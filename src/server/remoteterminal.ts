/**
 * The hub's side of the pty host (docs/live-reload-spec.md): a TerminalHost whose ptys live in another process.
 *
 * The TerminalHost interface is mostly synchronous (screen, title, info, write, resize...), and the sweep reads the screen on a timer.
 * So the host pushes the state of every agent (info, screen probe, title, output bytes) at most every 100 ms, and these calls read
 * the last push: at most one push late. Writes are sent without waiting and answer from the cache. `spawn` cannot be synchronous here
 * (it needs the host's answer), so the server calls `spawnAsync`.
 *
 * Loss of the host: it reconnects for a few seconds; when the host is gone, every agent it ran gets an `exit` event (killed, not
 * requested) so the hub treats it as a crash and the next start launches a new host.
 */
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import type { Attachment, ExitInfo, Logger, ScreenProbe, Snapshot, SpawnSpec, TerminalEvent, TerminalHost, TerminalInfo, TerminalListItem, TitleInfo } from '../shared/protocol.js';
import { nullLogger } from './constants.js';
import { encodeJson, FrameReader, FRAME_JSON, FRAME_OUTPUT, PTYHOST_VERSION } from './ptyhostproto.js';
import { keyPathOf, socketPathOf } from './ptyhost.js';

const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_MS = 100;

export interface RemoteTerminalOptions {
  homeDir: string;
  log?: Logger;
  /** Starts the host process (detached) when none answers. Absent: connecting to a host that is not there fails. */
  startHost?: () => void;
  /** How long `connect` waits for a host that was just started, default 8000. */
  connectTimeoutMs?: number;
  /** How long a lost connection is retried before the agents are declared gone, default 3000. */
  reconnectWindowMs?: number;
  now?: () => number;
}

export type ConnectResult =
  | { ok: true; agents: TerminalListItem[]; pid: number }
  | { ok: false; reason: 'version' | 'unreachable' | 'refused'; detail: string };

export interface RemoteTerminalHost extends TerminalHost {
  spawnAsync(name: string, generation: number, spec: SpawnSpec): Promise<{ pid: number }>;
  list(): TerminalListItem[];
  /** Connects to the host (starting one when `startHost` is given and none answers) and returns what runs there. */
  connect(): Promise<ConnectResult>;
  /** Leaves the host and its agents running. */
  disconnect(): void;
  /** Asks the host to stop every agent and exit (any version of the host takes this as its first frame). */
  quitHost(): Promise<boolean>;
  connected(): boolean;
}

interface CachedState {
  info: TerminalInfo | null;
  screen: ScreenProbe | null;
  title: TitleInfo | null;
  bytes: number;
  paste: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const EMPTY_SNAPSHOT: Snapshot = { cols: 80, rows: 24, data: '', generation: 0, running: false };

export function createRemoteTerminalHost(options: RemoteTerminalOptions): RemoteTerminalHost {
  const log = options.log ?? nullLogger;
  const now = options.now ?? Date.now;
  const socketPath = socketPathOf(options.homeDir);
  const cache = new Map<string, CachedState>();
  const handlers: Array<(event: TerminalEvent) => void> = [];
  const pending = new Map<number, Pending>();
  const listeners = new Map<number, (chunk: Uint8Array) => void>();
  let socket: net.Socket | null = null;
  let up = false;
  let wanted = false;
  let requestId = 0;
  let attachId = 0;
  let reconnecting = false;

  const emit = (event: TerminalEvent): void => {
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (error) {
        log.error('terminal event handler threw', error);
      }
    }
  };

  const write = (value: unknown): boolean => {
    if (!socket || socket.destroyed || !up) return false;
    socket.write(encodeJson(value));
    return true;
  };

  const request = (op: string, payload: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = (requestId += 1);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the pty host did not answer ${op}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      if (!write({ op, id, ...payload })) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('the pty host is not connected'));
      }
    });

  const failPending = (why: string): void => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      pending.delete(id);
    }
  };

  const applyState = (states: Record<string, CachedState | null>): void => {
    for (const [name, state] of Object.entries(states)) {
      if (state === null) cache.delete(name);
      else cache.set(name, state);
    }
  };

  const exitFor = (name: string, generation: number): TerminalEvent => {
    const info: ExitInfo = { code: null, signal: 9, durationMs: 0, requested: false, tail: 'the pty host is gone' };
    return { kind: 'exit', name, generation, info, at: now() };
  };

  /** The host is gone for good: its agents are gone with it. */
  const declareGone = (): void => {
    for (const [name, state] of [...cache]) {
      if (state.info?.running) {
        cache.set(name, { ...state, info: { ...state.info, running: false, pid: null } });
        emit(exitFor(name, state.info.generation));
      }
    }
  };

  const onMessage = (message: Record<string, unknown>): void => {
    if (message.op === 'replaced') {
      // another gonogo took the host over: this one is going away and must not take it back
      wanted = false;
      log.warn('another gonogo took over the pty host');
    } else if (message.op === 'state') {
      applyState(message.states as Record<string, CachedState | null>);
    } else if (message.op === 'event') {
      const event = message.event as TerminalEvent;
      // the cache moves first, so a handler that asks info() sees the exit
      if (event.kind === 'exit') {
        const state = cache.get(event.name);
        if (state?.info && state.info.generation === event.generation) cache.set(event.name, { ...state, info: { ...state.info, running: false, pid: null } });
      }
      emit(event);
    } else if (typeof message.id === 'number') {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.ok === true) p.resolve(message.result);
      else p.reject(new Error(typeof message.error === 'string' ? message.error : 'the pty host refused'));
    }
  };

  /** One attempt: connect, say hello, wait for the answer. */
  const attempt = async (): Promise<ConnectResult> => {
    let key: string;
    try {
      key = (await readFile(keyPathOf(options.homeDir), 'utf8')).trim();
    } catch {
      return { ok: false, reason: 'unreachable', detail: 'no pty host key yet' };
    }
    return new Promise<ConnectResult>((resolve) => {
      const s = net.connect(socketPath);
      const reader = new FrameReader();
      let settled = false;
      const settle = (result: ConnectResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ok) s.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => settle({ ok: false, reason: 'unreachable', detail: 'the pty host did not answer hello' }), 5000);
      s.once('connect', () => s.write(encodeJson({ op: 'hello', key, version: PTYHOST_VERSION })));
      s.on('data', (chunk) => {
        let frames;
        try {
          frames = reader.push(chunk);
        } catch (error) {
          settle({ ok: false, reason: 'refused', detail: error instanceof Error ? error.message : String(error) });
          return;
        }
        for (const frame of frames) {
          if (frame.type === FRAME_OUTPUT) {
            listeners.get(frame.attachment)?.(frame.bytes);
          } else if (frame.type === FRAME_JSON && typeof frame.json === 'object' && frame.json !== null) {
            const message = frame.json as Record<string, unknown>;
            if (!settled && message.op === 'hello') {
              if (message.ok === true) {
                socket = s;
                up = true;
                // the state push follows at once; until it is read, what the hello says is enough to find the agents
                for (const a of (message.agents as TerminalListItem[]) ?? []) {
                  if (!cache.has(a.name)) cache.set(a.name, { info: { running: a.running, generation: a.generation, pid: a.pid, cols: 80, rows: 24 }, screen: null, title: null, bytes: 0, paste: a.paste });
                }
                settle({ ok: true, agents: (message.agents as TerminalListItem[]) ?? [], pid: Number(message.pid) });
              } else {
                settle({ ok: false, reason: message.reason === 'version' ? 'version' : 'refused', detail: `the pty host speaks version ${String(message.version)}, this gonogo ${PTYHOST_VERSION}` });
              }
            } else if (settled) {
              onMessage(message);
            }
          }
        }
      });
      s.on('error', (error) => settle({ ok: false, reason: 'unreachable', detail: error.message }));
      s.on('close', () => {
        settle({ ok: false, reason: 'unreachable', detail: 'the connection closed' });
        if (socket === s) {
          socket = null;
          up = false;
          failPending('the pty host connection closed');
          for (const aid of [...listeners.keys()]) listeners.delete(aid);
          if (wanted) void reconnect();
        }
      });
    });
  };

  const reconnect = async (): Promise<void> => {
    if (reconnecting) return;
    reconnecting = true;
    const deadline = now() + (options.reconnectWindowMs ?? 3000);
    log.warn('lost the pty host; reconnecting');
    try {
      while (wanted && now() < deadline) {
        const result = await attempt();
        if (result.ok) {
          log.info('reconnected to the pty host');
          // agents that ran and are not listed any more ended while the connection was down
          const alive = new Set(result.agents.filter((a) => a.running).map((a) => a.name));
          for (const [name, state] of [...cache]) {
            if (state.info?.running && !alive.has(name)) {
              cache.set(name, { ...state, info: { ...state.info, running: false, pid: null } });
              emit(exitFor(name, state.info.generation));
            }
          }
          return;
        }
        await wait(200);
      }
      if (wanted) {
        log.error('the pty host is gone: its agents are lost');
        declareGone();
      }
    } finally {
      reconnecting = false;
    }
  };

  const spawnAsync = async (name: string, generation: number, spec: SpawnSpec): Promise<{ pid: number }> => {
    if (!up) {
      const result = await connect();
      if (!result.ok) throw new Error(`the pty host is not reachable: ${result.detail}`);
    }
    const result = (await request('spawn', { name, generation, spec })) as { pid: number };
    const previous = cache.get(name);
    cache.set(name, {
      info: { running: true, generation, pid: result.pid, cols: spec.cols ?? previous?.info?.cols ?? 80, rows: spec.rows ?? previous?.info?.rows ?? 24 },
      screen: null,
      title: null,
      bytes: 0,
      paste: false,
    });
    return result;
  };

  async function connect(): Promise<ConnectResult> {
    wanted = true;
    let started = false;
    const deadline = now() + (options.connectTimeoutMs ?? 8000);
    for (;;) {
      const result = await attempt();
      if (result.ok || result.reason === 'version' || result.reason === 'refused') return result;
      if (!started && options.startHost) {
        started = true;
        try {
          options.startHost();
        } catch (error) {
          return { ok: false, reason: 'unreachable', detail: `could not start the pty host: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (now() >= deadline || !options.startHost) return result;
      await wait(CONNECT_RETRY_MS);
    }
  }

  const spawn = (): { pid: number } => {
    throw new Error('the remote terminal host spawns through spawnAsync');
  };

  const attach = async (name: string, listener: (chunk: Uint8Array) => void): Promise<Attachment> => {
    if (!up) return { snapshot: EMPTY_SNAPSHOT, start: () => undefined, detach: () => undefined };
    const aid = (attachId += 1);
    let snapshot: Snapshot;
    // the listener is registered before the request: output frames only come after attach-start, but an id must never be unknown
    listeners.set(aid, () => undefined);
    try {
      snapshot = (await request('attach', { name, aid })) as Snapshot;
    } catch {
      listeners.delete(aid);
      return { snapshot: EMPTY_SNAPSHOT, start: () => undefined, detach: () => undefined };
    }
    let started = false;
    let detached = false;
    return {
      snapshot,
      start: () => {
        if (started || detached) return;
        started = true;
        listeners.set(aid, listener);
        write({ op: 'attach-start', aid });
      },
      detach: () => {
        if (detached) return;
        detached = true;
        listeners.delete(aid);
        write({ op: 'detach', aid });
      },
    };
  };

  const runningInfo = (name: string): TerminalInfo | null => {
    const info = cache.get(name)?.info ?? null;
    return info?.running ? info : null;
  };

  return {
    spawn,
    spawnAsync,
    connect,
    connected: () => up,
    disconnect: () => {
      wanted = false;
      up = false;
      failPending('disconnected');
      socket?.destroy();
      socket = null;
    },
    async quitHost() {
      let key: string;
      try {
        key = (await readFile(keyPathOf(options.homeDir), 'utf8')).trim();
      } catch {
        return false;
      }
      return new Promise<boolean>((resolve) => {
        const s = net.connect(socketPath);
        s.once('connect', () => s.write(encodeJson({ op: 'quit', key })));
        s.once('error', () => resolve(false));
        s.once('close', () => resolve(true));
        setTimeout(() => {
          s.destroy();
          resolve(false);
        }, 15_000).unref();
      });
    },
    async stop(name, generation) {
      const info = cache.get(name)?.info;
      if (!up || !info?.running || (generation !== undefined && generation !== info.generation)) return;
      await request('stop', { name, generation }).catch(() => undefined);
    },
    async stopAll() {
      if (!up) return;
      await request('stopAll').catch(() => undefined);
    },
    write(name, data) {
      if (!runningInfo(name)) return false;
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      return write({ op: 'write', name, b64: bytes.toString('base64') });
    },
    submit(name, generation, text) {
      const state = cache.get(name);
      if (!state?.info?.running || state.info.generation !== generation || !state.paste) return false;
      return write({ op: 'submit', name, generation, text });
    },
    resize(name, cols, rows) {
      const state = cache.get(name);
      if (!state?.info?.running) return false;
      cache.set(name, { ...state, info: { ...state.info, cols, rows } });
      return write({ op: 'resize', name, cols, rows });
    },
    rename(oldName, newName) {
      const old = cache.get(oldName);
      if (!old || old.info?.running || cache.get(newName)?.info?.running) return false;
      cache.delete(oldName);
      cache.set(newName, old);
      write({ op: 'rename', from: oldName, to: newName });
      return true;
    },
    forget(name) {
      if (runningInfo(name)) return;
      cache.delete(name);
      write({ op: 'forget', name });
    },
    attach,
    screen: (name) => cache.get(name)?.screen ?? null,
    title: (name) => cache.get(name)?.title ?? null,
    outputBytes: (name) => cache.get(name)?.bytes ?? 0,
    info: (name) => cache.get(name)?.info ?? null,
    list: () =>
      [...cache.entries()].map(([name, s]) => ({ name, generation: s.info?.generation ?? 0, pid: s.info?.pid ?? null, running: s.info?.running ?? false, paste: s.paste })),
    onEvent: (handler) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
}

