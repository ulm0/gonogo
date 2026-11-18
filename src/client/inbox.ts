import type { DownlinkEventKind, DownlinkItem } from '../shared/protocol.js';

// What the Downlink shows and what its keys do, kept out of Downlink.tsx so that it can be tested without a DOM.

export const FILTERS = [
  { id: 'all', label: 'ALL' },
  { id: 'messages', label: 'MESSAGES' },
  { id: 'events', label: 'EVENTS' },
  { id: 'archived', label: 'ARCHIVED' },
] as const;
export type FilterId = (typeof FILTERS)[number]['id'];

/** ALL, MESSAGES and EVENTS are the inbox: what was archived is only in ARCHIVED. */
const MATCHES: Record<FilterId, (item: DownlinkItem) => boolean> = {
  all: (item) => !item.archived,
  messages: (item) => item.type === 'message' && !item.archived,
  events: (item) => item.type === 'event' && !item.archived,
  archived: (item) => item.archived,
};

/**
 * Unread first, then read; each group keeps the order of the list, which is newest first. An id in `stay` was read while
 * the page was up and keeps its place with the unread ones, so a message that is opened does not jump away from under the hand.
 */
export function filterItems(items: readonly DownlinkItem[], filter: FilterId, stay: ReadonlySet<string> = new Set()): DownlinkItem[] {
  const rows = items.filter(MATCHES[filter]);
  const first = (item: DownlinkItem): boolean => !item.read || stay.has(item.id);
  return [...rows.filter(first), ...rows.filter((item) => !first(item))];
}

export function filterCounts(items: readonly DownlinkItem[]): Record<FilterId, number> {
  const counts: Record<FilterId, number> = { all: 0, messages: 0, events: 0, archived: 0 };
  for (const item of items) for (const { id } of FILTERS) if (MATCHES[id](item)) counts[id] += 1;
  return counts;
}

/** The chip of an event: the part of the room it comes from, and how loud it is. */
export const EVENT_CHIPS: Readonly<Record<DownlinkEventKind, { text: string; tone: 'amber' | 'nogo' | 'quiet' }>> = {
  redline: { text: 'REDLINE', tone: 'nogo' },
  tminus: { text: 'T-MINUS', tone: 'amber' },
  'launch-window': { text: 'LAUNCH WINDOW', tone: 'amber' },
  uplink: { text: 'UPLINK', tone: 'amber' },
  'flight-plan': { text: 'FLIGHT PLAN', tone: 'quiet' },
  livery: { text: 'LIVERY', tone: 'quiet' },
  relief: { text: 'RELIEF', tone: 'amber' },
  permission: { text: 'PERMISSION', tone: 'amber' },
  mission: { text: 'MISSION', tone: 'quiet' },
  review: { text: 'REVIEW', tone: 'quiet' },
};

export const unreadText = (n: number): string => `${n} unread`;

/** The id of the row that carries the keyboard, in the page. */
export const rowId = (id: string): string => `dl-${id}`;

/** The row that j (down) or k (up) reaches from `from`; at an end it stays; with no row yet j takes the first and k the last. */
export function stepId(ids: readonly string[], from: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = from === null ? -1 : ids.indexOf(from);
  if (at < 0) return (step === 1 ? ids[0] : ids[ids.length - 1]) ?? null;
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))] ?? null;
}

/** Where the keyboard goes when a row leaves the list (archived): the row that takes its place, else the one before it. */
export function afterLeaving(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id);
  return at < 0 ? null : (ids[at + 1] ?? ids[at - 1] ?? null);
}

export type KeyAction = 'next' | 'previous' | 'archive' | 'reply';
const KEYS: Readonly<Record<string, KeyAction>> = { j: 'next', k: 'previous', e: 'archive', r: 'reply' };

/** What a key asks for. Never a key with Ctrl, Cmd or Alt held, and never while the person types in a field. */
export function keyAction(key: string, modified: boolean, typing: boolean): KeyAction | null {
  if (modified || typing || !Object.hasOwn(KEYS, key)) return null;
  return KEYS[key] ?? null;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "14:03" for today, "Nov 16 14:03" for another day. An `at` outside the range of a Date reads "--:--" and cannot take the page down. */
export function whenText(at: number, now: number): string {
  try {
    const time = timeFormat.format(at);
    return new Date(at).toDateString() === new Date(now).toDateString() ? time : `${dayFormat.format(at)} ${time}`;
  } catch {
    return '--:--';
  }
}
