/**
 * The HTTP face of the login, in the supervisor (docs/login-spec.md): the pages, `/api/auth/...`, the cookies, and the one question the proxy
 * asks of every request: who is this (`grant`).
 */
import { forbiddenHostText } from './forbiddenhost.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../shared/protocol.js';
import { WS_TOKEN_PROTOCOL_PREFIX } from '../shared/protocol.js';
import { hostName } from './web.js';
import { hostClass, isLocalClass, KEY_SCOPES, LIFETIME, TUI_PREFIX } from './auth.js';
import type { Devices } from './devicelogin.js';
import type { AuthStore, HostClass, KeyScope, LoginResult, Who } from './auth.js';
import { authPage, authPageHeaders, PASSKEY_SCRIPT } from './authpage.js';
import type { AuthPageExtra } from './authpage.js';
import type { Passkeys } from './passkeys.js';
import { relyingParty } from './passkeys.js';
import { bodyMatters, needsRoomSandbox, reliefGoId, stepUpReason } from './stepup.js';
import type { StepUpContext } from './stepup.js';
import type { AuthPageKind } from './authpage.js';
import { nullLogger } from './constants.js';
import { bearerToken, readBody, sendApiError, sendJson, sendText } from './hooks.js';

export const SESSION_COOKIE_PUBLIC = '__Host-gonogo';
export const SESSION_COOKIE_LOCAL = 'gonogo-session';
export const DEVICE_COOKIE = 'gonogo-device';
const FORM_MAX = 8 * 1024;
/** An assertion or an attestation with its certificates can be a few KiB. */
const PASSKEY_BODY_MAX = 32 * 1024;
const YEAR_S = 365 * 24 * 60 * 60;

export interface Grant {
  kind: 'session' | 'key' | 'socket' | 'token' | 'tui';
  sessionId?: string;
  scope?: KeyScope;
  /** The id (hash) of the key, so a socket it opened can be closed when the key is revoked or expires. */
  keyId?: string;
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
  /** The device login of a terminal (docs/login-spec.md): without it the endpoints and the page do not exist. */
  devices?: Devices;
  /** The passkey ceremonies; without it no passkey is offered. */
  passkeys?: Passkeys;
  /** Addresses of reverse proxies whose X-Forwarded-For is believed (`--trusted-proxy`); none by default. */
  trustedProxies?: readonly string[];
  /** The header a trusted proxy puts the client address in: `x-forwarded-for` (default) or `cf-connecting-ip`. */
  clientIpHeader?: string;
  /** Where the page is for people outside, and the names that serve it: shown in the Director's own view of the login. */
  exposure?: { pages: readonly string[]; hooks: readonly string[]; publicUrl: string | null };
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
  /** True when the body of this change decides whether it needs a step-up (hire, edit of an agent): the proxy reads it first. */
  stepUpBody(method: string, path: string): boolean;
  /** Whether this change by this grant needs the password (and code) again now; `body` is the parsed JSON object, or null. */
  stepUpNeeded(grant: Grant, method: string, path: string, body: Record<string, unknown> | null, context?: StepUpContext): string | null;
  /** Whether the body names a flavor the room's default must be known for. */
  stepUpWantsRoom(method: string, path: string, body: Record<string, unknown> | null): boolean;
  /** The 403 that tells the page to ask for the password again. */
  stepUpDenied(req: IncomingMessage, res: ServerResponse, reason: string, tui?: boolean): void;
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

/** Headers a proxy in front adds: a request that carries one did not come straight from the machine's own network, whatever its Host says. */
const FORWARDING = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip'];
const RANK: Record<HostClass, number> = { loopback: 0, private: 1, public: 2 };

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

  /**
   * Local means BOTH the Host the request names AND the address it came from are local (loopback or private): a Host header is whatever the sender
   * wrote, so `Host: 127.0.0.1` from the internet is public. A request with a forwarding header from a peer that is not a trusted proxy was passed
   * on by something in front of gonogo, so it is public too. Not covered: a proxy on this machine that drops its forwarding headers and rewrites
   * Host looks local; `--trusted-proxy` is the answer (docs/features/login.md).
   */
  const classOf = (req: IncomingMessage, address: string, viaTrusted: boolean): HostClass => {
    if (local.has(req)) return 'loopback';
    const looksLikeAddress = /^[0-9a-f:.]+$/i.test(address) && /[.:]/.test(address);
    const byAddress: HostClass = looksLikeAddress ? hostClass(address) : 'public';
    if (!viaTrusted && FORWARDING.some((name) => req.headers[name] !== undefined)) return 'public';
    const byHost = hostClass(req.headers.host);
    return RANK[byHost] >= RANK[byAddress] ? byHost : byAddress;
  };

  const whoOf = (req: IncomingMessage): Who => {
    const peer = local.has(req) ? 'socket' : stripMapped(req.socket.remoteAddress ?? 'unknown');
    let address = peer;
    if (trusted.has(peer)) {
      // the rightmost forwarded address that is not one of our own proxies: the one the last trusted proxy saw
      const forwarded = String(req.headers[options.clientIpHeader ?? 'x-forwarded-for'] ?? '')
        .split(',')
        .map((a) => stripMapped(a.trim()))
        .filter((a) => a !== '');
      const real = [...forwarded].reverse().find((a) => !trusted.has(a));
      if (real !== undefined) address = real;
    }
    const cookies = parseCookies(req.headers.cookie);
    // a user agent is shown on a page and put in an alert: no control character, no markup
    const agent = String(req.headers['user-agent'] ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>&"'`]/g, '?').slice(0, 200);
    return { address, agent, cls: classOf(req, address, trusted.has(peer)), device: cookies[DEVICE_COOKIE] };
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
        if (key !== null) return { kind: 'key', scope: key.scope, keyId: key.id };
      } else if (bearer.startsWith(TUI_PREFIX)) {
        const tui = auth.tuiSession(bearer, who, touch === 'none' ? undefined : touch);
        if (tui !== null) return { kind: 'tui', sessionId: tui.id };
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
  const readForm = async (req: IncomingMessage, limit = FORM_MAX): Promise<{ form: Form; html: boolean } | null> => {
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    const result = await readBody(req, limit);
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

  const html = (res: ServerResponse, status: number, kind: AuthPageKind, extra: AuthPageExtra = {}): void => {
    res.writeHead(status, authPageHeaders(extra.passkey === true));
    res.end(authPage({ kind, stylesheet: options.stylesheet, ...extra }));
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
    needmfa: [403, 'This address needs a second factor. Turn on TOTP from this machine or your local network first (Flight Rules, LOGIN).'],
  };

  const cookiesFor = (who: Who, ok: Extract<LoginResult, { ok: true }>): string[] => {
    const life = isLocalClass(who.cls) ? LIFETIME.local.absolute : LIFETIME.public.absolute;
    return [
      sessionCookie(who.cls, ok.session, Math.floor(life / 1000)),
      `${DEVICE_COOKIE}=${ok.device}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${YEAR_S}${isLocalClass(who.cls) ? '' : '; Secure'}`,
    ];
  };

  /** Where a passkey can be offered: a public domain name, with the origin it will be signed for. */
  const rpOf = (req: IncomingMessage, who: Who) => relyingParty(req.headers.host, who.cls);

  const plainHttp = (req: IncomingMessage, who: Who): boolean => isLocalClass(who.cls) && who.cls !== 'loopback' && !(req.socket as { encrypted?: boolean }).encrypted;

  async function post(req: IncomingMessage, res: ServerResponse, which: 'login' | 'setup' | 'second'): Promise<void> {
    const who = whoOf(req);
    if (!options.hostOk(req.headers.host)) return sendText(res, 403, forbiddenHostText(req.headers.host, req.headers.accept));
    if (!originOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
    const body = await readForm(req);
    if (body === null) return sendApiError(res, 400, 'send a form or application/json, under 8 KiB', 'bad_request');
    const { form, html: asHtml } = body;
    const user = text(form, 'user');
    const password = text(form, 'password');
    try {
      const result = which === 'setup' ? await auth.setup(who, { token: text(form, 'token'), user, password }, options.legacyToken()) : which === 'second' ? await auth.second(who, text(form, 'pending'), text(form, 'code')) : await auth.login(who, { user, password });
      if (!result.ok && result.reason === 'second') {
        if (asHtml) return html(res, 200, 'second', { pending: result.pending, plain: plainHttp(req, who) });
        return sendJson(res, 200, { ok: false, second: true, pending: result.pending });
      }
      if (result.ok) {
        const cookies = cookiesFor(who, result);
        if (asHtml) return redirect(res, '/', cookies);
        return sendJson(res, 200, { ok: true, user: result.user }, { 'Set-Cookie': cookies as unknown as string });
      }
      const [status, message] = MESSAGE[result.reason] as [number, string];
      // on the setup form the only thing that can be wrong is the setup token (the name and the password have their own words: 'weak')
      const shown = result.reason === 'wait' && result.retryAfter !== undefined ? `Too many tries. Wait ${result.retryAfter} seconds, then try again.` : which === 'setup' && result.reason === 'wrong' ? 'That setup token is wrong: copy it again from the start-up output, or from the setup-token file in gonogo\'s home folder.' : message;
      if (asHtml) {
        res.setHeader('Retry-After', String(result.retryAfter ?? 0));
        if (result.reason === 'setup') return html(res, status, 'unset');
        // a wrong second factor shows its own page again (the pending token is still good for a few tries); anything else the form it came from
        if (which === 'second' && result.reason === 'wrong') return html(res, status, 'second', { message: shown, pending: text(form, 'pending'), plain: plainHttp(req, who) });
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
    sessions: auth.sessions().map((s) => ({ id: s.short, created: s.created, last: s.last, address: s.address, agent: s.agent, kind: s.cls, type: s.kind, label: s.label })),
    mfa: auth.mfa(),
    passkeys: auth.passkeys().map((p) => ({ id: p.id.slice(0, 24), name: p.name, rpId: p.rpId, created: p.created, last: p.last, backedUp: p.backedUp })),
    passkeyHere: ((rp) => (rp === null ? null : rp.rpId))(rpOf(req, whoOf(req))),
    stepFresh: current.sessionId === undefined ? true : auth.stepFresh(current.sessionId),
    keys: auth.keys().map((k) => ({ id: k.short, name: k.name, scope: k.scope, remote: k.remote, created: k.created, expires: k.expires, last: k.last, lastAddress: k.lastAddress })),
    host: whoOf(req).cls,
    exposure: options.exposure ?? { pages: [], hooks: [], publicUrl: null },
  });

  async function authed(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    const who = whoOf(req);
    if (path === '/api/auth/status' && method === 'GET') {
      return sendJson(res, 200, { state: auth.state(), setup: isLocalClass(who.cls) && ['fresh', 'none'].includes(auth.state()), locked: auth.locked(), host: who.cls }, { 'Cache-Control': 'no-store' });
    }
    if (!options.hostOk(req.headers.host)) return sendText(res, 403, forbiddenHostText(req.headers.host, req.headers.accept));
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
    // a terminal asking for a session (docs/login-spec.md, TUI device login): anonymous, small, counted; they do not exist until an account does, and on a public name until it has a second factor
    if ((path === '/api/auth/device' || path === '/api/auth/device/token') && method === 'POST' && options.devices !== undefined) {
      if (!deviceAllowed(who)) return sendApiError(res, 404, 'not found', 'not_found');
      const body = await readForm(req, 2048);
      if (body === null) return sendApiError(res, 400, 'send application/json, under 2 KiB', 'bad_request');
      if (path === '/api/auth/device') {
        const started = options.devices.start(who, body.form.label, `${baseUrl(req, who)}/login/device`);
        if (started.ok) return sendJson(res, 200, started.flow, { 'Cache-Control': 'no-store' });
        return sendApiError(res, 429, started.reason === 'cap' ? 'too many terminals are waiting: use `gonogo auth key add --scope full --remote` on the machine gonogo runs on, then give the key with --token' : 'too many tries: wait, then try again', 'rate_limited', undefined, { 'Retry-After': '600' });
      }
      const polled = options.devices.poll(who, body.form.device_code);
      if ('token' in polled) return sendJson(res, 200, { token: polled.token }, { 'Cache-Control': 'no-store' });
      if ('rate' in polled) return sendApiError(res, 429, 'too many polls: wait, then try again', 'rate_limited', undefined, { 'Retry-After': '60' });
      return sendJson(res, 400, { error: polled.error }, { 'Cache-Control': 'no-store' });
    }
    // signing in with a passkey: no login yet, so no session; the origin of the page is required and checked, the answer is checked by the library
    if ((path === '/api/auth/passkey/options' || path === '/api/auth/passkey/login') && method === 'POST' && options.passkeys !== undefined) {
      const rp = rpOf(req, who);
      if (rp === null || auth.state() !== 'account' || req.headers.origin !== rp.origin) return sendApiError(res, 404, 'passkeys are not available on this address', 'not_found');
      if (path.endsWith('options')) {
        const made = await options.passkeys.loginOptions(rp);
        return made === null ? sendApiError(res, 404, 'no passkey is set up for this address', 'not_found') : sendJson(res, 200, made, { 'Cache-Control': 'no-store' });
      }
      const body = await readForm(req, PASSKEY_BODY_MAX);
      if (body === null) return sendApiError(res, 400, 'send application/json', 'bad_request');
      const result = await options.passkeys.loginFinish(who, rp, body.form);
      if (result.ok) return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookiesFor(who, result) as unknown as string });
      return sendApiError(res, result.reason === 'locked' ? 423 : 401, result.reason === 'locked' ? 'remote logins are paused' : 'that passkey was not accepted', result.reason === 'locked' ? 'forbidden' : 'unauthorized');
    }
    const found = grant(req);
    // a terminal may end its own session and nothing else of the account: the rest is done in the browser
    if (found?.kind === 'tui') {
      if (path === '/api/auth/logout' && method === 'POST' && found.sessionId !== undefined) {
        auth.logout(found.sessionId);
        return sendJson(res, 200, { ok: true });
      }
      return stepUpDenied(req, res, 'the account', true);
    }
    if (found === null || (found.kind !== 'session' && found.kind !== 'socket')) return sendApiError(res, 401, 'unauthorized', 'unauthorized');
    if (found.kind === 'session' && !csrfOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
    if (path === '/api/auth/account' && method === 'GET') return sendJson(res, 200, view(req, found), { 'Cache-Control': 'no-store' });
    const readJson = async (): Promise<Form | null> => (await readForm(req))?.form ?? null;
    // the account's own changes ask the password again when the last check is old (the local socket is the Director on this machine and is not asked)
    const reason = stepUpReason(method, path, null);
    if (reason !== null && found.kind === 'session' && found.sessionId !== undefined && !auth.stepFresh(found.sessionId)) return stepUpDenied(req, res, reason);
    if (path === '/api/auth/stepup/options' && method === 'POST') {
      const rp = rpOf(req, who);
      const made = found.sessionId === undefined || rp === null || options.passkeys === undefined ? null : await options.passkeys.stepOptions(found.sessionId, rp);
      return made === null ? sendApiError(res, 404, 'no passkey is set up for this address', 'not_found') : sendJson(res, 200, made, { 'Cache-Control': 'no-store' });
    }
    if (path === '/api/auth/stepup' && method === 'POST') {
      if (found.sessionId === undefined) return sendJson(res, 200, { ok: true });
      const wide = await readForm(req, PASSKEY_BODY_MAX);
      const body = wide?.form ?? null;
      if (body === null) return sendApiError(res, 400, 'send application/json', 'bad_request');
      // a passkey is the password and the second factor in one step, and is not slowed: it cannot be guessed
      if (body.passkey !== undefined) {
        const rp = rpOf(req, who);
        const done = rp === null || options.passkeys === undefined ? { ok: false as const } : await options.passkeys.stepFinish(found.sessionId, rp, body.passkey);
        if (!done.ok) return sendApiError(res, 401, 'that passkey was not accepted', 'unauthorized');
        const life = LIFETIME[isLocalClass(who.cls) ? 'local' : 'public'].absolute;
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(who.cls, done.session, Math.floor(life / 1000)) });
      }
      const answer = await auth.stepUp(found.sessionId, who, { password: text(body, 'password'), code: text(body, 'code') });
      if (answer.ok) {
        const life = LIFETIME[isLocalClass(who.cls) ? 'local' : 'public'].absolute;
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(who.cls, answer.session, Math.floor(life / 1000)) });
      }
      if (answer.reason === 'gone') return sendApiError(res, 401, 'unauthorized', 'unauthorized');
      return sendApiError(res, answer.reason === 'wait' ? 429 : 401, answer.reason === 'wait' ? 'too many tries: wait, then try again' : 'wrong password or code', answer.reason === 'wait' ? 'rate_limited' : 'unauthorized');
    }
    if (path === '/api/auth/passkeys/begin' && method === 'POST') {
      const rp = rpOf(req, who);
      if (found.sessionId === undefined || rp === null || options.passkeys === undefined) return sendApiError(res, 409, 'a passkey can be added from a public name opened over https, signed in with a session', 'conflict');
      // the way back: the name a passkey is made for can change, and then it is gone; a second factor and its recovery codes do not depend on the name
      if (!auth.passkeysMayStart()) return sendApiError(res, 409, 'turn on the second factor (TOTP) first: it is the way back if the name of this page ever changes', 'conflict');
      return sendJson(res, 200, await options.passkeys.registerOptions(found.sessionId, rp), { 'Cache-Control': 'no-store' });
    }
    if (path === '/api/auth/passkeys/finish' && method === 'POST') {
      const rp = rpOf(req, who);
      const wide = await readForm(req, PASSKEY_BODY_MAX);
      if (found.sessionId === undefined || rp === null || options.passkeys === undefined || wide === null) return sendApiError(res, 409, 'a passkey can be added from a public name opened over https, signed in with a session', 'conflict');
      if (!auth.passkeysMayStart()) return sendApiError(res, 409, 'turn on the second factor (TOTP) first', 'conflict');
      const answer = await options.passkeys.registerFinish(found.sessionId, who, rp, wide.form.response, text(wide.form, 'name'));
      if (answer === 'ok') return sendJson(res, 200, { ok: true });
      return sendApiError(res, answer === 'full' ? 409 : 400, answer === 'full' ? 'there are twenty passkeys already, or this one is one of them' : 'that passkey was not accepted: it must be made for this address, opened over https, with a screen lock or key', answer === 'full' ? 'conflict' : 'bad_request');
    }
    const passkey = /^\/api\/auth\/passkeys\/([A-Za-z0-9_-]{8,64})$/.exec(path);
    if (passkey !== null && method === 'DELETE') {
      // as turning the second factor off: the password and a code, or a passkey; a fresh step-up alone is not enough
      const wide = await readForm(req, PASSKEY_BODY_MAX);
      const body = wide?.form ?? {};
      const short = passkey[1] as string;
      if (body.passkey !== undefined) {
        const rp = rpOf(req, who);
        const done = found.sessionId === undefined || rp === null || options.passkeys === undefined ? null : await options.passkeys.confirm(found.sessionId, rp, body.passkey);
        if (done === null) return sendApiError(res, 401, 'that passkey was not accepted', 'unauthorized');
        return auth.passkeyRemoveConfirmed(short, done.id, done.counter) ? sendJson(res, 200, { ok: true }) : sendApiError(res, 404, 'no such passkey', 'not_found');
      }
      const answer = await auth.passkeyRemove(found.sessionId ?? 'socket', who, short, { password: text(body, 'password'), code: text(body, 'code') });
      if (answer === 'ok') return sendJson(res, 200, { ok: true });
      if (answer === 'none') return sendApiError(res, 404, 'no such passkey', 'not_found');
      return sendApiError(res, answer === 'wait' ? 429 : 401, answer === 'wait' ? 'too many tries: wait, then try again' : 'wrong password or code', answer === 'wait' ? 'rate_limited' : 'unauthorized');
    }
    if (path === '/api/auth/mfa/begin' && method === 'POST') {
      if (auth.mfa().enabled) return sendApiError(res, 409, 'a second factor is already on: turn it off first', 'conflict');
      return sendJson(res, 200, auth.mfaBegin(), { 'Cache-Control': 'no-store' });
    }
    if (path === '/api/auth/mfa/enable' && method === 'POST') {
      const body = await readJson();
      if (body === null) return sendApiError(res, 400, 'send application/json', 'bad_request');
      const answer = auth.mfaEnable(found.sessionId ?? 'socket', who, text(body, 'code'));
      if (answer.ok) return sendJson(res, 200, { ok: true, recovery: answer.recovery }, { 'Cache-Control': 'no-store' });
      if (answer.reason === 'none') return sendApiError(res, 409, 'start with a new secret first', 'conflict');
      return sendApiError(res, answer.reason === 'wait' ? 429 : 401, answer.reason === 'wait' ? 'too many tries: wait, then try again' : 'wrong code', answer.reason === 'wait' ? 'rate_limited' : 'unauthorized', 'code');
    }
    if ((path === '/api/auth/mfa/disable' || path === '/api/auth/mfa/recovery') && method === 'POST') {
      const body = await readJson();
      if (body === null) return sendApiError(res, 400, 'send application/json', 'bad_request');
      const input = { password: text(body, 'password'), code: text(body, 'code') };
      if (path.endsWith('disable')) {
        // with a passkey on the account, TOTP and its recovery codes are the way back when the name changes: they stay until the passkeys are gone
        if (auth.passkeys().length > 0) return sendApiError(res, 409, 'remove the passkeys first: the second factor is the way back if the name of this page changes', 'conflict');
        const answer = await auth.mfaDisable(found.sessionId ?? 'socket', who, input);
        if (answer === 'ok') return sendJson(res, 200, { ok: true });
        return sendApiError(res, answer === 'wait' ? 429 : 401, answer === 'wait' ? 'too many tries: wait, then try again' : 'wrong password or code', answer === 'wait' ? 'rate_limited' : 'unauthorized');
      }
      const answer = await auth.mfaRecovery(found.sessionId ?? 'socket', who, input);
      if (answer.ok) return sendJson(res, 200, { ok: true, recovery: answer.recovery }, { 'Cache-Control': 'no-store' });
      if (answer.reason === 'none') return sendApiError(res, 409, 'no second factor is on', 'conflict');
      return sendApiError(res, answer.reason === 'wait' ? 429 : 401, answer.reason === 'wait' ? 'too many tries: wait, then try again' : 'wrong password or code', answer.reason === 'wait' ? 'rate_limited' : 'unauthorized');
    }

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

  /** The device login is offered only once an account exists, and on a public name only when it has a second factor or a passkey (the gate of the rest). */
  const deviceAllowed = (who: Who): boolean => auth.state() === 'account' && (isLocalClass(who.cls) || auth.mfa().enabled || auth.passkeys().length > 0);
  /** Where the page is: the public address when one is configured, else the one Host that was accepted (https on a public name). */
  const baseUrl = (req: IncomingMessage, who: Who): string => {
    const configured = options.exposure?.publicUrl?.replace(/\/+$/, '');
    if (configured !== undefined && configured !== '') return configured;
    // never the Host as the sender wrote it: the name and the port of a Host that hostOk accepted, put together again
    const host = req.headers.host ?? '';
    const name = hostName(host);
    const port = /:(\d{1,5})$/.exec(host.trim())?.[1];
    const shown = name === null ? 'localhost' : name.includes(':') ? `[${name}]` : name;
    return `${isLocalClass(who.cls) ? 'http' : 'https'}://${shown}${port === undefined || Number(port) > 65535 ? '' : `:${port}`}`;
  };
  /** The key of the wrong-code counter: the device cookie of the session (a step-up that mints the session's id again does not give fresh tries). */
  const approver = (sessionId: string): string => auth.sessions().find((s) => s.id === sessionId)?.device || sessionId;

  const stepUpDenied = (req: IncomingMessage, res: ServerResponse, reason: string, tui = false): void => {
    // a Bearer credential never carries a step-up (a key, a terminal): it is told to do this in the browser
    if (tui) return sendJson(res, 403, { error: `step_up_required: do this in the browser (${reason}).`, code: 'forbidden', stepUpRequired: true });
    const rp = rpOf(req, whoOf(req));
    const passkey = rp !== null && options.passkeys?.has(rp) === true;
    sendJson(res, 403, { error: `Confirm your password${auth.mfa().enabled ? ' and a code' : ''}${passkey ? ', or use a passkey,' : ''} to do this: ${reason}.`, code: 'forbidden', stepUp: true, second: auth.mfa().enabled, passkey });
  };

  const agoText = (at: number): string => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 90 ? `${s} seconds ago` : `${Math.round(s / 60)} minutes ago`;
  };

  /**
   * The page the Director types a terminal's code into, and where they approve or deny it. A browser session only (a key or a terminal cannot approve),
   * with the password asked again when the last check is old; the flow acted on is the one the code typed in THAT request names.
   */
  async function devicePage(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (!options.hostOk(req.headers.host)) return sendText(res, 403, forbiddenHostText(req.headers.host, req.headers.accept));
    const who = whoOf(req);
    const devices = options.devices;
    if (devices === undefined || !deviceAllowed(who)) return sendText(res, 404, 'not found');
    if (method !== 'GET' && method !== 'POST') return sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: 'GET, POST' });
    const found = grant(req, method === 'GET' ? 'none' : 'api');
    if (found?.kind !== 'session' || found.sessionId === undefined) return redirect(res, '/login');
    if (method === 'GET') return html(res, 200, 'device', { plain: plainHttp(req, who), ...(auth.stepFresh(found.sessionId) ? {} : { stepUp: { code: auth.mfa().enabled } }) });
    // the same Origin rule as the other forms of /login, and a cookie that is the one of this page
    if (!originOk(req) || !csrfOk(req)) return sendApiError(res, 403, 'forbidden origin', 'forbidden');
    const body = await readForm(req);
    if (body === null || !body.html) return sendApiError(res, 400, 'send the form of the page', 'bad_request');
    const form = body.form;
    const cookies: string[] = [];
    let sessionId = found.sessionId;
    if (!auth.stepFresh(sessionId)) {
      // the password again (and the code): this page has no script, so it asks here and mints the session's id again like the step-up route does
      const done = await auth.stepUp(sessionId, who, { password: text(form, 'password'), code: text(form, 'totp') });
      if (!done.ok) return html(res, done.reason === 'wait' ? 429 : 401, 'device', { message: done.reason === 'wait' ? 'Too many tries: wait, then try again.' : 'Wrong password or code.', stepUp: { code: auth.mfa().enabled } });
      cookies.push(sessionCookie(who.cls, done.session, Math.floor(LIFETIME[isLocalClass(who.cls) ? 'local' : 'public'].absolute / 1000)));
      // the id the new cookie names: its hash, as the store keeps it
      sessionId = createHash('sha256').update(done.session, 'utf8').digest('hex');
    }
    const typed = text(form, 'code');
    const answer = (view: NonNullable<Parameters<typeof authPage>[0]['device']>, status = 200): void => {
      res.writeHead(status, { ...authPageHeaders(), ...(cookies.length === 0 ? {} : { 'Set-Cookie': cookies }) });
      res.end(authPage({ kind: 'deviceDetails', stylesheet: options.stylesheet, device: view }));
    };
    const failPage = (message: string, status: number): void => {
      res.writeHead(status, { ...authPageHeaders(), ...(cookies.length === 0 ? {} : { 'Set-Cookie': cookies }) });
      res.end(authPage({ kind: 'device', stylesheet: options.stylesheet, message }));
    };
    if (path === '/login/device') {
      const got = devices.find(approver(sessionId), who, typed);
      if (got === null) return failPage('No terminal is waiting with that code. It may have expired (ten minutes), or been typed wrong.', 404);
      if ('wait' in got) return failPage('Too many wrong codes: wait ten minutes.', 429);
      return answer({ code: typed, label: got.view.label, address: got.view.address, agent: got.view.agent, asked: agoText(got.view.asked), far: got.view.far, again: false });
    }
    // approve or deny: the flow is the one this request's code names, and the step-up was just made or is still fresh
    const approve = text(form, 'action') === 'approve';
    const got = devices.find(approver(sessionId), who, typed);
    if (got === null) return failPage('No terminal is waiting with that code any more.', 404);
    if ('wait' in got) return failPage('Too many wrong codes: wait ten minutes.', 429);
    if (approve && got.view.far && text(form, 'again') !== '1') return answer({ code: typed, label: got.view.label, address: got.view.address, agent: got.view.agent, asked: agoText(got.view.asked), far: true, again: true });
    const done = devices.decide(approver(sessionId), who, typed, approve);
    if (!done.ok) return failPage('That terminal is no longer waiting.', 404);
    res.writeHead(200, { ...authPageHeaders(), ...(cookies.length === 0 ? {} : { 'Set-Cookie': cookies }) });
    res.end(authPage({ kind: 'deviceDone', stylesheet: options.stylesheet, done: approve ? 'APPROVED' : 'DENIED' }));
  }

  const method0 = (req: IncomingMessage): string => req.method ?? 'GET';
  const isAuthPath = (path: string): boolean => path === '/login/passkey.js' || path === '/login/device' || path === '/login/device/decide' || path === '/login' || path === '/setup' || path === '/api/auth' || path.startsWith('/api/auth/');

  return {
    grant,
    grantUpgrade,
    csrfOk,
    whoOf,
    stepUpBody: bodyMatters,
    stepUpWantsRoom: (method, path, body) => needsRoomSandbox(method, path, body) || reliefGoId(method, path) !== null,
    stepUpNeeded: (grant, method, path, body, context) => {
      if (grant.kind === 'tui') return stepUpReason(method, path, body, context);
      if (grant.kind !== 'session' || grant.sessionId === undefined || auth.stepFresh(grant.sessionId)) return null;
      return stepUpReason(method, path, body, context);
    },
    stepUpDenied,
    pageHeaders: () => ({
      // the page of a room and the list: nothing but the server's own files, no inline script, no frame (threat model 3); styles allow the inline rules the terminal and the client write
      // lower case: the room's own headers arrive lower-cased, and these must replace them, not sit beside them
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY',
    }),
    handle(req, res) {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (!isAuthPath(path)) return false;
      if (path === '/login/passkey.js') {
        if (method0(req) !== 'GET') return (sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: 'GET' }), true);
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(PASSKEY_SCRIPT);
        return true;
      }
      const method = req.method ?? 'GET';
      if (path === '/login/device' || path === '/login/device/decide') {
        void devicePage(req, res, path).catch((error: unknown) => {
          log.error('device page failed', error);
          sendText(res, 500, 'internal error');
        });
        return true;
      }
      if (path === '/login' || path === '/setup') {
        if (method !== 'GET' && method !== 'HEAD') return (sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: 'GET, HEAD' }), true);
        if (!options.hostOk(req.headers.host)) return (sendText(res, 403, forbiddenHostText(req.headers.host, req.headers.accept)), true);
        const who = whoOf(req);
        const state = auth.state();
        if (state === 'damaged') return (html(res, 503, 'damaged'), true);
        if (path === '/login') {
          if (state !== 'account') return (redirect(res, '/setup'), true);
          const rp = rpOf(req, who);
          // the address gonogo printed has the key of the first setup in it: once a login exists the page of the rooms sends that visit here with ?old=1, and the page says why
          const oldLink = (req.url ?? '').includes('?') && new URLSearchParams((req.url ?? '').split('?').slice(1).join('?')).get('old') === '1';
          return (html(res, 200, auth.locked() && !isLocalClass(who.cls) ? 'locked' : 'login', { plain: plainHttp(req, who), passkey: rp !== null && options.passkeys?.has(rp) === true, ...(oldLink ? { message: 'That address was for the first setup, before a login existed. Sign in with your name and password.' } : {}) }), true);
        }
        if (state === 'account') return (redirect(res, '/login'), true);
        return (html(res, isLocalClass(who.cls) ? 200 : 403, isLocalClass(who.cls) ? 'setup' : 'unset', { plain: plainHttp(req, who) }), true);
      }
      if (path === '/api/auth/login' || path === '/api/auth/setup' || path === '/api/auth/second') {
        if (method !== 'POST') return (sendApiError(res, 405, 'method not allowed', 'bad_request', undefined, { Allow: 'POST' }), true);
        void post(req, res, path.endsWith('setup') ? 'setup' : path.endsWith('second') ? 'second' : 'login').catch((error: unknown) => {
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

