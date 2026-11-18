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
  ScheduleView,
  ServerFrame,
  ServerInfo,
  StateSnapshot,
  Task,
  UplinkView,
} from '../shared/protocol.js';
import { defaultView } from '../shared/livery.js';
import { ACTIVITY_CLIENT_MAX, ENVELOPE_KEEP_MS } from '../shared/protocol.js';
import { NO_LOG_NEWS } from './log.js';
import type { LogNews } from './log.js';

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
  /** Which full view is up when no form is: the room, the comm loop, Launch Window, the Flight Plan, the Downlink, the Mission Log or the Livery. */
  view: 'room' | 'loop' | 'window' | 'plan' | 'downlink' | 'log' | 'livery' | 'hangar' | 'recorder';
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
  /** Downlink: the Director's inbox. The server keeps what is read, so every browser shows the same. */
  downlink: DownlinkView;
  /** Mission Log: what the last frame said. The entries are not here; the view asks for them again when `rev` changes. */
  log: LogNews;
  /** Livery: the look every device shows and the liveries to choose from. The server keeps the choice. */
  livery: LiveryView;
  /** Docking: this station's name and the stations docked with it. */
  docking: DockingView;
}

export interface Store {
  getState(): ClientState;
  setState(next: ClientState | ((s: ClientState) => ClientState)): void;
  subscribe(listener: () => void): () => void;
}

export const SELECTED_STORAGE_KEY = 'gonogo.selected';

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
export const NO_PROPELLANT: PropellantView = { room: { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: {} }, agents: {} };
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
    consoleOpen: false,
    envelopes: [],
    poll: null,
    governor: NO_GOVERNOR,
    propellant: NO_PROPELLANT,
    schedules: [],
    uplinks: [],
    tasks: [],
    downlink: NO_DOWNLINK,
    log: NO_LOG_NEWS,
    livery: defaultView(),
    docking: NO_DOCKING,
  };
}

export const store: Store = createStore({
  ...emptyState(),
  selected: readStored(SELECTED_STORAGE_KEY),
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
export const showLoop = (): void => store.setState((s) => ({ ...s, view: 'loop', consoleOpen: false }));
export const showWindow = (): void => store.setState((s) => ({ ...s, view: 'window', consoleOpen: false }));
export const showPlan = (): void => store.setState((s) => ({ ...s, view: 'plan', consoleOpen: false }));
export const showDownlink = (): void => store.setState((s) => ({ ...s, view: 'downlink', consoleOpen: false }));
export const showLog = (): void => store.setState((s) => ({ ...s, view: 'log', consoleOpen: false }));
export const showLivery = (): void => store.setState((s) => ({ ...s, view: 'livery', consoleOpen: false }));
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
    downlink: snapshot.downlink ?? NO_DOWNLINK,
    // an older server sends no livery: the page then shows the default look
    livery: snapshot.livery ?? defaultView(),
    // an older server, or one without Docking, sends none
    docking: snapshot.docking ?? NO_DOCKING,
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
    case 'downlink':
      return { ...s, downlink: frame.downlink };
    case 'livery':
      return { ...s, livery: frame.livery };
    case 'docking':
      return { ...s, docking: frame.docking };
    case 'log':
      return { ...s, log: { rev: s.log.rev + 1, changed: frame.changed, removed: frame.removed } };
    default:
      return s;
  }
}
