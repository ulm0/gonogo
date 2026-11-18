import { DEFAULT_LIVERY } from '../shared/livery.js';
import type { AgentView, LiveryView, PollView, PropellantView } from '../shared/protocol.js';
import type { ClientState } from './store.js';
import { readStored, writeStored } from './store.js';
import { pollButtons, pollTargets } from './wall.js';

// The Patch Panel (the command bar) and Commissioning (the first-run checklist), kept out of the .tsx files so that the tests can run them.

/* ---- Patch Panel ---- */

export type View = ClientState['view'];

/** What a line of the Patch Panel does. The page maps each kind to a store or api call that already exists. */
export type Act =
  | { kind: 'console'; name: string }
  | { kind: 'view'; view: View }
  | { kind: 'hire' }
  | { kind: 'brief' }
  | { kind: 'poll' }
  | { kind: 'read' }
  | { kind: 'livery'; slug: string };

export interface Command {
  id: string;
  label: string;
  group: 'Console' | 'View' | 'Action';
  /** More words that match but are not shown, such as an agent's own name under its call sign. */
  also: string;
  act: Act;
}

export const VIEW_NAMES: Record<View, string> = {
  room: 'Room',
  loop: 'Loop',
  downlink: 'Downlink',
  window: 'Launch Window',
  plan: 'Flight Plan',
  log: 'Mission Log',
  livery: 'Livery',
  rules: 'Flight Rules',
};

export interface CommandInput {
  /** In the order of the room. */
  agents: readonly AgentView[];
  legends: Readonly<Record<string, string>>;
  poll: PollView | null;
  unread: number;
  livery: LiveryView;
}

/** Every line the panel may show now: only actions the page has, and only when they can run (a poll needs somebody to poll). */
export function commands({ agents, legends, poll, unread, livery }: CommandInput): Command[] {
  const out: Command[] = [];
  for (const a of agents) {
    const legend = Object.hasOwn(legends, a.name) ? legends[a.name] : a.name.toUpperCase();
    out.push({ id: `console:${a.name}`, label: `Open ${legend}`, group: 'Console', also: `${a.name} console terminal`, act: { kind: 'console', name: a.name } });
  }
  for (const view of Object.keys(VIEW_NAMES) as View[]) {
    out.push({ id: `view:${view}`, label: VIEW_NAMES[view], group: 'View', also: view === 'rules' ? 'settings' : '', act: { kind: 'view', view } });
  }
  out.push({ id: 'hire', label: 'Staff a console', group: 'Action', also: 'hire new agent', act: { kind: 'hire' } });
  if (agents.some((a) => a.boss)) out.push({ id: 'brief', label: 'Brief FLIGHT', group: 'Action', also: 'mission message', act: { kind: 'brief' } });
  if (pollButtons(poll).includes('poll') && pollTargets(agents).length > 0) {
    out.push({ id: 'poll', label: 'Start a T-minus poll', group: 'Action', also: 'go no-go', act: { kind: 'poll' } });
  }
  if (unread > 0) out.push({ id: 'read', label: 'Mark the Downlink read', group: 'Action', also: 'inbox all', act: { kind: 'read' } });
  for (const l of livery.liveries) {
    if (l.slug !== livery.current) out.push({ id: `livery:${l.slug}`, label: `Apply livery ${l.name}`, group: 'Action', also: 'theme look', act: { kind: 'livery', slug: l.slug } });
  }
  return out;
}

/**
 * How well a query matches a text: null when its letters are not in the text in order, else the cost (lower is better). A letter
 * that follows the last one costs nothing, one at the start of a word costs 1, any other costs the letters skipped plus 2.
 */
export function fuzzyCost(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  let cost = 0;
  let at = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, at + 1);
    if (i < 0) return null;
    if (i !== at + 1) cost += i === 0 || /[^a-z0-9]/.test(t[i - 1] as string) ? 1 : i - at + 1;
    at = i;
  }
  return cost;
}

/** The lines that match, best first; equal ones keep the panel's order. A match in the hidden words costs 3 more than the same in the label. */
export function matchCommands(list: readonly Command[], query: string): Command[] {
  if (query.trim() === '') return [...list];
  const scored: { c: Command; cost: number; i: number }[] = [];
  list.forEach((c, i) => {
    const costs = [fuzzyCost(query, c.label), c.also === '' ? null : fuzzyCost(query, c.also)].map((x, k) => (x === null ? Infinity : x + k * 3));
    const cost = Math.min(...costs);
    if (cost !== Infinity) scored.push({ c, cost, i });
  });
  return scored.sort((a, b) => a.cost - b.cost || a.i - b.i).map((s) => s.c);
}

/** Cmd+K on a Mac, Ctrl+K elsewhere (both work everywhere). Ctrl+K typed in a terminal stays there: xterm takes it first. */
export const isPanelKey = (e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean =>
  e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;

/** The next option for an arrow key, wrapping at both ends; -1 when there is none. */
export function stepIndex(current: number, count: number, key: string): number {
  if (count === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  return (((current + step) % count) + count) % count;
}

/* ---- Commissioning ---- */

/**
 * What this browser remembers of the checklist: that it was put away, that the security note was read, that the Livery was
 * opened from it. Per browser, not on the server: it is a convenience (like the selected console), it needs no new state file
 * and no migration, and a second device that shows it once more costs one press of Put away.
 */
export const COMMISSIONING_STORAGE_KEY = 'gonogo.commissioning';
export type Mark = 'away' | 'note' | 'livery';
const MARKS: readonly Mark[] = ['away', 'note', 'livery'];

export function readMarks(text: string | null): Set<Mark> {
  try {
    const value: unknown = text === null ? [] : JSON.parse(text);
    return new Set(Array.isArray(value) ? MARKS.filter((m) => value.includes(m)) : []);
  } catch {
    return new Set();
  }
}

export const loadMarks = (): Set<Mark> => readMarks(readStored(COMMISSIONING_STORAGE_KEY));
export const saveMarks = (marks: ReadonlySet<Mark>): void => writeStored(COMMISSIONING_STORAGE_KEY, marks.size === 0 ? null : JSON.stringify([...marks]));

/** Shown on an empty room (FLIGHT is created at the first start, so empty means nobody else), until it is put away. */
export const showCommissioning = (agents: readonly AgentView[], marks: ReadonlySet<Mark>): boolean => !marks.has('away') && agents.every((a) => a.boss);

export interface Step {
  id: 'flight' | 'propellant' | 'livery' | 'note';
  done: boolean;
}

/** The four steps, in order. FLIGHT is staffed once it is up and past its startup questions. */
export function commissioningSteps(agents: readonly AgentView[], propellant: PropellantView, livery: LiveryView, marks: ReadonlySet<Mark>): Step[] {
  const boss = agents.find((a) => a.boss);
  return [
    { id: 'flight', done: boss !== undefined && (boss.state === 'idle' || boss.state === 'working') },
    { id: 'propellant', done: Object.keys(propellant.room.limits).length > 0 },
    { id: 'livery', done: livery.current !== DEFAULT_LIVERY || marks.has('livery') },
    { id: 'note', done: marks.has('note') },
  ];
}
