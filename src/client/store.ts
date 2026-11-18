import { useSyncExternalStore } from 'react';
import type {
  ActivityItem,
  AgentView,
  DockingView,
  DownlinkView,
  Envelope,
  GovernorView,
  LiveryView,
  PollView,
  PropellantView,
  ReliefRequest,
  RolloutView,
  ScheduleView,
  ServerFrame,
  ServerInfo,
  StateSnapshot,
  Mission,
  RoomView,
  TabNameView,
  Task,
  UplinkView,
} from '../shared/protocol.js';
import { defaultView } from '../shared/livery.js';
import { ACTIVITY_CLIENT_MAX, ENVELOPE_KEEP_MS } from '../shared/protocol.js';
import { NO_LOG_NEWS } from './log.js';
import type { LogNews } from './log.js';
import { publishModelDefaults } from './models.js';

export interface ClientState {
  connection: 'connecting' | 'open' | 'reconnecting' | 'unauthorized';
  /** Consecutive failed reconnects; >= RECONNECT_SERVER_GONE_AFTER means "server gone". */
  failedAttempts: number;
  info: ServerInfo | null;
  /** By name. Built without a prototype: an agent may be called "constructor". */
  agents: Record<string, AgentView>;
  /** Names sorted by desk ascending; the same array while the order does not change. */
  order: string[];
  /** Newest first, unique ids, at most ACTIVITY_CLIENT_MAX. */
  activity: ActivityItem[];
  selected: string | null;
  /** The staffing screen. A hire may start from an open seat (its position) or as a custom command. */
  form: null | { mode: 'hire'; position?: string | null; custom?: boolean } | { mode: 'edit'; name: string };
  /** Which full view is up when no form is: the room, the comm loop, Launch Window, the Flight Plan, the Downlink, the Mission Log, the Livery, the Flight Rules, Party Line, the Plot Board, the Black Box, the Hangar or the Recorder. */
  view: 'room' | 'comms' | 'window' | 'plan' | 'log' | 'livery' | 'rules' | 'missions' | 'board' | 'blackbox' | 'hangar' | 'recorder';
  /** Comms: which tab is up (INBOX the Downlink, TRAFFIC the Loop, THREADS Party Line), and the agent the traffic is filtered to, if any. */
  commsTab: CommsTab;
  commsAgent: string | null;
  /** Phone only: a console is open full screen over the room. A wide page ignores it (the selected console is always in its side panel). */
  consoleOpen: boolean;
  /** Transient message animations (Envelope lives in protocol.ts so that this file needs no .tsx). */
  envelopes: Envelope[];
  /** T-minus: the one poll the server keeps, or null. */
  poll: PollView | null;
  /** Max Q: the working limit and the counts. */
  governor: GovernorView;
  /** Propellant: token use and limits of the room and of each agent. */
  propellant: PropellantView;
  /** Launch Window: the schedules, with the next fire of each. */
  schedules: ScheduleView[];
  /** Uplink: the webhooks and their recent deliveries (never a secret). */
  uplinks: UplinkView[];
  /** Flight Plan: every task of the board, in the order they were made. */
  tasks: Task[];
  /** Missions: every mission, in the order they were made. */
  missions: Mission[];
  /** Room editor: the saved layout of the Room view (`layout: null` is today's page) and its revision. */
  room: RoomView;
  /** Tab name: what the title of the tab says of this room. */
  tabName: TabNameView;
  /** Room editor: the Director is editing a draft of the layout. */
  editingRoom: boolean;
  /** The mission whose detail the Missions view shows, or null for the list. */
  selectedMission: string | null;
  /** The Missions view opens on a new-mission form with these fields (from the Patch Panel or the brief box), or null. */
  missionDraft: { name: string; goal: string } | null;
  /** Downlink: the Director's inbox. The server keeps what is read, so every browser shows the same. */
  downlink: DownlinkView;
  /** Mission Log: what the last frame said. The entries are not here; the view asks for them again when `rev` changes. */
  log: LogNews;
  /** Livery: the look every device shows and the liveries to choose from. The server keeps the choice. */
  livery: LiveryView;
  /** Docking: this station's name and the stations docked with it. */
  docking: DockingView;
  /** Relief: the hire requests of the boss that wait for the Director's GO. */
  relief: ReliefRequest[];
  /** Feature toggles: the ids of the features that are off (src/shared/features.ts). The server refuses them too. */
  features: string[];
  /** Rollout: what the daily update check saw, or null from an older server. */
  rollout: RolloutView | null;
}

export interface Store {
  getState(): ClientState;
  setState(next: ClientState | ((s: ClientState) => ClientState)): void;
  subscribe(listener: () => void): () => void;
}

export const SELECTED_STORAGE_KEY = 'gonogo.selected';
export const COMMS_TAB_STORAGE_KEY = 'gonogo.commsTab';

export const COMMS_TABS = ['inbox', 'traffic', 'threads'] as const;
export type CommsTab = (typeof COMMS_TABS)[number];

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage throws or is missing (private window, blocked site data, Node in the tests); the page must work without it. */
function storage(): KeyValueStorage | null {
  try {
    const candidate: unknown = Reflect.get(globalThis, 'localStorage');
    return candidate !== null && typeof candidate === 'object' ? (candidate as KeyValueStorage) : null;
  } catch {
    return null;
  }
}

export function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** A null value removes the key. A failed write is dropped: what is stored is only a convenience. */
export function writeStored(key: string, value: string | null): void {
  try {
    const s = storage();
    if (s === null) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Storage only remembers conveniences (the selected tab): a lost write costs nothing.
  }
}

export function createStore(initial: ClientState): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(next) {
      const value = typeof next === 'function' ? next(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      // A copy, so that a listener that unsubscribes while we notify cannot skip its neighbour.
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const NO_GOVERNOR: GovernorView = { limit: null, working: 0, holding: 0 };
const NO_WINDOWS = { '5h': 0, day: 0, week: 0, month: 0 };
export const NO_PROPELLANT: PropellantView = {
  room: { used: { ...NO_WINDOWS }, limits: {} },
  agents: {},
  cost: { room: { usd: { ...NO_WINDOWS }, unpriced: { ...NO_WINDOWS }, budget: {} }, agents: {}, days: [], pricedSince: null },
};
/** No saved layout: the page is as it always was. */
export const NO_ROOM: RoomView = { rev: 0, layout: null };
export const NO_DOWNLINK: DownlinkView = { unread: 0, items: [] };
export const NO_DOCKING: DockingView = { station: '', docks: [] };

export function emptyState(): ClientState {
  return {
    connection: 'connecting',
    failedAttempts: 0,
    info: null,
    agents: Object.create(null),
    order: [],
    activity: [],
    selected: null,
    form: null,
    view: 'room',
    commsTab: 'inbox',
    commsAgent: null,
    consoleOpen: false,
    envelopes: [],
    poll: null,
    governor: NO_GOVERNOR,
    propellant: NO_PROPELLANT,
    schedules: [],
    uplinks: [],
    tasks: [],
    missions: [],
    room: NO_ROOM,
    tabName: { name: null, fallback: null },
    editingRoom: false,
    selectedMission: null,
    missionDraft: null,
    downlink: NO_DOWNLINK,
    log: NO_LOG_NEWS,
    livery: defaultView(),
    docking: NO_DOCKING,
    relief: [],
    features: [],
    rollout: null,
  };
}

export const store: Store = createStore({
  ...emptyState(),
  selected: readStored(SELECTED_STORAGE_KEY),
  commsTab: ((t) => (COMMS_TABS as readonly string[]).includes(t ?? '') ? (t as CommsTab) : 'inbox')(readStored(COMMS_TAB_STORAGE_KEY)),
});

// Persisting here, not in the components, keeps every writer of `selected` covered.
const persisted = { selected: store.getState().selected };
store.subscribe(() => {
  const { selected } = store.getState();
  if (selected !== persisted.selected) {
    persisted.selected = selected;
    writeStored(SELECTED_STORAGE_KEY, selected);
  }
});

/* ---- navigation: every way the page changes what it shows goes through here ---- */

export const selectAgent = (name: string): void => store.setState((s) => (s.selected === name ? s : { ...s, selected: name }));
export const openConsole = (name: string): void => store.setState((s) => ({ ...s, selected: name, consoleOpen: true, view: 'room' }));
export const closeConsole = (): void => store.setState((s) => (s.consoleOpen ? { ...s, consoleOpen: false } : s));
export const showRoom = (): void => store.setState((s) => ({ ...s, view: 'room', consoleOpen: false }));
/** COMMS: one view with three tabs. With no tab it opens the one the Director used last (kept in this browser). A tab chosen in the bar is remembered; the shortcuts below only open it. */
export const showComms = (tab?: CommsTab, agent: string | null = null): void => store.setState((s) => ({
    ...s,
    view: 'comms',
    // asked for no tab (the top bar, the phone bar): what waits for the Director first, else the tab used last, and no agent filter left over
    commsTab: tab ?? (s.downlink.unread > 0 ? 'inbox' : s.commsTab),
    commsAgent: tab === undefined ? null : tab === 'traffic' ? agent : s.commsAgent,
    consoleOpen: false,
  }));
export const chooseCommsTab = (tab: CommsTab): void => {
  writeStored(COMMS_TAB_STORAGE_KEY, tab);
  store.setState((s) => ({ ...s, commsTab: tab }));
};
export const setCommsAgent = (agent: string | null): void => store.setState((s) => ({ ...s, commsAgent: agent }));
/** The old views, now tabs of COMMS: they keep their names so that the callers do not change. */
export const showLoop = (): void => showComms('traffic');
/** The console's "Comm loop" link: TRAFFIC filtered to that agent. */
export const showTraffic = (agent: string): void => showComms('traffic', agent);
export const showDownlink = (): void => showComms('inbox');
export const showParty = (): void => showComms('threads');
export const showWindow = (): void => store.setState((s) => ({ ...s, view: 'window', consoleOpen: false }));
export const showPlan = (): void => store.setState((s) => ({ ...s, view: 'plan', consoleOpen: false }));
export const showLog = (): void => store.setState((s) => ({ ...s, view: 'log', consoleOpen: false }));
export const showLivery = (): void => store.setState((s) => ({ ...s, view: 'livery', consoleOpen: false }));
export const showRules = (): void => store.setState((s) => ({ ...s, view: 'rules', consoleOpen: false }));
/** Starts or ends editing the room: the draft itself lives in the editor. */
export const setEditingRoom = (editing: boolean): void => store.setState((s) => (s.editingRoom === editing ? s : { ...s, editingRoom: editing, view: editing ? 'room' : s.view, consoleOpen: false }));
export const showMissions = (): void => store.setState((s) => ({ ...s, view: 'missions', consoleOpen: false, missionDraft: null }));
/** Opens the Missions view on its New mission form; `draft` fills it (the brief box does). */
export const openNewMission = (draft: { name: string; goal: string } = { name: '', goal: '' }): void =>
  store.setState((s) => ({ ...s, view: 'missions', consoleOpen: false, selectedMission: null, missionDraft: draft }));
export const selectMission = (id: string | null): void => store.setState((s) => ({ ...s, selectedMission: id, missionDraft: null }));
export const showBoard = (): void => store.setState((s) => ({ ...s, view: 'board', consoleOpen: false }));
export const showBlackBox = (): void => store.setState((s) => ({ ...s, view: 'blackbox', consoleOpen: false }));
/** Hangar and Recorder work on the selected console; opened from it, they follow `selected`. */
export const showHangar = (): void => store.setState((s) => ({ ...s, view: 'hangar', consoleOpen: false }));
export const showRecorder = (): void => store.setState((s) => ({ ...s, view: 'recorder', consoleOpen: false }));
export const openHangar = (name: string): void => store.setState((s) => ({ ...s, selected: name, view: 'hangar', consoleOpen: false }));
export const openRecorder = (name: string): void => store.setState((s) => ({ ...s, selected: name, view: 'recorder', consoleOpen: false }));
export const selectConsole = (name: string): void => store.setState((s) => (s.selected === name ? s : { ...s, selected: name }));
/** An open seat passes its position; the spare seat passes none. */
export const openHire = (position: string | null = null): void => store.setState((s) => ({ ...s, form: { mode: 'hire', position } }));
export const openEdit = (name: string): void => store.setState((s) => ({ ...s, form: { mode: 'edit', name } }));

/** No state has arrived yet, so the office is not known: the page must not draw it empty or offer to hire into it. Reconnecting is not loading: what the page holds then is real. */
export const isLoading = (s: ClientState): boolean => s.info === null;

/**
 * One clock for every ticking text of the page (the mission time, the time in state): a single interval that runs only
 * while something is subscribed. Browser time: the mission clock is the plain difference to the server's `at`, correct on one machine and off by the clock offset on a remote one.
 */
let nowValue = Date.now();
let nowTimer: ReturnType<typeof setInterval> | undefined;
const nowListeners = new Set<() => void>();

function subscribeNow(listener: () => void): () => void {
  nowListeners.add(listener);
  if (nowTimer === undefined) {
    nowValue = Date.now();
    nowTimer = setInterval(() => {
      nowValue = Date.now();
      for (const l of [...nowListeners]) l();
    }, 1000);
  }
  return () => {
    nowListeners.delete(listener);
    if (nowListeners.size === 0) {
      clearInterval(nowTimer);
      nowTimer = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribeNow, () => nowValue, () => nowValue);
}

/** The selector must return a stable reference while the state it reads is unchanged (never build an array or object in it). */
/** Is a feature on (Flight Rules, FEATURES)? The server enforces the same list, so a hidden key is also a refused route. */
export const useFeature = (id: string): boolean => useStore((s) => !s.features.includes(id));

export function useStore<T>(selector: (s: ClientState) => T): T {
  const read = (): T => selector(store.getState());
  // The third argument is what a render without a DOM (server rendering) reads; the browser never uses it.
  return useSyncExternalStore(store.subscribe, read, read);
}

export function sortOrder(agents: Record<string, AgentView>): string[] {
  return Object.keys(agents).sort((a, b) => {
    const byDesk = (agents[a]?.desk ?? 0) - (agents[b]?.desk ?? 0);
    if (byDesk !== 0) return byDesk;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function recordOf(agents: Iterable<AgentView>): Record<string, AgentView> {
  const record: Record<string, AgentView> = Object.create(null);
  for (const agent of agents) record[agent.name] = agent;
  return record;
}

function withAgent(agents: Record<string, AgentView>, agent: AgentView): Record<string, AgentView> {
  const record = recordOf(Object.values(agents));
  record[agent.name] = agent;
  return record;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The boss, else the first agent: where the selection falls back to. */
function fallbackSelection(agents: Record<string, AgentView>, order: readonly string[]): string | null {
  return order.find((name) => agents[name]?.boss === true) ?? order[0] ?? null;
}

function normalizeActivity(items: readonly ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const item of [...items].sort((a, b) => b.at - a.at)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length === ACTIVITY_CLIENT_MAX) break;
  }
  return out;
}

function pruned(envelopes: Envelope[], now: number): Envelope[] {
  const kept = envelopes.filter((e) => now - e.startedAt < ENVELOPE_KEEP_MS);
  return kept.length === envelopes.length ? envelopes : kept;
}

/** Drops the envelopes whose animation is over; the same state object when there is none. */
export function pruneEnvelopes(s: ClientState, now: number): ClientState {
  const envelopes = pruned(s.envelopes, now);
  return envelopes === s.envelopes ? s : { ...s, envelopes };
}

function applyState(s: ClientState, snapshot: StateSnapshot, now: number): ClientState {
  const agents = recordOf(snapshot.agents);
  const sorted = sortOrder(agents);
  const order = sameList(s.order, sorted) ? s.order : sorted;
  const selected = s.selected !== null && Object.hasOwn(agents, s.selected) ? s.selected : fallbackSelection(agents, order);
  return {
    ...s,
    info: snapshot.info,
    agents,
    order,
    activity: normalizeActivity(snapshot.activity),
    selected,
    envelopes: pruned(s.envelopes, now),
    poll: snapshot.poll,
    governor: snapshot.governor,
    // an older server sends no propellant, schedules, uplinks, tasks or downlink
    propellant: snapshot.propellant ?? NO_PROPELLANT,
    schedules: snapshot.schedules ?? [],
    uplinks: snapshot.uplinks ?? [],
    tasks: snapshot.tasks ?? [],
    // an older server sends no missions
    missions: snapshot.missions ?? [],
    // an older server sends no room
    room: snapshot.room ?? NO_ROOM,
    tabName: snapshot.tabName ?? { name: null, fallback: null },
    downlink: snapshot.downlink ?? NO_DOWNLINK,
    // an older server sends no livery: the page then shows the default look
    livery: snapshot.livery ?? defaultView(),
    // an older server, or one without Docking, sends none
    docking: snapshot.docking ?? NO_DOCKING,
    // an older server, or one without Relief, sends none
    relief: snapshot.relief?.requests ?? [],
    // an older server sends none: every feature is on
    features: snapshot.features?.off ?? [],
    rollout: snapshot.rollout ?? null,
    // a state is a connect or a reconnect: frames may have been missed, so the view asks again
    log: { rev: s.log.rev + 1, changed: [], removed: [] },
  };
}

function applyAgent(s: ClientState, agent: AgentView, now: number): ClientState {
  const previous = Object.hasOwn(s.agents, agent.name) ? s.agents[agent.name] : undefined;
  const agents = withAgent(s.agents, agent);
  const order = previous === undefined || previous.desk !== agent.desk ? sortOrder(agents) : s.order;
  return {
    ...s,
    agents,
    order: sameList(s.order, order) ? s.order : order,
    selected: s.selected ?? fallbackSelection(agents, order),
    envelopes: pruned(s.envelopes, now),
  };
}

function applyRemoved(s: ClientState, name: string, now: number): ClientState {
  if (!Object.hasOwn(s.agents, name)) return pruneEnvelopes(s, now);
  const agents = recordOf(Object.values(s.agents).filter((a) => a.name !== name));
  const order = s.order.filter((n) => n !== name);
  return {
    ...s,
    agents,
    order,
    selected: s.selected === name ? fallbackSelection(agents, order) : s.selected,
    envelopes: pruned(s.envelopes, now),
  };
}

function takesAnEnvelope(agents: Record<string, AgentView>, item: ActivityItem): boolean {
  const known = (name: string): boolean => name === 'user' || Object.hasOwn(agents, name);
  return item.status !== 'undelivered' && item.from !== item.to && known(item.from) && known(item.to);
}

function applyActivity(s: ClientState, item: ActivityItem, now: number): ClientState {
  const index = s.activity.findIndex((existing) => existing.id === item.id);
  const envelopes = pruned(s.envelopes, now);
  if (index >= 0 && s.activity[index]?.at === item.at) {
    const activity = s.activity.slice();
    activity[index] = item;
    return { ...s, activity, envelopes };
  }
  const rest = index >= 0 ? s.activity.filter((_, i) => i !== index) : s.activity;
  const at = rest.findIndex((existing) => existing.at <= item.at);
  const position = at < 0 ? rest.length : at;
  const activity = [...rest.slice(0, position), item, ...rest.slice(position)].slice(0, ACTIVITY_CLIENT_MAX);
  // An id the frame only re-inserts (a status change of an item that was cut from the list) must not fly again.
  const isNew = index < 0 && position < ACTIVITY_CLIENT_MAX;
  return {
    ...s,
    activity,
    envelopes:
      isNew && takesAnEnvelope(s.agents, item)
        ? [...envelopes, { id: item.id, from: item.from, to: item.to, startedAt: now }]
        : envelopes,
  };
}

/** `size`, `snapshot` and `error` frames belong to the terminal pane (api.ts hands them over); they leave the state alone. */
export function applyServerFrame(s: ClientState, frame: ServerFrame, now: number): ClientState {
  switch (frame.t) {
    case 'state':
      return applyState(s, frame.state, now);
    case 'agent':
      return applyAgent(s, frame.agent, now);
    case 'agent-removed':
      return applyRemoved(s, frame.name, now);
    case 'activity':
      return applyActivity(s, frame.item, now);
    case 'poll':
      return { ...s, poll: frame.poll };
    case 'governor':
      return { ...s, governor: frame.governor };
    case 'propellant':
      return { ...s, propellant: frame.propellant };
    case 'schedules':
      return { ...s, schedules: frame.schedules };
    case 'uplinks':
      return { ...s, uplinks: frame.uplinks };
    case 'tasks':
      return { ...s, tasks: frame.tasks };
    case 'missions':
      return { ...s, missions: frame.missions };
    case 'room':
      return { ...s, room: frame.room };
    case 'tabname':
      return { ...s, tabName: frame.tabName };
    case 'downlink':
      return { ...s, downlink: frame.downlink };
    case 'livery':
      return { ...s, livery: frame.livery };
    case 'docking':
      return { ...s, docking: frame.docking };
    case 'relief':
      return { ...s, relief: frame.relief.requests };
    case 'features':
      return { ...s, features: frame.features.off };
    case 'rollout':
      return { ...s, rollout: frame.rollout };
    case 'models':
      publishModelDefaults(frame.models);
      return s;
    case 'log':
      return { ...s, log: { rev: s.log.rev + 1, changed: frame.changed, removed: frame.removed } };
    default:
      return s;
  }
}
