import { describe, expect, it } from 'vitest';
import { DOWNLINK_EVENT_KINDS } from '../src/shared/protocol.js';
import type { DownlinkItem } from '../src/shared/protocol.js';
import { afterLeaving, EVENT_CHIPS, filterCounts, filterItems, FILTERS, keyAction, rowId, stepId, unreadText, whenText } from '../src/client/inbox.js';

const message = (id: string, at: number, extra: Partial<Extract<DownlinkItem, { type: 'message' }>> = {}): DownlinkItem => ({
  type: 'message',
  id,
  at,
  from: 'ana',
  subject: `subject ${id}`,
  body: 'body',
  truncated: false,
  inReplyTo: null,
  read: false,
  archived: false,
  ...extra,
});
const event = (id: string, at: number, extra: Partial<Extract<DownlinkItem, { type: 'event' }>> = {}): DownlinkItem => ({
  type: 'event',
  id,
  at,
  kind: 'redline',
  text: 'ana: loop',
  read: false,
  archived: false,
  ...extra,
});

// newest first, as the server sends it
const items: DownlinkItem[] = [
  event('e2', 60, { read: true }),
  message('m3', 50),
  message('m2', 40, { read: true }),
  event('e1', 30),
  message('m1', 20, { read: true, archived: true }),
  event('e0', 10, { read: true, archived: true }),
];

describe('the filters of the Downlink', () => {
  it('shows the inbox in ALL and keeps what was archived for ARCHIVED', () => {
    expect(filterItems(items, 'all').map((i) => i.id)).toEqual(['m3', 'e1', 'e2', 'm2']);
    expect(filterItems(items, 'messages').map((i) => i.id)).toEqual(['m3', 'm2']);
    expect(filterItems(items, 'events').map((i) => i.id)).toEqual(['e1', 'e2']);
    expect(filterItems(items, 'archived').map((i) => i.id)).toEqual(['m1', 'e0']);
  });

  it('puts the unread first, and each group keeps the newest-first order', () => {
    const ids = filterItems([message('m5', 90, { read: true }), message('m4', 80), message('m3', 70, { read: true }), message('m2', 60)], 'all').map((i) => i.id);
    expect(ids).toEqual(['m4', 'm2', 'm5', 'm3']);
  });

  it('keeps a row that was read while the page is up in its place among the unread', () => {
    const list = [message('m5', 90, { read: true }), message('m4', 80, { read: true }), message('m3', 70, { read: true }), message('m2', 60)];
    expect(filterItems(list, 'all', new Set(['m4'])).map((i) => i.id)).toEqual(['m4', 'm2', 'm5', 'm3']);
  });

  it('counts each filter, and has a label for each', () => {
    expect(filterCounts(items)).toEqual({ all: 4, messages: 2, events: 2, archived: 2 });
    expect(filterCounts([])).toEqual({ all: 0, messages: 0, events: 0, archived: 0 });
    expect(FILTERS.map((f) => f.label)).toEqual(['ALL', 'MESSAGES', 'EVENTS', 'ARCHIVED']);
  });

  it('does not change the list it was given', () => {
    const copy = [...items];
    filterItems(items, 'all');
    expect(items).toEqual(copy);
  });
});

describe('the words of the Downlink', () => {
  it('has a chip for every kind of event the server can post', () => {
    for (const kind of DOWNLINK_EVENT_KINDS) expect(EVENT_CHIPS[kind].text, kind).toMatch(/^[A-Z -]+$/);
    expect(Object.keys(EVENT_CHIPS).sort()).toEqual([...DOWNLINK_EVENT_KINDS].sort());
  });

  it('says how many are unread, and names a row for the page', () => {
    expect(unreadText(0)).toBe('0 unread');
    expect(unreadText(12)).toBe('12 unread');
    expect(rowId('m7')).toBe('dl-m7');
  });

  it('writes the time of today alone and another day with its date, and survives a time that is not one', () => {
    const now = new Date(2026, 10, 17, 15, 30).getTime();
    const today = whenText(new Date(2026, 10, 17, 9, 5).getTime(), now);
    expect(today).toMatch(/^\d\d:\d\d$/);
    const earlier = whenText(new Date(2026, 10, 16, 9, 5).getTime(), now);
    expect(earlier.endsWith(` ${today}`)).toBe(true);
    expect(earlier.length).toBeGreaterThan(today.length);
    // the same day a year before is another day
    expect(whenText(new Date(2025, 10, 17, 9, 5).getTime(), now)).not.toBe(today);
    expect(whenText(Number.NaN, now)).toBe('--:--');
    expect(whenText(8.64e15 + 1, now)).toBe('--:--');
  });
});

describe('the keys of the Downlink', () => {
  const ids = ['a', 'b', 'c'];

  it('moves down with j and up with k, stays at an end, and starts at the first or the last when no row has the keyboard', () => {
    expect(stepId(ids, 'a', 1)).toBe('b');
    expect(stepId(ids, 'b', -1)).toBe('a');
    expect(stepId(ids, 'c', 1)).toBe('c');
    expect(stepId(ids, 'a', -1)).toBe('a');
    expect(stepId(ids, null, 1)).toBe('a');
    expect(stepId(ids, null, -1)).toBe('c');
    expect(stepId(ids, 'gone', 1)).toBe('a');
    expect(stepId([], 'a', 1)).toBeNull();
  });

  it('sends the keyboard to the row that takes the place of one that left, else the one before it, else nowhere', () => {
    expect(afterLeaving(ids, 'a')).toBe('b');
    expect(afterLeaving(ids, 'b')).toBe('c');
    expect(afterLeaving(ids, 'c')).toBe('b');
    expect(afterLeaving(['a'], 'a')).toBeNull();
    expect(afterLeaving(ids, 'x')).toBeNull();
  });

  it('reads j, k, e and r, and nothing else', () => {
    expect(['j', 'k', 'e', 'r'].map((key) => keyAction(key, false, false))).toEqual(['next', 'previous', 'archive', 'reply']);
    for (const key of ['J', 'x', 'Enter', ' ', 'ArrowDown', 'Escape', 'constructor', '__proto__', 'toString']) expect(keyAction(key, false, false), key).toBeNull();
  });

  it('leaves a key with Ctrl, Cmd or Alt to the browser, and every key to a field that is being typed in', () => {
    expect(keyAction('r', true, false)).toBeNull();
    expect(keyAction('e', true, false)).toBeNull();
    expect(keyAction('j', false, true)).toBeNull();
    expect(keyAction('r', false, true)).toBeNull();
  });
});
