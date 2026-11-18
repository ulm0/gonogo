/**
 * The proxy of the rooms supervisor (docs/rooms-spec.md, docs/single-mode-spec.md): `/r/<id>/...` on the front port reaches the gonogo process
 * of that room, and any path that is not reserved reaches room `main`, so a user with one room keeps every address he had.
 * Reserved (the supervisor's own, never proxied): `/rooms` and under it, `/api/rooms` and under it, `/internal` and under it, and `/r`.
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
 * - A room id is `[a-z][a-z0-9-]{0,23}`; a path with `..`, an encoded slash or dot, a backslash, a NUL or an empty segment is 400. The path is
 *   decoded ONCE and the reserved check and that check run on the same decoded, case-exact text, before anything is routed (S1).
 * - `Set-Cookie` is dropped from every answer (S2): a room can never set a cookie on the shared address.
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
  /** The one secret of the browser; a function so that a token rotated on disk is used at once. */
  directorToken: string | (() => string);
  rooms(): ProxyRoom[];
  /** Host names this server may be reached by (besides loopback). */
  allowedNames: ReadonlySet<string>;
}

export interface RoomProxy {
  /** True when the request was proxied or refused here; false when it is the supervisor's own (a reserved path). */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** True when the upgrade was proxied or refused here; false for a reserved path. */
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
  // case-insensitive on purpose: a router that folds case must not find an agent's route through here
  if (['hook', 'mcp'].includes(first.toLowerCase())) return 'closed';
  if (first === 'uplink' || first === 'dock') return 'passthrough';
  return 'browser';
}

/** A path that tries to leave the room: `..`, an encoded slash or dot, a backslash, a NUL. */
function suspicious(rest: string): boolean {
  const segments = rest.split('/');
  for (const [index, segment] of segments.entries()) {
    // an empty segment inside the path (`//internal/busy`) is how a check on the first segment gets stepped around; a trailing slash is fine
    if (segment === '' && index > 0 && index < segments.length - 1) return true;
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

/** The decoded, case-exact path (decoded once, per segment, after suspicious() passed) and whether it belongs to the supervisor. */
function reservedPath(rest: string): boolean {
  const segments = rest.split('/').map((segment) => decodeURIComponent(segment));
  const first = segments[1] ?? '';
  return first === 'rooms' || first === 'internal' || (first === 'api' && segments[2] === 'rooms');
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
    /** Reached under `/r/<id>/`: a redirect of the room is put back under that prefix. */
    prefixed: boolean;
  }

  /** Splits a url into path and query; null when it is not an origin-form path. */
  const split = (url: string): { path: string; query: string } | null => {
    const match = /^(\/[^?#]*)(\?[^#]*)?$/.exec(url);
    return match === null ? null : { path: match[1] as string, query: match[2] ?? '' };
  };

  /** True when the url is the supervisor's own (reserved) and nothing here should touch it. */
  const isReserved = (url: string): boolean => {
    const parts = split(url);
    if (parts === null || suspicious(parts.path)) return false;
    return reservedPath(parts.path);
  };

  /**
   * Resolves `/r/<id>/<rest>` or, for any path that is not reserved, room `main` at the same path; answers the error itself and returns null
   * when it cannot.
   */
  function resolve(req: IncomingMessage, fail: (status: number, text: string) => void): Target | null {
    const parts = split(req.url ?? '');
    if (parts === null) return (fail(400, 'bad request'), null);
    if (!hostAllowed(req.headers.host)) return (fail(403, 'forbidden host'), null);
    const prefixed = PREFIX.exec(req.url ?? '');
    let id = 'main';
    let rest = parts.path;
    if (prefixed !== null) {
      id = prefixed[1] ?? '';
      rest = prefixed[2] ?? '/';
      if (!validRoomId(id)) return (fail(404, 'no such room'), null);
    } else if ((parts.path.split('/')[1] ?? '') === 'r') {
      // /r and /r/ name no room
      return (fail(404, 'no such room'), null);
    }
    // one decode, then the same text goes to both checks
    if (suspicious(rest)) return (fail(400, 'bad path'), null);
    if (prefixed === null && reservedPath(rest)) return (fail(404, 'not found'), null);
    const kind = kindOf(rest);
    if (kind === 'closed') return (fail(404, 'not found'), null);
    const room = options.rooms().find((r) => r.id === id);
    if (room === undefined) return (fail(404, 'no such room'), null);
    if (room.port === null || room.token === null) return (fail(503, 'the room is not running'), null);
    return { room: { ...room, port: room.port }, path: rest + (prefixed === null ? parts.query : (prefixed[3] ?? '')), kind, id, prefixed: prefixed !== null };
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

  const directorOk = (token: string | null): boolean => sameToken(token, typeof options.directorToken === 'string' ? options.directorToken : options.directorToken());

  return {
    handle(req, res) {
      if (isReserved(req.url ?? '')) return false;
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
          // no Set-Cookie: a room must not set a cookie on the address all the rooms share (S2)
          for (const [name, value] of Object.entries(answer.headers)) if (!HOP.has(name) && name !== 'set-cookie') headers[name] = value;
          // a redirect to a path of the room stays inside its prefix; room main at / has none
          if (target.prefixed && typeof headers.location === 'string' && headers.location.startsWith('/') && !headers.location.startsWith('//')) headers.location = `/r/${target.id}${headers.location}`;
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
      if (isReserved(req.url ?? '')) return false;
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
