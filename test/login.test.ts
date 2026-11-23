// The login through the whole supervisor (docs/login-spec.md): real HTTP and WebSocket on a real front port, stand-in rooms (test/fake-room.mjs)
// behind it on their unix sockets, and the local socket for the TUI and the CLI.
import { loadRooms, setMainHome } from '../src/server/rooms.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AUTH_FILE, resetAuthFiles, SETUP_TOKEN_FILE, totpCode } from '../src/server/auth.js';
import { authCommand, socketCall } from '../src/server/authcli.js';
import { createTuiClient } from '../src/server/tui-client.js';
import { localSocketOf } from '../src/server/tui-cli.js';
import { startSupervisor } from '../src/server/supervisor.js';
import { phone } from './push-phone.js';
import { softKey } from './helpers/softkey.js';
import type { Supervisor } from '../src/server/supervisor.js';
import { WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from '../src/shared/protocol.js';

const FAKE = new URL('./fake-room.mjs', import.meta.url).pathname;
const COSTS = { argon2: { memory: 16, passes: 1, parallelism: 1 }, scrypt: { N: 16, r: 1, p: 1 } };
const PASSWORD = 'correct horse battery staple';
let home: string;
let sup: Supervisor;
let stopped = false;

const until = async (check: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
};

async function boot(over: Partial<Parameters<typeof startSupervisor>[0]> = {}): Promise<void> {
  sup = await startSupervisor({
    home,
    host: '127.0.0.1',
    port: 0,
    allowedHosts: ['gonogo.example.com', 'nas.local'],
    exposureCheck: false,
    command: [process.execPath, FAKE],
    env: { PATH: process.env.PATH ?? '' },
    authCosts: COSTS,
    tamperEveryMs: 0,
    ...over,
  });
  await sup.whenReady(15_000);
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gng-login-'));
  // a home made before 0.9: room main's files are at the root (a room's mission-log folder says so); a fresh home puts main in rooms/main (test/rooms.test.ts)
  mkdirSync(join(home, 'mission-log'));
  setMainHome(home, '.'); // and it has been asked: it stays (a home that was never asked is moved at the start, see test/mainmigrate.test.ts)
  stopped = false;
});
afterEach(async () => {
  if (!stopped) await sup?.stop();
  rmSync(home, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  cookies: Record<string, string>;
  setCookie: string[];
}
/** One request exactly as written (fetch will not set Host, Origin or a cookie jar the way these tests need). */
function call(method: string, path: string, headers: Record<string, string> = {}, body?: string, over: { socket?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...(over.socket === undefined ? { host: '127.0.0.1', port: sup.port } : { socketPath: over.socket }), method, path, headers: { host: over.socket === undefined ? `127.0.0.1:${sup.port}` : 'localhost', ...headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const setCookie = (res.headers['set-cookie'] ?? []) as string[];
          const cookies: Record<string, string> = {};
          for (const line of setCookie) {
            const [pair] = line.split(';');
            const at = (pair ?? '').indexOf('=');
            cookies[(pair ?? '').slice(0, at)] = (pair ?? '').slice(at + 1);
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), cookies, setCookie });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSONH = { 'content-type': 'application/json' };
const origin = (): Record<string, string> => ({ origin: `http://127.0.0.1:${sup.port}` });
const cookieHeader = (cookies: Record<string, string>): Record<string, string> => ({ cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') });
const setupToken = (): string => readFileSync(join(home, SETUP_TOKEN_FILE), 'utf8').trim();

/** Sets the account up through the page's own form; returns the cookies of the session. */
async function setUp(host = `127.0.0.1:${sup.port}`): Promise<Record<string, string>> {
  const res = await call('POST', '/api/auth/setup', { ...FORM, ...origin(), host }, form({ token: setupToken(), user: 'director', password: PASSWORD }));
  expect(res.status).toBe(303);
  return res.cookies;
}

describe('a fresh install', () => {
  it('keeps the old token over TCP until the account exists, and offers the setup page on this machine', async () => {
    await boot();
    const token = sup.directorToken as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('GET', '/api/rooms', { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await call('GET', '/api/rooms')).status).toBe(401);
    const login = await call('GET', '/login');
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe('/setup');
    const page = await call('GET', '/setup');
    expect(page.status).toBe(200);
    expect(page.text).toContain('SET UP THE LOGIN');
    expect(page.text).toContain('can run anything on this machine');
    expect(page.text).not.toMatch(/<script/i);
    expect(page.headers['content-security-policy']).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
    expect(sup.setupToken).toMatch(/^[0-9a-f]{64}$/);
    expect(setupToken()).toBe(sup.setupToken);
  });

  it('a wrong setup token says that the setup token is wrong, not that the name or the password is', async () => {
    await boot();
    const host = `127.0.0.1:${sup.port}`;
    const wrong = await call('POST', '/api/auth/setup', { ...FORM, ...origin(), host }, form({ token: 'f'.repeat(64), user: 'director', password: PASSWORD }));
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('That setup token is wrong: copy it again from the start-up output');
    expect(wrong.text).not.toContain('Wrong name or password.');
  });

  it('B2: Host 127.0.0.1 with a forwarding header is a request somebody passed on: setup is refused as from a public name', async () => {
    await boot();
    const forwarded = { 'x-forwarded-for': '8.8.8.8' };
    const page = await call('GET', '/setup', forwarded);
    expect(page.status).toBe(403);
    expect(page.text).toContain('LOGIN IS NOT SET UP');
    const post = await call('POST', '/api/auth/setup', { ...FORM, ...origin(), ...forwarded }, form({ token: setupToken(), user: 'director', password: PASSWORD }));
    expect(post.status).toBe(403);
    expect(existsSync(join(home, 'token'))).toBe(true);
  });

  it('RETRO 2: a socket opened with the old browser token ends when the account is made', async () => {
    await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${sup.port}/ws`, [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + (sup.directorToken as string)]);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await setUp();
    await closed;
  });

  it('refuses the setup page to a public name: "login is not set up", and never takes a token there', async () => {
    await boot();
    const page = await call('GET', '/setup', { host: 'gonogo.example.com' });
    expect(page.status).toBe(403);
    expect(page.text).toContain('LOGIN IS NOT SET UP');
    const post = await call('POST', '/api/auth/setup', { ...FORM, host: 'gonogo.example.com', origin: 'http://gonogo.example.com' }, form({ token: setupToken(), user: 'director', password: PASSWORD }));
    expect(post.status).toBe(403);
    expect(existsSync(join(home, 'token'))).toBe(true);
  });
});

describe('setup, login and the session cookie', () => {
  it('setup makes the account, logs in, and kills the old token everywhere (R1)', async () => {
    await boot();
    const old = sup.directorToken as string;
    const cookies = await setUp();
    expect(Object.keys(cookies).sort()).toEqual(['gonogo-device', 'gonogo-session']);
    expect(existsSync(join(home, 'token'))).toBe(false);
    expect(existsSync(join(home, SETUP_TOKEN_FILE))).toBe(false);
    // the old token opens nothing: the front, the room list, the rooms, and not through a rewritten Host either
    for (const path of ['/api/state', '/api/rooms', '/r/main/api/state']) {
      expect((await call('GET', path, { authorization: `Bearer ${old}` })).status, path).toBe(401);
      expect((await call('GET', path, { authorization: `Bearer ${old}`, host: 'gonogo.example.com' })).status, path).toBe(401);
      expect((await call('GET', path, { authorization: `Bearer ${old}`, ...origin() })).status, path).toBe(401);
    }
    // and a restart does not bring a token back
    await sup.stop();
    await boot();
    expect(sup.directorToken).toBeNull();
    expect(existsSync(join(home, 'token'))).toBe(false);
    expect(sup.url).not.toContain('#token');
  });

  it('the cookie is HttpOnly, SameSite=Strict, Path=/; plain http on a loopback or private name has no Secure and a public name has __Host- and Secure', async () => {
    await boot();
    const set = await call('POST', '/api/auth/setup', { ...FORM, ...origin() }, form({ token: setupToken(), user: 'director', password: PASSWORD }));
    const session = set.setCookie.find((c) => c.startsWith('gonogo-session='));
    expect(session).toMatch(/; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
    expect(session).not.toContain('Secure');
    const local = await call('POST', '/api/auth/login', { ...FORM, host: 'nas.local', origin: 'http://nas.local' }, form({ user: 'director', password: PASSWORD }));
    expect(local.setCookie.find((c) => c.startsWith('gonogo-session='))).not.toContain('Secure');
    // a public name takes a password only with a second factor on: turn TOTP on from here, then give the code there
    const begun = JSON.parse((await call('POST', '/api/auth/mfa/begin', { ...cookieHeader(set.cookies), ...origin(), ...JSONH }, '{}')).text) as { secret: string };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const ch of begun.secret) {
      value = (value << 5) | alphabet.indexOf(ch);
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    const secret = Buffer.from(bytes);
    expect((await call('POST', '/api/auth/mfa/enable', { ...cookieHeader(set.cookies), ...origin(), ...JSONH }, JSON.stringify({ code: totpCode(secret, Math.floor(Date.now() / 30000)) }))).status).toBe(200);
    const publicHeaders = { ...FORM, host: 'gonogo.example.com', origin: 'http://gonogo.example.com' };
    const step = await call('POST', '/api/auth/login', publicHeaders, form({ user: 'director', password: PASSWORD }));
    const pendingToken = /name="pending" value="([^"]+)"/.exec(step.text)?.[1] as string;
    // the same 30-second step as the one that turned it on is spent: the next one
    const code = totpCode(secret, Math.floor(Date.now() / 30000) + 1);
    const pub = await call('POST', '/api/auth/second', publicHeaders, form({ pending: pendingToken, code }));
    expect(pub.status).toBe(303);
    const secure = pub.setCookie.find((c) => c.startsWith('__Host-gonogo='));
    expect(secure).toMatch(/; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    expect(pub.setCookie.some((c) => c.startsWith('gonogo-session='))).toBe(false);
    expect(pub.setCookie.find((c) => c.startsWith('gonogo-device='))).toContain('Secure');
  });

  it('the cookie opens the page\'s API through the proxy; no cookie, a revoked one and a foreign one do not; a change needs this page\'s Origin', async () => {
    await boot();
    const cookies = await setUp();
    const c = cookieHeader(cookies);
    expect((await call('GET', '/api/state', c)).status).toBe(200);
    expect((await call('GET', '/r/main/api/state', c)).status).toBe(200);
    expect((await call('GET', '/api/state')).status).toBe(401);
    expect((await call('GET', '/api/state', { cookie: 'gonogo-session=nonsense' })).status).toBe(401);
    // CSRF: a change with the cookie and no Origin, or another page's, is 403; this page's passes
    expect((await call('POST', '/api/x', c, '{}')).status).toBe(403);
    expect((await call('POST', '/api/x', { ...c, origin: 'http://evil.example' }, '{}')).status).toBe(403);
    expect((await call('POST', '/api/x', { ...c, ...origin() }, '{}')).status).toBe(200);
    // the room never sees the cookie
    expect(readFileSync(join(home, 'dump.json'), 'utf8')).not.toContain(cookies['gonogo-session'] as string);
  });

  it('the login page and a wrong password: the same answer for a wrong name and a wrong password, a wait after the first', async () => {
    await boot();
    await setUp();
    const wrong = await call('POST', '/api/auth/login', { ...FORM, ...origin() }, form({ user: 'director', password: 'not the password' }));
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('Wrong name or password.');
    const again = await call('POST', '/api/auth/login', { ...FORM, ...origin() }, form({ user: 'someone', password: 'not the password' }));
    expect(again.status).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    expect(wrong.text).not.toContain(PASSWORD);
    // the page itself
    const page = await call('GET', '/login');
    expect(page.status).toBe(200);
    expect(page.text).toContain('LOG IN');
    expect(page.text).toContain('Opened over plain http'.slice(0, 0));
  });

  it('a spoofed X-Forwarded-For changes nothing without --trusted-proxy: the same bucket', async () => {
    await boot();
    await setUp();
    const bad = (xff: string) => call('POST', '/api/auth/login', { ...JSONH, ...origin(), 'x-forwarded-for': xff }, JSON.stringify({ user: 'director', password: 'nope nope nope' }));
    expect((await bad('1.1.1.1')).status).toBe(401);
    expect((await bad('2.2.2.2')).status).toBe(429);
  });

  it('with --trusted-proxy the forwarded address is the client, and the proxy\'s own address is not believed', async () => {
    await boot({ trustedProxies: ['127.0.0.1'] });
    await setUp();
    const bad = (xff: string) => call('POST', '/api/auth/login', { ...JSONH, ...origin(), 'x-forwarded-for': xff }, JSON.stringify({ user: 'director', password: 'nope nope nope' }));
    expect((await bad('1.1.1.1')).status).toBe(401);
    // a different client behind the proxy meets only the global bucket of unknown devices, which has been told once
    expect((await bad('1.1.1.1')).status).toBe(429);
    const sessions = await call('GET', '/api/auth/account', { ...cookieHeader(await (async () => ({}))()) });
    expect(sessions.status).toBe(401);
  });

  it('--client-ip-header cf-connecting-ip: that header names the client, and x-forwarded-for is then not read at all', async () => {
    await boot({ trustedProxies: ['127.0.0.1'], clientIpHeader: 'cf-connecting-ip' });
    await setUp();
    const bad = (headers: Record<string, string>) => call('POST', '/api/auth/login', { ...JSONH, ...origin(), ...headers }, JSON.stringify({ user: 'director', password: 'nope nope nope' }));
    expect((await bad({ 'cf-connecting-ip': '2.2.2.2', 'x-forwarded-for': '5.5.5.1' })).status).toBe(401);
    // the same client address with another x-forwarded-for is the same client: its second try waits
    expect((await bad({ 'cf-connecting-ip': '2.2.2.2', 'x-forwarded-for': '5.5.5.2' })).status).toBe(429);
  });

  it('logout ends the session and clears the cookie; the device list names the session', async () => {
    await boot();
    const cookies = await setUp();
    const c = cookieHeader(cookies);
    const account = JSON.parse((await call('GET', '/api/auth/account', c)).text) as { user: string; sessions: Array<{ id: string; address: string }>; current: string };
    expect(account.user).toBe('director');
    expect(account.sessions).toHaveLength(1);
    expect(account.current).toBe(account.sessions[0]?.id);
    const out = await call('POST', '/api/auth/logout', { ...c, ...origin(), ...JSONH }, '{}');
    expect(out.status).toBe(200);
    expect(out.setCookie.join('\n')).toMatch(/Max-Age=0/);
    expect((await call('GET', '/api/state', c)).status).toBe(401);
  });

  it('a password change needs the current password and ends the other sessions', async () => {
    await boot();
    const first = await setUp();
    const second = (await call('POST', '/api/auth/login', { ...FORM, ...origin(), ...cookieHeader({ 'gonogo-device': first['gonogo-device'] as string }) }, form({ user: 'director', password: PASSWORD }))).cookies;
    const c = cookieHeader(first);
    const body = (current: string, next: string) => JSON.stringify({ current, next });
    expect((await call('POST', '/api/auth/password', { ...c, ...origin(), ...JSONH }, body('wrong wrong wrong', 'another long password'))).status).toBe(401);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call('POST', '/api/auth/password', { ...c, ...origin(), ...JSONH }, body(PASSWORD, 'short'))).status).toBe(400);
    const ok = await call('POST', '/api/auth/password', { ...c, ...origin(), ...JSONH }, body(PASSWORD, 'another long password'));
    expect(ok.status).toBe(200);
    expect((await call('GET', '/api/state', c)).status).toBe(200);
    expect((await call('GET', '/api/state', cookieHeader(second))).status).toBe(401);
  });
});

describe('WebSockets are bound to their session', () => {
  const open = (path: string, headers: Record<string, string>, protocols: string[] = [WS_SUBPROTOCOL]): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${sup.port}${path}`, protocols, { headers });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    });

  it('opens with the cookie from this page, closes when the session is revoked, logged out or the password changes; a foreign Origin is refused', async () => {
    await boot();
    const cookies = await setUp();
    const c = cookieHeader(cookies);
    const here = { ...c, ...origin() };
    await expect(open('/ws', c)).rejects.toThrow(/403/);
    await expect(open('/ws', { ...c, origin: 'http://evil.example' })).rejects.toThrow(/403/);
    await expect(open('/ws', origin())).rejects.toThrow(/401/);
    const closing = async (end: () => Promise<unknown>): Promise<void> => {
      const ws = await open('/ws', here);
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      await end();
      await closed;
    };
    // logout
    await closing(() => call('POST', '/api/auth/logout', { ...here, ...JSONH }, '{}'));
    // a new session: revoked from another one
    const second = (await call('POST', '/api/auth/login', { ...FORM, ...origin(), ...cookieHeader({ 'gonogo-device': cookies['gonogo-device'] as string }) }, form({ user: 'director', password: PASSWORD }))).cookies;
    const third = (await call('POST', '/api/auth/login', { ...FORM, ...origin(), ...cookieHeader({ 'gonogo-device': cookies['gonogo-device'] as string }) }, form({ user: 'director', password: PASSWORD }))).cookies;
    const victim = { ...cookieHeader(third), ...origin() };
    const list = JSON.parse((await call('GET', '/api/auth/account', cookieHeader(second))).text) as { sessions: Array<{ id: string }>; current: string };
    const target = list.sessions.find((s) => s.id !== list.current && s.id !== undefined)?.id as string;
    // find which of the two belongs to `third` by trying to revoke each until the socket drops
    const ws = await open('/ws', victim);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    for (const s of list.sessions) if (s.id !== list.current) await call('DELETE', `/api/auth/sessions/${s.id}`, { ...cookieHeader(second), ...origin() });
    await closed;
    expect(target).toBeDefined();
    // password change ends the other sockets
    const keep = (await call('POST', '/api/auth/login', { ...FORM, ...origin(), ...cookieHeader({ 'gonogo-device': cookies['gonogo-device'] as string }) }, form({ user: 'director', password: PASSWORD }))).cookies;
    const other = (await call('POST', '/api/auth/login', { ...FORM, ...origin(), ...cookieHeader({ 'gonogo-device': cookies['gonogo-device'] as string }) }, form({ user: 'director', password: PASSWORD }))).cookies;
    const ws2 = await open('/ws', { ...cookieHeader(other), ...origin() });
    const closed2 = new Promise<void>((resolve) => ws2.once('close', () => resolve()));
    expect((await call('POST', '/api/auth/password', { ...cookieHeader(keep), ...origin(), ...JSONH }, JSON.stringify({ current: PASSWORD, next: 'another long password' }))).status).toBe(200);
    await closed2;
  });

  it('expiry closes the socket too: idle past the limit, the next check ends it', async () => {
    let clock = Date.now();
    await boot({ now: () => clock });
    const cookies = await setUp();
    const ws = await open('/ws', { ...cookieHeader(cookies), ...origin() });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    clock += 13 * 3600_000;
    expect((await call('GET', '/api/state', cookieHeader(cookies))).status).toBe(401);
    await closed;
  });
});

describe('the local socket (R2) and the API keys', () => {
  it('takes no token and no cookie: the file permissions are the credential, on TCP the same call is 401, and the TUI-shaped calls reach the rooms', async () => {
    await boot();
    await setUp();
    const via = (path: string, method = 'GET', body?: string) => call(method, path, body === undefined ? {} : JSONH, body, { socket: sup.socketPath });
    expect((await via('/api/state')).status).toBe(200);
    expect((await via('/r/main/api/state')).status).toBe(200);
    expect((await via('/api/rooms')).status).toBe(200);
    expect(JSON.parse((await via('/api/auth/account')).text)).toMatchObject({ user: 'director' });
    expect((await call('GET', '/api/state')).status).toBe(401);
    // a POST needs no Origin on the socket
    expect((await via('/api/x', 'POST', '{}')).status).toBe(200);
    // the socket is 0600 in a 0700 directory
    const { statSync } = await import('node:fs');
    expect(statSync(sup.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700);
    // and a WebSocket over it
    const ws = new WebSocket(`ws+unix://${sup.socketPath}:/ws`, [WS_SUBPROTOCOL]);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.close();
  });

  it('the TUI uses it: no token, the socket found in the home, a WebSocket and REST over it, a room under /r/<id>', async () => {
    await boot();
    await setUp();
    expect(localSocketOf(home, {})).toBe(sup.socketPath);
    expect(localSocketOf(join(home, 'nowhere'), {})).toBeNull();
    const links: string[] = [];
    const frames: unknown[] = [];
    const client = createTuiClient({ url: 'http://localhost', token: '', socketPath: sup.socketPath, onFrame: (f) => void frames.push(f), onOutput: () => undefined, onLink: (l) => void links.push(l) });
    client.start();
    await until(() => links.includes('open'));
    await expect(client.hold('ana')).resolves.toBeUndefined();
    await expect(client.sendMessage({ to: 'ana', subject: 's', body: 'b' })).resolves.toBeUndefined();
    client.stop();
    const room = createTuiClient({ url: 'http://localhost/r/main', token: '', socketPath: sup.socketPath, onFrame: () => undefined, onOutput: () => undefined, onLink: (l) => void links.push(l) });
    room.start();
    await until(() => links.filter((l) => l === 'open').length === 2);
    room.stop();
  });

  it('works on a fresh install too, and goes away with the supervisor', async () => {
    await boot();
    expect((await call('GET', '/api/state', {}, undefined, { socket: sup.socketPath })).status).toBe(200);
    await sup.stop();
    stopped = true;
    expect(existsSync(sup.socketPath)).toBe(false);
  });

  it('API keys: made over the socket, shown once, held to their scope, refused from a public name unless --remote, and listed without the secret', async () => {
    await boot();
    await setUp();
    const make = async (name: string, scope: string, remote = false): Promise<string> => {
      const res = await socketCall(sup.socketPath, 'POST', '/api/auth/keys', { name, scope, remote });
      expect(res.status).toBe(201);
      return String(res.body.key);
    };
    const read = await make('reader', 'read');
    const act = await make('actor', 'act');
    const remote = await make('remote', 'full', true);
    expect((await call('GET', '/api/state', { authorization: `Bearer ${read}` })).status).toBe(200);
    expect((await call('POST', '/api/messages', { authorization: `Bearer ${read}`, ...JSONH }, '{}')).status).toBe(403);
    expect((await call('POST', '/api/messages', { authorization: `Bearer ${act}`, ...JSONH }, '{}')).status).toBe(200);
    expect((await call('POST', '/api/agents', { authorization: `Bearer ${act}`, ...JSONH }, '{}')).status).toBe(403);
    // never the account
    expect((await call('GET', '/api/auth/account', { authorization: `Bearer ${remote}` })).status).toBe(401);
    // a public name needs --remote, and so does a request that something in front passed on, whatever Host it names
    expect((await call('GET', '/api/state', { authorization: `Bearer ${read}`, 'x-forwarded-for': '8.8.8.8' })).status).toBe(401);
    expect((await call('GET', '/api/state', { authorization: `Bearer ${read}`, host: 'gonogo.example.com' })).status).toBe(401);
    expect((await call('GET', '/api/state', { authorization: `Bearer ${remote}`, host: 'gonogo.example.com' })).status).toBe(200);
    // the rooms API wants a full key for a change
    expect((await call('GET', '/api/rooms', { authorization: `Bearer ${read}` })).status).toBe(200);
    expect((await call('POST', '/api/rooms', { authorization: `Bearer ${read}`, ...JSONH }, '{"id":"x"}')).status).toBe(403);
    // a socket is a console: only a full key opens one, by the subprotocol; a read or act key is refused
    const open = (key: string): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${sup.port}/ws`, [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + key]);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      });
    await expect(open(read)).rejects.toThrow(/403/);
    await expect(open(act)).rejects.toThrow(/403/);
    const full = await make('full', 'full');
    const ws = await open(full);
    // and it ends with its key: revoked, the socket closes
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const keyId = ((await socketCall(sup.socketPath, 'GET', '/api/auth/account')).body.keys as Array<{ id: string; name: string }>).find((k) => k.name === 'full')?.id as string;
    expect((await socketCall(sup.socketPath, 'DELETE', `/api/auth/keys/${keyId}`)).status).toBe(200);
    await closed;
    const list = await socketCall(sup.socketPath, 'GET', '/api/auth/account');
    expect(JSON.stringify(list.body)).not.toContain(read);
    expect((list.body.keys as unknown[]).length).toBe(3);
    expect(readFileSync(join(home, AUTH_FILE), 'utf8')).not.toContain(read);
  });

  it('gonogo auth key add|list|revoke over the socket, and key add prints the key once', async () => {
    await boot();
    await setUp();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), readLine: async () => PASSWORD };
    expect(await authCommand(['key', 'add', 'ci', '--scope', 'act', '--expires', '30d'], home, io)).toBe(0);
    const key = out.join('').trim();
    expect(key).toMatch(/^gnk_/);
    expect(err.join('')).toMatch(/only time it is shown/);
    out.length = 0;
    expect(await authCommand(['key', 'list'], home, io)).toBe(0);
    expect(out.join('')).toMatch(/ci\s+act/);
    expect(out.join('')).not.toContain(key);
    const id = out.join('').split(/\s+/)[0] as string;
    out.length = 0;
    expect(await authCommand(['key', 'revoke', id], home, io)).toBe(0);
    expect((await call('GET', '/api/state', { authorization: `Bearer ${key}` })).status).toBe(401);
    expect(await authCommand(['key', 'add', 'x', '--scope', 'root'], home, io)).toBe(1);
    expect(await authCommand(['status'], home, io)).toBe(0);
    expect(out.join('')).toContain('login: account');
  });
});

describe('reset, alerts and the tamper alarm through the supervisor', () => {
  const alerts = (): string => (existsSync(join(home, 'alerts')) ? readFileSync(join(home, 'alerts'), 'utf8') : '');

  it('the Director\'s inbox hears the account made, a new device, a new key and the password change, with no secret in the text', async () => {
    await boot();
    await setUp();
    await until(() => /account was created/.test(alerts()));
    await call('POST', '/api/auth/login', { ...FORM, ...origin(), 'user-agent': 'a phone' }, form({ user: 'director', password: PASSWORD }));
    await socketCall(sup.socketPath, 'POST', '/api/auth/keys', { name: 'ci', scope: 'read' });
    await until(() => /new API key/.test(alerts()) && /new device/.test(alerts()));
    const text = alerts();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/gnk_/);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('gonogo auth reset: the alert, every session and socket ends, public names see "not set up", no TCP token works, the setup token is refused on a public name', async () => {
    await boot();
    const cookies = await setUp();
    const c = cookieHeader(cookies);
    const ws = new WebSocket(`ws://127.0.0.1:${sup.port}/ws`, [WS_SUBPROTOCOL], { headers: { ...c, ...origin() } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const out: string[] = [];
    expect(await authCommand(['reset'], home, { out: (t) => void out.push(t), err: () => undefined, readLine: async () => '' })).toBe(0);
    expect(out.join('')).not.toMatch(/[0-9a-f]{64}/);
    // the server notices on the next request after the second its check is rate-limited to
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call('GET', '/api/state', c)).status).toBe(401);
    await closed;
    await until(() => /gonogo auth reset/.test(alerts()));
    expect((await call('GET', '/login', { host: 'gonogo.example.com' })).status).toBe(303);
    const page = await call('GET', '/setup', { host: 'gonogo.example.com' });
    expect(page.status).toBe(403);
    const refused = await call('POST', '/api/auth/setup', { ...FORM, host: 'gonogo.example.com', origin: 'http://gonogo.example.com' }, form({ token: setupToken(), user: 'director', password: PASSWORD }));
    expect(refused.status).toBe(403);
    expect(existsSync(join(home, 'token'))).toBe(false);
    // on this machine the setup token works again
    expect((await call('POST', '/api/auth/setup', { ...FORM, ...origin() }, form({ token: setupToken(), user: 'director', password: PASSWORD }))).status).toBe(303);
  });

  it('a planted session or key in auth.json is an alarm within one check, and remote logins wait for the confirmation on this machine', async () => {
    await boot();
    const cookies = await setUp();
    const real = JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(home, AUTH_FILE), JSON.stringify({ ...real, keys: [{ id: 'e'.repeat(64), name: 'backdoor', scope: 'full', remote: true, created: Date.now(), expires: Date.now() + 1e9, last: null, lastAddress: null }] }));
    sup.auth.checkTamper(true);
    await until(() => /changed outside gonogo/.test(alerts()));
    expect((await call('GET', '/api/state', cookieHeader(cookies))).status).toBe(200);
    const remote = await call('POST', '/api/auth/login', { ...FORM, host: 'gonogo.example.com', origin: 'http://gonogo.example.com' }, form({ user: 'director', password: PASSWORD }));
    expect(remote.status).toBe(423);
    expect(remote.text).toContain('REMOTE LOGINS ARE PAUSED');
    // confirming through the local socket, with the password in memory
    const bad = await socketCall(sup.socketPath, 'POST', '/api/auth/confirm', { password: 'not the password!' });
    expect(bad.status).toBe(401);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await socketCall(sup.socketPath, 'POST', '/api/auth/confirm', { password: PASSWORD })).status).toBe(200);
    const after = await call('POST', '/api/auth/login', { ...FORM, host: 'gonogo.example.com', origin: 'http://gonogo.example.com' }, form({ user: 'director', password: PASSWORD }));
    // no longer paused (it is now the second-factor rule of a public name that answers)
    expect(after.status).toBe(403);
    expect(after.text).toContain('needs a second factor');
  });

  it('a damaged auth.json refuses page logins and keeps no TCP token', async () => {
    writeFileSync(join(home, AUTH_FILE), '{"broken"', { mode: 0o600 });
    writeFileSync(join(home, 'token'), `${'ab'.repeat(32)}\n`, { mode: 0o600 });
    await boot();
    expect(sup.directorToken).toBeNull();
    expect(existsSync(join(home, 'token'))).toBe(false);
    expect((await call('GET', '/login')).status).toBe(503);
    expect((await call('GET', '/api/rooms', { authorization: `Bearer ${'ab'.repeat(32)}` })).status).toBe(401);
    resetAuthFiles(home);
  });
});

describe('the second factor and step-up through the supervisor (PR 2)', () => {
  const fromBase32 = (text: string): Buffer => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of text) {
      value = (value << 5) | alphabet.indexOf(ch);
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(out);
  };
  let clock = 0;
  const codeOf = (secret: Buffer, plus = 0): string => totpCode(secret, Math.floor((clock + plus) / 1000 / 30));
  const json = (c: Record<string, string>, body: unknown): [Record<string, string>, string] => [{ ...c, ...origin(), ...JSONH }, JSON.stringify(body)];

  /** An account with TOTP on, through the page's own routes; returns the session cookies, the secret and the recovery codes. */
  async function withTotp(): Promise<{ cookies: Record<string, string>; secret: Buffer; recovery: string[] }> {
    clock = Date.now();
    await boot({ now: () => clock });
    const cookies = await setUp();
    const begun = JSON.parse((await call('POST', '/api/auth/mfa/begin', ...json(cookieHeader(cookies), {}))).text) as { secret: string; uri: string };
    const secret = fromBase32(begun.secret);
    const enabled = await call('POST', '/api/auth/mfa/enable', ...json(cookieHeader(cookies), { code: codeOf(secret) }));
    expect(enabled.status).toBe(200);
    expect(enabled.headers['cache-control']).toBe('no-store');
    clock += 31_000;
    return { cookies, secret, recovery: (JSON.parse(enabled.text) as { recovery: string[] }).recovery };
  }

  it('turned on through the page: the secret, a first valid code, ten recovery codes once; the account view says so', async () => {
    const { cookies, recovery } = await withTotp();
    expect(recovery).toHaveLength(10);
    const view = JSON.parse((await call('GET', '/api/auth/account', cookieHeader(cookies))).text) as { mfa: { enabled: boolean; recoveryLeft: number } };
    expect(view.mfa).toEqual({ enabled: true, pending: false, recoveryLeft: 10 });
    expect(readFileSync(join(home, AUTH_FILE), 'utf8')).not.toContain(recovery[0] as string);
  });

  it('the login page then asks for the code: a plain form with the pending token, a wrong code says so, the right one signs in', async () => {
    const { secret } = await withTotp();
    const first = await call('POST', '/api/auth/login', { ...FORM, ...origin() }, form({ user: 'director', password: PASSWORD }));
    expect(first.status).toBe(200);
    expect(first.text).toContain('SECOND FACTOR');
    expect(first.text).not.toMatch(/<script/i);
    expect(first.text).not.toContain(PASSWORD);
    expect(first.setCookie).toEqual([]);
    const pending = /name="pending" value="([^"]+)"/.exec(first.text)?.[1] as string;
    const wrong = await call('POST', '/api/auth/second', { ...FORM, ...origin() }, form({ pending, code: '000000' }));
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('SECOND FACTOR');
    expect(wrong.text).toContain('Wrong name or password.');
    await new Promise((r) => setTimeout(r, 1100));
    clock += 31_000;
    const done = await call('POST', '/api/auth/second', { ...FORM, ...origin() }, form({ pending, code: codeOf(secret) }));
    expect(done.status).toBe(303);
    expect(done.cookies['gonogo-session']).toBeDefined();
    expect((await call('GET', '/api/state', cookieHeader(done.cookies))).status).toBe(200);
  });

  it('the JSON way: the first step answers second:true and a token, the second takes the code; a recovery code works once', async () => {
    const { recovery } = await withTotp();
    const login = async (): Promise<string> => {
      const first = await call('POST', '/api/auth/login', { ...JSONH, ...origin() }, JSON.stringify({ user: 'director', password: PASSWORD }));
      expect(JSON.parse(first.text)).toMatchObject({ ok: false, second: true });
      return (JSON.parse(first.text) as { pending: string }).pending;
    };
    const ok = await call('POST', '/api/auth/second', { ...JSONH, ...origin() }, JSON.stringify({ pending: await login(), code: recovery[0] }));
    expect(ok.status).toBe(200);
    expect(ok.cookies['gonogo-session']).toBeDefined();
    await new Promise((r) => setTimeout(r, 1100));
    const again = await call('POST', '/api/auth/second', { ...JSONH, ...origin() }, JSON.stringify({ pending: await login(), code: recovery[0] }));
    expect(again.status).toBe(401);
  });

  it('a public name: with no second factor "this address needs a second factor"; with one, the code lets in and the cookie is the __Host- one', async () => {
    clock = Date.now();
    await boot({ now: () => clock });
    await setUp();
    const pub = { ...FORM, host: 'gonogo.example.com', origin: 'http://gonogo.example.com' };
    const refused = await call('POST', '/api/auth/login', pub, form({ user: 'director', password: PASSWORD }));
    expect(refused.status).toBe(403);
    expect(refused.text).toContain('needs a second factor');
    expect(refused.setCookie).toEqual([]);
  });

  it('step-up: after five minutes a change from the list is refused with stepUp:true, the password (and code) gives a new cookie, and the sockets keep going', async () => {
    const { cookies, secret } = await withTotp();
    const ws = new WebSocket(`ws://127.0.0.1:${sup.port}/ws`, [WS_SUBPROTOCOL], { headers: { ...cookieHeader(cookies), ...origin() } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    let closed = false;
    ws.once('close', () => (closed = true));
    // fresh: the change goes through
    const [h, b] = json(cookieHeader(cookies), {});
    expect((await call('PUT', '/api/permissions', h, b)).status).toBe(200);
    clock += 6 * 60_000;
    const refused = await call('PUT', '/api/permissions', h, b);
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text)).toMatchObject({ stepUp: true, second: true });
    // not behind it: a message, an answer, hold, restart, and any read
    for (const [method, path] of [['POST', '/api/messages'], ['POST', '/api/agents/ana/hold'], ['POST', '/api/agents/ana/restart'], ['GET', '/api/permissions']] as const) expect((await call(method, path, h, b)).status, path).toBe(200);
    // the hire is judged by its body
    const hire = (body: unknown): Promise<Answer> => call('POST', '/api/agents', { ...h }, JSON.stringify(body));
    expect((await hire({ name: 'x', command: 'sh' })).status).toBe(403);
    expect((await hire({ name: 'x', mode: 'default' })).status).toBe(200);
    // the account's own changes too
    expect((await call('POST', '/api/auth/keys', h, JSON.stringify({ name: 'k', scope: 'read' }))).status).toBe(403);
    // a wrong password, then the right password and the current code
    expect((await call('POST', '/api/auth/stepup', h, JSON.stringify({ password: 'not the password', code: codeOf(secret) }))).status).toBe(401);
    await new Promise((r) => setTimeout(r, 1100));
    clock += 31_000;
    const done = await call('POST', '/api/auth/stepup', h, JSON.stringify({ password: PASSWORD, code: codeOf(secret) }));
    expect(done.status).toBe(200);
    const fresh = done.cookies['gonogo-session'] as string;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(cookies['gonogo-session']);
    // the old value is dead, the new one passes the change, and the socket did not close
    expect((await call('GET', '/api/state', cookieHeader(cookies))).status).toBe(401);
    expect((await call('PUT', '/api/permissions', { ...cookieHeader({ ...cookies, 'gonogo-session': fresh }), ...origin(), ...JSONH }, '{}')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(false);
    ws.close();
  });

  it('step-up: the rules of the room (the system prompt of every agent) are refused with stepUp:true when the check is old; reading them is not; a terminal and a key never write them', async () => {
    const { cookies } = await withTotp();
    const [h, b] = json(cookieHeader(cookies), { text: 'Never push to main.' });
    expect((await call('PUT', '/api/rules', h, b)).status).not.toBe(403);
    clock += 6 * 60_000;
    const refused = await call('PUT', '/api/rules', h, b);
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text)).toMatchObject({ stepUp: true });
    expect((await call('GET', '/api/rules', h, b)).status).not.toBe(403);
  });

  it('step-up: stopping rooms, stop-all, start-all and removing a room are refused with stepUp:true when the check is old, with a plain and with an encoded id; after the check they pass', async () => {
    const { cookies, secret } = await withTotp();
    const [h] = json(cookieHeader(cookies), {});
    const made = await call('POST', '/api/rooms', h, JSON.stringify({ id: 'c' }));
    expect(made.status).toBe(201);
    await until(() => sup.rooms().some((r) => r.id === 'c' && r.state === 'running'));
    clock += 6 * 60_000;
    const refused: Array<[string, string]> = [['POST', '/api/rooms/c/stop'], ['POST', '/api/rooms/%63/stop'], ['POST', '/api/rooms/main/stop'], ['POST', '/api/rooms/%6Dain/stop'], ['POST', '/api/rooms/stop-all'], ['POST', '/api/rooms/start-all'], ['DELETE', '/api/rooms/c'], ['DELETE', '/api/rooms/%63']];
    for (const [method, path] of refused) {
      const res = await call(method, path, h, '{}');
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(JSON.parse(res.text), path).toMatchObject({ stepUp: true });
    }
    expect(sup.rooms().map((r) => `${r.id}:${r.state}`).sort()).toEqual(['c:running', 'main:running']); // nothing was stopped or removed
    expect(loadRooms(home).map((r) => r.id)).toContain('c');
    // a bad encoded id is a 400, not a step-up bypass and not a stop
    expect((await call('POST', '/api/rooms/%2e%2e/stop', h, '{}')).status).toBe(400);
    // starting one room is not asked for
    expect((await call('POST', '/api/rooms/c/start', h, '{}')).status).toBe(409); // not refused for the password: it runs already
    await new Promise((r) => setTimeout(r, 1100));
    clock += 31_000;
    const done = await call('POST', '/api/auth/stepup', h, JSON.stringify({ password: PASSWORD, code: codeOf(secret) }));
    expect(done.status).toBe(200);
    const [fresh] = json(cookieHeader({ ...cookies, 'gonogo-session': done.cookies['gonogo-session'] as string }), {});
    expect((await call('POST', '/api/rooms/%63/stop', fresh, '{}')).status).toBe(200);
    expect(sup.rooms().find((r) => r.id === 'c')?.state).toBe('stopped');
    expect((await call('POST', '/api/rooms/start-all', fresh, '{}')).status).toBe(200);
    expect((await call('DELETE', '/api/rooms/%63', fresh, '{}')).status).toBe(200);
  }, 40_000);
  it('step-up: a runtime setting is refused with stepUp:true when the check is old, plain and with an encoded key name; reading is not', async () => {
    const { cookies } = await withTotp();
    const [h] = json(cookieHeader(cookies), {});
    const put = (path: string): Promise<Answer> => call('PUT', path, h, JSON.stringify({ scope: 'room', value: '3' }));
    expect((await put('/api/settings/maxHops')).status).toBe(200); // fresh
    clock += 6 * 60_000;
    for (const path of ['/api/settings/maxHops', '/api/settings/%6DaxHops', '/api/settings/agentCmd']) {
      const refused = await put(path);
      expect(refused.status, path).toBe(403);
      expect(JSON.parse(refused.text)).toMatchObject({ stepUp: true });
    }
    expect((await call('GET', '/api/settings', cookieHeader(cookies))).status).toBe(200);
  });

  it('step-up: moving where room main keeps its files (MIGRATE NOW, UNDO) is refused with stepUp:true when the check is old; cancelling it, dismissing the note and the dry run are not', async () => {
    const { cookies } = await withTotp();
    const [h] = json(cookieHeader(cookies), {});
    const post = (action: string): Promise<Answer> => call('POST', '/api/rooms/main/migrate', h, JSON.stringify({ action }));
    expect((await post('request')).status).toBe(200); // fresh
    clock += 6 * 60_000;
    for (const action of ['request', 'undo']) {
      const refused = await post(action);
      expect(refused.status, action).toBe(403);
      expect(JSON.parse(refused.text)).toMatchObject({ stepUp: true });
    }
    expect((await post('cancel')).status).toBe(200);
    expect((await post('dismiss')).status).toBe(409); // not behind step-up; there is just no note
    expect((await call('GET', '/api/rooms/main/migrate', cookieHeader(cookies))).status).toBe(200);
  });

  describe('push devices (docs/features/mobile.md)', () => {
    const device = (): Record<string, unknown> => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev', keys: { p256dh: phone().p256dh, auth: phone().auth }, device: 'Phone' });
    const stored = (): Array<{ session: string }> => (JSON.parse(readFileSync(join(home, 'push.json'), 'utf8')) as { devices: Array<{ session: string }> }).devices;

    it('subscribe, step-up, revoke: the device followed the new session id and goes with it', async () => {
      const { cookies, secret } = await withTotp();
      const [h] = json(cookieHeader(cookies), {});
      expect((await call('PUT', '/api/push/subscription', h, JSON.stringify(device()))).status).toBe(200);
      expect(stored()).toHaveLength(1);
      clock += 6 * 60_000;
      await new Promise((r) => setTimeout(r, 1100));
      clock += 31_000;
      const done = await call('POST', '/api/auth/stepup', h, JSON.stringify({ password: PASSWORD, code: codeOf(secret) }));
      expect(done.status).toBe(200);
      const fresh = { ...cookies, 'gonogo-session': done.cookies['gonogo-session'] as string };
      // the device is now the new session's: the list says it is this caller's
      const view = JSON.parse((await call('GET', '/api/push', cookieHeader(fresh))).text) as { devices: Array<{ mine: boolean }> };
      expect(view.devices).toMatchObject([{ mine: true }]);
      // a logout ends the session, and the device goes with it
      expect((await call('POST', '/api/auth/logout', { ...cookieHeader(fresh), ...origin() })).status).toBeLessThan(400);
      await until(() => stored().length === 0);
    });

    it('sends what a room says on its pipe, as the supervisor, to a signed-in device: generic, with the room named, and nothing else the room prints', async () => {
      const { addRoom } = await import('../src/server/rooms.js');
      addRoom(home, 'team', 'Team B');
      await boot();
      const cookies = await setUp();
      const p = phone();
      const [h] = [{ ...cookieHeader(cookies), ...origin(), ...JSONH }];
      expect((await call('PUT', '/api/push/subscription', h, JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev', keys: { p256dh: p.p256dh, auth: p.auth }, device: 'Phone' }))).status).toBe(200);
      await sup.stop();
      const sent: Buffer[] = [];
      const fake = (async (_url: URL, init: RequestInit) => (sent.push(Buffer.from(init.body as Uint8Array)), new Response(null, { status: 201 }))) as unknown as typeof fetch;
      const lines = [
        'gonogo-push ' + JSON.stringify({ kind: 'permission', text: 'ana: Bash: rm -rf /' }),
        'gonogo-push ' + JSON.stringify({ kind: 'nope', text: 'x' }),
        'gonogo-push not json',
        'gonogo-pushx ' + JSON.stringify({ kind: 'redline', text: 'x' }),
        ' gonogo-push ' + JSON.stringify({ kind: 'redline', text: 'x' }),
      ];
      await boot({ fetch: fake, env: { PATH: process.env.PATH ?? '', FAKE_ROOM_PUSH: JSON.stringify(lines) } });
      await until(() => sent.length >= 2);
      await new Promise((r) => setTimeout(r, 300));
      expect(sent).toHaveLength(2);
      const shown = sent.map((b) => JSON.parse(p.receive(b)) as Record<string, string>).sort((x, y) => (x.room ?? '').localeCompare(y.room ?? ''));
      expect(shown).toEqual([
        { title: 'gonogo', body: 'An agent needs you', tag: 'gonogo-main-permission', open: 'room', room: 'main' },
        { title: 'gonogo, Team B', body: 'An agent needs you', tag: 'gonogo-team-permission', open: 'room', room: 'team' },
      ]);
    });

    it('a device planted in push.json is gone after the load, and every device goes when the account is reset', async () => {
      const { makeVapid } = await import('../src/server/push.js');
      const planted = { id: 'p1', endpoint: 'https://fcm.googleapis.com/fcm/send/planted', p256dh: phone().p256dh, auth: phone().auth, name: 'Planted', snippet: false, session: 'no-such-session', at: 1 };
      writeFileSync(join(home, 'push.json'), JSON.stringify({ version: 1, vapid: makeVapid(), devices: [planted] }));
      await boot();
      expect(stored()).toEqual([]);
      const cookies = await setUp();
      const [h] = json(cookieHeader(cookies), {});
      expect((await call('PUT', '/api/push/subscription', h, JSON.stringify(device()))).status).toBe(200);
      expect(stored()).toHaveLength(1);
      resetAuthFiles(home);
      await until(() => stored().length === 0, 8000);
    });
  });

  it('turning it off needs the password and a code; the account view then says so', async () => {
    const { cookies, secret } = await withTotp();
    const [h] = json(cookieHeader(cookies), {});
    expect((await call('POST', '/api/auth/mfa/disable', h, JSON.stringify({ password: PASSWORD, code: '000000' }))).status).toBe(401);
    await new Promise((r) => setTimeout(r, 1100));
    clock += 31_000;
    expect((await call('POST', '/api/auth/mfa/disable', h, JSON.stringify({ password: PASSWORD, code: codeOf(secret) }))).status).toBe(200);
    const view = JSON.parse((await call('GET', '/api/auth/account', cookieHeader(cookies))).text) as { mfa: { enabled: boolean } };
    expect(view.mfa.enabled).toBe(false);
  });
});

describe('passkeys through the supervisor', () => {
  const NAME = 'gonogo.example.com';
  const ORIGIN = `https://${NAME}`;
  /** A request as the browser makes it at the public name: the Host, and the https origin of the page. */
  const at = (cookies: Record<string, string> = {}, extra: Record<string, string> = {}): Record<string, string> => ({ host: NAME, origin: ORIGIN, ...JSONH, ...cookieHeader(cookies), ...extra });
  const post = (path: string, headers: Record<string, string>, body: unknown = {}): Promise<Answer> => call('POST', path, headers, JSON.stringify(body));

  /** The account, a session from this machine, and one passkey registered at the public name. */
  let pclock = Date.now();
  const unbase32 = (text: string): Buffer => {
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of text) {
      value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(out);
  };
  let secret: Buffer = Buffer.alloc(0);
  const codeOf = (plus = 0): string => totpCode(secret, Math.floor((pclock + plus) / 1000 / 30));
  /** The way back first: a passkey asks for the second factor to be on. */
  async function totpOn(cookies: Record<string, string>): Promise<void> {
    const local = { ...cookieHeader(cookies), ...origin(), ...JSONH };
    secret = unbase32((JSON.parse((await call('POST', '/api/auth/mfa/begin', local, '{}')).text) as { secret: string }).secret);
    expect((await call('POST', '/api/auth/mfa/enable', local, JSON.stringify({ code: codeOf() }))).status).toBe(200);
    pclock += 31_000;
  }
  async function withPasskey(): Promise<{ cookies: Record<string, string>; key: ReturnType<typeof softKey> }> {
    pclock = Date.now();
    await boot({ now: () => pclock });
    const cookies = await setUp();
    await totpOn(cookies);
    const key = softKey();
    const begun = JSON.parse((await post('/api/auth/passkeys/begin', at(cookies))).text) as { challenge: string };
    const done = await post('/api/auth/passkeys/finish', at(cookies), { name: 'laptop', response: key.create({ rpId: NAME, origin: ORIGIN, challenge: begun.challenge }) });
    expect(done.status).toBe(200);
    return { cookies, key };
  }

  it('is registered with a session and listed; the account view says where one can be made', async () => {
    const { cookies } = await withPasskey();
    const view = JSON.parse((await call('GET', '/api/auth/account', { ...cookieHeader(cookies), host: NAME })).text) as { passkeys: Array<{ id: string; name: string; rpId: string }>; passkeyHere: string | null };
    expect(view.passkeys).toEqual([expect.objectContaining({ name: 'laptop', rpId: NAME })]);
    expect(view.passkeyHere).toBe(NAME);
    // on this machine there is none to be made
    const here = JSON.parse((await call('GET', '/api/auth/account', cookieHeader(cookies))).text) as { passkeyHere: string | null };
    expect(here.passkeyHere).toBeNull();
    expect((await post('/api/auth/passkeys/begin', { ...at(cookies), host: `127.0.0.1:${sup.port}`, origin: `http://127.0.0.1:${sup.port}` })).status).toBe(409);
    // without a session, or from an address that is only an IP: no
    expect((await post('/api/auth/passkeys/begin', at())).status).toBe(401);
    expect((await post('/api/auth/passkeys/begin', at(cookies, { host: '203.0.113.9' }))).status).toBe(403);
  });

  it('the login page offers it where there is one: the button and the one script it may load, and nowhere else', async () => {
    await withPasskey();
    const pub = await call('GET', '/login', { host: NAME });
    expect(pub.text).toContain('LOG IN WITH A PASSKEY');
    expect(pub.text).toContain('<script src="/login/passkey.js" defer></script>');
    expect(pub.headers['content-security-policy']).toMatch(/script-src 'self'; connect-src 'self'/);
    const local = await call('GET', '/login');
    expect(local.text).not.toContain('PASSKEY');
    expect(local.headers['content-security-policy']).not.toMatch(/script-src/);
    const js = await call('GET', '/login/passkey.js', { host: NAME });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.text).toContain("/api/auth/passkey/login");
    expect((await call('POST', '/login/passkey.js', { host: NAME })).status).toBe(405);
  });

  it('signs in with no password and no code, even though a public name needs a second factor: a session and a device cookie', async () => {
    const { key } = await withPasskey();
    const options = await post('/api/auth/passkey/options', at());
    expect(options.status).toBe(200);
    const { challenge } = JSON.parse(options.text) as { challenge: string };
    const login = await post('/api/auth/passkey/login', at(), key.get({ rpId: NAME, origin: ORIGIN, challenge }));
    expect(login.status).toBe(200);
    const secure = login.setCookie.find((c) => c.startsWith('__Host-gonogo='));
    expect(secure).toMatch(/; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    expect((await call('GET', '/api/state', { host: NAME, ...cookieHeader(login.cookies) })).status).toBe(200);
    // the same answer again is a spent challenge
    expect((await post('/api/auth/passkey/login', at(), key.get({ rpId: NAME, origin: ORIGIN, challenge }))).status).toBe(401);
  });

  it('the origin of the page must be https at this name: another one, none, or a name that is only an address, is "not available"', async () => {
    const { key } = await withPasskey();
    for (const headers of [at({}, { origin: 'http://gonogo.example.com' }), at({}, { origin: 'https://evil.example' }), { host: NAME, ...JSONH }, at({}, { host: '203.0.113.9' }), { ...at(), host: '127.0.0.1' }]) {
      expect([403, 404], JSON.stringify(headers)).toContain((await post('/api/auth/passkey/options', headers)).status);
    }
    expect((await post('/api/auth/passkey/login', at({}, { origin: 'https://evil.example' }), key.get({ rpId: NAME, origin: ORIGIN, challenge: 'x' }))).status).toBe(404);
  });

  it('a wrong passkey is 401 with no wait, and the right one still works after many', async () => {
    const { key } = await withPasskey();
    for (let i = 0; i < 6; i += 1) {
      const { challenge } = JSON.parse((await post('/api/auth/passkey/options', at())).text) as { challenge: string };
      expect((await post('/api/auth/passkey/login', at(), softKey().get({ rpId: NAME, origin: ORIGIN, challenge }))).status).toBe(401);
    }
    const { challenge } = JSON.parse((await post('/api/auth/passkey/options', at())).text) as { challenge: string };
    expect((await post('/api/auth/passkey/login', at(), key.get({ rpId: NAME, origin: ORIGIN, challenge }))).status).toBe(200);
  });

  it('step-up: the refusal says a passkey will do, and the passkey confirms and gives a new cookie', async () => {
    const { cookies, key } = await withPasskey();
    // five minutes on, a change of the list is refused, and the refusal says a passkey will do
    pclock += 6 * 60_000;
    const refused = await call('PUT', '/api/permissions', at(cookies), '{}');
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text)).toMatchObject({ stepUp: true, passkey: true });
    const o = await post('/api/auth/stepup/options', at(cookies));
    expect(o.status).toBe(200);
    const { challenge } = JSON.parse(o.text) as { challenge: string };
    const done = await post('/api/auth/stepup', at(cookies), { passkey: key.get({ rpId: NAME, origin: ORIGIN, challenge }) });
    expect(done.status).toBe(200);
    // the cookie is minted again for the name the page is at
    const fresh = done.cookies['__Host-gonogo'] as string;
    expect(fresh).toBeDefined();
    expect((await call('GET', '/api/state', cookieHeader(cookies))).status).toBe(401);
    expect((await call('GET', '/api/state', { host: NAME, ...cookieHeader({ '__Host-gonogo': fresh }) })).status).toBe(200);
    // and the change now goes through
    expect((await call('PUT', '/api/permissions', at({ '__Host-gonogo': fresh }), '{}')).status).toBe(200);
    // a wrong one is refused
    const next = { '__Host-gonogo': fresh };
    const o2 = await post('/api/auth/stepup/options', at(next));
    const again = JSON.parse(o2.text) as { challenge: string };
    expect((await post('/api/auth/stepup', at(next), { passkey: softKey().get({ rpId: NAME, origin: ORIGIN, challenge: again.challenge }) })).status).toBe(401);
  });

  it('the first passkey needs the second factor on (the way back if the name changes), and the second factor stays while a passkey does', async () => {
    pclock = Date.now();
    await boot({ now: () => pclock });
    const cookies = await setUp();
    const refused = await post('/api/auth/passkeys/begin', at(cookies));
    expect(refused.status).toBe(409);
    expect(refused.text).toContain('second factor');
    await totpOn(cookies);
    expect((await post('/api/auth/passkeys/begin', at(cookies))).status).toBe(200);
    const { cookies: _unused } = { cookies };
    void _unused;
  });

  it('turning the second factor off is refused while a passkey exists', async () => {
    const { cookies } = await withPasskey();
    const off = await post('/api/auth/mfa/disable', at(cookies), { password: PASSWORD, code: codeOf() });
    expect(off.status).toBe(409);
    expect(off.text).toContain('remove the passkeys first');
  });

  it('removing one needs the password and a code (or a passkey), not only a fresh session; then the login says none is set up', async () => {
    const { cookies, key } = await withPasskey();
    const view = JSON.parse((await call('GET', '/api/auth/account', { ...cookieHeader(cookies), host: NAME })).text) as { passkeys: Array<{ id: string }> };
    const id = view.passkeys[0]?.id as string;
    const del = (headers: Record<string, string>, body: unknown = {}): Promise<Answer> => call('DELETE', `/api/auth/passkeys/${id}`, headers, JSON.stringify(body));
    expect((await del({ host: NAME, origin: ORIGIN, ...JSONH })).status).toBe(401);
    // a session that is fresh but gives nothing, or the wrong thing
    expect((await del(at(cookies))).status).toBe(401);
    pclock += 10_000;
    expect((await del(at(cookies), { password: 'not the password', code: codeOf() })).status).toBe(401);
    // the waits count on the clock of the supervisor; the session stays fresh (under five minutes)
    pclock += 10_000;
    expect((await del(at(cookies), { password: PASSWORD, code: '000000' })).status).toBe(401);
    expect((await post('/api/auth/passkey/options', at())).status).toBe(200);
    pclock += 20_000;
    expect((await del(at(cookies), { password: PASSWORD, code: codeOf() })).status).toBe(200);
    expect((await post('/api/auth/passkey/options', at())).status).toBe(404);
    void key;
  });

  it('or with a passkey assertion for the same session', async () => {
    const { cookies, key } = await withPasskey();
    const view = JSON.parse((await call('GET', '/api/auth/account', { ...cookieHeader(cookies), host: NAME })).text) as { passkeys: Array<{ id: string }> };
    const id = view.passkeys[0]?.id as string;
    const { challenge } = JSON.parse((await post('/api/auth/stepup/options', at(cookies))).text) as { challenge: string };
    expect((await call('DELETE', `/api/auth/passkeys/${id}`, at(cookies), JSON.stringify({ passkey: key.get({ rpId: NAME, origin: ORIGIN, challenge }) }))).status).toBe(200);
    expect((await post('/api/auth/passkey/options', at())).status).toBe(404);
  });
});

describe('the device login of a terminal through the supervisor', () => {
  const NAME = 'gonogo.example.com';
  let dclock = Date.now();
  let secret: Buffer = Buffer.alloc(0);
  const unbase32 = (text: string): Buffer => {
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of text) {
      value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(out);
  };
  const bootDevice = async (over: Partial<Parameters<typeof startSupervisor>[0]> = {}, totp = false): Promise<Record<string, string>> => {
    dclock = Date.now();
    await boot({ now: () => dclock, ...over });
    const cookies = await setUp();
    if (totp) {
      const local = { ...cookieHeader(cookies), ...origin(), ...JSONH };
      secret = unbase32((JSON.parse((await call('POST', '/api/auth/mfa/begin', local, '{}')).text) as { secret: string }).secret);
      expect((await call('POST', '/api/auth/mfa/enable', local, JSON.stringify({ code: totpCode(secret, Math.floor(dclock / 30000)) }))).status).toBe(200);
      dclock += 31_000;
    }
    return cookies;
  };
  const startFlow = async (headers: Record<string, string> = {}, label = 'laptop'): Promise<{ device_code: string; user_code: string; verification_uri: string }> => {
    const res = await call('POST', '/api/auth/device', { ...JSONH, ...headers }, JSON.stringify({ label }));
    expect(res.status, res.text).toBe(200);
    return JSON.parse(res.text) as { device_code: string; user_code: string; verification_uri: string };
  };
  const poll = (deviceCode: string, headers: Record<string, string> = {}): Promise<Answer> => call('POST', '/api/auth/device/token', { ...JSONH, ...headers }, JSON.stringify({ device_code: deviceCode }));
  const typeCode = (cookies: Record<string, string>, code: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<Answer> =>
    call('POST', '/login/device', { ...FORM, ...origin(), ...cookieHeader(cookies), ...headers }, form({ code, ...extra }));
  const decide = (cookies: Record<string, string>, code: string, action: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<Answer> =>
    call('POST', '/login/device/decide', { ...FORM, ...origin(), ...cookieHeader(cookies), ...headers }, form({ code, action, ...extra }));
  const notices = (): string => (existsSync(join(home, 'notices')) ? readFileSync(join(home, 'notices'), 'utf8') : '');
  const alertsText = (): string => (existsSync(join(home, 'alerts')) ? readFileSync(join(home, 'alerts'), 'utf8') : '');

  it('does not exist before an account does, nor on a public name whose account has no second factor; with one it answers there with an https address', async () => {
    await boot({ now: () => dclock });
    expect((await call('POST', '/api/auth/device', JSONH, '{}')).status).toBe(404);
    expect((await call('POST', '/api/auth/device/token', JSONH, '{}')).status).toBe(404);
    const cookies = await setUp();
    expect((await call('POST', '/api/auth/device', { ...JSONH, host: NAME }, '{}')).status).toBe(404);
    const lan = await call('POST', '/api/auth/device', JSONH, '{}');
    expect(lan.status).toBe(200);
    expect((JSON.parse(lan.text) as { verification_uri: string }).verification_uri).toBe(`http://127.0.0.1:${sup.port}/login/device`);
    const local = { ...cookieHeader(cookies), ...origin(), ...JSONH };
    secret = unbase32((JSON.parse((await call('POST', '/api/auth/mfa/begin', local, '{}')).text) as { secret: string }).secret);
    // the server's clock is dclock, which is not the real time once another test moved it (or this file ran for a while): a code of the real step is refused
    expect((await call('POST', '/api/auth/mfa/enable', local, JSON.stringify({ code: totpCode(secret, Math.floor(dclock / 30000)) }))).status).toBe(200);
    const flow = await startFlow({ host: NAME });
    expect(flow.verification_uri).toBe(`https://${NAME}/login/device`);
    expect(flow.verification_uri).not.toContain(flow.user_code);
    // the page answers 404 where the endpoints do
    expect((await call('GET', '/login/device', { host: 'evil.example' })).status).toBe(403);
  });

  it('a full flow: the page never prefills the code, the details are shown as text, approve gives one token, and the open pages and the alert hear of it', async () => {
    const cookies = await bootDevice();
    const flow = await startFlow({ 'user-agent': 'gonogo-tui <b>x</b>' }, '<img src=x onerror=alert(1)>');
    await until(() => notices().includes('is asking to log in'));
    const page = await call('GET', '/login/device', cookieHeader(cookies));
    expect(page.status).toBe(200);
    expect(page.text).toContain('SIGN IN A TERMINAL');
    expect(page.text).not.toContain(flow.user_code);
    expect(page.text).not.toMatch(/<script/i);
    expect(page.text).not.toMatch(/value="[^"]+"/);
    const details = await typeCode(cookies, flow.user_code.toLowerCase());
    expect(details.status).toBe(200);
    expect(details.text).toContain('A TERMINAL ASKS TO SIGN IN');
    expect(details.text).toContain('127.0.0.1');
    expect(details.text).toContain('&#60;img src=x onerror=alert(1)&#62;');
    expect(details.text).not.toContain('<img src=x');
    expect(details.text).toContain('Approve only if you started this on your own terminal just now');
    // nothing is approved yet
    expect(JSON.parse((await poll(flow.device_code)).text)).toEqual({ error: 'authorization_pending' });
    const done = await decide(cookies, flow.user_code, 'approve');
    expect(done.text).toContain('APPROVED');
    dclock += 6000;
    const got = await poll(flow.device_code);
    const token = (JSON.parse(got.text) as { token: string }).token;
    expect(token).toMatch(/^gnt_/);
    expect((await poll(flow.device_code)).status).toBe(400);
    await until(() => /TUI session approved/.test(alertsText()));
    expect(alertsText()).not.toContain(token);
    expect(alertsText()).not.toContain(flow.device_code);
    expect(notices()).not.toContain(token);
    // the token is a Bearer credential: the room and the account
    const bearer = { authorization: `Bearer ${token}` };
    expect((await call('GET', '/api/state', bearer)).status).toBe(200);
    expect((await call('POST', '/api/x', { ...bearer, ...JSONH }, '{}')).status).toBe(200);
    const view = JSON.parse((await call('GET', '/api/auth/account', cookieHeader(cookies))).text) as { sessions: Array<{ type: string; label: string }> };
    expect(view.sessions.map((s) => s.type).sort()).toEqual(['browser', 'tui']);
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).not.toContain(token);
  });

  it('M3: a cross-origin or originless POST is refused, and so is a cookie-less one; deny ends the flow with access_denied', async () => {
    const cookies = await bootDevice();
    const flow = await startFlow();
    expect((await call('POST', '/login/device', { ...FORM, ...cookieHeader(cookies), origin: 'http://evil.example' }, form({ code: flow.user_code }))).status).toBe(403);
    expect((await call('POST', '/login/device', { ...FORM, ...cookieHeader(cookies) }, form({ code: flow.user_code }))).status).toBe(403);
    expect((await call('POST', '/login/device/decide', { ...FORM, ...cookieHeader(cookies), origin: 'http://evil.example' }, form({ code: flow.user_code, action: 'approve' }))).status).toBe(403);
    expect((await call('POST', '/login/device', { ...FORM, ...origin() }, form({ code: flow.user_code }))).status).toBe(303);
    expect((await decide(cookies, flow.user_code, 'deny')).text).toContain('DENIED');
    dclock += 6000;
    expect(JSON.parse((await poll(flow.device_code)).text)).toEqual({ error: 'access_denied' });
    // the code is spent
    expect((await typeCode(cookies, flow.user_code)).status).toBe(404);
  });

  it('adding a room with a project folder is the Director\'s own doing: a session (after the password check), not a key or a terminal; a room without a folder is open to a key as before', async () => {
    const cookies = await bootDevice();
    const key = String((await socketCall(sup.socketPath, 'POST', '/api/auth/keys', { name: 'k', scope: 'full' })).body.key);
    const approved = await startFlow();
    await decide(cookies, approved.user_code, 'approve');
    dclock += 6000;
    const tui = (JSON.parse((await poll(approved.device_code)).text) as { token: string }).token;
    const folder = mkdtempSync(join(tmpdir(), 'gng-pf-login-'));
    try {
      const add = (headers: Record<string, string>, body: Record<string, unknown>) => call('POST', '/api/rooms', { ...JSONH, ...headers }, JSON.stringify(body));
      const session = { ...cookieHeader(cookies), ...origin() };
      expect((await add({ authorization: `Bearer ${key}` }, { id: 'a', dir: folder })).status).toBe(403);
      expect((await add({ authorization: `Bearer ${tui}` }, { id: 'a', dir: folder })).status).toBe(403);
      expect(existsSync(join(home, 'rooms', 'a'))).toBe(false);
      expect((await add({ authorization: `Bearer ${key}` }, { id: 'plain' })).status).toBe(201);
      // the dry run of a folder says what exists on this computer: the Director's own login only
      const check = (headers: Record<string, string>) => call('GET', `/api/rooms/check-folder?dir=${encodeURIComponent(folder)}`, headers);
      expect((await check({ authorization: `Bearer ${key}` })).status).toBe(403);
      expect((await check({ authorization: `Bearer ${tui}` })).status).toBe(403);
      expect((await check(session)).status).toBe(200);
      expect((await add(session, { id: 'b', dir: folder })).status).toBe(201);
      expect(JSON.parse(readFileSync(join(home, 'rooms', 'b', 'project-folder.json'), 'utf8')).dir).toBe(folder);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('who changed a runtime setting reaches the room as x-gonogo-actor only on /api/settings, from the grant and never from the sender; a stale session is asked for the password', async () => {
    const cookies = await bootDevice();
    const key = String((await socketCall(sup.socketPath, 'POST', '/api/auth/keys', { name: 'k', scope: 'full' })).body.key);
    const approved = await startFlow();
    await decide(cookies, approved.user_code, 'approve');
    dclock += 6000;
    const tui = (JSON.parse((await poll(approved.device_code)).text) as { token: string }).token;
    const last = (): { url: string; actor: string | null } => {
      const lines = readFileSync(join(home, 'posts.jsonl'), 'utf8').trim().split('\n');
      return JSON.parse(lines[lines.length - 1] as string) as { url: string; actor: string | null };
    };
    const put = (headers: Record<string, string>) => call('PUT', '/r/main/api/settings/maxHops', { ...JSONH, ...headers }, JSON.stringify({ scope: 'room', value: '3' }));
    const session = { ...cookieHeader(cookies), ...origin() };
    expect((await put(session)).status).toBe(200);
    expect(last()).toMatchObject({ url: '/api/settings/maxHops', actor: 'session' });
    expect((await put({ authorization: `Bearer ${key}`, 'x-gonogo-actor': 'session' })).status).toBe(200);
    expect(last().actor).toMatch(/^key:[0-9a-f]{1,12}$/);
    expect((await put({ authorization: `Bearer ${tui}`, 'x-gonogo-actor': 'session' })).status).toBe(403); // a terminal login is asked for the password in the browser
    expect((await put({ ...session, 'x-gonogo-actor': 'key:ffffffffffff' })).status).toBe(200);
    expect(last().actor).toBe('session');
    // the network addresses of the computer: the actor is told for that route too, so that the room can keep them from a key
    const get = (headers: Record<string, string>) => call('GET', '/r/main/api/docking/addresses', headers);
    await get(session);
    expect(last()).toMatchObject({ url: '/api/docking/addresses', actor: 'session' });
    await get({ authorization: `Bearer ${key}`, 'x-gonogo-actor': 'session' });
    expect(last().actor).toMatch(/^key:[0-9a-f]{1,12}$/);
    // another route carries no actor
    await call('POST', '/r/main/api/messages', { ...JSONH, ...session }, JSON.stringify({ to: 'ana', body: 'go' }));
    expect(last()).toMatchObject({ url: '/api/messages', actor: null });
  });

  it("the Director's words are marked for the room only when a signed-in browser session posts a message: not a key, a terminal, the local socket, another route, and never a header a sender wrote", async () => {
    const cookies = await bootDevice();
    const key = String((await socketCall(sup.socketPath, 'POST', '/api/auth/keys', { name: 'k', scope: 'full' })).body.key);
    const approved = await startFlow();
    await decide(cookies, approved.user_code, 'approve');
    dclock += 6000;
    const tui = (JSON.parse((await poll(approved.device_code)).text) as { token: string }).token;
    const posts = (): Array<{ url: string; director: string | null; other: string[] }> =>
      readFileSync(join(home, 'posts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { url: string; director: string | null; other: string[] });
    const post = async (path: string, headers: Record<string, string>): Promise<{ url: string; director: string | null; other: string[] }> => {
      const before = existsSync(join(home, 'posts.jsonl')) ? posts().length : 0;
      const res = await call('POST', path, { ...JSONH, ...headers }, JSON.stringify({ to: 'ana', body: 'go' }));
      expect(res.status, path).toBe(200);
      const now = posts();
      expect(now).toHaveLength(before + 1);
      return now[before] as { url: string; director: string | null; other: string[] };
    };
    const session = { ...cookieHeader(cookies), ...origin() };
    // the signed-in browser: marked
    expect(await post('/r/main/api/messages', session)).toMatchObject({ url: '/api/messages', director: 'web', other: ['x-gonogo-director'] });
    // anything else is not: a key, a terminal's session, a header written by the sender (dropped, even with a good cookie), another route, another spelling of the path
    expect(await post('/r/main/api/messages', { authorization: `Bearer ${key}` })).toMatchObject({ director: null, other: [] });
    expect(await post('/r/main/api/messages', { authorization: `Bearer ${tui}` })).toMatchObject({ director: null, other: [] });
    expect(await post('/r/main/api/messages', { authorization: `Bearer ${key}`, 'x-gonogo-director': 'web' })).toMatchObject({ director: null, other: [] });
    expect(await post('/r/main/api/messages', { ...session, 'x-gonogo-director': 'telegram', 'x-gonogo-other': '1' })).toMatchObject({ director: 'web', other: ['x-gonogo-director'] });
    expect(await post('/r/main/api/agents', { ...session, 'x-gonogo-director': 'web' })).toMatchObject({ director: null, other: [] });
    expect(await post('/r/main/API/messages', session)).toMatchObject({ director: null });
    // the local socket is the supervisor's own door and carries no mark
    const before = posts().length;
    expect((await socketCall(sup.socketPath, 'POST', '/r/main/api/messages', { to: 'ana', body: 'go' })).status).toBe(200);
    expect(posts()[before]).toMatchObject({ director: null, other: [] });
  });

  it('only a browser session approves: a key, a terminal session and a request with no cookie are sent to the login', async () => {
    const cookies = await bootDevice();
    const key = String((await socketCall(sup.socketPath, 'POST', '/api/auth/keys', { name: 'k', scope: 'full' })).body.key);
    const first = await startFlow();
    const approvedFlow = await startFlow();
    await decide(cookies, approvedFlow.user_code, 'approve');
    dclock += 6000;
    const tui = (JSON.parse((await poll(approvedFlow.device_code)).text) as { token: string }).token;
    for (const auth of [`Bearer ${key}`, `Bearer ${tui}`]) {
      const res = await call('POST', '/login/device', { ...FORM, ...origin(), authorization: auth }, form({ code: first.user_code }));
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe('/login');
    }
    expect(JSON.parse((await poll(first.device_code)).text)).toEqual({ error: 'authorization_pending' });
  });

  it('M1: a forged X-Forwarded-For from an untrusted peer is ignored: the address is the peer\'s', async () => {
    const cookies = await bootDevice({}, true);
    const forged = await startFlow({ 'x-forwarded-for': '8.8.8.8' });
    const near = await typeCode(cookies, forged.user_code);
    expect(near.text).toContain('127.0.0.1');
    expect(near.text).not.toContain('8.8.8.8');
  });

  it('a terminal on another network than the browser: a warning and a second tap', async () => {
    const cookies = await bootDevice({ trustedProxies: ['127.0.0.1'] }, true);
    const asBrowser = { 'x-forwarded-for': '198.51.100.9' };
    const flow = await startFlow({ 'x-forwarded-for': '203.0.113.5' });
    const details = await typeCode(cookies, flow.user_code, {}, asBrowser);
    expect(details.text).toContain('203.0.113.5');
    expect(details.text).toContain('different network');
    // one tap is not enough
    const once = await decide(cookies, flow.user_code, 'approve', {}, asBrowser);
    expect(once.text).toContain('APPROVE ANYWAY');
    expect(once.text).toContain('second look');
    expect(JSON.parse((await poll(flow.device_code, { 'x-forwarded-for': '203.0.113.5' })).text)).toEqual({ error: 'authorization_pending' });
    const twice = await decide(cookies, flow.user_code, 'approve', { again: '1' }, asBrowser);
    expect(twice.text).toContain('APPROVED');
    // a terminal on the same network has no warning
    const same = await startFlow({ 'x-forwarded-for': '198.51.100.40' });
    const quiet = await typeCode(cookies, same.user_code, {}, asBrowser);
    expect(quiet.text).not.toContain('different network');
  });

  it('after five minutes the page asks the password (and the code) again before it shows anything, and mints the session\'s id again', async () => {
    const cookies = await bootDevice({}, true);
    const flow = await startFlow();
    dclock += 6 * 60_000;
    const stale = await call('GET', '/login/device', cookieHeader(cookies));
    expect(stale.text).toContain('give it again');
    expect(stale.text).toContain('name="password"');
    expect(stale.text).toContain('name="totp"');
    const wrong = await typeCode(cookies, flow.user_code, { password: 'not the password', totp: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.text).not.toContain('A TERMINAL ASKS');
    dclock += 31_000;
    const right = await typeCode(cookies, flow.user_code, { password: PASSWORD, totp: totpCode(secret, Math.floor(dclock / 30000)) });
    expect(right.status, right.text).toBe(200);
    expect(right.text).toContain('A TERMINAL ASKS TO SIGN IN');
    expect(right.cookies['gonogo-session']).toBeDefined();
    expect(right.cookies['gonogo-session']).not.toBe(cookies['gonogo-session']);
    // the new cookie decides at once
    const done = await decide({ ...cookies, 'gonogo-session': right.cookies['gonogo-session'] as string }, flow.user_code, 'approve');
    expect(done.text).toContain('APPROVED');
  });

  it('RSO N1: both endpoints check the Host like /login does (403), and the address given back is put together from the accepted name and port, never the raw Host', async () => {
    await bootDevice({ allowedHosts: ['gonogo.example.com', 'nas.local'] }, true);
    for (const path of ['/api/auth/device', '/api/auth/device/token']) {
      expect((await call('POST', path, { ...JSONH, host: 'evil.example' }, '{}')).status, path).toBe(403);
    }
    expect((await call('GET', '/login/device', { host: 'evil.example' })).status).toBe(403);
    const upper = await startFlow({ host: 'GONOGO.Example.COM' });
    expect(upper.verification_uri).toBe('https://gonogo.example.com/login/device');
    const withPort = await call('POST', '/api/auth/device', { ...JSONH, host: 'gonogo.example.com:8443' }, '{}');
    expect((JSON.parse(withPort.text) as { verification_uri: string }).verification_uri).toBe('https://gonogo.example.com:8443/login/device');
  });

  it('RSO N2: the wrong-code count follows the device cookie, so a step-up that mints the session again gives no fresh tries', async () => {
    const cookies = await bootDevice({}, true);
    const flow = await startFlow();
    for (let i = 0; i < 5; i += 1) expect((await typeCode(cookies, `ZZZZ-ZZZ${i}`)).status).toBe(404);
    expect((await typeCode(cookies, flow.user_code)).status).toBe(429);
    // six minutes on the password is asked again; giving it mints a new session id, and the counter is still the old one's
    dclock += 6 * 60_000;
    dclock += 31_000;
    const again = await typeCode(cookies, flow.user_code, { password: PASSWORD, totp: totpCode(secret, Math.floor(dclock / 30000)) });
    expect(again.cookies['gonogo-session']).toBeDefined();
    expect(again.cookies['gonogo-session']).not.toBe(cookies['gonogo-session']);
    expect(again.status).toBe(429);
    expect(again.text).toContain('Too many wrong codes');
    expect(again.text).not.toContain('A TERMINAL ASKS TO SIGN IN');
    // with the new cookie the tries are still the old ones
    const retry = await typeCode({ ...cookies, 'gonogo-session': again.cookies['gonogo-session'] as string }, flow.user_code);
    expect(retry.status).toBe(429);
  });

  it('S1: the third waiting terminal from an address is refused with the way around it; wrong or missing device codes are refused', async () => {
    await bootDevice();
    await startFlow();
    await startFlow();
    const third = await call('POST', '/api/auth/device', JSONH, '{}');
    expect(third.status).toBe(429);
    expect(third.text).toContain('gonogo auth key add');
    expect((await poll('nonsense')).status).toBe(400);
    expect(JSON.parse((await poll('nonsense')).text)).toEqual({ error: 'expired_token' });
    expect((await call('POST', '/api/auth/device', { ...JSONH, 'content-length': '0' }, 'x'.repeat(5000))).status).toBe(400);
  });

  it('the session of a terminal opens a console socket, may not do what a step-up guards or touch the account, and ends with a revoke or its own logout', async () => {
    const cookies = await bootDevice();
    const flow = await startFlow();
    await decide(cookies, flow.user_code, 'approve');
    dclock += 6000;
    const token = (JSON.parse((await poll(flow.device_code)).text) as { token: string }).token;
    const bearer = { authorization: `Bearer ${token}`, ...JSONH };
    // what a step-up guards: always "do this in the browser", however fresh
    for (const [method, path, body] of [['PUT', '/api/permissions', {}], ['POST', '/api/agents', { name: 'x', command: 'sh' }], ['PUT', '/api/features/relay', {}], ['PUT', '/api/rules', { text: 'x' }], ['POST', '/api/update', {}]] as const) {
      const res = await call(method, path, bearer, JSON.stringify(body));
      expect(res.status, path).toBe(403);
      expect(JSON.parse(res.text)).toMatchObject({ stepUpRequired: true });
      expect(res.text).toContain('do this in the browser');
    }
    // not shell-equivalent routes: a plain hire, a message
    expect((await call('POST', '/api/messages', bearer, '{}')).status).toBe(200);
    expect((await call('POST', '/api/agents', bearer, JSON.stringify({ name: 'x', mode: 'default' }))).status).toBe(200);
    // the account is the browser's
    for (const [method, path] of [['GET', '/api/auth/account'], ['POST', '/api/auth/keys'], ['POST', '/api/auth/password'], ['DELETE', '/api/auth/sessions/abcdef12']] as const) expect((await call(method, path, bearer, method === 'GET' ? undefined : '{}')).status, path).toBe(403);
    // the socket is bound to the session
    const ws = new WebSocket(`ws://127.0.0.1:${sup.port}/ws`, [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + token]);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const view = JSON.parse((await call('GET', '/api/auth/account', cookieHeader(cookies))).text) as { sessions: Array<{ id: string; type: string }> };
    const id = view.sessions.find((s) => s.type === 'tui')?.id as string;
    expect((await call('DELETE', `/api/auth/sessions/${id}`, { ...cookieHeader(cookies), ...origin() })).status).toBe(200);
    await closed;
    expect((await call('GET', '/api/state', bearer)).status).toBe(401);
    // its own logout
    const second = await startFlow();
    await decide(cookies, second.user_code, 'approve');
    dclock += 6000;
    const token2 = (JSON.parse((await poll(second.device_code)).text) as { token: string }).token;
    expect((await call('POST', '/api/auth/logout', { authorization: `Bearer ${token2}`, ...JSONH }, '{}')).status).toBe(200);
    expect((await call('GET', '/api/state', { authorization: `Bearer ${token2}` })).status).toBe(401);
  });
});

describe('no secret in any log', () => {
  it('a full login, a reset and a key creation leave no password, cookie, key, token or session id in the log', async () => {
    const lines: string[] = [];
    const record = (level: string) => (...args: unknown[]): void => void lines.push(`${level} ${args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
    const logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error'), child: () => logger };
    await boot({ log: logger as never });
    const token = sup.directorToken as string;
    const setup = setupToken();
    const cookies = await setUp();
    const login = await call('POST', '/api/auth/login', { ...FORM, ...origin() }, form({ user: 'director', password: PASSWORD }));
    const made = await socketCall(sup.socketPath, 'POST', '/api/auth/keys', { name: 'ci', scope: 'read' });
    await call('POST', '/api/auth/login', { ...FORM, ...origin() }, form({ user: 'director', password: 'a wrong password' }));
    resetAuthFiles(home);
    await new Promise((r) => setTimeout(r, 1100));
    await call('GET', '/api/state', cookieHeader(cookies));
    const secrets = [PASSWORD, 'a wrong password', token, setup, String(made.body.key), cookies['gonogo-session'] as string, cookies['gonogo-device'] as string, login.cookies['gonogo-session'] as string];
    const text = lines.join('\n');
    for (const secret of secrets) expect(text, secret.slice(0, 8)).not.toContain(secret);
    // not the hash of a session either: the id in the file is the only place it is
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).toMatch(/gonogo auth reset/);
  });
});

describe('what stays as it was', () => {
  it('the webhook and docking paths still pass with no login, the agents\' paths stay closed, and a page gets the strict CSP', async () => {
    await boot();
    await setUp();
    expect((await call('POST', '/uplink/u1', { ...JSONH }, '{}')).status).toBe(200);
    expect((await call('POST', '/dock/hello', { ...JSONH }, '{}')).status).toBe(200);
    expect((await call('POST', '/hook/ana/Stop', { ...JSONH }, '{}')).status).toBe(404);
    expect((await call('POST', '/mcp', { ...JSONH }, '{}')).status).toBe(404);
    const page = await call('GET', '/r/main/');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toMatch(/default-src 'self'.*script-src 'self'.*frame-ancestors 'none'/);
    expect(page.headers['x-frame-options']).toBe('DENY');
    // one of each: the room's own header is replaced, not joined
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    // the room list keeps its own policy, and is not served without being asked for
    const list = await call('GET', '/');
    expect(list.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    // 0.5.0's address of the list is moved
    const old = await call('GET', '/rooms?x=1');
    expect([old.status, old.headers.location]).toEqual([308, '/?x=1']);
    // no room can set a cookie on the shared address
    expect((await call('GET', '/r/main/cookie')).setCookie).toEqual([]);
  });
});
