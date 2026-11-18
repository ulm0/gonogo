// End to end (contract 10.5): a real server through startGonogo, GONOGO_AGENT_CMD pointing at the stand-in claude
// (test/fake-claude.mjs), and a client that does what the browser does: fetch for REST, ws for the terminals and events.
// The stand-in's switches are environment variables of the whole server, so a scenario that needs one starts its own
// server and uses the boss as its subject. Every scenario starts from a fresh server.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { startGonogo } from '../src/server/cli.js';
import { startPtyHost } from '../src/server/ptyhost.js';
import type { PtyHost } from '../src/server/ptyhost.js';
import type { Running } from '../src/server/cli.js';
import {
  ALLOWED_TOOLS,
  BOSS_ROLE,
  CLEAN_ROOM_NOTE,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  NBSP,
  PROMPT_GLYPH,
  SCREEN_DIALOG_REASON,
  STARTUP_DIALOG_REASON,
  nullLogger,
} from '../src/server/constants.js';
import { signCall } from '../src/server/docking.js';
import { pointerText } from '../src/server/hub.js';
import { buildRoleText } from '../src/server/launcher.js';
import { BUILTIN_LIVERIES } from '../src/shared/livery.js';
import { WORKTREE_NOTE } from '../src/server/constants.js';
import { cleanRoomEnv, fakeDockerBin, makeRepo } from './clean-room-helpers.js';
import { AGENT_STATES, PROTOCOL_VERSION, WS_BINARY_OUTPUT, WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from '../src/shared/protocol.js';
import type {
  ActivityItem,
  ActivityStatus,
  AgentFrame,
  AgentState,
  AgentView,
  ApiError,
  AuditView,
  BoardView,
  ClientFrame,
  DockCode,
  DockingView,
  DockView,
  DownlinkFrame,
  DownlinkView,
  GovernorView,
  HireRequest,
  LiveryFrame,
  LiveryView,
  LogChart,
  LogEntry,
  LogSearch,
  Payload,
  PollFrame,
  PollView,
  ReflectResult,
  ReliefFrame,
  ReliefView,
  RosterFile,
  RosterResult,
  ScheduleView,
  SendResult,
  ServerFrame,
  SnapshotFrame,
  StateSnapshot,
  Task,
  UplinkCreated,
  UplinkView,
} from '../src/shared/protocol.js';

const { Terminal } = xtermHeadless;
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------------------------------------------------------- *
 * waiting
 * ---------------------------------------------------------------------------------------------------------------- */

async function waitFor<T>(check: () => T | Promise<T>, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(40);
  }
}

/** The condition must stay false for `ms`: "nothing happens" is only meaningful over a stretch of time. */
async function staysFalse(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) throw new Error(`${what} happened`);
    await sleep(40);
  }
}

/* ---------------------------------------------------------------------------------------------------------------- *
 * the server under test
 * ---------------------------------------------------------------------------------------------------------------- */

interface Harness {
  run: Running;
  tmp: string;
  home: string;
  logDir: string;
  /** A working directory for hired agents. */
  work: string;
  /** Where the stand-in looks for transcripts when FAKE_CLAUDE_SESSION_DIR is on (scenario 12). */
  sessions: string;
  base: string;
  token: string;
}

interface ServerOptions {
  /** Switches of the stand-in (9.8): environment variables of the whole server. */
  env?: Record<string, string>;
  /** Point FAKE_CLAUDE_SESSION_DIR at <tmp>/sessions: the stand-in then disagrees with the launcher about which sessions exist. */
  sessionDir?: boolean;
  maxHops?: number;
  staticDir?: string | null;
  /** What Relay posts with (scenario 28), and what Rollout asks the registry with (scenario 32): a fake, so that nothing leaves the machine. */
  relayFetch?: typeof fetch;
  /** A home that an earlier server used (scenario 36): this one goes on from it. */
  home?: string;
  /** Rollout on (scenario 33). Off by default, as in startGonogo. */
  updateCheck?: boolean;
  /** Live reload (scenario 38): the ptys are in a pty host that the test runs itself. */
  ptyHost?: boolean;
  /** The port of an earlier server (scenario 38): the agents it started keep posting their hooks there. Default any. */
  port?: number;
}

const harnesses: Harness[] = [];
const clients: Client[] = [];

async function startServer(options: ServerOptions = {}): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'gonogo-'));
  const home = options.home ?? join(tmp, 'home');
  const logDir = join(tmp, 'log');
  const configDir = join(tmp, 'claude');
  const work = join(tmp, 'work');
  const sessions = join(tmp, 'sessions');
  await Promise.all([mkdir(logDir), mkdir(configDir), mkdir(work), mkdir(sessions)]);
  let run: Running;
  try {
    run = await startGonogo({
      port: options.port ?? 0,
      host: '127.0.0.1',
      home,
      cwd: tmp,
      seed: false,
      maxHops: options.maxHops ?? 8,
      allowedHosts: [],
      agentCmd: [process.execPath, FAKE],
      staticDir: options.staticDir ?? null,
      fetch: options.relayFetch,
      updateCheck: options.updateCheck,
      ptyHost: options.ptyHost,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        FAKE_CLAUDE_LOG_DIR: logDir,
        ...(options.sessionDir === true ? { FAKE_CLAUDE_SESSION_DIR: sessions } : {}),
        ...options.env,
      },
      log: nullLogger,
    });
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
  const harness: Harness = { run, tmp, home: run.home, logDir, work, sessions, base: `http://127.0.0.1:${run.port}`, token: run.browserToken };
  harnesses.push(harness);
  return harness;
}

/** A process that this test started and that outlived its server must not outlive the test run. */
function killStrays(h: Harness): void {
  for (const start of allStarts(h)) {
    try {
      process.kill(start.pid, 0);
    } catch {
      continue;
    }
    try {
      const command = execFileSync('ps', ['-p', String(start.pid), '-o', 'command='], { encoding: 'utf8' });
      if (command.includes('fake-claude.mjs')) process.kill(start.pid, 'SIGKILL');
    } catch {
      // gone in the meantime
    }
  }
}

/** Stopping may take 8 s (SIGKILL after 5 s); more than 25 s means something is stuck and killStrays takes over. */
async function stopWithin(h: Harness, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([h.run.stop().catch(() => undefined), limit]);
  clearTimeout(timer);
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const h of harnesses.splice(0)) {
    await stopWithin(h, 25_000);
    killStrays(h);
    await rm(h.tmp, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------------------------------------------------- *
 * REST, like the browser's fetch
 * ---------------------------------------------------------------------------------------------------------------- */

interface ApiResult<T> {
  status: number;
  body: T;
  headers: Headers;
}

async function api<T = unknown>(h: Harness, method: string, path: string, body?: unknown, token: string | null = h.token): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(h.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed as T, headers: response.headers };
}

/** For what fetch will not send: a foreign Host header, or an Origin. */
function rawRequest(
  h: Harness,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: h.run.port, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

const getState = async (h: Harness): Promise<StateSnapshot> => (await api<StateSnapshot>(h, 'GET', '/api/state')).body;

async function view(h: Harness, name: string): Promise<AgentView | undefined> {
  return (await getState(h)).agents.find((agent) => agent.name === name);
}

async function waitState(h: Harness, name: string, state: AgentState, timeoutMs = 15_000): Promise<AgentView> {
  let last: AgentView | undefined;
  try {
    return await waitFor(async () => {
      last = await view(h, name);
      return last?.state === state ? last : undefined;
    }, timeoutMs, `${name} to be ${state}`);
  } catch (error) {
    throw new Error(`${(error as Error).message} (last seen: ${last === undefined ? 'no such agent' : `${last.state} ${last.needsReason ?? ''}`})`);
  }
}

async function waitView(h: Harness, name: string, check: (agent: AgentView) => boolean, timeoutMs: number, what: string): Promise<AgentView> {
  return waitFor(async () => {
    const agent = await view(h, name);
    return agent !== undefined && check(agent) ? agent : undefined;
  }, timeoutMs, what);
}

async function hire(h: Harness, name: string, options: Partial<HireRequest> = {}): Promise<AgentView> {
  const response = await api<AgentView>(h, 'POST', '/api/agents', { name, role: `${name} does what it is told`, dir: h.work, mode: 'default', ...options });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return waitState(h, name, 'idle');
}

const send = (h: Harness, to: string, body: string, subject?: string): Promise<ApiResult<SendResult>> =>
  api<SendResult>(h, 'POST', '/api/messages', { to, body, ...(subject === undefined ? {} : { subject }) });

async function waitItem(h: Harness, id: string, check: (item: ActivityItem) => boolean, timeoutMs: number, what: string): Promise<ActivityItem> {
  let last: ActivityItem | undefined;
  try {
    return await waitFor(async () => {
      last = (await getState(h)).activity.find((item) => item.id === id);
      return last !== undefined && check(last) ? last : undefined;
    }, timeoutMs, `${id} ${what}`);
  } catch (error) {
    throw new Error(`${(error as Error).message} (last seen: ${last === undefined ? 'nothing' : `${last.status} ${last.note ?? ''}`})`);
  }
}

const itemRead = (h: Harness, id: string, timeoutMs = 15_000): Promise<ActivityItem> => waitItem(h, id, (item) => item.status === 'read', timeoutMs, 'to be read');

/** Every agent idle and every message at its end (read, undelivered, to the user): nothing more will happen on its own. */
async function waitQuiet(h: Harness, timeoutMs = 25_000): Promise<StateSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let quietSince = 0;
  let last: StateSnapshot | undefined;
  for (;;) {
    last = await getState(h);
    const quiet =
      last.agents.every((agent) => agent.state === 'idle' && agent.queued === 0) &&
      last.activity.every((item) => item.status === 'read' || item.status === 'undelivered' || item.status === 'to_user');
    if (!quiet) quietSince = 0;
    else if (quietSince === 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) return last;
    if (Date.now() > deadline) {
      throw new Error(`the office never went quiet: ${JSON.stringify(last.agents.map((a) => `${a.name}:${a.state}`))} ${JSON.stringify(last.activity.map((i) => `${i.id}:${i.status}`))}`);
    }
    await sleep(80);
  }
}

const readRoster = (h: Harness): RosterFile => JSON.parse(readFileSync(join(h.home, 'agents.json'), 'utf8')) as RosterFile;
const rosterEntry = (h: Harness, name: string) => {
  const entry = readRoster(h).agents.find((agent) => agent.name === name);
  if (entry === undefined) throw new Error(`${name} is not in agents.json`);
  return entry;
};
const readToken = async (h: Harness, name: string): Promise<string> => (await readFile(join(h.home, 'agents', name, 'token'), 'utf8')).trim();

/* ---------------------------------------------------------------------------------------------------------------- *
 * what the stand-in saw (9.9)
 * ---------------------------------------------------------------------------------------------------------------- */

interface FakeEvent {
  e: string;
}
interface StartEvent extends FakeEvent {
  e: 'start';
  argv: string[];
  /** Payload: the plugin folder the stand-in read (--plugin-dir), and the server names of mcp.json. */
  plugin: { name: string; skills: string[] } | null;
  servers: string[];
  tokenLength: number;
  cwd: string;
  pid: number;
  /** Engine Bay: the --model the stand-in was given, and the OPENAI_API_KEY of its environment (a made-up value). */
  model: string | null;
  openaiKey: string | null;
}
interface PromptEvent extends FakeEvent {
  e: 'prompt';
  text: string;
}
interface PasteEvent extends FakeEvent {
  e: 'paste';
  text: string;
}
interface HookEvent extends FakeEvent {
  e: 'hook';
  event: string;
  status: number;
  reply: { decision?: string; reason?: string } | null;
  session: string;
}
interface ToolEvent extends FakeEvent {
  e: 'tool';
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  isError: boolean;
}
interface ResizeEvent extends FakeEvent {
  e: 'resize';
  cols: number;
  rows: number;
}
interface ExitEvent extends FakeEvent {
  e: 'exit';
  code: number;
}

function readLog(h: Harness, name: string): FakeEvent[] {
  const path = join(h.logDir, `${name}.jsonl`);
  if (!existsSync(path)) return [];
  const events: FakeEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      events.push(JSON.parse(line) as FakeEvent);
    } catch {
      // the stand-in was in the middle of a write
    }
  }
  return events;
}

function logOf<T extends FakeEvent>(h: Harness, name: string, kind: T['e']): T[] {
  return readLog(h, name).filter((event): event is T => event.e === kind);
}

const starts = (h: Harness, name: string): StartEvent[] => logOf<StartEvent>(h, name, 'start');
const prompts = (h: Harness, name: string): string[] => logOf<PromptEvent>(h, name, 'prompt').map((event) => event.text);
const pastes = (h: Harness, name: string): string[] => logOf<PasteEvent>(h, name, 'paste').map((event) => event.text);
const hooks = (h: Harness, name: string, event?: string): HookEvent[] =>
  logOf<HookEvent>(h, name, 'hook').filter((hook) => event === undefined || hook.event === event);
const tools = (h: Harness, name: string, tool?: string): ToolEvent[] =>
  logOf<ToolEvent>(h, name, 'tool').filter((call) => tool === undefined || call.name === tool);
const lastResize = (h: Harness, name: string): ResizeEvent | undefined => logOf<ResizeEvent>(h, name, 'resize').at(-1);

function allStarts(h: Harness): StartEvent[] {
  if (!existsSync(h.logDir)) return [];
  return readdirSync(h.logDir)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) => starts(h, file.slice(0, -'.jsonl'.length)));
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The first-start argv of 7.2, written from the contract: the launcher's own builders are not used to judge the launcher. */
function expectedArgv(h: Harness, name: string, role: string, flag: 'session-id' | 'resume', pluginDir?: string, model?: string): string[] {
  const entry = rosterEntry(h, name);
  const dir = join(h.home, 'agents', name);
  return [
    flag === 'resume' ? '--resume' : '--session-id',
    entry.sessionId,
    '--permission-mode',
    entry.mode,
    '--settings',
    join(dir, 'settings.json'),
    '--strict-mcp-config',
    '--mcp-config',
    join(dir, 'mcp.json'),
    ...(pluginDir === undefined ? [] : ['--plugin-dir', pluginDir]),
    ...(model === undefined ? [] : ['--model', model]),
    '--append-system-prompt',
    buildRoleText(name, role, join(dir, 'memory.md')),
    '--system-prompt-snapshot',
    'off',
    '--allowedTools',
    ...ALLOWED_TOOLS,
  ];
}

/* ---------------------------------------------------------------------------------------------------------------- *
 * the browser side of a terminal
 * ---------------------------------------------------------------------------------------------------------------- */

/** An xterm of the snapshot's size, fed the snapshot and then the binary frames of its seq, as the pane does. */
class TerminalView {
  readonly term: HeadlessTerminal;
  private chain: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  }

  write(data: string | Uint8Array): void {
    this.chain = this.chain.then(() => new Promise<void>((resolve) => this.term.write(data, resolve)));
  }

  async rows(): Promise<string[]> {
    await this.chain;
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < this.term.rows; y += 1) rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
    return rows;
  }

  waitRow(check: (row: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    return waitFor(async () => (await this.rows()).find(check), timeoutMs, what);
  }
}

const isPromptRow = (row: string): boolean => row.startsWith(PROMPT_GLYPH + NBSP);

interface BinaryFrame {
  kind: number;
  seq: number;
  payload: Buffer;
}

class Client {
  readonly frames: ServerFrame[] = [];
  readonly binary: BinaryFrame[] = [];
  private readonly views = new Map<number, TerminalView>();
  private seq = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('error', () => undefined);
  }

  /** `new WebSocket(url, ['gonogo.v1', 'token.<token>'])`: the token travels in Sec-WebSocket-Protocol, never in the URL. */
  static async open(h: Harness, token: string = h.token): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${h.run.port}/ws`, [WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${token}`]);
    const client = new Client(ws);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await client.waitFrame((frame) => frame.t === 'state', 8000, 'the first state frame');
    return client;
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (isBinary) {
      const frame: BinaryFrame = { kind: buffer[0] ?? -1, seq: buffer.length >= 5 ? buffer.readUInt32BE(1) : -1, payload: buffer.subarray(5) };
      this.binary.push(frame);
      if (frame.kind === WS_BINARY_OUTPUT) this.views.get(frame.seq)?.write(frame.payload);
      return;
    }
    const frame = JSON.parse(buffer.toString('utf8')) as ServerFrame;
    this.frames.push(frame);
    if (frame.t === 'snapshot') {
      const terminal = new TerminalView(frame.cols, frame.rows);
      terminal.write(frame.data);
      this.views.set(frame.seq, terminal);
    }
  }

  send(frame: ClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Where the next frames will land: frames before this index are history. */
  mark(): number {
    return this.frames.length;
  }

  waitFrame(check: (frame: ServerFrame) => boolean, timeoutMs: number, what: string, from = 0): Promise<ServerFrame> {
    return waitFor(() => this.frames.slice(from).find(check), timeoutMs, what);
  }

  async attach(agent: string, size?: { cols: number; rows: number }): Promise<{ snapshot: SnapshotFrame; terminal: TerminalView }> {
    this.seq += 1;
    const seq = this.seq;
    const from = this.mark();
    this.send({ t: 'attach', seq, agent, ...size });
    const frame = await this.waitFrame((f) => (f.t === 'snapshot' && f.seq === seq) || (f.t === 'error' && f.ref === 'attach'), 10_000, `the snapshot of ${agent}`, from);
    if (frame.t !== 'snapshot') throw new Error(`attach of ${agent} was refused: ${frame.t === 'error' ? frame.message : frame.t}`);
    const terminal = this.views.get(seq);
    if (terminal === undefined) throw new Error('no terminal view for the snapshot');
    return { snapshot: frame, terminal };
  }

  detach(): void {
    this.send({ t: 'detach' });
  }

  input(agent: string, data: string): void {
    this.send({ t: 'input', agent, data });
  }

  /** What a person does: type the text, then press Enter. Several lines go in as one bracketed paste. */
  typeLine(agent: string, text: string): void {
    this.input(agent, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
    this.input(agent, '\r');
  }

  resize(agent: string, cols: number, rows: number): void {
    this.send({ t: 'resize', agent, cols, rows });
  }

  agentFrames(name: string, from = 0): AgentFrame[] {
    return this.frames.slice(from).filter((frame): frame is AgentFrame => frame.t === 'agent' && frame.agent.name === name);
  }

  /** The states an agent went through since `from`, one entry per change. */
  states(name: string, from = 0): AgentState[] {
    const states: AgentState[] = [];
    for (const frame of this.agentFrames(name, from)) if (states.at(-1) !== frame.agent.state) states.push(frame.agent.state);
    return states;
  }

  /** The states since the agent first reached `first`: the frames before it only carry other changes (a queue count, a latch). */
  statesFrom(name: string, first: AgentState, from = 0): AgentState[] {
    const states = this.states(name, from);
    const start = states.indexOf(first);
    return start === -1 ? [] : states.slice(start);
  }

  /**
   * Waits until the states since `first` begin with `expected`. A frame can carry a state that did not change (a draft that
   * Enter cleared arrives as "idle" before the turn starts), so "idle again" must be looked for after "working", in order.
   */
  async waitStates(name: string, first: AgentState, expected: AgentState[], timeoutMs: number, from = 0): Promise<void> {
    await waitFor(() => {
      const got = this.statesFrom(name, first, from);
      return got.length >= expected.length && expected.every((state, index) => got[index] === state);
    }, timeoutMs, `${name} to go ${expected.join(' then ')}`);
  }

  items(id: string, from = 0): ActivityItem[] {
    const items: ActivityItem[] = [];
    for (const frame of this.frames.slice(from)) if (frame.t === 'activity' && frame.item.id === id) items.push(frame.item);
    return items;
  }

  /** The statuses a message went through, one entry per change. */
  statuses(id: string, from = 0): ActivityStatus[] {
    const statuses: ActivityStatus[] = [];
    for (const item of this.items(id, from)) if (statuses.at(-1) !== item.status) statuses.push(item.status);
    return statuses;
  }

  waitItem(id: string, check: (item: ActivityItem) => boolean, timeoutMs: number, what: string, from = 0): Promise<ActivityItem> {
    return waitFor(() => this.items(id, from).find(check), timeoutMs, `${id} ${what}`);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

function refusedHandshake(h: Harness, protocols: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.run.port}/ws`, protocols);
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.on('open', () => {
      ws.terminate();
      reject(new Error('the handshake was accepted'));
    });
    ws.on('error', () => undefined);
  });
}

/* ---------------------------------------------------------------------------------------------------------------- *
 * the scenarios of 10.5
 * ---------------------------------------------------------------------------------------------------------------- */

describe('end to end with the stand-in agent', () => {
  it('1. boot and auth', async () => {
    const h = await startServer();
    const first = await view(h, 'flight');
    expect(first, 'the boss exists as soon as the server listens').toBeDefined();
    expect(['starting', 'idle']).toContain(first?.state);
    const flight = await waitState(h, 'flight', 'idle');
    expect(flight).toMatchObject({ name: 'flight', boss: true, desk: 0, mode: 'default', role: BOSS_ROLE, generation: 1, draft: false, held: null, queued: 0, dirty: false, exit: null });
    expect(realpathSync(flight.dir)).toBe(realpathSync(h.tmp));

    // no token, a wrong token, a foreign Host, a foreign Origin
    const noToken = await api<ApiError>(h, 'GET', '/api/state', undefined, null);
    expect(noToken.status).toBe(401);
    expect(noToken.body).toEqual({ error: 'unauthorized', code: 'unauthorized' });
    expect(noToken.headers.get('www-authenticate')).toBe('Bearer');
    expect((await api(h, 'GET', '/api/state', undefined, 'f'.repeat(64))).status).toBe(401);
    const foreignHost = await rawRequest(h, '/api/state', { host: 'evil.example', authorization: `Bearer ${h.token}` });
    expect(foreignHost.status).toBe(403);
    expect(foreignHost.body).toBe('forbidden host');
    const foreignOrigin = await rawRequest(h, '/api/state', { host: `127.0.0.1:${h.run.port}`, origin: 'http://evil.example', authorization: `Bearer ${h.token}` });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.body).toBe('forbidden origin');
    const sameOrigin = await rawRequest(h, '/api/state', { host: `127.0.0.1:${h.run.port}`, origin: `http://127.0.0.1:${h.run.port}`, authorization: `Bearer ${h.token}` });
    expect(sameOrigin.status).toBe(200);
    expect(await refusedHandshake(h, [WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${'f'.repeat(64)}`])).toBe(401);

    // with the token
    const state = await api<StateSnapshot>(h, 'GET', '/api/state');
    expect(state.status).toBe(200);
    expect(state.body.agents.map((agent) => agent.name)).toEqual(['flight']);
    expect(state.body.info).toMatchObject({ protocol: PROTOCOL_VERSION, home: h.home, port: h.run.port, seed: false, maxHops: 8 });
    // GONOGO_AGENT_CMD stands in for claude; custom is always there (Engine Bay)
    expect(state.body.info.installed).toEqual(expect.arrayContaining(['claude', 'custom']));

    // the agent token lives in a 0600 file while the boss runs and is refused where only the browser token counts
    const agentToken = await readToken(h, 'flight');
    expect(agentToken).toMatch(/^[0-9a-f]{64}$/);
    expect(agentToken).not.toBe(h.token);
    expect((await api(h, 'GET', '/api/state', undefined, agentToken)).status).toBe(401);
    expect((await api(h, 'POST', '/api/messages', { to: 'flight', body: 'x' }, agentToken)).status).toBe(401);
    expect(await refusedHandshake(h, [WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${agentToken}`])).toBe(401);
    // and the browser token is not an agent token
    const asBrowser = await api(h, 'POST', '/hook/flight/Stop', {}, h.token);
    expect(asBrowser.status).toBe(401);

    // the stand-in saw the token's length, never the token
    const [start] = starts(h, 'flight');
    expect(start?.tokenLength).toBe(64);
    const everything = JSON.stringify(readLog(h, 'flight'));
    expect(everything).not.toContain(agentToken);
    expect(everything).not.toContain(h.token);
  });

  it('2. terminal: snapshot, binary frames, input, resize, size ownership', async () => {
    const h = await startServer();
    await waitState(h, 'flight', 'idle');
    const a = await Client.open(h);
    expect(a.ws.protocol, 'the server selects the subprotocol and never echoes the token').toBe(WS_SUBPROTOCOL);
    expect(a.frames[0]?.t).toBe('state');

    // the snapshot holds the prompt box and says the process runs
    const { snapshot, terminal } = await a.attach('flight');
    expect(snapshot).toMatchObject({ agent: 'flight', generation: 1, running: true, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    expect((await terminal.rows()).some(isPromptRow), 'a row starting with ❯ and a no-break space').toBe(true);

    // binary frames follow: byte 0 = 1, bytes 1..4 = the seq
    const mark = a.mark();
    a.input('flight', 'hello');
    await a.waitFrame((f) => f.t === 'agent' && f.agent.name === 'flight' && f.agent.draft, 5000, 'the draft latch', mark);
    await waitFor(() => a.binary.some((frame) => frame.seq === snapshot.seq), 5000, 'binary output after the keystrokes');
    expect(a.binary.every((frame) => frame.kind === WS_BINARY_OUTPUT && frame.seq === snapshot.seq)).toBe(true);
    await terminal.waitRow((row) => isPromptRow(row) && row.includes('hello'), 5000, 'the typed text on the prompt row');

    // Enter: a prompt in the stand-in's log, working, then idle again
    a.input('flight', '\r');
    await waitFor(() => prompts(h, 'flight').includes('hello'), 5000, 'the prompt reaching the stand-in');
    await a.waitStates('flight', 'working', ['working', 'idle'], 10_000, mark);
    expect(await waitState(h, 'flight', 'idle')).toMatchObject({ draft: false });

    // resize changes the stand-in's size and the next snapshot
    a.resize('flight', 100, 30);
    await a.waitFrame((f) => f.t === 'size' && f.agent === 'flight' && f.cols === 100 && f.rows === 30, 5000, 'the size frame');
    await waitFor(() => lastResize(h, 'flight')?.cols === 100 && lastResize(h, 'flight')?.rows === 30, 5000, 'the stand-in noticing the new size');
    const again = await a.attach('flight');
    expect(again.snapshot).toMatchObject({ cols: 100, rows: 30, running: true });
    expect(again.snapshot.seq).not.toBe(snapshot.seq);

    // a second window with another size takes the pty: the first one is told
    const b = await Client.open(h);
    const second = await b.attach('flight', { cols: 80, rows: 24 });
    expect(second.snapshot).toMatchObject({ cols: 80, rows: 24 });
    await a.waitFrame((f) => f.t === 'size' && f.agent === 'flight' && f.cols === 80 && f.rows === 24, 5000, 'the first window hearing about 80x24');
    await waitFor(() => lastResize(h, 'flight')?.cols === 80 && lastResize(h, 'flight')?.rows === 24, 5000, 'the stand-in drawing at 80x24');

    // focus and mouse reports are not keystrokes: they never take the size back
    const markA = a.mark();
    const markB = b.mark();
    const otherSize = (c: Client, from: number): boolean => c.frames.slice(from).some((f) => f.t === 'size' && (f.cols !== 80 || f.rows !== 24));
    a.input('flight', '\x1b[I');
    a.input('flight', '\x1b[<35;10;5M');
    await staysFalse(() => otherSize(a, markA) || otherSize(b, markB) || lastResize(h, 'flight')?.cols !== 80, 1200, 'a size change after focus and mouse input');

    // a real keystroke does: the first window's size (100x30) comes back and the second window hears about it
    const beforeX = b.mark();
    a.input('flight', 'x');
    await b.waitFrame((f) => f.t === 'size' && f.agent === 'flight' && f.cols === 100 && f.rows === 30, 5000, 'the second window hearing about 100x30', beforeX);
    await waitFor(() => lastResize(h, 'flight')?.cols === 100, 5000, 'the stand-in drawing at 100x30');

    // and so does a keystroke of the second window, with the size it attached with; the first window is told
    const beforeY = a.mark();
    b.input('flight', 'y');
    await a.waitFrame((f) => f.t === 'size' && f.agent === 'flight' && f.cols === 80 && f.rows === 24, 5000, 'the first window hearing about 80x24 again', beforeY);
    await waitFor(() => lastResize(h, 'flight')?.cols === 80, 5000, 'the stand-in drawing at 80x24 again');
    const afterY = a.mark();
    a.input('flight', '\x1b[O');
    a.input('flight', '\x1b[<35;11;6M');
    await staysFalse(() => otherSize(a, afterY) || lastResize(h, 'flight')?.cols !== 80, 1000, 'the first window taking the size back with focus and mouse reports');
    await waitView(h, 'flight', (agent) => agent.draft, 5000, 'the draft latch of the typed letters');
    a.input('flight', '\x03');
    await waitState(h, 'flight', 'idle');
    await waitView(h, 'flight', (agent) => !agent.draft, 5000, 'the latch cleared');
  });

  it('3. hire: validation, then the first-start argv of 7.2', async () => {
    const h = await startServer();
    await waitState(h, 'flight', 'idle');
    const valid = { name: 'ana', role: 'Reviews the plan. Budget is $$5 and costs $& more.', dir: h.work, mode: 'acceptEdits' };
    const refuse = async (changes: Record<string, unknown>, status: number, code: string, field?: string): Promise<void> => {
      const response = await api<ApiError>(h, 'POST', '/api/agents', { ...valid, ...changes });
      expect(response.status, JSON.stringify(changes)).toBe(status);
      expect(response.body.code).toBe(code);
      if (field !== undefined) expect(response.body.field).toBe(field);
    };
    await refuse({ name: 'Ana Smith' }, 400, 'bad_request', 'name');
    await refuse({ name: '-ana' }, 400, 'bad_request', 'name');
    await refuse({ name: 'user' }, 400, 'bad_request', 'name');
    await refuse({ name: 'boss' }, 400, 'bad_request', 'name');
    await refuse({ role: '   ' }, 400, 'bad_request', 'role');
    await refuse({ dir: 'relative/dir' }, 400, 'bad_request', 'dir');
    await refuse({ dir: join(h.tmp, 'does-not-exist') }, 400, 'bad_request', 'dir');
    await refuse({ dir: join(h.tmp, 'home', 'agents.json') }, 400, 'bad_request', 'dir');
    await refuse({ mode: 'plan' }, 400, 'bad_request', 'mode');
    await refuse({ mode: 'bypassPermissions' }, 400, 'bad_request', 'confirmBypass');
    await refuse({ name: 'flight' }, 409, 'conflict', 'name');
    expect((await getState(h)).agents.map((agent) => agent.name), 'a refused hire leaves nothing behind').toEqual(['flight']);

    const hired = await api<AgentView>(h, 'POST', '/api/agents', valid);
    expect(hired.status).toBe(201);
    expect(hired.body).toMatchObject({ name: 'ana', state: 'starting', desk: 1, boss: false, mode: 'acceptEdits', generation: 1, dirty: false });
    await waitState(h, 'ana', 'idle');

    // the roster on disk, and the argv the stand-in was started with (it refuses any other)
    const entry = rosterEntry(h, 'ana');
    expect(entry).toMatchObject({ name: 'ana', desk: 1, boss: false, mode: 'acceptEdits', dir: h.work });
    expect(entry.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const [start] = starts(h, 'ana');
    const argv = start?.argv ?? [];
    expect(argv).toEqual(expectedArgv(h, 'ana', valid.role, 'session-id'));
    expect(argv[argv.indexOf('--append-system-prompt') + 1], 'the role, verbatim').toContain(valid.role);
    expect(argv.slice(0, 2)).toEqual(['--session-id', entry.sessionId]);
    expect(argv.slice(2, 4)).toEqual(['--permission-mode', 'acceptEdits']);
    expect(realpathSync(start?.cwd ?? '')).toBe(realpathSync(h.work));

    // every hook and MCP url the launcher wrote points at the loopback port of this server
    const settings = JSON.parse(await readFile(join(h.home, 'agents', 'ana', 'settings.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ url: string }> }>> };
    for (const [event, groups] of Object.entries(settings.hooks)) {
      expect(groups[0]?.hooks[0]?.url).toBe(`http://127.0.0.1:${h.run.port}/hook/ana/${event}`);
    }
    const mcp = JSON.parse(await readFile(join(h.home, 'agents', 'ana', 'mcp.json'), 'utf8')) as { mcpServers: { gonogo: { url: string } } };
    expect(mcp.mcpServers.gonogo.url).toBe(`http://127.0.0.1:${h.run.port}/mcp`);

    // auto needs no confirmBypass and reaches the stand-in (which refuses a mode it does not know) as --permission-mode auto
    expect((await hire(h, 'bea', { mode: 'auto' })).mode).toBe('auto');
    expect(starts(h, 'bea')[0]?.argv.slice(2, 4)).toEqual(['--permission-mode', 'auto']);
  });

  it('4. pointer delivery: queued, delivered, read; the body comes through the tool', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    const c = await Client.open(h);
    const mark = c.mark();
    const body = 'please review the plan\nand tell me what you think';
    const sent = await send(h, 'ana', body, 'plan');
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ ok: true, to: 'ana', status: 'queued', note: 'waiting: about to type the pointer' });
    const id = sent.body.id;
    await c.waitItem(id, (item) => item.status === 'read', 15_000, 'to be read', mark);

    // queued -> delivered (pointer typed) -> read
    expect(c.statuses(id, mark)).toEqual(['queued', 'delivered', 'read']);
    const delivered = c.items(id, mark).find((item) => item.status === 'delivered');
    expect(delivered?.note).toBe('pointer typed');
    expect(c.items(id, mark).at(-1)).toMatchObject({ status: 'read', note: null, from: 'user', to: 'ana', hops: 0, subject: 'plan', body });

    // exactly one prompt, and it is the pointer: the body never goes through the terminal
    // (the stand-in writes its log a moment after the state changes, so wait for it)
    await waitFor(() => prompts(h, 'ana').length >= 1 && pastes(h, 'ana').length >= 1 && tools(h, 'ana', 'read_messages').length >= 1, 5000, 'the stand-in log of the pointer and the read');
    const pointer = 'gonogo: 1 new message from user. Call read_messages.';
    expect(pointerText([{ from: 'user' }])).toBe(pointer);
    expect(prompts(h, 'ana')).toEqual([pointer]);
    expect(pastes(h, 'ana')).toEqual([pointer]);

    // the tool returned the body, the hooks wrapped it, and the state followed: working, then idle
    const read = tools(h, 'ana', 'read_messages');
    expect(read).toHaveLength(1);
    expect(read[0]?.result).toMatchObject({ count: 1, messages: [{ id, from: 'user', subject: 'plan', body, inReplyTo: null }] });
    await c.waitStates('ana', 'working', ['working', 'idle'], 10_000, mark);
    expect(c.statesFrom('ana', 'working', mark)).toEqual(['working', 'idle']);
    await waitFor(() => hooks(h, 'ana', 'Stop').length === 1, 5000, 'the Stop hook in the stand-in log');
    expect(hooks(h, 'ana').map((hook) => hook.event)).toEqual(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(hooks(h, 'ana').every((hook) => hook.status === 200), 'no hook was refused').toBe(true);
    expect(hooks(h, 'ana', 'Stop')[0]?.reply).toEqual({});
  });

  it('5. agent to agent, hops and the cap, a message to the user', async () => {
    const h = await startServer({ maxHops: 3 });
    await hire(h, 'ana');
    await hire(h, 'ben');
    const itemsOf = async (): Promise<ActivityItem[]> => (await getState(h)).activity;
    const find = (items: ActivityItem[], from: string, to: string, subject: string): ActivityItem | undefined =>
      items.find((item) => item.from === from && item.to === to && item.subject === subject);

    // a chain: ana tells ben, ben answers
    await send(h, 'ana', '@fake send ben | hi | @fake send ana | back | x', 'start');
    let items = (await waitQuiet(h)).activity;
    expect(find(items, 'ana', 'ben', 'hi')).toMatchObject({ hops: 1, status: 'read', body: '@fake send ana | back | x' });
    expect(find(items, 'ben', 'ana', 'back')).toMatchObject({ hops: 2, status: 'read', body: 'x' });
    expect(find(items, 'user', 'ana', 'start')).toMatchObject({ hops: 0, status: 'read' });

    // a ping-pong that would never stop: the message beyond the cap goes to the user
    await send(h, 'ana', '@fake send ben | p1 | @fake send ana | p2 | @fake send ben | p3 | @fake send ana | p4 | @fake send ben | p5 | end', 'pingpong');
    items = (await waitQuiet(h)).activity;
    expect(find(items, 'ana', 'ben', 'p1')).toMatchObject({ hops: 1, status: 'read' });
    expect(find(items, 'ben', 'ana', 'p2')).toMatchObject({ hops: 2, status: 'read' });
    expect(find(items, 'ana', 'ben', 'p3')).toMatchObject({ hops: 3, status: 'read' });
    const beyond = find(items, 'ben', 'ana', 'p4');
    expect(beyond).toMatchObject({ hops: 4, status: 'undelivered', note: 'hop limit 3 reached; the message went to the user' });
    expect(find(items, 'ana', 'ben', 'p5'), 'the chain ended with the refused message').toBeUndefined();
    const refused = tools(h, 'ben', 'send_message').find((call) => call.args.subject === 'p4');
    expect(refused).toMatchObject({
      isError: true,
      result: { ok: false, id: beyond?.id, to: 'ana', status: 'undelivered', note: 'hop limit 3 reached; the message went to the user' },
    });

    // a message to the user is never refused
    await send(h, 'ana', '@fake send user | done | all good', 'report');
    await waitQuiet(h);
    const toUser = find(await itemsOf(), 'ana', 'user', 'done');
    expect(toUser).toMatchObject({ to: 'user', status: 'to_user', note: null, body: 'all good', hops: 1 });
    expect(tools(h, 'ana', 'send_message').find((call) => call.args.subject === 'done')).toMatchObject({
      isError: false,
      result: { ok: true, to: 'user', status: 'to_user', note: null },
    });
  });

  it('6. a working recipient gets its mail with the Stop block, not typed', async () => {
    const h = await startServer();
    await hire(h, 'ben');
    const c = await Client.open(h);
    const mark = c.mark();
    const first = await send(h, 'ben', '@fake sleep 1500', 'work');
    expect(first.body.status).toBe('queued');
    await c.waitFrame((f) => f.t === 'agent' && f.agent.name === 'ben' && f.agent.state === 'working', 10_000, 'ben working', mark);
    await sleep(200);
    const second = await send(h, 'ben', 'one more thing', 'later');
    expect(second.body).toMatchObject({ ok: true, status: 'queued', note: 'waiting: ben is working' });
    await c.waitItem(second.body.id, (item) => item.status === 'read', 20_000, 'to be read', mark);
    await itemRead(h, first.body.id);

    expect(c.statuses(second.body.id, mark)).toEqual(['queued', 'delivered', 'read']);
    expect(c.items(second.body.id, mark).find((item) => item.status === 'delivered')?.note).toBe('handed over when its turn ended');
    // one typed prompt, two Stops: the first answered with the block, the second with {}
    const pointer = pointerText([{ from: 'user' }]);
    expect(prompts(h, 'ben')).toEqual([pointer]);
    expect(pastes(h, 'ben')).toEqual([pointer]);
    await waitState(h, 'ben', 'idle');
    await waitFor(() => hooks(h, 'ben', 'Stop').length === 2, 5000, 'the second Stop in the stand-in log');
    expect(hooks(h, 'ben', 'Stop').map((stop) => stop.reply)).toEqual([{ decision: 'block', reason: pointer }, {}]);
    expect(tools(h, 'ben', 'read_messages')).toHaveLength(2);
  });

  it('7. draft latch: held until Enter or Ctrl-C, or until the screen shows an empty box', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    const c = await Client.open(h);
    await c.attach('ana');
    const pointer = pointerText([{ from: 'user' }]);

    // text in the box holds the mail; Ctrl-C clears it and releases the mail
    c.input('ana', 'abc');
    await waitView(h, 'ana', (agent) => agent.draft, 5000, 'the draft latch');
    const held = await send(h, 'ana', 'first held message');
    expect(held.body).toMatchObject({ ok: true, status: 'held', note: "held: text in ana's input" });
    expect(await view(h, 'ana')).toMatchObject({ draft: true, queued: 1, held: { kind: 'draft', text: "held: text in ana's input" } });
    await sleep(1500);
    expect((await getState(h)).activity.find((item) => item.id === held.body.id)).toMatchObject({ status: 'held' });
    expect(prompts(h, 'ana'), 'nothing was typed into the half-written prompt').toEqual([]);
    c.input('ana', '\x03');
    await itemRead(h, held.body.id);
    expect(prompts(h, 'ana'), 'the pointer alone, not after "abc"').toEqual([pointer]);
    expect(await waitView(h, 'ana', (agent) => !agent.draft && agent.held === null, 5000, 'the latch gone')).toMatchObject({ queued: 0 });
    await waitState(h, 'ana', 'idle');

    // Escape alone does not release it; the empty box does, after about a second
    c.input('ana', 'abc');
    await waitView(h, 'ana', (agent) => agent.draft, 5000, 'the draft latch again');
    const second = await send(h, 'ana', 'second held message');
    expect(second.body.status).toBe('held');
    const escapedAt = Date.now();
    c.input('ana', '\x1b'); // the stand-in clears its box on Escape: it stands for Esc Esc
    await sleep(300);
    expect(await view(h, 'ana'), 'the latch stays up for about a second').toMatchObject({ draft: true });
    await waitItem(h, second.body.id, (item) => item.status === 'read', 5500, 'to be read once the screen proof released it');
    expect(Date.now() - escapedAt).toBeGreaterThanOrEqual(900);
    expect(prompts(h, 'ana')).toEqual([pointer, pointer]);

    // Backspace to an empty box ends it the same way
    await waitState(h, 'ana', 'idle');
    c.input('ana', 'abc');
    await waitView(h, 'ana', (agent) => agent.draft, 5000, 'the draft latch a third time');
    const third = await send(h, 'ana', 'third held message');
    expect(third.body.status).toBe('held');
    c.input('ana', '\x7f\x7f\x7f');
    await waitItem(h, third.body.id, (item) => item.status === 'read', 6000, 'to be read after the backspaces');
    expect(prompts(h, 'ana')).toEqual([pointer, pointer, pointer]);
  });

  describe('8. a pointer nobody confirms', () => {
    it('is held after 2 s, not retried, and typed again after the user presses Enter', async () => {
      const h = await startServer({ env: { FAKE_CLAUDE_IGNORE_CR: '1' } });
      await waitState(h, 'flight', 'idle');
      const c = await Client.open(h);
      const pointer = pointerText([{ from: 'user' }]);
      const sent = await send(h, 'boss', 'brief for the boss');
      expect(sent.body).toMatchObject({ to: 'flight', status: 'queued' });
      await waitFor(() => pastes(h, 'flight').length === 1, 8000, 'the pointer typed');
      expect(pastes(h, 'flight')).toEqual([pointer]);
      const held = await waitItem(h, sent.body.id, (item) => item.status === 'held', 8000, 'to be held');
      expect(held.note).toBe('held: pointer not confirmed within 2 s');
      expect(await view(h, 'flight')).toMatchObject({ queued: 1, held: { kind: 'unconfirmed', text: 'held: pointer not confirmed within 2 s' } });
      await staysFalse(() => pastes(h, 'flight').length > 1, 3000, 'a second pointer');

      // the user's Enter in that terminal releases it, and a fresh pointer is typed
      await c.attach('flight');
      c.input('flight', '\r');
      await waitFor(() => pastes(h, 'flight').length === 2, 8000, 'a fresh pointer after Enter');
      expect(prompts(h, 'flight'), 'the stand-in never submitted anything').toEqual([]);
    });

    it('is not held when the hooks are lost: read_messages ends the wait, and the next message works', async () => {
      const h = await startServer({ env: { FAKE_CLAUDE_NO_HOOKS: '1' } });
      await waitState(h, 'flight', 'idle');
      const c = await Client.open(h);
      const mark = c.mark();
      const first = await send(h, 'boss', 'first brief');
      await c.waitItem(first.body.id, (item) => item.status === 'read', 8000, 'to be read', mark);
      expect(c.statuses(first.body.id, mark).includes('held')).toBe(false);
      await waitState(h, 'flight', 'idle');
      const second = await send(h, 'boss', 'second brief');
      await c.waitItem(second.body.id, (item) => item.status === 'read', 8000, 'to be read', mark);
      expect(c.statuses(second.body.id, mark).includes('held')).toBe(false);
      const pointer = pointerText([{ from: 'user' }]);
      await waitFor(() => pastes(h, 'flight').length >= 2 && tools(h, 'flight', 'read_messages').length >= 2, 5000, 'the stand-in log of both pointers and reads');
      expect(pastes(h, 'flight')).toEqual([pointer, pointer]);
      expect(hooks(h, 'flight'), 'the stand-in posted no hook at all').toEqual([]);
      expect(tools(h, 'flight', 'read_messages').map((call) => (call.result as { count: number }).count)).toEqual([1, 1]);
      expect(await view(h, 'flight')).toMatchObject({ held: null, queued: 0 });
    });
  });

  it('9. a stopped recipient: undelivered; restart resumes the session; the old token dies', async () => {
    const h = await startServer();
    await hire(h, 'ben', { role: 'Answers questions' });
    const warmUp = await send(h, 'ben', 'wake up');
    await itemRead(h, warmUp.body.id);
    await waitState(h, 'ben', 'idle'); // the stand-in writes its transcript at the first prompt
    const oldToken = await readToken(h, 'ben');
    const sessionId = rosterEntry(h, 'ben').sessionId;

    const stopped = await api<AgentView>(h, 'POST', '/api/agents/ben/stop');
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ state: 'stopped', exit: { code: 143, signal: null, requested: true, text: 'stopped' } });
    await expect(readToken(h, 'ben'), 'a stop unlinks the token file').rejects.toThrow();

    const lost = await send(h, 'ben', 'are you there?');
    expect(lost.status).toBe(201);
    expect(lost.body).toMatchObject({ ok: false, to: 'ben', status: 'undelivered', note: 'ben is stopped; the message went to the user' });

    // attach to the finished record, then restart: the pane must find the new process by a fresh attach
    const c = await Client.open(h);
    const old = await c.attach('ben');
    expect(old.snapshot).toMatchObject({ running: false, generation: 1 });
    const mark = c.mark();
    const restarted = await api<AgentView>(h, 'POST', '/api/agents/ben/restart');
    expect(restarted.status).toBe(200);
    expect(restarted.body.generation).toBe(2);
    await c.waitFrame((f) => f.t === 'agent' && f.agent.name === 'ben' && f.agent.generation === 2 && f.agent.state === 'starting', 8000, 'the starting frame of generation 2', mark);
    const fresh = await c.attach('ben');
    expect(fresh.snapshot).toMatchObject({ running: true, generation: 2 });
    await waitState(h, 'ben', 'idle');

    // --resume with the same session id, because the stand-in wrote the transcript
    const ben = starts(h, 'ben');
    expect(ben).toHaveLength(2);
    expect(ben[1]?.argv).toEqual(expectedArgv(h, 'ben', 'Answers questions', 'resume'));
    expect(ben[1]?.argv.slice(0, 2)).toEqual(['--resume', sessionId]);
    expect((await view(h, 'ben'))?.generation).toBe(2);

    // the new process produces output for the fresh attach and for it only
    const welcome = await send(h, 'ben', 'welcome back');
    await itemRead(h, welcome.body.id);
    expect(c.binary.some((frame) => frame.seq === fresh.snapshot.seq), 'binary frames follow the fresh attach').toBe(true);
    expect(c.binary.filter((frame) => frame.seq === old.snapshot.seq), 'the finished record is told nothing').toEqual([]);

    // the token of the first process is refused on the hook route; the new token is another one
    const late = await api(h, 'POST', '/hook/ben/Stop', {}, oldToken);
    expect(late.status).toBe(401);
    expect(await readToken(h, 'ben')).not.toBe(oldToken);
  }, 60_000);

  describe('10. dialogs, permissions and the screen as a witness', () => {
    it('a startup dialog is "needs you" after 5 s and ends when it is answered', async () => {
      const h = await startServer({ env: { FAKE_CLAUDE_DIALOG: 'trust' } });
      const flight = await waitState(h, 'flight', 'needs_you', 20_000);
      expect(flight).toMatchObject({ needsKind: 'startup_dialog', needsReason: STARTUP_DIALOG_REASON });
      expect(STARTUP_DIALOG_REASON).toBe('startup dialog: answer it in the terminal');
      const c = await Client.open(h);
      const { terminal } = await c.attach('flight');
      await terminal.waitRow((row) => row.includes('Quick safety check: Is this a project you created or one you trust?'), 5000, 'the dialog on the snapshot');
      c.input('flight', '1');
      const idle = await waitState(h, 'flight', 'idle', 10_000);
      expect(idle).toMatchObject({ needsKind: null, needsReason: null });
      expect(logOf(h, 'flight', 'dialog').map((event) => (event as FakeEvent & { action: string }).action)).toEqual(['shown', 'accepted']);
    }, 60_000);

    it('a permission prompt is "needs you"; allowing it leads to working through the screen and the title, with no hook', async () => {
      const h = await startServer();
      await waitState(h, 'flight', 'idle');
      const c = await Client.open(h);
      await c.attach('flight');
      c.typeLine('flight', '@fake permission Bash 4000');
      const needs = await waitState(h, 'flight', 'needs_you', 10_000);
      expect(needs).toMatchObject({ needsKind: 'permission', needsReason: 'permission request: Bash' });

      const answered = c.mark();
      const answeredAt = Date.now();
      c.input('flight', '1');
      const next = await c.waitFrame((f) => f.t === 'agent' && f.agent.name === 'flight' && f.agent.state !== 'needs_you', 6000, 'the way out of needs you', answered);
      expect((next as AgentFrame).agent.state, 'working, not idle and not needs you').toBe('working');
      expect(Date.now() - answeredAt).toBeLessThan(4500);
      expect(hooks(h, 'flight', 'PostToolUse'), 'the approved tool is still running: no hook yet').toEqual([]);
      expect(await view(h, 'flight')).toMatchObject({ state: 'working', needsKind: null, needsReason: null });
      await c.waitStates('flight', 'working', ['working', 'idle'], 15_000, answered);
      expect(c.statesFrom('flight', 'working', answered)).toEqual(['working', 'idle']);
      expect(hooks(h, 'flight').map((hook) => hook.event)).toEqual(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']);
    }, 60_000);

    it('a denied prompt fires no hook; the screen brings the agent back to idle', async () => {
      const h = await startServer();
      await waitState(h, 'flight', 'idle');
      const c = await Client.open(h);
      await c.attach('flight');
      c.typeLine('flight', '@fake permission Bash');
      await waitState(h, 'flight', 'needs_you', 10_000);
      const deniedAt = Date.now();
      c.input('flight', '2');
      await waitState(h, 'flight', 'idle', 6000);
      expect(Date.now() - deniedAt, 'about NEEDS_YOU_CLEAR_MS plus a sweep').toBeLessThan(5000);
      expect(hooks(h, 'flight').map((hook) => hook.event), 'nothing after the PermissionRequest: the denial fired no hook').toEqual(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest']);
    }, 60_000);

    it('POST /api/agents/:name/answer with go presses Enter: the tool runs and the agent leaves needs you', async () => {
      const h = await startServer();
      await waitState(h, 'flight', 'idle');
      const c = await Client.open(h);
      await c.attach('flight');
      c.typeLine('flight', '@fake permission Bash 2000');
      const needs = await waitState(h, 'flight', 'needs_you', 10_000);
      expect(needs).toMatchObject({ needsKind: 'permission', doing: 'Bash' });
      expect(needs.history.map((change) => change.state).slice(-3)).toEqual(['idle', 'working', 'needs_you']);
      expect(needs.history.at(-1)).toEqual({ state: 'needs_you', at: needs.stateSince });

      // the dialog has a number, the inbox has an event for it, and an answer for another dialog types nothing
      expect(needs.needSeq).toBe(1);
      const inbox = (await api<DownlinkView>(h, 'GET', '/api/downlink')).body;
      expect(inbox.items.find((item) => item.type === 'event' && item.kind === 'permission')).toMatchObject({ text: expect.stringMatching(/^flight asks: Bash/), read: false });
      const stale = await api<ApiError>(h, 'POST', '/api/agents/flight/answer', { go: true, needSeq: 7 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'conflict', field: 'needSeq' });
      expect((await api<ApiError>(h, 'POST', '/api/agents/flight/answer', { go: true, needSeq: 'one' })).status).toBe(400);
      expect(logOf<FakeEvent & { action: string }>(h, 'flight', 'dialog').map((event) => event.action)).toEqual(['shown']);

      const answered = c.mark();
      const response = await api<AgentView>(h, 'POST', '/api/agents/flight/answer', { go: true, needSeq: 1 });
      expect(response.status).toBe(200);
      expect(response.body, 'the state is the hooks\' to change, not the answer\'s').toMatchObject({ name: 'flight', state: 'needs_you', needsKind: 'permission' });
      const next = await c.waitFrame((f) => f.t === 'agent' && f.agent.name === 'flight' && f.agent.state !== 'needs_you', 6000, 'the way out of needs you', answered);
      expect((next as AgentFrame).agent.state).toBe('working');
      await waitState(h, 'flight', 'idle', 15_000);
      expect(logOf<FakeEvent & { action: string }>(h, 'flight', 'dialog').map((event) => event.action)).toEqual(['shown', 'allowed']);
      expect(hooks(h, 'flight').map((hook) => hook.event)).toEqual(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']);

      // nothing is asking now
      const idle = await api<ApiError>(h, 'POST', '/api/agents/flight/answer', { go: true });
      expect(idle.status).toBe(409);
      expect(idle.body).toMatchObject({ code: 'conflict', error: 'flight is not asking for a go' });
    }, 60_000);

    it('POST /api/agents/:name/answer with no-go presses Escape: the prompt is denied and the agent ends needs you', async () => {
      const h = await startServer();
      await waitState(h, 'flight', 'idle');
      const c = await Client.open(h);
      await c.attach('flight');
      c.typeLine('flight', '@fake permission Bash');
      await waitState(h, 'flight', 'needs_you', 10_000);
      const deniedAt = Date.now();
      const response = await api<AgentView>(h, 'POST', '/api/agents/flight/answer', { go: false });
      expect(response.status).toBe(200);
      await waitState(h, 'flight', 'idle', 6000);
      expect(Date.now() - deniedAt, 'about NEEDS_YOU_CLEAR_MS plus a sweep').toBeLessThan(5000);
      expect(logOf<FakeEvent & { action: string }>(h, 'flight', 'dialog').map((event) => event.action)).toEqual(['shown', 'denied']);
      expect(hooks(h, 'flight').map((hook) => hook.event), 'a denial fires no hook').toEqual(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest']);
    }, 60_000);

    it('a late Notification does not bring "needs you" back; an elicitation does, with its message', async () => {
      const h = await startServer();
      await waitState(h, 'flight', 'idle');
      const c = await Client.open(h);
      await c.attach('flight');

      // the dialog was answered long ago: the permission_prompt Notification that comes after finds no dialog on screen
      const before = c.mark();
      c.typeLine('flight', '@fake notify permission_prompt x');
      await waitFor(() => hooks(h, 'flight', 'Notification').length === 1 && hooks(h, 'flight', 'Stop').length === 1, 8000, 'the Notification and the Stop');
      await c.waitStates('flight', 'working', ['working', 'idle'], 10_000, before);
      await sleep(600);
      expect(c.statesFrom('flight', 'working', before)).toEqual(['working', 'idle']);

      // an elicitation form is not on screen as a dialog: no screen check
      const mark = c.mark();
      c.typeLine('flight', '@fake notify elicitation_dialog hello\n@fake sleep 2000');
      const frame = await c.waitFrame((f) => f.t === 'agent' && f.agent.name === 'flight' && f.agent.state === 'needs_you', 8000, 'needs you for the elicitation', mark);
      expect((frame as AgentFrame).agent).toMatchObject({ needsKind: 'input', needsReason: 'input requested: hello' });
      await waitState(h, 'flight', 'idle', 10_000);
    }, 60_000);

    it('a dialog that no hook announced is found on the screen, after about 2 s', async () => {
      const h = await startServer();
      await waitState(h, 'flight', 'idle');
      const c = await Client.open(h);
      await c.attach('flight');
      c.typeLine('flight', '@fake dialog');
      const needs = await waitState(h, 'flight', 'needs_you', 10_000);
      expect(needs).toMatchObject({ needsKind: 'dialog', needsReason: SCREEN_DIALOG_REASON });
      expect(SCREEN_DIALOG_REASON).toBe('a dialog is waiting in the terminal: answer it there');
      expect(hooks(h, 'flight').map((hook) => hook.event), 'no hook announced it').toEqual(['UserPromptSubmit']);
      c.input('flight', '1');
      await waitState(h, 'flight', 'idle', 10_000);
    }, 60_000);
  });

  it('11. shell mode: working and idle again from the window title alone', async () => {
    const h = await startServer({ env: { FAKE_CLAUDE_SHELL_MS: '3000' } });
    await waitState(h, 'flight', 'idle');
    const c = await Client.open(h);
    await c.attach('flight');
    const mark = c.mark();
    c.typeLine('flight', '!sleep');
    const typedAt = Date.now();
    await c.waitStates('flight', 'working', ['working'], 8000, mark);
    expect(hooks(h, 'flight'), 'no hook fires for a shell command').toEqual([]);
    await c.waitStates('flight', 'working', ['working', 'idle'], 14_000, mark);
    expect(Date.now() - typedAt, 'the glyph turned back only when the command ended, 3 s after it began').toBeGreaterThanOrEqual(3000);
    expect(hooks(h, 'flight')).toEqual([]);
    expect(logOf<PromptEvent & { shell?: boolean }>(h, 'flight', 'prompt')[0]).toMatchObject({ text: '!sleep', shell: true });
  }, 60_000);

  it('12. session flag flip: once, only for the session message; any other early exit 1 is reported as it is', async () => {
    const h = await startServer({ sessionDir: true });
    await hire(h, 'ana');
    const sessionId = rosterEntry(h, 'ana').sessionId;
    await api(h, 'POST', '/api/agents/ana/stop');
    // the launcher looks under <CLAUDE_CONFIG_DIR>/projects and finds nothing; the stand-in looks here and finds this
    await writeFile(join(h.sessions, `${sessionId}.jsonl`), '{}\n');
    const before = starts(h, 'ana').length;
    const restarted = await api<AgentView>(h, 'POST', '/api/agents/ana/restart');
    expect(restarted.status).toBe(200);
    await waitState(h, 'ana', 'idle', 20_000);
    const after = starts(h, 'ana').slice(before);
    expect(after.map((start) => start.argv.slice(0, 2))).toEqual([['--session-id', sessionId], ['--resume', sessionId]]);
    expect(logOf<ExitEvent>(h, 'ana', 'exit')).toContainEqual({ e: 'exit', code: 1 });
    await sleep(1500);
    expect(starts(h, 'ana').slice(before), 'one retry, not a third start').toHaveLength(2);
    expect(await view(h, 'ana')).toMatchObject({ state: 'idle', exit: null });

    // an exit 1 for another reason is not a session mismatch: no retry
    await hire(h, 'zed');
    const c = await Client.open(h);
    await c.attach('zed');
    c.typeLine('zed', '@fake exit 1');
    const zed = await waitState(h, 'zed', 'stopped', 15_000);
    expect(zed.exit).toMatchObject({ code: 1, signal: null, requested: false });
    expect(zed.exit?.text.startsWith('exited with code 1')).toBe(true);
    await sleep(1500);
    expect(starts(h, 'zed'), 'exactly one start').toHaveLength(1);
    expect((await view(h, 'zed'))?.state).toBe('stopped');
  }, 60_000);

  describe('13. stopping', () => {
    it('SIGTERM: exit 143 and the text "stopped"', async () => {
      const h = await startServer();
      await hire(h, 'ana');
      const started = Date.now();
      const stopped = await api<AgentView>(h, 'POST', '/api/agents/ana/stop');
      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ state: 'stopped', exit: { code: 143, signal: null, requested: true, text: 'stopped' } });
      expect(Date.now() - started).toBeLessThan(4000);
      const [start] = starts(h, 'ana');
      expect(pidAlive(start?.pid ?? 0)).toBe(false);
      const again = await api<AgentView>(h, 'POST', '/api/agents/ana/stop');
      expect(again.status, 'stopping a stopped agent is idempotent').toBe(200);
      expect(again.body.state).toBe('stopped');
    }, 60_000);

    it('a stubborn agent is killed after about 5 s', async () => {
      const h = await startServer({ env: { FAKE_CLAUDE_STUBBORN: '1' } });
      await waitState(h, 'flight', 'idle');
      const started = Date.now();
      const stopped = await api<AgentView>(h, 'POST', '/api/agents/flight/stop');
      const took = Date.now() - started;
      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ state: 'stopped', exit: { code: null, signal: 9, requested: true, text: 'stopped' } });
      expect(took).toBeGreaterThanOrEqual(4500);
      expect(took).toBeLessThan(12_000);
      expect(pidAlive(starts(h, 'flight')[0]?.pid ?? 0)).toBe(false);
    }, 60_000);

    it('stopping the server leaves no process and no listening port', async () => {
      const h = await startServer();
      await hire(h, 'ana');
      await hire(h, 'ben');
      const pids = ['flight', 'ana', 'ben'].map((name) => starts(h, name)[0]?.pid ?? 0);
      expect(pids.every((pid) => pid > 0 && pidAlive(pid))).toBe(true);
      await h.run.stop();
      for (const pid of pids) expect(pidAlive(pid), `process ${pid}`).toBe(false);
      const refused = await new Promise<string>((resolve) => {
        const socket = net.connect(h.run.port, '127.0.0.1');
        socket.on('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
      });
      expect(refused).toBe('ECONNREFUSED');
      await h.run.stop(); // idempotent
    }, 60_000);
  });

  const builtClient = join(PROJECT_ROOT, 'dist', 'client');
  it.skipIf(!existsSync(join(builtClient, 'index.html')))('14. the built client is served, without a token, with the security headers', async () => {
    const h = await startServer({ staticDir: builtClient });
    const page = await fetch(`${h.base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('cache-control')).toContain('no-cache');
    expect(await page.text()).toContain('<div id="root"></div>');
    expect((await api(h, 'GET', '/api/state', undefined, null)).status, 'the API still needs the token').toBe(401);
  }, 60_000);

  it('15. edit, rename, remove', async () => {
    const h = await startServer();
    await waitState(h, 'flight', 'idle');
    await hire(h, 'ben', { role: 'first role' });
    const warmUp = await send(h, 'ben', 'wake up');
    await itemRead(h, warmUp.body.id); // the transcript exists from here on
    await waitState(h, 'ben', 'idle');
    const sessionId = rosterEntry(h, 'ben').sessionId;
    const c = await Client.open(h);

    // a new role waits for the restart
    const edited = await api<AgentView>(h, 'PATCH', '/api/agents/ben', { role: 'second role: write haiku' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ role: 'second role: write haiku', dirty: true });
    const restarted = await api<AgentView>(h, 'POST', '/api/agents/ben/restart');
    expect(restarted.status).toBe(200);
    expect(restarted.body.dirty).toBe(false);
    await waitState(h, 'ben', 'idle');
    const secondArgv = starts(h, 'ben')[1]?.argv ?? [];
    expect(secondArgv).toEqual(expectedArgv(h, 'ben', 'second role: write haiku', 'resume'));
    expect(secondArgv[secondArgv.indexOf('--append-system-prompt') + 1]).toContain('second role: write haiku');

    // rename while stopped: the old name goes, then the new one comes
    expect((await api<AgentView>(h, 'PATCH', '/api/agents/ben', { name: 'bob' })).status, 'a running agent cannot be renamed').toBe(409);
    expect((await api<AgentView>(h, 'POST', '/api/agents/ben/stop')).body.state).toBe('stopped');
    const mark = c.mark();
    const renamed = await api<AgentView>(h, 'PATCH', '/api/agents/ben', { name: 'bob' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'bob', state: 'stopped' });
    const removedAt = c.frames.slice(mark).findIndex((f) => f.t === 'agent-removed' && f.name === 'ben');
    const addedAt = c.frames.slice(mark).findIndex((f) => f.t === 'agent' && f.agent.name === 'bob');
    expect(removedAt, 'agent-removed for the old name').toBeGreaterThanOrEqual(0);
    expect(addedAt, 'the frame of the new name').toBeGreaterThan(removedAt);
    expect((await getState(h)).agents.map((agent) => agent.name)).toEqual(['flight', 'bob']);
    expect(existsSync(join(h.home, 'agents', 'bob')) && !existsSync(join(h.home, 'agents', 'ben'))).toBe(true);

    // the renamed agent resumes the same session
    await api(h, 'POST', '/api/agents/bob/restart');
    await waitState(h, 'bob', 'idle');
    const bob = starts(h, 'bob');
    expect(bob).toHaveLength(1);
    expect(bob[0]?.argv.slice(0, 2)).toEqual(['--resume', sessionId]);

    // remove: 204 once the process is gone; the boss cannot be removed
    const pid = bob[0]?.pid ?? 0;
    const afterMark = c.mark();
    const removed = await api(h, 'DELETE', '/api/agents/bob');
    expect(removed.status).toBe(204);
    expect(pidAlive(pid)).toBe(false);
    await c.waitFrame((f) => f.t === 'agent-removed' && f.name === 'bob', 5000, 'agent-removed for bob', afterMark);
    expect((await getState(h)).agents.map((agent) => agent.name)).toEqual(['flight']);
    const boss = await api<ApiError>(h, 'DELETE', '/api/agents/flight');
    expect(boss.status).toBe(409);
    expect(boss.body.code).toBe('conflict');
    expect(boss.body.error).toBe('the boss cannot be removed');
    expect((await api(h, 'DELETE', '/api/agents/nobody')).status).toBe(404);
  }, 90_000);

  it('16. detach stops the output and refuses input; a new session id is followed', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    const c = await Client.open(h);
    const { snapshot } = await c.attach('ana');
    c.input('ana', 'x');
    await waitFor(() => c.binary.some((frame) => frame.seq === snapshot.seq), 5000, 'output while attached');
    c.input('ana', '\x03');
    await waitView(h, 'ana', (agent) => !agent.draft, 5000, 'the latch cleared');

    c.detach();
    const mark = c.mark();
    c.input('ana', 'y');
    await c.waitFrame((f) => f.t === 'error' && f.ref === 'input', 5000, 'an error frame for the input after detach', mark);
    const seen = c.binary.length;
    const quiet = await send(h, 'ana', 'while detached');
    await itemRead(h, quiet.body.id);
    await waitState(h, 'ana', 'idle');
    await sleep(400);
    expect(c.binary.length, 'no output after detach').toBe(seen);
    await waitFor(() => prompts(h, 'ana').length >= 1, 5000, 'the pointer prompt in the stand-in log');
    expect(prompts(h, 'ana'),'the dropped input never reached the stand-in').toEqual([pointerText([{ from: 'user' }])]);

    // /clear starts a new session: the next UserPromptSubmit carries its id and the roster follows
    const original = rosterEntry(h, 'ana').sessionId;
    const clear = await send(h, 'ana', '@fake newsession');
    await itemRead(h, clear.body.id);
    await waitState(h, 'ana', 'idle');
    const next = await send(h, 'ana', 'another prompt');
    await itemRead(h, next.body.id);
    const latest = hooks(h, 'ana', 'UserPromptSubmit').at(-1)?.session;
    expect(latest).toBeDefined();
    expect(latest).not.toBe(original);
    await waitFor(() => rosterEntry(h, 'ana').sessionId === latest, 5000, 'agents.json following the new session id');
  }, 60_000);

  it('17. a pointer the agent ignores is pointed at once more, then reported, never looped', async () => {
    const h = await startServer({ env: { FAKE_CLAUDE_IGNORE_POINTER: '1' } });
    await waitState(h, 'flight', 'idle');
    const c = await Client.open(h);
    const mark = c.mark();
    const pointer = pointerText([{ from: 'user' }]);
    const sent = await send(h, 'boss', 'please read this');
    const id = sent.body.id;
    await waitFor(() => pastes(h, 'flight').length === 1, 8000, 'the pointer typed');
    const notRead = 'not read: flight did not read it after two pointers';
    await c.waitItem(id, (item) => item.note === notRead, 15_000, 'to be reported as not read', mark);

    // delivered by the typed pointer, back in the queue at the first Stop, handed over by the block, then reported
    const trail = c.items(id, mark).map((item) => `${item.status}: ${item.note ?? ''}`);
    const at = (text: string): number => trail.indexOf(text);
    expect(at('delivered: pointer typed')).toBeGreaterThanOrEqual(0);
    expect(at('queued: waiting: flight has not read it yet')).toBeGreaterThan(at('delivered: pointer typed'));
    expect(at('delivered: handed over when its turn ended')).toBeGreaterThan(at('queued: waiting: flight has not read it yet'));
    expect(at(`delivered: ${notRead}`)).toBeGreaterThan(at('delivered: handed over when its turn ended'));
    expect(c.items(id, mark).at(-1)).toMatchObject({ status: 'delivered', note: notRead });

    // no loop: within 3 s no further block and no second typed pointer
    await staysFalse(() => hooks(h, 'flight', 'Stop').length > 2 || pastes(h, 'flight').length > 1, 3000, 'another block or pointer');
    expect(hooks(h, 'flight', 'Stop').map((stop) => stop.reply)).toEqual([{ decision: 'block', reason: pointer }, {}]);
    expect(prompts(h, 'flight')).toEqual([pointer]);
    expect(tools(h, 'flight'), 'the agent never read its mail').toEqual([]);
    await waitState(h, 'flight', 'idle');
    expect((await getState(h)).activity.find((item) => item.id === id)).toMatchObject({ status: 'delivered', note: notRead });
  }, 60_000);

  it('18. StopFailure ends a turn; a queued message is then typed; list_roster shows everybody', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await hire(h, 'ben');
    const c = await Client.open(h);
    await c.attach('ana');
    const mark = c.mark();
    c.typeLine('ana', '@fake sleep 1500\n@fake apierror');
    await c.waitFrame((f) => f.t === 'agent' && f.agent.name === 'ana' && f.agent.state === 'working', 8000, 'ana working', mark);
    const queued = await send(h, 'ana', 'after the failure');
    expect(queued.body).toMatchObject({ ok: true, status: 'queued', note: 'waiting: ana is working' });
    await c.waitItem(queued.body.id, (item) => item.status === 'read', 20_000, 'to be read after the StopFailure', mark);
    await waitState(h, 'ana', 'idle');

    // the turn ended through StopFailure, with no Stop in between; the typed pointer came afterwards
    const log = readLog(h, 'ana');
    const promptAt = log.findIndex((event) => event.e === 'prompt' && (event as PromptEvent).text === '@fake sleep 1500\n@fake apierror');
    const failureAt = log.findIndex((event, index) => index > promptAt && event.e === 'hook' && (event as HookEvent).event === 'StopFailure');
    expect(promptAt).toBeGreaterThanOrEqual(0);
    expect(failureAt).toBeGreaterThan(promptAt);
    expect(log.slice(promptAt, failureAt).some((event) => event.e === 'hook' && (event as HookEvent).event === 'Stop'), 'no Stop for that turn').toBe(false);
    expect((log[failureAt] as HookEvent).status).toBe(200);
    expect(prompts(h, 'ana')).toEqual(['@fake sleep 1500\n@fake apierror', pointerText([{ from: 'user' }])]);

    // list_roster: every agent, its state and the boss flag
    const listed = await send(h, 'ana', '@fake list');
    await itemRead(h, listed.body.id);
    await waitState(h, 'ana', 'idle');
    const roster = tools(h, 'ana', 'list_roster').at(-1)?.result as unknown as RosterResult;
    expect(roster).toMatchObject({ you: 'ana', boss: 'flight', specialRecipients: ['boss', 'user'] });
    expect(roster.agents.map((agent) => [agent.name, agent.boss])).toEqual([['flight', true], ['ana', false], ['ben', false]]);
    expect(roster.agents.every((agent) => AGENT_STATES.includes(agent.state) && typeof agent.role === 'string')).toBe(true);
    expect(roster.agents.find((agent) => agent.name === 'ana')?.state, 'the caller is in the middle of its turn').toBe('working');
    expect(roster.agents.find((agent) => agent.name === 'ben')?.state).toBe('idle');
  }, 60_000);

  it('19. a custom agent: its own command, states, no token files, undelivered mail, never polled', async () => {
    const h = await startServer();
    const c = await Client.open(h);
    const script = "console.log('TOKEN=' + (process.env.GONOGO_TOKEN ?? 'none')); setInterval(() => {}, 1000);";
    const command = JSON.stringify([process.execPath, '-e', script]);
    const body = { name: 'dev', role: 'a plain terminal', dir: h.work, mode: 'default', provider: 'custom', command };

    // the hire refuses what a custom agent cannot be, before anything starts
    const noCommand = await api<ApiError>(h, 'POST', '/api/agents', { ...body, command: undefined });
    expect(noCommand).toMatchObject({ status: 400, body: { code: 'bad_request', field: 'command' } });
    const claudeCommand = await api<ApiError>(h, 'POST', '/api/agents', { ...body, provider: 'claude' });
    expect(claudeCommand).toMatchObject({ status: 400, body: { code: 'bad_request', field: 'command' } });
    const badProvider = await api<ApiError>(h, 'POST', '/api/agents', { ...body, provider: 'gpt' });
    expect(badProvider).toMatchObject({ status: 400, body: { field: 'provider' } });
    expect(starts(h, 'dev')).toEqual([]);

    const mark = c.mark();
    const hired = await api<AgentView>(h, 'POST', '/api/agents', body);
    expect(hired.status, JSON.stringify(hired.body)).toBe(201);
    expect(hired.body).toMatchObject({ name: 'dev', provider: 'custom', command, state: 'starting' });
    await waitState(h, 'dev', 'idle');
    // it printed once, so it counted as working for a moment before it went quiet
    expect(c.states('dev', mark)).toEqual(expect.arrayContaining(['starting', 'idle']));

    // the stand-in claude was never started for it: the command ran, with no token in its environment
    expect(starts(h, 'dev')).toEqual([]);
    const { terminal } = await c.attach('dev');
    await terminal.waitRow((row) => row === 'TOKEN=none', 5000, 'the command printing its environment');

    // no settings, MCP file, token or memory file, and the roster stores the custom fields only for it
    for (const file of ['settings.json', 'mcp.json', 'token', 'memory.md']) {
      expect(existsSync(join(h.home, 'agents', 'dev', file)), file).toBe(false);
    }
    expect(rosterEntry(h, 'dev')).toMatchObject({ provider: 'custom', command });
    expect('provider' in rosterEntry(h, 'flight')).toBe(false);

    // mail to it goes nowhere, and the Director is told at once
    const sent = await send(h, 'dev', 'are you there?');
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ ok: false, to: 'dev', status: 'undelivered', note: 'dev runs a custom command and cannot receive messages' });
    expect((await view(h, 'dev'))?.queued).toBe(0);

    // a poll never includes it: with nobody else there is nobody to poll, and naming it is refused
    const nobody = await api<ApiError>(h, 'POST', '/api/poll', {});
    expect(nobody).toMatchObject({ status: 400, body: { code: 'bad_request', error: 'nobody to poll' } });
    const named = await api<ApiError>(h, 'POST', '/api/poll', { agents: ['dev'] });
    expect(named).toMatchObject({ status: 400, body: { code: 'bad_request', field: 'agents' } });
    expect((await getState(h)).poll).toBeNull();

    // the usual lifecycle: stop, restart, edit the command
    expect((await api<AgentView>(h, 'POST', '/api/agents/dev/stop')).body.state).toBe('stopped');
    const edited = await api<AgentView>(h, 'PATCH', '/api/agents/dev', { command: 'sleep 600' });
    expect(edited.body).toMatchObject({ command: 'sleep 600' });
    await api(h, 'POST', '/api/agents/dev/restart');
    await waitState(h, 'dev', 'idle');
    expect(rosterEntry(h, 'dev')).toMatchObject({ provider: 'custom', command: 'sleep 600' });
    expect(starts(h, 'dev')).toEqual([]);
  }, 60_000);

  it('20. T-minus: all go, a no-go holds, the Director holds and aborts, clear', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await hire(h, 'ben');
    await waitState(h, 'flight', 'idle');
    const c = await Client.open(h);
    const poll = async (): Promise<PollView | null> => (await getState(h)).poll;
    const waitPoll = (check: (p: PollView) => boolean, what: string): Promise<PollView> =>
      waitFor(async () => {
        const p = await poll();
        return p !== null && check(p) ? p : undefined;
      }, 15_000, what);
    const subjects = async (subject: string): Promise<string[]> =>
      (await getState(h)).activity.filter((item) => item.subject === subject).map((item) => `${item.from}>${item.to}`).sort();
    const vote = async (name: string, text: string): Promise<void> => {
      const sent = await send(h, name, `@fake vote ${text}`, 'vote');
      await itemRead(h, sent.body.id);
      await waitState(h, name, 'idle');
    };

    // a vote with no poll says so, and the tool result is an error
    await vote('ana', 'go too early');
    expect(tools(h, 'ana', 'go_nogo').at(-1)).toMatchObject({ isError: true, args: { vote: 'go', reason: 'too early' }, result: { ok: false, note: 'no poll is open' } });

    // the default poll: every running claude agent except the boss, each told by a message from the Director
    const mark = c.mark();
    const started = await api<PollView>(h, 'POST', '/api/poll', {});
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ status: 'open', note: 'waiting for ana, ben', entries: [{ agent: 'ana', vote: null }, { agent: 'ben', vote: null }] });
    expect(await api(h, 'POST', '/api/poll', {})).toMatchObject({ status: 409 });
    await waitQuiet(h);
    expect(await subjects('T-minus: go/no-go poll')).toEqual(['user>ana', 'user>ben']);
    const pollFrames = (): PollFrame[] => c.frames.slice(mark).filter((f): f is PollFrame => f.t === 'poll');
    expect(pollFrames()[0]?.poll).toMatchObject({ status: 'open' });

    // all go: the poll turns go on the last vote and the boss is told
    await vote('ana', 'go ready');
    expect(await poll()).toMatchObject({ status: 'open', entries: [{ agent: 'ana', vote: 'go', reason: 'ready' }, { agent: 'ben', vote: null }] });
    expect(await subjects('T-minus: all go')).toEqual([]);
    await vote('ben', 'go');
    expect(await poll()).toMatchObject({ status: 'go', note: 'all go' });
    await waitQuiet(h);
    expect(await subjects('T-minus: all go')).toEqual(['user>flight']);
    expect(tools(h, 'ana', 'go_nogo').at(-1)).toMatchObject({ isError: false, result: { ok: true } });
    expect(pollFrames().at(-1)?.poll).toMatchObject({ status: 'go' });

    // clear removes it, in the snapshot and as a frame
    expect((await api(h, 'DELETE', '/api/poll')).status).toBe(204);
    expect(await poll()).toBeNull();
    await waitFor(() => pollFrames().at(-1)?.poll === null, 5000, 'the poll: null frame');

    // a no-go holds, a later go changes nothing, and abort tells everybody who did not say no-go
    await api(h, 'POST', '/api/poll', { agents: ['ana', 'ben'] });
    await waitQuiet(h);
    await vote('ana', 'no-go sim failed');
    expect(await poll()).toMatchObject({ status: 'hold', note: 'no-go: ana', entries: [{ agent: 'ana', vote: 'no-go', reason: 'sim failed' }, { agent: 'ben', vote: null }] });
    await vote('ben', 'go');
    expect(await poll()).toMatchObject({ status: 'hold', entries: [{ agent: 'ana', vote: 'no-go' }, { agent: 'ben', vote: 'go' }] });
    const aborted = await api<PollView>(h, 'POST', '/api/poll/abort');
    expect(aborted).toMatchObject({ status: 200, body: { status: 'aborted' } });
    await waitQuiet(h);
    expect(await subjects('T-minus: aborted')).toEqual(['user>ben']);
    await vote('ana', 'go changed my mind');
    expect(await poll()).toMatchObject({ status: 'aborted' });
    await api(h, 'DELETE', '/api/poll');

    // the Director holds an open poll; hold and abort need a poll
    expect((await api(h, 'POST', '/api/poll/hold')).status).toBe(409);
    expect((await api(h, 'POST', '/api/poll/abort')).status).toBe(409);
    expect((await api<ApiError>(h, 'POST', '/api/poll', { agents: ['ghost'] })).body).toMatchObject({ code: 'bad_request', field: 'agents' });
    await api(h, 'POST', '/api/poll', { agents: ['ben'] });
    const held = await api<PollView>(h, 'POST', '/api/poll/hold');
    expect(held).toMatchObject({ status: 200, body: { status: 'hold', note: 'held by the Director' } });
    // a second hold says so, instead of "no poll is open"
    expect(await api<ApiError>(h, 'POST', '/api/poll/hold')).toMatchObject({ status: 409, body: { code: 'conflict', error: 'the poll is already on hold' } });
    await waitQuiet(h);

    // a polled agent that stops becomes no-go with the reason "stopped"
    await api(h, 'DELETE', '/api/poll');
    await api(h, 'POST', '/api/poll', { agents: ['ana', 'ben'] });
    await api(h, 'POST', '/api/agents/ben/stop');
    await waitPoll((p) => p.entries.some((e) => e.agent === 'ben' && e.vote === 'no-go' && e.reason === 'stopped') && p.status === 'hold', 'ben stopped counted as no-go');
  }, 120_000);

  it('21. Max Q: a message between agents waits while the limit is reached, then goes when a working agent finishes', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await hire(h, 'ben');
    const c = await Client.open(h);
    const governor = async (): Promise<GovernorView> => (await getState(h)).governor;
    expect(await governor()).toEqual({ limit: null, working: 0, holding: 0 });

    // validation, then on
    expect(await api<ApiError>(h, 'PUT', '/api/governor', { limit: 0 })).toMatchObject({ status: 400, body: { field: 'limit' } });
    expect(await api<ApiError>(h, 'PUT', '/api/governor', { limit: 25 })).toMatchObject({ status: 400, body: { field: 'limit' } });
    const mark = c.mark();
    const on = await api<GovernorView>(h, 'PUT', '/api/governor', { limit: 1 });
    expect(on).toMatchObject({ status: 200, body: { limit: 1, working: 0, holding: 0 } });
    await c.waitFrame((f) => f.t === 'governor' && f.governor.limit === 1, 5000, 'the governor frame', mark);

    // ana works for a while and, meanwhile, tells idle ben something
    const first = await send(h, 'ana', '@fake send ben | hi | from ana\n@fake sleep 3000', 'work');
    const held = await waitFor(async () => {
      const item = (await getState(h)).activity.find((i) => i.from === 'ana' && i.to === 'ben' && i.subject === 'hi');
      return item?.note?.startsWith('waiting: load limit') === true ? item : undefined;
    }, 15_000, 'the message waiting for the limit');
    expect(held).toMatchObject({ status: 'queued', note: 'waiting: load limit (1 of 1 agents working)' });
    expect(await governor()).toEqual({ limit: 1, working: 1, holding: 1 });
    expect((await view(h, 'ben'))?.state).toBe('idle');
    expect(prompts(h, 'ben')).toEqual([]);

    // ana finishes: the pointer goes to ben and the message is read
    await itemRead(h, held.id, 20_000);
    await itemRead(h, first.body.id);
    expect(prompts(h, 'ben')).toEqual([pointerText([{ from: 'ana' }])]);
    await waitQuiet(h);
    expect(await governor()).toEqual({ limit: 1, working: 0, holding: 0 });
    expect(c.frames.slice(mark).some((f) => f.t === 'governor' && f.governor.holding === 1)).toBe(true);

    // off again
    expect((await api<GovernorView>(h, 'PUT', '/api/governor', { limit: null })).body).toEqual({ limit: null, working: 0, holding: 0 });
  }, 60_000);

  it('22. payload: MCP servers beside gonogo, skills as a plugin folder, edit marks it dirty, removal clears both', async () => {
    const h = await startServer();
    await waitState(h, 'flight', 'idle');
    const skill = join(h.tmp, 'skills', 'review');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Use when reviewing.\n---\nBe kind.\n');
    const payload: Payload = {
      mcpServers: {
        files: { command: 'node', args: ['-e', '0'], env: { TOKEN: 'plain-text-secret' } },
        remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer abc' } },
      },
      skills: [skill],
    };
    const valid = { name: 'ana', role: 'Reviews', dir: h.work, mode: 'default' };
    const refuse = async (changes: Record<string, unknown>, field: string): Promise<void> => {
      const response = await api<ApiError>(h, 'POST', '/api/agents', { ...valid, ...changes });
      expect(response.status, JSON.stringify(changes)).toBe(400);
      expect(response.body.field).toBe(field);
    };
    await refuse({ payload: [] }, 'payload');
    await refuse({ payload: { mcpServers: { gonogo: { command: 'x' } } } }, 'payload.mcpServers');
    await refuse({ payload: { mcpServers: { url: { url: 'https://example.test' } } } }, 'payload.mcpServers');
    await refuse({ payload: { skills: ['relative/skill'] } }, 'payload.skills');
    await refuse({ payload: { skills: [join(h.tmp, 'skills', 'missing')] } }, 'payload.skills');
    expect((await getState(h)).agents.map((agent) => agent.name), 'a refused hire leaves nothing behind').toEqual(['flight']);

    await hire(h, 'ana', { payload, role: valid.role });
    const dir = join(h.home, 'agents', 'ana');
    const [first] = starts(h, 'ana');
    expect(first?.argv).toEqual(expectedArgv(h, 'ana', valid.role, 'session-id', join(dir, 'payload-plugin')));
    expect(first?.servers, 'the payload servers beside gonogo').toEqual(['files', 'remote', 'gonogo']);
    expect(first?.plugin).toEqual({ name: 'gonogo-payload', skills: ['review'] });
    expect(lstatSync(join(dir, 'payload-plugin', 'skills', 'review')).isSymbolicLink()).toBe(true);
    const mcp = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers.files).toEqual(payload.mcpServers?.files);
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(rosterEntry(h, 'ana')).toMatchObject({ payload });
    expect((await view(h, 'ana'))?.payload).toEqual(payload);

    // an edit waits for the restart; null takes the whole payload away
    const refused = await api<ApiError>(h, 'PATCH', '/api/agents/ana', { payload: { skills: [join(h.tmp, 'skills', 'missing')] } });
    expect(refused).toMatchObject({ status: 400, body: { field: 'payload.skills' } });
    const edited = await api<AgentView>(h, 'PATCH', '/api/agents/ana', { payload: null });
    expect(edited).toMatchObject({ status: 200, body: { payload: null, dirty: true } });
    expect('payload' in rosterEntry(h, 'ana')).toBe(false);
    expect((await api<AgentView>(h, 'POST', '/api/agents/ana/restart')).body.dirty).toBe(false);
    await waitState(h, 'ana', 'idle');
    const second = starts(h, 'ana')[1];
    expect(second?.argv).toEqual(expectedArgv(h, 'ana', valid.role, 'session-id'));
    expect(second).toMatchObject({ plugin: null, servers: ['gonogo'] });
    expect(existsSync(join(dir, 'payload-plugin'))).toBe(false);
    expect(existsSync(join(skill, 'SKILL.md')), "the owner's skill folder is untouched").toBe(true);
  }, 60_000);

  it('23. Launch Window: a schedule is made, saved, run now as a message from the Director, edited and deleted', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    const c = await Client.open(h);
    const mark = c.mark();
    const base = { name: 'Daily check', to: 'ana', subject: 'status', body: 'Where are you?', rule: '0 9 1 1 *' };

    expect(await api<ApiError>(h, 'POST', '/api/schedules', { ...base, rule: '99 * * * *' })).toMatchObject({ status: 400, body: { field: 'rule' } });
    const made = await api<ScheduleView>(h, 'POST', '/api/schedules', base);
    expect(made).toMatchObject({ status: 201, body: { id: 's1', enabled: true, lastRunAt: null } });
    expect(made.body.nextAt).toBeGreaterThan(Date.now());
    await c.waitFrame((f) => f.t === 'schedules' && f.schedules.length === 1, 5000, 'the schedules frame', mark);
    expect((await getState(h)).schedules).toEqual([made.body]);
    expect(statSync(join(h.home, 'schedules.json')).mode & 0o777).toBe(0o600);

    // Run now goes the way of a Brief: from the Director, with the prefix, and ana reads it
    const ran = await api<ScheduleView>(h, 'POST', '/api/schedules/s1/run');
    expect(ran.body.lastResult).toMatch(/^sent m\d+: /);
    const id = /^sent (m\d+)/.exec(ran.body.lastResult ?? '')?.[1] ?? '';
    const item = await itemRead(h, id);
    expect(item).toMatchObject({ from: 'user', to: 'ana', subject: 'Launch Window: Daily check: status', body: 'Where are you?' });

    // a schedule for an agent that is not there records the refusal and stays
    expect((await api<ScheduleView>(h, 'PATCH', '/api/schedules/s1', { to: 'ghost', enabled: false })).body).toMatchObject({ to: 'ghost', enabled: false, nextAt: null });
    expect((await api<ScheduleView>(h, 'POST', '/api/schedules/s1/run')).body.lastResult).toMatch(/^not sent: unknown recipient "ghost"/);
    expect(JSON.parse(readFileSync(join(h.home, 'schedules.json'), 'utf8')).schedules[0]).toMatchObject({ to: 'ghost', enabled: false });

    expect((await api(h, 'DELETE', '/api/schedules/s1')).status).toBe(204);
    expect(await api<ApiError>(h, 'DELETE', '/api/schedules/s1')).toMatchObject({ status: 404 });
    expect((await getState(h)).schedules).toEqual([]);
  }, 60_000);

  it('24. Uplink: a signed delivery from outside the browser token becomes a message from the Director, and the secret is shown only at create and rotate', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    const c = await Client.open(h);
    const mark = c.mark();

    expect(await api<ApiError>(h, 'POST', '/api/uplinks', { name: 'GitHub', to: 'ana', kind: 'sms' })).toMatchObject({ status: 400, body: { field: 'kind' } });
    const made = await api<UplinkCreated>(h, 'POST', '/api/uplinks', { name: 'GitHub', to: 'ana' });
    expect(made).toMatchObject({ status: 201, body: { id: 'u1', kind: 'generic', enabled: true, deliveries: [] } });
    const secret = made.body.secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    await c.waitFrame((f) => f.t === 'uplinks' && f.uplinks.length === 1, 5000, 'the uplinks frame', mark);
    expect(statSync(join(h.home, 'uplinks.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(h.home, 'uplinks.json'), 'utf8')).uplinks[0].secret).toBe(secret);
    // the secret is in no answer and no frame but the one to create
    expect(JSON.stringify((await getState(h)).uplinks)).not.toContain(secret);
    expect(JSON.stringify((await api(h, 'GET', '/api/uplinks')).body)).not.toContain(secret);

    // outside /api and without the browser token: the signature of the raw body is the proof
    const post = (id: string, body: string, headers: Record<string, string>): Promise<Response> =>
      fetch(`${h.base}/uplink/${id}`, { method: 'POST', headers, body });
    const body = '{"action":  "opened", "issue": {"number": 7, "title": "It broke"}}';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const unsigned = await post('u1', body, {});
    expect(unsigned.status).toBe(401);
    expect((await post('u1', body, { 'x-gonogo-signature': `sha256=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await post('u9', body, { 'x-gonogo-signature': signature })).status).toBe(404);
    expect((await post('u1', body, { authorization: `Bearer ${h.token}` })).status).toBe(401);
    const sent = await post('u1', body, { 'x-gonogo-signature': signature });
    expect(sent.status).toBe(202);
    const { id, status } = (await sent.json()) as { id: string; status: string };
    expect(status).toBe('queued');
    const item = await itemRead(h, id);
    expect(item).toMatchObject({ from: 'user', to: 'ana', subject: 'Uplink: GitHub', body: JSON.stringify(JSON.parse(body), null, 2) });
    const frame = await c.waitFrame((f) => f.t === 'uplinks' && f.uplinks[0]?.deliveries.length === 1, 5000, 'the delivery frame', mark);
    expect(JSON.stringify(frame)).not.toContain(secret);
    expect((await getState(h)).uplinks[0]?.deliveries[0]).toMatchObject({ status: 'queued', note: expect.stringMatching(new RegExp(`^${id}`)) });

    // a bearer secret works too; a body that is not JSON is a 400 that the list shows as refused
    expect((await post('u1', '{"n":2}', { authorization: `Bearer ${secret}` })).status).toBe(202);
    expect((await post('u1', 'a=1', { authorization: `Bearer ${secret}` })).status).toBe(400);
    expect((await getState(h)).uplinks[0]?.deliveries[0]).toMatchObject({ status: 'refused' });

    // another Host is as forbidden as for any route; a page's Origin is refused
    expect((await rawRequest(h, '/uplink/u1', { host: 'evil.example' }, 'POST')).status).toBe(403);
    expect((await rawRequest(h, '/uplink/u1', { origin: h.base }, 'POST')).status).toBe(403);

    // Test sends a sample; rotate gives a new secret and the old one stops at once
    const tested = await api<UplinkView>(h, 'POST', '/api/uplinks/u1/test');
    expect(tested.body.deliveries[0]).toMatchObject({ status: 'queued', note: expect.stringMatching(/^test: m\d+/) });
    const rotated = await api<UplinkCreated>(h, 'POST', '/api/uplinks/u1/rotate');
    expect(rotated.body.secret).not.toBe(secret);
    expect((await post('u1', body, { 'x-gonogo-signature': signature })).status).toBe(401);
    const again = `sha256=${createHmac('sha256', rotated.body.secret).update(body).digest('hex')}`;
    expect((await post('u1', body, { 'x-gonogo-signature': again })).status).toBe(202);

    // off: the same 404 as an uplink that does not exist; a recipient that is gone is a 409 with the reason
    expect((await api<UplinkView>(h, 'PATCH', '/api/uplinks/u1', { enabled: false })).body.enabled).toBe(false);
    const off = await post('u1', body, { 'x-gonogo-signature': again });
    const unknown = await post('u9', body, { 'x-gonogo-signature': again });
    expect([off.status, await off.text()]).toEqual([unknown.status, await unknown.text()]);
    await api(h, 'PATCH', '/api/uplinks/u1', { enabled: true, to: 'ghost' });
    const ghost = await post('u1', body, { 'x-gonogo-signature': again });
    expect(ghost.status).toBe(409);
    expect(((await ghost.json()) as ApiError).error).toMatch(/^unknown recipient "ghost"/);

    expect((await api(h, 'DELETE', '/api/uplinks/u1')).status).toBe(204);
    expect((await post('u1', body, { 'x-gonogo-signature': again })).status).toBe(404);
    expect((await getState(h)).uplinks).toEqual([]);
  }, 60_000);

  it('25. Flight Plan: the Director and the agents change one board, an assignment is a message, and the file is private', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await hire(h, 'ben');
    await waitState(h, 'flight', 'idle');
    const c = await Client.open(h);
    const mark = c.mark();
    const board = async (): Promise<Task[]> => (await getState(h)).tasks;
    const mails = async (subject: string): Promise<string[]> => (await getState(h)).activity.filter((item) => item.subject === subject).map((item) => `${item.from}>${item.to}`);
    // what an agent does: the stand-in calls the tool with these arguments, after a message from the Director that carries the directive
    const tell = async (name: string, line: string): Promise<void> => {
      const sent = await send(h, name, `@fake task ${line}`, 'task');
      await itemRead(h, sent.body.id);
      await waitState(h, name, 'idle');
    };

    // the Director makes a task for ana; she is told by a message from the Director
    expect(await api<ApiError>(h, 'POST', '/api/tasks', { title: 'Write the spec', assignee: 'nobody' })).toMatchObject({ status: 400, body: { field: 'assignee' } });
    const made = await api<Task>(h, 'POST', '/api/tasks', { title: 'Write the spec', detail: 'one page', assignee: 'ana' });
    expect(made).toMatchObject({ status: 201, body: { id: 't1', status: 'todo', assignee: 'ana', createdBy: 'user' } });
    await c.waitFrame((f) => f.t === 'tasks' && f.tasks.length === 1, 5000, 'the tasks frame', mark);
    await waitQuiet(h);
    expect(await mails('Flight Plan: t1 assigned to you: Write the spec')).toEqual(['user>ana']);

    // ana moves it with the tool; the server stamps her name, whatever the arguments say
    await tell('ana', 'task_update {"id":"t1","status":"doing","note":"started"}');
    expect(tools(h, 'ana', 'task_update').at(-1)).toMatchObject({ isError: false, result: { ok: true, task: { id: 't1', status: 'doing' } } });
    expect((await board())[0]).toMatchObject({ status: 'doing', notes: [expect.stringMatching(/ Director: created; assigned to ana$/), expect.stringMatching(/ ana: status doing; started$/)] });

    // ana hands a new task to ben: the message is from ana, through the same path as send_message
    await tell('ana', 'task_create {"title":"Review the spec","assignee":"ben"}');
    expect(tools(h, 'ana', 'task_create').at(-1)).toMatchObject({ isError: false, result: { ok: true, task: { id: 't2', createdBy: 'ana', assignee: 'ben' } } });
    await waitQuiet(h);
    expect(await mails('Flight Plan: t2 assigned to you: Review the spec')).toEqual(['ana>ben']);

    // ben sees his own task, and is told why an assignment to somebody who is not there fails
    await tell('ben', 'task_list {"mine":true}');
    expect(tools(h, 'ben', 'task_list').at(-1)).toMatchObject({ isError: false, result: { count: 1, tasks: [{ id: 't2' }] } });
    await tell('ben', 'task_update {"id":"t2","assignee":"ghost"}');
    expect(tools(h, 'ben', 'task_update').at(-1)).toMatchObject({ isError: true, result: { ok: false, error: expect.stringMatching(/assignee/) } });
    expect((await board())[1]).toMatchObject({ assignee: 'ben' });

    // the file is private and holds the board
    expect(statSync(join(h.home, 'tasks.json')).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(join(h.home, 'tasks.json'), 'utf8')) as { tasks: Task[] }).tasks.map((t) => [t.id, t.status])).toEqual([['t1', 'doing'], ['t2', 'todo']]);

    // the Director moves a card and removes the other
    expect((await api<Task>(h, 'PATCH', '/api/tasks/t1', { status: 'done', note: 'merged' })).body.status).toBe('done');
    expect((await api(h, 'DELETE', '/api/tasks/t2')).status).toBe(204);
    expect(await api<ApiError>(h, 'DELETE', '/api/tasks/t2')).toMatchObject({ status: 404 });
    await c.waitFrame((f) => f.t === 'tasks' && f.tasks.length === 1 && f.tasks[0]?.status === 'done', 5000, 'the last tasks frame', mark);
    expect((await board()).map((t) => [t.id, t.status])).toEqual([['t1', 'done']]);
  }, 90_000);

  it('26. Downlink: a message to the Director, a T-minus result and a blocked task land in one inbox that the routes mark and the file keeps', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await waitState(h, 'flight', 'idle');
    const c = await Client.open(h);
    const mark = c.mark();
    const inbox = async (): Promise<DownlinkView> => (await api<DownlinkView>(h, 'GET', '/api/downlink')).body;
    const downlinkFrames = (): DownlinkView[] => c.frames.slice(mark).filter((f): f is DownlinkFrame => f.t === 'downlink').map((f) => f.downlink);
    expect(await inbox()).toEqual({ unread: 0, items: [] });
    expect((await getState(h)).downlink).toEqual({ unread: 0, items: [] });

    // what an agent sends to the Director is an item, unread, in the snapshot and as a frame
    const sent = await send(h, 'ana', '@fake send user | done | all good', 'report');
    await itemRead(h, sent.body.id);
    await waitFor(async () => (await inbox()).unread === 1, 15_000, 'the message in the inbox');
    expect((await inbox()).items[0]).toMatchObject({ type: 'message', from: 'ana', subject: 'done', body: 'all good', read: false, archived: false });
    expect(downlinkFrames().at(-1)?.unread).toBe(1);

    // a T-minus result and a task an agent moved to blocked are events; the Director's own moves are not
    await api(h, 'POST', '/api/poll', { agents: ['ana'] });
    expect((await api(h, 'POST', '/api/poll/abort')).status).toBe(200);
    expect((await api<Task>(h, 'POST', '/api/tasks', { title: 'Write the spec', assignee: 'ana' })).status).toBe(201);
    await api(h, 'PATCH', '/api/tasks/t1', { status: 'review' });
    await waitQuiet(h);
    const moved = await send(h, 'ana', '@fake task task_update {"id":"t1","status":"blocked","note":"waiting"}', 'task');
    await itemRead(h, moved.body.id);
    await waitState(h, 'ana', 'idle');
    const events = (await waitFor(async () => ((await inbox()).items.filter((i) => i.type === 'event').length === 2 ? await inbox() : undefined), 15_000, 'two events')).items.filter((i) => i.type === 'event');
    expect(events.map((e) => (e.type === 'event' ? [e.kind, e.text] : null))).toEqual([
      ['flight-plan', 'ana moved t1 to blocked: Write the spec'],
      ['tminus', 'ABORTED: aborted by the Director'],
    ]);
    expect((await inbox()).unread).toBe(3);

    // read, archive and read all, each by its route; an id that is not in the inbox is skipped and a bad request is named
    const messageId = (await inbox()).items.find((i) => i.type === 'message')?.id ?? '';
    expect((await api<DownlinkView>(h, 'POST', '/api/downlink/read', { ids: [messageId, 'm99'] })).body.unread).toBe(2);
    expect((await api<DownlinkView>(h, 'POST', '/api/downlink/archive', { ids: ['e1'] })).body.unread).toBe(1);
    expect(await api<ApiError>(h, 'POST', '/api/downlink/read', { ids: 'e2' })).toMatchObject({ status: 400, body: { field: 'ids' } });
    expect((await api<DownlinkView>(h, 'POST', '/api/downlink/read-all')).body.unread).toBe(0);
    await waitFor(() => downlinkFrames().at(-1)?.unread === 0, 5000, 'the last downlink frame');
    expect(downlinkFrames().map((v) => v.unread)).toEqual([1, 2, 3, 2, 1, 0]);

    // the file holds the events and one flag for each item, and is private
    const file = join(h.home, 'downlink.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, seq: 2, flags: { [messageId]: 'read', e1: 'archived', e2: 'read' } });
  }, 90_000);

  it('27. Mission Log: agents write, search and read one shared log, a frame carries only titles, the Director edits it, and the files are private', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await hire(h, 'ben');
    await waitState(h, 'flight', 'idle');
    const c = await Client.open(h);
    const mark = c.mark();
    const folder = join(h.home, 'mission-log');
    // what an agent does: the stand-in calls the tool with these arguments, after a message from the Director that carries the directive
    const tell = async (name: string, line: string): Promise<void> => {
      const sent = await send(h, name, `@fake log ${line}`, 'log');
      await itemRead(h, sent.body.id);
      await waitState(h, name, 'idle');
    };

    // ana writes an entry; the frame names its id and title, never its text
    await tell('ana', 'log_write {"title":"Cache key","body":"The cache key has the node version.","tags":["Build"]}');
    expect(tools(h, 'ana', 'log_write').at(-1)).toMatchObject({ isError: false, result: { ok: true, id: 'l1', title: 'Cache key', tags: ['build'] } });
    await c.waitFrame((f) => f.t === 'log' && f.changed.length === 1, 5000, 'the log frame', mark);
    const frames = c.frames.slice(mark).filter((f) => f.t === 'log');
    expect(frames).toEqual([{ t: 'log', changed: [{ id: 'l1', title: 'Cache key' }], removed: [] }]);
    expect(JSON.stringify(frames)).not.toContain('node version');

    // ben finds it by a word of the body, reads it, and is refused when he tries to change it
    await tell('ben', 'log_search {"query":"node version","limit":5}');
    expect(tools(h, 'ben', 'log_search').at(-1)).toMatchObject({ isError: false, result: { count: 1, results: [{ id: 'l1', author: 'ana', tags: ['build'], snippet: 'The cache key has the node version.' }] } });
    await tell('ben', 'log_read {"id":"l1"}');
    expect(tools(h, 'ben', 'log_read').at(-1)).toMatchObject({ isError: false, result: { ok: true, entry: { id: 'l1', author: 'ana', body: 'The cache key has the node version.' } } });
    await tell('ben', 'log_write {"id":"l1","body":"mine now"}');
    expect(tools(h, 'ben', 'log_write').at(-1)).toMatchObject({ isError: true, result: { ok: false, error: expect.stringMatching(/written by ana/) } });
    await tell('ana', 'log_write {"id":"l1","body":"The cache key has the node version and the lockfile hash."}');
    expect(tools(h, 'ana', 'log_write').at(-1)).toMatchObject({ isError: false, result: { ok: true, id: 'l1' } });

    // the Director searches, writes, edits and removes; what he writes has his name
    expect((await api<LogSearch>(h, 'GET', '/api/log?q=lockfile')).body).toMatchObject({ total: 1, hits: [{ id: 'l1', snippet: 'The cache key has the node version and the lockfile hash.' }] });
    expect((await api<LogSearch>(h, 'GET', '/api/log?q=unicorn')).body).toEqual({ total: 1, hits: [] });
    expect(await api<ApiError>(h, 'POST', '/api/log', { title: 'No body' })).toMatchObject({ status: 400, body: { field: 'body' } });
    const made = await api<LogEntry>(h, 'POST', '/api/log', { title: 'Release steps', body: 'Tag the release.', tags: ['release'] });
    expect(made).toMatchObject({ status: 201, body: { id: 'l2', author: 'user' } });
    expect((await api<LogEntry>(h, 'PUT', '/api/log/l1', { title: 'Cache key of the build' })).body).toMatchObject({ id: 'l1', author: 'ana', title: 'Cache key of the build' });
    expect((await api<LogEntry>(h, 'GET', '/api/log/l2')).body).toMatchObject({ body: 'Tag the release.' });
    expect((await api<LogSearch>(h, 'GET', '/api/log')).body.hits.map((hit) => hit.id)).toEqual(['l1', 'l2']);

    // the files are one markdown file for each entry, private, and the browser token is the only key to the routes
    expect(statSync(join(folder, 'l1.md')).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(folder, 'l1.md'), 'utf8')).toMatch(/^---\nversion: 1\nid: "l1"\ntitle: "Cache key of the build"\ntags: \["build"\]\nauthor: "ana"\ncreatedAt: "[^"]+"\nupdatedAt: "[^"]+"\n---\nThe cache key has the node version and the lockfile hash\.\n$/);
    expect((await rawRequest(h, '/api/log', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await api(h, 'DELETE', '/api/log/l2')).status).toBe(204);
    expect(await api<ApiError>(h, 'GET', '/api/log/l2')).toMatchObject({ status: 404 });
    await c.waitFrame((f) => f.t === 'log' && f.removed.includes('l2'), 5000, 'the removal frame', mark);
    expect(readdirSync(folder).filter((f) => f.endsWith('.md'))).toEqual(['l1.md']);
  }, 90_000);

  it('28. Relay: signed deliveries of four services reach the agent, what an agent writes to the Director is posted to Slack and Telegram, and a reply comes back to the agent that wrote it', async () => {
    const posts: Array<{ url: string; body: { text: string; channel?: string; chat_id?: string } }> = [];
    let n = 0;
    const relayFetch: typeof fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      n += 1;
      return Response.json(String(url).includes('slack') ? { ok: true, channel: 'C0123456789', ts: `1700000000.00000${n}` } : { ok: true, result: { message_id: 40 + n, chat: { id: 555 } } });
    };
    const h = await startServer({ relayFetch });
    await hire(h, 'ana');
    await waitState(h, 'flight', 'idle');
    const SLACK_TOKEN = 'xoxb-1234567890-abcdefghijkl';
    const TELEGRAM_TOKEN = '123456789:AAFabcdefghijklmnopqrstuvwxyz012345';
    const SLACK_SECRET = '8f742231b10e8888abcd99yyyzzz85a5';

    // the targets are saved in a private file and the token never comes back
    expect((await api(h, 'PUT', '/api/relay/slack', { token: SLACK_TOKEN, to: 'C0123456789' })).status).toBe(200);
    const view = await api<{ slack: { to: string } | null; telegram: { to: string } | null; forward: string[] }>(h, 'PUT', '/api/relay/telegram', { token: TELEGRAM_TOKEN, to: '555' });
    expect(view.body).toEqual({ slack: { to: 'C0123456789', last: null }, telegram: { to: '555', last: null }, forward: ['message', 'redline', 'tminus', 'flight-plan'], phone: 'off' });
    expect(statSync(join(h.home, 'relay.json')).mode & 0o777).toBe(0o600);
    expect(await api<ApiError>(h, 'PUT', '/api/relay/slack', { token: 'nope', to: 'C0123456789' })).toMatchObject({ status: 400, body: { field: 'token' } });

    // four uplinks: GitHub and Telegram get a secret of gonogo's, Slack takes the one of its app
    const github = (await api<UplinkCreated>(h, 'POST', '/api/uplinks', { name: 'GitHub', to: 'ana', kind: 'github' })).body;
    const slack = (await api<UplinkCreated>(h, 'POST', '/api/uplinks', { name: 'Slack', to: 'ana', kind: 'slack', secret: SLACK_SECRET })).body;
    const telegram = (await api<UplinkCreated>(h, 'POST', '/api/uplinks', { name: 'Telegram', to: 'ana', kind: 'telegram' })).body;
    expect([github.id, slack.id, telegram.id]).toEqual(['u1', 'u2', 'u3']);
    expect(await api<ApiError>(h, 'POST', '/api/uplinks', { name: 'Slack', to: 'ana', kind: 'slack' })).toMatchObject({ status: 400, body: { field: 'secret' } });
    expect((await api(h, 'POST', '/api/uplinks/u2/rotate')).status).toBe(409);
    const post = (id: string, body: string, headers: Record<string, string>): Promise<Response> => fetch(`${h.base}/uplink/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    const hub = (secret: string, body: string): Record<string, string> => ({ 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` });
    const slackSigned = (body: string, stamp = String(Math.floor(Date.now() / 1000))): Record<string, string> => ({
      'x-slack-request-timestamp': stamp,
      'x-slack-signature': `v0=${createHmac('sha256', SLACK_SECRET).update(`v0:${stamp}:${body}`).digest('hex')}`,
    });
    const telegramHeaders = { 'x-telegram-bot-api-secret-token': telegram.secret };
    const lastTo = async (): Promise<ActivityItem> => (await getState(h)).activity.find((item) => item.to === 'ana' && item.from === 'user') as ActivityItem;

    // GitHub: a ping is answered, a push is a message, a bad signature and the signature of another kind are 401
    const ping = '{"zen":"Keep it logically awesome.","repository":{"full_name":"ulm0/gonogo"}}';
    const pinged = await post('u1', ping, { 'x-github-event': 'ping', ...hub(github.secret, ping) });
    expect([pinged.status, await pinged.json()]).toEqual([200, { ok: true, ping: true }]);
    const push = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'ulm0/gonogo' }, sender: { login: 'ana-dev' }, commits: [{ id: '1234567890abc', message: 'Add Relay' }] });
    expect((await post('u1', push, { 'x-github-event': 'push', ...hub('wrong secret 0123456789', push) })).status).toBe(401);
    expect((await post('u1', push, { 'x-github-event': 'push', authorization: `Bearer ${github.secret}` })).status).toBe(401);
    const pushed = await post('u1', push, { 'x-github-event': 'push', ...hub(github.secret, push) });
    expect(pushed.status).toBe(202);
    const pushItem = await itemRead(h, ((await pushed.json()) as { id: string }).id);
    expect(pushItem).toMatchObject({ from: 'user', to: 'ana', subject: 'Uplink: GitHub', body: 'GitHub push to ulm0/gonogo refs/heads/main by ana-dev: 1 commit\n- 1234567 Add Relay' });
    expect((await getState(h)).uplinks[0]?.deliveries.map((d) => d.status)).toEqual(['queued', 'answered']);

    // Slack: the challenge is answered with the challenge, a stale timestamp is refused, a mention is a message
    const challenge = '{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRN"}';
    const verified = await post('u2', challenge, slackSigned(challenge));
    expect([verified.status, await verified.json()]).toEqual([200, { challenge: '3eZbrw1aBm2rZgRN' }]);
    expect((await post('u2', challenge, slackSigned(challenge, String(Math.floor(Date.now() / 1000) - 400)))).status).toBe(401);
    const mention = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention', user: 'U111', channel: 'C0123456789', ts: '1700000000.100000', text: '<@UBOT> status?' } });
    expect((await post('u2', mention, slackSigned(mention))).status).toBe(202);
    expect((await post('u2', mention, slackSigned(mention))).status).toBe(200);
    await itemRead(h, (await lastTo()).id);
    expect(await lastTo()).toMatchObject({ subject: 'Uplink: Slack', body: 'Slack mention from U111 in C0123456789:\n\n<@UBOT> status?' });

    // Telegram: the chat of the target is the Director, every other chat is dropped without a message
    const text = (chat: number, extra: Record<string, unknown> = {}): string => JSON.stringify({ update_id: 1, message: { message_id: 7, chat: { id: chat }, from: { first_name: 'Ulm' }, text: 'hello', ...extra } });
    expect((await post('u3', text(555), { 'x-telegram-bot-api-secret-token': 'x'.repeat(64) })).status).toBe(401);
    const before = (await getState(h)).activity.length;
    expect(await (await post('u3', text(556), telegramHeaders)).json()).toEqual({ ok: true, ignored: true });
    expect((await getState(h)).activity.length).toBe(before);
    expect((await post('u3', text(555), telegramHeaders)).status).toBe(202);
    await itemRead(h, (await lastTo()).id);
    expect(await lastTo()).toMatchObject({ subject: 'Uplink: Telegram', body: 'Telegram message from Ulm in chat 555:\n\nhello' });

    // what an agent writes to the Director is posted to both targets, in the words of the inbox
    expect(posts).toEqual([]);
    const sent = await send(h, 'ana', '@fake send user | done | all good <now>', 'report');
    await itemRead(h, sent.body.id);
    await waitFor(() => posts.length === 2, 15_000, 'both posts');
    const slackPost = posts.find((p) => p.url === 'https://slack.com/api/chat.postMessage');
    const telegramPost = posts.find((p) => p.url === `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
    expect(slackPost?.body).toEqual({ channel: 'C0123456789', text: 'Message from ana: done\n\nall good &lt;now&gt;' });
    expect(telegramPost?.body).toEqual({ chat_id: '555', text: 'Message from ana: done\n\nall good <now>' });
    const sentId = ((await getState(h)).activity.find((item) => item.to === 'user' && item.subject === 'done') as ActivityItem).id;

    // a reply in the thread, and a Telegram reply, are messages from the Director to the agent that wrote it, in reply to it
    const slackTs = `1700000000.00000${posts.indexOf(slackPost as never) + 1}`;
    const reply = JSON.stringify({ type: 'event_callback', event: { type: 'message', user: 'U111', channel: 'C0123456789', ts: '1700000000.200000', thread_ts: slackTs, text: 'ship it' } });
    expect((await post('u2', reply, slackSigned(reply))).status).toBe(202);
    await itemRead(h, (await lastTo()).id);
    expect(await lastTo()).toMatchObject({ to: 'ana', subject: 'Re: done', body: 'ship it', inReplyTo: sentId });
    const telegramId = 40 + posts.indexOf(telegramPost as never) + 1;
    expect((await post('u3', text(555, { text: 'and tell bo', reply_to_message: { message_id: telegramId } }), telegramHeaders)).status).toBe(202);
    await waitFor(async () => ((await lastTo()).body === 'and tell bo' ? true : undefined), 15_000, 'the Telegram reply');
    expect(await lastTo()).toMatchObject({ to: 'ana', subject: 'Re: done', inReplyTo: sentId });
    // a reply in a channel to something gonogo did not post is not for the agents
    const stray = JSON.stringify({ type: 'event_callback', event: { type: 'message', channel_type: 'channel', user: 'U111', channel: 'C0123456789', ts: '1700000000.300000', thread_ts: '1.2', text: 'chatter' } });
    expect(await (await post('u2', stray, slackSigned(stray))).json()).toEqual({ ok: true, ignored: true });

    // a T-minus result is forwarded too, and Test sends one message with the answer in the view
    await api(h, 'POST', '/api/poll', { agents: ['ana'] });
    await api(h, 'POST', '/api/poll/abort');
    await waitFor(() => posts.length === 4, 15_000, 'the T-minus posts');
    expect(posts.slice(2).map((p) => p.body.text)).toEqual(['T-minus: ABORTED: aborted by the Director', 'T-minus: ABORTED: aborted by the Director']);
    const tested = await api<{ slack: { last: { ok: boolean; note: string } } }>(h, 'POST', '/api/relay/slack/test');
    expect(tested.body.slack.last).toMatchObject({ ok: true, note: 'test sent' });
    expect(posts).toHaveLength(5);

    // what is not chosen is not forwarded
    expect((await api(h, 'PUT', '/api/relay/forward', { kinds: ['redline'] })).status).toBe(200);
    const quiet = await send(h, 'ana', '@fake send user | later | not forwarded', 'report');
    await itemRead(h, quiet.body.id);
    await staysFalse(() => posts.length > 5, 600, 'a post of a kind that is not chosen');

    // no token is in any answer, state or frame, and the secrets are in the file only
    const everything = JSON.stringify([(await api(h, 'GET', '/api/relay')).body, await getState(h), (await api(h, 'GET', '/api/uplinks')).body]);
    for (const secret of [SLACK_TOKEN, TELEGRAM_TOKEN, SLACK_SECRET, github.secret, telegram.secret]) expect(everything).not.toContain(secret);
    expect(JSON.parse(readFileSync(join(h.home, 'relay.json'), 'utf8'))).toMatchObject({ slack: { token: SLACK_TOKEN }, telegram: { token: TELEGRAM_TOKEN }, forward: ['redline'] });
    expect(statSync(join(h.home, 'uplinks.json')).mode & 0o777).toBe(0o600);
    expect((await api(h, 'DELETE', '/api/relay/telegram')).body).toMatchObject({ telegram: null });
  }, 120_000);

  it('29. Livery: an agent submits a livery that is checked, the Director chooses it and every device is told, a design request reaches the agent, and the files are private', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await waitState(h, 'flight', 'idle');
    const c = await Client.open(h);
    const mark = c.mark();
    const tokens = { ...BUILTIN_LIVERIES[0]!.tokens, '--body': '#dcdad3' };
    const liveryFrames = (): LiveryView[] => c.frames.slice(mark).filter((f): f is LiveryFrame => f.t === 'livery').map((f) => f.livery);
    const tell = async (line: string): Promise<void> => {
      const sent = await send(h, 'ana', `@fake livery ${line}`, 'livery');
      await itemRead(h, sent.body.id);
      await waitState(h, 'ana', 'idle');
    };

    // the four that ship are there, in the state too, and the default is on
    const first = await api<LiveryView>(h, 'GET', '/api/liveries');
    expect(first.body.current).toBe('instrument');
    expect(first.body.liveries.map((e) => e.slug)).toEqual(['instrument', 'night-shift', 'low-ink', 'high-contrast']);
    expect((await getState(h)).livery).toEqual(first.body);

    // a livery with a text that cannot be read is refused, and the answer says which pair; nothing is written
    await tell(`livery_submit ${JSON.stringify({ name: 'Faded', tokens: { ...tokens, '--muted': '#b5b2ab' } })}`);
    expect(tools(h, 'ana', 'livery_submit').at(-1)).toMatchObject({ isError: true, result: { ok: false, error: expect.stringMatching(/^--muted on --body is \d\.\d\d:1, it needs 4\.5:1/) } });
    expect(existsSync(join(h.home, 'liveries', 'faded.json'))).toBe(false);

    // a good one is saved under the agent's name, the browsers are told, the Director gets a Downlink event, and it is not applied
    await tell(`livery_submit ${JSON.stringify({ name: 'Dusk', description: 'Blue hour.', tokens })}`);
    expect(tools(h, 'ana', 'livery_submit').at(-1)).toMatchObject({ isError: false, result: { ok: true, slug: 'dusk' } });
    await waitFor(() => liveryFrames().length === 1, 5000, 'the livery frame');
    expect(liveryFrames()[0]).toMatchObject({ current: 'instrument' });
    expect(liveryFrames()[0]!.liveries.at(-1)).toMatchObject({ slug: 'dusk', name: 'Dusk', author: 'ana', builtin: false });
    const inbox = (await api<DownlinkView>(h, 'GET', '/api/downlink')).body;
    expect(inbox.items.find((item) => item.type === 'event' && item.kind === 'livery')).toMatchObject({ text: 'ana submitted the livery "Dusk". Pick it in the Livery view to try it.', read: false });
    const file = join(h.home, 'liveries', 'dusk.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.home, 'liveries')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, name: 'Dusk', description: 'Blue hour.', author: 'ana', tokens });

    // the Director chooses it: every device is told, and the choice is kept in a private file
    expect((await api<LiveryView>(h, 'PUT', '/api/livery', { slug: 'dusk' })).body.current).toBe('dusk');
    await waitFor(() => liveryFrames().at(-1)?.current === 'dusk', 5000, 'the choice frame');
    expect((await getState(h)).livery?.current).toBe('dusk');
    expect(JSON.parse(readFileSync(join(h.home, 'livery.json'), 'utf8'))).toEqual({ version: 1, current: 'dusk' });
    expect(statSync(join(h.home, 'livery.json')).mode & 0o777).toBe(0o600);
    expect(await api<ApiError>(h, 'PUT', '/api/livery', { slug: 'nope' })).toMatchObject({ status: 404, body: { field: 'slug' } });
    expect((await api(h, 'DELETE', '/api/liveries/night-shift')).status).toBe(403);
    expect((await rawRequest(h, '/api/liveries', { Authorization: 'Bearer nope' })).status).toBe(401);

    // the design request is a message from the Director with the brief, the tokens and the rule, and a refusal is a 400
    expect(await api<ApiError>(h, 'POST', '/api/liveries/design', { brief: '' })).toMatchObject({ status: 400, body: { field: 'brief' } });
    const asked = await api<SendResult>(h, 'POST', '/api/liveries/design', { to: 'ana', brief: 'A calm look for night.' });
    expect(asked.status).toBe(201);
    const item = await itemRead(h, asked.body.id);
    expect(item).toMatchObject({ from: 'user', to: 'ana', subject: 'Livery: design request' });
    expect(item.body).toContain('Brief: A calm look for night.');
    expect(item.body).toContain('mcp__gonogo__livery_submit');
    expect((await api<SendResult>(h, 'POST', '/api/liveries/design', { brief: 'For the boss.' })).body.to).toBe('flight');

    // deleting the chosen one goes back to the default, and the file goes
    const gone = await api<LiveryView>(h, 'DELETE', '/api/liveries/dusk');
    expect([gone.status, gone.body.current, gone.body.liveries.length]).toEqual([200, 'instrument', 4]);
    await waitFor(() => liveryFrames().at(-1)?.current === 'instrument', 5000, 'the frame of the delete');
    expect(existsSync(file)).toBe(false);
  }, 120_000);

  it('30. Docking: two servers pair over real HTTP, agents write to each other by name@station, a task is handed off, a replayed, old or unsigned call is refused, and an undock ends it on both', async () => {
    const a = await startServer({ env: { GONOGO_STATION: 'alpha' } });
    const b = await startServer({ env: { GONOGO_STATION: 'beta' } });
    await hire(a, 'ana');
    await hire(b, 'bob');
    const c = await Client.open(a);
    const mark = c.mark();
    const tell = async (h: Harness, agent: string, line: string): Promise<void> => {
      const sent = await send(h, agent, line, 'docking');
      await itemRead(h, sent.body.id);
      await waitState(h, agent, 'idle');
    };
    const docks = async (h: Harness): Promise<DockingView> => (await api<DockingView>(h, 'GET', '/api/docking')).body;

    // alone: a name and no docks, and name@station is not an address yet
    expect(await docks(a)).toEqual({ station: 'alpha', docks: [] });
    expect((await getState(a)).docking).toEqual({ station: 'alpha', docks: [] });
    expect((await docks(b)).station).toBe('beta');
    await tell(a, 'ana', '@fake send bob@beta | hello | nobody is docked');
    expect(tools(a, 'ana', 'send_message').at(-1)).toMatchObject({ isError: true, result: { ok: false, error: 'unknown station "beta". No station is docked' } });
    expect(statSync(join(a.home, 'station.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(a.home, 'station.json'), 'utf8')).id).toMatch(/^[0-9a-f]{32}$/);

    // a code from alpha, pasted in beta; a code that is not one, and one for an address that is not beta's, are refused
    expect(await api<ApiError>(a, 'POST', '/api/docking/code', { url: `${a.base}/path` })).toMatchObject({ status: 400, body: { field: 'url' } });
    expect(await api<ApiError>(b, 'POST', '/api/docking/pair', { code: 'nonsense', url: b.base })).toMatchObject({ status: 400, body: { field: 'code' } });
    const made = await api<DockCode>(a, 'POST', '/api/docking/code', { url: a.base });
    expect(made.status).toBe(201);
    expect(made.body.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
    const paired = await api<DockView>(b, 'POST', '/api/docking/pair', { code: made.body.code, url: b.base });
    expect(paired).toMatchObject({ status: 201, body: { name: 'alpha', url: a.base } });
    // the code works once
    expect(await api<ApiError>(b, 'POST', '/api/docking/pair', { code: made.body.code, url: b.base })).toMatchObject({ status: 409, body: { code: 'conflict' } });
    await c.waitFrame((f) => f.t === 'docking' && f.docking.docks.length === 1, 5000, 'the docking frame', mark);
    const dockOfB = (await docks(a)).docks[0]!;
    expect(dockOfB).toMatchObject({ name: 'beta', url: b.base });
    // the rosters are pulled at once: each sees the agents of the other
    await waitFor(async () => (await docks(a)).docks[0]?.agents.some((agent) => agent.name === 'bob'), 15_000, 'alpha to see bob');
    await waitFor(async () => (await docks(b)).docks[0]?.agents.some((agent) => agent.name === 'ana'), 15_000, 'beta to see ana');
    expect((await docks(a)).docks[0]).toMatchObject({ status: 'ok', error: null });
    expect((await docks(a)).docks[0]?.agents.map((agent) => agent.name).sort()).toEqual(['bob', 'flight']);
    const secrets = [a, b].map((h) => {
      expect(statSync(join(h.home, 'docking.json')).mode & 0o777).toBe(0o600);
      return (JSON.parse(readFileSync(join(h.home, 'docking.json'), 'utf8')) as { docks: Array<{ secret: string }> }).docks[0]?.secret;
    });
    expect(secrets[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets[0]).toBe(secrets[1]);
    expect(JSON.stringify(await getState(a))).not.toContain(secrets[0] ?? 'no secret');
    expect(JSON.stringify(c.frames)).not.toContain(secrets[0] ?? 'no secret');

    // a message from ana reaches bob as from ana@alpha, bob's reply goes back as from bob@beta, and the hops go on
    await tell(a, 'ana', '@fake send bob@beta | hello from alpha | @fake send ana@alpha | re | pong');
    const arrived = await waitFor(async () => (await getState(b)).activity.find((item) => item.from === 'ana@alpha'), 15_000, 'the message at beta');
    expect(arrived).toMatchObject({ to: 'bob', subject: 'hello from alpha', hops: 1 });
    await itemRead(b, arrived.id);
    const back = await waitFor(async () => (await getState(a)).activity.find((item) => item.from === 'bob@beta'), 15_000, 'the reply at alpha');
    expect(back).toMatchObject({ to: 'ana', subject: 're', body: 'pong', hops: 2 });
    await itemRead(a, back.id);
    const out = (await getState(a)).activity.find((item) => item.to === 'bob@beta' && item.subject === 'hello from alpha');
    expect(out).toMatchObject({ from: 'ana', status: 'delivered', note: expect.stringContaining('accepted by beta') });
    // a name that is not an agent there comes back as a reason, and the stand-in hears it in the tool result
    await tell(a, 'ana', '@fake send nobody@beta | hello | to no one');
    await waitFor(async () => (await getState(a)).activity.find((item) => item.to === 'nobody@beta' && item.status === 'undelivered'), 15_000, 'the refusal');
    expect((await getState(a)).activity.find((item) => item.to === 'nobody@beta')?.note).toMatch(/^beta refused: unknown recipient "nobody"/);

    // a task is copied to the other board, assigned there, and done here with a mark
    const made1 = await api<Task>(a, 'POST', '/api/tasks', { title: 'Fix the build', detail: 'The CI is red.' });
    const handed = await api<Task>(a, 'POST', `/api/docking/${dockOfB.id}/handoff`, { task: made1.body.id, assignee: 'bob' });
    expect(handed).toMatchObject({ status: 200, body: { id: made1.body.id, status: 'done', handedOff: 'beta' } });
    expect(handed.body.notes.at(-1)).toMatch(/Director: handed off to bob@beta$/);
    const there = (await api<Task[]>(b, 'GET', '/api/tasks')).body;
    expect(there).toHaveLength(1);
    expect(there[0]).toMatchObject({ title: 'Fix the build', assignee: 'bob', status: 'todo', detail: `Handed off from alpha (its task ${made1.body.id}).\n\nThe CI is red.` });
    expect(there[0]?.notes[0]).toMatch(/Director of alpha: created; assigned to bob$/);
    const assigned = await waitFor(async () => (await getState(b)).activity.find((item) => item.from === 'director@alpha'), 15_000, 'the assignment at beta');
    expect(assigned).toMatchObject({ to: 'bob' });
    expect(assigned.subject).toContain('assigned to you: Fix the build');
    expect(await api<ApiError>(a, 'POST', `/api/docking/${dockOfB.id}/handoff`, { task: made1.body.id })).toMatchObject({ status: 409, body: { field: 'task' } });
    expect(await api<ApiError>(a, 'POST', `/api/docking/${dockOfB.id}/handoff`, { task: 'nope' })).toMatchObject({ status: 404, body: { field: 'task' } });
    const second = await api<Task>(a, 'POST', '/api/tasks', { title: 'Second' });
    expect(await api<ApiError>(a, 'POST', `/api/docking/${dockOfB.id}/handoff`, { task: second.body.id, assignee: 'nobody' })).toMatchObject({ status: 400, body: { code: 'bad_request', field: 'assignee' } });
    expect((await api<Task[]>(a, 'GET', '/api/tasks')).body.find((t) => t.id === second.body.id)).toMatchObject({ status: 'todo' });

    // what crosses the wire is signed: a call from beta's side, by hand
    const secret = secrets[0] ?? '';
    const call = (over: { nonce?: string; timestamp?: number; secret?: string; method?: string } = {}): Promise<Response> => {
      const timestamp = String(over.timestamp ?? Date.now());
      const nonce = over.nonce ?? randomBytes(16).toString('hex');
      const method = over.method ?? 'GET';
      return fetch(`${a.base}/dock/roster`, {
        method,
        headers: {
          'x-gonogo-station': dockOfB.id,
          'x-gonogo-timestamp': timestamp,
          'x-gonogo-nonce': nonce,
          'x-gonogo-signature': signCall(over.secret ?? secret, dockOfB.id, method, '/dock/roster', timestamp, nonce, ''),
        },
      });
    };
    const nonce = randomBytes(16).toString('hex');
    expect((await call({ nonce })).status).toBe(200);
    const replay = await call({ nonce });
    expect([replay.status, await replay.json()]).toEqual([401, { error: 'this call was made before', code: 'unauthorized' }]);
    const old = await call({ timestamp: Date.now() - 6 * 60_000 });
    expect([old.status, ((await old.json()) as ApiError).error]).toEqual([401, expect.stringContaining('more than 5 minutes')]);
    expect((await call({ timestamp: Date.now() + 6 * 60_000 })).status).toBe(401);
    expect((await call({ secret: 'ab'.repeat(32) })).status).toBe(401);
    expect((await call({ method: 'POST' })).status, 'signed as a POST, but the route is a GET').toBe(405);
    expect((await fetch(`${a.base}/dock/roster`)).status, 'unsigned').toBe(401);
    expect((await fetch(`${a.base}/dock/roster`, { headers: { authorization: `Bearer ${a.token}` } })).status, 'the browser token is not a signature').toBe(401);
    expect((await fetch(`${a.base}/dock/message`, { method: 'POST', body: '{}' })).status, 'unsigned').toBe(401);
    expect((await rawRequest(a, '/dock/roster', { Host: 'evil.example' })).status).toBe(403);
    expect((await rawRequest(a, '/dock/roster', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await rawRequest(a, '/dock/roster', { Host: `host.docker.internal:${a.run.port}` })).status).toBe(403);
    expect((await rawRequest(a, '/dock/nothing', {})).status).toBe(404);
    // an agent's token is not a station's signature either
    expect((await fetch(`${a.base}/dock/roster`, { headers: { authorization: `Bearer ${await readToken(a, 'ana')}` } })).status).toBe(401);

    // undock: gone on both sides, in the files too, and the secret no longer works
    const gone = await api<{ told: boolean }>(a, 'DELETE', `/api/docking/${dockOfB.id}`);
    expect(gone).toMatchObject({ status: 200, body: { told: true } });
    expect((await docks(a)).docks).toEqual([]);
    expect((await docks(b)).docks).toEqual([]);
    for (const h of [a, b]) expect(JSON.parse(readFileSync(join(h.home, 'docking.json'), 'utf8')).docks).toEqual([]);
    await c.waitFrame((f) => f.t === 'docking' && f.docking.docks.length === 0, 5000, 'the frame of the undock', mark);
    expect((await call()).status).toBe(401);
    await tell(b, 'bob', '@fake send ana@alpha | still there? | no');
    expect(tools(b, 'bob', 'send_message').at(-1)).toMatchObject({ isError: true, result: { ok: false, error: 'unknown station "alpha". No station is docked' } });
    expect(await api<ApiError>(a, 'DELETE', `/api/docking/${dockOfB.id}`)).toMatchObject({ status: 404 });
  }, 180_000);

  it('31. Relief: the boss asks to hire, the request waits with every parameter, only the Director\'s go hires, and the limits hold', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await waitState(h, 'flight', 'idle');
    const c = await Client.open(h);
    const mark = c.mark();
    const reliefFrames = (): ReliefView[] => c.frames.slice(mark).filter((f): f is ReliefFrame => f.t === 'relief').map((f) => f.relief);
    const tell = async (who: string, request: Record<string, unknown>): Promise<void> => {
      const sent = await send(h, who, `@fake relief hire_agent ${JSON.stringify(request)}`, 'relief');
      await itemRead(h, sent.body.id);
      await waitState(h, who, 'idle');
    };
    const asked = { name: 'guido-1', position: 'guido', dir: h.work, mode: 'acceptEdits' };

    // the boss asks: the request waits, the browsers are told, the inbox has the event, and nobody is hired
    await tell('flight', asked);
    expect(tools(h, 'flight', 'hire_agent').at(-1)).toMatchObject({ isError: false, result: { ok: true, id: 'h1', status: 'pending' } });
    await waitFor(() => reliefFrames().length === 1, 5000, 'the relief frame');
    const waiting = (await getState(h)).relief?.requests ?? [];
    expect(waiting).toEqual([expect.objectContaining({ id: 'h1', by: 'flight', name: 'guido-1', position: 'guido', dir: h.work, provider: 'claude', mode: 'acceptEdits', cleanRoom: null })]);
    expect(waiting[0]?.role).toContain('GUIDO');
    expect(await view(h, 'guido-1')).toBeUndefined();
    const inbox = (await api<DownlinkView>(h, 'GET', '/api/downlink')).body;
    expect(inbox.items.find((item) => item.type === 'event' && item.kind === 'relief')).toMatchObject({ text: `flight asks to hire guido-1 as GUIDO: claude, acceptEdits, ${h.work}`, read: false });

    // the limits: nothing above acceptEdits, no field of the tool's own beyond its six, no custom command, a free valid name, a folder that is there
    const refused = async (who: string, request: Record<string, unknown>): Promise<unknown> => {
      await tell(who, request);
      const call = tools(h, who, 'hire_agent').at(-1);
      expect(call?.isError, JSON.stringify(request)).toBe(true);
      return call?.result;
    };
    expect(await refused('flight', { ...asked, name: 'x1', mode: 'bypassPermissions' })).toMatchObject({ ok: false, error: expect.stringMatching(/default or acceptEdits at most/) });
    await refused('flight', { ...asked, name: 'x2', mode: 'auto' });
    await refused('flight', { ...asked, name: 'x3', confirmBypass: true });
    await refused('flight', { ...asked, name: 'x4', command: 'sh' });
    await refused('flight', { ...asked, name: 'x5', engine: 'custom' });
    expect(await refused('flight', { ...asked, name: 'ana' })).toMatchObject({ ok: false, error: expect.stringMatching(/exists already/) });
    expect(await refused('flight', asked)).toMatchObject({ ok: false, error: expect.stringMatching(/exists already/) });
    await refused('flight', { ...asked, name: 'Bad Name' });
    expect(await refused('flight', { ...asked, name: 'x6', dir: join(h.work, 'missing') })).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    expect(await refused('ana', { ...asked, name: 'x7' })).toMatchObject({ ok: false, error: 'only the boss can ask for a hire' });
    expect((await getState(h)).relief?.requests.map((r) => r.id)).toEqual(['h1']);

    // an agent's token cannot answer, not even the boss's for its own request; a bad id or verdict finds nothing
    const bossToken = await readToken(h, 'flight');
    expect((await api(h, 'POST', '/api/relief/h1/go', undefined, bossToken)).status).toBe(401);
    expect((await api(h, 'POST', '/api/relief/h1/go', undefined, null)).status).toBe(401);
    expect(await api<ApiError>(h, 'POST', '/api/relief/h9/go')).toMatchObject({ status: 404 });
    expect((await api(h, 'POST', '/api/relief/h1/maybe')).status).toBe(404);
    expect((await getState(h)).relief?.requests).toHaveLength(1);

    // GO: the hub staffs it as the form does (the stand-in checks the arguments of a start), and the boss is told
    const went = await api<ReliefView>(h, 'POST', '/api/relief/h1/go');
    expect([went.status, went.body.requests]).toEqual([200, []]);
    const guido = await waitState(h, 'guido-1', 'idle');
    expect(guido).toMatchObject({ name: 'guido-1', position: 'guido', dir: h.work, mode: 'acceptEdits', provider: 'claude', boss: false });
    expect((JSON.parse(readFileSync(join(h.home, 'agents.json'), 'utf8')) as RosterFile).agents.find((a) => a.name === 'guido-1')).toMatchObject({ mode: 'acceptEdits', position: 'guido' });
    const told = (await getState(h)).activity.find((item) => item.to === 'flight' && item.subject === 'Relief: guido-1 is staffed');
    expect(told).toMatchObject({ from: 'user' });
    await waitFor(() => reliefFrames().at(-1)?.requests.length === 0, 5000, 'the frame of the answer');
    expect((await api(h, 'POST', '/api/relief/h1/go')).status).toBe(404);

    // NO-GO: nobody is hired and the boss hears it
    await tell('flight', { name: 'fido-1', role: 'Reads the plan.', dir: h.work });
    expect(tools(h, 'flight', 'hire_agent').at(-1)).toMatchObject({ isError: false, result: { id: 'h2' } });
    expect((await api<ReliefView>(h, 'POST', '/api/relief/h2/no-go')).body.requests).toEqual([]);
    expect(await view(h, 'fido-1')).toBeUndefined();
    expect((await getState(h)).activity.some((item) => item.to === 'flight' && item.subject === 'Relief: request for fido-1 refused')).toBe(true);
    const events = ((await api<DownlinkView>(h, 'GET', '/api/downlink')).body.items.filter((item) => item.type === 'event' && item.kind === 'relief') as Array<{ text: string }>).map((item) => item.text);
    expect(events).toEqual(expect.arrayContaining(['guido-1 hired (asked by flight)', 'hire of fido-1 refused']));
  }, 120_000);

  it('32. Engine Bay: a model and keys reach one agent only, no page, file or log but keys.json holds a value, and rename and remove take the keys along', async () => {
    const SECRET = 'sk-e2e-secret-0001';
    const NEW_SECRET = 'sk-e2e-secret-0002';
    // the server's own environment has a value of that name too: an agent's key beats it, and one without a key still gets it
    const h = await startServer({ env: { OPENAI_API_KEY: 'host-value' } });
    await waitState(h, 'flight', 'idle');
    const valid = { name: 'ana', role: 'Reviews', dir: h.work, mode: 'default' };
    const refuse = async (changes: Record<string, unknown>, field: string): Promise<void> => {
      const response = await api<ApiError>(h, 'POST', '/api/agents', { ...valid, ...changes });
      expect(response.status, JSON.stringify(changes)).toBe(400);
      expect(response.body.field).toBe(field);
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    };
    await refuse({ model: '--dangerously' }, 'model');
    await refuse({ model: 'x', provider: 'opencode' }, 'model');
    await refuse({ keys: { PATH: SECRET } }, 'keys');
    await refuse({ keys: { OPENAI_API_KEY: `${SECRET} with a space` } }, 'keys');
    await refuse({ keys: { [SECRET]: 'x' } }, 'keys');
    expect(existsSync(join(h.home, 'keys.json')), 'a refused hire writes no key').toBe(false);

    await hire(h, 'ana', { role: valid.role, model: 'haiku', keys: { OPENAI_API_KEY: SECRET } });
    await hire(h, 'ben', { role: 'Other' });
    const [first] = starts(h, 'ana');
    expect(first?.argv).toEqual(expectedArgv(h, 'ana', valid.role, 'session-id', undefined, 'haiku'));
    expect(first).toMatchObject({ model: 'haiku', openaiKey: SECRET });
    expect(starts(h, 'ben')[0]).toMatchObject({ model: null, openaiKey: 'host-value' });
    expect((await view(h, 'ana'))).toMatchObject({ model: 'haiku', keys: { OPENAI_API_KEY: expect.any(Number) } });

    // the value is in keys.json (0600) and nowhere else of the home, and the roster and the state hold the name only
    const keysFile = join(h.home, 'keys.json');
    expect(statSync(keysFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(keysFile, 'utf8'))).toEqual({ version: 1, agents: { ana: { OPENAI_API_KEY: SECRET } } });
    expect(rosterEntry(h, 'ana')).toMatchObject({ model: 'haiku', keys: { OPENAI_API_KEY: expect.any(Number) } });
    const holders = (readdirSync(h.home, { recursive: true }) as string[]).filter((entry) => {
      const path = join(h.home, entry);
      return statSync(path).isFile() && readFileSync(path, 'utf8').includes(SECRET);
    });
    expect(holders).toEqual(['keys.json']);
    expect(JSON.stringify(await getState(h))).not.toContain(SECRET);
    const agentDir = join(h.home, 'agents', 'ana');
    for (const file of ['settings.json', 'mcp.json']) expect(readFileSync(join(agentDir, file), 'utf8')).not.toContain(SECRET);

    // an edit: the key replaced, then removed; the agent is dirty until the restart, and then sees what is left
    const changed = await api<AgentView>(h, 'PATCH', '/api/agents/ana', { keys: { OPENAI_API_KEY: NEW_SECRET } });
    expect(changed).toMatchObject({ status: 200, body: { dirty: true } });
    expect(JSON.stringify(changed.body)).not.toContain(NEW_SECRET);
    await api(h, 'POST', '/api/agents/ana/restart');
    await waitView(h, 'ana', (agent) => agent.state === 'idle' && starts(h, 'ana').length === 2, 15_000, 'ana to restart');
    expect(starts(h, 'ana')[1]).toMatchObject({ model: 'haiku', openaiKey: NEW_SECRET });
    const removedKey = await api<AgentView>(h, 'PATCH', '/api/agents/ana', { keys: { OPENAI_API_KEY: null }, model: null });
    expect(removedKey.body).toMatchObject({ model: null, keys: {}, dirty: true });
    expect('keys' in rosterEntry(h, 'ana') && 'model' in rosterEntry(h, 'ana')).toBe(false);
    await api(h, 'POST', '/api/agents/ana/restart');
    await waitView(h, 'ana', (agent) => agent.state === 'idle' && starts(h, 'ana').length === 3, 15_000, 'ana to restart again');
    expect(starts(h, 'ana')[2]).toMatchObject({ model: null, openaiKey: 'host-value' });

    // a rename moves the keys with the folder, and a remove drops them
    await api<AgentView>(h, 'PATCH', '/api/agents/ana', { keys: { OPENAI_API_KEY: SECRET } });
    await api(h, 'POST', '/api/agents/ana/stop');
    expect((await api<AgentView>(h, 'PATCH', '/api/agents/ana', { name: 'cat' })).status).toBe(200);
    expect(JSON.parse(readFileSync(keysFile, 'utf8')).agents).toEqual({ cat: { OPENAI_API_KEY: SECRET } });
    await api(h, 'POST', '/api/agents/cat/restart');
    await waitState(h, 'cat', 'idle');
    expect(starts(h, 'cat')[0]).toMatchObject({ openaiKey: SECRET });
    expect((await api(h, 'DELETE', '/api/agents/cat')).status).toBe(204);
    expect(JSON.parse(readFileSync(keysFile, 'utf8')).agents).toEqual({});
    // a new agent of that name starts with no key
    await hire(h, 'cat', { role: 'again' });
    expect(starts(h, 'cat').at(-1)).toMatchObject({ openaiKey: 'host-value' });
  }, 120_000);

  it('33. Rollout: the daily check asks the registry once with a plain GET, the state says a newer gonogo is out, the file is private, and off asks nothing', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fake = ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(JSON.stringify({ name: '@ulm0/gonogo', version: '99.1.0' })));
    }) as typeof fetch;
    const on = await startServer({ relayFetch: fake, updateCheck: true });
    const seen = await waitFor(async () => (await getState(on)).rollout?.latest, 5000, 'the registry answer in the state');
    expect(seen).toBe('99.1.0');
    expect((await getState(on)).rollout).toMatchObject({ enabled: true, latest: '99.1.0', newer: true, checkedAt: expect.any(Number) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://registry.npmjs.org/@ulm0%2Fgonogo/latest');
    expect(calls[0]?.init?.headers).toEqual({ accept: 'application/json' });
    expect(JSON.parse(readFileSync(join(on.home, 'rollout.json'), 'utf8'))).toMatchObject({ version: 1, latest: '99.1.0' });
    expect(statSync(join(on.home, 'rollout.json')).mode & 0o777).toBe(0o600);
    // the page is told when a client is connected while the check ends: the frame carries the view
    const c = await Client.open(on);
    const state = c.frames.find((f) => f.t === 'state');
    expect(state?.t === 'state' && state.state.rollout?.newer).toBe(true);

    const off = await startServer({ relayFetch: fake, updateCheck: false });
    await waitState(off, 'flight', 'idle');
    await sleep(300);
    expect(calls).toHaveLength(1);
    expect((await getState(off)).rollout).toMatchObject({ enabled: false, latest: null, newer: false });
    expect(existsSync(join(off.home, 'rollout.json'))).toBe(false);
  }, 60_000);

  it('Clean Room: a console runs through docker on its own worktree and reaches the hub by the name containers use for the host', async () => {
    const aux = await mkdtemp(join(tmpdir(), 'gonogo-'));
    try {
      const dockerLog = join(aux, 'docker.jsonl');
      const repo = join(aux, 'repo');
      await makeRepo(repo);
      const h = await startServer({ env: cleanRoomEnv(await fakeDockerBin(aux), { FAKE_DOCKER_LOG: dockerLog }) });
      const valid = { name: 'ana', role: 'Reviews', dir: join(repo, 'sub'), mode: 'default', cleanRoom: {} };
      const refuse = async (changes: Record<string, unknown>, text: RegExp): Promise<void> => {
        const response = await api<ApiError>(h, 'POST', '/api/agents', { ...valid, ...changes });
        expect(response.status, JSON.stringify(changes)).toBe(400);
        expect(response.body).toMatchObject({ field: 'cleanRoom', error: expect.stringMatching(text) });
      };
      await refuse({ dir: h.work }, /inside a git repository/);
      await refuse({ provider: 'gemini' }, /Claude Code agents only/);
      await refuse({ cleanRoom: { image: '--privileged' } }, /Docker image name/);
      expect((await getState(h)).agents.map((agent) => agent.name), 'a refused hire leaves nothing behind').toEqual(['flight']);
      expect(existsSync(join(h.home, 'cleanroom'))).toBe(false);

      await hire(h, 'ana', { dir: valid.dir, cleanRoom: {} });
      expect((await view(h, 'ana'))?.cleanRoom).toEqual({});
      expect(rosterEntry(h, 'ana')).toMatchObject({ cleanRoom: {} });
      const worktree = join(h.home, 'cleanroom', 'ana');
      expect(readFileSync(join(worktree, 'sub', 'b.txt'), 'utf8')).toBe('b\n');
      expect(execFileSync('git', ['-C', repo, 'branch', '--list', 'gonogo/ana', '--format=%(refname:short)'], { encoding: 'utf8' }).trim()).toBe('gonogo/ana');

      // what was handed to docker: the two mounts, the user, the host name, variables by name, the program after the image
      const calls = readFileSync(dockerLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { verb: string; name: string; argv: string[]; user: string; addHost: string; volumes: string[]; workdir: string; entrypoint: string; image: string; env: string[]; flags: string[]; args: string[] });
      const runs = calls.filter((call) => call.verb === 'run');
      expect(runs).toHaveLength(1);
      const [run] = runs;
      // a container of that name left by an earlier start is removed first
      expect(calls[0]).toEqual({ verb: 'rm', argv: ['-f', run?.name] });
      const agentDir = join(h.home, 'agents', 'ana');
      expect(run).toMatchObject({
        image: 'ghcr.io/ulm0/gonogo',
        user: `${process.getuid?.()}:${process.getgid?.()}`,
        addHost: 'host.docker.internal:host-gateway',
        name: expect.stringMatching(/^gonogo-ana-[0-9a-f]{12}$/),
        volumes: [`${worktree}:${worktree}`, `${worktree}/.git:${worktree}/.git:ro`, `${agentDir}:${agentDir}`],
        workdir: join(worktree, 'sub'),
        entrypoint: process.execPath,
        flags: ['--rm', '-i', '-t', '--init'],
      });
      expect(run?.env).toEqual([`HOME=${join(agentDir, 'cleanroom-home')}`, `CLAUDE_CONFIG_DIR=${join(agentDir, 'cleanroom-home')}`, 'GONOGO_TOKEN', 'TERM', 'COLORTERM', 'IS_DEMO']);
      expect(run?.args.slice(0, 2)).toEqual([FAKE, '--session-id']);
      const token = readFileSync(join(agentDir, 'token'), 'utf8').trim();
      expect(run?.argv.join('\n'), 'the agent token is not on the command line').not.toContain(token);

      // the stand-in ran "inside" with the container's view: the worktree as its folder, the files of the launcher, the name of the host
      const [first] = starts(h, 'ana');
      expect(first?.cwd).toBe(realpathSync(join(worktree, 'sub')));
      const role = first?.argv[(first?.argv.indexOf('--append-system-prompt') ?? -2) + 1] ?? '';
      expect(role).toContain(CLEAN_ROOM_NOTE.replace('{branch}', 'gonogo/ana'));
      expect(readFileSync(join(agentDir, 'settings.json'), 'utf8')).toContain('http://host.docker.internal:');

      // mail goes to it through the MCP route and its hooks come back through the hook route, both by that name
      const sent = await send(h, 'ana', 'hello from the Director');
      await itemRead(h, sent.body.id);
      expect(tools(h, 'ana', 'read_messages').length).toBeGreaterThan(0);
      await waitFor(() => hooks(h, 'ana', 'Stop').length > 0, 5000, 'the Stop hook in the stand-in log');
      expect(hooks(h, 'ana').every((hook) => hook.status === 200), 'no hook was refused').toBe(true);

      // the browser routes still refuse that name
      const strict = await rawRequest(h, '/api/state', { Host: `host.docker.internal:${h.run.port}`, Authorization: `Bearer ${h.token}` });
      expect(strict).toMatchObject({ status: 403, body: 'forbidden host' });

      // a stop ends the docker process; its container is removed by name, since docker passes no signal on with -t
      expect((await api<AgentView>(h, 'POST', '/api/agents/ana/stop')).status).toBe(200);
      await waitFor(() => readFileSync(dockerLog, 'utf8').trim().split('\n').length === 3, 5000, 'the docker rm after the stop');
      expect(JSON.parse(readFileSync(dockerLog, 'utf8').trim().split('\n')[2] ?? '{}')).toEqual({ verb: 'rm', argv: ['-f', run?.name] });
    } finally {
      await rm(aux, { recursive: true, force: true });
    }
  }, 60_000);

  it('Worktree: a console starts in its own git worktree on the host, Hangar opens it, and a remove can delete it', async () => {
    const aux = await mkdtemp(join(tmpdir(), 'gonogo-'));
    try {
      const repo = join(aux, 'repo');
      await makeRepo(repo);
      const h = await startServer({ env: cleanRoomEnv(await fakeDockerBin(aux)) });
      const refuse = async (changes: Record<string, unknown>, text: RegExp): Promise<void> => {
        const response = await api<ApiError>(h, 'POST', '/api/agents', { name: 'ana', role: 'Reviews', dir: join(repo, 'sub'), mode: 'default', worktree: {}, ...changes });
        expect(response.status, JSON.stringify(changes)).toBe(400);
        expect(response.body).toMatchObject({ field: 'worktree', error: expect.stringMatching(text) });
      };
      await refuse({ dir: h.work }, /inside a git repository/);
      await refuse({ cleanRoom: {} }, /worktree already/);
      expect(existsSync(join(h.home, 'worktrees'))).toBe(false);

      await hire(h, 'ana', { dir: join(repo, 'sub'), worktree: {} });
      expect((await view(h, 'ana'))?.worktree).toEqual({});
      expect(rosterEntry(h, 'ana')).toMatchObject({ worktree: {} });
      const worktree = join(h.home, 'worktrees', 'ana');
      expect(readFileSync(join(worktree, 'sub', 'b.txt'), 'utf8')).toBe('b\n');
      const [first] = starts(h, 'ana');
      expect(first?.cwd).toBe(realpathSync(join(worktree, 'sub')));
      const role = first?.argv[(first?.argv.indexOf('--append-system-prompt') ?? -2) + 1] ?? '';
      expect(role).toContain(WORKTREE_NOTE.replace('{branch}', 'gonogo/ana'));

      // Hangar opens the worktree, not the main folder
      writeFileSync(join(worktree, 'sub', 'only-here.txt'), 'x');
      const listed = await api<{ entries: Array<{ name: string }> }>(h, 'GET', '/api/agents/ana/files');
      expect(listed.body.entries.map((entry) => entry.name)).toContain('sub');
      const sub = await api<{ entries: Array<{ name: string }> }>(h, 'GET', '/api/agents/ana/files?path=sub');
      expect(sub.body.entries.map((entry) => entry.name)).toContain('only-here.txt');

      // the status, then a remove that keeps and a remove that deletes (git refuses the unsaved file)
      expect((await api(h, 'GET', '/api/agents/flight/worktree')).status).toBe(404);
      expect((await api(h, 'GET', '/api/agents/ana/worktree')).body).toMatchObject({ path: worktree, branch: 'gonogo/ana', exists: true, dirty: true, ahead: 0 });
      expect((await api(h, 'DELETE', '/api/agents/ana?worktree=maybe')).status).toBe(400);
      const refused = await api<{ worktree: { removed: boolean; reason: string } }>(h, 'DELETE', '/api/agents/ana?worktree=delete');
      expect(refused).toMatchObject({ status: 200, body: { worktree: { removed: false } } });
      expect(existsSync(join(worktree, 'sub', 'only-here.txt'))).toBe(true);
      expect(await view(h, 'ana'), 'the console is removed all the same').toBeUndefined();
    } finally {
      await rm(aux, { recursive: true, force: true });
    }
  }, 60_000);
  it('Phone approvals: a permission goes to Telegram with signed buttons, a press types Enter once, and a late press is refused', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const relayFetch: typeof fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, result: { message_id: 40 + posts.length, chat: { id: 555 } } });
    };
    const h = await startServer({ relayFetch });
    await waitState(h, 'flight', 'idle');
    const TOKEN = '123456789:AAFabcdefghijklmnopqrstuvwxyz012345';
    const urlOf = (method: string): string => `https://api.telegram.org/bot${TOKEN}/${method}`;
    expect((await api(h, 'PUT', '/api/relay/telegram', { token: TOKEN, to: '555' })).status).toBe(200);
    const uplink = (await api<UplinkCreated>(h, 'POST', '/api/uplinks', { name: 'Telegram', to: 'flight', kind: 'telegram' })).body;
    expect((await api(h, 'PUT', '/api/relay/phone', { mode: 'sideways' })).status).toBe(400);

    // off (the default): nothing is sent
    const c = await Client.open(h);
    await c.attach('flight');
    c.typeLine('flight', '@fake permission Bash 2000');
    await waitState(h, 'flight', 'needs_you', 10_000);
    expect(posts.filter((post) => post.url.endsWith('/sendMessage'))).toEqual([]);
    expect((await api(h, 'POST', '/api/agents/flight/answer', { go: true })).status).toBe(200);
    await waitState(h, 'flight', 'idle', 15_000);

    // telegram: the next dialog is sent with two buttons
    expect((await api<{ phone: string }>(h, 'PUT', '/api/relay/phone', { mode: 'telegram' })).body.phone).toBe('telegram');
    const press = (data: string, id = 'q1', chat = 555): Promise<Response> =>
      fetch(`${h.base}/uplink/${uplink.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': uplink.secret },
        body: JSON.stringify({ callback_query: { id, data, message: { message_id: 41, chat: { id: chat } } } }),
      });
    c.typeLine('flight', '@fake permission Bash 2000');
    await waitState(h, 'flight', 'needs_you', 10_000);
    await waitFor(() => posts.some((post) => post.url.endsWith('/sendMessage') && post.body.reply_markup !== undefined), 5000, 'the message with buttons');
    const sent = posts.find((post) => post.url.endsWith('/sendMessage') && post.body.reply_markup !== undefined);
    expect(sent?.url).toBe(urlOf('sendMessage'));
    expect(String(sent?.body.text)).toMatch(/^flight asks: Bash/);
    const buttons = (sent?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard[0] ?? [];
    expect(buttons.map((b) => b.text)).toEqual(['GO', 'NO-GO']);
    const go = buttons[0]?.callback_data ?? '';

    // a press from another chat is not for the agents, a bad tag is refused on Telegram, and the dialog is still open
    expect(await (await press(go, 'q0', 556)).json()).toEqual({ ok: true, ignored: true });
    expect((await press(go.replace(/.$/, (ch) => (ch === '0' ? '1' : '0')), 'q1')).status).toBe(200);
    await waitFor(() => posts.some((post) => post.url.endsWith('/answerCallbackQuery') && post.body.text === 'Invalid button'), 5000, 'the refusal on Telegram');
    expect((await getState(h)).agents.find((a) => a.name === 'flight')?.state).toBe('needs_you');

    // the right press types Enter: the tool runs, and the buttons are taken off
    expect((await press(go, 'q2')).status).toBe(200);
    await waitState(h, 'flight', 'idle', 15_000);
    await waitFor(() => posts.some((post) => post.url.endsWith('/editMessageReplyMarkup')), 5000, 'the buttons taken off');
    expect(posts.some((post) => post.url.endsWith('/answerCallbackQuery') && post.body.text === 'Sent GO')).toBe(true);
    expect(logOf<FakeEvent & { action: string }>(h, 'flight', 'dialog').map((event) => event.action)).toEqual(['shown', 'allowed', 'shown', 'allowed']);

    // the same button again is late: nothing is typed
    expect((await press(go, 'q3')).status).toBe(200);
    await waitFor(() => posts.some((post) => post.url.endsWith('/answerCallbackQuery') && post.body.text === 'Too late: already answered'), 5000, 'too late');
    expect(logOf<FakeEvent & { action: string }>(h, 'flight', 'dialog').map((event) => event.action)).toHaveLength(4);
  }, 90_000);

  it('Tool permissions: the room\'s rules and an agent\'s own reach its settings.json, a bad rule is a 400, and another engine says it is not supported', async () => {
    const h = await startServer();
    await waitState(h, 'flight', 'idle');
    const settings = (name: string): { permissions: { allow: string[]; deny: string[]; ask?: string[] } } => JSON.parse(readFileSync(join(h.home, 'agents', name, 'settings.json'), 'utf8')) as never;
    expect((await api(h, 'GET', '/api/permissions')).body).toEqual({ permissions: {} });
    expect((await api<ApiError>(h, 'PUT', '/api/permissions', { allow: ['rm -rf /'] }))).toMatchObject({ status: 400, body: { field: 'permissions' } });
    expect((await api(h, 'PUT', '/api/permissions', { allow: ['Glob'], ask: ['Write'] })).body).toEqual({ permissions: { allow: ['Glob'], ask: ['Write'] } });
    expect(JSON.parse(readFileSync(join(h.home, 'permissions.json'), 'utf8'))).toEqual({ version: 1, permissions: { allow: ['Glob'], ask: ['Write'] } });

    // an agent without rules of its own gets the room's, with gonogo's own denials kept
    await hire(h, 'ana');
    expect(settings('ana').permissions).toMatchObject({ allow: expect.arrayContaining(['Glob']), ask: ['Write'], deny: ['SendMessage', 'ListAgents'] });
    // one with its own rules gets those and not the room's
    expect((await api<AgentView>(h, 'POST', '/api/agents', { name: 'ben', role: 'x', dir: h.work, mode: 'default', permissions: { allow: ['Bash(git:*)'], deny: ['WebFetch'] } })).status).toBe(201);
    await waitState(h, 'ben', 'idle');
    expect(settings('ben').permissions.allow).toContain('Bash(git:*)');
    expect(settings('ben').permissions.allow).not.toContain('Glob');
    expect(settings('ben').permissions.deny).toEqual(['SendMessage', 'ListAgents', 'WebFetch']);
    expect(rosterEntry(h, 'ben')).toMatchObject({ permissions: { allow: ['Bash(git:*)'], deny: ['WebFetch'] } });

    const refused = await api<ApiError>(h, 'POST', '/api/agents', { name: 'cy', role: 'x', dir: h.work, mode: 'default', provider: 'gemini', permissions: { allow: ['Bash'] } });
    expect(refused).toMatchObject({ status: 400, body: { field: 'permissions', error: expect.stringContaining('not supported for Gemini CLI') } });
    expect((await api<ApiError>(h, 'PATCH', '/api/agents/ben', { permissions: 'Bash' })).status).toBe(400);
  }, 60_000);

  it('34. Mass Budget and Star Chart: a request to condense is a message, the file is copied and never written by gonogo, and the chart follows the log', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    const memory = join(h.home, 'agents', 'ana', 'memory.md');
    const notes = readFileSync(memory, 'utf8');
    expect((await api(h, 'GET', '/api/agents/ana/memory')).body).toMatchObject({ exists: true, bytes: Buffer.byteLength(notes), lines: 3, over: false, backup: null });

    // the request is a message from the Director that the agent reads like any other; the copy is private and the file is as it was
    const asked = await api<ReflectResult>(h, 'POST', '/api/agents/ana/reflect');
    expect(asked).toMatchObject({ status: 201, body: { send: { ok: true, to: 'ana' }, memory: { backup: { bytes: Buffer.byteLength(notes) } } } });
    await itemRead(h, asked.body.send.id);
    expect(tools(h, 'ana', 'read_messages').at(-1)?.result).toMatchObject({ messages: [{ from: 'user', subject: 'Mass Budget: condense your memory file', body: expect.stringContaining(memory) }] });
    expect(readFileSync(`${memory}.bak`, 'utf8')).toBe(notes);
    expect(statSync(`${memory}.bak`).mode & 0o777).toBe(0o600);
    expect(readFileSync(memory, 'utf8')).toBe(notes);

    // a stopped agent is not asked, and its older copy stays
    await api(h, 'POST', '/api/agents/ana/stop');
    await waitState(h, 'ana', 'stopped');
    expect((await api<ReflectResult>(h, 'POST', '/api/agents/ana/reflect')).body).toMatchObject({ send: { ok: false, status: 'undelivered' } });
    expect(readFileSync(`${memory}.bak`, 'utf8')).toBe(notes);
    expect(readdirSync(join(h.home, 'agents', 'ana')).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // the routes are the browser's, for a name that is an agent
    expect((await rawRequest(h, '/api/agents/ana/memory', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await api(h, 'GET', '/api/agents/ghost/memory')).status).toBe(404);
    expect((await api(h, 'POST', '/api/agents/Bad Name/reflect')).status).toBe(404);
    expect((await api(h, 'GET', '/api/agents/ana/reflect')).status).toBe(405);

    // the chart: entries, tags, authors and the ids that entries name, from the same log
    await api(h, 'POST', '/api/log', { title: 'Cache key', body: 'The key has the node version.', tags: ['build', 'cache'] });
    await api(h, 'POST', '/api/log', { title: 'Cache miss', body: 'Follows l1.', tags: ['build', 'cache'] });
    const chart = (await api<LogChart>(h, 'GET', '/api/log/chart')).body;
    expect(chart).toMatchObject({ total: 2, shown: 2 });
    expect(chart.nodes.map((n) => n.id).sort()).toEqual(['author:user', 'entry:l1', 'entry:l2', 'tag:build', 'tag:cache']);
    expect(chart.edges.filter((e) => e.kind === 'mention')).toEqual([{ from: 'entry:l2', to: 'entry:l1', kind: 'mention', weight: 1 }]);
    expect(chart.edges.filter((e) => e.kind === 'cooccur')).toEqual([{ from: 'tag:build', to: 'tag:cache', kind: 'cooccur', weight: 2 }]);
    expect((await rawRequest(h, '/api/log/chart', { Authorization: 'Bearer nope' })).status).toBe(401);
  }, 60_000);

  it('35. Plot Board: every agent reads one plan, only the boss and the Director write it, a write names the revision it read, and the file is private', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await waitState(h, 'flight', 'idle');
    const tell = async (name: string, line: string): Promise<void> => {
      const sent = await send(h, name, `@fake board ${line}`, 'board');
      await itemRead(h, sent.body.id);
      await waitState(h, name, 'idle');
    };

    // an agent that is not the boss reads it and is refused when it writes
    expect((await api<BoardView>(h, 'GET', '/api/board')).body).toEqual({ text: '', revision: 0, author: null, updatedAt: null });
    await tell('ana', 'board_read {}');
    expect(tools(h, 'ana', 'board_read').at(-1)).toMatchObject({ isError: false, result: { ok: true, text: '', revision: 0, canWrite: false } });
    await tell('ana', 'board_write {"text":"ana takes over","revision":0}');
    expect(tools(h, 'ana', 'board_write').at(-1)).toMatchObject({ isError: true, result: { ok: false, error: 'only the boss may write the Plot Board' } });
    expect((await api<BoardView>(h, 'GET', '/api/board')).body.revision).toBe(0);

    // the boss writes it, and the author is its own name
    await tell('flight', 'board_read {}');
    expect(tools(h, 'flight', 'board_read').at(-1)).toMatchObject({ result: { canWrite: true } });
    await tell('flight', 'board_write {"text":"# Plan\\n\\n1. ship the audit log","revision":0,"author":"user"}');
    expect(tools(h, 'flight', 'board_write').at(-1)).toMatchObject({ isError: false, result: { ok: true, revision: 1 } });
    expect((await api<BoardView>(h, 'GET', '/api/board')).body).toMatchObject({ text: '# Plan\n\n1. ship the audit log', revision: 1, author: 'flight' });

    // every agent sees it
    await tell('ana', 'board_read {}');
    expect(tools(h, 'ana', 'board_read').at(-1)).toMatchObject({ result: { text: '# Plan\n\n1. ship the audit log', revision: 1, author: 'flight', canWrite: false } });

    // the Director edits it from the page: a stale revision is a 409 and changes nothing
    expect(await api<ApiError>(h, 'PUT', '/api/board', { text: 'late', revision: 0 })).toMatchObject({ status: 409, body: { code: 'conflict', field: 'revision' } });
    expect(await api<ApiError>(h, 'PUT', '/api/board', { text: 'x'.repeat(10_001), revision: 1 })).toMatchObject({ status: 400, body: { field: 'text' } });
    expect(await api<BoardView>(h, 'PUT', '/api/board', { text: '# Plan\n\n1. ship the audit log\n2. then the board', revision: 1 })).toMatchObject({ status: 200, body: { revision: 2, author: 'user' } });

    // the boss that wrote from the revision it read before the Director's edit is refused, and told to read again
    await tell('flight', 'board_write {"text":"overwrite","revision":1}');
    expect(tools(h, 'flight', 'board_write').at(-1)).toMatchObject({ isError: true, result: { ok: false, error: expect.stringMatching(/revision 2, not 1: read it again/) } });
    expect((await api<BoardView>(h, 'GET', '/api/board')).body.text).toBe('# Plan\n\n1. ship the audit log\n2. then the board');

    // the browser token is the only key to the route, and the file is private with a version
    expect((await rawRequest(h, '/api/board', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect(statSync(join(h.home, 'board.md')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(h.home, 'board.md'), 'utf8')).toMatch(/^---\nversion: 1\nrevision: 2\nauthor: "user"\nupdatedAt: "[^"]+"\n---\n# Plan\n\n1\. ship the audit log\n2\. then the board\n$/);
  }, 90_000);

  it('36. Black Box: what happens in the room is recorded as names and ids, the server commits it to a git repository of its own, and a restart goes on from it', async () => {
    const h = await startServer();
    await hire(h, 'ana');
    await waitState(h, 'flight', 'idle');
    const secret = 'topsecret-value-1234567890';
    const events = async (): Promise<AuditView> => (await api<AuditView>(h, 'GET', '/api/black-box')).body;

    // the Director's calls, an agent's task, a poll that is held, an uplink with a secret, the boss's plan
    expect((await api(h, 'POST', '/api/agents', { name: 'ben', role: `ben keeps ${secret} to himself`, dir: h.work, mode: 'default', command: undefined })).status).toBe(201);
    await waitState(h, 'ben', 'idle');
    await api(h, 'PATCH', '/api/agents/ben', { role: `ben keeps ${secret} still` });
    const tell = async (name: string, line: string): Promise<void> => {
      const sent = await send(h, name, line, 'audit');
      await itemRead(h, sent.body.id);
      await waitState(h, name, 'idle');
    };
    await tell('ana', `@fake task task_create {"title":"Write ${secret}","detail":"${secret}"}`);
    await tell('flight', `@fake board board_write {"text":"plan ${secret}","revision":0}`);
    expect((await api(h, 'POST', '/api/poll')).status).toBe(201);
    expect((await api(h, 'POST', '/api/poll/hold')).status).toBe(200);
    const made = await api<UplinkCreated>(h, 'POST', '/api/uplinks', { name: 'GitHub', to: 'ana' });
    const delivery = await fetch(`${h.base}/uplink/u1`, { method: 'POST', headers: { authorization: `Bearer ${made.body.secret}` }, body: `{"text":"${secret}"}` });
    expect(delivery.status).toBe(202);
    expect((await api(h, 'POST', '/api/agents/ben/stop')).status).toBe(200);

    const seen = (await events()).events.map((e) => `${e.kind}: ${e.text}`);
    const wanted = [
      /^audit: gonogo \S+ started$/,
      /^crew: Director hired ana$/,
      /^crew: Director hired ben$/,
      /^config: Director edited ben: role$/,
      /^plan: ana created task t1$/,
      /^plan: flight wrote the Plot Board: revision 1, \d+ characters$/,
      /^poll: Director started a T-minus poll$/,
      /^poll: Director held the poll$/,
      /^poll: T-minus poll HOLD: held by the Director$/,
      /^config: Director made an uplink u1$/,
      /^uplink: Uplink u1 delivered message m\d+$/,
      /^crew: Director stopped ben$/,
    ];
    for (const pattern of wanted) expect(seen.some((line) => pattern.test(line)), `${pattern} in ${JSON.stringify(seen)}`).toBe(true);
    // no text of a task, a role, a plan, a message or an uplink, and no secret of any
    expect(JSON.stringify(await events())).not.toContain(secret);
    expect(JSON.stringify(await events())).not.toContain(made.body.secret);
    expect((await events())).toMatchObject({ git: 'ok', note: '', dir: join(h.home, 'black-box') });
    expect((await events()).command).toBe(`git -C '${join(h.home, 'black-box')}' log -p`);
    expect((await rawRequest(h, '/api/black-box', { Authorization: 'Bearer nope' })).status).toBe(401);

    // after a stop the repository holds the events, committed by gonogo and by nobody else, and the files are private
    await h.run.stop();
    const repo = join(h.home, 'black-box');
    expect(statSync(repo).mode & 0o777).toBe(0o700);
    const day = readdirSync(repo).find((name) => name.endsWith('.jsonl')) ?? '';
    expect(statSync(join(repo, day)).mode & 0o777).toBe(0o600);
    const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    expect(git('status', '--porcelain')).toBe('');
    expect(git('log', '--format=%an <%ae>').split('\n').every((line) => line === 'gonogo <gonogo@localhost>')).toBe(true);
    const committed = git('show', `HEAD:${day}`).split('\n').map((line) => JSON.parse(line) as { text: string });
    expect(committed.map((e) => e.text)).toContain('gonogo stopped');
    expect(committed.map((e) => e.text)).toContain('Director hired ana');
    expect(git('log', '-p')).not.toContain(secret);

    // a second start on the same home goes on with the same repository, and lists what the first one wrote
    const again = await startServer({ home: h.home });
    const list = (await api<AuditView>(again, 'GET', '/api/black-box')).body;
    expect(list.git).toBe('ok');
    expect(list.events.map((e) => e.text)).toContain('Director hired ana');
    expect(list.events[0]?.text).toMatch(/^gonogo \S+ started$/);
    await again.run.stop();
  }, 120_000);

  it('37. Black Box without git: the room works, the page says git was not found, and the events are still written', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'gonogo-nogit-'));
    try {
      const h = await startServer({ env: { PATH: empty } });
      await hire(h, 'ana');
      const list = (await api<AuditView>(h, 'GET', '/api/black-box')).body;
      expect(list).toMatchObject({ git: 'missing', note: 'git was not found on the PATH' });
      expect(list.events.map((e) => e.text)).toContain('Director hired ana');
      expect(existsSync(join(h.home, 'black-box', '.git'))).toBe(false);
      await h.run.stop();
      const day = readdirSync(join(h.home, 'black-box')).find((name) => name.endsWith('.jsonl')) ?? '';
      expect(readFileSync(join(h.home, 'black-box', day), 'utf8')).toContain('Director hired ana');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }, 60_000);

  it('38. Live reload: a new server takes over the running agents, a turn in progress finishes, a hold stays, the old tokens still work, and a stop ends the host', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gng-rl-'));
    const host: PtyHost = await startPtyHost({ homeDir: home });
    try {
      const first = await startServer({ home, ptyHost: true });
      await hire(first, 'ana');
      await hire(first, 'ben');
      // ana is in the middle of a turn; ben is on hold
      await send(first, 'ana', '@fake sleep 2500\n@fake say finished-after-reload', 'long');
      await waitState(first, 'ana', 'working');
      expect((await api(first, 'POST', '/api/agents/ben/hold')).status).toBe(200);
      const before = await view(first, 'ana');
      const pidBefore = (await api<{ agents: Array<{ name: string; pid: number | null }> }>(first, 'GET', '/api/state')).body.agents.find((a) => a.name === 'ana')?.pid ?? null;

      const port = first.run.port;
      await first.run.release(); // what gonogo reload does to the old server: it ends, the agents stay
      const second = await startServer({ home, ptyHost: true, port }); // the same port: the agents' hook and MCP URLs name it
      expect(await view(second, 'ana')).toMatchObject({ state: 'working', generation: before?.generation });
      expect(await view(second, 'ben')).toMatchObject({ state: 'needs_you', needsKind: 'redline' });
      const pidAfter = (await api<{ agents: Array<{ name: string; pid: number | null }> }>(second, 'GET', '/api/state')).body.agents.find((a) => a.name === 'ana')?.pid ?? null;
      expect(pidAfter, 'the same process, not a new one').toBe(pidBefore);

      // the turn that began under the old server ends under the new one: its Stop hook is accepted with the saved token
      await waitState(second, 'ana', 'idle', 20_000);
      // mail to the held agent waits; mail to ana is read through the MCP tool with the same token
      const held = await send(second, 'ben', 'for the held one');
      expect(held.body).toMatchObject({ status: 'held' });
      const sent = await send(second, 'ana', 'after the reload');
      await waitItem(second, sent.body.id, (item) => item.status === 'read', 15_000, 'to be read');
      // the stand-in of ana is the process of the first server: its log is where its prompts are
      expect(prompts(first, 'ana').filter((text) => text.includes('read_messages')).length).toBeGreaterThanOrEqual(1);
      // the files that carry the state are private
      for (const file of ['hub-state.json', 'tokens.json', 'ptyhost.key', 'ptyhost.sock']) expect(statSync(join(home, 'run', file)).mode & 0o777).toBe(0o600);
      const token = readFileSync(join(home, 'agents', 'ana', 'token'), 'utf8').trim();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(join(home, 'run', 'tokens.json'), 'utf8'), 'the hash is saved, never the token').not.toContain(token);

      // an ordinary stop ends the agents and the host
      await second.run.stop();
      await waitFor(() => !existsSync(join(home, 'run', 'ptyhost.sock')), 8000, 'the pty host to be gone');
    } finally {
      await host.close(true).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  }, 90_000);
});
