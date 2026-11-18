/**
 * Browser notifications (docs/features/notifications.md): the Director misses a message when the gonogo tab is not the one in front.
 * This file is the logic with no browser in it: what is news (a new unread message to the Director, a T-minus poll that wants a call,
 * a Relief request), what one notification says (the sender and subject in the title, a short snippet in the body, because a
 * notification can show on a lock screen) and when one is shown (the tab hidden or not focused, the setting on, permission given).
 * `startNotifications` (notify-browser.ts) joins it to the page.
 */
import type { ClientState } from './store.js';

/** One notification: `tag` makes a burst from one sender replace itself, so one agent gives one notification. */
export interface Notice {
  tag: string;
  title: string;
  body: string;
  /** Where a click goes: the Downlink, or the room (a poll and a Relief request are in the room). */
  open: 'downlink' | 'room';
}

export const SNIPPET_CHARS = 80;
export const TITLE_CHARS = 100;

const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
export const cut = (text: string, max: number): string => {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What the page remembers between two states so that it tells each thing once. */
export interface Seen {
  /** Ids of messages already told or present when the page first knew the inbox. */
  messages: ReadonlySet<string>;
  /** `<poll id>:<status>` already told. */
  poll: string | null;
  relief: ReadonlySet<string>;
}

export const NOTHING_SEEN: Seen = { messages: new Set(), poll: null, relief: new Set() };

type Slice = Pick<ClientState, 'downlink' | 'poll' | 'relief'>;

const pollKey = (s: Slice): string | null => (s.poll === null ? null : `${s.poll.id}:${s.poll.status}`);

/** Everything that is in the state now, as the seen set: used for the first state, which is history and not news. */
export function seenIn(s: Slice): Seen {
  return {
    messages: new Set(s.downlink.items.filter((i) => i.type === 'message').map((i) => i.id)),
    poll: pollKey(s),
    relief: new Set(s.relief.map((r) => r.id)),
  };
}

/** The poll statuses that want the Director: a no-go that holds the poll, and a poll that came out go. Open and aborted need nothing. */
const POLL_NEWS = new Set(['hold', 'go']);

/** The notices the change from `seen` to `s` makes, and the new seen set. At most one for each sender, and one for the poll. */
export function noticesFor(seen: Seen, s: Slice): { notices: Notice[]; seen: Seen } {
  const notices: Notice[] = [];
  const bySender = new Map<string, Notice>();
  // newest first in the inbox: the first unread message of a sender is the one the notification shows
  for (const item of s.downlink.items) {
    if (item.type !== 'message' || seen.messages.has(item.id) || item.read || item.archived) continue;
    if (bySender.has(item.from)) continue;
    bySender.set(item.from, { tag: `gonogo-msg-${item.from}`, title: cut(`${item.from}: ${item.subject}`, TITLE_CHARS), body: cut(item.body, SNIPPET_CHARS), open: 'downlink' });
  }
  notices.push(...bySender.values());
  const key = pollKey(s);
  if (key !== null && key !== seen.poll && s.poll !== null && POLL_NEWS.has(s.poll.status)) {
    const subject = s.poll.subject === undefined ? 'T-minus' : `Static fire: ${cut(s.poll.subject, 40)}`;
    notices.push({ tag: 'gonogo-poll', title: s.poll.status === 'go' ? `${subject}: GO` : `${subject}: HOLD`, body: cut(s.poll.note, SNIPPET_CHARS), open: 'room' });
  }
  const fresh = s.relief.filter((r) => !seen.relief.has(r.id));
  if (fresh.length > 0) {
    const first = fresh[0]!;
    notices.push({
      tag: 'gonogo-relief',
      title: fresh.length === 1 ? `Relief: ${cut(first.by, 40)} asks to hire ${cut(first.name, 40)}` : `Relief: ${fresh.length} hire requests wait`,
      body: 'Waiting for your GO or NO-GO.',
      open: 'room',
    });
  }
  return {
    notices,
    seen: {
      // what was seen stays seen (ids only grow), so a message read and archived never comes back as news
      messages: new Set([...seen.messages, ...s.downlink.items.filter((i) => i.type === 'message').map((i) => i.id)]),
      poll: key,
      relief: new Set([...seen.relief, ...s.relief.map((r) => r.id)]),
    },
  };
}

/** Is the page out of the Director's sight: another tab, a minimised window, or another window in front. */
export const isAway = (doc: Pick<Document, 'hidden' | 'hasFocus'>): boolean => doc.hidden || !doc.hasFocus();

/** What the settings screen says about the state of the browser's permission and of our own switch. */
export type NotifyStatus = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on' | 'needs-permission';

export function notifyStatus(input: { supported: boolean; secure: boolean; permission: 'default' | 'granted' | 'denied'; enabled: boolean }): NotifyStatus {
  if (!input.supported) return 'unsupported';
  if (!input.secure) return 'insecure';
  if (input.permission === 'denied') return 'denied';
  if (!input.enabled) return 'off';
  return input.permission === 'granted' ? 'on' : 'needs-permission';
}

export const STATUS_TEXT: Record<NotifyStatus, string> = {
  unsupported: 'This browser has no notifications. The tab title still counts what is unread.',
  insecure: 'Notifications need https or localhost, and this address is plain http. The tab title still counts what is unread.',
  denied: 'The browser blocks notifications for this address. Allow them in its site settings; until then the tab title counts what is unread.',
  off: 'Off. Turn it on to be told when a message for you, a T-minus poll or a Relief request arrives while this tab is not in front.',
  'needs-permission': 'On, but the browser has not been asked yet. Press the key again to ask.',
  on: 'On in this browser. A notification shows only while this tab is hidden or not focused.',
};

/** The title of the tab without a count: `<name> · gonogo` with the Director's name or the station's, plain `gonogo` with neither. */
export function tabTitle(view: { name: string | null; fallback: string | null }): string {
  const name = view.name ?? view.fallback;
  return name === null || name === '' ? 'gonogo' : `${name} · gonogo`;
}

/** The tab title with the count of what waits for the Director in front: `(3) gonogo`. Nothing waiting leaves the title as it was. */
export function titleWith(base: string, waiting: number): string {
  return waiting > 0 ? `(${waiting > 99 ? '99+' : waiting}) ${base}` : base;
}

/** What waits for the Director: unread inbox items, and Relief requests (they are not in the inbox). */
export const waitingFor = (s: Pick<ClientState, 'downlink' | 'relief'>): number => s.downlink.unread + s.relief.length;
