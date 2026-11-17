import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem, AgentView, PollView, StateChange } from '../src/shared/protocol.js';
import { HISTORY_WINDOW_MS, MAX_AGENTS } from '../src/shared/protocol.js';
import { POSITIONS } from '../src/shared/positions.js';
import {
  ANNOUNCE_GAP_MS,
  askDetail,
  askTitle,
  asksForGo,
  cellNumber,
  chipText,
  cleanRoomPlace,
  consoleMode,
  createAnnouncer,
  ledOf,
  legendsOf,
  needingYou,
  panelDetails,
  reasonText,
  seat,
  secondLine,
  splitReason,
  stateText,
  tileKind,
  tileLabel,
  tileLines,
  voteOf,
} from '../src/client/room.js';
import type { Cell } from '../src/client/room.js';
import {
  briefedText,
  clockText,
  missionOf,
  noteLine,
  pollTargets,
  pollWord,
  sequenceLabel,
  sequenceSpans,
  sinceText,
  voteChips,
} from '../src/client/wall.js';

function agent(name: string, desk: number, extra: Partial<AgentView> = {}): AgentView {
  return {
    name,
    role: 'a role',
    dir: '/work',
    mode: 'default',
    desk,
    boss: false,
    state: 'idle',
    stateSince: 0,
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
    doing: null,
    history: [],
    ...extra,
  };
}

function item(id: string, from: string, to: string, at: number, extra: Partial<ActivityItem> = {}): ActivityItem {
  return { id, from, to, subject: 's', body: 'b', inReplyTo: null, hops: 1, at, status: 'queued', note: null, updatedAt: at, truncated: false, ...extra };
}

function poll(extra: Partial<PollView> = {}): PollView {
  return {
    id: 1,
    startedAt: 0,
    status: 'open',
    entries: [
      { agent: 'fido', vote: 'go', reason: 'fine', at: 1 },
      { agent: 'ana', vote: null, reason: '', at: null },
    ],
    note: 'waiting for ana',
    ...extra,
  };
}

const agentCells = (cells: Cell[]): Array<Extract<Cell, { type: 'agent' }>> => cells.flatMap((c) => (c.type === 'agent' ? [c] : []));

describe('seating', () => {
  it('has the fifteen positions first, in order, and one spare cell in an empty room', () => {
    const cells = seat([]);
    expect(cells).toHaveLength(POSITIONS.length + 1);
    expect(cells.slice(0, POSITIONS.length).map((c) => (c.type === 'open' ? c.position.id : '?'))).toEqual(POSITIONS.map((p) => p.id));
    expect(cells[POSITIONS.length]).toEqual({ type: 'spare', n: POSITIONS.length + 1 });
    expect(cells.map((c) => c.n)).toEqual(cells.map((_, i) => i + 1));
  });

  it('seats an agent in the cell of its position', () => {
    const cells = seat([agent('flight', 0, { boss: true, position: 'flight' }), agent('g', 1, { position: 'guido' })]);
    expect(cells[0]).toMatchObject({ type: 'agent', seated: true });
    const guido = POSITIONS.findIndex((p) => p.id === 'guido');
    expect(cells[guido]).toMatchObject({ type: 'agent', n: guido + 1, seated: true });
    expect(cells[1]?.type).toBe('open');
  });

  it('gives the cell to the oldest desk and sends the duplicate, the unseated and the custom to the spare cells in desk order', () => {
    const cells = seat([
      agent('late', 5, { position: 'guido' }),
      agent('custom', 4, { provider: 'custom', command: '["tail"]' }),
      agent('early', 2, { position: 'guido' }),
      agent('plain', 3),
    ]);
    const guido = POSITIONS.findIndex((p) => p.id === 'guido');
    expect(cells[guido]).toMatchObject({ type: 'agent', agent: { name: 'early' }, seated: true });
    const rest = cells.slice(POSITIONS.length);
    expect(rest.map((c) => (c.type === 'agent' ? c.agent.name : c.type))).toEqual(['plain', 'custom', 'late', 'spare']);
    expect(agentCells(rest).every((c) => !c.seated)).toBe(true);
  });

  it('treats an unknown position as none', () => {
    const cells = seat([agent('x', 1, { position: 'nonsense' })]);
    expect(cells.slice(0, POSITIONS.length).every((c) => c.type === 'open')).toBe(true);
    expect(agentCells(cells)).toHaveLength(1);
  });

  it('drops the spare cell when the room is full', () => {
    const full = Array.from({ length: MAX_AGENTS }, (_, i) => agent(`a${i}`, i));
    const cells = seat(full);
    expect(cells.some((c) => c.type === 'spare')).toBe(false);
    expect(agentCells(cells)).toHaveLength(MAX_AGENTS);
  });

  it('names a seated agent by its call sign and everyone else by its name in capitals', () => {
    const legends = legendsOf(seat([agent('g', 1, { position: 'guido' }), agent('dup', 2, { position: 'guido' }), agent('ana', 3)]));
    expect(legends.g).toBe('GUIDO');
    expect(legends.dup).toBe('DUP');
    expect(legends.ana).toBe('ANA');
  });
});

describe('a tile', () => {
  it('maps the state to the kind of the tile', () => {
    expect(tileKind(agent('a', 1, { state: 'working' }))).toBe('working');
    expect(tileKind(agent('a', 1, { state: 'needs_you' }))).toBe('needs');
    expect(tileKind(agent('a', 1, { state: 'starting' }))).toBe('starting');
    expect(tileKind(agent('a', 1, { state: 'stopped' }))).toBe('stopped');
    expect(tileKind(agent('a', 1, { state: 'idle' }))).toBe('idle');
  });

  it('lights the LED of a console that works or needs you, and only breathes it while starting', () => {
    expect(ledOf('working')).toEqual({ on: true, blink: true });
    expect(ledOf('needs')).toEqual({ on: true, blink: true });
    expect(ledOf('starting')).toEqual({ on: false, blink: true });
    for (const kind of ['idle', 'stopped', 'open'] as const) expect(ledOf(kind)).toEqual({ on: false, blink: false });
  });

  it('prints the cell number with two digits', () => {
    expect(cellNumber(1)).toBe('01');
    expect(cellNumber(10)).toBe('10');
    expect(cellNumber(24)).toBe('24');
  });

  it('prints the state with the time in it, PRINTING for a custom command, and the transition while one runs', () => {
    expect(stateText(agent('a', 1, { state: 'working', stateSince: 1_000 }), 39_000)).toBe('WORKING 38 S');
    expect(stateText(agent('a', 1, { state: 'needs_you', stateSince: 0 }), 180_000)).toBe('NEEDS YOU 3 M');
    expect(stateText(agent('a', 1, { state: 'idle', stateSince: 0 }), 2 * 3_600_000)).toBe('IDLE 2 H');
    expect(stateText(agent('a', 1, { state: 'working', provider: 'custom' }), 5_000)).toBe('PRINTING');
    expect(stateText(agent('a', 1, { state: 'stopped', transition: 'removing' }), 5_000)).toBe('REMOVING');
    expect(sinceText(59_999)).toBe('59 s');
  });

  it('strips the permission prefix from the reason', () => {
    expect(reasonText(agent('a', 1, { needsReason: 'permission request: Bash: npm test' }))).toBe('Bash: npm test');
    expect(reasonText(agent('a', 1, { needsReason: 'startup dialog: answer it in the terminal' }))).toBe('startup dialog: answer it in the terminal');
    expect(reasonText(agent('a', 1))).toBeNull();
  });

  it('picks the second line: reason, held text, exit text, waiting, then what the position does', () => {
    const fido = POSITIONS.find((p) => p.id === 'fido') ?? null;
    const base = agent('a', 1, { position: 'fido' });
    expect(secondLine(base, fido)).toBe(fido?.summary);
    expect(secondLine({ ...base, queued: 2 }, fido)).toBe('2 waiting');
    expect(secondLine({ ...base, queued: 2, exit: { code: 1, signal: null, at: 0, requested: false, text: 'exited with code 1' } }, fido)).toBe('exited with code 1');
    expect(secondLine({ ...base, queued: 2, exit: null, held: { kind: 'draft', text: "held: text in a's input" } }, fido)).toBe("held: text in a's input");
    expect(secondLine({ ...base, state: 'needs_you', needsReason: 'permission request: Bash: ls', held: { kind: 'draft', text: 'held' } }, fido)).toBe('Bash: ls');
  });

  it('shows what it does first, and moves the second line up when it has done nothing yet', () => {
    const fido = POSITIONS.find((p) => p.id === 'fido') ?? null;
    expect(tileLines(agent('a', 1, { doing: 'Bash: ls' }), fido)).toEqual(['Bash: ls', fido?.summary]);
    expect(tileLines(agent('a', 1), fido)).toEqual([fido?.summary, '']);
    // the gonogo prefix goes, a stopped console forgets its last tool, and a prompt for the same tool is said once
    expect(tileLines(agent('a', 1, { doing: 'mcp__gonogo__read_messages' }), fido)[0]).toBe('read_messages');
    expect(tileLines(agent('a', 1, { doing: 'mcp__github__create_issue: x' }), fido)[0]).toBe('github: create_issue: x');
    expect(tileLines(agent('a', 1, { state: 'stopped', doing: 'Bash: ls' }), fido)).toEqual([fido?.summary, '']);
    expect(tileLines(agent('a', 1, { state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: ls', doing: 'Bash: ls' }), fido)).toEqual(['Bash: ls', '']);
    expect(tileLines(agent('c', 1, { provider: 'custom', command: '["tail","-f","x"]', doing: 'ignored' }), null)).toEqual(['["tail","-f","x"]', '']);
  });

  it('shows the vote of an agent while a poll runs, and none once it is aborted', () => {
    expect(voteOf(poll(), 'fido')).toBe('GO');
    expect(voteOf(poll(), 'ana')).toBe('WAIT');
    expect(voteOf(poll(), 'ben')).toBeNull();
    expect(voteOf(null, 'fido')).toBeNull();
    expect(voteOf(poll({ status: 'aborted' }), 'fido')).toBeNull();
    expect(voteOf(poll({ entries: [{ agent: 'x', vote: 'no-go', reason: 'no', at: 1 }] }), 'x')).toBe('NO-GO');
  });

  it('gives every tile a full accessible name', () => {
    const cells = seat([
      agent('flight', 0, { boss: true, position: 'flight', state: 'needs_you', needsReason: 'permission request: Bash: ls', queued: 1 }),
      agent('logs', 1, { provider: 'custom', state: 'working' }),
    ]);
    const labels = cells.map((c) => tileLabel(c, null));
    expect(labels[0]).toBe('flight (boss), Flight director, needs you: Bash: ls, 1 message waiting');
    expect(labels[1]).toBe('Staff a console: FAO, Flight activities officer');
    expect(labels.at(-2)).toBe('logs, custom command, printing');
    expect(labels.at(-1)).toBe('Staff a console with no position');
    expect(tileLabel(cells[0] as Cell, 'WAIT')).toContain(', vote wait');
  });

  it('says clean room in the accessible name of a Clean Room tile, and only there', () => {
    const labels = seat([agent('ana', 1, { cleanRoom: {}, state: 'idle' }), agent('ben', 2)]).map((c) => tileLabel(c, null));
    expect(labels).toContain('ana, idle, clean room');
    expect(labels).toContain('ben, idle');
  });

  it('puts a Clean Room console on its branch and in its worktree under the server home, and a console on the host nowhere', () => {
    expect(cleanRoomPlace(agent('ana', 1, { cleanRoom: {} }), '/Users/me/.gonogo')).toEqual({ branch: 'gonogo/ana', worktree: '/Users/me/.gonogo/cleanroom/ana' });
    expect(cleanRoomPlace(agent('ana', 1, { cleanRoom: { image: 'x' } }), '/state/gonogo/')).toEqual({ branch: 'gonogo/ana', worktree: '/state/gonogo/cleanroom/ana' });
    expect(cleanRoomPlace(agent('ana', 1, { cleanRoom: null }), '/h')).toBeNull();
  });
});

describe('what needs the Director', () => {
  const asking = agent('s', 1, { state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: npm run test:e2e', stateSince: 0, queued: 1 });

  it('lists the consoles in needs_you', () => {
    expect(needingYou([agent('a', 1), asking, agent('b', 2, { state: 'working' })]).map((a) => a.name)).toEqual(['s']);
  });

  it('asks for a go only for a permission that is not mid-transition', () => {
    expect(asksForGo(asking)).toBe(true);
    expect(asksForGo({ ...asking, needsKind: 'dialog' })).toBe(false);
    expect(asksForGo({ ...asking, transition: 'stopping' })).toBe(false);
    expect(asksForGo(agent('a', 1))).toBe(false);
  });

  it('words the title and the detail', () => {
    expect(askTitle(asking, 'SURGEON')).toBe('SURGEON ASKS FOR A GO');
    expect(askTitle({ ...asking, needsKind: 'startup_dialog' }, 'SURGEON')).toBe('SURGEON NEEDS YOU');
    expect(askDetail(asking, 180_000)).toBe('Bash: npm run test:e2e · waiting 3 m · 1 message waiting');
    expect(askDetail({ ...asking, needsReason: null, queued: 0 }, 5_000)).toBe('Answer it in the terminal · waiting 5 s');
  });

  it('splits a reason into the tool and what it runs', () => {
    expect(splitReason('Bash: npm run test:e2e')).toEqual({ tool: 'Bash', detail: 'npm run test:e2e' });
    expect(splitReason('Do you want to proceed?')).toEqual({ tool: null, detail: 'Do you want to proceed?' });
    expect(splitReason(null)).toEqual({ tool: null, detail: '' });
  });
});

describe('the console panel', () => {
  it('picks the state of Console.dc.html', () => {
    const base = agent('a', 1);
    expect(consoleMode({ ...base, state: 'needs_you', needsKind: 'permission' })).toBe('ask');
    expect(consoleMode({ ...base, state: 'needs_you', needsKind: 'dialog' })).toBe('needs');
    expect(consoleMode({ ...base, state: 'stopped' })).toBe('stopped');
    expect(consoleMode({ ...base, state: 'starting' })).toBe('starting');
    expect(consoleMode({ ...base, provider: 'custom', state: 'working' })).toBe('custom');
    expect(consoleMode({ ...base, provider: 'custom', state: 'stopped' })).toBe('stopped');
    expect(consoleMode({ ...base, state: 'working' })).toBe('running');
  });

  it('words the chip of the header', () => {
    expect(chipText(agent('a', 1, { state: 'needs_you', needsKind: 'permission', stateSince: 0 }), 180_000)).toBe('NEEDS YOU 3 M · PERMISSION');
    expect(chipText(agent('a', 1, { provider: 'custom', state: 'working' }), 1)).toBe('PRINTING · CUSTOM COMMAND');
    expect(chipText(agent('a', 1, { provider: 'gemini', state: 'working', stateSince: 0 }), 1000)).toBe('WORKING 1 S · GEMINI CLI');
    expect(chipText(agent('a', 1, { state: 'working', stateSince: 0 }), 38_000)).toBe('WORKING 38 S');
  });

  it('tells about waiting mail and edits that need a restart', () => {
    expect(panelDetails(agent('a', 1))).toEqual([]);
    expect(panelDetails(agent('a', 1, { queued: 2, dirty: true }))).toEqual(['2 messages waiting', 'Restart to apply the changes you saved.']);
    expect(panelDetails(agent('a', 1, { queued: 2, held: { kind: 'draft', text: 'held: draft' } }))).toEqual(['held: draft']);
  });
});

describe('mission', () => {
  const brief = (id: string, at: number, extra: Partial<ActivityItem> = {}): ActivityItem => item(id, 'user', 'flight', at, extra);

  it('is the latest message from the Director to the boss that is not a poll, by its subject', () => {
    const activity = [
      brief('m3', 300, { subject: 'T-minus: go/no-go poll' }),
      brief('m2', 200, { subject: 'Add CSV export' }),
      item('m1x', 'user', 'ana', 150, { subject: 'for ana' }),
      brief('m1', 100, { subject: 'older' }),
    ];
    expect(missionOf(activity, 'flight')).toEqual({ text: 'Add CSV export', at: 200 });
  });

  it('takes the first line of the body when the subject says nothing', () => {
    expect(missionOf([brief('m', 5, { subject: 'Brief', body: '\n  Add CSV export\nmore' })], 'flight')?.text).toBe('Add CSV export');
    expect(missionOf([brief('m', 5, { subject: '', body: 'Do it' })], 'flight')?.text).toBe('Do it');
  });

  it('is none without a brief, without a boss, or when only agents wrote', () => {
    expect(missionOf([], 'flight')).toBeNull();
    expect(missionOf([brief('m', 5)], null)).toBeNull();
    expect(missionOf([item('m', 'ana', 'flight', 5)], 'flight')).toBeNull();
    expect(missionOf([brief('m', 5, { subject: 'T-minus: x' })], 'flight')).toBeNull();
  });

  it('counts the clock as HH:MM:SS and never below zero', () => {
    expect(clockText(0)).toBe('00:00:00');
    expect(clockText(10 * 60_000 + 42_999)).toBe('00:10:42');
    expect(clockText(3_661_000)).toBe('01:01:01');
    expect(clockText(100 * 3_600_000)).toBe('100:00:00');
    expect(clockText(-5000)).toBe('00:00:00');
  });

  it('shows the time of the brief as HH:MM', () => {
    expect(briefedText(Date.now())).toMatch(/^\d\d:\d\d$/);
  });
});

describe('sequence', () => {
  const NOW = 10_000_000;
  const T0 = NOW - HISTORY_WINDOW_MS;
  const at = (fraction: number): number => T0 + fraction * HISTORY_WINDOW_MS;
  const history = (...rows: Array<[StateChange['state'], number]>): StateChange[] => rows.map(([state, f]) => ({ state, at: at(f) }));

  it('draws working spans and needs-you spans in percent of the window', () => {
    const spans = sequenceSpans({ provider: 'claude', history: history(['idle', 0.1], ['working', 0.3], ['idle', 0.5], ['needs_you', 0.7]) }, NOW);
    expect(spans).toEqual([
      { kind: 'work', from: 30, to: 50 },
      { kind: 'needs', from: 70, to: 100 },
    ]);
  });

  it('cuts the entry before the window at the left edge', () => {
    const spans = sequenceSpans({ provider: 'claude', history: [{ state: 'working', at: T0 - 5_000 }, { state: 'idle', at: at(0.25) }] }, NOW);
    expect(spans).toEqual([{ kind: 'work', from: 0, to: 25 }]);
  });

  it('draws a custom agent working in its own colour and nothing for idle, starting or stopped', () => {
    expect(sequenceSpans({ provider: 'custom', history: history(['working', 0.5]) }, NOW)).toEqual([{ kind: 'custom', from: 50, to: 100 }]);
    expect(sequenceSpans({ provider: 'claude', history: history(['starting', 0], ['idle', 0.2], ['stopped', 0.6]) }, NOW)).toEqual([]);
    expect(sequenceSpans({ provider: 'claude', history: [] }, NOW)).toEqual([]);
  });

  it('ignores an entry in the future (a browser clock behind the server)', () => {
    expect(sequenceSpans({ provider: 'claude', history: [{ state: 'working', at: NOW + 5_000 }] }, NOW)).toEqual([]);
  });

  it('says who works and who needs the Director, for how long', () => {
    const legends = legendsOf(seat([agent('g', 1, { position: 'guido' }), agent('c', 2, { position: 'control' }), agent('s', 3, { position: 'surgeon' })]));
    const list = [agent('g', 1, { state: 'working' }), agent('c', 2, { state: 'working' }), agent('s', 3, { state: 'needs_you', stateSince: 0 })];
    expect(sequenceLabel(list, legends, 180_000)).toBe('GUIDO and CONTROL are working now; SURGEON has needed you for 3 m');
    expect(sequenceLabel([agent('g', 1, { state: 'working' })], legends, 0)).toBe('GUIDO is working now');
    expect(sequenceLabel([agent('g', 1)], legends, 0)).toBe('Nobody is working and nobody needs you');
  });
});

describe('T-minus', () => {
  it('words the poll and picks the colour of the wall', () => {
    expect(pollWord(null)).toEqual({ word: 'STANDBY', count: null, tone: 'none', ghost: true });
    expect(pollWord(poll())).toEqual({ word: 'POLLING', count: '1/2', tone: 'none', ghost: false });
    expect(pollWord(poll({ status: 'go' }))).toMatchObject({ word: 'GO', tone: 'go' });
    expect(pollWord(poll({ status: 'aborted' }))).toMatchObject({ word: 'ABORTED', tone: 'nogo' });
  });

  it('calls a hold with a no-go NO-GO (orange) and a hold the Director called HOLD (lit)', () => {
    const noGo = poll({ status: 'hold', entries: [{ agent: 'a', vote: 'no-go', reason: 'x', at: 1 }] });
    expect(pollWord(noGo)).toMatchObject({ word: 'NO-GO', tone: 'nogo' });
    expect(pollWord(poll({ status: 'hold' }))).toMatchObject({ word: 'HOLD', tone: 'lit' });
  });

  it('makes one chip per entry, with the call sign, and READY chips when there is no poll', () => {
    const list = [agent('flight', 0, { boss: true }), agent('f', 1, { position: 'fido' }), agent('ana', 2)];
    const legends = legendsOf(seat(list));
    expect(voteChips(poll({ entries: [{ agent: 'f', vote: 'go', reason: '', at: 1 }, { agent: 'ana', vote: 'no-go', reason: 'no', at: 2 }, { agent: 'x', vote: null, reason: '', at: null }] }), [], legends).map((c) => c.text)).toEqual([
      'FIDO GO',
      'ANA NO-GO',
      'X WAIT',
    ]);
    expect(voteChips(null, pollTargets(list), legends).map((c) => c.text)).toEqual(['FIDO READY', 'ANA READY']);
  });

  it('puts the reasons after the server note, and says who can be asked when there is no poll', () => {
    const legends = legendsOf(seat([agent('f', 1, { position: 'fido' })]));
    expect(noteLine(poll({ entries: [{ agent: 'f', vote: 'go', reason: 'fine', at: 1 }] }), [], legends)).toBe('waiting for ana · FIDO: fine');
    expect(noteLine(null, [agent('a', 1)], legends)).toBe('No poll. 1 console can be asked.');
    expect(noteLine(null, [agent('a', 1), agent('b', 2)], legends)).toBe('No poll. 2 consoles can be asked.');
    expect(noteLine(null, [], legends)).toMatch(/Nobody to ask/);
  });
});

describe('live region announcer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const facts = (agents: AgentView[], extra: { unread?: number; poll?: PollView | null; limit?: number | null } = {}) => ({
    agents,
    unread: extra.unread ?? 0,
    poll: extra.poll ?? null,
    limit: extra.limit ?? null,
  });

  function setup(): { writes: string[]; announcer: ReturnType<typeof createAnnouncer> } {
    vi.useFakeTimers();
    const writes: string[] = [];
    return { writes, announcer: createAnnouncer((t) => writes.push(t)) };
  }

  it('says nothing for the first list of agents: it is the page loading', () => {
    const { writes, announcer } = setup();
    announcer.update(facts([agent('a', 1, { state: 'needs_you' })], { unread: 3 }), {});
    vi.advanceTimersByTime(5_000);
    expect(writes).toEqual([]);
  });

  it('announces a console that starts needing the Director, with the reason', () => {
    const { writes, announcer } = setup();
    announcer.update(facts([agent('s', 1)]), { s: 'SURGEON' });
    announcer.update(facts([agent('s', 1, { state: 'needs_you', needsKind: 'permission', needsReason: 'permission request: Bash: ls' })]), { s: 'SURGEON' });
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(writes).toEqual(['SURGEON asks for a go: Bash: ls']);
  });

  it('does not announce every working and idle change', () => {
    const { writes, announcer } = setup();
    announcer.update(facts([agent('a', 1)]), {});
    announcer.update(facts([agent('a', 1, { state: 'working' })]), {});
    announcer.update(facts([agent('a', 1, { state: 'idle' })]), {});
    vi.advanceTimersByTime(5_000);
    expect(writes).toEqual([]);
  });

  it('announces a stop, more unread items in the Downlink, a poll result and a new Max Q limit, joined in one write', () => {
    const { writes, announcer } = setup();
    announcer.update(facts([agent('a', 1, { state: 'working' })]), {});
    announcer.update(facts([agent('a', 1, { state: 'stopped' })], { unread: 2, poll: poll({ status: 'go' }), limit: 3 }), {});
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(writes).toEqual(['A stopped. 2 unread in the Downlink. T-minus: GO. Max Q limit 3']);
  });

  it('waits the gap since the last write before the next one', () => {
    const { writes, announcer } = setup();
    announcer.update(facts([agent('a', 1)]), {});
    announcer.update(facts([agent('a', 1)], { unread: 1 }), {});
    vi.advanceTimersByTime(0);
    announcer.update(facts([agent('a', 1)], { unread: 2 }), {});
    expect(writes).toEqual(['1 unread in the Downlink']);
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(writes).toEqual(['1 unread in the Downlink', '2 unread in the Downlink']);
  });

  it('stops its pending write and resumes it', () => {
    const { writes, announcer } = setup();
    announcer.update(facts([agent('a', 1)]), {});
    announcer.update(facts([agent('a', 1)], { unread: 1 }), {});
    announcer.stop();
    vi.advanceTimersByTime(5_000);
    expect(writes).toEqual([]);
    announcer.resume();
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(writes).toEqual(['1 unread in the Downlink']);
  });
});
