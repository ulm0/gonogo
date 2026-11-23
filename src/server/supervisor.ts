/**
 * The rooms supervisor (docs/rooms-spec.md): `gonogo rooms` starts one ordinary gonogo process per room (each with its own home,
 * on a loopback port of its own) and serves ONE port: a list of the rooms and the proxy of roomproxy.ts under `/r/<id>/`.
 *
 * A room is exactly today's gonogo, so memory, tokens, ptys and crashes are not shared; agents talk to their own room's loopback port
 * and never through this server. The files are not isolated (one OS user): see docs/features/rooms.md.
 *
 * shortcut: a room that is added or removed in rooms.json is noticed within 2 s by polling the file, not by a watcher.
 * shortcut: the supervisor does not restart a room that was stopped by hand: there is no stop key, only `rooms remove`.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { chmodSync } from 'node:fs';
import type { Logger } from '../shared/protocol.js';
import { keyMayDo, openAuth } from './auth.js';
import type { AuthStore, HashCosts } from './auth.js';
import { createAuthHttp } from './authhttp.js';
import { createDevices } from './devicelogin.js';
import { createPasskeys } from './passkeys.js';
import { GLOBAL_SETTINGS_FILE, globalSetting } from './settings.js';
import { checkFolder, FolderError, writeFolder } from './projectfolder.js';
import { KNOWLEDGE_DIR, nullLogger, SHUTDOWN_MAX_MS } from './constants.js';
import { sendApiError, sendJson, sendText } from './hooks.js';
import { cachedLatest, isNewer, updateCheckOff } from './rollout.js';
import { clientStylesheet, ROOMS_PATH, roomsPage, roomsPageHeaders } from './roomspage.js';
import { createRoomProxy } from './roomproxy.js';
import { acquireSupervisorLock } from './home.js';
import { clearMigration, planMigration, readMigration, startupMigration, writeMigration } from './mainmigrate.js';
import type { MigrationNote, StartupOutcome } from './mainmigrate.js';
import { createPush, PUSH_LINE, parsePushLine } from './push.js';
import type { Push } from './push.js';
import { isPushPath, pushApi } from './pushhttp.js';
import { addRoom, updateRoom, loadRooms, recordMainHome, roomText, MAIN_ROOM, removeRoom, removeSupervisorFile, RoomsError, roomHome, validRoomId, writeSupervisorFile } from './rooms.js';
import type { RoomEntry } from './rooms.js';
import { exposureProblem, parsePublicUrl } from './exposure.js';
import { splitAllowed } from './hosts.js';
import { hostName } from './web.js';

const DIRECTOR_TOKEN_FILE = 'token';
const RELOAD_EXIT = 75;
const READY = /gonogo ready: http:\/\/[^\s/:]+:(\d{1,5})\//;
/** The socket the supervisor itself answers on, for the TUI, the CLI and scripts on this machine (docs/login-spec.md R2). */
export const API_SOCKET = join('run', 'api.sock');
/** The socket each room answers on (room main's home is the root home, so it cannot also be `api.sock`). */
export const ROOM_SOCKET = join('run', 'room.sock');
/** Alerts that wait for room main to be up (a start that finds the account reset, for one). */
const ALERTS_KEPT = 20;
const POLL_MS = 2000;
const STATUS_TTL_MS = 3000;
const START_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];
// a room gives up its own shutdown after SHUTDOWN_MAX_MS: wait longer than that before SIGKILL, or the kill lands in the middle of it
const BODY_MAX = 4096;
const STOP_WAIT_MS = SHUTDOWN_MAX_MS + 5000;

export type RoomState = 'starting' | 'running' | 'stopped' | 'crashed';

export interface RoomView {
  id: string;
  name: string;
  state: RoomState;
  /** Whether the room starts when gonogo starts (`main` always does). */
  autostart: boolean;
  /** Agents of the room, running ones, and those that need the Director; null while it cannot be asked. */
  agents: number | null;
  running: number | null;
  needsYou: number | null;
  /** Agents in the working state; null while it cannot be asked. */
  working: number | null;
  /** ms epoch of the newest message or state change of the room, or null (none, or it cannot be asked). */
  lastActivity: number | null;
  /** Dollars the room's ledger prices for today (local day): an estimate, not a bill; null while it cannot be asked. */
  costToday: number | null;
  /** The tab name of the room (the Director's, else the station's), or null. */
  tabName: string | null;
  /** Why a room that is not running is not (its last error line), or null. */
  note: string | null;
}

type Counts = Pick<RoomView, 'agents' | 'running' | 'needsYou' | 'working' | 'lastActivity' | 'tabName' | 'costToday'>;
const NO_COUNTS: Counts = { agents: null, running: null, needsYou: null, working: null, lastActivity: null, tabName: null, costToday: null };

export interface SupervisorOptions {
  /** The root home: room `main`, `rooms.json`, `rooms/<id>/`, the Director token. */
  home: string;
  host: string;
  /** 0 for any (tests). */
  port: number;
  /** `--allow-host`: a name is a page host, `name:hooks` a host that serves only /uplink and /dock (docs/expose-spec.md). */
  allowedHosts: string[];
  /** `--public-url`: where the page is for people outside (an https origin for a public name). */
  publicUrl?: string;
  /** The request header that carries the client address when the peer is a trusted proxy: `x-forwarded-for` (default) or `cf-connecting-ip`. */
  clientIpHeader?: string;
  /** Tests of the login pages boot on a public name with no account yet, which the start refuses by default (docs/expose-spec.md): they turn the refusal off. Never set outside a test. */
  exposureCheck?: boolean;
  /** Inside a container the wildcard bind is normal and says nothing about exposure. */
  inContainer?: boolean;
  /** The command that starts a gonogo: [node, entry]. */
  command: string[];
  env: NodeJS.ProcessEnv;
  /** Extra arguments for every room (for a test's stand-in agent no flag is needed: the environment carries it). */
  roomArgs?: string[];
  /** The running version, shown in the corner of the list page. */
  version?: string;
  /** What a push is sent with (tests give a stand-in for the browser vendors' push services). */
  fetch?: typeof fetch;
  /** The built client (dist/client): its stylesheet dresses the list page, served from /assets/. Absent or without a build: plain styles. */
  staticDir?: string | null;
  /** Addresses of reverse proxies whose X-Forwarded-For is believed (`--trusted-proxy`); none by default. */
  trustedProxies?: string[];
  /** Tests: cheaper password hashing, no tamper timer. */
  authCosts?: HashCosts;
  tamperEveryMs?: number;
  now?: () => number;
  log?: Logger;
}

export interface Supervisor {
  host: string;
  port: number;
  /** The old browser token: only on an install that has never had an account; null once there is one (docs/login-spec.md R1). */
  directorToken: string | null;
  url: string;
  /** The account, sessions and keys. */
  auth: AuthStore;
  /** `<home>/run/api.sock`. */
  socketPath: string;
  /** The setup token made at this start (no account yet), to print once; null otherwise. */
  setupToken: string | null;
  rooms(): RoomView[];
  /** Resolves once room main has been ready, or after `ms` (a main that does not start must not keep the front port from being announced). */
  whenReady(ms: number): Promise<void>;
  /** Reload (SIGUSR2 to every room, which hands its agents to its pty host and exits 75); resolves when they are gone. The caller then stops and re-executes. */
  reload(): Promise<void>;
  /** Graceful: every room gets SIGTERM and its own shutdown; resolves when they are gone (or after 12 s, then SIGKILL). */
  stop(): Promise<void>;
}

interface Child {
  entry: RoomEntry;
  proc: ChildProcess | null;
  port: number | null;
  state: RoomState;
  failures: number;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  wanted: boolean;
  /** The last `gonogo: ...` line the room printed to stderr (why it did not start, for example a lock): shown in its row. */
  lastError: string | null;
  exited: Promise<void> | null;
}

/**
 * The Director token is `<home>/token`, 0600: for an existing home the value its owner already has, so every old link works. A room never
 * holds it (its own token is `run/room-token`, new at every start). The `rooms-token` of 0.4 and the `token` of a non-main room are removed.
 */
export function directorTokenOf(home: string, otherRooms: readonly string[] = []): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  rmSync(join(home, 'rooms-token'), { force: true });
  // a room's own token of 0.4 must not open anything now (it was never the Director's)
  for (const id of otherRooms) rmSync(join(roomHome(home, id), 'token'), { force: true });
  // room main in its own folder (a home made by 0.8.2 or later) has no use for a token file either: the one at the root is the Director's
  try {
    const main = roomHome(home, MAIN_ROOM);
    if (main !== home) rmSync(join(main, 'token'), { force: true });
  } catch {
    // a damaged rooms.json: the supervisor says so itself when it reads the list
  }
  const path = join(home, DIRECTOR_TOKEN_FILE);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // none yet
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export async function startSupervisor(options: SupervisorOptions): Promise<Supervisor> {
  const log = options.log ?? nullLogger;
  // the names and the public URL are read before anything is held
  const split = splitAllowed(options.allowedHosts);
  if (typeof split === 'string') throw new Error(split);
  const publicUrl = options.publicUrl === undefined ? null : parsePublicUrl(options.publicUrl);
  if (typeof publicUrl === 'string') throw new Error(publicUrl);
  // one supervisor per home; the lock is released by stop() (and by the process ending, for the stale-pid rule)
  const releaseLock = acquireSupervisorLock(options.home);
  let directorToken: string | null = null;
  const children = new Map<string, Child>();
  const alertsWaiting: string[] = [];
  /** Alerts and notices that could not be handed to main (stopped, starting) and were not kept (ALERTS_KEPT each): said once when main is ready. */
  let heldDropped = 0;
  const noticesWaiting: string[] = [];
  /** Alerts go to room main (its Downlink and Relay) over the pipe the supervisor holds. */
  const tell = (text: string): void => {
    log.warn(`login: ${text}`);
    const main = children.get(MAIN_ROOM);
    if (main?.proc != null && main.state === 'running' && main.proc.stdin !== null && !main.proc.stdin.destroyed) main.proc.stdin.write(`gonogo-alert ${JSON.stringify(text)}\n`);
    else if (alertsWaiting.length < ALERTS_KEPT) alertsWaiting.push(text);
    else heldDropped += 1;
  };
  /** The open pages of room main hear it (its Downlink), nobody is pushed to: not Relay, not a redline. */
  const notice = (text: string): void => {
    log.info(`login: ${text}`);
    const main = children.get(MAIN_ROOM);
    if (main?.proc != null && main.state === 'running' && main.proc.stdin !== null && !main.proc.stdin.destroyed) main.proc.stdin.write(`gonogo-notice ${JSON.stringify(text)}\n`);
    // held while main is stopped or starting, and said when it is ready (a notice is a line in its Downlink, so it is cheap to keep a few)
    else if (noticesWaiting.length < ALERTS_KEPT) noticesWaiting.push(text);
    else heldDropped += 1;
  };
  // an old home's room main is moved into rooms/main before anything reads where it lives (docs/features/rooms.md); a refusal leaves the home as it is
  let startupMove: StartupOutcome;
  try {
    startupMove = await startupMigration(options.home);
  } catch (error) {
    releaseLock();
    throw error;
  }
  const moveNotice = ((): string | null => {
    const o = startupMove;
    if (o.did === 'migrated' || o.did === 'resumed') return o.direction === 'forward' ? `Room main now lives in rooms/main/ (${o.moved} files moved${o.did === 'migrated' && o.removed.length > 0 ? `; leftover worktrees removed first: ${o.removed.join(', ')}; their branches are kept` : ''}). UNDO is on the rooms page.` : 'Room main is back at the root of the home.';
    if (o.did === 'skipped') return o.direction === 'forward' ? `Room main stays at the root of the home, not moved: ${o.problems[0] ?? 'a check failed'}. The rooms page has the reasons and MIGRATE NOW.` : `Room main stays in rooms/main/, not moved back: ${o.problems[0] ?? 'a check failed'}.`;
    return null;
  })();
  if (moveNotice !== null) {
    log.warn(moveNotice);
    // a move the Director asked for (MIGRATE NOW, UNDO) that was refused is an alert: his inbox AND his phone, not a line he may miss while a page reloads
    if (startupMove.did === 'skipped' && startupMove.asked) alertsWaiting.push(moveNotice);
    else noticesWaiting.push(moveNotice);
  }
  let auth: AuthStore;
  let madeSetupToken: string | null = null;
  try {
    auth = openAuth({ home: options.home, alert: tell, notice, log: log.child('auth'), ...(options.authCosts === undefined ? {} : { costs: options.authCosts }), ...(options.tamperEveryMs === undefined ? {} : { tamperEveryMs: options.tamperEveryMs }), ...(options.now === undefined ? {} : { now: options.now }) });
    // once an account has existed no browser token comes back, and an old home's token file is gone (R1)
    if (auth.tokenAllowed()) directorToken = directorTokenOf(options.home, loadRooms(options.home).filter((r) => r.id !== MAIN_ROOM).map((r) => r.id));
    else {
      rmSync(join(options.home, DIRECTOR_TOKEN_FILE), { force: true });
      rmSync(join(options.home, 'rooms-token'), { force: true });
    }
    // docs/expose-spec.md: gonogo does not start on a name other machines use until the login (and its second factor) stands behind it
    const problem = exposureProblem({ pages: [...split.pages], hooks: [...split.hooks], bindHost: options.host, port: options.port, inContainer: options.inContainer === true, publicUrl, account: auth.state(), mfa: auth.mfa().enabled });
    if (problem !== null && options.exposureCheck !== false) {
      auth.close();
      throw new Error(problem);
    }
    madeSetupToken = auth.ensureSetupToken();
  } catch (error) {
    releaseLock();
    throw error;
  }
  // push to the installed app (docs/features/mobile.md): one key and the devices of the login's sessions, in the supervisor's home
  const push: Push = createPush({ dir: options.home, now: options.now ?? (() => Date.now()), fetch: options.fetch ?? ((url, init) => fetch(url, init)), log: log.child('push') });
  try {
    await push.load();
    // a device whose session is not alive (it ended while this server was off, a reset, an entry planted in the file) is not kept
    await push.prune((id) => auth.alive(id));
  } catch (error) {
    auth.close();
    releaseLock();
    throw error;
  }
  let reloading = false;
  let mainReadyOnce = false;
  let markMainReady: () => void = () => undefined;
  const mainReady = new Promise<void>((resolve) => (markMainReady = resolve));
  // `gonogo token rotate` writes a new `token` file: it is taken up the next time anything asks, with no restart
  const tokenPath = join(options.home, DIRECTOR_TOKEN_FILE);
  let tokenStamp = '';
  let closeDirectorSockets: () => void = () => undefined;
  const stampOf = (): string => {
    try {
      const st = statSync(tokenPath);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return '';
    }
  };
  tokenStamp = stampOf();
  const currentToken = (): string | null => {
    if (!auth.tokenAllowed()) return null;
    const now = stampOf();
    if (now !== tokenStamp) {
      tokenStamp = now;
      try {
        const fresh = readFileSync(tokenPath, 'utf8').trim();
        if (/^[0-9a-f]{64}$/.test(fresh) && fresh !== directorToken) {
          directorToken = fresh;
          // a socket opened with the old token must not outlive it: the page reconnects with the new one
          closeDirectorSockets();
        }
      } catch {
        // the old value stays until a readable one is there
      }
    }
    return directorToken;
  };
  let stopping = false;
  const statusCache = new Map<string, { at: number; value: Counts }>();

  // page hosts serve everything the login lets in; hooks hosts only the webhooks (the proxy answers 404 to anything else there)
  const allowedNames = new Set<string>(split.pages);
  if (!['0.0.0.0', '::', ''].includes(options.host)) allowedNames.add(hostName(options.host) ?? options.host.toLowerCase());
  const hooksNames = split.hooks;

  /* ---------------------------------------------------------------- the children */

  // where room main lives is decided once per supervisor (a damaged rooms.json later must not move it), the others are under rooms/<id>
  let mainHome: string | null = null;
  const homeOfRoom = (id: string): string => (id === MAIN_ROOM ? (mainHome ??= roomHome(options.home, MAIN_ROOM)) : roomHome(options.home, id));
  const socketOf = (child: Child): string => join(homeOfRoom(child.entry.id), ROOM_SOCKET);

  /** GET a JSON answer from a room over its local socket (no token: the file permissions are the credential). */
  const askRoom = (child: Child, path: string, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath: socketOf(child), path, method: 'GET', headers: { host: `127.0.0.1:${child.port ?? 0}`, accept: 'application/json' }, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`room answered ${String(res.statusCode)}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e instanceof Error ? e : new Error('not json'));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });

  const telegramRouteKey = randomBytes(32).toString('hex');

  function launch(child: Child): void {
    if (stopping || reloading || !child.wanted) return;
    const home = homeOfRoom(child.entry.id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const env = { ...options.env };
    // the flags below win over these, but a room must not see the supervisor's own settings by mistake
    for (const name of ['GONOGO_PORT', 'GONOGO_HOST', 'GONOGO_TOKEN', 'GONOGO_BROWSER_TOKEN']) delete env[name];
    env.GONOGO_HOME = home;
    env.GONOGO_ROOM = child.entry.id;
    // the Knowledge store lives with the supervisor, not in a room: it survives a deleted room, and the rooms of an install share the claims the Director accepted
    env.GONOGO_KNOWLEDGE_DIR = join(options.home, KNOWLEDGE_DIR);
    // the settings every room shares (docs/runtime-settings-spec.md): a room reads the file itself, over its own
    env.GONOGO_GLOBAL_SETTINGS = join(options.home, GLOBAL_SETTINGS_FILE);
    // where the install's rooms are (rooms.json, and each room's socket): main reads it to offer a Telegram update to the room it belongs to
    env.GONOGO_INSTALL_ROOT = options.home;
    // the rooms of one install offer each other Telegram updates with this key (telegramroute.ts); new at every start of the supervisor, never written to a file
    env.GONOGO_TELEGRAM_ROUTE_KEY = telegramRouteKey;
    // the update hook is main's: the other rooms never get its address or its token
    if (child.entry.id !== MAIN_ROOM) for (const name of ['GONOGO_UPDATE_HOOK', 'GONOGO_UPDATE_HOOK_TOKEN']) delete env[name];
    // a room that is told to reload signals this process, and only this one
    env.GONOGO_SUPERVISOR_PID = String(process.pid);
    const [file, ...head] = options.command;
    const args = [...head, '__room', '--home', home, '--port', '0', '--host', '127.0.0.1', '--exit-with-stdin', ...(child.entry.id === MAIN_ROOM ? [] : ['--no-update-check']), ...(options.roomArgs ?? [])];
    child.state = 'starting';
    child.port = null;
    child.startedAt = Date.now();
    const proc = spawn(file as string, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.proc = proc;
    let buffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        // the one question a room may ask: no route, no port, only this pipe; any other line is just output
        if ((line === 'gonogo-ask busy' || line === 'gonogo-ask idle') && child.proc === proc) {
          void answerBusy(child, proc, line === 'gonogo-ask idle');
          continue;
        }
        // a room wrote the file of settings for every room: only the fact is taken from it, every running room is told to read the file again and checks it itself
        if (line === 'gonogo-settings-changed' && child.proc === proc) {
          for (const other of children.values()) if (other.proc !== null && other.state === 'running') other.proc.stdin?.write('gonogo-settings\n');
          continue;
        }
        // what waits for the Director in this room, to be pushed to the phones (push.ts): checked and cut here, whatever the room sent
        if (line.startsWith(PUSH_LINE) && child.proc === proc) {
          const event = parsePushLine(line.slice(PUSH_LINE.length));
          if (event !== null) push.notify({ id: child.entry.id, name: child.entry.name }, event);
          continue;
        }
        const ready = READY.exec(line);
        if (ready !== null && child.proc === proc) {
          child.port = Number(ready[1]);
          child.state = 'running';
          child.lastError = null;
          if (child.entry.id === MAIN_ROOM) {
            mainReadyOnce = true;
            markMainReady();
            for (const text of alertsWaiting.splice(0)) proc.stdin?.write(`gonogo-alert ${JSON.stringify(text)}\n`);
            for (const text of noticesWaiting.splice(0)) proc.stdin?.write(`gonogo-notice ${JSON.stringify(text)}\n`);
            if (heldDropped > 0) {
              proc.stdin?.write(`gonogo-alert ${JSON.stringify(`${String(heldDropped)} login alerts or notices were dropped while this room was not running (only ${String(ALERTS_KEPT)} of each are kept): check the sessions and keys in Settings`)}\n`);
              heldDropped = 0;
            }
          }
          log.info(`room ${child.entry.id} is up on 127.0.0.1:${child.port}`);
        } else if (line.trim() !== '') {
          // the ready line holds the room's token: if a later version words it so that READY misses it, the token is still not logged
          log.debug(`[${child.entry.id}] ${line.replace(/#token=\S+/g, '#token=<hidden>')}`);
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        log.info(`[${child.entry.id}] ${line}`);
        // gonogo's own fatal message, as main() prints it
        if (line.startsWith('gonogo: ')) child.lastError = line.slice(8).replace(/#token=\S+/g, '#token=<hidden>').slice(0, 200);
      }
    });
    child.exited = new Promise<void>((done) => {
      proc.once('exit', (code, signal) => {
        if (child.proc !== proc) return done();
        child.proc = null;
        child.port = null;
        if (stopping || !child.wanted) {
          child.state = 'stopped';
        } else if (reloading && code === RELOAD_EXIT) {
          // asked for: it handed its agents to its pty host and left; the supervisor re-executes itself next (S6: an unasked 75 is a crash)
          child.state = 'stopped';
        } else {
          // a room that ran for a minute starts over from the shortest wait
          if (Date.now() - child.startedAt > 60_000) child.failures = 0;
          const wait = START_BACKOFF_MS[Math.min(child.failures, START_BACKOFF_MS.length - 1)] ?? 30_000;
          child.failures += 1;
          child.state = 'crashed';
          log.warn(`room ${child.entry.id} ended (${signal ?? `code ${String(code)}`}); starting it again in ${wait / 1000} s`);
          child.timer = setTimeout(() => launch(child), wait);
          child.timer.unref();
        }
        done();
      });
      proc.once('error', (error) => {
        log.error(`room ${child.entry.id} could not start: ${error.message}`);
      });
    });
  }

  function halt(child: Child): Promise<void> {
    child.wanted = false;
    if (child.timer !== null) clearTimeout(child.timer);
    const proc = child.proc;
    if (proc === null) {
      child.state = 'stopped';
      return Promise.resolve();
    }
    proc.kill('SIGTERM');
    const kill = setTimeout(() => proc.kill('SIGKILL'), STOP_WAIT_MS);
    return (child.exited ?? Promise.resolve()).finally(() => clearTimeout(kill));
  }

  /**
   * The answer to `gonogo-ask busy`: whether a room other than the asker has a T-minus poll or Static fire open. `gonogo-ask idle` (auto-update, nobody
   * is there to click) asks for more: any agent working, starting or needing the Director in another room. One line back, two fields, nothing else.
   */
  async function answerBusy(asker: Child, proc: ChildProcess, strict = false): Promise<void> {
    let busy: string | null = null;
    let room: string | null = null;
    for (const other of children.values()) {
      if (other === asker) continue;
      // a room that is still starting may be about to have agents working (auto-update asks; the click's plain question does not)
      if (strict && other.state === 'starting') {
        busy = `room "${other.entry.name}" is still starting`;
        room = other.entry.id;
        break;
      }
      if (other.port === null) continue;
      try {
        const body = (await askRoom(other, '/api/state', 2000)) as { poll?: { status?: string } | null; agents?: Array<{ name?: string; state?: string; queued?: number }> };
        if (body.poll?.status === 'open') {
          busy = `a T-minus poll or Static fire is open in room "${other.entry.name}": wait for its answer, then update`;
          room = other.entry.id;
          break;
        }
        const active = strict ? (body.agents ?? []).find((a) => a.state === 'working' || a.state === 'needs_you' || a.state === 'starting' || (a.queued ?? 0) > 0) : undefined;
        if (active !== undefined) {
          busy = `room "${other.entry.name}" is not idle (an agent is ${active.state === 'needs_you' ? 'waiting for you' : active.state === 'working' ? 'working' : 'starting or has mail queued'})`;
          room = other.entry.id;
          break;
        }
      } catch {
        busy = `room "${other.entry.name}" did not say whether it is busy: try again`;
        room = other.entry.id;
        break;
      }
    }
    if (child_alive(asker, proc)) proc.stdin?.write(`gonogo-answer busy ${JSON.stringify({ busy, room })}\n`);
  }
  const child_alive = (child: Child, proc: ChildProcess): boolean => child.proc === proc && proc.stdin !== null && !proc.stdin.destroyed;

  /** Starts the rooms the file lists and stops the ones it no longer lists. */
  let lastListError = '';
  function reconcile(): void {
    if (stopping) return;
    let listed: RoomEntry[];
    try {
      listed = loadRooms(options.home);
      recordMainHome(options.home); // a home that has no layout on record gets it now, before any room starts
      lastListError = '';
    } catch (error) {
      // a damaged rooms.json is not "no rooms": keep every room as it is, and say so once
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastListError) log.error(`${message}; keeping the rooms that run`);
      lastListError = message;
      if (children.size === 0) throw error;
      return;
    }
    for (const entry of listed) {
      const have = children.get(entry.id);
      if (have === undefined) {
        const child: Child = { entry, proc: null, port: null, state: 'stopped', failures: 0, startedAt: 0, timer: null, wanted: entry.autostart, lastError: null, exited: null };
        children.set(entry.id, child);
        if (entry.autostart) launch(child);
      } else {
        have.entry = entry;
      }
    }
    for (const [id, child] of children) {
      if (!listed.some((r) => r.id === id)) {
        children.delete(id);
        void halt(child);
        log.info(`room ${id} was taken off the list; stopping it (its folder stays)`);
      }
    }
  }

  /* ---------------------------------------------------------------- what the list page shows */

  async function statusOf(child: Child): Promise<Counts> {
    const none: Counts = NO_COUNTS;
    if (child.port === null) return none;
    const cached = statusCache.get(child.entry.id);
    if (cached !== undefined && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    try {
      const body = (await askRoom(child, '/api/state', 1500)) as { agents?: Array<{ state?: string; stateSince?: number }>; activity?: Array<{ at?: number }>; tabName?: { name?: string | null; fallback?: string | null }; propellant?: { cost?: { days?: Array<{ usd?: number }> } } };
      const agents = Array.isArray(body.agents) ? body.agents : [];
      const times = [...agents.map((a) => a.stateSince), body.activity?.[0]?.at].filter((t): t is number => typeof t === 'number' && t > 0);
      const tab = body.tabName?.name ?? body.tabName?.fallback;
      const value: Counts = {
        agents: agents.length,
        running: agents.filter((a) => a.state !== 'stopped').length,
        needsYou: agents.filter((a) => a.state === 'needs_you').length,
        working: agents.filter((a) => a.state === 'working').length,
        lastActivity: times.length === 0 ? null : Math.max(...times),
        // the estimate of the room's local day, from the same state the list already asks for (no second request)
        costToday: ((usd) => (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null))(body.propellant?.cost?.days?.at(-1)?.usd),
        tabName: typeof tab === 'string' && roomText(tab) !== '' ? roomText(tab) : null,
      };
      statusCache.set(child.entry.id, { at: Date.now(), value });
      return value;
    } catch {
      return none;
    }
  }

  const viewsNow = async (): Promise<RoomView[]> =>
    Promise.all([...children.values()].map(async (c) => ({ id: c.entry.id, name: c.entry.name, state: c.state, autostart: c.entry.id === MAIN_ROOM || c.entry.autostart, note: c.state === 'running' ? null : c.lastError, ...(await statusOf(c)) })));

  /* ---------------------------------------------------------------- the front port */

  const stylesheet = clientStylesheet(options.staticDir ?? null);
  const assetsDir = options.staticDir === null || options.staticDir === undefined ? null : join(options.staticDir, 'assets');
  const TYPES: Record<string, string> = { css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', svg: 'image/svg+xml' };

  const hostOk = (header: string | undefined): boolean => {
    const name = header === undefined ? null : hostName(header);
    return name !== null && (['127.0.0.1', 'localhost', '::1'].includes(name) || allowedNames.has(name));
  };

  /** Requests that came in on the local socket. */
  const localReqs = new WeakSet<http.IncomingMessage>();
  const authHttp = createAuthHttp({
    auth,
    legacyToken: currentToken,
    hostOk,
    stylesheet,
    local: localReqs,
    passkeys: createPasskeys(auth, options.now),
    devices: createDevices({ auth, now: options.now ?? Date.now, alert: tell, notice }),
    ...(options.trustedProxies === undefined ? {} : { trustedProxies: options.trustedProxies }),
    ...(options.clientIpHeader === undefined ? {} : { clientIpHeader: options.clientIpHeader }),
    exposure: { pages: [...split.pages], hooks: [...split.hooks], publicUrl: publicUrl === null ? null : publicUrl.origin },
    log: log.child('login'),
  });

  const proxy = createRoomProxy({
    auth: { ...authHttp, alive: (id) => auth.alive(id), touchSession: (id) => auth.touchSession(id) },
    allowedNames,
    hooksHosts: hooksNames,
    rooms: () => [...children.values()].map((c) => ({ id: c.entry.id, port: c.state === 'running' ? c.port : null, socket: socketOf(c) })),
  });

  closeDirectorSockets = () => proxy.closeSockets();
  // a session that ends (revoked, logged out, expired, password changed, reset, tamper) takes its sockets with it
  auth.onEnded((ids) => {
    proxy.closeSessions(ids);
    // the phones of these sessions go with them (push.ts)
    void push.dropSessions(ids);
  });
  // a socket opened with the old browser token is bound to no session: it ends with the token, when the account is made
  auth.onAccountMade(() => proxy.closeSockets());
  auth.onReminted((from, to) => {
    proxy.rebind(from, to);
    // a step-up gives the session a new id: its phones follow it, or a later revoke would never find them
    void push.rebind(from, to);
  });

  /** The write routes need the same Origin rule as a room's: a browser page of another address is refused, a client without one is not. */
  const originOk = (req: http.IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      const url = new URL(origin);
      return url.host.toLowerCase() === (req.headers.host ?? '').toLowerCase() && hostOk(url.host);
    } catch {
      return false;
    }
  };

  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reject(new RoomsError('send application/json'));
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        // answered, not cut off: the rest of the body is read and dropped (only the Director gets this far)
        if (size > BODY_MAX) reject(new RoomsError(`the body is over ${BODY_MAX} bytes`));
        else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object');
          resolve(body as Record<string, unknown>);
        } catch {
          reject(new RoomsError('the body must be a JSON object'));
        }
      });
      req.on('error', () => reject(new RoomsError('the body could not be read')));
    });

  /** What main's daily check saw, when it is newer than this version: the other rooms run no check of their own, and their pages ask here. Nothing when the check is off. */
  const newerNow = (): { latest: string } | null => {
    const latest = updateCheckOff(globalSetting(join(options.home, GLOBAL_SETTINGS_FILE), 'updateCheck', options.env) ?? undefined) || options.roomArgs?.includes('--no-update-check') === true ? null : cachedLatest(homeOfRoom(MAIN_ROOM));
    return latest !== null && options.version !== undefined && isNewer(latest, options.version) ? { latest } : null;
  };

  /** Where room main lives, and what the last move said (never the list of files: reasons are short text). */
  const layoutView = (): { main: '.' | 'rooms/main'; path: string; migration: { state: string; at: number; reasons?: string[]; moved?: number; removed?: string[] } | null } => {
    let note: MigrationNote | null = null;
    let damaged = false;
    try {
      note = readMigration(options.home);
    } catch {
      damaged = true;
    }
    const path = homeOfRoom(MAIN_ROOM);
    const migration = damaged
      ? { state: 'damaged', at: 0, reasons: ['main-migration.json cannot be read: fix or delete it'] }
      : note === null
        ? null
        : note.state === 'skipped'
          ? { state: note.state, at: note.at, reasons: note.reasons }
          : note.state === 'done'
            ? { state: note.state, at: note.at, moved: note.moved, ...(note.undoReasons === undefined ? {} : { reasons: note.undoReasons }), ...(note.removedWorktrees === undefined ? {} : { removed: note.removedWorktrees }) }
            : { state: note.state, at: note.at };
    return { main: path === options.home ? '.' : 'rooms/main', path, migration };
  };

  /** GET: what a move would do now (nothing is written). POST {action}: request | undo | cancel | dismiss, each acted on at the next start. The Director's grant was checked. */
  async function migrateApi(req: http.IncomingMessage, res: http.ServerResponse, grant: NonNullable<ReturnType<typeof authHttp.grant>>): Promise<void> {
    try {
      const method = req.method ?? '';
      const layout = layoutView();
      if (method === 'GET') {
        const plan = await planMigration(options.home, layout.main === '.' ? 'forward' : 'undo', { running: false });
        return sendJson(res, 200, { ...plan, layout }, { 'Cache-Control': 'no-store' });
      }
      if (method !== 'POST') return sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: 'GET, POST' });
      if (!originOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
      const body = await readBody(req);
      // a session whose last password check is old is asked again (the supervisor's own routes are not behind the room proxy, which asks for the rooms' routes)
      const reason = authHttp.stepUpNeeded(grant, 'POST', '/api/rooms/main/migrate', body);
      if (reason !== null) return authHttp.stepUpDenied(req, res, reason, grant.kind === 'tui');
      const action = body.action;
      const note = readMigration(options.home);
      const pending = note?.state === 'requested' || note?.state === 'undo-requested';
      if (action === 'request') {
        if (layout.main !== '.') throw new RoomsError('room main already lives in rooms/main', 'conflict');
        writeMigration(options.home, { state: 'requested', at: Date.now() });
      } else if (action === 'undo') {
        if (layout.main !== 'rooms/main') throw new RoomsError('room main is at the root: there is nothing to undo', 'conflict');
        writeMigration(options.home, { state: 'undo-requested', at: Date.now() });
      } else if (action === 'cancel') {
        if (!pending) throw new RoomsError('no move is waiting for the next start', 'conflict');
        clearMigration(options.home);
      } else if (action === 'dismiss') {
        // only what the page shows as a note: never the journal of a move (moving, undoing) or a request that waits
        if (note === null || (note.state !== 'skipped' && note.state !== 'done')) throw new RoomsError('there is no note to dismiss', 'conflict');
        clearMigration(options.home);
      } else {
        throw new RoomsError('action must be request, undo, cancel or dismiss');
      }
      return sendJson(res, 200, { ok: true, layout: layoutView() });
    } catch (error) {
      if (error instanceof RoomsError) return sendApiError(res, error.kind === 'conflict' ? 409 : error.kind === 'not_found' ? 404 : 400, error.message, error.kind);
      log.error('migrate api failed', error);
      return sendApiError(res, 500, 'internal error', 'internal');
    }
  }

  const roomView = async (id: string): Promise<RoomView | undefined> => (await viewsNow()).find((r) => r.id === id);

  /* ---------------------------------------------------------------- stop and start (docs/features/rooms.md) */

  /** One stop or start per room at a time: a second request for the same room is refused while the first is in flight. */
  const inFlight = new Map<string, 'stopping' | 'starting'>();
  const STOP_ANSWER_MS = 5000;
  type Power = { ok: true; status: 200 | 202; note?: string } | { ok: false; status: number; why: string; needsForce?: true };

  /** The reasons a room must not be stopped now (an open poll, a waiting Relief request, a running update, a main move), or null. */
  async function stopRefusal(child: Child): Promise<string | null | 'unanswered'> {
    const id = child.entry.id;
    if (id === MAIN_ROOM) {
      const note = readMigration(options.home);
      if (note?.state === 'moving' || note?.state === 'undoing') return 'room main is being moved: wait for it to finish';
    }
    if (child.port === null) return null;
    try {
      const body = (await askRoom(child, '/api/state', 4000)) as { poll?: { status?: string } | null; relief?: { requests?: Array<{ id?: string }> } };
      if (body.poll?.status === 'open') return `a T-minus poll or Static fire is open in room "${id}": wait for its answer`;
      const waiting = body.relief?.requests ?? [];
      if (waiting.length > 0) return `a Relief request waits in room "${id}" (${waiting.map((r) => String(r.id)).join(', ')}): answer it first`;
      if (id === MAIN_ROOM) {
        const update = (await askRoom(child, '/api/update', 4000)) as { state?: string };
        if (update.state === 'running' || update.state === 'reloading' || update.state === 'handed-off') return 'an update is running in room main: wait for it to finish';
      }
    } catch {
      // a room that does not answer cannot be asked, and must still be stoppable (it may be hung); main carries updates and polls, so it is not
      return id === MAIN_ROOM ? `room "${id}" did not say whether it is busy: try again` : 'unanswered';
    }
    return null;
  }

  async function stopOne(child: Child, byKey: boolean, force = false): Promise<Power> {
    const id = child.entry.id;
    const doing = inFlight.get(id);
    if (doing !== undefined) return { ok: false, status: 409, why: `room ${id} is ${doing}` };
    if (byKey && id === MAIN_ROOM) return { ok: false, status: 403, why: 'an API key may not stop room main (it carries the updates and the Telegram poll): do it in the browser' };
    if (child.state === 'stopped' && !child.wanted) return { ok: false, status: 409, why: `room ${id} is already stopped` };
    inFlight.set(id, 'stopping');
    let unanswered = false;
    try {
      const refusal = await stopRefusal(child);
      if (refusal === 'unanswered' && !force) {
        inFlight.delete(id);
        return { ok: false, status: 409, why: `room "${id}" did not answer whether it is busy: it may be hung; send {"force":true} to stop it anyway`, needsForce: true };
      }
      if (refusal !== null && refusal !== 'unanswered') {
        inFlight.delete(id);
        return { ok: false, status: 409, why: refusal };
      }
      unanswered = refusal === 'unanswered';
    } catch (error) {
      inFlight.delete(id);
      throw error;
    }
    const done = halt(child).finally(() => inFlight.delete(id));
    const quick = await Promise.race([done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), STOP_ANSWER_MS).unref())]);
    return { ok: true, status: quick ? 200 : 202, ...(unanswered ? { note: 'the room did not answer whether it is busy: stopped by force' } : {}) };
  }

  function startOne(child: Child): Power {
    const id = child.entry.id;
    const doing = inFlight.get(id);
    if (doing !== undefined) return { ok: false, status: 409, why: `room ${id} is ${doing}` };
    if (child.state === 'starting' || child.state === 'running') return { ok: false, status: 409, why: `room ${id} is ${child.state}` };
    if (child.timer !== null) clearTimeout(child.timer);
    child.timer = null;
    child.wanted = true;
    child.failures = 0;
    launch(child);
    return (child.state as RoomState) === 'starting' ? { ok: true, status: 200 } : { ok: false, status: 409, why: 'gonogo is stopping' };
  }

  /** POST /api/rooms/<id>/stop|start and /api/rooms/stop-all|start-all. The grant was checked; step-up and the audit are here, not in the proxy. */
  async function powerApi(req: http.IncomingMessage, res: http.ServerResponse, grant: NonNullable<ReturnType<typeof authHttp.grant>>, action: string, rawId: string | undefined): Promise<void> {
    try {
      if (req.method !== 'POST') return sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: 'POST' });
      if (!originOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
      // the room id is decoded ONCE and checked before anything is judged by it: the step-up rule matches the decoded text, never %6Dain
      let id: string | undefined;
      if (rawId !== undefined) {
        try {
          id = decodeURIComponent(rawId);
        } catch {
          return sendApiError(res, 400, 'bad room id', 'bad_request', 'id');
        }
        if (!validRoomId(id)) return sendApiError(res, 400, 'a room id is a lower-case letter, then up to 23 lower-case letters, digits or dashes', 'bad_request', 'id');
      }
      const path = id === undefined ? `/api/rooms/${action}` : `/api/rooms/${id}/${action}`;
      const reason = authHttp.stepUpNeeded(grant, 'POST', path, {});
      if (reason !== null) return authHttp.stepUpDenied(req, res, reason, grant.kind === 'tui');
      // {"force":true} stops a room that does not answer the question whether it is busy; no body is no force
      const force = ((await readBody(req).catch(() => ({}))) as { force?: unknown }).force === true;
      const byKey = grant.kind === 'key';
      const actor = byKey ? `key "${auth.keys().find((k) => k.id === grant.keyId)?.name ?? 'unknown'}"` : grant.kind === 'session' ? 'the Director (browser session)' : `the Director (${grant.kind})`;
      // the supervisor writes the audit, before and after, so a page cannot skip it
      const audit = (text: string): void => {
        log.warn(`rooms: ${actor}: ${text}`);
        notice(`${actor}: ${text}`);
      };
      if (id === undefined) {
        if (byKey && action === 'stop-all') {
          audit('refused: an API key may not stop every room');
          return sendApiError(res, 403, 'an API key may not stop every room: do it in the browser', 'forbidden');
        }
        const done: string[] = [];
        const skipped: Array<{ id: string; why: string }> = [];
        const todo = [...children.values()].filter((child) => (action === 'stop-all' ? !(child.state === 'stopped' && !child.wanted) : child.state === 'stopped' || child.state === 'crashed'));
        const note = (child: Child, r: Power): void => {
          if (r.ok) done.push(child.entry.id);
          else skipped.push({ id: child.entry.id, why: r.why });
        };
        if (action === 'stop-all') {
          // the other rooms together, then main last: main carries the audit and the updates, and the others should not wait for each other's shutdown
          const others = todo.filter((c) => c.entry.id !== MAIN_ROOM);
          const results = await Promise.all(others.map((c) => stopOne(c, false)));
          others.forEach((c, i) => note(c, results[i] as Power));
          for (const main of todo.filter((c) => c.entry.id === MAIN_ROOM)) note(main, await stopOne(main, false));
        } else for (const child of todo) note(child, startOne(child));
        audit(`${action}: ${done.length === 0 ? 'nothing done' : `done ${done.join(', ')}`}${skipped.length === 0 ? '' : `; skipped ${skipped.map((s) => `${s.id} (${s.why})`).join(', ')}`}`);
        return sendJson(res, 200, action === 'stop-all' ? { stopped: done, skipped } : { started: done, skipped });
      }
      if (id === undefined) return sendApiError(res, 400, 'bad room id', 'bad_request', 'id');
      const child = children.get(id);
      if (child === undefined) return sendApiError(res, 404, `there is no room "${id}"`, 'not_found');
      const r = action === 'stop' ? await stopOne(child, byKey, force) : startOne(child);
      audit(`${action} room ${id}: ${r.ok ? `done${r.note === undefined ? '' : ` (${r.note})`}` : `refused (${r.why})`}`);
      if (!r.ok) return sendApiError(res, r.status, r.why, r.status === 403 ? 'forbidden' : 'conflict', undefined, {}, r.needsForce === true ? { needsForce: true } : {});
      return sendJson(res, r.status, (await roomView(id)) ?? { id });
    } catch (error) {
      log.error('rooms power api failed', error);
      return sendApiError(res, 500, 'internal error', 'internal');
    }
  }

  /** GET lists; POST adds; PATCH renames; DELETE takes a room off the list (its folder stays). The Director token was checked. */
  async function roomsApi(req: http.IncomingMessage, res: http.ServerResponse, grant: NonNullable<ReturnType<typeof authHttp.grant>>, rawId: string | undefined): Promise<void> {
    try {
      const method = req.method ?? '';
      if (method === 'GET' && rawId === undefined) return sendJson(res, 200, { rooms: await viewsNow(), update: newerNow(), layout: layoutView() }, { 'Cache-Control': 'no-store' });
      const allow = rawId === undefined ? 'GET, POST' : 'PATCH, DELETE';
      if (!(rawId === undefined ? method === 'POST' : method === 'PATCH' || method === 'DELETE')) return sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: allow });
      if (!originOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
      let id = rawId;
      if (id !== undefined) {
        try {
          id = decodeURIComponent(id);
        } catch {
          return sendApiError(res, 400, 'bad room id', 'bad_request', 'id');
        }
        if (!validRoomId(id)) return sendApiError(res, 400, 'a room id is a lower-case letter, then up to 23 lower-case letters, digits or dashes', 'bad_request', 'id');
      }
      if (method === 'DELETE') {
        // judged by the decoded id, here, because the room proxy does not cover the supervisor's own routes
        const reason = authHttp.stepUpNeeded(grant, 'DELETE', `/api/rooms/${String(id)}`, null);
        if (reason !== null) return authHttp.stepUpDenied(req, res, reason, grant.kind === 'tui');
        removeRoom(options.home, id);
        reconcile();
        return sendJson(res, 200, { ok: true, note: `room ${id} was taken off the list and is stopping; its folder stays` });
      }
      const body = await readBody(req);
      if (method === 'POST') {
        // a folder that is not one adds no room; and a room that starts its agents in a folder is the Director's own doing: a session (asked for the password again), not a key or a terminal
        let folder: string | null = null;
        if (body.dir !== undefined && body.dir !== null) {
          if (grant.kind !== 'session' && grant.kind !== 'token') return sendApiError(res, 403, "a project folder is set from the Director's own login: agents start in it", 'forbidden');
          const reason = authHttp.stepUpNeeded(grant, 'POST', '/api/rooms', body);
          if (reason !== null) return authHttp.stepUpDenied(req, res, reason, false);
          try {
            folder = checkFolder(body.dir, [options.home]);
          } catch (error) {
            if (error instanceof FolderError) throw new RoomsError(error.message);
            throw error;
          }
        }
        const entry = addRoom(options.home, body.id, typeof body.name === 'string' ? body.name : undefined);
        if (folder !== null) {
          try {
            writeFolder(homeOfRoom(entry.id), folder);
          } catch (error) {
            removeRoom(options.home, entry.id);
            throw error;
          }
          log.info(`room ${entry.id}: project folder ${folder}`);
        }
        reconcile();
        return sendJson(res, 201, (await roomView(entry.id)) ?? entry);
      }
      const entry = updateRoom(options.home, id, { name: body.name, autostart: body.autostart });
      reconcile();
      return sendJson(res, 200, (await roomView(entry.id)) ?? entry);
    } catch (error) {
      if (error instanceof RoomsError) {
        const status = error.kind === 'conflict' ? 409 : error.kind === 'not_found' ? 404 : 400;
        return sendApiError(res, status, error.message, error.kind);
      }
      log.error('rooms api failed', error);
      return sendApiError(res, 500, 'internal error', 'internal');
    }
  }

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // a hooks-only host (`--allow-host name:hooks`) has no login, no list and no page: the proxy serves its webhooks, everything else is 404
    const asked = req.headers.host === undefined ? null : hostName(req.headers.host);
    if (asked !== null && hooksNames.has(asked) && !allowedNames.has(asked)) {
      if (!proxy.handle(req, res)) sendText(res, 404, 'not found');
      return;
    }
    // the login pages and /api/auth are the supervisor's own
    if (authHttp.handle(req, res)) return;
    if (proxy.handle(req, res)) return;
    if (!hostOk(req.headers.host)) return sendText(res, 403, 'forbidden host');
    const path = (req.url ?? '').split('?')[0] ?? '';
    const get = req.method === 'GET' || req.method === 'HEAD';
    // the Docker healthcheck: no token, never proxied; 503 until main has been ready once, then 200 for as long as this process runs
    if (path === `${ROOMS_PATH}/health` && get) {
      const up = mainReadyOnce;
      res.writeHead(up ? 200 : 503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : up ? 'ok' : 'main is not ready yet');
      return;
    }
    // 0.5.0's address of the list: moved to "/" (the query stays)
    if ((path === ROOMS_PATH || path === `${ROOMS_PATH}/`) && get) {
      res.writeHead(308, { Location: `/${(req.url ?? '').includes('?') ? `?${(req.url ?? '').split('?').slice(1).join('?')}` : ''}`, 'Content-Length': 0 });
      res.end();
      return;
    }
    if (path === '/' && get) {
      res.writeHead(200, roomsPageHeaders());
      res.end(req.method === 'HEAD' ? undefined : roomsPage(stylesheet, options.version ?? null));
      return;
    }
    // the stylesheet and fonts of the built client, and the logo (public/lockup.svg), for the list page, under /rooms/: a plain file name, only css, fonts and that one svg (room main keeps /assets/)
    const asset = new RegExp(`^${ROOMS_PATH}/(?:assets/([\\w.-]+\\.(css|woff2?))|(lockup)\\.(svg))$`).exec(path);
    const [file0, ext0] = asset?.[3] === undefined ? [join(assetsDir ?? '', asset?.[1] ?? ''), asset?.[2]] : [join(options.staticDir ?? '', 'lockup.svg'), 'svg'];
    if (asset !== null && assetsDir !== null && req.method === 'GET' && !file0.includes('..')) {
      try {
        // a regular file only: a symlink in a writable install folder must not turn this route into a read of the token
        const file = file0;
        if (!lstatSync(file).isFile()) throw new Error('not a regular file');
        const body = readFileSync(file);
        res.writeHead(200, { 'Content-Type': TYPES[ext0 as string] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', ...(ext0 === 'svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
        res.end(body);
      } catch {
        sendText(res, 404, 'not found');
      }
      return;
    }
    if (isPushPath(path)) {
      const grant = authHttp.grant(req, 'api');
      if (grant === null) return sendApiError(res, 401, 'unauthorized', 'unauthorized', undefined, { 'WWW-Authenticate': 'Bearer' });
      if (grant.kind === 'session' && !authHttp.csrfOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
      if (grant.kind === 'key' && !keyMayDo(grant.scope ?? 'read', req.method ?? 'GET', path)) return sendApiError(res, 403, 'this key may not do that', 'forbidden');
      // a device is tied to a login session; a key, the old token and the local socket have none
      void pushApi(push, req, res, path, grant.kind === 'session' ? (grant.sessionId ?? null) : null);
      return;
    }
    const rooms = /^\/api\/rooms(?:\/([^/]+)(?:\/(migrate|stop|start))?)?$/.exec(path);
    if (rooms !== null) {
      const grant = authHttp.grant(req, 'api');
      if (grant === null) return sendApiError(res, 401, 'unauthorized', 'unauthorized', undefined, { 'WWW-Authenticate': 'Bearer' });
      if (grant.kind === 'session' && !authHttp.csrfOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
      if (grant.kind === 'key' && !keyMayDo(grant.scope ?? 'read', req.method ?? 'GET', path)) return sendApiError(res, 403, 'this key may not do that', 'forbidden');
      if (rooms[2] === 'migrate') void (rooms[1] === 'main' ? migrateApi(req, res, grant) : sendApiError(res, 404, 'not found', 'not_found'));
      else if (rooms[2] === 'stop' || rooms[2] === 'start' || rooms[1] === 'stop-all' || rooms[1] === 'start-all') void powerApi(req, res, grant, rooms[2] ?? (rooms[1] as string), rooms[2] === undefined ? undefined : rooms[1]);
      else void roomsApi(req, res, grant, rooms[1]);
      return;
    }
    sendText(res, 404, 'not found');
  };
  const onUpgrade = (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    if (!proxy.upgrade(req, socket, head)) socket.destroy();
  };
  const server = http.createServer(onRequest);
  server.on('upgrade', onUpgrade);
  // the local door: the unix socket is this machine's own, and its file permissions are the credential (R2)
  const socketPath = join(options.home, API_SOCKET);
  const socketServer = http.createServer((req, res) => {
    localReqs.add(req);
    onRequest(req, res);
  });
  socketServer.on('upgrade', (req, socket, head) => {
    localReqs.add(req);
    onUpgrade(req, socket, head);
  });

  try {
    reconcile();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => resolve());
    });
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(socketPath), 0o700);
    rmSync(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen({ path: socketPath }, () => resolve());
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    // a start that fails leaves no lock and no child behind
    stopping = true;
    await Promise.all([...children.values()].map((c) => halt(c)));
    auth.close();
    proxy.close();
    releaseLock();
    throw error;
  }
  // the token file is looked at on this beat too, so a rotated token closes the old sockets within seconds whatever the traffic
  const poll = setInterval(() => {
    currentToken();
    reconcile();
    // a session that ended unseen (a reset, the tamper alarm, an outside edit of the file) takes its phones with it within a beat
    void push.prune((id) => auth.alive(id));
  }, POLL_MS);
  // `gonogo rooms add` looks for this file to tell whether anything will act on a change
  writeSupervisorFile(options.home, options.host, (server.address() as { port: number }).port);
  poll.unref();
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const shownHost = ['0.0.0.0', '::', '127.0.0.1'].includes(options.host) ? '127.0.0.1' : options.host.includes(':') ? `[${options.host}]` : options.host;

  return {
    host: options.host,
    port,
    get directorToken() {
      return currentToken();
    },
    auth,
    socketPath,
    setupToken: madeSetupToken,
    url: `http://${shownHost}:${port}/${directorToken === null ? '' : `#token=${directorToken}`}`,
    rooms: () => [...children.values()].map((c) => ({ id: c.entry.id, name: c.entry.name, state: c.state, autostart: c.entry.id === MAIN_ROOM || c.entry.autostart, note: c.lastError, ...NO_COUNTS })),
    whenReady: (ms) => Promise.race([mainReady, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]),
    async reload() {
      if (reloading || stopping) return;
      reloading = true;
      for (const child of children.values()) {
        if (child.timer !== null) clearTimeout(child.timer);
        const proc = child.proc;
        if (proc === null) continue;
        proc.kill('SIGUSR2');
        const kill = setTimeout(() => proc.kill('SIGKILL'), STOP_WAIT_MS);
        void (child.exited ?? Promise.resolve()).finally(() => clearTimeout(kill));
      }
      await Promise.all([...children.values()].map((c) => c.exited ?? Promise.resolve()));
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(poll);
      removeSupervisorFile(options.home);
      server.closeAllConnections?.();
      socketServer.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      rmSync(socketPath, { force: true });
      auth.close();
      proxy.close();
      await Promise.all([...children.values()].map((c) => halt(c)));
      await push.close();
      releaseLock();
    },
  };
}
