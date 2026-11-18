/** gonogo tui: the pure parts: the state from frames, the keys, the screen, the console escape and the command line. */
import { describe, expect, it } from 'vitest';
import type { AgentView, DownlinkItem, PollView, ReliefRequest, ServerFrame } from '../src/shared/protocol.js';
import { HOLD_REASON } from '../src/shared/protocol.js';
import { CONSOLE_HELP, consoleInput, initialConsoleInput } from '../src/server/tui-console.js';
import { initialUi, parseKeys, step } from '../src/server/tui-keys.js';
import type { Ui } from '../src/server/tui-keys.js';
import { parseTuiArgs, resolveToken, resolveUrl, tuiMain } from '../src/server/tui-cli.js';
import { render } from '../src/server/tui-render.js';
import { applyFrame, clean, inboxOf, initialState, isOnHold, itemLine, needsOf } from '../src/server/tui-state.js';
import type { TuiState } from '../src/server/tui-state.js';

const agent = (name: string, desk: number, patch: Partial<AgentView> = {}): AgentView =>
  ({ name, desk, boss: desk === 0, state: 'idle', stateSince: 1, needsKind: null, needsReason: null, needSeq: null, transition: null, held: null, queued: 0, position: null, provider: 'claude', ...patch }) as AgentView;
const message = (id: string, patch: Partial<Extract<DownlinkItem, { type: 'message' }>> = {}): DownlinkItem => ({ type: 'message', id, at: 1_700_000_000_000, from: 'ana', subject: `subject ${id}`, body: `body of ${id}`, truncated: false, inReplyTo: null, read: false, archived: false, ...patch });
const event = (id: string, patch: Partial<Extract<DownlinkItem, { type: 'event' }>> = {}): DownlinkItem => ({ type: 'event', id, at: 1_700_000_000_000, kind: 'redline', text: 'tripped', read: false, archived: false, ...patch });
const relief = (id: string): ReliefRequest => ({ id, by: 'flight', at: 1, expiresAt: 2, name: 'ben', position: 'fido', role: 'r', dir: '/work', provider: 'claude', mode: 'default', cleanRoom: null });
const stateFrame = (agents: AgentView[], items: DownlinkItem[] = [], requests: ReliefRequest[] = [], poll: PollView | null = null): ServerFrame =>
  ({ t: 'state', state: { agents, activity: [], info: { cwd: '/' }, poll, governor: { limit: null, working: 0, holding: 0 }, downlink: { unread: items.filter((i) => !i.read && !i.archived).length, items }, relief: { requests } } }) as unknown as ServerFrame;
const loaded = (agents: AgentView[], items: DownlinkItem[] = [], requests: ReliefRequest[] = [], poll: PollView | null = null): TuiState => ({ ...applyFrame(initialState(), stateFrame(agents, items, requests, poll)), link: 'open' });
const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '');

describe('the state', () => {
  it('knows nothing until the first state frame, then the roster by desk, the Downlink, Relief and the poll', () => {
    const s0 = initialState();
    expect(s0).toMatchObject({ loaded: false, link: 'connecting', agents: [] });
    const s1 = applyFrame(s0, stateFrame([agent('ben', 2), agent('flight', 0), agent('ana', 1)], [message('m1')], [relief('h1')]));
    expect(s1.loaded).toBe(true);
    expect(s1.agents.map((a) => a.name)).toEqual(['flight', 'ana', 'ben']);
    expect(s1.downlink.items).toHaveLength(1);
    expect(s1.relief).toHaveLength(1);
  });

  it('replaces an agent by name, removes one, and follows the Downlink, Relief and poll frames', () => {
    let s = loaded([agent('flight', 0), agent('ana', 1)]);
    s = applyFrame(s, { t: 'agent', agent: agent('ana', 1, { state: 'working' }) });
    expect(s.agents.map((a) => [a.name, a.state])).toEqual([['flight', 'idle'], ['ana', 'working']]);
    s = applyFrame(s, { t: 'agent-removed', name: 'ana' });
    expect(s.agents.map((a) => a.name)).toEqual(['flight']);
    s = applyFrame(s, { t: 'downlink', downlink: { unread: 1, items: [message('m2')] } });
    expect(s.downlink.unread).toBe(1);
    s = applyFrame(s, { t: 'relief', relief: { requests: [relief('h2')] } });
    expect(s.relief.map((r) => r.id)).toEqual(['h2']);
    s = applyFrame(s, { t: 'poll', poll: { id: 1, status: 'open' } as PollView });
    expect(s.poll?.id).toBe(1);
    // frames the terminal does not show change nothing
    expect(applyFrame(s, { t: 'size', agent: 'x', cols: 1, rows: 1 })).toBe(s);
  });

  it('lists what waits for a go or a no-go: permission dialogs and Relief requests, not a hold or a stopping agent', () => {
    const s = loaded(
      [
        agent('flight', 0),
        agent('ana', 1, { state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: git push', needSeq: 4 }),
        agent('ben', 2, { state: 'needs_you', needsKind: 'redline', needsReason: HOLD_REASON }),
        agent('cat', 3, { state: 'needs_you', needsKind: 'permission', needsReason: 'x', transition: 'stopping' }),
        agent('dan', 4, { state: 'needs_you', needsKind: 'startup_dialog', needsReason: 'startup dialog' }),
      ],
      [],
      [relief('h1')],
    );
    expect(needsOf(s)).toEqual([
      { kind: 'permission', agent: 'ana', reason: 'permission request: Bash: git push', needSeq: 4 },
      { kind: 'relief', id: 'h1', by: 'flight', name: 'ben', reason: 'hire ben (fido) in /work' },
    ]);
    expect(isOnHold(s.agents[2]!)).toBe(true);
    expect(isOnHold(s.agents[1]!)).toBe(false);
  });

  it('puts the unread items first, drops the archived ones, and says an item in one line', () => {
    const s = loaded([agent('flight', 0)], [message('m4', { read: true }), message('m3'), event('e1', { archived: true }), event('e2'), message('m1', { read: true })]);
    expect(inboxOf(s).map((i) => i.id)).toEqual(['m3', 'e2', 'm4', 'm1']);
    expect(itemLine(message('m9', { subject: '' }))).toBe('ana: body of m9');
    expect(itemLine(event('e9'))).toBe('redline: tripped');
  });

  it('takes out of a text of the server what a terminal would act on', () => {
    expect(clean('a\x1b[2Jb\x07c\u202ed\u009bx')).toBe('a [2Jb c d x');
    expect(clean('x'.repeat(300), 20)).toBe(`${'x'.repeat(19)}…`);
    expect(clean('  one \n\n two  ')).toBe('one two');
    expect(clean('\x1b]0;title\x07')).not.toContain('\x1b');
  });
});

describe('parseKeys', () => {
  it('reads the arrows, the Escape key, the controls and text', () => {
    expect(parseKeys('\x1b[A\x1b[B\x1bOC\x1b[D')).toEqual(['up', 'down', 'right', 'left']);
    expect(parseKeys('\x1b')).toEqual(['esc']);
    expect(parseKeys('\r')).toEqual(['enter']);
    expect(parseKeys('\t\x7f\x03\x15\x1d')).toEqual(['tab', 'backspace', 'ctrl-c', 'ctrl-u', 'ctrl-]']);
    expect(parseKeys('\x1b[3~\x1b[5~\x1b[1;5A')).toEqual(['delete', 'pageup', 'up']);
    expect(parseKeys('ab é😀')).toEqual(['a', 'b', ' ', 'é', '😀']);
    expect(parseKeys('a\nb')).toEqual(['a', 'enter', 'b']);
    expect(parseKeys('\x01')).toEqual(['unknown']);
  });
});

describe('the keys on each screen', () => {
  const room = loaded([agent('flight', 0), agent('ana', 1), agent('ben', 2)], [message('m1'), message('m2', { read: true }), event('e1')]);
  const press = (ui: Ui, state: TuiState, ...keys: string[]): { ui: Ui; actions: ReturnType<typeof step>['actions'] } => {
    let current = ui;
    const actions: ReturnType<typeof step>['actions'] = [];
    for (const key of keys) {
      const out = step(current, state, key);
      current = out.ui;
      actions.push(...out.actions);
    }
    return { ui: current, actions };
  };

  it('switches screens with 1 to 4 and Tab, and leaves with q or Ctrl-C', () => {
    expect(press(initialUi(), room, '2').ui.screen).toBe('inbox');
    expect(press(initialUi(), room, 'tab', 'tab', 'tab').ui.screen).toBe('poll');
    expect(press(initialUi(), room, 'tab', 'tab', 'tab', 'tab').ui.screen).toBe('room');
    expect(press(initialUi(), room, 'q').actions).toEqual([{ kind: 'quit' }]);
    expect(press(initialUi(), room, 'ctrl-c').actions).toEqual([{ kind: 'quit' }]);
    expect(press(initialUi(), room, '?').ui.help).toBe(true);
    expect(press(initialUi(), room, '?', 'q').actions).toEqual([]);
  });

  it('moves the cursor of the room, never past the ends, and attaches, writes, holds and resumes the agent under it', () => {
    expect(press(initialUi(), room, 'down', 'down', 'down', 'down').ui.room).toBe(2);
    expect(press(initialUi(), room, 'up').ui.room).toBe(0);
    expect(press(initialUi(), room, 'j', 'enter').actions).toEqual([{ kind: 'attach', agent: 'ana' }]);
    expect(press(initialUi(), room, 'down', 'h').actions).toEqual([{ kind: 'hold', agent: 'ana' }]);
    expect(press(initialUi(), room, 'down', 'down', 'r').actions).toEqual([{ kind: 'resume', agent: 'ben' }]);
    const writing = press(initialUi(), room, 'down', 'n', 'h', 'i', ' ', 'y', 'o', 'u', 'backspace');
    expect(writing.ui.compose).toMatchObject({ to: 'ana', text: 'hi yo' });
    const sent = press(writing.ui, room, 'enter');
    expect(sent.actions).toEqual([{ kind: 'send', to: 'ana', subject: '', body: 'hi yo' }]);
    expect(sent.ui.compose).toBeNull();
    expect(press(initialUi(), loaded([]), 'enter', 'n', 'h').actions).toEqual([]);
  });

  it('edits a message: Esc cancels, Ctrl-U clears, an empty line sends nothing, q is a letter and not a quit', () => {
    const open = press(initialUi(), room, 'n', 'q', 'x');
    expect(open.ui.compose?.text).toBe('qx');
    expect(open.actions).toEqual([]);
    expect(press(open.ui, room, 'esc').ui.compose).toBeNull();
    expect(press(open.ui, room, 'ctrl-u').ui.compose?.text).toBe('');
    expect(press(initialUi(), room, 'n', 'enter').actions).toEqual([]);
    expect(press(initialUi(), room, 'n', 'enter').ui.compose).toBeNull();
  });

  it('reads an item with Enter, archives with a, and replies to a message as the Director with the id of the message', () => {
    const inbox = (key: string[]): ReturnType<typeof press> => press({ ...initialUi(), screen: 'inbox' }, room, ...key);
    expect(inbox(['enter']).actions).toEqual([{ kind: 'read', ids: ['m1'] }]);
    expect(inbox(['enter']).ui.detail).toBe(true);
    expect(inbox(['enter', 'enter']).actions).toEqual([{ kind: 'read', ids: ['m1'] }]);
    expect(inbox(['enter', 'enter']).ui.detail).toBe(false);
    // the second item is an unread event, then the read message
    expect(inbox(['down', 'enter']).actions).toEqual([{ kind: 'read', ids: ['e1'] }]);
    expect(inbox(['down', 'down', 'enter']).actions).toEqual([]);
    expect(inbox(['a']).actions).toEqual([{ kind: 'archive', ids: ['m1'] }]);
    const reply = inbox(['r', 'o', 'k', 'enter']);
    expect(reply.actions).toEqual([{ kind: 'read', ids: ['m1'] }, { kind: 'send', to: 'ana', subject: 'Re: subject m1', body: 'ok', inReplyTo: 'm1' }]);
    expect(inbox(['down', 'r']).ui.flash).toBe('Only a message can be answered.');
    expect(press({ ...initialUi(), screen: 'inbox' }, loaded([agent('flight', 0)], [message('m5', { subject: 'Re: asking' })]), 'r', 'enter').ui.compose).toBeNull();
    expect((press({ ...initialUi(), screen: 'inbox' }, loaded([agent('flight', 0)], [message('m5', { subject: 'Re: asking' })]), 'r').ui.compose)?.subject).toBe('Re: asking');
  });

  it('answers a permission dialog with its needSeq and a hire request by its id, from the NEEDS screen only', () => {
    const state = loaded([agent('flight', 0), agent('ana', 1, { state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: ls', needSeq: 7 })], [], [relief('h1')]);
    const needs = (keys: string[]): ReturnType<typeof press> => press({ ...initialUi(), screen: 'needs' }, state, ...keys);
    expect(needs(['g']).actions).toEqual([{ kind: 'answer', agent: 'ana', go: true, needSeq: 7 }]);
    expect(needs(['x']).actions).toEqual([{ kind: 'answer', agent: 'ana', go: false, needSeq: 7 }]);
    expect(needs(['down', 'g']).actions).toEqual([{ kind: 'relief', id: 'h1', go: true }]);
    expect(needs(['down', 'x']).actions).toEqual([{ kind: 'relief', id: 'h1', go: false }]);
    // a go on another screen does nothing: the strip names what waits, 3 opens it
    expect(press(initialUi(), state, 'g', 'x').actions).toEqual([]);
    expect(press({ ...initialUi(), screen: 'needs' }, loaded([agent('flight', 0)]), 'g').actions).toEqual([]);
  });

  it('calls a poll with t on the POLL screen', () => {
    expect(press({ ...initialUi(), screen: 'poll' }, room, 't').actions).toEqual([{ kind: 'poll' }]);
    expect(press(initialUi(), room, 't').actions).toEqual([]);
  });

  it('keeps a cursor inside a list that got shorter', () => {
    const long = loaded([agent('flight', 0), agent('ana', 1), agent('ben', 2)]);
    const at = press(initialUi(), long, 'down', 'down').ui;
    expect(press(at, loaded([agent('flight', 0)]), 'enter').actions).toEqual([{ kind: 'attach', agent: 'flight' }]);
  });
});

describe('the screen', () => {
  const rich = loaded(
    [
      agent('flight', 0, { position: 'flight', state: 'working' }),
      agent('ana', 1, { state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: git push origin main', needSeq: 2, position: 'fido' }),
      agent('ben', 2, { state: 'needs_you', needsKind: 'redline', needsReason: HOLD_REASON }),
      agent('cat', 3, { state: 'stopped' }),
      agent('dan', 4, { held: { kind: 'draft', text: 'held: text in dan\'s input' } as never, queued: 2 }),
    ],
    [message('m1'), event('e1', { read: true })],
    [relief('h1')],
    { id: 3, status: 'hold', note: 'no-go: ana', entries: [{ agent: 'ana', vote: 'no-go', reason: 'unsafe', at: 1 }, { agent: 'ben', vote: null, reason: '', at: null }], startedAt: 1 } as PollView,
  );
  const draw = (state: TuiState, ui: Ui, cols: number, rows: number, color = false): string[] => render(state, ui, { cols, rows }, { color });

  it.each([[60, 20], [80, 24], [100, 30], [120, 40], [200, 50]])('is exactly %i columns by %i rows, in every screen', (cols, rows) => {
    for (const screen of ['room', 'inbox', 'needs', 'poll'] as const) {
      const lines = draw(rich, { ...initialUi(), screen }, cols, rows);
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect([...plain(line)]).toHaveLength(cols);
    }
  });

  it('shows the room with a glyph and a word for each state, the hold, the held mail and what a needs-you asks', () => {
    const text = draw(rich, initialUi(), 90, 24).map(plain).join('\n');
    expect(text).toMatch(/\* flight\s+working/);
    expect(text).toMatch(/! ana\s+needs you\s+fido\s+permission request: Bash: git push/);
    expect(text).toMatch(/! ben\s+on hold/);
    expect(text).toMatch(/- cat\s+stopped/);
    expect(text).toMatch(/\. dan\s+idle\s+held: text in dan/);
  });

  it('keeps the strip of what waits on every screen, with the first request and how to reach it', () => {
    for (const screen of ['room', 'inbox', 'poll'] as const) {
      const strip = plain(draw(rich, { ...initialUi(), screen }, 100, 24)[1] as string);
      expect(strip).toContain('NEEDS 2: ana: permission request: Bash: git push origin main');
      expect(strip).toContain('(press 3)');
    }
    expect(plain(draw(loaded([agent('flight', 0)]), initialUi(), 100, 24)[1] as string)).toContain('Nothing waits for you.');
  });

  it('puts the room on the left and the inbox or the needs on the right from 100 columns, one pane below', () => {
    const wide = draw(rich, initialUi(), 120, 24).map(plain);
    expect(wide[3]).toContain('│');
    expect(wide.join('\n')).toContain('INBOX');
    expect(draw(rich, { ...initialUi(), screen: 'needs' }, 120, 24).map(plain).join('\n')).toMatch(/NEEDS YOU\s+2/);
    const narrow = draw(rich, initialUi(), 80, 24).map(plain).join('\n');
    expect(narrow).not.toContain('│');
    expect(narrow).not.toContain('INBOX  ');
  });

  it('marks the unread items, draws the cursor, and shows a whole message on Enter with its lines wrapped', () => {
    const inbox = draw(rich, { ...initialUi(), screen: 'inbox' }, 80, 24).map(plain);
    expect(inbox.join('\n')).toMatch(/> NEW \d\d:\d\d ana: subject m1/);
    expect(inbox.join('\n')).toMatch(/\s{2}\s{4}\d\d:\d\d redline: tripped/);
    const long = loaded([agent('flight', 0)], [message('m1', { body: `first line\n${'word '.repeat(40)}` })]);
    const detail = draw(long, { ...initialUi(), screen: 'inbox', detail: true }, 60, 24).map(plain).join('\n');
    expect(detail).toContain('From ana: subject m1');
    expect(detail).toContain('first line');
    expect(detail.split('\n').filter((l) => l.includes('word word')).length).toBeGreaterThan(1);
  });

  it('shows the poll, and what to press when there is none', () => {
    const poll = draw(rich, { ...initialUi(), screen: 'poll' }, 80, 24).map(plain).join('\n');
    expect(poll).toMatch(/T-minus: HOLD/);
    expect(poll).toMatch(/ana\s+no-go\s+unsafe/);
    expect(poll).toMatch(/ben\s+waiting/);
    expect(draw(loaded([agent('flight', 0)]), { ...initialUi(), screen: 'poll' }, 80, 24).map(plain).join('\n')).toContain('Press t to call a T-minus poll.');
  });

  it('draws what is being typed with its tail in view, and the keys of the editor', () => {
    const ui: Ui = { ...initialUi(), compose: { to: 'ana', label: 'Message to ana', subject: '', text: `${'a'.repeat(100)}END` } };
    const lines = draw(rich, ui, 60, 20).map(plain);
    expect(lines[lines.length - 2]).toMatch(/^Message to ana> a+END_/);
    expect(lines[lines.length - 1]).toContain('Enter send  Esc cancel');
    expect(draw(rich, { ...initialUi(), flash: 'GO sent.' }, 60, 20).map(plain)[18]).toContain('GO sent.');
  });

  it('shows the help over the screen, and says so before the server has answered', () => {
    expect(draw(rich, { ...initialUi(), help: true }, 100, 24).map(plain).join('\n')).toContain('Ctrl-] then q leaves it');
    const waiting = draw(initialState(), initialUi(), 80, 24).map(plain).join('\n');
    expect(waiting).toContain('Waiting for the server…');
    expect(waiting).toContain('connecting…');
    expect(draw({ ...initialState(), link: 'unauthorized' }, initialUi(), 80, 24).map(plain).join('\n')).toContain('The server refused the token.');
    expect(draw({ ...rich, link: 'reconnecting' }, initialUi(), 80, 24).map(plain)[0]).toContain('reconnecting…');
  });

  it('never draws a control sequence that an agent wrote, in any field', () => {
    const evil = '\x1b[2J\x1b]0;pwn\x07\u009b31m';
    const hostile = loaded(
      [agent(`ev${evil}il`, 0, { state: 'needs_you', needsKind: 'permission', needsReason: evil, needSeq: 1, position: evil }), agent('ana', 1, { held: { kind: 'draft', text: evil } as never })],
      [message('m1', { from: evil, subject: evil, body: evil }), event('e1', { text: evil })],
      [{ ...relief('h1'), by: evil, name: evil, position: evil, dir: evil }],
      { id: 1, status: 'hold', note: evil, subject: evil, entries: [{ agent: evil, vote: 'no-go', reason: evil, at: 1 }], startedAt: 1 } as PollView,
    );
    for (const screen of ['room', 'inbox', 'needs', 'poll'] as const) {
      for (const detail of [false, true]) {
        for (const line of draw(hostile, { ...initialUi(), screen, detail }, 120, 30, false)) {
          expect(line).not.toMatch(/[\x00-\x1f\x7f\u0080-\u009f]/);
        }
      }
    }
    // with colour, the only escapes are ours: colour codes
    for (const line of draw(hostile, initialUi(), 120, 30, true)) expect(line.replace(/\x1b\[[0-9;]*m/g, '')).not.toMatch(/[\x00-\x1f\x7f\u0080-\u009f]/);
  });

  it('draws no colour at all with NO_COLOR, and the 16 standard colours otherwise', () => {
    const mono = draw(rich, initialUi(), 100, 24, false).join('');
    expect(mono).not.toContain('\x1b');
    const colour = draw(rich, initialUi(), 100, 24, true).join('');
    expect(colour).toContain('\x1b[');
    expect([...colour.matchAll(/\x1b\[([0-9;]*)m/g)].every((m) => ['0', '1', '2', '7', '31', '32', '33', '36'].includes(m[1] as string))).toBe(true);
  });

  it('survives a terminal of the smallest size and a room with nothing in it', () => {
    expect(() => draw(rich, initialUi(), 5, 3)).not.toThrow();
    expect(draw(rich, initialUi(), 5, 3)).toHaveLength(6);
    expect(draw(loaded([]), initialUi(), 80, 24).map(plain).join('\n')).toContain('No consoles yet');
  });
});

describe('the escape of a console', () => {
  it('sends what is typed as it is, and takes Ctrl-] and the key after it', () => {
    const s0 = initialConsoleInput();
    expect(consoleInput(s0, 'hello\r')).toEqual({ state: { pending: false }, send: 'hello\r' });
    const first = consoleInput(s0, 'ab\x1d');
    expect(first).toEqual({ state: { pending: true }, send: 'ab' });
    expect(consoleInput(first.state, 'q')).toEqual({ state: { pending: false }, send: '', action: 'detach' });
    expect(consoleInput(first.state, '?')).toMatchObject({ action: 'help', send: '' });
    expect(consoleInput(first.state, '\x1d')).toEqual({ state: { pending: false }, send: '\x1d' });
    expect(consoleInput(first.state, 'z')).toEqual({ state: { pending: false }, send: 'z' });
  });

  it('works inside one chunk, and sends nothing after a detach', () => {
    expect(consoleInput(initialConsoleInput(), 'a\x1dqb')).toMatchObject({ send: 'a', action: 'detach' });
    expect(consoleInput(initialConsoleInput(), 'a\x1d\x1db')).toEqual({ state: { pending: false }, send: 'a\x1db' });
    expect(CONSOLE_HELP).toContain('Ctrl-] q');
  });
});

describe('the command line', () => {
  it('reads --url, --token and --home, with = or a space, and refuses anything else', () => {
    expect(parseTuiArgs([])).toEqual({ kind: 'run' });
    expect(parseTuiArgs(['--url', 'http://h:1', '--token=abc', '--home', '/x'])).toEqual({ kind: 'run', url: 'http://h:1', token: 'abc', home: '/x' });
    expect(parseTuiArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseTuiArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseTuiArgs(['--port', '1'])).toEqual({ kind: 'error', message: 'unknown option --port' });
    expect(parseTuiArgs(['--url'])).toEqual({ kind: 'error', message: '--url needs a value' });
    expect(parseTuiArgs(['--token='])).toEqual({ kind: 'error', message: '--token needs a value' });
    expect(parseTuiArgs(['x'])).toMatchObject({ kind: 'error' });
  });

  it('finds the server: --url, else the loopback address and the port of the environment', () => {
    expect(resolveUrl(undefined, {})).toEqual({ url: 'http://127.0.0.1:7777' });
    expect(resolveUrl(undefined, { GONOGO_PORT: '9000', GONOGO_HOST: '0.0.0.0' })).toEqual({ url: 'http://127.0.0.1:9000' });
    expect(resolveUrl(undefined, { GONOGO_HOST: '10.0.0.5' })).toEqual({ url: 'http://10.0.0.5:7777' });
    expect(resolveUrl(undefined, { GONOGO_HOST: '::1' })).toEqual({ url: 'http://[::1]:7777' });
    expect(resolveUrl('https://room.example.test/', {})).toEqual({ url: 'https://room.example.test' });
    expect(resolveUrl('http://h:5/#token=zz', {})).toEqual({ url: 'http://h:5' });
    expect(resolveUrl('ftp://h', {})).toHaveProperty('error');
    expect(resolveUrl('not a url', {})).toHaveProperty('error');
    expect(resolveUrl(undefined, { GONOGO_PORT: 'x' })).toHaveProperty('error');
  });

  it('takes the token from --token, then GONOGO_TOKEN, then the file of the home, and says where it looked', () => {
    const read = (path: string): string => {
      if (path === '/home/a/token') return ' filetoken\n';
      throw new Error('ENOENT');
    };
    expect(resolveToken('given', undefined, { GONOGO_TOKEN: 'env' }, read)).toEqual({ token: 'given' });
    expect(resolveToken(undefined, undefined, { GONOGO_TOKEN: 'env' }, read)).toEqual({ token: 'env' });
    expect(resolveToken(undefined, '/home/a', {}, read)).toEqual({ token: 'filetoken' });
    expect(resolveToken(undefined, undefined, { GONOGO_HOME: '/home/a' }, read)).toEqual({ token: 'filetoken' });
    const none = resolveToken(undefined, '/home/b', {}, read);
    expect(none).toHaveProperty('error');
    expect((none as { error: string }).error).toContain('/home/b');
    expect(resolveToken(undefined, '/home/a', { GONOGO_TOKEN: '' }, read)).toEqual({ token: 'filetoken' });
  });

  it('needs a terminal: with none it says so and exits 2, and the help and the errors need none', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = (tty: boolean) => ({ stdin: { isTTY: tty } as never, stdout: { isTTY: tty, write: (t: string) => void out.push(t) } as never, stderr: { write: (t: string) => void err.push(t) } });
    expect(await tuiMain(['--help'], {}, io(false))).toBe(0);
    expect(out.join('')).toContain('Usage: gonogo tui');
    expect(await tuiMain(['--nope'], {}, io(false))).toBe(2);
    expect(await tuiMain([], {}, io(false))).toBe(2);
    expect(err.join('')).toContain('needs a terminal');
    err.length = 0;
    expect(await tuiMain(['--url', 'ftp://x'], { GONOGO_TOKEN: 't' }, io(true))).toBe(2);
    expect(await tuiMain([], { GONOGO_HOME: '/nowhere/at/all' }, io(true))).toBe(1);
    expect(err.join('')).toContain('no browser token');
    expect(err.join('')).not.toMatch(/token: [0-9a-f]{20}/);
  });
});
