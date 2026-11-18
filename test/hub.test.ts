/**
 * Unit tests of the hub (contract 10.1). The hub runs against a fake HubIo: a fake clock whose timers the test fires, scripted
 * screen and title probes, a fake terminal host that delivers exit events the way the real one does, and recorders for
 * everything the hub writes (frames, log lines, roster saves, typed pointers, spawn and stop calls). Nothing here touches the
 * file system, the network or a real timer.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { classifyInput, createHub, describeDoing, describePermission, HubError, pointerText } from '../src/server/hub.js';
import {
  ACTIVITY_HUB_MAX,
  ACTIVITY_WIRE_BODY_CHARS,
  BODY_MAX_CHARS,
  BOSS_ROLE,
  COMMAND_MAX_CHARS,
  CUSTOM_ACTIVE_MS,
  CUSTOM_START_MS,
  DELIVERY_COALESCE_MS,
  DELIVERY_SETTLE_MS,
  DRAFT_EXPIRY_MS,
  DRAFT_SCREEN_CLEAR_MS,
  MAILBOX_MAX_BODY_CHARS,
  MAILBOX_MAX_MESSAGES,
  MAX_AGENTS,
  MAX_STOP_BLOCKS,
  METER_INTERVAL_MS,
  NEEDS_YOU_CLEAR_MS,
  POLL_REASON_MAX_CHARS,
  PROMPT_SUBMIT_CONFIRM_MS,
  READ_MAX_CHARS,
  READ_MAX_MESSAGES,
  RECONCILE_TICK_MS,
  REDLINE_API_ERRORS,
  REDLINE_REPEATS,
  REDLINE_SENDS_TO_ONE,
  REDLINE_TOOL_FAILURES,
  SCREEN_DIALOG_REASON,
  SEND_RATE_MAX,
  SEND_RATE_WINDOW_MS,
  SUBJECT_MAX_CHARS,
  SESSION_FLIP_WINDOW_MS,
  SESSION_IN_USE_TEXT,
  SESSION_MISSING_TEXT,
  STARTUP_DIALOG_REASON,
  STARTUP_READY_TIMEOUT_MS,
  STARTUP_RECHECK_MS,
  TITLE_IDLE_RECONCILE_MS,
  TITLE_WORKING_CONFIRM_MS,
} from '../src/server/constants.js';
import type {
  ActivityItem,
  AgentRecord,
  AgentView,
  AnswerRequest,
  ApiErrorCode,
  DockedAgent,
  EditRequest,
  ExitInfo,
  HookEvent,
  HireRequest,
  HookPayload,
  HookReply,
  Hub,
  HubEvent,
  HubIo,
  GovernorRequest,
  InputEffect,
  Logger,
  MessageRecord,
  PermissionMode,
  Provider,
  ReadMessagesResult,
  RosterFile,
  RunEntry,
  StartupSettings,
  ScreenProbe,
  SendResult,
  SessionFlag,
  SpawnRequest,
  StationMessage,
  TitleGlyph,
  TitleInfo,
} from '../src/shared/protocol.js';
import { DOING_MAX_CHARS, HISTORY_MAX, HISTORY_WINDOW_MS, HOLD_REASON } from '../src/shared/protocol.js';

/* ------------------------------------------------------------------------------------------------------------
 * The fake world
 * ---------------------------------------------------------------------------------------------------------- */

const T0 = 1_700_000_000_000;
const OPEN_BOX: ScreenProbe = { cols: 120, rows: 40, promptBox: true, dialog: null, promptText: '' };
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Gate {
  promise: Promise<void>;
  open(): void;
}
function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeTimer {
  id: number;
  fn: () => void;
  due: number;
  live: boolean;
}

/** What a test may script. A gate is used once: the next call that reaches it waits for it. */
interface Script {
  typeResult: boolean;
  pressResult: boolean;
  saveError: string | null;
  saveGate: Gate | null;
  dirGate: Gate | null;
  spawnGate: Gate | null;
  spawnError: string | null;
  stopGate: Gate | null;
  afterStopGate: Gate | null;
  stopExits: boolean;
  renameGate: Gate | null;
  renameError: string | null;
  forgetError: string | null;
  missingDirs: Set<string>;
  /** What the fake Clean Room check answers: null is a working Docker and a repository, text is the reason it is not. */
  cleanRoomProblem: string | null;
  /** The flag the fake launcher picks when the hub does not force one. */
  flag: SessionFlag;
}

interface Harness {
  hub: Hub;
  io: HubIo;
  script: Script;
  events: HubEvent[];
  logged: MessageRecord[];
  saves: RosterFile[];
  typed: Array<{ name: string; generation: number; text: string }>;
  pressed: Array<{ name: string; generation: number; data: string }>;
  metered: Array<{ name: string; generation: number; transcriptPath: string }>;
  /** What the hub told the Downlink: kind and text. */
  notices: Array<[string, string]>;
  spawns: SpawnRequest[];
  /** The directories the hub asked the Clean Room check about. */
  cleanRoomChecks: string[];
  stops: Array<{ name: string; generation: number }>;
  renames: Array<[string, string]>;
  /** Names the hub asked the terminal host to forget, in order. */
  forgotten: string[];
  warnings: string[];
  now(): number;
  /** Timers that are armed and have not fired. */
  pendingTimers(): number;
  advance(ms: number): Promise<void>;
  alignToTick(msBefore: number): Promise<void>;
  boot(): Promise<void>;
  hire(name: string, mode?: PermissionMode): Promise<AgentView>;
  hireRaw(name: string, mode?: PermissionMode): Promise<AgentView>;
  ready(name: string): void;
  gen(name: string): number;
  view(name: string): AgentView;
  hook(name: string, event: HookEvent, payload?: HookPayload): HookReply;
  work(name: string): void;
  /** A UserPromptSubmit hook, then the working glyph (a turn is running). */
  prompt(name: string, text: string, extra?: HookPayload): HookReply;
  type(name: string, data: string): InputEffect;
  send(from: string, to: string, body?: string, subject?: string): SendResult;
  read(name: string): ReadMessagesResult;
  exit(name: string, info?: Partial<ExitInfo>): void;
  setScreen(name: string, probe: Partial<ScreenProbe> | null): void;
  setTitle(name: string, glyph: TitleGlyph | null, since?: number): void;
  setOutput(name: string, bytes: number): void;
  frames(name: string): AgentView[];
  items(id: string): ActivityItem[];
  msg(id: string): ActivityItem;
  /** Types the pointer into `name` (waits for the coalescing delay) and returns the text. */
  pointerTyped(name: string): Promise<string>;
}

interface HarnessOptions {
  maxHops?: number;
  roster?: AgentRecord[];
  history?: MessageRecord[];
  maxWorking?: number | null;
  redline?: boolean;
  /** Live reload: what kept running in the pty host. */
  adoptable?: HubIo['adoptable'];
  saveHolds?: HubIo['saveHolds'];
  /** Autostart: the room's policy, the set the last run left, and where the hub writes the set (the fakes of runstate.ts). */
  startup?: StartupSettings;
  runSet?: RunEntry[] | null;
  marks?: Array<[string, boolean, boolean]>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  let now = T0;
  let messageSeq = 0;
  let sessionSeq = 0;
  let timerSeq = 0;
  let roster: AgentRecord[] = (options.roster ?? []).map((record) => ({ ...record }));
  let saveChain: Promise<void> = Promise.resolve();
  const history = (options.history ?? []).map((record) => ({ ...record }));
  const timers: FakeTimer[] = [];
  const live = new Map<string, number>();
  const events: HubEvent[] = [];
  const logged: MessageRecord[] = [];
  const saves: RosterFile[] = [];
  const typed: Array<{ name: string; generation: number; text: string }> = [];
  const pressed: Array<{ name: string; generation: number; data: string }> = [];
  const metered: Array<{ name: string; generation: number; transcriptPath: string }> = [];
  const notices: Array<[string, string]> = [];
  const spawns: SpawnRequest[] = [];
  const cleanRoomChecks: string[] = [];
  const stops: Array<{ name: string; generation: number }> = [];
  const renames: Array<[string, string]> = [];
  const forgotten: string[] = [];
  const warnings: string[] = [];
  const screens = new Map<string, ScreenProbe | null>();
  const titles = new Map<string, TitleInfo | null>();
  const output = new Map<string, number>();
  const script: Script = {
    typeResult: true,
    pressResult: true,
    saveError: null,
    saveGate: null,
    dirGate: null,
    spawnGate: null,
    spawnError: null,
    stopGate: null,
    afterStopGate: null,
    stopExits: true,
    renameGate: null,
    renameError: null,
    forgetError: null,
    missingDirs: new Set(),
    cleanRoomProblem: null,
    flag: 'session-id',
  };
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (message) => void warnings.push(message),
    error: (message) => void warnings.push(`error: ${message}`),
    child: () => logger,
  };
  // The hub is created below; the fake terminal host needs it to deliver exit events.
  let hub: Hub;

  const takeGate = (
    name: 'saveGate' | 'dirGate' | 'spawnGate' | 'stopGate' | 'afterStopGate' | 'renameGate',
  ): Gate | null => {
    const taken = script[name];
    script[name] = null;
    return taken;
  };

  const io: HubIo = {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { id: (timerSeq += 1), fn, due: now + ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as FakeTimer).live = false;
    },
    newMessageId: () => `m${(messageSeq += 1)}`,
    newSessionId: () => `00000000-0000-4000-8000-${String((sessionSeq += 1)).padStart(12, '0')}`,
    checkDirectory: async (path) => {
      const hold = takeGate('dirGate');
      if (hold) await hold.promise;
      if (!path.startsWith('/')) return { ok: false, error: 'directory must be an absolute path' };
      if (script.missingDirs.has(path)) return { ok: false, error: `directory does not exist: ${path}` };
      return { ok: true, path: path.replace(/\/+$/, '') };
    },
    checkCleanRoom: async (dir) => {
      cleanRoomChecks.push(dir);
      return script.cleanRoomProblem;
    },
    loadRoster: async () => ({ version: 1, agents: roster.map((record) => ({ ...record })) }),
    // Like Home.saveRoster: calls run one after the other in call order, so the last call wins.
    saveRoster: (file) => {
      const snapshot = JSON.parse(JSON.stringify(file)) as RosterFile;
      const run = saveChain.then(async () => {
        const hold = takeGate('saveGate');
        if (hold) await hold.promise;
        if (script.saveError !== null) throw new Error(script.saveError);
        saves.push(snapshot);
        roster = snapshot.agents.map((record) => ({ ...record }));
      });
      saveChain = run.catch(() => undefined);
      return run;
    },
    loadHistory: async (limit) => history.slice(-limit).map((record) => ({ ...record })),
    logMessage: (record) => void logged.push({ ...record }),
    renameAgentFiles: async (oldName, newName) => {
      renames.push([oldName, newName]);
      const hold = takeGate('renameGate');
      if (hold) await hold.promise;
      if (script.renameError !== null) throw new Error(script.renameError);
    },
    spawn: async (req) => {
      spawns.push({ agent: { ...req.agent }, generation: req.generation, flag: req.flag });
      const hold = takeGate('spawnGate');
      if (hold) await hold.promise;
      if (script.spawnError !== null) throw new Error(script.spawnError);
      live.set(req.agent.name, req.generation);
      return { generation: req.generation, flag: req.flag ?? script.flag, pid: 7000 + req.generation };
    },
    stop: async (name, generation) => {
      stops.push({ name, generation });
      const before = takeGate('stopGate');
      if (before) await before.promise;
      if (live.get(name) === generation) {
        live.delete(name);
        if (script.stopExits) {
          hub.onTerminalEvent({
            kind: 'exit',
            name,
            generation,
            info: { code: null, signal: 15, durationMs: 60_000, requested: true, tail: '' },
            at: now,
          });
        }
      }
      const after = takeGate('afterStopGate');
      if (after) await after.promise;
    },
    typePointer: (name, generation, text) => {
      typed.push({ name, generation, text });
      return script.typeResult;
    },
    press: (name, generation, data) => {
      pressed.push({ name, generation, data });
      return script.pressResult;
    },
    screen: (name) => (screens.has(name) ? (screens.get(name) ?? null) : { ...OPEN_BOX }),
    title: (name) =>
      titles.has(name) ? (titles.get(name) ?? null) : { glyph: 'idle', title: '✳ Claude Code', since: 0 },
    outputBytes: (name) => output.get(name) ?? 0,
    forget: (name) => {
      if (script.forgetError !== null) throw new Error(script.forgetError);
      forgotten.push(name);
    },
    emit: (event) => void events.push(event),
    log: logger,
  };
  if (options.adoptable) io.adoptable = options.adoptable;
  if (options.saveHolds) io.saveHolds = options.saveHolds;
  io.meter = (name, generation, transcriptPath) => void metered.push({ name, generation, transcriptPath });
  io.notify = (kind, text) => void notices.push([kind, text]);
  if (options.startup) io.startup = () => options.startup as StartupSettings;
  if (options.runSet !== undefined) io.runSet = () => options.runSet ?? null;
  if (options.marks) io.markRun = (name, running, working) => void options.marks?.push([name, running, working]);
  hub = createHub(io, { maxHops: options.maxHops ?? 8, bossDir: '/work/boss', maxWorking: options.maxWorking, redline: options.redline });

  const view = (name: string): AgentView => {
    const found = hub.views().find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no agent ${name}`);
    return found;
  };
  const gen = (name: string): number => view(name).generation;

  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    for (;;) {
      let next: FakeTimer | undefined;
      for (const timer of timers) {
        if (!timer.live || timer.due > target) continue;
        if (!next || timer.due < next.due || (timer.due === next.due && timer.id < next.id)) next = timer;
      }
      if (!next) break;
      next.live = false;
      now = Math.max(now, next.due);
      next.fn();
      await settle();
    }
    now = target;
    timers.splice(0, timers.length, ...timers.filter((timer) => timer.live));
    await settle();
  }

  const harness: Harness = {
    hub,
    io,
    script,
    events,
    logged,
    saves,
    typed,
    pressed,
    metered,
    notices,
    spawns,
    cleanRoomChecks,
    stops,
    renames,
    forgotten,
    warnings,
    now: () => now,
    pendingTimers: () => timers.filter((timer) => timer.live).length,
    advance,
    alignToTick: async (msBefore) => {
      const phase = (now - T0) % RECONCILE_TICK_MS;
      await advance((RECONCILE_TICK_MS - phase - msBefore + RECONCILE_TICK_MS) % RECONCILE_TICK_MS);
    },
    boot: async () => {
      await hub.start();
      await settle();
      harness.ready('flight');
    },
    hireRaw: async (name, mode = 'default') => {
      return hub.hire({ name, role: `${name} does the ${name} work`, dir: `/work/${name}`, mode, confirmBypass: true });
    },
    hire: async (name, mode = 'default') => {
      await harness.hireRaw(name, mode);
      harness.ready(name);
      return view(name);
    },
    ready: (name) => hub.onTerminalEvent({ kind: 'ready', name, generation: gen(name), at: now }),
    gen,
    view,
    hook: (name, event, payload = {}) => hub.onHook({ agent: name, generation: gen(name), event, payload }),
    prompt: (name, text, extra = {}) => {
      const reply = harness.hook(name, 'UserPromptSubmit', { prompt: text, ...extra });
      harness.setTitle(name, 'working', now);
      return reply;
    },
    work: (name) => void harness.prompt(name, 'work'),
    type: (name, data) => hub.onUserInput(name, data),
    send: (from, to, body = 'hello', subject = '') =>
      from === 'user'
        ? hub.sendFromUser({ to, subject, body })
        : hub.sendFromAgent(from, gen(from), { to, subject, body }),
    read: (name) => hub.readMessages(name, gen(name)),
    exit: (name, info = {}) => {
      const generation = gen(name);
      live.delete(name);
      hub.onTerminalEvent({
        kind: 'exit',
        name,
        generation,
        info: { code: 1, signal: null, durationMs: 60_000, requested: false, tail: '', ...info },
        at: now,
      });
    },
    setScreen: (name, probe) => {
      screens.set(name, probe === null ? null : { ...OPEN_BOX, ...probe });
    },
    setTitle: (name, glyph, since) => {
      if (glyph === null) titles.set(name, null);
      else titles.set(name, { glyph, title: glyph === 'idle' ? '✳ Claude Code' : '◐ Claude Code', since: since ?? now });
    },
    setOutput: (name, bytes) => void output.set(name, bytes),
    frames: (name) =>
      events.flatMap((event) => (event.t === 'agent' && event.agent.name === name ? [event.agent] : [])),
    items: (id) => events.flatMap((event) => (event.t === 'activity' && event.item.id === id ? [event.item] : [])),
    msg: (id) => {
      const found = hub.activity().find((item) => item.id === id);
      if (!found) throw new Error(`no message ${id}`);
      return found;
    },
    pointerTyped: async (name) => {
      await advance(DELIVERY_COALESCE_MS);
      const last = typed[typed.length - 1];
      if (!last || last.name !== name) throw new Error(`no pointer was typed into ${name}`);
      return last.text;
    },
  };
  return harness;
}

async function started(options?: HarnessOptions): Promise<Harness> {
  const h = makeHarness(options);
  await h.boot();
  return h;
}

/** A started hub with one idle agent (`ana`, generation 1). */
async function withAna(options?: HarnessOptions): Promise<Harness> {
  const h = await started(options);
  await h.hire('ana');
  return h;
}

function expectHubError(fn: () => unknown, code: ApiErrorCode, message?: string | RegExp, field?: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'a HubError was expected').toBeInstanceOf(Error);
  const error = thrown as HubError;
  expect(error.name).toBe('HubError');
  expect(error.code).toBe(code);
  if (typeof message === 'string') expect(error.message).toBe(message);
  else if (message) expect(error.message).toMatch(message);
  expect(error.field).toBe(field);
}

async function expectHubReject(
  promise: Promise<unknown>,
  code: ApiErrorCode,
  message?: string | RegExp,
  field?: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'a HubError was expected').toBeInstanceOf(Error);
  const error = thrown as HubError;
  expect(error.name).toBe('HubError');
  expect(error.code).toBe(code);
  if (typeof message === 'string') expect(error.message).toBe(message);
  else if (message) expect(error.message).toMatch(message);
  expect(error.field).toBe(field);
}

const POINTER_ONE = 'gonogo: 1 new message from user. Call read_messages.';
const IDLE_NOTE = 'waiting: about to type the pointer';
const CONFIRMING = 'waiting: confirming the pointer';
const PERMISSION_REASON = 'permission request: Bash: git push origin main';
const PERMISSION_PAYLOAD: HookPayload = { tool_name: 'Bash', tool_input: { command: 'git push origin main' } };

/** `count` messages from `name` to the user, a minute apart every SEND_RATE_MAX of them so that the sender is never rate limited. */
async function sendReports(h: Harness, name: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && index % SEND_RATE_MAX === 0) await h.advance(SEND_RATE_WINDOW_MS);
    h.send(name, 'user', `report ${index}`);
  }
}

/** A turn that ends on `ana` with `rounds` blocked Stops and no tool call in between (the cap of 8 counts them). */
function blockCycle(h: Harness, name: string, from = 'user'): HookReply {
  h.send(from, name, 'more work');
  return h.hook(name, 'Stop');
}

/* ------------------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------------------- */

describe('pointerText (5.1)', () => {
  it('uses the singular for one message', () => {
    expect(pointerText([{ from: 'ana' }])).toBe('gonogo: 1 new message from ana. Call read_messages.');
  });

  it('uses the plural and names each sender once, in order of first appearance', () => {
    expect(pointerText([{ from: 'ana' }, { from: 'user' }, { from: 'ana' }])).toBe(
      'gonogo: 3 new messages from ana, user. Call read_messages.',
    );
  });

  it('names three senders and says "and others" for more', () => {
    const three = ['a', 'b', 'c'].map((from) => ({ from }));
    expect(pointerText(three)).toBe('gonogo: 3 new messages from a, b, c. Call read_messages.');
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((from) => ({ from }));
    expect(pointerText(seven)).toBe('gonogo: 7 new messages from a, b, c and others. Call read_messages.');
  });

  it('is at most 162 characters, one ASCII line that starts with the pointer prefix', () => {
    const names = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(32));
    const text = pointerText(Array.from({ length: 999 }, (_, index) => ({ from: names[index % 4] ?? 'a' })));
    expect(text).toHaveLength(162);
    expect(text).toMatch(/^gonogo: [\x20-\x7e]+$/);
  });
});

describe('describePermission (4.2, 0.5 item 5)', () => {
  it('names the tool alone when the input has nothing to show', () => {
    expect(describePermission('Read', {})).toBe('permission request: Read');
    expect(describePermission('Read', { limit: 5 })).toBe('permission request: Read');
  });

  it('shows the first of command, file_path, path and url', () => {
    expect(describePermission('Bash', { command: 'git push origin main' })).toBe(PERMISSION_REASON);
    expect(describePermission('Edit', { file_path: '/a/b.ts', path: '/x', url: 'u' })).toBe(
      'permission request: Edit: /a/b.ts',
    );
    expect(describePermission('Glob', { path: '/src', url: 'u' })).toBe('permission request: Glob: /src');
    expect(describePermission('WebFetch', { url: 'https://example.com' })).toBe(
      'permission request: WebFetch: https://example.com',
    );
    expect(describePermission('Bash', { command: 'x', file_path: 'y' })).toBe('permission request: Bash: x');
  });

  it('skips a key that is empty or not text', () => {
    expect(describePermission('Bash', { command: '   ', file_path: '/f' })).toBe('permission request: Bash: /f');
    expect(describePermission('Bash', { command: 5, path: '/p' })).toBe('permission request: Bash: /p');
  });

  it('collapses whitespace to single spaces', () => {
    expect(describePermission('Bash', { command: '  ls \n\t -la   /tmp ' })).toBe('permission request: Bash: ls -la /tmp');
  });

  it('keeps the first 100 characters of the collapsed text and adds an ellipsis only when something was cut', () => {
    const exact = 'x'.repeat(100);
    expect(describePermission('Bash', { command: exact })).toBe(`permission request: Bash: ${exact}`);
    const long = describePermission('Bash', { command: `${exact}y` });
    expect(long).toBe(`permission request: Bash: ${exact}…`);
    const summary = long.slice('permission request: Bash: '.length);
    expect(summary).toHaveLength(101);
    // The cut counts collapsed text: 60 spaces in a row are one character.
    const spaced = `a${' '.repeat(60)}${'b'.repeat(98)}`;
    expect(describePermission('Bash', { command: spaced })).toBe(`permission request: Bash: a ${'b'.repeat(98)}`);
  });

  it('does not leave half of a surrogate pair at the cut', () => {
    const text = `${'x'.repeat(99)}😀tail`;
    const reason = describePermission('Bash', { command: text });
    expect(reason).toBe(`permission request: Bash: ${'x'.repeat(99)}…`);
  });

  it('survives arguments of the wrong type', () => {
    expect(describePermission(undefined, 5)).toBe('permission request: unknown tool');
    expect(describePermission('', null)).toBe('permission request: unknown tool');
    expect(describePermission('Bash', ['command'])).toBe('permission request: Bash');
    expect(describePermission({}, 'ls')).toBe('permission request: unknown tool');
  });
});

describe('classifyInput (4.6)', () => {
  const table: Array<[string, string, InputEffect]> = [
    ['a printable character', 'a', 'set'],
    ['a word', 'hello world', 'set'],
    ['an astral character', '😀', 'set'],
    ['Enter', '\r', 'clear'],
    ['Ctrl-C', '\x03', 'clear'],
    ['Escape alone (it leaves the text in claude\'s box)', '\x1b', 'none'],
    ['Escape Escape', '\x1b\x1b', 'none'],
    ['an arrow key', '\x1b[A', 'none'],
    ['an arrow key with modifiers', '\x1b[1;5C', 'none'],
    ['an application-mode arrow', '\x1bOA', 'none'],
    ['an SGR mouse press', '\x1b[<0;41;13M', 'none'],
    ['an SGR mouse release', '\x1b[<0;41;13m', 'none'],
    ['an X10 mouse report (three raw bytes)', '\x1b[M !!', 'none'],
    ['an X10 mouse report followed by text', '\x1b[M !!a', 'set'],
    ['focus in', '\x1b[I', 'none'],
    ['focus out', '\x1b[O', 'none'],
    ['a device attributes reply', '\x1b[?1;2c', 'none'],
    ['a cursor position reply', '\x1b[12;40R', 'none'],
    ['an OSC colour reply ended by BEL', '\x1b]11;rgb:0000/0000/0000\x07', 'none'],
    ['an OSC colour reply ended by ST', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\', 'none'],
    ['a DCS reply', '\x1bP1$r0m\x1b\\', 'none'],
    ['an Alt-key', '\x1bb', 'none'],
    ['ESC CR (a newline)', '\x1b\r', 'none'],
    ['a bracketed paste with text', '\x1b[200~hello\x1b[201~', 'set'],
    ['a bracketed paste of whitespace only', '\x1b[200~ \n \x1b[201~', 'none'],
    ['a bracketed paste that is not terminated', '\x1b[200~hello', 'set'],
    ['a paste, then Enter', '\x1b[200~hello\x1b[201~\r', 'clear'],
    ['an Enter inside a paste (it is text)', '\x1b[200~a\rb\x1b[201~', 'set'],
    ['Backspace', '\x7f', 'none'],
    ['Tab', '\t', 'none'],
    ['a line feed', '\n', 'none'],
    ['Ctrl-U', '\x15', 'none'],
    ['a C1 control', '\x85', 'none'],
    ['text, then Enter', 'ab\r', 'clear'],
    ['Enter, then text', '\rab', 'set'],
    ['an arrow, then text', '\x1b[Aab', 'set'],
    ['a focus report, then Ctrl-C', '\x1b[I\x03', 'clear'],
    ['an empty chunk', '', 'none'],
    ['text, then a truncated sequence', 'a\x1b[1;', 'set'],
    ['text, then a paste of whitespace (the earlier effect stays)', 'a\x1b[200~  \x1b[201~', 'set'],
  ];
  it.each(table)('%s', (_name, data, effect) => {
    expect(classifyInput(data)).toBe(effect);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * Helpers for the scenarios below
 * ---------------------------------------------------------------------------------------------------------- */

/** Gives `name` a trigger whose highest hop count is 1 (a message from `ben`, who was briefed by the user). */
async function armTrigger(h: Harness, name: string): Promise<void> {
  if (!h.hub.views().some((agent) => agent.name === 'ben')) await h.hire('ben');
  h.send('user', 'ben', 'start');
  h.read('ben');
  h.send('ben', name, 'trigger');
  expect(h.read(name).count).toBeGreaterThan(0);
}

/** The hop count the next message from `name` would get. */
function nextHops(h: Harness, name: string): number {
  return h.msg(h.send(name, 'ben', 'probe').id).hops;
}

/** Answers `MAX_STOP_BLOCKS` Stops with a block each, with no tool call in between: the cap is reached. */
function fillBlocks(h: Harness, name: string): void {
  for (let round = 0; round < MAX_STOP_BLOCKS; round += 1) {
    expect(blockCycle(h, name).decision, `block ${round + 1}`).toBe('block');
  }
}

/* ------------------------------------------------------------------------------------------------------------
 * 4.4, 4.5: hooks and the transition table
 * ---------------------------------------------------------------------------------------------------------- */

describe('4.5 transition table', () => {
  it('a hired agent is starting, then idle on the terminal ready event', async () => {
    const h = await started();
    const hired = await h.hireRaw('ana');
    expect(hired).toMatchObject({ state: 'starting', generation: 1, needsKind: null, needsReason: null });
    h.ready('ana');
    expect(h.view('ana')).toMatchObject({ state: 'idle', needsKind: null, needsReason: null });
    expect(h.frames('ana').map((frame) => frame.state)).toEqual(['starting', 'idle']);
  });

  const hookCases: Array<[string, HookEvent, HookPayload, string]> = [
    ['UserPromptSubmit', 'UserPromptSubmit', { prompt: 'hello' }, 'working'],
    ['PreToolUse', 'PreToolUse', { tool_name: 'Bash' }, 'working'],
    ['PostToolUse', 'PostToolUse', { tool_name: 'Bash' }, 'working'],
    ['PostToolUseFailure', 'PostToolUseFailure', { tool_name: 'Bash' }, 'working'],
    ['PermissionRequest', 'PermissionRequest', PERMISSION_PAYLOAD, 'needs_you'],
    ['Notification (elicitation_dialog)', 'Notification', { notification_type: 'elicitation_dialog', message: 'q' }, 'needs_you'],
    ['Stop', 'Stop', {}, 'idle'],
    ['StopFailure', 'StopFailure', {}, 'idle'],
  ];
  for (const from of ['idle', 'working'] as const) {
    it.each(hookCases)(`from ${from}: %s`, async (_label, event, payload, expected) => {
      const h = await withAna();
      if (from === 'working') h.work('ana');
      expect(h.view('ana').state).toBe(from);
      h.hook('ana', event, payload);
      expect(h.view('ana').state).toBe(expected);
    });
  }

  it('Stop and StopFailure answer {} when nothing is waiting', async () => {
    const h = await withAna();
    h.work('ana');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    h.work('ana');
    expect(h.hook('ana', 'StopFailure')).toStrictEqual({});
  });

  it('every other event answers {}', async () => {
    const h = await withAna();
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification'] as const) {
      expect(h.hook('ana', event, PERMISSION_PAYLOAD)).toStrictEqual({});
    }
  });

  it('a PermissionRequest sets kind permission and the exact reason', async () => {
    const h = await withAna();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'permission', needsReason: PERMISSION_REASON });
  });

  it('stateSince moves only when the state value changes, and a no-op write emits nothing', async () => {
    const h = await withAna();
    h.work('ana');
    const since = h.view('ana').stateSince;
    h.hook('ana', 'PreToolUse', PERMISSION_PAYLOAD); // moves `doing`, which is part of the view
    const frames = h.frames('ana').length;
    await h.advance(100);
    h.hook('ana', 'PreToolUse', PERMISSION_PAYLOAD);
    h.hook('ana', 'PostToolUse');
    h.hook('ana', 'UserPromptSubmit', { prompt: 'again' });
    expect(h.view('ana').stateSince).toBe(since);
    expect(h.frames('ana')).toHaveLength(frames);
    h.hook('ana', 'Stop');
    expect(h.view('ana').stateSince).toBe(since + 100);
  });

  it('a state change emits the whole view once', async () => {
    const h = await withAna();
    const before = h.frames('ana').length;
    h.work('ana');
    const frames = h.frames('ana').slice(before);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toStrictEqual(h.view('ana'));
  });

  it('ignores events it does not know and payloads that are not objects', async () => {
    const h = await withAna();
    expect(h.hub.onHook({ agent: 'ana', generation: h.gen('ana'), event: 'SessionEnd' as HookEvent, payload: {} })).toStrictEqual({});
    expect(h.hub.onHook({ agent: 'nobody', generation: 1, event: 'Stop', payload: {} })).toStrictEqual({});
    expect(h.hub.onHook({ agent: 'ana', generation: h.gen('ana'), event: 'PermissionRequest', payload: null as unknown as HookPayload })).toStrictEqual({});
    expect(h.view('ana').state).toBe('needs_you');
    expect(h.view('ana').needsReason).toBe('permission request: unknown tool');
  });

  it('P1: a hook is ignored while a stop is running, P2: and once the agent is stopped', async () => {
    const h = await withAna();
    h.script.stopGate = gate();
    const gateOpen = h.script.stopGate;
    const stopping = h.hub.stop('ana');
    await settle();
    expect(h.view('ana').transition).toBe('stopping');
    expect(h.hook('ana', 'UserPromptSubmit', { prompt: 'late' })).toStrictEqual({});
    expect(h.view('ana').state).toBe('idle');
    gateOpen.open();
    await stopping;
    expect(h.view('ana')).toMatchObject({ state: 'stopped', transition: null });
    const frames = h.frames('ana').length;
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD)).toStrictEqual({});
    expect(h.view('ana').state).toBe('stopped');
    expect(h.frames('ana')).toHaveLength(frames);
  });
});

describe('P3: implicit readiness', () => {
  it.each(['UserPromptSubmit', 'PreToolUse', 'Stop', 'Notification'] as const)(
    'a %s hook while starting proves the REPL is up; the later ready event changes nothing',
    async (event) => {
      const h = await started();
      await h.hireRaw('ana');
      h.hook('ana', event, { notification_type: 'idle_prompt' });
      const expected = event === 'UserPromptSubmit' || event === 'PreToolUse' ? 'working' : 'idle';
      expect(h.view('ana').state).toBe(expected);
      const frames = h.frames('ana').length;
      h.ready('ana');
      expect(h.view('ana').state).toBe(expected);
      expect(h.frames('ana')).toHaveLength(frames);
    },
  );

  it('a hook answers a startup dialog: needs_you (startup_dialog) becomes idle, then the event applies', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.setOutput('ana', 500);
    await h.advance(STARTUP_READY_TIMEOUT_MS);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'startup_dialog' });
    h.hook('ana', 'Stop');
    expect(h.view('ana')).toMatchObject({ state: 'idle', needsKind: null, needsReason: null });
    // The startup timer is gone with the readiness.
    await h.advance(STARTUP_RECHECK_MS * 5);
    expect(h.view('ana').state).toBe('idle');
  });
});

describe('PermissionRequest, tool hooks and the needs_you heartbeat', () => {
  it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const)(
    '%s leaves needs_you only when no dialog is on screen',
    async (event) => {
      const h = await withAna();
      h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
      // A sibling tool of the same batch ended: the dialog is still open.
      h.setScreen('ana', { promptBox: false, dialog: 'permission' });
      h.hook('ana', event);
      expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'permission', needsReason: PERMISSION_REASON });
      // The dialog is gone: the tool ran.
      h.setScreen('ana', { promptBox: true, dialog: null });
      h.hook('ana', event);
      expect(h.view('ana')).toMatchObject({ state: 'working', needsKind: null, needsReason: null });
    },
  );

  it('a screen that cannot be read does not keep needs_you either', async () => {
    const h = await withAna();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.setScreen('ana', null);
    h.hook('ana', 'PostToolUse');
    expect(h.view('ana').state).toBe('working');
  });

  it('a second PermissionRequest with the same text is idempotent, a different tool updates the reason', async () => {
    const h = await withAna();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    const frames = h.frames('ana').length;
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    expect(h.frames('ana')).toHaveLength(frames);
    h.hook('ana', 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/a/b.ts' } });
    expect(h.view('ana').needsReason).toBe('permission request: Edit: /a/b.ts');
    expect(h.frames('ana')).toHaveLength(frames + 1);
  });
});

describe('Notification (4.4)', () => {
  it('permission_prompt brings needs_you only while a dialog is on screen', async () => {
    const h = await withAna();
    h.work('ana');
    h.setScreen('ana', { promptBox: false, dialog: 'permission' });
    h.hook('ana', 'Notification', { notification_type: 'permission_prompt' });
    expect(h.view('ana')).toMatchObject({
      state: 'needs_you',
      needsKind: 'permission',
      needsReason: 'permission request: waiting for approval',
    });
  });

  it('permission_prompt is ignored when no dialog is on screen (the user already answered)', async () => {
    const h = await withAna();
    h.work('ana');
    h.setScreen('ana', { promptBox: true, dialog: null });
    h.hook('ana', 'Notification', { notification_type: 'permission_prompt' });
    expect(h.view('ana').state).toBe('working');
  });

  it('permission_prompt is ignored while the screen is unparsed', async () => {
    const h = await withAna();
    h.work('ana');
    h.setScreen('ana', null);
    h.hook('ana', 'Notification', { notification_type: 'permission_prompt' });
    expect(h.view('ana').state).toBe('working');
  });

  it('permission_prompt does not replace the reason of a PermissionRequest that already came', async () => {
    const h = await withAna();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.setScreen('ana', { promptBox: false, dialog: 'permission' });
    h.hook('ana', 'Notification', { notification_type: 'permission_prompt' });
    expect(h.view('ana').needsReason).toBe(PERMISSION_REASON);
  });

  it.each(['elicitation_dialog', 'agent_needs_input'])('%s brings needs_you (input) with no screen check', async (type) => {
    const h = await withAna();
    h.work('ana');
    h.setScreen('ana', null);
    h.hook('ana', 'Notification', { notification_type: type, message: 'Which branch?' });
    expect(h.view('ana')).toMatchObject({
      state: 'needs_you',
      needsKind: 'input',
      needsReason: 'input requested: Which branch?',
    });
  });

  it('cuts the input message to 100 characters', async () => {
    const h = await withAna();
    h.hook('ana', 'Notification', { notification_type: 'elicitation_dialog', message: 'q'.repeat(150) });
    expect(h.view('ana').needsReason).toBe(`input requested: ${'q'.repeat(100)}`);
  });

  it.each(['idle_prompt', 'auth_success', 'something_new', undefined])('%s never changes the state', async (type) => {
    const h = await withAna();
    h.work('ana');
    h.setScreen('ana', { promptBox: false, dialog: 'permission' });
    h.hook('ana', 'Notification', { notification_type: type, message: 'hi' });
    expect(h.view('ana').state).toBe('working');
  });
});

describe('StopFailure (4.4)', () => {
  it('goes idle, clears the trigger and the block counter, answers {}', async () => {
    const h = await withAna();
    await armTrigger(h, 'ana');
    fillBlocks(h, 'ana');
    expect(h.hook('ana', 'StopFailure')).toStrictEqual({});
    expect(h.view('ana').state).toBe('idle');
    expect(nextHops(h, 'ana')).toBe(1);
    expect(blockCycle(h, 'ana').decision).toBe('block');
  });

  it('gives a message that was delivered but not read one more pointer', async () => {
    const h = await withAna();
    h.send('user', 'ana', 'read me');
    const text = await h.pointerTyped('ana');
    h.hook('ana', 'UserPromptSubmit', { prompt: text });
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });
    h.hook('ana', 'StopFailure');
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'waiting: ana has not read it yet' });
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(2);
  });
});

describe('UserPromptSubmit and the session id (4.4)', () => {
  it('follows a new session id (after /clear) and saves the roster', async () => {
    const h = await withAna();
    const saves = h.saves.length;
    h.hook('ana', 'UserPromptSubmit', { prompt: 'x', session_id: UUID_A });
    await settle();
    expect(h.saves).toHaveLength(saves + 1);
    expect(h.saves[h.saves.length - 1]?.agents.find((record) => record.name === 'ana')?.sessionId).toBe(UUID_A);
    // The next start resumes the new session.
    h.hook('ana', 'Stop');
    await h.hub.restart('ana');
    expect(h.spawns[h.spawns.length - 1]?.agent.sessionId).toBe(UUID_A);
  });

  it('ignores a session id that is not a UUID, or is the one it has', async () => {
    const h = await withAna();
    const saves = h.saves.length;
    h.hook('ana', 'UserPromptSubmit', { prompt: 'x', session_id: 'not-a-uuid' });
    h.hook('ana', 'UserPromptSubmit', { prompt: 'x', session_id: 42 as unknown as string });
    h.hook('ana', 'UserPromptSubmit', { prompt: 'x', session_id: h.spawns[h.spawns.length - 1]?.agent.sessionId });
    await settle();
    expect(h.saves).toHaveLength(saves);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 4.8 startup
 * ---------------------------------------------------------------------------------------------------------- */

describe('startup timer (4.8)', () => {
  it('5 s without readiness and with output: needs_you with the exact startup reason', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.setOutput('ana', 1);
    await h.advance(STARTUP_READY_TIMEOUT_MS - 100);
    expect(h.view('ana').state).toBe('starting');
    await h.advance(200);
    expect(h.view('ana')).toMatchObject({
      state: 'needs_you',
      needsKind: 'startup_dialog',
      needsReason: STARTUP_DIALOG_REASON,
    });
    expect(STARTUP_DIALOG_REASON).toBe('startup dialog: answer it in the terminal');
  });

  it('5 s without readiness and without output: looks again every STARTUP_RECHECK_MS', async () => {
    const h = await started();
    await h.hireRaw('ana');
    await h.advance(STARTUP_READY_TIMEOUT_MS + STARTUP_RECHECK_MS * 3);
    expect(h.view('ana').state).toBe('starting');
    h.setOutput('ana', 10);
    await h.advance(STARTUP_RECHECK_MS);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'startup_dialog' });
  });

  it('the ready event after the dialog moves needs_you (startup_dialog) to idle', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.setOutput('ana', 1);
    await h.advance(STARTUP_READY_TIMEOUT_MS + 100);
    h.ready('ana');
    expect(h.view('ana')).toMatchObject({ state: 'idle', needsKind: null, needsReason: null });
  });

  it('readiness before the 5 s cancels the timer', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.setOutput('ana', 1);
    h.ready('ana');
    await h.advance(STARTUP_READY_TIMEOUT_MS * 2);
    expect(h.view('ana').state).toBe('idle');
  });

  it('a startup timer of an older generation does nothing, even when it was not cancelled', async () => {
    const h = await started();
    h.io.clearTimer = () => undefined;
    await h.hireRaw('ana');
    h.setOutput('ana', 10);
    await h.advance(STARTUP_READY_TIMEOUT_MS - 1000);
    await h.hub.restart('ana');
    await h.advance(1500);
    expect(h.view('ana')).toMatchObject({ state: 'starting', generation: 2 });
    await h.advance(STARTUP_READY_TIMEOUT_MS);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'startup_dialog' });
  });

  it('nothing is delivered to an agent that is not ready', async () => {
    const h = await started();
    await h.hireRaw('ana');
    const result = h.send('user', 'ana');
    expect(result).toMatchObject({ ok: true, status: 'queued', note: 'waiting: ana is starting' });
    await h.advance(DELIVERY_COALESCE_MS * 4);
    expect(h.typed).toHaveLength(0);
    h.ready('ana');
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toEqual([{ name: 'ana', generation: 1, text: POINTER_ONE }]);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 4.7 reconciliation
 * ---------------------------------------------------------------------------------------------------------- */

describe('reconciliation R1: working, idle glyph', () => {
  it('goes idle once the idle glyph has lasted TITLE_IDLE_RECONCILE_MS', async () => {
    const h = await withAna();
    h.work('ana');
    h.setTitle('ana', 'idle');
    await h.advance(TITLE_IDLE_RECONCILE_MS - 700);
    expect(h.view('ana').state).toBe('working');
    await h.advance(1400);
    expect(h.view('ana')).toMatchObject({ state: 'idle', needsKind: null });
  });

  it('goes to needs_you (dialog) when a dialog is on screen', async () => {
    const h = await withAna();
    h.work('ana');
    h.setTitle('ana', 'idle');
    h.setScreen('ana', { promptBox: false, dialog: 'permission' });
    await h.advance(TITLE_IDLE_RECONCILE_MS + RECONCILE_TICK_MS);
    expect(h.view('ana')).toMatchObject({
      state: 'needs_you',
      needsKind: 'dialog',
      needsReason: SCREEN_DIALOG_REASON,
    });
  });

  it('does nothing with a null probe or a null title', async () => {
    const h = await withAna();
    h.work('ana');
    h.setTitle('ana', 'idle');
    h.setScreen('ana', null);
    await h.advance(TITLE_IDLE_RECONCILE_MS * 3);
    expect(h.view('ana').state).toBe('working');
    h.setScreen('ana', { promptBox: true });
    h.setTitle('ana', null);
    await h.advance(TITLE_IDLE_RECONCILE_MS * 3);
    expect(h.view('ana').state).toBe('working');
  });

  it('counts from the later of the glyph change and the state change', async () => {
    const h = await withAna();
    h.setTitle('ana', 'idle', h.now() - 60_000);
    await h.advance(5000);
    h.work('ana');
    h.setTitle('ana', 'idle', h.now() - 60_000);
    // The glyph has been idle for a minute, but the state became working just now.
    await h.advance(TITLE_IDLE_RECONCILE_MS - 700);
    expect(h.view('ana').state).toBe('working');
    await h.advance(1400);
    expect(h.view('ana').state).toBe('idle');
  });

  it('a sweep tick 20 ms after a Stop does not flip idle back to working', async () => {
    const h = await withAna();
    h.work('ana');
    await h.advance(30_000);
    h.setTitle('ana', 'working', h.now() - 30_000);
    await h.alignToTick(20);
    h.hook('ana', 'Stop');
    expect(h.view('ana').state).toBe('idle');
    await h.advance(20);
    expect(h.view('ana').state).toBe('idle');
  });

  it('is suppressed for TITLE_IDLE_RECONCILE_MS after a Stop block was answered', async () => {
    const h = await withAna();
    h.work('ana');
    await h.advance(10_000);
    h.send('user', 'ana');
    h.setTitle('ana', 'idle', h.now() - 60_000);
    expect(h.hook('ana', 'Stop').decision).toBe('block');
    await h.advance(TITLE_IDLE_RECONCILE_MS - 700);
    expect(h.view('ana').state).toBe('working');
    await h.advance(1500);
    expect(h.view('ana').state).toBe('idle');
  });

  it('clears the trigger and the block counter', async () => {
    const h = await withAna();
    await armTrigger(h, 'ana');
    fillBlocks(h, 'ana');
    h.setTitle('ana', 'idle', h.now() - 60_000);
    await h.advance(TITLE_IDLE_RECONCILE_MS + 1000);
    expect(h.view('ana').state).toBe('idle');
    expect(nextHops(h, 'ana')).toBe(1);
    expect(blockCycle(h, 'ana').decision).toBe('block');
  });
});

describe('reconciliation R2: needs_you, the dialog is gone', () => {
  async function needsYou(): Promise<Harness> {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.setScreen('ana', { promptBox: false, dialog: 'permission' });
    h.setTitle('ana', 'idle');
    return h;
  }

  it('goes idle when the box is back, no dialog, idle glyph, for NEEDS_YOU_CLEAR_MS', async () => {
    const h = await needsYou();
    await h.advance(5000);
    expect(h.view('ana').state).toBe('needs_you');
    h.setScreen('ana', { promptBox: true, dialog: null });
    await h.advance(NEEDS_YOU_CLEAR_MS - 700);
    expect(h.view('ana').state).toBe('needs_you');
    await h.advance(1400);
    expect(h.view('ana')).toMatchObject({ state: 'idle', needsKind: null, needsReason: null });
  });

  it('starts counting again whenever the condition fails', async () => {
    const h = await needsYou();
    h.setScreen('ana', { promptBox: true, dialog: null });
    await h.advance(NEEDS_YOU_CLEAR_MS - 700);
    h.setScreen('ana', { promptBox: true, dialog: 'permission' });
    await h.advance(1000);
    h.setScreen('ana', { promptBox: true, dialog: null });
    await h.advance(NEEDS_YOU_CLEAR_MS - 700);
    expect(h.view('ana').state).toBe('needs_you');
    await h.advance(1400);
    expect(h.view('ana').state).toBe('idle');
  });

  it('needs the idle glyph and the box: neither a working glyph nor a missing box is enough', async () => {
    const h = await needsYou();
    h.setScreen('ana', { promptBox: false, dialog: null });
    await h.advance(5000);
    expect(h.view('ana').state).toBe('needs_you');
    h.setScreen('ana', { promptBox: true, dialog: null });
    h.setTitle('ana', 'unknown');
    await h.advance(5000);
    expect(h.view('ana').state).toBe('needs_you');
  });

  it('clears the trigger and the block counter', async () => {
    const h = await withAna();
    await armTrigger(h, 'ana');
    fillBlocks(h, 'ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.setScreen('ana', { promptBox: true, dialog: null });
    h.setTitle('ana', 'idle');
    await h.advance(NEEDS_YOU_CLEAR_MS + 1000);
    expect(h.view('ana').state).toBe('idle');
    expect(nextHops(h, 'ana')).toBe(1);
    expect(blockCycle(h, 'ana').decision).toBe('block');
  });

  it('applies to kind input as well, and never to a startup dialog', async () => {
    const h = await withAna();
    h.hook('ana', 'Notification', { notification_type: 'elicitation_dialog', message: 'Which?' });
    h.setScreen('ana', { promptBox: true, dialog: null });
    h.setTitle('ana', 'idle');
    await h.advance(NEEDS_YOU_CLEAR_MS + 1000);
    expect(h.view('ana').state).toBe('idle');

    const g = await started();
    await g.hireRaw('dana');
    g.setOutput('dana', 5);
    await g.advance(STARTUP_READY_TIMEOUT_MS + 100);
    g.setScreen('dana', { promptBox: true, dialog: null });
    g.setTitle('dana', 'idle');
    await g.advance(10_000);
    expect(g.view('dana')).toMatchObject({ state: 'needs_you', needsKind: 'startup_dialog' });
  });
});

describe('reconciliation R3: idle, working glyph', () => {
  it('goes working after TITLE_WORKING_CONFIRM_MS of the working glyph (a shell command, a lost hook)', async () => {
    const h = await withAna();
    h.setTitle('ana', 'working');
    await h.advance(TITLE_WORKING_CONFIRM_MS - 600);
    expect(h.view('ana').state).toBe('idle');
    await h.advance(1200);
    expect(h.view('ana').state).toBe('working');
  });

  it('does nothing while the glyph is idle or unknown', async () => {
    const h = await withAna();
    h.setTitle('ana', 'unknown');
    await h.advance(5000);
    expect(h.view('ana').state).toBe('idle');
  });

  it('counts from the state change, not from the age of the glyph', async () => {
    const h = await withAna();
    h.setTitle('ana', 'working', h.now() - 60_000);
    await h.advance(RECONCILE_TICK_MS);
    expect(h.view('ana').state).toBe('idle');
    await h.advance(TITLE_WORKING_CONFIRM_MS);
    expect(h.view('ana').state).toBe('working');
  });
});

describe('reconciliation R4: needs_you, the user allowed the tool', () => {
  async function waiting(): Promise<Harness> {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.setScreen('ana', { promptBox: false, dialog: 'permission' });
    h.setTitle('ana', 'idle');
    return h;
  }

  it('goes working once the dialog is gone and the glyph has been working for TITLE_WORKING_CONFIRM_MS', async () => {
    const h = await waiting();
    await h.advance(3000);
    expect(h.view('ana').state).toBe('needs_you');
    h.setScreen('ana', { promptBox: false, dialog: null });
    h.setTitle('ana', 'working');
    await h.advance(TITLE_WORKING_CONFIRM_MS - 600);
    expect(h.view('ana').state).toBe('needs_you');
    await h.advance(1200);
    expect(h.view('ana')).toMatchObject({ state: 'working', needsKind: null, needsReason: null });
  });

  it('does not fire while a dialog is on screen', async () => {
    const h = await waiting();
    h.setTitle('ana', 'working');
    await h.advance(5000);
    expect(h.view('ana').state).toBe('needs_you');
  });

  it('does not fire while the glyph is idle', async () => {
    const h = await waiting();
    h.setScreen('ana', { promptBox: false, dialog: null });
    await h.advance(5000);
    expect(h.view('ana').state).toBe('needs_you');
  });

  it('does not fire for kind input (an elicitation form is not recognised on screen)', async () => {
    const h = await withAna();
    h.hook('ana', 'Notification', { notification_type: 'elicitation_dialog', message: 'Which?' });
    h.setScreen('ana', { promptBox: false, dialog: null });
    h.setTitle('ana', 'working');
    await h.advance(5000);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'input' });
  });

  it('applies to kind dialog (found by R1) as well', async () => {
    const h = await withAna();
    h.work('ana');
    h.setTitle('ana', 'idle');
    h.setScreen('ana', { promptBox: false, dialog: 'menu' });
    await h.advance(TITLE_IDLE_RECONCILE_MS + RECONCILE_TICK_MS);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'dialog' });
    h.setScreen('ana', { promptBox: false, dialog: null });
    h.setTitle('ana', 'working');
    await h.advance(TITLE_WORKING_CONFIRM_MS + RECONCILE_TICK_MS);
    expect(h.view('ana').state).toBe('working');
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 5.2, 5.3, 5.9: delivery
 * ---------------------------------------------------------------------------------------------------------- */

describe('delivery to each recipient state (5.9)', () => {
  it('idle: the note says about to type the pointer, and one pointer is typed after the coalescing delay', async () => {
    const h = await withAna();
    const result = h.send('user', 'ana');
    expect(result).toStrictEqual({ ok: true, id: 'm1', to: 'ana', status: 'queued', note: IDLE_NOTE });
    expect(h.typed).toHaveLength(0);
    await h.advance(DELIVERY_COALESCE_MS - 1);
    expect(h.typed).toHaveLength(0);
    await h.advance(1);
    expect(h.typed).toStrictEqual([{ name: 'ana', generation: 1, text: POINTER_ONE }]);
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: CONFIRMING });
    expect(h.view('ana').queued).toBe(1);
  });

  it('two messages at once become one pointer, naming the senders in order of first appearance', async () => {
    const h = await withAna();
    await h.hire('ben');
    h.send('user', 'ana', 'first');
    await h.advance(100);
    h.send('ben', 'ana', 'second');
    // The first message scheduled the check; the second does not push it back.
    await h.advance(DELIVERY_COALESCE_MS - 100);
    expect(h.typed).toHaveLength(1);
    expect(h.typed[0]?.text).toBe('gonogo: 2 new messages from user, ben. Call read_messages.');
    expect(h.msg('m1').note).toBe(CONFIRMING);
    expect(h.msg('m2').note).toBe(CONFIRMING);
  });

  it('while a pointer is in flight no second pointer is typed', async () => {
    const h = await withAna();
    h.send('user', 'ana');
    await h.advance(DELIVERY_COALESCE_MS);
    h.send('user', 'ana');
    await h.advance(DELIVERY_COALESCE_MS * 3);
    expect(h.typed).toHaveLength(1);
  });

  it('working: waits for the Stop hook, nothing is typed', async () => {
    const h = await withAna();
    h.work('ana');
    const result = h.send('user', 'ana');
    expect(result).toMatchObject({ status: 'queued', note: 'waiting: ana is working' });
    await h.advance(DELIVERY_COALESCE_MS * 3);
    expect(h.typed).toHaveLength(0);
    expect(h.items('m1')).toHaveLength(1);
  });

  it('needs_you: waits for the user, nothing is typed', async () => {
    const h = await withAna();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.setScreen('ana', { promptBox: false, dialog: 'permission' });
    expect(h.send('user', 'ana')).toMatchObject({ status: 'queued', note: 'waiting: ana needs you' });
    await h.advance(5000);
    expect(h.typed).toHaveLength(0);
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'waiting: ana needs you' });
  });

  it('starting: queued, typed after the agent became idle (see the startup tests)', async () => {
    const h = await started();
    await h.hireRaw('ana');
    expect(h.send('user', 'ana')).toMatchObject({ status: 'queued', note: 'waiting: ana is starting' });
    h.ready('ana');
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(1);
  });

  const notTypeable: Array<[string, (h: Harness) => void, (h: Harness) => void]> = [
    ['there is no prompt box', (h) => h.setScreen('ana', { promptBox: false }), (h) => h.setScreen('ana', { promptBox: true })],
    ['a dialog is on screen', (h) => h.setScreen('ana', { dialog: 'menu' }), (h) => h.setScreen('ana', { dialog: null })],
    ['the title glyph says working', (h) => h.setTitle('ana', 'working'), (h) => h.setTitle('ana', 'idle')],
  ];
  it.each(notTypeable)('idle, but nothing is typed while %s', async (_label, block, release) => {
    const h = await withAna();
    block(h);
    h.send('user', 'ana');
    await h.advance(DELIVERY_COALESCE_MS);
    expect(h.typed).toHaveLength(0);
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'waiting: ana is not ready for input' });
    release(h);
    await h.advance(RECONCILE_TICK_MS);
    expect(h.typed).toHaveLength(1);
    expect(h.msg('m1').note).toBe(CONFIRMING);
  });

  it('an unparsed screen: nothing is typed, nothing changes, the next sweep tries again', async () => {
    const h = await withAna();
    h.setScreen('ana', null);
    h.send('user', 'ana');
    await h.advance(DELIVERY_COALESCE_MS * 4);
    expect(h.typed).toHaveLength(0);
    expect(h.items('m1')).toHaveLength(1);
    expect(h.warnings).toEqual([]);
    h.setScreen('ana', { promptBox: true });
    await h.advance(RECONCILE_TICK_MS);
    expect(h.typed).toHaveLength(1);
  });

  it('a pointer the terminal host refused is tried again at the next sweep, with no pending confirmation', async () => {
    const h = await withAna();
    h.script.typeResult = false;
    h.send('user', 'ana');
    await h.advance(DELIVERY_COALESCE_MS);
    expect(h.typed).toHaveLength(1);
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: IDLE_NOTE });
    await h.advance(RECONCILE_TICK_MS);
    expect(h.typed).toHaveLength(2);
    h.script.typeResult = true;
    await h.advance(RECONCILE_TICK_MS);
    expect(h.typed).toHaveLength(3);
    expect(h.msg('m1').note).toBe(CONFIRMING);
  });

  it('the typed write is exactly one typePointer call per delivery', async () => {
    const h = await withAna();
    h.send('user', 'ana');
    h.send('user', 'ana');
    h.send('user', 'ana');
    await h.advance(DELIVERY_COALESCE_MS * 5);
    expect(h.typed).toHaveLength(1);
    expect(h.typed[0]?.text).toBe('gonogo: 3 new messages from user. Call read_messages.');
  });
});

describe('the notes of a send (5.8)', () => {
  it('a working recipient with a draft is held from the first frame and stays held through the delivery check', async () => {
    const h = await withAna();
    h.work('ana');
    expect(h.type('ana', 'half a sentence')).toBe('set');
    const result = h.send('user', 'ana');
    expect(result).toMatchObject({ ok: true, status: 'held', note: "held: text in ana's input" });
    expect(h.items(result.id)).toHaveLength(1);
    expect(h.items(result.id)[0]).toMatchObject({ status: 'held', note: "held: text in ana's input" });
    await h.advance(DELIVERY_COALESCE_MS * 3);
    expect(h.items(result.id)).toHaveLength(1);
    expect(h.typed).toHaveLength(0);
  });

  it('an idle recipient with a draft is held as well, and nothing is typed', async () => {
    const h = await withAna();
    h.type('ana', 'abc');
    expect(h.send('user', 'ana')).toMatchObject({ status: 'held' });
    await h.advance(DELIVERY_COALESCE_MS * 3);
    expect(h.typed).toHaveLength(0);
    expect(h.view('ana').held).toStrictEqual({ kind: 'draft', text: "held: text in ana's input" });
  });

  it('a message to the user is to_user with no note and is never queued', async () => {
    const h = await withAna();
    const result = h.send('ana', 'user', 'done');
    expect(result).toStrictEqual({ ok: true, id: 'm1', to: 'user', status: 'to_user', note: null });
    expect(h.msg('m1')).toMatchObject({ from: 'ana', to: 'user', hops: 1, status: 'to_user', note: null });
  });

  it('an undelivered item is not queued anywhere and is never typed later', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    const result = h.send('user', 'ana');
    expect(result).toStrictEqual({
      ok: false,
      id: 'm1',
      to: 'ana',
      status: 'undelivered',
      note: 'ana is stopped; the message went to the user',
    });
    await h.hub.restart('ana');
    h.ready('ana');
    await h.advance(DELIVERY_COALESCE_MS * 5);
    expect(h.typed).toHaveLength(0);
    expect(h.view('ana').queued).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 5.4: the 2 second confirmation
 * ---------------------------------------------------------------------------------------------------------- */

async function pointed(): Promise<{ h: Harness; text: string }> {
  const h = await withAna();
  h.send('user', 'ana');
  return { h, text: await h.pointerTyped('ana') };
}

describe('the 2 s confirmation (5.4)', () => {
  it('a UserPromptSubmit with the pointer text delivers the message', async () => {
    const { h, text } = await pointed();
    h.prompt('ana', text);
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });
    expect(h.view('ana')).toMatchObject({ state: 'working', queued: 0, held: null });
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS * 3);
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });
    expect(h.typed).toHaveLength(1);
  });

  it('a prompt that only ends with the pointer confirms it (the pointer was pasted after text in the box)', async () => {
    const { h, text } = await pointed();
    h.prompt('ana', `half a thought, then\n${text}`);
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });
  });

  it('line endings and surrounding whitespace do not matter', async () => {
    const { h, text } = await pointed();
    h.prompt('ana', `\r\n${text}\r\n`);
    expect(h.msg('m1').status).toBe('delivered');
  });

  it('another prompt does not confirm: the timer runs on and ends as not confirmed', async () => {
    const { h, text } = await pointed();
    h.prompt('ana', 'something the user typed');
    expect(h.msg('m1').note).toBe(CONFIRMING);
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: 'held: pointer not confirmed within 2 s' });
    expect(text).toBe(POINTER_ONE);
  });

  it('no UserPromptSubmit within 2 s: held with the exact note, and the view says so', async () => {
    const { h } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS - 1);
    expect(h.msg('m1').note).toBe(CONFIRMING);
    await h.advance(1);
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: 'held: pointer not confirmed within 2 s' });
    expect(h.view('ana')).toMatchObject({
      queued: 1,
      draft: false,
      held: { kind: 'unconfirmed', text: 'held: pointer not confirmed within 2 s' },
    });
  });

  it('no hook from this process and a turn that started after the pointer: the no-hook note and one warning', async () => {
    const { h } = await pointed();
    h.setTitle('ana', 'working', h.now());
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    const note = 'held: no hook has reached gonogo from ana; is its folder trusted?';
    expect(h.msg('m1')).toMatchObject({ status: 'held', note });
    expect(h.view('ana').held).toStrictEqual({ kind: 'unconfirmed', text: note });
    expect(h.warnings).toContain('no hook has reached gonogo from ana; is its folder trusted?');
  });

  it('the no-hook note needs hooksSeen to be false', async () => {
    const h = await withAna();
    h.hook('ana', 'Notification', { notification_type: 'idle_prompt' });
    h.send('user', 'ana');
    await h.pointerTyped('ana');
    h.setTitle('ana', 'working', h.now());
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    expect(h.msg('m1').note).toBe('held: pointer not confirmed within 2 s');
  });

  it('the no-hook note needs the working glyph to have started after the pointer was typed', async () => {
    const { h } = await pointed();
    h.setTitle('ana', 'working', h.now() - 10_000);
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    expect(h.msg('m1').note).toBe('held: pointer not confirmed within 2 s');
    expect(h.warnings).toHaveLength(0);
  });

  it('makes no retry: nothing is typed again until a person acts', async () => {
    const { h } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    await h.advance(120_000);
    expect(h.typed).toHaveLength(1);
    expect(h.msg('m1').status).toBe('held');
  });

  it('a late UserPromptSubmit with the pointer text confirms it and clears the latch', async () => {
    const { h, text } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    h.prompt('ana', `text that was in the box\n${text}`);
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });
    expect(h.view('ana').held).toBeNull();
  });

  it.each([
    ['Enter', '\r'],
    ['Ctrl-C', '\x03'],
  ])('%s releases the held message, and a fresh pointer is typed', async (_label, key) => {
    const { h } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    expect(h.type('ana', key)).toBe('clear');
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: IDLE_NOTE });
    expect(h.view('ana').held).toBeNull();
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(2);
    expect(h.msg('m1').note).toBe(CONFIRMING);
  });

  it('Escape does not release it (a lone Esc leaves the pointer in the box)', async () => {
    const { h } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    expect(h.type('ana', '\x1b')).toBe('none');
    await h.advance(10_000);
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: 'held: pointer not confirmed within 2 s' });
    expect(h.typed).toHaveLength(1);
  });

  it('any other UserPromptSubmit releases it', async () => {
    const { h } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    h.prompt('ana', 'a person typed this');
    expect(h.view('ana')).toMatchObject({ state: 'working', held: null, queued: 1 });
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'waiting: ana is working' });
  });

  it('a Stop hook does not release it', async () => {
    const { h } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    h.hook('ana', 'PreToolUse');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: 'held: pointer not confirmed within 2 s' });
    expect(h.view('ana').held).not.toBeNull();
  });

  it('read_messages before the hook ends the confirmation: no timer, no latch, a later message is typed, not held', async () => {
    const { h } = await pointed();
    expect(h.read('ana').count).toBe(1);
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS * 2);
    expect(h.msg('m1')).toMatchObject({ status: 'read', note: null });
    expect(h.view('ana')).toMatchObject({ held: null, queued: 0 });
    h.send('user', 'ana', 'second');
    await h.advance(DELIVERY_COALESCE_MS);
    expect(h.typed).toHaveLength(2);
    expect(h.msg('m2').note).toBe(CONFIRMING);
  });

  it('read_messages after the 2 s ends an unconfirmed latch as well', async () => {
    const { h } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    expect(h.view('ana').held).not.toBeNull();
    h.read('ana');
    expect(h.view('ana').held).toBeNull();
    h.send('user', 'ana', 'second');
    await h.advance(DELIVERY_COALESCE_MS);
    expect(h.typed).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 5.5: the Stop hook
 * ---------------------------------------------------------------------------------------------------------- */

describe('the Stop hook hands a pointer to a working agent (5.5)', () => {
  it('answers the exact block JSON, marks the message delivered and types nothing', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana', 'task', 'subject');
    const reply = h.hook('ana', 'Stop');
    expect(reply).toStrictEqual({ decision: 'block', reason: POINTER_ONE });
    expect(JSON.stringify(reply)).toBe('{"decision":"block","reason":"gonogo: 1 new message from user. Call read_messages."}');
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'handed over when its turn ended' });
    expect(h.view('ana')).toMatchObject({ state: 'working', queued: 0 });
    await h.advance(DELIVERY_COALESCE_MS * 3);
    expect(h.typed).toHaveLength(0);
  });

  it('names every sender in the reason', async () => {
    const h = await withAna();
    await h.hire('ben');
    h.work('ana');
    h.send('user', 'ana');
    h.send('ben', 'ana');
    expect(h.hook('ana', 'Stop').reason).toBe('gonogo: 2 new messages from user, ben. Call read_messages.');
  });

  it('never blocks while the user has a draft: the messages are held and the agent goes idle', async () => {
    const h = await withAna();
    h.work('ana');
    h.type('ana', 'draft');
    h.send('user', 'ana');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.view('ana')).toMatchObject({ state: 'idle', draft: true, queued: 1 });
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: "held: text in ana's input" });
    await h.advance(DELIVERY_SETTLE_MS * 3);
    expect(h.typed).toHaveLength(0);
  });

  it('never blocks the ids whose pointer is in flight, and a Stop that ended a turn does not confirm them', async () => {
    const { h, text } = await pointed();
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: CONFIRMING });
    // A new message is not in flight: it is handed over, the old one is left to its own pointer.
    h.send('user', 'ana', 'newer');
    expect(h.hook('ana', 'Stop')).toStrictEqual({ decision: 'block', reason: POINTER_ONE });
    expect(h.msg('m2')).toMatchObject({ status: 'delivered', note: 'handed over when its turn ended' });
    expect(h.msg('m1').note).toBe(CONFIRMING);
    expect(text).toBe(POINTER_ONE);
  });

  it('writes the state once: a block leaves working with no transient idle frame and no stateSince change', async () => {
    const h = await withAna();
    h.work('ana');
    await h.advance(1000);
    h.send('user', 'ana');
    const before = h.view('ana');
    const mark = h.events.length;
    h.hook('ana', 'Stop');
    const agentFrames = h.events.slice(mark).flatMap((event) => (event.t === 'agent' ? [event.agent] : []));
    expect(agentFrames.map((frame) => frame.state)).toEqual(['working']);
    expect(agentFrames[0]).toMatchObject({ queued: 0, stateSince: before.stateSince });
    expect(h.view('ana').stateSince).toBe(before.stateSince);
  });

  it('does nothing for a Stop with an unconfirmed pointer: the agent goes idle, the mail stays held', async () => {
    const { h } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    h.hook('ana', 'PreToolUse');
    h.send('user', 'ana', 'second');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.view('ana').state).toBe('idle');
    expect(h.msg('m2').status).toBe('held');
  });

  it('answers {} at the cap and the typed path delivers instead', async () => {
    const h = await withAna();
    h.work('ana');
    fillBlocks(h, 'ana');
    h.send('user', 'ana', 'one more');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.view('ana').state).toBe('idle');
    expect(h.typed).toHaveLength(0);
    h.setTitle('ana', 'idle');
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(1);
    expect(h.typed[0]?.text).toMatch(/^gonogo: \d+ new messages? from user\. Call read_messages\.$/);
  });

  it.each([
    ['PreToolUse', {}],
    ['PostToolUse', {}],
    ['PostToolUseFailure', {}],
    ['UserPromptSubmit', { prompt: 'a person typed this' }],
  ] as const)('a %s resets the block counter', async (event, payload) => {
    const h = await withAna();
    h.work('ana');
    fillBlocks(h, 'ana');
    h.hook('ana', event, payload);
    expect(blockCycle(h, 'ana').decision).toBe('block');
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 5.5 redeliver
 * ---------------------------------------------------------------------------------------------------------- */

describe('redeliver: a delivered message whose turn ended unread (5.5, conflict 16)', () => {
  async function deliveredOnce(): Promise<Harness> {
    const { h, text } = await pointed();
    h.prompt('ana', text);
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });
    return h;
  }
  const NOT_READ = 'not read: ana did not read it after two pointers';
  const AGAIN = 'waiting: ana has not read it yet';

  it('Stop: the message gets one more pointer, handed over at once; at the next Stop it says not read', async () => {
    const h = await deliveredOnce();
    expect(h.hook('ana', 'Stop')).toStrictEqual({ decision: 'block', reason: POINTER_ONE });
    expect(h.items('m1').map((item) => `${item.status}|${item.note}`)).toContain(`queued|${AGAIN}`);
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'handed over when its turn ended' });
    h.prompt('ana', 'a person typed this');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: NOT_READ });
    // Nothing more is typed or handed over, however many turns end.
    h.prompt('ana', 'again');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    await h.advance(30_000);
    expect(h.typed).toHaveLength(1);
    expect(h.msg('m1').note).toBe(NOT_READ);
  });

  it('StopFailure: back to the queue with the note, pointed at again, then not read', async () => {
    const h = await deliveredOnce();
    // Just after a sweep tick, so that only the check StopFailure scheduled can type within the settle delay.
    await h.alignToTick(RECONCILE_TICK_MS);
    h.hook('ana', 'StopFailure');
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: AGAIN });
    expect(h.view('ana').queued).toBe(1);
    h.setTitle('ana', 'idle');
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(2);
    h.prompt('ana', h.typed[1]?.text ?? '');
    expect(h.msg('m1').status).toBe('delivered');
    h.hook('ana', 'StopFailure');
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: NOT_READ });
    await h.advance(30_000);
    expect(h.typed).toHaveLength(2);
  });

  it('R1: a turn that ended without a Stop (an interrupt) is looked at too', async () => {
    const h = await deliveredOnce();
    h.setTitle('ana', 'idle');
    await h.advance(TITLE_IDLE_RECONCILE_MS + RECONCILE_TICK_MS);
    expect(h.view('ana').state).toBe('idle');
    expect(h.items('m1').map((item) => item.note)).toContain(AGAIN);
    expect(h.typed).toHaveLength(2);
    h.prompt('ana', h.typed[1]?.text ?? '');
    h.setTitle('ana', 'idle');
    await h.advance(TITLE_IDLE_RECONCILE_MS + RECONCILE_TICK_MS);
    expect(h.msg('m1').note).toBe(NOT_READ);
    expect(h.typed).toHaveLength(2);
  });

  it('R2: a dialog that was answered without a hook is looked at too', async () => {
    const h = await deliveredOnce();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.setScreen('ana', { promptBox: true, dialog: null });
    h.setTitle('ana', 'idle');
    await h.advance(NEEDS_YOU_CLEAR_MS + 1000);
    expect(h.view('ana').state).toBe('idle');
    expect(h.items('m1').map((item) => item.note)).toContain(AGAIN);
    expect(h.typed).toHaveLength(2);
  });

  it('a message that gets its second pointer goes in front of the newer ones', async () => {
    const h = await withAna();
    await h.hire('ben');
    h.work('ana');
    h.send('ben', 'ana', 'older');
    expect(h.hook('ana', 'Stop').reason).toBe('gonogo: 1 new message from ben. Call read_messages.');
    h.send('user', 'ana', 'newer');
    expect(h.hook('ana', 'Stop').reason).toBe('gonogo: 2 new messages from ben, user. Call read_messages.');
  });

  it('read_messages ends the bookkeeping: a read message is never looked at again', async () => {
    const h = await deliveredOnce();
    expect(h.read('ana').count).toBe(1);
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    h.hook('ana', 'StopFailure');
    expect(h.msg('m1')).toMatchObject({ status: 'read', note: null });
    await h.advance(DELIVERY_SETTLE_MS * 3);
    expect(h.typed).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 4.6: the draft latch
 * ---------------------------------------------------------------------------------------------------------- */

describe('the draft latch (4.6)', () => {
  it('onUserInput returns the effect of the chunk, for any agent', async () => {
    const h = await withAna();
    expect(h.type('ana', 'a')).toBe('set');
    expect(h.type('ana', '\r')).toBe('clear');
    expect(h.type('ana', '\x1b')).toBe('none');
    expect(h.type('ana', '\x1b[<0;41;13M')).toBe('none');
    expect(h.type('ana', '\x1b[I')).toBe('none');
    expect(h.type('ana', '\x1b[?1;2c')).toBe('none');
    expect(h.type('ana', '\x1b[200~text\x1b[201~')).toBe('set');
    expect(h.type('nobody', 'a')).toBe('set');
    expect(h.type('ana', 5 as unknown as string)).toBe('none');
  });

  it('printable text turns the latch on with one frame; more keystrokes add none', async () => {
    const h = await withAna();
    const before = h.frames('ana').length;
    h.type('ana', 'a');
    expect(h.view('ana')).toMatchObject({ draft: true, held: null });
    expect(h.frames('ana')).toHaveLength(before + 1);
    h.type('ana', 'b');
    expect(h.frames('ana')).toHaveLength(before + 1);
  });

  it('queued messages become held at once, with the exact view', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana');
    expect(h.msg('m1').note).toBe('waiting: ana is working');
    h.type('ana', 'abc');
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: "held: text in ana's input" });
    expect(h.view('ana')).toMatchObject({
      draft: true,
      queued: 1,
      held: { kind: 'draft', text: "held: text in ana's input" },
    });
  });

  it('leaves a message whose pointer is already typed alone: it is confirmed, not held', async () => {
    const { h, text } = await pointed();
    h.type('ana', 'abc');
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: CONFIRMING });
    h.send('user', 'ana', 'second');
    expect(h.msg('m2')).toMatchObject({ status: 'held', note: "held: text in ana's input" });
    h.prompt('ana', text);
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });
    expect(h.msg('m2').status).toBe('held');
  });

  it('is ignored while a dialog is on screen', async () => {
    const h = await withAna();
    h.setScreen('ana', { promptBox: false, dialog: 'permission' });
    expect(h.type('ana', '1')).toBe('set');
    expect(h.view('ana').draft).toBe(false);
  });

  it('is ignored while the state is needs_you', async () => {
    const h = await withAna();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    expect(h.type('ana', 'y')).toBe('set');
    expect(h.view('ana').draft).toBe(false);
  });

  it('a foreign UserPromptSubmit leaves the latch alone (claude queues a prompt typed while it works)', async () => {
    const h = await withAna();
    h.type('ana', 'abc');
    h.prompt('ana', 'something submitted earlier');
    expect(h.view('ana').draft).toBe(true);
  });

  it.each([
    ['Enter', '\r'],
    ['Ctrl-C', '\x03'],
  ])('%s clears it, releases the held messages at once with the wait note and types nothing by itself', async (_label, key) => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana');
    h.type('ana', 'abc');
    expect(h.type('ana', key)).toBe('clear');
    expect(h.view('ana')).toMatchObject({ draft: false, held: null, queued: 1 });
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'waiting: ana is working' });
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(0);
  });

  it('after Enter an idle agent gets its pointer within the settle delay', async () => {
    const h = await withAna();
    h.type('ana', 'abc');
    h.setScreen('ana', { promptBox: true, promptText: 'abc' });
    h.send('user', 'ana');
    await h.advance(1000);
    expect(h.msg('m1').status).toBe('held');
    expect(h.typed).toHaveLength(0);
    h.type('ana', '\r');
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: IDLE_NOTE });
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(1);
  });

  it('Escape alone does nothing: the text is still in claude\'s box', async () => {
    const h = await withAna();
    h.type('ana', 'abc');
    h.send('user', 'ana');
    expect(h.type('ana', '\x1b')).toBe('none');
    expect(h.view('ana').draft).toBe(true);
    expect(h.msg('m1').status).toBe('held');
  });

  describe('screen proof', () => {
    it('an empty box for DRAFT_SCREEN_CLEAR_MS after the last input clears the latch and releases the items', async () => {
      const h = await withAna();
      h.work('ana');
      h.send('user', 'ana');
      h.type('ana', 'abc');
      h.setScreen('ana', { promptBox: true, promptText: '' });
      await h.advance(DRAFT_SCREEN_CLEAR_MS - 600);
      expect(h.view('ana').draft).toBe(true);
      await h.advance(1200);
      expect(h.view('ana')).toMatchObject({ draft: false, held: null });
      expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'waiting: ana is working' });
    });

    it('counts from the last input of any kind, a focus report included', async () => {
      const h = await withAna();
      h.type('ana', 'abc');
      h.setScreen('ana', { promptBox: true, promptText: '' });
      await h.advance(700);
      h.type('ana', '\x1b[I');
      await h.advance(800);
      expect(h.view('ana').draft).toBe(true);
      await h.advance(700);
      expect(h.view('ana').draft).toBe(false);
    });

    it.each([
      ['a placeholder', { promptBox: true, promptText: 'Try "fix the bug"' }],
      ['text', { promptBox: true, promptText: 'abc' }],
      ['an unparsed screen', null],
      ['no prompt box', { promptBox: false, promptText: null }],
    ])('does not clear it for %s', async (_label, probe) => {
      const h = await withAna();
      h.type('ana', 'abc');
      h.setScreen('ana', probe);
      await h.advance(10_000);
      expect(h.view('ana').draft).toBe(true);
    });

    it('can end a latch but never starts one', async () => {
      const h = await withAna();
      h.setScreen('ana', { promptBox: true, promptText: 'abc' });
      await h.advance(5000);
      expect(h.view('ana').draft).toBe(false);
    });
  });

  it('expires after DRAFT_EXPIRY_MS: the mail goes in, typed after whatever the box holds', async () => {
    const h = await withAna();
    h.type('ana', 'abc');
    h.setScreen('ana', { promptBox: true, promptText: 'abc' });
    h.send('user', 'ana');
    await h.advance(DRAFT_EXPIRY_MS - 5000);
    expect(h.view('ana').draft).toBe(true);
    expect(h.typed).toHaveLength(0);
    await h.advance(6000);
    expect(h.view('ana').draft).toBe(false);
    expect(h.typed).toHaveLength(1);
    expect(h.msg('m1').note).toBe(CONFIRMING);
  });

  it('a keystroke renews the expiry', async () => {
    const h = await withAna();
    h.type('ana', 'a');
    h.setScreen('ana', { promptBox: true, promptText: 'a' });
    await h.advance(DRAFT_EXPIRY_MS - 60_000);
    h.type('ana', 'b');
    await h.advance(120_000);
    expect(h.view('ana').draft).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 5.7: hops and the trigger
 * ---------------------------------------------------------------------------------------------------------- */

describe('hops and the trigger (5.7)', () => {
  it('stamps 0 for the user, 1 without a trigger, and the highest hop of the trigger plus one', async () => {
    const h = await withAna();
    expect(h.msg(h.send('user', 'ana').id).hops).toBe(0);
    expect(h.msg(h.send('ana', 'user').id).hops).toBe(1);
    await h.hire('ben');
    h.send('user', 'ben');
    h.read('ben');
    h.send('ben', 'ana', 'hop one');
    h.send('user', 'ana', 'hop zero');
    h.read('ana');
    expect(h.msg(h.send('ana', 'ben').id).hops).toBe(2);
  });

  it('refuses hops above the cap: 9 at maxHops 8, with the exact note and ok false', async () => {
    const h = await withAna();
    await h.hire('ben');
    h.send('user', 'ana');
    let from = 'ana';
    let to = 'ben';
    for (let hop = 1; hop <= 8; hop += 1) {
      h.read(from);
      const result = h.send(from, to, 'ping');
      expect(result.ok, `hop ${hop}`).toBe(true);
      expect(h.msg(result.id).hops).toBe(hop);
      [from, to] = [to, from];
    }
    h.read(from);
    const refused = h.send(from, to, 'one more');
    expect(refused).toMatchObject({
      ok: false,
      status: 'undelivered',
      note: 'hop limit 8 reached; the message went to the user',
    });
    expect(h.msg(refused.id).hops).toBe(9);
    expect(h.view(to).queued).toBe(0);
    // A message to the user is never blocked.
    expect(h.send(from, 'user', 'report')).toMatchObject({ ok: true, status: 'to_user' });
  });

  it('honours a smaller cap from the options', async () => {
    const h = await withAna({ maxHops: 1 });
    await h.hire('ben');
    h.send('user', 'ana');
    h.read('ana');
    expect(h.send('ana', 'ben').ok).toBe(true);
    h.read('ben');
    expect(h.send('ben', 'ana')).toMatchObject({ ok: false, note: 'hop limit 1 reached; the message went to the user' });
  });

  const clearers: Array<[string, (h: Harness) => Promise<void>]> = [
    ['Stop', async (h) => void h.hook('ana', 'Stop')],
    ['StopFailure', async (h) => void h.hook('ana', 'StopFailure')],
    ['a prompt that is not our pointer', async (h) => void h.prompt('ana', 'typed by a person')],
    [
      'R1',
      async (h) => {
        h.work('ana');
        h.setTitle('ana', 'idle');
        await h.advance(TITLE_IDLE_RECONCILE_MS + RECONCILE_TICK_MS);
        expect(h.view('ana').state).toBe('idle');
      },
    ],
    [
      'R2',
      async (h) => {
        h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
        h.setTitle('ana', 'idle');
        await h.advance(NEEDS_YOU_CLEAR_MS + 1000);
        expect(h.view('ana').state).toBe('idle');
      },
    ],
    [
      'an exit and a restart',
      async (h) => {
        h.exit('ana');
        await h.hub.restart('ana');
      },
    ],
  ];
  it.each(clearers)('the trigger is cleared by %s', async (_label, clear) => {
    const h = await withAna();
    await armTrigger(h, 'ana');
    expect(nextHops(h, 'ana')).toBe(2);
    await clear(h);
    expect(nextHops(h, 'ana')).toBe(1);
  });

  it('a read that returns nothing keeps the trigger', async () => {
    const h = await withAna();
    await armTrigger(h, 'ana');
    expect(h.read('ana')).toStrictEqual({ count: 0, messages: [] });
    expect(nextHops(h, 'ana')).toBe(2);
  });

  it('the confirmation of our own pointer keeps the trigger', async () => {
    const h = await withAna();
    await armTrigger(h, 'ana');
    const next = h.send('user', 'ana', 'next');
    const text = await h.pointerTyped('ana');
    h.prompt('ana', text);
    expect(h.msg(next.id).status).toBe('delivered');
    expect(nextHops(h, 'ana')).toBe(2);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 5.2, 5.6: sending and reading
 * ---------------------------------------------------------------------------------------------------------- */

describe('sendFromAgent and sendFromUser validation (5.2)', () => {
  it('an unknown recipient lists the names and is not_found with field to', async () => {
    const h = await withAna();
    expectHubError(
      () => h.hub.sendFromAgent('ana', 1, { to: 'zed', subject: '', body: 'x' }),
      'not_found',
      'unknown recipient "zed". Known: flight, ana, boss, user',
      'to',
    );
    expectHubError(() => h.hub.sendFromUser({ to: 'zed', body: 'x' }), 'not_found', /^unknown recipient "zed"\. Known: /, 'to');
  });

  it('refuses a message to oneself, the boss through the alias included', async () => {
    const h = await withAna();
    expectHubError(() => h.hub.sendFromAgent('ana', 1, { to: 'ana', subject: '', body: 'x' }), 'bad_request', 'you cannot send a message to yourself', 'to');
    expectHubError(() => h.hub.sendFromAgent('flight', 1, { to: 'boss', subject: '', body: 'x' }), 'bad_request', 'you cannot send a message to yourself', 'to');
  });

  it('refuses an empty or whitespace body, and one over the limit; the limit itself is fine', async () => {
    const h = await withAna();
    const send = (body: unknown) => () => h.hub.sendFromAgent('ana', 1, { to: 'user', subject: '', body: body as string });
    expectHubError(send(''), 'bad_request', /body/, 'body');
    expectHubError(send('  \n\t '), 'bad_request', /body/, 'body');
    expectHubError(send(undefined), 'bad_request', /body/, 'body');
    expectHubError(send(42), 'bad_request', /body/, 'body');
    expectHubError(send('x'.repeat(20001)), 'bad_request', /20000/, 'body');
    expect(h.hub.sendFromAgent('ana', 1, { to: 'user', subject: '', body: 'x'.repeat(20000) }).ok).toBe(true);
  });

  it('refuses a subject over the limit; an agent may omit it', async () => {
    const h = await withAna();
    expectHubError(() => h.hub.sendFromAgent('ana', 1, { to: 'user', subject: 's'.repeat(201), body: 'x' }), 'bad_request', /subject/, 'subject');
    expect(h.hub.sendFromAgent('ana', 1, { to: 'user', subject: 's'.repeat(200), body: 'x' }).ok).toBe(true);
    const omitted = h.hub.sendFromAgent('ana', 1, { to: 'user', body: 'x' } as unknown as { to: string; subject: string; body: string });
    expect(h.msg(omitted.id).subject).toBe('');
  });

  it('refuses a recipient that is empty, too long or not text', async () => {
    const h = await withAna();
    for (const to of ['', 'a'.repeat(65), 7]) {
      expectHubError(() => h.hub.sendFromAgent('ana', 1, { to: to as string, subject: '', body: 'x' }), 'bad_request', /^to must/, 'to');
    }
    expectHubError(() => h.hub.sendFromAgent('ana', 1, null as unknown as { to: string; subject: string; body: string }), 'bad_request', /object/);
  });

  it('keeps the body as given and drops an inReplyTo that is not a message id', async () => {
    const h = await withAna();
    const first = h.hub.sendFromAgent('ana', 1, { to: 'user', subject: 's', body: '  padded  ', inReplyTo: 'abc' });
    expect(h.msg(first.id)).toMatchObject({ body: '  padded  ', inReplyTo: null, subject: 's' });
    const second = h.hub.sendFromAgent('ana', 1, { to: 'user', subject: '', body: 'x', inReplyTo: first.id });
    expect(h.msg(second.id).inReplyTo).toBe(first.id);
    const third = h.hub.sendFromAgent('ana', 1, { to: 'user', subject: '', body: 'x', inReplyTo: 'm1; drop' });
    expect(h.msg(third.id).inReplyTo).toBeNull();
  });

  it('the user cannot write to user; the subject is optional for the user', async () => {
    const h = await withAna();
    expectHubError(() => h.hub.sendFromUser({ to: 'user', body: 'x' }), 'bad_request', /user/, 'to');
    const sent = h.hub.sendFromUser({ to: 'ana', body: 'no subject' });
    expect(h.msg(sent.id)).toMatchObject({ from: 'user', subject: '', inReplyTo: null });
    expectHubError(() => h.hub.sendFromUser({ to: 'ana', body: '' }), 'bad_request', /body/, 'body');
  });

  it('the alias boss resolves to the boss\'s name', async () => {
    const h = await withAna();
    const result = h.hub.sendFromAgent('ana', 1, { to: 'boss', subject: '', body: 'x' });
    expect(result).toMatchObject({ to: 'flight' });
    expect(h.msg(result.id)).toMatchObject({ from: 'ana', to: 'flight' });
    expect(h.hub.sendFromUser({ to: 'boss', body: 'brief' }).to).toBe('flight');
  });

  it('an unknown sender is bad_request', async () => {
    const h = await withAna();
    expectHubError(() => h.hub.sendFromAgent('nobody', 1, { to: 'user', subject: '', body: 'x' }), 'bad_request', 'unknown sender');
  });
});

describe('a stale generation or a running transition (4.10 rule 7)', () => {
  it('sendFromAgent, readMessages and rosterFor refuse a generation that is not the current one', async () => {
    const h = await withAna();
    await h.hub.restart('ana');
    expect(h.gen('ana')).toBe(2);
    expectHubError(() => h.hub.sendFromAgent('ana', 1, { to: 'user', subject: '', body: 'x' }), 'conflict', 'this session has ended');
    expectHubError(() => h.hub.readMessages('ana', 1), 'conflict', 'this session has ended');
    expectHubError(() => h.hub.rosterFor('ana', 1), 'conflict', 'this session has ended');
    expect(h.hub.rosterFor('ana', 2).you).toBe('ana');
  });

  it('the same calls are refused while a stop, restart or remove is running', async () => {
    const h = await withAna();
    h.script.stopGate = gate();
    const release = h.script.stopGate;
    const stopping = h.hub.stop('ana');
    await settle();
    expectHubError(() => h.hub.sendFromAgent('ana', 1, { to: 'user', subject: '', body: 'x' }), 'conflict', 'this session has ended');
    expectHubError(() => h.hub.readMessages('ana', 1), 'conflict', 'this session has ended');
    expectHubError(() => h.hub.rosterFor('ana', 1), 'conflict', 'this session has ended');
    release.open();
    await stopping;
  });

  it('an unknown agent: an empty read and a not_found roster', async () => {
    const h = await withAna();
    expect(h.hub.readMessages('nobody', 1)).toStrictEqual({ count: 0, messages: [] });
    expectHubError(() => h.hub.rosterFor('nobody', 1), 'not_found', 'unknown agent');
  });
});

describe('read_messages (5.6)', () => {
  it('returns every unread message once, oldest first, whatever its status, and marks them read', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana', 'first');
    expect(h.hook('ana', 'Stop').decision).toBe('block');
    expect(h.msg('m1').status).toBe('delivered');
    h.send('user', 'ana', 'second');
    h.type('ana', 'abc');
    h.send('user', 'ana', 'third');
    expect([h.msg('m1').status, h.msg('m2').status, h.msg('m3').status]).toEqual(['delivered', 'held', 'held']);
    const result = h.read('ana');
    expect(result.count).toBe(3);
    expect(result.messages.map((message) => message.body)).toEqual(['first', 'second', 'third']);
    expect(result.messages[0]).toStrictEqual({ id: 'm1', from: 'user', subject: '', body: 'first', inReplyTo: null, at: h.msg('m1').at });
    for (const id of ['m1', 'm2', 'm3']) expect(h.msg(id)).toMatchObject({ status: 'read', note: null });
    expect(h.view('ana')).toMatchObject({ queued: 0, held: null });
    expect(h.read('ana')).toStrictEqual({ count: 0, messages: [] });
  });

  it('emits and logs the new status of each message', async () => {
    const h = await withAna();
    h.work('ana');
    const sent = h.send('ana', 'ana' === 'ana' ? 'flight' : 'x', 'for the boss');
    h.read('flight');
    expect(h.items(sent.id).map((item) => item.status)).toEqual(['queued', 'read']);
    expect(h.logged.filter((record) => record.id === sent.id).map((record) => record.status)).toEqual(['queued', 'read']);
    expect(h.logged[h.logged.length - 1]).toMatchObject({ id: sent.id, status: 'read', note: null });
  });

  it('returns the whole body, the activity item is cut', async () => {
    const h = await withAna();
    h.work('ana');
    const body = 'y'.repeat(ACTIVITY_WIRE_BODY_CHARS + 500);
    const sent = h.send('user', 'ana', body);
    expect(h.msg(sent.id)).toMatchObject({ truncated: true });
    expect(h.msg(sent.id).body).toHaveLength(ACTIVITY_WIRE_BODY_CHARS);
    expect(h.read('ana').messages[0]?.body).toHaveLength(ACTIVITY_WIRE_BODY_CHARS + 500);
    expect(h.msg(sent.id).truncated).toBe(true);
    const short = h.send('user', 'ana', 'short');
    expect(h.msg(short.id)).toMatchObject({ truncated: false, body: 'short' });
  });

  it('rosterFor lists the agents by desk with the role cut to 300 characters', async () => {
    const h = await withAna();
    await h.hub.hire({ name: 'wordy', role: 'r'.repeat(500), dir: '/work/wordy', mode: 'default' });
    h.work('ana');
    const roster = h.hub.rosterFor('ana', 1);
    expect(roster.you).toBe('ana');
    expect(roster.boss).toBe('flight');
    expect(roster.specialRecipients).toEqual(['boss', 'user']);
    expect(roster.agents.map((entry) => [entry.name, entry.state, entry.boss])).toEqual([
      ['flight', 'idle', true],
      ['ana', 'working', false],
      ['wordy', 'starting', false],
    ]);
    expect(roster.agents[2]?.role).toHaveLength(300);
    expect(roster.agents[1]?.role).toBe('ana does the ana work');
  });
});

describe('read_messages: one result is capped (SECPROC-2)', () => {
  const more = 'More messages are waiting: call read_messages again to read them.';
  const sendMany = (h: Harness, count: number, body = 'hello'): void => {
    for (let index = 0; index < count; index += 1) h.send('user', 'ana', body);
  };

  it('returns at most READ_MAX_MESSAGES messages, leaves the rest unread and says how many are left', async () => {
    const h = await withAna();
    h.work('ana');
    sendMany(h, READ_MAX_MESSAGES + 5);
    const first = h.read('ana');
    expect(first.count).toBe(READ_MAX_MESSAGES);
    expect(first.messages.map((message) => message.id)).toEqual(Array.from({ length: READ_MAX_MESSAGES }, (_, index) => `m${index + 1}`));
    expect(first.remaining).toBe(5);
    expect(first.note).toBe(more);
    for (let index = 1; index <= READ_MAX_MESSAGES; index += 1) expect(h.msg(`m${index}`)).toMatchObject({ status: 'read', note: null });
    for (let index = READ_MAX_MESSAGES + 1; index <= READ_MAX_MESSAGES + 5; index += 1) {
      expect(h.msg(`m${index}`)).toMatchObject({ status: 'queued', note: 'waiting: ana is working' });
    }
    expect(h.view('ana').queued).toBe(5);

    const second = h.read('ana');
    expect(second.messages.map((message) => message.id)).toEqual(['m21', 'm22', 'm23', 'm24', 'm25']);
    expect(second.count).toBe(5);
    expect(second).not.toHaveProperty('remaining');
    expect(second).not.toHaveProperty('note');
    expect(h.view('ana').queued).toBe(0);
    expect(h.read('ana')).toStrictEqual({ count: 0, messages: [] });
  });

  it('stops at READ_MAX_CHARS of JSON too, whichever comes first, and the result stays under it', async () => {
    const h = await withAna();
    h.work('ana');
    for (let index = 0; index < 4; index += 1) h.send('user', 'ana', `${index}`.padEnd(15_000, 'z'));
    const first = h.read('ana');
    expect(first.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
    expect(first).toMatchObject({ count: 2, remaining: 2, note: more });
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(READ_MAX_CHARS);
    const second = h.read('ana');
    expect(second.messages.map((message) => message.id)).toEqual(['m3', 'm4']);
    expect(second).not.toHaveProperty('remaining');
  });

  it('always returns the first message, even when its JSON alone is over the cap (it would never be read otherwise)', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana', '"'.repeat(BODY_MAX_CHARS)); // every quote is two characters in JSON
    h.send('user', 'ana', 'next');
    const first = h.read('ana');
    expect(JSON.stringify(first.messages[0]).length).toBeGreaterThan(READ_MAX_CHARS);
    expect(first).toMatchObject({ count: 1, remaining: 1 });
    expect(h.read('ana').messages.map((message) => message.body)).toEqual(['next']);
  });

  it('what did not fit was not read, even if its pointer had gone out: it is queued again and the pointer counters go on', async () => {
    const h = await withAna();
    h.work('ana');
    sendMany(h, 25);
    expect(h.hook('ana', 'Stop')).toEqual({ decision: 'block', reason: 'gonogo: 25 new messages from user. Call read_messages.' });
    expect(h.msg('m25').status).toBe('delivered');
    expect(h.read('ana')).toMatchObject({ count: READ_MAX_MESSAGES, remaining: 5 });
    expect(h.msg('m25')).toMatchObject({ status: 'queued', note: 'waiting: ana is working' });
    expect(h.view('ana').queued).toBe(5);
    // The turn ends without a second read: the Stop rule points at the five once more (their second pointer) ...
    expect(h.hook('ana', 'Stop')).toEqual({ decision: 'block', reason: 'gonogo: 5 new messages from user. Call read_messages.' });
    expect(h.msg('m21')).toMatchObject({ status: 'delivered', note: 'handed over when its turn ended' });
    // ... and when that is ignored too, there is no third one.
    expect(h.hook('ana', 'Stop')).toEqual({});
    expect(h.msg('m21')).toMatchObject({ status: 'delivered', note: 'not read: ana did not read it after two pointers' });
  });

  it('a draft latch holds what is left over', async () => {
    const h = await withAna();
    h.work('ana');
    sendMany(h, 25);
    h.type('ana', 'half a sentence');
    expect(h.read('ana')).toMatchObject({ count: READ_MAX_MESSAGES, remaining: 5 });
    expect(h.msg('m21')).toMatchObject({ status: 'held', note: "held: text in ana's input" });
    expect(h.view('ana')).toMatchObject({ queued: 5, held: { kind: 'draft' } });
  });

  it('ends the confirmation of a pointer in flight, and the delivery check then points at the rest', async () => {
    const h = await withAna();
    sendMany(h, 25);
    expect(await h.pointerTyped('ana')).toBe('gonogo: 25 new messages from user. Call read_messages.');
    expect(h.msg('m21').note).toBe(CONFIRMING);
    h.script.typeResult = false; // nothing more can be typed, so a latch could only come from the cancelled confirmation
    expect(h.read('ana')).toMatchObject({ count: READ_MAX_MESSAGES, remaining: 5 });
    expect(h.msg('m21')).toMatchObject({ status: 'queued', note: IDLE_NOTE });
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS + RECONCILE_TICK_MS);
    expect(h.view('ana')).toMatchObject({ queued: 5, held: null });
    h.script.typeResult = true;
    await h.advance(RECONCILE_TICK_MS);
    expect(h.typed.at(-1)).toEqual({ name: 'ana', generation: 1, text: 'gonogo: 5 new messages from user. Call read_messages.' });
  });
});

describe('limits on mail (SECPROC-1)', () => {
  const FULL = 'mailbox full: ana has too many unread messages';

  it('a recipient holds at most MAILBOX_MAX_MESSAGES unread messages: the next is undelivered, and the sender is told', async () => {
    const h = await withAna();
    h.work('ana');
    for (let index = 0; index < MAILBOX_MAX_MESSAGES; index += 1) expect(h.send('user', 'ana')).toMatchObject({ ok: true, status: 'queued' });
    const refused = h.send('user', 'ana', 'one too many');
    expect(refused).toEqual({ ok: false, id: `m${MAILBOX_MAX_MESSAGES + 1}`, to: 'ana', status: 'undelivered', note: FULL });
    expect(h.msg(refused.id)).toMatchObject({ status: 'undelivered', note: FULL, body: 'one too many' });
    expect(h.logged.at(-1)).toMatchObject({ id: refused.id, status: 'undelivered', note: FULL });
    expect(h.view('ana').queued).toBe(MAILBOX_MAX_MESSAGES);
    // An agent as the sender gets the same answer (the MCP tool shows it as an error).
    expect(h.send('flight', 'ana')).toMatchObject({ ok: false, status: 'undelivered', note: FULL });
    // Reading makes room again.
    expect(h.read('ana').count).toBe(READ_MAX_MESSAGES);
    expect(h.send('user', 'ana')).toMatchObject({ ok: true, status: 'queued' });
    // The refused ones are not mail: they are never read.
    expect(h.read('ana').messages.every((message) => message.body !== 'one too many')).toBe(true);
  });

  it('counts the bodies too: MAILBOX_MAX_BODY_CHARS of unread text is the limit, whatever the number of messages', async () => {
    const h = await withAna();
    h.work('ana');
    const fits = Math.floor(MAILBOX_MAX_BODY_CHARS / BODY_MAX_CHARS);
    for (let index = 0; index < fits; index += 1) expect(h.send('user', 'ana', 'x'.repeat(BODY_MAX_CHARS)).ok).toBe(true);
    expect(h.send('user', 'ana', 'x'.repeat(BODY_MAX_CHARS))).toMatchObject({ ok: false, note: FULL });
    // What is left of the room still takes a small one.
    expect(h.send('user', 'ana', 'small').ok).toBe(true);
  });

  it('a message whose pointer went out is still unread: delivered mail counts', async () => {
    const h = await withAna();
    h.work('ana');
    for (let index = 0; index < MAILBOX_MAX_MESSAGES; index += 1) h.send('user', 'ana');
    expect(h.hook('ana', 'Stop').decision).toBe('block');
    expect(h.msg('m1').status).toBe('delivered');
    expect(h.view('ana').queued).toBe(0);
    expect(h.send('user', 'ana')).toMatchObject({ ok: false, note: FULL });
  });

  it('a full mailbox does not stop mail to the others', async () => {
    const h = await withAna();
    await h.hire('ben');
    h.work('ana');
    for (let index = 0; index < MAILBOX_MAX_MESSAGES; index += 1) h.send('user', 'ana');
    expect(h.send('user', 'ben')).toMatchObject({ ok: true });
    expect(h.send('ana', 'flight')).toMatchObject({ ok: true });
  });

  it('an agent may send SEND_RATE_MAX messages per rolling minute: the next is undelivered and says so', async () => {
    const h = await withAna();
    for (let index = 0; index < SEND_RATE_MAX; index += 1) expect(h.send('ana', 'user').ok).toBe(true);
    const refused = h.send('ana', 'user', 'one too many');
    expect(refused).toEqual({
      ok: false,
      id: `m${SEND_RATE_MAX + 1}`,
      to: 'user',
      status: 'undelivered',
      note: 'rate limit: ana sent too many messages this minute',
    });
    expect(h.msg(refused.id)).toMatchObject({ status: 'undelivered', note: 'rate limit: ana sent too many messages this minute' });
    expect(h.logged.at(-1)).toMatchObject({ id: refused.id, status: 'undelivered' });
    // The limit is the sender's: another agent is not affected.
    expect(h.send('flight', 'user').ok).toBe(true);
  });

  it('a flood is on record once, not once per message: the sender is told every time, the log, the strip and the browsers once', async () => {
    const h = await withAna();
    for (let index = 0; index < SEND_RATE_MAX; index += 1) h.send('ana', 'user');
    const frames = h.events.length;
    const logged = h.logged.length;
    const results = Array.from({ length: 50 }, () => h.send('ana', 'user', 'x'.repeat(BODY_MAX_CHARS)));
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, status: 'undelivered', note: 'rate limit: ana sent too many messages this minute' });
    }
    expect(new Set(results.map((result) => result.id)).size).toBe(50);
    expect(h.logged).toHaveLength(logged + 1);
    expect(h.events).toHaveLength(frames + 1);
    expect(h.hub.activity().filter((item) => item.status === 'undelivered')).toHaveLength(1);
  });

  it('a refused message never reaches the recipient, whoever the recipient is', async () => {
    const h = await withAna();
    await h.hire('ben');
    for (let index = 0; index < SEND_RATE_MAX; index += 1) h.send('ana', 'user');
    expect(h.send('ana', 'ben', 'refused')).toMatchObject({ ok: false, status: 'undelivered' });
    expect(h.view('ben').queued).toBe(0);
    expect(h.read('ben')).toStrictEqual({ count: 0, messages: [] });
    await h.hub.stop('ben');
    expect(h.send('ana', 'ben')).toMatchObject({ ok: false, note: 'rate limit: ana sent too many messages this minute' });
  });

  it('the window rolls: a minute after the first message there is room again, and refused sends are not counted', async () => {
    const h = await withAna();
    for (let index = 0; index < SEND_RATE_MAX; index += 1) h.send('ana', 'user');
    await h.advance(SEND_RATE_WINDOW_MS / 2);
    for (let index = 0; index < 5; index += 1) expect(h.send('ana', 'user').ok).toBe(false);
    await h.advance(SEND_RATE_WINDOW_MS / 2 - 1);
    expect(h.send('ana', 'user').ok).toBe(false);
    await h.advance(1);
    for (let index = 0; index < SEND_RATE_MAX; index += 1) expect(h.send('ana', 'user').ok).toBe(true);
    expect(h.send('ana', 'user').ok).toBe(false);
    // The next flood is a new fact: it is on record again.
    expect(h.logged.filter((record) => record.status === 'undelivered')).toHaveLength(2);
  });

  it('the owner is not limited', async () => {
    const h = await withAna();
    h.work('ana');
    for (let index = 0; index < 90; index += 1) {
      expect(h.send('user', 'ana').ok).toBe(true);
      expect(h.send('user', 'flight').ok).toBe(true);
    }
  });
});

describe('what the hub keeps in memory is bounded (SECPROC-1)', () => {
  /** Node's `gc`, switched on at run time so that the test needs no flag. */
  const collect = (): number => {
    setFlagsFromString('--expose-gc');
    (runInNewContext('gc') as () => void)();
    return process.memoryUsage().heapUsed;
  };

  /** Messages to a stopped agent are undelivered at once: the cheapest way to push older ones out of the list. */
  async function withGone(): Promise<Harness> {
    const h = await withAna();
    await h.hire('gone');
    await h.hub.stop('gone');
    h.work('ana');
    return h;
  }

  it('a message that was unread while newer ones pushed it out of the list is dropped once it has been read', async () => {
    const h = await withGone();
    const unreadPerCycle = Math.floor(MAILBOX_MAX_BODY_CHARS / BODY_MAX_CHARS);
    const before = collect();
    for (let cycle = 0; cycle < 80; cycle += 1) {
      for (let index = 0; index < unreadPerCycle; index += 1) {
        expect(h.send('user', 'ana', `${cycle * 100 + index}`.padEnd(BODY_MAX_CHARS, 'x')).ok).toBe(true);
      }
      for (let index = 0; index < ACTIVITY_HUB_MAX * 2 + 50; index += 1) h.send('user', 'gone', 'filler');
      let read = 0;
      for (let result = h.read('ana'); ; result = h.read('ana')) {
        read += result.count;
        if (result.remaining === undefined) break;
      }
      expect(read).toBe(unreadPerCycle);
      h.logged.length = 0; // the harness records every body; what is measured is the hub's own map
      h.events.length = 0;
    }
    const kept = collect() - before;
    expect(kept).toBeLessThan(8 * 1024 * 1024); // the old code kept about 260 KB of read mail per cycle: 21 MB
  });

  it('the activity list still shows the newest ACTIVITY_HUB_MAX, and unread mail that left it can be read', async () => {
    const h = await withGone();
    for (let index = 0; index < 30; index += 1) h.send('user', 'ana', `waiting ${index}`);
    for (let index = 0; index < ACTIVITY_HUB_MAX * 3; index += 1) h.send('user', 'gone', `filler ${index}`);
    expect(h.hub.activity()).toHaveLength(ACTIVITY_HUB_MAX);
    expect(h.hub.activity().some((item) => item.id === 'm1')).toBe(false);
    const first = h.read('ana');
    expect(first.messages.map((message) => message.body).slice(0, 2)).toEqual(['waiting 0', 'waiting 1']);
    expect(first.count + (first.remaining ?? 0)).toBe(30);
  });
});

describe('activity() (2.1 rule 6)', () => {
  it('is newest first and holds at most ACTIVITY_HUB_MAX items', async () => {
    const h = await withAna();
    await sendReports(h, 'ana', 450);
    const items = h.hub.activity();
    expect(items).toHaveLength(ACTIVITY_HUB_MAX);
    expect(items[0]?.id).toBe('m450');
    expect(items[ACTIVITY_HUB_MAX - 1]?.id).toBe('m251');
    // Older items stay in the log only.
    expect(h.logged.filter((record) => record.id === 'm1')).toHaveLength(1);
  });

  it('keeps an unread message readable after newer ones pushed it out of the list', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana', 'still waiting');
    await sendReports(h, 'ana', 450);
    expect(h.hub.activity().some((item) => item.id === 'm1')).toBe(false);
    expect(h.read('ana').messages.map((message) => message.body)).toEqual(['still waiting']);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 4.9: lifecycle
 * ---------------------------------------------------------------------------------------------------------- */

function rosterRecord(name: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name,
    role: `${name} role`,
    dir: `/work/${name}`,
    mode: 'default',
    sessionId: UUID_B,
    desk: 1,
    boss: false,
    createdAt: T0 - 1000,
    ...extra,
  };
}

function historyRecord(id: string, status: MessageRecord['status'], extra: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    from: 'user',
    to: 'ana',
    subject: '',
    body: `body of ${id}`,
    inReplyTo: null,
    hops: 0,
    at: T0 - 5000 + Number(id.slice(1)),
    status,
    note: null,
    updatedAt: T0 - 5000,
    ...extra,
  };
}

describe('start (4.9)', () => {
  it('creates the boss on a first run: flight, desk 0, the boss role, the boss directory, default mode', async () => {
    const h = makeHarness();
    await h.hub.start();
    await settle();
    expect(h.hub.views()).toHaveLength(1);
    expect(h.view('flight')).toMatchObject({
      name: 'flight',
      role: BOSS_ROLE,
      dir: '/work/boss',
      mode: 'default',
      desk: 0,
      boss: true,
      state: 'starting',
      generation: 1,
    });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toStrictEqual({
      version: 1,
      agents: [
        {
          name: 'flight',
          role: BOSS_ROLE,
          dir: '/work/boss',
          mode: 'default',
          sessionId: '00000000-0000-4000-8000-000000000001',
          desk: 0,
          boss: true,
          createdAt: T0,
          position: 'flight',
        },
      ],
    });
    expect(h.view('flight').position).toBe('flight');
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]).toMatchObject({ generation: 1, flag: null });
  });

  it.each([
    [['flight'], 'flight-2'],
    [['flight', 'flight-2'], 'flight-3'],
  ])('takes the first free name when %j exist', async (taken, expected) => {
    const h = makeHarness({ roster: taken.map((name, index) => rosterRecord(name, { desk: index + 1 })) });
    await h.hub.start();
    await settle();
    expect(h.hub.views().find((agent) => agent.boss)?.name).toBe(expected);
  });

  it('keeps an existing boss, starts only the boss and leaves the others stopped', async () => {
    const h = makeHarness({
      roster: [rosterRecord('lead', { boss: true, desk: 0 }), rosterRecord('ana', { desk: 1 })],
    });
    await h.hub.start();
    await settle();
    expect(h.saves).toHaveLength(0);
    expect(h.spawns.map((request) => request.agent.name)).toEqual(['lead']);
    expect(h.view('lead').state).toBe('starting');
    expect(h.view('ana')).toMatchObject({ state: 'stopped', generation: 0, exit: null });
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['lead', 'ana']);
  });

  it('is idempotent', async () => {
    const h = makeHarness();
    const first = h.hub.start();
    const second = h.hub.start();
    expect(second).toBe(first);
    await first;
    expect(h.spawns).toHaveLength(1);
  });

  it('converts what the log still shows as queued, held or delivered into undelivered, logged and emitted', async () => {
    const history = [
      historyRecord('m1', 'read'),
      historyRecord('m2', 'queued', { note: 'waiting: ana is working' }),
      historyRecord('m3', 'held', { note: "held: text in ana's input" }),
      historyRecord('m4', 'delivered', { note: 'pointer typed' }),
      historyRecord('m5', 'to_user', { from: 'ana', to: 'user' }),
      historyRecord('m6', 'undelivered', { note: 'ana is stopped; the message went to the user' }),
    ];
    const h = makeHarness({ roster: [rosterRecord('flight', { boss: true, desk: 0 })], history });
    await h.hub.start();
    await settle();
    const note = 'server restarted before it was read; the message went to the user';
    const items = new Map(h.hub.activity().map((item) => [item.id, item]));
    for (const id of ['m2', 'm3', 'm4']) expect(items.get(id), id).toMatchObject({ status: 'undelivered', note });
    expect(items.get('m1')).toMatchObject({ status: 'read', note: null });
    expect(items.get('m5')).toMatchObject({ status: 'to_user' });
    expect(items.get('m6')?.note).toBe('ana is stopped; the message went to the user');
    expect(h.hub.activity().map((item) => item.id)).toEqual(['m6', 'm5', 'm4', 'm3', 'm2', 'm1']);
    expect(h.logged.map((record) => [record.id, record.status, record.note])).toEqual([
      ['m2', 'undelivered', note],
      ['m3', 'undelivered', note],
      ['m4', 'undelivered', note],
    ]);
    expect(h.logged[0]?.body).toBe('body of m2');
    expect(h.items('m2')).toHaveLength(1);
  });

  it('survives a history with records that are not usable', async () => {
    const history = [
      null,
      5,
      { id: 'm9' },
      { id: 'm8', from: 'a', to: 'b', body: 'x', status: 'bogus' },
      historyRecord('m7', 'read'),
      historyRecord('m7', 'queued'),
    ];
    const h = makeHarness({ history: history as unknown as MessageRecord[] });
    await h.hub.start();
    expect(h.hub.activity().map((item) => [item.id, item.status])).toEqual([['m7', 'read']]);
  });

  it('carries on when the history cannot be loaded, and fails when the roster cannot', async () => {
    const h = makeHarness();
    h.io.loadHistory = async () => {
      throw new Error('log unreadable');
    };
    await h.hub.start();
    expect(h.warnings).toContain('could not load the message history');
    expect(h.hub.activity()).toEqual([]);

    const g = makeHarness();
    g.io.loadRoster = async () => {
      throw new Error('agents.json is corrupt: fix or delete it');
    };
    await expect(g.hub.start()).rejects.toThrow('agents.json is corrupt: fix or delete it');
  });

  it('a boss that cannot start is stopped with the reason, and start() still resolves', async () => {
    const h = makeHarness();
    h.script.spawnError = 'no pty';
    await h.hub.start();
    expect(h.view('flight')).toMatchObject({
      state: 'stopped',
      exit: { code: null, signal: null, requested: false, text: 'could not start: no pty' },
    });
  });
});

describe('hire (4.9)', () => {
  const good = { name: 'ana', role: 'does things', dir: '/work/ana', mode: 'default' };
  const hireWith = (h: Harness, patch: Record<string, unknown>): Promise<AgentView> =>
    h.hub.hire({ ...good, ...patch } as unknown as HireRequest);

  it('creates the record, saves the roster and starts the process; the view is starting', async () => {
    const h = await started();
    const saves = h.saves.length;
    const view = await h.hub.hire({ name: 'ana', role: '  does things  ', dir: '/work/ana/', mode: 'acceptEdits' });
    expect(view).toStrictEqual({
      name: 'ana',
      role: 'does things',
      dir: '/work/ana',
      mode: 'acceptEdits',
      desk: 1,
      boss: false,
      state: 'starting',
      stateSince: T0,
      needsKind: null,
      needsReason: null,
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
      needSeq: null,
      remoteControl: null,
      permissions: null,
      autostart: true,
      model: null,
      keys: {},
      doing: null,
      subagents: { running: 0, started: 0, types: {} },
      history: [{ state: 'starting', at: T0 }],
    });
    expect(h.saves).toHaveLength(saves + 1);
    const saved = h.saves[h.saves.length - 1]?.agents ?? [];
    expect(saved.map((record) => record.name)).toEqual(['flight', 'ana']);
    expect(saved[1]).toStrictEqual({
      name: 'ana',
      role: 'does things',
      dir: '/work/ana',
      mode: 'acceptEdits',
      sessionId: '00000000-0000-4000-8000-000000000002',
      desk: 1,
      boss: false,
      createdAt: T0,
    });
    expect(h.spawns[h.spawns.length - 1]).toStrictEqual({ agent: saved[1], generation: 1, flag: null });
  });

  const rejected: Array<[string, Record<string, unknown>, ApiErrorCode, string | RegExp, string | undefined]> = [
    ['an upper-case name', { name: 'Ana2' }, 'bad_request', /^name must be/, 'name'],
    ['a name that starts with a hyphen', { name: '-ana' }, 'bad_request', /^name must be/, 'name'],
    ['an empty name', { name: '' }, 'bad_request', /^name must be/, 'name'],
    ['a name of 33 characters', { name: 'a'.repeat(33) }, 'bad_request', /^name must be/, 'name'],
    ['a name that is not text', { name: 5 }, 'bad_request', /^name must be/, 'name'],
    ['a name with a slash', { name: 'a/b' }, 'bad_request', /^name must be/, 'name'],
    ['the reserved name user', { name: 'user' }, 'bad_request', /reserved/, 'name'],
    ['the reserved name boss', { name: 'boss' }, 'bad_request', /reserved/, 'name'],
    ['a name that is taken', { name: 'ana' }, 'conflict', 'an agent named "ana" already exists', 'name'],
    ['the name of the boss', { name: 'flight' }, 'conflict', 'an agent named "flight" already exists', 'name'],
    ['an empty role', { name: 'b', role: '' }, 'bad_request', 'role must be 1 to 4000 characters', 'role'],
    ['a role of blanks', { name: 'b', role: ' \n ' }, 'bad_request', /^role must be/, 'role'],
    ['a role over 4000 characters', { name: 'b', role: 'r'.repeat(4001) }, 'bad_request', /^role must be/, 'role'],
    ['a role that is not text', { name: 'b', role: 7 }, 'bad_request', /^role must be/, 'role'],
    ['a mode that does not exist', { name: 'b', mode: 'root' }, 'bad_request', /^mode must be one of/, 'mode'],
    ['no mode', { name: 'b', mode: undefined }, 'bad_request', /^mode must be one of/, 'mode'],
    ['a relative directory', { name: 'b', dir: 'relative/dir' }, 'bad_request', 'directory must be an absolute path', 'dir'],
    ['a directory that does not exist', { name: 'b', dir: '/missing' }, 'bad_request', 'directory does not exist: /missing', 'dir'],
    ['an empty directory', { name: 'b', dir: '' }, 'bad_request', /^dir must be/, 'dir'],
    ['a directory over 1024 characters', { name: 'b', dir: `/${'d'.repeat(1024)}` }, 'bad_request', /^dir must be/, 'dir'],
    ['a directory that is not text', { name: 'b', dir: 7 }, 'bad_request', /^dir must be/, 'dir'],
    ['bypassPermissions without confirmBypass', { name: 'b', mode: 'bypassPermissions' }, 'bad_request', /confirmBypass/, 'confirmBypass'],
    [
      'bypassPermissions with a confirmBypass that is not true',
      { name: 'b', mode: 'bypassPermissions', confirmBypass: 'yes' },
      'bad_request',
      /confirmBypass/,
      'confirmBypass',
    ],
  ];
  it.each(rejected)('rejects %s and changes nothing', async (_label, patch, code, message, field) => {
    const h = await started();
    h.script.missingDirs.add('/missing');
    await hireWith(h, {});
    const before = { views: h.hub.views().length, saves: h.saves.length, spawns: h.spawns.length };
    await expectHubReject(hireWith(h, patch), code, message, field);
    expect({ views: h.hub.views().length, saves: h.saves.length, spawns: h.spawns.length }).toStrictEqual(before);
  });

  it.each([
    ['the name before the role', { name: 'Bad', role: '' }, 'name'],
    ['uniqueness before the role', { name: 'ana', role: '' }, 'name'],
    ['the role before the mode', { name: 'b', role: '', mode: 'x' }, 'role'],
    ['the mode before the directory', { name: 'b', mode: 'x', dir: 'rel' }, 'mode'],
    ['the directory before confirmBypass', { name: 'b', dir: 'rel', mode: 'bypassPermissions' }, 'dir'],
  ])('checks %s', async (_label, patch, field) => {
    const h = await started();
    await hireWith(h, {});
    const error = (await hireWith(h, patch).catch((caught: unknown) => caught)) as HubError;
    expect(error.name).toBe('HubError');
    expect(error.field).toBe(field);
  });

  it('refuses a hire when the operations room is full, before it looks at the other fields', async () => {
    const h = await started();
    for (let count = 1; h.hub.views().length < MAX_AGENTS; count += 1) await h.hireRaw(`a${count}`);
    expect(h.hub.views()).toHaveLength(MAX_AGENTS);
    await expectHubReject(hireWith(h, { name: 'extra', role: '' }), 'conflict', `the operations room is full (${MAX_AGENTS} agents)`);
    await h.hub.remove('a1');
    expect((await hireWith(h, { name: 'extra' })).state).toBe('starting');
  });

  it('hands out the lowest unused desk; the boss keeps desk 0 and views() is sorted by desk', async () => {
    const h = await started();
    await h.hireRaw('a');
    await h.hireRaw('b');
    await h.hireRaw('c');
    expect(h.hub.views().map((agent) => [agent.name, agent.desk])).toEqual([
      ['flight', 0],
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    await h.hub.remove('b');
    await h.hireRaw('d');
    expect(h.view('d').desk).toBe(2);
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight', 'a', 'd', 'c']);
  });

  it('two hires at once get different desks and both reach the roster', async () => {
    const h = await started();
    h.script.saveGate = gate();
    const release = h.script.saveGate;
    const first = hireWith(h, { name: 'a' });
    const second = hireWith(h, { name: 'b' });
    await settle();
    release.open();
    const views = await Promise.all([first, second]);
    expect(views.map((view) => view.desk).sort()).toEqual([1, 2]);
    expect(h.saves[h.saves.length - 1]?.agents.map((record) => record.name).sort()).toEqual(['a', 'b', 'flight']);
  });

  it('two hires of one name at once: one wins, the other is a conflict', async () => {
    const h = await started();
    const results = await Promise.allSettled([hireWith(h, {}), hireWith(h, {})]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(h.hub.views().filter((agent) => agent.name === 'ana')).toHaveLength(1);
  });

  it('a roster that cannot be saved is an internal error and nothing is created', async () => {
    const h = await started();
    h.script.saveError = 'disk full';
    await expectHubReject(hireWith(h, {}), 'internal', 'could not save the roster: disk full');
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
    expect(h.spawns).toHaveLength(1);
    h.script.saveError = null;
    expect((await hireWith(h, {})).desk).toBe(1);
  });

  it('a hire that cannot spawn answers the view in state stopped, with the reason, and keeps the agent', async () => {
    const h = await started();
    h.script.spawnError = 'no pty';
    const view = await hireWith(h, {});
    expect(view).toMatchObject({
      state: 'stopped',
      generation: 1,
      exit: { code: null, signal: null, requested: false, text: 'could not start: no pty' },
    });
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight', 'ana']);
    expect(h.frames('ana').map((frame) => frame.state)).toEqual(['stopped']);
    h.script.spawnError = null;
    expect((await h.hub.restart('ana')).state).toBe('starting');
  });
});

describe('edit (4.9)', () => {
  it('needs at least one known field and an agent that exists', async () => {
    const h = await withAna();
    await expectHubReject(h.hub.edit('ana', {}), 'bad_request', /^nothing to change/);
    await expectHubReject(h.hub.edit('ana', { size: 4 } as unknown as EditRequest), 'bad_request', /^nothing to change/);
    await expectHubReject(h.hub.edit('ana', null as unknown as EditRequest), 'bad_request', /object/);
    await expectHubReject(h.hub.edit('nobody', { role: 'x' }), 'not_found', 'unknown agent');
  });

  it('changes apply at the next start: dirty shows while the agent runs, role is trimmed, the roster is saved', async () => {
    const h = await withAna();
    const saves = h.saves.length;
    const view = await h.hub.edit('ana', { role: '  a new role  ', dir: '/work/other/', mode: 'acceptEdits' });
    expect(view).toMatchObject({ role: 'a new role', dir: '/work/other', mode: 'acceptEdits', dirty: true, state: 'idle' });
    expect(h.frames('ana').at(-1)).toMatchObject({ role: 'a new role', dirty: true });
    expect(h.saves).toHaveLength(saves + 1);
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')).toMatchObject({
      role: 'a new role',
      dir: '/work/other',
      mode: 'acceptEdits',
    });
    expect(h.spawns.at(-1)?.agent.role).toBe('ana does the ana work');
    await h.hub.restart('ana');
    expect(h.view('ana').dirty).toBe(false);
    expect(h.spawns.at(-1)?.agent).toMatchObject({ role: 'a new role', dir: '/work/other', mode: 'acceptEdits' });
  });

  it.each([
    ['role', { role: 'something else' }],
    ['dir', { dir: '/work/elsewhere' }],
    ['mode', { mode: 'acceptEdits' }],
  ] as const)('editing only the %s makes a running agent dirty', async (_field, patch) => {
    const h = await withAna();
    expect(h.view('ana').dirty).toBe(false);
    await h.hub.edit('ana', patch as EditRequest);
    expect(h.view('ana').dirty).toBe(true);
    // Putting it back is not dirty any more.
    await h.hub.edit('ana', { role: 'ana does the ana work', dir: '/work/ana', mode: 'default' });
    expect(h.view('ana').dirty).toBe(false);
  });

  it('a stopped agent is never dirty', async () => {
    const h = await withAna();
    await h.hub.edit('ana', { role: 'something else' });
    await h.hub.stop('ana');
    expect(h.view('ana')).toMatchObject({ state: 'stopped', dirty: false });
  });

  it('a change that changes nothing saves nothing and emits nothing', async () => {
    const h = await withAna();
    const saves = h.saves.length;
    const frames = h.frames('ana').length;
    await h.hub.edit('ana', { role: 'ana does the ana work', mode: 'default', name: 'ana' });
    expect(h.saves).toHaveLength(saves);
    expect(h.frames('ana')).toHaveLength(frames);
  });

  it.each([
    ['a role of blanks', { role: '  ' }, /^role must be/, 'role'],
    ['a mode that does not exist', { mode: 'root' }, /^mode must be/, 'mode'],
    ['a relative directory', { dir: 'rel' }, 'directory must be an absolute path', 'dir'],
    ['a name that is not valid', { name: 'Bad Name' }, /^name must be/, 'name'],
    ['a reserved name', { name: 'boss' }, /reserved/, 'name'],
    ['a name that is taken', { name: 'flight' }, 'an agent named "flight" already exists', 'name'],
    ['bypassPermissions without confirmation', { mode: 'bypassPermissions' }, /confirmBypass/, 'confirmBypass'],
  ] as const)('rejects %s', async (_label, patch, message, field) => {
    const h = await withAna();
    const code = field === 'name' && patch.name === 'flight' ? 'conflict' : 'bad_request';
    await expectHubReject(h.hub.edit('ana', patch as EditRequest), code, message, field);
    expect(h.view('ana').dirty).toBe(false);
  });

  it('auto needs no confirmBypass, on hire or on edit', async () => {
    const h = await withAna();
    expect((await h.hub.hire({ name: 'bea', role: 'does things', dir: '/work/bea', mode: 'auto' })).mode).toBe('auto');
    await h.hub.edit('ana', { mode: 'auto' });
    expect(h.view('ana').mode).toBe('auto');
  });

  it('bypassPermissions needs confirmBypass only when the mode changes to it', async () => {
    const h = await withAna();
    await h.hub.edit('ana', { mode: 'bypassPermissions', confirmBypass: true });
    expect(h.view('ana').mode).toBe('bypassPermissions');
    await h.hub.edit('ana', { role: 'still a bypass agent' });
    await h.hub.edit('ana', { mode: 'bypassPermissions' });
    expect(h.view('ana').role).toBe('still a bypass agent');
  });

  it('renames only a stopped agent: agent-removed for the old name, then the frame of the new one', async () => {
    const h = await withAna();
    await expectHubReject(
      h.hub.edit('ana', { name: 'ann' }),
      'conflict',
      'an agent can only be renamed while it is stopped',
      'name',
    );
    await h.hub.stop('ana');
    const mark = h.events.length;
    const view = await h.hub.edit('ana', { name: 'ann' });
    expect(view).toMatchObject({ name: 'ann', state: 'stopped' });
    expect(h.renames).toEqual([['ana', 'ann']]);
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight', 'ann']);
    const frames = h.events.slice(mark).map((event) => (event.t === 'agent-removed' ? `removed ${event.name}` : event.t === 'agent' ? `agent ${event.agent.name}` : event.t));
    expect(frames).toEqual(['removed ana', 'agent ann']);
    expect(h.saves.at(-1)?.agents.map((record) => record.name)).toEqual(['flight', 'ann']);
    // The agent works under its new name: restart, hooks, messages.
    await h.hub.restart('ann');
    h.ready('ann');
    expect(h.spawns.at(-1)?.agent.name).toBe('ann');
    expect(h.hook('ann', 'UserPromptSubmit', { prompt: 'x' })).toStrictEqual({});
    expect(h.view('ann').state).toBe('working');
    expectHubError(() => h.hub.sendFromUser({ to: 'ana', body: 'x' }), 'not_found', /unknown recipient "ana"/, 'to');
  });

  it('refuses a new name that is taken, or whose files cannot be moved; nothing changes', async () => {
    const h = await withAna();
    await h.hire('ben');
    await h.hub.stop('ana');
    await expectHubReject(h.hub.edit('ana', { name: 'ben' }), 'conflict', 'an agent named "ben" already exists', 'name');
    h.script.renameError = 'agents/ann already exists';
    const mark = h.events.length;
    await expectHubReject(h.hub.edit('ana', { name: 'ann' }), 'conflict', 'agents/ann already exists', 'name');
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight', 'ana', 'ben']);
    expect(h.events.slice(mark)).toHaveLength(0);
  });

  it('a roster that cannot be saved after a rename puts the files and the name back', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    h.script.saveError = 'disk full';
    await expectHubReject(h.hub.edit('ana', { name: 'ann', role: 'changed' }), 'internal', 'could not save the roster: disk full');
    expect(h.renames).toEqual([
      ['ana', 'ann'],
      ['ann', 'ana'],
    ]);
    expect(h.hub.views().map((agent) => [agent.name, agent.role])).toEqual([
      ['flight', expect.any(String)],
      ['ana', 'ana does the ana work'],
    ]);
  });

  it('a rename claims the new name while its directory check is still running', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    h.script.dirGate = gate();
    const release = h.script.dirGate;
    const renaming = h.hub.edit('ana', { name: 'ann', dir: '/work/elsewhere' });
    await settle();
    await expectHubReject(
      h.hub.hire({ name: 'ann', role: 'r', dir: '/work/ann', mode: 'default' }),
      'conflict',
      'an agent named "ann" already exists',
      'name',
    );
    release.open();
    await renaming;
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight', 'ann']);
    // The claim is released at the end: the old name is free again.
    expect((await h.hub.hire({ name: 'ana', role: 'r', dir: '/work/ana', mode: 'default' })).state).toBe('starting');
  });

  it('the boss can be renamed like any agent', async () => {
    const h = await withAna();
    await h.hub.stop('flight');
    await h.hub.edit('flight', { name: 'lead' });
    expect(h.hub.rosterFor('ana', 1).boss).toBe('lead');
    expect(h.hub.sendFromUser({ to: 'boss', body: 'x' }).to).toBe('lead');
  });

  it('an operation queued for the agent runs after the rename and works under the new name', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    h.script.renameGate = gate();
    const release = h.script.renameGate;
    const renaming = h.hub.edit('ana', { name: 'ann' });
    const restarting = h.hub.restart('ana');
    await settle();
    expect(h.spawns.at(-1)?.agent.name).toBe('ana');
    expect(h.spawns).toHaveLength(2);
    release.open();
    await renaming;
    await restarting;
    expect(h.spawns).toHaveLength(3);
    expect(h.spawns.at(-1)).toMatchObject({ agent: { name: 'ann' }, generation: 2 });
    expect(h.view('ann').state).toBe('starting');
  });

  it('an operation queued under the new name waits for the roster to be saved', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    h.script.saveGate = gate();
    const release = h.script.saveGate;
    const renaming = h.hub.edit('ana', { name: 'ann' });
    await settle();
    expect(h.hub.views().map((agent) => agent.name)).toContain('ann');
    const restarting = h.hub.restart('ann');
    await settle();
    expect(h.spawns).toHaveLength(2);
    release.open();
    await Promise.all([renaming, restarting]);
    expect(h.spawns.at(-1)).toMatchObject({ agent: { name: 'ann' }, generation: 2 });
  });
});

describe('stop and restart (4.9)', () => {
  it('stop: transition stopping, the process stops, one stopped frame; idempotent on a stopped agent', async () => {
    const h = await withAna();
    h.send('user', 'ana');
    const mark = h.events.length;
    const view = await h.hub.stop('ana');
    expect(view).toMatchObject({
      state: 'stopped',
      transition: null,
      exit: { code: null, signal: 15, requested: true, text: 'stopped' },
    });
    expect(h.stops).toEqual([{ name: 'ana', generation: 1 }]);
    const frames = h.events.slice(mark).flatMap((event) => (event.t === 'agent' ? [event.agent] : []));
    expect(frames.map((frame) => [frame.state, frame.transition])).toEqual([
      ['idle', 'stopping'],
      ['stopped', null],
    ]);
    expect(await h.hub.stop('ana')).toMatchObject({ state: 'stopped' });
    expect(h.stops).toHaveLength(1);
  });

  it('restart: stop, then spawn the next generation; one frame for the whole restart besides the transition', async () => {
    const h = await withAna();
    const mark = h.events.length;
    const view = await h.hub.restart('ana');
    expect(view).toMatchObject({ state: 'starting', generation: 2, transition: null, exit: null });
    expect(h.stops).toEqual([{ name: 'ana', generation: 1 }]);
    expect(h.spawns.at(-1)).toMatchObject({ generation: 2, flag: null });
    const frames = h.events.slice(mark).flatMap((event) => (event.t === 'agent' ? [event.agent] : []));
    expect(frames.map((frame) => [frame.state, frame.generation, frame.transition])).toEqual([
      ['idle', 1, 'restarting'],
      ['starting', 2, null],
    ]);
  });

  it('restart also starts a stopped agent, without a stop', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    const stops = h.stops.length;
    const view = await h.hub.restart('ana');
    expect(view).toMatchObject({ state: 'starting', generation: 2 });
    expect(h.stops).toHaveLength(stops);
  });

  it('a double-clicked Restart or Stop does not run twice', async () => {
    const h = await withAna();
    const [a, b] = await Promise.all([h.hub.restart('ana'), h.hub.restart('ana')]);
    expect(a).toStrictEqual(b);
    expect(h.stops).toHaveLength(1);
    expect(h.spawns.filter((request) => request.agent.name === 'ana')).toHaveLength(2);
    h.ready('ana');
    const [c, d] = await Promise.all([h.hub.stop('ana'), h.hub.stop('ana')]);
    expect(c).toStrictEqual(d);
    expect(h.stops).toHaveLength(2);
  });

  it('a Restart after a Stop is not folded into it', async () => {
    const h = await withAna();
    const stopping = h.hub.stop('ana');
    const restarting = h.hub.restart('ana');
    await Promise.all([stopping, restarting]);
    expect(h.view('ana')).toMatchObject({ state: 'starting', generation: 2 });
  });

  it('operations of different agents do not wait for each other', async () => {
    const h = await withAna();
    h.script.spawnGate = gate();
    const release = h.script.spawnGate;
    const slow = h.hub.hire({ name: 'slow', role: 'r', dir: '/work/slow', mode: 'default' });
    await settle();
    await expect(h.hub.restart('ana')).resolves.toMatchObject({ generation: 2 });
    expect(h.frames('slow')).toHaveLength(0);
    release.open();
    await expect(slow).resolves.toMatchObject({ state: 'starting' });
  });

  it('serialises the operations of one agent: a stop waits for the spawn in flight, then stops the new process', async () => {
    const h = await started();
    h.script.spawnGate = gate();
    const release = h.script.spawnGate;
    const hiring = h.hub.hire({ name: 'ben', role: 'r', dir: '/work/ben', mode: 'default' });
    await settle();
    const stopping = h.hub.stop('ben');
    await settle();
    expect(h.stops).toHaveLength(0);
    expect(h.view('ben')).toMatchObject({ state: 'starting', generation: 1 });
    release.open();
    await hiring;
    const view = await stopping;
    expect(h.stops).toEqual([{ name: 'ben', generation: 1 }]);
    expect(view.state).toBe('stopped');
  });

  it('a restart whose spawn fails answers the view in state stopped, with the reason', async () => {
    const h = await withAna();
    h.script.spawnError = 'no pty';
    const mark = h.events.length;
    const view = await h.hub.restart('ana');
    expect(view).toMatchObject({
      state: 'stopped',
      transition: null,
      exit: { requested: false, text: 'could not start: no pty' },
    });
    const frames = h.events.slice(mark).flatMap((event) => (event.t === 'agent' ? [event.agent] : []));
    expect(frames.map((frame) => [frame.state, frame.transition])).toEqual([
      ['idle', 'restarting'],
      ['stopped', null],
    ]);
  });

  it('an agent that stays running when stop returns is treated as stopped; the exit event that comes later changes nothing', async () => {
    const h = await withAna();
    h.script.stopExits = false;
    const view = await h.hub.stop('ana');
    expect(view).toMatchObject({ state: 'stopped', transition: null, exit: { requested: true, text: 'stopped' } });
    const frames = h.frames('ana').length;
    h.hub.onTerminalEvent({
      kind: 'exit',
      name: 'ana',
      generation: 1,
      info: { code: 1, signal: null, durationMs: 60_000, requested: false, tail: 'boom' },
      at: h.now(),
    });
    expect(h.view('ana').exit).toMatchObject({ requested: true, text: 'stopped' });
    expect(h.frames('ana')).toHaveLength(frames);
  });
});

describe('remove (4.9)', () => {
  it('refuses the boss', async () => {
    const h = await withAna();
    await expectHubReject(h.hub.remove('flight'), 'conflict', 'the boss cannot be removed');
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight', 'ana']);
  });

  it('stops a running agent, converts its mail, saves the roster without it and emits agent-removed', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana');
    const mark = h.events.length;
    await h.hub.remove('ana');
    expect(h.stops).toEqual([{ name: 'ana', generation: 1 }]);
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
    expect(h.saves.at(-1)?.agents.map((record) => record.name)).toEqual(['flight']);
    expect(h.msg('m1')).toMatchObject({
      status: 'undelivered',
      note: 'ana was removed before reading it; the message went to the user',
    });
    const tail = h.events.slice(mark).flatMap((event) => (event.t === 'agent' ? [`${event.agent.state}/${event.agent.transition}`] : event.t === 'agent-removed' ? [`removed ${event.name}`] : []));
    expect(tail).toEqual(['working/removing', 'stopped/removing', 'removed ana']);
    await expectHubReject(h.hub.stop('ana'), 'not_found', 'unknown agent');
    await expectHubReject(h.hub.remove('ana'), 'not_found', 'unknown agent');
  });

  it('a stopped agent is removed without a stop', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    const stops = h.stops.length;
    await h.hub.remove('ana');
    expect(h.stops).toHaveLength(stops);
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
  });

  it('a message to an agent that is being removed is undelivered with its own note', async () => {
    const h = await withAna();
    h.script.stopGate = gate();
    const release = h.script.stopGate;
    const removing = h.hub.remove('ana');
    await settle();
    const result = h.send('user', 'ana');
    expect(result).toMatchObject({ ok: false, status: 'undelivered', note: 'ana is being removed; the message went to the user' });
    release.open();
    await removing;
  });

  it('a roster that cannot be saved leaves the agent in place, stopped', async () => {
    const h = await withAna();
    h.script.saveError = 'disk full';
    await expectHubReject(h.hub.remove('ana'), 'internal', 'could not save the roster: disk full');
    expect(h.view('ana')).toMatchObject({ state: 'stopped', transition: null });
  });

  it('a double-clicked Remove runs once', async () => {
    const h = await withAna();
    await Promise.all([h.hub.remove('ana'), h.hub.remove('ana')]);
    expect(h.stops).toHaveLength(1);
  });

  describe('the terminal record is freed (SECPROC-3)', () => {
    it('after the process has exited and the agent is gone: once, by name', async () => {
      const h = await withAna();
      h.work('ana');
      h.script.stopGate = gate();
      const release = h.script.stopGate;
      const removing = h.hub.remove('ana');
      await settle();
      expect(h.forgotten).toEqual([]); // not while the process may still be running
      release.open();
      await removing;
      expect(h.stops).toEqual([{ name: 'ana', generation: 1 }]);
      expect(h.forgotten).toEqual(['ana']);
      expect(h.events.at(-1)).toEqual({ t: 'agent-removed', name: 'ana' });
    });

    it('also for an agent that was stopped long before', async () => {
      const h = await withAna();
      await h.hub.stop('ana');
      expect(h.forgotten).toEqual([]);
      await h.hub.remove('ana');
      expect(h.forgotten).toEqual(['ana']);
    });

    it('not when the agent stays: stop, restart, rename, a failed remove and the shutdown keep the record', async () => {
      const h = await withAna();
      await h.hub.restart('ana');
      await h.hub.stop('ana');
      await h.hub.edit('ana', { name: 'ann' });
      h.script.saveError = 'disk full';
      await expectHubReject(h.hub.remove('ann'), 'internal', 'could not save the roster: disk full');
      h.script.saveError = null;
      await h.hub.shutdown();
      expect(h.forgotten).toEqual([]);
    });

    it('a terminal host that cannot forget, or fails to, does not stop the removal', async () => {
      const h = await withAna();
      h.script.forgetError = 'boom';
      await h.hub.remove('ana');
      expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
      expect(h.warnings.some((line) => line.includes('ana'))).toBe(true);
      await h.hire('ben');
      h.io.forget = undefined; // the method is optional: a fake host without it works
      await h.hub.remove('ben');
      expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
    });
  });
});

describe('spawn frames (4.9)', () => {
  it('no AgentFrame with the new generation before io.spawn resolves; the starting frame after it', async () => {
    const h = await started();
    h.script.spawnGate = gate();
    const release = h.script.spawnGate;
    const hiring = h.hub.hire({ name: 'ben', role: 'r', dir: '/work/ben', mode: 'default' });
    await settle();
    expect(h.frames('ben')).toHaveLength(0);
    // The routing state is already consistent, views() shows it.
    expect(h.view('ben')).toMatchObject({ state: 'starting', generation: 1 });
    expect(h.send('user', 'ben')).toMatchObject({ status: 'queued', note: 'waiting: ben is starting' });
    release.open();
    await hiring;
    expect(h.frames('ben').map((frame) => [frame.state, frame.generation, frame.queued])).toEqual([['starting', 1, 1]]);
  });

  it('a spawn that is rejected: the stopped frame with could not start, the mail goes to the user', async () => {
    const h = await started();
    h.script.spawnGate = gate();
    const release = h.script.spawnGate;
    const hiring = h.hub.hire({ name: 'ben', role: 'r', dir: '/work/ben', mode: 'default' });
    await settle();
    const sent = h.send('user', 'ben');
    h.script.spawnError = 'posix_spawnp failed';
    release.open();
    const view = await hiring;
    expect(view).toMatchObject({ state: 'stopped', queued: 0, exit: { text: 'could not start: posix_spawnp failed' } });
    expect(h.msg(sent.id)).toMatchObject({
      status: 'undelivered',
      note: 'ben could not start; the message went to the user',
    });
    expect(h.frames('ben').map((frame) => frame.state)).toEqual(['stopped']);
  });

  it('events that arrive while the spawn is held count, the frame shows the result', async () => {
    const h = await started();
    h.script.spawnGate = gate();
    const release = h.script.spawnGate;
    const hiring = h.hub.hire({ name: 'ben', role: 'r', dir: '/work/ben', mode: 'default' });
    await settle();
    h.ready('ben');
    expect(h.frames('ben')).toHaveLength(0);
    release.open();
    await hiring;
    expect(h.frames('ben').map((frame) => frame.state)).toEqual(['idle']);
  });
});

describe('the session flag flip (4.9 exit step 1, conflict 28)', () => {
  // The two messages claude prints for a wrong flag, built from the constants the hub looks for.
  const inUse = `Error: Session ID ${UUID_A} ${SESSION_IN_USE_TEXT}.`;
  const missing = `${SESSION_MISSING_TEXT}: ${UUID_A}`;

  it('exit code 1 within 3 s with the message of --session-id: no stopped flash, one retry with --resume', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.send('user', 'ana');
    const frames = h.frames('ana').length;
    h.exit('ana', { code: 1, durationMs: 800, tail: `some banner\nError: Session ID ${UUID_A} is already in use.` });
    expect(h.view('ana')).toMatchObject({ state: 'starting', exit: null, queued: 1 });
    expect(h.frames('ana')).toHaveLength(frames);
    await settle();
    expect(h.spawns.at(-1)).toMatchObject({ agent: { name: 'ana' }, generation: 2, flag: 'resume' });
    expect(h.view('ana')).toMatchObject({ state: 'starting', generation: 2, queued: 1 });
    expect(h.msg('m1').status).toBe('queued');
  });

  it('the other way round: --resume with a missing session retries with --session-id', async () => {
    const h = await started();
    h.script.flag = 'resume';
    await h.hireRaw('ana');
    h.exit('ana', { code: 1, durationMs: 500, tail: `No conversation found with session ID: ${UUID_A}` });
    await settle();
    expect(h.spawns.at(-1)).toMatchObject({ generation: 2, flag: 'session-id' });
  });

  it('flips only once: a retry that fails the same way stops with its own tail', async () => {
    const h = await started();
    h.script.flag = 'resume';
    await h.hireRaw('ana');
    h.exit('ana', { code: 1, durationMs: 500, tail: missing });
    await settle();
    // The retry used --session-id, and claude says the session is in use: the one flip is spent.
    h.exit('ana', { code: 1, durationMs: 500, tail: inUse });
    await settle();
    expect(h.spawns.filter((request) => request.agent.name === 'ana')).toHaveLength(2);
    expect(h.view('ana')).toMatchObject({ state: 'stopped', exit: { text: `exited with code 1: ${inUse}` } });
  });

  it('a later user restart has its own flip', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.exit('ana', { code: 1, durationMs: 500, tail: inUse });
    await settle();
    h.exit('ana', { code: 1, durationMs: 500, tail: missing });
    await settle();
    expect(h.view('ana').state).toBe('stopped');
    await h.hub.restart('ana');
    h.exit('ana', { code: 1, durationMs: 500, tail: inUse });
    await settle();
    expect(h.spawns.at(-1)).toMatchObject({ flag: 'resume' });
    expect(h.view('ana').state).toBe('starting');
  });

  it.each([
    ['the exit was requested', { requested: true, tail: inUse }],
    ['it took 3 s', { durationMs: SESSION_FLIP_WINDOW_MS, tail: inUse }],
    ['the code is not 1', { code: 2, tail: inUse }],
    ['the tail holds the message of the other flag', { tail: missing }],
    ['the tail holds an unrelated message', { tail: 'Error: --permission-mode must be one of ...' }],
    ['the tail is empty', { tail: '' }],
  ])('does not flip when %s', async (_label, info) => {
    const h = await started();
    await h.hireRaw('ana');
    h.exit('ana', { code: 1, durationMs: 500, ...info });
    await settle();
    expect(h.spawns.filter((request) => request.agent.name === 'ana')).toHaveLength(1);
    expect(h.view('ana').state).toBe('stopped');
  });

  it('an exit code 1 with an unrelated tail is reported as it is, with its last non-empty line', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.exit('ana', { code: 1, durationMs: 500, tail: 'Error: refusing to run as root\n\n  ' });
    expect(h.view('ana').exit).toMatchObject({
      code: 1,
      signal: null,
      requested: false,
      text: 'exited with code 1: Error: refusing to run as root',
    });
  });

  it('does not flip while a stop is running', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.script.stopGate = gate();
    const release = h.script.stopGate;
    const stopping = h.hub.stop('ana');
    await settle();
    h.exit('ana', { code: 1, durationMs: 500, tail: inUse });
    release.open();
    await stopping;
    expect(h.view('ana').state).toBe('stopped');
    expect(h.spawns.filter((request) => request.agent.name === 'ana')).toHaveLength(1);
  });
});

describe('the exit event (4.9)', () => {
  it('records the exit: killed by a signal, exit codes, the last line of the tail', async () => {
    const h = await withAna();
    h.exit('ana', { code: null, signal: 9, tail: '' });
    expect(h.view('ana')).toMatchObject({ state: 'stopped', exit: { code: null, signal: 9, text: 'killed by signal 9' } });
    await h.hub.restart('ana');
    h.exit('ana', { code: 2, durationMs: 60_000, tail: 'first\n\nsecond line  \n' });
    expect(h.view('ana').exit).toMatchObject({ code: 2, text: 'exited with code 2: second line' });
    await h.hub.restart('ana');
    h.exit('ana', { code: 3, tail: '' });
    expect(h.view('ana').exit?.text).toBe('exited with code 3');
  });

  it('converts every unread message of a crashed agent into undelivered', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana', 'one');
    expect(h.hook('ana', 'Stop').decision).toBe('block');
    h.send('user', 'ana', 'two');
    h.type('ana', 'draft');
    h.send('user', 'ana', 'three');
    expect([h.msg('m1').status, h.msg('m2').status, h.msg('m3').status]).toEqual(['delivered', 'held', 'held']);
    h.exit('ana');
    for (const id of ['m1', 'm2', 'm3']) {
      expect(h.msg(id)).toMatchObject({
        status: 'undelivered',
        note: 'ana stopped before reading it; the message went to the user',
      });
    }
    expect(h.view('ana')).toMatchObject({ queued: 0, draft: false, held: null });
  });

  it('a requested stop converts the mail the same way', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana');
    await h.hub.stop('ana');
    expect(h.msg('m1')).toMatchObject({ status: 'undelivered', note: 'ana stopped before reading it; the message went to the user' });
  });

  it('messages to a stopped or stopping agent are undelivered and ok is false', async () => {
    const h = await withAna();
    h.script.stopGate = gate();
    const release = h.script.stopGate;
    const stopping = h.hub.stop('ana');
    await settle();
    expect(h.send('user', 'ana')).toMatchObject({ ok: false, note: 'ana is stopped; the message went to the user' });
    release.open();
    await stopping;
    expect(h.send('user', 'ana')).toMatchObject({ ok: false, status: 'undelivered', note: 'ana is stopped; the message went to the user' });
  });

  it('cancels the timers of the agent: nothing fires after the exit', async () => {
    const { h } = await pointed();
    h.exit('ana');
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS * 3);
    expect(h.view('ana')).toMatchObject({ state: 'stopped', held: null });
    expect(h.typed).toHaveLength(1);
  });
});

describe('events of an older generation are dropped (4.3, 4.10 rules 1, 7 and 10)', () => {
  it('hooks, ready, title and exit events of the previous process change nothing', async () => {
    const h = await withAna();
    await h.hub.restart('ana');
    expect(h.gen('ana')).toBe(2);
    const view = h.view('ana');
    const frames = h.frames('ana').length;
    expect(h.hub.onHook({ agent: 'ana', generation: 1, event: 'UserPromptSubmit', payload: { prompt: 'x' } })).toStrictEqual({});
    expect(h.hub.onHook({ agent: 'ana', generation: 1, event: 'Stop', payload: {} })).toStrictEqual({});
    h.hub.onTerminalEvent({ kind: 'ready', name: 'ana', generation: 1, at: h.now() });
    h.hub.onTerminalEvent({ kind: 'title', name: 'ana', generation: 1, glyph: 'working', title: '◐', at: h.now() });
    h.hub.onTerminalEvent({
      kind: 'exit',
      name: 'ana',
      generation: 1,
      info: { code: 1, signal: null, durationMs: 60_000, requested: false, tail: '' },
      at: h.now(),
    });
    expect(h.view('ana')).toStrictEqual(view);
    expect(h.frames('ana')).toHaveLength(frames);
  });

  it('events for an agent that does not exist are ignored', async () => {
    const h = await withAna();
    h.hub.onTerminalEvent({ kind: 'ready', name: 'nobody', generation: 1, at: h.now() });
    h.hub.onTerminalEvent(null as never);
    expect(h.hub.onHook({ agent: 'nobody', generation: 1, event: 'Stop', payload: {} })).toStrictEqual({});
  });
});

describe('shutdown (4.9, 2.1 rule 7)', () => {
  it('stops every running agent in parallel and rejects every lifecycle call afterwards', async () => {
    const h = await withAna();
    await h.hire('ben');
    const down = h.hub.shutdown();
    // Both stop calls were made before either resolved.
    expect(h.stops.map((call) => call.name).sort()).toEqual(['ana', 'ben', 'flight']);
    await down;
    expect(h.hub.views().map((agent) => agent.state)).toEqual(['stopped', 'stopped', 'stopped']);
    const shutting = 'the server is shutting down';
    await expectHubReject(h.hub.hire({ name: 'cy', role: 'r', dir: '/work/cy', mode: 'default' }), 'conflict', shutting);
    await expectHubReject(h.hub.edit('ana', { role: 'x' }), 'conflict', shutting);
    await expectHubReject(h.hub.restart('ana'), 'conflict', shutting);
    await expectHubReject(h.hub.stop('ana'), 'conflict', shutting);
    await expectHubReject(h.hub.remove('ana'), 'conflict', shutting);
  });

  it('converts no message: the exits skip it, and start() converts what the log shows', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana', 'one');
    h.send('user', 'ana', 'two');
    expect(h.hook('ana', 'Stop').decision).toBe('block');
    h.send('user', 'ana', 'three');
    const logged = h.logged.length;
    await h.hub.shutdown();
    expect(h.logged).toHaveLength(logged);
    expect([h.msg('m1').status, h.msg('m2').status, h.msg('m3').status]).toEqual(['delivered', 'delivered', 'queued']);
    // The next run starts from what the log holds (last line per id).
    const latest = new Map<string, MessageRecord>();
    for (const record of h.logged) latest.set(record.id, record);
    const next = makeHarness({ roster: h.saves.at(-1)?.agents ?? [], history: [...latest.values()] });
    await next.hub.start();
    const note = 'server restarted before it was read; the message went to the user';
    expect(next.hub.activity().map((item) => [item.id, item.status, item.note])).toEqual([
      ['m3', 'undelivered', note],
      ['m2', 'undelivered', note],
      ['m1', 'undelivered', note],
    ]);
  });

  it('stops the sweep and clears every timer; mail, hooks and reads still work', async () => {
    const h = await withAna();
    h.send('user', 'ana');
    await h.hub.shutdown();
    expect(h.pendingTimers()).toBe(0);
    await h.advance(10_000);
    expect(h.pendingTimers()).toBe(0);
    expect(h.hub.sendFromUser({ to: 'ana', body: 'late' })).toMatchObject({ status: 'undelivered' });
    expect(h.hub.onHook({ agent: 'ana', generation: 1, event: 'Stop', payload: {} })).toStrictEqual({});
    expect(h.hub.readMessages('nobody', 1).count).toBe(0);
  });

  it('waits for a spawn in flight, then stops the process that spawn created', async () => {
    const h = await started();
    h.script.spawnGate = gate();
    const release = h.script.spawnGate;
    const hiring = h.hub.hire({ name: 'ben', role: 'r', dir: '/work/ben', mode: 'default' });
    await settle();
    const down = h.hub.shutdown();
    await settle();
    expect(h.stops.filter((call) => call.name === 'ben')).toHaveLength(0);
    release.open();
    await hiring;
    await down;
    expect(h.stops.filter((call) => call.name === 'ben')).toEqual([{ name: 'ben', generation: 1 }]);
    expect(h.view('ben').state).toBe('stopped');
  });

  it('a restart in flight does not start a new process once the shutdown began', async () => {
    const h = await withAna();
    h.script.stopGate = gate();
    const release = h.script.stopGate;
    const restarting = h.hub.restart('ana');
    await settle();
    const spawns = h.spawns.length;
    const down = h.hub.shutdown();
    release.open();
    await restarting;
    await down;
    expect(h.spawns).toHaveLength(spawns);
    expect(h.view('ana')).toMatchObject({ state: 'stopped', transition: null });
  });

  it('does not flip the session flag while shutting down; a second call answers with the same promise', async () => {
    const h = await started();
    await h.hireRaw('ana');
    const down = h.hub.shutdown();
    expect(h.hub.shutdown()).toBe(down);
    await down;
    expect(h.spawns.filter((request) => request.agent.name === 'ana')).toHaveLength(1);
  });
});

describe('persistence and frames', () => {
  it('logs and emits every creation and every status change of a message, and nothing for an unchanged note', async () => {
    const h = await withAna();
    const sent = h.send('user', 'ana', 'body');
    const text = await h.pointerTyped('ana');
    h.prompt('ana', text);
    h.read('ana');
    const summary = (list: Array<{ status: string; note: string | null }>) => list.map((item) => `${item.status}|${item.note}`);
    const expected = [`queued|${IDLE_NOTE}`, `queued|${CONFIRMING}`, 'delivered|pointer typed', 'read|null'];
    expect(summary(h.items(sent.id))).toEqual(expected);
    expect(summary(h.logged.filter((record) => record.id === sent.id))).toEqual(expected);
    expect(h.logged[0]).toMatchObject({ id: sent.id, body: 'body', hops: 0, from: 'user', to: 'ana' });
  });

  it('message routing survives a log or a broadcast that throws', async () => {
    const h = await withAna();
    h.io.logMessage = () => {
      throw new Error('log failed');
    };
    h.io.emit = () => {
      throw new Error('broadcast failed');
    };
    expect(h.send('user', 'ana')).toMatchObject({ ok: true, status: 'queued' });
    h.hook('ana', 'UserPromptSubmit', { prompt: 'x' });
    expect(h.view('ana').state).toBe('working');
    expect(h.warnings).toContain('could not log a message');
    expect(h.warnings).toContain('emit failed');
  });

  it('every frame is the whole view; a frame is emitted once per change', async () => {
    const h = await withAna();
    const mark = h.events.length;
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.hook('ana', 'PostToolUse');
    const frames = h.events.slice(mark).flatMap((event) => (event.t === 'agent' ? [event.agent] : []));
    expect(frames.map((frame) => frame.state)).toEqual(['working', 'needs_you', 'working']);
    for (const frame of frames) expect(Object.keys(frame).sort()).toEqual(Object.keys(h.view('ana')).sort());
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 4.10: the 14 races, one test each, named by its number
 * ---------------------------------------------------------------------------------------------------------- */

describe('4.10 races', () => {
  it('race 1: a hook before readiness is evidence of readiness; the ready event after it changes nothing', async () => {
    const h = await started();
    await h.hireRaw('ana');
    expect(h.view('ana').state).toBe('starting');
    h.hook('ana', 'PreToolUse', { tool_name: 'Bash' });
    expect(h.view('ana').state).toBe('working');
    const frames = h.frames('ana').length;
    h.ready('ana');
    expect(h.view('ana').state).toBe('working');
    expect(h.frames('ana')).toHaveLength(frames);
    // A hook of an older generation is dropped.
    await h.hub.restart('ana');
    expect(h.hub.onHook({ agent: 'ana', generation: 1, event: 'Stop', payload: {} })).toStrictEqual({});
    expect(h.view('ana')).toMatchObject({ state: 'starting', generation: 2 });
  });

  it('race 2: a Stop while a pointer is being typed ignores the ids in flight; the confirmation still lands', async () => {
    const { h, text } = await pointed();
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.view('ana').state).toBe('idle');
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: CONFIRMING });
    // The pointer is submitted after the turn ended: UserPromptSubmit confirms it.
    h.prompt('ana', text);
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });

    // The 2 s run out first: the messages are held, and a late UserPromptSubmit still confirms them.
    const second = await pointed();
    expect(second.h.hook('ana', 'Stop')).toStrictEqual({});
    await second.h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    expect(second.h.msg('m1').status).toBe('held');
    second.h.prompt('ana', second.text);
    expect(second.h.msg('m1')).toMatchObject({ status: 'delivered', note: 'pointer typed' });
  });

  it('race 3: two messages at once make one pointer, none while one is in flight, and read_messages returns them all', async () => {
    const h = await withAna();
    h.send('user', 'ana', 'one');
    await h.advance(100);
    h.send('user', 'ana', 'two');
    await h.advance(DELIVERY_COALESCE_MS);
    expect(h.typed).toHaveLength(1);
    expect(h.typed[0]?.text).toBe('gonogo: 2 new messages from user. Call read_messages.');
    h.send('user', 'ana', 'three');
    await h.advance(DELIVERY_COALESCE_MS * 2);
    expect(h.typed).toHaveLength(1);
    const read = h.read('ana');
    expect(read.messages.map((message) => message.body)).toEqual(['one', 'two', 'three']);
    expect(h.view('ana')).toMatchObject({ queued: 0, held: null });
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS * 2);
    expect(h.view('ana').held).toBeNull();
  });

  it('race 4: a restart during delivery cancels the timers and keeps the queue for the new process', async () => {
    const { h } = await pointed();
    await h.hub.restart('ana');
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS * 2);
    expect(h.view('ana')).toMatchObject({ state: 'starting', held: null, queued: 1 });
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'waiting: ana is starting' });
    h.ready('ana');
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed.map((call) => call.generation)).toEqual([1, 2]);

    // A message that was delivered but not read goes back to queued.
    const g = await withAna();
    g.work('ana');
    g.send('user', 'ana');
    expect(g.hook('ana', 'Stop').decision).toBe('block');
    expect(g.msg('m1').status).toBe('delivered');
    await g.hub.restart('ana');
    expect(g.msg('m1')).toMatchObject({ status: 'queued', note: 'restarted before it was read' });
    expect(g.view('ana').queued).toBe(1);
    // The next delivery check puts the usual wait note on it, and the new process gets its pointer.
    await g.advance(RECONCILE_TICK_MS);
    expect(g.msg('m1').note).toBe('waiting: ana is starting');
    g.ready('ana');
    g.setTitle('ana', 'idle');
    await g.advance(DELIVERY_SETTLE_MS);
    expect(g.typed.map((call) => call.generation)).toEqual([2]);
  });

  it('race 5: a draft latch while a Stop is answered: held when it is set, the block lands when it comes after', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana', 'one');
    h.type('ana', 'half a sentence');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: "held: text in ana's input" });
    // Enter releases the held message and submits a prompt: the agent works, the message waits for the next Stop.
    h.setTitle('ana', 'idle');
    h.type('ana', '\r');
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: IDLE_NOTE });
    h.prompt('ana', 'what the user typed');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.typed).toHaveLength(0);
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'waiting: ana is working' });
    expect(h.hook('ana', 'Stop').decision).toBe('block');

    // The user starts typing after the reply was computed: the block stands.
    const g = await withAna();
    g.work('ana');
    g.send('user', 'ana', 'one');
    expect(g.hook('ana', 'Stop').decision).toBe('block');
    g.type('ana', 'late typing');
    expect(g.msg('m1')).toMatchObject({ status: 'delivered', note: 'handed over when its turn ended' });
  });

  it('race 6: the reconciliation clock is the later of the glyph and the state; a block suppresses R1', async () => {
    const h = await withAna();
    h.work('ana');
    await h.advance(30_000);
    h.setTitle('ana', 'working', h.now() - 30_000);
    await h.alignToTick(20);
    h.hook('ana', 'Stop');
    await h.advance(20);
    expect(h.view('ana').state).toBe('idle');

    h.work('ana');
    await h.advance(10_000);
    h.send('user', 'ana');
    h.setTitle('ana', 'idle', h.now() - 60_000);
    expect(h.hook('ana', 'Stop').decision).toBe('block');
    await h.advance(TITLE_IDLE_RECONCILE_MS - 700);
    expect(h.view('ana').state).toBe('working');
    await h.advance(1500);
    expect(h.view('ana').state).toBe('idle');
  });

  it('race 7: calls of a previous generation, or while a stop or restart runs, are refused and consume nothing', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana');
    h.script.stopGate = gate();
    const release = h.script.stopGate;
    const restarting = h.hub.restart('ana');
    await settle();
    expectHubError(() => h.hub.readMessages('ana', 1), 'conflict', 'this session has ended');
    expectHubError(() => h.hub.sendFromAgent('ana', 1, { to: 'user', subject: '', body: 'x' }), 'conflict', 'this session has ended');
    expectHubError(() => h.hub.rosterFor('ana', 1), 'conflict', 'this session has ended');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.msg('m1').status).toBe('queued');
    release.open();
    await restarting;
    expectHubError(() => h.hub.readMessages('ana', 1), 'conflict', 'this session has ended');
    expect(h.msg('m1').status).toBe('queued');
    h.ready('ana');
    expect(h.hub.readMessages('ana', 2).count).toBe(1);
  });

  it('race 8: a stop requested while a spawn is running waits, then stops the new process', async () => {
    const h = await withAna();
    h.script.spawnGate = gate();
    const release = h.script.spawnGate;
    const restarting = h.hub.restart('ana');
    await settle();
    const stopping = h.hub.stop('ana');
    await settle();
    expect(h.stops).toEqual([{ name: 'ana', generation: 1 }]);
    release.open();
    await restarting;
    const view = await stopping;
    expect(h.stops).toEqual([
      { name: 'ana', generation: 1 },
      { name: 'ana', generation: 2 },
    ]);
    expect(view.state).toBe('stopped');
  });

  it('race 9: an exit while a pointer is in flight clears the confirmation; its ids are handled by the exit', async () => {
    const { h } = await pointed();
    h.exit('ana');
    expect(h.msg('m1')).toMatchObject({ status: 'undelivered', note: 'ana stopped before reading it; the message went to the user' });
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS * 2);
    expect(h.view('ana')).toMatchObject({ state: 'stopped', held: null, queued: 0 });
    expect(h.typed).toHaveLength(1);
  });

  it('race 10: a delayed ready or title event of an older generation is dropped', async () => {
    const h = await withAna();
    await h.hub.restart('ana');
    h.hub.onTerminalEvent({ kind: 'ready', name: 'ana', generation: 1, at: h.now() });
    h.hub.onTerminalEvent({ kind: 'title', name: 'ana', generation: 1, glyph: 'working', title: '◐', at: h.now() });
    expect(h.view('ana').state).toBe('starting');
    h.setOutput('ana', 5);
    await h.advance(STARTUP_READY_TIMEOUT_MS);
    // Only the startup timer of the new process decides: no ready came for it.
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'startup_dialog' });
  });

  it('race 11: a double Stop, a double PermissionRequest and a repeated ready are idempotent', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'Stop');
    let frames = h.frames('ana').length;
    h.hook('ana', 'Stop');
    expect(h.frames('ana')).toHaveLength(frames);
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    frames = h.frames('ana').length;
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    expect(h.frames('ana')).toHaveLength(frames);
    h.ready('ana');
    h.ready('ana');
    expect(h.frames('ana')).toHaveLength(frames);
    expect(h.view('ana').state).toBe('needs_you');
  });

  it('race 12: Enter or Ctrl-C while a pointer is unconfirmed releases it; the submitted pointer is an ordinary prompt', async () => {
    const { h, text } = await pointed();
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    expect(h.msg('m1').status).toBe('held');
    // The Enter that submits the pointer sitting in the box: the keystroke reaches the hub before the hook does.
    h.type('ana', '\r');
    expect(h.view('ana')).toMatchObject({ held: null, draft: false });
    expect(h.msg('m1').status).toBe('queued');
    h.prompt('ana', text);
    expect(h.view('ana').state).toBe('working');
    // Not "confirmed": the latch was gone. The agent reads its mail and read_messages ends the bookkeeping.
    expect(h.msg('m1').status).toBe('queued');
    expect(h.read('ana').count).toBe(1);
    expect(h.msg('m1')).toMatchObject({ status: 'read', note: null });
    await h.advance(DELIVERY_SETTLE_MS * 3);
    expect(h.typed).toHaveLength(1);

    // Escape is not a release.
    const g = await pointed();
    await g.h.advance(PROMPT_SUBMIT_CONFIRM_MS);
    g.h.type('ana', '\x1b');
    expect(g.h.msg('m1').status).toBe('held');
  });

  it('race 13: read_messages before the confirmation ends it, the timer finds nothing and no invisible latch is left', async () => {
    const { h } = await pointed();
    expect(h.read('ana').count).toBe(1);
    await h.advance(PROMPT_SUBMIT_CONFIRM_MS * 3);
    expect(h.view('ana')).toMatchObject({ held: null, queued: 0 });
    h.send('user', 'ana', 'second');
    await h.advance(DELIVERY_COALESCE_MS);
    expect(h.typed).toHaveLength(2);
    expect(h.msg('m2').status).toBe('queued');
    expect(h.msg('m2').note).toBe(CONFIRMING);

    // A confirmation timer that was already due when the read came fires anyway: it finds nothing and sets nothing.
    const g = await withAna();
    g.io.clearTimer = () => undefined;
    g.send('user', 'ana');
    await g.pointerTyped('ana');
    expect(g.read('ana').count).toBe(1);
    await g.advance(PROMPT_SUBMIT_CONFIRM_MS * 2);
    expect(g.view('ana')).toMatchObject({ held: null, queued: 0 });
    g.send('user', 'ana', 'second');
    await g.advance(DELIVERY_COALESCE_MS);
    expect(g.typed).toHaveLength(2);
  });

  it('race 14: a turn that ends without read_messages gets one more pointer, then the strip says so', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana');
    expect(h.hook('ana', 'Stop')).toStrictEqual({ decision: 'block', reason: POINTER_ONE });
    // The model ignored it and stopped again: second pointer.
    expect(h.hook('ana', 'Stop')).toStrictEqual({ decision: 'block', reason: POINTER_ONE });
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'handed over when its turn ended' });
    // And again: nothing more is handed over.
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    expect(h.msg('m1')).toMatchObject({ status: 'delivered', note: 'not read: ana did not read it after two pointers' });
    h.setTitle('ana', 'idle');
    await h.advance(DELIVERY_SETTLE_MS * 4);
    expect(h.typed).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 0.5 item 6: the restart gap
 * ---------------------------------------------------------------------------------------------------------- */

describe('the restart gap (0.5 item 6)', () => {
  it('records the exit and sets stopped without a frame; routing treats the agent as running; the spawn emits one starting frame', async () => {
    const h = await withAna();
    h.work('ana');
    h.send('user', 'ana', 'handed over');
    expect(h.hook('ana', 'Stop').decision).toBe('block');
    h.send('user', 'ana', 'still queued');
    expect(h.msg('m2').note).toBe('waiting: ana is working');

    h.script.afterStopGate = gate();
    h.script.spawnGate = gate();
    const afterStop = h.script.afterStopGate;
    const spawnHeld = h.script.spawnGate;
    const mark = h.events.length;
    const agentFrames = () => h.events.slice(mark).flatMap((event) => (event.t === 'agent' ? [event.agent] : []));
    const restarting = h.hub.restart('ana');
    await settle();

    // The process has exited, the stop has not resolved: the internal state is stopped, the transition is restarting.
    expect(h.view('ana')).toMatchObject({ state: 'stopped', transition: 'restarting', generation: 1 });
    expect(agentFrames().map((frame) => [frame.state, frame.transition])).toEqual([['working', 'restarting']]);

    // Routing tests restarting before stopped: the message is queued for the new process, not undelivered.
    const during = h.send('user', 'ana', 'while restarting');
    expect(during).toMatchObject({ ok: true, status: 'queued', note: 'waiting: ana is restarting' });
    expect(h.msg('m1')).toMatchObject({ status: 'queued', note: 'restarted before it was read' });
    expect(h.msg('m2')).toMatchObject({ status: 'queued', note: 'waiting: ana is restarting' });
    expect(h.view('ana').queued).toBe(3);

    afterStop.open();
    await settle();
    // The spawn runs, its frame waits for io.spawn.
    expect(h.view('ana')).toMatchObject({ state: 'starting', generation: 2, transition: null });
    expect(agentFrames()).toHaveLength(1);
    spawnHeld.open();
    await restarting;

    const frames = agentFrames();
    expect(frames.map((frame) => [frame.state, frame.generation, frame.transition, frame.queued])).toEqual([
      ['working', 1, 'restarting', 1],
      ['starting', 2, null, 3],
    ]);
    // No stopped frame was emitted, and the exit summary of the old process is gone with the new start.
    expect(frames.some((frame) => frame.state === 'stopped')).toBe(false);
    expect(frames[1]?.exit).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 0.5 item 5: the permission summary
 * ---------------------------------------------------------------------------------------------------------- */

describe('the permission summary (0.5 item 5)', () => {
  it('is the first 100 characters of the whitespace-collapsed text, plus an ellipsis only when something was cut', async () => {
    const h = await withAna();
    h.hook('ana', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: `  ${'a b '.repeat(60)}` } });
    const reason = h.view('ana').needsReason ?? '';
    const summary = reason.slice('permission request: Bash: '.length);
    expect(reason.startsWith('permission request: Bash: a b a b')).toBe(true);
    expect(summary).toHaveLength(101);
    expect(summary).toBe(`${'a b '.repeat(60).trim().slice(0, 100)}…`);

    h.hook('ana', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x'.repeat(100) } });
    expect(h.view('ana').needsReason).toBe(`permission request: Bash: ${'x'.repeat(100)}`);
    h.hook('ana', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x'.repeat(101) } });
    expect(h.view('ana').needsReason).toBe(`permission request: Bash: ${'x'.repeat(100)}…`);
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * A whole conversation
 * ---------------------------------------------------------------------------------------------------------- */

describe('a conversation through the hub', () => {
  it('the user briefs the boss, the boss hands work to ana, ana reports back, the boss tells the user', async () => {
    const h = await withAna();

    // The brief: typed as a pointer into the idle boss, confirmed by the hook, read through the tool.
    const brief = h.send('user', 'boss', 'Build the thing', 'brief');
    expect(brief).toMatchObject({ to: 'flight', status: 'queued', note: IDLE_NOTE });
    h.prompt('flight', await h.pointerTyped('flight'));
    expect(h.msg(brief.id)).toMatchObject({ status: 'delivered', note: 'pointer typed', hops: 0 });
    expect(h.read('flight').messages.map((message) => message.subject)).toEqual(['brief']);

    // The boss sends the task while it works; ana is idle and gets a pointer of her own.
    const task = h.send('flight', 'ana', 'Write the module', 'task');
    expect(h.msg(task.id).hops).toBe(1);
    h.prompt('ana', await h.pointerTyped('ana'));
    expect(h.read('ana').messages.map((message) => message.body)).toEqual(['Write the module']);
    h.hook('flight', 'Stop');
    h.setTitle('flight', 'idle');

    // Ana reports to the boss; the boss is idle again and is pointed at it.
    const report = h.send('ana', 'boss', 'Done', 'report');
    expect(h.msg(report.id).hops).toBe(2);
    h.hook('ana', 'Stop');
    h.prompt('flight', await h.pointerTyped('flight'));
    expect(h.read('flight').messages.map((message) => message.body)).toEqual(['Done']);
    const answer = h.send('flight', 'user', 'All done', 'outcome');
    expect(answer).toMatchObject({ ok: true, status: 'to_user', note: null });

    const statuses = [brief, task, report, answer].map((sent) => [h.msg(sent.id).status, h.msg(sent.id).hops]);
    expect(statuses).toEqual([
      ['read', 0],
      ['read', 1],
      ['read', 2],
      ['to_user', 3],
    ]);
    expect(h.hub.activity().map((item) => item.id)).toEqual([answer.id, report.id, task.id, brief.id]);
    expect(h.hub.views().map((view) => [view.name, view.queued, view.held])).toEqual([
      ['flight', 0, null],
      ['ana', 0, null],
    ]);
    expect(h.typed.map((call) => call.name)).toEqual(['flight', 'ana', 'flight']);
  });

  it('a message handed over at a Stop reaches an agent that never goes idle, and is read in the same turn', async () => {
    const h = await withAna();
    h.work('ana');
    const sent = h.send('user', 'ana', 'while you work');
    expect(h.msg(sent.id)).toMatchObject({ status: 'queued', note: 'waiting: ana is working' });
    const reply = h.hook('ana', 'Stop');
    expect(reply.decision).toBe('block');
    // The agent carries on, calls the tool, and the tool call is a tool hook.
    h.hook('ana', 'PreToolUse', { tool_name: 'mcp__gonogo__read_messages' });
    expect(h.read('ana').messages.map((message) => message.id)).toEqual([sent.id]);
    h.hook('ana', 'Stop');
    expect(h.msg(sent.id)).toMatchObject({ status: 'read', note: null });
    expect(h.typed).toHaveLength(0);
    expect(h.view('ana')).toMatchObject({ state: 'idle', queued: 0 });
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * 0.3 item 8: hostile and broken input never crashes
 * ---------------------------------------------------------------------------------------------------------- */

describe('hostile input (0.3 item 8)', () => {
  const garbage: unknown[] = [
    undefined,
    null,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    'x',
    '\u0000',
    'a'.repeat(5000),
    [],
    ['ana'],
    {},
    { name: 'ana' },
    { to: 'user', body: 'x', subject: {} },
    true,
    () => 1,
    Symbol('s'),
    10n,
  ];

  it('onHook, onTerminalEvent and onUserInput never throw, and the agent is still sane afterwards', async () => {
    const h = await withAna();
    for (const a of garbage) {
      expect(() => h.hub.onTerminalEvent(a as never)).not.toThrow();
      for (const b of garbage) {
        expect(() => h.hub.onHook({ agent: a, generation: b, event: a, payload: b } as never)).not.toThrow();
        expect(() => h.hub.onHook({ agent: 'ana', generation: 1, event: 'Stop', payload: b } as never)).not.toThrow();
        expect(() => h.hub.onHook({ agent: 'ana', generation: 1, event: 'Notification', payload: { notification_type: a, message: b } } as never)).not.toThrow();
        expect(() => h.hub.onHook({ agent: 'ana', generation: 1, event: 'PermissionRequest', payload: { tool_name: a, tool_input: b } } as never)).not.toThrow();
        expect(() => h.hub.onHook({ agent: 'ana', generation: 1, event: 'UserPromptSubmit', payload: { prompt: a, session_id: b } } as never)).not.toThrow();
        expect(() => h.hub.onTerminalEvent({ kind: a, name: 'ana', generation: 1, info: b } as never)).not.toThrow();
        expect(() => h.hub.onTerminalEvent({ kind: 'ready', name: a, generation: b } as never)).not.toThrow();
        expect(() => h.hub.onUserInput(a as never, b as never)).not.toThrow();
        expect(() => describePermission(a, b)).not.toThrow();
      }
    }
    expect(h.hub.views().every((view) => view.name.length > 0)).toBe(true);
    // Nothing was caught by a last-resort handler: the hub looked at every field before it used it.
    expect(h.warnings.filter((line) => line.startsWith('error:'))).toEqual([]);
  });

  it('the request methods fail with a HubError and nothing else', async () => {
    const h = await withAna();
    const fails = (fn: () => unknown): void => {
      try {
        fn();
      } catch (error) {
        expect((error as HubError).name).toBe('HubError');
      }
    };
    for (const a of garbage) {
      fails(() => h.hub.sendFromUser(a as never));
      fails(() => h.hub.readMessages(a as never, a as never));
      fails(() => h.hub.rosterFor(a as never, a as never));
      for (const b of garbage) {
        fails(() => h.hub.sendFromAgent(a as never, b as never, a as never));
        fails(() => h.hub.sendFromAgent('ana', 1, { to: a, subject: b, body: b } as never));
        fails(() => h.hub.sendFromAgent('ana', 1, { to: 'user', subject: a, body: 'x', inReplyTo: b } as never));
        fails(() => h.hub.sendFromUser({ to: a, body: b } as never));
      }
    }
    for (const a of garbage) {
      await expect(h.hub.hire(a as never)).rejects.toMatchObject({ name: 'HubError' });
      await expect(h.hub.edit(a as never, a as never)).rejects.toMatchObject({ name: 'HubError' });
      await expect(h.hub.restart(a as never)).rejects.toMatchObject({ name: 'HubError' });
      await expect(h.hub.stop(a as never)).rejects.toMatchObject({ name: 'HubError' });
      await expect(h.hub.remove(a as never)).rejects.toMatchObject({ name: 'HubError' });
      // { name: 'ana' } is a valid edit that changes nothing; anything else is refused.
      const outcome = await h.hub.edit('ana', a as never).then(() => null, (error: unknown) => error);
      if (outcome !== null) expect((outcome as HubError).name).toBe('HubError');
      await expect(h.hub.hire({ name: 'zed', role: a, dir: a, mode: a } as never)).rejects.toMatchObject({ name: 'HubError' });
    }
    expect(h.hub.views().map((view) => view.name)).toEqual(['flight', 'ana']);
  });
});

// END-OF-TESTS

/* ------------------------------------------------------------------------------------------------------------
 * Positions, providers and the custom command
 * ---------------------------------------------------------------------------------------------------------- */

describe('position, provider and command (hire and edit)', () => {
  const custom = { name: 'tail', role: 'watches a log', dir: '/work/tail', mode: 'default', provider: 'custom', command: 'htop' };
  const hireCustom = (h: Harness, patch: Record<string, unknown> = {}): Promise<AgentView> =>
    h.hub.hire({ ...custom, ...patch } as unknown as HireRequest);

  it('rejects an unknown position on hire and on edit, with the field', async () => {
    const h = await withAna();
    await expectHubReject(
      h.hub.hire({ name: 'bob', role: 'x', dir: '/work/bob', mode: 'default', position: 'captain' }),
      'bad_request',
      'unknown position',
      'position',
    );
    await expectHubReject(h.hub.edit('ana', { position: 'captain' }), 'bad_request', 'unknown position', 'position');
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight', 'ana']);
  });

  it('stores a position, shows it in the view, lets edit change and clear it, and never makes the agent dirty', async () => {
    const h = await started();
    const view = await h.hub.hire({ name: 'guido', role: 'x', dir: '/work/g', mode: 'default', position: 'guido' });
    h.ready('guido');
    expect(view.position).toBe('guido');
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'guido')?.position).toBe('guido');
    expect((await h.hub.edit('guido', { position: 'fido' })).position).toBe('fido');
    expect(h.view('guido').dirty).toBe(false);
    const cleared = await h.hub.edit('guido', { position: null });
    expect(cleared.position).toBeNull();
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'guido')).not.toHaveProperty('position');
  });

  it('an agent without a position and the claude provider leaves its roster record without those fields', async () => {
    const h = await withAna();
    const record = h.saves.at(-1)?.agents.find((candidate) => candidate.name === 'ana');
    expect(record).not.toHaveProperty('position');
    expect(record).not.toHaveProperty('provider');
    expect(record).not.toHaveProperty('command');
    expect(h.view('ana')).toMatchObject({ position: null, provider: 'claude', command: null });
  });

  it('refuses an unknown provider', async () => {
    const h = await started();
    await expectHubReject(hireCustom(h, { provider: 'gpt' }), 'bad_request', /^provider must be one of/, 'provider');
  });

  it('a custom agent needs a command: missing, blank and too long are bad_request with field command', async () => {
    const h = await started();
    await expectHubReject(hireCustom(h, { command: undefined }), 'bad_request', /^command must be/, 'command');
    await expectHubReject(hireCustom(h, { command: '   ' }), 'bad_request', /^command must be/, 'command');
    await expectHubReject(hireCustom(h, { command: 'x'.repeat(COMMAND_MAX_CHARS + 1) }), 'bad_request', /^command must be/, 'command');
    expect(h.hub.views()).toHaveLength(1);
  });

  it('a claude agent cannot have a command, on hire or on edit', async () => {
    const h = await withAna();
    await expectHubReject(
      h.hub.hire({ name: 'bob', role: 'x', dir: '/work/bob', mode: 'default', command: 'htop' }),
      'bad_request',
      'only a custom agent has a command',
      'command',
    );
    await expectHubReject(h.hub.edit('ana', { command: 'htop' }), 'bad_request', 'only a custom agent has a command', 'command');
  });

  it('hires a custom agent: trimmed command, mode default whatever was sent, provider stored, view says so', async () => {
    const h = await started();
    const view = await hireCustom(h, { command: '  htop -d 5  ', mode: 'bypassPermissions' });
    expect(view).toMatchObject({ name: 'tail', provider: 'custom', command: 'htop -d 5', mode: 'default', state: 'starting' });
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'tail')).toMatchObject({
      provider: 'custom',
      command: 'htop -d 5',
      mode: 'default',
    });
    expect(h.spawns.at(-1)?.agent).toMatchObject({ provider: 'custom', command: 'htop -d 5' });
  });

  it('editing the command of a custom agent makes it dirty until the restart; the provider cannot be edited', async () => {
    const h = await started();
    await hireCustom(h);
    expect(h.view('tail').dirty).toBe(false);
    expect((await h.hub.edit('tail', { command: ' top ' })).command).toBe('top');
    expect(h.view('tail').dirty).toBe(true);
    await expectHubReject(h.hub.edit('tail', { command: '' }), 'bad_request', /^command must be/, 'command');
    await h.hub.restart('tail');
    expect(h.view('tail').dirty).toBe(false);
    expect(h.spawns.at(-1)?.agent.command).toBe('top');
    await expectHubReject(h.hub.edit('tail', { provider: 'claude' } as unknown as EditRequest), 'bad_request', /^nothing to change/);
    expect(h.view('tail').provider).toBe('custom');
  });

  it('list_roster carries the position of every entry', async () => {
    const h = await started();
    await h.hub.hire({ name: 'guido', role: 'x', dir: '/work/g', mode: 'default', position: 'guido' });
    h.ready('guido');
    await h.hire('ana');
    const roster = h.hub.rosterFor('ana', h.gen('ana'));
    expect(roster.agents.map((entry) => [entry.name, entry.position])).toEqual([
      ['flight', 'flight'],
      ['guido', 'guido'],
      ['ana', null],
    ]);
  });
});

describe('the custom provider', () => {
  const hireTail = async (h: Harness): Promise<void> => {
    await h.hub.hire({ name: 'tail', role: 'watches', dir: '/work/tail', mode: 'default', provider: 'custom', command: 'htop' });
  };

  it('a message to a custom agent is undelivered at once with the note, and nothing is queued or typed', async () => {
    const h = await withAna();
    await hireTail(h);
    const fromAgent = h.send('ana', 'tail');
    expect(fromAgent).toMatchObject({
      ok: false,
      status: 'undelivered',
      note: 'tail runs a custom command and cannot receive messages',
    });
    expect(h.send('user', 'tail')).toMatchObject({ ok: false, status: 'undelivered' });
    await h.advance(DELIVERY_SETTLE_MS * 4);
    expect(h.typed).toHaveLength(0);
    expect(h.view('tail').queued).toBe(0);
  });

  it('state comes from the output bytes: starting, idle after the quiet start, working while it prints, idle when quiet', async () => {
    const h = await started();
    await hireTail(h);
    expect(h.view('tail').state).toBe('starting');
    await h.advance(CUSTOM_START_MS + RECONCILE_TICK_MS);
    expect(h.view('tail').state).toBe('idle');
    h.setOutput('tail', 120);
    await h.advance(RECONCILE_TICK_MS);
    expect(h.view('tail').state).toBe('working');
    await h.advance(CUSTOM_ACTIVE_MS - RECONCILE_TICK_MS);
    expect(h.view('tail').state).toBe('working');
    h.setOutput('tail', 240);
    await h.advance(CUSTOM_ACTIVE_MS - RECONCILE_TICK_MS);
    expect(h.view('tail').state).toBe('working');
    await h.advance(CUSTOM_ACTIVE_MS + RECONCILE_TICK_MS);
    expect(h.view('tail').state).toBe('idle');
  });

  it('output before the quiet start means working at once, and a long silence after it is idle, never needs_you', async () => {
    const h = await started();
    await hireTail(h);
    h.setOutput('tail', 10);
    await h.advance(RECONCILE_TICK_MS);
    expect(h.view('tail').state).toBe('working');
    await h.advance(STARTUP_READY_TIMEOUT_MS * 3);
    expect(h.view('tail').state).toBe('idle');
    expect(h.view('tail').needsKind).toBeNull();
  });

  it('hooks, the ready event and keystrokes do nothing for a custom agent: no latches, no hook-driven state', async () => {
    const h = await started();
    await hireTail(h);
    const generation = h.gen('tail');
    expect(h.hub.onHook({ agent: 'tail', generation, event: 'PermissionRequest', payload: {} })).toEqual({});
    h.hub.onTerminalEvent({ kind: 'ready', name: 'tail', generation, at: h.now() });
    expect(h.view('tail').state).toBe('starting');
    h.type('tail', 'abc');
    expect(h.view('tail').draft).toBe(false);
  });

  it('an exit is the normal exit path: stopped with the exit text; a restart starts it over (starting again)', async () => {
    const h = await started();
    await hireTail(h);
    h.setOutput('tail', 5);
    await h.advance(RECONCILE_TICK_MS);
    h.exit('tail', { code: 3 });
    expect(h.view('tail')).toMatchObject({ state: 'stopped', exit: { text: 'exited with code 3' } });
    await h.hub.restart('tail');
    expect(h.view('tail')).toMatchObject({ state: 'starting', generation: 2 });
  });

  it('after a restart the first output of the new process counts, whatever the old process printed', async () => {
    const h = await started();
    await hireTail(h);
    h.setOutput('tail', 5000);
    await h.advance(RECONCILE_TICK_MS);
    h.exit('tail');
    await h.hub.restart('tail');
    h.setOutput('tail', 100);
    await h.advance(RECONCILE_TICK_MS);
    expect(h.view('tail').state).toBe('working');
  });

  it('a custom agent is never in a default poll and cannot be named in one', async () => {
    const h = await withAna();
    await hireTail(h);
    expect(h.hub.startPoll({}).entries.map((entry) => entry.agent)).toEqual(['ana']);
    h.hub.clearPoll();
    expectHubError(() => h.hub.startPoll({ agents: ['tail'] }), 'bad_request', /custom command/, 'agents');
  });
});

describe('Engine Bay: other agent CLIs', () => {
  const hireAs = async (h: Harness, name: string, provider: Provider, mode: PermissionMode = 'default'): Promise<AgentView> =>
    h.hub.hire({ name, role: `${name} works`, dir: `/work/${name}`, mode, confirmBypass: true, provider });

  it('gemini is hook driven: the first hook ends starting, Stop goes idle, and it takes a Max Q slot', async () => {
    const h = await started();
    const view = await hireAs(h, 'gem', 'gemini', 'acceptEdits');
    expect(view).toMatchObject({ provider: 'gemini', mode: 'acceptEdits', state: 'starting' });
    expect(h.saves.at(-1)?.agents.find((a) => a.name === 'gem')).toMatchObject({ provider: 'gemini' });
    // The terminal host's ready rule reads Claude's prompt box: for gemini only a hook ends starting.
    h.hub.onTerminalEvent({ kind: 'ready', name: 'gem', generation: h.gen('gem'), at: h.now() });
    expect(h.view('gem').state).toBe('starting');
    h.hook('gem', 'UserPromptSubmit', { prompt: 'You are "gem"', session_id: UUID_B });
    expect(h.view('gem').state).toBe('working');
    expect(h.hub.governor().working).toBe(1);
    h.hook('gem', 'PreToolUse', { tool_name: 'run_shell_command', tool_input: { command: 'ls' } });
    expect(h.view('gem').doing).toBe('run_shell_command: ls');
    h.hook('gem', 'Stop', { transcript_path: '/x/gem.json' });
    expect(h.view('gem').state).toBe('idle');
    // Propellant reads Claude transcripts only, and a gemini session id is not Claude's to resume.
    expect(h.metered).toHaveLength(0);
    expect(h.saves.at(-1)?.agents.find((a) => a.name === 'gem')?.sessionId).not.toBe(UUID_B);
  });

  it('gemini gets mail as a typed pointer without a screen check, confirmed by its BeforeAgent hook', async () => {
    const h = await started();
    await hireAs(h, 'gem', 'gemini');
    h.hook('gem', 'UserPromptSubmit', { prompt: 'role' });
    h.hook('gem', 'Stop');
    h.setScreen('gem', { promptBox: false });
    h.setTitle('gem', 'working');
    const sent = h.send('user', 'gem');
    const text = await h.pointerTyped('gem');
    expect(text).toBe(POINTER_ONE);
    expect(h.msg(sent.id).note).toBe(CONFIRMING);
    h.hook('gem', 'UserPromptSubmit', { prompt: text });
    expect(h.msg(sent.id)).toMatchObject({ status: 'delivered', note: 'pointer typed' });
  });

  it('gemini: mail for a working agent is handed over by the AfterAgent block, and ToolPermission means needs_you', async () => {
    const h = await started();
    await hireAs(h, 'gem', 'gemini');
    h.hook('gem', 'UserPromptSubmit', { prompt: 'role' });
    h.send('user', 'gem');
    expect(h.hook('gem', 'Stop')).toEqual({ decision: 'block', reason: POINTER_ONE });
    h.hook('gem', 'Notification', { notification_type: 'ToolPermission', message: 'Allow   run_shell_command: rm -rf build?' });
    expect(h.view('gem')).toMatchObject({ state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Allow run_shell_command: rm -rf build?' });
    h.hook('gem', 'PostToolUse', { tool_name: 'run_shell_command' });
    expect(h.view('gem').state).toBe('working');
    // NO-GO is an Escape, which ends Gemini's turn without a hook: the hub goes idle itself.
    h.hook('gem', 'Notification', { notification_type: 'ToolPermission', message: 'Allow it?' });
    expect(h.hub.answer('gem', { go: false }).state).toBe('idle');
    expect(h.pressed.at(-1)).toMatchObject({ name: 'gem', data: '\x1b' });
  });

  it('codex has the tools but no hooks: state from output, a typed pointer is delivered at once, no Max Q slot', async () => {
    const h = await started();
    const view = await hireAs(h, 'cx', 'codex', 'bypassPermissions');
    expect(view).toMatchObject({ provider: 'codex', mode: 'bypassPermissions' });
    expect(h.hub.onHook({ agent: 'cx', generation: h.gen('cx'), event: 'UserPromptSubmit', payload: {} })).toEqual({});
    h.setOutput('cx', 100);
    await h.advance(RECONCILE_TICK_MS);
    expect(h.view('cx').state).toBe('working');
    expect(h.hub.governor().working).toBe(0);
    const sent = h.send('user', 'cx');
    await h.advance(RECONCILE_TICK_MS);
    expect(h.typed).toHaveLength(0);
    expect(h.msg(sent.id).note).toBe('waiting: cx is working');
    await h.advance(CUSTOM_ACTIVE_MS + RECONCILE_TICK_MS);
    expect(h.view('cx').state).toBe('idle');
    expect(h.typed.at(-1)).toMatchObject({ name: 'cx', text: POINTER_ONE });
    expect(h.msg(sent.id)).toMatchObject({ status: 'delivered', note: 'pointer typed' });
    expect(h.hub.startPoll({}).entries.map((entry) => entry.agent)).toEqual(['cx']);
  });

  it('pi has no gonogo tools: no permission modes, no mail, no votes, and a note that names it', async () => {
    const h = await started();
    expect(await hireAs(h, 'pip', 'pi', 'bypassPermissions')).toMatchObject({ provider: 'pi', mode: 'default' });
    expect(h.send('user', 'pip')).toMatchObject({ ok: false, status: 'undelivered', note: 'pip runs pi without the gonogo tools and cannot receive messages' });
    expectHubError(() => h.hub.startPoll({}), 'bad_request', 'nobody to poll');
    expectHubError(() => h.hub.startPoll({ agents: ['pip'] }), 'bad_request', 'pip runs pi without the gonogo tools and cannot vote', 'agents');
    expect(await h.hub.edit('pip', { mode: 'acceptEdits', role: 'new' })).toMatchObject({ mode: 'default', role: 'new' });
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * T-minus
 * ---------------------------------------------------------------------------------------------------------- */

describe('T-minus', () => {
  const POLL_SUBJECT = 'T-minus: go/no-go poll';
  const POLL_BODY = 'The Director is polling for go or no-go. Call go_nogo with your vote and a one-sentence reason.';
  const pollFrames = (h: Harness): Array<unknown> => h.events.filter((event) => event.t === 'poll').map((event) => (event.t === 'poll' ? event.poll : null));
  const messagesTo = (h: Harness, to: string): ActivityItem[] => h.hub.activity().filter((item) => item.to === to).reverse();
  const vote = (h: Harness, name: string, choice: 'go' | 'no-go', reason = 'ok') => h.hub.vote(name, h.gen(name), choice, reason);

  async function threeAgents(): Promise<Harness> {
    const h = await started();
    await h.hire('ana');
    await h.hire('bob');
    return h;
  }

  it('starts a poll of every running claude agent except the boss, tells each one, and emits one frame', async () => {
    const h = await threeAgents();
    await h.hub.stop('bob');
    await h.hire('cara');
    const view = h.hub.startPoll({});
    expect(view).toMatchObject({
      id: 1,
      status: 'open',
      note: 'waiting for ana, cara',
      entries: [
        { agent: 'ana', vote: null, reason: '', at: null },
        { agent: 'cara', vote: null, reason: '', at: null },
      ],
    });
    expect(h.hub.poll()).toEqual(view);
    expect(pollFrames(h)).toEqual([view]);
    for (const name of ['ana', 'cara']) {
      expect(messagesTo(h, name)).toMatchObject([{ from: 'user', subject: POLL_SUBJECT, body: POLL_BODY, status: 'queued' }]);
    }
    expect(messagesTo(h, 'bob')).toHaveLength(0);
    expect(messagesTo(h, 'flight')).toHaveLength(0);
  });

  it('named agents: unknown, stopped and duplicate names; nobody to poll; a second poll is a conflict until cleared', async () => {
    const h = await threeAgents();
    expectHubError(() => h.hub.startPoll({ agents: ['nobody'] }), 'bad_request', /unknown agent "nobody"/, 'agents');
    expectHubError(() => h.hub.startPoll({ agents: 'ana' } as unknown as { agents: string[] }), 'bad_request', /list of agent names/, 'agents');
    await h.hub.stop('bob');
    expectHubError(() => h.hub.startPoll({ agents: ['bob'] }), 'bad_request', /not running/, 'agents');
    expect(h.hub.poll()).toBeNull();
    expect(h.hub.startPoll({ agents: ['ana', 'ana', 'flight'] }).entries.map((entry) => entry.agent)).toEqual(['ana', 'flight']);
    expectHubError(() => h.hub.startPoll({}), 'conflict', 'clear the poll first');
    h.hub.abortPoll();
    expectHubError(() => h.hub.startPoll({}), 'conflict', 'clear the poll first');
    h.hub.clearPoll();
    await h.hub.stop('ana');
    expectHubError(() => h.hub.startPoll({}), 'bad_request', 'nobody to poll');
  });

  it('all go: every vote counts, the status turns go on the last one and the boss is told once', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    expect(vote(h, 'ana', 'go', '  ready  ')).toEqual({ ok: true, note: 'vote recorded: go' });
    expect(h.hub.poll()).toMatchObject({ status: 'open', note: 'waiting for bob' });
    expect(h.hub.poll()?.entries[0]).toMatchObject({ vote: 'go', reason: 'ready', at: h.now() });
    expect(messagesTo(h, 'flight')).toHaveLength(0);
    vote(h, 'bob', 'go', 'fine');
    expect(h.hub.poll()).toMatchObject({ status: 'go', note: 'all go' });
    expect(messagesTo(h, 'flight')).toMatchObject([
      { from: 'user', subject: 'T-minus: all go', body: 'Every polled position is go. Proceed.' },
    ]);
    expect(pollFrames(h)).toHaveLength(3);
    expect(vote(h, 'bob', 'no-go')).toEqual({ ok: false, note: 'no poll is open' });
    expect(messagesTo(h, 'flight')).toHaveLength(1);
  });

  it('tells the Downlink each result once: go, hold and aborted, never open', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    vote(h, 'ana', 'go');
    expect(h.notices).toEqual([]);
    vote(h, 'bob', 'go');
    expect(h.notices).toEqual([['tminus', 'GO: all go']]);
    h.hub.clearPoll();
    h.hub.startPoll({});
    vote(h, 'ana', 'no-go', 'not ready');
    vote(h, 'bob', 'no-go', 'wait');
    expect(h.notices.slice(1)).toEqual([['tminus', 'HOLD: no-go: ana']]);
    h.hub.clearPoll();
    h.hub.startPoll({});
    h.hub.holdPoll();
    h.hub.abortPoll();
    expect(h.notices.slice(2)).toEqual([
      ['tminus', 'HOLD: held by the Director'],
      ['tminus', 'ABORTED: aborted by the Director'],
    ]);
  });

  it('a second vote while open replaces the first', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    vote(h, 'ana', 'go', 'first');
    vote(h, 'ana', 'go', 'second');
    expect(h.hub.poll()?.entries[0]).toMatchObject({ vote: 'go', reason: 'second' });
    expect(h.hub.poll()?.status).toBe('open');
  });

  it('the first no-go turns the poll to hold with the note; the boss is not told; the reason is cut', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    vote(h, 'ana', 'no-go', 'y'.repeat(POLL_REASON_MAX_CHARS + 50));
    expect(h.hub.poll()).toMatchObject({ status: 'hold', note: 'no-go: ana' });
    expect(h.hub.poll()?.entries[0]?.reason).toHaveLength(POLL_REASON_MAX_CHARS);
    expect(messagesTo(h, 'flight')).toHaveLength(0);
  });

  it('a hold by the Director never follows votes: they are recorded and the note stays', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    h.hub.holdPoll();
    vote(h, 'ana', 'no-go', 'not ready');
    expect(h.hub.poll()).toMatchObject({ status: 'hold', note: 'held by the Director' });
    vote(h, 'ana', 'go', 'now ready');
    expect(vote(h, 'bob', 'go', 'ready')).toEqual({ ok: true, note: 'vote recorded: go' });
    expect(h.hub.poll()).toMatchObject({ status: 'hold', note: 'held by the Director' });
    expect(h.hub.poll()?.entries.map((entry) => entry.vote)).toEqual(['go', 'go']);
    expect(messagesTo(h, 'flight')).toHaveLength(0);
  });

  it('a hold by vote follows the votes: open while somebody has not voted, go with one all-go message', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    vote(h, 'ana', 'no-go', 'not ready');
    vote(h, 'bob', 'go', 'ready');
    expect(h.hub.poll()).toMatchObject({ status: 'hold', note: 'no-go: ana' });
    vote(h, 'bob', 'no-go', 'wait');
    expect(h.hub.poll()?.note).toBe('no-go: ana, bob');
    vote(h, 'ana', 'go', 'now ready');
    expect(h.hub.poll()).toMatchObject({ status: 'hold', note: 'no-go: bob' });
    vote(h, 'bob', 'go', 'ready too');
    expect(h.hub.poll()).toMatchObject({ status: 'go', note: 'all go' });
    expect(messagesTo(h, 'flight')).toMatchObject([{ subject: 'T-minus: all go' }]);
  });

  it('a withdrawn no-go with a missing vote goes back to open, and a new no-go holds again', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    vote(h, 'ana', 'no-go', 'x');
    vote(h, 'ana', 'go', 'y');
    expect(h.hub.poll()).toMatchObject({ status: 'open', note: 'waiting for bob' });
    vote(h, 'bob', 'no-go', 'z');
    expect(h.hub.poll()).toMatchObject({ status: 'hold', note: 'no-go: bob' });
    expect(messagesTo(h, 'flight')).toHaveLength(0);
  });

  it('vote answers in plain notes: no poll, not in the poll, a stale session', async () => {
    const h = await threeAgents();
    expect(vote(h, 'ana', 'go')).toEqual({ ok: false, note: 'no poll is open' });
    h.hub.startPoll({ agents: ['ana'] });
    expect(vote(h, 'bob', 'go')).toEqual({ ok: false, note: 'you are not in this poll' });
    expect(h.hub.vote('ana', h.gen('ana') + 1, 'go', 'x')).toEqual({ ok: false, note: 'this session has ended' });
    expect(h.hub.vote('ana', h.gen('ana'), 'maybe' as unknown as 'go', 'x').ok).toBe(false);
    expect(h.hub.poll()?.entries[0]?.vote).toBeNull();
  });

  it('static fire: briefs the running SIMSUP and RETRO, waits for every answer, tells the inbox with the answers, not the boss', async () => {
    const h = await threeAgents();
    expectHubError(() => h.hub.startPoll({ subject: 'login' }), 'bad_request', 'no SIMSUP or RETRO is running');
    for (const [name, position] of [['sim', 'simsup'], ['ret', 'retro'], ['sim-2', 'simsup']] as const) {
      await h.hub.hire({ name, role: 'x', dir: `/work/${name}`, mode: 'default', position });
      h.ready(name);
    }
    await h.hub.stop('sim-2');
    expectHubError(() => h.hub.startPoll({ subject: '  ' }), 'bad_request', /subject must be text/, 'subject');
    expectHubError(() => h.hub.startPoll({ subject: 'x'.repeat(SUBJECT_MAX_CHARS) }), 'bad_request', /subject must be text/, 'subject');
    expectHubError(() => h.hub.startPoll({ subject: 'login', agents: ['ana'] }), 'bad_request', /picks SIMSUP and RETRO/, 'agents');
    const view = h.hub.startPoll({ subject: ' the\nlogin  form ' });
    expect(view).toMatchObject({ subject: 'the login form', status: 'open', note: 'waiting for sim, ret' });
    expect(messagesTo(h, 'sim')).toMatchObject([{ from: 'user', subject: 'Static fire: the login form', body: expect.stringContaining('try to break it') }]);
    expect(messagesTo(h, 'ret')).toMatchObject([{ from: 'user', subject: 'Static fire: the login form', body: expect.stringContaining('rollback plan') }]);
    expect(messagesTo(h, 'ana')).toHaveLength(0);
    vote(h, 'sim', 'no-go', 'empty password accepted');
    expect(h.hub.poll()).toMatchObject({ status: 'open', note: 'waiting for ret' });
    expect(h.notices).toEqual([]);
    vote(h, 'ret', 'go', 'revert the merge');
    expect(h.hub.poll()).toMatchObject({ status: 'hold', note: 'no-go: sim' });
    expect(h.notices).toEqual([['tminus', 'Static fire on the login form: HOLD: no-go: sim · sim: empty password accepted · ret: revert the merge']]);
    vote(h, 'sim', 'go', 'fixed now');
    expect(h.hub.poll()).toMatchObject({ status: 'go', note: 'all go' });
    expect(messagesTo(h, 'flight')).toHaveLength(0);
    h.hub.abortPoll();
    expect(messagesTo(h, 'sim').at(-1)).toMatchObject({ subject: 'Static fire: aborted' });
  });

  it('holdPoll turns an open poll to hold; hold, abort and a finished poll answer conflict where the spec says', async () => {
    const h = await threeAgents();
    expectHubError(() => h.hub.holdPoll(), 'conflict');
    expectHubError(() => h.hub.abortPoll(), 'conflict');
    h.hub.startPoll({});
    expect(h.hub.holdPoll()).toMatchObject({ status: 'hold', note: 'held by the Director' });
    expectHubError(() => h.hub.holdPoll(), 'conflict');
    expect(pollFrames(h)).toHaveLength(2);
  });

  it('abort tells every entry that has not voted no-go to stand by, once, and ends the poll as aborted', async () => {
    const h = await started();
    for (const name of ['ana', 'bob', 'cara']) await h.hire(name);
    h.hub.startPoll({});
    vote(h, 'ana', 'no-go', 'no');
    vote(h, 'bob', 'go', 'yes');
    const view = h.hub.abortPoll();
    expect(view.status).toBe('aborted');
    const standBy = { from: 'user', subject: 'T-minus: aborted', body: 'The Director aborted the poll. Stand by.' };
    expect(messagesTo(h, 'bob').at(-1)).toMatchObject(standBy);
    expect(messagesTo(h, 'cara').at(-1)).toMatchObject(standBy);
    expect(messagesTo(h, 'ana').map((item) => item.subject)).toEqual([POLL_SUBJECT]);
    const frames = pollFrames(h).length;
    h.hub.abortPoll();
    expect(pollFrames(h)).toHaveLength(frames);
    expect(messagesTo(h, 'bob')).toHaveLength(2);
    expect(vote(h, 'cara', 'go')).toEqual({ ok: false, note: 'no poll is open' });
  });

  it('clear removes the poll and emits poll: null once; clearing nothing emits nothing; ids keep counting', async () => {
    const h = await threeAgents();
    h.hub.clearPoll();
    expect(pollFrames(h)).toHaveLength(0);
    h.hub.startPoll({});
    h.hub.clearPoll();
    h.hub.clearPoll();
    expect(h.hub.poll()).toBeNull();
    expect(pollFrames(h).at(-1)).toBeNull();
    expect(pollFrames(h)).toHaveLength(2);
    expect(h.hub.startPoll({}).id).toBe(2);
  });

  it('an entry whose agent stops becomes no-go "stopped" and turns an open poll to hold', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    vote(h, 'ana', 'go', 'ready');
    await h.hub.stop('bob');
    expect(h.hub.poll()).toMatchObject({ status: 'hold', note: 'no-go: bob' });
    expect(h.hub.poll()?.entries[1]).toMatchObject({ vote: 'no-go', reason: 'stopped', at: h.now() });
  });

  it('a restart, a crash and a removal count as stopped too; a voted go entry turns no-go', async () => {
    const h = await started();
    for (const name of ['ana', 'bob', 'cara']) await h.hire(name);
    h.hub.startPoll({});
    vote(h, 'ana', 'go');
    await h.hub.restart('ana');
    expect(h.hub.poll()?.entries[0]).toMatchObject({ vote: 'no-go', reason: 'stopped' });
    h.exit('bob');
    expect(h.hub.poll()?.entries[1]).toMatchObject({ vote: 'no-go', reason: 'stopped' });
    await h.hub.remove('cara');
    expect(h.hub.poll()?.entries.map((entry) => entry.agent)).toEqual(['ana', 'bob']);
    expect(h.hub.poll()?.status).toBe('hold');
  });

  it('a stop after the poll turned go changes nothing', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    vote(h, 'ana', 'go');
    vote(h, 'bob', 'go');
    const frames = pollFrames(h).length;
    await h.hub.stop('bob');
    expect(h.hub.poll()?.status).toBe('go');
    expect(pollFrames(h)).toHaveLength(frames);
  });

  it('poll() hands out copies', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    const copy = h.hub.poll();
    if (copy) copy.entries[0]!.vote = 'go';
    expect(h.hub.poll()?.entries[0]?.vote).toBeNull();
  });

  it('shutdown clears the poll', async () => {
    const h = await threeAgents();
    h.hub.startPoll({});
    await h.hub.shutdown();
    expect(h.hub.poll()).toBeNull();
  });
});

describe('T-minus: renames, removals and vote hygiene', () => {
  const vote = (h: Harness, name: string, choice: 'go' | 'no-go', reason = 'ok') => h.hub.vote(name, h.gen(name), choice, reason);
  const toFlight = (h: Harness) => h.hub.activity().filter((item) => item.to === 'flight');

  async function two(): Promise<Harness> {
    const h = await started();
    await h.hire('ana');
    await h.hire('bob');
    return h;
  }

  it('a rename during a poll moves the entry; the new name votes and a new agent under the old name cannot', async () => {
    const h = await two();
    h.hub.startPoll({});
    await h.hub.stop('ana');
    await h.hub.edit('ana', { name: 'ann' });
    expect(h.hub.poll()?.entries.map((entry) => entry.agent)).toEqual(['ann', 'bob']);
    await h.hire('ana');
    expect(vote(h, 'ana', 'go')).toEqual({ ok: false, note: 'you are not in this poll' });
    await h.hub.restart('ann');
    expect(vote(h, 'ann', 'go')).toMatchObject({ ok: true });
    expect(h.hub.poll()?.entries[0]).toMatchObject({ agent: 'ann', vote: 'go' });
  });

  it('removal deletes the entry; removing the last one clears the poll with no all-go message', async () => {
    const h = await two();
    h.hub.startPoll({});
    await h.hub.remove('ana');
    expect(h.hub.poll()?.entries.map((entry) => entry.agent)).toEqual(['bob']);
    await h.hub.remove('bob');
    expect(h.hub.poll()).toBeNull();
    expect(toFlight(h)).toHaveLength(0);
  });

  it('130 rapid votes are refused after the cap with the note, and the poll stays as it was', async () => {
    const h = await two();
    h.hub.startPoll({});
    let ok = 0;
    for (let index = 0; index < 130; index += 1) if (vote(h, 'ana', 'go', `v${index}`).ok) ok += 1;
    expect(ok).toBe(SEND_RATE_MAX);
    const before = JSON.stringify(h.hub.poll());
    expect(vote(h, 'ana', 'no-go', 'late')).toEqual({ ok: false, note: 'too many requests: wait a moment' });
    expect(JSON.stringify(h.hub.poll())).toBe(before);
  });

  it('a reason with control and bidi characters is stored as one clean line', async () => {
    const h = await two();
    h.hub.startPoll({});
    vote(h, 'ana', 'go', 'a\u001b[31mb\u0007\u0000c\rd\ne\u202ef');
    expect(h.hub.poll()?.entries[0]?.reason).toBe('a [31mb c d e f');
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * Max Q
 * ---------------------------------------------------------------------------------------------------------- */

describe('Max Q', () => {
  const governorFrames = (h: Harness): Array<{ limit: number | null; working: number; holding: number }> =>
    h.events.flatMap((event) => (event.t === 'governor' ? [event.governor] : []));
  const GATE_NOTE = 'waiting: load limit (1 of 1 agents working)';

  /** ana works; bob and cara are idle; the limit is 1. */
  async function loaded(): Promise<Harness> {
    const h = await started({ maxWorking: 1 });
    for (const name of ['ana', 'bob', 'cara']) await h.hire(name);
    h.work('ana');
    return h;
  }

  it('starts with the limit of the options and reports working and holding', async () => {
    const h = await loaded();
    expect(h.hub.governor()).toEqual({ limit: 1, working: 1, holding: 0 });
    expect((await started()).hub.governor()).toEqual({ limit: null, working: 0, holding: 0 });
  });

  it('holds an agent message for an idle recipient while the working count is at the limit', async () => {
    const h = await loaded();
    const result = h.send('bob', 'cara');
    expect(result).toMatchObject({ ok: true, status: 'queued' });
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.typed).toHaveLength(0);
    expect(h.msg(result.id)).toMatchObject({ status: 'queued', note: GATE_NOTE });
    expect(h.hub.governor()).toEqual({ limit: 1, working: 1, holding: 1 });
  });

  it('releases the message when a working agent finishes (the next sweep)', async () => {
    const h = await loaded();
    const result = h.send('bob', 'cara');
    await h.advance(DELIVERY_SETTLE_MS);
    h.hook('ana', 'Stop');
    h.setTitle('ana', 'idle');
    await h.advance(RECONCILE_TICK_MS * 2);
    expect(h.typed.map((entry) => entry.name)).toEqual(['cara']);
    expect(h.msg(result.id).note).toBe('waiting: confirming the pointer');
    // cara's pointer is typed but not confirmed: it holds the slot ana freed.
    expect(h.hub.governor()).toEqual({ limit: 1, working: 1, holding: 0 });
  });

  it('messages from the Director and poll messages are not gated, and a user message takes the agent messages along', async () => {
    const h = await loaded();
    h.send('bob', 'cara', 'from bob');
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(0);
    h.send('user', 'cara', 'from the Director');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.typed).toHaveLength(1);
    expect(h.typed[0]?.name).toBe('cara');
    h.hub.startPoll({ agents: ['bob'] });
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.typed.map((entry) => entry.name)).toEqual(['cara', 'bob']);
  });

  it('the Stop-hook hand-over to an agent that is already working is not gated', async () => {
    const h = await loaded();
    h.send('bob', 'ana', 'while you work');
    expect(h.hook('ana', 'Stop')).toMatchObject({ decision: 'block' });
  });

  it('nothing is gated while the limit is off or above the working count', async () => {
    const h = await started({ maxWorking: 2 });
    for (const name of ['ana', 'bob', 'cara']) await h.hire(name);
    h.work('ana');
    h.send('bob', 'cara');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.typed.map((entry) => entry.name)).toEqual(['cara']);
  });

  it('an unconfirmed pointer counts as working: two deliveries in one tick do not both pass the limit', async () => {
    const h = await started({ maxWorking: 2 });
    for (const name of ['ana', 'bob', 'cara']) await h.hire(name);
    await h.hire('dan');
    h.work('ana');
    const first = h.send('ana', 'bob');
    const second = h.send('ana', 'cara');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.typed).toHaveLength(1);
    expect(h.hub.governor().working).toBe(2);
    const waiting = [first, second].map((r) => h.msg(r.id)).filter((m) => m.note?.startsWith('waiting: load limit'));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.note).toBe('waiting: load limit (2 of 2 agents working)');
  });

  it('a custom agent that keeps printing takes no slot and never gates mail', async () => {
    const h = await started({ maxWorking: 1 });
    await h.hire('ana');
    await h.hire('bob');
    await h.hub.hire({ name: 'tail', role: 'watches', dir: '/work/tail', mode: 'default', provider: 'custom', command: 'htop' });
    h.setOutput('tail', 10);
    await h.advance(RECONCILE_TICK_MS);
    expect(h.view('tail').state).toBe('working');
    expect(h.hub.governor().working).toBe(0);
    h.send('ana', 'bob');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.typed.map((entry) => entry.name)).toEqual(['bob']);
  });

  it('setGovernor changes the limit, releases held messages when it is raised, and returns the view', async () => {
    const h = await loaded();
    h.send('bob', 'cara');
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(0);
    expect(h.hub.setGovernor({ limit: 2 })).toEqual({ limit: 2, working: 1, holding: 1 });
    await h.advance(DELIVERY_COALESCE_MS);
    expect(h.typed.map((entry) => entry.name)).toEqual(['cara']);
    expect(h.hub.setGovernor({ limit: null })).toEqual({ limit: null, working: 2, holding: 0 });
  });

  it.each([
    ['zero', 0],
    ['above MAX_AGENTS', MAX_AGENTS + 1],
    ['a fraction', 1.5],
    ['a string', '2'],
    ['NaN', Number.NaN],
    ['missing', undefined],
  ])('setGovernor refuses a limit that is %s', async (_label, limit) => {
    const h = await started();
    expectHubError(() => h.hub.setGovernor({ limit } as unknown as GovernorRequest), 'bad_request', /^limit must be/, 'limit');
    expect(h.hub.governor().limit).toBeNull();
    expect(governorFrames(h)).toHaveLength(0);
  });

  it('accepts 1 and MAX_AGENTS', async () => {
    const h = await started();
    expect(h.hub.setGovernor({ limit: 1 }).limit).toBe(1);
    expect(h.hub.setGovernor({ limit: MAX_AGENTS }).limit).toBe(MAX_AGENTS);
  });

  it('emits a GovernorFrame once per change, and none for a write that changes nothing', async () => {
    const h = await started();
    for (const name of ['ana', 'bob', 'cara']) await h.hire(name);
    h.hub.setGovernor({ limit: 1 });
    h.hub.setGovernor({ limit: 1 });
    expect(governorFrames(h)).toEqual([{ limit: 1, working: 0, holding: 0 }]);
    h.work('ana');
    h.hook('ana', 'PreToolUse');
    expect(governorFrames(h).at(-1)).toEqual({ limit: 1, working: 1, holding: 0 });
    h.send('bob', 'cara');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(governorFrames(h).at(-1)).toEqual({ limit: 1, working: 1, holding: 1 });
    h.hook('ana', 'Stop');
    h.setTitle('ana', 'idle');
    await h.advance(RECONCILE_TICK_MS * 4);
    expect(governorFrames(h)).toEqual([
      { limit: 1, working: 0, holding: 0 },
      { limit: 1, working: 1, holding: 0 },
      { limit: 1, working: 1, holding: 1 },
      { limit: 1, working: 0, holding: 1 },
      { limit: 1, working: 1, holding: 0 },
    ]);
  });
});

describe('AgentView.history (sequence chart)', () => {
  it('a new agent starts with one entry, and every state change adds one', async () => {
    const h = await started();
    // never `stopped` first: that state lasted no time
    expect(h.view('flight').history).toEqual([
      { state: 'starting', at: T0 },
      { state: 'idle', at: T0 },
    ]);
    await h.advance(1000);
    h.work('flight');
    await h.advance(1000);
    h.hook('flight', 'PermissionRequest', PERMISSION_PAYLOAD);
    expect(h.view('flight').history.slice(2)).toEqual([
      { state: 'working', at: T0 + 1000 },
      { state: 'needs_you', at: T0 + 2000 },
    ]);
  });

  it('does not grow when the state stays and only the reason changes, and the last entry is the current state', async () => {
    const h = await withAna();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    const length = h.view('ana').history.length;
    h.hook('ana', 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/a/b.ts' } });
    const view = h.view('ana');
    expect(view.history).toHaveLength(length);
    expect(view.history.at(-1)).toEqual({ state: view.state, at: view.stateSince });
  });

  it('keeps the changes of the window plus the one before it', async () => {
    const h = await withAna();
    h.work('ana'); // working at T0
    await h.advance(HISTORY_WINDOW_MS - 1000);
    h.hook('ana', 'Stop');
    h.setTitle('ana', 'idle');
    await h.advance(RECONCILE_TICK_MS * 4);
    const at = h.now();
    const view = h.view('ana');
    expect(view.history.every((c) => c.at >= at - HISTORY_WINDOW_MS)).toBe(false);
    // the entry before the window is the state at its left edge
    const inside = view.history.filter((c) => c.at >= at - HISTORY_WINDOW_MS);
    expect(view.history).toHaveLength(inside.length + 1);
    expect(view.history[0]?.state).toBe('working');
    // later the working entry leaves the window; the idle one that began after it stays as the left edge
    await h.advance(HISTORY_WINDOW_MS);
    const later = h.view('ana');
    expect(later.history).toEqual([{ state: 'idle', at: expect.any(Number) }]);
    expect(later.history[0]?.at).toBe(later.stateSince);
  });

  it('keeps at most HISTORY_MAX entries, the newest, and prunes when the view is built', async () => {
    const h = await withAna();
    for (let index = 0; index < HISTORY_MAX; index += 1) {
      h.hook('ana', index % 2 === 0 ? 'PermissionRequest' : 'UserPromptSubmit', PERMISSION_PAYLOAD);
      await h.advance(1);
    }
    const view = h.view('ana');
    expect(view.history).toHaveLength(HISTORY_MAX);
    expect(view.history.at(-1)?.state).toBe(view.state);
    expect(view.history[0]?.at).toBeLessThanOrEqual(view.history[1]?.at ?? 0);
    // time passes: the view alone drops what left the window
    await h.advance(HISTORY_WINDOW_MS * 2);
    const later = h.view('ana');
    expect(later.history.length).toBeLessThan(5);
    expect(later.history.at(-1)).toEqual({ state: later.state, at: later.stateSince });
  });

  it('a rename keeps it, a restart adds to it, and the view carries a copy', async () => {
    const h = await withAna();
    h.work('ana');
    await h.hub.stop('ana');
    const before = h.view('ana').history;
    expect(before.at(-1)?.state).toBe('stopped');
    await h.hub.edit('ana', { name: 'bea' });
    expect(h.view('bea').history).toEqual(before);
    const copy = h.view('bea');
    copy.history.push({ state: 'stopped', at: 0 });
    copy.history[0]!.state = 'stopped';
    expect(h.view('bea').history).toEqual(before);
    await h.hub.restart('bea');
    const after = h.view('bea').history;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)?.state).toBe('starting');
  });

  it('goes out with the agent frame of the change', async () => {
    const h = await withAna();
    h.work('ana');
    expect(h.frames('ana').at(-1)?.history.at(-1)).toEqual({ state: 'working', at: T0 });
  });
});

describe('AgentView.doing', () => {
  it('is null until the first PreToolUse of the process, then the permission text without its prefix', async () => {
    const h = await withAna();
    expect(h.view('ana').doing).toBeNull();
    h.work('ana');
    expect(h.view('ana').doing).toBeNull();
    h.hook('ana', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test -- export' } });
    expect(h.view('ana').doing).toBe('Bash: npm test -- export');
    h.hook('ana', 'PreToolUse', { tool_name: 'Read' });
    expect(h.view('ana').doing).toBe('Read');
  });

  it('only PreToolUse sets it', async () => {
    const h = await withAna();
    h.work('ana');
    for (const event of ['PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop'] as const) {
      h.hook('ana', event, { tool_name: 'Bash', tool_input: { command: 'ls' } });
      expect(h.view('ana').doing, event).toBeNull();
    }
  });

  it('goes out with the agent frame of that hook, and no frame follows when the text did not change', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PreToolUse', { tool_name: 'Grep', tool_input: { path: '/src' } });
    expect(h.frames('ana').at(-1)?.doing).toBe('Grep: /src');
    const frames = h.frames('ana').length;
    h.hook('ana', 'PreToolUse', { tool_name: 'Grep', tool_input: { path: '/src' } });
    expect(h.frames('ana')).toHaveLength(frames);
    h.hook('ana', 'PreToolUse', { tool_name: 'Grep', tool_input: { path: '/test' } });
    expect(h.frames('ana')).toHaveLength(frames + 1);
  });

  it('is cut to DOING_MAX_CHARS on one line without control characters', () => {
    expect(DOING_MAX_CHARS).toBe(120);
    const long = describeDoing('a'.repeat(100), { command: 'b'.repeat(100) });
    expect(long).toHaveLength(DOING_MAX_CHARS);
    expect(long.startsWith('a'.repeat(100))).toBe(true);
    expect(describeDoing('Bash', { command: 'echo\n\thi\u0000 \u001b[31m there‮' })).toBe('Bash: echo hi [31m there');
    // a cut never leaves half of a surrogate pair
    expect(describeDoing('a'.repeat(60), { command: `${'b'.repeat(58)}😀😀` })).not.toMatch(/[\ud800-\udbff]$/);
    expect(describeDoing(null, null)).toBe('unknown tool');
  });

  it('is reset by a restart, and a hook of an older generation does not set it', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PreToolUse', PERMISSION_PAYLOAD);
    const old = h.gen('ana');
    await h.hub.restart('ana');
    expect(h.view('ana').doing).toBeNull();
    h.hub.onHook({ agent: 'ana', generation: old, event: 'PreToolUse', payload: PERMISSION_PAYLOAD });
    expect(h.view('ana').doing).toBeNull();
  });

  it('stays null for a custom agent', async () => {
    const h = await started();
    await h.hub.hire({ name: 'cu', role: 'prints', dir: '/work/cu', mode: 'default', provider: 'custom', command: 'echo hi' });
    h.hook('cu', 'PreToolUse', PERMISSION_PAYLOAD);
    expect(h.view('cu').doing).toBeNull();
  });
});

describe('Hub.answer', () => {
  it('presses Enter for a go and Escape for a no-go, in the generation of the agent, and changes no state', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    const frames = h.frames('ana').length;
    const view = h.hub.answer('ana', { go: true });
    expect(view).toMatchObject({ name: 'ana', state: 'needs_you', needsKind: 'permission', needsReason: PERMISSION_REASON });
    h.hub.answer('ana', { go: false });
    expect(h.pressed).toEqual([
      { name: 'ana', generation: h.gen('ana'), data: '\r' },
      { name: 'ana', generation: h.gen('ana'), data: '\x1b' },
    ]);
    expect(h.view('ana').state).toBe('needs_you');
    expect(h.frames('ana')).toHaveLength(frames);
  });

  it('numbers each permission dialog and posts one Downlink event for it, in the inbox only', async () => {
    const h = await withAna();
    expect(h.view('ana').needSeq).toBeNull();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    expect(h.view('ana').needSeq).toBe(1);
    expect(h.notices).toEqual([['permission', 'ana asks: Bash: git push origin main']]);
    // a second dialog replaces the first one: a new number and a new event
    h.hook('ana', 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/work/ana/a.txt' } });
    expect(h.view('ana').needSeq).toBe(2);
    expect(h.notices.at(-1)).toEqual(['permission', 'ana asks: Edit: /work/ana/a.txt']);
    expect(h.notices).toHaveLength(2);
    // the same dialog again (a repeated hook) is the same dialog
    h.hook('ana', 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/work/ana/a.txt' } });
    expect(h.view('ana').needSeq).toBe(2);
    expect(h.notices).toHaveLength(2);
    // the number shows only while a dialog is open
    h.hook('ana', 'PostToolUse', PERMISSION_PAYLOAD);
    expect(h.view('ana').needSeq).toBeNull();
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    expect(h.view('ana').needSeq).toBe(3);
  });

  it('posts no event for a permission that a Hold or a trip has covered', async () => {
    const h = await withAna();
    h.work('ana');
    h.hub.hold('ana');
    const before = h.notices.length;
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    expect(h.notices.length).toBe(before);
    expect(h.view('ana').needSeq).toBeNull();
  });

  it('types the answer only for the dialog that is open: a late tap of a phone is a conflict and types nothing', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    const first = h.view('ana').needSeq ?? -1;
    // replaced by another dialog before the tap
    h.hook('ana', 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/work/ana/a.txt' } });
    expectHubError(() => h.hub.answer('ana', { go: true, needSeq: first }), 'conflict', /answered or replaced/, 'needSeq');
    expect(h.pressed).toEqual([]);
    expect(h.hub.answer('ana', { go: true, needSeq: first + 1 }).needSeq).toBe(first + 1);
    expect(h.pressed).toEqual([{ name: 'ana', generation: h.gen('ana'), data: '\r' }]);
    // answered in the terminal, then the tap comes: the state moved, so it is the usual conflict
    h.setScreen('ana', { promptBox: true, dialog: null });
    h.hook('ana', 'PostToolUse', PERMISSION_PAYLOAD);
    expectHubError(() => h.hub.answer('ana', { go: true, needSeq: first + 1 }), 'conflict', 'ana is not asking for a go');
    expect(h.pressed).toHaveLength(1);
    // a number from the future is not the open dialog either
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    expectHubError(() => h.hub.answer('ana', { go: false, needSeq: 99 }), 'conflict', /answered or replaced/, 'needSeq');
    expect(h.pressed).toHaveLength(1);
  });

  it('keeps the page working without a needSeq, and refuses one that is not a whole number', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    for (const bad of ['1', -1, 1.5, null, Number.NaN]) {
      expectHubError(() => h.hub.answer('ana', { go: true, needSeq: bad } as unknown as AnswerRequest), 'bad_request', 'needSeq must be a whole number', 'needSeq');
    }
    expect(h.pressed).toEqual([]);
    h.hub.answer('ana', { go: true });
    expect(h.pressed).toHaveLength(1);
  });

  it('the hooks end needs_you afterwards, as after a key typed in the terminal', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.hub.answer('ana', { go: true });
    h.setScreen('ana', { promptBox: true, dialog: null });
    h.hook('ana', 'PostToolUse', PERMISSION_PAYLOAD);
    expect(h.view('ana').state).toBe('working');
    expectHubError(() => h.hub.answer('ana', { go: true }), 'conflict', 'ana is not asking for a go');
  });

  it('is not_found for an unknown agent, conflict unless a permission is asked, bad_request for a go that is not a boolean', async () => {
    const h = await withAna();
    expectHubError(() => h.hub.answer('ghost', { go: true }), 'not_found', 'unknown agent');
    expectHubError(() => h.hub.answer('ana', { go: true }), 'conflict', 'ana is not asking for a go'); // idle
    h.work('ana');
    expectHubError(() => h.hub.answer('ana', { go: true }), 'conflict', 'ana is not asking for a go'); // working
    h.hook('ana', 'Notification', { notification_type: 'idle_prompt' });
    expectHubError(() => h.hub.answer('ana', { go: 'yes' } as unknown as AnswerRequest), 'bad_request', 'go must be true or false', 'go');
    expectHubError(() => h.hub.answer('ana', undefined as unknown as AnswerRequest), 'bad_request', /request/);
    expect(h.pressed).toEqual([]);
  });

  it('is a conflict for a startup dialog, a stopped agent and a running transition', async () => {
    const h = await started();
    await h.hireRaw('ana');
    h.setOutput('ana', 500);
    await h.advance(STARTUP_READY_TIMEOUT_MS);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'startup_dialog' });
    expectHubError(() => h.hub.answer('ana', { go: true }), 'conflict', 'ana is not asking for a go');
    h.hook('ana', 'Stop');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.script.stopGate = gate();
    const open = h.script.stopGate;
    const stopping = h.hub.stop('ana');
    await settle();
    expect(h.view('ana').transition).toBe('stopping');
    expectHubError(() => h.hub.answer('ana', { go: true }), 'conflict', 'ana is not asking for a go');
    open.open();
    await stopping;
    expect(h.view('ana').state).toBe('stopped');
    expectHubError(() => h.hub.answer('ana', { go: true }), 'conflict', 'ana is not asking for a go');
    expect(h.pressed).toEqual([]);
  });

  it('is a conflict when the host has no press or cannot reach the terminal, and it presses nothing else', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    h.script.pressResult = false;
    expectHubError(() => h.hub.answer('ana', { go: true }), 'conflict', 'could not reach the terminal of ana');
    delete h.io.press;
    expectHubError(() => h.hub.answer('ana', { go: false }), 'conflict', 'could not reach the terminal of ana');
    expect(h.view('ana').state).toBe('needs_you');
  });

  it('is a conflict while the hub shuts down', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', PERMISSION_PAYLOAD);
    void h.hub.shutdown();
    expectHubError(() => h.hub.answer('ana', { go: true }), 'conflict', 'the server is shutting down');
  });
});

describe('Redline', () => {
  const BASH = { tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const loop = (h: Harness, name: string, times: number): void => {
    for (let i = 0; i < times; i += 1) h.hook(name, 'PreToolUse', BASH);
  };

  it('trips on the same tool call five times in a row: Escape, needs_you, mail held', async () => {
    const h = await withAna();
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS - 1);
    expect(h.view('ana').state).toBe('working');
    expect(h.pressed).toHaveLength(0);
    h.hook('ana', 'PreToolUse', BASH);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'redline', needsReason: 'redline: loop: Bash: npm test 5 times in a row' });
    expect(h.pressed).toEqual([{ name: 'ana', generation: h.gen('ana'), data: '\x1b' }]);
    h.send('user', 'ana', 'are you there?');
    expect(h.view('ana').held).toEqual({ kind: 'redline', text: 'held: redline on ana' });
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: 'held: redline on ana' });
    await h.advance(DELIVERY_COALESCE_MS * 4);
    expect(h.typed).toHaveLength(0);
  });

  it('tells the Downlink once per trip, with the agent and the reason', async () => {
    const h = await withAna();
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS + 3);
    expect(h.notices).toEqual([['redline', 'ana: loop: Bash: npm test 5 times in a row']]);
    // a trip that changes nothing (already tripped) is no news; after a resume the next trip is
    h.hub.trip('ana', 'again');
    expect(h.notices).toHaveLength(1);
    h.hub.resume('ana');
    h.hub.trip('ana', 'out of propellant: 2M of 1M tokens in 5h');
    expect(h.notices.at(-1)).toEqual(['redline', 'ana: out of propellant: 2M of 1M tokens in 5h']);
    expect(h.notices).toHaveLength(2);
  });

  it('does not count a different call in between', async () => {
    const h = await withAna();
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS - 1);
    h.hook('ana', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' } });
    loop(h, 'ana', REDLINE_REPEATS - 1);
    expect(h.view('ana').state).toBe('working');
  });

  it('stays tripped whatever the hooks and the screen say, and a Stop hands over no mail', async () => {
    const h = await withAna();
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS);
    h.send('user', 'ana', 'later');
    h.hook('ana', 'PostToolUse');
    expect(h.hook('ana', 'Stop')).toStrictEqual({});
    h.setTitle('ana', 'idle');
    await h.advance(TITLE_IDLE_RECONCILE_MS * 2);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'redline' });
    expect(h.msg('m1').status).toBe('held');
  });

  it('resume clears it and the held mail is delivered', async () => {
    const h = await withAna();
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS);
    h.send('user', 'ana', 'go on');
    h.setTitle('ana', 'idle');
    expect(h.hub.resume('ana')).toMatchObject({ state: 'idle', needsKind: null });
    expect(h.msg('m1')).toMatchObject({ status: 'queued' });
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(1);
    // the counter starts again from zero
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS - 1);
    expect(h.view('ana').state).toBe('working');
  });

  it('resume of an agent that did not trip is a conflict; an unknown name is not_found', async () => {
    const h = await withAna();
    expectHubError(() => h.hub.resume('ana'), 'conflict', 'ana has not tripped the redline');
    expectHubError(() => h.hub.resume('ghost'), 'not_found');
    expectHubError(() => h.hub.trip('ghost', 'x'), 'not_found');
  });

  it('the Director typing into the terminal ends the trip', async () => {
    const h = await withAna();
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS);
    h.prompt('ana', 'stop looping and run the tests once');
    expect(h.view('ana')).toMatchObject({ state: 'working', needsKind: null });
  });

  it('Hold: the Director trips it by hand, with no Downlink notice; resume ends it and the mail goes', async () => {
    const h = await withAna();
    h.work('ana');
    expect(h.hub.hold('ana')).toMatchObject({ state: 'needs_you', needsKind: 'redline', needsReason: HOLD_REASON });
    expect(h.pressed).toEqual([{ name: 'ana', generation: h.gen('ana'), data: '\x1b' }]);
    expect(h.notices).toEqual([]);
    h.send('user', 'ana', 'when you are back');
    expect(h.msg('m1')).toMatchObject({ status: 'held', note: 'held: ana is on hold' });
    h.hook('ana', 'Stop');
    expect(h.view('ana').needsReason).toBe(HOLD_REASON);
    expectHubError(() => h.hub.hold('ana'), 'conflict', 'ana is already on hold');
    h.setTitle('ana', 'idle');
    expect(h.hub.resume('ana')).toMatchObject({ state: 'idle', needsKind: null });
    await h.advance(DELIVERY_SETTLE_MS);
    expect(h.typed).toHaveLength(1);
  });

  it('Hold of an idle agent presses nothing; it is refused while tripped, needing you, stopped or without hooks', async () => {
    const h = await withAna();
    expect(h.hub.hold('ana').needsReason).toBe(HOLD_REASON);
    expect(h.pressed).toEqual([]);
    h.hub.resume('ana');
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS);
    expectHubError(() => h.hub.hold('ana'), 'conflict', 'ana has tripped the redline: resume or stop it');
    h.hub.resume('ana');
    h.work('ana');
    h.hook('ana', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expectHubError(() => h.hub.hold('ana'), 'conflict', 'ana needs you: answer it first');
    await h.hub.stop('ana');
    expectHubError(() => h.hub.hold('ana'), 'conflict', 'ana is not running');
    await h.hub.hire({ name: 'tail', role: 'watches', dir: '/work/tail', mode: 'default', provider: 'custom', command: 'htop' });
    expectHubError(() => h.hub.hold('tail'), 'conflict', 'tail reports no hooks, so gonogo cannot hold it');
    expectHubError(() => h.hub.hold('ghost'), 'not_found');
  });

  it('Telemetry: the tool hooks of the current process go to io.toolHook', async () => {
    const h = await withAna();
    const seen: Array<[string, string, unknown]> = [];
    h.io.toolHook = (name, event, payload) => void seen.push([name, event, payload.tool_use_id]);
    h.work('ana');
    h.hook('ana', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    h.hook('ana', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 't1' });
    h.hook('ana', 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 't2' });
    h.hook('ana', 'Stop');
    expect(seen).toEqual([
      ['ana', 'PreToolUse', 't1'],
      ['ana', 'PostToolUse', 't1'],
      ['ana', 'PostToolUseFailure', 't2'],
    ]);
    h.io.toolHook = () => {
      throw new Error('disk full');
    };
    h.hook('ana', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' } });
    expect(h.view('ana').state).toBe('working');
  });

  it('a restart ends the trip', async () => {
    const h = await withAna();
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS);
    await h.hub.restart('ana');
    h.ready('ana');
    expect(h.view('ana')).toMatchObject({ state: 'idle', needsKind: null });
  });

  it('trips on an error storm of failed tool calls, and of API errors', async () => {
    const h = await withAna();
    await h.hire('ben');
    h.work('ana');
    for (let i = 0; i < REDLINE_TOOL_FAILURES - 1; i += 1) h.hook('ana', 'PostToolUseFailure');
    expect(h.view('ana').state).toBe('working');
    h.hook('ana', 'PostToolUseFailure');
    expect(h.view('ana').needsReason).toBe(`redline: error storm: ${REDLINE_TOOL_FAILURES} failed tool calls in 2 min`);
    for (let i = 0; i < REDLINE_API_ERRORS; i += 1) {
      h.work('ben');
      h.hook('ben', 'StopFailure');
    }
    expect(h.view('ben')).toMatchObject({ state: 'needs_you', needsReason: `redline: error storm: ${REDLINE_API_ERRORS} API errors in 10 min` });
    // ben was idle after its last API error: nothing to interrupt
    expect(h.pressed.map((p) => p.name)).toEqual(['ana']);
  });

  it('forgets failures that fell out of the window', async () => {
    const h = await withAna();
    h.work('ana');
    for (let i = 0; i < REDLINE_TOOL_FAILURES - 1; i += 1) h.hook('ana', 'PostToolUseFailure');
    await h.advance(120_000);
    h.hook('ana', 'PostToolUseFailure');
    expect(h.view('ana').state).toBe('working');
  });

  it('trips a ping-pong: too many messages to the same recipient', async () => {
    const h = await withAna();
    await h.hire('ben');
    h.work('ana');
    for (let i = 0; i < REDLINE_SENDS_TO_ONE; i += 1) h.send('ana', 'ben', `ping ${i}`);
    expect(h.view('ana').state).toBe('working');
    h.send('ana', 'ben', 'ping again');
    expect(h.view('ana').needsReason).toBe(`redline: ping-pong: ${REDLINE_SENDS_TO_ONE + 1} messages to ben in 10 min`);
  });

  it('with the detectors off nothing trips by itself, but Hub.trip still does', async () => {
    const h = await withAna({ redline: false });
    h.work('ana');
    loop(h, 'ana', REDLINE_REPEATS * 2);
    expect(h.view('ana').state).toBe('working');
    h.hub.trip('ana', 'out of propellant: 2M of 1M tokens in 5h');
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsReason: 'redline: out of propellant: 2M of 1M tokens in 5h' });
  });

  it('never trips a stopped agent', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    h.hub.trip('ana', 'x');
    expect(h.view('ana')).toMatchObject({ state: 'stopped', needsKind: null });
  });

  it('meters the transcript at every Stop and at most every METER_INTERVAL_MS on a tool call', async () => {
    const h = await withAna();
    h.work('ana');
    const path = '/home/u/.claude/projects/p/s.jsonl';
    h.hook('ana', 'PreToolUse', { ...BASH, transcript_path: path });
    h.hook('ana', 'PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: path });
    expect(h.metered).toHaveLength(1);
    await h.advance(METER_INTERVAL_MS);
    h.hook('ana', 'PreToolUse', { tool_name: 'Read', tool_input: {}, transcript_path: path });
    h.hook('ana', 'Stop', { transcript_path: path });
    expect(h.metered).toEqual([
      { name: 'ana', generation: h.gen('ana'), transcriptPath: path },
      { name: 'ana', generation: h.gen('ana'), transcriptPath: path },
      { name: 'ana', generation: h.gen('ana'), transcriptPath: path },
    ]);
    h.hook('ana', 'Stop', {});
    expect(h.metered).toHaveLength(3);
  });
});

describe('Payload: MCP servers and skills per agent (hire and edit)', () => {
  const files = { command: 'npx', args: ['-y', 'server-files'], env: { ROOT: '/work' } };
  const remote = { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer abc' } };
  const hireWith = (h: Harness, payload: unknown, patch: Record<string, unknown> = {}): Promise<AgentView> =>
    h.hub.hire({ name: 'ana', role: 'x', dir: '/work/ana', mode: 'default', payload, ...patch } as unknown as HireRequest);

  it('stores the payload in the record and the view, and hands it to the launcher with the spawn', async () => {
    const h = await started();
    const payload = { mcpServers: { files, remote }, skills: ['/skills/review/'] };
    const view = await hireWith(h, payload);
    const stored = { mcpServers: { files, remote }, skills: ['/skills/review'] };
    expect(view.payload).toEqual(stored);
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')?.payload).toEqual(stored);
    expect(h.spawns.at(-1)?.agent.payload).toEqual(stored);
  });

  it('an agent without one has no payload in its record, an empty payload is none, and null is none', async () => {
    const h = await started();
    await hireWith(h, { mcpServers: {}, skills: [] });
    await hireWith(h, null, { name: 'ben', dir: '/work/ben' });
    for (const name of ['ana', 'ben']) {
      expect(h.saves.at(-1)?.agents.find((record) => record.name === name)).not.toHaveProperty('payload');
      expect(h.view(name).payload).toBeNull();
    }
  });

  it('names the field that is wrong, and creates nothing', async () => {
    const h = await started();
    h.script.missingDirs.add('/skills/missing');
    const refuse = (payload: unknown, field: string, message: string | RegExp): Promise<void> => expectHubReject(hireWith(h, payload), 'bad_request', message, field);
    await refuse([], 'payload', 'payload must be an object');
    await refuse({ tools: [] }, 'payload', 'payload has no field "tools"');
    await refuse({ mcpServers: { gonogo: { command: 'x' } } }, 'payload.mcpServers', /reserved/);
    await refuse({ mcpServers: { 'Bad Name': { command: 'x' } } }, 'payload.mcpServers', /server name "Bad Name"/);
    await refuse({ mcpServers: { a: { command: '' } } }, 'payload.mcpServers', /command must be text of 1 to/);
    await refuse({ mcpServers: { a: { url: 'https://example.test' } } }, 'payload.mcpServers', /"url" is not a field of a stdio server/);
    await refuse({ mcpServers: { a: { type: 'http', url: 'ftp://example.test' } } }, 'payload.mcpServers', /http or https address/);
    await refuse({ mcpServers: { a: { command: 'x', env: { 'BAD-NAME': '1' } } } }, 'payload.mcpServers', /not a usable name/);
    await refuse({ mcpServers: { a: { type: 'http', url: 'https://example.test', headers: { H: 'a\nb' } } } }, 'payload.mcpServers', /line break/);
    await refuse({ mcpServers: { a: { command: 'x', args: [1] } } }, 'payload.mcpServers', /args\[0\]/);
    await refuse({ skills: ['relative/skill'] }, 'payload.skills', /absolute path/);
    await refuse({ skills: ['/a/review', '/b/review'] }, 'payload.skills', /differ in name/);
    await refuse({ skills: ['/skills/missing'] }, 'payload.skills', 'skill folder: directory does not exist: /skills/missing');
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
  });

  it('only an engine that takes a payload gets one: skills need Claude Code, a custom command takes nothing', async () => {
    const h = await started();
    await hireWith(h, { mcpServers: { files } }, { name: 'gem', dir: '/work/gem', provider: 'gemini' });
    expect(h.view('gem').payload).toEqual({ mcpServers: { files } });
    await expectHubReject(hireWith(h, { skills: ['/skills/review'] }, { name: 'gem2', dir: '/work/gem2', provider: 'gemini' }), 'bad_request', /skills need Claude Code/, 'payload.skills');
    await expectHubReject(hireWith(h, { mcpServers: { files } }, { name: 'pi1', dir: '/work/pi1', provider: 'pi' }), 'bad_request', 'pi takes no payload', 'payload');
    await expectHubReject(hireWith(h, { mcpServers: { files } }, { name: 'tail', dir: '/work/tail', provider: 'custom', command: 'htop' }), 'bad_request', 'Custom command takes no payload', 'payload');
  });

  it('edit replaces the whole payload, null removes it, and either one is dirty until the restart', async () => {
    const h = await withAna();
    expect(h.view('ana').dirty).toBe(false);
    const view = await h.hub.edit('ana', { payload: { mcpServers: { files } } });
    expect(view).toMatchObject({ payload: { mcpServers: { files } }, dirty: true });
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')?.payload).toEqual({ mcpServers: { files } });
    await h.hub.restart('ana');
    expect(h.spawns.at(-1)?.agent.payload).toEqual({ mcpServers: { files } });
    expect(h.view('ana').dirty).toBe(false);
    // the same payload again changes nothing
    await h.hub.edit('ana', { payload: { mcpServers: { files } } });
    expect(h.view('ana').dirty).toBe(false);
    const cleared = await h.hub.edit('ana', { payload: null });
    expect(cleared).toMatchObject({ payload: null, dirty: true });
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')).not.toHaveProperty('payload');
  });

  it('a refused edit and a roster that cannot be saved leave the payload as it was', async () => {
    const h = await started();
    await hireWith(h, { mcpServers: { files } });
    await expectHubReject(h.hub.edit('ana', { payload: { mcpServers: { gonogo: { command: 'x' } } } }), 'bad_request', /reserved/, 'payload.mcpServers');
    h.script.saveError = 'disk full';
    await expectHubReject(h.hub.edit('ana', { payload: null }), 'internal', 'could not save the roster: disk full');
    expect(h.view('ana').payload).toEqual({ mcpServers: { files } });
    expect(h.view('ana').dirty).toBe(false);
  });

  it('a custom agent cannot be given a payload by an edit either', async () => {
    const h = await started();
    await h.hub.hire({ name: 'tail', role: 'x', dir: '/work/tail', mode: 'default', provider: 'custom', command: 'htop' });
    await expectHubReject(h.hub.edit('tail', { payload: { mcpServers: { files } } }), 'bad_request', 'Custom command takes no payload', 'payload');
  });
});

describe('Clean Room: a container on its own worktree (hire and edit)', () => {
  const hireWith = (h: Harness, cleanRoom: unknown, patch: Record<string, unknown> = {}): Promise<AgentView> =>
    h.hub.hire({ name: 'ana', role: 'x', dir: '/work/ana', mode: 'default', cleanRoom, ...patch } as unknown as HireRequest);

  it('stores the setting in the record and the view, checks the directory and hands the record to the launcher', async () => {
    const h = await started();
    const view = await hireWith(h, { image: 'my/image:2' });
    expect(view.cleanRoom).toEqual({ image: 'my/image:2' });
    expect(h.cleanRoomChecks).toEqual(['/work/ana']);
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')?.cleanRoom).toEqual({ image: 'my/image:2' });
    expect(h.spawns.at(-1)?.agent.cleanRoom).toEqual({ image: 'my/image:2' });
  });

  it('{} is the default image, and an agent without the setting has none: no key in the record, null in the view', async () => {
    const h = await started();
    expect((await hireWith(h, {})).cleanRoom).toEqual({});
    const plain = await hireWith(h, undefined, { name: 'ben', dir: '/work/ben' });
    expect(plain.cleanRoom).toBeNull();
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ben')).not.toHaveProperty('cleanRoom');
    expect(h.cleanRoomChecks).toEqual(['/work/ana']);
  });

  it('refuses a bad value, another engine and a check that fails, names the field and creates nothing', async () => {
    const h = await started();
    const refuse = (cleanRoom: unknown, message: string | RegExp, patch: Record<string, unknown> = {}): Promise<void> =>
      expectHubReject(hireWith(h, cleanRoom, patch), 'bad_request', message, 'cleanRoom');
    await refuse([], 'cleanRoom must be an object');
    await refuse({ image: '-v' }, /Docker image name/);
    await refuse({ image: 'a b' }, /Docker image name/);
    await refuse({ image: 3 }, /Docker image name/);
    await refuse({ imag: 'x' }, 'cleanRoom has no field "imag"');
    await refuse({}, 'a Clean Room runs Claude Code agents only', { provider: 'gemini' });
    h.script.cleanRoomProblem = 'Clean Room needs Docker, and "docker version" failed: Cannot connect';
    await refuse({}, /docker version/);
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
    expect(h.spawns.filter((spawn) => spawn.agent.name === 'ana')).toEqual([]);
  });

  it('edit turns it on and off, checks the new directory, and either way is dirty until the restart', async () => {
    const h = await withAna();
    const on = await h.hub.edit('ana', { cleanRoom: {} });
    expect(on).toMatchObject({ cleanRoom: {}, dirty: true });
    expect(h.cleanRoomChecks).toEqual(['/work/ana']);
    await h.hub.restart('ana');
    expect(h.spawns.at(-1)?.agent.cleanRoom).toEqual({});
    expect(h.view('ana').dirty).toBe(false);
    await h.hub.edit('ana', { cleanRoom: {} });
    expect(h.view('ana').dirty).toBe(false);
    const moved = await h.hub.edit('ana', { dir: '/work/other', cleanRoom: { image: 'x' } });
    expect(moved).toMatchObject({ dir: '/work/other', cleanRoom: { image: 'x' }, dirty: true });
    expect(h.cleanRoomChecks.at(-1)).toBe('/work/other');
    const off = await h.hub.edit('ana', { cleanRoom: null });
    expect(off.cleanRoom).toBeNull();
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')).not.toHaveProperty('cleanRoom');
  });

  it('a refused edit and a roster that cannot be saved leave the setting as it was', async () => {
    const h = await withAna();
    h.script.cleanRoomProblem = 'not a repository';
    await expectHubReject(h.hub.edit('ana', { cleanRoom: {} }), 'bad_request', 'not a repository', 'cleanRoom');
    expect(h.view('ana').cleanRoom).toBeNull();
    h.script.cleanRoomProblem = null;
    await h.hub.edit('ana', { cleanRoom: {} });
    h.script.saveError = 'disk full';
    await expectHubReject(h.hub.edit('ana', { cleanRoom: null }), 'internal', 'could not save the roster: disk full');
    expect(h.view('ana').cleanRoom).toEqual({});
  });

  it('a Clean Room console is not renamed: its worktree and branch carry the name', async () => {
    const h = await withAna();
    await h.hub.edit('ana', { cleanRoom: {} });
    await h.hub.stop('ana');
    await expectHubReject(h.hub.edit('ana', { name: 'bea' }), 'conflict', /cannot be renamed/, 'name');
    expect(h.view('ana').name).toBe('ana');
    const renamed = await h.hub.edit('ana', { name: 'bea', cleanRoom: null });
    expect(renamed).toMatchObject({ name: 'bea', cleanRoom: null });
  });

  it('a hub whose IO has no check hires as asked (the fakes of the other tests)', async () => {
    const h = await started();
    delete (h.io as { checkCleanRoom?: unknown }).checkCleanRoom;
    expect((await hireWith(h, {})).cleanRoom).toEqual({});
  });
});

describe('Worktree: an agent in its own git worktree (hire and edit)', () => {
  const hireWith = (h: Harness, worktree: unknown, patch: Record<string, unknown> = {}): Promise<AgentView> =>
    h.hub.hire({ name: 'ana', role: 'x', dir: '/work/ana', mode: 'default', worktree, ...patch } as unknown as HireRequest);
  /** The fake check of the repository: the directories it was asked about, and its answer. */
  const checking = (h: Harness, problem: { text: string | null } = { text: null }): string[] => {
    const asked: string[] = [];
    h.io.checkWorktree = async (dir) => {
      asked.push(dir);
      return problem.text;
    };
    return asked;
  };

  it('stores the setting in the record and the view, checks the directory and hands the record to the launcher', async () => {
    const h = await started();
    const asked = checking(h);
    const view = await hireWith(h, {});
    expect(view.worktree).toEqual({});
    expect(asked).toEqual(['/work/ana']);
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')?.worktree).toEqual({});
    expect(h.spawns.at(-1)?.agent.worktree).toEqual({});
    const plain = await hireWith(h, undefined, { name: 'ben', dir: '/work/ben' });
    expect(plain.worktree).toBeNull();
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ben')).not.toHaveProperty('worktree');
    expect(asked).toEqual(['/work/ana']);
  });

  it('refuses a bad value, a Clean Room as well and a directory outside a repository, names the field and creates nothing', async () => {
    const h = await started();
    const problem = { text: null as string | null };
    checking(h, problem);
    const refuse = (worktree: unknown, message: string | RegExp, patch: Record<string, unknown> = {}): Promise<void> =>
      expectHubReject(hireWith(h, worktree, patch), 'bad_request', message, 'worktree');
    await refuse([], 'worktree must be an object');
    await refuse({ branch: 'x' }, 'worktree has no field "branch"');
    await refuse({}, /has a worktree already/, { cleanRoom: {} });
    problem.text = 'a worktree needs the directory to be inside a git repository: not a git repository';
    await refuse({}, /inside a git repository/);
    expect(h.saves.at(-1)?.agents.some((record) => record.name === 'ana') ?? false).toBe(false);
  });

  it('is turned on and off by an edit, the console is dirty until the restart, and a rename waits for it to be off', async () => {
    const h = await withAna();
    const asked = checking(h);
    const on = await h.hub.edit('ana', { worktree: {} });
    expect(on).toMatchObject({ worktree: {}, dirty: true });
    expect(asked).toEqual(['/work/ana']);
    await h.hub.stop('ana');
    await expectHubReject(h.hub.edit('ana', { name: 'bea' }), 'conflict', /cannot be renamed/, 'name');
    await expectHubReject(h.hub.edit('ana', { cleanRoom: {} }), 'bad_request', /has a worktree already/, 'worktree');
    const renamed = await h.hub.edit('ana', { name: 'bea', worktree: null });
    expect(renamed).toMatchObject({ name: 'bea', worktree: null });
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'bea')).not.toHaveProperty('worktree');
  });

  it('checks the new folder of an edit when the worktree stays on', async () => {
    const h = await withAna();
    const problem = { text: null as string | null };
    const asked = checking(h, problem);
    await h.hub.edit('ana', { worktree: {} });
    await h.hub.edit('ana', { dir: '/work/other' });
    expect(asked).toEqual(['/work/ana', '/work/other']);
    problem.text = 'a worktree needs the directory to be inside a git repository: no';
    await expectHubReject(h.hub.edit('ana', { dir: '/work/third' }), 'bad_request', /inside a git repository/, 'worktree');
    expect(h.view('ana').dir).toBe('/work/other');
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * Docking (docs/docking-spec.md): name@station
 * ---------------------------------------------------------------------------------------------------------- */

describe('docking', () => {
  /** A dock that answers when the test says so. */
  function fakeDock(stations = ['lab']): {
    link: NonNullable<HubIo['dock']>;
    sent: Array<{ station: string; message: StationMessage }>;
    answer: { value: { ok: boolean; note: string | null } | Promise<{ ok: boolean; note: string | null }> };
    rosters: Array<{ station: string; agents: DockedAgent[] }>;
  } {
    const sent: Array<{ station: string; message: StationMessage }> = [];
    const answer: { value: { ok: boolean; note: string | null } | Promise<{ ok: boolean; note: string | null }> } = { value: { ok: true, note: 'accepted by lab: queued' } };
    const rosters: Array<{ station: string; agents: DockedAgent[] }> = [];
    const link: NonNullable<HubIo['dock']> = {
      stations: () => stations,
      rosters: () => rosters,
      send: async (station, message) => {
        sent.push({ station, message });
        return answer.value;
      },
    };
    return { link, sent, answer, rosters };
  }

  async function docked(options?: HarnessOptions): Promise<{ h: Harness; dock: ReturnType<typeof fakeDock> }> {
    const h = await withAna(options);
    const dock = fakeDock();
    h.io.dock = dock.link;
    return { h, dock };
  }

  it('hands a message to name@station: queued while the other station answers, then delivered with its answer', async () => {
    const { h, dock } = await docked();
    let reply: (value: { ok: boolean; note: string | null }) => void = () => undefined;
    dock.answer.value = new Promise((resolve) => (reply = resolve));
    const result = h.send('ana', 'bob@lab', 'please look', 'a look');
    expect(result).toMatchObject({ ok: true, to: 'bob@lab', status: 'queued', note: 'sending to lab' });
    expect(dock.sent).toEqual([{ station: 'lab', message: { from: 'ana', to: 'bob', subject: 'a look', body: 'please look', hops: 1 } }]);
    reply({ ok: true, note: 'accepted by lab: queued' });
    await settle();
    expect(h.msg(result.id)).toMatchObject({ from: 'ana', to: 'bob@lab', status: 'delivered', note: 'accepted by lab: queued' });
    // nothing here will read it: it is not a message waiting for an agent
    expect(h.view('ana').queued).toBe(0);
  });

  it('a message the other station did not deliver is undelivered with its reason', async () => {
    const { h, dock } = await docked();
    dock.answer.value = { ok: false, note: 'lab refused: unknown recipient "bob"' };
    const result = h.send('ana', 'bob@lab');
    await settle();
    expect(h.msg(result.id)).toMatchObject({ status: 'undelivered', note: 'lab refused: unknown recipient "bob"' });
  });

  it('a send that throws is undelivered, and the hub keeps working', async () => {
    const { h, dock } = await docked();
    dock.link.send = () => Promise.reject(new Error('boom'));
    const result = h.send('ana', 'boss@lab');
    await settle();
    expect(h.msg(result.id)).toMatchObject({ status: 'undelivered', note: 'could not send to lab' });
    expect(h.warnings.some((line) => line.includes('docked send failed'))).toBe(true);
  });

  it('refuses an address that is not a docked station or a name, and the Director and a missing dock', async () => {
    const { h, dock } = await docked();
    expectHubError(() => h.send('ana', 'bob@nowhere'), 'not_found', 'unknown station "nowhere". Docked: lab', 'to');
    expectHubError(() => h.send('ana', 'Bob@lab'), 'bad_request', /name@station/, 'to');
    expectHubError(() => h.send('ana', 'bob@LAB'), 'bad_request', /name@station/, 'to');
    expectHubError(() => h.send('ana', '@lab'), 'bad_request', /name@station/, 'to');
    expectHubError(() => h.send('user', 'bob@lab'), 'bad_request', 'only an agent writes to another station: ask one to', 'to');
    expect(dock.sent).toEqual([]);
    h.io.dock = fakeDock([]).link;
    expectHubError(() => h.send('ana', 'bob@lab'), 'not_found', 'unknown station "lab". No station is docked', 'to');
    delete h.io.dock;
    expectHubError(() => h.send('ana', 'bob@lab'), 'bad_request', 'docking is not available', 'to');
  });

  it('applies the hop limit and the send limit of the sender, and Redline counts the messages to one station agent', async () => {
    const { h, dock } = await docked({ maxHops: 1 });
    await h.hire('ben');
    h.send('ben', 'ana', 'one');
    h.read('ana');
    // ana now answers a message with hops 1: her next one has hops 2, more than the limit
    const over = h.send('ana', 'bob@lab');
    expect(over).toMatchObject({ ok: false, status: 'undelivered', note: 'hop limit 1 reached; the message went to the user' });
    expect(dock.sent).toEqual([]);
    const second = await docked();
    for (let i = 0; i < REDLINE_SENDS_TO_ONE + 1; i += 1) second.h.send('ana', 'bob@lab', `ping ${i}`);
    expect(second.h.view('ana').needsReason).toBe(`redline: ping-pong: ${REDLINE_SENDS_TO_ONE + 1} messages to bob@lab in 10 min`);
  });

  it('a message from a station is a message from name@station to the agent, with the hops it came with', async () => {
    const { h } = await docked();
    // an id of the other station's is not one of ours: inReplyTo does not cross
    const result = h.hub.sendFromStation('lab', { from: 'bob', to: 'ana', subject: 'hello', body: 'from the lab', hops: 3, inReplyTo: 'm1' } as StationMessage);
    expect(result).toMatchObject({ ok: true, to: 'ana', status: 'queued' });
    expect(h.msg(result.id)).toMatchObject({ from: 'bob@lab', to: 'ana', subject: 'hello', hops: 3 });
    const read = h.read('ana');
    expect(read.messages).toMatchObject([{ from: 'bob@lab', subject: 'hello', body: 'from the lab', inReplyTo: null }]);
    // the reply goes back the same way, and continues the hops
    const reply = h.send('ana', 'bob@lab', 'thanks');
    expect(reply.status).toBe('queued');
    expect(h.msg(reply.id).hops).toBe(4);
  });

  it('a message from a station to the boss goes to the boss, and one that is over the hop limit is undelivered here', async () => {
    const { h } = await docked({ maxHops: 2 });
    const boss = h.hub.sendFromStation('lab', { from: 'bob', to: 'boss', subject: '', body: 'to the boss', hops: 1 });
    expect(boss.to).toBe('flight');
    const over = h.hub.sendFromStation('lab', { from: 'bob', to: 'ana', subject: '', body: 'too far', hops: 3 });
    expect(over).toMatchObject({ ok: false, status: 'undelivered', note: 'hop limit 2 reached; the message went to the user' });
  });

  it('refuses what a station may not do: write to the Director, pass a message on, or send nonsense', async () => {
    const { h } = await docked();
    const from = (patch: Partial<StationMessage>): StationMessage => ({ from: 'bob', to: 'ana', subject: '', body: 'hi', hops: 1, ...patch });
    expectHubError(() => h.hub.sendFromStation('lab', from({ to: 'user' })), 'bad_request', /cannot be addressed to user/, 'to');
    expectHubError(() => h.hub.sendFromStation('lab', from({ to: 'cy@mars' })), 'bad_request', /cannot be passed on/, 'to');
    expectHubError(() => h.hub.sendFromStation('lab', from({ to: 'ghost' })), 'not_found', /unknown recipient "ghost"/, 'to');
    expectHubError(() => h.hub.sendFromStation('lab', from({ from: 'Bob' })), 'bad_request', 'from must be an agent name', 'from');
    expectHubError(() => h.hub.sendFromStation('lab', from({ from: 'bob@x' })), 'bad_request', 'from must be an agent name', 'from');
    expectHubError(() => h.hub.sendFromStation('lab', from({ hops: -1 })), 'bad_request', 'hops must be a whole number', 'hops');
    expectHubError(() => h.hub.sendFromStation('lab', from({ hops: 1.5 })), 'bad_request', 'hops must be a whole number', 'hops');
    expectHubError(() => h.hub.sendFromStation('lab', from({ body: ' ' })), 'bad_request', 'body must not be empty', 'body');
    expectHubError(() => h.hub.sendFromStation('lab', null as unknown as StationMessage), 'bad_request', /must be a JSON object/);
  });

  it('list_roster adds the agents of the docked stations', async () => {
    const { h, dock } = await docked();
    expect(h.hub.rosterFor('ana', h.gen('ana'))).not.toHaveProperty('docked');
    dock.rosters.push({ station: 'lab', agents: [{ name: 'bob', role: 'tests', state: 'idle', boss: false }] });
    expect(h.hub.rosterFor('ana', h.gen('ana')).docked).toEqual([{ station: 'lab', agents: [{ name: 'bob', role: 'tests', state: 'idle', boss: false }] }]);
  });

  it('a message to a station that was accepted stays delivered after a restart, and one that never left becomes undelivered', async () => {
    const accepted: MessageRecord = { id: 'm1', from: 'ana', to: 'bob@lab', subject: '', body: 'sent', inReplyTo: null, hops: 1, at: T0, status: 'delivered', note: 'accepted by lab: queued', updatedAt: T0 };
    const sending: MessageRecord = { ...accepted, id: 'm2', body: 'in flight', status: 'queued', note: 'sending to lab' };
    const local: MessageRecord = { ...accepted, id: 'm3', to: 'ben', status: 'delivered', note: null };
    const h = await started({ history: [accepted, sending, local] });
    expect(h.msg('m1').status).toBe('delivered');
    expect(h.msg('m2')).toMatchObject({ status: 'undelivered', note: 'server restarted before it was read; the message went to the user' });
    expect(h.msg('m3').status).toBe('undelivered');
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * Engine Bay: the model of an agent and Clearance, its keys (docs/engine-bay-spec.md)
 * ---------------------------------------------------------------------------------------------------------- */

describe('Engine Bay: the model and the keys of an agent', () => {
  const SECRET = 'sk-test-0123456789abcdef';
  /** A key store of memory: what the hub asked it, and what it holds. */
  function withKeys(h: Harness): { held: Map<string, Record<string, string>>; calls: string[] } {
    const held = new Map<string, Record<string, string>>();
    const calls: string[] = [];
    h.io.keys = {
      values: (name) => ({ ...held.get(name) }),
      apply: async (name, patch, fresh = false) => {
        calls.push(`apply ${name}${fresh ? ' fresh' : ''}`);
        const next: Record<string, string> = { ...(fresh ? {} : held.get(name)) };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        if (Object.keys(next).length === 0) held.delete(name);
        else held.set(name, next);
      },
      rename: async (oldName, newName) => {
        calls.push(`rename ${oldName} ${newName}`);
        const keys = held.get(oldName);
        if (keys) held.set(newName, keys);
        held.delete(oldName);
      },
      remove: async (name) => {
        calls.push(`remove ${name}`);
        held.delete(name);
      },
    };
    return { held, calls };
  }
  const hireWith = (h: Harness, patch: Record<string, unknown> = {}): Promise<AgentView> =>
    h.hub.hire({ name: 'ana', role: 'x', dir: '/work/ana', mode: 'default', ...patch } as unknown as HireRequest);

  it('hire stores the model in the record and the view, and hands the record to the launcher', async () => {
    const h = await started();
    const view = await hireWith(h, { model: ' sonnet ' });
    expect(view.model).toBe('sonnet');
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')?.model).toBe('sonnet');
    expect(h.spawns.at(-1)?.agent.model).toBe('sonnet');
  });

  it('empty text is no model: no key in the record, null in the view', async () => {
    const h = await started();
    expect((await hireWith(h, { model: '  ' })).model).toBeNull();
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')).not.toHaveProperty('model');
    expect((await hireWith(h, { name: 'ben', dir: '/work/ben' })).model).toBeNull();
  });

  it('refuses a bad name, a name that looks like a flag, a model for an engine that has none, and a model that is not text', async () => {
    const h = await started();
    for (const model of ['-x', '--model', 'a b', 'a;b', '$(id)', 'x'.repeat(101), '\nx;']) {
      await expectHubReject(hireWith(h, { model }), 'bad_request', /model must be 1 to 100 letters/, 'model');
    }
    await expectHubReject(hireWith(h, { model: 'x', provider: 'opencode' }), 'bad_request', 'opencode takes no model setting', 'model');
    await expectHubReject(hireWith(h, { model: 'x', provider: 'custom', command: 'htop' }), 'bad_request', 'Custom command takes no model setting', 'model');
    await expectHubReject(hireWith(h, { model: 5 }), 'bad_request', /model must be/, 'model');
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
    expect((await hireWith(h, { model: 'flash', provider: 'gemini' })).model).toBe('flash');
  });

  it('edit changes and clears the model, and either is dirty until the restart', async () => {
    const h = await withAna();
    const set = await h.hub.edit('ana', { model: 'opus' });
    expect(set).toMatchObject({ model: 'opus', dirty: true });
    await h.hub.restart('ana');
    expect(h.spawns.at(-1)?.agent.model).toBe('opus');
    expect(h.view('ana').dirty).toBe(false);
    await h.hub.edit('ana', { model: 'opus' });
    expect(h.view('ana').dirty).toBe(false);
    const cleared = await h.hub.edit('ana', { model: null });
    expect(cleared).toMatchObject({ model: null, dirty: true });
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')).not.toHaveProperty('model');
  });

  it('hire keeps the values in the key store and only their names and times in the record, the view and the roster file', async () => {
    const h = await started();
    const { held, calls } = withKeys(h);
    const view = await hireWith(h, { keys: { OPENAI_API_KEY: SECRET } });
    expect(held.get('ana')).toEqual({ OPENAI_API_KEY: SECRET });
    expect(calls).toEqual(['apply ana fresh']);
    expect(view.keys).toEqual({ OPENAI_API_KEY: T0 });
    for (const text of [JSON.stringify(view), JSON.stringify(h.saves), JSON.stringify(h.events), JSON.stringify(h.logged), h.warnings.join('\n'), JSON.stringify(h.spawns)]) {
      expect(text).not.toContain(SECRET);
    }
  });

  it('a hire without keys still starts from none, so a removed agent of that name leaves nothing behind', async () => {
    const h = await started();
    const { held, calls } = withKeys(h);
    held.set('ana', { OLD_KEY: 'left-over' });
    const view = await hireWith(h);
    expect(calls).toEqual(['apply ana fresh']);
    expect(held.has('ana')).toBe(false);
    expect(view.keys).toEqual({});
  });

  it('refuses bad keys with the field keys, and creates nothing', async () => {
    const h = await started();
    const { held } = withKeys(h);
    for (const keys of [{ lower: 'x' }, { PATH: 'x' }, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: 'a b' }, { OPENAI_API_KEY: null }, [], 'x', { OPENAI_API_KEY: SECRET, [`K${SECRET}`]: 5 }]) {
      await expectHubReject(hireWith(h, { keys }), 'bad_request', undefined, 'keys');
    }
    expect(held.size).toBe(0);
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
  });

  it('a hub without a key store refuses keys, and hires without them as before', async () => {
    const h = await started();
    await expectHubReject(hireWith(h, { keys: { OPENAI_API_KEY: SECRET } }), 'bad_request', 'this server cannot keep keys', 'keys');
    expect((await hireWith(h)).keys).toEqual({});
  });

  it('a roster that cannot be saved takes the values of the hire back', async () => {
    const h = await started();
    const { held } = withKeys(h);
    h.script.saveError = 'disk full';
    await expectHubReject(hireWith(h, { keys: { OPENAI_API_KEY: SECRET } }), 'internal', 'could not save the roster: disk full');
    expect(held.has('ana')).toBe(false);
  });

  it('edit sets, replaces and removes keys by name, leaves the others, and is dirty until the restart', async () => {
    const h = await started();
    const { held } = withKeys(h);
    await hireWith(h, { keys: { OPENAI_API_KEY: SECRET, GEMINI_API_KEY: 'g-1' } });
    expect(h.view('ana').dirty).toBe(false);
    await h.advance(5);
    const view = await h.hub.edit('ana', { keys: { OPENAI_API_KEY: 'sk-new-value', GEMINI_API_KEY: null, XAI_API_KEY: 'x-1' } });
    expect(held.get('ana')).toEqual({ OPENAI_API_KEY: 'sk-new-value', XAI_API_KEY: 'x-1' });
    expect(Object.keys(view.keys).sort()).toEqual(['OPENAI_API_KEY', 'XAI_API_KEY']);
    expect(view.dirty).toBe(true);
    expect(JSON.stringify(h.saves) + JSON.stringify(h.events)).not.toContain('sk-new-value');
    // an edit that names nothing is refused as before
    await expectHubReject(h.hub.edit('ana', {}), 'bad_request', /nothing to change/);
    // removing the last ones leaves no keys in the record
    await h.hub.edit('ana', { keys: { OPENAI_API_KEY: null, XAI_API_KEY: null } });
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')).not.toHaveProperty('keys');
    expect(held.has('ana')).toBe(false);
  });

  it('a changed value of a key that was already set shows as dirty: its time changes', async () => {
    const h = await started();
    withKeys(h);
    await hireWith(h, { keys: { OPENAI_API_KEY: SECRET } });
    expect(h.view('ana').dirty).toBe(false);
    await h.advance(10);
    expect((await h.hub.edit('ana', { keys: { OPENAI_API_KEY: 'another-value' } })).dirty).toBe(true);
  });

  it('a refused edit changes nothing, and an edit is checked against the 16 keys of the agent', async () => {
    const h = await started();
    const { held } = withKeys(h);
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`K${i}`, 'v']));
    await hireWith(h, { keys: sixteen });
    await expectHubReject(h.hub.edit('ana', { keys: { ONE_MORE: 'v' } }), 'bad_request', 'at most 16 keys', 'keys');
    expect(Object.keys(held.get('ana') ?? {})).toHaveLength(16);
    await h.hub.edit('ana', { keys: { K1: 'changed', K2: null } });
    expect(Object.keys(held.get('ana') ?? {})).toHaveLength(15);
  });

  it('a roster that cannot be saved leaves the names and the values as they were', async () => {
    const h = await started();
    const { held } = withKeys(h);
    await hireWith(h, { keys: { OPENAI_API_KEY: SECRET } });
    h.script.saveError = 'disk full';
    await expectHubReject(h.hub.edit('ana', { keys: { OPENAI_API_KEY: null } }), 'internal', 'could not save the roster: disk full');
    expect(Object.keys(h.view('ana').keys)).toEqual(['OPENAI_API_KEY']);
    expect(held.get('ana')).toEqual({ OPENAI_API_KEY: SECRET });
    // a replaced value comes back, and a key the edit added goes again
    await expectHubReject(h.hub.edit('ana', { keys: { OPENAI_API_KEY: 'sk-new-value', NEW_KEY: 'n' } }), 'internal', 'could not save the roster: disk full');
    expect(held.get('ana')).toEqual({ OPENAI_API_KEY: SECRET });
    expect(Object.keys(h.view('ana').keys)).toEqual(['OPENAI_API_KEY']);
  });

  it('a rename whose roster cannot be saved puts the values back under the old name', async () => {
    const h = await started();
    const { held } = withKeys(h);
    // like the glue of cli.ts: the keys move with the folder, and move back with it
    const moveFolder = h.io.renameAgentFiles;
    h.io.renameAgentFiles = async (from, to) => {
      await moveFolder(from, to);
      await h.io.keys?.rename(from, to);
    };
    await hireWith(h, { keys: { OPENAI_API_KEY: SECRET } });
    await h.hub.stop('ana');
    h.script.saveError = 'disk full';
    await expectHubReject(h.hub.edit('ana', { name: 'bea', keys: { OPENAI_API_KEY: 'sk-new-value' } }), 'internal', 'could not save the roster: disk full');
    expect([...held.keys()]).toEqual(['ana']);
    expect(held.get('ana')).toEqual({ OPENAI_API_KEY: SECRET });
  });

  it('a rename writes the new values under the new name, after the folder moved; a remove drops them', async () => {
    const h = await started();
    const { held, calls } = withKeys(h);
    await hireWith(h, { keys: { OPENAI_API_KEY: SECRET } });
    await h.hub.stop('ana');
    await h.hub.edit('ana', { name: 'bea', keys: { GEMINI_API_KEY: 'g' } });
    expect(h.renames).toEqual([['ana', 'bea']]);
    expect(calls.at(-1)).toBe('apply bea');
    await h.hub.remove('bea');
    expect(calls.at(-1)).toBe('remove bea');
    expect(held.has('bea')).toBe(false);
  });

  it('a key store that fails to remove is a warning, and the agent is gone', async () => {
    const h = await started();
    withKeys(h);
    await hireWith(h);
    h.io.keys = { values: () => ({}), apply: async () => undefined, rename: async () => undefined, remove: () => Promise.reject(new Error('disk full')) };
    await h.hub.remove('ana');
    expect(h.hub.views().map((agent) => agent.name)).toEqual(['flight']);
    expect(h.warnings.some((line) => line.includes('could not remove the keys of ana'))).toBe(true);
  });
});

describe('Remote Control: an agent approved in the Claude app (hire and edit)', () => {
  const hireWith = (h: Harness, remoteControl: unknown, patch: Record<string, unknown> = {}): Promise<AgentView> =>
    h.hub.hire({ name: 'ana', role: 'x', dir: '/work/ana', mode: 'default', remoteControl, ...patch } as unknown as HireRequest);

  it('stores the setting in the record and the view, and hands it to the launcher', async () => {
    const h = await started();
    const view = await hireWith(h, {});
    expect(view.remoteControl).toEqual({});
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')?.remoteControl).toEqual({});
    expect(h.spawns.at(-1)?.agent.remoteControl).toEqual({});
    const plain = await hireWith(h, undefined, { name: 'ben', dir: '/work/ben' });
    expect(plain.remoteControl).toBeNull();
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ben')).not.toHaveProperty('remoteControl');
  });

  it('refuses a bad value, another engine and a Clean Room, naming the field', async () => {
    const h = await started();
    const refuse = (value: unknown, message: string | RegExp, patch: Record<string, unknown> = {}): Promise<void> => expectHubReject(hireWith(h, value, patch), 'bad_request', message, 'remoteControl');
    await refuse([], 'remoteControl must be an object');
    await refuse({ a: 1 }, 'remoteControl has no field "a"');
    await refuse({}, /Claude Code agents only/, { provider: 'gemini' });
    await refuse({}, /Clean Room/, { cleanRoom: {} });
  });

  it('is turned on and off by an edit and the console is dirty until the restart', async () => {
    const h = await withAna();
    expect(await h.hub.edit('ana', { remoteControl: {} })).toMatchObject({ remoteControl: {}, dirty: true });
    expect(await h.hub.edit('ana', { remoteControl: null })).toMatchObject({ remoteControl: null });
    await h.hub.edit('ana', { remoteControl: {} });
    await expectHubReject(h.hub.edit('ana', { cleanRoom: {} }), 'bad_request', /Remote Control off first/, 'cleanRoom');
  });
});

describe('Tool permissions: the rules of an agent (hire and edit)', () => {
  const hireWith = (h: Harness, permissions: unknown, patch: Record<string, unknown> = {}): Promise<AgentView> =>
    h.hub.hire({ name: 'ana', role: 'x', dir: '/work/ana', mode: 'default', permissions, ...patch } as unknown as HireRequest);

  it('stores the rules in the record and the view, and hands them to the launcher; an empty object is no rules', async () => {
    const h = await started();
    const view = await hireWith(h, { allow: [' Bash ', 'Bash', 'Read'], deny: ['WebFetch'], ask: [] });
    expect(view.permissions).toEqual({ allow: ['Bash', 'Read'], deny: ['WebFetch'] });
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')?.permissions).toEqual({ allow: ['Bash', 'Read'], deny: ['WebFetch'] });
    expect(h.spawns.at(-1)?.agent.permissions).toEqual({ allow: ['Bash', 'Read'], deny: ['WebFetch'] });
    const none = await hireWith(h, {}, { name: 'ben', dir: '/work/ben' });
    expect(none.permissions).toBeNull();
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ben')).not.toHaveProperty('permissions');
  });

  it('refuses a bad rule, gonogo\'s own tools and another engine, naming the field, and creates nothing', async () => {
    const h = await started();
    const refuse = (permissions: unknown, message: string | RegExp, patch: Record<string, unknown> = {}): Promise<void> => expectHubReject(hireWith(h, permissions, patch), 'bad_request', message, 'permissions');
    await refuse([], 'permissions must be an object');
    await refuse({ allow: ['rm -rf /'] }, /is not a rule/);
    await refuse({ deny: ['mcp__gonogo__send_message'] }, /gonogo's own tools/);
    await refuse({ allow: ['Bash'] }, /not supported for Gemini CLI/, { provider: 'gemini' });
    expect(h.saves.at(-1)?.agents.some((record) => record.name === 'ana') ?? false).toBe(false);
  });

  it('is changed by an edit, the console is dirty until the restart, and null goes back to the room\'s', async () => {
    const h = await withAna();
    expect(await h.hub.edit('ana', { permissions: { allow: ['Bash'] } })).toMatchObject({ permissions: { allow: ['Bash'] }, dirty: true });
    expect(await h.hub.edit('ana', { permissions: null })).toMatchObject({ permissions: null });
    expect(h.saves.at(-1)?.agents.find((record) => record.name === 'ana')).not.toHaveProperty('permissions');
    await expectHubReject(h.hub.edit('ana', { permissions: { allow: ['bad rule'] } }), 'bad_request', /is not a rule/, 'permissions');
  });
});

describe('live reload: a new hub takes over the agents that kept running', () => {
  const roster = [rosterRecord('flight', { boss: true, desk: 0 }), rosterRecord('ana', { desk: 1 })];

  it('adopts a running agent with its generation, reads idle or working from the window title and does not start it again', async () => {
    const h = makeHarness({ roster, adoptable: async () => ({ running: [{ name: 'flight', generation: 5 }, { name: 'ana', generation: 7 }], holds: {} }) });
    h.setScreen('ana', { cols: 80, rows: 24, promptBox: true, dialog: null, promptText: '' });
    h.setTitle('ana', 'idle');
    h.setTitle('flight', 'working');
    await h.hub.start();
    await h.advance(10);
    expect(h.spawns, 'nothing is spawned for an agent that is already running').toEqual([]);
    expect(h.view('ana')).toMatchObject({ state: 'idle', generation: 7 });
    expect(h.view('flight')).toMatchObject({ state: 'working', generation: 5 });
    // the next start of the agent goes on from its generation
    await h.hub.restart('ana');
    expect(h.spawns.at(-1)).toMatchObject({ generation: 8 });
  });

  it('reads a dialog on the screen as needs_you, never idle', async () => {
    const h = makeHarness({ roster, adoptable: async () => ({ running: [{ name: 'flight', generation: 1 }, { name: 'ana', generation: 2 }], holds: {} }) });
    h.setScreen('ana', { cols: 80, rows: 24, promptBox: true, dialog: 'trust', promptText: '' });
    await h.hub.start();
    expect(h.view('ana')).toMatchObject({ state: 'needs_you' });
  });

  it('keeps a held agent held: the hold comes back from the saved file and mail waits behind it', async () => {
    const saved: Array<Record<string, string>> = [];
    const h = makeHarness({
      roster,
      saveHolds: (holds) => void saved.push({ ...holds }),
      adoptable: async () => ({ running: [{ name: 'flight', generation: 1 }, { name: 'ana', generation: 2 }], holds: { ana: 'hold: the Director asked' } }),
    });
    h.setScreen('ana', { cols: 80, rows: 24, promptBox: true, dialog: null, promptText: '' });
    await h.hub.start();
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'redline' });
    const sent = h.send('flight', 'ana', 'do the thing');
    await h.advance(DELIVERY_SETTLE_MS * 4);
    expect(h.msg(sent.id).status, 'a held agent gets no mail').toBe('held');
    expect(h.typed.filter((t) => t.name === 'ana')).toEqual([]);
    expect(saved.at(-1)).toEqual({ ana: 'hold: the Director asked' });
  });

  it('saves a hold when it is made and takes it out of the file when it is lifted', async () => {
    const saved: Array<Record<string, string>> = [];
    const h = await withAna({ saveHolds: (holds) => void saved.push({ ...holds }) });
    h.hub.hold('ana');
    expect(Object.keys(saved.at(-1) ?? {})).toEqual(['ana']);
    h.hub.resume('ana');
    expect(saved.at(-1)).toEqual({});
  });

  it('a hold stays in the saved file when its process ends without being asked to (a pty host that stalled)', async () => {
    const saved: Array<Record<string, string>> = [];
    const h = await withAna({ saveHolds: (holds) => void saved.push({ ...holds }) });
    h.hub.hold('ana');
    expect(saved.at(-1)).toHaveProperty('ana');
    h.exit('ana', { requested: false, signal: 9 });
    expect(h.view('ana').state).toBe('stopped');
    expect(saved.at(-1), 'the agent may still run in the host: the next hub must find it held').toHaveProperty('ana');
    // the Director starting it again is the release
    await h.hub.restart('ana');
    expect(saved.at(-1)).toEqual({});
  });

  it('a hold ends with a stop the Director asked for', async () => {
    const saved: Array<Record<string, string>> = [];
    const h = await withAna({ saveHolds: (holds) => void saved.push({ ...holds }) });
    h.hub.hold('ana');
    await h.hub.stop('ana');
    expect(saved.at(-1)).toEqual({});
  });

  it('refuses a reload while the holds cannot be saved, and allows it again once they can', async () => {
    let fail = false;
    const h = await withAna({
      saveHolds: () => {
        if (fail) throw new Error('disk full');
      },
    });
    h.hub.hold('ana');
    fail = true;
    expect(() => h.hub.saveHoldsNow()).toThrow(/not reloading/);
    fail = false;
    expect(() => h.hub.saveHoldsNow()).not.toThrow();
  });

  it('stops an agent that runs in the host but is not in the roster', async () => {
    const h = makeHarness({ roster, adoptable: async () => ({ running: [{ name: 'flight', generation: 1 }, { name: 'ghost', generation: 4 }], holds: {} }) });
    await h.hub.start();
    expect(h.stops).toContainEqual({ name: 'ghost', generation: 4 });
    expect(h.hub.views().map((v) => v.name)).not.toContain('ghost');
  });

  it('release ends the hub without stopping any agent', async () => {
    const h = await withAna();
    h.hub.release();
    expect(h.stops).toEqual([]);
    expect(() => h.hub.hold('ana')).toThrow();
  });
});

describe('Autostart: the agents that were running start again after a server restart', () => {
  const ROSTER = [rosterRecord('flight', { boss: true, desk: 0 }), rosterRecord('ana', { desk: 1 }), rosterRecord('ben', { desk: 2 }), rosterRecord('cy', { desk: 3 }), rosterRecord('dee', { desk: 4 }), rosterRecord('eli', { desk: 5 })];
  const entries = (...names: string[]): RunEntry[] => names.map((name) => ({ name, working: false }));
  const states = (h: Harness): Record<string, string> => Object.fromEntries(h.hub.views().map((v) => [v.name, v.state]));
  const spawned = (h: Harness): string[] => h.spawns.map((s) => s.agent.name);

  it('the policy boss, and a hub without settings, start the boss only, as always', async () => {
    const plain = makeHarness({ roster: ROSTER, runSet: entries('flight', 'ana') });
    await plain.hub.start();
    await settle();
    expect(spawned(plain)).toEqual(['flight']);
    const boss = makeHarness({ roster: ROSTER, startup: { policy: 'boss', carryOn: true, bossMayStart: true }, runSet: entries('flight', 'ana') });
    await boss.hub.start();
    await settle();
    expect(spawned(boss)).toEqual(['flight']);
  });

  it('the policy off starts nobody, the boss too', async () => {
    const h = makeHarness({ roster: ROSTER, startup: { policy: 'off', carryOn: true, bossMayStart: true }, runSet: entries('flight', 'ana') });
    await h.hub.start();
    await settle();
    expect(spawned(h)).toEqual([]);
  });

  it('running with no saved set is the boss only', async () => {
    const h = makeHarness({ roster: ROSTER, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: null });
    await h.hub.start();
    await settle();
    expect(spawned(h)).toEqual(['flight']);
  });

  it('running starts the set, the boss first and then three at a time, each wave when the last one is out of starting', async () => {
    const h = makeHarness({ roster: ROSTER, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: entries('ben', 'flight', 'ana', 'cy', 'dee', 'eli') });
    await h.hub.start();
    await settle();
    // the boss is up, and the first wave of three is started at once
    expect(spawned(h).slice(0, 1)).toEqual(['flight']);
    await settle();
    expect(spawned(h)).toEqual(['flight', 'ben', 'ana', 'cy']);
    // the second wave waits until the first one is out of starting
    await h.advance(2000);
    expect(spawned(h)).toHaveLength(4);
    for (const name of ['flight', 'ben', 'ana', 'cy']) h.ready(name);
    await h.advance(1000);
    await settle();
    expect(spawned(h)).toEqual(['flight', 'ben', 'ana', 'cy', 'dee', 'eli']);
    expect(states(h).dee).toBe('starting');
  });

  it('the next wave starts anyway after the timeout when an agent stays in starting', async () => {
    const h = makeHarness({ roster: ROSTER, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: entries('flight', 'ana', 'ben', 'cy', 'dee') });
    await h.hub.start();
    await settle();
    await h.advance(59_000);
    expect(spawned(h)).toHaveLength(4);
    await h.advance(2000);
    await settle();
    expect(spawned(h)).toEqual(['flight', 'ana', 'ben', 'cy', 'dee']);
  });

  it('a wave is never bigger than Max Q', async () => {
    const h = makeHarness({ roster: ROSTER, maxWorking: 1, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: entries('flight', 'ana', 'ben') });
    await h.hub.start();
    await settle();
    expect(spawned(h)).toEqual(['flight', 'ana']);
    h.ready('ana');
    h.ready('flight');
    await h.advance(1000);
    await settle();
    expect(spawned(h)).toEqual(['flight', 'ana', 'ben']);
  });

  it('leaves an opted-out agent, one that is not in the set and one that was removed stopped, and says which', async () => {
    const roster = [...ROSTER.slice(0, 3), rosterRecord('cy', { desk: 3, autostart: false })];
    const marks: Array<[string, boolean, boolean]> = [];
    const h = makeHarness({ roster, marks, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: entries('flight', 'cy', 'ghost') });
    await h.hub.start();
    await settle();
    expect(spawned(h)).toEqual(['flight']);
    expect(h.notices.at(-1)).toEqual(['startup', 'Restarted 1 agent after the server start; not started: cy (opted out)']);
    // the set drops what this start leaves stopped, so the next start does not bring it back
    expect(marks).toContainEqual(['cy', false, false]);
    expect(marks).toContainEqual(['ghost', false, false]);
  });

  it('an agent taken over from the pty host is running: autostart does not start it again and sends it no carry-on', async () => {
    const roster = [rosterRecord('flight', { boss: true, desk: 0 }), rosterRecord('ana', { desk: 1 }), rosterRecord('ben', { desk: 2 })];
    const set: RunEntry[] = [{ name: 'flight', working: true }, { name: 'ana', working: true }, { name: 'ben', working: false }];
    const marks: Array<[string, boolean, boolean]> = [];
    const h = makeHarness({ roster, marks, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: set, adoptable: async () => ({ running: [{ name: 'flight', generation: 3 }, { name: 'ana', generation: 4 }], holds: {} }) });
    h.setScreen('ana', { cols: 80, rows: 24, promptBox: true, dialog: null, promptText: '' });
    h.setScreen('flight', { cols: 80, rows: 24, promptBox: true, dialog: null, promptText: '' });
    await h.hub.start();
    await settle();
    await h.advance(2000);
    expect(spawned(h)).toEqual(['ben']);
    expect(h.hub.activity().filter((item) => item.subject === 'Server restarted')).toEqual([]);
    // the adopted agents stay in the saved set
    expect(marks.filter((m) => !m[1]).map((m) => m[0])).not.toContain('flight');
  });

  it('one start that fails does not stop the rest, and the reason is in the event', async () => {
    const h = makeHarness({ roster: ROSTER, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: entries('flight', 'ana', 'ben') });
    h.script.spawnError = 'the folder is gone';
    await h.hub.start();
    await settle();
    await h.advance(2000);
    expect(spawned(h)).toContain('ben');
    expect(h.notices.at(-1)?.[0]).toBe('startup');
  });

  it('tells an agent that was in a turn to carry on, once, and an idle one nothing', async () => {
    const set: RunEntry[] = [{ name: 'flight', working: true }, { name: 'ana', working: true }, { name: 'ben', working: false }];
    const h = makeHarness({ roster: ROSTER, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: set });
    await h.hub.start();
    await settle();
    await h.advance(1000);
    const told = h.hub.activity().filter((item) => item.from === 'user' && item.subject === 'Server restarted');
    expect(told.map((item) => item.to).sort()).toEqual(['ana', 'flight']);
    expect(told[0]?.body).toContain('carry on');
    const off = makeHarness({ roster: ROSTER, startup: { policy: 'running', carryOn: false, bossMayStart: true }, runSet: set });
    await off.hub.start();
    await settle();
    await off.advance(1000);
    expect(off.hub.activity().filter((item) => item.subject === 'Server restarted')).toEqual([]);
  });

  it('writes the set at starts and stops, takes out a stop, a hold, a trip and a remove, and puts a resume back', async () => {
    const marks: Array<[string, boolean, boolean]> = [];
    const h = makeHarness({ marks });
    await h.boot();
    await h.hire('ana');
    await h.hire('ben');
    const last = (name: string) => marks.filter((m) => m[0] === name).at(-1);
    expect(last('ana')).toEqual(['ana', true, false]);
    h.work('ana');
    expect(last('ana')).toEqual(['ana', true, true]);
    h.hook('ana', 'Stop');
    await h.hub.stop('ana');
    expect(last('ana')).toEqual(['ana', false, false]);
    await h.hub.restart('ana');
    expect(last('ana')?.[1]).toBe(true);
    h.ready('ana');
    h.hub.hold('ben');
    expect(last('ben')).toEqual(['ben', false, false]);
    h.hub.resume('ben');
    expect(last('ben')?.[1]).toBe(true);
    h.hub.trip('ben', 'loop');
    expect(last('ben')).toEqual(['ben', false, false]);
    h.hub.resume('ben');
    await h.hub.remove('ben');
    expect(last('ben')).toEqual(['ben', false, false]);
  });

  it('writes nothing during a shutdown: the set stays as it was', async () => {
    const marks: Array<[string, boolean, boolean]> = [];
    const h = makeHarness({ marks });
    await h.boot();
    await h.hire('ana');
    const before = marks.length;
    await h.hub.shutdown();
    expect(marks.length).toBe(before);
  });

  it('an agent that exits by itself leaves the set', async () => {
    const marks: Array<[string, boolean, boolean]> = [];
    const h = makeHarness({ marks });
    await h.boot();
    await h.hire('ana');
    h.exit('ana', { code: 0 });
    expect(marks.filter((m) => m[0] === 'ana').at(-1)).toEqual(['ana', false, false]);
  });

  it('the opt-out is a record field, in the view, set by hire and edit', async () => {
    const h = await started();
    expect((await h.hub.hire({ name: 'ana', role: 'x', dir: '/work/ana', mode: 'default', autostart: false })).autostart).toBe(false);
    expect(h.saves.at(-1)?.agents.find((r) => r.name === 'ana')?.autostart).toBe(false);
    expect((await h.hub.hire({ name: 'ben', role: 'x', dir: '/work/ben', mode: 'default' })).autostart).toBe(true);
    expect(h.saves.at(-1)?.agents.find((r) => r.name === 'ben')).not.toHaveProperty('autostart');
    expect(await h.hub.edit('ana', { autostart: true })).toMatchObject({ autostart: true, dirty: false });
    expect(h.saves.at(-1)?.agents.find((r) => r.name === 'ana')).not.toHaveProperty('autostart');
    await expectHubReject(h.hub.edit('ana', { autostart: 'no' } as never), 'bad_request', 'autostart must be true or false', 'autostart');
    await expectHubReject(h.hub.hire({ name: 'cy', role: 'x', dir: '/work/cy', mode: 'default', autostart: 1 } as never), 'bad_request', 'autostart must be true or false', 'autostart');
  });
});

describe('Hub.startAgent: the boss starts a stopped agent', () => {
  it('starts a stopped agent, and refuses a running one and one on hold', async () => {
    const h = await withAna();
    await expectHubReject(h.hub.startAgent('ana', 'flight'), 'conflict', 'ana is already running');
    h.hub.hold('ana');
    await expectHubReject(h.hub.startAgent('ana', 'flight'), 'conflict', /ana is on hold/);
    h.hub.resume('ana');
    h.exit('ana', { code: 0 });
    const before = h.spawns.length;
    expect((await h.hub.startAgent('ana', 'flight')).state).toBe('starting');
    expect(h.spawns.length).toBe(before + 1);
    await expectHubReject(h.hub.startAgent('ghost', 'flight'), 'not_found', 'unknown agent');
  });
});

describe('ALL STOP and ALL RESUME, and the switch of start_agent', () => {
  it('holds every agent that can be held, names the others, and resumes only the held ones', async () => {
    const h = await started();
    await h.hire('ana');
    await h.hire('ben');
    await h.hire('cy');
    h.work('ana');
    await h.hub.stop('cy');
    const result = h.hub.holdAll();
    expect(result.held.sort()).toEqual(['ana', 'ben', 'flight']);
    expect(result.skipped).toEqual([]);
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsReason: 'on hold' });
    expect(h.view('cy').state).toBe('stopped');
    // mail waits for a held agent, as with Hold
    h.send('user', 'ben', 'hello');
    expect(h.typed.filter((t) => t.name === 'ben')).toEqual([]);
    // a second press holds nobody new, and does not name the held ones as skipped
    expect(h.hub.holdAll()).toEqual({ held: [], skipped: [] });
    // a tripped one is not resumed by ALL RESUME
    h.hub.resume('ben');
    h.hub.trip('ben', 'loop');
    expect(h.hub.resumeAll().resumed.sort()).toEqual(['ana', 'flight']);
    expect(h.view('ben').state).toBe('needs_you');
    expect(h.view('ana').state).not.toBe('needs_you');
  });

  it('names an agent at a dialog, which it cannot hold, as left alone', async () => {
    const h = await started();
    await h.hire('ana');
    h.work('ana');
    h.hook('ana', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    const result = h.hub.holdAll();
    expect(result.skipped).toEqual(['ana']);
    expect(result.held).toContain('flight');
  });

  it('start_agent is refused when the Director switched "FLIGHT may start agents" off, and the room keeps working', async () => {
    const h = makeHarness({ startup: { policy: 'boss', carryOn: true, bossMayStart: false } });
    await h.boot();
    await h.hire('ana');
    h.exit('ana', { code: 0 });
    await expectHubReject(h.hub.startAgent('ana', 'flight'), 'forbidden', /FLIGHT may start agents/);
    expect(h.view('ana').state).toBe('stopped');
    expect((await h.hub.restart('ana')).state).toBe('starting');
  });
});

describe('start_agent and the Director\'s stop, and a boss that cannot start', () => {
  it('refuses an agent the Director stopped until a start clears it, and the flag is in the roster', async () => {
    const h = await withAna();
    await h.hub.stop('ana');
    expect(h.saves.at(-1)?.agents.find((r) => r.name === 'ana')?.stoppedBy).toBe('director');
    await expectHubReject(h.hub.startAgent('ana', 'flight'), 'forbidden', /the Director stopped ana/);
    expect(h.view('ana').state).toBe('stopped');
    await h.hub.restart('ana');
    expect(h.saves.at(-1)?.agents.find((r) => r.name === 'ana')).not.toHaveProperty('stoppedBy');
    await h.hub.stop('ana');
    await h.hub.restart('ana');
    h.ready('ana');
    // stopped some other way (it exited by itself): FLIGHT may bring it back
    h.exit('ana', { code: 0 });
    expect((await h.hub.startAgent('ana', 'flight')).state).toBe('starting');
  });

  it('a STOP of an agent that already crashed sticks too: FLIGHT may not start it', async () => {
    const h = await withAna();
    h.exit('ana', { code: 1 });
    expect(h.view('ana').state).toBe('stopped');
    await h.hub.stop('ana');
    expect(h.saves.at(-1)?.agents.find((r) => r.name === 'ana')?.stoppedBy).toBe('director');
    await expectHubReject(h.hub.startAgent('ana', 'flight'), 'forbidden', /the Director stopped ana/);
  });

  it('a boss that cannot start does not keep the others from starting, and the notice names it', async () => {
    const roster = [rosterRecord('flight', { boss: true, desk: 0 }), rosterRecord('ana', { desk: 1 })];
    const h = makeHarness({ roster, startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: [{ name: 'flight', working: false }, { name: 'ana', working: false }] });
    const real = h.io.spawn;
    h.io.spawn = async (req) => {
      if (req.agent.name === 'flight') throw new Error('the folder is gone');
      return real(req);
    };
    await h.hub.start();
    await settle();
    await h.advance(2000);
    expect(h.spawns.map((s) => s.agent.name)).toContain('ana');
    expect(h.notices.at(-1)?.[1]).toMatch(/not started: flight \(.*the folder is gone/);
  });
});

describe('Feature toggles at the hub', () => {
  it('Max Q off: the limit is ignored and no mail waits for load', async () => {
    const h = await started({ maxWorking: 1 });
    let on = true;
    h.io.featureOn = (id) => (id === 'maxq' ? on : true);
    for (const name of ['ana', 'bob', 'cara']) await h.hire(name);
    h.work('ana');
    const held = h.send('bob', 'cara');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.msg(held.id).note).toContain('load limit');
    on = false;
    const free = h.send('bob', 'cara', 'again');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.msg(free.id).note ?? '').not.toContain('load limit');
  });

  it('Telemetry off: the tool hooks are not handed to the recorder', async () => {
    const h = await withAna();
    const seen: string[] = [];
    h.io.toolHook = (name, event) => void seen.push(`${name}:${event}`);
    h.hook('ana', 'PreToolUse', { tool_name: 'Bash' });
    h.io.featureOn = (id) => id !== 'telemetry';
    h.hook('ana', 'PreToolUse', { tool_name: 'Bash' });
    expect(seen).toEqual(['ana:PreToolUse']);
  });

  it('Static fire off: a poll with a subject is refused, a plain poll is not', async () => {
    const h = await withAna();
    h.io.featureOn = (id) => id !== 'static-fire';
    await h.hire('sim');
    expect(() => h.hub.startPoll({ subject: 'the new build' } as never)).toThrow(/Static fire is off/);
    expect(h.hub.startPoll({}).status).toBe('open');
  });
});

describe('refreshLimits: Max Q switched off releases the mail it held', () => {
  it('delivers a held message at once when the feature goes off', async () => {
    const h = await started({ maxWorking: 1 });
    let on = true;
    h.io.featureOn = (id) => (id === 'maxq' ? on : true);
    for (const name of ['ana', 'bob', 'cara']) await h.hire(name);
    h.work('ana');
    const held = h.send('bob', 'cara');
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.msg(held.id).note).toContain('load limit');
    on = false;
    h.hub.refreshLimits();
    await h.advance(DELIVERY_SETTLE_MS * 2);
    expect(h.typed.map((t) => t.name)).toContain('cara');
  });
});

describe('Subagents: what the hooks say of the helpers of an agent', () => {
  const start = (h: Harness, id: string, type = 'Explore'): void => void h.hook('ana', 'SubagentStart', { agent_id: id, agent_type: type });
  const stop = (h: Harness, id: string): void => void h.hook('ana', 'SubagentStop', { agent_id: id, agent_type: 'Explore' });

  it('keeps the set of running helpers: a start adds (once), a stop removes, a stop with no start is ignored, and the view counts them', async () => {
    const h = await withAna();
    expect(h.view('ana').subagents).toEqual({ running: 0, started: 0, types: {} });
    start(h, 'a1');
    start(h, 'a1');
    start(h, 'a2', 'general-purpose');
    expect(h.view('ana').subagents).toEqual({ running: 2, started: 2, types: { Explore: 1, 'general-purpose': 1 } });
    stop(h, 'a1');
    stop(h, 'never-started');
    expect(h.view('ana').subagents).toEqual({ running: 1, started: 2, types: { 'general-purpose': 1 } });
    // a helper does not change what the agent is doing
    expect(h.view('ana').state).toBe('idle');
  });

  it('drops a helper nobody has heard of for 30 minutes, keeps one a tool event of its own refreshed, and drops all at an exit or a restart', async () => {
    const h = await withAna();
    start(h, 'a1');
    start(h, 'a2');
    await h.advance(20 * 60_000);
    h.hook('ana', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' }, agent_id: 'a2' });
    await h.advance(15 * 60_000);
    expect(h.view('ana').subagents.running).toBe(1);
    h.exit('ana', { code: 0 });
    expect(h.view('ana').subagents.running).toBe(0);
    await h.hub.restart('ana');
    expect(h.view('ana').subagents).toEqual({ running: 0, started: 0, types: {} });
  });

  it('a loop is the same call by the same agent: the same call spread over two helpers does not trip, one helper that repeats it does, and a helper cannot hide it', async () => {
    const h = await withAna();
    h.work('ana');
    const call = (id: string, command = 'ls'): void => void h.hook('ana', 'PreToolUse', { tool_name: 'Bash', tool_input: { command }, agent_id: id });
    // 4 + 4 of the same call, interleaved: more than the limit counted together, less than it for each
    for (let n = 0; n < 4; n += 1) {
      call('a1');
      call('a2');
    }
    expect(h.view('ana').needsKind).not.toBe('redline');
    // a1 repeats its call while a2 keeps doing other things in between: it still trips
    for (let n = 0; n < 3; n += 1) {
      call('a1');
      call('a2', `other ${n}`);
    }
    expect(h.view('ana')).toMatchObject({ needsKind: 'redline', needsReason: expect.stringContaining('(a subagent)') });
  });

  it('an agent\'s own loop still trips, whatever its helpers do between its calls', async () => {
    const h = await withAna();
    h.work('ana');
    for (let n = 0; n < 6; n += 1) {
      h.hook('ana', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'make' } });
      h.hook('ana', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, agent_id: 'a1' });
    }
    expect(h.view('ana').needsKind).toBe('redline');
  });

  it('failures are counted for each helper: a storm of one trips, the same number spread over several does not', async () => {
    const h = await withAna();
    h.work('ana');
    const fail = (id: string): void => void h.hook('ana', 'PostToolUseFailure', { tool_name: 'Bash', agent_id: id });
    for (let n = 0; n < 6; n += 1) {
      fail('a1');
      fail('a2');
    }
    expect(h.view('ana').needsKind).not.toBe('redline');
    for (let n = 0; n < 8; n += 1) fail('a3');
    expect(h.view('ana')).toMatchObject({ needsKind: 'redline', needsReason: expect.stringContaining('error storm') });
  });

  it('the permission a helper asks for says so, and is still the parent\'s to answer', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' }, agent_id: 'a1', agent_type: 'Explore' });
    expect(h.view('ana')).toMatchObject({ state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: git push (subagent Explore)' });
    expect(h.notices.at(-1)?.[1]).toBe('ana asks: Bash: git push (subagent Explore)');
  });

  it('a permission of an agent started with --agent has an agent_type but no agent_id: no helper is named', async () => {
    const h = await withAna();
    h.work('ana');
    h.hook('ana', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, agent_type: 'reviewer' });
    expect(h.view('ana').needsReason).toBe('permission request: Bash: ls');
  });

  it('a SubagentStop makes Propellant read the session again, and a flood of ids is bounded', async () => {
    const h = await withAna();
    h.hook('ana', 'SubagentStop', { agent_id: 'a1', transcript_path: '/p/session.jsonl' });
    expect(h.metered.at(-1)).toMatchObject({ name: 'ana', transcriptPath: '/p/session.jsonl' });
    for (let n = 0; n < 200; n += 1) start(h, `id${n}`);
    expect(h.view('ana').subagents.running).toBeLessThanOrEqual(64);
  });
});

describe('a hold that was lost with its process is not released by FLIGHT or by autostart', () => {
  const ROSTER = [rosterRecord('flight', { boss: true, desk: 0 }), rosterRecord('ana', { desk: 1 }), rosterRecord('ben', { desk: 2 })];

  it('start_agent refuses an agent whose hold was lost, the hold stays in the file, and the Director\'s start lets it go', async () => {
    const saved: Array<Record<string, string>> = [];
    const h = await withAna({ saveHolds: (holds) => void saved.push({ ...holds }) });
    h.hub.hold('ana');
    h.exit('ana', { requested: false, signal: 9 });
    expect(h.view('ana').state).toBe('stopped');
    const before = h.spawns.length;
    await expectHubReject(h.hub.startAgent('ana', 'flight'), 'conflict', 'ana is on hold: the Director resumes it');
    expect(h.spawns.length).toBe(before);
    expect(saved.at(-1)).toHaveProperty('ana');
    await h.hub.restart('ana');
    expect(h.spawns.length).toBe(before + 1);
    expect(saved.at(-1)).toEqual({});
  });

  it('autostart does not start an agent that the previous host still holds, names it, and starts the others', async () => {
    const saved: Array<Record<string, string>> = [];
    const set: RunEntry[] = [{ name: 'flight', working: false }, { name: 'ana', working: false }, { name: 'ben', working: false }];
    const h = makeHarness({ roster: ROSTER, saveHolds: (holds) => void saved.push({ ...holds }), startup: { policy: 'running', carryOn: true, bossMayStart: true }, runSet: set, adoptable: async () => ({ running: [], holds: { ana: 'hold: the Director asked' } }) });
    await h.hub.start();
    await settle();
    await h.advance(2000);
    expect(h.spawns.map((s) => s.agent.name).sort()).toEqual(['ben', 'flight']);
    expect(h.notices.at(-1)?.[1]).toContain('ana (on hold)');
    expect(saved.at(-1)).toEqual({ ana: 'hold: the Director asked' });
  });

  it('a boss whose hold was lost is not started by the policy either', async () => {
    const h = makeHarness({ roster: ROSTER, startup: { policy: 'boss', carryOn: true, bossMayStart: true }, adoptable: async () => ({ running: [], holds: { flight: 'hold: the Director asked' } }) });
    await h.hub.start();
    await settle();
    expect(h.spawns).toEqual([]);
    expect(h.view('flight').state).toBe('stopped');
  });
});
