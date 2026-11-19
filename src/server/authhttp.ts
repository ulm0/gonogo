/**
 * The HTTP face of the login, in the supervisor (docs/login-spec.md): the pages, `/api/auth/...`, the cookies, and the one question the proxy
 * asks of every request: who is this (`grant`).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../shared/protocol.js';
import { WS_TOKEN_PROTOCOL_PREFIX } from '../shared/protocol.js';
import { hostClass, isLocalClass, KEY_SCOPES, LIFETIME } from './auth.js';
import type { AuthStore, HostClass, KeyScope, LoginResult, Who } from './auth.js';
import { authPage, authPageHeaders } from './authpage.js';
import type { AuthPageKind } from './authpage.js';
import { nullLogger } from './constants.js';
import { bearerToken, readBody, sendApiError, sendJson, sendText } from './hooks.js';

export const SESSION_COOKIE_PUBLIC = '__Host-gonogo';
export const SESSION_COOKIE_LOCAL = 'gonogo-session';
export const DEVICE_COOKIE = 'gonogo-device';
const FORM_MAX = 8 * 1024;
const YEAR_S = 365 * 24 * 60 * 60;

export interface Grant {
  kind: 'session' | 'key' | 'socket' | 'token';
  sessionId?: string;
  scope?: KeyScope;
}

export interface AuthHttpOptions {
  auth: AuthStore;
  /** The old Director token; asked only while a fresh install has no account. */
  legacyToken(): string | null;
  /** Host names this server may be reached by (as the proxy checks). */
  hostOk(host: string | undefined): boolean;
  stylesheet: string | null;
  /** Requests that came by the local unix socket: the file permissions were their credential. */
  local: WeakSet<IncomingMessage>;
  /** Addresses of reverse proxies whose X-Forwarded-For is believed (`--trusted-proxy`); none by default. */
  trustedProxies?: readonly string[];
  log?: Logger;
}

export interface AuthHttp {
  /** Who a request is (null: nobody). `touch` says what counts as use of the session. */
  grant(req: IncomingMessage, touch?: 'api' | 'input' | 'none'): Grant | null;
  /** The subprotocol-carried key of a WebSocket upgrade is read here too. */
  grantUpgrade(req: IncomingMessage): Grant | null;
  /** True when a request that changes something and is authenticated by a cookie has a proper Origin. */
  csrfOk(req: IncomingMessage): boolean;
  /** The pages and `/api/auth/...`; true when the request was answered here. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  whoOf(req: IncomingMessage): Who;
  /** The headers every page of the room proxy gets (CSP and friends). */
  pageHeaders(): Record<string, string>;
}

const sameText = (a: string, b: string): boolean => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (!(name in out)) out[name] = part.slice(at + 1).trim();
  }
  return out;
}

const subprotocolToken = (header: string | string[] | undefined): string | null => {
  if (typeof header !== 'string') return null;
  for (const entry of header.split(',')) {
    const protocol = entry.trim();
    if (protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return protocol.slice(WS_TOKEN_PROTOCOL_PREFIX.length);
  }
  return null;
};

const stripMapped = (address: string): string => (address.startsWith('::ffff:') ? address.slice(7) : address);

/** What the browser is told about its own session: the cookie, by the class of the name it used. */
function sessionCookie(cls: HostClass, value: string, maxAgeS: number): string {
  return isLocalClass(cls)
    ? `${SESSION_COOKIE_LOCAL}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}`
    : `${SESSION_COOKIE_PUBLIC}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}`;
}
const clearCookies = (): string[] => [`${SESSION_COOKIE_LOCAL}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, `${SESSION_COOKIE_PUBLIC}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`];

export function createAuthHttp(options: AuthHttpOptions): AuthHttp {
  const { auth, local } = options;
  const log = options.log ?? nullLogger;
  const trusted = new Set(options.trustedProxies ?? []);

  const whoOf = (req: IncomingMessage): Who => {
    const peer = local.has(req) ? 'socket' : stripMapped(req.socket.remoteAddress ?? 'unknown');
    let address = peer;
    if (trusted.has(peer)) {
      // the rightmost forwarded address that is not one of our own proxies: the one the last trusted proxy saw
      const forwarded = String(req.headers['x-forwarded-for'] ?? '')
        .split(',')
        .map((a) => stripMapped(a.trim()))
        .filter((a) => a !== '');
      const real = [...forwarded].reverse().find((a) => !trusted.has(a));
      if (real !== undefined) address = real;
    }
    const cookies = parseCookies(req.headers.cookie);
    return { address, agent: String(req.headers['user-agent'] ?? '').slice(0, 200), cls: hostClass(req.headers.host), device: cookies[DEVICE_COOKIE] };
  };

  const originOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      const url = new URL(origin);
      return url.host.toLowerCase() === (req.headers.host ?? '').toLowerCase() && options.hostOk(url.host);
    } catch {
      return false;
    }
  };

  const cookieOf = (req: IncomingMessage): string | undefined => {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[SESSION_COOKIE_PUBLIC] ?? cookies[SESSION_COOKIE_LOCAL];
  };

  const grantFrom = (req: IncomingMessage, bearer: string | null, touch: 'api' | 'input' | 'none'): Grant | null => {
    if (local.has(req)) return { kind: 'socket' };
    const who = whoOf(req);
    if (bearer !== null && bearer !== '') {
      if (bearer.startsWith('gnk_')) {
        const key = auth.key(bearer, who);
        if (key !== null) return { kind: 'key', scope: key.scope };
      } else if (auth.tokenAllowed()) {
        const legacy = options.legacyToken();
        if (legacy !== null && sameText(bearer, legacy)) return { kind: 'token' };
      }
    }
    const session = auth.session(cookieOf(req), who, touch === 'none' ? undefined : touch);
    return session === null ? null : { kind: 'session', sessionId: session.id };
  };

  const csrfOk = (req: IncomingMessage): boolean => {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    // a cookie authenticates the request: a missing Origin is refused (unlike a header-token client, which sends none on purpose)
    return req.headers.origin !== undefined && originOk(req);
  };

  const grant = (req: IncomingMessage, touch: 'api' | 'input' | 'none' = 'api'): Grant | null => grantFrom(req, bearerToken(req.headers.authorization), touch);
  const grantUpgrade = (req: IncomingMessage): Grant | null => grantFrom(req, subprotocolToken(req.headers['sec-websocket-protocol']), 'none');

  /* ---- bodies ---- */

  type Form = Record<string, unknown>;
  const readForm = async (req: IncomingMessage): Promise<{ form: Form; html: boolean } | null> => {
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    const result = await readBody(req, FORM_MAX);
    if (!result.ok) return null;
    const text = result.body.toString('utf8');
    try {
      if (type === 'application/x-www-form-urlencoded') return { form: Object.fromEntries(new URLSearchParams(text)), html: true };
      if (type === 'application/json') {
        const parsed: unknown = text === '' ? {} : JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { form: parsed as Form, html: false } : null;
      }
    } catch {
      return null;
    }
    return null;
  };
  const text = (form: Form, name: string): string => (typeof form[name] === 'string' ? (form[name] as string) : '');

  const html = (res: ServerResponse, status: number, kind: AuthPageKind, extra: { message?: string; user?: string; plain?: boolean } = {}, cacheless = true): void => {
    res.writeHead(status, authPageHeaders());
    res.end(authPage({ kind, stylesheet: options.stylesheet, ...extra }));
    void cacheless;
  };
  const redirect = (res: ServerResponse, to: string, cookies: string[] = []): void => {
    res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...(cookies.length === 0 ? {} : { 'Set-Cookie': cookies }) });
    res.end();
  };

  const MESSAGE: Record<string, [number, string]> = {
    wrong: [401, 'Wrong name or password.'],
    wait: [429, 'Too many tries. Wait, then try again.'],
    locked: [423, 'Remote logins are paused: gonogo saw its account file change outside gonogo. Confirm on the machine gonogo runs on.'],
    off: [409, 'Login is not set up on this gonogo.'],
    damaged: [503, 'The account file is damaged. Run `gonogo auth reset` on the machine gonogo runs on.'],
    weak: [400, 'The password needs 12 to 256 characters, and the name letters, digits, dots, dashes or spaces (64 at most).'],
    setup: [403, 'Login is not set up: open gonogo from this machine or your local network.'],
  };

  const cookiesFor = (who: Who, ok: Extract<LoginResult, { ok: true }>): string[] => {
    const life = isLocalClass(who.cls) ? LIFETIME.local.absolute : LIFETIME.public.absolute;
    return [
      sessionCookie(who.cls, ok.session, Math.floor(life / 1000)),
      `${DEVICE_COOKIE}=${ok.device}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${YEAR_S}${isLocalClass(who.cls) ? '' : '; Secure'}`,
    ];
  };

  const plainHttp = (req: IncomingMessage, who: Who): boolean => isLocalClass(who.cls) && who.cls !== 'loopback' && !(req.socket as { encrypted?: boolean }).encrypted;

  async function post(req: IncomingMessage, res: ServerResponse, which: 'login' | 'setup'): Promise<void> {
    const who = whoOf(req);
    if (!options.hostOk(req.headers.host)) return sendText(res, 403, 'forbidden host');
    if (!originOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
    const body = await readForm(req);
    if (body === null) return sendApiError(res, 400, 'send a form or application/json, under 8 KiB', 'bad_request');
    const { form, html: asHtml } = body;
    const user = text(form, 'user');
    const password = text(form, 'password');
    try {
      const result = which === 'setup' ? await auth.setup(who, { token: text(form, 'token'), user, password }, options.legacyToken()) : await auth.login(who, { user, password });
      if (result.ok) {
        const cookies = cookiesFor(who, result);
        if (asHtml) return redirect(res, '/', cookies);
        return sendJson(res, 200, { ok: true, user: result.user }, { 'Set-Cookie': cookies as unknown as string });
      }
      const [status, message] = MESSAGE[result.reason] as [number, string];
      const shown = result.reason === 'wait' && result.retryAfter !== undefined ? `Too many tries. Wait ${result.retryAfter} seconds, then try again.` : message;
      if (asHtml) {
        res.setHeader('Retry-After', String(result.retryAfter ?? 0));
        if (result.reason === 'setup') return html(res, status, 'unset');
        return html(res, status, which === 'setup' && result.reason !== 'off' ? 'setup' : result.reason === 'locked' ? 'locked' : result.reason === 'damaged' ? 'damaged' : 'login', { message: shown, user, plain: plainHttp(req, who) });
      }
      return sendApiError(res, status, shown, status === 429 ? 'rate_limited' : status === 401 ? 'unauthorized' : 'forbidden', undefined, result.retryAfter === undefined ? {} : { 'Retry-After': String(result.retryAfter) });
    } catch (error) {
      log.error('login failed', error);
      return sendApiError(res, 500, 'internal error', 'internal');
    }
  }

  /* ---- authenticated routes ---- */

  const view = (req: IncomingMessage, current: Grant): Record<string, unknown> => ({
    user: auth.user(),
    state: auth.state(),
    locked: auth.locked(),
    current: current.sessionId?.slice(0, 16) ?? null,
    sessions: auth.sessions().map((s) => ({ id: s.short, created: s.created, last: s.last, address: s.address, agent: s.agent, kind: s.cls })),
    keys: auth.keys().map((k) => ({ id: k.short, name: k.name, scope: k.scope, remote: k.remote, created: k.created, expires: k.expires, last: k.last, lastAddress: k.lastAddress })),
    host: whoOf(req).cls,
  });

  async function authed(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const who = whoOf(req);
    if (path === '/api/auth/status' && method === 'GET') {
      return sendJson(res, 200, { state: auth.state(), setup: isLocalClass(who.cls) && ['fresh', 'none'].includes(auth.state()), locked: auth.locked() }, { 'Cache-Control': 'no-store' });
    }
    if (!options.hostOk(req.headers.host)) return sendText(res, 403, 'forbidden host');
    // the tamper confirmation: on a loopback or private Host, or through the local socket, with the Director's password
    if (path === '/api/auth/confirm' && method === 'POST') {
      if (!local.has(req) && !isLocalClass(who.cls)) return sendApiError(res, 403, 'confirm on the machine gonogo runs on', 'forbidden');
      if (!local.has(req) && !originOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
      const body = await readForm(req);
      if (body === null) return sendApiError(res, 400, 'send application/json', 'bad_request');
      const answer = await auth.confirm(who, text(body.form, 'password'));
      if (answer === 'ok') return sendJson(res, 200, { ok: true });
      if (answer === 'none') return sendJson(res, 200, { ok: true, note: 'nothing to confirm' });
      return sendApiError(res, answer === 'wait' ? 429 : 401, answer === 'wait' ? 'too many tries: wait, then try again' : 'wrong password', answer === 'wait' ? 'rate_limited' : 'unauthorized');
    }
    const found = grant(req);
    if (found === null || (found.kind !== 'session' && found.kind !== 'socket')) return sendApiError(res, 401, 'unauthorized', 'unauthorized');
    if (found.kind === 'session' && !csrfOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
    if (path === '/api/auth/account' && method === 'GET') return sendJson(res, 200, view(req, found), { 'Cache-Control': 'no-store' });
    const readJson = async (): Promise<Form | null> => (await readForm(req))?.form ?? null;

    if (path === '/api/auth/logout' && method === 'POST') {
      if (found.sessionId !== undefined) auth.logout(found.sessionId);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookies() as unknown as string });
    }
    if (path === '/api/auth/logout-all' && method === 'POST') {
      const count = auth.logoutEverywhere(found.sessionId);
      return sendJson(res, 200, { ok: true, ended: count });
    }
    if (path === '/api/auth/password' && method === 'POST') {
      if (found.sessionId === undefined) return sendApiError(res, 403, 'change the password from a logged-in page', 'forbidden');
      const body = await readJson();
      if (body === null) return sendApiError(res, 400, 'send application/json', 'bad_request');
      const answer = await auth.changePassword(found.sessionId, text(body, 'current'), text(body, 'next'));
      if (answer === 'ok') return sendJson(res, 200, { ok: true });
      if (answer === 'weak') return sendApiError(res, 400, MESSAGE.weak?.[1] ?? 'weak', 'bad_request', 'next');
      return sendApiError(res, answer === 'wait' ? 429 : 401, answer === 'wait' ? 'too many tries: wait, then try again' : 'wrong password', answer === 'wait' ? 'rate_limited' : 'unauthorized', 'current');
    }
    const session = /^\/api\/auth\/sessions\/([0-9a-f]{8,64})$/.exec(path);
    if (session !== null && method === 'DELETE') {
      const ok = auth.revoke(session[1] as string);
      return ok ? sendJson(res, 200, { ok: true }) : sendApiError(res, 404, 'no such session', 'not_found');
    }
    if (path === '/api/auth/keys' && method === 'POST') {
      const body = await readJson();
      if (body === null) return sendApiError(res, 400, 'send application/json', 'bad_request');
      const name = text(body, 'name').trim();
      const scope = (typeof body.scope === 'string' ? body.scope : 'read') as KeyScope;
      const days = body.days === undefined || body.days === null ? null : Number(body.days);
      if (name === '' || name.length > 60) return sendApiError(res, 400, 'a key needs a name of 1 to 60 characters', 'bad_request', 'name');
      if (!KEY_SCOPES.includes(scope)) return sendApiError(res, 400, 'scope is read, act or full', 'bad_request', 'scope');
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return sendApiError(res, 400, 'days is a whole number from 1 to 3650', 'bad_request', 'days');
      const made = auth.addKey(name, scope, days, body.remote === true);
      // the secret is in this answer once and nowhere else
      return sendJson(res, 201, { key: made.secret, id: made.key.id.slice(0, 12), name: made.key.name, scope, remote: made.key.remote, expires: made.key.expires });
    }
    const key = /^\/api\/auth\/keys\/([0-9a-f]{8,64})$/.exec(path);
    if (key !== null && method === 'DELETE') {
      return auth.revokeKey(key[1] as string) ? sendJson(res, 200, { ok: true }) : sendApiError(res, 404, 'no such key', 'not_found');
    }
    return sendApiError(res, 404, 'not found', 'not_found');
  }

  const isAuthPath = (path: string): boolean => path === '/login' || path === '/setup' || path === '/api/auth' || path.startsWith('/api/auth/');

  return {
    grant,
    grantUpgrade,
    csrfOk,
    whoOf,
    pageHeaders: () => ({
      // the page of a room and the list: nothing but the server's own files, no inline script, no frame (threat model 3); styles allow the inline rules the terminal and the client write
      // lower case: the room's own headers arrive lower-cased, and these must replace them, not sit beside them
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    }),
    handle(req, res) {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (!isAuthPath(path)) return false;
      const method = req.method ?? 'GET';
      if (path === '/login' || path === '/setup') {
        if (method !== 'GET' && method !== 'HEAD') return (sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: 'GET, HEAD' }), true);
        if (!options.hostOk(req.headers.host)) return (sendText(res, 403, 'forbidden host'), true);
        const who = whoOf(req);
        const state = auth.state();
        if (state === 'damaged') return (html(res, 503, 'damaged'), true);
        if (path === '/login') {
          if (state !== 'account') return (redirect(res, '/setup'), true);
          return (html(res, 200, auth.locked() && !isLocalClass(who.cls) ? 'locked' : 'login', { plain: plainHttp(req, who) }), true);
        }
        if (state === 'account') return (redirect(res, '/login'), true);
        return (html(res, isLocalClass(who.cls) ? 200 : 403, isLocalClass(who.cls) ? 'setup' : 'unset', { plain: plainHttp(req, who) }), true);
      }
      if (path === '/api/auth/login' || path === '/api/auth/setup') {
        if (method !== 'POST') return (sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: 'POST' }), true);
        void post(req, res, path.endsWith('setup') ? 'setup' : 'login').catch((error: unknown) => {
          log.error('auth route failed', error);
          sendApiError(res, 500, 'internal error', 'internal');
        });
        return true;
      }
      void authed(req, res, path).catch((error: unknown) => {
        log.error('auth route failed', error);
        sendApiError(res, 500, 'internal error', 'internal');
      });
      return true;
    },
  };
}

