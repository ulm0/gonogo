import { describe, expect, it } from 'vitest';
import type { DownlinkItem, PollView, ReliefRequest } from '../src/shared/protocol.js';
import { cut, isAway, NOTHING_SEEN, noticesFor, notifyStatus, seenIn, titleWith, waitingFor } from '../src/client/notify.js';

const msg = (id: string, from: string, patch: Partial<Extract<DownlinkItem, { type: 'message' }>> = {}): DownlinkItem => ({
  type: 'message', id, at: 1, from, subject: `subject ${id}`, body: `body of ${id}`, truncated: false, inReplyTo: null, read: false, archived: false, ...patch,
});
const poll = (patch: Partial<PollView> = {}): PollView => ({ id: 1, startedAt: 1, status: 'open', entries: [], note: 'waiting for ana', ...patch });
const relief = (id: string, by = 'flight', name = 'ben'): ReliefRequest => ({ id, by, at: 1, expiresAt: 2, name, position: null, role: 'r', dir: '/d', provider: 'claude', mode: 'default', cleanRoom: null });
const slice = (items: DownlinkItem[] = [], p: PollView | null = null, r: ReliefRequest[] = []) => ({ downlink: { unread: items.filter((i) => !i.read && !i.archived).length, items }, poll: p, relief: r });

describe('messages to the Director', () => {
  it('the first state is history: nothing is told, everything is seen', () => {
    const first = slice([msg('m2', 'ana'), msg('m1', 'ben')]);
    expect(seenIn(first).messages).toEqual(new Set(['m1', 'm2']));
    expect(noticesFor(seenIn(first), first).notices).toEqual([]);
  });

  it('a new unread message is told once, with the sender and subject as title and a short snippet', () => {
    const seen = seenIn(slice([msg('m1', 'ana')]));
    const next = slice([msg('m2', 'ana', { subject: 'Done', body: 'x'.repeat(300) }), msg('m1', 'ana')]);
    const { notices, seen: after } = noticesFor(seen, next);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ tag: 'gonogo-msg-ana', title: 'ana: Done', open: 'downlink' });
    expect(notices[0]!.body.length).toBeLessThanOrEqual(80);
    expect(noticesFor(after, next).notices).toEqual([]);
  });

  it('a burst from one agent is one notification (the newest), another agent has its own', () => {
    const next = slice([msg('m3', 'ana'), msg('m2', 'ben'), msg('m1', 'ana')]);
    const { notices } = noticesFor(NOTHING_SEEN, next);
    expect(notices.map((n) => n.tag).sort()).toEqual(['gonogo-msg-ana', 'gonogo-msg-ben']);
    expect(notices.find((n) => n.tag === 'gonogo-msg-ana')!.title).toBe('ana: subject m3');
  });

  it('skips what is already read or archived, and what was in an earlier state', () => {
    const next = slice([msg('m3', 'ana', { read: true }), msg('m2', 'ana', { archived: true })]);
    expect(noticesFor(NOTHING_SEEN, next).notices).toEqual([]);
  });

  it('puts a newline, control and bidi characters of an agent\'s text on one clean line', () => {
    const next = slice([msg('m1', 'ana', { subject: 'a\nb‮c', body: 'line one\n\nline two\u0007' })]);
    const [n] = noticesFor(NOTHING_SEEN, next).notices;
    expect(n!.title).toBe('ana: a b c');
    expect(n!.body).toBe('line one line two');
    expect(cut('abcdef', 4)).toBe('abc…');
  });
});

describe('T-minus polls and Relief', () => {
  it('tells a poll that holds or comes out go, once per status, and not an open or aborted one', () => {
    let seen = seenIn(slice([], poll()));
    const hold = slice([], poll({ status: 'hold', note: 'no-go: simsup' }));
    const out = noticesFor(seen, hold);
    expect(out.notices).toEqual([{ tag: 'gonogo-poll', title: 'T-minus: HOLD', body: 'no-go: simsup', open: 'room' }]);
    seen = out.seen;
    expect(noticesFor(seen, hold).notices).toEqual([]);
    expect(noticesFor(seen, slice([], poll({ status: 'go', note: 'all go' }))).notices[0]!.title).toBe('T-minus: GO');
    expect(noticesFor(seen, slice([], poll({ status: 'aborted' }))).notices).toEqual([]);
    expect(noticesFor(NOTHING_SEEN, slice([], poll({ status: 'hold', subject: 'the login form' }))).notices[0]!.title).toBe('Static fire: the login form: HOLD');
  });

  it('tells a new Relief request, and says how many when several came', () => {
    const seen = seenIn(slice([], null, [relief('h1')]));
    expect(noticesFor(seen, slice([], null, [relief('h1')])).notices).toEqual([]);
    const one = noticesFor(seen, slice([], null, [relief('h1'), relief('h2', 'flight', 'cleo')]));
    expect(one.notices).toEqual([{ tag: 'gonogo-relief', title: 'Relief: flight asks to hire cleo', body: 'Waiting for your GO or NO-GO.', open: 'room' }]);
    expect(noticesFor(seen, slice([], null, [relief('h1'), relief('h2'), relief('h3')])).notices[0]!.title).toBe('Relief: 2 hire requests wait');
  });
});

describe('when and whether', () => {
  it('is away when the tab is hidden or has no focus', () => {
    expect(isAway({ hidden: true, hasFocus: () => true })).toBe(true);
    expect(isAway({ hidden: false, hasFocus: () => false })).toBe(true);
    expect(isAway({ hidden: false, hasFocus: () => true })).toBe(false);
  });

  it('reads the state of the switch and of the permission', () => {
    const ok = { supported: true, secure: true, permission: 'granted' as const, enabled: true };
    expect(notifyStatus(ok)).toBe('on');
    expect(notifyStatus({ ...ok, enabled: false })).toBe('off');
    expect(notifyStatus({ ...ok, permission: 'default' })).toBe('needs-permission');
    expect(notifyStatus({ ...ok, permission: 'denied' })).toBe('denied');
    expect(notifyStatus({ ...ok, secure: false })).toBe('insecure');
    expect(notifyStatus({ ...ok, supported: false })).toBe('unsupported');
  });

  it('counts what waits and puts it in the tab title', () => {
    expect(waitingFor({ downlink: { unread: 2, items: [] }, relief: [relief('h1')] })).toBe(3);
    expect(titleWith('gonogo', 0)).toBe('gonogo');
    expect(titleWith('gonogo', 3)).toBe('(3) gonogo');
    expect(titleWith('gonogo', 150)).toBe('(99+) gonogo');
  });
});
