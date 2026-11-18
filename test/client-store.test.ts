import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityItem,
  AgentView,
  ExitSummary,
  DownlinkView,
  GovernorView,
  PollView,
  ServerFrame,
  ScheduleView,
  Task,
  UplinkView,
  ServerInfo,
  StateSnapshot,
} from '../src/shared/protocol.js';
import { ACTIVITY_CLIENT_MAX, AGENT_NAME_PATTERN, ENVELOPE_KEEP_MS } from '../src/shared/protocol.js';
import {
  applyServerFrame,
  createStore,
  emptyState,
  isLoading,
  pruneEnvelopes,
  readStored,
  closeConsole,
  openConsole,
  openEdit,
  openHire,
  showBlackBox,
  showBoard,
  showLivery,
  showLog,
  showLoop,
  showParty,
  showRoom,
  showPlan,
  showWindow,
  sortOrder,
  store,
  writeStored,
} from '../src/client/store.js';
import type { ClientState } from '../src/client/store.js';
import { briefSentText, displayName, plainActivityNote, stoppedCardDetail } from '../src/client/wording.js';
import { choosePosition, editRequest, hireRequest, suggestName, validate } from '../src/client/form.js';
import type { Values } from '../src/client/form.js';
import { POSITION_IDS, positionById } from '../src/shared/positions.js';
import {
  gaugeSegments,
  governorSummary,
  pollButtons,
  pollTargets,
  stepLimit,
} from '../src/client/wall.js';

const INFO: ServerInfo = {
  protocol: 1,
  version: '0.1.0',
  cwd: '/work',
  home: '/home/x/.gonogo',
  host: '127.0.0.1',
  port: 7777,
  seed: false,
  agentCmd: null,
  maxHops: 8,
  startedAt: 1,
  installed: ['claude', 'custom'],
  timeZone: 'UTC',
};

function agent(name: string, desk: number, extra: Partial<AgentView> = {}): AgentView {
  return {
    name,
    role: 'a role',
    dir: '/work',
    mode: 'default',
    desk,
    boss: desk === 0,
    state: 'idle',
    stateSince: 1,
    needsKind: null,
    needsReason: null,
    needSeq: null,
    remoteControl: null,
    permissions: null,
    autostart: true,
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
    history: [],
    ...extra,
  };
}

function item(id: string, from: string, to: string, at: number, extra: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    from,
    to,
    subject: 'subject',
    body: 'body',
    inReplyTo: null,
    hops: 1,
    at,
    status: 'queued',
    note: null,
    updatedAt: at,
    truncated: false,
    ...extra,
  };
}

const OFF: GovernorView = { limit: null, working: 0, holding: 0 };
const snapshot = (agents: AgentView[], activity: ActivityItem[] = []): StateSnapshot => ({
  agents,
  activity,
  info: INFO,
  poll: null,
  governor: OFF,
  propellant: { room: { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: {} }, agents: {}, cost: { room: { usd: { '5h': 0, day: 0, week: 0, month: 0 }, unpriced: { '5h': 0, day: 0, week: 0, month: 0 }, budget: {} }, agents: {}, days: [], pricedSince: null } },
  schedules: [],
  uplinks: [],
  tasks: [],
  downlink: { unread: 0, items: [] },
});
const stateFrame = (agents: AgentView[], activity: ActivityItem[] = []): ServerFrame => ({
  t: 'state',
  state: snapshot(agents, activity),
});

function run(frames: ServerFrame[], from: ClientState = emptyState(), now = 1_000): ClientState {
  return frames.reduce((s, frame) => applyServerFrame(s, frame, now), from);
}

/** A state with flight (desk 0), ana (1) and ben (2) and nothing selected yet. */
function office(): ClientState {
  return run([stateFrame([agent('flight', 0), agent('ana', 1), agent('ben', 2)])]);
}

describe('sortOrder', () => {
  it('sorts by desk, the boss (desk 0) first, and by name for the same desk', () => {
    const agents = Object.fromEntries([agent('zed', 3), agent('ana', 1), agent('flight', 0), agent('amy', 1)].map((a) => [a.name, a]));
    expect(sortOrder(agents)).toEqual(['flight', 'amy', 'ana', 'zed']);
  });
});

describe('state frame', () => {
  it('replaces info, agents, order and activity wholesale', () => {
    const before = run([stateFrame([agent('flight', 0), agent('ana', 1)], [item('m1', 'ana', 'flight', 10)])]);
    const after = run(
      [stateFrame([agent('flight', 0, { state: 'working' }), agent('ben', 2)], [item('m2', 'flight', 'ben', 20)])],
      before,
    );
    expect(after.info).toEqual(INFO);
    expect(Object.keys(after.agents).sort()).toEqual(['ben', 'flight']);
    expect(after.agents.flight?.state).toBe('working');
    expect(after.order).toEqual(['flight', 'ben']);
    expect(after.activity.map((i) => i.id)).toEqual(['m2']);
  });

  it('keeps the selection when that agent still exists, else falls back to the boss, else the first agent, else null', () => {
    const selected = { ...office(), selected: 'ben' };
    expect(run([stateFrame([agent('flight', 0), agent('ben', 2)])], selected).selected).toBe('ben');
    expect(run([stateFrame([agent('flight', 0), agent('ana', 1)])], selected).selected).toBe('flight');
    // No boss in the roster: the first by desk.
    expect(run([stateFrame([agent('zed', 5, { boss: false }), agent('ana', 3, { boss: false })])], selected).selected).toBe('ana');
    expect(run([stateFrame([])], selected).selected).toBeNull();
    // The remembered name from a previous visit is not an agent any more.
    expect(run([stateFrame([agent('flight', 0)])], { ...emptyState(), selected: 'gone' }).selected).toBe('flight');
  });

  it('creates no envelopes from the activity it carries', () => {
    const history = [item('m1', 'ana', 'flight', 10), item('m2', 'flight', 'ana', 20)];
    const s = run([stateFrame([agent('flight', 0), agent('ana', 1)], history)]);
    expect(s.envelopes).toEqual([]);
  });

  it('keeps the same order array when the order did not change', () => {
    const before = office();
    const after = run([stateFrame([agent('flight', 0, { state: 'working' }), agent('ana', 1), agent('ben', 2)])], before);
    expect(after.order).toBe(before.order);
  });

  it('keeps activity newest first with unique ids, at most ACTIVITY_CLIENT_MAX', () => {
    const many = Array.from({ length: ACTIVITY_CLIENT_MAX + 25 }, (_, i) => item(`m${i}`, 'ana', 'flight', 1_000 + i));
    const s = run([stateFrame([agent('flight', 0)], [...many, item('m3', 'ana', 'flight', 1_003)])]);
    expect(s.activity).toHaveLength(ACTIVITY_CLIENT_MAX);
    expect(s.activity[0]?.id).toBe(`m${ACTIVITY_CLIENT_MAX + 24}`);
    expect(new Set(s.activity.map((i) => i.id)).size).toBe(ACTIVITY_CLIENT_MAX);
    const times = s.activity.map((i) => i.at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('handles an agent called "constructor" (the agents record has no prototype)', () => {
    const s = run([stateFrame([agent('flight', 0), agent('constructor', 1)])]);
    expect(Object.hasOwn(s.agents, 'constructor')).toBe(true);
    expect(s.order).toEqual(['flight', 'constructor']);
    const removed = run([{ t: 'agent-removed', name: 'toString' }], s);
    expect(removed.order).toEqual(['flight', 'constructor']);
  });
});

describe('agent frame', () => {
  it('replaces the entry with the new object and leaves the previous state untouched', () => {
    const before = office();
    const next = agent('ana', 1, { state: 'working' });
    const after = run([{ t: 'agent', agent: next }], before);
    expect(after.agents.ana).toBe(next);
    expect(before.agents.ana?.state).toBe('idle');
    expect(after.agents).not.toBe(before.agents);
    expect(after.agents.ben).toBe(before.agents.ben);
  });

  it('keeps the order array when the name is known and the desk is the same', () => {
    const before = office();
    expect(run([{ t: 'agent', agent: agent('ana', 1, { state: 'needs_you' }) }], before).order).toBe(before.order);
  });

  it('recomputes the order for a new name and for a changed desk', () => {
    const before = office();
    const added = run([{ t: 'agent', agent: agent('cat', 3) }], before);
    expect(added.order).toEqual(['flight', 'ana', 'ben', 'cat']);
    const moved = run([{ t: 'agent', agent: agent('ana', 4) }], before);
    expect(moved.order).toEqual(['flight', 'ben', 'ana']);
  });

  it('selects the boss when nothing is selected, and leaves a selection alone', () => {
    expect(run([{ t: 'agent', agent: agent('flight', 0) }]).selected).toBe('flight');
    expect(run([{ t: 'agent', agent: agent('ana', 1) }], { ...office(), selected: 'ben' }).selected).toBe('ben');
    // A selection made before the agent's own frame arrived (the REST answer of a hire) is not overridden.
    expect(run([{ t: 'agent', agent: agent('ben', 2) }], { ...office(), selected: 'cat' }).selected).toBe('cat');
  });
});

describe('agent-removed frame', () => {
  it('deletes the agent and its place in the order', () => {
    const after = run([{ t: 'agent-removed', name: 'ana' }], office());
    expect(Object.keys(after.agents).sort()).toEqual(['ben', 'flight']);
    expect(after.order).toEqual(['flight', 'ben']);
  });

  it('moves the selection to the boss when the selected agent was removed, else keeps it', () => {
    expect(run([{ t: 'agent-removed', name: 'ana' }], { ...office(), selected: 'ana' }).selected).toBe('flight');
    expect(run([{ t: 'agent-removed', name: 'ana' }], { ...office(), selected: 'ben' }).selected).toBe('ben');
  });

  it('leaves the state alone for a name it does not know', () => {
    const before = office();
    expect(run([{ t: 'agent-removed', name: 'nobody' }], before)).toBe(before);
  });

  it('shows a rename as agent-removed for the old name, then agent for the new one', () => {
    const before = { ...office(), selected: 'ana' };
    const after = run([{ t: 'agent-removed', name: 'ana' }, { t: 'agent', agent: agent('anna', 1) }], before);
    expect(Object.keys(after.agents).sort()).toEqual(['anna', 'ben', 'flight']);
    expect(after.order).toEqual(['flight', 'anna', 'ben']);
    // The form selects the new name after its REST answer; until then the boss is selected.
    expect(after.selected).toBe('flight');
  });
});

describe('activity frame', () => {
  it('inserts a new item newest first and keeps the list ordered by time', () => {
    let s = office();
    s = run([{ t: 'activity', item: item('m1', 'ana', 'ben', 100) }, { t: 'activity', item: item('m3', 'ana', 'ben', 300) }], s);
    s = run([{ t: 'activity', item: item('m2', 'ben', 'ana', 200) }], s);
    expect(s.activity.map((i) => i.id)).toEqual(['m3', 'm2', 'm1']);
  });

  it('replaces the item with the same id in place, and makes no second envelope for it', () => {
    let s = run([{ t: 'activity', item: item('m1', 'ana', 'ben', 100) }], office(), 1_000);
    expect(s.envelopes).toHaveLength(1);
    s = run([{ t: 'activity', item: item('m1', 'ana', 'ben', 100, { status: 'read', updatedAt: 150 }) }], s, 1_100);
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0]?.status).toBe('read');
    expect(s.envelopes).toHaveLength(1);
  });

  it('caps the list at ACTIVITY_CLIENT_MAX and ignores an item older than everything in a full list', () => {
    const full = Array.from({ length: ACTIVITY_CLIENT_MAX }, (_, i) => item(`m${i}`, 'ana', 'ben', 10_000 + i));
    let s = run([stateFrame([agent('flight', 0), agent('ana', 1), agent('ben', 2)], full)]);
    s = run([{ t: 'activity', item: item('new', 'ana', 'ben', 20_000) }], s);
    expect(s.activity).toHaveLength(ACTIVITY_CLIENT_MAX);
    expect(s.activity[0]?.id).toBe('new');
    expect(s.activity.some((i) => i.id === 'm0')).toBe(false);
    const envelopesBefore = s.envelopes.length;
    // A status change of an item that was already cut from the list must not come back or fly again.
    s = run([{ t: 'activity', item: item('m0', 'ana', 'ben', 10_000, { status: 'read' }) }], s);
    expect(s.activity.some((i) => i.id === 'm0')).toBe(false);
    expect(s.envelopes).toHaveLength(envelopesBefore);
  });

  describe('envelopes', () => {
    it('adds one for a new id between two known names, with the frame time', () => {
      const s = run([{ t: 'activity', item: item('m1', 'ana', 'ben', 100) }], office(), 5_000);
      expect(s.envelopes).toEqual([{ id: 'm1', from: 'ana', to: 'ben', startedAt: 5_000 }]);
    });

    it('treats user as a known name, on either side', () => {
      let s = run([{ t: 'activity', item: item('m1', 'user', 'flight', 100) }], office(), 5_000);
      s = run([{ t: 'activity', item: item('m2', 'ana', 'user', 200, { status: 'to_user' }) }], s, 5_000);
      expect(s.envelopes.map((e) => `${e.from}>${e.to}`)).toEqual(['user>flight', 'ana>user']);
    });

    it('adds none for undelivered, for the same sender and recipient, or for a name that is not on the floor', () => {
      let s = office();
      s = run([{ t: 'activity', item: item('m1', 'ana', 'ben', 100, { status: 'undelivered' }) }], s);
      s = run([{ t: 'activity', item: item('m2', 'ana', 'ana', 110) }], s);
      s = run([{ t: 'activity', item: item('m3', 'ghost', 'ben', 120) }], s);
      s = run([{ t: 'activity', item: item('m4', 'ana', 'ghost', 130) }], s);
      expect(s.envelopes).toEqual([]);
      expect(s.activity).toHaveLength(4);
    });

    it('drops envelopes older than ENVELOPE_KEEP_MS on every kind of frame', () => {
      const flying = run([{ t: 'activity', item: item('m1', 'ana', 'ben', 100) }], office(), 1_000);
      expect(flying.envelopes).toHaveLength(1);
      const later = 1_000 + ENVELOPE_KEEP_MS;
      const frames: ServerFrame[] = [
        { t: 'activity', item: item('m2', 'ben', 'ana', 200, { status: 'undelivered' }) },
        { t: 'agent', agent: agent('ana', 1) },
        { t: 'agent-removed', name: 'ben' },
        stateFrame([agent('flight', 0)]),
      ];
      for (const frame of frames) expect(applyServerFrame(flying, frame, later).envelopes).toEqual([]);
      expect(applyServerFrame(flying, frames[0] as ServerFrame, later - 1).envelopes).toHaveLength(1);
    });
  });
});

describe('pruneEnvelopes', () => {
  it('returns the same state when nothing is old enough to drop', () => {
    const s = run([{ t: 'activity', item: item('m1', 'ana', 'ben', 100) }], office(), 1_000);
    expect(pruneEnvelopes(s, 1_000 + ENVELOPE_KEEP_MS - 1)).toBe(s);
    expect(pruneEnvelopes(s, 1_000 + ENVELOPE_KEEP_MS).envelopes).toEqual([]);
  });
});

describe('frames the store does not handle', () => {
  it('leaves the state object alone for size, snapshot and error frames, and for an unknown frame', () => {
    const s = office();
    const frames = [
      { t: 'size', agent: 'ana', cols: 100, rows: 30 },
      { t: 'snapshot', seq: 1, agent: 'ana', generation: 1, cols: 100, rows: 30, running: true, data: '' },
      { t: 'error', message: 'bad frame', ref: 'frame' },
      { t: 'something-new' },
    ] as unknown as ServerFrame[];
    for (const frame of frames) expect(applyServerFrame(s, frame, 9_999)).toBe(s);
  });
});

describe('rollout (the update note)', () => {
  const view = (over = {}) => ({ enabled: true, current: '0.1.1', latest: '0.2.0', checkedAt: 5, newer: true, command: 'pnpm add -g @ulm0/gonogo@latest', ...over });

  it('starts with none, takes the view of the state, and replaces it with each rollout frame', () => {
    expect(emptyState().rollout).toBeNull();
    const first = run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), rollout: view() } }]);
    expect(first.rollout).toEqual(view());
    const later = run([{ t: 'rollout', rollout: view({ latest: '0.3.0' }) }], first);
    expect(later.rollout?.latest).toBe('0.3.0');
  });

  it('carries the progress of an update from the page with the rest of the view, frame by frame', () => {
    const running = run([{ t: 'rollout', rollout: view({ install: 'npm', canUpdate: true, update: { state: 'running', version: '0.2.0', note: 'Installing 0.2.0…', tail: [], rollback: null } }) }]);
    expect(running.rollout?.update?.state).toBe('running');
    const done = run([{ t: 'rollout', rollout: view({ install: 'npm', canUpdate: true, update: { state: 'reloading', version: '0.2.0', note: 'Reloading', tail: ['added 1 package'], rollback: 'npm install -g @ulm0/gonogo@0.1.1' } }) }], running);
    expect(done.rollout?.update).toMatchObject({ state: 'reloading', rollback: 'npm install -g @ulm0/gonogo@0.1.1' });
  });

  it('an older server sends none, and a state that has none drops the old view', () => {
    const { rollout: _none, ...older } = snapshot([agent('flight', 0)]);
    expect(run([{ t: 'state', state: older as StateSnapshot }]).rollout).toBeNull();
    const had = run([{ t: 'rollout', rollout: view() }]);
    expect(run([{ t: 'state', state: older as StateSnapshot }], had).rollout).toBeNull();
  });
});

describe('downlink', () => {
  const inbox = (unread: number): DownlinkView => ({
    unread,
    items: [{ type: 'event', id: 'e1', at: 5, kind: 'redline', text: 'ana: loop', read: unread === 0, archived: false }],
  });

  it('starts empty, takes the inbox of the state, and replaces it with each downlink frame', () => {
    expect(emptyState().downlink).toEqual({ unread: 0, items: [] });
    const first = run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), downlink: inbox(1) } }]);
    expect(first.downlink).toEqual(inbox(1));
    const read = run([{ t: 'downlink', downlink: inbox(0) }], first);
    expect(read.downlink.unread).toBe(0);
    expect(run([{ t: 'downlink', downlink: { unread: 0, items: [] } }], read).downlink.items).toEqual([]);
  });

  it('keeps an empty inbox when an older server sends none, and a reconnect state replaces the inbox', () => {
    const { downlink: _none, ...older } = snapshot([agent('flight', 0)]);
    const s = run([{ t: 'state', state: older as StateSnapshot }]);
    expect(s.downlink).toEqual({ unread: 0, items: [] });
    const full = run([{ t: 'downlink', downlink: inbox(1) }], s);
    expect(run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), downlink: inbox(0) } }], full).downlink.unread).toBe(0);
  });

  it('keeps no mail watermark in the browser any more', () => {
    expect(Object.keys(emptyState())).not.toContain('userMailSeenAt');
  });
});

describe('livery', () => {
  const dusk = { slug: 'dusk', name: 'Dusk', description: '', builtin: false, author: 'ana', tokens: { '--body': '#112233' } };

  it('starts with the four that ship and the default chosen, takes the livery of the state, and replaces it with each livery frame', () => {
    const start = emptyState().livery;
    expect(start.current).toBe('instrument');
    expect(start.liveries.map((e) => e.slug)).toEqual(['instrument', 'night-shift', 'low-ink', 'high-contrast']);
    const view = { current: 'dusk', liveries: [...start.liveries, dusk] };
    const first = run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), livery: view } }]);
    expect(first.livery).toBe(view);
    const chosen = run([{ t: 'livery', livery: { ...view, current: 'instrument' } }], first);
    expect(chosen.livery.current).toBe('instrument');
    expect(chosen.agents).toBe(first.agents);
  });

  it('shows the default when an older server sends none, and takes the choice of a reconnect', () => {
    const s = run([{ t: 'state', state: snapshot([agent('flight', 0)]) }]);
    expect(s.livery.current).toBe('instrument');
    const night = { current: 'night-shift', liveries: emptyState().livery.liveries };
    const on = run([{ t: 'livery', livery: night }], s);
    expect(run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), livery: night } }], on).livery.current).toBe('night-shift');
    expect(run([{ t: 'state', state: snapshot([agent('flight', 0)]) }], on).livery.current).toBe('instrument');
  });

  it('opens its own view, which leaves the console and the others', () => {
    store.setState({ ...emptyState(), view: 'log', consoleOpen: true });
    showLivery();
    expect(store.getState()).toMatchObject({ view: 'livery', consoleOpen: false });
  });
});

describe('docking', () => {
  const dock = { id: 'a'.repeat(32), name: 'lab', url: 'http://lab.test', since: 1, status: 'ok' as const, seenAt: 2, error: null, agents: [] };

  it('starts with no station, takes the docks of the state, and replaces them with each docking frame', () => {
    expect(emptyState().docking).toEqual({ station: '', docks: [] });
    const view = { station: 'home', docks: [dock] };
    const first = run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), docking: view } }]);
    expect(first.docking).toBe(view);
    const gone = run([{ t: 'docking', docking: { station: 'home', docks: [] } }], first);
    expect(gone.docking.docks).toEqual([]);
    expect(gone.agents).toBe(first.agents);
  });

  it('shows none when an older server or one without Docking sends none, and takes the docks of a reconnect', () => {
    const view = { station: 'home', docks: [dock] };
    const on = run([{ t: 'docking', docking: view }]);
    expect(run([{ t: 'state', state: snapshot([agent('flight', 0)]) }], on).docking).toEqual({ station: '', docks: [] });
    expect(run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), docking: view } }], on).docking).toBe(view);
  });
});

describe('createStore', () => {
  it('notifies subscribers on a change, not on the same state, and stops after unsubscribe', () => {
    const store = createStore(emptyState());
    const seen: string[] = [];
    const off = store.subscribe(() => seen.push(store.getState().connection));
    store.setState((s) => ({ ...s, connection: 'open' }));
    store.setState((s) => s);
    store.setState(store.getState());
    store.setState({ ...store.getState(), connection: 'reconnecting' });
    off();
    store.setState((s) => ({ ...s, connection: 'unauthorized' }));
    expect(seen).toEqual(['open', 'reconnecting']);
    expect(store.getState().connection).toBe('unauthorized');
  });

  it('lets a listener unsubscribe while it is being notified without skipping the next one', () => {
    const store = createStore(emptyState());
    const calls: string[] = [];
    const offFirst = store.subscribe(() => {
      calls.push('first');
      offFirst();
    });
    store.subscribe(() => calls.push('second'));
    store.setState((s) => ({ ...s, failedAttempts: 1 }));
    store.setState((s) => ({ ...s, failedAttempts: 2 }));
    expect(calls).toEqual(['first', 'second', 'second']);
  });
});

describe('stored values', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads and writes through localStorage, and removes a key on null', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    writeStored('k', 'v');
    expect(readStored('k')).toBe('v');
    writeStored('k', null);
    expect(readStored('k')).toBeNull();
  });

  it('works without storage, and when storage throws', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readStored('k')).toBeNull();
    expect(() => writeStored('k', 'v')).not.toThrow();
    const hostile = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('localStorage', hostile);
    expect(readStored('k')).toBeNull();
    expect(() => writeStored('k', 'v')).not.toThrow();
    expect(() => writeStored('k', null)).not.toThrow();
  });
});

describe('isLoading', () => {
  it('is true until the first state has arrived, and false from then on whatever the connection does', () => {
    expect(isLoading(emptyState())).toBe(true);
    // A page that has never reached the server has no office to show yet: reconnecting does not make it real.
    expect(isLoading({ ...emptyState(), connection: 'reconnecting', failedAttempts: 5 })).toBe(true);
    const loaded = office();
    expect(isLoading(loaded)).toBe(false);
    // What a reconnecting page holds is the real office: it stays live.
    expect(isLoading({ ...loaded, connection: 'reconnecting' })).toBe(false);
    expect(isLoading({ ...loaded, connection: 'connecting' })).toBe(false);
    // An office that was really loaded and is empty is not "loading".
    expect(isLoading(run([stateFrame([])]))).toBe(false);
  });
});

describe('briefSentText', () => {
  /** Every note of contract 5.8 that a send to an agent can return, with what the owner reads instead. */
  const plain: Array<[string, string]> = [
    ['waiting: flight is starting', 'Sent. flight is starting and will see it when ready.'],
    ['waiting: flight is working', 'Sent. flight is working and will see it when its turn ends.'],
    ['waiting: flight needs you', 'Sent. flight needs you first and will see it after you answer.'],
    ['waiting: about to type the pointer', 'Sent. flight will see it in a moment.'],
    ['waiting: flight is not ready for input', 'Sent. flight is not ready for input and will see it soon.'],
    ['waiting: flight is restarting', 'Sent. flight is restarting and will see it afterwards.'],
    ['waiting: confirming the pointer', 'Sent. flight will see it in a moment.'],
    ['waiting: flight has not read it yet', 'Sent. flight has not read it yet; gonogo will remind it.'],
    ["held: text in flight's input", "Sent. It waits until the text typed in flight's terminal is sent or cleared."],
    ['held: pointer not confirmed within 2 s', 'Sent. On hold: flight did not pick it up. Check its terminal.'],
    [
      'held: no hook has reached gonogo from flight; is its folder trusted?',
      'Sent. On hold: gonogo is not hearing from flight. Is its folder trusted?',
    ],
  ];

  it('says "Sent." and one plain sentence for each known note', () => {
    for (const [note, text] of plain) expect(briefSentText(note, 'flight')).toBe(text);
  });

  it('never shows the server words (pointer, hook, the waiting: and held: prefixes) for a known note', () => {
    for (const [note] of plain) expect(briefSentText(note, 'flight')).not.toMatch(/pointer|hook|waiting:|held:/);
  });

  it('names the boss that the box was given, whatever it is called', () => {
    expect(briefSentText('waiting: ana-2 is working', 'ana-2')).toBe('Sent. ana-2 is working and will see it when its turn ends.');
  });

  it('says only "Sent." when the server gave no note', () => {
    expect(briefSentText(null, 'flight')).toBe('Sent.');
  });

  it('falls back to a generic sentence for a note it does not know, without repeating that note', () => {
    expect(briefSentText('waiting: something the server learned later', 'flight')).toBe('Sent. flight will see it as soon as it can.');
    // A note about another agent than the one the box briefs is not one it knows either.
    expect(briefSentText('waiting: ben is working', 'flight')).toBe('Sent. flight will see it as soon as it can.');
  });
});

describe('stoppedCardDetail', () => {
  const exit = (text: string, requested = false): ExitSummary => ({ code: null, signal: null, at: 1, requested, text });

  it('adds nothing under "<name> is stopped" when the exit text only says "stopped" (a stop the owner asked for)', () => {
    expect(stoppedCardDetail(exit('stopped', true))).toBeNull();
    expect(stoppedCardDetail(null)).toBeNull();
    expect(stoppedCardDetail(exit(''))).toBeNull();
  });

  it('keeps what a crash, a kill or a failed start has to say', () => {
    for (const text of ['exited with code 1: No conversation found with session ID: x', 'killed by signal 9', 'could not start: spawn ENOENT']) {
      expect(stoppedCardDetail(exit(text))).toBe(text);
    }
  });
});

function poll(extra: Partial<PollView> = {}): PollView {
  return {
    id: 1,
    startedAt: 1,
    status: 'open',
    entries: [
      { agent: 'fido', vote: 'go', reason: 'fine', at: 2 },
      { agent: 'ana', vote: null, reason: '', at: null },
    ],
    note: 'waiting for ana',
    ...extra,
  };
}

describe('poll and governor frames', () => {
  it('starts without a poll and with the limit off', () => {
    const s = emptyState();
    expect(s.poll).toBeNull();
    expect(s.governor).toEqual(OFF);
  });

  it('keeps the poll of a poll frame, and null clears it', () => {
    const open = run([{ t: 'poll', poll: poll() }]);
    expect(open.poll?.status).toBe('open');
    expect(run([{ t: 'poll', poll: null }], open).poll).toBeNull();
  });

  it('keeps the governor of a governor frame', () => {
    const governor = { limit: 3, working: 2, holding: 1 };
    expect(run([{ t: 'governor', governor }]).governor).toEqual(governor);
  });

  it('takes the poll and the governor of a state frame wholesale', () => {
    const governor = { limit: 2, working: 0, holding: 0 };
    const frame: ServerFrame = { t: 'state', state: { ...snapshot([agent('flight', 0)]), poll: poll(), governor } };
    const s = run([frame]);
    expect(s.poll?.id).toBe(1);
    expect(s.governor).toEqual(governor);
    expect(run([stateFrame([agent('flight', 0)])], s).poll).toBeNull();
  });

  it('leaves the agents alone', () => {
    const before = office();
    expect(run([{ t: 'poll', poll: poll() }], before).agents).toBe(before.agents);
  });
});

describe('position to name', () => {
  it('suggests the id, then id-2, id-3 while taken', () => {
    expect(suggestName('fido', {})).toBe('fido');
    expect(suggestName('fido', { fido: 1 })).toBe('fido-2');
    expect(suggestName('fido', { fido: 1, 'fido-2': 1 })).toBe('fido-3');
  });

  it('keeps every suggestion within the name rules (positions are presets, not seats)', () => {
    for (const id of POSITION_IDS) {
      const taken = Object.fromEntries([id, ...Array.from({ length: 98 }, (_, i) => `${id}-${i + 2}`)].map((n) => [n, 1]));
      expect(suggestName(id, taken)).toBe(`${id}-100`);
      expect(suggestName(id, taken)).toMatch(new RegExp(AGENT_NAME_PATTERN));
    }
  });

  it('is not fooled by a taken name that is a property of Object.prototype', () => {
    expect(suggestName('constructor', {})).toBe('constructor');
  });
});

const VALUES: Values = {
  provider: 'claude',
  position: '',
  name: 'ana',
  role: ' does things ',
  dir: ' /work ',
  mode: 'default',
  confirm: false,
  command: '',
  servers: '',
  skills: '',
  cleanRoom: false,
  worktree: false,
  remoteControl: false,
  rules: '',
  autostart: true,
  model: '',
  keys: [],
  keysRemoved: [],
};

describe('choosePosition keeps what was typed', () => {
  it('keeps a typed name and role', () => {
    const typed = { ...VALUES, name: 'zed', role: 'my own role' };
    const next = choosePosition(typed, 'fido', {}, true);
    expect(next.name).toBe('zed');
    expect(next.role).toBe('my own role');
    expect(next.position).toBe('fido');
  });

  it('changes both when nothing was typed (FIDO then GUIDO)', () => {
    const first = choosePosition({ ...VALUES, name: '', role: '' }, 'fido', {}, true);
    const second = choosePosition(first, 'guido', {}, true);
    expect(second.name).toBe('guido');
    expect(second.role).toBe(positionById('guido')?.role);
    expect(second.role).not.toBe(first.role);
  });
});

describe('choosePosition', () => {
  it('fills the name and the default role when hiring', () => {
    const fido = positionById('fido');
    const next = choosePosition({ ...VALUES, name: '', role: '' }, 'fido', { fido: agent('fido', 1) }, true);
    expect(next).toMatchObject({ position: 'fido', name: 'fido-2', role: fido?.role });
  });

  it('fills only the role when editing, and "Custom role" changes nothing else', () => {
    const next = choosePosition({ ...VALUES, position: 'fido' }, 'guido', {}, false);
    expect(next).toMatchObject({ position: 'guido', name: 'ana' });
    expect(choosePosition(next, '', {}, true)).toEqual({ ...next, position: '' });
  });
});

describe('hire request body', () => {
  it('for Claude Code sends mode, provider and position, and the trimmed text', () => {
    expect(hireRequest({ ...VALUES, position: 'fido' })).toEqual({
      name: 'ana',
      role: 'does things',
      dir: '/work',
      mode: 'default',
      provider: 'claude',
      position: 'fido',
    });
  });

  it('sends confirmBypass only for bypassPermissions that was confirmed, and no position for a custom role', () => {
    const body = hireRequest({ ...VALUES, mode: 'bypassPermissions', confirm: true });
    expect(body).toMatchObject({ mode: 'bypassPermissions', confirmBypass: true });
    expect(body).not.toHaveProperty('position');
    expect(hireRequest(VALUES)).not.toHaveProperty('confirmBypass');
    expect(hireRequest({ ...VALUES, mode: 'auto', confirm: true })).toMatchObject({ mode: 'auto' });
    expect(hireRequest({ ...VALUES, mode: 'auto', confirm: true })).not.toHaveProperty('confirmBypass');
  });

  it('for a custom command sends the command, mode default, no position and no confirmBypass', () => {
    const body = hireRequest({ ...VALUES, provider: 'custom', command: ' htop ', position: 'fido', mode: 'bypassPermissions', confirm: true });
    expect(body).toEqual({ name: 'ana', role: 'does things', dir: '/work', mode: 'default', provider: 'custom', command: 'htop' });
  });
});

describe('edit request body', () => {
  const original = agent('ana', 1, { role: 'does things', dir: '/work', position: 'fido' });
  const same: Values = { ...VALUES, position: 'fido' };

  it('is null when nothing changed', () => {
    expect(editRequest(same, original, true)).toBeNull();
  });

  it('sends only what changed, a cleared position as null', () => {
    expect(editRequest({ ...same, position: 'guido' }, original, true)).toEqual({ position: 'guido' });
    expect(editRequest({ ...same, position: '' }, original, true)).toEqual({ position: null });
    expect(editRequest({ ...same, name: 'bob' }, original, false)).toEqual({ name: 'bob' });
    expect(editRequest({ ...same, name: 'bob' }, original, true)).toBeNull();
  });

  it('lets a custom agent change its command but never mode or position', () => {
    const custom = agent('top', 1, { provider: 'custom', command: 'htop', role: 'does things', dir: '/work' });
    const values: Values = { ...same, provider: 'custom', position: 'fido', mode: 'acceptEdits', command: ' top ' };
    expect(editRequest(values, custom, true)).toEqual({ command: 'top' });
    expect(editRequest({ ...values, command: 'htop' }, custom, true)).toBeNull();
  });
});

describe('hire form rules', () => {
  it('asks for a command from a custom agent and no permission confirmation', () => {
    const custom: Values = { ...VALUES, provider: 'custom', mode: 'bypassPermissions' };
    expect(validate(custom, {}, null, false)).toEqual({ command: 'A command is required.' });
    expect(validate({ ...custom, command: 'x'.repeat(1001) }, {}, null, false).command).toMatch(/At most/);
    expect(validate({ ...custom, command: 'htop' }, {}, null, false)).toEqual({});
    for (const bad of ['[', '[1]', '[]', '["a", ""]', '["a",', 'a\0b']) {
      expect(validate({ ...custom, command: bad }, {}, null, false).command, bad).toBeDefined();
    }
    expect(validate({ ...custom, command: '["node", "x.js"]' }, {}, null, false)).toEqual({});
    expect(validate({ ...custom, command: '[' }, {}, null, false).command).toBe('Not a valid JSON array of strings.');
  });

  it('still asks a Claude Code agent in bypassPermissions to confirm, but not one in auto', () => {
    expect(validate({ ...VALUES, mode: 'bypassPermissions' }, {}, null, false).confirmBypass).toBeDefined();
    expect(validate({ ...VALUES, mode: 'auto' }, {}, null, false).confirmBypass).toBeUndefined();
  });
});

describe('poll buttons and targets', () => {
  it('offers the buttons of each status', () => {
    expect(pollButtons(null)).toEqual(['poll']);
    expect(pollButtons(poll())).toEqual(['hold', 'abort']);
    expect(pollButtons(poll({ status: 'hold' }))).toEqual(['abort', 'clear']);
    expect(pollButtons(poll({ status: 'go' }))).toEqual(['clear']);
    expect(pollButtons(poll({ status: 'aborted' }))).toEqual(['clear']);
  });

  it('polls running claude agents except the boss', () => {
    const list = [
      agent('flight', 0),
      agent('a', 1),
      agent('b', 2, { state: 'stopped' }),
      agent('c', 3, { provider: 'custom' }),
      agent('d', 4, { transition: 'stopping' }),
    ];
    expect(pollTargets(list).map((a) => a.name)).toEqual(['a']);
  });
});

describe('Max Q gauge', () => {
  it('draws one segment per slot of the limit, lit for the agents working', () => {
    expect(gaugeSegments({ limit: 4, working: 1, holding: 0 })).toEqual({ total: 4, filled: 1, full: false, over: false });
    expect(gaugeSegments({ limit: 2, working: 2, holding: 1 })).toEqual({ total: 2, filled: 2, full: true, over: false });
    expect(gaugeSegments({ limit: 2, working: 3, holding: 0 })).toEqual({ total: 2, filled: 2, full: true, over: true });
    expect(gaugeSegments({ limit: null, working: 3, holding: 0 })).toEqual({ total: 0, filled: 0, full: false, over: false });
  });

  it('steps the limit within 1 to MAX_AGENTS, and plus from off starts at the number working', () => {
    expect(stepLimit({ limit: 3, working: 0, holding: 0 }, 'minus')).toBe(2);
    expect(stepLimit({ limit: 1, working: 0, holding: 0 }, 'minus')).toBeNull();
    expect(stepLimit(OFF, 'minus')).toBeNull();
    expect(stepLimit({ limit: 3, working: 0, holding: 0 }, 'plus')).toBe(4);
    expect(stepLimit({ limit: 24, working: 0, holding: 0 }, 'plus')).toBeNull();
    expect(stepLimit({ ...OFF, working: 5 }, 'plus')).toBe(5);
    expect(stepLimit(OFF, 'plus')).toBe(1);
  });

  it('announces the limit and what waits, not the working count', () => {
    expect(governorSummary(OFF)).toBe('Max Q off');
    expect(governorSummary({ limit: 3, working: 2, holding: 1 })).toBe('Max Q limit 3, holding 1');
  });
});

describe('words of the room', () => {
  it('shows the wire name user as Director', () => {
    expect(displayName('user')).toBe('Director');
    expect(displayName('fido')).toBe('fido');
  });

  it('words the load-limit note and leaves other notes as they came', () => {
    expect(plainActivityNote('waiting: load limit (3 of 3 agents working)')).toBe('waiting for Max Q: 3 of 3 agents working');
    expect(plainActivityNote('waiting: ana is working')).toBe('waiting: ana is working');
  });
});

describe('navigation of the shell', () => {
  afterEach(() => store.setState(emptyState()));

  it('opens a console: selects it, opens it full screen and shows the room', () => {
    store.setState({ ...emptyState(), view: 'loop' });
    openConsole('ana');
    expect(store.getState()).toMatchObject({ selected: 'ana', consoleOpen: true, view: 'room' });
    closeConsole();
    expect(store.getState().consoleOpen).toBe(false);
    expect(store.getState().selected).toBe('ana');
  });

  it('closing a console that is not open changes nothing', () => {
    const before = store.getState();
    closeConsole();
    expect(store.getState()).toBe(before);
  });

  it('switches between the room and the loop, and a screen switch closes the console', () => {
    openConsole('ana');
    showLoop();
    expect(store.getState()).toMatchObject({ view: 'loop', consoleOpen: false });
    showRoom();
    expect(store.getState().view).toBe('room');
  });

  it('opens Launch Window and leaves a console that was open', () => {
    openConsole('ana');
    showWindow();
    expect(store.getState()).toMatchObject({ view: 'window', consoleOpen: false });
  });

  it('opens Flight Plan and leaves a console that was open', () => {
    openConsole('ana');
    showPlan();
    expect(store.getState()).toMatchObject({ view: 'plan', consoleOpen: false });
  });

  it('opens the Mission Log and leaves a console that was open', () => {
    openConsole('ana');
    showLog();
    expect(store.getState()).toMatchObject({ view: 'log', consoleOpen: false });
  });

  it('opens Party Line and leaves a console that was open', () => {
    openConsole('ana');
    showParty();
    expect(store.getState()).toMatchObject({ view: 'party', consoleOpen: false });
  });

  it('opens the Plot Board and the Black Box and leaves a console that was open', () => {
    openConsole('ana');
    showBoard();
    expect(store.getState()).toMatchObject({ view: 'board', consoleOpen: false });
    openConsole('ana');
    showBlackBox();
    expect(store.getState()).toMatchObject({ view: 'blackbox', consoleOpen: false });
    showRoom();
    expect(store.getState().view).toBe('room');
  });

  it('opens the staffing screen from a seat, from the spare seat and for an edit', () => {
    openHire('fido');
    expect(store.getState().form).toEqual({ mode: 'hire', position: 'fido' });
    openHire();
    expect(store.getState().form).toEqual({ mode: 'hire', position: null });
    openEdit('ana');
    expect(store.getState().form).toEqual({ mode: 'edit', name: 'ana' });
  });
});

describe('Launch Window frames', () => {
  const schedule: ScheduleView = {
    id: 's1',
    name: 'Standup',
    to: 'ana',
    subject: '',
    body: 'Status?',
    rule: '0 9 * * *',
    enabled: true,
    createdAt: 1,
    lastRunAt: null,
    lastResult: null,
    nextAt: 5,
  };

  it('takes the list from the state and replaces it at every schedules frame, an empty one included', () => {
    const withOne = run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), schedules: [schedule] } }]);
    expect(withOne.schedules).toEqual([schedule]);
    const changed = run([{ t: 'schedules', schedules: [{ ...schedule, enabled: false, nextAt: null }] }], withOne);
    expect(changed.schedules).toEqual([{ ...schedule, enabled: false, nextAt: null }]);
    expect(run([{ t: 'schedules', schedules: [] }], changed).schedules).toEqual([]);
  });

  it('shows none for a server that sends none', () => {
    const old = { ...snapshot([agent('flight', 0)]) } as Partial<StateSnapshot>;
    delete old.schedules;
    expect(run([{ t: 'state', state: old as StateSnapshot }]).schedules).toEqual([]);
  });
});

describe('Uplink frames', () => {
  const uplink: UplinkView = { id: 'u1', name: 'GitHub', kind: 'generic', to: 'ana', enabled: true, createdAt: 1, deliveries: [{ at: 2, status: 'queued', note: 'm1' }] };

  it('takes the list from the state and replaces it at every uplinks frame, an empty one included', () => {
    const withOne = run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), uplinks: [uplink] } }]);
    expect(withOne.uplinks).toEqual([uplink]);
    const changed = run([{ t: 'uplinks', uplinks: [{ ...uplink, enabled: false }] }], withOne);
    expect(changed.uplinks).toEqual([{ ...uplink, enabled: false }]);
    expect(run([{ t: 'uplinks', uplinks: [] }], changed).uplinks).toEqual([]);
  });

  it('shows none for a server that sends none', () => {
    const old = { ...snapshot([agent('flight', 0)]) } as Partial<StateSnapshot>;
    delete old.uplinks;
    expect(run([{ t: 'state', state: old as StateSnapshot }]).uplinks).toEqual([]);
  });
});

describe('Flight Plan frames', () => {
  const task: Task = { id: 't1', title: 'Write the spec', detail: '', status: 'todo', assignee: null, createdBy: 'user', createdAt: 1, updatedAt: 1, notes: [] };

  it('takes the list from the state and replaces it at every tasks frame, an empty one included', () => {
    const withOne = run([{ t: 'state', state: { ...snapshot([agent('flight', 0)]), tasks: [task] } }]);
    expect(withOne.tasks).toEqual([task]);
    const changed = run([{ t: 'tasks', tasks: [{ ...task, status: 'doing' }] }], withOne);
    expect(changed.tasks).toEqual([{ ...task, status: 'doing' }]);
    expect(run([{ t: 'tasks', tasks: [] }], changed).tasks).toEqual([]);
  });

  it('shows none for a server that sends none', () => {
    const old = { ...snapshot([agent('flight', 0)]) } as Partial<StateSnapshot>;
    delete old.tasks;
    expect(run([{ t: 'state', state: old as StateSnapshot }]).tasks).toEqual([]);
  });
});

describe('Mission Log frames', () => {
  it('counts the frames and keeps what the last one said; a state counts too, since frames may have been missed', () => {
    expect(emptyState().log).toEqual({ rev: 0, changed: [], removed: [] });
    const first = run([{ t: 'log', changed: [{ id: 'l1', title: 'Cache key' }], removed: [] }]);
    expect(first.log).toEqual({ rev: 1, changed: [{ id: 'l1', title: 'Cache key' }], removed: [] });
    const second = run([{ t: 'log', changed: [], removed: ['l1'] }], first);
    expect(second.log).toEqual({ rev: 2, changed: [], removed: ['l1'] });
    expect(run([{ t: 'state', state: snapshot([agent('flight', 0)]) }], second).log).toEqual({ rev: 3, changed: [], removed: [] });
  });
});
