/**
 * gonogo tui (docs/tui-spec.md): the terminal client's connection to a running server. The same WebSocket and the same REST as
 * the page, with the browser token: nothing else is asked of the server. It reconnects with the page's delays, and a refused token
 * is not retried. A console's bytes arrive as binary frames tagged with the seq of the attach they belong to; an older seq is dropped.
 */
import http from 'node:http';
import WebSocket from 'ws';
import { RECONNECT_DELAYS_MS, WS_BINARY_OUTPUT, WS_INPUT_CHUNK_CHARS, WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from '../shared/protocol.js';
import type { ClientFrame, ModelDefaults, ServerFrame, UserMessageRequest } from '../shared/protocol.js';
import type { Link } from './tui-state.js';

export interface TuiClientOptions {
  /** http://host:port or https://host:port: the server's address. */
  url: string;
  /** The browser token (a server elsewhere, or a fresh install); not needed with `socketPath`. */
  token: string;
  /** The supervisor's local socket (`<home>/run/api.sock`): the file permissions are the credential and no token is sent (docs/login-spec.md R2). */
  socketPath?: string;
  onFrame(frame: ServerFrame): void;
  /** Terminal bytes of the attached console (already checked against the current attach seq). */
  onOutput(bytes: Buffer): void;
  onLink(link: Link): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TuiClient {
  start(): void;
  stop(): void;
  /** Attaches to a console at this terminal's size; answers the seq. The server answers with a `snapshot` frame, then bytes. */
  attach(agent: string, cols: number, rows: number): number;
  detach(): void;
  input(agent: string, data: string): void;
  resize(agent: string, cols: number, rows: number): void;
  sendMessage(request: UserMessageRequest): Promise<void>;
  answer(agent: string, go: boolean, needSeq: number | null): Promise<void>;
  relief(id: string, go: boolean): Promise<void>;
  hold(agent: string): Promise<void>;
  resume(agent: string): Promise<void>;
  markRead(ids: string[]): Promise<void>;
  archive(ids: string[]): Promise<void>;
  startPoll(): Promise<void>;
  /** The room's default models (GET /api/models), or null when the server does not answer them: the chips of a console need them. */
  modelDefaults(): Promise<ModelDefaults | null>;
  /** The seq of the attach in force, or 0 when none. */
  readonly seq: number;
}

/** The address of the WebSocket for a server address. */
export function wsUrl(url: string): string {
  const u = new URL(url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // the address may carry a room prefix (/r/<id>): the WebSocket of that room is under it
  u.pathname = `${/^(\/r\/[a-z][a-z0-9-]{0,23})(?:\/|$)/.exec(u.pathname)?.[1] ?? ''}/ws`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** A paste is cut into pieces the server takes, never between the two halves of a surrogate pair. */
export function chunksOf(data: string, size = WS_INPUT_CHUNK_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < data.length; ) {
    let end = Math.min(data.length, i + size);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

export function createTuiClient(options: TuiClientOptions): TuiClient {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let socket: WebSocket | null = null;
  let timer: unknown = null;
  let stopped = false;
  let failures = 0;
  let seq = 0;
  let attached = 0;

  const send = (frame: ClientFrame): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const retry = (): void => {
    if (stopped) return;
    options.onLink('reconnecting');
    const delay = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)] as number;
    failures += 1;
    timer = setTimer(connect, delay);
  };

  function connect(): void {
    timer = null;
    if (stopped) return;
    const ws =
      options.socketPath === undefined
        ? new WebSocket(wsUrl(options.url), [WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${options.token}`])
        : new WebSocket(`ws+unix://${options.socketPath}:${new URL(wsUrl(options.url)).pathname}`, [WS_SUBPROTOCOL]);
    socket = ws;
    let refused = false;
    ws.on('open', () => {
      failures = 0;
      options.onLink('open');
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (data.length > 5 && data[0] === WS_BINARY_OUTPUT && data.readUInt32BE(1) === attached) options.onOutput(data.subarray(5));
        return;
      }
      try {
        options.onFrame(JSON.parse(data.toString('utf8')) as ServerFrame);
      } catch {
        // a frame that is not JSON is not ours to understand
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      // 401: the token is wrong, and asking again will not change that
      refused = res.statusCode === 401 || res.statusCode === 403;
      res.resume();
      if (refused) {
        stopped = true;
        options.onLink('unauthorized');
      }
    });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      if (socket === ws) socket = null;
      attached = 0;
      if (!refused) retry();
    });
  }

  async function call(method: string, path: string, body?: unknown): Promise<void> {
    await request(method, path, body);
  }

  /** One REST call: the answer's JSON (null for a 204 or text), or an Error with the server's own message. */
  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (options.socketPath !== undefined) return requestSocket(options.socketPath, new URL(options.url).pathname.replace(/\/+$/, '') + path, method, body);
    let response: Response;
    try {
      response = await fetch(`${options.url.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${options.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('could not reach the server');
    }
    if (response.ok) return response.status === 204 ? null : await response.json().catch(() => null);
    let message = `the server answered ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // not JSON: the status is the message
    }
    throw new Error(message);
  }

  const agentPath = (name: string): string => `/api/agents/${encodeURIComponent(name)}`;

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      socket?.close();
      socket = null;
    },
    attach(agent, cols, rows) {
      seq += 1;
      attached = seq;
      send({ t: 'attach', seq, agent, cols, rows });
      return seq;
    },
    detach() {
      attached = 0;
      send({ t: 'detach' });
    },
    input(agent, data) {
      for (const piece of chunksOf(data)) send({ t: 'input', agent, data: piece });
    },
    resize(agent, cols, rows) {
      send({ t: 'resize', agent, cols, rows });
    },
    sendMessage: (request) => call('POST', '/api/messages', request),
    answer: (agent, go, needSeq) => call('POST', `${agentPath(agent)}/answer`, needSeq === null ? { go } : { go, needSeq }),
    relief: (id, go) => call('POST', `/api/relief/${encodeURIComponent(id)}/${go ? 'go' : 'no-go'}`),
    hold: (agent) => call('POST', `${agentPath(agent)}/hold`),
    resume: (agent) => call('POST', `${agentPath(agent)}/resume`),
    markRead: (ids) => call('POST', '/api/downlink/read', { ids }),
    archive: (ids) => call('POST', '/api/downlink/archive', { ids }),
    startPoll: () => call('POST', '/api/poll', {}),
    modelDefaults: async () => {
      const value = await request('GET', '/api/models').catch(() => null);
      return typeof value === 'object' && value !== null && 'models' in value ? (value as ModelDefaults) : null;
    },
    get seq() {
      return attached;
    },
  };
}

/** One REST call over a unix socket: the answer's JSON (null for a 204), or an Error with the server's own message. */
function requestSocket(socketPath: string, path: string, method: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, path, method, headers: { host: 'localhost', ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try {
          if (text !== '') parsed = JSON.parse(text);
        } catch {
          // not JSON: the status is the message
        }
        if ((res.statusCode ?? 500) < 300) return resolve(res.statusCode === 204 ? null : parsed);
        const message = typeof (parsed as { error?: unknown } | null)?.error === 'string' ? ((parsed as { error: string }).error) : `the server answered ${String(res.statusCode)}`;
        reject(new Error(message));
      });
    });
    req.on('error', () => reject(new Error('could not reach the server')));
    if (data !== undefined) req.write(data);
    req.end();
  });
}
