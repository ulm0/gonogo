/**
 * The pty host (docs/live-reload-spec.md): a small process that owns the agents' ptys and their headless mirrors, so that a new
 * gonogo can take over without killing them. It runs the ordinary terminal host (terminal.ts) and serves it on a unix socket.
 *
 * Security: the socket is in `<home>/run` (0700) and is 0600; the first frame must carry the key of `<home>/run/ptyhost.key` (0600),
 * compared in constant time, so a stray local connection does nothing. One hub at a time: a new authenticated connection replaces
 * the old one. The host has no gonogo logic and never touches the roster, messages or tokens.
 *
 * shortcut: output is not flow-controlled: a hub that stops reading lets the socket buffer grow until the hub drops it.
 * shortcut: an exit that happens while no hub is connected is not replayed: the next hub sees the agent as not running (list).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import type { Attachment, Logger, SpawnSpec, TerminalHost } from '../shared/protocol.js';
import { nullLogger } from './constants.js';
import { createTerminalHost } from './terminal.js';
import { encodeJson, encodeOutput, FrameReader, FRAME_JSON, FRAME_OUTPUT, KEY_FILE, PTYHOST_VERSION, RUN_DIR, SOCKET_FILE } from './ptyhostproto.js';

/** The longest unix socket path the kernel takes (sun_path is 108 bytes on Linux, 104 on macOS). */
const SOCKET_PATH_MAX = 100;
const STATE_POLL_MS = 100;
const IDLE_CHECK_MS = 1000;
/** The host exits when it has no agent and no hub for this long. */
export const HOST_IDLE_EXIT_MS = 60_000;

export interface PtyHostOptions {
  homeDir: string;
  /** Default: a new terminal host. Tests pass their own. */
  host?: TerminalHost;
  idleExitMs?: number;
  /** Called once when the host ends by itself (idle or told to quit): the process exits there. */
  onExit?: () => void;
  log?: Logger;
}

export interface PtyHost {
  socketPath: string;
  /** Closes the socket and the connection; the agents keep running unless `stopAgents` is true. */
  close(stopAgents?: boolean): Promise<void>;
}

export function runDir(homeDir: string): string {
  return join(homeDir, RUN_DIR);
}
export function socketPathOf(homeDir: string): string {
  return join(runDir(homeDir), SOCKET_FILE);
}
export function keyPathOf(homeDir: string): string {
  return join(runDir(homeDir), KEY_FILE);
}

/** Makes `<home>/run` (0700, owned by this user) and returns the key, creating it (0600) when there is none. */
export async function prepareRunDir(homeDir: string): Promise<string> {
  const dir = runDir(homeDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const info = await stat(dir);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`${dir} is not owned by this user`);
  const keyPath = keyPathOf(homeDir);
  try {
    const existing = (await readFile(keyPath, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      await chmod(keyPath, 0o600);
      return existing;
    }
  } catch {
    // none yet
  }
  const key = randomBytes(32).toString('hex');
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return key;
}

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
const sameKey = (a: unknown, b: string): boolean => typeof a === 'string' && timingSafeEqual(digest(a), digest(b));

/** Is something listening on this socket? A refused or missing one is stale. */
function probe(path: string): Promise<'alive' | 'stale'> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const done = (answer: 'alive' | 'stale'): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect', () => done('alive'));
    socket.once('error', () => done('stale'));
    socket.setTimeout(1000, () => done('alive'));
  });
}

interface Conn {
  socket: net.Socket;
  reader: FrameReader;
  authed: boolean;
  attachments: Map<number, { attachment: Attachment; started: boolean }>;
  sent: Map<string, string>;
}

export async function startPtyHost(options: PtyHostOptions): Promise<PtyHost> {
  const log = options.log ?? nullLogger;
  const host = options.host ?? createTerminalHost({ log: log.child('terminal') });
  const idleExitMs = options.idleExitMs ?? HOST_IDLE_EXIT_MS;
  const socketPath = socketPathOf(options.homeDir);
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX) throw new Error(`the socket path is too long for a unix socket (${Buffer.byteLength(socketPath)} bytes, at most ${SOCKET_PATH_MAX}): ${socketPath}`);
  const key = await prepareRunDir(options.homeDir);

  if (existsSync(socketPath)) {
    if ((await probe(socketPath)) === 'alive') throw new Error(`another pty host is already listening on ${socketPath}`);
    await unlink(socketPath).catch(() => undefined);
    log.info('removed a stale pty host socket');
  }

  let current: Conn | null = null;
  let closed = false;
  let idleSince: number | null = Date.now();
  const timers: NodeJS.Timeout[] = [];

  const send = (conn: Conn, value: unknown): void => {
    if (!conn.socket.destroyed) conn.socket.write(encodeJson(value));
  };
  const reply = (conn: Conn, id: unknown, run: () => unknown | Promise<unknown>): void => {
    void (async () => {
      try {
        send(conn, { id, ok: true, result: (await run()) ?? null });
      } catch (error) {
        send(conn, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };

  const states = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const item of host.list?.() ?? []) {
      out[item.name] = { info: host.info(item.name), screen: host.screen(item.name), title: host.title(item.name), bytes: host.outputBytes(item.name), paste: item.paste };
    }
    return out;
  };
  /** Pushes what changed since the last push to this connection (all of it when `all`). */
  const pushStates = (conn: Conn, all = false): void => {
    const changed: Record<string, unknown> = {};
    const now = states();
    for (const [name, state] of Object.entries(now)) {
      const text = JSON.stringify(state);
      if (all || conn.sent.get(name) !== text) {
        conn.sent.set(name, text);
        changed[name] = state;
      }
    }
    for (const name of [...conn.sent.keys()]) {
      if (!(name in now)) {
        conn.sent.delete(name);
        changed[name] = null;
      }
    }
    if (Object.keys(changed).length > 0) send(conn, { op: 'state', states: changed });
  };

  const dropAttachments = (conn: Conn): void => {
    for (const { attachment } of conn.attachments.values()) attachment.detach();
    conn.attachments.clear();
  };

  const unsubscribe = host.onEvent((event) => {
    if (current?.authed) send(current, { op: 'event', event });
  });

  const handle = (conn: Conn, message: Record<string, unknown>): void => {
    const op = message.op;
    const id = message.id;
    if (!conn.authed) {
      if (op === 'quit' && sameKey(message.key, key)) {
        void ending(true);
        return;
      }
      if (op !== 'hello' || !sameKey(message.key, key)) {
        conn.socket.destroy();
        return;
      }
      if (message.version !== PTYHOST_VERSION) {
        send(conn, { op: 'hello', ok: false, reason: 'version', version: PTYHOST_VERSION });
        conn.socket.end();
        return;
      }
      conn.authed = true;
      const old = current;
      current = conn;
      idleSince = null;
      if (old) {
        // told, so that it does not fight back by reconnecting
        send(old, { op: 'replaced' });
        dropAttachments(old);
        old.socket.end();
      }
      send(conn, { op: 'hello', ok: true, version: PTYHOST_VERSION, pid: process.pid, agents: host.list?.() ?? [] });
      pushStates(conn, true);
      return;
    }
    const name = typeof message.name === 'string' ? message.name : '';
    switch (op) {
      case 'spawn':
        reply(conn, id, () => host.spawn(name, Number(message.generation), message.spec as SpawnSpec));
        break;
      case 'stop':
        reply(conn, id, () => host.stop(name, typeof message.generation === 'number' ? message.generation : undefined));
        break;
      case 'stopAll':
        reply(conn, id, () => host.stopAll());
        break;
      case 'write':
        reply(conn, id, () => host.write(name, Buffer.from(String(message.b64 ?? ''), 'base64')));
        break;
      case 'submit':
        reply(conn, id, () => host.submit(name, Number(message.generation), String(message.text ?? '')));
        break;
      case 'resize':
        reply(conn, id, () => host.resize(name, Number(message.cols), Number(message.rows)));
        break;
      case 'rename':
        reply(conn, id, () => host.rename(String(message.from ?? ''), String(message.to ?? '')));
        break;
      case 'forget':
        reply(conn, id, () => host.forget?.(name));
        break;
      case 'attach': {
        const aid = Number(message.aid);
        reply(conn, id, async () => {
          const entry = { attachment: null as unknown as Attachment, started: false };
          const attachment = await host.attach(name, (chunk) => {
            if (entry.started && !conn.socket.destroyed) conn.socket.write(encodeOutput(aid, chunk));
          });
          entry.attachment = attachment;
          conn.attachments.set(aid, entry);
          return attachment.snapshot;
        });
        break;
      }
      case 'attach-start': {
        const entry = conn.attachments.get(Number(message.aid));
        if (entry && !entry.started) {
          entry.started = true;
          entry.attachment.start();
        }
        break;
      }
      case 'detach': {
        const aid = Number(message.aid);
        conn.attachments.get(aid)?.attachment.detach();
        conn.attachments.delete(aid);
        break;
      }
      case 'shutdown':
        reply(conn, id, () => undefined);
        void ending(true);
        break;
      default:
        send(conn, { id, ok: false, error: `unknown operation ${String(op)}` });
    }
  };

  const server = net.createServer((socket) => {
    const conn: Conn = { socket, reader: new FrameReader(), authed: false, attachments: new Map(), sent: new Map() };
    // a peer that never says hello is dropped
    const hello = setTimeout(() => {
      if (!conn.authed) socket.destroy();
    }, 5000);
    socket.on('data', (chunk) => {
      try {
        for (const frame of conn.reader.push(chunk)) {
          if (frame.type === FRAME_JSON && typeof frame.json === 'object' && frame.json !== null) handle(conn, frame.json as Record<string, unknown>);
          else if (frame.type === FRAME_OUTPUT) throw new Error('the hub sends no output frames');
        }
      } catch (error) {
        log.warn(`pty host: dropping a connection: ${error instanceof Error ? error.message : String(error)}`);
        socket.destroy();
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(hello);
      dropAttachments(conn);
      if (current === conn) {
        current = null;
        idleSince = Date.now();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  timers.push(
    setInterval(() => {
      if (current?.authed) pushStates(current);
    }, STATE_POLL_MS),
    setInterval(() => {
      if (current !== null) return;
      const running = (host.list?.() ?? []).some((item) => item.running);
      if (running) idleSince = null;
      else if (idleSince === null) idleSince = Date.now();
      else if (Date.now() - idleSince >= idleExitMs) void ending(false);
    }, Math.min(IDLE_CHECK_MS, idleExitMs)),
  );
  for (const timer of timers) timer.unref();

  let endingPromise: Promise<void> | null = null;
  async function ending(stopAgents: boolean, byOwner = false): Promise<void> {
    endingPromise ??= (async () => {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      unsubscribe();
      if (stopAgents) await host.stopAll().catch(() => undefined);
      if (current) {
        dropAttachments(current);
        current.socket.destroy();
        current = null;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
      if (!byOwner) options.onExit?.();
    })();
    return endingPromise;
  }
  log.info(`pty host listening on ${socketPath} (pid ${process.pid})`);
  return {
    socketPath,
    close: (stopAgents = false) => (closed ? (endingPromise ?? Promise.resolve()) : ending(stopAgents, true)),
  };
}
