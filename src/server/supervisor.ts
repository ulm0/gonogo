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
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { nullLogger, SHUTDOWN_MAX_MS } from './constants.js';
import { bearerToken, sendApiError, sendJson, sendText } from './hooks.js';
import { clientStylesheet, ROOMS_PATH, roomsPage, roomsPageHeaders } from './roomspage.js';
import { createRoomProxy, sameToken } from './roomproxy.js';
import { acquireSupervisorLock } from './home.js';
import { addRoom, loadRooms, roomText, MAIN_ROOM, removeRoom, removeSupervisorFile, renameRoom, RoomsError, roomHome, validRoomId, writeSupervisorFile } from './rooms.js';
import type { RoomEntry } from './rooms.js';
import { hostName } from './web.js';

const DIRECTOR_TOKEN_FILE = 'token';
const RELOAD_EXIT = 75;
const READY = /gonogo ready: http:\/\/[^\s/:]+:(\d{1,5})\/#token=([0-9a-f]{64})/;
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
  /** Agents of the room, running ones, and those that need the Director; null while it cannot be asked. */
  agents: number | null;
  running: number | null;
  needsYou: number | null;
  /** Agents in the working state; null while it cannot be asked. */
  working: number | null;
  /** ms epoch of the newest message or state change of the room, or null (none, or it cannot be asked). */
  lastActivity: number | null;
  /** The tab name of the room (the Director's, else the station's), or null. */
  tabName: string | null;
  /** Why a room that is not running is not (its last error line), or null. */
  note: string | null;
}

type Counts = Pick<RoomView, 'agents' | 'running' | 'needsYou' | 'working' | 'lastActivity' | 'tabName'>;
const NO_COUNTS: Counts = { agents: null, running: null, needsYou: null, working: null, lastActivity: null, tabName: null };

export interface SupervisorOptions {
  /** The root home: room `main`, `rooms.json`, `rooms/<id>/`, the Director token. */
  home: string;
  host: string;
  /** 0 for any (tests). */
  port: number;
  allowedHosts: string[];
  /** The command that starts a gonogo: [node, entry]. */
  command: string[];
  env: NodeJS.ProcessEnv;
  /** Extra arguments for every room (for a test's stand-in agent no flag is needed: the environment carries it). */
  roomArgs?: string[];
  /** The running version, shown in the corner of the list page. */
  version?: string;
  /** The built client (dist/client): its stylesheet dresses the list page, served from /assets/. Absent or without a build: plain styles. */
  staticDir?: string | null;
  log?: Logger;
}

export interface Supervisor {
  host: string;
  port: number;
  directorToken: string;
  url: string;
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
  token: string | null;
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
  // one supervisor per home; the lock is released by stop() (and by the process ending, for the stale-pid rule)
  const releaseLock = acquireSupervisorLock(options.home);
  let directorToken: string;
  try {
    directorToken = directorTokenOf(options.home, loadRooms(options.home).filter((r) => r.id !== MAIN_ROOM).map((r) => r.id));
  } catch (error) {
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
  const currentToken = (): string => {
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
  const children = new Map<string, Child>();
  let stopping = false;
  const statusCache = new Map<string, { at: number; value: Counts }>();

  const allowedNames = new Set<string>(options.allowedHosts.map((h) => hostName(h) ?? h.trim().toLowerCase()).filter((h) => h !== ''));
  if (!['0.0.0.0', '::', ''].includes(options.host)) allowedNames.add(hostName(options.host) ?? options.host.toLowerCase());

  /* ---------------------------------------------------------------- the children */

  function launch(child: Child): void {
    if (stopping || reloading || !child.wanted) return;
    const home = roomHome(options.home, child.entry.id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const env = { ...options.env };
    // the flags below win over these, but a room must not see the supervisor's own settings by mistake
    for (const name of ['GONOGO_PORT', 'GONOGO_HOST', 'GONOGO_TOKEN', 'GONOGO_BROWSER_TOKEN']) delete env[name];
    env.GONOGO_HOME = home;
    env.GONOGO_ROOM = child.entry.id;
    // the update hook is main's: the other rooms never get its address or its token
    if (child.entry.id !== MAIN_ROOM) for (const name of ['GONOGO_UPDATE_HOOK', 'GONOGO_UPDATE_HOOK_TOKEN']) delete env[name];
    // a room that is told to reload signals this process, and only this one
    env.GONOGO_SUPERVISOR_PID = String(process.pid);
    const [file, ...head] = options.command;
    const args = [...head, '__room', '--home', home, '--port', '0', '--host', '127.0.0.1', '--exit-with-stdin', ...(child.entry.id === MAIN_ROOM ? [] : ['--no-update-check']), ...(options.roomArgs ?? [])];
    child.state = 'starting';
    child.port = null;
    child.token = null;
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
        if (line === 'gonogo-ask busy' && child.proc === proc) {
          void answerBusy(child, proc);
          continue;
        }
        const ready = READY.exec(line);
        if (ready !== null && child.proc === proc) {
          child.port = Number(ready[1]);
          child.token = ready[2] ?? null;
          child.state = 'running';
          child.lastError = null;
          if (child.entry.id === MAIN_ROOM) {
            mainReadyOnce = true;
            markMainReady();
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
        child.token = null;
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

  /** The answer to `gonogo-ask busy`: whether a room other than the asker has a T-minus poll or Static fire open. One line back, two fields, nothing else. */
  async function answerBusy(asker: Child, proc: ChildProcess): Promise<void> {
    let busy: string | null = null;
    let room: string | null = null;
    for (const other of children.values()) {
      if (other === asker || other.port === null || other.token === null) continue;
      try {
        const res = await fetch(`http://127.0.0.1:${other.port}/api/state`, { headers: { authorization: `Bearer ${other.token}` }, signal: AbortSignal.timeout(2000) });
        const body = (await res.json()) as { poll?: { status?: string } | null };
        if (body.poll?.status === 'open') {
          busy = `a T-minus poll or Static fire is open in room "${other.entry.name}": wait for its answer, then update`;
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
        const child: Child = { entry, proc: null, port: null, token: null, state: 'stopped', failures: 0, startedAt: 0, timer: null, wanted: entry.autostart, lastError: null, exited: null };
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
    if (child.port === null || child.token === null) return none;
    const cached = statusCache.get(child.entry.id);
    if (cached !== undefined && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    try {
      const res = await fetch(`http://127.0.0.1:${child.port}/api/state`, { headers: { authorization: `Bearer ${child.token}` }, signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as { agents?: Array<{ state?: string; stateSince?: number }>; activity?: Array<{ at?: number }>; tabName?: { name?: string | null; fallback?: string | null } };
      const agents = Array.isArray(body.agents) ? body.agents : [];
      const times = [...agents.map((a) => a.stateSince), body.activity?.[0]?.at].filter((t): t is number => typeof t === 'number' && t > 0);
      const tab = body.tabName?.name ?? body.tabName?.fallback;
      const value: Counts = {
        agents: agents.length,
        running: agents.filter((a) => a.state !== 'stopped').length,
        needsYou: agents.filter((a) => a.state === 'needs_you').length,
        working: agents.filter((a) => a.state === 'working').length,
        lastActivity: times.length === 0 ? null : Math.max(...times),
        tabName: typeof tab === 'string' && roomText(tab) !== '' ? roomText(tab) : null,
      };
      statusCache.set(child.entry.id, { at: Date.now(), value });
      return value;
    } catch {
      return none;
    }
  }

  const viewsNow = async (): Promise<RoomView[]> =>
    Promise.all([...children.values()].map(async (c) => ({ id: c.entry.id, name: c.entry.name, state: c.state, note: c.state === 'running' ? null : c.lastError, ...(await statusOf(c)) })));

  /* ---------------------------------------------------------------- the front port */

  const stylesheet = clientStylesheet(options.staticDir ?? null);
  const assetsDir = options.staticDir === null || options.staticDir === undefined ? null : join(options.staticDir, 'assets');
  const TYPES: Record<string, string> = { css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', svg: 'image/svg+xml' };

  const proxy = createRoomProxy({
    directorToken: currentToken,
    allowedNames,
    rooms: () => [...children.values()].map((c) => ({ id: c.entry.id, port: c.state === 'running' ? c.port : null, token: c.token })),
  });

  closeDirectorSockets = () => proxy.closeSockets();

  const hostOk = (header: string | undefined): boolean => {
    const name = header === undefined ? null : hostName(header);
    return name !== null && (['127.0.0.1', 'localhost', '::1'].includes(name) || allowedNames.has(name));
  };

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

  const roomView = async (id: string): Promise<RoomView | undefined> => (await viewsNow()).find((r) => r.id === id);

  /** GET lists; POST adds; PATCH renames; DELETE takes a room off the list (its folder stays). The Director token was checked. */
  async function roomsApi(req: http.IncomingMessage, res: http.ServerResponse, rawId: string | undefined): Promise<void> {
    try {
      const method = req.method ?? '';
      if (method === 'GET' && rawId === undefined) return sendJson(res, 200, { rooms: await viewsNow() }, { 'Cache-Control': 'no-store' });
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
        removeRoom(options.home, id);
        reconcile();
        return sendJson(res, 200, { ok: true, note: `room ${id} was taken off the list and is stopping; its folder stays` });
      }
      const body = await readBody(req);
      if (method === 'POST') {
        const entry = addRoom(options.home, body.id, typeof body.name === 'string' ? body.name : undefined);
        reconcile();
        return sendJson(res, 201, (await roomView(entry.id)) ?? entry);
      }
      const entry = renameRoom(options.home, id, body.name);
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

  const server = http.createServer((req, res) => {
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
    if ((path === ROOMS_PATH || path === `${ROOMS_PATH}/`) && get) {
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
    const rooms = /^\/api\/rooms(?:\/([^/]+))?$/.exec(path);
    if (rooms !== null) {
      if (!sameToken(bearerToken(req.headers.authorization), currentToken())) return sendApiError(res, 401, 'unauthorized', 'unauthorized', undefined, { 'WWW-Authenticate': 'Bearer' });
      void roomsApi(req, res, rooms[1]);
      return;
    }
    sendText(res, 404, 'not found');
  });
  server.on('upgrade', (req, socket, head) => {
    if (!proxy.upgrade(req, socket, head)) socket.destroy();
  });

  try {
    reconcile();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => resolve());
    });
  } catch (error) {
    // a start that fails leaves no lock and no child behind
    stopping = true;
    await Promise.all([...children.values()].map((c) => halt(c)));
    releaseLock();
    throw error;
  }
  // the token file is looked at on this beat too, so a rotated token closes the old sockets within seconds whatever the traffic
  const poll = setInterval(() => {
    currentToken();
    reconcile();
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
    url: `http://${shownHost}:${port}/#token=${directorToken}`,
    rooms: () => [...children.values()].map((c) => ({ id: c.entry.id, name: c.entry.name, state: c.state, note: c.lastError, ...NO_COUNTS })),
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([...children.values()].map((c) => halt(c)));
      releaseLock();
    },
  };
}
