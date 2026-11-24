import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SerializeAddon } from '@xterm/addon-serialize';
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, SpawnSpec, TerminalEvent, TerminalHost } from '../src/shared/protocol.js';
import {
  BOX_MAX_ROWS,
  ENTER,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  MIRROR_SCROLLBACK_LINES,
  NBSP,
  PASTE_END,
  PASTE_START,
  PROMPT_GLYPH,
  RULE_CHAR,
  STOP_GIVEUP_AFTER_KILL_MS,
  STOP_KILL_AFTER_MS,
  TITLE_IDLE_GLYPH,
  createLogger,
  nullLogger,
  POINTER_LINE_MAX_CHARS,
} from '../src/server/constants.js';
import {
  ModeTracker,
  analyzeScreen,
  buildSubmit,
  classifyTitle,
  createTerminalHost,
  ensureSpawnHelperExecutable,
  sanitizeForPaste,
} from '../src/server/terminal.js';

const { Terminal } = xtermHeadless;

const ESC = '\u001b';
const BEL = '\u0007';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const rule = (width = 40): string => RULE_CHAR.repeat(width);
const BOX = `${rule()}\r\n${PROMPT_GLYPH}${NBSP}\r\n${rule()}\r\n`;
const PASTE_MODE_ON = `${ESC}[?2004h`;
const POINTER = 'gonogo: 1 new message from ana. Call read_messages.';

let tmp = '';
const hosts: TerminalHost[] = [];
const strays: number[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.map((host) => host.stopAll()));
  hosts.length = 0;
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone, which is what the test wanted
    }
  }
  await rm(tmp, { recursive: true, force: true });
});

function collectingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ level: 'debug', sink: (line) => lines.push(line) }), lines };
}

function makeHost(options: Parameters<typeof createTerminalHost>[0] = {}): TerminalHost {
  const host = createTerminalHost({ log: nullLogger, killAfterMs: 300, giveUpAfterKillMs: 300, ...options });
  hosts.push(host);
  return host;
}

function collect(host: TerminalHost): TerminalEvent[] {
  const events: TerminalEvent[] = [];
  host.onEvent((event) => events.push(event));
  return events;
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const nodeSpec = (script: string, env: Record<string, string> = {}, extra: Partial<SpawnSpec> = {}): SpawnSpec => ({
  file: process.execPath,
  args: ['-e', script],
  env: { PATH: process.env.PATH ?? '', ...env },
  cwd: tmp,
  ...extra,
});

/** A child that prints `payload` once and then stays alive. */
const printing = (payload: string): string => `process.stdout.write(${JSON.stringify(payload)}); setInterval(() => {}, 1000);`;

/** mulberry32: the same sequence on every machine, so a failing random case can be replayed. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const textOf = async (host: TerminalHost, name: string): Promise<string> => {
  const attachment = await host.attach(name, () => {});
  attachment.detach();
  return attachment.snapshot.data;
};

const exitOf = (events: TerminalEvent[]): Extract<TerminalEvent, { kind: 'exit' }> => {
  const exit = events.find((event): event is Extract<TerminalEvent, { kind: 'exit' }> => event.kind === 'exit');
  if (!exit) throw new Error('no exit event');
  return exit;
};

const feed = (term: HeadlessTerminal, bytes: Uint8Array | string): Promise<void> => new Promise<void>((resolve) => term.write(bytes, resolve));

function viewportRows(term: HeadlessTerminal): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
  return rows;
}

/* ---- recorded streams ---- */

interface StreamRecord {
  t: number;
  k: string;
  b?: string;
  cols?: number;
  rows?: number;
  type?: string;
  detail?: unknown;
  args?: unknown;
  cwd?: unknown;
}
type DataStep = { kind: 'data'; from: number; to: number; checkpoint: boolean };
type ResizeStep = { kind: 'resize'; cols: number; rows: number };

const loadStream = (file: string): StreamRecord[] =>
  readFileSync(join(fixtureDir, file), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as StreamRecord);

const QUIET_MS = 400;

/** Data steps end at a quiet point (no output for 400 ms, the facts' checkpoint) or at a resize record. */
function planOf(records: StreamRecord[]): { steps: Array<DataStep | ResizeStep>; chunks: Buffer[]; cols: number; rows: number } {
  const start = records.find((record) => record.k === 'start');
  const steps: Array<DataStep | ResizeStep> = [];
  const chunks: Buffer[] = [];
  let from = 0;
  let lastT: number | null = null;
  const flush = (checkpoint: boolean): void => {
    if (chunks.length > from) {
      steps.push({ kind: 'data', from, to: chunks.length, checkpoint });
      from = chunks.length;
      return;
    }
    const previous = steps[steps.length - 1];
    if (checkpoint && previous?.kind === 'data') previous.checkpoint = true;
  };
  for (const record of records) {
    if (record.k === 'd') {
      if (lastT !== null && record.t - lastT > QUIET_MS) flush(true);
      chunks.push(Buffer.from(record.b ?? '', 'base64'));
      lastT = record.t;
    } else if (record.k === 'rs') {
      flush(lastT !== null && record.t - lastT > QUIET_MS);
      steps.push({ kind: 'resize', cols: record.cols ?? 0, rows: record.rows ?? 0 });
    }
  }
  flush(true);
  return { steps, chunks, cols: start?.cols ?? 120, rows: start?.rows ?? 40 };
}

/** The screens of a recording at its quiet points, read with a plain headless terminal. */
async function recordedScreens(file: string): Promise<Array<{ rows: string[]; cols: number }>> {
  const plan = planOf(loadStream(file));
  const term = new Terminal({ cols: plan.cols, rows: plan.rows, scrollback: MIRROR_SCROLLBACK_LINES, allowProposedApi: true });
  const screens: Array<{ rows: string[]; cols: number }> = [];
  for (const step of plan.steps) {
    if (step.kind === 'resize') {
      term.resize(step.cols, step.rows);
      continue;
    }
    for (let i = step.from; i < step.to; i++) await feed(term, plan.chunks[i]);
    if (step.checkpoint) screens.push({ rows: viewportRows(term), cols: term.cols });
  }
  return screens;
}

/* ---- pure functions ---- */

describe('analyzeScreen', () => {
  const box = (text: string, width = 60): string[] => [rule(width), `${PROMPT_GLYPH}${NBSP}${text}`, rule(width)];

  it('a modal with no numbered cursor sets modal (not dialog), only where there is no prompt box, in any case; a live box with such words in the transcript does not', () => {
    for (const line of ['  Esc to cancel', 'Press Enter to continue', '  Enter to confirm · Esc to go back', '  ↵ to select']) {
      expect(analyzeScreen(['', '  Rename session', '  > new name_', line], 60), line).toMatchObject({ dialog: null, modal: true });
      expect(analyzeScreen(['', '  Rename session', '  > new name_', line.toLowerCase()], 60).modal, line).toBe(true);
      expect(analyzeScreen(['  assistant: ' + line.trim(), ...box('')], 60), line).toMatchObject({ dialog: null, modal: false });
    }
    // the footer hints of a ready screen, as on FLIGHT's real one
    expect(analyzeScreen([...box(''), '  plan 73% wk', '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ? for shortcuts'], 42).dialog).toBeNull();
  });

  it('reads the words of Claude Code that it is not signed in, on any row but a line of the transcript that quotes them', () => {
    const box = (text: string): string[] => ['─'.repeat(40), `${PROMPT_GLYPH}${NBSP}${text}`, '─'.repeat(40)];
    for (const line of ['  Not logged in · Run /login', 'Not logged in · Please run /login', '  Invalid API key · Please run /login', '  Please run /login to continue']) {
      expect(analyzeScreen([...box(''), line], 60).signedOut, line).toBe(true);
    }
    expect(analyzeScreen([...box(''), '  ? for shortcuts'], 60).signedOut).toBe(false);
    for (const line of ['  Remote managed settings failed to load (authentication rejected (401))', '  API Error: 401 authentication_error', '  OAuth token has expired', '  Invalid API key · Please run /login']) {
      expect(analyzeScreen([...box(''), line], 70), line).toMatchObject({ authRejected: true });
    }
    expect(analyzeScreen(['● It said "authentication rejected"', ...box('')], 80).authRejected).toBe(false);
    expect(analyzeScreen(['● The message was "Not logged in · Run /login", so I asked you to log in', ...box('')], 80).signedOut).toBe(false);
    // RETRO's screens: tool output and a wrapped line of the assistant, above the box, are the transcript
    const tool = ['● Bash(git push)', '  ⎿  remote: authentication rejected', ...box('')];
    expect(analyzeScreen(tool, 80)).toMatchObject({ authRejected: false, signedOut: false });
    expect(analyzeScreen(['  OAuth token has expired, so the CI job failed.', ...box('')], 80)).toMatchObject({ authRejected: false, signedOut: false });
    expect(analyzeScreen(['  Remote managed settings failed to load (authentication rejected (401))', ...box('')], 80).authRejected).toBe(false); // above the box
    // with no box found: only the last rows
    const bare = ['x', 'y', 'z', 'w', 'v', 'u', 't', '  Not logged in · Run /login'];
    expect(analyzeScreen(bare, 60).signedOut).toBe(true);
    expect(analyzeScreen(['  Not logged in · Run /login', ...bare.slice(0, 7), ...bare.slice(0, 6)], 60).signedOut).toBe(false);
    expect(analyzeScreen(['> why does it say Not logged in · Run /login?', ...box('')], 80).signedOut).toBe(false);
  });

  it('finds the box on the real screen of FLIGHT (t110): 42 columns and a plugin banner set into the rule above the box', () => {
    const rows = [
      '✻ Churned for 13s · done 1:37 AM',
      '● full  $1la4h 8Review  Audit  Board  [-]a',
      '                   1% until auto-compact',
      '───────────────── Gonogo message reading ─',
      `${PROMPT_GLYPH}${NBSP}`,
      '─'.repeat(42),
      '  plan 73% wk',
      '  ⏵⏵ auto mode on (shift+tab to cycle) ·',
    ];
    expect(analyzeScreen(rows, 42)).toMatchObject({ promptBox: true, dialog: null, promptText: '' });
  });

  it('a short run of rule characters in the middle of a line is still not a rule', () => {
    expect(analyzeScreen(['text ──────── more', `${PROMPT_GLYPH}${NBSP}`, rule(60)], 80).promptBox).toBe(false);
  });

  it('finds the idle box, an empty one included (the NBSP must survive)', () => {
    const rows = ['', '  some output', ...box(''), '  ? for shortcuts'];
    expect(analyzeScreen(rows, 80)).toEqual({ cols: 80, rows: rows.length, promptBox: true, dialog: null, promptText: '', modal: false, signedOut: false, authRejected: false });
  });

  it('reports a placeholder or typed text as information, trimmed', () => {
    expect(analyzeScreen(box('Try "fix lint errors"'), 80).promptText).toBe('Try "fix lint errors"');
    expect(analyzeScreen(box('fix the build   '), 80)).toMatchObject({ promptBox: true, promptText: 'fix the build' });
  });

  it('accepts a draft that wraps over several rows, up to BOX_MAX_ROWS below the prompt row', () => {
    const wrapped = [rule(), `${PROMPT_GLYPH}${NBSP}${'a'.repeat(38)}`, `  ${'b'.repeat(38)}`, '  tail', rule()];
    expect(analyzeScreen(wrapped, 40)).toMatchObject({ promptBox: true, promptText: 'a'.repeat(38) });
    const filler = Array.from({ length: BOX_MAX_ROWS - 1 }, () => '  text');
    expect(analyzeScreen([rule(), `${PROMPT_GLYPH}${NBSP}x`, ...filler, rule()], 40).promptBox).toBe(true);
    expect(analyzeScreen([rule(), `${PROMPT_GLYPH}${NBSP}x`, ...filler, '  text', rule()], 40).promptBox).toBe(false);
  });

  it('is not fooled by a dashed rule, a normal space after the glyph, short rules or a missing rule', () => {
    expect(analyzeScreen(['╌'.repeat(40), `${PROMPT_GLYPH}${NBSP}hello`, '╌'.repeat(40)], 40).promptBox).toBe(false);
    expect(analyzeScreen([rule(), `${PROMPT_GLYPH} hello`, rule()], 40).promptBox).toBe(false);
    expect(analyzeScreen([RULE_CHAR.repeat(19), `${PROMPT_GLYPH}${NBSP}`, RULE_CHAR.repeat(19)], 40).promptBox).toBe(false);
    expect(analyzeScreen([rule(), `${PROMPT_GLYPH}${NBSP}hello`], 40).promptBox).toBe(false);
    expect(analyzeScreen([`${PROMPT_GLYPH}${NBSP}hello`, rule()], 40).promptBox).toBe(false);
    expect(analyzeScreen([], 40)).toEqual({ cols: 40, rows: 0, promptBox: false, dialog: null, promptText: null, modal: false, signedOut: false, authRejected: false });
  });

  it('takes the lowest box when an older echo also sits between rules', () => {
    const rows = [...box('old'), '', ...box('new')];
    expect(analyzeScreen(rows, 80).promptText).toBe('new');
  });

  it('recognises each startup dialog and lets the specific kinds win over the generic menu', () => {
    const cases: Array<[string, string[]]> = [
      ['theme', ['Welcome', 'Choose the text style that looks best with your terminal', `${PROMPT_GLYPH} 1. Dark mode`, '  2. Light mode']],
      ['login', ['Select login method:', `${PROMPT_GLYPH} 1. Claude account`, '  2. Anthropic Console']],
      ['trust', ['Quick safety check: Is this a project you created or one you trust?', '', `${PROMPT_GLYPH} 1. Yes, I trust this folder`, '  2. No, exit']],
      ['trust', ['Is this a project you created or one you trust? (Like your own code)', `${PROMPT_GLYPH} Yes, proceed`, '  No, exit']],
      ['bypass', ['WARNING: Claude Code running in Bypass Permissions mode', '', `${PROMPT_GLYPH} No, exit`, '  Yes, I accept', 'Enter to confirm · Esc to cancel']],
      ['api_key', ['Detected a custom API key in your environment', 'Do you want to use this API key?', `${PROMPT_GLYPH} 1. Yes`, '  2. No (recommended)']],
      ['resume', ['Resume this conversation?', `${PROMPT_GLYPH} 1. From the start`, '  2. From a summary']],
    ];
    for (const [kind, rows] of cases) expect(analyzeScreen(rows, 80), kind).toMatchObject({ dialog: kind, promptBox: false });
  });

  it('reports a numbered menu on its own as menu, and a permission dialog only with its menu', () => {
    expect(analyzeScreen(['Pick one', `${PROMPT_GLYPH} 1. First`, '  2. Second'], 80).dialog).toBe('menu');
    expect(analyzeScreen([`  ${PROMPT_GLYPH} No, exit`], 80).dialog).toBe('menu');
    expect(analyzeScreen([`${PROMPT_GLYPH} Yes, proceed`], 80).dialog).toBe('menu');
    expect(analyzeScreen([' Do you want to create x.txt?', `${PROMPT_GLYPH} 1. Yes`, '  2. No'], 80).dialog).toBe('permission');
    expect(analyzeScreen(['Do you want to see the diff?', '  Esc to cancel'], 80).dialog).toBeNull();
    expect(analyzeScreen(['  Do you want to continue?', '  1. not a menu row', '  2. the glyph is missing'], 80).dialog).toBeNull();
    expect(analyzeScreen(['⏺ Do you want to continue with the refactor?', ...box('')], 80)).toMatchObject({ dialog: null, promptBox: true });
    expect(analyzeScreen(['⏵⏵ bypass permissions on (shift+tab to cycle)', 'permission', ...box('')], 80).dialog).toBeNull();
  });

  it('never reads the box row as a dialog: a draft is information, not a verdict', () => {
    expect(analyzeScreen(box('Quick safety check'), 80).dialog).toBeNull();
    expect(analyzeScreen(box('1. foo'), 80).dialog).toBeNull();
    expect(analyzeScreen(box('Do you want to'), 80).dialog).toBeNull();
  });

  describe('on the recorded screens', () => {
    it('fullscreen run: placeholder box, permission dialog without a box, empty box after the denial, a suggestion', async () => {
      const probes = (await recordedScreens('real-fs.stream.jsonl')).map((screen) => ({ screen, probe: analyzeScreen(screen.rows, screen.cols) }));
      expect(probes.length).toBeGreaterThanOrEqual(10);
      expect(probes[0]?.probe).toMatchObject({ promptBox: true, dialog: null, promptText: 'Try "fix lint errors"' });
      const dialogs = probes.filter(({ screen }) => screen.rows.some((row) => row.includes('Do you want to create')));
      expect(dialogs.length).toBeGreaterThan(0);
      for (const { probe } of dialogs) expect(probe).toMatchObject({ dialog: 'permission', promptBox: false, promptText: null });
      expect(probes.some(({ probe }) => probe.promptBox && probe.promptText === '')).toBe(true);
      expect(probes.some(({ probe }) => probe.promptText === 'create the file')).toBe(true);
      for (const { screen, probe } of probes) {
        if (!screen.rows.some((row) => row.includes('Do you want to create'))) expect(probe.dialog).toBeNull();
      }
    });

    it('classic run: the box is found at every width, empty after the reply', async () => {
      const probes = (await recordedScreens('real-classic.stream.jsonl')).map((screen) => analyzeScreen(screen.rows, screen.cols));
      expect(probes.length).toBeGreaterThanOrEqual(5);
      for (const probe of probes) expect(probe).toMatchObject({ promptBox: true, dialog: null, promptText: '' });
    });
  });
});

describe('analyzeScreen for pi and opencode (rows as the real engines drew them in a gonogo of this branch)', () => {
  const rule = '─'.repeat(100);
  const pad = (rows: string[], total = 30): string[] => [...rows, ...Array.from({ length: total - rows.length }, () => '')];
  const pi = (typed: string, below = ['/tmp/par-proj (master)', '↑28 ↓613 R1.3M W143k CH99.9% $0.980 14.3%/1.0M (auto)   claude-opus-5-5 • medium']): string[] => pad([' I sent "PONG-MAIL" to you in reply to your message, and it was delivered.', '', rule, typed, rule, ...below]);
  const opencode = (typed: string): string[] =>
    pad(['', '', '                                ▄', '', '             ┃', `             ┃  ${typed}`, '             ┃', '             ┃  Build · Big Pickle OpenCode', '             ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', '                                                tab agents  ctrl+p commands', '', '  /tmp/par-proj:master  ⊙ 2 MCP /status      1.19.6']);

  it('pi: the box is the rows between the lowest two rules; empty is empty, a draft is its text; Claude Code reads the same rows as no box', () => {
    expect(analyzeScreen(pi(''), 100, 'pi')).toMatchObject({ promptBox: true, promptText: '', dialog: null });
    expect(analyzeScreen(pi('hello draft'), 100, 'pi')).toMatchObject({ promptBox: true, promptText: 'hello draft' });
    expect(analyzeScreen(pi(''), 100)).toMatchObject({ promptBox: false, promptText: null });
    // a rule in the transcript above the box is not the box
    expect(analyzeScreen([rule, 'text', rule, ...pi('')], 100, 'pi')).toMatchObject({ promptBox: true, promptText: '' });
    // no status line below the box: not a box that is drawn yet
    expect(analyzeScreen(pad([rule, '', rule]), 100, 'pi')).toMatchObject({ promptBox: false });
  });

  it('opencode: the bar of ┃ rows above the ╹▀▀ line; the placeholder is empty, a draft is its text', () => {
    expect(analyzeScreen(opencode('Ask anything… "Fix a TODO in the codebase"'), 100, 'opencode')).toMatchObject({ promptBox: true, promptText: '' });
    expect(analyzeScreen(opencode('hello draft'), 100, 'opencode')).toMatchObject({ promptBox: true, promptText: 'hello draft' });
    expect(analyzeScreen(opencode('hello draft'), 100)).toMatchObject({ promptBox: false });
    expect(analyzeScreen(pad(['┃', '┃  x']), 100, 'opencode')).toMatchObject({ promptBox: false });
  });

  it('opencode 2.4.1 with no model it may use: "No provider selected" on its agent line, or its "Connect an integration" dialog (screens seen in a real run)', () => {
    const none = pad(['', '             ┃', '             ┃  Ask anything… "Fix a TODO in the codebase"', '             ┃', '             ┃  Build · No provider selected Connect a provider', '             ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', '             /tmp/w/a                   shift+tab agents  ctrl+p commands', '  ⊙ 2 MCP /mcps      2.4.1']);
    expect(analyzeScreen(none, 100, 'opencode')).toMatchObject({ promptBox: true, noModel: true });
    expect(analyzeScreen(pad(['                                  Connect an integration                           esc', '                                  Search', '                                  Popular', '                              ┃   OpenCode']), 100, 'opencode').noModel).toBe(true);
    expect(analyzeScreen(opencode('hello'), 100, 'opencode').noModel).toBe(false);
    // another engine never reads it
    expect(analyzeScreen(none, 100, 'pi').noModel).toBeUndefined();
  });

  it('opencode: the same words in the transcript (a printed file, a diff) or typed in the box do not hold the agent (RSO on #308)', () => {
    const transcript = (lines: string[]): string[] => // the dialog title only counts as a row of its own, with esc at the right (opencode's chrome)
      pad(['  + const reason = "No provider selected";', '  Connect an integration esc', '    Connect an integration                           esc   // quoted', '', '             ┃', `             ┃  ${lines[0] ?? 'Ask anything…'}`, '             ┃', '             ┃  Build · Big Pickle OpenCode', '             ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', '             /tmp/w/a                   shift+tab agents  ctrl+p commands']);
    expect(analyzeScreen(transcript([]), 100, 'opencode')).toMatchObject({ promptBox: true, noModel: false });
    // a draft that says it, in the box
    expect(analyzeScreen(transcript(['No provider selected']), 100, 'opencode')).toMatchObject({ promptBox: true, noModel: false });
  });

  it('the text of the box is never read as a dialog', () => {
    expect(analyzeScreen(pi('Do you want to proceed?'), 100, 'pi').dialog).toBeNull();
    expect(analyzeScreen(opencode('1. Yes  2. No'), 100, 'opencode').dialog).toBeNull();
  });
});

describe('classifyTitle', () => {
  it.each([
    ['✳ Claude Code', 'idle'],
    ['✳', 'idle'],
    ['   ✳ padded', 'idle'],
    ['◐ x', 'working'],
    ['◑ x', 'working'],
    ['◐', 'working'],
    ['', 'unknown'],
    ['   ', 'unknown'],
    ['Claude Code', 'unknown'],
    ['◓ other frame', 'unknown'],
    ['✻ Sketching', 'unknown'],
    ['x ✳', 'unknown'],
  ])('%j is %s', (title, glyph) => {
    expect(classifyTitle(title)).toBe(glyph);
  });
});

describe('ModeTracker', () => {
  const sequences: Array<[string, string]> = [
    [`${ESC}[?1006h`, `${ESC}[?1006h`],
    [`${ESC}[?25l`, `${ESC}[?25l`],
    [`${ESC}[?2031h`, `${ESC}[?2031h`],
    [`${ESC}[?1000;1006h`, `${ESC}[?1006h`],
    [`${ESC}[?1049;25;2004l`, `${ESC}[?25l`],
    [`before ${ESC}[?25h after`, `${ESC}[?25h`],
    [`${ESC}[?25l text ${ESC}[?1006h`, `${ESC}[?1006h${ESC}[?25l`], // a complete sequence, then one that the chunk cuts
  ];

  it('finds every sequence however the chunks are cut, even one byte at a time', () => {
    for (const [sequence, expected] of sequences) {
      for (let cut = 0; cut <= sequence.length; cut++) {
        const tracker = new ModeTracker();
        tracker.feed(sequence.slice(0, cut));
        tracker.feed(sequence.slice(cut));
        expect(tracker.fixup(), `${JSON.stringify(sequence)} cut at ${cut}`).toBe(expected);
      }
      const bytewise = new ModeTracker();
      for (const byte of Buffer.from(sequence)) bytewise.feed(Uint8Array.of(byte));
      expect(bytewise.fixup(), `${JSON.stringify(sequence)} byte by byte`).toBe(expected);
    }
  });

  it('keeps the last value of each mode and returns them in the order 1006, 2031, 25', () => {
    const tracker = new ModeTracker();
    tracker.feed(`${ESC}[?25l${ESC}[?2031h${ESC}[?1006l`);
    tracker.feed(Buffer.from(`${ESC}[?1006h${ESC}[?25h${ESC}[?25l`));
    tracker.feed(`${ESC}[?2031l`);
    expect(tracker.fixup()).toBe(`${ESC}[?1006h${ESC}[?2031l${ESC}[?25l`);
  });

  it('answers an empty string when nothing was seen, and ignores everything else', () => {
    const tracker = new ModeTracker();
    expect(tracker.fixup()).toBe('');
    tracker.feed(`${ESC}[2J${ESC}[?1049h${ESC}[?2004h${ESC}]0;title${BEL}${ESC}[?1006$p ${ESC}[1006h ${ESC}[?h plain text`);
    expect(tracker.fixup()).toBe('');
  });

  it('drops an unfinished sequence longer than 32 bytes and one that was cut off by other output', () => {
    const tracker = new ModeTracker();
    tracker.feed(`${ESC}[?1006;${'0;'.repeat(20)}`);
    tracker.feed('h');
    expect(tracker.fixup()).toBe('');
    tracker.feed(`${ESC}[?10`);
    tracker.feed(`x${ESC}[?25h`);
    expect(tracker.fixup()).toBe(`${ESC}[?25h`);
  });

  it('works when its methods are passed on detached', () => {
    const { feed, fixup } = new ModeTracker();
    feed(`${ESC}[?25l`);
    expect(fixup()).toBe(`${ESC}[?25l`);
  });
});

describe('sanitizeForPaste and buildSubmit', () => {
  it.each([
    ['line ends become LF', 'a\r\nb\rc\nd', 'a\nb\nc\nd'],
    ['ESC goes, so a paste cannot be ended from inside', `a${ESC}[201~b`, 'a[201~b'],
    ['C0 controls go, tab and LF stay', 'a\u0000\u0001\u0007\u0008\u000b\u000c\u000e\u001fb\tc\nd', 'ab\tc\nd'],
    ['DEL and C1 controls go', 'a\u007f\u0080\u0085\u009fb', 'ab'],
    ['zero-width, bidi and tag characters go', 'a\u{200b}\u{200c}\u{200d}\u{200e}\u{200f}\u{202a}\u{202e}\u{2060}\u{2064}\u{2066}\u{2069}\u{feff}\u{e0041}\u{e007f}b', 'ab'],
    ['neighbours of those ranges stay', 'a\u{200a}\u{2065}\u{2028}b', 'a\u{200a}\u{2065}\u{2028}b'],
    ['letters of every script stay', 'é 日本 ñ 😀 γ', 'é 日本 ñ 😀 γ'],
    ['the ends are trimmed', '  \n gonogo: x \n\n', 'gonogo: x'],
    ['nothing left is an empty string', `${ESC}\u0000\u{200b}`, ''],
  ])('%s', (_label, input, expected) => {
    expect(sanitizeForPaste(input)).toBe(expected);
  });

  it('whatever the input, nothing that could end the paste or type a key gets through (seeded random strings)', () => {
    const next = seeded(20261116);
    const pool = [
      'a', 'Z', ' ', '\t', '\n', '\r', '\r\n', ESC, '[', '2', '0', '1', '~', '\u0000', '\u0003', '\u0007', '\u001f', '\u007f', '\u0085', '\u009b',
      '\u{200b}', '\u{200e}', '\u{202e}', '\u{2066}', '\u{2069}', '\u{feff}', '\u{e0041}', '\u{e007f}', '\u{2028}', 'é', '日', '😀',
    ];
    const forbidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e0000}-\u{e007f}]/u;
    for (let i = 0; i < 2000; i++) {
      const text = Array.from({ length: Math.floor(next() * 40) }, () => pool[Math.floor(next() * pool.length)]).join('');
      const clean = sanitizeForPaste(text);
      expect(forbidden.test(clean), JSON.stringify(text)).toBe(false);
      expect(sanitizeForPaste(clean), JSON.stringify(text)).toBe(clean);
      expect(clean, JSON.stringify(text)).toBe(clean.trim());
      const typed = buildSubmit(text);
      expect(typed, JSON.stringify(text)).toBe(`${PASTE_START}${clean}${PASTE_END}${ENTER}`);
      expect(typed.split(ESC).length - 1, JSON.stringify(text)).toBe(2); // only the two paste markers
    }
  });

  it('builds ESC[200~ text ESC[201~ CR from the sanitised text', () => {
    expect(buildSubmit(POINTER)).toBe(`${ESC}[200~${POINTER}${ESC}[201~\r`);
    expect(buildSubmit(` gonogo: hi${ESC} `)).toBe(`${PASTE_START}gonogo: hi${PASTE_END}${ENTER}`);
    expect(buildSubmit('')).toBe(`${PASTE_START}${PASTE_END}${ENTER}`);
  });
});

describe('ensureSpawnHelperExecutable', () => {
  const makeRoot = (mode: number, where = join('prebuilds', 'darwin-arm64')): { root: string; helper: string } => {
    const root = join(tmp, 'pkg');
    mkdirSync(join(root, where), { recursive: true });
    const helper = join(root, where, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, mode);
    return { root, helper };
  };

  it('makes a 0644 helper executable, reports it once, and leaves an executable one alone', () => {
    const { root, helper } = makeRoot(0o644);
    const { log, lines } = collectingLogger();
    expect(ensureSpawnHelperExecutable(log, [root])).toEqual([helper]);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
    expect(ensureSpawnHelperExecutable(log, [root])).toEqual([]);
    expect(lines.some((line) => line.includes('made spawn-helper executable') && line.includes(helper))).toBe(true);
  });

  it('also finds build/Release and keeps the other mode bits', () => {
    const { root, helper } = makeRoot(0o640, join('build', 'Release'));
    expect(ensureSpawnHelperExecutable(nullLogger, [root])).toEqual([helper]);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('returns an empty list for a tree with no helper (Linux packages have none) or no tree at all', () => {
    mkdirSync(join(tmp, 'linux', 'prebuilds', 'linux-x64'), { recursive: true });
    writeFileSync(join(tmp, 'linux', 'prebuilds', 'linux-x64', 'pty.node'), '');
    expect(ensureSpawnHelperExecutable(nullLogger, [join(tmp, 'linux'), join(tmp, 'missing')])).toEqual([]);
    expect(ensureSpawnHelperExecutable(nullLogger, [])).toEqual([]);
  });

  it('finds the real helper in this install, changes nothing and does not throw (no roots)', () => {
    const { log, lines } = collectingLogger();
    expect(ensureSpawnHelperExecutable(log)).toEqual([]);
    if (process.platform === 'darwin') {
      const found = lines.filter((line) => line.includes('spawn-helper is executable'));
      expect(found.some((line) => line.includes('node-pty') && line.includes('spawn-helper'))).toBe(true);
    }
    expect(lines.some((line) => / warn /.test(line))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('logs a warning and does not throw when the folder cannot be read', () => {
    const { root } = makeRoot(0o644);
    const prebuilds = join(root, 'prebuilds');
    chmodSync(prebuilds, 0o000);
    try {
      const { log, lines } = collectingLogger();
      expect(ensureSpawnHelperExecutable(log, [root])).toEqual([]);
      expect(lines.some((line) => line.includes(' warn ') && line.includes(root))).toBe(true);
    } finally {
      chmodSync(prebuilds, 0o755);
    }
  });

  it('logs a warning with the path and does not throw when chmod is refused', async () => {
    const { root, helper } = makeRoot(0o644);
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        chmodSync: () => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        },
      };
    });
    try {
      const fresh = await import('../src/server/terminal.js');
      const { log, lines } = collectingLogger();
      expect(fresh.ensureSpawnHelperExecutable(log, [root])).toEqual([]);
      expect(lines.some((line) => line.includes(' warn ') && line.includes(helper) && line.includes('EPERM'))).toBe(true);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('the libraries as plain Node loads them', () => {
  it('default-imports @xterm/headless and destructures Terminal (the form terminal.ts uses)', () => {
    expect(typeof xtermHeadless.Terminal).toBe('function');
    expect(typeof Terminal).toBe('function');
  });

  it('plain Node ESM resolves the three imports the way terminal.ts writes them', () => {
    const script = [
      'import xtermHeadless from "@xterm/headless";',
      'import { spawn } from "@lydell/node-pty";',
      'import { SerializeAddon } from "@xterm/addon-serialize";',
      'process.stdout.write([typeof xtermHeadless.Terminal, typeof spawn, typeof SerializeAddon].join(","));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: projectRoot, encoding: 'utf8' });
    expect(out).toBe('function,function,function');
  });

  it('O1: onTitleChange fires for OSC 0 with the whole title string', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const titles: string[] = [];
    term.onTitleChange((title) => titles.push(title));
    await feed(term, `${ESC}]0;✳ Claude Code${BEL}${ESC}]0;◐ Fake${BEL}${ESC}]2;two${ESC}\\`);
    expect(titles).toEqual(['✳ Claude Code', '◐ Fake', 'two']);
  });

  it('O2: bracketedPasteMode and the buffer type are readable right after the write callback', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    expect(term.modes.bracketedPasteMode).toBe(false);
    await feed(term, `${ESC}[?2004h${ESC}[?1049h`);
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(term.buffer.active.type).toBe('alternate');
    await feed(term, `${ESC}[?2004l`);
    expect(term.modes.bracketedPasteMode).toBe(false);
  });
});

/* ---- a real pty with node children (no claude) ---- */

describe('terminal host with a real pty', () => {
  it('echoes output and emits title, then ready, then exit last', async () => {
    const host = makeHost();
    const events = collect(host);
    const { pid } = host.spawn('a', 1, nodeSpec(printing(`${ESC}]0;${TITLE_IDLE_GLYPH} Claude Code${BEL}${PASTE_MODE_ON}${BOX}hello pty\r\n`)));
    expect(pid).toBeGreaterThan(1);
    await until(() => events.some((event) => event.kind === 'ready'), 'ready');
    expect(events.map((event) => event.kind)).toEqual(['title', 'ready']);
    expect(events[0]).toMatchObject({ kind: 'title', name: 'a', generation: 1, glyph: 'idle', title: `${TITLE_IDLE_GLYPH} Claude Code` });
    expect(events[1]).toMatchObject({ kind: 'ready', name: 'a', generation: 1 });
    expect(await textOf(host, 'a')).toContain('hello pty');
    expect(host.info('a')).toEqual({ running: true, generation: 1, pid, cols: 120, rows: 40 });
    expect(host.outputBytes('a')).toBeGreaterThan(50);
    await host.stop('a');
    expect(events[events.length - 1]).toMatchObject({ kind: 'exit', name: 'a', generation: 1 });
    expect(events.filter((event) => event.kind === 'exit')).toHaveLength(1);
  });

  describe('readiness: ESC[?2004h and the boxed prompt row, no dialog', () => {
    const settle = async (host: TerminalHost): Promise<void> => {
      await until(() => host.outputBytes('a') > 0 && host.screen('a') !== null, 'parsed output');
      await new Promise((resolve) => setTimeout(resolve, 60));
    };

    it('does not fire for a box without bracketed paste mode (raw mode is not known to be on)', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec(printing(BOX)));
      await settle(host);
      expect(host.screen('a')).toMatchObject({ promptBox: true, dialog: null });
      expect(events.filter((event) => event.kind === 'ready')).toEqual([]);
    });

    it('does not fire for a permission dialog (it replaces the box), nor for a box under a startup dialog', async () => {
      const host = makeHost();
      const events = collect(host);
      const dialog = `${PASTE_MODE_ON} Create file\r\n${'╌'.repeat(40)}\r\n Do you want to create x.txt?\r\n ${PROMPT_GLYPH} 1. Yes\r\n   2. No\r\n`;
      host.spawn('a', 1, nodeSpec(printing(dialog)));
      await settle(host);
      expect(host.screen('a')).toMatchObject({ promptBox: false, dialog: 'permission' });
      host.spawn('b', 1, nodeSpec(printing(`${PASTE_MODE_ON}Quick safety check: Is this a project you created or one you trust?\r\n${BOX}`)));
      await until(() => host.outputBytes('b') > 0 && host.screen('b') !== null, 'parsed output of b');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(host.screen('b')).toMatchObject({ promptBox: true, dialog: 'trust' });
      expect(events.filter((event) => event.kind === 'ready')).toEqual([]);
    });

    it('fires exactly once per generation, however often the box is drawn again, and again for the next generation', async () => {
      const host = makeHost();
      const events = collect(host);
      // the text goes in by environment, not spliced into the code
      const script = 'process.stdout.write(process.env.FIRST); setTimeout(() => process.stdout.write(process.env.BOX), 80); setTimeout(() => process.exit(0), 250);';
      const env = { FIRST: PASTE_MODE_ON + BOX, BOX };
      host.spawn('a', 1, nodeSpec(script, env));
      await until(() => events.some((event) => event.kind === 'exit'), 'exit');
      expect(events.filter((event) => event.kind === 'ready')).toHaveLength(1);
      host.spawn('a', 2, nodeSpec(script, env));
      await until(() => events.filter((event) => event.kind === 'exit').length === 2, 'second exit');
      expect(events.filter((event) => event.kind === 'ready').map((event) => event.generation)).toEqual([1, 2]);
    });
  });

  it('emits title events when the glyph class changes, and host.title() holds the last one', async () => {
    const host = makeHost();
    const events = collect(host);
    const titles = ['✳ A', '✳ B', '◐ C', '◑ D', '✳ E', ''];
    host.spawn('a', 1, nodeSpec(printing(titles.map((title) => `${ESC}]0;${title}${BEL}`).join(''))));
    await until(() => events.filter((event) => event.kind === 'title').length === 4, 'four title events');
    expect(events.map((event) => (event.kind === 'title' ? `${event.glyph}:${event.title}` : event.kind))).toEqual([
      'idle:✳ A',
      'working:◐ C',
      'idle:✳ E',
      'unknown:',
    ]);
    expect(host.title('a')).toMatchObject({ glyph: 'unknown', title: '' });
    expect(host.title('nobody')).toBeNull();
  });

  describe('typing', () => {
    const stdinLogger = (withPasteMode: boolean): string => `
      const fs = require('node:fs');
      process.stdin.setRawMode(true);
      process.stdin.on('data', (d) => fs.appendFileSync(process.env.STDIN_LOG, d.toString('hex') + '\\n'));
      process.stdout.write(${JSON.stringify((withPasteMode ? PASTE_MODE_ON : '') + BOX)});
      setInterval(() => {}, 1000);
    `;
    const logPath = (): string => join(tmp, 'stdin.log');
    const readLog = (): string[] => (existsSync(logPath()) ? readFileSync(logPath(), 'utf8').split('\n').filter((line) => line !== '') : []);
    const hex = (text: string): string => Buffer.from(text).toString('hex');

    it('submit writes ESC[200~ text ESC[201~ CR as one chunk', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec(stdinLogger(true), { STDIN_LOG: logPath() }));
      await until(() => events.some((event) => event.kind === 'ready'), 'ready');
      expect(host.submit('a', 1, POINTER)).toBe(true);
      await until(() => readLog().length > 0, 'the typed pointer');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readLog()).toEqual([hex(`${PASTE_START}${POINTER}${PASTE_END}${ENTER}`)]);
    });

    it('refuses text without the prefix, an empty or long text, another generation, and writes nothing', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec(stdinLogger(true), { STDIN_LOG: logPath() }));
      await until(() => events.some((event) => event.kind === 'ready'), 'ready');
      expect(host.submit('a', 1, 'hello')).toBe(false);
      expect(host.submit('a', 1, '/clear')).toBe(false);
      expect(host.submit('a', 1, '!rm -rf /')).toBe(false);
      expect(host.submit('a', 1, ' \n ')).toBe(false);
      expect(host.submit('a', 1, `\u{200b}hello ${POINTER}`)).toBe(false);
      expect(host.submit('a', 1, `gonogo: ${'x'.repeat(POINTER_LINE_MAX_CHARS)}`)).toBe(false);
      expect(host.submit('a', 2, POINTER)).toBe(false);
      expect(host.submit('nobody', 1, POINTER)).toBe(false);
      const longest = `gonogo: ${'x'.repeat(POINTER_LINE_MAX_CHARS - 8)}`; // exactly the longest line
      expect(host.submit('a', 1, longest)).toBe(true);
      const expected = hex(`${PASTE_START}${longest}${PASTE_END}${ENTER}`);
      await until(() => readLog().join('').length >= expected.length, 'the one accepted write');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readLog().join('')).toBe(expected); // none of the refused texts got through
    });

    it('refuses while bracketed paste mode is off', async () => {
      const host = makeHost();
      host.spawn('a', 1, nodeSpec(stdinLogger(false), { STDIN_LOG: logPath() }));
      await until(() => host.outputBytes('a') > 0 && host.screen('a') !== null, 'parsed output');
      expect(host.submit('a', 1, POINTER)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readLog()).toEqual([]);
    });

    it('sanitises instead of refusing: a text holding ESC reaches the child with no ESC but the two paste markers', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec(stdinLogger(true), { STDIN_LOG: logPath() }));
      await until(() => events.some((event) => event.kind === 'ready'), 'ready');
      expect(host.submit('a', 1, `gonogo: a${ESC}[201~b\u0003c`)).toBe(true);
      await until(() => readLog().join('').length >= hex(`${PASTE_START}gonogo: a[201~bc${PASTE_END}${ENTER}`).length, 'the typed text');
      expect(readLog().join('')).toBe(hex(`${PASTE_START}gonogo: a[201~bc${PASTE_END}${ENTER}`));
    });

    it('write passes browser input through untouched, text and bytes', async () => {
      const host = makeHost();
      host.spawn('a', 1, nodeSpec(stdinLogger(true), { STDIN_LOG: logPath() }));
      await until(() => host.outputBytes('a') > 0, 'output');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(host.write('a', `x${ESC}[A\u0003`)).toBe(true);
      expect(host.write('a', Uint8Array.of(0xe2, 0x9c, 0xb3))).toBe(true);
      await until(() => readLog().join('').length >= hex(`x${ESC}[A\u0003✳`).length, 'the keystrokes');
      expect(readLog().join('')).toBe(hex(`x${ESC}[A\u0003✳`));
      expect(host.write('nobody', 'x')).toBe(false);
    });
  });

  describe('size', () => {
    // `stty size` asks the pty itself ("rows cols"), node's own columns and rows come from the same ioctl but arrive with the resize event.
    const reporter = `
      const { execFileSync } = require('node:child_process');
      process.stdout.write('START ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');
      process.stdout.on('resize', () => {
        const stty = execFileSync('stty', ['size'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
        process.stdout.write('SIZE ' + process.stdout.columns + 'x' + process.stdout.rows + ' STTY ' + stty + '\\r\\n');
      });
      setInterval(() => {}, 1000);
    `;

    it('starts at the size of the spec and resize applies to the pty and to the mirror', async () => {
      const host = makeHost();
      host.spawn('a', 1, nodeSpec(reporter, {}, { cols: 100, rows: 30 }));
      await until(async () => (await textOf(host, 'a')).includes('START 100x30'), 'the start size');
      expect(host.resize('a', 80, 24)).toBe(true);
      expect(host.info('a')).toMatchObject({ cols: 80, rows: 24 });
      await until(async () => (await textOf(host, 'a')).includes('SIZE 80x24 STTY 24 80'), 'the child seeing 80x24');
      const attachment = await host.attach('a', () => {});
      expect([attachment.snapshot.cols, attachment.snapshot.rows]).toEqual([80, 24]);
      attachment.detach();
    });

    it('clamps to the limits, truncates fractions, refuses numbers that are not numbers, and does nothing at the same size', async () => {
      const host = makeHost();
      host.spawn('a', 1, nodeSpec(reporter, {}, { cols: 100, rows: 30 }));
      expect(host.resize('a', 1, 1)).toBe(true);
      expect(host.info('a')).toMatchObject({ cols: MIN_COLS, rows: MIN_ROWS });
      expect(host.resize('a', 99999, 99999)).toBe(true);
      expect(host.info('a')).toMatchObject({ cols: MAX_COLS, rows: MAX_ROWS });
      expect(host.resize('a', 90.9, 40.2)).toBe(true);
      expect(host.info('a')).toMatchObject({ cols: 90, rows: 40 });
      expect(host.resize('a', Number.NaN, 30)).toBe(false);
      expect(host.resize('a', 90, Number.POSITIVE_INFINITY)).toBe(false);
      expect(host.info('a')).toMatchObject({ cols: 90, rows: 40 });
      expect(host.resize('a', 90, 40)).toBe(true);
      expect(host.resize('nobody', 90, 40)).toBe(false);
    });

    it('a new spawn takes the size of the spec, else the last size of that name, else the default; always clamped', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec('setTimeout(() => process.exit(0), 200)', {}, { cols: 100, rows: 30 }));
      expect(host.resize('a', 90, 25)).toBe(true);
      await until(() => events.some((event) => event.kind === 'exit'), 'first exit');
      expect(host.info('a')).toMatchObject({ running: false, cols: 90, rows: 25 });
      host.spawn('a', 2, nodeSpec('setTimeout(() => process.exit(0), 200)'));
      expect(host.info('a')).toMatchObject({ cols: 90, rows: 25 });
      await until(() => events.filter((event) => event.kind === 'exit').length === 2, 'second exit');
      host.spawn('a', 3, nodeSpec('setTimeout(() => process.exit(0), 200)', {}, { cols: 5, rows: 100000 }));
      expect(host.info('a')).toMatchObject({ cols: MIN_COLS, rows: MAX_ROWS });
      host.spawn('fresh', 1, nodeSpec('setTimeout(() => process.exit(0), 200)'));
      expect(host.info('fresh')).toMatchObject({ cols: 120, rows: 40 });
    });
  });

  describe('exit', () => {
    const exits = async (script: string): Promise<Extract<TerminalEvent, { kind: 'exit' }>> => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 7, nodeSpec(script));
      await until(() => events.some((event) => event.kind === 'exit'), 'exit');
      const exit = exitOf(events);
      expect(exit.generation).toBe(7);
      expect(events[events.length - 1]).toBe(exit);
      return exit;
    };

    it.each([
      ['code 0', 'process.exit(0)', 0, null],
      ['code 1', 'process.exit(1)', 1, null],
      ['code 143 (claude after SIGTERM)', 'process.exit(143)', 143, null],
      ['a signal (node-pty reports code 0 with it)', "process.kill(process.pid, 'SIGKILL')", null, 9],
      ['SIGTERM', "process.kill(process.pid, 'SIGTERM')", null, 15],
    ])('maps %s', async (_label, script, code, signal) => {
      const exit = await exits(script);
      expect(exit.info).toMatchObject({ code, signal, requested: false });
      expect(exit.info.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('carries the last non-empty rows of the screen as the tail', async () => {
      const exit = await exits(`process.stdout.write('first\\r\\n\\r\\nNo conversation found with session ID: 1234\\r\\n'); process.exit(1)`);
      expect(exit.info.tail).toBe('first\nNo conversation found with session ID: 1234');
    });

    it('keeps at most 20 rows and 2000 characters of the tail, the last ones', async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `row ${String(i + 1).padStart(2, '0')} ${'.'.repeat(100)}`);
      const exit = await exits(`process.stdout.write(${JSON.stringify(lines.join('\r\n') + '\r\n')}); process.exit(0)`);
      expect(exit.info.tail.length).toBe(2000);
      expect(exit.info.tail.endsWith(lines[29] ?? '')).toBe(true);
      expect(exit.info.tail.split('\n').length).toBeLessThanOrEqual(20);
      expect(exit.info.tail).not.toContain('row 10');
    });

    it('methods that touch a pty that is gone return false and never throw, also inside the exit listener', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {}); // node-pty prints the EIO of the writes after the exit
      const host = makeHost();
      const thrown: unknown[] = [];
      const inside: boolean[] = [];
      let sawExit = false;
      host.onEvent((event) => {
        if (event.kind !== 'exit') return;
        sawExit = true;
        inside.push(host.resize('a', 90, 30), host.write('a', 'x'), host.submit('a', 1, POINTER));
      });
      host.spawn('a', 1, nodeSpec(`process.stdout.write(${JSON.stringify(PASTE_MODE_ON + BOX)}); setTimeout(() => process.exit(0), 150);`));
      let n = 0;
      const timer = setInterval(() => {
        try {
          host.resize('a', 100 + (n++ % 2), 30);
          host.write('a', 'x');
          host.submit('a', 1, POINTER);
          host.info('a');
          host.screen('a');
        } catch (error) {
          thrown.push(error);
        }
      }, 1);
      await until(() => sawExit, 'exit');
      clearInterval(timer);
      expect(thrown).toEqual([]);
      expect(inside).toEqual([false, false, false]);
      expect([host.resize('a', 100, 30), host.write('a', 'x'), host.submit('a', 1, POINTER)]).toEqual([false, false, false]);
      expect(host.info('a')).toMatchObject({ running: false, pid: null });
      await new Promise((resolve) => setTimeout(resolve, 30)); // the late write errors arrive on later ticks, while the stub is still in place
    });
  });

  describe('stop', () => {
    // A zombie still answers kill(pid, 0); where there is no init to reap it, /proc says it is dead.
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      try {
        return !(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1] ?? '').startsWith('Z');
      } catch {
        return true; // no /proc (macOS), where launchd reaps orphans at once
      }
    };
    const waitForPidFile = async (name: string): Promise<number> => {
      const file = join(tmp, name);
      await until(() => existsSync(file) && readFileSync(file, 'utf8') !== '', `${name}`);
      const pid = Number(readFileSync(file, 'utf8'));
      strays.push(pid);
      return pid;
    };

    it('sends SIGTERM to a well-behaved child and resolves after the exit event handlers ran', async () => {
      const host = makeHost({ killAfterMs: 5000 });
      const order: string[] = [];
      host.onEvent((event) => order.push(event.kind));
      host.spawn('a', 1, nodeSpec('setInterval(() => {}, 1000)'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const started = Date.now();
      const stopping = host.stop('a');
      expect(host.stop('a')).toBe(stopping); // a second call returns the same promise
      await stopping.then(() => order.push('stopped'));
      expect(order).toEqual(['exit', 'stopped']);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(host.info('a')?.running).toBe(false);
    });

    it('reports requested, and the signal that ended it', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec('setInterval(() => {}, 1000)'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      await host.stop('a');
      expect(exitOf(events).info).toMatchObject({ code: null, signal: 15, requested: true });
    });

    it('sends SIGKILL after killAfterMs to a child that ignores SIGTERM', async () => {
      const host = makeHost({ killAfterMs: 200, giveUpAfterKillMs: 3000 });
      const events = collect(host);
      host.spawn('a', 1, nodeSpec(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.UP, '1'); setInterval(() => {}, 1000);`, { UP: join(tmp, 'up') }));
      await until(() => existsSync(join(tmp, 'up')), 'the child to ignore SIGTERM');
      const started = Date.now();
      await host.stop('a');
      expect(Date.now() - started).toBeGreaterThanOrEqual(190);
      expect(exitOf(events).info).toMatchObject({ code: null, signal: 9, requested: true });
    });

    it('kills the whole process group: a grandchild dies with its parent, with SIGTERM and with SIGKILL', async () => {
      const grandchild = (stubborn: boolean): string => `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const body = ${JSON.stringify(stubborn ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);" : 'setInterval(() => {}, 1000);')};
        const g = spawn(process.execPath, ['-e', body], { stdio: 'ignore' });
        fs.writeFileSync(process.env.GPID, String(g.pid));
        ${stubborn ? "process.on('SIGTERM', () => {});" : ''}
        setInterval(() => {}, 1000);
      `;
      const host = makeHost({ killAfterMs: 400, giveUpAfterKillMs: 3000 });
      host.spawn('polite', 1, nodeSpec(grandchild(false), { GPID: join(tmp, 'polite.pid') }));
      host.spawn('stubborn', 1, nodeSpec(grandchild(true), { GPID: join(tmp, 'stubborn.pid') }));
      const politePid = await waitForPidFile('polite.pid');
      const stubbornPid = await waitForPidFile('stubborn.pid');
      await new Promise((resolve) => setTimeout(resolve, 200)); // the stubborn pair must have installed its handlers
      expect(alive(politePid) && alive(stubbornPid)).toBe(true);
      await host.stop('polite');
      await until(() => !alive(politePid), 'the polite grandchild to die');
      expect(alive(stubbornPid)).toBe(true);
      await host.stop('stubborn');
      await until(() => !alive(stubbornPid), 'the stubborn grandchild to die');
    });

    it('resolves at once for a name that does not run and for a generation that is not the running one', async () => {
      const host = makeHost();
      await host.stop('nobody');
      host.spawn('a', 3, nodeSpec('setInterval(() => {}, 1000)'));
      await host.stop('a', 2);
      expect(host.info('a')?.running).toBe(true);
      await host.stop('a', 3);
      expect(host.info('a')?.running).toBe(false);
      await host.stop('a');
    });

    it('stopAll stops every running agent', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec('setInterval(() => {}, 1000)'));
      host.spawn('b', 1, nodeSpec('setInterval(() => {}, 1000)'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      await host.stopAll();
      expect(events.filter((event) => event.kind === 'exit').map((event) => event.name).sort()).toEqual(['a', 'b']);
      await host.stopAll();
    });
  });

  describe('attach', () => {
    const flood = `
      let i = 0;
      const total = 30000;
      const timer = setInterval(() => {
        const out = [];
        for (let k = 0; k < 200 && i < total; k++) out.push('line ' + (++i));
        process.stdout.write(out.join('\\r\\n') + '\\r\\n');
        if (i >= total) { clearInterval(timer); process.stdout.write('DONE\\r\\n'); setTimeout(() => process.exit(0), 100); }
      }, 4);
    `;

    it('under heavy output delivers the snapshot and then the listener bytes with none missing and none twice', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec(flood));
      await until(() => host.outputBytes('a') > 8000, 'some output');
      const joiners: Array<{ parts: Buffer[]; attachment: Awaited<ReturnType<TerminalHost['attach']>>; at: number }> = [];
      for (let i = 0; i < 3; i++) {
        const parts: Buffer[] = [];
        const at = host.outputBytes('a');
        const attachment = await host.attach('a', (chunk) => parts.push(Buffer.from(chunk)));
        expect(attachment.snapshot).toMatchObject({ generation: 1, running: true, cols: 120, rows: 40 });
        expect(parts).toEqual([]); // nothing before start()
        attachment.start();
        joiners.push({ parts, attachment, at });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await until(() => events.some((event) => event.kind === 'exit'), 'the flood to end');
      expect(joiners[0]?.at).toBeLessThan(host.outputBytes('a'));
      for (const { parts, attachment } of joiners) {
        const joined = new Terminal({ cols: attachment.snapshot.cols, rows: attachment.snapshot.rows, scrollback: 100_000, allowProposedApi: true });
        await feed(joined, attachment.snapshot.data);
        await feed(joined, Buffer.concat(parts));
        const buffer = joined.buffer.active;
        const numbers: number[] = [];
        for (let y = 0; y < buffer.length; y++) {
          const match = /^line (\d+)$/.exec(buffer.getLine(y)?.translateToString(true) ?? '');
          if (match) numbers.push(Number(match[1]));
        }
        expect(numbers.length).toBeGreaterThan(1000);
        expect(numbers[numbers.length - 1]).toBe(30000);
        const gaps = numbers.filter((value, index) => index > 0 && value !== (numbers[index - 1] ?? 0) + 1);
        expect(gaps).toEqual([]); // a missing chunk leaves a gap, a repeated one a repeat
      }
    });

    it('detach is idempotent and stops delivery for good', async () => {
      const host = makeHost();
      host.spawn('a', 1, nodeSpec(`setInterval(() => process.stdout.write('tick\\r\\n'), 5)`));
      const parts: Buffer[] = [];
      const attachment = await host.attach('a', (chunk) => parts.push(Buffer.from(chunk)));
      attachment.start();
      await until(() => parts.length > 2, 'live chunks');
      attachment.detach();
      attachment.detach();
      const seen = parts.length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(parts.length).toBe(seen);
    });

    it('an unknown name gets an empty snapshot at the default size and no-op start and detach', async () => {
      const host = makeHost();
      const attachment = await host.attach('nobody', () => {});
      expect(attachment.snapshot).toEqual({ cols: 120, rows: 40, data: '', generation: 0, running: false });
      attachment.start();
      attachment.detach();
    });
  });

  describe('rename', () => {
    const finishedWith = async (host: TerminalHost, events: TerminalEvent[], name: string, text: string): Promise<void> => {
      const before = events.filter((event) => event.kind === 'exit').length;
      host.spawn(name, 1, nodeSpec(`process.stdout.write(${JSON.stringify(text + '\r\n')}); setTimeout(() => process.exit(0), 100);`));
      await until(() => events.filter((event) => event.kind === 'exit').length === before + 1, `exit of ${name}`);
    };

    it('moves a finished record: the new name attaches to the last screen, the old name has none', async () => {
      const host = makeHost();
      const events = collect(host);
      await finishedWith(host, events, 'old', 'the last screen of old');
      expect(host.rename('old', 'new')).toBe(true);
      const moved = await host.attach('new', () => {});
      expect(moved.snapshot.data).toContain('the last screen of old');
      expect(moved.snapshot).toMatchObject({ generation: 1, running: false });
      expect(host.info('new')).toMatchObject({ running: false, generation: 1 });
      expect(host.title('old')).toBeNull();
      expect(host.info('old')).toBeNull();
      expect(host.outputBytes('old')).toBe(0);
      expect((await host.attach('old', () => {})).snapshot).toMatchObject({ data: '', generation: 0, running: false });
    });

    it('replaces a finished record under the new name and keeps size and title with the record', async () => {
      const host = makeHost();
      const events = collect(host);
      await finishedWith(host, events, 'a', `${ESC}]0;✳ from a${BEL}text of a`);
      await finishedWith(host, events, 'b', 'text of b');
      expect(host.rename('a', 'b')).toBe(true);
      const data = await textOf(host, 'b');
      expect(data).toContain('text of a');
      expect(data).not.toContain('text of b');
      expect(host.title('b')).toMatchObject({ glyph: 'idle', title: '✳ from a' });
      expect(host.rename('b', 'b')).toBe(true);
    });

    it('is false for a live process on either name, and for a name with no record', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('live', 1, nodeSpec('setInterval(() => {}, 1000)'));
      await finishedWith(host, events, 'done', 'x');
      expect(host.rename('live', 'other')).toBe(false);
      expect(host.rename('done', 'live')).toBe(false);
      expect(host.rename('nobody', 'other')).toBe(false);
      expect(host.info('done')).not.toBeNull();
      expect(host.info('live')?.running).toBe(true);
    });

    it('a spawn of the old name afterwards starts clean, with no stale mirror or size', async () => {
      const host = makeHost();
      const events = collect(host);
      await finishedWith(host, events, 'old', 'stale screen');
      expect(host.resize('old', 90, 20)).toBe(false);
      expect(host.rename('old', 'new')).toBe(true);
      host.spawn('old', 2, nodeSpec('setInterval(() => {}, 1000)'));
      expect(host.info('old')).toMatchObject({ generation: 2, cols: 120, rows: 40 });
      expect(await textOf(host, 'old')).not.toContain('stale screen');
    });
  });

  describe('forget (SECPROC-3)', () => {
    const finishedWith = async (host: TerminalHost, events: TerminalEvent[], name: string, text: string): Promise<void> => {
      const before = events.filter((event) => event.kind === 'exit').length;
      host.spawn(name, 1, nodeSpec(`process.stdout.write(${JSON.stringify(`${ESC}]0;✳ ${name}${BEL}${text}\r\n`)}); setTimeout(() => process.exit(0), 100);`));
      await until(() => events.filter((event) => event.kind === 'exit').length === before + 1, `exit of ${name}`);
    };

    it('frees the finished record of a name: the host knows nothing of it any more, and the mirror is disposed', async () => {
      const dispose = vi.spyOn(Terminal.prototype, 'dispose');
      const host = makeHost();
      const events = collect(host);
      await finishedWith(host, events, 'gone', 'the last screen of gone');
      await finishedWith(host, events, 'stays', 'the last screen of stays');
      expect(host.info('gone')).not.toBeNull();
      host.forget?.('gone');
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(host.info('gone')).toBeNull();
      expect(host.title('gone')).toBeNull();
      expect(host.screen('gone')).toBeNull();
      expect(host.outputBytes('gone')).toBe(0);
      expect((await host.attach('gone', () => {})).snapshot).toMatchObject({ data: '', generation: 0, running: false });
      expect(host.rename('gone', 'other')).toBe(false);
      // Nobody else is touched.
      expect(await textOf(host, 'stays')).toContain('the last screen of stays');
      expect(host.info('stays')).toMatchObject({ running: false, generation: 1 });
    });

    it('a name that is hired again starts clean, with no stale mirror or size', async () => {
      const host = makeHost();
      const events = collect(host);
      await finishedWith(host, events, 'a', 'stale screen');
      host.forget?.('a');
      host.spawn('a', 2, nodeSpec('setInterval(() => {}, 1000)'));
      expect(host.info('a')).toMatchObject({ generation: 2, running: true, cols: 120, rows: 40 });
      expect(await textOf(host, 'a')).not.toContain('stale screen');
    });

    it('does nothing for a process that still runs, a name never spawned, and a second call', async () => {
      const dispose = vi.spyOn(Terminal.prototype, 'dispose');
      const host = makeHost();
      const events = collect(host);
      host.spawn('live', 1, nodeSpec(printing('still here')));
      await until(async () => (await textOf(host, 'live')).includes('still here'), 'the output');
      expect(() => {
        host.forget?.('live');
        host.forget?.('nobody');
        host.forget?.('');
      }).not.toThrow();
      expect(dispose).not.toHaveBeenCalled();
      expect(host.info('live')).toMatchObject({ running: true, generation: 1 });
      expect(await textOf(host, 'live')).toContain('still here');
      await finishedWith(host, events, 'done', 'x');
      host.forget?.('done');
      expect(() => host.forget?.('done')).not.toThrow();
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('cuts an attachment loose: what it had buffered is never delivered, and a late start() is silent', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec(`setTimeout(() => process.stdout.write('buffered'), 50); setTimeout(() => process.exit(0), 150);`));
      const seen: string[] = [];
      const attachment = await host.attach('a', (chunk) => seen.push(Buffer.from(chunk).toString()));
      await until(() => events.some((event) => event.kind === 'exit'), 'exit');
      host.forget?.('a');
      attachment.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual([]);
      expect(() => attachment.detach()).not.toThrow();
    });

    it('survives an attach that is still waiting for its snapshot', async () => {
      const host = makeHost();
      const events = collect(host);
      await finishedWith(host, events, 'a', 'text');
      const pending = host.attach('a', () => {});
      host.forget?.('a');
      const attachment = await pending;
      expect(() => {
        attachment.start();
        attachment.detach();
      }).not.toThrow();
    });
  });

  describe('spawn', () => {
    it('throws a readable error for a missing command, a file that is not executable, and a second spawn of a live name', async () => {
      const host = makeHost();
      expect(() => host.spawn('a', 1, { ...nodeSpec(''), file: join(tmp, 'no-such-command') })).toThrow(/^could not start .*no-such-command: command not found/);
      expect(() => host.spawn('a', 1, { ...nodeSpec(''), file: 'definitely-not-a-command-xyz' })).toThrow(/command not found or not executable/);
      writeFileSync(join(tmp, 'plain.txt'), 'x');
      expect(() => host.spawn('a', 1, { ...nodeSpec(''), file: join(tmp, 'plain.txt') })).toThrow(/could not start/);
      expect(host.info('a')).toBeNull();
      host.spawn('a', 1, nodeSpec('setInterval(() => {}, 1000)'));
      expect(() => host.spawn('a', 2, nodeSpec('setInterval(() => {}, 1000)'))).toThrow('agent a is already running');
      expect(host.info('a')).toMatchObject({ running: true, generation: 1 });
    });

    it('finds a bare command name on the PATH of the child environment', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, { file: basename(process.execPath), args: ['-e', 'process.exit(0)'], env: { PATH: join(process.execPath, '..') }, cwd: tmp });
      await until(() => events.some((event) => event.kind === 'exit'), 'exit');
      expect(exitOf(events).info.code).toBe(0);
    });

    it('replaces a finished record: output bytes, title and screen start again', async () => {
      const host = makeHost();
      const events = collect(host);
      host.spawn('a', 1, nodeSpec(`process.stdout.write(${JSON.stringify(`${ESC}]0;✳ one${BEL}first run\r\n`)}); setTimeout(() => process.exit(2), 100)`));
      await until(() => events.some((event) => event.kind === 'exit'), 'exit');
      expect(host.outputBytes('a')).toBeGreaterThan(0);
      host.spawn('a', 2, nodeSpec('setInterval(() => {}, 1000)'));
      expect(host.outputBytes('a')).toBe(0);
      expect(host.title('a')).toBeNull();
      expect(host.info('a')).toMatchObject({ running: true, generation: 2 });
      expect(await textOf(host, 'a')).not.toContain('first run');
    });

    it('screen() is null while a written chunk is still unparsed, and the analysis once it is parsed', async () => {
      const host = makeHost();
      const seen: Array<ReturnType<TerminalHost['screen']>> = [];
      host.spawn('a', 1, nodeSpec(printing(PASTE_MODE_ON + BOX)));
      const attachment = await host.attach('a', () => seen.push(host.screen('a')));
      attachment.start();
      expect(host.screen('nobody')).toBeNull();
      await until(() => host.screen('a')?.promptBox === true, 'the parsed box');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((probe) => probe === null)).toBe(true); // the listener runs right after mirror.write, before it is parsed
      expect(host.screen('a')).toEqual({ cols: 120, rows: 40, promptBox: true, dialog: null, promptText: '', modal: false, signedOut: false, authRejected: false });
    });

    it('survives a handler that throws: the others still run, the host keeps working, an unsubscribed handler is silent', async () => {
      const { log, lines } = collectingLogger();
      const host = makeHost({ log });
      const second: string[] = [];
      host.onEvent(() => {
        throw new Error('handler bug');
      });
      const unsubscribe = host.onEvent((event) => second.push(`late:${event.kind}`));
      host.onEvent((event) => second.push(event.kind));
      unsubscribe();
      host.spawn('a', 1, nodeSpec('process.exit(0)'));
      await until(() => second.includes('exit'), 'exit');
      expect(second).toEqual(['exit']);
      expect(lines.some((line) => line.includes(' error ') && line.includes('event handler') && line.includes('handler bug'))).toBe(true);
    });
  });
});

/* ---- a fake pty: the cases a real child cannot hit on cue ---- */

describe('terminal host with a fake pty', () => {
  interface FakeState {
    writes: Array<string | Uint8Array>;
    resizes: Array<[number, number]>;
    destroyed: number;
    throwOnWrite: boolean;
    throwOnResize: boolean;
  }
  type DataListener = (data: Uint8Array | string) => void;
  type ExitListener = (event: { exitCode: number; signal?: number }) => void;

  function makeFakePty(pid = 987654): { pty: object; state: FakeState; data: (input: string | Uint8Array) => void; exit: (exitCode: number, signal?: number) => void } {
    const dataListeners: DataListener[] = [];
    const exitListeners: ExitListener[] = [];
    const state: FakeState = { writes: [], resizes: [], destroyed: 0, throwOnWrite: false, throwOnResize: false };
    const pty = {
      pid,
      onData: (listener: DataListener) => {
        dataListeners.push(listener);
        return { dispose: () => {} };
      },
      onExit: (listener: ExitListener) => {
        exitListeners.push(listener);
        return { dispose: () => {} };
      },
      write: (data: string | Uint8Array) => {
        if (state.throwOnWrite) throw new Error('write EIO');
        state.writes.push(data);
      },
      resize: (cols: number, rows: number) => {
        if (state.throwOnResize) throw new Error('ioctl(2) failed, EBADF');
        state.resizes.push([cols, rows]);
      },
      destroy: () => {
        state.destroyed += 1;
      },
    };
    return {
      pty,
      state,
      data: (input) => dataListeners.forEach((listener) => listener(typeof input === 'string' ? Buffer.from(input) : input)),
      exit: (exitCode, signal) => exitListeners.forEach((listener) => listener(signal === undefined ? { exitCode } : { exitCode, signal })),
    };
  }

  type Fake = ReturnType<typeof makeFakePty>;
  const kills: Array<[number, string | number | undefined]> = [];
  const created: Fake[] = [];
  const clock = { t: 1000 };

  async function load(options: Parameters<typeof createTerminalHost>[0] = {}): Promise<{
    host: TerminalHost;
    spawnCalls: unknown[][];
    failNextSpawnWith: (error: Error) => void;
    spawn: (name: string, generation: number, extra?: Partial<SpawnSpec>) => Fake;
    nextPid: (pid: number) => void;
  }> {
    vi.resetModules();
    const spawnCalls: unknown[][] = [];
    const next: { fake: Fake; error: Error | null; pid: number } = { fake: makeFakePty(), error: null, pid: 987654 };
    vi.doMock('@lydell/node-pty', () => ({
      spawn: (...args: unknown[]) => {
        spawnCalls.push(args);
        if (next.error) throw next.error;
        return next.fake.pty;
      },
    }));
    const fresh = await import('../src/server/terminal.js');
    const host = fresh.createTerminalHost({ now: () => clock.t, killAfterMs: 25, giveUpAfterKillMs: 25, ...options });
    return {
      host,
      spawnCalls,
      failNextSpawnWith: (error) => {
        next.error = error;
      },
      nextPid: (pid) => {
        next.pid = pid;
      },
      spawn: (name, generation, extra = {}) => {
        const fake = makeFakePty(next.pid);
        next.fake = fake;
        created.push(fake);
        host.spawn(name, generation, nodeSpec('', {}, extra));
        return fake;
      },
    };
  }

  beforeEach(() => {
    kills.length = 0;
    created.length = 0;
    clock.t = 1000;
    // The fake pid must never reach a real process group.
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      kills.push([pid, signal]);
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers(); // a test that failed inside useFakeTimers must not leave the next ones without a clock
    for (const fake of created) fake.exit(0);
    vi.doUnmock('@lydell/node-pty');
    vi.resetModules();
  });

  const parsed = async (host: TerminalHost, name: string): Promise<void> => {
    await until(() => host.screen(name) !== null, 'the mirror to parse');
  };

  it('starts the pty exactly as the contract says: TERM, size, cwd, the whole env, bytes not strings', async () => {
    const { host, spawnCalls, spawn } = await load();
    spawn('a', 1, { cols: 100, rows: 30, cwd: '/' });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual([process.execPath, ['-e', ''], { name: 'xterm-256color', cols: 100, rows: 30, cwd: '/', env: { PATH: process.env.PATH ?? '' }, encoding: null }]);
    expect(host.info('a')).toEqual({ running: true, generation: 1, pid: 987654, cols: 100, rows: 30 });
  });

  it('turns a failed pty spawn into a readable error, hints at the helper for posix_spawnp, and keeps the old record', async () => {
    const { host, failNextSpawnWith, spawn } = await load();
    const first = spawn('a', 1);
    first.data('last screen of run one');
    first.exit(0);
    await until(() => host.info('a')?.running === false, 'run one to finish');
    failNextSpawnWith(new Error('posix_spawnp failed.'));
    expect(() => host.spawn('a', 2, nodeSpec(''))).toThrow(
      `could not start ${process.execPath}: posix_spawnp failed. (command not found, or the pty helper is not executable)`,
    );
    failNextSpawnWith(new Error('something else'));
    expect(() => host.spawn('a', 2, nodeSpec(''))).toThrow(`could not start ${process.execPath}: something else`);
    expect(host.info('a')).toMatchObject({ generation: 1, running: false });
    expect(await textOf(host, 'a')).toContain('last screen of run one');
  });

  it('maps exit codes and signals, measures the duration with now() and says whether stop was requested', async () => {
    const { host, spawn } = await load();
    const events = collect(host);
    clock.t = 1000;
    const fake = spawn('a', 4);
    clock.t = 1750;
    fake.exit(0, 15);
    await until(() => events.some((event) => event.kind === 'exit'), 'exit');
    expect(exitOf(events)).toMatchObject({ name: 'a', generation: 4, at: 1750, info: { code: null, signal: 15, durationMs: 750, requested: false, tail: '' } });
    const second = spawn('b', 1);
    second.exit(143);
    await until(() => events.filter((event) => event.kind === 'exit').length === 2, 'second exit');
    expect(events.filter((event) => event.kind === 'exit')[1]).toMatchObject({ info: { code: 143, signal: null } });
  });

  it('title: since is the time the glyph class last changed, from now()', async () => {
    const { host, spawn } = await load();
    const events = collect(host);
    const fake = spawn('a', 1);
    const send = async (title: string, at: number): Promise<void> => {
      clock.t = at;
      fake.data(`${ESC}]0;${title}${BEL}`);
      await parsed(host, 'a');
    };
    expect(host.title('a')).toBeNull();
    await send('✳ Claude Code', 1100);
    await send('✳ renamed by the model', 1200);
    expect(host.title('a')).toEqual({ glyph: 'idle', title: '✳ renamed by the model', since: 1100, textSince: 1200 });
    await send('◐ working', 1300);
    await send('◑ working', 1400);
    expect(host.title('a')).toEqual({ glyph: 'working', title: '◑ working', since: 1300, textSince: 1400 });
    await send('◑ working', 1450); // the same text again: not a change
    expect(host.title('a')?.textSince).toBe(1400);
    await send('', 1500);
    expect(host.title('a')).toEqual({ glyph: 'unknown', title: '', since: 1500, textSince: 1500 });
    expect(events.map((event) => (event.kind === 'title' ? [event.glyph, event.at] : event.kind))).toEqual([
      ['idle', 1100],
      ['working', 1300],
      ['unknown', 1500],
    ]);
  });

  it('exit handling starts with exited: every method returns false at once, nothing reaches the pty and no signal is sent', async () => {
    const { host, spawn } = await load();
    const events = collect(host);
    const fake = spawn('a', 1);
    fake.data(PASTE_MODE_ON + BOX);
    await parsed(host, 'a');
    expect(host.submit('a', 1, POINTER)).toBe(true);
    expect(fake.state.writes).toHaveLength(1);
    fake.exit(1);
    // Same tick as the exit callback, before the exit event (the mirror still has to flush).
    expect([host.resize('a', 90, 30), host.write('a', 'x'), host.submit('a', 1, POINTER)]).toEqual([false, false, false]);
    expect(host.info('a')).toMatchObject({ running: true, pid: 987654 }); // the record runs until the exit event went out
    expect(() => host.spawn('a', 2, nodeSpec(''))).toThrow('agent a is already running');
    expect(host.rename('a', 'b')).toBe(false);
    const stopping = host.stop('a');
    expect(events.some((event) => event.kind === 'exit')).toBe(false);
    await stopping;
    expect(events.some((event) => event.kind === 'exit')).toBe(true);
    expect(host.info('a')).toMatchObject({ running: false, pid: null });
    expect(fake.state.writes).toHaveLength(1);
    expect(fake.state.resizes).toEqual([]);
    expect(kills).toEqual([]);
    expect(exitOf(events).info.requested).toBe(false);
  });

  it('a pty that throws on resize or write makes the method return false and leaves the mirror alone', async () => {
    const { host, spawn } = await load();
    const fake = spawn('a', 1, { cols: 100, rows: 30 });
    fake.data(PASTE_MODE_ON + BOX);
    await parsed(host, 'a');
    fake.state.throwOnResize = true;
    expect(host.resize('a', 80, 24)).toBe(false);
    expect(host.info('a')).toMatchObject({ cols: 100, rows: 30 });
    fake.state.throwOnResize = false;
    expect(host.resize('a', 100, 30)).toBe(true);
    expect(fake.state.resizes).toEqual([]); // the same size never reaches the pty
    expect(host.resize('a', 80, 24)).toBe(true);
    expect(fake.state.resizes).toEqual([[80, 24]]);
    fake.state.throwOnWrite = true;
    expect(host.write('a', 'x')).toBe(false);
    expect(host.submit('a', 1, POINTER)).toBe(false);
  });

  it('stop: SIGTERM to the group, SIGKILL to the group after killAfterMs, nothing more once it exited', async () => {
    const { host, spawn } = await load({ killAfterMs: 40, giveUpAfterKillMs: 5000 });
    const events = collect(host);
    const fake = spawn('a', 1);
    const stopping = host.stop('a');
    expect(host.stop('a')).toBe(stopping);
    expect(kills).toEqual([[-987654, 'SIGTERM']]);
    await until(() => kills.length === 2, 'SIGKILL');
    expect(kills[1]).toEqual([-987654, 'SIGKILL']);
    fake.exit(0, 9);
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(kills).toHaveLength(2);
    expect(exitOf(events).info).toMatchObject({ code: null, signal: 9, requested: true });
  });

  it('stop: no SIGKILL when the child exits in time', async () => {
    const { host, spawn } = await load({ killAfterMs: 60 });
    const fake = spawn('a', 1);
    const stopping = host.stop('a');
    fake.exit(143);
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(kills).toEqual([[-987654, 'SIGTERM']]);
  });

  it('stop: falls back to the pid when the group is gone (ESRCH), and only then', async () => {
    const { host, spawn } = await load();
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      kills.push([pid, signal]);
      if (pid < 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      return true;
    });
    const fake = spawn('a', 1);
    const stopping = host.stop('a');
    expect(kills).toEqual([[-987654, 'SIGTERM'], [987654, 'SIGTERM']]);
    fake.exit(0);
    await stopping;
  });

  it('stop: another kill error is logged and does not fall back or throw', async () => {
    const { log, lines } = collectingLogger();
    const { host, spawn } = await load({ log });
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      kills.push([pid, signal]);
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    const fake = spawn('a', 1);
    const stopping = host.stop('a');
    expect(kills).toEqual([[-987654, 'SIGTERM']]);
    expect(lines.some((line) => line.includes(' warn ') && line.includes('EPERM'))).toBe(true);
    fake.exit(0);
    await stopping;
  });

  it('stop: gives up after SIGKILL, reports the process gone with signal 9, destroys the pty and ignores a late real exit', async () => {
    const { host, spawn } = await load({ killAfterMs: 20, giveUpAfterKillMs: 20 });
    const events = collect(host);
    const fake = spawn('a', 1);
    clock.t = 1000;
    const stopping = host.stop('a');
    clock.t = 1200;
    await stopping;
    expect(kills).toEqual([[-987654, 'SIGTERM'], [-987654, 'SIGKILL']]);
    expect(fake.state.destroyed).toBe(1);
    expect(exitOf(events)).toMatchObject({ info: { code: null, signal: 9, requested: true, durationMs: 200 } });
    fake.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.filter((event) => event.kind === 'exit')).toHaveLength(1);
    expect(host.info('a')?.running).toBe(false);
  });

  it('stop never signals a pid that cannot be a process (0, 1, negative)', async () => {
    const { host, nextPid, spawn } = await load();
    for (const [index, pid] of [0, 1, -5].entries()) {
      nextPid(pid);
      const fake = spawn(`n${index}`, 1);
      const stopping = host.stop(`n${index}`);
      fake.exit(0);
      await stopping;
    }
    expect(kills).toEqual([]);
  });

  it('exit event: the tail is the last 20 non-empty rows, cut to the last 2000 characters; the viewport only', async () => {
    const { host, spawn } = await load();
    const events = collect(host);
    const fake = spawn('a', 1, { cols: 120, rows: 40 });
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`);
    fake.data(lines.join('\r\n\r\n') + '\r\n');
    fake.exit(1);
    await until(() => events.some((event) => event.kind === 'exit'), 'exit');
    expect(exitOf(events).info.tail).toBe(lines.slice(-20).join('\n'));
  });

  it('ready: needs the paste mode and the box and no dialog, and fires once per generation', async () => {
    const { host, spawn } = await load();
    const events = collect(host);
    const fake = spawn('a', 1);
    fake.data(BOX);
    await parsed(host, 'a');
    fake.data(PASTE_MODE_ON);
    await until(() => host.screen('a') !== null && events.some((event) => event.kind === 'ready'), 'ready');
    expect(events).toEqual([{ kind: 'ready', name: 'a', generation: 1, at: 1000 }]);
    fake.data(`${BOX}${BOX}`);
    await parsed(host, 'a');
    fake.data(`${ESC}[?2004l${ESC}[?2004h`);
    await parsed(host, 'a');
    expect(events.filter((event) => event.kind === 'ready')).toHaveLength(1);
    fake.exit(0);
    await until(() => events.some((event) => event.kind === 'exit'), 'exit');
    expect(events.map((event) => event.kind)).toEqual(['ready', 'exit']);
  });

  it('ready waits for the chunk that completes the picture, not for the pty to go quiet', async () => {
    const { host, spawn } = await load();
    const events = collect(host);
    const fake = spawn('a', 1);
    fake.data(`${PASTE_MODE_ON}Quick safety check: Is this a project you created or one you trust?\r\n`);
    fake.data(BOX);
    await parsed(host, 'a');
    expect(events).toEqual([]);
    fake.data(`${ESC}[2J${ESC}[H${BOX}`); // the dialog is gone, the box is back
    await until(() => events.some((event) => event.kind === 'ready'), 'ready after the dialog');
  });

  it('attach: the snapshot holds what came before it, start() delivers what came after, once and in order', async () => {
    const { host, spawn } = await load();
    const fake = spawn('a', 1);
    fake.data('one\r\ntwo\r\n');
    const parts: string[] = [];
    const attaching = host.attach('a', (chunk) => parts.push(Buffer.from(chunk).toString()));
    fake.data('three\r\n'); // arrives while the marker is queued
    fake.data('four\r\n');
    const attachment = await attaching;
    fake.data('five\r\n'); // arrives between the snapshot and start()
    expect(attachment.snapshot.data).toContain('two');
    expect(attachment.snapshot.data).not.toContain('three');
    expect(parts).toEqual([]);
    attachment.start();
    attachment.start();
    fake.data('six\r\n'); // direct delivery from here on
    expect(parts).toEqual(['three\r\n', 'four\r\n', 'five\r\n', 'six\r\n']);
    attachment.detach();
    fake.data('seven\r\n');
    expect(parts).toHaveLength(4);
  });

  it('attach: a listener that throws does not break the other listeners or the host; a detached one never gets a late start', async () => {
    const { log, lines } = collectingLogger();
    const { host, spawn } = await load({ log });
    const fake = spawn('a', 1);
    const good: string[] = [];
    const bad = await host.attach('a', () => {
      throw new Error('listener bug');
    });
    const fine = await host.attach('a', (chunk) => good.push(Buffer.from(chunk).toString()));
    const detached = await host.attach('a', () => good.push('detached got data'));
    bad.start();
    fine.start();
    detached.detach();
    detached.start();
    fake.data('x');
    await parsed(host, 'a');
    expect(good).toEqual(['x']);
    expect(lines.some((line) => line.includes(' error ') && line.includes('output listener'))).toBe(true);
  });

  it('attach puts the modes that serialize() lacks after the snapshot: 1006, 2031 and 25, last value wins', async () => {
    const { host, spawn } = await load();
    const fake = spawn('a', 1);
    expect((await host.attach('a', () => {})).snapshot.data).not.toMatch(/\?(1006|2031|25)[hl]/);
    fake.data(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?2031h${ESC}[?25l`);
    fake.data(`${ESC}[?25`);
    fake.data('h');
    fake.data(`${ESC}[?25l`);
    const data = (await host.attach('a', () => {})).snapshot.data;
    expect(data.endsWith(`${ESC}[?1006h${ESC}[?2031h${ESC}[?25l`)).toBe(true);
    fake.data(`${ESC}[?1006l`);
    expect((await host.attach('a', () => {})).snapshot.data.endsWith(`${ESC}[?1006l${ESC}[?2031h${ESC}[?25l`)).toBe(true);
  });

  it('a new spawn starts a new tracker: modes of the previous run are not carried over', async () => {
    const { host, spawn } = await load();
    const first = spawn('a', 1);
    first.data(`${ESC}[?1006h${ESC}[?25l`);
    first.exit(0);
    await until(() => host.info('a')?.running === false, 'run one to finish');
    spawn('a', 2);
    expect((await host.attach('a', () => {})).snapshot.data).not.toMatch(/\?(1006|2031|25)[hl]/);
  });

  it('uses STOP_KILL_AFTER_MS and STOP_GIVEUP_AFTER_KILL_MS when the options leave them out', async () => {
    const { host, spawn } = await load({ killAfterMs: undefined, giveUpAfterKillMs: undefined });
    const events = collect(host);
    const fake = spawn('a', 1);
    vi.useFakeTimers();
    try {
      const stopping = host.stop('a');
      await vi.advanceTimersByTimeAsync(STOP_KILL_AFTER_MS - 1);
      expect(kills).toEqual([[-987654, 'SIGTERM']]);
      await vi.advanceTimersByTimeAsync(1);
      expect(kills).toEqual([[-987654, 'SIGTERM'], [-987654, 'SIGKILL']]);
      await vi.advanceTimersByTimeAsync(STOP_GIVEUP_AFTER_KILL_MS - 1);
      expect(fake.state.destroyed).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(50); // the mirror flushes on a timer of its own before the exit event goes out
      await stopping;
      expect(fake.state.destroyed).toBe(1);
      expect(exitOf(events).info).toMatchObject({ code: null, signal: 9, requested: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== 'darwin')('looks at the spawn helper once, before the first spawn of the process', async () => {
    const { log, lines } = collectingLogger();
    const { host, spawn } = await load({ log });
    const found = (): number => lines.filter((line) => line.includes('spawn-helper is executable')).length;
    expect(found()).toBe(0);
    const first = spawn('a', 1);
    expect(found()).toBe(1);
    first.exit(0);
    await until(() => host.info('a')?.running === false, 'run one to finish');
    spawn('a', 2);
    expect(found()).toBe(1);
  });

  it('runs event handlers in the order they subscribed', async () => {
    const { host, spawn } = await load();
    const order: string[] = [];
    host.onEvent((event) => order.push(`first:${event.kind}`));
    host.onEvent((event) => order.push(`second:${event.kind}`));
    const fake = spawn('a', 1);
    fake.data(`${ESC}]0;✳ x${BEL}`);
    await parsed(host, 'a');
    fake.exit(0);
    await until(() => order.includes('second:exit'), 'exit');
    expect(order).toEqual(['first:title', 'second:title', 'first:exit', 'second:exit']);
  });

  it('survives a flood: xterm refuses writes beyond its watermark, the host logs that once and keeps its books straight', async () => {
    const { log, lines } = collectingLogger();
    const { host, spawn } = await load({ log });
    const fake = spawn('a', 1);
    const seen: number[] = [];
    const attachment = await host.attach('a', (chunk) => seen.push(chunk.length));
    attachment.start();
    const chunk = '\u0000'.repeat(5_000_000);
    expect(() => {
      for (let i = 0; i < 14; i++) fake.data(chunk);
    }).not.toThrow();
    expect(lines.filter((line) => line.includes('rejected output'))).toHaveLength(1);
    expect(seen).toHaveLength(14); // browsers still get every byte the pty produced
    expect(host.outputBytes('a')).toBe(14 * 5_000_000);
    await until(() => host.screen('a') !== null, 'the backlog to drain', 60_000);
    fake.data('after the flood');
    await until(async () => (await textOf(host, 'a')).includes('after the flood'), 'output after the flood');
  }, 90_000);

  it('random bytes, escape fragments and half sequences neither throw nor wedge the host, and nothing reaches the console (seeded)', async () => {
    const printed = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const { host, spawn } = await load();
    const fake = spawn('a', 1);
    const next = seeded(7);
    const alphabet = [ESC, ESC, ESC, '[', ']', '?', ';', '0', '1', '2', '4', '5', '6', '9', 'h', 'l', 'm', 'H', 'J', 'K', BEL, '\r', '\n', '\u2500', '\u276f', '\u00a0', ' ', 'a', '\u200b', '\u0000'];
    const parts: number[] = [];
    const attachment = await host.attach('a', (chunk) => parts.push(chunk.length));
    attachment.start();
    expect(() => {
      for (let i = 0; i < 400; i++) {
        const bytes: number[] = [];
        for (let k = Math.floor(next() * 300); k > 0; k--) {
          bytes.push(next() < 0.7 ? Buffer.from(alphabet[Math.floor(next() * alphabet.length)] ?? 'a')[0] ?? 97 : Math.floor(next() * 256));
        }
        fake.data(Uint8Array.from(bytes)); // raw bytes, invalid UTF-8 included
        if (i % 50 === 0) host.resize('a', 20 + Math.floor(next() * 200), 5 + Math.floor(next() * 80));
        host.screen('a');
        host.submit('a', 1, POINTER);
        host.write('a', 'x');
      }
    }).not.toThrow();
    await until(() => host.screen('a') !== null, 'the mirror to parse');
    expect(parts).toHaveLength(400);
    const joined = await host.attach('a', () => {});
    expect(joined.snapshot).toMatchObject({ generation: 1, running: true });
    expect(host.info('a')?.running).toBe(true);
    expect(host.screen('a')).toMatchObject({ promptBox: expect.any(Boolean) });
    expect(printed.flatMap((spy) => spy.mock.calls)).toEqual([]); // xterm's parser errors go nowhere (logLevel off)
  });

  it('ignores bytes that arrive after the exit event, and a second exit', async () => {
    const { host, spawn } = await load();
    const events = collect(host);
    const fake = spawn('a', 1);
    fake.data('before');
    fake.exit(0);
    await until(() => events.some((event) => event.kind === 'exit'), 'exit');
    const bytes = host.outputBytes('a');
    expect(() => {
      fake.data('late bytes');
      fake.exit(1);
    }).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.outputBytes('a')).toBe(bytes);
    expect(await textOf(host, 'a')).not.toContain('late');
    expect(events.filter((event) => event.kind === 'exit')).toHaveLength(1);
  });

  it('a handler of node-pty that throws inside the host is contained', async () => {
    const { log, lines } = collectingLogger();
    const { host, spawn } = await load({ log });
    const events = collect(host);
    host.onEvent(() => {
      throw new Error('boom');
    });
    const fake = spawn('a', 1);
    expect(() => fake.data(`${ESC}]0;✳ x${BEL}`)).not.toThrow();
    await parsed(host, 'a');
    expect(() => fake.exit(0)).not.toThrow();
    await until(() => events.some((event) => event.kind === 'exit'), 'exit');
    expect(lines.filter((line) => line.includes('event handler')).length).toBeGreaterThanOrEqual(2);
  });
});

/* ---- the recorded runs, replayed through a real pty (contract 0.5 items 10 and 11) ---- */

describe('replay of the recorded runs through spawn()', () => {
  const REPLAY_CHILD = `
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const chunks = fs.readFileSync(process.env.REPLAY_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.k === 'd').map((o) => Buffer.from(o.b, 'base64'));
    const plan = JSON.parse(process.env.REPLAY_PLAN);
    execFileSync('stty', ['-opost'], { stdio: 'inherit' }); // no CR insertion: the host must see the recorded bytes exactly
    fs.writeFileSync(process.env.REPLAY_DIR + '/ready', '1');
    let step = 0;
    const write = (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        try { off += fs.writeSync(1, chunk, off); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
      }
    };
    const tick = () => {
      if (!fs.existsSync(process.env.REPLAY_DIR + '/go-' + step)) { setTimeout(tick, 3); return; }
      for (let i = plan[step][0]; i < plan[step][1]; i++) write(chunks[i]);
      step += 1;
      if (step >= plan.length) { setTimeout(() => process.exit(0), 50); return; }
      tick();
    };
    tick();
  `;

  interface XtermCore {
    coreMouseService: { triggerMouseEvent(event: Record<string, number | boolean>): boolean };
    coreService: { isCursorHidden: boolean };
  }
  const coreOf = (term: HeadlessTerminal): XtermCore => (term as unknown as { _core: XtermCore })._core;

  /** What a click at column 40, row 12 would send to claude: the SGR form only when ?1006 is on. */
  function clickReport(term: HeadlessTerminal): string {
    const sent: string[] = [];
    const onData = term.onData((data) => sent.push(data));
    const onBinary = term.onBinary((data) => sent.push(`binary:${data}`));
    coreOf(term).coreMouseService.triggerMouseEvent({ col: 40, row: 12, x: 0, y: 0, button: 0, action: 1, ctrl: false, alt: false, shift: false });
    onData.dispose();
    onBinary.dispose();
    return sent.join('|');
  }

  function cellRows(term: HeadlessTerminal): string[] {
    const buffer = term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      const cells: string[] = [];
      for (let x = 0; line && x < term.cols; x++) {
        const cell = line.getCell(x);
        if (!cell) continue;
        const flags = [cell.isBold(), cell.isItalic(), cell.isDim(), cell.isUnderline(), cell.isBlink(), cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline()].join('');
        cells.push(`${cell.getChars()}/${cell.getWidth()}/${cell.getFgColorMode()}:${cell.getFgColor()}/${cell.getBgColorMode()}:${cell.getBgColor()}/${flags}`);
      }
      rows.push(cells.join(' '));
    }
    return rows;
  }

  const firstDifference = (live: string[], joined: string[]): string | null => {
    for (let y = 0; y < Math.max(live.length, joined.length); y++) {
      if (live[y] !== joined[y]) return `row ${y}: live ${JSON.stringify(live[y]?.slice(0, 200))} but joined ${JSON.stringify(joined[y]?.slice(0, 200))}`;
    }
    return null;
  };

  /** The modes the recording's own parser saw, up to and including the first `chunkCount` output records. */
  function expectedFixup(records: StreamRecord[], chunkCount: number): string {
    const last = new Map<number, boolean>();
    let seen = 0;
    for (const record of records) {
      if (record.k === 'd') {
        if (seen === chunkCount) break;
        seen += 1;
      } else if (record.k === 'ev' && (record.type === 'decset' || record.type === 'decrst') && Array.isArray(record.detail)) {
        for (const mode of record.detail) if (mode === 1006 || mode === 2031 || mode === 25) last.set(mode, record.type === 'decset');
      }
    }
    return [1006, 2031, 25]
      .filter((mode) => last.has(mode))
      .map((mode) => `${ESC}[?${mode}${last.get(mode) ? 'h' : 'l'}`)
      .join('');
  }

  async function replay(file: string): Promise<void> {
    const records = loadStream(file);
    const plan = planOf(records);
    const dataSteps = plan.steps.filter((step): step is DataStep => step.kind === 'data');
    const checkpoints = dataSteps.filter((step) => step.checkpoint).length;
    expect(checkpoints).toBeGreaterThanOrEqual(5);
    const host = makeHost();
    const events = collect(host);
    host.spawn('replay', 1, {
      file: process.execPath,
      args: ['-e', REPLAY_CHILD],
      env: { PATH: process.env.PATH ?? '', REPLAY_FILE: join(fixtureDir, file), REPLAY_PLAN: JSON.stringify(dataSteps.map((step) => [step.from, step.to])), REPLAY_DIR: tmp },
      cwd: tmp,
      cols: plan.cols,
      rows: plan.rows,
    });
    await until(() => existsSync(join(tmp, 'ready')), 'the replay child');
    const reference = new Terminal({ cols: plan.cols, rows: plan.rows, scrollback: MIRROR_SCROLLBACK_LINES, allowProposedApi: true });
    let sent = 0;
    let dataIndex = 0;
    let compared = 0;
    let sawMouseReport = false;
    const dialogsSeen = new Set<string | null>();
    for (const step of plan.steps) {
      if (step.kind === 'resize') {
        expect(host.resize('replay', step.cols, step.rows)).toBe(true);
        reference.resize(step.cols, step.rows);
        continue;
      }
      writeFileSync(join(tmp, `go-${dataIndex}`), '1');
      dataIndex += 1;
      for (let i = step.from; i < step.to; i++) {
        sent += plan.chunks[i]?.length ?? 0;
        await feed(reference, plan.chunks[i] ?? new Uint8Array());
      }
      await until(() => host.outputBytes('replay') >= sent, `${sent} bytes of output`);
      expect(host.outputBytes('replay')).toBe(sent);
      if (!step.checkpoint) continue;
      await until(() => host.screen('replay') !== null, 'the mirror to parse');
      const attachment = await host.attach('replay', () => {});
      attachment.detach();
      const { snapshot } = attachment;
      expect([snapshot.cols, snapshot.rows, snapshot.generation, snapshot.running]).toEqual([reference.cols, reference.rows, 1, true]);
      const joined = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: MIRROR_SCROLLBACK_LINES, allowProposedApi: true });
      await feed(joined, snapshot.data);
      const label = `checkpoint ${compared} after ${step.to} output records`;
      expect(joined.buffer.active.type, `${label}: buffer`).toBe(reference.buffer.active.type);
      expect([joined.buffer.active.cursorX, joined.buffer.active.cursorY], `${label}: cursor`).toEqual([reference.buffer.active.cursorX, reference.buffer.active.cursorY]);
      expect(joined.modes, `${label}: modes`).toEqual(reference.modes);
      expect(coreOf(joined).coreService.isCursorHidden, `${label}: cursor visibility`).toBe(coreOf(reference).coreService.isCursorHidden);
      expect(firstDifference(cellRows(reference), cellRows(joined)), `${label}: cells`).toBeNull();
      const live = clickReport(reference);
      expect(clickReport(joined), `${label}: mouse report`).toBe(live);
      if (live === `${ESC}[<0;41;13M`) sawMouseReport = true;
      expect(snapshot.data.endsWith(expectedFixup(records, step.to)), `${label}: fix-ups`).toBe(true);
      expect(host.screen('replay'), `${label}: probe`).toEqual(analyzeScreen(viewportRows(reference), reference.cols));
      dialogsSeen.add(host.screen('replay')?.dialog ?? null);
      compared += 1;
    }
    expect(compared).toBe(checkpoints);
    // The fullscreen run holds a real permission dialog; the classic run never shows one.
    expect(dialogsSeen.has('permission')).toBe(file.includes('-fs'));
    await until(() => events.some((event) => event.kind === 'exit'), 'the replay child to exit');
    expect(exitOf(events).info).toMatchObject({ code: 0, signal: null, requested: false });
    expect(exitOf(events).info.tail).toContain('Resume this session with:'); // what claude prints on the normal screen as it ends
    expect(events.filter((event) => event.kind === 'ready')).toHaveLength(1);
    const recordedTitles = records
      .filter((record) => record.k === 'ev' && record.type === 'osc0')
      .map((record) => classifyTitle(String(record.detail)))
      .filter((glyph, index, all) => index === 0 || glyph !== all[index - 1]);
    expect(events.filter((event) => event.kind === 'title').map((event) => (event.kind === 'title' ? event.glyph : ''))).toEqual(recordedTitles);
    if (file.includes('-fs')) expect(sawMouseReport).toBe(true); // otherwise the SGR check proved nothing
  }

  it('fullscreen run: a joining browser gets the screen, the modes and the SGR mouse encoding of the live terminal at every quiet point', async () => {
    await replay('real-fs.stream.jsonl');
  }, 60_000);

  it('classic run: the same, in the normal buffer with scrollback', async () => {
    await replay('real-classic.stream.jsonl');
  }, 60_000);

  it('without the ?1006 fix-up the late joiner would report the click in the wrong encoding (the check can fail)', async () => {
    const live = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    await feed(live, `${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?25l`);
    const addon = new SerializeAddon();
    live.loadAddon(addon);
    const serialized = addon.serialize({ scrollback: 1000 });
    const withoutFixup = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    await feed(withoutFixup, serialized);
    const tracker = new ModeTracker();
    tracker.feed(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[?25l`);
    const withFixup = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    await feed(withFixup, serialized + tracker.fixup());
    expect(clickReport(live)).toBe(`${ESC}[<0;41;13M`);
    expect(clickReport(withoutFixup)).not.toBe(clickReport(live));
    expect(clickReport(withFixup)).toBe(clickReport(live));
    expect(coreOf(withoutFixup).coreService.isCursorHidden).toBe(false);
    expect(coreOf(withFixup).coreService.isCursorHidden).toBe(true);
  });
});

/* ---- the fixtures are public: nothing of the machine they were recorded on may be in them (contract 0.5 item 11) ---- */

describe('fixtures hold nothing private', () => {
  const files = ['real-fs.stream.jsonl', 'real-classic.stream.jsonl'];

  /** Everything a record can carry, decoded: output and input bytes both as UTF-8 and as Latin-1, plus the JSON of the rest. */
  function decodedText(file: string): string[] {
    return loadStream(file).flatMap((record) => {
      if (record.k === 'd' || record.k === 'in') {
        const bytes = Buffer.from(record.b ?? '', 'base64');
        return [bytes.toString('utf8'), bytes.toString('latin1')];
      }
      return [JSON.stringify(record)];
    });
  }

  it.each(files)('%s has no home path, volume path, e-mail address, account id or ARN', (file) => {
    const all = decodedText(file).join('\n');
    expect(all).not.toMatch(/\/Users\//);
    expect(all).not.toMatch(/\/Volumes\//);
    expect(all).not.toMatch(/\/home\//);
    expect(all).not.toMatch(/@/);
    expect(all).not.toMatch(/[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/);
    expect(all).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
    expect(all).not.toMatch(/arn:aws/);
  });

  it.each(files)('%s has no start arguments or directory, and none of the recording machine\'s names', (file) => {
    const start = loadStream(file).find((record) => record.k === 'start');
    expect(start?.args).toEqual([]);
    expect(start?.cwd).toBe('');
    const all = decodedText(file).join('\n').toLowerCase();
    // Generic account names are ordinary words that the recorded screens may hold ("User rejected write").
    const generic = new Set(['user', 'root', 'node', 'test', 'runner', 'admin', 'ubuntu', 'debian', 'docker', 'build', 'localhost']);
    const login = ((): string => {
      try {
        return userInfo().username;
      } catch {
        return ''; // an arbitrary uid in a container has no passwd entry
      }
    })();
    const names = [login, hostname(), hostname().split('.')[0] ?? ''].filter((name) => name.length >= 4 && !generic.has(name.toLowerCase()));
    for (const name of names) expect(all.includes(name.toLowerCase()), 'a name of the machine running this test').toBe(false);
  });
});
