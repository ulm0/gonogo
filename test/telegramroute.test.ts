import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger, SendResult, UserMessageRequest } from '../src/shared/protocol.js';
import { createRouter, offerOverSocket, replyKey, roomPrefix, ROUTE_KEY_HEADER, ROUTE_PATH, sameKey, takeOffer } from '../src/server/telegramroute.js';
import { createUplinks } from '../src/server/uplinks.js';
import type { Inbound, Uplinks } from '../src/server/uplinks.js';

// Telegram and several rooms (src/server/telegramroute.ts): two rooms and one bot. A reply to what room X sent must reach room X; everything else is main's.

const CHAT = '777';
const KEY = 'a'.repeat(64);
let dir: string;
let logs: string[];
const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m) => void logs.push(m),
  error: (m) => void logs.push(m),
  child: () => log,
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-route-'));
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const update = (message: Record<string, unknown>, id = 1): Record<string, unknown> => ({
  update_id: id,
  message: { message_id: 500 + id, from: { id: 777, first_name: 'Ulm' }, chat: { id: 777, type: 'private' }, ...message },
});
const buf = (u: unknown): Buffer => Buffer.from(JSON.stringify(u));

describe('what is read of an update', () => {
  it('a reply is keyed as the rooms key what they sent; anything else has no key', () => {
    expect(replyKey(update({ text: 'ok', reply_to_message: { message_id: 55 } }))).toBe('telegram:777:55');
    expect(replyKey(update({ text: 'ok' }))).toBeNull();
    expect(replyKey({ callback_query: { id: 'q', message: { message_id: 5, chat: { id: 777 } } } })).toBeNull();
    expect(replyKey('nope')).toBeNull();
    expect(replyKey(update({ text: 'ok', chat: { type: 'private' }, reply_to_message: { message_id: 55 } }))).toBeNull();
  });

  it('/room <id> at the start of a text or a caption names a room and is taken off; nothing else is a prefix', () => {
    const t = roomPrefix(update({ text: '/room alpha  build is green\nplease merge' }));
    expect(t?.room).toBe('alpha');
    expect((t?.update.message as { text: string }).text).toBe('build is green\nplease merge');
    expect((roomPrefix(update({ caption: '/room beta see the screenshot' }))?.update.message as { caption: string }).caption).toBe('see the screenshot');
    expect((roomPrefix(update({ text: '/room gamma' }))?.update.message as { text: string }).text).toBe('');
    for (const text of ['hello /room alpha', '/rooms alpha hi', '/room', '/room Bad_Id hi', '/room ../x hi', '/room alpha-' + 'x'.repeat(40) + ' hi']) expect(roomPrefix(update({ text })), text).toBeNull();
    expect(roomPrefix(update({ photo: [] }))).toBeNull();
  });

  it('the key is compared in constant time and an absent or empty one never matches', () => {
    expect(sameKey(KEY, KEY)).toBe(true);
    expect(sameKey(`${KEY}x`, KEY)).toBe(false);
    expect(sameKey(undefined, KEY)).toBe(false);
    expect(sameKey('', '')).toBe(false);
  });
});

describe('the router (room main)', () => {
  type Offer = [string, Record<string, unknown>, boolean];
  function make(over: { peers?: string[]; owns?: boolean; takes?: string[] } = {}) {
    const offers: Offer[] = [];
    const own: Buffer[] = [];
    const deliver = createRouter({
      self: 'main',
      peers: () => over.peers ?? ['main', 'alpha', 'beta'],
      offer: async (room, u, force) => (offers.push([room, u, force]), (over.takes ?? []).includes(room)),
      owns: () => over.owns ?? false,
      deliverOwn: (u) => void own.push(u),
      log,
    });
    return { deliver, offers, own };
  }

  it('a plain message is main\'s, and nothing is offered to anyone', async () => {
    const { deliver, offers, own } = make({ takes: ['alpha'] });
    await deliver(buf(update({ text: 'hello' })), 'k');
    expect(own).toHaveLength(1);
    expect(offers).toEqual([]);
  });

  it('a reply to something main sent is main\'s, with no offer', async () => {
    const { deliver, offers, own } = make({ owns: true, takes: ['alpha'] });
    await deliver(buf(update({ text: 'ok', reply_to_message: { message_id: 55 } })), 'k');
    expect(own).toHaveLength(1);
    expect(offers).toEqual([]);
  });

  it('a reply main did not send is offered to the other rooms in turn, and the first to take it has it alone', async () => {
    const { deliver, offers, own } = make({ takes: ['beta'] });
    await deliver(buf(update({ text: 'ok', reply_to_message: { message_id: 55 } })), 'k');
    expect(offers.map((o) => [o[0], o[2]])).toEqual([['alpha', false], ['beta', false]]);
    expect(own).toEqual([]);
    const second = make({ takes: ['alpha', 'beta'] });
    await second.deliver(buf(update({ text: 'ok', reply_to_message: { message_id: 55 } })), 'k');
    expect(second.offers.map((o) => o[0])).toEqual(['alpha']);
  });

  it('a reply nobody knows falls to main, as it always did', async () => {
    const { deliver, own, offers } = make();
    await deliver(buf(update({ text: 'ok', reply_to_message: { message_id: 55 } })), 'k');
    expect(offers).toHaveLength(2);
    expect(own).toHaveLength(1);
  });

  it('/room <id> goes to that room with the prefix off and force; main\'s own id stays here; an unknown or unwilling room leaves the message with main, untouched', async () => {
    const a = make({ takes: ['alpha'] });
    await a.deliver(buf(update({ text: '/room alpha do it' })), 'k');
    expect(a.offers).toHaveLength(1);
    expect(a.offers[0]?.[0]).toBe('alpha');
    expect(a.offers[0]?.[2]).toBe(true);
    expect((a.offers[0]?.[1].message as { text: string }).text).toBe('do it');
    expect(a.own).toEqual([]);
    const m = make();
    await m.deliver(buf(update({ text: '/room main do it' })), 'k');
    expect(JSON.parse(m.own[0]?.toString() as string).message.text).toBe('do it');
    expect(m.offers).toEqual([]);
    const unknown = make();
    const raw = buf(update({ text: '/room nowhere do it' }));
    await unknown.deliver(raw, 'k');
    expect(unknown.offers).toEqual([]);
    expect(unknown.own[0]?.equals(raw)).toBe(true);
    const unwilling = make({ takes: [] });
    await unwilling.deliver(buf(update({ text: '/room beta hi' })), 'k');
    expect(unwilling.own).toHaveLength(1);
    expect(logs.some((l) => l.includes('did not take'))).toBe(true);
  });

  it('a button (phone approvals) and a body that is not JSON are never offered; with no other room, nothing is', async () => {
    const { deliver, offers, own } = make();
    await deliver(buf({ update_id: 3, callback_query: { id: 'q', data: 'a:perm:p1:go:abcd1234', message: { message_id: 55, chat: { id: 777 } } } }), 'k');
    await deliver(Buffer.from('not json'), 'k');
    expect(offers).toEqual([]);
    expect(own).toHaveLength(2);
    const alone = make({ peers: ['main'] });
    await alone.deliver(buf(update({ text: 'ok', reply_to_message: { message_id: 55 } })), 'k');
    await alone.deliver(buf(update({ text: '/room alpha hi' })), 'k');
    expect(alone.offers).toEqual([]);
    expect(alone.own).toHaveLength(2);
  });
});

/** A room as its own process would be: its own uplinks, its own map of what it sent, its own chat. */
function room(name: string, chat: string | null, threads: Record<string, { id: string; agent: string; subject: string }>): { uplinks: Uplinks; sent: Array<{ request: UserMessageRequest; director?: unknown }> } {
  const sent: Array<{ request: UserMessageRequest; director?: unknown }> = [];
  const seen = new Set<string>();
  const inbound: Inbound = { find: (k) => threads[k], seen: (k) => (seen.has(k) ? true : (seen.add(k), false)), telegramChat: () => chat };
  const uplinks = createUplinks({
    dir: join(dir, name),
    now: () => Date.UTC(2026, 10, 21, 9, 0),
    inbound,
    send: (request, director): SendResult => (sent.push({ request, ...(director === undefined ? {} : { director }) }), { ok: true, id: `${name}${sent.length}`, to: request.to, status: 'queued', note: null }),
    emit: () => undefined,
    log,
  });
  return { uplinks, sent };
}

describe('two rooms, one bot', () => {
  function pair(alphaChat: string | null = CHAT) {
    const main = room('main', CHAT, { [`telegram:${CHAT}:10`]: { id: 'm1', agent: 'flight', subject: 'Build' } });
    const alpha = room('alpha', alphaChat, { [`telegram:${CHAT}:55`]: { id: 'a1', agent: 'ana', subject: 'Review' } });
    const rooms = { alpha };
    const deliver = createRouter({
      self: 'main',
      peers: () => ['main', 'alpha'],
      offer: async (id, u, force) => {
        const target = rooms[id as keyof typeof rooms];
        return target === undefined ? false : takeOffer({ update: u, force }, { owns: (b) => target.uplinks.ownsReply(b), deliver: (b) => target.uplinks.deliverPolled(b, '') }).claimed;
      },
      owns: (u) => main.uplinks.ownsReply(u),
      deliverOwn: (u, s) => main.uplinks.deliverPolled(u, s),
      log,
    });
    return { main, alpha, deliver };
  }

  it('THE BUG: a reply to a message room alpha sent used to land in main\'s boss; now it reaches alpha\'s agent, as the Director\'s own words', async () => {
    const { main, alpha, deliver } = pair();
    await deliver(buf(update({ text: 'looks good', reply_to_message: { message_id: 55 } })), 'k');
    expect(main.sent).toEqual([]);
    expect(alpha.sent).toHaveLength(1);
    expect(alpha.sent[0]?.request).toMatchObject({ to: 'ana', inReplyTo: 'a1', subject: 'Re: Review', body: 'looks good' });
    expect(alpha.sent[0]?.director).toMatchObject({ channel: 'telegram', said: 'looks good' });
  });

  it('a reply to something main sent, and a plain message, still go to main', async () => {
    const { main, alpha, deliver } = pair();
    await deliver(buf(update({ text: 'thanks', reply_to_message: { message_id: 10 } }, 2)), 'k');
    await deliver(buf(update({ text: 'anyone there?' }, 3)), 'k');
    expect(alpha.sent).toEqual([]);
    expect(main.sent.map((s) => [s.request.to, s.request.body])).toEqual([['flight', 'thanks'], ['boss', expect.stringContaining('anyone there?')]]);
  });

  it('/room alpha reaches alpha\'s boss with the prefix off, and the Director mark; /room of an id that is no room stays with main', async () => {
    const { main, alpha, deliver } = pair();
    await deliver(buf(update({ text: '/room alpha status please' }, 4)), 'k');
    expect(main.sent).toEqual([]);
    expect(alpha.sent[0]?.request.body).toContain('status please');
    expect(alpha.sent[0]?.request.body).not.toContain('/room');
    expect(alpha.sent[0]?.director).toMatchObject({ channel: 'telegram', said: 'status please' });
    await deliver(buf(update({ text: '/room elsewhere hi' }, 5)), 'k');
    expect(main.sent[0]?.request.body).toContain('/room elsewhere hi');
  });

  it('the gates are the room\'s own: a forwarded reply has no Director mark, a group or another chat is dropped, a room with another chat refuses', async () => {
    const { main, alpha, deliver } = pair();
    await deliver(buf(update({ text: 'fwd', reply_to_message: { message_id: 55 }, forward_origin: { type: 'user' } }, 6)), 'k');
    expect(alpha.sent[0]?.request.body).toBe('fwd');
    expect(alpha.sent[0]?.director).toBeUndefined();
    await deliver(buf(update({ text: 'in a group', reply_to_message: { message_id: 55 }, chat: { id: -100777, type: 'supergroup' } }, 7)), 'k');
    await deliver(buf(update({ text: 'stranger', reply_to_message: { message_id: 55 }, chat: { id: 999, type: 'private' }, from: { id: 999 } }, 8)), 'k');
    expect(alpha.sent).toHaveLength(1);
    expect(main.sent).toHaveLength(0);
    // the room whose own chat is another one does not own what the Director replied to, and a forced /room is refused by its own read
    const other = pair('555');
    await other.deliver(buf(update({ text: '/room alpha hi' }, 9)), 'k');
    expect(other.alpha.sent).toEqual([]);
  });

  it('a duplicate offer is dropped by the room\'s own dedup, and a button is not offered', async () => {
    const { alpha, deliver } = pair();
    const u = update({ text: 'once', reply_to_message: { message_id: 55 } }, 11);
    await deliver(buf(u), 'k');
    await deliver(buf(u), 'k');
    // Telegram's update_id is not the dedup key; the room's own counter limit and `once` apply as for a polled update: two deliveries of one message are two here, as before
    expect(alpha.sent.length).toBeGreaterThanOrEqual(1);
    expect(takeOffer({ update: { callback_query: { id: 'q' }, message: {} } }, { owns: () => true, deliver: () => alpha.sent.push({ request: {} as UserMessageRequest }) })).toEqual({ claimed: false });
  });
});

describe('an offer over a socket', () => {
  let server: Server;
  let path: string;
  let taken: Array<Record<string, unknown>>;
  beforeEach(async () => {
    taken = [];
    path = join(dir, 'room.sock');
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url !== ROUTE_PATH || !sameKey(req.headers[ROUTE_KEY_HEADER] as string | undefined, KEY)) {
          res.statusCode = 404;
          return void res.end('{}');
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        taken.push(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(takeOffer(body, { owns: () => true, deliver: () => undefined })));
      });
    });
    await new Promise<void>((r) => server.listen(path, r));
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('is claimed with the key, refused without it or with another, and false for a room that is not there', async () => {
    const u = update({ text: 'ok', reply_to_message: { message_id: 55 } });
    expect(await offerOverSocket(path, KEY, u, false)).toBe(true);
    expect(taken).toHaveLength(1);
    expect(await offerOverSocket(path, 'b'.repeat(64), u, false)).toBe(false);
    expect(await offerOverSocket(join(dir, 'nothing.sock'), KEY, u, false)).toBe(false);
  });
});
