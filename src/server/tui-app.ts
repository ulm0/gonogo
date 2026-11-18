/**
 * gonogo tui (docs/tui-spec.md): the loop. Raw mode and the alternate screen on a terminal, the room drawn from the frames of a
 * running server, keys turned into actions, and a console attached by passing bytes through. The screen is restored on every way
 * out: a normal quit, a signal, an error. It stores nothing on disk and holds no state the server does not have.
 */
import { createTuiClient } from './tui-client.js';
import type { TuiClient } from './tui-client.js';
import { CONSOLE_HELP, consoleInput, initialConsoleInput } from './tui-console.js';
import type { ConsoleInput } from './tui-console.js';
import { initialUi, parseKeys, step } from './tui-keys.js';
import type { Action, Ui } from './tui-keys.js';
import { render } from './tui-render.js';
import { applyFrame, initialState } from './tui-state.js';
import type { TuiState } from './tui-state.js';
import type { ServerFrame } from '../shared/protocol.js';

/** What the app needs of a terminal: a real one, or a fake in a test. */
export interface TuiInput {
  setRawMode?(raw: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
}
export interface TuiOutput {
  write(data: string | Uint8Array): unknown;
  columns?: number;
  rows?: number;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

export interface TuiOptions {
  url: string;
  token: string;
  stdin: TuiInput;
  stdout: TuiOutput;
  /** NO_COLOR and the like: only `NO_COLOR` is read. */
  env?: Record<string, string | undefined>;
  /** Redraw at most this often. Default 50 ms (20 a second). */
  frameMs?: number;
  /** For tests: the client that talks to the server. */
  client?: (options: Parameters<typeof createTuiClient>[0]) => TuiClient;
}

export const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l';
/** Modes a console may switch on (bracketed paste, mouse, focus reports, application keys): off again when the terminal is given back. */
export const RESET_MODES = '\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?1l\x1b>';
export const LEAVE_SCREEN = `\x1b[0m${RESET_MODES}\x1b[?25h\x1b[?1049l`;
const CLEAR = '\x1b[2J\x1b[H';

/** Runs the terminal client until the Director quits; answers the exit code. */
export async function runTui(options: TuiOptions): Promise<number> {
  const { stdin, stdout } = options;
  const color = (options.env?.NO_COLOR ?? '') === '';
  let state: TuiState = initialState();
  let ui: Ui = initialUi();
  let mode: { kind: 'screen' } | { kind: 'console'; agent: string; input: ConsoleInput } = { kind: 'screen' };
  let last: string[] = [];
  let dirty = true;
  let entered = false;
  let finished = false;
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => (finish = resolve));

  const size = (): { cols: number; rows: number } => ({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });

  const client = (options.client ?? createTuiClient)({
    url: options.url,
    token: options.token,
    onFrame: (frame: ServerFrame) => {
      if (frame.t === 'snapshot') {
        if (mode.kind === 'console' && frame.seq === client.seq) stdout.write(`\x1b[0m\x1b[2J\x1b[H${frame.data}`);
        return;
      }
      state = applyFrame(state, frame);
      if (mode.kind === 'console' && frame.t === 'agent-removed' && frame.name === mode.agent) leaveConsole(`${frame.name} was removed.`);
      dirty = true;
    },
    onOutput: (bytes) => {
      if (mode.kind === 'console') stdout.write(bytes);
    },
    onLink: (link) => {
      state = { ...state, link };
      // the page's rule: a console re-attaches itself after a reconnect
      if (link === 'open' && mode.kind === 'console') {
        const { cols, rows } = size();
        client.attach(mode.agent, cols, rows);
      }
      dirty = true;
    },
  });

  function draw(): void {
    if (!dirty || mode.kind !== 'screen' || finished) return;
    dirty = false;
    const { cols, rows } = size();
    const lines = render(state, ui, { cols, rows }, { color });
    let out = '';
    if (last.length !== lines.length || last[0]?.length === undefined) out += CLEAR;
    lines.forEach((line, i) => {
      if (last[i] !== line || out.startsWith(CLEAR)) out += `\x1b[${i + 1};1H${line}`;
    });
    last = lines;
    if (out !== '') stdout.write(out);
  }

  function enterConsole(agent: string): void {
    const { cols, rows } = size();
    mode = { kind: 'console', agent, input: initialConsoleInput() };
    stdout.write(`${CLEAR}\x1b[?25h`);
    client.attach(agent, cols, rows);
  }

  function leaveConsole(note = ''): void {
    if (mode.kind !== 'console') return;
    client.detach();
    mode = { kind: 'screen' };
    last = [];
    ui = { ...ui, flash: note };
    stdout.write(`\x1b[0m${RESET_MODES}\x1b[?25l${CLEAR}`);
    dirty = true;
  }

  function quit(code = 0): void {
    if (finished) return;
    finished = true;
    clearInterval(tick);
    stdin.off('data', onData);
    stdout.off('resize', onResize);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('exit', restore);
    client.stop();
    restore();
    finish(code);
  }

  /** The terminal as it was: cursor shown, normal screen, cooked mode. Safe to call twice. */
  function restore(): void {
    if (!entered) return;
    entered = false;
    try {
      stdout.write(LEAVE_SCREEN);
      stdin.setRawMode?.(false);
      stdin.pause();
    } catch {
      // the terminal is gone: nothing left to restore
    }
  }

  const flashError = (what: string, e: unknown): void => {
    ui = { ...ui, flash: `${what}: ${e instanceof Error ? e.message : String(e)}` };
    dirty = true;
  };

  function run(action: Action): void {
    const fail = (what: string) => (e: unknown): void => flashError(what, e);
    switch (action.kind) {
      case 'quit':
        quit(0);
        break;
      case 'attach':
        enterConsole(action.agent);
        break;
      case 'send':
        client.sendMessage({ to: action.to, subject: action.subject, body: action.body, ...(action.inReplyTo === undefined ? {} : { inReplyTo: action.inReplyTo }) }).catch(fail('Not sent'));
        break;
      case 'hold':
        client.hold(action.agent).catch(fail(`Could not hold ${action.agent}`));
        break;
      case 'resume':
        client.resume(action.agent).catch(fail(`Could not resume ${action.agent}`));
        break;
      case 'read':
        client.markRead(action.ids).catch(fail('Could not mark read'));
        break;
      case 'archive':
        client.archive(action.ids).catch(fail('Could not archive'));
        break;
      case 'answer':
        client.answer(action.agent, action.go, action.needSeq).catch(fail(`Could not answer ${action.agent}`));
        break;
      case 'relief':
        client.relief(action.id, action.go).catch(fail('Could not answer the hire request'));
        break;
      case 'poll':
        client.startPoll().catch(fail('Could not call a poll'));
        break;
    }
  }

  /** A function, not a comparison: an action in the loop above may change the mode, which the type of `mode` cannot see. */
  const inConsole = (): boolean => mode.kind === 'console';

  function onData(chunk: string): void {
    if (finished) return;
    if (mode.kind === 'console') {
      const out = consoleInput(mode.input, chunk);
      const agent = mode.agent;
      mode = { kind: 'console', agent, input: out.state };
      if (out.send !== '') client.input(agent, out.send);
      if (out.action === 'detach') leaveConsole();
      else if (out.action === 'help') stdout.write(`\x1b7\x1b[${size().rows};1H\x1b[7m${CONSOLE_HELP}\x1b[0m\x1b8`);
      return;
    }
    for (const key of parseKeys(chunk)) {
      const next = step(ui, state, key);
      ui = next.ui;
      dirty = true;
      for (const action of next.actions) {
        run(action);
        if (finished || inConsole()) return;
      }
    }
  }

  function onResize(): void {
    if (mode.kind === 'console') {
      const { cols, rows } = size();
      client.resize(mode.agent, cols, rows);
    } else {
      last = [];
      dirty = true;
    }
  }

  const onSignal = (): void => quit(0);
  const tick = setInterval(draw, options.frameMs ?? 50);

  try {
    stdout.write(ENTER_SCREEN);
    entered = true;
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    process.on('exit', restore);
    client.start();
    return await done;
  } catch (e) {
    quit(1);
    throw e;
  }
}
