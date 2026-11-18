import { describe, expect, it } from 'vitest';
import type { ActivityItem } from '../src/shared/protocol.js';
import { SUBJECT_MAX_CHARS } from '../src/shared/protocol.js';
import { replyRequest } from '../src/client/loop.js';
import { groupThreads, repliers, replyTarget, stripReplyPrefix } from '../src/client/threads.js';

let clock = 0;
/** A message; ids count up and `at` with them, as the hub makes them. */
function msg(from: string, to: string, subject: string, extra: Partial<ActivityItem> = {}): ActivityItem {
  clock += 1;
  return {
    id: `m${clock}`,
    from,
    to,
    subject,
    body: `body ${clock}`,
    inReplyTo: null,
    hops: 1,
    at: clock * 1000,
    status: 'delivered',
    note: null,
    updatedAt: clock * 1000,
    truncated: false,
    ...extra,
  };
}
/** The store keeps its list newest first. */
const newestFirst = (...items: ActivityItem[]): ActivityItem[] => [...items].reverse();
const ids = (items: readonly ActivityItem[]): string[] => items.map((i) => i.id);

describe('stripReplyPrefix', () => {
  it('takes off any number of Re: and Fwd:, in any case, and nothing else', () => {
    expect(stripReplyPrefix('Re: Build')).toBe('Build');
    expect(stripReplyPrefix('RE:  re: Fwd: FW:build is Re: red')).toBe('build is Re: red');
    expect(stripReplyPrefix('Report')).toBe('Report');
    expect(stripReplyPrefix('Re:')).toBe('');
    expect(stripReplyPrefix('  ')).toBe('');
  });

  it('is linear on a subject made of nothing but prefixes', () => {
    const start = performance.now();
    expect(stripReplyPrefix('Re: '.repeat(50_000))).toBe('');
    expect(stripReplyPrefix(`${' '.repeat(50_000)}x`)).toBe('x');
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('groupThreads', () => {
  it('has no threads for no messages', () => {
    expect(groupThreads([])).toEqual([]);
  });

  it('puts messages of the same two parties and subject in one thread, whoever speaks, oldest first', () => {
    const a = msg('ana', 'user', 'Build is green');
    const b = msg('user', 'ana', 'Re: Build is green');
    const c = msg('ana', 'user', 'RE: build is  green');
    const threads = groupThreads(newestFirst(a, b, c));
    expect(threads).toHaveLength(1);
    expect(ids(threads[0]?.items ?? [])).toEqual([a.id, b.id, c.id]);
    expect(threads[0]).toMatchObject({ id: a.id, subject: 'Build is green', title: 'Build is green', who: ['ana', 'user'], last: c });
  });

  it('keeps other parties, or another subject, in other threads', () => {
    const a = msg('ana', 'user', 'Plan');
    const b = msg('ben', 'user', 'Plan');
    const c = msg('ana', 'user', 'Plan B');
    const d = msg('ana', 'ben', 'Plan');
    expect(groupThreads(newestFirst(a, b, c, d)).map((t) => ids(t.items))).toEqual([[d.id], [c.id], [b.id], [a.id]]);
  });

  it('follows inReplyTo into the thread of that message, even when the parties or the subject differ', () => {
    const a = msg('ana', 'user', 'Build is green');
    const b = msg('user', 'ben', 'Something else', { inReplyTo: a.id });
    const c = msg('ben', 'ana', 'Re: Something else', { inReplyTo: b.id });
    const threads = groupThreads(newestFirst(a, b, c));
    expect(threads).toHaveLength(1);
    expect(ids(threads[0]?.items ?? [])).toEqual([a.id, b.id, c.id]);
    expect(threads[0]?.who).toEqual(['ana', 'user', 'ben']);
  });

  it('lets a later message with the subject of a reply join it, and a reply to a message that is not in the list fall back to the subject', () => {
    const a = msg('ana', 'user', 'Plan');
    const reply = msg('ben', 'user', 'Re: Plan', { inReplyTo: a.id });
    const later = msg('ben', 'user', 'Plan');
    const orphan = msg('cy', 'user', 'Report', { inReplyTo: 'm9999' });
    const sibling = msg('cy', 'user', 'Re: Report');
    const threads = groupThreads(newestFirst(a, reply, later, orphan, sibling));
    expect(threads.map((t) => ids(t.items))).toEqual([[orphan.id, sibling.id], [a.id, reply.id, later.id]]);
  });

  it('groups messages with no subject by their two parties, titles them by the first line and answers them with no subject', () => {
    const a = msg('ana', 'user', '', { body: 'Done with the spec\nand the tests' });
    const b = msg('user', 'ana', '');
    const c = msg('ben', 'user', '');
    const threads = groupThreads(newestFirst(a, b, c));
    expect(threads.map((t) => ids(t.items))).toEqual([[c.id], [a.id, b.id]]);
    expect(threads[1]).toMatchObject({ subject: '', title: 'Done with the spec' });
    expect(replyRequest(replyTarget(threads[1]!, 'ana'), 'ok').subject).toBe('');
  });

  it('lists the thread with the newest message first, and a thread that gets a message moves up', () => {
    const a = msg('ana', 'user', 'One');
    const b = msg('ben', 'user', 'Two');
    const c = msg('cy', 'user', 'Three');
    expect(groupThreads(newestFirst(a, b, c)).map((t) => t.title)).toEqual(['Three', 'Two', 'One']);
    const again = msg('ana', 'user', 'Re: One');
    expect(groupThreads(newestFirst(a, b, c, again)).map((t) => t.title)).toEqual(['One', 'Three', 'Two']);
  });

  it('reads the list from its end, which is the order of the store: a message sorted before another is older', () => {
    const a = msg('ana', 'user', 'One');
    const b = msg('user', 'ana', 'Re: One', { at: a.at - 500 });
    // the store sorts by `at` and puts the newest first, so this is the list it would hold
    expect(ids(groupThreads([a, b])[0]?.items ?? [])).toEqual([b.id, a.id]);
  });

  it('does not change the list it is given', () => {
    const list = newestFirst(msg('ana', 'user', 'One'), msg('user', 'ana', 'Re: One'));
    const copy = JSON.parse(JSON.stringify(list)) as ActivityItem[];
    groupThreads(list);
    expect(list).toEqual(copy);
  });

  it('treats names that look like object keys as names, and a message that replies to itself as a first message', () => {
    const a = msg('__proto__', 'constructor', 'toString');
    const b = msg('constructor', '__proto__', 'Re: toString');
    const self = msg('hasOwnProperty', 'user', 'x', { inReplyTo: 'm0' });
    const loop = msg('ana', 'user', 'loop');
    loop.inReplyTo = loop.id;
    const threads = groupThreads(newestFirst(a, b, self, loop));
    expect(threads.map((t) => ids(t.items))).toEqual([[loop.id], [self.id], [a.id, b.id]]);
    expect(threads[2]?.who).toEqual(['__proto__', 'constructor']);
  });

  it('keeps names that hold the separator of a key apart', () => {
    const a = msg('a', 'b,c', 'x');
    const b = msg('a,b', 'c', 'x');
    expect(groupThreads(newestFirst(a, b))).toHaveLength(2);
  });

  it('groups 200 messages in a blink', () => {
    const list = Array.from({ length: 200 }, (_, i) => msg(i % 2 === 0 ? 'ana' : 'user', i % 2 === 0 ? 'user' : 'ana', `Re: topic ${i % 7}`));
    const start = performance.now();
    const threads = groupThreads(newestFirst(...list));
    expect(performance.now() - start).toBeLessThan(500);
    expect(threads).toHaveLength(7);
    expect(threads.reduce((n, t) => n + t.items.length, 0)).toBe(200);
  });
});

describe('repliers and replyTarget', () => {
  const thread = (...items: ActivityItem[]) => groupThreads(newestFirst(...items))[0]!;

  it('answers the one who spoke last, then the others of the thread', () => {
    const a = msg('ana', 'user', 'Plan');
    const b = msg('user', 'ben', 'Re: Plan', { inReplyTo: a.id });
    const c = msg('ben', 'ana', 'Re: Plan', { inReplyTo: b.id });
    expect(repliers(thread(a, b, c))).toEqual(['ben', 'ana']);
  });

  it('answers whom the Director spoke to last when only he has spoken', () => {
    const first = msg('user', 'ana', 'Brief');
    const t = thread(first, msg('user', 'ben', 'Re: Brief', { inReplyTo: first.id }));
    expect(repliers(t)).toEqual(['ben', 'ana']);
  });

  it('offers no one of another station, and none when the thread is only with a station', () => {
    const hi = msg('bob@lab', 'user', 'Hi');
    expect(repliers(thread(hi, msg('user', 'ana', 'Re: Hi', { inReplyTo: hi.id })))).toEqual(['ana']);
    expect(repliers(thread(msg('bob@lab', 'user', 'Hello')))).toEqual([]);
  });

  it('replies to the newest message, with the subject of the thread, so that the answer joins it', () => {
    const a = msg('ana', 'user', 'Re: Build is green');
    const b = msg('ana', 'user', 'Build is green');
    const t = thread(a, b);
    expect(replyTarget(t, 'ana')).toEqual({ id: b.id, from: 'ana', subject: 'Build is green' });
    expect(replyRequest(replyTarget(t, 'ana'), 'ship it')).toEqual({ to: 'ana', subject: 'Re: Build is green', body: 'ship it', inReplyTo: b.id });
    // and the answer is a message of the same thread
    const answer = msg('user', 'ana', 'Re: Build is green', { inReplyTo: b.id });
    expect(groupThreads(newestFirst(a, b, answer))).toHaveLength(1);
  });

  it('keeps the subject of the answer within the limit the hub takes', () => {
    const long = msg('ana', 'user', 'x'.repeat(SUBJECT_MAX_CHARS));
    expect(replyRequest(replyTarget(thread(long), 'ana'), 'ok').subject).toHaveLength(SUBJECT_MAX_CHARS);
  });
});
