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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { nullLogger, SHUTDOWN_MAX_MS } from './constants.js';
import { bearerToken, sendJson, sendText } from './hooks.js';
import { clientStylesheet, roomsPage, roomsPageHeaders } from './roomspage.js';
import { createRoomProxy, sameToken } from './roomproxy.js';
import { loadRooms, MAIN_ROOM, roomHome } from './rooms.js';
import type { RoomEntry } from './rooms.js';
import { hostName } from './web.js';

const DIRECTOR_TOKEN_FILE = 'rooms-token';
const READY = /gonogo ready: http:\/\/[^\s/:]+:(\d{1,5})\/#token=([0-9a-f]{64})/;
const POLL_MS = 2000;
const STATUS_TTL_MS = 3000;
const START_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];
// a room gives up its own shutdown after SHUTDOWN_MAX_MS: wait longer than that before SIGKILL, or the kill lands in the middle of it
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
  /** Why a room that is not running is not (its last error line), or null. */
  note: string | null;
}

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

/** The Director token: its own file, so that it is never a room's token. 0600. */
export function directorTokenOf(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
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
  const directorToken = directorTokenOf(options.home);
  const children = new Map<string, Child>();
  let stopping = false;
  const statusCache = new Map<string, { at: number; value: Pick<RoomView, 'agents' | 'running' | 'needsYou'> }>();

  const allowedNames = new Set<string>(options.allowedHosts.map((h) => hostName(h) ?? h.trim().toLowerCase()).filter((h) => h !== ''));
  if (!['0.0.0.0', '::', ''].includes(options.host)) allowedNames.add(hostName(options.host) ?? options.host.toLowerCase());

  /* ---------------------------------------------------------------- the children */

  function launch(child: Child): void {
    if (stopping || !child.wanted) return;
    const home = roomHome(options.home, child.entry.id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const env = { ...options.env };
    // the flags below win over these, but a room must not see the supervisor's own settings by mistake
    for (const name of ['GONOGO_PORT', 'GONOGO_HOST', 'GONOGO_TOKEN']) delete env[name];
    env.GONOGO_HOME = home;
    const [file, ...head] = options.command;
    const args = [...head, '--home', home, '--port', '0', '--host', '127.0.0.1', '--exit-with-stdin', ...(child.entry.id === MAIN_ROOM ? [] : ['--no-update-check']), ...(options.roomArgs ?? [])];
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
        const ready = READY.exec(line);
        if (ready !== null && child.proc === proc) {
          child.port = Number(ready[1]);
          child.token = ready[2] ?? null;
          child.state = 'running';
          child.lastError = null;
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

  async function statusOf(child: Child): Promise<Pick<RoomView, 'agents' | 'running' | 'needsYou'>> {
    const none = { agents: null, running: null, needsYou: null };
    if (child.port === null || child.token === null) return none;
    const cached = statusCache.get(child.entry.id);
    if (cached !== undefined && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
    try {
      const res = await fetch(`http://127.0.0.1:${child.port}/api/state`, { headers: { authorization: `Bearer ${child.token}` }, signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as { agents?: Array<{ state?: string }> };
      const agents = Array.isArray(body.agents) ? body.agents : [];
      const value = { agents: agents.length, running: agents.filter((a) => a.state !== 'stopped').length, needsYou: agents.filter((a) => a.state === 'needs_you').length };
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
  const TYPES: Record<string, string> = { css: 'text/css', woff: 'font/woff', woff2: 'font/woff2' };

  const proxy = createRoomProxy({
    directorToken,
    allowedNames,
    rooms: () => [...children.values()].map((c) => ({ id: c.entry.id, port: c.state === 'running' ? c.port : null, token: c.token })),
  });

  const hostOk = (header: string | undefined): boolean => {
    const name = header === undefined ? null : hostName(header);
    return name !== null && (['127.0.0.1', 'localhost', '::1'].includes(name) || allowedNames.has(name));
  };

  const server = http.createServer((req, res) => {
    if (proxy.handle(req, res)) return;
    if (!hostOk(req.headers.host)) return sendText(res, 403, 'forbidden host');
    const path = (req.url ?? '').split('?')[0];
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, roomsPageHeaders());
      res.end(req.method === 'HEAD' ? undefined : roomsPage(stylesheet));
      return;
    }
    // the stylesheet and fonts of the built client, for the list page: a plain file name, only css and fonts
    const asset = /^\/assets\/([\w.-]+\.(css|woff2?))$/.exec(path ?? '');
    if (asset !== null && assetsDir !== null && req.method === 'GET' && !(asset[1] as string).includes('..')) {
      try {
        const body = readFileSync(join(assetsDir, asset[1] as string));
        res.writeHead(200, { 'Content-Type': TYPES[asset[2] as string] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        res.end(body);
      } catch {
        sendText(res, 404, 'not found');
      }
      return;
    }
    if (path === '/api/rooms' && req.method === 'GET') {
      const token = bearerToken(req.headers.authorization);
      if (!sameToken(token, directorToken)) return sendText(res, 401, 'unauthorized');
      void viewsNow().then((rooms) => sendJson(res, 200, { rooms }, { 'Cache-Control': 'no-store' }));
      return;
    }
    sendText(res, 404, 'not found');
  });
  server.on('upgrade', (req, socket, head) => {
    if (!proxy.upgrade(req, socket, head)) socket.destroy();
  });

  reconcile();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const poll = setInterval(reconcile, POLL_MS);
  poll.unref();
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const shownHost = ['0.0.0.0', '::', '127.0.0.1'].includes(options.host) ? '127.0.0.1' : options.host.includes(':') ? `[${options.host}]` : options.host;

  return {
    host: options.host,
    port,
    directorToken,
    url: `http://${shownHost}:${port}/#token=${directorToken}`,
    rooms: () => [...children.values()].map((c) => ({ id: c.entry.id, name: c.entry.name, state: c.state, note: c.lastError, agents: null, running: null, needsYou: null })),
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(poll);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([...children.values()].map((c) => halt(c)));
    },
  };
}
