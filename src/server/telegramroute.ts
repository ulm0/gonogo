/**
 * Telegram and several rooms (docs/features/relay.md): one bot has ONE getUpdates consumer, and that is room main's process, but every room can send to the
 * Director through the same bot. A reply to a message that room X sent has to reach room X, and only X knows that message (its map of forwarded
 * messages is in its own process). So main's poller is a router:
 *
 *   - a reply to something main sent, a plain message, a button: main, as before;
 *   - a reply to something main did not send: offered to the other rooms in turn, over their local sockets, and the first room whose own map knows the
 *     replied-to message takes it (and runs it through ITS OWN read: its chat, its Director mark, its files); nobody claims it: main, as before;
 *   - a plain message that starts `/room <id> `: that room, with the prefix taken off; an id that is no room: main, untouched.
 *
 * The offer is a POST to `/api/telegram/route` of the other room's socket with a key that only the supervisor and its rooms have (an environment variable
 * agents never get). The room never routes onward, so there is no loop. Buttons (phone approvals) are not routed: a room other than main has no polling
 * secret to sign them (known limit, said in the docs). Nothing here sends a token anywhere: the update holds none.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { Logger } from '../shared/protocol.js';
import { isRecord } from './hooks.js';
import { validRoomId } from './rooms.js';

export const ROUTE_PATH = '/api/telegram/route';
export const ROUTE_KEY_HEADER = 'x-gonogo-route-key';
export const ROUTE_TIMEOUT_MS = 3000;
export const ROUTE_BODY_MAX_BYTES = 256 * 1024;

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const get = (v: unknown, path: string): unknown => path.split('.').reduce<unknown>((at, k) => (isRecord(at) ? at[k] : undefined), v);

/** `telegram:<chat>:<message id>`: the message this update replies to, as the rooms key what they sent. null for anything that is not a reply to a message. */
export function replyKey(update: unknown): string | null {
  if (!isRecord(update) || !isRecord(update.message)) return null;
  const chat = str(get(update, 'message.chat.id'));
  const to = str(get(update, 'message.reply_to_message.message_id'));
  return chat === '' || to === '' ? null : `telegram:${chat}:${to}`;
}

/** `/room <id> text` at the start of a plain text or a caption: the room, and the update with the prefix taken off. null when it is not that. */
export function roomPrefix(update: unknown): { room: string; update: Record<string, unknown> } | null {
  if (!isRecord(update) || !isRecord(update.message)) return null;
  const field = typeof update.message.text === 'string' ? 'text' : typeof update.message.caption === 'string' ? 'caption' : null;
  if (field === null) return null;
  const m = /^\/room[ \t]+(\S{1,32})(?:[ \t]+([\s\S]*))?$/.exec((update.message[field] as string).trim());
  if (m === null || !validRoomId(m[1])) return null;
  return { room: m[1], update: { ...update, message: { ...update.message, [field]: (m[2] ?? '').trim() } } };
}

export interface RouterOptions {
  /** This process's room. */
  self: string;
  /** The other rooms, by id (main first). */
  peers(): string[];
  /** Offers an update to a room; true when that room took it. Never throws. */
  offer(room: string, update: Record<string, unknown>, force: boolean): Promise<boolean>;
  /** Main's own: does it know the message this update replies to? */
  owns(update: Buffer): boolean;
  /** Main's own path: the update goes through the read of this process. */
  deliverOwn(update: Buffer, secret: string): void;
  log: Logger;
}

/** The `deliver` of the poller. */
export function createRouter(options: RouterOptions): (update: Buffer, secret: string) => Promise<void> {
  const { self, log } = options;
  return async (raw, secret) => {
    let update: unknown;
    try {
      update = JSON.parse(raw.toString('utf8'));
    } catch {
      return options.deliverOwn(raw, secret);
    }
    const others = options.peers().filter((id) => id !== self);
    if (others.length === 0 || !isRecord(update) || update.callback_query !== undefined) return options.deliverOwn(raw, secret);
    const prefixed = roomPrefix(update);
    if (prefixed !== null) {
      if (prefixed.room === self) return options.deliverOwn(Buffer.from(JSON.stringify(prefixed.update)), secret);
      if (others.includes(prefixed.room)) {
        if (await options.offer(prefixed.room, prefixed.update, true)) return;
        log.warn(`telegram: the room ${prefixed.room} did not take the message: it stays with this room`);
      }
      return options.deliverOwn(raw, secret);
    }
    if (replyKey(update) !== null && !options.owns(raw)) {
      for (const room of others) if (await options.offer(room, update, false)) return;
    }
    return options.deliverOwn(raw, secret);
  };
}

/** The key of a supervisor start, compared in constant time. */
export function sameKey(given: string | undefined, key: string): boolean {
  if (given === undefined || key === '') return false;
  const a = createHmac('sha256', 'gonogo-route').update(given).digest();
  const b = createHmac('sha256', 'gonogo-route').update(key).digest();
  return timingSafeEqual(a, b);
}

export interface RoomSide {
  /** Does this room know the message the update replies to? */
  owns(update: Buffer): boolean;
  deliver(update: Buffer): void;
}

/** What a room answers to an offer: `{ claimed }`. Throws nothing; a body that is not an update is not claimed. */
export function takeOffer(body: Record<string, unknown>, room: RoomSide): { claimed: boolean } {
  const update = body.update;
  if (!isRecord(update) || update.callback_query !== undefined || !isRecord(update.message)) return { claimed: false };
  const raw = Buffer.from(JSON.stringify(update));
  // `force` is the `/room` prefix: the Director named this room. Without it only the room that sent the message replied to takes the update.
  if (body.force !== true && !room.owns(raw)) return { claimed: false };
  room.deliver(raw);
  return { claimed: true };
}

/** One offer over a room's local socket. false for anything that goes wrong (the room is stopped, slow, or answers no). */
export function offerOverSocket(socketPath: string, key: string, update: Record<string, unknown>, force: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ update, force });
    const req = http.request(
      { socketPath, path: ROUTE_PATH, method: 'POST', timeout: ROUTE_TIMEOUT_MS, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [ROUTE_KEY_HEADER]: key } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if ((text += chunk).length > 4096) req.destroy();
        });
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 && (JSON.parse(text) as { claimed?: unknown }).claimed === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}
