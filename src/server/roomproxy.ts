/**
 * The proxy of the rooms supervisor (docs/rooms-spec.md, docs/single-mode-spec.md): `/r/<id>/...` on the front port reaches the gonogo process
 * of that room; main is a room like any other, at `/r/main/`, and `/` is the list of rooms. What 0.4 and 0.5.0 gave out for main at the root keeps
 * working as an alias to main: the API (`/api`, `/ws`), the webhooks and station calls (`/uplink/`, `/dock/`) and the installed app's own files (`/sw.js`, the
 * manifest, the icons). A GET of any other path of the old main (its page, its assets) is a 308 to `/r/main/...`.
 * Reserved (the supervisor's own, never proxied): `/` itself, `/rooms` and under it, `/api/rooms` and `/api/auth` and under them, `/login`, `/setup`, `/internal` and under it, and `/r`.
 *
 * It is on the security path, so it is small and says no by default:
 * - The browser is let in by the login (docs/login-spec.md): a session cookie, an API key, or, on a fresh install with no account, the old
 *   Director token; the local unix socket needs none. The proxy asks `auth` who a request is, then reaches the room over the room's own
 *   `run/room.sock`, which has no token: no secret of the browser, no cookie and no X-Forwarded header of the request goes to a room.
 * - Without a grant only a plain GET or HEAD outside `/api` and `/ws` goes through (the page and its assets, which a room serves without
 *   a token anyway), with no Authorization at all. A cookie-authenticated change needs a matching Origin (CSRF), a key is held to its scope,
 *   and a WebSocket is bound to its session: it closes when the session ends.
 * - `/uplink/` and `/dock/` (webhooks and other stations, which prove themselves with a signature) go through with no
 *   Authorization either. `/hook/` and `/mcp/` are for the agents of a room, who use that room's own loopback port: here they are 404.
 * - A room id is `[a-z][a-z0-9-]{0,23}`; a path with `..`, an encoded slash or dot, a backslash, a NUL or an empty segment is 400. The path is
 *   decoded ONCE and the reserved check and that check run on the same decoded, case-exact text, before anything is routed (S1).
 * - `Set-Cookie` is dropped from every answer (S2): a room can never set a cookie on the shared address.
 * - Host and Origin are checked as a room checks them, then rewritten to the room's loopback address (the room checks them again).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Grant } from './authhttp.js';
import { keyMayDo } from './auth.js';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WS_TOKEN_PROTOCOL_PREFIX } from '../shared/protocol.js';
import { readBody, sendText } from './hooks.js';
import { validRoomId } from './rooms.js';
import { hostName } from './web.js';

export interface ProxyRoom {
  id: string;
  /** The loopback port of the room's gonogo, or null while it is not running. */
  port: number | null;
  /** The room's own unix socket (`<room home>/run/room.sock`): the only way in, and it takes no token. */
  socket: string;
}

/** What the proxy asks of the login. */
export interface ProxyAuth {
  grant(req: IncomingMessage, touch?: 'api' | 'input' | 'none'): Grant | null;
  grantUpgrade(req: IncomingMessage): Grant | null;
  csrfOk(req: IncomingMessage): boolean;
  /** The headers of a page (CSP and friends). */
  pageHeaders(): Record<string, string>;
  alive(sessionId: string): boolean;
  touchSession(sessionId: string): void;
  stepUpBody(method: string, path: string): boolean;
  stepUpNeeded(grant: Grant, method: string, path: string, body: Record<string, unknown> | null): string | null;
  stepUpDenied(req: IncomingMessage, res: ServerResponse, reason: string, tui?: boolean): void;
}

export interface RoomProxyOptions {
  auth: ProxyAuth;
  rooms(): ProxyRoom[];
  /** Host names this server may be reached by (besides loopback). */
  allowedNames: ReadonlySet<string>;
  /** Hooks-only hosts (`--allow-host name:hooks`, docs/expose-spec.md): answered for /uplink/* and /dock/* and nothing else; never the page, the login or a socket. */
  hooksHosts?: ReadonlySet<string>;
}

export interface RoomProxy {
  /** True when the request was proxied or refused here; false when it is the supervisor's own (a reserved path). */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** True when the upgrade was proxied or refused here; false for a reserved path. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Ends every WebSocket that is open through the proxy (the Director token changed: the page reconnects with the new one). */
  closeSockets(): void;
  /** Ends the WebSockets bound to these sessions (revoked, logged out, expired, password changed). */
  closeSessions(ids: readonly string[]): void;
  /** A session's id was minted again (step-up): its sockets stay open, bound to the new id. */
  rebind(from: string, to: string): void;
  /** Stops the once-a-minute check of the sockets' sessions. */
  close(): void;
}

const PREFIX = /^\/r\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/;
/** The old main's paths that stay at the root as an alias of `/r/main/`: what a script, a webhook, a peer station or the installed app was given. Every other GET of the root is moved. */
const ROOT_ALIASES = /^\/(?:api|ws|uplink|dock|hook|mcp)(?:\/|$)|^\/(?:sw\.js|manifest\.webmanifest|apple-touch-icon\.png|favicon\.(?:ico|svg)|icon-[\w-]+\.png|lockup\.svg)$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const DROPPED = new Set(['authorization', 'cookie', 'host', 'origin', 'forwarded', 'x-real-ip']);
/** The one header the proxy adds for a room (docs/features/relay.md): "this POST /api/messages was made by a browser session that is signed in". Whatever a sender puts under any `x-gonogo-` name is dropped first, so only this code can say it. */
export const DIRECTOR_HEADER = 'x-gonogo-director';
/** Who asked, for a change of the room's settings: `session`, `key:<id>`, `token`, `socket` or `tui`. The room believes it only from this socket; a sender's own copy is dropped like every x-gonogo- header. */
export const ACTOR_HEADER = 'x-gonogo-actor';
const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
export const sameToken = (candidate: string | null, expected: string): boolean => candidate !== null && timingSafeEqual(digest(candidate), digest(expected));

type Kind = 'browser' | 'passthrough' | 'closed';

/** What the first segment of the path inside a room is for. */
function kindOf(rest: string): Kind {
  // decoded, because a room's router decodes it (/%68ook is /hook there); suspicious() has already made sure it decodes
  const first = decodeURIComponent(rest.split('/')[1] ?? '');
  // case-insensitive on purpose: a router that folds case must not find an agent's route through here
  if (['hook', 'mcp'].includes(first.toLowerCase())) return 'closed';
  // the route the rooms of an install offer each other Telegram updates on (telegramroute.ts) is for the local socket and the other rooms, not for a browser or a tunnel
  const [, , second = '', third = ''] = rest.split('?')[0]!.split('/').map((s) => decodeURIComponent(s).toLowerCase());
  if (first.toLowerCase() === 'api' && second === 'telegram' && third !== '') return 'closed';
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
  // the list of rooms is "/" exactly ("//" and the like are no path of anything)
  if (segments.length === 2 && first === '') return true;
  return first === 'rooms' || first === 'internal' || first === 'login' || first === 'setup' || (first === 'api' && (segments[2] === 'rooms' || segments[2] === 'auth' || segments[2] === 'push'));
}

export function createRoomProxy(options: RoomProxyOptions): RoomProxy {
  const hostAllowed = (header: string | undefined): boolean => {
    const name = header === undefined ? null : hostName(header);
    return name !== null && (['127.0.0.1', 'localhost', '::1'].includes(name) || options.allowedNames.has(name) || (options.hooksHosts?.has(name) ?? false));
  };
  const hooksOnly = (header: string | undefined): boolean => {
    const name = header === undefined ? null : hostName(header);
    return name !== null && (options.hooksHosts?.has(name) ?? false) && !options.allowedNames.has(name);
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
    /** The first segment of the path inside the room, DECODED: every decision (the login, a key's scope, the agents' routes) is made on this and on `decoded`, never on the raw text. */
    first: string;
    /** The path inside the room, decoded once and joined again (no query): what the checks look at. */
    decoded: string;
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
    // nothing but slashes names nothing: a plain 404, as a room gives (an empty segment before a name is the 400 below)
    if (prefixed === null && /^\/{2,}$/.test(rest)) return (fail(404, 'not found'), null);
    // one decode, then the same text goes to both checks
    if (suspicious(rest)) return (fail(400, 'bad path'), null);
    if (prefixed === null && reservedPath(rest)) return (fail(404, 'not found'), null);
    const kind = kindOf(rest);
    if (kind === 'closed') return (fail(404, 'not found'), null);
    // a hooks host has no page: the decision is on the decoded first segment, the same one the room routes by
    if (kind !== 'passthrough' && hooksOnly(req.headers.host)) return (fail(404, 'not found'), null);
    const room = options.rooms().find((r) => r.id === id);
    if (room === undefined) return (fail(404, 'no such room'), null);
    if (room.port === null) return (fail(503, 'the room is not running'), null);
    // decoded once, per segment (suspicious() has made sure each one decodes and holds no slash, dot segment or NUL); the room is sent the path
    // built again from exactly these segments, so it routes what was checked here: %61pi is api in both places or in neither
    const segments = rest.split('/').map((segment) => decodeURIComponent(segment));
    const canonical = segments.map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment))).join('/');
    return {
      room: { ...room, port: room.port },
      path: canonical + (prefixed === null ? parts.query : (prefixed[3] ?? '')),
      kind,
      id,
      prefixed: prefixed !== null,
      first: segments[1] ?? '',
      decoded: segments.join('/'),
    };
  }

  /** The headers for the room: no secret of the browser; the socket is the credential. */
  function forwardHeaders(req: IncomingMessage, target: Target, upgrade: boolean, director = false, actor: string | null = null): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (DROPPED.has(lower) || lower.startsWith('x-forwarded-') || lower.startsWith('x-gonogo-') || (!upgrade && HOP.has(lower))) continue;
      if (upgrade && lower === 'sec-websocket-protocol') continue;
      out[lower] = value;
    }
    out.host = `127.0.0.1:${target.room.port}`;
    if (director) out[DIRECTOR_HEADER] = 'web';
    if (actor !== null) out[ACTOR_HEADER] = actor;
    // a browser's Origin was checked above and now names the room; another sender's is kept, so the room refuses it as it would
    if (req.headers.origin !== undefined) out.origin = target.kind === 'browser' ? `http://127.0.0.1:${target.room.port}` : req.headers.origin;
    if (upgrade) {
      out.connection = 'Upgrade';
      out.upgrade = 'websocket';
    }
    return out;
  }

  /** The browser sockets that are open through the proxy, with the session each is bound to (none for a key, the token or the local socket). */
  const open = new Map<Duplex, string | null>();
  /** A session that ended must not leave a socket open: every minute each bound socket asks whether its session is alive. */
  const recheck = setInterval(() => {
    for (const [socket, session] of [...open]) if (session !== null && !options.auth.alive(session)) socket.destroy();
  }, 60_000);
  recheck.unref();

  return {
    closeSockets() {
      for (const socket of [...open.keys()]) socket.destroy();
    },
    rebind(from, to) {
      for (const [socket, session] of [...open]) if (session === from) open.set(socket, to);
    },
    closeSessions(ids) {
      const set = new Set(ids);
      for (const [socket, session] of [...open]) if (session !== null && set.has(session)) socket.destroy();
    },
    close() {
      clearInterval(recheck);
    },
    handle(req, res) {
      if (isReserved(req.url ?? '')) return false;
      // /r/<id> without the slash: the page needs it for its relative asset paths
      const bare = /^\/r\/([a-z][a-z0-9-]{0,23})(\?[^#]*)?$/.exec(req.url ?? '');
      if (bare !== null) {
        res.writeHead(308, { Location: `/r/${bare[1]}/${bare[2] ?? ''}`, 'Content-Length': 0 });
        res.end();
        return true;
      }
      // an old address of main's page or assets: moved to /r/main/ (the query stays, the #fragment stays in the browser)
      if ((req.method === 'GET' || req.method === 'HEAD') && PREFIX.exec(req.url ?? '') === null) {
        const old = split(req.url ?? '');
        // decided on the decoded path, as the room routes it: /%61pi/x is the alias /api/x, not a page
        const plain = old !== null && !suspicious(old.path) ? old.path.split('/').map((segment) => decodeURIComponent(segment)).join('/') : null;
        if (old !== null && plain !== null && old.path.length > 1 && !old.path.startsWith('//') && !plain.startsWith('/r/') && plain !== '/r' && !ROOT_ALIASES.test(plain) && hostAllowed(req.headers.host) && !hooksOnly(req.headers.host)) {
          res.writeHead(308, { Location: `/r/main${old.path}${old.query}`, 'Content-Length': 0 });
          res.end();
          return true;
        }
      }
      const target = resolve(req, (status, text) => sendText(res, status, text));
      if (target === null) return true;
      if (!originOk(req) && target.kind === 'browser') {
        sendText(res, 403, 'forbidden origin');
        return true;
      }
      // case does not matter to a router that folds it, so API and Ws are asked about too
      const first = target.first.toLowerCase();
      /** What the step-up asks about this change, when a session makes it: after the body is read when the body decides. */
      let stepUp: { grant: Grant; method: string; path: string } | null = null;
      // a message of the Director: the browser route of messages, with a login session (or the browser token of an install with no account yet). Not a key, not the local socket, not a terminal.
      let director = false;
      let actor: string | null = null;
      if (target.kind === 'browser' && !((req.method === 'GET' || req.method === 'HEAD') && first !== 'api' && first !== 'ws')) {
        const grant = options.auth.grant(req, 'api');
        if (grant === null) {
          sendText(res, 401, 'unauthorized');
          return true;
        }
        // a cookie authenticates the request: the change must come from this very page (Origin required, SameSite is the second wall)
        if (grant.kind === 'session' && !options.auth.csrfOk(req)) {
          sendText(res, 403, 'forbidden origin');
          return true;
        }
        if (grant.kind === 'key' && !keyMayDo(grant.scope ?? 'read', req.method ?? 'GET', target.decoded)) {
          sendText(res, 403, 'this key may not do that');
          return true;
        }
        if (grant.kind === 'session' || grant.kind === 'tui') stepUp = { grant, method: req.method ?? 'GET', path: target.decoded };
        director = (grant.kind === 'session' || grant.kind === 'token') && req.method === 'POST' && target.decoded === '/api/messages';
        if (target.decoded.startsWith('/api/settings') || target.decoded === '/api/docking/addresses') actor = grant.kind === 'key' ? `key:${(grant.keyId ?? '').slice(0, 12)}` : grant.kind;
      }
      const forward = (buffered: Buffer | null): void => {
        const upstream = http.request(
        { socketPath: target.room.socket, method: req.method, path: target.path, headers: forwardHeaders(req, target, false, director, actor) },
        (answer) => {
          const headers: http.OutgoingHttpHeaders = {};
          // no Set-Cookie: a room must not set a cookie on the address all the rooms share (S2); no Service-Worker-Allowed: a room's script cannot widen its scope
          for (const [name, value] of Object.entries(answer.headers)) if (!HOP.has(name) && name !== 'set-cookie' && name !== 'service-worker-allowed') headers[name] = value;
          // the CSP of the room's pages is the supervisor's, not the room's (threat model 3)
          if (target.kind === 'browser' && String(headers['content-type'] ?? '').startsWith('text/html')) Object.assign(headers, options.auth.pageHeaders());
          // a redirect to a path of the room stays inside its prefix; room main at / has none
          if (target.prefixed && typeof headers.location === 'string' && headers.location.startsWith('/') && !headers.location.startsWith('//')) headers.location = `/r/${target.id}${headers.location}`;
          res.writeHead(answer.statusCode ?? 502, headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => sendText(res, 502, 'the room did not answer'));
      res.on('close', () => upstream.destroy());
      if (buffered === null) req.pipe(upstream);
      else upstream.end(buffered);
      };
      if (stepUp === null) {
        forward(null);
        return true;
      }
      const asked = stepUp;
      if (!options.auth.stepUpBody(asked.method, asked.path)) {
        const reason = options.auth.stepUpNeeded(asked.grant, asked.method, asked.path, null);
        if (reason !== null) options.auth.stepUpDenied(req, res, reason, asked.grant.kind === 'tui');
        else forward(null);
        return true;
      }
      // a hire or an edit of an agent: the body says whether it needs the password again, so it is read (64 KiB) and then sent on
      void readBody(req, 64 * 1024).then((got) => {
        if (!got.ok) return void sendText(res, got.reason === 'too_large' ? 413 : 400, 'the body could not be read');
        let parsed: Record<string, unknown> | null = null;
        try {
          const value: unknown = JSON.parse(got.body.toString('utf8'));
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch {
          // not JSON: the room answers 400; the strictest reading of a body nobody could read is that it needs the check
        }
        const reason = options.auth.stepUpNeeded(asked.grant, asked.method, asked.path, parsed);
        if (reason !== null) options.auth.stepUpDenied(req, res, reason, asked.grant.kind === 'tui');
        else forward(got.body);
      });
      return true;
    },

    upgrade(req, socket, head) {
      if (isReserved(req.url ?? '')) return false;
      const refuse = (status: number, text: string): void => {
        socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
      };
      const target = resolve(req, refuse);
      if (target === null) return true;
      if (target.kind !== 'browser' || target.first !== 'ws') return (refuse(404, 'not found'), true);
      if (!originOk(req)) return (refuse(403, 'forbidden origin'), true);
      const grant = options.auth.grantUpgrade(req);
      if (grant === null) return (refuse(401, 'unauthorized'), true);
      // a socket is a console: only a session, the local socket, the old token or a full key may open one (a read or act key may not type)
      if (grant.kind === 'key' && grant.scope !== 'full') return (refuse(403, 'this key may not open a console'), true);
      // a cookie opens the socket only from a page: an upgrade with no Origin is refused (cross-site WebSocket hijack)
      if (grant.kind === 'session' && req.headers.origin === undefined) return (refuse(403, 'forbidden origin'), true);
      // no token entry goes on: the room's socket takes none
      const offered = String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '' && !entry.startsWith(WS_TOKEN_PROTOCOL_PREFIX));
      const headers = forwardHeaders(req, target, true);
      headers['sec-websocket-protocol'] = offered.join(', ');
      const upstream = http.request({ socketPath: target.room.socket, method: 'GET', path: target.path, headers });
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
        // a session's socket ends with the session, a key's with the key (revoked or expired)
        const bound = grant.kind === 'session' || grant.kind === 'tui' ? (grant.sessionId ?? null) : grant.kind === 'key' && grant.keyId !== undefined ? `key:${grant.keyId}` : null;
        open.set(socket, bound);
        socket.once('close', () => open.delete(socket));
        // input to a console is use of the session; output is not, and a pong (the browser's reply to our ping) is neither: only text and binary frames count
        if (bound !== null && !bound.startsWith('key:')) {
          socket.on('data', (chunk: Buffer) => {
            const opcode = (chunk[0] ?? 0) & 0x0f;
            // the id it is bound to NOW: a step-up mints the id again and rebind() moves the socket, so the one captured above would be the dead one
            const now = open.get(socket);
            if ((opcode === 1 || opcode === 2) && now !== undefined && now !== null && !now.startsWith('key:')) options.auth.touchSession(now);
          });
        }
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
