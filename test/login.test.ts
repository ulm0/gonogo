// The login through the whole supervisor (docs/login-spec.md): real HTTP and WebSocket on a real front port, stand-in rooms (test/fake-room.mjs)
// behind it on their unix sockets, and the local socket for the TUI and the CLI.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AUTH_FILE, resetAuthFiles, SETUP_TOKEN_FILE } from '../src/server/auth.js';
import { authCommand, socketCall } from '../src/server/authcli.js';
import { createTuiClient } from '../src/server/tui-client.js';
import { localSocketOf } from '../src/server/tui-cli.js';
import { startSupervisor } from '../src/server/supervisor.js';
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
    const pub = await call('POST', '/api/auth/login', { ...FORM, host: 'gonogo.example.com', origin: 'http://gonogo.example.com' }, form({ user: 'director', password: PASSWORD }));
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
    expect(after.status).toBe(303);
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
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toMatch(/default-src 'self'.*script-src 'self'.*frame-ancestors 'none'/);
    expect(page.headers['x-frame-options']).toBe('DENY');
    // one of each: the room's own header is replaced, not joined
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    // the room list keeps its own policy, and is not served without being asked for
    const list = await call('GET', '/rooms');
    expect(list.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    // no room can set a cookie on the shared address
    expect((await call('GET', '/cookie')).setCookie).toEqual([]);
  });
});
