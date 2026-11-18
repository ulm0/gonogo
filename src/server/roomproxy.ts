/**
 * The proxy of the rooms supervisor (docs/rooms-spec.md): `/r/<id>/...` on the front port reaches the gonogo process of that room.
 *
 * It is on the security path, so it is small and says no by default:
 * - The browser holds one secret, the Director token. The proxy checks it and swaps in the room's own browser token on the way
 *   (the Authorization header, or the `token.` entry of the WebSocket subprotocols). Every other Authorization header, every
 *   cookie and every X-Forwarded header of the request is dropped, so the Director token never reaches a room, and a room's token
 *   never leaves the supervisor.
 * - Without the Director token only a plain GET or HEAD outside `/api` and `/ws` goes through (the page and its assets, which a
 *   room serves without a token anyway), with no Authorization at all.
 * - `/uplink/` and `/dock/` (webhooks and other stations, which prove themselves with a signature) go through with no
 *   Authorization either. `/hook/` and `/mcp/` are for the agents of a room, who use that room's own loopback port: here they are 404.
 * - A room id is `[a-z][a-z0-9-]{0,23}`; a path with `..`, an encoded slash or a NUL is 400.
 * - Host and Origin are checked as a room checks them, then rewritten to the room's loopback address (the room checks them again).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WS_TOKEN_PROTOCOL_PREFIX } from '../shared/protocol.js';
import { bearerToken, sendText } from './hooks.js';
import { validRoomId } from './rooms.js';
import { hostName } from './web.js';

export interface ProxyRoom {
  id: string;
  /** The loopback port of the room's gonogo, or null while it is not running. */
  port: number | null;
  /** The room's own browser token, or null while it is not known. */
  token: string | null;
}

export interface RoomProxyOptions {
  /** The one secret of the browser. */
  directorToken: string;
  rooms(): ProxyRoom[];
  /** Host names this server may be reached by (besides loopback). */
  allowedNames: ReadonlySet<string>;
}

export interface RoomProxy {
  /** True when the request was for `/r/...` (answered or proxied); false when it is the supervisor's own. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** True when the upgrade was for `/r/...`. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

const PREFIX = /^\/r\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const DROPPED = new Set(['authorization', 'cookie', 'host', 'origin', 'forwarded', 'x-real-ip']);
const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
export const sameToken = (candidate: string | null, expected: string): boolean => candidate !== null && timingSafeEqual(digest(candidate), digest(expected));

type Kind = 'browser' | 'passthrough' | 'closed';

/** What the first segment of the path inside a room is for. */
function kindOf(rest: string): Kind {
  const first = rest.split('/')[1] ?? '';
  if (first === 'hook' || first === 'mcp') return 'closed';
  if (first === 'uplink' || first === 'dock') return 'passthrough';
  return 'browser';
}

/** A path that tries to leave the room: `..`, an encoded slash or dot, a backslash, a NUL. */
function suspicious(rest: string): boolean {
  for (const segment of rest.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === '..' || decoded === '.' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return true;
  }
  return false;
}

const directorFromSubprotocols = (header: string | string[] | undefined): string | null => {
  if (typeof header !== 'string') return null;
  for (const entry of header.split(',')) {
    const protocol = entry.trim();
    if (protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return protocol.slice(WS_TOKEN_PROTOCOL_PREFIX.length);
  }
  return null;
};

export function createRoomProxy(options: RoomProxyOptions): RoomProxy {
  const hostAllowed = (header: string | undefined): boolean => {
    const name = header === undefined ? null : hostName(header);
    return name !== null && (['127.0.0.1', 'localhost', '::1'].includes(name) || options.allowedNames.has(name));
  };

  /** A browser's Origin must be this very server, as a room demands it of its own address. */
  const originOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      const url = new URL(origin);
      return url.host.toLowerCase() === (req.headers.host ?? '').toLowerCase() && hostAllowed(url.host);
    } catch {
      return false;
    }
  };

  interface Target {
    room: ProxyRoom & { port: number };
    path: string;
    kind: Exclude<Kind, 'closed'>;
    id: string;
  }

  /** Resolves `/r/<id>/<rest>`; answers the error itself and returns null when it cannot. */
  function resolve(req: IncomingMessage, fail: (status: number, text: string) => void): Target | null {
    const match = PREFIX.exec(req.url ?? '');
    if (match === null) return (fail(404, 'not found'), null);
    const [, id = '', rest = '/', query = ''] = match;
    if (!validRoomId(id)) return (fail(404, 'no such room'), null);
    if (!hostAllowed(req.headers.host)) return (fail(403, 'forbidden host'), null);
    if (suspicious(rest)) return (fail(400, 'bad path'), null);
    const kind = kindOf(rest);
    if (kind === 'closed') return (fail(404, 'not found'), null);
    const room = options.rooms().find((r) => r.id === id);
    if (room === undefined) return (fail(404, 'no such room'), null);
    if (room.port === null || room.token === null) return (fail(503, 'the room is not running'), null);
    return { room: { ...room, port: room.port }, path: rest + query, kind, id };
  }

  /** The headers for the room: no secret of the browser, the room's own token only when the Director proved himself. */
  function forwardHeaders(req: IncomingMessage, target: Target, withRoomToken: boolean, upgrade: boolean): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (DROPPED.has(lower) || lower.startsWith('x-forwarded-') || (!upgrade && HOP.has(lower))) continue;
      if (upgrade && lower === 'sec-websocket-protocol') continue;
      out[lower] = value;
    }
    out.host = `127.0.0.1:${target.room.port}`;
    // a browser's Origin was checked above and now names the room; another sender's is kept, so the room refuses it as it would
    if (req.headers.origin !== undefined) out.origin = target.kind === 'browser' ? `http://127.0.0.1:${target.room.port}` : req.headers.origin;
    if (withRoomToken && !upgrade) out.authorization = `Bearer ${target.room.token}`;
    if (upgrade) {
      out.connection = 'Upgrade';
      out.upgrade = 'websocket';
    }
    return out;
  }

  const directorOk = (token: string | null): boolean => sameToken(token, options.directorToken);

  return {
    handle(req, res) {
      if (!(req.url ?? '').startsWith('/r/') && req.url !== '/r') return false;
      // /r/<id> without the slash: the page needs it for its relative asset paths
      const bare = /^\/r\/([a-z][a-z0-9-]{0,23})(\?[^#]*)?$/.exec(req.url ?? '');
      if (bare !== null) {
        res.writeHead(308, { Location: `/r/${bare[1]}/${bare[2] ?? ''}`, 'Content-Length': 0 });
        res.end();
        return true;
      }
      const target = resolve(req, (status, text) => sendText(res, status, text));
      if (target === null) return true;
      if (!originOk(req) && target.kind === 'browser') {
        sendText(res, 403, 'forbidden origin');
        return true;
      }
      const first = target.path.split('/')[1]?.split('?')[0] ?? '';
      let withRoomToken = false;
      if (target.kind === 'browser') {
        if (directorOk(bearerToken(req.headers.authorization))) withRoomToken = true;
        else if (!((req.method === 'GET' || req.method === 'HEAD') && first !== 'api' && first !== 'ws')) {
          sendText(res, 401, 'unauthorized');
          return true;
        }
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: target.room.port, method: req.method, path: target.path, headers: forwardHeaders(req, target, withRoomToken, false) },
        (answer) => {
          const headers: http.OutgoingHttpHeaders = {};
          for (const [name, value] of Object.entries(answer.headers)) if (!HOP.has(name)) headers[name] = value;
          // a redirect to a path of the room stays inside its prefix
          if (typeof headers.location === 'string' && headers.location.startsWith('/') && !headers.location.startsWith('//')) headers.location = `/r/${target.id}${headers.location}`;
          res.writeHead(answer.statusCode ?? 502, headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => sendText(res, 502, 'the room did not answer'));
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return true;
    },

    upgrade(req, socket, head) {
      if (!(req.url ?? '').startsWith('/r/')) return false;
      const refuse = (status: number, text: string): void => {
        socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
      };
      const target = resolve(req, refuse);
      if (target === null) return true;
      const first = target.path.split('/')[1]?.split('?')[0] ?? '';
      if (target.kind !== 'browser' || first !== 'ws') return (refuse(404, 'not found'), true);
      if (!originOk(req)) return (refuse(403, 'forbidden origin'), true);
      if (!directorOk(directorFromSubprotocols(req.headers['sec-websocket-protocol']))) return (refuse(401, 'unauthorized'), true);
      const offered = String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .map((entry) => (entry.startsWith(WS_TOKEN_PROTOCOL_PREFIX) ? `${WS_TOKEN_PROTOCOL_PREFIX}${target.room.token}` : entry));
      const headers = forwardHeaders(req, target, false, true);
      headers['sec-websocket-protocol'] = offered.join(', ');
      const upstream = http.request({ host: '127.0.0.1', port: target.room.port, method: 'GET', path: target.path, headers });
      upstream.on('upgrade', (answer: IncomingMessage, roomSocket: Duplex, roomHead: Buffer) => {
        const lines = [`HTTP/1.1 101 Switching Protocols`];
        for (const [name, value] of Object.entries(answer.headers as IncomingHttpHeaders)) {
          for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) lines.push(`${name}: ${one}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (roomHead.length > 0) socket.write(roomHead);
        if (head.length > 0) roomSocket.write(head);
        roomSocket.pipe(socket);
        socket.pipe(roomSocket);
        const end = (): void => {
          roomSocket.destroy();
          socket.destroy();
        };
        roomSocket.on('error', end);
        socket.on('error', end);
        roomSocket.on('close', end);
        socket.on('close', end);
      });
      // the room said no (a bad token, a bad Origin): pass its answer on, without its headers beyond the type
      upstream.on('response', (answer) => {
        answer.resume();
        refuse(answer.statusCode ?? 502, 'refused');
      });
      upstream.on('error', () => refuse(502, 'the room did not answer'));
      socket.on('close', () => upstream.destroy());
      upstream.end();
      return true;
    },
  };
}
