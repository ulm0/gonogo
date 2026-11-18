import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { Agent, IncomingMessage, Server as HttpServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { Socket, connect as netConnect, createServer as createNetServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  AGENT_NAME_PATTERN,
  HOOK_EVENTS,
  MCP_TOOL_NAMES,
  PERMISSION_MODES,
  WS_BINARY_OUTPUT,
  WS_INPUT_CHUNK_CHARS,
  WS_SUBPROTOCOL,
} from '../src/shared/protocol.js';
import type {
  AgentIdentity,
  AgentView,
  ApiErrorCode,
  Attachment,
  HookReply,
  Hub,
  HubEvent,
  HubIo,
  HubOptions,
  InputEffect,
  Launcher,
  LauncherOptions,
  Logger,
  MessageRecord,
  OutputListener,
  PollView,
  RosterFile,
  ServerInfo,
  StateSnapshot,
  TerminalEvent,
  TerminalHost,
} from '../src/shared/protocol.js';
import {
  LOCK_FILE,
  MAX_COLS,
  MAX_HOOK_BODY_BYTES,
  MAX_REST_BODY_BYTES,
  MESSAGES_FILE,
  MESSAGES_ROTATED_FILE,
  MESSAGES_ROTATE_BYTES,
  MCP_DESCRIPTIONS,
  MESSAGES_TAIL_BYTES,
  MIN_COLS,
  POLL_REASON_MAX_CHARS,
  MIN_ROWS,
  WS_MAX_FRAME_BYTES,
  WS_PING_INTERVAL_MS,
  createLogger,
  nullLogger,
} from '../src/server/constants.js';

/* The edge never needs the real hub, launcher or terminal host: cli.ts is exercised against fakes typed from protocol.ts. */
const factories = vi.hoisted(() => ({
  createHub: vi.fn(),
  createLauncher: vi.fn(),
  parseAgentCmd: vi.fn(),
  createTerminalHost: vi.fn(),
}));
vi.mock('../src/server/hub.js', () => ({ createHub: factories.createHub }));
vi.mock('../src/server/launcher.js', () => ({
  createLauncher: factories.createLauncher,
  parseAgentCmd: factories.parseAgentCmd,
}));
vi.mock('../src/server/terminal.js', () => ({ createTerminalHost: factories.createTerminalHost }));

/*
 * A filesystem that refuses chmod, or takes it and changes nothing (an exFAT volume, a bind mount), cannot be made in a
 * test: home.ts reaches chmodSync through this hook. null = the real one.
 */
const fsHooks = vi.hoisted(() => ({ chmodSync: null as ((...args: Parameters<typeof import('node:fs').chmodSync>) => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, chmodSync: (...args: Parameters<typeof actual.chmodSync>): void => (fsHooks.chmodSync ?? actual.chmodSync)(...args) };
});

import { USAGE, isTransientError, main, parseArgs, resolveSettings, startGonogo } from '../src/server/cli.js';
import type { Running } from '../src/server/cli.js';
import { openHome } from '../src/server/home.js';
import { createHookHandler } from '../src/server/hooks.js';
import { createMcpHandler } from '../src/server/mcp.js';
import { createWebServer, hostName, needsLoopbackTwin } from '../src/server/web.js';
import type { WebOptions, WebServer } from '../src/server/web.js';

/* ================================================================================================================
 * Shared helpers
 * ============================================================================================================== */

const PROJECT_ROOT = join(import.meta.dirname, '..');
const TOKEN = randomBytes(32).toString('hex');
const ANA_TOKEN = 'a1'.repeat(32);
const BEN_TOKEN = 'b2'.repeat(32);
const identities = new Map<string, AgentIdentity>([
  [ANA_TOKEN, { agent: 'ana', generation: 3 }],
  [BEN_TOKEN, { agent: 'ben', generation: 1 }],
]);
const INFO: ServerInfo = {
  protocol: 1,
  version: '9.9.9',
  cwd: '/work',
  home: '/home/x',
  host: '127.0.0.1',
  port: 7777,
  seed: false,
  agentCmd: null,
  maxHops: 8,
  startedAt: 1,
  installed: ['claude', 'custom'],
  timeZone: 'UTC',
};
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(fn: () => T | undefined | false | null, what: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gonogo-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

class FakeHubError extends Error {
  readonly code: ApiErrorCode;
  readonly field?: string;
  constructor(code: ApiErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

function agentView(name: string, over: Partial<AgentView> = {}): AgentView {
  return {
    name,
    role: `${name} role`,
    dir: '/work',
    mode: 'default',
    desk: name === 'flight' ? 0 : 1,
    boss: name === 'flight',
    state: 'idle',
    stateSince: 1,
    needsKind: null,
    needsReason: null,
    needSeq: null,
    remoteControl: null,
    transition: null,
    draft: false,
    held: null,
    queued: 0,
    dirty: false,
    generation: 1,
    exit: null,
    position: null,
    provider: 'claude',
    command: null,
    payload: null,
    cleanRoom: null,
    worktree: null,
    model: null,
    keys: {},
    doing: null,
    history: [{ state: 'idle', at: 1 }],
    ...over,
  };
}

interface Call {
  fn: string;
  args: unknown[];
}

function pollView(over: Partial<PollView> = {}): PollView {
  return {
    id: 1,
    startedAt: 5,
    status: 'open',
    entries: [{ agent: 'ana', vote: null, reason: '', at: null }, { agent: 'ben', vote: null, reason: '', at: null }],
    note: 'waiting for ana, ben',
    ...over,
  };
}

function makeHub(over: Partial<Hub> = {}): { hub: Hub; calls: Call[] } {
  const calls: Call[] = [];
  let currentPoll: PollView | null = null;
  let limit: number | null = null;
  const rec = (fn: string, ...args: unknown[]): void => {
    calls.push({ fn, args });
  };
  const hub: Hub = {
    start: async () => rec('start'),
    shutdown: async () => rec('shutdown'),
    views: () => [agentView('flight'), agentView('ana'), agentView('ben')],
    activity: () => [],
    hire: async (req) => {
      rec('hire', req);
      return agentView(req.name, { state: 'starting' });
    },
    edit: async (name, req) => {
      rec('edit', name, req);
      if (Object.keys(req).length === 0) throw new FakeHubError('bad_request', 'nothing to change');
      return agentView(req.name ?? name);
    },
    restart: async (name) => {
      rec('restart', name);
      if (name === 'ghost') throw new FakeHubError('not_found', 'unknown agent');
      return agentView(name, { state: 'starting' });
    },
    stop: async (name) => {
      rec('stop', name);
      if (name === 'ghost') throw new FakeHubError('not_found', 'unknown agent');
      return agentView(name, { state: 'stopped' });
    },
    trip: (name, reason) => rec('trip', name, reason),
    hold: (name) => {
      rec('hold', name);
      if (name === 'ghost') throw new FakeHubError('not_found', 'unknown agent');
      if (name === 'ben') throw new FakeHubError('conflict', 'ben is already on hold');
      return agentView(name, { state: 'needs_you', needsKind: 'redline', needsReason: 'on hold' });
    },
    resume: (name) => {
      rec('resume', name);
      if (name === 'ghost') throw new FakeHubError('not_found', 'unknown agent');
      if (name === 'ben') throw new FakeHubError('conflict', 'ben has not tripped the redline');
      return agentView(name, { state: 'idle' });
    },
    answer: (name, req) => {
      rec('answer', name, req);
      if (name === 'ghost') throw new FakeHubError('not_found', 'unknown agent');
      if (name === 'ben') throw new FakeHubError('conflict', 'ben is not asking for a go');
      return agentView(name, { state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: ls' });
    },
    remove: async (name) => {
      rec('remove', name);
      if (name === 'flight') throw new FakeHubError('conflict', 'the boss cannot be removed');
      if (name === 'ghost') throw new FakeHubError('not_found', 'unknown agent');
    },
    sendFromUser: (req) => {
      rec('sendFromUser', req);
      if (req.to === 'user') throw new FakeHubError('bad_request', 'you cannot send a message to user', 'to');
      if (req.to === 'nobody') throw new FakeHubError('not_found', 'unknown recipient "nobody"', 'to');
      return { ok: true, id: 'm1', to: req.to === 'boss' ? 'flight' : req.to, status: 'queued', note: 'waiting: about to type the pointer' };
    },
    sendFromStation: (station, req) => {
      rec('sendFromStation', station, req);
      return { ok: true, id: 'm13', to: req.to, status: 'queued', note: 'waiting: ben is working' };
    },
    sendFromAgent: (from, generation, req) => {
      rec('sendFromAgent', from, generation, req);
      return { ok: true, id: 'm12', to: req.to, status: 'queued', note: 'waiting: ben is working' };
    },
    readMessages: (agent, generation) => {
      rec('readMessages', agent, generation);
      return { count: 0, messages: [] };
    },
    rosterFor: (agent, generation) => {
      rec('rosterFor', agent, generation);
      return { you: agent, boss: 'flight', agents: [{ name: 'flight', role: 'boss', state: 'idle', boss: true, position: 'flight' }], specialRecipients: ['boss', 'user'] };
    },
    startPoll: (req) => {
      rec('startPoll', req);
      if (currentPoll) throw new FakeHubError('conflict', 'clear the poll first');
      if (req.agents?.includes('ghost')) throw new FakeHubError('bad_request', 'unknown agent "ghost"', 'agents');
      currentPoll = pollView();
      return currentPoll;
    },
    holdPoll: () => {
      rec('holdPoll');
      if (!currentPoll) throw new FakeHubError('conflict', 'there is no poll');
      currentPoll = { ...currentPoll, status: 'hold', note: 'held by the Director' };
      return currentPoll;
    },
    abortPoll: () => {
      rec('abortPoll');
      if (!currentPoll) throw new FakeHubError('conflict', 'there is no poll');
      currentPoll = { ...currentPoll, status: 'aborted' };
      return currentPoll;
    },
    clearPoll: () => {
      rec('clearPoll');
      currentPoll = null;
    },
    poll: () => currentPoll,
    vote: (agent, generation, vote, reason) => {
      rec('vote', agent, generation, vote, reason);
      return { ok: true, note: 'vote recorded' };
    },
    setGovernor: (req) => {
      rec('setGovernor', req);
      if (req.limit !== null && (req.limit < 1 || req.limit > 24)) throw new FakeHubError('bad_request', 'limit must be 1 to 24 or null', 'limit');
      limit = req.limit;
      return { limit, working: 1, holding: 0 };
    },
    governor: () => ({ limit, working: 1, holding: 0 }),
    onHook: (input) => {
      rec('onHook', input);
      return {};
    },
    onUserInput: (name, data) => {
      rec('onUserInput', name, data);
      return 'none';
    },
    onTerminalEvent: (event) => rec('onTerminalEvent', event),
    ...over,
  };
  return { hub, calls };
}

interface FakeAttachment {
  name: string;
  listener: OutputListener;
  started: boolean;
  detached: boolean;
}

interface Deferred {
  release(): void;
}

/** A terminal host that remembers what the edge asked of it and lets a test push output. */
function makeTerminals(hooks: { order?: string[]; stopAllGate?: Promise<void> } = {}) {
  const calls: Call[] = [];
  const handlers: Array<(event: TerminalEvent) => void> = [];
  const sizes = new Map<string, { cols: number; rows: number; running: boolean; generation: number }>([
    ['flight', { cols: 120, rows: 40, running: true, generation: 1 }],
    ['ana', { cols: 120, rows: 40, running: true, generation: 3 }],
    ['ben', { cols: 120, rows: 40, running: false, generation: 0 }],
  ]);
  const attachments: FakeAttachment[] = [];
  const state = {
    writeResult: true,
    submitResult: true,
    holdNext: null as Promise<void> | null,
    onStart: null as ((a: FakeAttachment) => void) | null,
  };
  const terms: TerminalHost = {
    spawn: (name, generation, spec) => {
      calls.push({ fn: 'spawn', args: [name, generation, spec] });
      return { pid: 1 };
    },
    stop: async (name, generation) => {
      calls.push({ fn: 'stop', args: [name, generation] });
    },
    stopAll: async () => {
      hooks.order?.push('terminals.stopAll');
      await hooks.stopAllGate;
    },
    write: (name, data) => {
      calls.push({ fn: 'write', args: [name, data] });
      return state.writeResult;
    },
    submit: (name, generation, text) => {
      calls.push({ fn: 'submit', args: [name, generation, text] });
      return state.submitResult;
    },
    resize: (name, cols, rows) => {
      calls.push({ fn: 'resize', args: [name, cols, rows] });
      const s = sizes.get(name);
      if (!s || !s.running) return false;
      s.cols = cols;
      s.rows = rows;
      return true;
    },
    rename: (oldName, newName) => {
      hooks.order?.push(`terminals.rename ${oldName} ${newName}`);
      return true;
    },
    attach: async (name, listener) => {
      const att: FakeAttachment = { name, listener, started: false, detached: false };
      attachments.push(att);
      const hold = state.holdNext;
      state.holdNext = null;
      if (hold) await hold;
      const s = sizes.get(name) ?? { cols: 120, rows: 40, running: false, generation: 0 };
      const attachment: Attachment = {
        snapshot: { cols: s.cols, rows: s.rows, data: `screen of ${name}`, generation: s.generation, running: s.running },
        start: () => {
          att.started = true;
          state.onStart?.(att);
        },
        detach: () => {
          att.detached = true;
        },
      };
      return attachment;
    },
    screen: (name) => {
      calls.push({ fn: 'screen', args: [name] });
      return null;
    },
    title: (name) => {
      calls.push({ fn: 'title', args: [name] });
      return null;
    },
    outputBytes: (name) => {
      calls.push({ fn: 'outputBytes', args: [name] });
      return 42;
    },
    info: (name) => {
      const s = sizes.get(name);
      return s ? { running: s.running, generation: s.generation, pid: s.running ? 1234 : null, cols: s.cols, rows: s.rows } : null;
    },
    onEvent: (handler) => {
      handlers.push(handler);
      return () => undefined;
    },
  };
  return {
    terms,
    calls,
    handlers,
    sizes,
    attachments,
    state,
    /** The next attach() waits until the returned handle is released. */
    holdNextAttach(): Deferred {
      let release!: () => void;
      state.holdNext = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release };
    },
    /** Output that reaches every attachment that has been started and not detached. */
    push(name: string, bytes: Uint8Array): void {
      for (const a of attachments) if (a.name === name && a.started && !a.detached) a.listener(bytes);
    },
  };
}

type FakeTerminals = ReturnType<typeof makeTerminals>;

interface Harness {
  web: WebServer;
  port: number;
  hub: Hub;
  hubCalls: Call[];
  fake: FakeTerminals;
  state: { ready: boolean };
}

async function startWeb(over: Partial<WebOptions> = {}, hubOver: Partial<Hub> = {}): Promise<Harness> {
  const { hub, calls } = makeHub(hubOver);
  const fake = makeTerminals();
  const state = { ready: true };
  const web = createWebServer({
    host: '127.0.0.1',
    port: 0,
    browserToken: TOKEN,
    allowedHosts: ['gonogo.example.com'],
    staticDir: null,
    hub,
    terminals: fake.terms,
    resolveToken: (token) => identities.get(token) ?? null,
    info: () => INFO,
    isReady: () => state.ready,
    log: nullLogger,
    ...over,
  });
  const { port } = await web.listen();
  cleanups.push(() => web.close());
  return { web, port, hub, hubCalls: calls, fake, state };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json(): unknown;
}

interface HttpOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  host?: string;
  agent?: Agent;
}

/**
 * A client that keeps its connection: a server that answers a body it will not read must drain it, and a request sent with
 * `Connection: close` (what a one-off agent does) is closed by Node's server as soon as the answer is out, which resets a
 * client that is still writing.
 */
function keepAliveAgent(): Agent {
  const agent = new Agent({ keepAlive: true });
  cleanups.push(() => agent.destroy());
  return agent;
}

function send(port: number, options: HttpOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: options.host ?? '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers,
        agent: options.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) as unknown });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** A JSON API call as the browser makes it. */
function api(port: number, method: string, path: string, body?: unknown, token = TOKEN): Promise<HttpResult> {
  return send(port, {
    method,
    path,
    headers: { ...bearer(token), ...(body === undefined ? {} : JSON_HEADERS) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Bytes on a plain socket, for requests that an HTTP client library would not let through. A reset gives status 0 and whatever came before it. */
function rawRequest(port: number, bytes: string | Buffer): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0), headers: head, body: split === -1 ? '' : text.slice(split + 4) });
    });
    socket.write(bytes);
  });
}

type Frame = Record<string, unknown>;

interface WsClient {
  ws: WebSocket;
  frames: Frame[];
  binaries: Buffer[];
  /** What arrived, in order: "text:<t>" or "binary". */
  order: string[];
  closed: Promise<number>;
  send(frame: unknown): void;
  waitFrame(match: (f: Frame) => boolean, what: string): Promise<Frame>;
  waitBinary(count: number): Promise<Buffer[]>;
  frameCount(t: string): number;
}

type WsOutcome = { kind: 'open'; client: WsClient } | { kind: 'rejected'; status: number; body: string };

interface WsOptions {
  token?: string;
  protocols?: string[] | null;
  headers?: Record<string, string>;
  path?: string;
  autoPong?: boolean;
}

function connectWs(port: number, options: WsOptions = {}): Promise<WsOutcome> {
  const token = options.token ?? TOKEN;
  const protocols = options.protocols === null ? undefined : (options.protocols ?? [WS_SUBPROTOCOL, `token.${token}`]);
  return new Promise((resolve) => {
    // spreading an undefined autoPong over the library default would switch pongs off
    const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/ws'}`, protocols, {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.autoPong === undefined ? {} : { autoPong: options.autoPong }),
    });
    const frames: Frame[] = [];
    const binaries: Buffer[] = [];
    const order: string[] = [];
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (isBinary) {
        binaries.push(buf);
        order.push('binary');
      } else {
        const frame = JSON.parse(buf.toString('utf8')) as Frame;
        frames.push(frame);
        order.push(`text:${String(frame.t)}`);
      }
    });
    ws.on('error', () => undefined);
    ws.on('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ kind: 'rejected', status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    ws.on('open', () => {
      cleanups.push(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      });
      resolve({
        kind: 'open',
        client: {
          ws,
          frames,
          binaries,
          order,
          closed,
          send: (frame) => ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)),
          waitFrame: (match, what) => waitFor(() => frames.find(match), what),
          waitBinary: (count) => waitFor(() => (binaries.length >= count ? binaries : null), `${count} binary frame(s)`),
          frameCount: (t) => frames.filter((f) => f.t === t).length,
        },
      });
    });
  });
}

async function openWs(port: number, options: WsOptions = {}): Promise<WsClient> {
  const outcome = await connectWs(port, options);
  if (outcome.kind !== 'open') throw new Error(`websocket was refused with ${outcome.status}`);
  await outcome.client.waitFrame((f) => f.t === 'state', 'the state frame');
  return outcome.client;
}

/** A WebSocket handshake written by hand: the status line of the answer, or 101. */
function upgradeStatus(port: number, headers: Record<string, string>, path = '/ws'): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

/** After anything hostile the server must still answer an ordinary request. */
async function expectStillServing(port: number): Promise<void> {
  const res = await api(port, 'GET', '/api/state');
  expect(res.status).toBe(200);
}

function collectingLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ level: 'debug', sink: (line) => lines.push(line) }), lines };
}

/* ================================================================================================================
 * home.ts
 * ============================================================================================================== */

function agentRecord(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    role: 'does things',
    dir: '/work',
    mode: 'default',
    sessionId: '123e4567-e89b-42d3-a456-426614174000',
    desk: 1,
    boss: false,
    createdAt: 1700000000000,
    ...over,
  };
}

function message(id: string, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    from: 'user',
    to: 'flight',
    subject: 's',
    body: `body of ${id}`,
    inReplyTo: null,
    hops: 0,
    at: 1000,
    status: 'queued',
    note: 'waiting: about to type the pointer',
    updatedAt: 1000,
    ...over,
  };
}

function openTestHome(dir: string, log: Logger = nullLogger) {
  const home = openHome(dir, log);
  cleanups.push(() => home.close());
  return home;
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

const NO_PROPELLANT_VIEW = { room: { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: {} }, agents: {}, cost: { room: { usd: { '5h': 0, day: 0, week: 0, month: 0 }, unpriced: { '5h': 0, day: 0, week: 0, month: 0 }, budget: {} }, agents: {}, days: [], pricedSince: null } };

describe('home', () => {
  it('creates the home and agents directories (0700) and a 64 hex browser token (0600) on first open', () => {
    const dir = join(tmpDir(), 'fresh', 'home');
    const home = openTestHome(dir);
    expect(home.dir).toBe(dir);
    expect(home.browserToken).toMatch(/^[0-9a-f]{64}$/);
    expect(fileMode(dir)).toBe(0o700);
    expect(fileMode(join(dir, 'agents'))).toBe(0o700);
    expect(fileMode(join(dir, 'token'))).toBe(0o600);
    expect(readFileSync(join(dir, 'token'), 'utf8').trim()).toBe(home.browserToken);
  });

  it('reads the same token on the next open', async () => {
    const dir = tmpDir();
    const first = openHome(dir);
    const token = first.browserToken;
    await first.close();
    const second = openTestHome(dir);
    expect(second.browserToken).toBe(token);
  });

  it('tightens a home restored with 0755 and a token with 0644', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'agents'), { recursive: true });
    chmodSync(dir, 0o755);
    chmodSync(join(dir, 'agents'), 0o755);
    const token = 'c3'.repeat(32);
    writeFileSync(join(dir, 'token'), token + '\n', { mode: 0o644 });
    chmodSync(join(dir, 'token'), 0o644);
    const home = openTestHome(dir);
    expect(home.browserToken).toBe(token);
    expect(fileMode(dir)).toBe(0o700);
    expect(fileMode(join(dir, 'agents'))).toBe(0o700);
    expect(fileMode(join(dir, 'token'))).toBe(0o600);
  });

  it('replaces a token file that is not 64 hex characters, with a warning that does not show it', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'token'), 'not-a-token-at-all\n');
    const { log, lines } = collectingLog();
    const home = openTestHome(dir, log);
    expect(home.browserToken).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'token'), 'utf8').trim()).toBe(home.browserToken);
    expect(lines.some((l) => l.includes('warn') && l.includes('replacing'))).toBe(true);
    expect(lines.join('\n')).not.toContain('not-a-token-at-all');
    expect(lines.join('\n')).not.toContain(home.browserToken);
  });

  it('answers loadRoster with an empty roster when the file does not exist', () => {
    const home = openTestHome(tmpDir());
    expect(home.loadRoster()).toEqual({ version: 1, agents: [] });
  });

  it('saves the roster atomically, round-trips it and leaves no temp file', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const file: RosterFile = {
      version: 1,
      agents: [
        { name: 'flight', role: 'boss', dir: '/work', mode: 'default', sessionId: '123e4567-e89b-42d3-a456-426614174000', desk: 0, boss: true, createdAt: 5 },
        { name: 'ana', role: 'dev', dir: '/work/a', mode: 'acceptEdits', sessionId: '223e4567-e89b-42d3-a456-426614174000', desk: 1, boss: false, createdAt: 6 },
      ],
    };
    await home.saveRoster(file);
    expect(home.loadRoster()).toEqual(file);
    expect(fileMode(join(dir, 'agents.json'))).toBe(0o600);
    expect(readFileSync(join(dir, 'agents.json'), 'utf8')).toBe(JSON.stringify(file, null, 2));
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('round-trips position, provider and command, and loads an old file without them', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const base = { dir: '/w', mode: 'default' as const, sessionId: id, createdAt: 1 };
    const file: RosterFile = {
      version: 1,
      agents: [
        { ...base, name: 'flight', role: 'boss', desk: 0, boss: true, position: 'flight' },
        { ...base, name: 'bot', role: 'tool', desk: 1, boss: false, position: 'flight', provider: 'custom', command: 'node x.js' },
        { ...base, name: 'gem', role: 'tool', desk: 2, boss: false, provider: 'gemini' },
      ],
    };
    await home.saveRoster(file);
    expect(home.loadRoster()).toEqual(file);
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: 1, agents: [agentRecord('old'), agentRecord('c', { provider: 'claude', desk: 2 })] }));
    const old = home.loadRoster().agents;
    expect(old[0]).not.toHaveProperty('provider');
    expect(old[1]).not.toHaveProperty('provider');
  });

  it('round-trips a payload in plain text (mode 0600), and loads an old file without one', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const base = { dir: '/w', mode: 'default' as const, sessionId: id, createdAt: 1, boss: false };
    const payload = {
      mcpServers: {
        files: { command: 'npx', args: ['-y', 'x'], env: { TOKEN: 'plain-text-secret' } },
        remote: { type: 'http' as const, url: 'https://example.test/mcp', headers: { Authorization: 'Bearer abc' } },
      },
      skills: ['/skills/review'],
    };
    const file: RosterFile = {
      version: 1,
      agents: [
        { ...base, name: 'ana', role: 'dev', desk: 1, payload },
        { ...base, name: 'gem', role: 'dev', desk: 2, provider: 'gemini', payload: { mcpServers: payload.mcpServers } },
        { ...base, name: 'old', role: 'dev', desk: 3 },
      ],
    };
    await home.saveRoster(file);
    expect(home.loadRoster()).toEqual(file);
    expect(home.loadRoster().agents[2]).not.toHaveProperty('payload');
    expect(readFileSync(join(dir, 'agents.json'), 'utf8')).toContain('plain-text-secret');
    expect(fileMode(join(dir, 'agents.json'))).toBe(0o600);
  });

  it('round-trips a Clean Room setting, and loads an old file without one', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const base = { dir: '/w', mode: 'default' as const, sessionId: id, createdAt: 1, boss: false };
    const file: RosterFile = {
      version: 1,
      agents: [
        { ...base, name: 'ana', role: 'dev', desk: 1, cleanRoom: { image: 'my/image:2' } },
        { ...base, name: 'ben', role: 'dev', desk: 2, cleanRoom: {} },
        { ...base, name: 'old', role: 'dev', desk: 3 },
      ],
    };
    await home.saveRoster(file);
    expect(home.loadRoster()).toEqual(file);
    expect(home.loadRoster().agents[2]).not.toHaveProperty('cleanRoom');
  });

  it('round-trips a worktree setting, and loads a file without one', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const base = { dir: '/w', mode: 'default' as const, sessionId: id, createdAt: 1, boss: false };
    const file: RosterFile = {
      version: 1,
      agents: [
        { ...base, name: 'ana', role: 'dev', desk: 1, worktree: {} },
        { ...base, name: 'old', role: 'dev', desk: 2 },
      ],
    };
    await home.saveRoster(file);
    expect(home.loadRoster()).toEqual(file);
    expect(home.loadRoster().agents[1]).not.toHaveProperty('worktree');
  });

  it('round-trips a model and the names of keys, and the file holds no value', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const base = { dir: '/w', mode: 'default' as const, sessionId: id, createdAt: 1, boss: false };
    const file: RosterFile = {
      version: 1,
      agents: [
        { ...base, name: 'ana', role: 'dev', desk: 1, model: 'sonnet', keys: { OPENAI_API_KEY: 5, GEMINI_API_KEY: 6 } },
        { ...base, name: 'gem', role: 'dev', desk: 2, provider: 'gemini', model: 'flash' },
        { ...base, name: 'old', role: 'dev', desk: 3 },
      ],
    };
    await home.saveRoster(file);
    expect(home.loadRoster()).toEqual(file);
    expect(home.loadRoster().agents[2]).not.toHaveProperty('model');
    expect(home.loadRoster().agents[2]).not.toHaveProperty('keys');
  });

  it.each([
    ['a model that is not text', { model: 5 }],
    ['a model that looks like a flag', { model: '--yolo' }],
    ['a model on an opencode agent', { provider: 'opencode', model: 'x' }],
    ['a model on a custom agent', { provider: 'custom', command: 'ls', model: 'x' }],
    ['keys that are a list', { keys: ['A_KEY'] }],
    ['a key with a lower case name', { keys: { openai: 5 } }],
    ['a key of a reserved name', { keys: { PATH: 5 } }],
    ['a key whose time is not a number', { keys: { A_KEY: 'now' } }],
    ['17 keys', { keys: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`K${i}`, 1])) }],
  ])('refuses a roster with %s, and the message holds no key name or value', (_what, over) => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: 1, agents: [agentRecord('ana', over)] }));
    let message = '';
    try {
      home.loadRoster();
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/fix or delete this file/);
    expect(message).not.toMatch(/PATH|openai|OPENAI|A_KEY/);
  });

  it('serialises saves: the last call wins even when they overlap, and the object is copied at call time', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const file: RosterFile = { version: 1, agents: [] };
    const saves: Array<Promise<void>> = [];
    for (let i = 1; i <= 5; i += 1) {
      file.agents = [agentRecord(`a${i}`) as never];
      saves.push(home.saveRoster(file));
    }
    await Promise.all(saves);
    expect(home.loadRoster().agents.map((a) => a.name)).toEqual(['a5']);
  });

  it('leaves no temp file and keeps saving after a failed save', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    mkdirSync(join(dir, 'agents.json'));
    await expect(home.saveRoster({ version: 1, agents: [] })).rejects.toThrow();
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    rmSync(join(dir, 'agents.json'), { recursive: true });
    await home.saveRoster({ version: 1, agents: [] });
    expect(home.loadRoster()).toEqual({ version: 1, agents: [] });
  });

  it.each([
    ['not json', '{'],
    ['an array', '[]'],
    ['a wrong version', JSON.stringify({ version: 2, agents: [] })],
    ['no agents list', JSON.stringify({ version: 1 })],
    ['a record that is not an object', JSON.stringify({ version: 1, agents: [5] })],
    ['a bad name', JSON.stringify({ version: 1, agents: [agentRecord('Bad Name')] })],
    ['a leading hyphen', JSON.stringify({ version: 1, agents: [agentRecord('-a')] })],
    ['a bad mode', JSON.stringify({ version: 1, agents: [agentRecord('ana', { mode: 'yolo' })] })],
    ['a bad session id', JSON.stringify({ version: 1, agents: [agentRecord('ana', { sessionId: 'abc' })] })],
    ['a negative desk', JSON.stringify({ version: 1, agents: [agentRecord('ana', { desk: -1 })] })],
    ['a fractional desk', JSON.stringify({ version: 1, agents: [agentRecord('ana', { desk: 1.5 })] })],
    ['a boss that is not boolean', JSON.stringify({ version: 1, agents: [agentRecord('ana', { boss: 'yes' })] })],
    ['a duplicate name', JSON.stringify({ version: 1, agents: [agentRecord('ana'), agentRecord('ana', { desk: 2 })] })],
    ['an unknown position', JSON.stringify({ version: 1, agents: [agentRecord('ana', { position: 'nope' })] })],
    ['a position that is not a string', JSON.stringify({ version: 1, agents: [agentRecord('ana', { position: 3 })] })],
    ['an unknown provider', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'eliza' })] })],
    ['a custom agent without a command', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'custom' })] })],
    ['an empty command', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'custom', command: '' })] })],
    ['a command that is not a string', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'custom', command: 5 })] })],
    ['a command that is too long', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'custom', command: 'x'.repeat(1001) })] })],
    ['a command on a claude agent', JSON.stringify({ version: 1, agents: [agentRecord('ana', { command: 'ls' })] })],
    ['a command on an explicit claude agent', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'claude', command: 'ls' })] })],
    ['a reserved name', JSON.stringify({ version: 1, agents: [agentRecord('user')] })],
    ['a custom boss', JSON.stringify({ version: 1, agents: [agentRecord('ana', { boss: true, provider: 'custom', command: 'ls' })] })],
    ['a custom command that is not a JSON array of strings', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'custom', command: '["sh", 1]' })] })],
    ['a custom command with a NUL character', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'custom', command: 'sh -c \u0000' })] })],
    ['a payload that is not an object', JSON.stringify({ version: 1, agents: [agentRecord('ana', { payload: 'x' })] })],
    ['a payload field it does not know', JSON.stringify({ version: 1, agents: [agentRecord('ana', { payload: { tools: [] } })] })],
    ['a server named gonogo', JSON.stringify({ version: 1, agents: [agentRecord('ana', { payload: { mcpServers: { gonogo: { command: 'x' } } } })] })],
    ['a server name with a capital letter', JSON.stringify({ version: 1, agents: [agentRecord('ana', { payload: { mcpServers: { Files: { command: 'x' } } } })] })],
    ['a stdio server without a command', JSON.stringify({ version: 1, agents: [agentRecord('ana', { payload: { mcpServers: { files: { args: [] } } } })] })],
    ['a url server without a type', JSON.stringify({ version: 1, agents: [agentRecord('ana', { payload: { mcpServers: { web: { url: 'https://example.test' } } } })] })],
    ['an env value that is not text', JSON.stringify({ version: 1, agents: [agentRecord('ana', { payload: { mcpServers: { files: { command: 'x', env: { A: 1 } } } } })] })],
    ['a skill folder that is not absolute', JSON.stringify({ version: 1, agents: [agentRecord('ana', { payload: { skills: ['review'] } })] })],
    ['skills on a gemini agent', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'gemini', payload: { skills: ['/s/review'] } })] })],
    ['a Clean Room that is not an object', JSON.stringify({ version: 1, agents: [agentRecord('ana', { cleanRoom: true })] })],
    ['a Clean Room field it does not know', JSON.stringify({ version: 1, agents: [agentRecord('ana', { cleanRoom: { mount: '/' } })] })],
    ['a Clean Room image docker would read as an option', JSON.stringify({ version: 1, agents: [agentRecord('ana', { cleanRoom: { image: '--privileged' } })] })],
    ['a Clean Room on a gemini agent', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'gemini', cleanRoom: {} })] })],
    ['a worktree that is not an object', JSON.stringify({ version: 1, agents: [agentRecord('ana', { worktree: true })] })],
    ['a worktree field it does not know', JSON.stringify({ version: 1, agents: [agentRecord('ana', { worktree: { base: 'main' } })] })],
    ['a worktree on a Clean Room agent', JSON.stringify({ version: 1, agents: [agentRecord('ana', { worktree: {}, cleanRoom: {} })] })],
    ['a payload on a custom agent', JSON.stringify({ version: 1, agents: [agentRecord('ana', { provider: 'custom', command: 'ls', payload: { mcpServers: { f: { command: 'x' } } } })] })],
  ])('refuses a roster with %s, naming the path and never resetting the file', (_what, text) => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    writeFileSync(join(dir, 'agents.json'), text);
    expect(() => home.loadRoster()).toThrowError(new RegExp(`${join(dir, 'agents.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*fix or delete this file`));
    expect(readFileSync(join(dir, 'agents.json'), 'utf8')).toBe(text);
  });

  it('accepts every permission mode and ignores fields it does not know', () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const agents = PERMISSION_MODES.map((mode, i) => agentRecord(`m${i}`, { mode, desk: i, extra: 'ignored' }));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: 1, agents }));
    const loaded = home.loadRoster();
    expect(loaded.agents.map((a) => a.mode)).toEqual([...PERMISSION_MODES]);
    expect(loaded.agents[0]).not.toHaveProperty('extra');
  });

  it('appends the whole record first and only four fields afterwards, and folds them back', async () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    home.appendMessage(message('m1', { at: 10 }));
    home.appendMessage(message('m2', { at: 20, from: 'ana', to: 'ben', body: 'second' }));
    home.appendMessage(message('m1', { at: 10, status: 'read', note: null, updatedAt: 99 }));
    await home.close();
    const lines = readFileSync(join(dir, MESSAGES_FILE), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '')).toEqual(message('m1', { at: 10 }));
    expect(lines[2]).toBe('{"id":"m1","status":"read","note":null,"updatedAt":99}');
    expect(fileMode(join(dir, MESSAGES_FILE))).toBe(0o600);

    const again = openTestHome(dir);
    const recent = again.loadRecentMessages(10);
    expect(recent.map((m) => [m.id, m.status, m.note, m.updatedAt, m.body])).toEqual([
      ['m1', 'read', null, 99, 'body of m1'],
      ['m2', 'queued', 'waiting: about to type the pointer', 1000, 'second'],
    ]);
    expect(again.loadRecentMessages(1).map((m) => m.id)).toEqual(['m2']);
    expect(again.loadRecentMessages(0)).toEqual([]);
  });

  it('orders history by time, drops a partial line that has no whole record, and warns about unreadable lines', () => {
    const dir = tmpDir();
    const { log, lines } = collectingLog();
    const home = openTestHome(dir, log);
    const whole = (m: MessageRecord): string => JSON.stringify(m);
    writeFileSync(
      join(dir, MESSAGES_FILE),
      [
        whole(message('m3', { at: 300 })),
        '{"id":"m9","status":"read","note":null,"updatedAt":5}',
        'this is not json',
        whole(message('m1', { at: 100 })),
        '{"id":"m3","status":"delivered","note":"pointer typed","updatedAt":400}',
        '{"id":"m2","status":"nonsense","note":null,"updatedAt":1}',
        whole(message('m2', { at: 200 })),
        '',
      ].join('\n'),
    );
    const recent = home.loadRecentMessages(10);
    expect(recent.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(recent[2]).toMatchObject({ status: 'delivered', note: 'pointer typed', updatedAt: 400 });
    expect(lines.some((l) => l.includes('warn') && l.includes('ignored 2 line(s)'))).toBe(true);
  });

  it('reads only the tail window of a big log and drops the line that starts before it', () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const pad = 'x'.repeat(2000);
    const rows: string[] = [];
    // enough whole records to fill about three windows: the first ones fall outside it
    for (let i = 1; i <= Math.ceil((MESSAGES_TAIL_BYTES * 3) / 2100); i += 1) {
      rows.push(JSON.stringify(message(`m${i}`, { at: i, body: pad })));
    }
    // a four-field line whose whole record is far outside the window
    rows.push('{"id":"m1","status":"read","note":null,"updatedAt":7}');
    writeFileSync(join(dir, MESSAGES_FILE), rows.join('\n') + '\n');
    const recent = home.loadRecentMessages(100000);
    expect(recent.length).toBeGreaterThan(100);
    expect(recent.length).toBeLessThan(rows.length / 2);
    expect(recent.some((m) => m.id === 'm1')).toBe(false);
    expect(recent[recent.length - 1]?.id).toBe(`m${rows.length - 1}`);
    // every message it returns is whole: no record was cut at the window edge
    for (const m of recent) expect(m.body).toBe(pad);
    expect(home.lastMessageSeq()).toBe(rows.length - 1);
  });

  it('keeps a first line that starts exactly at the window edge', () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    const first = JSON.stringify(message('m1', { at: 1 }));
    const second = JSON.stringify(message('m2', { at: 2 }));
    const filler = ' '.repeat(MESSAGES_TAIL_BYTES - Buffer.byteLength(second) - 1);
    // the window holds exactly "\n" + second record + newline, i.e. it starts on the second record's first byte
    writeFileSync(join(dir, MESSAGES_FILE), first + filler + '\n' + second + '\n');
    expect(home.loadRecentMessages(10).map((m) => m.id)).toEqual(['m2']);
  });

  it('numbers ids after the highest one in the log, partial lines included, and 0 for no log', () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    expect(home.lastMessageSeq()).toBe(0);
    writeFileSync(
      join(dir, MESSAGES_FILE),
      [JSON.stringify(message('m41')), '{"id":"m57","status":"read","note":null,"updatedAt":1}', JSON.stringify(message('x9')), 'garbage'].join('\n'),
    );
    expect(home.lastMessageSeq()).toBe(57);
  });

  it('rotates a log over the limit at open, keeps ids counting across it, and starts a fresh file', async () => {
    const dir = tmpDir();
    const logPath = join(dir, MESSAGES_FILE);
    const fd = openSync(logPath, 'w');
    // a sparse file: the size is what rotation looks at, the last bytes are what the id counter reads
    ftruncateSync(fd, MESSAGES_ROTATE_BYTES + 1000);
    // the newline before the record is what makes it a whole line inside the window
    const tail = '\n' + JSON.stringify(message('m77')) + '\n';
    writeSync(fd, tail, MESSAGES_ROTATE_BYTES + 1000 - tail.length);
    closeSync(fd);
    writeFileSync(join(dir, MESSAGES_ROTATED_FILE), 'an older rotated file\n');
    const home = openTestHome(dir);
    expect(existsSync(logPath)).toBe(false);
    expect(statSync(join(dir, MESSAGES_ROTATED_FILE)).size).toBe(MESSAGES_ROTATE_BYTES + 1000);
    expect(home.lastMessageSeq()).toBe(77);
    expect(home.loadRecentMessages(10)).toEqual([]);
    home.appendMessage(message('m78'));
    await home.close();
    expect(readFileSync(logPath, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    const reopened = openTestHome(dir);
    expect(reopened.lastMessageSeq()).toBe(78);
  });

  it('does not rotate a log under the limit', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, MESSAGES_FILE), JSON.stringify(message('m1')) + '\n');
    openTestHome(dir);
    expect(existsSync(join(dir, MESSAGES_ROTATED_FILE))).toBe(false);
    expect(existsSync(join(dir, MESSAGES_FILE))).toBe(true);
  });

  it('rotates at run time too: the line that finds the log over the limit moves it aside first, and no line is lost or torn', async () => {
    const dir = tmpDir();
    const logPath = join(dir, MESSAGES_FILE);
    const rotatedPath = join(dir, MESSAGES_ROTATED_FILE);
    // a sparse file 100 bytes under the limit: opening the home leaves it alone, and the first line takes it over
    const fd = openSync(logPath, 'w');
    ftruncateSync(fd, MESSAGES_ROTATE_BYTES - 100);
    closeSync(fd);
    const { log, lines } = collectingLog();
    const home = openTestHome(dir, log);
    expect(existsSync(rotatedPath)).toBe(false);
    for (let i = 1; i <= 50; i += 1) home.appendMessage(message(`m${i}`, { at: i }));
    await home.close();
    // m1 filled the old file past the limit, m2 found it so and started the new one
    expect(readFileSync(rotatedPath).subarray(MESSAGES_ROTATE_BYTES - 100).toString()).toBe(JSON.stringify(message('m1', { at: 1 })) + '\n');
    const fresh = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    expect(fresh.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual(Array.from({ length: 49 }, (_, i) => `m${i + 2}`));
    expect(lines.filter((l) => l.includes('moved to')).length).toBe(1);
    // ids go on counting from the new file
    expect(openTestHome(dir).lastMessageSeq()).toBe(50);
  });

  it('does not rotate at run time while the log is under the limit', async () => {
    const dir = tmpDir();
    const fd = openSync(join(dir, MESSAGES_FILE), 'w');
    ftruncateSync(fd, MESSAGES_ROTATE_BYTES - 100_000);
    closeSync(fd);
    const home = openTestHome(dir);
    for (let i = 1; i <= 20; i += 1) home.appendMessage(message(`m${i}`));
    await home.close();
    expect(existsSync(join(dir, MESSAGES_ROTATED_FILE))).toBe(false);
    expect(statSync(join(dir, MESSAGES_FILE)).size).toBeGreaterThan(MESSAGES_ROTATE_BYTES - 100_000);
  });

  it('keeps appending when the rotation cannot be done, and says so', async () => {
    const dir = tmpDir();
    const logPath = join(dir, MESSAGES_FILE);
    const fd = openSync(logPath, 'w');
    ftruncateSync(fd, MESSAGES_ROTATE_BYTES - 100);
    closeSync(fd);
    // a directory with something in it cannot be replaced by a file
    mkdirSync(join(dir, MESSAGES_ROTATED_FILE));
    writeFileSync(join(dir, MESSAGES_ROTATED_FILE, 'keep'), 'x');
    const { log, lines } = collectingLog();
    const home = openTestHome(dir, log);
    expect(lines.some((l) => l.includes('could not rotate'))).toBe(false);
    for (const id of ['m1', 'm2', 'm3']) home.appendMessage(message(id));
    await home.close();
    expect(lines.some((l) => l.includes('warn') && l.includes('could not rotate'))).toBe(true);
    const appended = readFileSync(logPath).subarray(MESSAGES_ROTATE_BYTES - 100).toString();
    expect(appended).toBe(['m1', 'm2', 'm3'].map((id) => JSON.stringify(message(id)) + '\n').join(''));
  });

  it('gives the path of an agent directory and rejects names that could leave it', () => {
    const dir = tmpDir();
    const home = openTestHome(dir);
    expect(home.agentDir('ana')).toBe(join(dir, 'agents', 'ana'));
    for (const bad of ['', '..', '../x', 'a/b', 'A', '-a', 'a'.repeat(33), 'a b', '.hidden']) {
      expect(() => home.agentDir(bad)).toThrow(/invalid agent name/);
    }
    expect(() => home.agentDir(undefined as unknown as string)).toThrow(/invalid agent name/);
    expect(new RegExp(AGENT_NAME_PATTERN).test('ana')).toBe(true);
  });

  describe('a home or a token that is not private', () => {
    const uid = process.getuid?.() ?? 0;
    const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /** The process as another user: whatever it created itself now looks foreign to it. */
    const asUser = (other: number): void => {
      const spy = vi.spyOn(process, 'getuid').mockReturnValue(other);
      cleanups.push(() => spy.mockRestore());
    };
    const chmodDoes = (hook: () => void): void => {
      fsHooks.chmodSync = hook;
      cleanups.push(() => {
        fsHooks.chmodSync = null;
      });
    };
    const hostsAreForeign = existsSync('/etc/hosts') && statSync('/etc/hosts').uid !== uid;

    it('refuses a home that another user owns in one line that says what to do, before it takes the lock or writes a token', () => {
      const dir = tmpDir();
      asUser(uid + 1);
      expect(() => openHome(dir)).toThrowError(new RegExp(`^${escaped(dir)} belongs to another user \\(uid \\d+\\); use --home with a directory of your own$`));
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      expect(existsSync(join(dir, 'token'))).toBe(false);
      // nothing was put into it either
      expect(readdirSync(dir)).toEqual([]);
      expect(() => openHome(dir)).toThrowError(/^[^\n]+$/);
    });

    it.skipIf(statSync('/usr').uid === uid)('refuses an agents directory that another user owns just the same, and never touches its mode', () => {
      const dir = tmpDir();
      const before = statSync('/usr').mode;
      symlinkSync('/usr', join(dir, 'agents'));
      expect(() => openHome(dir)).toThrowError(new RegExp(`^${escaped(join(dir, 'agents'))} belongs to another user \\(uid \\d+\\); use --home with a directory of your own$`));
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      expect(statSync('/usr').mode).toBe(before);
    });

    it.skipIf(!hostsAreForeign)('refuses an existing token file that another user owns, releases the lock and leaves the file alone', () => {
      const dir = tmpDir();
      // a file of root's behind the name: whatever it holds, it is not ours to adopt or to replace
      symlinkSync('/etc/hosts', join(dir, 'token'));
      const before = readFileSync('/etc/hosts', 'utf8');
      expect(() => openHome(dir)).toThrowError(new RegExp(`^${escaped(join(dir, 'token'))} belongs to another user \\(uid \\d+\\); delete it \\(a new token is made\\) or use --home with a directory of your own$`));
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      expect(readFileSync('/etc/hosts', 'utf8')).toBe(before);
    });

    it('refuses a home whose group and other bits chmod does not clear, and says what chmod answered', () => {
      const dir = tmpDir();
      mkdirSync(join(dir, 'agents'));
      chmodSync(dir, 0o755);
      chmodDoes(() => undefined);
      expect(() => openHome(dir)).toThrowError(
        new RegExp(`^${escaped(dir)} is open to other users \\(mode 755\\) and chmod 700 did not close it; have its owner run chmod 700 on it, or use --home with a directory of your own$`),
      );
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      chmodDoes(() => {
        throw Object.assign(new Error("EPERM: operation not permitted, chmod 'x'"), { code: 'EPERM' });
      });
      expect(() => openHome(dir)).toThrowError(/did not close it \(EPERM: operation not permitted, chmod 'x'\); have its owner run chmod 700/);
    });

    it('refuses a token file that stays readable by others, and releases the lock', () => {
      const dir = tmpDir();
      const token = join(dir, 'token');
      writeFileSync(token, 'c3'.repeat(32) + '\n');
      chmodSync(token, 0o644);
      chmodDoes(() => undefined);
      expect(() => openHome(dir)).toThrowError(new RegExp(`^${escaped(token)} is open to other users \\(mode 644\\) and chmod 600 did not close it; have its owner run chmod 600 on it, or use --home`));
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      // the same token opens once chmod works again
      fsHooks.chmodSync = null;
      expect(openTestHome(dir).browserToken).toBe('c3'.repeat(32));
      expect(fileMode(token)).toBe(0o600);
    });

    it('names a home that is not a directory, and a token that is not a file', () => {
      const file = join(tmpDir(), 'plain');
      writeFileSync(file, 'x');
      expect(() => openHome(file)).toThrowError(new RegExp(`^${escaped(file)} is not a directory; remove it or use --home with a directory of your own$`));
      const dir = tmpDir();
      mkdirSync(join(dir, 'token'));
      expect(() => openHome(dir)).toThrowError(new RegExp(`^${escaped(join(dir, 'token'))} is not a file; remove it or use --home`));
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    });

    it('starts as before for a home and a token of its own, loose modes from a restore included', () => {
      const dir = tmpDir();
      mkdirSync(join(dir, 'agents'));
      chmodSync(dir, 0o777);
      writeFileSync(join(dir, 'token'), 'd4'.repeat(32) + '\n');
      chmodSync(join(dir, 'token'), 0o666);
      const home = openTestHome(dir);
      expect(home.browserToken).toBe('d4'.repeat(32));
      expect([fileMode(dir), fileMode(join(dir, 'agents')), fileMode(join(dir, 'token'))]).toEqual([0o700, 0o700, 0o600]);
    });
  });

  describe('lock', () => {
    it('writes the pid, refuses a second open of the same directory in this process, and close() removes it', async () => {
      const dir = tmpDir();
      const home = openHome(dir);
      expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(`${process.pid}\n`);
      expect(fileMode(join(dir, LOCK_FILE))).toBe(0o600);
      expect(() => openHome(dir)).toThrowError(`another gonogo is using ${dir} (pid ${process.pid}). Stop it, or delete ${join(dir, LOCK_FILE)} if none is running.`);
      // the refused open did not take the lock away
      expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
      await home.close();
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      const again = openTestHome(dir);
      expect(again.dir).toBe(dir);
    });

    it('refuses a directory whose lock names another running process', () => {
      const dir = tmpDir();
      writeFileSync(join(dir, LOCK_FILE), `${process.ppid}\n`);
      expect(() => openHome(dir)).toThrowError(/^another gonogo is using .+ \(pid \d+\)\. Stop it, or delete .+server\.lock if none is running\.$/);
      expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(`${process.ppid}\n`);
    });

    it.each([
      ['a pid that does not exist', '2147483646\n'],
      ['text that is not a number', 'hello\n'],
      ['an empty file', ''],
      ['zero', '0\n'],
      ['a negative number', '-5\n'],
    ])('replaces a stale lock holding %s', (_what, content) => {
      const dir = tmpDir();
      writeFileSync(join(dir, LOCK_FILE), content);
      const home = openTestHome(dir);
      expect(home.dir).toBe(dir);
      expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(`${process.pid}\n`);
    });

    it("replaces a lock that names this very process when this process holds no lock on the directory (a container's pids repeat)", () => {
      const dir = tmpDir();
      writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);
      const home = openTestHome(dir);
      expect(home.dir).toBe(dir);
    });

    it('does not remove a lock that now belongs to someone else, and a second close() is a no-op', async () => {
      const dir = tmpDir();
      const home = openHome(dir);
      writeFileSync(join(dir, LOCK_FILE), `${process.ppid}\n`);
      await home.close();
      expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(`${process.ppid}\n`);
      await expect(home.close()).resolves.toBeUndefined();
    });

    it('releases the lock when the open fails after taking it', () => {
      const dir = tmpDir();
      mkdirSync(join(dir, 'token'));
      expect(() => openHome(dir)).toThrow();
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      rmSync(join(dir, 'token'), { recursive: true });
      expect(openTestHome(dir).dir).toBe(dir);
    });

    it('flushes queued saves and appends before it lets go of the lock', async () => {
      const dir = tmpDir();
      const home = openHome(dir);
      const save = home.saveRoster({ version: 1, agents: [agentRecord('ana') as never] });
      for (let i = 1; i <= 50; i += 1) home.appendMessage(message(`m${i}`, { at: i }));
      await home.close();
      await save;
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      const reopened = openTestHome(dir);
      expect(reopened.loadRoster().agents).toHaveLength(1);
      expect(reopened.loadRecentMessages(100)).toHaveLength(50);
    });

    it('logs and survives an append that fails', async () => {
      const dir = tmpDir();
      const { log, lines } = collectingLog();
      const home = openHome(dir, log);
      rmSync(dir, { recursive: true, force: true });
      home.appendMessage(message('m1'));
      await home.close();
      expect(lines.some((l) => l.includes('error') && l.includes('could not append'))).toBe(true);
      mkdirSync(dir, { recursive: true });
    });
  });
});

/* ================================================================================================================
 * hooks (through the web server: Host and Origin checks come first, as in production)
 * ============================================================================================================== */

interface HookOptions {
  token?: string | null;
  headers?: Record<string, string>;
  body?: string | Buffer;
  method?: string;
  agent?: Agent;
}

function postHook(port: number, path: string, options: HookOptions = {}): Promise<HttpResult> {
  const token = options.token === undefined ? ANA_TOKEN : options.token;
  return send(port, {
    method: options.method ?? 'POST',
    path,
    headers: { ...(token === null ? {} : bearer(token)), ...JSON_HEADERS, ...options.headers },
    body: options.body ?? '{}',
    agent: options.agent,
  });
}

function onHookCalls(calls: Call[]): unknown[] {
  return calls.filter((c) => c.fn === 'onHook').map((c) => c.args[0]);
}

describe('hooks', () => {
  it('answers 401 without a usable agent token, and keeps serving', async () => {
    const { port, hubCalls } = await startWeb();
    const attempts: Array<string | null> = [null, 'f'.repeat(64), '', 'é'.repeat(64), TOKEN];
    for (const token of attempts) {
      const res = await postHook(port, '/hook/ana/Stop', { token });
      expect(res.status).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized', code: 'unauthorized' });
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
    for (const authorization of ['Bearer', 'Basic abc', `Token ${ANA_TOKEN}`, `Bearer ${ANA_TOKEN} extra`]) {
      const res = await postHook(port, '/hook/ana/Stop', { token: null, headers: { Authorization: authorization } });
      expect(res.status).toBe(401);
    }
    expect(onHookCalls(hubCalls)).toEqual([]);
    await expectStillServing(port);
  });

  it('answers 403 when the token belongs to another agent', async () => {
    const { port, hubCalls } = await startWeb();
    const res = await postHook(port, '/hook/ana/Stop', { token: BEN_TOKEN });
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: 'token does not belong to this agent', code: 'forbidden' });
    expect(onHookCalls(hubCalls)).toEqual([]);
  });

  it('answers 404 for an unknown event, a bad agent name and a path of the wrong shape', async () => {
    const { port, hubCalls } = await startWeb();
    for (const path of ['/hook/ana/Bogus', '/hook/Ana/Stop', '/hook/ana/stop', '/hook/ana', '/hook/ana/Stop/extra', '/hook/', '/hook']) {
      const res = await postHook(port, path);
      expect(res.status).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    }
    expect(onHookCalls(hubCalls)).toEqual([]);
  });

  it('answers 405 with Allow for other methods, after the token check', async () => {
    const { port } = await startWeb();
    const res = await postHook(port, '/hook/ana/Stop', { method: 'GET', body: '' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
    const noToken = await postHook(port, '/hook/ana/Stop', { method: 'GET', body: '', token: null });
    expect(noToken.status).toBe(401);
  });

  it.each([
    ['broken JSON', '{'],
    ['an array', '[1]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['a number', '12'],
    ['an empty body', ''],
  ])('answers 400 for %s', async (_what, body) => {
    const { port, hubCalls } = await startWeb();
    const res = await postHook(port, '/hook/ana/Stop', { body });
    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: 'hook body must be a JSON object', code: 'bad_request' });
    expect(onHookCalls(hubCalls)).toEqual([]);
  });

  it('refuses any Origin header, even one that matches the server', async () => {
    const { port, hubCalls } = await startWeb();
    for (const origin of [`http://127.0.0.1:${port}`, 'null', 'https://evil.example', '']) {
      const res = await postHook(port, '/hook/ana/Stop', { headers: { Origin: origin } });
      expect(res.status).toBe(403);
      expect(res.body).toBe('forbidden origin');
      expect(res.headers['content-type']).toBe('text/plain');
    }
    expect(onHookCalls(hubCalls)).toEqual([]);
  });

  it('answers 413 for a body over the limit, drains the rest and keeps serving', async () => {
    const { port, hubCalls } = await startWeb();
    const res = await postHook(port, '/hook/ana/Stop', { body: Buffer.alloc(MAX_HOOK_BODY_BYTES + 1, 0x61), agent: keepAliveAgent() });
    expect(res.status).toBe(413);
    expect(res.json()).toEqual({ error: 'hook body too large', code: 'too_large' });
    expect(onHookCalls(hubCalls)).toEqual([]);
    const ok = await postHook(port, '/hook/ana/Stop', { body: JSON.stringify({ big: 'x'.repeat(1_000_000) }) });
    expect(ok.status).toBe(200);
  });

  it('counts the bytes of a body that has no declared length', async () => {
    const { port, hubCalls } = await startWeb();
    const agent = keepAliveAgent();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'POST', path: '/hook/ana/Stop', agent, headers: { ...bearer(ANA_TOKEN), 'Transfer-Encoding': 'chunked' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i <= MAX_HOOK_BODY_BYTES / chunk.length; i += 1) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
    expect(onHookCalls(hubCalls)).toEqual([]);
    await expectStillServing(port);
  });

  it('passes the agent, the generation of the token, the event and the payload to the hub', async () => {
    const { port, hubCalls } = await startWeb();
    const payload = { session_id: 's1', prompt: 'hello', tool_input: { command: 'ls' }, extra: [1, 2] };
    expect((await postHook(port, '/hook/ana/UserPromptSubmit', { body: JSON.stringify(payload) })).status).toBe(200);
    expect((await postHook(port, '/hook/ben/Stop', { token: BEN_TOKEN, body: '{}' })).status).toBe(200);
    expect(onHookCalls(hubCalls)).toEqual([
      { agent: 'ana', generation: 3, event: 'UserPromptSubmit', payload },
      { agent: 'ben', generation: 1, event: 'Stop', payload: {} },
    ]);
  });

  it('accepts every registered event, PostToolUseFailure included', async () => {
    const { port, hubCalls } = await startWeb();
    for (const event of HOOK_EVENTS) {
      const res = await postHook(port, `/hook/ana/${event}`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('{}');
    }
    expect(onHookCalls(hubCalls).map((c) => (c as { event: string }).event)).toEqual([...HOOK_EVENTS]);
  });

  it('does not look at the content type', async () => {
    const { port } = await startWeb();
    const res = await postHook(port, '/hook/ana/Stop', { headers: { 'Content-Type': 'text/plain' }, body: '{"a":1}' });
    expect(res.status).toBe(200);
  });

  it('replies {} to lets the agent go, passes a Stop block through, and strips a decision from any other event', async () => {
    const block: HookReply = { decision: 'block', reason: 'gonogo: 1 new message from ana. Call read_messages.' };
    const { port } = await startWeb({}, { onHook: () => block });
    const stop = await postHook(port, '/hook/ana/Stop');
    expect(stop.status).toBe(200);
    expect(stop.headers['content-type']).toBe('application/json');
    expect(stop.body).toBe('{"decision":"block","reason":"gonogo: 1 new message from ana. Call read_messages."}');
    for (const event of HOOK_EVENTS.filter((e) => e !== 'Stop')) {
      const res = await postHook(port, `/hook/ana/${event}`);
      expect(res.body).toBe('{}');
    }
  });

  it.each<[string, unknown]>([
    ['a block with no reason', { decision: 'block' }],
    ['a block with an empty reason', { decision: 'block', reason: '' }],
    ['a reason with no decision', { reason: 'x' }],
    ['another decision', { decision: 'approve', reason: 'x' }],
    ['null', null],
    ['unknown fields only', { continue: false }],
  ])('lets a Stop go when the hub answers %s', async (_what, reply) => {
    const { port } = await startWeb({}, { onHook: () => reply as HookReply });
    const res = await postHook(port, '/hook/ana/Stop');
    expect(res.status).toBe(200);
    expect(res.body).toBe('{}');
  });

  it('keeps only decision and reason of a Stop block', async () => {
    const { port } = await startWeb({}, { onHook: () => ({ decision: 'block', reason: 'r', secret: 'no' }) as HookReply });
    expect((await postHook(port, '/hook/ana/Stop')).body).toBe('{"decision":"block","reason":"r"}');
  });

  it('answers 500 when the hub throws, logs it, and the next hook works', async () => {
    const { log, lines } = collectingLog();
    let first = true;
    const { port } = await startWeb({ log }, {
      onHook: () => {
        if (first) {
          first = false;
          throw new Error('boom inside the hub');
        }
        return {};
      },
    });
    const res = await postHook(port, '/hook/ana/Stop');
    expect(res.status).toBe(500);
    expect(res.json()).toEqual({ error: 'internal error', code: 'internal' });
    expect(res.body).not.toContain('boom');
    expect(lines.some((l) => l.includes('error') && l.includes('boom inside the hub'))).toBe(true);
    expect((await postHook(port, '/hook/ana/Stop')).status).toBe(200);
  });

  it('sets the standing headers and no-store, and sends no CORS header', async () => {
    const { port } = await startWeb();
    const res = await postHook(port, '/hook/ana/Stop');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('survives a client that goes away in the middle of the body', async () => {
    const { port, hubCalls } = await startWeb();
    await new Promise<void>((resolve) => {
      const socket = netConnect({ host: '127.0.0.1', port }, () => {
        socket.write(`POST /hook/ana/Stop HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${ANA_TOKEN}\r\nContent-Length: 1000\r\n\r\n{"half":`);
        setTimeout(() => socket.resetAndDestroy(), 30);
      });
      socket.on('error', () => undefined);
      socket.on('close', () => resolve());
    });
    await sleep(50);
    expect(onHookCalls(hubCalls)).toEqual([]);
    await expectStillServing(port);
  });

  it('works without the web server around it: token, method, shape, body and reply in one handler', async () => {
    const seen: unknown[] = [];
    const handler = createHookHandler({
      hub: { onHook: (input) => (seen.push(input), { decision: 'block', reason: 'r' }) },
      resolveToken: (token) => identities.get(token) ?? null,
      log: nullLogger,
    });
    const server = createNetServer();
    server.close();
    const { createServer } = await import('node:http');
    const http = createServer((req, res) => {
      handler(req, res, 'ana', 'Stop').catch(() => res.destroy());
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await postHook(port, '/anything');
    expect(res.body).toBe('{"decision":"block","reason":"r"}');
    expect(seen).toHaveLength(1);
  });
});

/* ================================================================================================================
 * mcp
 * ============================================================================================================== */

async function connectMcp(port: number, token = ANA_TOKEN): Promise<Client> {
  const client = new Client({ name: 'edge-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: bearer(token) } }));
  cleanups.push(() => client.close());
  return client;
}

function toolOutcome(result: unknown): { text: string; isError: boolean; json: unknown } {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const first = r.content?.[0];
  const text = first?.type === 'text' ? (first.text ?? '') : '';
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: the text itself is what the test looks at
  }
  return { text, isError: r.isError === true, json };
}

const RPC_NOT_ALLOWED = '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}';

function postMcp(
  port: number,
  options: { token?: string | null; headers?: Record<string, string>; body?: string | Buffer; agent?: Agent } = {},
): Promise<HttpResult> {
  const token = options.token === undefined ? ANA_TOKEN : options.token;
  return send(port, {
    method: 'POST',
    path: '/mcp',
    headers: { ...(token === null ? {} : bearer(token)), ...JSON_HEADERS, Accept: 'application/json, text/event-stream', ...options.headers },
    body: options.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    agent: options.agent,
  });
}

describe('flight plan', () => {
  const task = { id: 't1', title: 'Write the spec', detail: '', status: 'todo', assignee: null, createdBy: 'user', createdAt: 1, updatedAt: 1, notes: [] };
  /** A tasks that records what the routes and the tools ask of it, with the actor it was asked as. */
  function fakeTasks(): { calls: unknown[][]; tasks: NonNullable<WebOptions['tasks']> } {
    const calls: unknown[][] = [];
    const known = (id: string): void => {
      if (id !== 't1') throw new FakeHubError('not_found', 'unknown task');
    };
    return {
      calls,
      tasks: {
        list: () =>
          [
            { ...task, id: 't1', updatedAt: 5, assignee: 'ana' },
            { ...task, id: 't2', updatedAt: 9, status: 'doing', assignee: 'ben' },
            { ...task, id: 't3', updatedAt: 7, status: 'doing', assignee: 'ana' },
          ] as never,
        create: async (actor, input) => {
          calls.push(['create', actor, input]);
          if ((input as { title?: unknown }).title === 'bad') throw new FakeHubError('bad_request', 'title must be 1 to 200 characters on one line', 'title');
          return task as never;
        },
        update: async (actor, id, input) => {
          calls.push(['update', actor, id, input]);
          known(id);
          return { ...task, status: 'doing' } as never;
        },
        remove: async (id) => {
          calls.push(['remove', id]);
          known(id);
        },
      },
    };
  }

  it('lists, makes, changes and removes tasks as the Director', async () => {
    const { calls, tasks } = fakeTasks();
    const { port } = await startWeb({ tasks });
    expect((await api(port, 'GET', '/api/tasks')).json()).toHaveLength(3);
    const made = await api(port, 'POST', '/api/tasks', { title: 'Write the spec', assignee: 'ana' });
    expect([made.status, made.json()]).toEqual([201, task]);
    expect((await api(port, 'POST', '/api/tasks', { title: 'bad' })).json()).toEqual({ error: 'title must be 1 to 200 characters on one line', code: 'bad_request', field: 'title' });
    expect((await api(port, 'POST', '/api/tasks', [1])).status).toBe(400);
    const patched = await api(port, 'PATCH', '/api/tasks/t1', { status: 'doing' });
    expect([patched.status, patched.json()]).toEqual([200, { ...task, status: 'doing' }]);
    expect((await api(port, 'DELETE', '/api/tasks/t1')).status).toBe(204);
    for (const method of ['PATCH', 'DELETE'] as const) {
      expect((await api(port, method, '/api/tasks/t2', method === 'PATCH' ? {} : undefined)).json(), method).toEqual({ error: 'unknown task', code: 'not_found' });
    }
    // the browser is the Director, whatever the body says
    expect(calls[0]).toEqual(['create', { kind: 'user' }, { title: 'Write the spec', assignee: 'ana' }]);
    expect(calls.filter((c) => c[0] === 'update')[0]).toEqual(['update', { kind: 'user' }, 't1', { status: 'doing' }]);
    expect(calls.filter((c) => c[0] === 'remove')[0]).toEqual(['remove', 't1']);
  });

  it('allows only the methods of each route, and wants a browser token', async () => {
    const { tasks } = fakeTasks();
    const { port } = await startWeb({ tasks });
    expect((await api(port, 'PUT', '/api/tasks')).status).toBe(405);
    expect((await api(port, 'DELETE', '/api/tasks')).status).toBe(405);
    expect((await api(port, 'GET', '/api/tasks/t1')).status).toBe(405);
    expect((await api(port, 'POST', '/api/tasks/t1')).status).toBe(405);
    expect((await api(port, 'GET', '/api/tasks/t1/more')).status).toBe(404);
    expect((await api(port, 'GET', '/api/tasks', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'PATCH', '/api/tasks/t1', { status: 'done' }, ANA_TOKEN)).status).toBe(401);
  });

  it('shows the list in the first state frame, and is 404 without a tasks', async () => {
    const { tasks } = fakeTasks();
    const { port } = await startWeb({ tasks });
    expect((await openWs(port)).frames[0]).toMatchObject({ t: 'state', state: { tasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] } });
    const none = await startWeb();
    expect((await api(none.port, 'GET', '/api/tasks')).status).toBe(404);
    expect((await api(none.port, 'DELETE', '/api/tasks/t1')).status).toBe(404);
  });

  it('gives the agents three tools, stamped with the agent and the generation of the token', async () => {
    const { calls, tasks } = fakeTasks();
    const { port } = await startWeb({ tasks });
    const ana = await connectMcp(port, ANA_TOKEN);
    const ben = await connectMcp(port, BEN_TOKEN);
    const made = toolOutcome(await ana.callTool({ name: 'task_create', arguments: { title: 'Write the spec', detail: 'd', assignee: 'ben', createdBy: 'flight', actor: 'x' } }));
    expect(made).toMatchObject({ isError: false, json: { ok: true, task } });
    const moved = toolOutcome(await ben.callTool({ name: 'task_update', arguments: { id: 't1', status: 'doing', assignee: null, note: 'go', agent: 'flight', generation: 9 } }));
    expect(moved).toMatchObject({ isError: false, json: { ok: true, task: { status: 'doing' } } });
    expect(calls).toEqual([
      ['create', { kind: 'agent', name: 'ana', generation: 3 }, { title: 'Write the spec', detail: 'd', assignee: 'ben' }],
      ['update', { kind: 'agent', name: 'ben', generation: 1 }, 't1', { status: 'doing', assignee: null, note: 'go' }],
    ]);
  });

  it('lists the tasks most recently changed first, and filters by mine and by status', async () => {
    const { tasks } = fakeTasks();
    const { port } = await startWeb({ tasks });
    const ana = await connectMcp(port, ANA_TOKEN);
    const ids = async (args: Record<string, unknown>): Promise<unknown> => {
      const out = toolOutcome(await ana.callTool({ name: 'task_list', arguments: args }));
      expect(out.isError).toBe(false);
      return (out.json as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
    };
    expect(await ids({})).toEqual(['t2', 't3', 't1']);
    expect(await ids({ mine: true })).toEqual(['t3', 't1']);
    expect(await ids({ status: 'doing' })).toEqual(['t2', 't3']);
    expect(await ids({ mine: true, status: 'doing' })).toEqual(['t3']);
    expect(await ids({ status: 'done' })).toEqual([]);
    expect(toolOutcome(await ana.callTool({ name: 'task_list', arguments: { status: 'finished' } })).isError).toBe(true);
  });

  it('cuts a long list like read_messages does and says how many are left', async () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ ...task, id: `t${i + 1}`, updatedAt: i, detail: 'x'.repeat(4000) }));
    const { port } = await startWeb({ tasks: { list: () => big as never, create: async () => task as never, update: async () => task as never, remove: async () => undefined } });
    const ana = await connectMcp(port, ANA_TOKEN);
    const out = toolOutcome(await ana.callTool({ name: 'task_list', arguments: {} }));
    const body = out.json as { count: number; tasks: Array<{ id: string }>; remaining: number; note: string };
    expect(body.count).toBeGreaterThan(5);
    expect(body.count).toBeLessThan(15);
    expect(body.remaining).toBe(30 - body.count);
    expect(body.tasks[0]?.id).toBe('t30');
    expect(out.text.length).toBeLessThan(45_000);
  });

  it('reports a refusal of the store as an error with its text, and a bad argument without calling the store', async () => {
    const calls: unknown[] = [];
    const refuse = async (): Promise<never> => {
      calls.push('called');
      throw new FakeHubError('bad_request', 'assignee must be the name of an agent in the room, or null', 'assignee');
    };
    const { port } = await startWeb({ tasks: { list: () => [], create: refuse, update: refuse, remove: async () => undefined } });
    const ana = await connectMcp(port, ANA_TOKEN);
    expect(toolOutcome(await ana.callTool({ name: 'task_create', arguments: { title: 't', assignee: 'nobody' } }))).toMatchObject({
      isError: true,
      text: '{"ok":false,"error":"assignee must be the name of an agent in the room, or null"}',
    });
    expect(toolOutcome(await ana.callTool({ name: 'task_update', arguments: { id: 't1', note: 'n' } })).isError).toBe(true);
    for (const [name, args] of [
      ['task_create', { title: '' }],
      ['task_create', { title: 'x'.repeat(201) }],
      ['task_create', { title: 't', detail: 'x'.repeat(4001) }],
      ['task_update', { status: 'done' }],
      ['task_update', { id: 't1', status: 'finished' }],
      ['task_update', { id: 't1', note: 'x'.repeat(201) }],
    ] as const) {
      const out = await ana.callTool({ name, arguments: args }).catch(() => ({ isError: true }));
      expect((out as { isError?: boolean }).isError, JSON.stringify([name, args])).toBe(true);
    }
    expect(calls).toHaveLength(2);
  });

  it('says the board is not available when the server has none', async () => {
    const { port } = await startWeb();
    const ana = await connectMcp(port, ANA_TOKEN);
    for (const [name, args] of [
      ['task_list', {}],
      ['task_create', { title: 't' }],
      ['task_update', { id: 't1', status: 'done' }],
    ] as const) {
      expect(toolOutcome(await ana.callTool({ name, arguments: args }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"the Flight Plan is not available"}' });
    }
  });
});

describe('mission log', () => {
  const entry = { id: 'l1', title: 'Cache key', body: 'The cache key has the node version.', tags: ['build'], author: 'ana', createdAt: 1, updatedAt: 2 };
  const hit = { id: 'l1', title: 'Cache key', author: 'ana', tags: ['build'], updatedAt: 2, snippet: 'The cache key has the node version.' };
  /** A mission log that records what the routes and the tools ask of it, with the author or the agent it was asked as. */
  function fakeLog(): { calls: unknown[][]; missionLog: NonNullable<WebOptions['missionLog']> } {
    const calls: unknown[][] = [];
    const known = (id: string): void => {
      if (id !== 'l1') throw new FakeHubError('not_found', 'unknown entry');
    };
    return {
      calls,
      missionLog: {
        search: (query, limit) => {
          calls.push(['search', query, limit]);
          return { total: 7, hits: query === 'nothing' ? [] : [hit] };
        },
        get: (id) => {
          calls.push(['get', id]);
          known(id);
          return entry;
        },
        chart: () => ({ total: 7, shown: 1, nodes: [{ id: 'entry:l1', kind: 'entry', ref: 'l1', label: 'Cache key', weight: 1 }], edges: [] }),
        create: async (author, input) => {
          calls.push(['create', author, input]);
          if ((input as { title?: unknown }).title === 'bad') throw new FakeHubError('bad_request', 'title must be 1 to 200 characters on one line', 'title');
          return entry;
        },
        update: async (id, input, by) => {
          calls.push(['update', id, input, by]);
          known(id);
          if (by === 'ben') throw new FakeHubError('forbidden', 'l1 was written by ana: only its author or the Director may change it');
          return { ...entry, title: 'Changed' };
        },
        remove: async (id) => {
          calls.push(['remove', id]);
          known(id);
        },
      },
    };
  }

  it('searches, reads, writes, changes and removes entries as the Director', async () => {
    const { calls, missionLog } = fakeLog();
    const { port } = await startWeb({ missionLog });
    expect((await api(port, 'GET', '/api/log?q=cache%20key')).json()).toEqual({ total: 7, hits: [hit] });
    expect((await api(port, 'GET', '/api/log')).json()).toEqual({ total: 7, hits: [hit] });
    expect((await api(port, 'GET', '/api/log?q=')).status).toBe(200);
    expect((await api(port, 'GET', '/api/log/l1')).json()).toEqual(entry);
    expect((await api(port, 'GET', '/api/log/chart')).json()).toMatchObject({ total: 7, shown: 1, nodes: [{ id: 'entry:l1' }], edges: [] });
    for (const method of ['POST', 'PUT', 'DELETE'] as const) expect((await api(port, method, '/api/log/chart', method === 'DELETE' ? undefined : {})).status, method).toBe(405);
    const made = await api(port, 'POST', '/api/log', { title: 'Cache key', body: 'b', tags: ['build'] });
    expect([made.status, made.json()]).toEqual([201, entry]);
    expect((await api(port, 'POST', '/api/log', { title: 'bad' })).json()).toEqual({ error: 'title must be 1 to 200 characters on one line', code: 'bad_request', field: 'title' });
    expect((await api(port, 'POST', '/api/log', [1])).status).toBe(400);
    const put = await api(port, 'PUT', '/api/log/l1', { title: 'Changed' });
    expect([put.status, (put.json() as { title: string }).title]).toEqual([200, 'Changed']);
    expect((await api(port, 'DELETE', '/api/log/l1')).status).toBe(204);
    for (const [method, body] of [['GET', undefined], ['PUT', {}], ['DELETE', undefined]] as const) {
      expect((await api(port, method, '/api/log/l2', body)).json(), method).toEqual({ error: 'unknown entry', code: 'not_found' });
    }
    // no limit: the log gives its own cap; the browser is the Director, whatever the body says
    expect(calls[0]).toEqual(['search', 'cache key', undefined]);
    expect(calls[1]).toEqual(['search', '', undefined]);
    expect(calls.find((c) => c[0] === 'create')).toEqual(['create', 'user', { title: 'Cache key', body: 'b', tags: ['build'] }]);
    expect(calls.find((c) => c[0] === 'update')).toEqual(['update', 'l1', { title: 'Changed' }, null]);
    expect(calls.find((c) => c[0] === 'remove')).toEqual(['remove', 'l1']);
  });

  it('allows only the methods of each route, and wants a browser token', async () => {
    const { missionLog } = fakeLog();
    const { port } = await startWeb({ missionLog });
    expect((await api(port, 'PUT', '/api/log')).status).toBe(405);
    expect((await api(port, 'DELETE', '/api/log')).status).toBe(405);
    expect((await api(port, 'PATCH', '/api/log/l1', {})).status).toBe(405);
    expect((await api(port, 'POST', '/api/log/l1', {})).status).toBe(405);
    expect((await api(port, 'GET', '/api/log/l1/more')).status).toBe(404);
    expect((await api(port, 'GET', '/api/log?q=cache', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'PUT', '/api/log/l1', { title: 'x' }, ANA_TOKEN)).status).toBe(401);
  });

  it('is 404 without a mission log', async () => {
    const none = await startWeb();
    expect((await api(none.port, 'GET', '/api/log')).status).toBe(404);
    expect((await api(none.port, 'DELETE', '/api/log/l1')).status).toBe(404);
  });

  it('gives the agents three tools, and the author is the agent of the token', async () => {
    const { calls, missionLog } = fakeLog();
    const { port } = await startWeb({ missionLog });
    const ana = await connectMcp(port, ANA_TOKEN);
    const ben = await connectMcp(port, BEN_TOKEN);
    const made = toolOutcome(await ana.callTool({ name: 'log_write', arguments: { title: 'Cache key', body: 'b', tags: ['build'], author: 'flight' } }));
    expect(made).toMatchObject({ isError: false, json: { ok: true, id: 'l1', title: 'Cache key', tags: ['build'] } });
    expect(made.text).not.toContain('node version');
    const changed = toolOutcome(await ana.callTool({ name: 'log_write', arguments: { id: 'l1', body: 'new' } }));
    expect(changed).toMatchObject({ isError: false, json: { ok: true, title: 'Changed' } });
    const read = toolOutcome(await ben.callTool({ name: 'log_read', arguments: { id: 'l1' } }));
    expect(read).toMatchObject({ isError: false, json: { ok: true, entry } });
    expect(calls).toEqual([
      ['create', 'ana', { title: 'Cache key', body: 'b', tags: ['build'] }],
      ['update', 'l1', { body: 'new' }, 'ana'],
      ['get', 'l1'],
    ]);
  });

  it('searches with a limit of at most 20, and answers a search with no hit', async () => {
    const { calls, missionLog } = fakeLog();
    const { port } = await startWeb({ missionLog });
    const ana = await connectMcp(port, ANA_TOKEN);
    expect(toolOutcome(await ana.callTool({ name: 'log_search', arguments: { query: 'cache', limit: 3 } }))).toMatchObject({ isError: false, json: { count: 1, results: [hit] } });
    expect(toolOutcome(await ana.callTool({ name: 'log_search', arguments: { query: 'nothing' } }))).toMatchObject({ isError: false, json: { count: 0, results: [] } });
    expect(calls).toEqual([['search', 'cache', 3], ['search', 'nothing', 20]]);
    for (const args of [{ query: '' }, { query: 'x'.repeat(201) }, { query: 'x', limit: 21 }, { query: 'x', limit: 0 }, { query: 'x', limit: 1.5 }, { limit: 3 }]) {
      const out = await ana.callTool({ name: 'log_search', arguments: args }).catch(() => ({ isError: true }));
      expect((out as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toHaveLength(2);
  });

  it('reports a refusal of the store as an error with its text, and a bad argument without calling the store', async () => {
    const { calls, missionLog } = fakeLog();
    const { port } = await startWeb({ missionLog });
    const ben = await connectMcp(port, BEN_TOKEN);
    expect(toolOutcome(await ben.callTool({ name: 'log_write', arguments: { id: 'l1', body: 'mine now' } }))).toMatchObject({
      isError: true,
      text: '{"ok":false,"error":"l1 was written by ana: only its author or the Director may change it"}',
    });
    expect(toolOutcome(await ben.callTool({ name: 'log_write', arguments: { title: 'bad', body: 'b' } }))).toMatchObject({ isError: true, json: { ok: false, error: expect.stringContaining('title') } });
    expect(toolOutcome(await ben.callTool({ name: 'log_read', arguments: { id: 'l9' } }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"unknown entry"}' });
    expect(calls).toHaveLength(3);
    for (const [name, args] of [
      ['log_write', { title: '' }],
      ['log_write', { title: 'x'.repeat(201) }],
      ['log_write', { body: 'x'.repeat(20_001) }],
      ['log_write', { tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }],
      ['log_write', { tags: 'build' }],
      ['log_read', {}],
      ['log_read', { id: '' }],
    ] as const) {
      const out = await ben.callTool({ name, arguments: args }).catch(() => ({ isError: true }));
      expect((out as { isError?: boolean }).isError, JSON.stringify([name, args])).toBe(true);
    }
    expect(calls).toHaveLength(3);
  });

  it('says the log is not available when the server has none', async () => {
    const { port } = await startWeb();
    const ana = await connectMcp(port, ANA_TOKEN);
    for (const [name, args] of [
      ['log_write', { title: 't', body: 'b' }],
      ['log_search', { query: 'q' }],
      ['log_read', { id: 'l1' }],
    ] as const) {
      expect(toolOutcome(await ana.callTool({ name, arguments: args }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"the Mission Log is not available"}' });
    }
  });
});

describe('livery', () => {
  const entry = { slug: 'dusk', name: 'Dusk', description: 'Blue.', builtin: false, author: 'ana', tokens: { '--body': '#112233' } };
  const view = { current: 'instrument', liveries: [{ slug: 'instrument', name: 'Instrument', description: 'd', builtin: true, author: null, tokens: { '--body': '#e4e2dc' } }, entry] };
  /** Liveries that record what the routes and the tool ask of them. */
  function fakeLiveries(): { calls: unknown[][]; liveries: NonNullable<WebOptions['liveries']> } {
    const calls: unknown[][] = [];
    return {
      calls,
      liveries: {
        view: () => view,
        select: async (input) => {
          calls.push(['select', input]);
          if ((input as { slug?: unknown }).slug === 'nope') throw new FakeHubError('not_found', 'unknown livery', 'slug');
          return { ...view, current: 'dusk' };
        },
        remove: async (slug) => {
          calls.push(['remove', slug]);
          if (slug === 'instrument') throw new FakeHubError('forbidden', 'a livery that ships cannot be deleted');
          return view;
        },
        submit: async (author, input) => {
          calls.push(['submit', author, input]);
          if ((input as { name?: unknown }).name === 'bad') throw new FakeHubError('bad_request', '--muted on --body is 3.00:1, it needs 4.5:1', 'tokens');
          return entry;
        },
        design: (input) => {
          calls.push(['design', input]);
          return { ok: true, id: 'm1', to: 'flight', status: 'queued', note: null };
        },
      },
    };
  }

  it('lists the liveries, chooses one, deletes one and asks for a design, as the Director', async () => {
    const { calls, liveries } = fakeLiveries();
    const { port } = await startWeb({ liveries });
    expect((await api(port, 'GET', '/api/liveries')).json()).toEqual(view);
    expect((await api(port, 'PUT', '/api/livery', { slug: 'dusk' })).json()).toEqual({ ...view, current: 'dusk' });
    expect((await api(port, 'PUT', '/api/livery', { slug: 'nope' })).json()).toEqual({ error: 'unknown livery', code: 'not_found', field: 'slug' });
    expect((await api(port, 'PUT', '/api/livery', [1])).status).toBe(400);
    expect((await api(port, 'DELETE', '/api/liveries/dusk')).json()).toEqual(view);
    expect((await api(port, 'DELETE', '/api/liveries/instrument')).status).toBe(403);
    const asked = await api(port, 'POST', '/api/liveries/design', { to: 'flight', brief: 'night' });
    expect([asked.status, asked.json()]).toEqual([201, { ok: true, id: 'm1', to: 'flight', status: 'queued', note: null }]);
    expect((await api(port, 'POST', '/api/liveries/design', 'x')).status).toBe(400);
    expect(calls).toEqual([['select', { slug: 'dusk' }], ['select', { slug: 'nope' }], ['remove', 'dusk'], ['remove', 'instrument'], ['design', { to: 'flight', brief: 'night' }]]);
  });

  it('puts the livery in the state, and allows only the methods of each route with a browser token', async () => {
    const { liveries } = fakeLiveries();
    const { port } = await startWeb({ liveries });
    expect(((await api(port, 'GET', '/api/state')).json() as { livery: unknown }).livery).toEqual(view);
    expect((await api(port, 'POST', '/api/liveries', {})).status).toBe(405);
    expect((await api(port, 'GET', '/api/livery')).status).toBe(405);
    expect((await api(port, 'GET', '/api/liveries/dusk')).status).toBe(405);
    expect((await api(port, 'GET', '/api/liveries/design')).status).toBe(405);
    expect((await api(port, 'POST', '/api/liveries/dusk/more', {})).status).toBe(404);
    expect((await api(port, 'GET', '/api/liveries', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'PUT', '/api/livery', { slug: 'dusk' }, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'POST', '/api/liveries/design', { brief: 'x' }, ANA_TOKEN)).status).toBe(401);
  });

  it('has no livery in the state and answers 404 without a Livery', async () => {
    const none = await startWeb();
    expect('livery' in ((await api(none.port, 'GET', '/api/state')).json() as object)).toBe(false);
    expect((await api(none.port, 'GET', '/api/liveries')).status).toBe(404);
    expect((await api(none.port, 'PUT', '/api/livery', { slug: 'dusk' })).status).toBe(404);
    expect((await api(none.port, 'POST', '/api/liveries/design', { brief: 'x' })).status).toBe(404);
  });

  it('Pad Check: GET /api/engines answers the engines, wants the browser token, allows only GET, and is 404 without it', async () => {
    const checks = [{ provider: 'claude', label: 'Claude Code', bin: 'claude', path: '/bin/claude', version: '2.1.325', install: 'curl x | bash', docs: 'https://a.example' }];
    const { port } = await startWeb({ engines: async () => checks as never });
    const res = await api(port, 'GET', '/api/engines');
    expect([res.status, res.json()]).toEqual([200, checks]);
    expect((await api(port, 'GET', '/api/engines', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await send(port, { path: '/api/engines' })).status).toBe(401);
    expect((await api(port, 'POST', '/api/engines', {})).status).toBe(405);
    expect((await api(port, 'GET', '/api/engines/claude')).status).toBe(404);
    expect((await api((await startWeb()).port, 'GET', '/api/engines')).status).toBe(404);
  });

  it('Rollout: the state carries the view when there is one, and nothing when there is not', async () => {
    const view = { enabled: true, current: '0.1.1', latest: '0.2.0', checkedAt: 5, newer: true, command: 'pnpm add -g @ulm0/gonogo@latest' };
    const { port } = await startWeb({ rollout: { view: () => view } });
    expect(((await api(port, 'GET', '/api/state')).json() as { rollout: unknown }).rollout).toEqual(view);
    expect('rollout' in ((await api((await startWeb()).port, 'GET', '/api/state')).json() as object)).toBe(false);
  });

  it('gives the agents livery_submit, and the author is the agent of the token', async () => {
    const { calls, liveries } = fakeLiveries();
    const { port } = await startWeb({ liveries });
    const ana = await connectMcp(port, ANA_TOKEN);
    const sent = toolOutcome(await ana.callTool({ name: 'livery_submit', arguments: { name: 'Dusk', description: 'Blue.', tokens: { '--body': '#112233' } } }));
    expect(sent).toMatchObject({ isError: false, json: { ok: true, slug: 'dusk' } });
    expect(sent.text).not.toContain('#112233');
    expect(calls).toEqual([['submit', 'ana', { name: 'Dusk', description: 'Blue.', tokens: { '--body': '#112233' } }]]);
  });

  it('tells an agent what to fix, and refuses a bad argument without calling the store', async () => {
    const { calls, liveries } = fakeLiveries();
    const { port } = await startWeb({ liveries });
    const ben = await connectMcp(port, BEN_TOKEN);
    expect(toolOutcome(await ben.callTool({ name: 'livery_submit', arguments: { name: 'bad', tokens: {} } }))).toMatchObject({
      isError: true,
      text: '{"ok":false,"error":"--muted on --body is 3.00:1, it needs 4.5:1"}',
    });
    for (const args of [{ name: '', tokens: {} }, { name: 'x'.repeat(41), tokens: {} }, { name: 'x' }, { tokens: {} }, { name: 'x', tokens: { '--body': 5 } }, { name: 'x', tokens: 'red' }, { name: 'x', description: 'y'.repeat(201), tokens: {} }]) {
      const out = await ben.callTool({ name: 'livery_submit', arguments: args }).catch(() => ({ isError: true }));
      expect((out as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it('says Livery is not available when the server has none', async () => {
    const { port } = await startWeb();
    const ana = await connectMcp(port, ANA_TOKEN);
    expect(toolOutcome(await ana.callTool({ name: 'livery_submit', arguments: { name: 'x', tokens: {} } }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"Livery is not available"}' });
  });
});

describe('relief', () => {
  const request = { id: 'h1', by: 'flight', at: 5, expiresAt: 9, name: 'guido-1', position: 'guido', role: 'r', dir: '/work', provider: 'claude', mode: 'acceptEdits', cleanRoom: null } as const;
  const view = { requests: [request] };
  /** A Relief that records what the routes and the tool ask of it. */
  function fakeRelief(): { calls: unknown[][]; relief: NonNullable<WebOptions['relief']> } {
    const calls: unknown[][] = [];
    return {
      calls,
      relief: {
        view: () => view,
        request: async (by, input) => {
          calls.push(['request', by, input]);
          if ((input as { name?: unknown }).name === 'full') throw new FakeHubError('conflict', 'the operations room is full (24 agents)');
          return { id: 'h1', status: 'pending', note: 'waiting for the Director' };
        },
        decide: async (id, verdict, by) => {
          calls.push(['decide', id, verdict, by]);
          if (id === 'h9') throw new FakeHubError('not_found', 'no such hire request: it may have expired or been answered');
          return { requests: [] };
        },
      },
    };
  }

  it('lists the requests, and answers GO and NO-GO as the Director', async () => {
    const { calls, relief } = fakeRelief();
    const { port } = await startWeb({ relief });
    expect((await api(port, 'GET', '/api/relief')).json()).toEqual(view);
    expect((await api(port, 'POST', '/api/relief/h1/go')).json()).toEqual({ requests: [] });
    expect((await api(port, 'POST', '/api/relief/h1/no-go')).json()).toEqual({ requests: [] });
    expect((await api(port, 'POST', '/api/relief/h9/go')).json()).toEqual({ error: 'no such hire request: it may have expired or been answered', code: 'not_found' });
    expect(calls).toEqual([['decide', 'h1', 'go', { kind: 'user' }], ['decide', 'h1', 'no-go', { kind: 'user' }], ['decide', 'h9', 'go', { kind: 'user' }]]);
  });

  it('puts the requests in the state, and allows only the methods of each route', async () => {
    const { relief } = fakeRelief();
    const { port } = await startWeb({ relief });
    expect(((await api(port, 'GET', '/api/state')).json() as { relief: unknown }).relief).toEqual(view);
    expect((await api(port, 'POST', '/api/relief', {})).status).toBe(405);
    expect((await api(port, 'GET', '/api/relief/h1/go')).status).toBe(405);
    expect((await api(port, 'PUT', '/api/relief/h1/no-go', {})).status).toBe(405);
    expect((await api(port, 'POST', '/api/relief/h1/maybe')).status).toBe(404);
    expect((await api(port, 'POST', '/api/relief/h1')).status).toBe(404);
    expect((await api(port, 'POST', '/api/relief/h1/go/x')).status).toBe(404);
  });

  it('an agent token cannot answer, or even list: the boss cannot approve its own request', async () => {
    const { calls, relief } = fakeRelief();
    const { port } = await startWeb({ relief });
    for (const token of [ANA_TOKEN, BEN_TOKEN, 'nope']) {
      expect((await api(port, 'POST', '/api/relief/h1/go', undefined, token)).status, token).toBe(401);
      expect((await api(port, 'POST', '/api/relief/h1/no-go', undefined, token)).status, token).toBe(401);
      expect((await api(port, 'GET', '/api/relief', undefined, token)).status, token).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('has no requests in the state and answers 404 without a Relief', async () => {
    const none = await startWeb();
    expect('relief' in ((await api(none.port, 'GET', '/api/state')).json() as object)).toBe(false);
    expect((await api(none.port, 'GET', '/api/relief')).status).toBe(404);
    expect((await api(none.port, 'POST', '/api/relief/h1/go')).status).toBe(404);
  });

  it('gives the agents hire_agent, and the requester is the agent of the token', async () => {
    const { calls, relief } = fakeRelief();
    const { port } = await startWeb({ relief });
    const ana = await connectMcp(port, ANA_TOKEN);
    const sent = toolOutcome(await ana.callTool({ name: 'hire_agent', arguments: { name: 'guido-1', position: 'guido', dir: '/work', engine: 'claude', mode: 'acceptEdits' } }));
    expect(sent).toMatchObject({ isError: false, json: { ok: true, id: 'h1', status: 'pending' } });
    expect(calls).toEqual([['request', { agent: 'ana', generation: 3 }, { name: 'guido-1', position: 'guido', dir: '/work', engine: 'claude', mode: 'acceptEdits' }]]);
  });

  it('tells the agent why when the request is refused', async () => {
    const { relief } = fakeRelief();
    const { port } = await startWeb({ relief });
    const ana = await connectMcp(port, ANA_TOKEN);
    expect(toolOutcome(await ana.callTool({ name: 'hire_agent', arguments: { name: 'full', role: 'r', dir: '/work' } }))).toMatchObject({
      isError: true,
      text: '{"ok":false,"error":"the operations room is full (24 agents)"}',
    });
  });

  it('refuses a field the tool does not have, and a bad shape, before Relief is asked', async () => {
    const { calls, relief } = fakeRelief();
    const { port } = await startWeb({ relief });
    const ana = await connectMcp(port, ANA_TOKEN);
    const bad = [
      { name: 'x', role: 'r', dir: '/work', confirmBypass: true },
      { name: 'x', role: 'r', dir: '/work', command: 'sh' },
      { name: 'x', role: 'r', dir: '/work', payload: {} },
      { name: 'x', role: 'r', dir: '/work', cleanRoom: {} },
      { name: 'x', role: 'r', dir: '/work', provider: 'custom' },
      { name: '', role: 'r' },
      { name: 'x'.repeat(33), role: 'r' },
      { role: 'r' },
      { name: 'x', role: 'r'.repeat(4001) },
      { name: 'x', dir: 'd'.repeat(1025) },
      { name: 'x', mode: 5 },
    ];
    for (const args of bad) {
      const out = await ana.callTool({ name: 'hire_agent', arguments: args }).catch(() => ({ isError: true }));
      expect((out as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('says Relief is not available when the server has none', async () => {
    const { port } = await startWeb();
    const ana = await connectMcp(port, ANA_TOKEN);
    expect(toolOutcome(await ana.callTool({ name: 'hire_agent', arguments: { name: 'x', role: 'r', dir: '/work' } }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"Relief is not available"}' });
  });
});

describe('downlink', () => {
  const view = {
    unread: 1,
    items: [
      { type: 'event', id: 'e1', at: 5, kind: 'redline', text: 'ana: loop', read: false, archived: false },
      { type: 'message', id: 'm1', at: 3, from: 'ana', subject: 's', body: 'b', truncated: false, inReplyTo: null, read: true, archived: false },
    ],
  };
  /** A downlink that records what the routes ask of it. */
  function fakeDownlink(): { calls: unknown[][]; downlink: NonNullable<WebOptions['downlink']> } {
    const calls: unknown[][] = [];
    const run = (name: string) => async (input: unknown): Promise<never> => {
      calls.push([name, input]);
      if (!Array.isArray((input as { ids?: unknown }).ids) || (input as { ids: unknown[] }).ids.length === 0) throw new FakeHubError('bad_request', 'ids must be a list of 1 to 200 item ids', 'ids');
      return { ...view, unread: 0 } as never;
    };
    return {
      calls,
      downlink: {
        view: () => view as never,
        read: run('read'),
        archive: run('archive'),
        readAll: async () => {
          calls.push(['read-all']);
          return { ...view, unread: 0 } as never;
        },
      },
    };
  }

  it('lists the inbox, marks read, archives and marks all read', async () => {
    const { calls, downlink } = fakeDownlink();
    const { port } = await startWeb({ downlink });
    expect((await api(port, 'GET', '/api/downlink')).json()).toEqual(view);
    for (const action of ['read', 'archive'] as const) {
      const out = await api(port, 'POST', `/api/downlink/${action}`, { ids: ['m1', 'e1'] });
      expect([out.status, (out.json() as { unread: number }).unread], action).toEqual([200, 0]);
    }
    const all = await api(port, 'POST', '/api/downlink/read-all');
    expect([all.status, (all.json() as { unread: number }).unread]).toEqual([200, 0]);
    expect((await api(port, 'POST', '/api/downlink/read', { ids: [] })).json()).toEqual({ error: 'ids must be a list of 1 to 200 item ids', code: 'bad_request', field: 'ids' });
    expect((await api(port, 'POST', '/api/downlink/archive', [1])).status).toBe(400);
    expect(calls).toEqual([['read', { ids: ['m1', 'e1'] }], ['archive', { ids: ['m1', 'e1'] }], ['read-all'], ['read', { ids: [] }]]);
  });

  it('allows only the methods of each route, and wants a browser token', async () => {
    const { downlink } = fakeDownlink();
    const { port } = await startWeb({ downlink });
    expect((await api(port, 'POST', '/api/downlink')).status).toBe(405);
    expect((await api(port, 'GET', '/api/downlink/read')).status).toBe(405);
    expect((await api(port, 'GET', '/api/downlink/archive')).status).toBe(405);
    expect((await api(port, 'GET', '/api/downlink/read-all')).status).toBe(405);
    expect((await api(port, 'POST', '/api/downlink/delete', { ids: ['m1'] })).status).toBe(404);
    expect((await api(port, 'GET', '/api/downlink/read/more')).status).toBe(404);
    expect((await api(port, 'GET', '/api/downlink', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'POST', '/api/downlink/read', { ids: ['m1'] }, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'POST', '/api/downlink/read-all', undefined, ANA_TOKEN)).status).toBe(401);
  });

  it('shows the inbox in the first state frame, and is 404 without a downlink', async () => {
    const { downlink } = fakeDownlink();
    const { port } = await startWeb({ downlink });
    expect((await openWs(port)).frames[0]).toMatchObject({ t: 'state', state: { downlink: view } });
    const none = await startWeb();
    expect((await api(none.port, 'GET', '/api/downlink')).status).toBe(404);
    expect((await api(none.port, 'POST', '/api/downlink/read-all')).status).toBe(404);
  });
});

describe('mcp', () => {
  it('offers exactly the ten tools, with the contract schemas and descriptions', async () => {
    const { port } = await startWeb();
    const client = await connectMcp(port);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    const send_message = tools.find((t) => t.name === 'send_message');
    expect(Object.keys(send_message?.inputSchema.properties ?? {}).sort()).toEqual(['body', 'in_reply_to', 'subject', 'to']);
    expect([...(send_message?.inputSchema.required ?? [])].sort()).toEqual(['body', 'to']);
    expect(send_message?.description).toContain('Send a message to another agent');
    for (const name of ['list_roster', 'read_messages']) {
      const tool = tools.find((t) => t.name === name);
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([]);
    }
    const go = tools.find((t) => t.name === 'go_nogo');
    expect(Object.keys(go?.inputSchema.properties ?? {}).sort()).toEqual(['reason', 'vote']);
    expect([...(go?.inputSchema.required ?? [])].sort()).toEqual(['vote']);
    expect(go?.inputSchema.properties?.vote).toMatchObject({ enum: ['go', 'no-go'] });
    expect(go?.inputSchema.properties?.reason).toMatchObject({ maxLength: POLL_REASON_MAX_CHARS });
    expect(go?.description).toBe(MCP_DESCRIPTIONS.go_nogo);
    const list = tools.find((t) => t.name === 'task_list');
    expect(Object.keys(list?.inputSchema.properties ?? {}).sort()).toEqual(['mine', 'status']);
    expect(list?.inputSchema.required ?? []).toEqual([]);
    expect(list?.inputSchema.properties?.status).toMatchObject({ enum: ['todo', 'doing', 'review', 'done', 'blocked'] });
    const create = tools.find((t) => t.name === 'task_create');
    expect(Object.keys(create?.inputSchema.properties ?? {}).sort()).toEqual(['assignee', 'detail', 'missionId', 'title']);
    expect([...(create?.inputSchema.required ?? [])]).toEqual(['title']);
    expect(create?.inputSchema.properties?.title).toMatchObject({ maxLength: 200 });
    expect(create?.inputSchema.properties?.detail).toMatchObject({ maxLength: 4000 });
    const update = tools.find((t) => t.name === 'task_update');
    expect(Object.keys(update?.inputSchema.properties ?? {}).sort()).toEqual(['assignee', 'id', 'missionId', 'note', 'status']);
    expect([...(update?.inputSchema.required ?? [])]).toEqual(['id']);
    for (const name of ['task_list', 'task_create', 'task_update'] as const) expect(tools.find((t) => t.name === name)?.description).toBe(MCP_DESCRIPTIONS[name]);
    const write = tools.find((t) => t.name === 'log_write');
    expect(Object.keys(write?.inputSchema.properties ?? {}).sort()).toEqual(['body', 'id', 'tags', 'title']);
    expect(write?.inputSchema.required ?? []).toEqual([]);
    expect(write?.inputSchema.properties?.body).toMatchObject({ maxLength: 20_000 });
    const search = tools.find((t) => t.name === 'log_search');
    expect(Object.keys(search?.inputSchema.properties ?? {}).sort()).toEqual(['limit', 'query']);
    expect([...(search?.inputSchema.required ?? [])]).toEqual(['query']);
    expect(search?.inputSchema.properties?.limit).toMatchObject({ maximum: 20 });
    const read = tools.find((t) => t.name === 'log_read');
    expect([...(read?.inputSchema.required ?? [])]).toEqual(['id']);
    for (const name of ['log_write', 'log_search', 'log_read'] as const) expect(tools.find((t) => t.name === name)?.description).toBe(MCP_DESCRIPTIONS[name]);
    const livery = tools.find((t) => t.name === 'livery_submit');
    expect(Object.keys(livery?.inputSchema.properties ?? {}).sort()).toEqual(['description', 'name', 'tokens']);
    expect([...(livery?.inputSchema.required ?? [])].sort()).toEqual(['name', 'tokens']);
    expect(livery?.inputSchema.properties?.name).toMatchObject({ maxLength: 40 });
    expect(livery?.description).toBe(MCP_DESCRIPTIONS.livery_submit);
  });

  it('go_nogo stamps agent and generation from the token and returns the VoteResult', async () => {
    const seen: unknown[][] = [];
    const vote: Hub['vote'] = (agent, generation, v, reason) => {
      seen.push([agent, generation, v, reason]);
      return agent === 'ana' ? { ok: false, note: 'no poll is open' } : { ok: true, note: 'vote recorded' };
    };
    const { port } = await startWeb({}, { vote });
    const ana = await connectMcp(port, ANA_TOKEN);
    const ben = await connectMcp(port, BEN_TOKEN);
    const no = toolOutcome(await ana.callTool({ name: 'go_nogo', arguments: { vote: 'no-go', reason: 'sim failed', agent: 'flight', generation: 9 } }));
    expect(no).toMatchObject({ isError: true, json: { ok: false, note: 'no poll is open' } });
    const yes = toolOutcome(await ben.callTool({ name: 'go_nogo', arguments: { vote: 'go', reason: '' } }));
    expect(yes).toMatchObject({ isError: false, json: { ok: true, note: 'vote recorded' } });
    expect(seen).toEqual([['ana', 3, 'no-go', 'sim failed'], ['ben', 1, 'go', '']]);
  });

  it('go_nogo refuses a vote that is not go or no-go and a reason that is too long, without calling the hub', async () => {
    const { port, hubCalls } = await startWeb();
    const client = await connectMcp(port);
    for (const args of [{ vote: 'maybe', reason: 'x' }, { reason: 'x' }, { vote: 'go', reason: 'x'.repeat(POLL_REASON_MAX_CHARS + 1) }]) {
      const out = await client.callTool({ name: 'go_nogo', arguments: args }).catch(() => ({ isError: true }));
      expect(out.isError).toBe(true);
    }
    expect(hubCalls.filter((c) => c.fn === 'vote')).toEqual([]);
    const edge = toolOutcome(await client.callTool({ name: 'go_nogo', arguments: { vote: 'go', reason: 'x'.repeat(POLL_REASON_MAX_CHARS) } }));
    expect(edge.isError).toBe(false);
  });

  it('go_nogo takes a vote without a reason and passes an empty one to the hub', async () => {
    const { port, hubCalls } = await startWeb();
    const client = await connectMcp(port);
    const out = toolOutcome(await client.callTool({ name: 'go_nogo', arguments: { vote: 'go' } }));
    expect(out.isError).toBe(false);
    expect(hubCalls.filter((c) => c.fn === 'vote')).toHaveLength(1);
    expect(hubCalls.find((c) => c.fn === 'vote')?.args.slice(2)).toEqual(['go', '']);
  });

  it('go_nogo reports a stale generation from the hub as an error with its text', async () => {
    const { port } = await startWeb({}, { vote: () => { throw new FakeHubError('conflict', 'this session has ended'); } });
    const client = await connectMcp(port);
    const out = toolOutcome(await client.callTool({ name: 'go_nogo', arguments: { vote: 'go', reason: 'r' } }));
    expect(out).toMatchObject({ isError: true, json: { ok: false, error: 'this session has ended' } });
  });

  it('stamps from and generation from the token, whatever the arguments say', async () => {
    const { port, hubCalls } = await startWeb();
    const ana = await connectMcp(port, ANA_TOKEN);
    const ben = await connectMcp(port, BEN_TOKEN);
    await ana.callTool({ name: 'send_message', arguments: { to: 'ben', subject: 'hi', body: 'x', from: 'flight', agent: 'flight', generation: 99 } });
    await ben.callTool({ name: 'send_message', arguments: { to: 'ana', subject: 'yo', body: 'y', from: 'ana' } });
    expect(hubCalls.filter((c) => c.fn === 'sendFromAgent').map((c) => c.args)).toEqual([
      ['ana', 3, { to: 'ben', subject: 'hi', body: 'x' }],
      ['ben', 1, { to: 'ana', subject: 'yo', body: 'y' }],
    ]);
  });

  it('maps in_reply_to to inReplyTo and a missing subject to an empty one', async () => {
    const { port, hubCalls } = await startWeb();
    const client = await connectMcp(port);
    await client.callTool({ name: 'send_message', arguments: { to: 'ben', body: 'b' } });
    await client.callTool({ name: 'send_message', arguments: { to: 'ben', subject: 's', body: 'b', in_reply_to: 'm5' } });
    const requests = hubCalls.filter((c) => c.fn === 'sendFromAgent').map((c) => c.args[2]);
    expect(requests[0]).toStrictEqual({ to: 'ben', subject: '', body: 'b' });
    expect(requests[1]).toStrictEqual({ to: 'ben', subject: 's', body: 'b', inReplyTo: 'm5' });
  });

  it('reports a queued message as {"ok":true,...}', async () => {
    const { port } = await startWeb();
    const client = await connectMcp(port);
    const out = toolOutcome(await client.callTool({ name: 'send_message', arguments: { to: 'ben', body: 'b' } }));
    expect(out.isError).toBe(false);
    expect(out.text).toBe('{"ok":true,"id":"m12","to":"ben","status":"queued","note":"waiting: ben is working"}');
  });

  it('reports a message to the user with a null note', async () => {
    const { port } = await startWeb({}, { sendFromAgent: () => ({ ok: true, id: 'm13', to: 'user', status: 'to_user', note: null }) });
    const client = await connectMcp(port);
    const out = toolOutcome(await client.callTool({ name: 'send_message', arguments: { to: 'user', body: 'b' } }));
    expect(out).toMatchObject({ isError: false, text: '{"ok":true,"id":"m13","to":"user","status":"to_user","note":null}' });
  });

  it('reports an undelivered message as an error that says where it went', async () => {
    const { port } = await startWeb(
      {},
      { sendFromAgent: () => ({ ok: false, id: 'm14', to: 'ben', status: 'undelivered', note: 'ben is stopped; the message went to the user' }) },
    );
    const client = await connectMcp(port);
    const out = toolOutcome(await client.callTool({ name: 'send_message', arguments: { to: 'ben', body: 'b' } }));
    expect(out.isError).toBe(true);
    expect(out.text).toBe('{"ok":false,"id":"m14","to":"ben","status":"undelivered","note":"ben is stopped; the message went to the user"}');
  });

  it('reports a HubError as an error with its message, for each tool', async () => {
    const boom = (): never => {
      throw new FakeHubError('conflict', 'this session has ended');
    };
    const { port } = await startWeb({}, { sendFromAgent: boom, readMessages: boom, rosterFor: boom, vote: boom });
    const client = await connectMcp(port);
    for (const [name, args] of [
      ['send_message', { to: 'ben', body: 'b' }],
      ['read_messages', {}],
      ['list_roster', {}],
      ['go_nogo', { vote: 'go', reason: 'r' }],
    ] as const) {
      const out = toolOutcome(await client.callTool({ name, arguments: args }));
      expect(out.isError).toBe(true);
      expect(out.text).toBe('{"ok":false,"error":"this session has ended"}');
    }
  });

  it('reports an unknown recipient with the hub text', async () => {
    const text = 'unknown recipient "x". Known: flight, ana, ben, boss, user';
    const { port } = await startWeb({}, { sendFromAgent: () => { throw new FakeHubError('not_found', text, 'to'); } });
    const client = await connectMcp(port);
    const out = toolOutcome(await client.callTool({ name: 'send_message', arguments: { to: 'x', body: 'b' } }));
    expect(out).toMatchObject({ isError: true, json: { ok: false, error: text } });
  });

  it('hides the text of a bug in the hub, logs it, and the next call works', async () => {
    const { log, lines } = collectingLog();
    let first = true;
    const { port } = await startWeb({ log }, {
      readMessages: () => {
        if (first) {
          first = false;
          throw new Error('secret internals');
        }
        return { count: 0, messages: [] };
      },
    });
    const client = await connectMcp(port);
    const bad = toolOutcome(await client.callTool({ name: 'read_messages', arguments: {} }));
    expect(bad).toMatchObject({ isError: true, text: '{"ok":false,"error":"internal error"}' });
    expect(lines.some((l) => l.includes('secret internals'))).toBe(true);
    const good = toolOutcome(await client.callTool({ name: 'read_messages', arguments: {} }));
    expect(good).toMatchObject({ isError: false, json: { count: 0, messages: [] } });
  });

  it.each([
    ['an empty body', { to: 'ben', body: '' }],
    ['no recipient', { body: 'b' }],
    ['a recipient over 64 characters', { to: 'x'.repeat(65), body: 'b' }],
    ['a subject over 200 characters', { to: 'ben', subject: 's'.repeat(201), body: 'b' }],
    ['a body over 20000 characters', { to: 'ben', body: 'b'.repeat(20001) }],
    ['an in_reply_to over 40 characters', { to: 'ben', body: 'b', in_reply_to: 'm'.repeat(41) }],
    ['a number for the body', { to: 'ben', body: 5 }],
  ])('refuses %s before it reaches the hub', async (_what, args) => {
    const { port, hubCalls } = await startWeb();
    const client = await connectMcp(port);
    const outcome = await client.callTool({ name: 'send_message', arguments: args }).then(
      (r) => toolOutcome(r).isError,
      () => true,
    );
    expect(outcome).toBe(true);
    expect(hubCalls.filter((c) => c.fn === 'sendFromAgent')).toEqual([]);
  });

  it('returns the roster and the messages as JSON text, with the caller identity', async () => {
    const messages = { count: 1, messages: [{ id: 'm1', from: 'user', subject: 's', body: 'hello', inReplyTo: null, at: 5 }] };
    const readCalls: unknown[][] = [];
    const { port, hubCalls } = await startWeb({}, { readMessages: (agent, generation) => (readCalls.push([agent, generation]), messages) });
    const client = await connectMcp(port, BEN_TOKEN);
    expect(toolOutcome(await client.callTool({ name: 'read_messages', arguments: {} })).json).toEqual(messages);
    const roster = toolOutcome(await client.callTool({ name: 'list_roster', arguments: {} }));
    expect(roster.isError).toBe(false);
    expect(roster.json).toEqual({ you: 'ben', boss: 'flight', agents: [{ name: 'flight', role: 'boss', state: 'idle', boss: true, position: 'flight' }], specialRecipients: ['boss', 'user'] });
    expect(readCalls).toEqual([['ben', 1]]);
    expect(hubCalls.filter((c) => c.fn === 'rosterFor').map((c) => c.args)).toEqual([['ben', 1]]);
  });

  it('serves many clients that connect at the same moment (O13)', async () => {
    const { port } = await startWeb({}, { rosterFor: (agent) => ({ you: agent, boss: 'flight', agents: [], specialRecipients: ['boss', 'user'] }) });
    const clients = await Promise.all(Array.from({ length: 12 }, (_, i) => connectMcp(port, i % 2 === 0 ? ANA_TOKEN : BEN_TOKEN)));
    const results = await Promise.all(clients.flatMap((client) => [1, 2, 3, 4, 5].map(() => client.callTool({ name: 'list_roster', arguments: {} }))));
    expect(results).toHaveLength(60);
    for (const [i, result] of results.entries()) {
      expect(toolOutcome(result).json).toMatchObject({ you: Math.floor(i / 5) % 2 === 0 ? 'ana' : 'ben' });
    }
  });

  it('serves concurrent calls from several agents, each with its own identity (O13)', async () => {
    const { port } = await startWeb({}, {
      sendFromAgent: (from, generation, req) => ({ ok: true, id: `m-${from}-${generation}`, to: req.to, status: 'queued', note: req.body }),
    });
    const ana = await connectMcp(port, ANA_TOKEN);
    const ben = await connectMcp(port, BEN_TOKEN);
    const calls = Array.from({ length: 40 }, (_, i) => {
      const client = i % 2 === 0 ? ana : ben;
      return client.callTool({ name: 'send_message', arguments: { to: 'flight', body: `call ${i}` } }).then((r) => ({ i, out: toolOutcome(r) }));
    });
    for (const { i, out } of await Promise.all(calls)) {
      expect(out.json).toEqual({ ok: true, id: i % 2 === 0 ? 'm-ana-3' : 'm-ben-1', to: 'flight', status: 'queued', note: `call ${i}` });
    }
  });

  it('answers every MCP request with Cache-Control: no-store and the standing headers, the SDK stream and the 202 included', async () => {
    const { port } = await startWeb();
    const list = await postMcp(port, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(list.status).toBe(200);
    expect(list.headers['content-type']).toBe('text/event-stream');
    const notification = await postMcp(port, { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(notification.status).toBe(202);
    for (const res of [list, notification]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('answers GET and DELETE with 405 and the JSON-RPC body, after the token check', async () => {
    const { port } = await startWeb();
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      const res = await send(port, { method, path: '/mcp', headers: bearer(ANA_TOKEN) });
      expect(res.status).toBe(405);
      expect(res.body).toBe(RPC_NOT_ALLOWED);
      expect(res.headers.allow).toBe('POST');
    }
    expect((await send(port, { method: 'GET', path: '/mcp' })).status).toBe(401);
    expect((await send(port, { method: 'DELETE', path: '/mcp', headers: bearer(TOKEN) })).status).toBe(401);
  });

  it('answers 401 without an agent token, and for the browser token', async () => {
    const { port } = await startWeb();
    for (const token of [null, 'f'.repeat(64), 'é'.repeat(64), TOKEN]) {
      const res = await postMcp(port, { token });
      expect(res.status).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized', code: 'unauthorized' });
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
    await expectStillServing(port);
  });

  it('refuses any Origin header', async () => {
    const { port } = await startWeb();
    for (const origin of [`http://127.0.0.1:${port}`, 'null', 'https://evil.example']) {
      const res = await postMcp(port, { headers: { Origin: origin } });
      expect(res.status).toBe(403);
      expect(res.body).toBe('forbidden origin');
    }
  });

  it('answers 400 for a body that is not JSON and 413 for one over the limit, then keeps serving', async () => {
    const { port } = await startWeb();
    const bad = await postMcp(port, { body: '{' });
    expect(bad.status).toBe(400);
    expect(bad.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 }, id: null });
    const big = await postMcp(port, { body: Buffer.alloc(1024 * 1024 + 1, 0x20), agent: keepAliveAgent() });
    expect(big.status).toBe(413);
    expect(big.json()).toMatchObject({ jsonrpc: '2.0', id: null });
    const client = await connectMcp(port);
    expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);
  });

  it('survives clients that reset the connection while a tool call is being answered', async () => {
    const { port, hubCalls } = await startWeb();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'ben', body: 'x'.repeat(5000) } } });
    for (let i = 0; i < 40; i += 1) {
      await new Promise<void>((resolve) => {
        const socket = netConnect({ host: '127.0.0.1', port }, () => {
          socket.write(
            `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${ANA_TOKEN}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
          setTimeout(() => socket.resetAndDestroy(), i % 4);
        });
        socket.on('error', () => undefined);
        socket.on('close', () => resolve());
      });
    }
    await sleep(100);
    expect(hubCalls.filter((c) => c.fn === 'sendFromAgent').length).toBeGreaterThan(0);
    const client = await connectMcp(port);
    expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);
  });

  it('answers 500 when the handler itself fails, logs the stack, and serves the next request', async () => {
    const { log, lines } = collectingLog();
    let failures = 1;
    const handler = createMcpHandler({
      hub: makeHub().hub,
      resolveToken: (token) => identities.get(token) ?? null,
      log,
      version: () => {
        if (failures-- > 0) throw new Error('version exploded');
        return '1.2.3';
      },
    });
    const { createServer } = await import('node:http');
    const http = createServer((req, res) => {
      handler(req, res).catch(() => res.destroy());
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const first = await postMcp(port);
    expect(first.status).toBe(500);
    expect(first.json()).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error.' }, id: null });
    expect(lines.some((l) => l.includes('version exploded'))).toBe(true);
    const client = await connectMcp(port);
    expect(client.getServerVersion()).toMatchObject({ name: 'gonogo', version: '1.2.3' });
    expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);
  });

  it('answers 500 through the web server when resolving the token throws, and keeps serving', async () => {
    const { port } = await startWeb({
      resolveToken: (token) => {
        if (token === 'e'.repeat(64)) throw new Error('registry broke');
        return identities.get(token) ?? null;
      },
    });
    const res = await postMcp(port, { token: 'e'.repeat(64) });
    expect(res.status).toBe(500);
    expect(res.json()).toEqual({ error: 'internal error', code: 'internal' });
    const hook = await postHook(port, '/hook/ana/Stop', { token: 'e'.repeat(64) });
    expect(hook.status).toBe(500);
    const client = await connectMcp(port);
    expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);
  });
});

/* ================================================================================================================
 * web: REST
 * ============================================================================================================== */

const STATUS_OF_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported: 415,
  internal: 500,
  unavailable: 503,
  rate_limited: 429,
};

describe('web: REST', () => {
  it('serves the snapshot: agents, activity and info', async () => {
    const views = [agentView('flight'), agentView('ana', { desk: 1, state: 'working' })];
    const activity = [{ ...message('m1'), truncated: false }];
    const { port } = await startWeb({}, { views: () => views, activity: () => activity });
    const res = await api(port, 'GET', '/api/state');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.json()).toEqual({ agents: views, activity, info: INFO, poll: null, governor: { limit: null, working: 1, holding: 0 }, propellant: NO_PROPELLANT_VIEW, schedules: [], uplinks: [], tasks: [], missions: [], downlink: { unread: 0, items: [] } });
  });

  it('puts the current poll and governor in the snapshot', async () => {
    const poll = pollView({ status: 'hold' });
    const governor = { limit: 3, working: 2, holding: 1 };
    const { port } = await startWeb({}, { poll: () => poll, governor: () => governor });
    expect(((await api(port, 'GET', '/api/state')).json() as StateSnapshot)).toMatchObject({ poll, governor });
  });

  describe('hire', () => {
    it('answers 201 with the agent and hands the hub only the fields it knows', async () => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'POST', '/api/agents', { name: 'zed', role: 'tester', dir: '/work', mode: 'bypassPermissions', confirmBypass: true, bogus: 1 });
      expect(res.status).toBe(201);
      expect(res.json()).toMatchObject({ name: 'zed', state: 'starting' });
      expect(hubCalls.filter((c) => c.fn === 'hire').map((c) => c.args[0])).toStrictEqual([
        { name: 'zed', role: 'tester', dir: '/work', mode: 'bypassPermissions', confirmBypass: true },
      ]);
    });

    it('passes position, provider and command to the hub', async () => {
      const { port, hubCalls } = await startWeb();
      const base = { name: 'zed', role: 'tester', dir: '/work', mode: 'default' };
      await api(port, 'POST', '/api/agents', { ...base, position: 'guido', provider: 'claude' });
      await api(port, 'POST', '/api/agents', { ...base, provider: 'custom', command: '["node","a.js"]' });
      await api(port, 'POST', '/api/agents', { ...base, provider: 'gemini' });
      expect(hubCalls.filter((c) => c.fn === 'hire').map((c) => c.args[0])).toStrictEqual([
        { ...base, position: 'guido', provider: 'claude' },
        { ...base, provider: 'custom', command: '["node","a.js"]' },
        { ...base, provider: 'gemini' },
      ]);
    });

    it.each([
      ['a name that is not a string', { name: 5, role: 'r', dir: '/w', mode: 'default' }, 'name'],
      ['a missing role', { name: 'a', dir: '/w', mode: 'default' }, 'role'],
      ['a dir that is not a string', { name: 'a', role: 'r', dir: ['/w'], mode: 'default' }, 'dir'],
      ['a mode that does not exist', { name: 'a', role: 'r', dir: '/w', mode: 'yolo' }, 'mode'],
      ['a missing mode', { name: 'a', role: 'r', dir: '/w' }, 'mode'],
      ['a confirmation that is not boolean', { name: 'a', role: 'r', dir: '/w', mode: 'default', confirmBypass: 'yes' }, 'confirmBypass'],
      ['a position that is not a string', { name: 'a', role: 'r', dir: '/w', mode: 'default', position: 4 }, 'position'],
      ['a null position', { name: 'a', role: 'r', dir: '/w', mode: 'default', position: null }, 'position'],
      ['a provider that does not exist', { name: 'a', role: 'r', dir: '/w', mode: 'default', provider: 'gpt' }, 'provider'],
      ['a command that is not a string', { name: 'a', role: 'r', dir: '/w', mode: 'default', provider: 'custom', command: ['htop'] }, 'command'],
      ['a command that is not a JSON array of strings', { name: 'a', role: 'r', dir: '/w', mode: 'default', provider: 'custom', command: '["sh",1]' }, 'command'],
      ['an empty JSON array command', { name: 'a', role: 'r', dir: '/w', mode: 'default', provider: 'custom', command: '[]' }, 'command'],
      ['a command that is only spaces', { name: 'a', role: 'r', dir: '/w', mode: 'default', provider: 'custom', command: '   ' }, 'command'],
      ['a command with a NUL character', { name: 'a', role: 'r', dir: '/w', mode: 'default', provider: 'custom', command: 'sh -c \u0000' }, 'command'],
    ])('answers 400 with the field for %s, and never calls the hub', async (_what, body, field) => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'POST', '/api/agents', body);
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request', field });
      expect(hubCalls.filter((c) => c.fn === 'hire')).toEqual([]);
    });

    it('turns every HubError code into its status with the ApiError shape', async () => {
      const { port } = await startWeb({}, {
        hire: async (req) => {
          throw new FakeHubError(req.role as ApiErrorCode, `message of ${req.role}`, 'name');
        },
      });
      for (const [code, status] of Object.entries(STATUS_OF_CODE)) {
        const res = await api(port, 'POST', '/api/agents', { name: 'a', role: code, dir: '/w', mode: 'default' });
        expect(res.status).toBe(status);
        expect(res.json()).toEqual({ error: `message of ${code}`, code, field: 'name' });
      }
    });

    it('answers 500 for anything that is not a HubError, logs the stack, and hides the text', async () => {
      const { log, lines } = collectingLog();
      let first = true;
      const { port } = await startWeb({ log }, {
        views: () => {
          if (first) {
            first = false;
            throw new TypeError('views exploded');
          }
          return [];
        },
      });
      const res = await api(port, 'GET', '/api/state');
      expect(res.status).toBe(500);
      expect(res.json()).toEqual({ error: 'internal error', code: 'internal' });
      expect(lines.some((l) => l.includes('error') && l.includes('views exploded'))).toBe(true);
      expect((await api(port, 'GET', '/api/state')).status).toBe(200);
    });

    it('does not take an error that only looks like a HubError for one', async () => {
      class Fake extends Error {
        readonly code = 'teapot';
        constructor() {
          super('i am a teapot');
          this.name = 'HubError';
        }
      }
      const { port } = await startWeb({}, { hire: async () => { throw new Fake(); } });
      const res = await api(port, 'POST', '/api/agents', { name: 'a', role: 'r', dir: '/w', mode: 'default' });
      expect(res.status).toBe(500);
      expect(res.json()).toEqual({ error: 'internal error', code: 'internal' });
    });
  });

  describe('edit', () => {
    it('answers 200 and hands the hub the known fields only', async () => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'PATCH', '/api/agents/ana', { role: 'new role', mode: 'acceptEdits', bogus: true });
      expect(res.status).toBe(200);
      expect(hubCalls.filter((c) => c.fn === 'edit').map((c) => c.args)).toStrictEqual([['ana', { role: 'new role', mode: 'acceptEdits' }]]);
      const rename = await api(port, 'PATCH', '/api/agents/ana', { name: 'bob', dir: '/elsewhere', confirmBypass: false });
      expect(rename.json()).toMatchObject({ name: 'bob' });
    });

    it('passes a payload (an object, or null to remove it) to the hub as it is', async () => {
      const { port, hubCalls } = await startWeb();
      const payload = { mcpServers: { files: { command: 'npx' } }, skills: ['/skills/review'] };
      await api(port, 'PATCH', '/api/agents/ana', { payload });
      await api(port, 'PATCH', '/api/agents/ana', { payload: null });
      await api(port, 'POST', '/api/agents', { name: 'zed', role: 'r', dir: '/w', mode: 'default', payload });
      expect(hubCalls.filter((c) => c.fn === 'edit').map((c) => c.args)).toStrictEqual([['ana', { payload }], ['ana', { payload: null }]]);
      expect(hubCalls.filter((c) => c.fn === 'hire').map((c) => c.args[0])).toStrictEqual([{ name: 'zed', role: 'r', dir: '/w', mode: 'default', payload }]);
    });

    it.each([
      ['a payload that is a list', { payload: [] }],
      ['a payload that is text', { payload: 'x' }],
    ])('answers 400 with the field payload for %s, on edit and on hire', async (_what, body) => {
      const { port, hubCalls } = await startWeb();
      const edit = await api(port, 'PATCH', '/api/agents/ana', body);
      const hire = await api(port, 'POST', '/api/agents', { name: 'zed', role: 'r', dir: '/w', mode: 'default', ...body });
      for (const res of [edit, hire]) {
        expect(res.status).toBe(400);
        expect(res.json()).toMatchObject({ code: 'bad_request', field: 'payload' });
      }
      expect(hubCalls.filter((c) => c.fn === 'edit' || c.fn === 'hire')).toEqual([]);
    });

    it('answers 400 with the field the hub names for a payload it refuses', async () => {
      const { port } = await startWeb({}, { edit: async () => { throw new FakeHubError('bad_request', 'skill folder: directory does not exist: /x', 'payload.skills'); } });
      const res = await api(port, 'PATCH', '/api/agents/ana', { payload: { skills: ['/x'] } });
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request', field: 'payload.skills' });
    });

    it('passes a Clean Room setting (an object, or null to turn it off) to the hub as it is', async () => {
      const { port, hubCalls } = await startWeb();
      await api(port, 'PATCH', '/api/agents/ana', { cleanRoom: { image: 'x' } });
      await api(port, 'PATCH', '/api/agents/ana', { cleanRoom: null });
      await api(port, 'POST', '/api/agents', { name: 'zed', role: 'r', dir: '/w', mode: 'default', cleanRoom: {} });
      expect(hubCalls.filter((c) => c.fn === 'edit').map((c) => c.args)).toStrictEqual([['ana', { cleanRoom: { image: 'x' } }], ['ana', { cleanRoom: null }]]);
      expect(hubCalls.filter((c) => c.fn === 'hire').map((c) => c.args[0])).toStrictEqual([{ name: 'zed', role: 'r', dir: '/w', mode: 'default', cleanRoom: {} }]);
    });

    it.each([
      ['a list', { cleanRoom: [] }],
      ['text', { cleanRoom: 'on' }],
      ['true', { cleanRoom: true }],
    ])('answers 400 with the field cleanRoom for a Clean Room that is %s', async (_what, body) => {
      const { port, hubCalls } = await startWeb();
      const edit = await api(port, 'PATCH', '/api/agents/ana', body);
      const hire = await api(port, 'POST', '/api/agents', { name: 'zed', role: 'r', dir: '/w', mode: 'default', ...body });
      for (const res of [edit, hire]) {
        expect(res.status).toBe(400);
        expect(res.json()).toMatchObject({ code: 'bad_request', field: 'cleanRoom' });
      }
      expect(hubCalls.filter((c) => c.fn === 'edit' || c.fn === 'hire')).toEqual([]);
    });

    it('answers 400 with the field cleanRoom for a setting the hub refuses (no Docker, no repository)', async () => {
      const { port } = await startWeb({}, { edit: async () => { throw new FakeHubError('bad_request', 'Clean Room needs Docker, and "docker version" failed: nope', 'cleanRoom'); } });
      const res = await api(port, 'PATCH', '/api/agents/ana', { cleanRoom: {} });
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request', field: 'cleanRoom', error: expect.stringContaining('docker version') });
    });

    it('passes a model and keys to the hub as they are: a string or null for the model, an object of keys', async () => {
      const { port, hubCalls } = await startWeb();
      await api(port, 'PATCH', '/api/agents/ana', { model: 'sonnet', keys: { OPENAI_API_KEY: 'sk-test-1', OLD_KEY: null } });
      await api(port, 'PATCH', '/api/agents/ana', { model: null });
      await api(port, 'POST', '/api/agents', { name: 'zed', role: 'r', dir: '/w', mode: 'default', model: 'flash', keys: { GEMINI_API_KEY: 'g-1' } });
      expect(hubCalls.filter((c) => c.fn === 'edit').map((c) => c.args)).toStrictEqual([['ana', { model: 'sonnet', keys: { OPENAI_API_KEY: 'sk-test-1', OLD_KEY: null } }], ['ana', { model: null }]]);
      expect(hubCalls.filter((c) => c.fn === 'hire').map((c) => c.args[0])).toStrictEqual([{ name: 'zed', role: 'r', dir: '/w', mode: 'default', model: 'flash', keys: { GEMINI_API_KEY: 'g-1' } }]);
    });

    it.each([
      ['a model that is a number', { model: 5 }, 'model'],
      ['a model that is a list', { model: [] }, 'model'],
      ['keys that are a list', { keys: [] }, 'keys'],
      ['keys that are text', { keys: 'OPENAI_API_KEY=x' }, 'keys'],
      ['keys that are null on a hire', { keys: null }, 'keys'],
    ])('answers 400 with the field %s names for %s, on hire; the edit says the same unless it takes null', async (_what, body, field) => {
      const { port, hubCalls } = await startWeb();
      const hire = await api(port, 'POST', '/api/agents', { name: 'zed', role: 'r', dir: '/w', mode: 'default', ...body });
      expect(hire.status).toBe(400);
      expect(hire.json()).toMatchObject({ code: 'bad_request', field });
      if (field === 'keys' || !('model' in body && body.model === null)) {
        const edit = await api(port, 'PATCH', '/api/agents/ana', body);
        expect(edit.status).toBe(400);
        expect(edit.json()).toMatchObject({ code: 'bad_request', field });
      }
      expect(hubCalls.filter((c) => c.fn === 'edit' || c.fn === 'hire')).toEqual([]);
    });

    it('answers 400 with the field keys for keys the hub refuses, and the answer never holds the value', async () => {
      const secret = 'sk-test-the-secret-value';
      const { port } = await startWeb({}, { edit: async () => { throw new FakeHubError('bad_request', 'a key name uses capital letters, digits and _, starting with a letter (at most 64 characters)', 'keys'); } });
      const res = await api(port, 'PATCH', '/api/agents/ana', { keys: { [secret]: 'x', OTHER: secret } });
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request', field: 'keys' });
      expect(res.body).not.toContain(secret);
    });

    it('keys and the model need the browser token like every other route', async () => {
      const { port } = await startWeb();
      expect((await api(port, 'PATCH', '/api/agents/ana', { keys: { A_KEY: 'x' } }, ANA_TOKEN)).status).toBe(401);
      expect((await send(port, { method: 'PATCH', path: '/api/agents/ana', headers: JSON_HEADERS, body: JSON.stringify({ model: 'x' }) })).status).toBe(401);
    });

    it('passes position (a string or null to clear it) and command to the hub', async () => {
      const { port, hubCalls } = await startWeb();
      await api(port, 'PATCH', '/api/agents/ana', { position: 'fido' });
      await api(port, 'PATCH', '/api/agents/ana', { position: null, command: 'htop -d 5' });
      expect(hubCalls.filter((c) => c.fn === 'edit').map((c) => c.args)).toStrictEqual([
        ['ana', { position: 'fido' }],
        ['ana', { position: null, command: 'htop -d 5' }],
      ]);
    });

    it('leaves an empty edit to the hub, which answers 400', async () => {
      const { port } = await startWeb();
      const res = await api(port, 'PATCH', '/api/agents/ana', {});
      expect(res.status).toBe(400);
      expect(res.json()).toEqual({ error: 'nothing to change', code: 'bad_request' });
    });

    it.each([
      ['a role that is not a string', { role: 7 }, 'role'],
      ['a null name', { name: null }, 'name'],
      ['a bad mode', { mode: 'yolo' }, 'mode'],
      ['a confirmation that is not boolean', { confirmBypass: 1 }, 'confirmBypass'],
      ['a position that is a number', { position: 3 }, 'position'],
      ['a command that is null', { command: null }, 'command'],
    ])('answers 400 with the field for %s', async (_what, body, field) => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'PATCH', '/api/agents/ana', body);
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ field });
      expect(hubCalls.filter((c) => c.fn === 'edit')).toEqual([]);
    });

    it('answers 404 for a name that is not a valid agent name, without asking the hub, and 409 for a conflict', async () => {
      const { port, hubCalls } = await startWeb({}, { edit: async () => { throw new FakeHubError('conflict', 'stop the agent to rename it'); } });
      for (const name of ['Ana', 'a_b', 'a'.repeat(33), '-a', '%41na', 'ana%2Fstop']) {
        const res = await api(port, 'PATCH', `/api/agents/${name}`, { role: 'r' });
        expect(res.status).toBe(404);
        expect(res.json()).toEqual({ error: 'unknown agent', code: 'not_found' });
      }
      // bad percent-encoding is refused before the path is routed at all
      expect((await api(port, 'PATCH', '/api/agents/%E0%A4%A', { role: 'r' })).status).toBe(404);
      expect(hubCalls).toEqual([]);
      const conflict = await api(port, 'PATCH', '/api/agents/ana', { name: 'bob' });
      expect(conflict.status).toBe(409);
    });
  });

  describe('stop, restart, remove', () => {
    it('answers 200 with the view', async () => {
      const { port, hubCalls } = await startWeb();
      expect((await api(port, 'POST', '/api/agents/ana/stop')).json()).toMatchObject({ name: 'ana', state: 'stopped' });
      expect((await api(port, 'POST', '/api/agents/ben/restart')).json()).toMatchObject({ name: 'ben', state: 'starting' });
      expect(hubCalls.map((c) => [c.fn, ...c.args])).toEqual([['stop', 'ana'], ['restart', 'ben']]);
    });

    it('answers 404 for an unknown agent from the hub and for an invalid name', async () => {
      const { port, hubCalls } = await startWeb();
      for (const action of ['stop', 'restart']) {
        expect((await api(port, 'POST', `/api/agents/ghost/${action}`)).status).toBe(404);
        const invalid = await api(port, 'POST', `/api/agents/Not_A_Name/${action}`);
        expect(invalid.status).toBe(404);
        expect(invalid.json()).toEqual({ error: 'unknown agent', code: 'not_found' });
      }
      expect(hubCalls.map((c) => c.args[0])).toEqual(['ghost', 'ghost']);
    });

    it('answers 204 without a body when an agent is removed, 409 for the boss and 404 for an unknown one', async () => {
      const { port } = await startWeb();
      const done = await api(port, 'DELETE', '/api/agents/ana');
      expect(done.status).toBe(204);
      expect(done.body).toBe('');
      const boss = await api(port, 'DELETE', '/api/agents/flight');
      expect(boss.status).toBe(409);
      expect(boss.json()).toEqual({ error: 'the boss cannot be removed', code: 'conflict' });
      expect((await api(port, 'DELETE', '/api/agents/ghost')).status).toBe(404);
    });

    it('does not need a body or a content type for stop and restart, and ignores one', async () => {
      const { port } = await startWeb();
      const res = await send(port, { method: 'POST', path: '/api/agents/ana/stop', headers: { ...bearer(TOKEN), 'Content-Type': 'application/json' }, body: 'not even json' });
      expect(res.status).toBe(200);
    });
  });

  describe('resume and propellant', () => {
    it('POST /api/agents/:name/resume answers with the view, 404 and 409 from the name and the hub', async () => {
      const { port, hubCalls } = await startWeb();
      const ok = await api(port, 'POST', '/api/agents/ana/resume');
      expect(ok.status).toBe(200);
      expect(ok.json()).toMatchObject({ name: 'ana', state: 'idle' });
      expect((await api(port, 'POST', '/api/agents/ghost/resume')).status).toBe(404);
      expect((await api(port, 'POST', '/api/agents/ben/resume')).json()).toEqual({ error: 'ben has not tripped the redline', code: 'conflict' });
      expect((await api(port, 'GET', '/api/agents/ana/resume')).status).toBe(405);
      expect(hubCalls.map((c) => [c.fn, ...c.args])).toStrictEqual([['resume', 'ana'], ['resume', 'ghost'], ['resume', 'ben']]);
    });

    it('POST /api/agents/:name/hold answers with the view, 404 and 409 from the name and the hub', async () => {
      const { port, hubCalls } = await startWeb();
      const ok = await api(port, 'POST', '/api/agents/ana/hold');
      expect(ok.status).toBe(200);
      expect(ok.json()).toMatchObject({ name: 'ana', needsReason: 'on hold' });
      expect((await api(port, 'POST', '/api/agents/ghost/hold')).status).toBe(404);
      expect((await api(port, 'POST', '/api/agents/ben/hold')).json()).toEqual({ error: 'ben is already on hold', code: 'conflict' });
      expect((await api(port, 'GET', '/api/agents/ana/hold')).status).toBe(405);
      expect(hubCalls.map((c) => [c.fn, ...c.args])).toStrictEqual([['hold', 'ana'], ['hold', 'ghost'], ['hold', 'ben']]);
    });

    it('GET /api/agents/:name/telemetry lists the calls, empty without a recorder', async () => {
      const call = { at: 1, ms: 20, tool: 'Bash', summary: 'Bash: ls', failed: false };
      const { port } = await startWeb({ telemetry: { calls: (name) => (name === 'ana' ? [call] : []) } });
      expect((await api(port, 'GET', '/api/agents/ana/telemetry')).json()).toEqual({ calls: [call] });
      expect((await api(port, 'GET', '/api/agents/ben/telemetry')).json()).toEqual({ calls: [] });
      expect((await api(port, 'POST', '/api/agents/ana/telemetry')).status).toBe(405);
      const bare = await startWeb();
      expect((await api(bare.port, 'GET', '/api/agents/ana/telemetry')).json()).toEqual({ calls: [] });
    });

    it('PUT /api/propellant checks the body, saves the limits and tells every browser', async () => {
      const saved: unknown[] = [];
      const view = { room: { used: { '5h': 3, day: 3, week: 3, month: 3 }, limits: { day: 10 } }, agents: {}, cost: { room: { usd: { '5h': 0, day: 0, week: 0, month: 0 }, unpriced: { '5h': 0, day: 0, week: 0, month: 0 }, budget: {} }, agents: {}, days: [], pricedSince: null } };
      const { port } = await startWeb({
        propellant: {
          view: () => view,
          setLimits: async (request) => {
            saved.push(request);
            return view;
          },
          setBudget: async (budget) => {
            saved.push({ budget });
            return view;
          },
        },
      });
      const client = await openWs(port);
      expect(client.frames[0]).toMatchObject({ t: 'state', state: { propellant: view } });
      const res = await api(port, 'PUT', '/api/propellant', { room: { day: 10 } });
      expect(res.status).toBe(200);
      expect(res.json()).toEqual(view);
      expect(saved).toEqual([{ room: { day: 10 } }]);
      await waitFor(() => client.frames.some((f) => (f as { t?: string }).t === 'propellant'), 'a propellant frame');
      const bad = await api(port, 'PUT', '/api/propellant', { room: { day: -1 } });
      expect(bad.status).toBe(400);
      expect(bad.json()).toMatchObject({ code: 'bad_request', field: 'room' });
      expect(saved).toHaveLength(1);
    });

    it('PUT /api/propellant is 404 without a propellant', async () => {
      const { port } = await startWeb();
      expect((await api(port, 'PUT', '/api/propellant', { room: {} })).status).toBe(404);
    });

    it('PUT /api/propellant takes a budget alone without touching the limits, and refuses a bad one', async () => {
      const calls: unknown[] = [];
      const view = { room: { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: {} }, agents: {}, cost: { room: { usd: { '5h': 0, day: 0, week: 0, month: 0 }, unpriced: { '5h': 0, day: 0, week: 0, month: 0 }, budget: {} }, agents: {}, days: [], pricedSince: null } };
      const { port } = await startWeb({
        propellant: {
          view: () => view,
          setLimits: async (r) => (calls.push(['limits', r]), view),
          setBudget: async (b) => (calls.push(['budget', b]), view),
        },
      });
      expect((await api(port, 'PUT', '/api/propellant', { budget: { room: { day: 10 } } })).status).toBe(200);
      expect(calls).toEqual([['budget', { room: { day: 10 } }]]);
      const bad = await api(port, 'PUT', '/api/propellant', { budget: { room: { day: 0 } } });
      expect(bad.status).toBe(400);
      expect(bad.json()).toMatchObject({ code: 'bad_request', field: 'budget' });
      expect(calls).toHaveLength(1);
    });
  });

  describe('prices', () => {
    const price = { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 };
    const fake = (): { calls: unknown[]; prices: NonNullable<WebOptions['prices']> } => {
      const calls: unknown[] = [];
      const view = { currency: 'USD', rows: {} };
      return {
        calls,
        prices: {
          view: () => view,
          replace: async (models, currency) => (calls.push(['replace', models, currency]), view),
          remove: async (prefix) => (calls.push(['remove', prefix]), prefix === 'mine'),
        },
      };
    };

    it('GET, PUT and DELETE /api/prices, strict about the body and the prefix', async () => {
      const { calls, prices } = fake();
      const { port } = await startWeb({ prices });
      expect((await api(port, 'GET', '/api/prices')).json()).toEqual({ currency: 'USD', rows: {} });
      expect((await api(port, 'PUT', '/api/prices', { models: { mine: price } })).status).toBe(200);
      expect(calls).toEqual([['replace', { mine: price }, undefined]]);
      expect((await api(port, 'PUT', '/api/prices', { models: { mine: { ...price, input: -1 } } })).json()).toMatchObject({ code: 'bad_request', field: 'models' });
      expect((await api(port, 'PUT', '/api/prices', { models: {}, extra: 1 })).json()).toMatchObject({ field: 'extra' });
      expect((await api(port, 'DELETE', '/api/prices/mine')).status).toBe(200);
      expect((await api(port, 'DELETE', '/api/prices/other')).status).toBe(404);
      expect((await api(port, 'DELETE', '/api/prices/a%20b')).status).toBe(400);
      expect(calls).toHaveLength(3);
    });

    it('answers 404 without prices', async () => {
      const { port } = await startWeb();
      expect((await api(port, 'GET', '/api/prices')).status).toBe(404);
    });
  });

  describe('launch window', () => {
    const entry = { id: 's1', name: 'Standup', to: 'ana', subject: '', body: 'Status?', rule: '0 9 * * *', enabled: true, createdAt: 1, lastRunAt: null, lastResult: null, nextAt: 5 };
    /** A schedules that records what the routes ask of it. */
    function fakeSchedules(): { calls: unknown[][]; schedules: NonNullable<WebOptions['schedules']> } {
      const calls: unknown[][] = [];
      const known = (id: string): void => {
        if (id !== 's1') throw new FakeHubError('not_found', 'unknown schedule');
      };
      return {
        calls,
        schedules: {
          list: () => [entry],
          create: async (input) => {
            calls.push(['create', input]);
            if ((input as { name?: unknown }).name === 'bad') throw new FakeHubError('bad_request', 'name must be 1 to 60 characters on one line', 'name');
            return entry;
          },
          update: async (id, input) => {
            calls.push(['update', id, input]);
            known(id);
            return { ...entry, enabled: false };
          },
          remove: async (id) => {
            calls.push(['remove', id]);
            known(id);
          },
          run: async (id) => {
            calls.push(['run', id]);
            known(id);
            return { ...entry, lastRunAt: 9, lastResult: 'sent m1: queued' };
          },
        },
      };
    }

    it('lists, makes, edits, runs and deletes, and answers a refusal with its field', async () => {
      const { calls, schedules } = fakeSchedules();
      const { port } = await startWeb({ schedules });
      expect((await api(port, 'GET', '/api/schedules')).json()).toEqual([entry]);
      const made = await api(port, 'POST', '/api/schedules', { name: 'Standup' });
      expect([made.status, made.json()]).toEqual([201, entry]);
      expect((await api(port, 'POST', '/api/schedules', { name: 'bad' })).json()).toEqual({ error: 'name must be 1 to 60 characters on one line', code: 'bad_request', field: 'name' });
      expect((await api(port, 'POST', '/api/schedules', [1])).status).toBe(400);
      const patched = await api(port, 'PATCH', '/api/schedules/s1', { enabled: false });
      expect([patched.status, patched.json()]).toEqual([200, { ...entry, enabled: false }]);
      expect((await api(port, 'POST', '/api/schedules/s1/run')).json()).toMatchObject({ lastResult: 'sent m1: queued' });
      expect((await api(port, 'DELETE', '/api/schedules/s1')).status).toBe(204);
      for (const [method, path] of [['PATCH', '/api/schedules/s2'], ['DELETE', '/api/schedules/s2'], ['POST', '/api/schedules/s2/run']] as const) {
        expect((await api(port, method, path, method === 'PATCH' ? {} : undefined)).json()).toEqual({ error: 'unknown schedule', code: 'not_found' });
      }
      expect(calls.slice(0, 2)).toEqual([['create', { name: 'Standup' }], ['create', { name: 'bad' }]]);
      expect(calls.slice(2, 5)).toEqual([['update', 's1', { enabled: false }], ['run', 's1'], ['remove', 's1']]);
    });

    it('allows only the methods of each route, and wants a browser token', async () => {
      const { schedules } = fakeSchedules();
      const { port } = await startWeb({ schedules });
      expect((await api(port, 'PUT', '/api/schedules')).status).toBe(405);
      expect((await api(port, 'GET', '/api/schedules/s1')).status).toBe(405);
      expect((await api(port, 'GET', '/api/schedules/s1/run')).status).toBe(405);
      expect((await api(port, 'POST', '/api/schedules/s1/other')).status).toBe(404);
      expect((await api(port, 'POST', '/api/schedules/s1/run/more')).status).toBe(404);
      expect((await api(port, 'GET', '/api/schedules', undefined, ANA_TOKEN)).status).toBe(401);
    });

    it('shows the list in the first state frame, and is 404 without a schedules', async () => {
      const { schedules } = fakeSchedules();
      const { port } = await startWeb({ schedules });
      expect((await openWs(port)).frames[0]).toMatchObject({ t: 'state', state: { schedules: [entry] } });
      const none = await startWeb();
      expect((await api(none.port, 'GET', '/api/schedules')).status).toBe(404);
    });
  });

  describe('uplink', () => {
    const entry = { id: 'u1', name: 'GitHub', kind: 'generic', to: 'ana', enabled: true, createdAt: 1, deliveries: [] };
    /** An uplinks that records what the routes ask of it; `deliver` fails the way the header `x-fail` says. */
    function fakeUplinks(): { calls: unknown[][]; uplinks: NonNullable<WebOptions['uplinks']> } {
      const calls: unknown[][] = [];
      const known = (id: string): void => {
        if (id !== 'u1') throw new FakeHubError('not_found', 'unknown uplink');
      };
      return {
        calls,
        uplinks: {
          list: () => [entry] as never,
          create: async (input) => {
            calls.push(['create', input]);
            if ((input as { name?: unknown }).name === 'bad') throw new FakeHubError('bad_request', 'name must be 1 to 60 characters on one line', 'name');
            return { ...entry, secret: 'a'.repeat(64) } as never;
          },
          update: async (id, input) => {
            calls.push(['update', id, input]);
            known(id);
            return { ...entry, enabled: false } as never;
          },
          remove: async (id) => {
            calls.push(['remove', id]);
            known(id);
          },
          rotate: async (id) => {
            calls.push(['rotate', id]);
            known(id);
            return { ...entry, secret: 'b'.repeat(64) } as never;
          },
          test: async (id) => {
            calls.push(['test', id]);
            known(id);
            return { ...entry, deliveries: [{ at: 9, status: 'queued', note: 'test: m1' }] } as never;
          },
          deliver: (id, raw, headers) => {
            calls.push(['deliver', id, raw.toString('latin1'), headers['x-gonogo-signature'] ?? null]);
            const fail = headers['x-fail'];
            if (typeof fail === 'string') throw new FakeHubError(fail as ApiErrorCode, `message of ${fail}`);
            if (headers['x-answer'] === 'challenge') return { ok: true, answer: { challenge: 'abc' } };
            return { ok: true, id: 'm1', status: 'queued' };
          },
        },
      };
    }
    const post = (port: number, path = '/uplink/u1', body: string | Buffer = '{}', headers: Record<string, string> = {}): Promise<HttpResult> =>
      send(port, { method: 'POST', path, headers: { Host: 'gonogo.example.com', ...headers }, body });

    it('lists, makes, edits, rotates, tests and deletes, and shows the secret only to create and rotate', async () => {
      const { calls, uplinks } = fakeUplinks();
      const { port } = await startWeb({ uplinks });
      expect((await api(port, 'GET', '/api/uplinks')).json()).toEqual([entry]);
      const made = await api(port, 'POST', '/api/uplinks', { name: 'GitHub', to: 'ana' });
      expect([made.status, made.json()]).toEqual([201, { ...entry, secret: 'a'.repeat(64) }]);
      expect((await api(port, 'POST', '/api/uplinks', { name: 'bad' })).json()).toEqual({ error: 'name must be 1 to 60 characters on one line', code: 'bad_request', field: 'name' });
      expect((await api(port, 'POST', '/api/uplinks', [1])).status).toBe(400);
      const patched = await api(port, 'PATCH', '/api/uplinks/u1', { enabled: false });
      expect([patched.status, patched.json()]).toEqual([200, { ...entry, enabled: false }]);
      expect((await api(port, 'POST', '/api/uplinks/u1/rotate')).json()).toEqual({ ...entry, secret: 'b'.repeat(64) });
      expect((await api(port, 'POST', '/api/uplinks/u1/test')).json()).toMatchObject({ deliveries: [{ note: 'test: m1' }] });
      expect((await api(port, 'DELETE', '/api/uplinks/u1')).status).toBe(204);
      for (const [method, path] of [['PATCH', '/api/uplinks/u2'], ['DELETE', '/api/uplinks/u2'], ['POST', '/api/uplinks/u2/rotate'], ['POST', '/api/uplinks/u2/test']] as const) {
        expect((await api(port, method, path, method === 'PATCH' ? {} : undefined)).json(), path).toEqual({ error: 'unknown uplink', code: 'not_found' });
      }
      expect(calls.slice(0, 2)).toEqual([['create', { name: 'GitHub', to: 'ana' }], ['create', { name: 'bad' }]]);
      expect(calls.slice(2, 6)).toEqual([['update', 'u1', { enabled: false }], ['rotate', 'u1'], ['test', 'u1'], ['remove', 'u1']]);
    });

    it('allows only the methods of each route, and wants a browser token', async () => {
      const { uplinks } = fakeUplinks();
      const { port } = await startWeb({ uplinks });
      expect((await api(port, 'PUT', '/api/uplinks')).status).toBe(405);
      expect((await api(port, 'GET', '/api/uplinks/u1')).status).toBe(405);
      expect((await api(port, 'GET', '/api/uplinks/u1/rotate')).status).toBe(405);
      expect((await api(port, 'PATCH', '/api/uplinks/u1/test')).status).toBe(405);
      expect((await api(port, 'POST', '/api/uplinks/u1/other')).status).toBe(404);
      expect((await api(port, 'POST', '/api/uplinks/u1/test/more')).status).toBe(404);
      expect((await api(port, 'GET', '/api/uplinks', undefined, ANA_TOKEN)).status).toBe(401);
      expect((await api(port, 'POST', '/api/uplinks/u1/rotate', undefined, ANA_TOKEN)).status).toBe(401);
    });

    it('shows the list in the first state frame, and is 404 without an uplinks', async () => {
      const { uplinks } = fakeUplinks();
      const { port } = await startWeb({ uplinks });
      expect((await openWs(port)).frames[0]).toMatchObject({ t: 'state', state: { uplinks: [entry] } });
      const none = await startWeb();
      expect((await api(none.port, 'GET', '/api/uplinks')).status).toBe(404);
      expect((await post(none.port)).status).toBe(404);
    });

    describe('POST /uplink/:id', () => {
      it('is reached without the browser token through a name on the allow-list, and hands over the raw bytes and the headers', async () => {
        const { calls, uplinks } = fakeUplinks();
        const { port } = await startWeb({ uplinks });
        // bytes that JSON.parse and a string round trip would change: spacing, order, an invalid UTF-8 byte
        const raw = Buffer.concat([Buffer.from('{ "b":  1,\n"a" : "'), Buffer.from([0xff, 0xfe]), Buffer.from('" }')]);
        const res = await post(port, '/uplink/u1', raw, { 'X-Gonogo-Signature': 'sha256=abc' });
        expect([res.status, res.json()]).toEqual([202, { ok: true, id: 'm1', status: 'queued' }]);
        expect(res.headers['content-type']).toBe('application/json');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(calls).toEqual([['deliver', 'u1', raw.toString('latin1'), 'sha256=abc']]);
        for (const host of ['127.0.0.1', `localhost:${port}`, 'gonogo.example.com:8443']) {
          expect((await post(port, '/uplink/u1', '{}', { Host: host })).status, host).toBe(202);
        }
      });

      it('is as strict as any route about the Host: a name that is not listed is 403, whatever the path', async () => {
        const { calls, uplinks } = fakeUplinks();
        const { port } = await startWeb({ uplinks });
        for (const host of ['evil.example', 'evil.example:7777', 'host.docker.internal', '0.0.0.0']) {
          const res = await post(port, '/uplink/u1', '{}', { Host: host });
          expect([res.status, res.body], host).toEqual([403, 'forbidden host']);
        }
        const bare = await rawRequest(port, 'POST /uplink/u1 HTTP/1.0\r\nContent-Length: 2\r\n\r\n{}');
        expect([bare.status, bare.body]).toEqual([403, 'forbidden host']);
        expect(calls).toEqual([]);
        // the other routes did not become looser: the Host check is the same one for them
        expect((await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: 'evil.example' } })).status).toBe(403);
        expect((await postHook(port, '/hook/ana/Stop', { headers: { Host: 'evil.example' } })).status).toBe(403);
      });

      it('refuses a request that comes from a web page: any Origin is 403', async () => {
        const { calls, uplinks } = fakeUplinks();
        const { port } = await startWeb({ uplinks });
        for (const origin of ['https://gonogo.example.com', 'https://evil.example', 'null']) {
          const res = await post(port, '/uplink/u1', '{}', { Origin: origin });
          expect([res.status, res.body], origin).toEqual([403, 'forbidden origin']);
        }
        expect(calls).toEqual([]);
      });

      it('takes POST only, and says nothing about the id for any other method', async () => {
        const { calls, uplinks } = fakeUplinks();
        const { port } = await startWeb({ uplinks });
        for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
          for (const id of ['u1', 'u9']) {
            const res = await send(port, { method, path: `/uplink/${id}`, headers: { Host: 'gonogo.example.com' } });
            expect([res.status, res.headers.allow], `${method} ${id}`).toEqual([405, 'POST']);
          }
        }
        expect(calls).toEqual([]);
      });

      it('is a 404 for a path that is not /uplink/<id>', async () => {
        const { calls, uplinks } = fakeUplinks();
        const { port } = await startWeb({ uplinks });
        for (const path of ['/uplink', '/uplink/', '/uplink/u1/', '/uplink/u1/more']) {
          expect((await post(port, path)).status, path).toBe(404);
        }
        expect(calls).toEqual([]);
      });

      it('answers what the store says: 401, 404, 400, 409 and 429 with Retry-After, the same shape as the rest of the API', async () => {
        const { uplinks } = fakeUplinks();
        const { port } = await startWeb({ uplinks });
        for (const [code, status] of [['unauthorized', 401], ['not_found', 404], ['bad_request', 400], ['conflict', 409], ['rate_limited', 429]] as const) {
          const res = await post(port, '/uplink/u1', '{}', { 'X-Fail': code });
          expect([res.status, res.json()], code).toEqual([status, { error: `message of ${code}`, code }]);
          expect(res.headers['retry-after'], code).toBe(code === 'rate_limited' ? '60' : undefined);
        }
        // an unexpected failure is a plain 500 and does not tell the sender what happened
        const broke = await send(port, { method: 'POST', path: '/uplink/u1', headers: { Host: 'gonogo.example.com', 'X-Fail': 'x' }, body: '{}' });
        expect(broke.status).toBe(500);
      });

      it('takes a body of 256 KiB and answers 413 for more, whether the length is declared or not, then keeps serving', async () => {
        const { calls, uplinks } = fakeUplinks();
        const { port } = await startWeb({ uplinks });
        const limit = 256 * 1024;
        expect((await post(port, '/uplink/u1', Buffer.alloc(limit, 0x61))).status).toBe(202);
        expect(calls).toHaveLength(1);
        const declared = await post(port, '/uplink/u1', Buffer.alloc(limit + 1, 0x61));
        expect([declared.status, declared.json()]).toEqual([413, { error: 'request body too large', code: 'too_large' }]);
        const chunked = await rawRequest(
          port,
          `POST /uplink/u1 HTTP/1.1\r\nHost: gonogo.example.com\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${(limit + 1).toString(16)}\r\n${'a'.repeat(limit + 1)}\r\n0\r\n\r\n`,
        );
        expect(chunked.status).toBe(413);
        expect(calls).toHaveLength(1);
        expect((await post(port)).status).toBe(202);
      });

      it('answers 200 with the answer of the kind for a ping or a challenge, and 202 for a message', async () => {
        const { uplinks } = fakeUplinks();
        const { port } = await startWeb({ uplinks });
        const asked = await post(port, '/uplink/u1', '{}', { 'X-Answer': 'challenge' });
        expect([asked.status, asked.json()]).toEqual([200, { challenge: 'abc' }]);
        expect((await post(port)).status).toBe(202);
      });

      it('is 503 until the server is ready', async () => {
        const { calls, uplinks } = fakeUplinks();
        const { port, state } = await startWeb({ uplinks });
        state.ready = false;
        expect((await post(port)).status).toBe(503);
        state.ready = true;
        expect((await post(port)).status).toBe(202);
        expect(calls).toHaveLength(1);
      });
    });
  });

  describe('docking', () => {
    const dockView = { id: 'a'.repeat(32), name: 'lab', url: 'http://lab.test', since: 1, status: 'ok', seenAt: 2, error: null, agents: [] };
    const view = { station: 'home', docks: [dockView] };
    /** A docking that records what the routes ask of it; `handle` fails the way the header `x-fail` says. */
    function fakeDocking(): { calls: unknown[][]; docking: NonNullable<WebOptions['docking']> } {
      const calls: unknown[][] = [];
      const known = (id: string): void => {
        if (id !== dockView.id) throw new FakeHubError('not_found', 'unknown dock');
      };
      return {
        calls,
        docking: {
          view: () => view as never,
          createCode: (input) => {
            calls.push(['code', input]);
            if ((input as { url?: unknown }).url === 'bad') throw new FakeHubError('bad_request', 'url must be a web address with no path', 'url');
            return { code: 'gonogo-dock:abc', expiresAt: 5 };
          },
          pair: async (input) => {
            calls.push(['pair', input]);
            return dockView as never;
          },
          undock: async (id) => {
            calls.push(['undock', id]);
            known(id);
            return { told: false };
          },
          handOff: async (id, input) => {
            calls.push(['handoff', id, input]);
            known(id);
            return { id: 't1', handedOff: 'lab' } as never;
          },
          handle: async (route, method, url, headers, body) => {
            calls.push(['handle', route, method, url, headers['x-gonogo-signature'] ?? null, body.toString('latin1')]);
            const fail = headers['x-fail'];
            if (typeof fail === 'string') throw new FakeHubError(fail as ApiErrorCode, `message of ${fail}`);
            return { ok: true };
          },
        },
      };
    }
    const call = (port: number, method: string, path = '/dock/roster', body: string | Buffer = '', headers: Record<string, string> = {}): Promise<HttpResult> =>
      send(port, { method, path, headers: { Host: 'gonogo.example.com', ...headers }, body });

    it('shows the docks, makes a code, pairs, hands a task off and undocks, with the browser token', async () => {
      const { calls, docking } = fakeDocking();
      const { port } = await startWeb({ docking });
      expect((await api(port, 'GET', '/api/docking')).json()).toEqual(view);
      const code = await api(port, 'POST', '/api/docking/code', { url: 'https://lab.example.com' });
      expect([code.status, code.json()]).toEqual([201, { code: 'gonogo-dock:abc', expiresAt: 5 }]);
      expect((await api(port, 'POST', '/api/docking/code', { url: 'bad' })).json()).toEqual({ error: 'url must be a web address with no path', code: 'bad_request', field: 'url' });
      const paired = await api(port, 'POST', '/api/docking/pair', { code: 'gonogo-dock:x', url: 'https://home.example.com' });
      expect([paired.status, paired.json()]).toEqual([201, dockView]);
      const handed = await api(port, 'POST', `/api/docking/${dockView.id}/handoff`, { task: 't1', assignee: 'bob' });
      expect([handed.status, handed.json()]).toEqual([200, { id: 't1', handedOff: 'lab' }]);
      const gone = await api(port, 'DELETE', `/api/docking/${dockView.id}`);
      expect([gone.status, gone.json()]).toEqual([200, { told: false }]);
      expect((await api(port, 'DELETE', `/api/docking/${'b'.repeat(32)}`)).json()).toEqual({ error: 'unknown dock', code: 'not_found' });
      expect((await api(port, 'POST', `/api/docking/${'b'.repeat(32)}/handoff`, { task: 't1' })).status).toBe(404);
      expect((await api(port, 'POST', '/api/docking/code', [1])).status).toBe(400);
      expect(calls).toEqual([
        ['code', { url: 'https://lab.example.com' }],
        ['code', { url: 'bad' }],
        ['pair', { code: 'gonogo-dock:x', url: 'https://home.example.com' }],
        ['handoff', dockView.id, { task: 't1', assignee: 'bob' }],
        ['undock', dockView.id],
        ['undock', 'b'.repeat(32)],
        ['handoff', 'b'.repeat(32), { task: 't1' }],
      ]);
    });

    it('allows only the methods of each route, and wants the browser token, not an agent', async () => {
      const { docking } = fakeDocking();
      const { port } = await startWeb({ docking });
      expect((await api(port, 'POST', '/api/docking')).status).toBe(405);
      expect((await api(port, 'GET', '/api/docking/code')).status).toBe(405);
      expect((await api(port, 'GET', '/api/docking/pair')).status).toBe(405);
      expect((await api(port, 'POST', `/api/docking/${dockView.id}`)).status).toBe(405);
      expect((await api(port, 'GET', `/api/docking/${dockView.id}/handoff`)).status).toBe(405);
      expect((await api(port, 'POST', `/api/docking/${dockView.id}/other`)).status).toBe(404);
      expect((await api(port, 'POST', `/api/docking/${dockView.id}/handoff/more`)).status).toBe(404);
      expect((await api(port, 'GET', '/api/docking', undefined, ANA_TOKEN)).status).toBe(401);
      expect((await api(port, 'POST', '/api/docking/code', { url: 'http://x.test' }, ANA_TOKEN)).status).toBe(401);
      expect((await send(port, { path: '/api/docking' })).status).toBe(401);
    });

    it('is in the snapshot and the first state frame, and is 404 without a docking', async () => {
      const { docking } = fakeDocking();
      const { port } = await startWeb({ docking });
      expect(((await api(port, 'GET', '/api/state')).json() as StateSnapshot).docking).toEqual(view);
      expect((await openWs(port)).frames[0]).toMatchObject({ t: 'state', state: { docking: view } });
      const none = await startWeb();
      expect(((await api(none.port, 'GET', '/api/state')).json() as StateSnapshot)).not.toHaveProperty('docking');
      expect((await api(none.port, 'GET', '/api/docking')).status).toBe(404);
      expect((await call(none.port, 'GET')).status).toBe(404);
      expect((await call(none.port, 'POST', '/dock/pair', '{}')).status).toBe(404);
    });

    describe('/dock/<route>', () => {
      it('is reached without the browser token through a name on the allow-list, and hands over the route, method, path, headers and raw bytes', async () => {
        const { calls, docking } = fakeDocking();
        const { port } = await startWeb({ docking });
        const raw = Buffer.concat([Buffer.from('{ "b":  1,\n"a" : "'), Buffer.from([0xff, 0xfe]), Buffer.from('" }')]);
        const res = await call(port, 'POST', '/dock/message', raw, { 'X-Gonogo-Signature': 'abc' });
        expect([res.status, res.json()]).toEqual([200, { ok: true }]);
        expect(res.headers['content-type']).toBe('application/json');
        expect(res.headers['cache-control']).toBe('no-store');
        const roster = await call(port, 'GET', '/dock/roster', '', { 'X-Gonogo-Signature': 'def' });
        expect(roster.status).toBe(200);
        expect(calls).toEqual([
          ['handle', 'message', 'POST', '/dock/message', 'abc', raw.toString('latin1')],
          ['handle', 'roster', 'GET', '/dock/roster', 'def', ''],
        ]);
        for (const host of ['127.0.0.1', `localhost:${port}`, 'gonogo.example.com:8443']) {
          expect((await call(port, 'GET', '/dock/roster', '', { Host: host })).status, host).toBe(200);
        }
      });

      it('is as strict as any route about the Host: a name that is not listed, or the one of a container, is 403', async () => {
        const { calls, docking } = fakeDocking();
        const { port } = await startWeb({ docking });
        for (const host of ['evil.example', 'evil.example:7777', 'host.docker.internal', '0.0.0.0']) {
          const res = await call(port, 'GET', '/dock/roster', '', { Host: host });
          expect([res.status, res.body], host).toEqual([403, 'forbidden host']);
        }
        expect(calls).toEqual([]);
      });

      it('refuses a request that comes from a web page: any Origin is 403', async () => {
        const { calls, docking } = fakeDocking();
        const { port } = await startWeb({ docking });
        for (const origin of ['https://gonogo.example.com', 'https://evil.example', 'null']) {
          const res = await call(port, 'GET', '/dock/roster', '', { Origin: origin });
          expect([res.status, res.body], origin).toEqual([403, 'forbidden origin']);
        }
        expect(calls).toEqual([]);
      });

      it('takes the one method of each route, and is a 404 for a path that is not a route', async () => {
        const { calls, docking } = fakeDocking();
        const { port } = await startWeb({ docking });
        const methods: Record<string, string> = { pair: 'POST', roster: 'GET', message: 'POST', task: 'POST', undock: 'POST' };
        for (const [route, want] of Object.entries(methods)) {
          for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
            const res = await call(port, method, `/dock/${route}`);
            if (method === want) expect(res.status, `${method} ${route}`).toBe(200);
            else expect([res.status, res.headers.allow], `${method} ${route}`).toEqual([405, method === 'OPTIONS' ? 'GET, POST' : want]);
          }
        }
        calls.length = 0;
        for (const path of ['/dock', '/dock/', '/dock/other', '/dock/roster/', '/dock/roster/x', '/dock/constructor', '/dock/__proto__', '/dock/toString']) {
          expect((await call(port, 'GET', path)).status, path).toBe(404);
        }
        expect(calls).toEqual([]);
      });

      it('answers what the module says: 401, 400, 409, 413 and 429 with Retry-After, in the shape of the rest of the API', async () => {
        const { docking } = fakeDocking();
        const { port } = await startWeb({ docking });
        for (const [code, status] of [['unauthorized', 401], ['bad_request', 400], ['conflict', 409], ['not_found', 404], ['rate_limited', 429], ['too_large', 413]] as const) {
          const res = await call(port, 'GET', '/dock/roster', '', { 'X-Fail': code });
          expect([res.status, res.json()], code).toEqual([status, { error: `message of ${code}`, code }]);
          expect(res.headers['retry-after'], code).toBe(code === 'rate_limited' ? '60' : undefined);
        }
        expect((await call(port, 'GET', '/dock/roster', '', { 'X-Fail': 'x' })).status).toBe(500);
      });

      it('takes a body of 256 KiB and answers 413 for more, declared or not, then keeps serving', async () => {
        const { calls, docking } = fakeDocking();
        const { port } = await startWeb({ docking });
        const limit = 256 * 1024;
        expect((await call(port, 'POST', '/dock/message', Buffer.alloc(limit, 0x61))).status).toBe(200);
        expect(calls).toHaveLength(1);
        const declared = await call(port, 'POST', '/dock/message', Buffer.alloc(limit + 1, 0x61));
        expect([declared.status, declared.json()]).toEqual([413, { error: 'request body too large', code: 'too_large' }]);
        const chunked = await rawRequest(
          port,
          `POST /dock/message HTTP/1.1\r\nHost: gonogo.example.com\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${(limit + 1).toString(16)}\r\n${'a'.repeat(limit + 1)}\r\n0\r\n\r\n`,
        );
        expect(chunked.status).toBe(413);
        expect(calls).toHaveLength(1);
      });

      it('is 503 until the server is ready', async () => {
        const { calls, docking } = fakeDocking();
        const { port, state } = await startWeb({ docking });
        state.ready = false;
        expect((await call(port, 'GET')).status).toBe(503);
        state.ready = true;
        expect((await call(port, 'GET')).status).toBe(200);
        expect(calls).toHaveLength(1);
      });
    });
  });

  describe('relay', () => {
    const view = { slack: { to: 'C0123456789', last: null }, telegram: null, forward: ['message', 'redline'] };
    /** A relay that records what the routes ask of it; a service named "bad" is refused as the real one refuses. */
    function fakeRelay(): { calls: unknown[][]; relay: NonNullable<WebOptions['relay']> } {
      const calls: unknown[][] = [];
      const known = (service: string): void => {
        if (service !== 'slack' && service !== 'telegram') throw new FakeHubError('not_found', 'unknown service');
      };
      return {
        calls,
        relay: {
          view: () => view as never,
          setPhone: async (input) => {
            calls.push(['phone', input]);
            return view as never;
          },
          set: async (service, input) => {
            calls.push(['set', service, input]);
            known(service);
            if ((input as { to?: unknown }).to === 'bad') throw new FakeHubError('bad_request', 'to must be the channel id, such as C0123456789', 'to');
            return view as never;
          },
          remove: async (service) => {
            calls.push(['remove', service]);
            known(service);
            return { ...view, slack: null } as never;
          },
          forward: async (input) => {
            calls.push(['forward', input]);
            return view as never;
          },
          test: async (service) => {
            calls.push(['test', service]);
            known(service);
            return { ...view, slack: { to: 'C0123456789', last: { at: 1, ok: true, note: 'test sent' } } } as never;
          },
        },
      };
    }

    it('shows the view, saves a target, removes it, tests it and chooses what is forwarded, and answers with the view each time', async () => {
      const { calls, relay } = fakeRelay();
      const { port } = await startWeb({ relay });
      expect((await api(port, 'GET', '/api/relay')).json()).toEqual(view);
      const put = await api(port, 'PUT', '/api/relay/slack', { token: 'xoxb-1234567890-abc', to: 'C0123456789' });
      expect([put.status, put.json()]).toEqual([200, view]);
      expect((await api(port, 'PUT', '/api/relay/forward', { kinds: ['message', 'redline'] })).json()).toEqual(view);
      expect((await api(port, 'POST', '/api/relay/slack/test')).json()).toMatchObject({ slack: { last: { ok: true } } });
      const del = await api(port, 'DELETE', '/api/relay/slack');
      expect([del.status, del.json()]).toEqual([200, { ...view, slack: null }]);
      expect(calls).toEqual([
        ['set', 'slack', { token: 'xoxb-1234567890-abc', to: 'C0123456789' }],
        ['forward', { kinds: ['message', 'redline'] }],
        ['test', 'slack'],
        ['remove', 'slack'],
      ]);
    });

    it('says what is wrong with the name of the field, and 404 for a service that is not there', async () => {
      const { relay } = fakeRelay();
      const { port } = await startWeb({ relay });
      const bad = await api(port, 'PUT', '/api/relay/slack', { to: 'bad' });
      expect([bad.status, bad.json()]).toEqual([400, { error: 'to must be the channel id, such as C0123456789', code: 'bad_request', field: 'to' }]);
      expect((await api(port, 'PUT', '/api/relay/slack', [1])).status).toBe(400);
      for (const [method, path] of [['PUT', '/api/relay/discord'], ['DELETE', '/api/relay/discord'], ['POST', '/api/relay/discord/test']] as const) {
        expect((await api(port, method, path, method === 'PUT' ? { to: 'x' } : undefined)).json(), path).toEqual({ error: 'unknown service', code: 'not_found' });
      }
    });

    it('allows only the methods of each route, and wants a browser token', async () => {
      const { calls, relay } = fakeRelay();
      const { port } = await startWeb({ relay });
      expect((await api(port, 'POST', '/api/relay')).status).toBe(405);
      expect((await api(port, 'GET', '/api/relay/slack')).status).toBe(405);
      expect((await api(port, 'POST', '/api/relay/forward')).status).toBe(405);
      expect((await api(port, 'GET', '/api/relay/slack/test')).status).toBe(405);
      expect((await api(port, 'POST', '/api/relay/slack/other')).status).toBe(404);
      expect((await api(port, 'POST', '/api/relay/slack/test/more')).status).toBe(404);
      for (const [method, path] of [['GET', '/api/relay'], ['PUT', '/api/relay/slack'], ['POST', '/api/relay/slack/test']] as const) {
        expect((await api(port, method, path, method === 'PUT' ? {} : undefined, ANA_TOKEN)).status, path).toBe(401);
      }
      expect(calls).toEqual([]);
    });

    it('is 404 without a relay, and its answers carry no token', async () => {
      const none = await startWeb();
      expect((await api(none.port, 'GET', '/api/relay')).status).toBe(404);
      const { relay } = fakeRelay();
      const { port } = await startWeb({ relay });
      expect((await api(port, 'GET', '/api/relay')).body).not.toMatch(/token/);
      expect((await openWs(port)).frames[0]).not.toMatchObject({ state: { relay: expect.anything() } });
    });
  });

  describe('answer', () => {
    it('POST /api/agents/:name/answer answers 200 with the view and hands the hub only { go }', async () => {
      const { port, hubCalls } = await startWeb();
      const go = await api(port, 'POST', '/api/agents/ana/answer', { go: true, bogus: 1 });
      expect(go.status).toBe(200);
      expect(go.json()).toMatchObject({ name: 'ana', state: 'needs_you', needsKind: 'permission', doing: null });
      expect((await api(port, 'POST', '/api/agents/ana/answer', { go: false })).status).toBe(200);
      expect(hubCalls.map((c) => [c.fn, ...c.args])).toStrictEqual([['answer', 'ana', { go: true }], ['answer', 'ana', { go: false }]]);
    });

    it.each([
      ['a missing go', {}],
      ['a string', { go: 'true' }],
      ['a number', { go: 1 }],
      ['null', { go: null }],
    ])('answers 400 with the field go for %s, and never calls the hub', async (_what, body) => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'POST', '/api/agents/ana/answer', body);
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request', field: 'go' });
      expect(hubCalls).toEqual([]);
    });

    it('answers 400 for a body that is not an object, 415 for a body that is not JSON, 404 and 409 from the name and the hub', async () => {
      const { port } = await startWeb();
      expect((await api(port, 'POST', '/api/agents/ana/answer', [])).status).toBe(400);
      expect((await api(port, 'POST', '/api/agents/ana/answer')).status).toBe(400);
      const plain = await send(port, { method: 'POST', path: '/api/agents/ana/answer', headers: { ...bearer(TOKEN), 'Content-Type': 'text/plain' }, body: '{"go":true}' });
      expect(plain.status).toBe(415);
      expect((await api(port, 'POST', '/api/agents/ghost/answer', { go: true })).status).toBe(404);
      expect((await api(port, 'POST', '/api/agents/Not_A_Name/answer', { go: true })).json()).toEqual({ error: 'unknown agent', code: 'not_found' });
      const conflict = await api(port, 'POST', '/api/agents/ben/answer', { go: true });
      expect(conflict.status).toBe(409);
      expect(conflict.json()).toEqual({ error: 'ben is not asking for a go', code: 'conflict' });
    });

    it('allows only POST, and needs the browser token and a ready hub', async () => {
      const { port, state, hubCalls } = await startWeb();
      const wrong = await api(port, 'GET', '/api/agents/ana/answer');
      expect(wrong.status).toBe(405);
      expect(wrong.headers.allow).toBe('POST');
      expect((await api(port, 'POST', '/api/agents/ana/answer', { go: true }, 'wrong')).status).toBe(401);
      expect((await send(port, { method: 'POST', path: '/api/agents/ana/answer' })).status).toBe(401);
      expect(hubCalls).toEqual([]);
      state.ready = false;
      expect((await api(port, 'POST', '/api/agents/ana/answer', { go: true })).status).toBe(503);
    });
  });

  describe('poll', () => {
    it('POST /api/poll answers 201 with the PollView and hands the hub the agents, or {} without a body', async () => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'POST', '/api/poll', { agents: ['ana', 'ben'], bogus: 1 });
      expect(res.status).toBe(201);
      expect(res.json()).toEqual(pollView());
      expect((await api(port, 'DELETE', '/api/poll')).status).toBe(204);
      expect((await api(port, 'POST', '/api/poll')).status).toBe(201);
      expect(hubCalls.filter((c) => c.fn === 'startPoll').map((c) => c.args[0])).toStrictEqual([{ agents: ['ana', 'ben'] }, {}]);
    });

    it('POST /api/poll passes a static fire subject to the hub, and refuses one that is not text', async () => {
      const { port, hubCalls } = await startWeb();
      expect((await api(port, 'POST', '/api/poll', { subject: 'the login form' })).status).toBe(201);
      expect(hubCalls.filter((c) => c.fn === 'startPoll').map((c) => c.args[0])).toStrictEqual([{ subject: 'the login form' }]);
      const bad = await api(port, 'POST', '/api/poll', { subject: 3 });
      expect(bad.status).toBe(400);
      expect(bad.json()).toMatchObject({ code: 'bad_request', field: 'subject' });
    });

    it.each([
      ['agents that is a string', { agents: 'ana' }],
      ['agents with a number in it', { agents: ['ana', 3] }],
      ['agents that is null', { agents: null }],
    ])('answers 400 for %s, and never calls the hub', async (_what, body) => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'POST', '/api/poll', body);
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request', field: 'agents' });
      expect(hubCalls).toEqual([]);
    });

    it('answers 400 for a body that is not an object, 415 for another content type, 413 for a huge body', async () => {
      const { port } = await startWeb();
      expect((await api(port, 'POST', '/api/poll', [1])).status).toBe(400);
      const plain = await send(port, { method: 'POST', path: '/api/poll', headers: { ...bearer(TOKEN), 'Content-Type': 'text/plain' }, body: '{}' });
      expect(plain.status).toBe(415);
      const big = await api(port, 'POST', '/api/poll', { agents: ['x'.repeat(MAX_REST_BODY_BYTES)] });
      expect(big.status).toBe(413);
    });

    it('turns the hub errors into their statuses: 409 while a poll exists, 400 for an unknown agent', async () => {
      const { port } = await startWeb();
      const bad = await api(port, 'POST', '/api/poll', { agents: ['ghost'] });
      expect(bad.status).toBe(400);
      expect(bad.json()).toEqual({ error: 'unknown agent "ghost"', code: 'bad_request', field: 'agents' });
      expect((await api(port, 'POST', '/api/poll', {})).status).toBe(201);
      const again = await api(port, 'POST', '/api/poll', {});
      expect(again.status).toBe(409);
      expect(again.json()).toEqual({ error: 'clear the poll first', code: 'conflict' });
    });

    it('hold and abort answer 200 with the PollView, and 409 with no poll', async () => {
      const { port, hubCalls } = await startWeb();
      for (const action of ['hold', 'abort']) {
        const none = await api(port, 'POST', `/api/poll/${action}`);
        expect(none.status).toBe(409);
        expect(none.json()).toEqual({ error: 'there is no poll', code: 'conflict' });
      }
      await api(port, 'POST', '/api/poll', {});
      const held = await api(port, 'POST', '/api/poll/hold');
      expect(held.status).toBe(200);
      expect(held.json()).toMatchObject({ status: 'hold', note: 'held by the Director' });
      const aborted = await api(port, 'POST', '/api/poll/abort');
      expect(aborted.status).toBe(200);
      expect(aborted.json()).toMatchObject({ status: 'aborted' });
      expect(hubCalls.map((c) => c.fn).filter((fn) => fn === 'holdPoll' || fn === 'abortPoll')).toEqual(['holdPoll', 'abortPoll', 'holdPoll', 'abortPoll']);
    });

    it('DELETE /api/poll clears and answers 204 like the other delete routes, also with no poll', async () => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'DELETE', '/api/poll');
      expect(res.status).toBe(204);
      expect(res.body).toBe('');
      expect(hubCalls.map((c) => c.fn)).toEqual(['clearPoll']);
    });

    it('allows only the right methods, and answers 404 for an unknown poll path', async () => {
      const { port } = await startWeb();
      const wrong: Array<[string, string, string]> = [
        ['GET', '/api/poll', 'POST, DELETE'],
        ['PUT', '/api/poll', 'POST, DELETE'],
        ['GET', '/api/poll/hold', 'POST'],
        ['DELETE', '/api/poll/abort', 'POST'],
        ['GET', '/api/governor', 'PUT'],
        ['POST', '/api/governor', 'PUT'],
      ];
      for (const [method, path, allow] of wrong) {
        const res = await api(port, method, path);
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.allow).toBe(allow);
      }
      expect((await api(port, 'POST', '/api/poll/clear')).status).toBe(404);
      expect((await api(port, 'POST', '/api/poll/hold/x')).status).toBe(404);
    });

    it('needs the browser token and a ready hub, like every route', async () => {
      const { port, state, hubCalls } = await startWeb();
      for (const [method, path] of [['POST', '/api/poll'], ['POST', '/api/poll/hold'], ['POST', '/api/poll/abort'], ['DELETE', '/api/poll'], ['PUT', '/api/governor']]) {
        expect((await api(port, method, path, method === 'DELETE' ? undefined : {}, 'wrong')).status).toBe(401);
        expect((await send(port, { method, path })).status).toBe(401);
      }
      expect(hubCalls).toEqual([]);
      state.ready = false;
      expect((await api(port, 'POST', '/api/poll', {})).status).toBe(503);
      expect((await api(port, 'PUT', '/api/governor', { limit: 2 })).status).toBe(503);
    });
  });

  describe('governor', () => {
    it('PUT /api/governor answers 200 with the GovernorView, for a limit and for null', async () => {
      const { port, hubCalls } = await startWeb();
      const on = await api(port, 'PUT', '/api/governor', { limit: 3, bogus: true });
      expect(on.status).toBe(200);
      expect(on.json()).toEqual({ limit: 3, working: 1, holding: 0 });
      const off = await api(port, 'PUT', '/api/governor', { limit: null });
      expect(off.json()).toEqual({ limit: null, working: 1, holding: 0 });
      expect(hubCalls.filter((c) => c.fn === 'setGovernor').map((c) => c.args[0])).toStrictEqual([{ limit: 3 }, { limit: null }]);
    });

    it.each([
      ['a missing limit', {}],
      ['a string', { limit: '3' }],
      ['a fraction', { limit: 2.5 }],
      ['a boolean', { limit: true }],
    ])('answers 400 with the field for %s, and never calls the hub', async (_what, body) => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'PUT', '/api/governor', body);
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request', field: 'limit' });
      expect(hubCalls).toEqual([]);
    });

    it('leaves the range to the hub, which answers 400 with the field', async () => {
      const { port } = await startWeb();
      for (const limit of [0, 25, -1]) {
        const res = await api(port, 'PUT', '/api/governor', { limit });
        expect(res.status).toBe(400);
        expect(res.json()).toEqual({ error: 'limit must be 1 to 24 or null', code: 'bad_request', field: 'limit' });
      }
    });

    it('answers 400 for a body that is not an object and 415 for a body that is not JSON', async () => {
      const { port } = await startWeb();
      expect((await api(port, 'PUT', '/api/governor', [])).status).toBe(400);
      const plain = await send(port, { method: 'PUT', path: '/api/governor', headers: { ...bearer(TOKEN), 'Content-Type': 'text/plain' }, body: '{"limit":2}' });
      expect(plain.status).toBe(415);
    });
  });

  describe('messages', () => {
    it('answers 201 with the SendResult and hands the hub the known fields', async () => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'POST', '/api/messages', { to: 'boss', subject: 'Brief', body: 'do it', inReplyTo: 'm2', from: 'flight' });
      expect(res.status).toBe(201);
      expect(res.json()).toEqual({ ok: true, id: 'm1', to: 'flight', status: 'queued', note: 'waiting: about to type the pointer' });
      expect(hubCalls.filter((c) => c.fn === 'sendFromUser').map((c) => c.args[0])).toStrictEqual([{ to: 'boss', body: 'do it', subject: 'Brief', inReplyTo: 'm2' }]);
    });

    it('relays the hub refusals: a message to the user is 400 and an unknown recipient is 404, both with field to', async () => {
      const { port } = await startWeb();
      const toUser = await api(port, 'POST', '/api/messages', { to: 'user', body: 'x' });
      expect(toUser.status).toBe(400);
      expect(toUser.json()).toMatchObject({ code: 'bad_request', field: 'to' });
      const unknown = await api(port, 'POST', '/api/messages', { to: 'nobody', body: 'x' });
      expect(unknown.status).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'not_found', field: 'to' });
    });

    it.each([
      ['no recipient', { body: 'x' }, 'to'],
      ['a body that is not a string', { to: 'ana', body: 12 }, 'body'],
      ['a subject that is not a string', { to: 'ana', body: 'x', subject: [] }, 'subject'],
      ['an inReplyTo that is not a string', { to: 'ana', body: 'x', inReplyTo: 4 }, 'inReplyTo'],
    ])('answers 400 with the field for %s', async (_what, body, field) => {
      const { port, hubCalls } = await startWeb();
      const res = await api(port, 'POST', '/api/messages', body);
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ field });
      expect(hubCalls).toEqual([]);
    });

    it('keeps working while the hub is shutting down: 409 for lifecycle calls, 200 for state and messages', async () => {
      const closing = (): never => {
        throw new FakeHubError('conflict', 'the server is shutting down');
      };
      const { port } = await startWeb({}, { hire: closing, edit: closing, restart: closing, stop: closing, remove: closing });
      expect((await api(port, 'GET', '/api/state')).status).toBe(200);
      expect((await api(port, 'POST', '/api/messages', { to: 'ana', body: 'x' })).status).toBe(201);
      for (const [method, path, body] of [
        ['POST', '/api/agents', { name: 'a', role: 'r', dir: '/w', mode: 'default' }],
        ['PATCH', '/api/agents/ana', { role: 'r' }],
        ['DELETE', '/api/agents/ana', undefined],
        ['POST', '/api/agents/ana/stop', undefined],
        ['POST', '/api/agents/ana/restart', undefined],
      ] as const) {
        const res = await api(port, method, path, body);
        expect(res.status).toBe(409);
        expect(res.json()).toEqual({ error: 'the server is shutting down', code: 'conflict' });
      }
    });
  });

  describe('bodies and methods', () => {
    it('answers 415 for a body that is not JSON, and accepts the usual spellings of JSON', async () => {
      const { port } = await startWeb();
      const body = JSON.stringify({ to: 'ana', body: 'x' });
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx']) {
        const res = await send(port, { method: 'POST', path: '/api/messages', headers: { ...bearer(TOKEN), 'Content-Type': type }, body });
        expect(res.status).toBe(415);
        expect(res.json()).toMatchObject({ code: 'unsupported' });
      }
      const none = await send(port, { method: 'POST', path: '/api/messages', headers: bearer(TOKEN), body });
      expect(none.status).toBe(415);
      for (const type of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
        const res = await send(port, { method: 'POST', path: '/api/messages', headers: { ...bearer(TOKEN), 'Content-Type': type }, body });
        expect(res.status).toBe(201);
      }
    });

    it('answers 413 for a body over the limit and keeps serving', async () => {
      const { port, hubCalls } = await startWeb();
      const agent = keepAliveAgent();
      const body = JSON.stringify({ to: 'ana', body: 'x'.repeat(MAX_REST_BODY_BYTES) });
      const res = await send(port, { method: 'POST', path: '/api/messages', headers: { ...bearer(TOKEN), ...JSON_HEADERS }, body, agent });
      expect(res.status).toBe(413);
      expect(res.json()).toEqual({ error: 'request body too large', code: 'too_large' });
      expect(hubCalls).toEqual([]);
      expect((await send(port, { method: 'GET', path: '/api/state', headers: bearer(TOKEN), agent })).status).toBe(200);
    });

    it.each([
      ['broken JSON', '{'],
      ['an array', '[]'],
      ['null', 'null'],
      ['a number', '1'],
      ['an empty body', ''],
    ])('answers 400 for %s', async (_what, body) => {
      const { port, hubCalls } = await startWeb();
      const res = await send(port, { method: 'POST', path: '/api/messages', headers: { ...bearer(TOKEN), ...JSON_HEADERS }, body });
      expect(res.status).toBe(400);
      expect(res.json()).toEqual({ error: 'request body must be a JSON object', code: 'bad_request' });
      expect(hubCalls).toEqual([]);
    });

    it('answers 405 with the Allow header of the route', async () => {
      const { port } = await startWeb();
      const cases: Array<[string, string, string]> = [
        ['PUT', '/api/state', 'GET'],
        ['POST', '/api/state', 'GET'],
        ['GET', '/api/agents', 'POST'],
        ['DELETE', '/api/agents', 'POST'],
        ['GET', '/api/agents/ana', 'PATCH, DELETE'],
        ['POST', '/api/agents/ana', 'PATCH, DELETE'],
        ['GET', '/api/agents/ana/stop', 'POST'],
        ['PATCH', '/api/agents/ana/restart', 'POST'],
        ['GET', '/api/messages', 'POST'],
        ['DELETE', '/api/messages', 'POST'],
      ];
      for (const [method, path, allow] of cases) {
        const res = await api(port, method, path);
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.allow).toBe(allow);
        expect(res.json()).toMatchObject({ code: 'bad_request' });
      }
    });

    it('answers OPTIONS with 405 on every kind of route, with or without a token, and never sends CORS headers', async () => {
      const { port } = await startWeb();
      for (const [path, allow] of [
        ['/api/state', 'GET, POST, PATCH, DELETE'],
        ['/hook/ana/Stop', 'POST'],
        ['/mcp', 'POST'],
        ['/ws', 'GET'],
        ['/', 'GET, HEAD'],
        ['/assets/app.js', 'GET, HEAD'],
      ] as const) {
        for (const headers of [{}, bearer(TOKEN), bearer(ANA_TOKEN)]) {
          const res = await send(port, { method: 'OPTIONS', path, headers });
          expect(res.status, path).toBe(405);
          expect(res.headers.allow).toBe(allow);
          expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
        }
      }
      // a preflight from another site fails the Origin check first
      const preflight = await send(port, { method: 'OPTIONS', path: '/api/state', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
      expect(preflight.status).toBe(403);
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers 404 with a JSON body for unknown routes under the reserved prefixes, after the token check', async () => {
      const { port } = await startWeb();
      for (const path of ['/api', '/api/', '/api/zzz', '/api/state/x', '/api/agents/ana/start', '/api/agents/ana/stop/x', '/mcp/x', '/ws/x']) {
        const res = await api(port, 'GET', path);
        expect(res.status, path).toBe(404);
      }
      const apiBody = await api(port, 'GET', '/api/zzz');
      expect(apiBody.json()).toEqual({ error: 'not found', code: 'not_found' });
      expect((await send(port, { path: '/api/zzz' })).status).toBe(401);
    });

    it('sets the standing headers on every kind of answer, no-store on API answers, and no cookies or CORS', async () => {
      const { port } = await startWeb();
      const answers = [
        await api(port, 'GET', '/api/state'),
        await api(port, 'GET', '/api/zzz'),
        await send(port, { path: '/api/state' }),
        await send(port, { path: '/hook/ana/Stop', method: 'POST' }),
        await send(port, { path: '/mcp', method: 'POST' }),
        await send(port, { path: '/api/state', headers: { Host: 'evil.example' } }),
        await send(port, { path: '/nothing.js' }),
      ];
      for (const res of answers) {
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
      }
      for (const res of answers.slice(0, 5)) expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('starting up', () => {
    it('answers 503 on /api and /ws until the hub is ready, after the token check', async () => {
      const harness = await startWeb();
      harness.state.ready = false;
      const { port } = harness;
      const early = await api(port, 'GET', '/api/state');
      expect(early.status).toBe(503);
      expect(early.json()).toEqual({ error: 'starting', code: 'unavailable' });
      for (const [method, path] of [['POST', '/api/agents'], ['PATCH', '/api/agents/ana'], ['POST', '/api/messages'], ['GET', '/api/zzz']] as const) {
        expect((await api(port, method, path, method === 'GET' ? undefined : {})).status).toBe(503);
      }
      // a stranger learns nothing about the state of the server
      expect((await send(port, { path: '/api/state' })).status).toBe(401);
      expect((await api(port, 'GET', '/api/state', undefined, 'f'.repeat(64))).status).toBe(401);
      const upgrade = await connectWs(port);
      expect(upgrade).toMatchObject({ kind: 'rejected', status: 503, body: '{"error":"starting","code":"unavailable"}' });
      expect(await connectWs(port, { token: 'f'.repeat(64) })).toMatchObject({ kind: 'rejected', status: 401 });
      // hooks, MCP and static files are not held back: the boss is started while only these are listening
      expect((await postHook(port, '/hook/ana/Stop')).status).toBe(200);
      expect((await postMcp(port)).status).not.toBe(503);
      harness.state.ready = true;
      expect((await api(port, 'GET', '/api/state')).status).toBe(200);
      expect((await connectWs(port)).kind).toBe('open');
    });
  });
});

/* ================================================================================================================
 * web: who may talk to the port
 * ============================================================================================================== */

describe('web: auth, Host and Origin', () => {
  it('answers 401 with the ApiError body and WWW-Authenticate when the token is missing or wrong', async () => {
    const { port } = await startWeb();
    const attempts: Array<Record<string, string>> = [
      {},
      bearer('f'.repeat(64)),
      bearer(''),
      bearer(ANA_TOKEN),
      { Authorization: 'Basic abc' },
      { Authorization: TOKEN },
      { Authorization: `Bearer ${TOKEN} x` },
      { Authorization: `Bearer ${TOKEN.slice(0, 63)}` },
      { Authorization: `Bearer ${TOKEN}0` },
      { Cookie: `token=${TOKEN}` },
    ];
    for (const headers of attempts) {
      const res = await send(port, { path: '/api/state', headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized', code: 'unauthorized' });
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('takes the token from the Authorization header only, never from the URL, and the scheme in any case', async () => {
    const { port } = await startWeb();
    expect((await send(port, { path: `/api/state?token=${TOKEN}` })).status).toBe(401);
    expect((await send(port, { path: '/api/state', headers: { Authorization: `bearer ${TOKEN}` } })).status).toBe(200);
  });

  it('answers 401, not a crash, for a 64 character token that is not ASCII and for very long tokens', async () => {
    const { port } = await startWeb();
    for (const token of ['é'.repeat(64), 'ÿ'.repeat(64), 'a'.repeat(10_000), 'é'.repeat(32) + 'a'.repeat(32)]) {
      const res = await api(port, 'GET', '/api/state', undefined, token);
      expect(res.status).toBe(401);
    }
    await expectStillServing(port);
  });

  it('does not accept the browser token for hooks and MCP, nor an agent token for /api', async () => {
    const { port } = await startWeb();
    expect((await postHook(port, '/hook/ana/Stop', { token: TOKEN })).status).toBe(401);
    expect((await postMcp(port, { token: TOKEN })).status).toBe(401);
    expect((await api(port, 'GET', '/api/state', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await connectWs(port, { token: ANA_TOKEN })).kind).toBe('rejected');
  });

  describe('Host', () => {
    it.each([
      ['127.0.0.1', true],
      ['127.0.0.1:1234', true],
      ['localhost', true],
      ['LOCALHOST:7777', true],
      ['[::1]:7777', true],
      ['[::1]', true],
      ['gonogo.example.com', true],
      ['gonogo.example.com:8443', true],
      ['GONOGO.Example.COM', true],
      ['evil.example', false],
      ['evil.example:7777', false],
      ['127.0.0.1.evil.example', false],
      ['localhost.', false],
      ['localhost.evil.example', false],
      ['0.0.0.0', false],
      ['[::2]', false],
      ['::1', false],
      ['127.0.0.1:abc', false],
      ['127.0.0.1:1:2', false],
      ['[::1', false],
      ['192.168.1.5', false],
    ])('Host %j: allowed is %s', async (host, allowed) => {
      const { port } = await startWeb();
      const res = await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: host } });
      expect(res.status).toBe(allowed ? 200 : 403);
      if (!allowed) {
        expect(res.body).toBe('forbidden host');
        expect(res.headers['content-type']).toBe('text/plain');
      }
    });

    it('answers 403 for a request with no Host header, or an empty one, on every kind of route', async () => {
      const { port } = await startWeb();
      for (const path of ['/api/state', '/', '/hook/ana/Stop', '/mcp']) {
        for (const request of [`GET ${path} HTTP/1.0\r\n\r\n`, `GET ${path} HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n`]) {
          const res = await rawRequest(port, request);
          expect(res.status, request).toBe(403);
          expect(res.body).toBe('forbidden host');
        }
      }
    });

    it('checks the Host before anything else, even for a path that would be a 404 or a 401', async () => {
      const { port } = await startWeb();
      for (const path of ['//', '/api/zzz', '/nothing.js', '/hook/x/y']) {
        const res = await send(port, { path, headers: { Host: 'evil.example' } });
        expect(res.status, path).toBe(403);
      }
    });

    describe('the name containers use for the host (Clean Room)', () => {
      const container = (port: number): Record<string, string> => ({ Host: `host.docker.internal:${port}` });

      it('reaches the hook and MCP endpoints, with the agent token as always', async () => {
        const { port, hubCalls } = await startWeb();
        const hook = await postHook(port, '/hook/ana/Stop', { headers: container(port) });
        expect(hook.status).toBe(200);
        expect(onHookCalls(hubCalls)).toHaveLength(1);
        expect((await postHook(port, '/hook/ana/Stop', { headers: container(port), token: null })).status).toBe(401);
        const mcp = await postMcp(port, { headers: container(port) });
        expect(mcp.status).toBe(200);
        expect((await postMcp(port, { headers: container(port), token: null })).status).toBe(401);
      });

      it.each(['HOST.DOCKER.INTERNAL', 'host.docker.internal'])('%s is the name with or without a port', async (host) => {
        const { port } = await startWeb();
        expect((await postHook(port, '/hook/ana/Stop', { headers: { Host: host } })).status).toBe(200);
      });

      it('reaches nothing else: not the API, the page, the WebSocket path or a path that does not parse', async () => {
        const dir = tmpDir();
        writeFileSync(join(dir, 'index.html'), '<title>x</title>');
        const { port } = await startWeb({ staticDir: dir });
        for (const path of ['/api/state', '/api/agents', '/', '/index.html', '/ws', '/nothing.js', '//', '/hooks', '/mcp/x', '/hook']) {
          const res = await send(port, { path, headers: { ...bearer(TOKEN), ...container(port) } });
          // /mcp/x and /hook are the agent endpoints with a bad shape: those are a 404 of the endpoint, never a page or the API
          const expected = ['/mcp/x', '/hook'].includes(path) ? 404 : 403;
          expect(res.status, path).toBe(expected);
          if (expected === 403) expect(res.body, path).toBe('forbidden host');
        }
      });

      it('a browser route is as strict as before: the browser token does not help, and neither does a WebSocket upgrade', async () => {
        const { port } = await startWeb();
        const state = await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), ...container(port) } });
        expect(state.status).toBe(403);
        const post = await send(port, { method: 'POST', path: '/api/agents', headers: { ...bearer(TOKEN), ...JSON_HEADERS, ...container(port) }, body: '{}' });
        expect(post.status).toBe(403);
        expect(await connectWs(port, { headers: container(port) })).toMatchObject({ kind: 'rejected', status: 403, body: 'forbidden host' });
      });

      it('a page still cannot use it: an Origin on a hook or MCP request is refused as before', async () => {
        const { port, hubCalls } = await startWeb();
        const res = await postHook(port, '/hook/ana/Stop', { headers: { ...container(port), Origin: `http://host.docker.internal:${port}` } });
        expect(res.status).toBe(403);
        expect(res.body).toBe('forbidden origin');
        expect(onHookCalls(hubCalls)).toEqual([]);
      });

      it('is no extra name for the allow-list: a similar name is still refused', async () => {
        const { port } = await startWeb();
        for (const host of ['host.docker.internal.evil.example', 'evil.host.docker.internal', 'host-docker-internal']) {
          expect((await postHook(port, '/hook/ana/Stop', { headers: { Host: host } })).status, host).toBe(403);
        }
      });
    });

    it('parses Host values: port stripped, brackets removed, lower case, nothing odd accepted', () => {
      expect(hostName('127.0.0.1:7777')).toBe('127.0.0.1');
      expect(hostName('LOCALHOST')).toBe('localhost');
      expect(hostName('[::1]:7777')).toBe('::1');
      expect(hostName('[::1]')).toBe('::1');
      expect(hostName(' gonogo.example.com:8443 ')).toBe('gonogo.example.com');
      for (const bad of ['', '   ', '[::1', '[]', '[]:1', '[::1]x', '::1', 'a:b', 'a:1:2', 'a:', ':80x']) expect(hostName(bad), bad).toBeNull();
    });
  });

  describe('Origin', () => {
    it('lets a request without Origin through and one whose Origin is this server', async () => {
      const { port } = await startWeb();
      expect((await send(port, { path: '/api/state', headers: bearer(TOKEN) })).status).toBe(200);
      const same = await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Origin: `http://127.0.0.1:${port}` } });
      expect(same.status).toBe(200);
      const v6 = await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: `[::1]:${port}`, Origin: `http://[::1]:${port}` } });
      expect(v6.status).toBe(200);
    });

    it.each([
      ['another site', 'https://evil.example'],
      ['null, as a sandboxed iframe sends it', 'null'],
      ['an empty value', ''],
      ['garbage', 'not a url at all'],
      ['two values', 'http://a.example, http://b.example'],
      ['the right host on another port', 'http://127.0.0.1:1'],
      ['localhost while the Host is 127.0.0.1', 'PORT_LOCALHOST'],
      ['a file page', 'file://'],
      ['the host of an allow-list entry while the Host is something else', 'https://gonogo.example.com'],
    ])('answers 403 forbidden origin for %s', async (_what, origin) => {
      const { port } = await startWeb();
      const value = origin === 'PORT_LOCALHOST' ? `http://localhost:${port}` : origin;
      const res = await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Origin: value } });
      expect(res.status).toBe(403);
      expect(res.body).toBe('forbidden origin');
      expect(res.headers['content-type']).toBe('text/plain');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('accepts the reverse proxy case: Host and Origin are the public name and the name is on the allow-list', async () => {
      const { port } = await startWeb();
      const ok = await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: 'gonogo.example.com', Origin: 'https://gonogo.example.com' } });
      expect(ok.status).toBe(200);
      const withPort = await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: 'gonogo.example.com:8443', Origin: 'https://gonogo.example.com:8443' } });
      expect(withPort.status).toBe(200);
      const mismatch = await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: 'gonogo.example.com', Origin: 'https://other.example.com' } });
      expect(mismatch.status).toBe(403);
      const unlisted = await startWeb({ allowedHosts: [] });
      const refused = await send(unlisted.port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: 'gonogo.example.com', Origin: 'https://gonogo.example.com' } });
      expect(refused.status).toBe(403);
      expect(refused.body).toBe('forbidden host');
    });

    it('applies to every method that is not a plain read of a static file', async () => {
      const dir = tmpDir();
      writeFileSync(join(dir, 'index.html'), '<title>x</title>');
      const { port } = await startWeb({ staticDir: dir });
      for (const origin of ['null', 'https://evil.example']) {
        expect((await send(port, { path: '/', headers: { Origin: origin } })).status).toBe(200);
        expect((await send(port, { path: '/', method: 'HEAD', headers: { Origin: origin } })).status).toBe(200);
        expect((await send(port, { path: '/', method: 'POST', headers: { Origin: origin } })).status).toBe(403);
      }
      expect((await send(port, { path: '/', method: 'POST' })).status).toBe(405);
    });
  });
});

/* ================================================================================================================
 * web: hostile input (contract 3.2)
 * ============================================================================================================== */

/** A site directory with an index, assets, a directory, and a file next to it that must never be served. */
function makeSite(): { dir: string; outside: string } {
  const parent = tmpDir();
  const dir = join(parent, 'site');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(parent, 'secret.txt'), 'top secret');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>gonogo</title><script type="module" src="./assets/app-abc.js"></script>');
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{margin:0}\n');
  writeFileSync(join(dir, 'assets', 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  writeFileSync(join(dir, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
  writeFileSync(join(dir, 'notes.txt'), 'plain notes');
  writeFileSync(join(dir, 'data.json'), '{"a":1}');
  writeFileSync(join(dir, 'font.woff2'), 'wOF2');
  writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'pic.png'), 'png');
  writeFileSync(join(dir, 'pic.jpg'), 'jpg');
  writeFileSync(join(dir, 'app.js.map'), '{}');
  writeFileSync(join(dir, 'blob.unknown'), 'x');
  return { dir, outside: join(parent, 'secret.txt') };
}

function rawGet(port: number, target: string, extra = ''): Promise<{ status: number; headers: string; body: string }> {
  return rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${extra}\r\n`);
}

describe('web: hostile input', () => {
  it.each([
    ['a double slash', '//'],
    ['a double slash and a bracket', '//['],
    ['a double slash and a host', '//evil.example/x'],
    ['bad percent-encoding', '/%E0%A4%A'],
    ['bad percent-encoding under /api', '/api/%E0%A4%A'],
    ['a lone percent sign', '/%'],
    ['an encoded NUL', '/%00'],
    ['an encoded NUL in the middle', '/index.html%00.png'],
    ['an encoded NUL under /api', '/api/state%00'],
    ['traversal', '/../../../../etc/passwd'],
    ['encoded traversal', '/%2e%2e/%2e%2e/etc/passwd'],
    ['traversal with an encoded slash', '/..%2f..%2f..%2fetc%2fpasswd'],
    ['traversal below assets', '/assets/%2e%2e/%2e%2e/secret.txt'],
    ['a sibling file through traversal', '/../secret.txt'],
    ['an encoded absolute path', '/%2Fetc%2Fpasswd'],
    ['a double slash inside /api', '/api//state'],
    ['a directory', '/assets'],
    ['a directory with a slash', '/assets/'],
    ['an absolute-form target', 'http://127.0.0.1/'],
    ['an asterisk', '*'],
    ['a target that does not start with a slash', 'index.html'],
  ])('answers a 4xx to %s and keeps serving', async (_what, target) => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    const res = await rawGet(port, target);
    expect(res.status, `${target}: ${res.headers}`).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toContain('top secret');
    expect(res.body).not.toContain('root:');
    await expectStillServing(port);
  });

  it('answers 404 to a raw NUL byte or a malformed request line, and keeps serving', async () => {
    const { port } = await startWeb();
    for (const bytes of ['GET /a\u0000b HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', 'GARBAGE\r\n\r\n', 'GET / HTTP/9.9\r\nHost: x\r\n\r\n', '\u0000\u0001\u0002\r\n\r\n']) {
      const res = await rawRequest(port, Buffer.from(bytes, 'latin1'));
      expect([0, 400, 403, 404, 505]).toContain(res.status);
    }
    await expectStillServing(port);
  });

  it('refuses Origin: null on /api, /hook, /mcp and /ws, and keeps serving', async () => {
    const { port } = await startWeb();
    expect((await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Origin: 'null' } })).status).toBe(403);
    expect((await postHook(port, '/hook/ana/Stop', { headers: { Origin: 'null' } })).status).toBe(403);
    expect((await postMcp(port, { headers: { Origin: 'null' } })).status).toBe(403);
    const upgrade = await upgradeStatus(port, { Origin: 'null', 'Sec-WebSocket-Protocol': `${WS_SUBPROTOCOL}, token.${TOKEN}` });
    expect(upgrade.status).toBe(403);
    expect(await connectWs(port, { headers: { Origin: 'null' } })).toMatchObject({ kind: 'rejected', status: 403 });
    await expectStillServing(port);
  });

  it('answers 401 to a 64 character bearer token that is not ASCII, in the header and in the WebSocket protocol', async () => {
    const { port } = await startWeb();
    const rest = await rawRequest(port, Buffer.from(`GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${'é'.repeat(64)}\r\nConnection: close\r\n\r\n`, 'latin1'));
    expect(rest.status).toBe(401);
    const hook = await rawRequest(port, Buffer.from(`POST /hook/ana/Stop HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${'é'.repeat(64)}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`, 'latin1'));
    expect(hook.status).toBe(401);
    const ws = await rawRequest(
      port,
      Buffer.from(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Protocol: ${WS_SUBPROTOCOL}, token.${'é'.repeat(64)}\r\n\r\n`,
        'latin1',
      ),
    );
    expect(ws.status).toBe(401);
    expect(ws.body).toBe('{"error":"unauthorized","code":"unauthorized"}');
    await expectStillServing(port);
  });

  it('survives clients that reset the connection at every stage', async () => {
    const dir = makeSite().dir;
    const { port } = await startWeb({ staticDir: dir });
    const upgradeRequest = (token: string): string =>
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Protocol: ${WS_SUBPROTOCOL}, token.${token}\r\n\r\n`;
    const stages: string[] = [
      '',
      'GET /api/st',
      `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`,
      `POST /api/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"to":`,
      `GET /assets/big.bin HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
      upgradeRequest('f'.repeat(64)),
      upgradeRequest(TOKEN),
    ];
    for (let round = 0; round < 6; round += 1) {
      for (const bytes of stages) {
        await new Promise<void>((resolve) => {
          const socket = netConnect({ host: '127.0.0.1', port }, () => {
            if (bytes !== '') socket.write(bytes);
            setTimeout(() => socket.resetAndDestroy(), round);
          });
          socket.on('error', () => undefined);
          socket.on('close', () => resolve());
        });
      }
    }
    await sleep(100);
    await expectStillServing(port);
    expect((await connectWs(port)).kind).toBe('open');
  });

  it('survives a client that vanishes in the middle of a big file', async () => {
    const dir = makeSite().dir;
    const { port } = await startWeb({ staticDir: dir });
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => {
        const socket = netConnect({ host: '127.0.0.1', port }, () => {
          socket.write(`GET /assets/big.bin HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
        });
        socket.once('data', () => socket.resetAndDestroy());
        socket.on('error', () => undefined);
        socket.on('close', () => resolve());
      });
    }
    await sleep(100);
    await expectStillServing(port);
  });

  it('answers a request with an enormous header, a thousand headers and a long path without dying', async () => {
    const { port } = await startWeb();
    const huge = await rawGet(port, '/', `X-Big: ${'a'.repeat(200_000)}\r\n`);
    expect([0, 400, 431]).toContain(huge.status);
    const many = await rawGet(port, '/', Array.from({ length: 3000 }, (_, i) => `X-${i}: 1\r\n`).join(''));
    expect([0, 400, 431]).toContain(many.status);
    const long = await rawGet(port, `/${'a'.repeat(100_000)}`);
    expect([0, 400, 414, 431]).toContain(long.status);
    await expectStillServing(port);
  });
});

/* ================================================================================================================
 * web: static client (contract 3.7)
 * ============================================================================================================== */

describe('web: static files', () => {
  it('serves index.html at / and /index.html without a token, with no-cache and the standing headers', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    for (const path of ['/', '/index.html', '/?x=1']) {
      const res = await send(port, { path });
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.body).toBe(readFileSync(join(dir, 'index.html'), 'utf8'));
    }
  });

  it('serves assets with the immutable cache header and the right type', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    const js = await send(port, { path: '/assets/app-abc.js?v=2' });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe('export const x = 1;\n');
    const css = await send(port, { path: '/assets/app.css' });
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it.each([
    ['/favicon.ico', 'image/x-icon'],
    ['/notes.txt', 'text/plain; charset=utf-8'],
    ['/data.json', 'application/json; charset=utf-8'],
    ['/font.woff2', 'font/woff2'],
    ['/logo.svg', 'image/svg+xml'],
    ['/pic.png', 'image/png'],
    ['/pic.jpg', 'image/jpeg'],
    ['/app.js.map', 'application/json; charset=utf-8'],
    ['/blob.unknown', 'application/octet-stream'],
  ])('types %s as %s and does not cache it for ever', async (path, type) => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    const res = await send(port, { path });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(type);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('answers HEAD with the headers and no body', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    const res = await send(port, { method: 'HEAD', path: '/assets/app-abc.js' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength('export const x = 1;\n')));
  });

  it('streams a big file whole', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    const res = await send(port, { path: '/assets/big.bin' });
    expect(res.status).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(3 * 1024 * 1024);
    expect(res.body.length).toBe(3 * 1024 * 1024);
  });

  it('gives index.html for a client route without an extension and 404 for a missing file with one', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    for (const path of ['/agents/ana', '/some/deep/route/', '/.well-known/thing', '/missing']) {
      const res = await send(port, { path });
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body).toContain('<title>gonogo</title>');
    }
    for (const path of ['/missing.js', '/assets/missing.js', '/.well-known/security.txt']) {
      const res = await send(port, { path });
      expect(res.status, path).toBe(404);
      expect(res.headers['content-type']).toBe('text/plain');
      expect(res.body).toBe('not found');
    }
  });

  it('never serves a directory, even one that exists', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    for (const path of ['/assets', '/assets/']) {
      const res = await send(port, { path });
      expect(res.status, path).toBe(404);
    }
    await expectStillServing(port);
  });

  it('never leaves the site directory', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    for (const target of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/%2Fetc%2Fpasswd', '/a/../../secret.txt']) {
      const res = await rawGet(port, target);
      expect(res.status, target).toBe(404);
      expect(res.body).not.toContain('top secret');
    }
    // a path that climbs and comes back inside is still inside
    const inside = await rawGet(port, '/assets/../index.html');
    expect(inside.status).toBe(200);
  });

  it('answers 404 for every static path when there is no static directory, and still serves the API', async () => {
    const { port } = await startWeb({ staticDir: null });
    for (const path of ['/', '/index.html', '/assets/x.js', '/some/route']) {
      const res = await send(port, { path });
      expect(res.status, path).toBe(404);
    }
    await expectStillServing(port);
  });

  it('answers 404 for / when the directory has no index.html', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'a.txt'), 'a');
    const { port } = await startWeb({ staticDir: dir });
    expect((await send(port, { path: '/' })).status).toBe(404);
    expect((await send(port, { path: '/route' })).status).toBe(404);
    expect((await send(port, { path: '/a.txt' })).status).toBe(200);
  });

  it('answers 405 with Allow for other methods and checks the Host', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await send(port, { method, path: '/index.html' });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
    }
    expect((await send(port, { path: '/', headers: { Host: 'evil.example' } })).status).toBe(403);
  });

  it('does not need the browser token', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    expect((await send(port, { path: '/' })).status).toBe(200);
    expect((await send(port, { path: '/api/state' })).status).toBe(401);
  });
});

/* ================================================================================================================
 * web: static requests that nobody waits for (EDGE-1: a descriptor per aborted request ended the whole process)
 * ============================================================================================================== */

/** Where this process lists its open descriptors, or null where it cannot (the tests are skipped there). */
const FD_DIR = ['/proc/self/fd', '/dev/fd'].find((dir) => existsSync(dir)) ?? null;

function openDescriptors(): number {
  return FD_DIR === null ? 0 : readdirSync(FD_DIR).length;
}

/** The count once it is back near `baseline`: a leak never goes away, a socket that is still closing does. */
async function settledDescriptors(baseline: number, margin: number): Promise<number> {
  const deadline = Date.now() + 5000;
  let count = openDescriptors();
  while (count > baseline + margin && Date.now() < deadline) {
    await sleep(25);
    count = openDescriptors();
  }
  return count;
}

/** A request written to a fresh socket, and the socket dropped (reset, or closed) at once or after the first bytes of the answer, as a page drops it when it is closed or navigated away. */
function droppedRequest(port: number, request: string, how: { reset: boolean; afterFirstData?: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => {
      const drop = (): void => {
        if (how.reset) socket.resetAndDestroy();
        else socket.destroy();
      };
      socket.write(request);
      if (how.afterFirstData === true) socket.once('data', drop);
      else drop();
    });
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => resolve());
  });
}

const staticRequest = (port: number, method: string, path: string, extra = ''): string => `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}\r\n`;

describe.skipIf(FD_DIR === null)('web: static requests that are dropped keep no descriptor', () => {
  // a few concurrent clients, thousands of requests: one leaked descriptor each used to end in EMFILE, and EMFILE in exit(1)
  const MARGIN = 16;

  it('however many are aborted before the answer, in the middle of it, or as HEAD and conditional requests', async () => {
    const { dir } = makeSite();
    const { port } = await startWeb({ staticDir: dir });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => void uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    cleanups.push(() => void process.off('uncaughtException', onUncaught));
    await send(port, { path: '/zzz' });
    await sleep(50);
    const baseline = openDescriptors();

    const conditional = 'If-None-Match: *\r\nIf-Modified-Since: Wed, 21 Oct 2037 07:28:00 GMT\r\nRange: bytes=0-9\r\n';
    const mix: Array<[string, string, string]> = [
      ['GET', '/zzz', ''], // a client route: two stats and then the index
      ['GET', '/agents/ana', ''],
      ['GET', '/index.html', ''],
      ['GET', '/assets/app-abc.js', ''],
      ['GET', '/index.html', conditional],
      ['HEAD', '/zzz', ''],
      ['HEAD', '/index.html', ''],
    ];
    let next = 0;
    const clients = Array.from({ length: 6 }, async () => {
      while (next < 4200) {
        const i = next;
        next += 1;
        const [method, path, extra] = mix[i % mix.length] ?? ['GET', '/', ''];
        await droppedRequest(port, staticRequest(port, method, path, extra), { reset: i % 2 === 0 });
      }
    });
    await Promise.all(clients);
    // the 3 MiB file is bigger than the socket buffers: the server is in the middle of it when the client goes
    let big = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (big < 200) {
          const i = big;
          big += 1;
          await droppedRequest(port, staticRequest(port, 'GET', '/assets/big.bin'), { reset: i % 2 === 0, afterFirstData: true });
        }
      }),
    );

    const count = await settledDescriptors(baseline, MARGIN);
    expect(count - baseline).toBeLessThanOrEqual(MARGIN);
    expect(uncaught).toEqual([]);
    await expectStillServing(port);
  }, 60_000);

  it('and none for a file it served whole, HEAD and conditional requests included', async () => {
    const { dir } = makeSite();
    writeFileSync(join(dir, 'empty.txt'), '');
    const { port } = await startWeb({ staticDir: dir });
    await send(port, { path: '/zzz' });
    await sleep(50);
    const baseline = openDescriptors();
    const agent = keepAliveAgent();
    for (let round = 0; round < 40; round += 1) {
      const answers = await Promise.all([
        send(port, { path: '/zzz', agent }),
        send(port, { path: '/assets/app-abc.js', agent }),
        send(port, { path: '/index.html', method: 'HEAD', agent }),
        send(port, { path: '/index.html', agent, headers: { 'If-None-Match': '*', Range: 'bytes=0-9' } }),
      ]);
      expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    }
    expect((await send(port, { path: '/assets/big.bin', agent })).body.length).toBe(3 * 1024 * 1024);
    const empty = await send(port, { path: '/empty.txt', agent });
    expect([empty.status, empty.headers['content-length'], empty.body]).toEqual([200, '0', '']);
    agent.destroy();
    expect((await settledDescriptors(baseline, MARGIN)) - baseline).toBeLessThanOrEqual(MARGIN);
  });
});

/* ================================================================================================================
 * web: binding
 * ============================================================================================================== */

function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

function ipv6LoopbackWorks(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

/** Some CI containers have no IPv6 loopback: the tests that need one are skipped there, not passed. */
const HAS_IPV6 = await ipv6LoopbackWorks();

describe('web: binding', () => {
  it('decides which bind hosts need a loopback twin for the agents', () => {
    for (const host of ['192.168.1.5', '100.64.0.7', '10.0.0.2', 'fd00::5', '[fd00::5]', 'myhost.local', '127.0.0.2']) {
      expect(needsLoopbackTwin(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '[::]', '127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
      expect(needsLoopbackTwin(host), host).toBe(false);
    }
  });

  it('listens on a free port and says which', async () => {
    const harness = await startWeb();
    expect(harness.port).toBeGreaterThan(0);
    await expect(harness.web.listen()).resolves.toEqual({ host: '127.0.0.1', port: harness.port });
  });

  it('rejects when the port is taken, and leaves nothing open', async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const address = blocker.address();
    const taken = typeof address === 'object' && address ? address.port : 0;
    const { hub } = makeHub();
    const web = createWebServer({
      host: '127.0.0.1',
      port: taken,
      browserToken: TOKEN,
      allowedHosts: [],
      staticDir: null,
      hub,
      terminals: makeTerminals().terms,
      resolveToken: () => null,
      info: () => INFO,
      isReady: () => true,
      log: nullLogger,
    });
    await expect(web.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(web.close()).resolves.toBeUndefined();
  });

  it('closes idempotently and refuses connections afterwards', async () => {
    const { web, port } = await startWeb();
    await web.close();
    await web.close();
    await expect(send(port, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('closes within about a second even when a client keeps a request open for ever', async () => {
    const { web, port } = await startWeb();
    const stuck = netConnect({ host: '127.0.0.1', port });
    stuck.on('error', () => undefined);
    // reading is what lets the socket see the other side go away
    stuck.resume();
    await new Promise<void>((resolve) => stuck.once('connect', () => resolve()));
    stuck.write(`POST /api/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 1000\r\n\r\n{"to"`);
    await sleep(50);
    const began = Date.now();
    await web.close();
    expect(Date.now() - began).toBeLessThan(3000);
    await waitFor(() => stuck.destroyed, 'the stuck connection to be closed');
  });

  it('allows loopback names only on a wildcard bind', async () => {
    const { port } = await startWeb({ host: '0.0.0.0' });
    expect((await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: `127.0.0.1:${port}` } })).status).toBe(200);
    expect((await send(port, { path: '/api/state', headers: { ...bearer(TOKEN), Host: `0.0.0.0:${port}` } })).status).toBe(403);
  });

  it.skipIf(lanAddress() === null)('also answers on 127.0.0.1 when the bind host is a specific address, and accepts that address as a Host', async () => {
    const lan = lanAddress() ?? '';
    const { web, port } = await startWeb({ host: lan });
    await expect(web.listen()).resolves.toEqual({ host: lan, port });
    for (const host of [lan, '127.0.0.1']) {
      const res = await send(port, { host, path: '/api/state', headers: bearer(TOKEN) });
      expect(res.status, host).toBe(200);
    }
    expect((await send(port, { host: '127.0.0.1', path: '/api/state', headers: { ...bearer(TOKEN), Host: '10.9.9.9' } })).status).toBe(403);
    expect((await connectWs(port)).kind).toBe('open');
    await web.close();
    await expect(send(port, { host: lan, path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(send(port, { host: '127.0.0.1', path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it.skipIf(lanAddress() === null)('closes the first listener when the 127.0.0.1 listener cannot bind', async () => {
    const lan = lanAddress() ?? '';
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const address = blocker.address();
    const taken = typeof address === 'object' && address ? address.port : 0;
    const { hub } = makeHub();
    const web = createWebServer({
      host: lan,
      port: taken,
      browserToken: TOKEN,
      allowedHosts: [],
      staticDir: null,
      hub,
      terminals: makeTerminals().terms,
      resolveToken: () => null,
      info: () => INFO,
      isReady: () => true,
      log: nullLogger,
    });
    await expect(web.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(send(taken, { host: lan, path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await web.close();
  });

  it.skipIf(!HAS_IPV6)('binds ::1 when asked to, and accepts [::1] as the Host', async () => {
    const { port, web } = await startWeb({ host: '::1' });
    await expect(web.listen()).resolves.toEqual({ host: '::1', port });
    const res = await send(port, { host: '::1', path: '/api/state', headers: { ...bearer(TOKEN), Host: `[::1]:${port}` } });
    expect(res.status).toBe(200);
    // ::1 is a loopback address: no second listener on 127.0.0.1
    await expect(send(port, { host: '127.0.0.1', path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

/* ================================================================================================================
 * web: WebSocket (contract 3.4)
 * ============================================================================================================== */

function agentFrame(name: string, over: Partial<AgentView> = {}): HubEvent {
  return { t: 'agent', agent: agentView(name, over) };
}

describe('web: WebSocket handshake', () => {
  it('accepts the token in the subprotocol, selects gonogo.v1 only, and never echoes the secret', async () => {
    const { port } = await startWeb();
    const accepted = await upgradeStatus(port, { 'Sec-WebSocket-Protocol': `${WS_SUBPROTOCOL}, token.${TOKEN}` });
    expect(accepted.status).toBe(101);
    expect(accepted.headers['sec-websocket-protocol']).toBe(WS_SUBPROTOCOL);
    expect(JSON.stringify(accepted.headers)).not.toContain(TOKEN);
    const client = await openWs(port);
    expect(client.ws.protocol).toBe(WS_SUBPROTOCOL);
  });

  it('sends the state first: agents, activity and info', async () => {
    const views = [agentView('flight'), agentView('ana')];
    const activity = [{ ...message('m1'), truncated: false }];
    const { port } = await startWeb({}, { views: () => views, activity: () => activity });
    const client = await openWs(port);
    expect(client.frames[0]).toEqual({ t: 'state', state: { agents: views, activity, info: INFO, poll: null, governor: { limit: null, working: 1, holding: 0 }, propellant: NO_PROPELLANT_VIEW, schedules: [], uplinks: [], tasks: [], missions: [], downlink: { unread: 0, items: [] } } });
  });

  it('answers 401 with the ApiError body when the token is not in the subprotocol, and refuses ?token=', async () => {
    const { port } = await startWeb();
    const attempts: WsOptions[] = [
      { protocols: null },
      { protocols: [WS_SUBPROTOCOL] },
      { protocols: [WS_SUBPROTOCOL, 'token.'] },
      { protocols: [WS_SUBPROTOCOL, `token.${'f'.repeat(64)}`] },
      { protocols: [WS_SUBPROTOCOL, `tokens.${TOKEN}`] },
      { protocols: [`token.${TOKEN.slice(0, 63)}`, WS_SUBPROTOCOL] },
      { protocols: null, path: `/ws?token=${TOKEN}` },
      { token: ANA_TOKEN },
    ];
    for (const options of attempts) {
      const outcome = await connectWs(port, options);
      expect(outcome, JSON.stringify(options)).toMatchObject({ kind: 'rejected', status: 401, body: '{"error":"unauthorized","code":"unauthorized"}' });
    }
    const upgrade = await upgradeStatus(port, {});
    expect(upgrade.status).toBe(401);
    expect(upgrade.headers['www-authenticate']).toBe('Bearer');
    await expectStillServing(port);
  });

  it('refuses a foreign Host and a foreign or unparseable Origin, and accepts the server itself', async () => {
    const { port } = await startWeb();
    expect(await connectWs(port, { headers: { Host: 'evil.example' } })).toMatchObject({ kind: 'rejected', status: 403, body: 'forbidden host' });
    for (const origin of ['https://evil.example', 'null', '', 'garbage', `http://localhost:${port}`]) {
      expect(await connectWs(port, { headers: { Origin: origin } }), origin).toMatchObject({ kind: 'rejected', status: 403, body: 'forbidden origin' });
    }
    expect((await connectWs(port, { headers: { Origin: `http://127.0.0.1:${port}` } })).kind).toBe('open');
    expect((await connectWs(port)).kind).toBe('open');
    const proxied = await startWeb();
    expect((await connectWs(proxied.port, { headers: { Host: 'gonogo.example.com', Origin: 'https://gonogo.example.com' } })).kind).toBe('open');
  });

  it('answers 404 for an upgrade to any other path and 405 for a method other than GET', async () => {
    const { port } = await startWeb();
    for (const path of ['/', '/api/state', '/ws/x', '/wsx', '/hook/ana/Stop', '/mcp']) {
      const res = await upgradeStatus(port, { 'Sec-WebSocket-Protocol': `${WS_SUBPROTOCOL}, token.${TOKEN}` }, path);
      expect(res.status, path).toBe(404);
    }
    const post = await rawRequest(port, `POST /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nContent-Length: 0\r\n\r\n`);
    expect(post.status).toBe(405);
    await expectStillServing(port);
  });

  it('answers 400 to an upgrade that is not a WebSocket upgrade or is malformed, and keeps serving', async () => {
    const { port } = await startWeb();
    const protocol = { 'Sec-WebSocket-Protocol': `${WS_SUBPROTOCOL}, token.${TOKEN}` };
    for (const headers of [
      { ...protocol, Upgrade: 'h2c' },
      { ...protocol, Upgrade: 'websocket', 'Sec-WebSocket-Key': 'not base64 of 16 bytes' },
      { ...protocol, 'Sec-WebSocket-Version': '7' },
    ]) {
      const res = await upgradeStatus(port, headers);
      expect([400, 426]).toContain(res.status);
    }
    await expectStillServing(port);
    expect((await connectWs(port)).kind).toBe('open');
  });

  it('answers a plain GET of /ws, which is not an upgrade, with 401 or 400', async () => {
    const { port } = await startWeb();
    expect((await send(port, { path: '/ws' })).status).toBe(401);
    const withToken = await send(port, { path: '/ws', headers: bearer(TOKEN) });
    expect(withToken.status).toBe(400);
    expect(withToken.json()).toMatchObject({ code: 'bad_request' });
    expect((await send(port, { path: '/ws', method: 'POST', headers: bearer(TOKEN) })).status).toBe(405);
  });
});

describe('web: WebSocket frames', () => {
  it('broadcasts hub events to every connected socket, unchanged', async () => {
    const { port, web } = await startWeb();
    const a = await openWs(port);
    const b = await openWs(port);
    const gone = await openWs(port);
    gone.ws.close();
    await gone.closed;
    const events: HubEvent[] = [
      agentFrame('ana', { state: 'working' }),
      { t: 'agent-removed', name: 'ben' },
      { t: 'activity', item: { ...message('m5'), truncated: false } },
      { t: 'poll', poll: pollView({ status: 'go', note: 'all go' }) },
      { t: 'poll', poll: null },
      { t: 'governor', governor: { limit: 2, working: 2, holding: 1 } },
    ];
    for (const event of events) web.broadcast(event);
    for (const client of [a, b]) {
      await waitFor(() => client.frames.length >= 7, 'the six events');
      expect(client.frames.slice(1)).toEqual(events);
    }
    web.broadcast({ t: 'agent-removed', name: 'nobody-listens' });
  });

  it('does not let a broadcast throw into the hub', async () => {
    const { port, web, } = await startWeb();
    await openWs(port);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => web.broadcast(cyclic as unknown as HubEvent)).not.toThrow();
  });

  describe('attach', () => {
    it('sends the snapshot, then starts the attachment, then binary frames with the 5 byte header', async () => {
      const { port, fake } = await startWeb();
      fake.state.onStart = (a) => a.listener(new Uint8Array([104, 105]));
      const client = await openWs(port);
      client.send({ t: 'attach', seq: 7, agent: 'ana', cols: 120, rows: 40 });
      const snapshot = await client.waitFrame((f) => f.t === 'snapshot', 'the snapshot');
      expect(snapshot).toEqual({ t: 'snapshot', seq: 7, agent: 'ana', generation: 3, cols: 120, rows: 40, running: true, data: 'screen of ana' });
      const [first] = await client.waitBinary(1);
      expect([...(first ?? [])]).toEqual([WS_BINARY_OUTPUT, 0, 0, 0, 7, 104, 105]);
      // what start() delivered came after the snapshot, not before it
      expect(client.order).toEqual(['text:state', 'text:snapshot', 'binary']);
      fake.push('ana', new Uint8Array([1, 2, 3]));
      const frames = await client.waitBinary(2);
      expect([...(frames[1] ?? [])]).toEqual([WS_BINARY_OUTPUT, 0, 0, 0, 7, 1, 2, 3]);
    });

    it('writes the sequence number as an unsigned 32 bit big endian number', async () => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      client.send({ t: 'attach', seq: 0xdeadbeef, agent: 'ana' });
      await client.waitFrame((f) => f.t === 'snapshot', 'the snapshot');
      fake.push('ana', new Uint8Array([9]));
      const [frame] = await client.waitBinary(1);
      expect(frame?.readUInt32BE(1)).toBe(0xdeadbeef);
      client.send({ t: 'attach', seq: 0, agent: 'ana' });
      await waitFor(() => client.frameCount('snapshot') === 2, 'the second snapshot');
      fake.push('ana', new Uint8Array([9]));
      const frames = await client.waitBinary(2);
      expect(frames[1]?.readUInt32BE(1)).toBe(0);
    });

    it('snapshots a stopped agent as not running', async () => {
      const { port } = await startWeb();
      const client = await openWs(port);
      client.send({ t: 'attach', seq: 1, agent: 'ben' });
      expect(await client.waitFrame((f) => f.t === 'snapshot', 'the snapshot')).toMatchObject({ agent: 'ben', running: false, generation: 0 });
    });

    it('answers an unknown agent with an error frame and keeps the socket', async () => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      for (const agent of ['ghost', 'Ana', '../x', '']) {
        client.send({ t: 'attach', seq: 1, agent });
      }
      await waitFor(() => client.frameCount('error') === 4, 'four errors');
      for (const frame of client.frames.filter((f) => f.t === 'error')) expect(frame).toEqual({ t: 'error', message: 'unknown agent', ref: 'attach' });
      expect(fake.attachments).toEqual([]);
    });

    it.each([
      ['a seq that is a string', { seq: '1' }],
      ['a negative seq', { seq: -1 }],
      ['a fractional seq', { seq: 1.5 }],
      ['a seq over 32 bits', { seq: 2 ** 32 }],
      ['a missing seq', {}],
      ['an agent that is not a string', { seq: 1, agent: 5 }],
    ])('answers a bad frame for %s', async (_what, fields) => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      client.send({ t: 'attach', agent: 'ana', ...fields });
      expect(await client.waitFrame((f) => f.t === 'error', 'the error')).toEqual({ t: 'error', message: 'bad frame', ref: 'attach' });
      expect(fake.attachments).toEqual([]);
    });

    it('detaches the previous attachment when the socket attaches to another agent, and sends nothing from the old one', async () => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      client.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => client.frameCount('snapshot') === 1, 'the first snapshot');
      client.send({ t: 'attach', seq: 2, agent: 'flight' });
      await waitFor(() => client.frameCount('snapshot') === 2, 'the second snapshot');
      expect(fake.attachments.map((a) => [a.name, a.started, a.detached])).toEqual([['ana', true, true], ['flight', true, false]]);
      fake.push('ana', new Uint8Array([1]));
      fake.push('flight', new Uint8Array([2]));
      const frames = await client.waitBinary(1);
      await sleep(30);
      expect(frames).toHaveLength(1);
      expect([...(frames[0] ?? [])]).toEqual([WS_BINARY_OUTPUT, 0, 0, 0, 2, 2]);
    });

    it('detaches on a detach frame and refuses input afterwards', async () => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      client.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => client.frameCount('snapshot') === 1, 'the snapshot');
      client.send({ t: 'detach' });
      await waitFor(() => fake.attachments[0]?.detached === true, 'the detach');
      fake.push('ana', new Uint8Array([1]));
      client.send({ t: 'input', agent: 'ana', data: 'x' });
      expect(await client.waitFrame((f) => f.t === 'error', 'the error')).toEqual({ t: 'error', message: 'not attached to that agent', ref: 'input' });
      expect(client.binaries).toEqual([]);
      expect(fake.calls.filter((c) => c.fn === 'write')).toEqual([]);
    });

    it('detaches when the socket closes', async () => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      client.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => client.frameCount('snapshot') === 1, 'the snapshot');
      client.ws.close();
      await client.closed;
      await waitFor(() => fake.attachments[0]?.detached === true, 'the detach');
    });

    it('drops an attach that a newer attach overtook, without a snapshot, and detaches it', async () => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      const slow = fake.holdNextAttach();
      client.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => fake.attachments.length === 1, 'the first attach to arrive');
      client.send({ t: 'attach', seq: 2, agent: 'flight' });
      await waitFor(() => client.frameCount('snapshot') === 1, 'the second snapshot');
      slow.release();
      await waitFor(() => fake.attachments[0]?.detached === true, 'the stale attachment to be detached');
      await sleep(30);
      expect(client.frames.filter((f) => f.t === 'snapshot').map((f) => f.seq)).toEqual([2]);
      expect(fake.attachments[0]?.started).toBe(false);
    });

    it('drops an attach whose socket closed meanwhile and detaches it', async () => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      const slow = fake.holdNextAttach();
      client.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => fake.attachments.length === 1, 'the attach to arrive');
      client.ws.close();
      await client.closed;
      // the server sees its end of the connection close a moment after the client does
      await sleep(100);
      slow.release();
      await waitFor(() => fake.attachments[0]?.detached === true, 'the attachment to be detached');
      expect(fake.attachments[0]?.started).toBe(false);
    });

    it('survives a terminal host that rejects the attach, and tells the client', async () => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      const original = fake.terms.attach;
      fake.terms.attach = async () => {
        throw new Error('mirror gone');
      };
      client.send({ t: 'attach', seq: 1, agent: 'ana' });
      expect(await client.waitFrame((f) => f.t === 'error', 'the error')).toEqual({ t: 'error', message: 'could not attach', ref: 'attach' });
      fake.terms.attach = original;
      client.send({ t: 'attach', seq: 2, agent: 'ana' });
      await waitFor(() => client.frameCount('snapshot') === 1, 'a snapshot after the failure');
    });
  });

  describe('input', () => {
    const attached = async (port: number, agent = 'ana', size?: { cols: number; rows: number }): Promise<WsClient> => {
      const client = await openWs(port);
      client.send({ t: 'attach', seq: 1, agent, ...size });
      await waitFor(() => client.frameCount('snapshot') === 1, 'the snapshot');
      return client;
    };

    it('writes to the attached agent and tells the hub, in that order', async () => {
      const { port, fake, hubCalls } = await startWeb();
      const client = await attached(port);
      client.send({ t: 'input', agent: 'ana', data: 'hello\r' });
      await waitFor(() => hubCalls.some((c) => c.fn === 'onUserInput'), 'the hub call');
      expect(fake.calls.filter((c) => c.fn === 'write').map((c) => c.args)).toEqual([['ana', 'hello\r']]);
      expect(hubCalls.filter((c) => c.fn === 'onUserInput').map((c) => c.args)).toEqual([['ana', 'hello\r']]);
    });

    it('refuses input for an agent that is not the attached one, or before any attach', async () => {
      const { port, fake, hubCalls } = await startWeb();
      const fresh = await openWs(port);
      fresh.send({ t: 'input', agent: 'ana', data: 'x' });
      const client = await attached(port, 'ana');
      client.send({ t: 'input', agent: 'flight', data: 'x' });
      for (const c of [fresh, client]) {
        expect(await c.waitFrame((f) => f.t === 'error', 'the error')).toEqual({ t: 'error', message: 'not attached to that agent', ref: 'input' });
      }
      expect(fake.calls.filter((c) => c.fn === 'write')).toEqual([]);
      expect(hubCalls.filter((c) => c.fn === 'onUserInput')).toEqual([]);
    });

    it('writes binary input as latin1 bytes and gives the hub the same string', async () => {
      const { port, fake, hubCalls } = await startWeb();
      const client = await attached(port);
      const data = '\x1b[M \x21\x22éÿ';
      client.send({ t: 'input', agent: 'ana', data, binary: true });
      await waitFor(() => hubCalls.some((c) => c.fn === 'onUserInput'), 'the hub call');
      const written = fake.calls.find((c) => c.fn === 'write')?.args[1];
      expect(Buffer.isBuffer(written)).toBe(true);
      expect([...(written as Buffer)]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0x21, 0x22, 0xe9, 0xff]);
      expect(hubCalls.find((c) => c.fn === 'onUserInput')?.args).toEqual(['ana', data]);
    });

    it('does not tell the hub about input the terminal did not take', async () => {
      const { port, fake, hubCalls } = await startWeb();
      const client = await attached(port);
      fake.state.writeResult = false;
      client.send({ t: 'input', agent: 'ana', data: 'lost' });
      client.send({ t: 'input', agent: 'ana' });
      await client.waitFrame((f) => f.t === 'error', 'the error for the malformed frame');
      expect(fake.calls.filter((c) => c.fn === 'write')).toHaveLength(1);
      expect(hubCalls.filter((c) => c.fn === 'onUserInput')).toEqual([]);
    });

    it('keeps the socket when the hub throws', async () => {
      let first = true;
      const { port, fake, hubCalls } = await startWeb({}, {
        onUserInput: () => {
          if (first) {
            first = false;
            throw new Error('hub broke');
          }
          return 'none';
        },
      });
      const client = await attached(port);
      client.send({ t: 'input', agent: 'ana', data: 'a' });
      client.send({ t: 'input', agent: 'ana', data: 'b' });
      await waitFor(() => fake.calls.filter((c) => c.fn === 'write').length === 2, 'both writes');
      expect(hubCalls).toEqual([]);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });

    it.each([
      ['no data', { agent: 'ana' }],
      ['data that is not a string', { agent: 'ana', data: 5 }],
      ['binary that is not a boolean', { agent: 'ana', data: 'x', binary: 'yes' }],
      ['no agent', { data: 'x' }],
    ])('answers a bad frame for %s', async (_what, fields) => {
      const { port, fake } = await startWeb();
      const client = await attached(port);
      client.send({ t: 'input', ...fields });
      expect(await client.waitFrame((f) => f.t === 'error', 'the error')).toEqual({ t: 'error', message: 'bad frame', ref: 'input' });
      expect(fake.calls.filter((c) => c.fn === 'write')).toEqual([]);
    });

    it('writes a 300 KB paste that the client split into pieces of WS_INPUT_CHUNK_CHARS, all of it, in order', async () => {
      const { port, fake } = await startWeb();
      const client = await attached(port);
      const paste = Array.from({ length: 300_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
      let pieces = 0;
      for (let at = 0; at < paste.length; at += WS_INPUT_CHUNK_CHARS) {
        client.send({ t: 'input', agent: 'ana', data: paste.slice(at, at + WS_INPUT_CHUNK_CHARS) });
        pieces += 1;
      }
      expect(pieces).toBe(10);
      await waitFor(() => fake.calls.filter((c) => c.fn === 'write').length === pieces, 'every piece to be written');
      expect(fake.calls.filter((c) => c.fn === 'write').map((c) => c.args[1]).join('')).toBe(paste);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('size', () => {
    let effect: InputEffect = 'none';
    beforeEach(() => {
      effect = 'none';
    });
    const sized = (): Partial<Hub> => ({ onUserInput: () => effect });
    const sizeFrames = (c: WsClient): Frame[] => c.frames.filter((f) => f.t === 'size');
    const attach = async (port: number, seq: number, size?: { cols: number; rows: number }): Promise<WsClient> => {
      const client = await openWs(port);
      client.send({ t: 'attach', seq, agent: 'ana', ...size });
      await waitFor(() => client.frameCount('snapshot') === 1, 'the snapshot');
      return client;
    };
    /** Round trip through the socket: everything sent before it has been handled when this returns. */
    const settle = async (c: WsClient): Promise<void> => {
      const before = c.frameCount('error');
      c.send({ t: 'size?' });
      await waitFor(() => c.frameCount('error') > before, 'the settle marker');
    };
    const resizes = (fake: FakeTerminals): unknown[][] => fake.calls.filter((c) => c.fn === 'resize').map((c) => c.args);

    it('resizes the pty to the size of an attach and tells the sockets that were already attached', async () => {
      const { port, fake } = await startWeb({}, sized());
      const first = await attach(port, 1);
      expect(resizes(fake)).toEqual([]);
      const second = await attach(port, 2, { cols: 100, rows: 30 });
      expect(resizes(fake)).toEqual([['ana', 100, 30]]);
      await waitFor(() => sizeFrames(first).length === 1, 'the size frame');
      expect(sizeFrames(first)[0]).toEqual({ t: 'size', agent: 'ana', cols: 100, rows: 30 });
      // the socket that attached learns the size from its snapshot, which already holds it
      expect(second.frames.find((f) => f.t === 'snapshot')).toMatchObject({ cols: 100, rows: 30 });
      await settle(second);
      expect(sizeFrames(second)).toEqual([]);
    });

    it('does not resize for an attach without a size, or with a size the pty already has, or for a stopped agent', async () => {
      const { port, fake } = await startWeb({}, sized());
      await attach(port, 1, { cols: 120, rows: 40 });
      await attach(port, 2);
      const stopped = await openWs(port);
      stopped.send({ t: 'attach', seq: 1, agent: 'ben', cols: 90, rows: 20 });
      await waitFor(() => stopped.frameCount('snapshot') === 1, 'the snapshot');
      expect(resizes(fake)).toEqual([]);
    });

    it('resizes on a resize frame and tells every socket attached to that agent, the sender included', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1);
      const b = await attach(port, 2);
      const elsewhere = await openWs(port);
      elsewhere.send({ t: 'attach', seq: 3, agent: 'flight' });
      await waitFor(() => elsewhere.frameCount('snapshot') === 1, 'the snapshot');
      b.send({ t: 'resize', agent: 'ana', cols: 140, rows: 45 });
      for (const c of [a, b]) {
        await waitFor(() => sizeFrames(c).length === 1, 'the size frame');
        expect(sizeFrames(c)[0]).toEqual({ t: 'size', agent: 'ana', cols: 140, rows: 45 });
      }
      await settle(elsewhere);
      expect(sizeFrames(elsewhere)).toEqual([]);
      expect(resizes(fake)).toEqual([['ana', 140, 45]]);
    });

    it('sends nothing when the size did not change', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1);
      a.send({ t: 'resize', agent: 'ana', cols: 120, rows: 40 });
      await settle(a);
      expect(resizes(fake)).toEqual([]);
      a.send({ t: 'resize', agent: 'ana', cols: 100, rows: 30 });
      await waitFor(() => sizeFrames(a).length === 1, 'the size frame');
      a.send({ t: 'resize', agent: 'ana', cols: 100, rows: 30 });
      await settle(a);
      expect(sizeFrames(a)).toHaveLength(1);
      expect(resizes(fake)).toEqual([['ana', 100, 30]]);
    });

    it('lets a keystroke take the size back, and lets focus, mouse and terminal replies leave it alone', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1, { cols: 100, rows: 30 });
      const b = await attach(port, 2, { cols: 140, rows: 45 });
      await waitFor(() => sizeFrames(a).length === 1, 'the size frame of the second attach');
      expect(resizes(fake)).toEqual([['ana', 100, 30], ['ana', 140, 45]]);
      for (const data of ['\x1b[I', '\x1b[<35;10;5M', '\x1b[?1;2c', '\x1b[12;40R']) {
        effect = 'none';
        a.send({ t: 'input', agent: 'ana', data });
      }
      await settle(a);
      expect(resizes(fake)).toHaveLength(2);
      effect = 'set';
      a.send({ t: 'input', agent: 'ana', data: 'x' });
      await waitFor(() => resizes(fake).length === 3, 'a keystroke to take the size');
      expect(resizes(fake)[2]).toEqual(['ana', 100, 30]);
      for (const c of [a, b]) await waitFor(() => sizeFrames(c).at(-1)?.cols === 100, 'the size frame of the keystroke');
      effect = 'clear';
      b.send({ t: 'input', agent: 'ana', data: '\r' });
      await waitFor(() => resizes(fake).length === 4, 'Enter to take the size');
      expect(resizes(fake)[3]).toEqual(['ana', 140, 45]);
      expect(sizeFrames(a).at(-1)).toEqual({ t: 'size', agent: 'ana', cols: 140, rows: 45 });
    });

    it('takes nothing for a keystroke from a socket that never sent a size, and writes it all the same', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1, { cols: 100, rows: 30 });
      const quiet = await attach(port, 2);
      await waitFor(() => sizeFrames(quiet).length === 0 && resizes(fake).length === 1, 'the first resize');
      effect = 'set';
      quiet.send({ t: 'input', agent: 'ana', data: 'x' });
      await waitFor(() => fake.calls.some((c) => c.fn === 'write'), 'the write');
      await settle(quiet);
      expect(resizes(fake)).toHaveLength(1);
      void a;
    });

    it('clamps a resize to the allowed range and refuses anything that is not a pair of integers', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1);
      a.send({ t: 'resize', agent: 'ana', cols: 5, rows: 1 });
      await waitFor(() => resizes(fake).length === 1, 'the first resize');
      a.send({ t: 'resize', agent: 'ana', cols: 99999, rows: 99999 });
      await waitFor(() => resizes(fake).length === 2, 'the second resize');
      expect(resizes(fake)).toEqual([['ana', MIN_COLS, MIN_ROWS], ['ana', MAX_COLS, 200]]);
      const bad: unknown[] = [{ cols: 80.5, rows: 24 }, { cols: '80', rows: 24 }, { cols: 80 }, {}, { cols: null, rows: null }, { cols: NaN, rows: 24 }];
      for (const fields of bad) a.send({ t: 'resize', agent: 'ana', ...(fields as object) });
      await waitFor(() => a.frameCount('error') === bad.length, 'an error per bad frame');
      for (const frame of a.frames.filter((f) => f.t === 'error')) expect(frame).toMatchObject({ t: 'error', ref: 'resize' });
      expect(resizes(fake)).toHaveLength(2);
    });

    it('refuses a resize for an agent the socket is not attached to', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1);
      a.send({ t: 'resize', agent: 'flight', cols: 100, rows: 30 });
      a.send({ t: 'resize', cols: 100, rows: 30 });
      const fresh = await openWs(port);
      fresh.send({ t: 'resize', agent: 'ana', cols: 100, rows: 30 });
      await waitFor(() => a.frameCount('error') === 2 && fresh.frameCount('error') === 1, 'the errors');
      for (const frame of [...a.frames, ...fresh.frames].filter((f) => f.t === 'error')) {
        expect(frame).toEqual({ t: 'error', message: 'not attached to that agent', ref: 'resize' });
      }
      expect(resizes(fake)).toEqual([]);
    });

    it('sends no size frame when the terminal host did not change the size (a pty whose child just exited)', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1);
      const b = await attach(port, 2);
      fake.terms.resize = (name, cols, rows) => {
        fake.calls.push({ fn: 'resize', args: [name, cols, rows] });
        return false;
      };
      a.send({ t: 'resize', agent: 'ana', cols: 100, rows: 30 });
      await settle(a);
      await settle(b);
      expect(resizes(fake)).toEqual([['ana', 100, 30]]);
      expect(sizeFrames(a)).toEqual([]);
      expect(sizeFrames(b)).toEqual([]);
      expect(fake.sizes.get('ana')).toMatchObject({ cols: 120, rows: 40 });
    });

    it('does not resize when the pty has stopped, and sends no size frame for it', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1);
      const entry = fake.sizes.get('ana');
      if (entry) entry.running = false;
      a.send({ t: 'resize', agent: 'ana', cols: 100, rows: 30 });
      await settle(a);
      expect(resizes(fake)).toEqual([]);
      expect(sizeFrames(a)).toEqual([]);
    });

    it('leaves the size alone when the socket that took it closes', async () => {
      const { port, fake } = await startWeb({}, sized());
      const a = await attach(port, 1, { cols: 100, rows: 30 });
      const b = await attach(port, 2, { cols: 140, rows: 45 });
      await waitFor(() => sizeFrames(a).length === 1, 'the size frame');
      b.ws.close();
      await b.closed;
      effect = 'none';
      a.send({ t: 'input', agent: 'ana', data: '\x1b[I' });
      await settle(a);
      expect(resizes(fake)).toEqual([['ana', 100, 30], ['ana', 140, 45]]);
      expect(fake.sizes.get('ana')).toMatchObject({ cols: 140, rows: 45 });
      expect(sizeFrames(a)).toHaveLength(1);
    });
  });

  describe('limits and liveness', () => {
    it.each([
      ['text that is not JSON', 'not json'],
      ['an array', '[]'],
      ['a number', '1'],
      ['null', 'null'],
      ['a string', '"attach"'],
      ['an object with no t', '{}'],
      ['a t that is not a string', '{"t":5}'],
      ['an unknown t', '{"t":"nope"}'],
      ['a frame type of the server', '{"t":"snapshot"}'],
    ])('answers %s with a bad frame error and keeps the socket open', async (_what, text) => {
      const { port, fake } = await startWeb();
      const client = await openWs(port);
      client.ws.send(text);
      expect(await client.waitFrame((f) => f.t === 'error', 'the error')).toEqual({ t: 'error', message: 'bad frame', ref: 'frame' });
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      client.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => client.frameCount('snapshot') === 1, 'a snapshot after the bad frame');
      expect(fake.attachments).toHaveLength(1);
    });

    it('closes a socket that sends text that is not UTF-8 with 1007, and the server survives', async () => {
      const { port } = await startWeb();
      const client = await openWs(port);
      client.ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false });
      expect(await client.closed).toBe(1007);
      await expectStillServing(port);
      expect((await openWs(port)).ws.readyState).toBe(WebSocket.OPEN);
    });

    it('answers a frame that is nested too deep for JSON.parse with a bad frame error', async () => {
      const { port } = await startWeb();
      const client = await openWs(port);
      client.ws.send('['.repeat(200_000));
      expect(await client.waitFrame((f) => f.t === 'error', 'the error')).toEqual({ t: 'error', message: 'bad frame', ref: 'frame' });
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('answers a REST or hook body that is nested too deep with a 400', async () => {
      const { port } = await startWeb();
      const deep = '['.repeat(200_000);
      expect((await send(port, { method: 'POST', path: '/api/messages', headers: { ...bearer(TOKEN), ...JSON_HEADERS }, body: deep })).status).toBe(400);
      expect((await postHook(port, '/hook/ana/Stop', { body: deep })).status).toBe(400);
      expect((await postMcp(port, { body: deep })).status).toBe(400);
      await expectStillServing(port);
    });

    it('survives a terminal host whose detach throws, and one whose output listener is given rubbish', async () => {
      const { log, lines } = collectingLog();
      const { port, fake } = await startWeb({ log });
      const original = fake.terms.attach;
      fake.terms.attach = async (name, listener) => {
        const attachment = await original(name, listener);
        return {
          ...attachment,
          detach: () => {
            attachment.detach();
            throw new Error('detach broke');
          },
        };
      };
      const client = await openWs(port);
      client.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => client.frameCount('snapshot') === 1, 'the snapshot');
      fake.push('ana', undefined as unknown as Uint8Array);
      client.ws.close();
      await client.closed;
      await waitFor(() => lines.some((l) => l.includes('terminal detach failed')), 'the detach failure to be logged');
      expect(lines.some((l) => l.includes('terminal output could not be sent'))).toBe(true);
      await expectStillServing(port);
    });

    it('answers a binary frame from the client with a bad frame error', async () => {
      const { port } = await startWeb();
      const client = await openWs(port);
      client.ws.send(Buffer.from([1, 2, 3]), { binary: true });
      expect(await client.waitFrame((f) => f.t === 'error', 'the error')).toEqual({ t: 'error', message: 'bad frame', ref: 'frame' });
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('closes a socket that sends a frame over the limit with 1009, and the server survives', async () => {
      const { log, lines } = collectingLog();
      const { port } = await startWeb({ log });
      const client = await openWs(port);
      client.ws.send(Buffer.alloc(300 * 1024, 0x61), { binary: false });
      expect(await client.closed).toBe(1009);
      expect(WS_MAX_FRAME_BYTES).toBeLessThan(300 * 1024);
      await expectStillServing(port);
      expect((await openWs(port)).ws.readyState).toBe(WebSocket.OPEN);
      expect(lines.some((l) => l.includes('websocket error'))).toBe(true);
    });

    it('closes a socket that reads too slowly with 1013, for events and for terminal output', async () => {
      const { port, web, fake } = await startWeb();
      const events = await openWs(port);
      const output = await openWs(port);
      output.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => output.frameCount('snapshot') === 1, 'the snapshot');
      const spy = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(5 * 1024 * 1024);
      try {
        web.broadcast(agentFrame('ana'));
        expect(await events.closed).toBe(1013);
        expect(await output.closed).toBe(1013);
        fake.push('ana', new Uint8Array([1]));
      } finally {
        spy.mockRestore();
      }
      await expectStillServing(port);
      expect((await openWs(port)).ws.readyState).toBe(WebSocket.OPEN);
    });

    it('sends 1001 to every socket when the server closes, and detaches them', async () => {
      const { port, web, fake } = await startWeb();
      const a = await openWs(port);
      const b = await openWs(port);
      a.send({ t: 'attach', seq: 1, agent: 'ana' });
      await waitFor(() => a.frameCount('snapshot') === 1, 'the snapshot');
      await web.close();
      expect(await a.closed).toBe(1001);
      expect(await b.closed).toBe(1001);
      expect(fake.attachments[0]?.detached).toBe(true);
      await expect(send(port, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    it('pings every interval and drops a socket that did not answer the previous ping', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const harness = await startWeb();
      try {
        const alive = await openWs(harness.port);
        const dead = await openWs(harness.port, { autoPong: false });
        let pings = 0;
        dead.ws.on('ping', () => {
          pings += 1;
        });
        vi.advanceTimersByTime(WS_PING_INTERVAL_MS);
        await waitFor(() => pings === 1, 'the first ping');
        await sleep(50);
        expect(dead.ws.readyState).toBe(WebSocket.OPEN);
        vi.advanceTimersByTime(WS_PING_INTERVAL_MS);
        expect(await dead.closed).toBe(1006);
        expect(alive.ws.readyState).toBe(WebSocket.OPEN);
        // the pong of the second round has to get back before the third tick looks for it
        await sleep(50);
        vi.advanceTimersByTime(WS_PING_INTERVAL_MS);
        await sleep(50);
        expect(alive.ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        await harness.web.close();
        vi.useRealTimers();
      }
    });

    it('survives sockets that are dropped at every stage', async () => {
      const { port, fake } = await startWeb();
      for (let i = 0; i < 20; i += 1) {
        const outcome = await connectWs(port);
        if (outcome.kind !== 'open') throw new Error('refused');
        const { ws } = outcome.client;
        outcome.client.send({ t: 'attach', seq: i, agent: 'ana', cols: 100 + i, rows: 30 });
        if (i % 2 === 0) outcome.client.send({ t: 'input', agent: 'ana', data: 'x'.repeat(1000) });
        if (i % 3 === 0) fake.push('ana', new Uint8Array(100_000));
        if (i % 5 === 0) await sleep(5);
        ws.terminate();
      }
      await sleep(50);
      await expectStillServing(port);
      expect((await openWs(port)).ws.readyState).toBe(WebSocket.OPEN);
    });
  });
});

/* ================================================================================================================
 * cli.ts: arguments, settings, wiring, start, stop
 * ============================================================================================================== */

const PACKAGE_VERSION = (JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

beforeEach(() => {
  for (const factory of Object.values(factories)) factory.mockReset();
  factories.parseAgentCmd.mockImplementation((value: string | undefined) => (value === undefined || value.trim() === '' ? null : value.trim().split(/\s+/)));
});

interface Captured {
  io: HubIo | null;
  hubOptions: HubOptions | null;
  launcherOptions: LauncherOptions | null;
  terminalOptions: unknown;
}

/** Puts fakes behind the three factories cli.ts imports; the home, the web server and cli.ts itself are the real ones. */
function installFakes(options: { stopAllGate?: Promise<void>; hub?: Partial<Hub> } = {}) {
  const order: string[] = [];
  const captured: Captured = { io: null, hubOptions: null, launcherOptions: null, terminalOptions: null };
  const fake = makeTerminals({ order, stopAllGate: options.stopAllGate });
  const launcherCalls: Call[] = [];
  const launcher: Launcher = {
    prepareStart: async (agent, opts) => {
      launcherCalls.push({ fn: 'prepareStart', args: [agent, opts] });
      return { spec: { file: 'fake-claude', args: ['--x'], env: { A: '1' }, cwd: agent.dir }, flag: opts.flag ?? 'session-id', token: 'tok' };
    },
    resolveToken: (token) => identities.get(token) ?? null,
    revoke: (name, generation) => {
      order.push(`revoke ${name} ${generation}`);
      launcherCalls.push({ fn: 'revoke', args: [name, generation] });
    },
    renameAgentFiles: async (oldName, newName) => {
      order.push(`launcher.rename ${oldName} ${newName}`);
    },
    memoryPath: (name) => `/mem/${name}.md`,
  };
  let closing = false;
  const { hub, calls: hubCalls } = makeHub({
    start: async () => {
      order.push('hub.start');
    },
    shutdown: async () => {
      closing = true;
      order.push('hub.shutdown');
    },
    hire: async (req) => {
      if (closing) throw new FakeHubError('conflict', 'the server is shutting down');
      return agentView(req.name, { state: 'starting' });
    },
    onTerminalEvent: (event) => {
      order.push(`hub.onTerminalEvent ${event.kind}`);
    },
    ...options.hub,
  });
  factories.createHub.mockImplementation((io: HubIo, hubOptions: HubOptions) => {
    captured.io = io;
    captured.hubOptions = hubOptions;
    return hub;
  });
  factories.createLauncher.mockImplementation((launcherOptions: LauncherOptions) => {
    captured.launcherOptions = launcherOptions;
    return launcher;
  });
  factories.createTerminalHost.mockImplementation((terminalOptions: unknown) => {
    captured.terminalOptions = terminalOptions;
    return fake.terms;
  });
  return {
    order,
    captured,
    fake,
    hub,
    hubCalls,
    launcherCalls,
    io: (): HubIo => {
      if (!captured.io) throw new Error('createHub was not called');
      return captured.io;
    },
    hubUrl: (): string => {
      if (!captured.launcherOptions) throw new Error('createLauncher was not called');
      return captured.launcherOptions.hubUrl();
    },
  };
}

async function startCli(over: Partial<Parameters<typeof startGonogo>[0]> = {}): Promise<{ running: Running; home: string; cwd: string }> {
  const home = over?.home ?? join(tmpDir(), 'home');
  const cwd = over?.cwd ?? tmpDir();
  const running = await startGonogo({ port: 0, home, cwd, agentCmd: ['node', 'fake-claude'], staticDir: null, env: { PATH: process.env.PATH }, log: nullLogger, ...over });
  cleanups.push(() => running.stop());
  return { running, home, cwd };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === 'object' && address ? address.port : 0;
}

async function portIsFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

describe('cli: parseArgs', () => {
  it.each([
    [[], {}],
    [['--port', '8080'], { port: 8080 }],
    [['--port=8080'], { port: 8080 }],
    [['--port', '0'], { port: 0 }],
    [['--port=65535'], { port: 65535 }],
    [['--host', '0.0.0.0'], { host: '0.0.0.0' }],
    [['--host=::1'], { host: '::1' }],
    [['--host='], { host: '' }],
    [['--host', ''], { host: '' }],
    [['--home', '/x/y'], { home: '/x/y' }],
    [['--home=/a b/c'], { home: '/a b/c' }],
    [['--seed-claude'], { seed: true }],
    [['--allow-host', 'gonogo.example.com'], { allowedHosts: ['gonogo.example.com'] }],
    [['--allow-host=a.example', '--allow-host', ' b.example '], { allowedHosts: ['a.example', 'b.example'] }],
    [['--port=1', '--host=h', '--home=/h', '--seed-claude', '--allow-host=a'], { port: 1, host: 'h', home: '/h', seed: true, allowedHosts: ['a'] }],
    [['--port', '1', '--port', '2'], { port: 2 }],
  ] as Array<[string[], Record<string, unknown>]>)('reads %j', (argv, options) => {
    expect(parseArgs(argv)).toEqual({ kind: 'run', options });
  });

  it('does not invent options the flags did not give: env fallbacks belong to startGonogo', () => {
    const parsed = parseArgs(['--port=1']);
    expect(parsed.kind === 'run' && Object.keys(parsed.options)).toEqual(['port']);
  });

  it.each([[['--help']], [['-h']], [['--port', '1', '--help']], [['--bogus', '-h']], [['-h', '--port', 'abc']]])('shows the help for %j', (argv) => {
    expect(parseArgs(argv)).toEqual({ kind: 'help' });
  });

  it.each([[['--version']], [['-v']], [['--port=1', '-v']]])('shows the version for %j', (argv) => {
    expect(parseArgs(argv)).toEqual({ kind: 'version' });
  });

  it.each([
    [['--bogus'], 'unknown option --bogus'],
    [['--bogus=1'], 'unknown option --bogus=1'],
    [['stray'], 'unknown option stray'],
    [['-p', '1'], 'unknown option -p'],
    [['--seed-claude=1'], 'unknown option --seed-claude=1'],
    [['--port=1', '--bogus'], 'unknown option --bogus'],
    [['--port'], '--port needs a value'],
    [['--host'], '--host needs a value'],
    [['--port', '--host', 'x'], '--port needs a value'],
    [['--port', '-1'], '--port needs a value'],
    [['--allow-host'], '--allow-host needs a value'],
    [['--port', 'abc'], 'invalid port "abc" (use a number from 0 to 65535)'],
    [['--port=70000'], 'invalid port "70000" (use a number from 0 to 65535)'],
    [['--port=1.5'], 'invalid port "1.5" (use a number from 0 to 65535)'],
    [['--port='], 'invalid port "" (use a number from 0 to 65535)'],
    [['--port', '8080abc'], 'invalid port "8080abc" (use a number from 0 to 65535)'],
    [['--port', '1e3'], 'invalid port "1e3" (use a number from 0 to 65535)'],
    [['--home='], '--home needs a directory'],
    [['--allow-host='], '--allow-host needs a host name'],
    [['--allow-host', '  '], '--allow-host needs a host name'],
  ] as Array<[string[], string]>)('refuses %j: %s', (argv, message) => {
    expect(parseArgs(argv)).toEqual({ kind: 'error', message });
  });

  it('documents every flag and variable in the usage text', () => {
    for (const word of ['--port', '--host', '--home', '--seed-claude', '--allow-host', '--help', '--version', 'GONOGO_PORT', 'GONOGO_HOST', 'GONOGO_HOME', 'GONOGO_SEED_CLAUDE', 'GONOGO_ALLOWED_HOSTS', 'GONOGO_MAX_HOPS', 'GONOGO_MAX_WORKING', 'GONOGO_AGENT_CMD', 'GONOGO_LOG_LEVEL', 'GONOGO_SCRUB_ENV', '7777']) {
      expect(USAGE, word).toContain(word);
    }
    expect(USAGE.startsWith('Usage: gonogo')).toBe(true);
  });
});

describe('cli: resolveSettings', () => {
  it('has defaults for everything', () => {
    const s = resolveSettings({ env: {} });
    expect(s).toMatchObject({
      host: '127.0.0.1',
      port: 7777,
      seed: false,
      agentCmd: null,
      maxHops: 8,
      maxWorking: null,
      allowedHosts: [],
      staticDir: null,
      checkClaude: true,
    });
    expect(s.home).toBe(join(process.env.HOME ?? '', '.gonogo').replace(/\/$/, ''));
    expect(s.cwd).toBe(process.cwd());
  });

  it('reads every environment variable', () => {
    const s = resolveSettings({
      env: {
        GONOGO_HOST: '0.0.0.0',
        GONOGO_PORT: '9001',
        GONOGO_HOME: '/state/gonogo',
        GONOGO_SEED_CLAUDE: '1',
        GONOGO_MAX_HOPS: '5',
        GONOGO_ALLOWED_HOSTS: 'a.example, b.example ,, c.example',
        GONOGO_AGENT_CMD: 'node fake.mjs',
      },
    });
    expect(s).toMatchObject({
      host: '0.0.0.0',
      port: 9001,
      home: '/state/gonogo',
      seed: true,
      maxHops: 5,
      allowedHosts: ['a.example', 'b.example', 'c.example'],
      agentCmd: ['node', 'fake.mjs'],
    });
    expect(factories.parseAgentCmd).toHaveBeenCalledWith('node fake.mjs');
  });

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['True', true],
    ['0', false],
    ['false', false],
    ['', false],
    ['yes', false],
    ['2', false],
  ])('reads GONOGO_SEED_CLAUDE=%j as %s', (value, seed) => {
    expect(resolveSettings({ env: { GONOGO_SEED_CLAUDE: value } }).seed).toBe(seed);
  });

  it('lets an option beat the variable of the same name, the empty list and null and false included', () => {
    const env = {
      GONOGO_HOST: '0.0.0.0',
      GONOGO_PORT: '9001',
      GONOGO_HOME: '/from/env',
      GONOGO_SEED_CLAUDE: '1',
      GONOGO_MAX_HOPS: '5',
      GONOGO_ALLOWED_HOSTS: 'env.example',
      GONOGO_AGENT_CMD: 'node fake.mjs',
    };
    const s = resolveSettings({ env, host: '10.1.1.1', port: 0, home: '/from/flag', seed: false, maxHops: 3, allowedHosts: [], agentCmd: null, staticDir: '/site' });
    expect(s).toMatchObject({ host: '10.1.1.1', port: 0, home: '/from/flag', seed: false, maxHops: 3, allowedHosts: [], agentCmd: null, staticDir: '/site' });
    expect(resolveSettings({ env, allowedHosts: ['flag.example'] }).allowedHosts).toEqual(['flag.example']);
  });

  it.each([
    ['localhost', '127.0.0.1'],
    ['LOCALHOST', '127.0.0.1'],
    ['', '127.0.0.1'],
    ['   ', '127.0.0.1'],
    ['[::1]', '::1'],
    ['::1', '::1'],
    ['0.0.0.0', '0.0.0.0'],
    ['::', '::'],
    ['192.168.1.5', '192.168.1.5'],
    ['myhost.local', 'myhost.local'],
  ])('binds %j as %j', (host, bound) => {
    expect(resolveSettings({ host, env: {} }).host).toBe(bound);
    expect(resolveSettings({ env: { GONOGO_HOST: host } }).host).toBe(host === undefined ? '127.0.0.1' : bound);
  });

  it.each([['abc'], ['-1'], ['70000'], ['1.5'], ['80 80']])('refuses GONOGO_PORT=%j', (value) => {
    expect(() => resolveSettings({ env: { GONOGO_PORT: value } })).toThrowError(`invalid GONOGO_PORT "${value}" (use a number from 0 to 65535)`);
  });

  it.each([[-1], [70000], [1.5], [Number.NaN]])('refuses the port option %s', (port) => {
    expect(() => resolveSettings({ port, env: {} })).toThrow(/invalid port/);
  });

  it.each([['0'], ['101'], ['abc'], ['5.5'], ['-3'], ['1000000']])('warns and uses 8 for GONOGO_MAX_HOPS=%j', (value) => {
    const { log, lines } = collectingLog();
    expect(resolveSettings({ env: { GONOGO_MAX_HOPS: value }, log }, log).maxHops).toBe(8);
    expect(lines.some((l) => l.includes('warn') && l.includes(`"${value}"`))).toBe(true);
  });

  it.each([['1', 1], ['8', 8], ['100', 100]])('accepts GONOGO_MAX_HOPS=%s', (value, hops) => {
    const { log, lines } = collectingLog();
    expect(resolveSettings({ env: { GONOGO_MAX_HOPS: value } }, log).maxHops).toBe(hops);
    expect(lines).toEqual([]);
  });

  it('also checks the maxHops option, and ignores an empty variable', () => {
    const { log, lines } = collectingLog();
    expect(resolveSettings({ env: {}, maxHops: 1000 }, log).maxHops).toBe(8);
    expect(lines).toHaveLength(1);
    expect(resolveSettings({ env: { GONOGO_MAX_HOPS: '' } }).maxHops).toBe(8);
  });

  it.each([['0'], ['25'], ['abc'], ['2.5'], ['-1']])('warns and leaves Max Q off for GONOGO_MAX_WORKING=%j', (value) => {
    const { log, lines } = collectingLog();
    expect(resolveSettings({ env: { GONOGO_MAX_WORKING: value } }, log).maxWorking).toBeNull();
    expect(lines.some((l) => l.includes('warn') && l.includes(`"${value}"`) && l.includes('GONOGO_MAX_WORKING'))).toBe(true);
  });

  it.each([['1', 1], ['3', 3], ['24', 24]])('accepts GONOGO_MAX_WORKING=%s, and the maxWorking option wins', (value, limit) => {
    const { log, lines } = collectingLog();
    expect(resolveSettings({ env: { GONOGO_MAX_WORKING: value } }, log).maxWorking).toBe(limit);
    expect(resolveSettings({ env: { GONOGO_MAX_WORKING: value }, maxWorking: 2 }, log).maxWorking).toBe(2);
    expect(resolveSettings({ env: { GONOGO_MAX_WORKING: '' } }, log).maxWorking).toBeNull();
    expect(lines).toEqual([]);
  });

  it('lets a bad GONOGO_AGENT_CMD end the start with its own message', () => {
    factories.parseAgentCmd.mockImplementation(() => {
      throw new Error('GONOGO_AGENT_CMD: not a JSON array');
    });
    expect(() => resolveSettings({ env: { GONOGO_AGENT_CMD: '[x' } })).toThrowError('GONOGO_AGENT_CMD: not a JSON array');
  });

  it('treats an empty GONOGO_HOME as unset', () => {
    expect(resolveSettings({ env: { GONOGO_HOME: '' } }).home).toMatch(/\.gonogo$/);
  });
});

describe('cli: isTransientError', () => {
  it.each([
    ['ECONNRESET', true],
    ['EPIPE', true],
    ['ERR_STREAM_DESTROYED', true],
    ['ERR_STREAM_WRITE_AFTER_END', true],
    ['ERR_STREAM_PREMATURE_CLOSE', true],
    ['ERR_HTTP_HEADERS_SENT', true],
    ['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH', true],
    ['WS_ERR_INVALID_UTF8', true],
    ['ENOENT', false],
    ['EADDRINUSE', false],
    ['ERR_INVALID_URL', false],
    ['ERR_WS_ERR', false],
  ])('%s is transient: %s', (code, transient) => {
    expect(isTransientError(Object.assign(new Error('x'), { code }))).toBe(transient);
  });

  it('is false for anything without a string code', () => {
    for (const value of [new Error('plain'), null, undefined, 'ECONNRESET', 5, {}, { code: 5 }, { code: null }]) expect(isTransientError(value)).toBe(false);
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
  });
});

describe('cli: startGonogo', () => {
  describe('the claude executable', () => {
    const executable = (dir: string, mode: number): void => {
      writeFileSync(join(dir, 'claude'), '#!/bin/sh\n');
      chmodSync(join(dir, 'claude'), mode);
    };
    const MESSAGE = 'the claude CLI was not found on PATH. Install Claude Code and sign in, or set GONOGO_AGENT_CMD.';

    it('refuses to start when claude is not on PATH, before it touches the home or the terminals', async () => {
      installFakes();
      const empty = tmpDir();
      const home = join(tmpDir(), 'home');
      await expect(startGonogo({ port: 0, home, cwd: tmpDir(), agentCmd: null, env: { PATH: empty }, log: nullLogger })).rejects.toThrowError(MESSAGE);
      expect(existsSync(home)).toBe(false);
      expect(factories.createTerminalHost).not.toHaveBeenCalled();
      expect(factories.createHub).not.toHaveBeenCalled();
    });

    it.each([
      ['a file that is not executable', (dir: string) => executable(dir, 0o644)],
      ['a directory', (dir: string) => mkdirSync(join(dir, 'claude'))],
      ['nothing', () => undefined],
    ])('does not take %s for claude', async (_what, prepare) => {
      installFakes();
      const bin = tmpDir();
      prepare(bin);
      await expect(startGonogo({ port: 0, home: join(tmpDir(), 'h'), cwd: tmpDir(), agentCmd: null, env: { PATH: `${bin}:/nonexistent` }, log: nullLogger })).rejects.toThrowError(MESSAGE);
    });

    it('starts when an executable claude is on PATH', async () => {
      installFakes();
      const bin = tmpDir();
      executable(bin, 0o755);
      const { running } = await startCli({ agentCmd: null, env: { PATH: `/nonexistent::${bin}` } });
      expect(running.port).toBeGreaterThan(0);
    });

    it('does not look for claude when an agent command is set, by option or by variable, or when checkClaude is false', async () => {
      installFakes();
      const empty = tmpDir();
      await startCli({ agentCmd: ['node', 'x'], env: { PATH: empty } });
      await startCli({ agentCmd: undefined, env: { PATH: empty, GONOGO_AGENT_CMD: 'node x' } });
      await startCli({ agentCmd: null, checkClaude: false, env: { PATH: empty } });
    });

    it('stops at a GONOGO_AGENT_CMD that cannot be read, before it opens the home', async () => {
      installFakes();
      factories.parseAgentCmd.mockImplementation(() => {
        throw new Error('GONOGO_AGENT_CMD: not a JSON array');
      });
      const home = join(tmpDir(), 'home');
      await expect(startGonogo({ port: 0, home, cwd: tmpDir(), agentCmd: undefined, env: { GONOGO_AGENT_CMD: '[x' }, log: nullLogger })).rejects.toThrowError('GONOGO_AGENT_CMD: not a JSON array');
      expect(existsSync(home)).toBe(false);
    });
  });

  describe('wiring', () => {
    it('hands the factories what contract 2.8 says', async () => {
      const fakes = installFakes();
      const env = { PATH: process.env.PATH, GONOGO_SEED_CLAUDE: 'true', CLAUDE_CONFIG_DIR: '/cfg' };
      const { running, cwd } = await startCli({ env, maxHops: 5, agentCmd: ['node', 'fake.mjs'] });
      expect(fakes.captured.hubOptions).toEqual({ maxHops: 5, bossDir: cwd, maxWorking: null, redline: true });
      const launcherOptions = fakes.captured.launcherOptions;
      expect(launcherOptions).toMatchObject({ homeDir: running.home, seed: true, env, agentCmd: ['node', 'fake.mjs'] });
      expect(launcherOptions?.log).toBeDefined();
      expect(fakes.captured.terminalOptions).toMatchObject({ log: expect.anything() });
      expect(fakes.hubUrl()).toBe(`http://127.0.0.1:${running.port}`);
    });

    it('reads the options from the environment when the options are not given', async () => {
      const fakes = installFakes();
      const home = join(tmpDir(), 'home');
      await startCli({ home: undefined, agentCmd: undefined, maxHops: undefined, seed: undefined, env: { PATH: '', GONOGO_HOME: home, GONOGO_AGENT_CMD: 'node a b', GONOGO_MAX_HOPS: '4', GONOGO_MAX_WORKING: '3', GONOGO_SEED_CLAUDE: '1' } });
      expect(fakes.captured.launcherOptions).toMatchObject({ homeDir: home, seed: true, agentCmd: ['node', 'a', 'b'] });
      expect(fakes.captured.hubOptions?.maxHops).toBe(4);
      expect(fakes.captured.hubOptions?.maxWorking).toBe(3);
    });

    it('serves the snapshot with the real info, and the browser token is the one in the home', async () => {
      installFakes();
      const { running, home, cwd } = await startCli({ seed: true, maxHops: 6 });
      const res = await api(running.port, 'GET', '/api/state', undefined, running.browserToken);
      expect(res.status).toBe(200);
      const info = (res.json() as { info: ServerInfo }).info;
      expect(info).toMatchObject({ protocol: 1, version: PACKAGE_VERSION, cwd, home, host: '127.0.0.1', port: running.port, seed: true, agentCmd: 'node fake-claude', maxHops: 6 });
      expect(info.startedAt).toBeGreaterThan(Date.now() - 60_000);
      expect(running.browserToken).toBe(readFileSync(join(home, 'token'), 'utf8').trim());
      expect(running.home).toBe(home);
    });

    it('starts the hub only after the server listens, and answers 503 on /api until it has started', async () => {
      const probes: Array<[string, number]> = [];
      let base = '';
      const fakes = installFakes({
        hub: {
          start: async () => {
            base = fakes.hubUrl();
            const port = Number(new URL(base).port);
            probes.push(['state', (await api(port, 'GET', '/api/state')).status]);
            const token = readFileSync(join(fakes.captured.launcherOptions?.homeDir ?? '', 'token'), 'utf8').trim();
            probes.push(['state with token', (await api(port, 'GET', '/api/state', undefined, token)).status]);
            probes.push(['hook', (await send(port, { method: 'POST', path: '/hook/ana/Stop' })).status]);
            probes.push(['mcp', (await send(port, { method: 'POST', path: '/mcp' })).status]);
          },
        },
      });
      const { running } = await startCli();
      expect(base).toBe(`http://127.0.0.1:${running.port}`);
      // the hook and MCP endpoints answer (401 without a token) while the boss starts; /api waits (503 after the token check)
      expect(probes).toEqual([['state', 401], ['state with token', 503], ['hook', 401], ['mcp', 401]]);
      const ready = await api(running.port, 'GET', '/api/state', undefined, running.browserToken);
      expect(ready.status).toBe(200);
      void fakes;
    });

    it('answers 503 with the browser token while the hub is still starting', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fakes = installFakes({
        hub: {
          start: async () => {
            fakes.order.push('hub.start');
            await held;
          },
        },
      });
      const starting = startCli();
      await waitFor(() => fakes.order.includes('hub.start'), 'the hub to be asked to start');
      const port = Number(new URL(fakes.hubUrl()).port);
      // the token is in the home, which exists as soon as the start began
      const token = readFileSync(join(fakes.captured.launcherOptions?.homeDir ?? '', 'token'), 'utf8').trim();
      const early = await api(port, 'GET', '/api/state', undefined, token);
      expect(early.status).toBe(503);
      expect(early.json()).toEqual({ error: 'starting', code: 'unavailable' });
      release();
      const { running } = await starting;
      expect((await api(running.port, 'GET', '/api/state', undefined, token)).status).toBe(200);
    });

    it('forwards the terminal events: an exit revokes the token first, then reaches the hub', async () => {
      const fakes = installFakes();
      await startCli();
      const [handler] = fakes.fake.handlers;
      expect(fakes.fake.handlers).toHaveLength(1);
      const exit: TerminalEvent = { kind: 'exit', name: 'ana', generation: 4, at: 1, info: { code: 0, signal: null, durationMs: 5, requested: true, tail: '' } };
      const ready: TerminalEvent = { kind: 'ready', name: 'ana', generation: 5, at: 2 };
      handler?.(exit);
      handler?.(ready);
      expect(fakes.order.filter((o) => o.startsWith('revoke') || o.startsWith('hub.onTerminalEvent'))).toEqual(['revoke ana 4', 'hub.onTerminalEvent exit', 'hub.onTerminalEvent ready']);
      expect(fakes.hubCalls.filter((c) => c.fn === 'onTerminalEvent')).toEqual([]);
    });

    it('subscribes to the terminal events before the hub starts', async () => {
      let subscribed = -1;
      const fakes = installFakes({ hub: { start: async () => { subscribed = fakes.fake.handlers.length; } } });
      await startCli();
      expect(subscribed).toBe(1);
    });
  });

  describe('the hub io', () => {
    it('numbers messages after the ones in the log, makes session ids, and the functions work detached', async () => {
      const home = join(tmpDir(), 'home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, MESSAGES_FILE), JSON.stringify(message('m41')) + '\n');
      const fakes = installFakes();
      await startCli({ home });
      const { newMessageId, newSessionId, now, setTimer, clearTimer } = fakes.io();
      expect([newMessageId(), newMessageId()]).toEqual(['m42', 'm43']);
      expect(newSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(newSessionId()).not.toBe(newSessionId());
      expect(Math.abs(now() - Date.now())).toBeLessThan(1000);
      let fired = 0;
      const handle = setTimer(() => {
        fired += 1;
      }, 10);
      const cancelled = setTimer(() => {
        fired += 100;
      }, 10);
      clearTimer(cancelled);
      await waitFor(() => fired > 0, 'the timer');
      await sleep(30);
      expect(fired).toBe(1);
      // a timer of the hub must never keep the process alive
      expect((handle as NodeJS.Timeout).hasRef()).toBe(false);
    });

    it('starts the message ids at 1 when there is no log', async () => {
      const fakes = installFakes();
      await startCli();
      expect(fakes.io().newMessageId()).toBe('m1');
    });

    it('checks directories the way the hire form needs', async () => {
      const fakes = installFakes();
      const { cwd } = await startCli();
      const file = join(cwd, 'file.txt');
      writeFileSync(file, 'x');
      mkdirSync(join(cwd, 'sub'));
      const { checkDirectory } = fakes.io();
      expect(await checkDirectory('relative/dir')).toEqual({ ok: false, error: 'directory must be an absolute path' });
      expect(await checkDirectory('')).toEqual({ ok: false, error: 'directory must be an absolute path' });
      expect(await checkDirectory(join(cwd, 'missing'))).toEqual({ ok: false, error: `directory does not exist: ${join(cwd, 'missing')}` });
      expect(await checkDirectory(file)).toEqual({ ok: false, error: `not a directory: ${file}` });
      expect(await checkDirectory(`${cwd}/\u0000x`)).toMatchObject({ ok: false });
      expect(await checkDirectory(cwd)).toEqual({ ok: true, path: cwd });
      expect(await checkDirectory(`${cwd}/sub/../sub/`)).toEqual({ ok: true, path: join(cwd, 'sub') });
    });

    it('persists through the home: roster, history and the message log', async () => {
      const home = join(tmpDir(), 'home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, MESSAGES_FILE), JSON.stringify(message('m1', { at: 5 })) + '\n');
      const fakes = installFakes();
      const { running } = await startCli({ home });
      const io = fakes.io();
      const roster: RosterFile = { version: 1, agents: [agentRecord('flight', { boss: true, desk: 0 }) as never] };
      await io.saveRoster(roster);
      expect(await io.loadRoster()).toEqual(roster);
      expect(JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'))).toEqual(roster);
      expect((await io.loadHistory(10)).map((m) => m.id)).toEqual(['m1']);
      io.logMessage(message('m2', { at: 6 }));
      await running.stop();
      expect(readFileSync(join(home, MESSAGES_FILE), 'utf8').trimEnd().split('\n')).toHaveLength(2);
    });

    it('renames the files and then the terminal record', async () => {
      const fakes = installFakes();
      await startCli();
      await fakes.io().renameAgentFiles('ana', 'bob');
      expect(fakes.order.filter((o) => o.includes('rename'))).toEqual(['launcher.rename ana bob', 'terminals.rename ana bob']);
    });

    it('spawns through the launcher and the terminal host, and hands back the pid', async () => {
      const fakes = installFakes();
      await startCli();
      const agent = agentRecord('ana') as never;
      const info = await fakes.io().spawn({ agent, generation: 3, flag: null });
      expect(info).toEqual({ generation: 3, flag: 'session-id', pid: 1 });
      expect(fakes.launcherCalls[0]).toEqual({ fn: 'prepareStart', args: [agent, { generation: 3, flag: null }] });
      expect(fakes.fake.calls.find((c) => c.fn === 'spawn')?.args).toEqual(['ana', 3, { file: 'fake-claude', args: ['--x'], env: { A: '1' }, cwd: '/work' }]);
      const forced = await fakes.io().spawn({ agent, generation: 4, flag: 'resume' });
      expect(forced.flag).toBe('resume');
    });

    it('revokes the token when the terminal host cannot spawn, and passes the error on', async () => {
      const fakes = installFakes();
      await startCli();
      fakes.fake.terms.spawn = () => {
        throw new Error('could not start fake-claude');
      };
      await expect(fakes.io().spawn({ agent: agentRecord('ana') as never, generation: 2, flag: null })).rejects.toThrowError('could not start fake-claude');
      expect(fakes.launcherCalls.filter((c) => c.fn === 'revoke').map((c) => c.args)).toEqual([['ana', 2]]);
    });

    it('does not spawn, or revoke, when the launcher cannot prepare the start', async () => {
      const fakes = installFakes();
      await startCli();
      const launcherOptions = fakes.captured.launcherOptions;
      expect(launcherOptions).not.toBeNull();
      const real = factories.createLauncher.mock.results[0]?.value as Launcher;
      real.prepareStart = async () => {
        throw new Error('working directory does not exist: /gone');
      };
      await expect(fakes.io().spawn({ agent: agentRecord('ana') as never, generation: 1, flag: null })).rejects.toThrowError('working directory does not exist: /gone');
      expect(fakes.fake.calls.filter((c) => c.fn === 'spawn')).toEqual([]);
      expect(fakes.launcherCalls.filter((c) => c.fn === 'revoke')).toEqual([]);
    });

    it('passes stop, typePointer, screen, title and outputBytes straight to the terminal host', async () => {
      const fakes = installFakes();
      await startCli();
      const io = fakes.io();
      await io.stop('ana', 3);
      expect(io.typePointer('ana', 3, 'gonogo: 1 new message from user. Call read_messages.')).toBe(true);
      fakes.fake.state.submitResult = false;
      expect(io.typePointer('ana', 3, 'x')).toBe(false);
      expect(io.screen('ana')).toBeNull();
      expect(io.title('ana')).toBeNull();
      expect(io.outputBytes('ana')).toBe(42);
      expect(fakes.fake.calls.map((c) => [c.fn, ...c.args])).toEqual([
        ['stop', 'ana', 3],
        ['submit', 'ana', 3, 'gonogo: 1 new message from user. Call read_messages.'],
        ['submit', 'ana', 3, 'x'],
        ['screen', 'ana'],
        ['title', 'ana'],
        ['outputBytes', 'ana'],
      ]);
    });

    it('presses keys only in the running process of the generation the hub names', async () => {
      const fakes = installFakes();
      await startCli();
      const io = fakes.io();
      expect(io.press?.('ana', 3, '\r')).toBe(true);
      expect(io.press?.('ana', 2, '\r')).toBe(false); // an older generation
      expect(io.press?.('ben', 0, '\r')).toBe(false); // not running
      expect(io.press?.('ghost', 1, '\r')).toBe(false);
      fakes.fake.state.writeResult = false;
      expect(io.press?.('ana', 3, '\x1b')).toBe(false);
      expect(fakes.fake.calls.filter((c) => c.fn === 'write').map((c) => c.args)).toEqual([['ana', '\r'], ['ana', '\x1b']]);
    });

    it('sends emitted events to the connected browsers', async () => {
      const fakes = installFakes();
      const { running } = await startCli();
      const client = await openWs(running.port, { token: running.browserToken });
      fakes.io().emit({ t: 'agent-removed', name: 'ghost' });
      await client.waitFrame((f) => f.t === 'agent-removed', 'the event');
      expect(client.frames.at(-1)).toEqual({ t: 'agent-removed', name: 'ghost' });
    });

    it('lets a call to emit that comes before the web server exists do nothing', async () => {
      let early: unknown = 'not called';
      const fakes = installFakes();
      factories.createHub.mockImplementation((io: HubIo) => {
        early = io.emit({ t: 'agent-removed', name: 'early' });
        return fakes.hub;
      });
      await startCli();
      expect(early).toBeUndefined();
    });

    it('has the arrow functions of 2.8 step 4: every member works when taken off the object', async () => {
      const fakes = installFakes();
      await startCli();
      const io = fakes.io();
      const detached = { ...io };
      expect(detached.now()).toBeGreaterThan(0);
      expect(detached.newMessageId()).toMatch(/^m\d+$/);
      expect(detached.newSessionId()).toHaveLength(36);
      expect(detached.screen('ana')).toBeNull();
      expect(await detached.loadRoster()).toEqual({ version: 1, agents: [] });
    });
  });

  describe('URL, host and port', () => {
    it('prints the loopback URL with the token in the fragment', async () => {
      installFakes();
      const { running } = await startCli();
      expect(running.url).toBe(`http://127.0.0.1:${running.port}/#token=${running.browserToken}`);
      expect(running.browserToken).toMatch(/^[0-9a-f]{64}$/);
      expect(running.host).toBe('127.0.0.1');
    });

    it.each(HAS_IPV6 ? [['0.0.0.0'], ['::']] : [['0.0.0.0']])('prints 127.0.0.1 for a wildcard bind (%s), and agents are told the loopback URL', async (host) => {
      const fakes = installFakes();
      const { running } = await startCli({ host });
      expect(running.url).toBe(`http://127.0.0.1:${running.port}/#token=${running.browserToken}`);
      expect(running.host).toBe(host);
      expect(fakes.hubUrl()).toBe(`http://127.0.0.1:${running.port}`);
      expect((await api(running.port, 'GET', '/api/state', undefined, running.browserToken)).status).toBe(200);
    });

    it.each([['localhost'], ['LOCALHOST'], ['']])('binds 127.0.0.1 for the host %j', async (host) => {
      const fakes = installFakes();
      const { running } = await startCli({ host });
      expect(running.host).toBe('127.0.0.1');
      expect(running.url).toBe(`http://127.0.0.1:${running.port}/#token=${running.browserToken}`);
      expect(fakes.hubUrl()).toBe(`http://127.0.0.1:${running.port}`);
      expect((await api(running.port, 'GET', '/api/state', undefined, running.browserToken)).status).toBe(200);
    });

    it.skipIf(!HAS_IPV6)('brackets an IPv6 host in the printed URL and hands the agents [::1] (contract 0.5 item 14)', async () => {
      const fakes = installFakes();
      for (const host of ['::1', '[::1]']) {
        const { running } = await startCli({ host });
        expect(running.host).toBe('::1');
        expect(running.url).toBe(`http://[::1]:${running.port}/#token=${running.browserToken}`);
        expect(fakes.hubUrl()).toBe(`http://[::1]:${running.port}`);
        const res = await send(running.port, { host: '::1', path: '/api/state', headers: { ...bearer(running.browserToken), Host: `[::1]:${running.port}` } });
        expect(res.status).toBe(200);
        await running.stop();
      }
    });

    it.skipIf(lanAddress() === null)('prints a specific address as it is, but gives the agents 127.0.0.1, which answers too (contract 2.8 step 8)', async () => {
      const lan = lanAddress() ?? '';
      const fakes = installFakes();
      const { running } = await startCli({ host: lan });
      expect(running.url).toBe(`http://${lan}:${running.port}/#token=${running.browserToken}`);
      expect(fakes.hubUrl()).toBe(`http://127.0.0.1:${running.port}`);
      for (const host of [lan, '127.0.0.1']) {
        expect((await send(running.port, { host, path: '/api/state', headers: bearer(running.browserToken) })).status, host).toBe(200);
      }
    });

    it('allows the extra Host names it was given', async () => {
      installFakes();
      const { running } = await startCli({ allowedHosts: ['gonogo.example.com'] });
      const proxied = await send(running.port, { path: '/api/state', headers: { ...bearer(running.browserToken), Host: 'gonogo.example.com', Origin: 'https://gonogo.example.com' } });
      expect(proxied.status).toBe(200);
      const other = await send(running.port, { path: '/api/state', headers: { ...bearer(running.browserToken), Host: 'other.example.com' } });
      expect(other.status).toBe(403);
    });

    it('reads the allowed Host names from the environment, and an option replaces them', async () => {
      installFakes();
      const env = { PATH: process.env.PATH, GONOGO_ALLOWED_HOSTS: 'env.example.com' };
      const fromEnv = await startCli({ env });
      expect((await send(fromEnv.running.port, { path: '/api/state', headers: { ...bearer(fromEnv.running.browserToken), Host: 'env.example.com' } })).status).toBe(200);
      const replaced = await startCli({ env, allowedHosts: ['flag.example.com'] });
      expect((await send(replaced.running.port, { path: '/api/state', headers: { ...bearer(replaced.running.browserToken), Host: 'env.example.com' } })).status).toBe(403);
      expect((await send(replaced.running.port, { path: '/api/state', headers: { ...bearer(replaced.running.browserToken), Host: 'flag.example.com' } })).status).toBe(200);
    });

    it('says what is wrong when the port is taken', async () => {
      installFakes();
      const blocker = createNetServer();
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
      const address = blocker.address();
      const taken = typeof address === 'object' && address ? address.port : 0;
      const home = join(tmpDir(), 'home');
      await expect(startGonogo({ port: taken, home, cwd: tmpDir(), agentCmd: ['x'], staticDir: null, env: {}, log: nullLogger })).rejects.toThrowError(
        `cannot listen on 127.0.0.1:${taken}: the port is already in use (EADDRINUSE). Stop whatever uses it, or pass --port.`,
      );
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
    });
  });

  describe('failing to start leaves nothing behind', () => {
    it('stops at a corrupt agents.json before anything listens, and says which file', async () => {
      const fakes = installFakes();
      const home = join(tmpDir(), 'home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'agents.json'), '{ this is not json');
      const port = await freePort();
      const error = await startGonogo({ port, home, cwd: tmpDir(), agentCmd: ['x'], staticDir: null, env: {}, log: nullLogger }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(join(home, 'agents.json'));
      expect((error as Error).message).toContain('fix or delete this file');
      expect(await portIsFree(port)).toBe(true);
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
      expect(readFileSync(join(home, 'agents.json'), 'utf8')).toBe('{ this is not json');
      expect(factories.createTerminalHost).not.toHaveBeenCalled();
      expect(factories.createHub).not.toHaveBeenCalled();
      void fakes;
    });

    it('refuses a home that another gonogo is using, and leaves that lock alone', async () => {
      installFakes();
      const home = join(tmpDir(), 'home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, LOCK_FILE), `${process.ppid}\n`);
      await expect(startGonogo({ port: 0, home, cwd: tmpDir(), agentCmd: ['x'], staticDir: null, env: {}, log: nullLogger })).rejects.toThrowError(/another gonogo is using/);
      expect(readFileSync(join(home, LOCK_FILE), 'utf8')).toBe(`${process.ppid}\n`);
      expect(factories.createTerminalHost).not.toHaveBeenCalled();
    });

    it('closes the server, stops the terminals and releases the lock when the hub fails to start', async () => {
      const fakes = installFakes({ hub: { start: async () => { throw new Error('the roster could not be saved'); } } });
      const home = join(tmpDir(), 'home');
      const port = await freePort();
      await expect(startGonogo({ port, home, cwd: tmpDir(), agentCmd: ['x'], staticDir: null, env: {}, log: nullLogger })).rejects.toThrowError('the roster could not be saved');
      expect(await portIsFree(port)).toBe(true);
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
      expect(fakes.order).toContain('terminals.stopAll');
      expect(fakes.order).toContain('hub.shutdown');
      // the home can be used again at once
      expect(openTestHome(home).dir).toBe(home);
    });

    it('does the same when the port is taken after the home was opened and the terminal host made', async () => {
      const fakes = installFakes();
      const blocker = createNetServer();
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
      const address = blocker.address();
      const taken = typeof address === 'object' && address ? address.port : 0;
      const home = join(tmpDir(), 'home');
      await expect(startGonogo({ port: taken, home, cwd: tmpDir(), agentCmd: ['x'], staticDir: null, env: {}, log: nullLogger })).rejects.toThrow(/EADDRINUSE/);
      expect(fakes.order).toContain('terminals.stopAll');
      expect(fakes.order).not.toContain('hub.shutdown');
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
    });

    it.each([
      ['createHub', () => factories.createHub.mockImplementation(() => { throw new Error('hub factory broke'); }), 'hub factory broke'],
      ['createLauncher', () => factories.createLauncher.mockImplementation(() => { throw new Error('launcher factory broke'); }), 'launcher factory broke'],
      ['createTerminalHost', () => factories.createTerminalHost.mockImplementation(() => { throw new Error('pty library missing'); }), 'pty library missing'],
    ])('releases the lock when %s throws', async (_what, breakIt, message) => {
      installFakes();
      breakIt();
      const home = join(tmpDir(), 'home');
      await expect(startGonogo({ port: 0, home, cwd: tmpDir(), agentCmd: ['x'], staticDir: null, env: {}, log: nullLogger })).rejects.toThrowError(message);
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
    });

    it('goes on closing when one step of the clean-up fails, and logs it', async () => {
      const { log, lines } = collectingLog();
      const fakes = installFakes({ hub: { start: async () => { throw new Error('start failed'); }, shutdown: async () => { throw new Error('shutdown failed too'); } } });
      const home = join(tmpDir(), 'home');
      await expect(startGonogo({ port: 0, home, cwd: tmpDir(), agentCmd: ['x'], staticDir: null, env: {}, log })).rejects.toThrowError('start failed');
      expect(fakes.order).toContain('terminals.stopAll');
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
      expect(lines.some((l) => l.includes('shutdown failed too'))).toBe(true);
    });

    it.skipIf(process.getuid?.() === 0)('warns once for a directory the server cannot write to', async () => {
      installFakes();
      const { log, lines } = collectingLog();
      const cwd = tmpDir();
      chmodSync(cwd, 0o500);
      cleanups.push(() => chmodSync(cwd, 0o700));
      await startCli({ cwd, log });
      const warnings = lines.filter((l) => l.includes('is not writable by uid'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${cwd} is not writable by uid ${process.getuid?.()}; chown it to that uid`);
    });

    it('does not warn for directories it can write to', async () => {
      installFakes();
      const { log, lines } = collectingLog();
      await startCli({ log });
      expect(lines.filter((l) => l.includes('not writable'))).toEqual([]);
    });
  });

  describe('stop', () => {
    it('shuts the hub down first, then the terminals, then closes the server and releases the home', async () => {
      const fakes = installFakes();
      const { running, home } = await startCli();
      const first = running.stop();
      expect(running.stop()).toBe(first);
      await first;
      await running.stop();
      expect(fakes.order.filter((o) => o === 'hub.shutdown' || o === 'terminals.stopAll')).toEqual(['hub.shutdown', 'terminals.stopAll']);
      expect(fakes.order.filter((o) => o === 'hub.shutdown')).toHaveLength(1);
      await expect(send(running.port, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
      expect(openTestHome(home).dir).toBe(home);
    });

    it('answers 409 on POST /api/agents while it stops, starts no process, and keeps the other endpoints alive until the end', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fakes = installFakes({ stopAllGate: gate });
      const { running } = await startCli();
      const hire = { name: 'zed', role: 'r', dir: '/work', mode: 'default' };
      expect((await api(running.port, 'POST', '/api/agents', hire, running.browserToken)).status).toBe(201);
      const stopping = running.stop();
      await waitFor(() => fakes.order.includes('terminals.stopAll'), 'the terminals to be stopped');
      const refused = await api(running.port, 'POST', '/api/agents', hire, running.browserToken);
      expect(refused.status).toBe(409);
      expect(refused.json()).toEqual({ error: 'the server is shutting down', code: 'conflict' });
      expect(fakes.fake.calls.filter((c) => c.fn === 'spawn')).toEqual([]);
      // messages, the snapshot, hooks and open sockets keep working so the agents can finish
      expect((await api(running.port, 'GET', '/api/state', undefined, running.browserToken)).status).toBe(200);
      expect((await api(running.port, 'POST', '/api/messages', { to: 'ana', body: 'x' }, running.browserToken)).status).toBe(201);
      expect((await postHook(running.port, '/hook/ana/Stop')).status).toBe(200);
      expect((await openWs(running.port, { token: running.browserToken })).ws.readyState).toBe(WebSocket.OPEN);
      release();
      await stopping;
      await expect(send(running.port, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    it('goes on with the later steps when an earlier one fails, and logs it', async () => {
      const { log, lines } = collectingLog();
      const fakes = installFakes({ hub: { shutdown: async () => { throw new Error('hub shutdown blew up'); } } });
      const { running, home } = await startCli({ log });
      await running.stop();
      expect(fakes.order).toContain('terminals.stopAll');
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
      await expect(send(running.port, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(lines.some((l) => l.includes('hub shutdown blew up'))).toBe(true);
    });

    it('does not wait for ever: it gives up after SHUTDOWN_MAX_MS and says so', async () => {
      const { log, lines } = collectingLog();
      const never = new Promise<void>(() => undefined);
      installFakes({ stopAllGate: never });
      const { running } = await startCli({ log });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const stopping = running.stop();
        await vi.advanceTimersByTimeAsync(12_000);
        await stopping;
      } finally {
        vi.useRealTimers();
      }
      expect(lines.some((l) => l.includes('warn') && l.includes('shutdown did not finish within 12000 ms'))).toBe(true);
    });
  });
});

/* ================================================================================================================
 * cli.ts: main
 * ============================================================================================================== */

type Listener = (...args: unknown[]) => void;
const WATCHED_EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'] as const;

/** Captures stdout, stderr and process.exit, and removes the process handlers that main installs. */
function captureProcess() {
  const emitter: NodeJS.EventEmitter = process;
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const before = new Map<string, Set<unknown>>(WATCHED_EVENTS.map((e) => [e, new Set<unknown>(emitter.listeners(e))]));
  const stdoutErrorListeners = process.stdout.listenerCount('error');
  const stderrErrorListeners = process.stderr.listenerCount('error');
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit);
  cleanups.push(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    for (const event of WATCHED_EVENTS) {
      for (const listener of emitter.listeners(event)) if (!before.get(event)?.has(listener)) emitter.removeListener(event, listener as Listener);
    }
  });
  const added = (event: string): Listener[] => emitter.listeners(event).filter((l) => !before.get(event)?.has(l)) as Listener[];
  return {
    out,
    err,
    exits,
    added,
    handler(event: string): Listener {
      const [listener] = added(event);
      if (!listener) throw new Error(`main installed no ${event} handler`);
      return listener;
    },
    streamErrorListeners: () => ({
      stdout: process.stdout.listenerCount('error') - stdoutErrorListeners,
      stderr: process.stderr.listenerCount('error') - stderrErrorListeners,
    }),
  };
}

type ProcessCapture = ReturnType<typeof captureProcess>;

async function runMain(cap: ProcessCapture, argv: string[], env: Record<string, string | undefined>): Promise<{ url: string; port: number; token: string } | null> {
  await main(argv, env);
  const match = /^gonogo ready: (http:\/\/(?:127\.0\.0\.1|\[::1\]|[^:/]+):(\d+)\/#token=([0-9a-f]{64}))\n$/.exec(cap.out.join(''));
  return match ? { url: match[1] ?? '', port: Number(match[2]), token: match[3] ?? '' } : null;
}

describe('cli: main', () => {
  const baseEnv = (): Record<string, string | undefined> => ({ PATH: process.env.PATH, GONOGO_AGENT_CMD: 'node fake-claude' });

  it('prints the usage and exits 0 for --help, and starts nothing', async () => {
    installFakes();
    const cap = captureProcess();
    await main(['--help'], baseEnv());
    expect(cap.out.join('')).toBe(USAGE);
    expect(cap.err).toEqual([]);
    expect(cap.exits).toEqual([0]);
    expect(factories.createHub).not.toHaveBeenCalled();
    expect(cap.added('SIGTERM')).toEqual([]);
  });

  it('prints gonogo <version> and exits 0 for --version and -v', async () => {
    installFakes();
    const cap = captureProcess();
    await main(['--version'], baseEnv());
    await main(['-v'], baseEnv());
    expect(cap.out.join('')).toBe(`gonogo ${PACKAGE_VERSION}\ngonogo ${PACKAGE_VERSION}\n`);
    expect(cap.exits).toEqual([0, 0]);
  });

  it('prints the usage to stderr and exits 2 for an unknown flag or a bad value', async () => {
    installFakes();
    const cap = captureProcess();
    await main(['--bogus'], baseEnv());
    await main(['--port', 'abc'], baseEnv());
    await main(['--port'], baseEnv());
    expect(cap.exits).toEqual([2, 2, 2]);
    expect(cap.out).toEqual([]);
    const text = cap.err.join('');
    expect(text).toContain('gonogo: unknown option --bogus\n');
    expect(text).toContain('gonogo: invalid port "abc" (use a number from 0 to 65535)\n');
    expect(text).toContain('gonogo: --port needs a value\n');
    expect(text.split('Usage: gonogo').length - 1).toBe(3);
    expect(factories.createHub).not.toHaveBeenCalled();
  });

  it('prints one line gonogo: <message> and exits 1 when the start fails, with no stack', async () => {
    installFakes();
    const cap = captureProcess();
    const home = join(tmpDir(), 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'agents.json'), 'nope');
    await main([`--home=${home}`, '--port=0'], baseEnv());
    expect(cap.exits).toEqual([1]);
    expect(cap.out).toEqual([]);
    const lines = cap.err.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`gonogo: ${join(home, 'agents.json')} is not usable (not valid JSON); fix or delete this file`);
    expect(cap.added('uncaughtException')).toEqual([]);
  });

  it('says that claude is missing in one line', async () => {
    installFakes();
    const cap = captureProcess();
    await main([`--home=${join(tmpDir(), 'home')}`, '--port=0'], { PATH: tmpDir() });
    expect(cap.exits).toEqual([1]);
    expect(cap.err.join('')).toBe('gonogo: the claude CLI was not found on PATH. Install Claude Code and sign in, or set GONOGO_AGENT_CMD.\n');
  });

  it('says what is wrong with a port that is in use', async () => {
    installFakes();
    const cap = captureProcess();
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const address = blocker.address();
    const taken = typeof address === 'object' && address ? address.port : 0;
    await main([`--home=${join(tmpDir(), 'home')}`, `--port=${taken}`], baseEnv());
    expect(cap.exits).toEqual([1]);
    expect(cap.err.join('')).toContain(`gonogo: cannot listen on 127.0.0.1:${taken}: the port is already in use (EADDRINUSE)`);
  });

  it('adds the stack of a failed start when the log level is debug', async () => {
    installFakes();
    const cap = captureProcess();
    await main([`--home=${join(tmpDir(), 'home')}`, '--port=0'], { PATH: tmpDir(), GONOGO_LOG_LEVEL: 'debug' });
    const text = cap.err.join('');
    expect(text.startsWith('gonogo: the claude CLI was not found on PATH.')).toBe(true);
    expect(text).toMatch(/\n\s+at /);
  });

  it('prints exactly one line on stdout once the server listens, and only log lines on stderr', async () => {
    const fakes = installFakes();
    const cap = captureProcess();
    const home = join(tmpDir(), 'home');
    const started = await runMain(cap, [`--home=${home}`, '--port=0'], baseEnv());
    expect(started).not.toBeNull();
    expect(cap.out).toHaveLength(1);
    expect(cap.exits).toEqual([]);
    expect(started?.url).toBe(`http://127.0.0.1:${started?.port}/#token=${readFileSync(join(home, 'token'), 'utf8').trim()}`);
    for (const line of cap.err.join('').trimEnd().split('\n')) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z (info |warn |error|debug) /);
    expect((await api(started?.port ?? 0, 'GET', '/api/state', undefined, started?.token)).status).toBe(200);
    expect(fakes.order).toContain('hub.start');
    cap.handler('SIGTERM')('SIGTERM');
    await waitFor(() => cap.exits.length > 0, 'the exit');
  });

  it('applies the flags: port, host, home, seed and allowed hosts, and a flag beats a variable even when the variable is garbage', async () => {
    const fakes = installFakes();
    const cap = captureProcess();
    const home = join(tmpDir(), 'home');
    const started = await runMain(cap, [`--home=${home}`, '--port=0', '--host=localhost', '--seed-claude', '--allow-host=gonogo.example.com'], {
      ...baseEnv(),
      GONOGO_PORT: 'garbage',
      GONOGO_HOST: '0.0.0.0',
      GONOGO_HOME: '/never/used',
      GONOGO_SEED_CLAUDE: '0',
      GONOGO_ALLOWED_HOSTS: 'env.example.com',
    });
    expect(started?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    expect(fakes.captured.launcherOptions).toMatchObject({ homeDir: home, seed: true });
    expect(existsSync(join(home, 'token'))).toBe(true);
    expect((await send(started?.port ?? 0, { path: '/api/state', headers: { ...bearer(started?.token ?? ''), Host: 'gonogo.example.com' } })).status).toBe(200);
    expect((await send(started?.port ?? 0, { path: '/api/state', headers: { ...bearer(started?.token ?? ''), Host: 'env.example.com' } })).status).toBe(403);
    cap.handler('SIGTERM')('SIGTERM');
    await waitFor(() => cap.exits.length > 0, 'the exit');
  });

  it.skipIf(!HAS_IPV6)('brackets an IPv6 host in the line it prints (contract 0.5 item 14)', async () => {
    installFakes();
    const cap = captureProcess();
    const started = await runMain(cap, [`--home=${join(tmpDir(), 'home')}`, '--port=0', '--host=::1'], baseEnv());
    expect(started?.url).toBe(`http://[::1]:${started?.port}/#token=${started?.token}`);
    expect(cap.out.join('')).toBe(`gonogo ready: ${started?.url}\n`);
    cap.handler('SIGTERM')('SIGTERM');
    await waitFor(() => cap.exits.length > 0, 'the exit');
  });

  it('uses the variables when no flag is given', async () => {
    const fakes = installFakes();
    const cap = captureProcess();
    const home = join(tmpDir(), 'home');
    const started = await runMain(cap, [], { ...baseEnv(), GONOGO_PORT: '0', GONOGO_HOME: home, GONOGO_SEED_CLAUDE: 'true', GONOGO_MAX_HOPS: '3' });
    expect(started).not.toBeNull();
    expect(fakes.captured.launcherOptions).toMatchObject({ homeDir: home, seed: true });
    expect(fakes.captured.hubOptions?.maxHops).toBe(3);
    cap.handler('SIGTERM')('SIGTERM');
    await waitFor(() => cap.exits.length > 0, 'the exit');
  });

  it('honours GONOGO_LOG_LEVEL', async () => {
    installFakes();
    const quiet = captureProcess();
    await runMain(quiet, [`--home=${join(tmpDir(), 'home')}`, '--port=0'], { ...baseEnv(), GONOGO_LOG_LEVEL: 'error' });
    expect(quiet.err).toEqual([]);
    quiet.handler('SIGTERM')('SIGTERM');
    await waitFor(() => quiet.exits.length > 0, 'the exit');
  });

  it('keeps the agents alive when a terminal or pipe closes: error listeners on stdout and stderr, installed once', async () => {
    installFakes();
    const cap = captureProcess();
    await runMain(cap, [`--home=${join(tmpDir(), 'home')}`, '--port=0'], baseEnv());
    const listeners = process.stdout.listenerCount('error') + process.stderr.listenerCount('error');
    expect(process.stdout.listenerCount('error')).toBeGreaterThan(0);
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0);
    cap.handler('SIGTERM')('SIGTERM');
    await waitFor(() => cap.exits.length > 0, 'the exit');
    const again = captureProcess();
    await runMain(again, [`--home=${join(tmpDir(), 'home')}`, '--port=0'], baseEnv());
    expect(process.stdout.listenerCount('error') + process.stderr.listenerCount('error')).toBe(listeners);
    expect(() => process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    expect(() => process.stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    again.handler('SIGTERM')('SIGTERM');
    await waitFor(() => again.exits.length > 0, 'the second exit');
  });

  describe('signals', () => {
    it.each([['SIGINT'], ['SIGTERM'], ['SIGHUP']])('stops gracefully on %s and then exits 0', async (signal) => {
      const fakes = installFakes();
      const cap = captureProcess();
      const home = join(tmpDir(), 'home');
      const started = await runMain(cap, [`--home=${home}`, '--port=0'], baseEnv());
      expect(cap.added(signal)).toHaveLength(1);
      cap.handler(signal)(signal);
      await waitFor(() => cap.exits.length > 0, 'the exit');
      expect(cap.exits).toEqual([0]);
      expect(fakes.order.filter((o) => o === 'hub.shutdown' || o === 'terminals.stopAll')).toEqual(['hub.shutdown', 'terminals.stopAll']);
      await expect(send(started?.port ?? 0, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(existsSync(join(home, LOCK_FILE))).toBe(false);
      expect(cap.err.join('')).toContain(`${signal} received; stopping`);
    });

    it('exits at once with 130 on a second signal, while the first is still stopping', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      installFakes({ stopAllGate: gate });
      const cap = captureProcess();
      await runMain(cap, [`--home=${join(tmpDir(), 'home')}`, '--port=0'], baseEnv());
      cap.handler('SIGINT')('SIGINT');
      await sleep(30);
      expect(cap.exits).toEqual([]);
      cap.handler('SIGTERM')('SIGTERM');
      expect(cap.exits).toEqual([130]);
      release();
      await waitFor(() => cap.exits.length === 2, 'the first stop to finish');
      expect(cap.exits).toEqual([130, 0]);
    });
  });

  describe('errors after the start', () => {
    const transient = ['ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP_HEADERS_SENT', 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'];

    it.each(transient.map((code) => [code]))('logs an uncaught %s at warn with its stack, keeps running and keeps serving', async (code) => {
      installFakes();
      const cap = captureProcess();
      const started = await runMain(cap, [`--home=${join(tmpDir(), 'home')}`, '--port=0'], baseEnv());
      const error = Object.assign(new Error(`socket trouble ${code}`), { code });
      cap.handler('uncaughtException')(error);
      cap.handler('unhandledRejection')(error);
      cap.handler('unhandledRejection')({ code });
      expect(cap.exits).toEqual([]);
      const text = cap.err.join('');
      expect(text).toMatch(new RegExp(`warn  uncaught exception ignored[^\\n]*\\n?[^]*socket trouble ${code}\\n\\s+at `));
      expect(text).toContain('unhandled rejection ignored');
      expect((await api(started?.port ?? 0, 'GET', '/api/state', undefined, started?.token)).status).toBe(200);
      cap.handler('SIGTERM')('SIGTERM');
      await waitFor(() => cap.exits.length > 0, 'the exit');
    });

    it('logs the stack, stops and exits 1 for an error that is not transient, once', async () => {
      const fakes = installFakes();
      const cap = captureProcess();
      const started = await runMain(cap, [`--home=${join(tmpDir(), 'home')}`, '--port=0'], baseEnv());
      cap.handler('uncaughtException')(new TypeError('a real bug'));
      await waitFor(() => cap.exits.length > 0, 'the exit');
      expect(cap.exits).toEqual([1]);
      expect(cap.err.join('')).toMatch(/error uncaught exception; stopping[^]*TypeError: a real bug\n\s+at /);
      expect(fakes.order.filter((o) => o === 'hub.shutdown')).toHaveLength(1);
      cap.handler('uncaughtException')(new Error('another one on the way down'));
      cap.handler('unhandledRejection')('a string reason');
      await sleep(30);
      expect(cap.exits).toEqual([1]);
      expect(fakes.order.filter((o) => o === 'hub.shutdown')).toHaveLength(1);
      await expect(send(started?.port ?? 0, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    it('treats a rejection that is not an error, and one without a transient code, as fatal', async () => {
      installFakes();
      const cap = captureProcess();
      await runMain(cap, [`--home=${join(tmpDir(), 'home')}`, '--port=0'], baseEnv());
      cap.handler('unhandledRejection')('just a string');
      await waitFor(() => cap.exits.length > 0, 'the exit');
      expect(cap.exits).toEqual([1]);
      expect(cap.err.join('')).toContain('unhandled rejection; stopping');
    });
  });
});

/* ================================================================================================================
 * web: the upgrade handler, with a socket the test controls
 * ============================================================================================================== */

describe('web: the upgrade handler keeps an error listener on the raw socket', () => {
  type UpgradeHandler = (req: IncomingMessage, socket: PassThrough, head: Buffer) => void;

  /** Starts a web server and returns the function it registered for 'upgrade', so that it can be driven without a network. */
  async function withUpgradeHandler(over: Partial<WebOptions> = {}): Promise<{ handler: UpgradeHandler; harness: Harness }> {
    const handlers: UpgradeHandler[] = [];
    const proto = EventEmitter.prototype as unknown as {
      on(this: EventEmitter, event: string | symbol, listener: (...args: unknown[]) => void): EventEmitter;
    };
    const original = proto.on;
    proto.on = function (this: EventEmitter, event, listener) {
      if (event === 'upgrade' && this instanceof HttpServer) handlers.push(listener as unknown as UpgradeHandler);
      return original.call(this, event, listener);
    };
    let harness: Harness;
    try {
      harness = await startWeb(over);
    } finally {
      proto.on = original;
    }
    const handler = handlers[0];
    if (!handler) throw new Error('the web server registered no upgrade handler');
    return { handler, harness };
  }

  function upgradeRequest(port: number, headers: Record<string, string>, over: { url?: string; method?: string } = {}): IncomingMessage {
    const req = new IncomingMessage(new Socket());
    req.url = over.url ?? '/ws';
    req.method = over.method ?? 'GET';
    req.headers = { host: `127.0.0.1:${port}`, upgrade: 'websocket', connection: 'upgrade', ...headers };
    return req;
  }

  const good = (): Record<string, string> => ({ 'sec-websocket-protocol': `${WS_SUBPROTOCOL}, token.${TOKEN}` });
  const reset = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

  it.each([
    ['a wrong token', 401, () => ({ 'sec-websocket-protocol': `${WS_SUBPROTOCOL}, token.${'f'.repeat(64)}` }), {}],
    ['no token', 401, () => ({}), {}],
    ['a foreign Host', 403, () => ({ ...good(), host: 'evil.example' }), {}],
    ['a foreign Origin', 403, () => ({ ...good(), origin: 'https://evil.example' }), {}],
    ['an Origin that is null', 403, () => ({ ...good(), origin: 'null' }), {}],
    ['a path that is not /ws', 404, good, { url: '/api/state' }],
    ['a double slash', 404, good, { url: '//' }],
    ['bad percent-encoding', 404, good, { url: '/%E0%A4%A' }],
    ['a method other than GET', 405, good, { method: 'POST' }],
  ] as Array<[string, number, () => Record<string, string>, { url?: string; method?: string }]>)(
    'answers %s with %s and survives the client resetting the connection afterwards',
    async (_what, status, headers, over) => {
      const { handler, harness } = await withUpgradeHandler();
      const socket = new PassThrough();
      const chunks: Buffer[] = [];
      socket.on('data', (c: Buffer) => chunks.push(c));
      handler(upgradeRequest(harness.port, headers(), over), socket, Buffer.alloc(0));
      expect(socket.listenerCount('error')).toBeGreaterThan(0);
      expect(() => socket.emit('error', reset())).not.toThrow();
      await waitFor(() => socket.destroyed, 'the socket to be destroyed');
      const text = Buffer.concat(chunks).toString('utf8');
      expect(text.startsWith(`HTTP/1.1 ${status} `)).toBe(true);
      expect(text).toContain('Connection: close');
      expect(() => socket.emit('error', reset())).not.toThrow();
      await expectStillServing(harness.port);
    },
  );

  it('answers 503 while the hub is starting, with the token check first', async () => {
    const { handler, harness } = await withUpgradeHandler();
    harness.state.ready = false;
    const starting = new PassThrough();
    const chunks: Buffer[] = [];
    starting.on('data', (c: Buffer) => chunks.push(c));
    handler(upgradeRequest(harness.port, good()), starting, Buffer.alloc(0));
    expect(starting.listenerCount('error')).toBeGreaterThan(0);
    await waitFor(() => starting.destroyed, 'the socket to be destroyed');
    expect(Buffer.concat(chunks).toString('utf8')).toMatch(/^HTTP\/1\.1 503 [^]*\r\n\r\n\{"error":"starting","code":"unavailable"\}$/);
    expect(() => starting.emit('error', reset())).not.toThrow();
  });

  it('destroys the socket, keeps a listener on it and answers nothing when the handler itself fails', async () => {
    const { log, lines } = collectingLog();
    const { handler, harness } = await withUpgradeHandler({ log });
    const socket = new PassThrough();
    const req = upgradeRequest(harness.port, good());
    Object.defineProperty(req, 'url', {
      get(): string {
        throw new Error('the request object broke');
      },
    });
    expect(() => handler(req, socket, Buffer.alloc(0))).not.toThrow();
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount('error')).toBeGreaterThan(0);
    expect(() => socket.emit('error', reset())).not.toThrow();
    expect(lines.some((l) => l.includes('error') && l.includes('the request object broke'))).toBe(true);
    await expectStillServing(harness.port);
  });
});

/* ================================================================================================================
 * bin/gonogo.js
 * ============================================================================================================== */

/** A copy of the shim next to a fake dist, so that what the import throws is under the test's control. */
function fakeInstall(cliSource: string): { bin: string; root: string } {
  const root = tmpDir();
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'dist', 'server'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  copyFileSync(join(PROJECT_ROOT, 'bin', 'gonogo.js'), join(root, 'bin', 'gonogo.js'));
  writeFileSync(join(root, 'dist', 'server', 'cli.js'), cliSource);
  return { bin: join(root, 'bin', 'gonogo.js'), root };
}

function runBin(bin: string, args: string[] = [], env: Record<string, string> = {}, nodeArgs: string[] = []) {
  return spawnSync(process.execPath, [...nodeArgs, bin, ...args], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', ...env } });
}

describe('bin/gonogo.js', () => {
  it('has the shebang and the exec bit, and imports nothing before the version check', () => {
    const file = join(PROJECT_ROOT, 'bin', 'gonogo.js');
    const source = readFileSync(file, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).toContain("import('../dist/server/cli.js')");
  });

  it('prints one gonogo: <message> line and exits 1 when the import throws', async () => {
    const { bin } = fakeInstall("throw new Error('could not load @lydell/node-pty-darwin-arm64: it is not installed (was it installed with --omit=optional?)');");
    const run = runBin(bin);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('gonogo: could not load @lydell/node-pty-darwin-arm64: it is not installed (was it installed with --omit=optional?)\n');
  });

  it('prints a message of many lines as one, the way the README promises', async () => {
    const lines = ['The platform package is missing:', '', '\t@lydell/node-pty-darwin-arm64', '', 'Do not install with --omit=optional.  '];
    const run = runBin(fakeInstall(`throw new Error(${JSON.stringify(lines.join('\r\n'))});`).bin);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('gonogo: The platform package is missing: @lydell/node-pty-darwin-arm64 Do not install with --omit=optional.\n');
    expect(runBin(fakeInstall("throw 'a\\n\\nb\\tc';").bin).stderr).toBe('gonogo: a b c\n');
  });

  it('adds the stack only when the log level is debug', async () => {
    const { bin } = fakeInstall("throw new Error('loader failed', { cause: new Error('inner') });");
    const quiet = runBin(bin);
    expect(quiet.stderr).toBe('gonogo: loader failed\n');
    const debug = runBin(bin, [], { GONOGO_LOG_LEVEL: 'debug' });
    expect(debug.status).toBe(1);
    expect(debug.stderr.startsWith('gonogo: loader failed\n')).toBe(true);
    expect(debug.stderr).toMatch(/\n\s+at /);
  });

  it('prints a thrown string too, and an error thrown by main itself', async () => {
    expect(runBin(fakeInstall("throw 'plain words';").bin).stderr).toBe('gonogo: plain words\n');
    const main = runBin(fakeInstall("export async function main() { throw new Error('boom from main'); }").bin);
    expect(main.status).toBe(1);
    expect(main.stderr).toBe('gonogo: boom from main\n');
  });

  it('hands the arguments after the script to main, and leaves the exit code to it', async () => {
    const { bin } = fakeInstall("export async function main(argv) { process.stdout.write(JSON.stringify(argv) + '\\n'); }");
    const run = runBin(bin, ['--port=1', 'x y', '--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('["--port=1","x y","--help"]\n');
    expect(run.stderr).toBe('');
  });

  it.each([['18.20.0'], ['22.20.1'], ['23.9.9'], ['9.0.0'], ['4.8.4']])('refuses Node %s before it imports anything', async (version) => {
    const { bin, root } = fakeInstall("import { writeFileSync } from 'node:fs'; writeFileSync(new URL('../../imported', import.meta.url), 'yes'); export async function main() {}");
    const preload = join(root, 'old-node.mjs');
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: '${version}' });\n`);
    const run = runBin(bin, [], {}, ['--import', `file://${preload}`]);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(`gonogo needs Node 24 or newer (this is ${version}).\n`);
    expect(existsSync(join(root, 'imported'))).toBe(false);
  });

  it.each([['24.0.0'], ['24.18.0'], ['26.1.0'], ['100.0.0']])('lets Node %s through', async (version) => {
    const { bin, root } = fakeInstall("import { writeFileSync } from 'node:fs'; writeFileSync(new URL('../../imported', import.meta.url), 'yes'); export async function main() {}");
    const preload = join(root, 'new-node.mjs');
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: '${version}' });\n`);
    const run = runBin(bin, [], {}, ['--import', `file://${preload}`]);
    expect(run.status).toBe(0);
    expect(existsSync(join(root, 'imported'))).toBe(true);
  });
});

/* ================================================================================================================
 * seams: what cli.ts imports from the other builders' files (contract 0.1: builder E owns this check)
 * ============================================================================================================== */

describe('seams with the real hub, launcher and terminal host', () => {
  const members = (o: object): string[] => Object.keys(o).sort();

  it('exports the factories cli.ts calls, and they return what cli.ts uses', async () => {
    const hubModule = await vi.importActual<typeof import('../src/server/hub.js')>('../src/server/hub.js');
    const launcherModule = await vi.importActual<typeof import('../src/server/launcher.js')>('../src/server/launcher.js');
    const terminalModule = await vi.importActual<typeof import('../src/server/terminal.js')>('../src/server/terminal.js');
    expect(typeof hubModule.createHub).toBe('function');
    expect(typeof launcherModule.createLauncher).toBe('function');
    expect(typeof launcherModule.parseAgentCmd).toBe('function');
    expect(typeof terminalModule.createTerminalHost).toBe('function');

    expect(launcherModule.parseAgentCmd(undefined)).toBeNull();
    expect(launcherModule.parseAgentCmd('node a.mjs')).toEqual(['node', 'a.mjs']);
    expect(launcherModule.parseAgentCmd('["node","a b.mjs"]')).toEqual(['node', 'a b.mjs']);

    const terminals = terminalModule.createTerminalHost({ log: nullLogger });
    expect(members(terminals)).toEqual(
      ['attach', 'forget', 'info', 'onEvent', 'outputBytes', 'rename', 'resize', 'screen', 'spawn', 'stop', 'stopAll', 'submit', 'title', 'write'].sort(),
    );

    const home = tmpDir();
    const launcher = launcherModule.createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:1', seed: false, env: {}, log: nullLogger });
    expect(members(launcher)).toEqual(['memoryPath', 'prepareStart', 'renameAgentFiles', 'resolveToken', 'revoke']);
    expect(launcher.resolveToken('f'.repeat(64))).toBeNull();

    const io = {
      now: () => 0,
      setTimer: () => undefined,
      clearTimer: () => undefined,
      newMessageId: () => 'm1',
      newSessionId: () => '123e4567-e89b-42d3-a456-426614174000',
      checkDirectory: async (p: string) => ({ ok: true as const, path: p }),
      loadRoster: async (): Promise<RosterFile> => ({ version: 1, agents: [] }),
      saveRoster: async () => undefined,
      loadHistory: async () => [],
      logMessage: () => undefined,
      renameAgentFiles: async () => undefined,
      spawn: async () => ({ generation: 1, flag: 'session-id' as const, pid: 1 }),
      stop: async () => undefined,
      typePointer: () => true,
      screen: () => null,
      title: () => null,
      outputBytes: () => 0,
      emit: () => undefined,
      log: nullLogger,
    } satisfies HubIo;
    const hub = hubModule.createHub(io, { maxHops: 8, bossDir: home });
    for (const member of ['start', 'shutdown', 'views', 'activity', 'hire', 'edit', 'restart', 'stop', 'remove', 'sendFromUser', 'sendFromAgent', 'readMessages', 'rosterFor', 'startPoll', 'holdPoll', 'abortPoll', 'clearPoll', 'poll', 'vote', 'setGovernor', 'answer', 'governor', 'onHook', 'onUserInput', 'onTerminalEvent']) {
      expect(typeof (hub as unknown as Record<string, unknown>)[member], member).toBe('function');
    }
  });

  it('starts, serves and stops with the real hub, launcher and terminal host behind cli.ts', async () => {
    const hubModule = await vi.importActual<typeof import('../src/server/hub.js')>('../src/server/hub.js');
    const launcherModule = await vi.importActual<typeof import('../src/server/launcher.js')>('../src/server/launcher.js');
    const terminalModule = await vi.importActual<typeof import('../src/server/terminal.js')>('../src/server/terminal.js');
    factories.createHub.mockImplementation(hubModule.createHub);
    factories.createLauncher.mockImplementation(launcherModule.createLauncher);
    factories.parseAgentCmd.mockImplementation(launcherModule.parseAgentCmd);
    factories.createTerminalHost.mockImplementation(terminalModule.createTerminalHost);
    // a command that stays alive and prints nothing: the boss is spawned for real and waits in "starting"
    const { running, home } = await startCli({ agentCmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)', '--'] });
    const res = await api(running.port, 'GET', '/api/state', undefined, running.browserToken);
    expect(res.status).toBe(200);
    const state = res.json() as { agents: AgentView[] };
    expect(state.agents.map((a) => [a.name, a.boss, a.generation])).toEqual([['flight', true, 1]]);
    expect(existsSync(join(home, 'agents', 'flight', 'settings.json'))).toBe(true);
    const agentToken = readFileSync(join(home, 'agents', 'flight', 'token'), 'utf8').trim();
    // the token the launcher wrote is the one the hook and MCP endpoints accept, and the hub reacts to the hook
    const hook = await postHook(running.port, '/hook/flight/UserPromptSubmit', { token: agentToken, body: JSON.stringify({ prompt: 'hi' }) });
    expect(hook.status).toBe(200);
    const after = (await api(running.port, 'GET', '/api/state', undefined, running.browserToken)).json() as { agents: AgentView[] };
    expect(after.agents[0]?.state).toBe('working');
    const client = await connectMcp(running.port, agentToken);
    const sent = toolOutcome(await client.callTool({ name: 'send_message', arguments: { to: 'user', body: 'hello from the boss' } }));
    expect(sent.json).toMatchObject({ ok: true, to: 'user', status: 'to_user' });
    await running.stop();
    expect(existsSync(join(home, LOCK_FILE))).toBe(false);
    await expect(send(running.port, { path: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

/* ================================================================================================================
 * the conventions of contract section 11, for the files of this builder
 * ============================================================================================================== */

describe('plot board', () => {
  const view = { text: 'ship it', revision: 2, author: 'flight', updatedAt: 5 };
  /** A board that records what the routes and the tools ask of it, and refuses a revision that is not the current one. */
  function fakeBoard(): { calls: unknown[][]; board: NonNullable<WebOptions['board']> } {
    const calls: unknown[][] = [];
    return {
      calls,
      board: {
        get: () => {
          calls.push(['get']);
          return view;
        },
        write: async (by, input) => {
          calls.push(['write', by, input]);
          const body = input as { text?: unknown; revision?: unknown };
          if (typeof body.text !== 'string') throw new FakeHubError('bad_request', 'text is required', 'text');
          if (body.revision !== 2) throw new FakeHubError('conflict', `the Plot Board is at revision 2, not ${String(body.revision)}: read it again, then write`, 'revision');
          return { ...view, text: body.text, revision: 3, author: by };
        },
      },
    };
  }
  const asBoss = { rosterFor: (agent: string) => ({ you: agent, boss: 'ana', agents: [], specialRecipients: ['boss', 'user'] }) };

  it('reads and writes the plan as the Director, with the revision it was made from', async () => {
    const { calls, board } = fakeBoard();
    const { port } = await startWeb({ board });
    expect((await api(port, 'GET', '/api/board')).json()).toEqual(view);
    const put = await api(port, 'PUT', '/api/board', { text: 'new plan', revision: 2 });
    expect([put.status, put.json()]).toEqual([200, { text: 'new plan', revision: 3, author: 'user', updatedAt: 5 }]);
    expect(calls[1]).toEqual(['write', 'user', { text: 'new plan', revision: 2 }]);
    const stale = await api(port, 'PUT', '/api/board', { text: 'late', revision: 1 });
    expect([stale.status, stale.json()]).toEqual([409, { error: 'the Plot Board is at revision 2, not 1: read it again, then write', code: 'conflict', field: 'revision' }]);
    expect((await api(port, 'PUT', '/api/board', { revision: 2 })).json()).toEqual({ error: 'text is required', code: 'bad_request', field: 'text' });
    expect((await api(port, 'PUT', '/api/board', [1])).status).toBe(400);
  });

  it('allows GET and PUT only, wants a browser token, and is 404 without a board', async () => {
    const { board } = fakeBoard();
    const { port } = await startWeb({ board });
    for (const method of ['POST', 'PATCH', 'DELETE']) expect((await api(port, method, '/api/board', {})).status, method).toBe(405);
    expect((await api(port, 'GET', '/api/board/x')).status).toBe(404);
    expect((await api(port, 'GET', '/api/board', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'PUT', '/api/board', { text: 'x', revision: 2 }, ANA_TOKEN)).status).toBe(401);
    expect((await api((await startWeb()).port, 'GET', '/api/board')).status).toBe(404);
  });

  it('lets every agent read it, and says whether it may write', async () => {
    const { board } = fakeBoard();
    const { port } = await startWeb({ board });
    const ben = await connectMcp(port, BEN_TOKEN);
    expect(toolOutcome(await ben.callTool({ name: 'board_read', arguments: {} }))).toMatchObject({ isError: false, json: { ok: true, ...view, canWrite: false } });
    const boss = await connectMcp((await startWeb({ board }, asBoss)).port, ANA_TOKEN);
    expect(toolOutcome(await boss.callTool({ name: 'board_read', arguments: {} }))).toMatchObject({ isError: false, json: { ok: true, canWrite: true } });
  });

  it('lets only the boss write it, as itself whatever the call says, and never answers with the text', async () => {
    const { calls, board } = fakeBoard();
    const other = await startWeb({ board });
    const ben = await connectMcp(other.port, BEN_TOKEN);
    const refused = toolOutcome(await ben.callTool({ name: 'board_write', arguments: { text: 'mine', revision: 2 } }));
    expect(refused).toMatchObject({ isError: true, text: '{"ok":false,"error":"only the boss may write the Plot Board"}' });
    expect(calls).toEqual([]);
    const { port } = await startWeb({ board }, asBoss);
    const ana = await connectMcp(port, ANA_TOKEN);
    const written = toolOutcome(await ana.callTool({ name: 'board_write', arguments: { text: 'the plan', revision: 2, author: 'user' } }));
    expect(written).toMatchObject({ isError: false, json: { ok: true, revision: 3, updatedAt: 5 } });
    expect(written.text).not.toContain('the plan');
    expect(calls).toEqual([['write', 'ana', { text: 'the plan', revision: 2 }]]);
  });

  it('tells the boss to read again when the board moved on', async () => {
    const { board } = fakeBoard();
    const { port } = await startWeb({ board }, asBoss);
    const ana = await connectMcp(port, ANA_TOKEN);
    expect(toolOutcome(await ana.callTool({ name: 'board_write', arguments: { text: 'x', revision: 1 } }))).toMatchObject({
      isError: true,
      text: '{"ok":false,"error":"the Plot Board is at revision 2, not 1: read it again, then write"}',
    });
  });

  it('refuses a bad argument without calling the board', async () => {
    const { calls, board } = fakeBoard();
    const { port } = await startWeb({ board }, asBoss);
    const ana = await connectMcp(port, ANA_TOKEN);
    for (const args of [{}, { text: 'x' }, { revision: 1 }, { text: 'x'.repeat(10_001), revision: 2 }, { text: 5, revision: 2 }, { text: 'x', revision: -1 }, { text: 'x', revision: 1.5 }, { text: 'x', revision: '2' }]) {
      const out = await ana.callTool({ name: 'board_write', arguments: args }).catch(() => ({ isError: true }));
      expect((out as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('says the board is not available when the server has none', async () => {
    const { port } = await startWeb({}, asBoss);
    const ana = await connectMcp(port, ANA_TOKEN);
    for (const [name, args] of [['board_read', {}], ['board_write', { text: 'x', revision: 0 }]] as const) {
      expect(toolOutcome(await ana.callTool({ name, arguments: args }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"the Plot Board is not available"}' });
    }
  });

  it('describes its two tools as the server says', async () => {
    const { board } = fakeBoard();
    const { port } = await startWeb({ board });
    const tools = (await (await connectMcp(port)).listTools()).tools;
    const read = tools.find((t) => t.name === 'board_read');
    const write = tools.find((t) => t.name === 'board_write');
    expect(read?.description).toBe(MCP_DESCRIPTIONS.board_read);
    expect(write?.description).toBe(MCP_DESCRIPTIONS.board_write);
    expect(Object.keys(write?.inputSchema.properties ?? {}).sort()).toEqual(['revision', 'text']);
    expect([...(write?.inputSchema.required ?? [])].sort()).toEqual(['revision', 'text']);
    expect(write?.inputSchema.properties?.text).toMatchObject({ maxLength: 10_000 });
  });
});

describe('black box', () => {
  const view = { git: 'ok', note: '', dir: '/home/x/black-box', command: "git -C '/home/x/black-box' log -p", events: [{ at: 1, kind: 'crew', text: 'Director hired ana' }] };

  it('lists the recent events and the command, to the browser only', async () => {
    const { port } = await startWeb({ blackBox: { view: () => view as never } });
    expect((await api(port, 'GET', '/api/black-box')).json()).toEqual(view);
    expect((await api(port, 'GET', '/api/black-box', undefined, ANA_TOKEN)).status).toBe(401);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await api(port, method, '/api/black-box', {})).status, method).toBe(405);
    expect((await api(port, 'GET', '/api/black-box/x')).status).toBe(404);
  });

  it('is 404 without a Black Box', async () => {
    expect((await api((await startWeb()).port, 'GET', '/api/black-box')).status).toBe(404);
  });

  it('gives the agents no tool to read or write it', async () => {
    const { port } = await startWeb({ blackBox: { view: () => view as never } });
    const names = (await (await connectMcp(port)).listTools()).tools.map((t) => t.name);
    expect(names.filter((name) => /audit|black|box|record/i.test(name))).toEqual([]);
  });
});

describe('conventions', () => {
  const sources = ['home', 'hooks', 'mcp', 'web', 'cli'].map((name) => [name, readFileSync(join(PROJECT_ROOT, 'src', 'server', `${name}.ts`), 'utf8')] as const);

  it.each(sources)('%s.ts has no console, any, ts-ignore, this, class or TODO', (_name, source) => {
    expect(source).not.toMatch(/\bconsole\./);
    expect(source).not.toMatch(/:\s*any\b|\bas any\b|<any>|@ts-ignore|@ts-expect-error|@ts-nocheck/);
    expect(source).not.toMatch(/\bthis\.[A-Za-z_]/);
    expect(source).not.toMatch(/^\s*(export\s+)?class\s/m);
    expect(source).not.toMatch(/\bTODO\b|\bFIXME\b/);
  });

  it.each(sources)('%s.ts ends every relative import with .js', (_name, source) => {
    for (const match of source.matchAll(/from '(\.{1,2}\/[^']*)'/g)) expect(match[1]).toMatch(/\.js$/);
  });

  it('exits the process only from main in cli.ts', () => {
    for (const [name, source] of sources) {
      if (name !== 'cli') expect(source, name).not.toMatch(/process\.exit/);
    }
  });

  it('keeps the modules in the import order of contract 0.3 item 11: only cli.ts imports hub, launcher, terminal, home and web', () => {
    for (const [name, source] of sources) {
      if (name === 'cli') continue;
      expect(source, name).not.toMatch(/from '\.\/(hub|launcher|terminal|cli)\.js'/);
    }
    expect(sources.find(([name]) => name === 'home')?.[1]).not.toMatch(/from '\.\/(hooks|mcp|web)\.js'/);
  });
});

describe('missions', () => {
  const asBoss = { rosterFor: (agent: string) => ({ you: agent, boss: 'ana', agents: [], specialRecipients: ['boss', 'user'] }) };
  const mission = { id: 'ms1', name: 'Ship', goal: '', status: 'planned', lead: 'ana', createdBy: 'user', createdAt: 1, updatedAt: 1, startedAt: null, endedAt: null, history: [] };
  /** A missions that records what the routes and the tools ask of it, with the actor it was asked as. */
  function fakeMissions(): { calls: unknown[][]; missions: NonNullable<WebOptions['missions']> } {
    const calls: unknown[][] = [];
    const known = (id: string): void => {
      if (id !== 'ms1') throw new FakeHubError('not_found', 'unknown mission');
    };
    return {
      calls,
      missions: {
        list: () => [mission, { ...mission, id: 'ms2', status: 'active', updatedAt: 9 }] as never,
        create: async (actor, input) => {
          calls.push(['create', actor, input]);
          if ((input as { name?: unknown }).name === 'bad') throw new FakeHubError('bad_request', 'name must be 1 to 80 characters on one line', 'name');
          return mission as never;
        },
        update: async (actor, id, input) => {
          calls.push(['update', actor, id, input]);
          known(id);
          return { ...mission, status: 'active' } as never;
        },
        remove: async (id, unlink) => {
          calls.push(['remove', id, unlink]);
          known(id);
          if (!unlink) throw new FakeHubError('conflict', 'the mission has 1 linked task', 'unlink');
        },
      },
    };
  }

  it('lists, makes, changes and removes missions as the Director, and unlink is a query flag', async () => {
    const { calls, missions } = fakeMissions();
    const { port } = await startWeb({ missions });
    expect((await api(port, 'GET', '/api/missions')).json()).toHaveLength(2);
    const made = await api(port, 'POST', '/api/missions', { name: 'Ship', createdBy: 'flight' });
    expect([made.status, made.json()]).toEqual([201, mission]);
    expect((await api(port, 'POST', '/api/missions', { name: 'bad' })).json()).toEqual({ error: 'name must be 1 to 80 characters on one line', code: 'bad_request', field: 'name' });
    expect((await api(port, 'PATCH', '/api/missions/ms1', { status: 'active' })).json()).toMatchObject({ status: 'active' });
    expect((await api(port, 'PATCH', '/api/missions/ms9', { status: 'active' })).status).toBe(404);
    const refused = await api(port, 'DELETE', '/api/missions/ms1');
    expect([refused.status, refused.json()]).toEqual([409, { error: 'the mission has 1 linked task', code: 'conflict', field: 'unlink' }]);
    expect((await api(port, 'DELETE', '/api/missions/ms1?unlink=1')).status).toBe(204);
    expect(calls).toContainEqual(['create', { kind: 'user' }, { name: 'Ship', createdBy: 'flight' }]);
    expect(calls).toContainEqual(['remove', 'ms1', true]);
    expect(calls).toContainEqual(['remove', 'ms1', false]);
  });

  it('wants a browser token, answers 405 to other methods, shows the list in the first state frame and is 404 without missions', async () => {
    const { missions } = fakeMissions();
    const { port } = await startWeb({ missions });
    expect((await api(port, 'GET', '/api/missions', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'PATCH', '/api/missions', {})).status).toBe(405);
    expect((await api(port, 'POST', '/api/missions/ms1', {})).status).toBe(405);
    expect((await openWs(port)).frames[0]).toMatchObject({ t: 'state', state: { missions: [{ id: 'ms1' }, { id: 'ms2' }] } });
    const none = await startWeb();
    expect((await api(none.port, 'GET', '/api/missions')).status).toBe(404);
    expect((await api(none.port, 'DELETE', '/api/missions/ms1')).status).toBe(404);
  });

  it('lets every agent list the missions with the progress of their tasks, newest change first', async () => {
    const { missions } = fakeMissions();
    const { tasks } = (() => {
      const base = { id: 't1', title: 'a', detail: '', status: 'done', assignee: null, createdBy: 'user', createdAt: 1, updatedAt: 1, notes: [], missionId: 'ms1' };
      return { tasks: { list: () => [base, { ...base, id: 't2', status: 'doing' }, { ...base, id: 't3', missionId: undefined }] as never, create: async () => base as never, update: async () => base as never, remove: async () => undefined } };
    })();
    const { port } = await startWeb({ missions, tasks });
    const ben = await connectMcp(port, BEN_TOKEN);
    const out = toolOutcome(await ben.callTool({ name: 'mission_list', arguments: {} }));
    expect(out).toMatchObject({ isError: false, json: { count: 2, missions: [{ id: 'ms2', tasksTotal: 0 }, { id: 'ms1', tasksDone: 1, tasksTotal: 2 }] } });
    expect(toolOutcome(await ben.callTool({ name: 'mission_list', arguments: { status: 'active' } })).json).toMatchObject({ count: 1 });
    expect(toolOutcome(await ben.callTool({ name: 'mission_list', arguments: { status: 'finished' } })).isError).toBe(true);
  });

  it('lets only the boss make or change a mission, as itself whatever the call says', async () => {
    const { calls, missions } = fakeMissions();
    const other = await startWeb({ missions });
    const ben = await connectMcp(other.port, BEN_TOKEN);
    expect(toolOutcome(await ben.callTool({ name: 'mission_create', arguments: { name: 'x' } }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"only the boss may change missions"}' });
    expect(toolOutcome(await ben.callTool({ name: 'mission_update', arguments: { id: 'ms1', status: 'done' } })).isError).toBe(true);
    expect(calls).toEqual([]);
    const { port } = await startWeb({ missions }, asBoss);
    const ana = await connectMcp(port, ANA_TOKEN);
    const made = toolOutcome(await ana.callTool({ name: 'mission_create', arguments: { name: 'Ship', goal: 'g', lead: 'ben', createdBy: 'user' } }));
    expect(made).toMatchObject({ isError: false, json: { ok: true, mission } });
    const moved = toolOutcome(await ana.callTool({ name: 'mission_update', arguments: { id: 'ms1', status: 'active', note: 'go', name: 'renamed' } }));
    expect(moved).toMatchObject({ isError: false, json: { ok: true } });
    expect(calls).toEqual([
      ['create', { kind: 'agent', name: 'ana', generation: 3 }, { name: 'Ship', goal: 'g', lead: 'ben' }],
      ['update', { kind: 'agent', name: 'ana', generation: 3 }, 'ms1', { status: 'active', note: 'go' }],
    ]);
  });

  it('answers that missions are not available without them', async () => {
    const { port } = await startWeb({}, asBoss);
    const ana = await connectMcp(port, ANA_TOKEN);
    for (const [name, args] of [['mission_list', {}], ['mission_create', { name: 'x' }], ['mission_update', { id: 'ms1' }]] as const) {
      expect(toolOutcome(await ana.callTool({ name, arguments: args }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"Missions are not available"}' });
    }
  });
});

describe('post-flight review', () => {
  const place = { state: 'exact', line: 3 };
  const noteView = { id: 'rn1', agent: 'ana', path: 'a.ts', side: 'new', line: 3, text: 'c', body: 'Why?', tone: 'info', author: 'user', status: 'open', createdAt: 1, updatedAt: 1, place };
  const file = { path: 'a.ts', status: 'modified', binary: false, hunks: [{ header: '@@ -1 +1,2 @@', oldStart: 1, oldCount: 1, newStart: 1, newCount: 2, lines: [{ kind: 'ctx', old: 1, new: 1, text: 'a' }, { kind: 'add', old: null, new: 2, text: 'c' }] }] };
  const view = { repo: true, files: [file], truncated: false, diffHash: 'abc', notes: [noteView, { ...noteView, id: 'rn2', replyTo: 'rn1', tone: undefined, author: 'ana' }], verdict: { verdict: 'changes', at: 1, diffHash: 'abc', by: 'user' }, stale: false, asked: ['ben'] };
  /** A review that records what the routes and the tools ask of it, with the actor. */
  function fakeReview(): { calls: unknown[][]; review: NonNullable<WebOptions['review']> } {
    const calls: unknown[][] = [];
    const known = (name: string): void => {
      if (name !== 'ana') throw new FakeHubError('not_found', 'unknown agent');
    };
    return {
      calls,
      review: {
        view: async (name) => {
          calls.push(['view', name]);
          known(name);
          return view as never;
        },
        read: async (name, as, opts) => {
          calls.push(['read', name, as, opts]);
          known(name);
          if (as.kind === 'agent' && as.name === 'cat') throw new FakeHubError('forbidden', 'only the author, or an agent the Director asked to review this diff, may do that');
          return { view: view as never, ...(opts?.patch === true ? { patch: 'diff --git a/a.ts b/a.ts\n', patchTruncated: true } : {}) };
        },
        addNote: async (actor, name, input) => {
          calls.push(['addNote', actor, name, input]);
          known(name);
          if ((input as { body?: unknown }).body === 'bad') throw new FakeHubError('bad_request', 'body must be text of 1 to 2000 characters', 'body');
          return noteView as never;
        },
        addNotes: async (actor, name, inputs) => {
          calls.push(['addNotes', actor, name, inputs]);
          known(name);
          return [noteView, { ...noteView, id: 'rn2' }] as never;
        },
        update: async (name, id, input) => {
          calls.push(['update', name, id, input]);
          known(name);
          return { ...noteView, status: 'resolved' } as never;
        },
        remove: async (name, id) => {
          calls.push(['remove', name, id]);
          known(name);
        },
        verdict: async (name, input) => {
          calls.push(['verdict', name, input]);
          known(name);
          return { message: 'm5', notes: 2, verdict: view.verdict } as never;
        },
        ask: async (name, input) => {
          calls.push(['ask', name, input]);
          known(name);
          return { message: 'm6', notes: 0 };
        },
      },
    };
  }

  it('serves the diff, the notes and the verdict, and takes, resolves and deletes notes as the Director', async () => {
    const { calls, review } = fakeReview();
    const { port } = await startWeb({ review });
    expect((await api(port, 'GET', '/api/agents/ana/review')).json()).toEqual(view);
    const made = await api(port, 'POST', '/api/agents/ana/review/notes', { path: 'a.ts', side: 'new', line: 3, body: 'Why?', author: 'ben' });
    expect([made.status, made.json()]).toEqual([201, noteView]);
    expect((await api(port, 'POST', '/api/agents/ana/review/notes', { body: 'bad' })).json()).toEqual({ error: 'body must be text of 1 to 2000 characters', code: 'bad_request', field: 'body' });
    expect((await api(port, 'PATCH', '/api/agents/ana/review/notes/rn1', { status: 'resolved' })).json()).toMatchObject({ status: 'resolved' });
    expect((await api(port, 'DELETE', '/api/agents/ana/review/notes/rn1')).status).toBe(204);
    expect(calls).toContainEqual(['addNote', { kind: 'user' }, 'ana', { path: 'a.ts', side: 'new', line: 3, body: 'Why?', author: 'ben' }]);
    expect(calls).toContainEqual(['update', 'ana', 'rn1', { status: 'resolved' }]);
    expect(calls).toContainEqual(['remove', 'ana', 'rn1']);
  });

  it('gives a verdict and asks for a walkthrough or a peer review, and answers 404 for an unknown agent', async () => {
    const { calls, review } = fakeReview();
    const { port } = await startWeb({ review });
    expect((await api(port, 'POST', '/api/agents/ana/review/verdict', { verdict: 'changes' })).json()).toMatchObject({ message: 'm5', notes: 2 });
    expect((await api(port, 'POST', '/api/agents/ana/review/ask', { kind: 'walkthrough' })).json()).toEqual({ message: 'm6', notes: 0 });
    expect((await api(port, 'POST', '/api/agents/ana/review/ask', { kind: 'peer', reviewer: 'ben' })).json()).toEqual({ message: 'm6', notes: 0 });
    expect(calls.filter((c) => c[0] === 'verdict' || c[0] === 'ask')).toEqual([['verdict', 'ana', { verdict: 'changes' }], ['ask', 'ana', { kind: 'walkthrough' }], ['ask', 'ana', { kind: 'peer', reviewer: 'ben' }]]);
    expect((await api(port, 'GET', '/api/agents/zed/review')).status).toBe(404);
    expect((await api(port, 'POST', '/api/agents/zed/review/verdict', { verdict: 'approved' })).status).toBe(404);
    expect((await api(port, 'POST', '/api/agents/ana/review/verdict', [1])).status).toBe(400);
  });

  it('wants a browser token, allows only the right methods, and is 404 without a review', async () => {
    const { review } = fakeReview();
    const { port } = await startWeb({ review });
    expect((await api(port, 'GET', '/api/agents/ana/review', undefined, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'POST', '/api/agents/ana/review/verdict', { verdict: 'approved' }, ANA_TOKEN)).status).toBe(401);
    expect((await api(port, 'POST', '/api/agents/ana/review')).status).toBe(405);
    expect((await api(port, 'GET', '/api/agents/ana/review/ask')).status).toBe(405);
    expect((await api(port, 'PUT', '/api/agents/ana/review/notes', {})).status).toBe(405);
    expect((await api(port, 'GET', '/api/agents/ana/review/send')).status).toBe(404);
    expect((await api(port, 'GET', '/api/agents/ana/review/notes/rn1/more')).status).toBe(404);
    const none = await startWeb();
    expect((await api(none.port, 'GET', '/api/agents/ana/review')).status).toBe(404);
  });

  it('gives an agent review_read: its own diff by default, the structure first and the patch only on request', async () => {
    const { calls, review } = fakeReview();
    const { port } = await startWeb({ review });
    const ana = await connectMcp(port, ANA_TOKEN);
    const out = toolOutcome(await ana.callTool({ name: 'review_read', arguments: {} }));
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({
      agent: 'ana',
      repo: true,
      truncated: false,
      files: [{ path: 'a.ts', status: 'modified', hunks: [{ h: '@@ -1 +1,2 @@', old: [1, 1], new: [1, 2] }] }],
      notes: [{ id: 'rn1', path: 'a.ts', line: 3, place: 'exact', tone: 'info', author: 'user', status: 'open', body: 'Why?' }, { id: 'rn2', replyTo: 'rn1', author: 'ana' }],
      verdict: { verdict: 'changes', current: true },
    });
    expect(JSON.stringify(out.json)).not.toContain('"patch"');
    expect(calls[0]).toEqual(['read', 'ana', { kind: 'agent', name: 'ana' }, { patch: false, path: undefined }]);
    const withPatch = toolOutcome(await ana.callTool({ name: 'review_read', arguments: { agent: 'ana', patch: true, path: 'a.ts' } }));
    expect(withPatch.json).toMatchObject({ patch: 'diff --git a/a.ts b/a.ts\n', patchTruncated: true });
    expect(calls.at(-1)).toEqual(['read', 'ana', { kind: 'agent', name: 'ana' }, { patch: true, path: 'a.ts' }]);
    expect(toolOutcome(await ana.callTool({ name: 'review_read', arguments: { agent: 'zed' } })).isError).toBe(true);
  });

  it('answers forbidden to an agent that was not asked, with the reason', async () => {
    const { review } = fakeReview();
    const { port } = await startWeb({ review: { ...review, read: async () => Promise.reject(new FakeHubError('forbidden', 'only the author, or an agent the Director asked to review this diff, may do that')) } });
    const out = toolOutcome(await (await connectMcp(port, BEN_TOKEN)).callTool({ name: 'review_read', arguments: { agent: 'ana' } }));
    expect(out.isError).toBe(true);
    expect(out.text).toContain('only the author');
  });

  it('gives an agent review_note, authored by the agent of its token whatever the call says, on its own diff by default, and refuses a field it does not have', async () => {
    const { calls, review } = fakeReview();
    const { port } = await startWeb({ review });
    const ben = await connectMcp(port, BEN_TOKEN);
    const notes = [{ path: 'a.ts', side: 'new', line: 3, body: 'Why?', tone: 'warning' }, { replyTo: 'rn1', body: 'ok' }];
    const out = toolOutcome(await ben.callTool({ name: 'review_note', arguments: { agent: 'ana', notes } }));
    expect(out).toMatchObject({ isError: false, json: { ok: true, added: ['rn1', 'rn2'] } });
    expect(calls.at(-1)).toEqual(['addNotes', { kind: 'agent', name: 'ben' }, 'ana', notes]);
    await ben.callTool({ name: 'review_note', arguments: { notes: [{ replyTo: 'rn1', body: 'mine' }] } });
    expect(calls.at(-1)).toEqual(['addNotes', { kind: 'agent', name: 'ben' }, 'ben', [{ replyTo: 'rn1', body: 'mine' }]]);
    const forged = await ben.callTool({ name: 'review_note', arguments: { agent: 'ana', notes: [{ body: 'x', author: 'user' }] } }).catch(() => ({ isError: true }));
    expect(forged.isError).toBe(true);
    const many = await ben.callTool({ name: 'review_note', arguments: { agent: 'ana', notes: Array.from({ length: 21 }, () => ({ body: 'x' })) } }).catch(() => ({ isError: true }));
    expect(many.isError).toBe(true);
  });

  it('answers that review is not available without it', async () => {
    const { port } = await startWeb();
    const ana = await connectMcp(port, ANA_TOKEN);
    expect(toolOutcome(await ana.callTool({ name: 'review_read', arguments: {} }))).toMatchObject({ isError: true, text: '{"ok":false,"error":"Post-Flight Review is not available"}' });
    expect(toolOutcome(await ana.callTool({ name: 'review_note', arguments: { notes: [{ body: 'x' }] } })).isError).toBe(true);
  });
});
