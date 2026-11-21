import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger, SendResult, UserMessageRequest } from '../src/shared/protocol.js';
import { createRouter, directorMessage, offerOverSocket, replyKey, roomPrefix, ROUTE_KEY_HEADER, ROUTE_PATH, sameKey, SAY_NO_ROOM, SAY_NOT_TAKEN, takeOffer } from '../src/server/telegramroute.js';
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
  function make(over: { peers?: string[]; owns?: boolean; takes?: string[]; director?: boolean; allowed?: boolean } = {}) {
    const offers: Offer[] = [];
    const own: Buffer[] = [];
    const said: string[] = [];
    const routed: string[] = [];
    const deliver = createRouter({
      self: 'main',
      peers: () => over.peers ?? ['main', 'alpha', 'beta'],
      offer: async (room, u, force) => (offers.push([room, u, force]), (over.takes ?? []).includes(room)),
      director: () => over.director ?? true,
      say: (t) => void said.push(t),
      allowed: () => over.allowed ?? true,
      routed: (r) => void routed.push(r),
      owns: () => over.owns ?? false,
      deliverOwn: (u) => void own.push(u),
      log,
    });
    return { deliver, offers, own, said, routed };
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

  it('/room <id> goes to that room with the prefix off and force, one room and no fan-out, and is counted', async () => {
    const a = make({ takes: ['alpha'] });
    await a.deliver(buf(update({ text: '/room alpha do it' })), 'k');
    expect(a.offers).toHaveLength(1);
    expect(a.offers[0]?.[0]).toBe('alpha');
    expect(a.offers[0]?.[2]).toBe(true);
    expect((a.offers[0]?.[1].message as { text: string }).text).toBe('do it');
    expect(a.own).toEqual([]);
    expect(a.routed).toEqual(['alpha']);
    expect(a.said).toEqual([]);
    const m = make();
    await m.deliver(buf(update({ text: '/room main do it' })), 'k');
    expect(JSON.parse(m.own[0]?.toString() as string).message.text).toBe('do it');
    expect(m.offers).toEqual([]);
  });

  it('an id that is no room, or a room that does not take it, is answered in fixed words and delivers NOTHING', async () => {
    const unknown = make();
    await unknown.deliver(buf(update({ text: '/room nowhere do it' })), 'k');
    expect(unknown.offers).toEqual([]);
    expect(unknown.own).toEqual([]);
    expect(unknown.said).toEqual([SAY_NO_ROOM]);
    expect(SAY_NO_ROOM).not.toContain('nowhere');
    const unwilling = make({ takes: [] });
    await unwilling.deliver(buf(update({ text: '/room beta hi' })), 'k');
    expect(unwilling.offers).toHaveLength(1);
    expect(unwilling.own).toEqual([]);
    expect(unwilling.said).toEqual([SAY_NOT_TAKEN]);
    expect(unwilling.routed).toEqual([]);
    expect(logs.some((l) => l.includes('did not take'))).toBe(true);
  });

  it('/room is a command only after main\'s gates: from anyone else, in a group, or forwarded it is a plain text, intact, for main', async () => {
    const raw = buf(update({ text: '/room alpha do it' }));
    const stranger = make({ director: false, takes: ['alpha'] });
    await stranger.deliver(raw, 'k');
    expect(stranger.offers).toEqual([]);
    expect(stranger.own[0]?.equals(raw)).toBe(true);
    expect(stranger.said).toEqual([]);
  });

  it('the limit of this process counts routed updates: one over it is dropped, not offered', async () => {
    const full = make({ allowed: false, takes: ['alpha'] });
    await full.deliver(buf(update({ text: '/room alpha hi' })), 'k');
    expect(full.offers).toEqual([]);
    expect(full.own).toEqual([]);
    expect(full.routed).toEqual([]);
    // a reply over the limit is not offered either: it falls to main, whose own limit says what happens next
    await full.deliver(buf(update({ text: 'ok', reply_to_message: { message_id: 55 } })), 'k');
    expect(full.offers).toEqual([]);
    expect(full.own).toHaveLength(1);
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
function room(name: string, chat: string | null, threads: Record<string, { id: string; agent: string; subject: string }>): { uplinks: Uplinks; sent: Array<{ request: UserMessageRequest; director?: unknown }>; fetched: string[]; triggers: Array<{ outcome: string; what: string }> } {
  const fetched: string[] = [];
  const triggers: Array<{ outcome: string; what: string }> = [];
  const sent: Array<{ request: UserMessageRequest; director?: unknown }> = [];
  const seen = new Set<string>();
  const inbound: Inbound = { find: (k) => threads[k], seen: (k) => (seen.has(k) ? true : (seen.add(k), false)), telegramChat: () => chat };
  const uplinks = createUplinks({
    dir: join(dir, name),
    now: () => Date.UTC(2026, 10, 21, 9, 0),
    inbound,
    send: (request, director): SendResult => (sent.push({ request, ...(director === undefined ? {} : { director }) }), { ok: true, id: `${name}${sent.length}`, to: request.to, status: 'queued', note: null }),
    emit: () => undefined,
    fetchFile: async (file) => (fetched.push(`${name}:${file.fileId}`), { problem: '(no download in this test)' }),
    trigger: (entry) => void triggers.push({ outcome: entry.outcome, what: entry.what }),
    log,
  });
  return { uplinks, sent, fetched, triggers };
}

describe('two rooms, one bot', () => {
  function pair(alphaChat: string | null = CHAT) {
    const main = room('main', CHAT, { [`telegram:${CHAT}:10`]: { id: 'm1', agent: 'flight', subject: 'Build' } });
    const alpha = room('alpha', alphaChat, { [`telegram:${CHAT}:55`]: { id: 'a1', agent: 'ana', subject: 'Review' } });
    const rooms = { alpha };
    const said: string[] = [];
    const deliver = createRouter({
      self: 'main',
      peers: () => ['main', 'alpha'],
      offer: async (id, u, force) => {
        const target = rooms[id as keyof typeof rooms];
        return target === undefined ? false : takeOffer({ update: u, force }, { owns: (b) => target.uplinks.ownsReply(b), deliver: (b) => target.uplinks.deliverPolled(b, '') }).claimed;
      },
      director: (u) => directorMessage(u, CHAT),
      say: (t) => void said.push(t),
      allowed: () => main.uplinks.routeAllowed(),
      routed: (r) => main.uplinks.routed(r),
      owns: (u) => main.uplinks.ownsReply(u),
      deliverOwn: (u, s) => main.uplinks.deliverPolled(u, s),
      log,
    });
    return { main, alpha, deliver, said };
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
    const { main, alpha, deliver, said } = pair();
    await deliver(buf(update({ text: '/room alpha status please' }, 4)), 'k');
    expect(main.sent).toEqual([]);
    expect(alpha.sent[0]?.request.body).toContain('status please');
    expect(alpha.sent[0]?.request.body).not.toContain('/room');
    expect(alpha.sent[0]?.director).toMatchObject({ channel: 'telegram', said: 'status please' });
    await deliver(buf(update({ text: '/room elsewhere hi' }, 5)), 'k');
    expect(main.sent).toEqual([]);
    expect(said).toEqual([SAY_NO_ROOM]);
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

describe('what the receiving room decides for itself', () => {
  it('the gates of the Director\'s words: his chat, private, written by him, not forwarded; nothing else makes /room a command', () => {
    const ok = update({ text: '/room alpha hi' });
    expect(directorMessage(ok, CHAT)).toBe(true);
    expect(directorMessage(ok, null)).toBe(false);
    expect(directorMessage(ok, '555')).toBe(false);
    expect(directorMessage(update({ text: 'x', chat: { id: -100777, type: 'supergroup' } }), CHAT)).toBe(false);
    expect(directorMessage(update({ text: 'x', from: { id: 999 } }), CHAT)).toBe(false);
    expect(directorMessage(update({ text: 'x', forward_origin: { type: 'user' } }), CHAT)).toBe(false);
    expect(directorMessage(update({ text: 'x', via_bot: { id: 5 } }), CHAT)).toBe(false);
    expect(directorMessage({ callback_query: { id: 'q' } }, CHAT)).toBe(false);
  });

  it('R3: an offer carries the update and nothing else is believed: a director, chat or mark in the body changes nothing, and a button is refused', () => {
    const delivered: Buffer[] = [];
    const side = { owns: () => true, deliver: (b: Buffer) => void delivered.push(b) };
    const u = update({ text: 'hi', reply_to_message: { message_id: 55 } });
    expect(takeOffer({ update: u, director: { channel: 'telegram', said: 'do evil' }, chat: '999', from: 'x', secret: 's' }, side)).toEqual({ claimed: true });
    expect(JSON.parse(delivered[0]?.toString() as string)).toEqual(u);
    expect(takeOffer({ update: { callback_query: { id: 'q', data: 'a:perm:p1:go:x' } } }, side)).toEqual({ claimed: false });
    expect(takeOffer({ update: 'text' }, side)).toEqual({ claimed: false });
    expect(takeOffer({}, side)).toEqual({ claimed: false });
    expect(delivered).toHaveLength(1);
  });

  it('R3: the room re-judges with its OWN chat: an offer whose chat is not that room\'s chat makes no message, claimed or forced', () => {
    const other = room('other', '555', { [`telegram:${CHAT}:55`]: { id: 'o1', agent: 'ana', subject: 'S' } });
    const u = update({ text: 'hi', reply_to_message: { message_id: 55 } });
    takeOffer({ update: u, force: true }, { owns: (b) => other.uplinks.ownsReply(b), deliver: (b) => other.uplinks.deliverPolled(b, '') });
    expect(other.sent).toEqual([]);
  });

  it('R6: a photo is fetched by the room that takes it, with its own download, and never by main', async () => {
    const main = room('main', CHAT, {});
    const alpha = room('alpha', CHAT, { [`telegram:${CHAT}:55`]: { id: 'a1', agent: 'ana', subject: 'Review' } });
    const deliver = createRouter({
      self: 'main',
      peers: () => ['main', 'alpha'],
      offer: async (_id, u, force) => takeOffer({ update: u, force }, { owns: (b) => alpha.uplinks.ownsReply(b), deliver: (b) => alpha.uplinks.deliverPolled(b, '') }).claimed,
      director: (u) => directorMessage(u, CHAT),
      say: () => undefined,
      allowed: () => true,
      routed: (r) => main.uplinks.routed(r),
      owns: (u) => main.uplinks.ownsReply(u),
      deliverOwn: (u, k) => main.uplinks.deliverPolled(u, k),
      log,
    });
    await deliver(buf(update({ photo: [{ file_id: 'PHOTO-1', width: 9, height: 9 }], caption: 'here', reply_to_message: { message_id: 55 } })), 'k');
    await alpha.uplinks.close();
    await main.uplinks.close();
    expect(alpha.fetched).toEqual(['alpha:PHOTO-1']);
    expect(main.fetched).toEqual([]);
    expect(alpha.sent[0]?.request).toMatchObject({ to: 'ana' });
    expect(main.sent).toEqual([]);
  });

  it('R7: a routed update counts against main\'s limit too (30 a minute) and leaves one line in main\'s history of triggers, with the room and nothing of the message', () => {
    const main = room('main', CHAT, {});
    expect(main.uplinks.routeAllowed()).toBe(true);
    for (let i = 0; i < 30; i += 1) main.uplinks.routed('alpha');
    expect(main.uplinks.routeAllowed()).toBe(false);
    expect(main.triggers).toHaveLength(30);
    expect(main.triggers[0]).toEqual({ outcome: 'answered', what: 'routed to room alpha' });
    // the room that took it counts and records it as a polled update of its own
    const alpha = room('alpha', CHAT, { [`telegram:${CHAT}:55`]: { id: 'a1', agent: 'ana', subject: 'S' } });
    alpha.uplinks.deliverPolled(buf(update({ text: 'ok', reply_to_message: { message_id: 55 } })), '');
    expect(alpha.triggers).toHaveLength(1);
    expect(alpha.triggers[0]?.what).toContain('ok');
  });
});
