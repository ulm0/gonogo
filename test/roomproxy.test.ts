// The rooms proxy (docs/rooms-spec.md): what it passes, what it swaps, and what it must never carry from one room to another.
// Two fake rooms (an HTTP server and a WebSocket server each) stand behind a real proxy on a real port.
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createRoomProxy } from '../src/server/roomproxy.js';
import { bodyMatters, stepUpReason } from '../src/server/stepup.js';
import { validRoomId } from '../src/server/rooms.js';
import { WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from '../src/shared/protocol.js';

const DIRECTOR = 'd'.repeat(64);
// a room has no token any more: it is reached by its own unix socket (docs/login-spec.md R8). These stand in for the secrets the old model swapped in.
const TOKEN_A = 'a'.repeat(64);
const TOKEN_MAIN = 'c'.repeat(64);
const sockets = mkdtempSync(join(tmpdir(), 'gonogo-proxy-'));

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
interface Fake {
  port: number;
  sock: string;
  seen: Seen[];
  protocols: string[][];
  close(): Promise<void>;
}

async function fakeRoom(name: string): Promise<Fake> {
  const seen: Seen[] = [];
  const protocols: string[][] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'default-src *', 'x-content-type-options': 'nosniff', connection: 'close' });
        return res.end('<p>room</p>');
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/elsewhere' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-room': name, 'set-cookie': 'sid=1; Path=/', connection: 'close' });
      res.end(`room ${name} ${req.method} ${req.url}`);
    });
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false) });
  server.on('upgrade', (req, socket, head) => {
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    protocols.push(offered);
    seen.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers, body: '' });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => ws.send(isBinary ? data : `${name}:${String(data)}`, { binary: isBinary }));
    });
  });
  const sock = join(sockets, `${name}.sock`);
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return {
    // the port the room says it has: only the Host the proxy puts on a request
    port: 41000 + name.length * 100 + (name.codePointAt(0) ?? 0),
    sock,
    seen,
    protocols,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let a: Fake;
let b: Fake;
let main: Fake;
let front: http.Server;
let base: string;
let stoppedRoom = false;
let proxyUnderTest: ReturnType<typeof createRoomProxy>;
let aliveSessions = new Set<string>();
const touched: string[] = [];

/** What the login says about a request: the old Director token is a `token` grant, a cookie `gonogo-session=<id>` a session, `gnk_*` a key. */
const fakeAuth = {
  grant(req: http.IncomingMessage) {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer === DIRECTOR) return { kind: 'token' as const };
    if (bearer === 'gnk_read') return { kind: 'key' as const, scope: 'read' as const };
    if (bearer === 'gnk_full') return { kind: 'key' as const, scope: 'full' as const };
    const cookie = /gonogo-session=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    return cookie !== undefined && aliveSessions.has(cookie) ? { kind: 'session' as const, sessionId: cookie } : null;
  },
  grantUpgrade(req: http.IncomingMessage) {
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '');
    if (protocols.includes(WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR)) return { kind: 'token' as const };
    return fakeAuth.grant(req);
  },
  csrfOk: (req: http.IncomingMessage) => req.method === 'GET' || req.headers.origin !== undefined,
  pageHeaders: () => ({ 'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff' }),
  // session s2 has not been checked for a while: the step-up asks about it
  stepUpBody: bodyMatters,
  stepUpNeeded: (grant: { kind: string; sessionId?: string }, method: string, path: string, body: Record<string, unknown> | null) => (grant.kind === 'session' && grant.sessionId === 's2' ? stepUpReason(method, path, body) : null),
  stepUpDenied: (_req: http.IncomingMessage, res: http.ServerResponse, reason: string) => void res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ stepUp: true, reason })),
  alive: (id: string) => aliveSessions.has(id),
  touchSession: (id: string) => void touched.push(id),
};

beforeEach(async () => {
  a = await fakeRoom('a');
  b = await fakeRoom('b');
  main = await fakeRoom('main');
  stoppedRoom = false;
  aliveSessions = new Set(['s1', 's2']);
  touched.length = 0;
  const proxy = (proxyUnderTest = createRoomProxy({
    auth: fakeAuth,
    allowedNames: new Set(['rooms.example']),
    rooms: () => [
      { id: 'a', port: a.port, socket: a.sock },
      { id: 'b', port: b.port, socket: b.sock },
      { id: 'main', port: main.port, socket: main.sock },
      { id: 'down', port: stoppedRoom ? null : null, socket: join(sockets, 'down.sock') },
    ],
  }));
  front = http.createServer((req, res) => {
    if (!proxy.handle(req, res)) {
      res.writeHead(200);
      res.end('supervisor');
    }
  });
  front.on('upgrade', (req, socket, head) => {
    if (!proxy.upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});
afterEach(async () => {
  proxyUnderTest.close();
  front.closeAllConnections();
  await new Promise<void>((resolve) => front.close(() => resolve()));
  await a.close();
  await b.close();
  await main.close();
});
afterAll(() => rmSync(sockets, { recursive: true, force: true }));

const get = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) => fetch(base + path, { method, headers, body });
const director = { authorization: `Bearer ${DIRECTOR}` };
/** A request exactly as written: fetch tidies a path and will not set Host, and both matter here. */
const raw = (path: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: Number(new URL(base).port), path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.end();
  });

describe('rooms proxy: HTTP', () => {
  it('leaves the supervisor its own reserved paths (the list of rooms is "/"), keeps the root aliases of main, and moves every other GET of the old main to /r/main/', async () => {
    for (const path of ['/', '/?x=1', '/rooms', '/rooms/', '/rooms/health', '/rooms/assets/x.css', '/api/rooms', '/api/rooms/team', '/internal', '/internal/busy', '/internal/x/y']) {
      expect(await (await get(path)).text(), path).toBe('supervisor');
    }
    expect(main.seen).toEqual([]);
    // the aliases: what a script, a webhook, a peer station or the installed app was given keeps reaching main at the root
    expect(await (await get('/api/state', director)).text()).toBe('room main GET /api/state');
    expect(await (await get('/api/roomsx', director)).text()).toBe('room main GET /api/roomsx');
    for (const path of ['/sw.js', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png', '/favicon.svg', '/lockup.svg']) expect(await (await get(path)).text(), path).toBe(`room main GET ${path}`);
    // every other GET or HEAD of the old main is moved: the query stays, the fragment never leaves the browser
    for (const [path, to] of [
      ['/assets/app.js', '/r/main/assets/app.js'],
      ['/index.html?x=1&y=2', '/r/main/index.html?x=1&y=2'],
      ['/roomsx', '/r/main/roomsx'],
      ['/some/page/', '/r/main/some/page/'],
    ] as const) {
      for (const method of ['GET', 'HEAD']) {
        const moved = await fetch(`${base}${path}`, { method, redirect: 'manual' });
        expect([moved.status, moved.headers.get('location')], `${method} ${path}`).toEqual([308, to]);
      }
    }
    // not a page: a change at the old root is not moved, it reaches main as it always did
    expect((await fetch(`${base}/assets/app.js`, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${DIRECTOR}` } })).status).toBe(200);
    expect(main.seen.map((x) => x.url)).toEqual(['/api/state', '/api/roomsx', '/sw.js', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png', '/favicon.svg', '/lockup.svg', '/assets/app.js']);
  });

  it('a redirect never leaves the path it was asked to leave: a dot segment, a double slash, an encoded slash or another host are no redirect', async () => {
    // raw request lines: fetch would tidy these paths before they left
    const raw = (path: string, host?: string): Promise<{ status: number; location: string | undefined }> =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path, method: 'GET', headers: host === undefined ? {} : { host } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, location: res.headers.location });
        });
        req.on('error', reject);
        req.end();
      });
    for (const path of ['/a/../b', '/a/%2e%2e/b', '//evil.test/x', '/a%2fb', '/r', '/r/']) {
      const res = await raw(path);
      expect(res.status === 308 ? res.location : null, path).toBeNull();
    }
    expect((await raw('/x', 'evil.test')).status).toBe(403);
    // the alias is decided on the decoded path: these are /api/x, /sw.js and /r/main/..., never a page of the old main
    for (const path of ['/%61pi/x', '/%73w.js', '/%75plink/u1', '/%72/main/x']) {
      const res = await raw(path);
      expect(res.status === 308 ? res.location : null, path).toBeNull();
    }
  });

  it('main answers the same at / and at /r/main/, and the room sees no Authorization at either', async () => {
    const one = await (await get('/api/state', director)).text();
    const two = await (await get('/r/main/api/state', director)).text();
    expect(one.replace('GET /api', 'GET /api')).toBe('room main GET /api/state');
    expect(two).toBe('room main GET /api/state');
    for (const seen of main.seen) expect(seen.headers.authorization).toBeUndefined();
    expect(JSON.stringify(main.seen)).not.toContain(DIRECTOR);
    expect((await get('/api/state')).status).toBe(401);
    expect((await get('/api/state', { authorization: `Bearer ${TOKEN_MAIN}` })).status).toBe(401);
    expect(main.seen).toHaveLength(2);
  });

  it('keeps the agents\' routes closed at the root too, in any case, and passes webhooks and docks without Authorization', async () => {
    for (const path of ['/hook/ana/Stop', '/hook/', '/mcp', '/mcp?x=1', '/Hook/ana/Stop', '/MCP', '/r/main/Hook/x', '/%68ook/ana/Stop', '/%48OOK/x', '/%6dcp', '/%6Dcp/x', '/r/a/%68ook/ana/Stop', '/r/main/%6dcp']) expect((await get(path, director, 'POST', '{}')).status, path).toBe(404);
    expect((await get('/uplink/u1', director, 'POST', '{}')).status).toBe(200);
    expect((await get('/dock/hello', director, 'POST', '{}')).status).toBe(200);
    expect(main.seen.map((x) => x.headers.authorization)).toEqual([undefined, undefined]);
    expect(main.seen.map((x) => x.url)).toEqual(['/uplink/u1', '/dock/hello']);
  });

  it('R1: the route the rooms offer each other Telegram updates on is closed to the browser side, whatever the case, encoding or query, at the root and under a room', async () => {
    for (const path of ['/api/telegram/route', '/Api/Telegram/Route', '/api/%74elegram/route', '/%61pi/telegram/route', '/api/telegram/route?x=1', '/api/telegram/route/', '/api/telegram/anything', '/r/main/api/telegram/route']) {
      expect((await get(path, director, 'POST', '{}')).status, path).toBe(404);
    }
    expect(main.seen).toHaveLength(0);
  });

  it('S1: a reserved name cannot be reached or hidden by encoding, case, empty segments or dots: decoded once, same text for both checks', async () => {
    // refused (400) or the supervisor's own: never main
    for (const path of ['/%72ooms', '/%72ooms/health', '/%69nternal/busy', '/api/%72ooms', '//internal/busy', '/internal//busy', '/rooms//health', '/internal/../api/state', '/./internal', '/r%2Fmain/x', '/%2e%2e/rooms', '/a/%2e%2e/b', '/x%5cy', '/x%00y', '/%']) {
      const status = await raw(path, director);
      expect([200, 400, 404], path).toContain(status);
    }
    expect(main.seen).toEqual([]);
    // case is exact: /Rooms is not reserved, so it is main's (its own 404 to give)
    expect(await (await get('/Rooms')).text()).toBe('room main GET /Rooms');
    expect(main.seen.map((x) => x.url)).toEqual(['/Rooms']);
    // the reserved ones that were decoded answer as the supervisor
    expect(await raw('/%72ooms/health', {})).toBe(200);
  });

  it('S2: no Set-Cookie from any room, at / or under /r/<id>/; a redirect of a room gets its /r/<id> prefix (main too)', async () => {
    for (const path of ['/api/cookie', '/r/a/cookie', '/r/main/cookie']) {
      const res = await get(path, director);
      expect(res.headers.get('set-cookie'), path).toBeNull();
      expect(res.headers.get('x-room')).not.toBeNull();
    }
    // main at the old root is moved, not proxied; a redirect of the room itself keeps the room's prefix
    const here = await fetch(`${base}/redirect`, { redirect: 'manual' });
    expect([here.status, here.headers.get('location')]).toEqual([308, '/r/main/redirect']);
    const there = await fetch(`${base}/r/a/redirect`, { redirect: 'manual' });
    expect(there.headers.get('location')).toBe('/r/a/elsewhere');
    const viaMain = await fetch(`${base}/r/main/redirect`, { redirect: 'manual' });
    expect(viaMain.headers.get('location')).toBe('/r/main/elsewhere');
  });

  it('strips the prefix, passes method, query and body, and answers with the room\'s status and headers', async () => {
    const res = await get('/r/a/api/state?x=1', director, 'POST', '{"go":true}');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-room')).toBe('a');
    expect(await res.text()).toBe('room a POST /api/state?x=1');
    expect(a.seen[0]).toMatchObject({ method: 'POST', url: '/api/state?x=1', body: '{"go":true}' });
    expect(b.seen).toEqual([]);
  });

  it('never forwards a credential of the browser: the room is reached by its socket and sees no Authorization', async () => {
    await get('/r/a/api/state', director);
    await get('/r/b/api/state', director);
    for (const seen of [...a.seen, ...b.seen]) {
      expect(JSON.stringify(seen)).not.toContain(DIRECTOR);
      expect(seen.headers.authorization).toBeUndefined();
    }
  });

  it('refuses an API call without the Director token, and with a room\'s own token or a wrong one', async () => {
    expect((await get('/r/a/api/state')).status).toBe(401);
    expect((await get('/r/a/api/state', { authorization: `Bearer ${TOKEN_A}` })).status).toBe(401);
    expect((await get('/r/a/api/state', { authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401);
    expect((await get('/r/a/api/state', { authorization: 'Basic abc' })).status).toBe(401);
    expect((await get('/r/a/api/x', {}, 'DELETE')).status).toBe(401);
    expect(a.seen).toEqual([]);
  });

  it('lets the page and its assets through without a token, and without any Authorization header', async () => {
    const res = await get('/r/a/assets/app.js', { authorization: `Bearer ${TOKEN_A}`, cookie: 'k=v' });
    expect(res.status).toBe(200);
    expect(a.seen[0]?.headers.authorization).toBeUndefined();
    expect(a.seen[0]?.headers.cookie).toBeUndefined();
    expect((await get('/r/a/')).status).toBe(200);
    expect(a.seen[1]?.url).toBe('/');
  });

  it('drops cookies, forwarded headers and a foreign Authorization from what the room sees', async () => {
    await get('/r/a/api/state', { ...director, cookie: 'session=1', 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4' });
    const headers = a.seen[0]?.headers ?? {};
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers.forwarded).toBeUndefined();
    expect(headers.host).toBe(`127.0.0.1:${a.port}`);
  });

  it('passes webhooks and docking calls with no Authorization, and keeps the agents\' routes closed', async () => {
    const hook = await get('/r/a/uplink/u1', { ...director, 'x-signature': 'sig' }, 'POST', '{}');
    expect(hook.status).toBe(200);
    expect(a.seen[0]?.headers.authorization).toBeUndefined();
    expect(a.seen[0]?.headers['x-signature']).toBe('sig');
    expect((await get('/r/a/dock/hello', {}, 'POST', '{}')).status).toBe(200);
    for (const path of ['/r/a/hook/ana/Stop', '/r/a/mcp', '/r/a/mcp/x', '/r/a/%68ook/ana/Stop', '/r/a/%6Dcp', '/r/a/api/telegram/route', '/r/a/Api/%54elegram/route?x=1']) {
      expect((await get(path, director, 'POST', '{}')).status, path).toBe(404);
    }
    expect(a.seen).toHaveLength(2);
  });

  it('answers 404 for an unknown room, a bad id, and ids that try to leave; 400 for a path that tries to leave the room', async () => {
    expect((await get('/r/nope/api/state', director)).status).toBe(404);
    for (const id of ['A', '1x', 'a.b', '..', '%2e%2e', 'a%2fb', 'a%00']) expect(await raw(`/r/${id}/api/state`, director), id).toBe(404);
    for (const path of ['/r/a/../b/api/state', '/r/a/api/..%2fx', '/r/a/%2e%2e/api', '/r/a/api%5cx', '/r/a/a%00b', '/r/a/api/%2E%2E/x']) {
      expect([400, 404], path).toContain(await raw(path, director));
    }
    expect(a.seen).toEqual([]);
    expect(b.seen).toEqual([]);
  });

  it('503 for a room that is not running; the slash is added to /r/<id>', async () => {
    expect((await get('/r/down/', director)).status).toBe(503);
    const res = await fetch(`${base}/r/a?x=1`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/r/a/?x=1');
  });

  it('keeps a redirect of the room inside its prefix', async () => {
    const res = await fetch(`${base}/r/a/redirect`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/r/a/elsewhere');
  });

  it('checks Host and Origin like a room does, and rewrites the Origin to the room', async () => {
    expect(await raw('/r/a/api/state', { ...director, host: 'evil.example' })).toBe(403);
    expect(await raw('/r/a/api/state', { ...director, host: 'rooms.example', origin: 'http://evil.example' })).toBe(403);
    expect(await raw('/r/a/api/state', { ...director, host: 'rooms.example', origin: 'http://rooms.example' })).toBe(200);
    expect(a.seen.at(-1)?.headers.origin).toBe(`http://127.0.0.1:${a.port}`);
    expect(a.seen.at(-1)?.headers.host).toBe(`127.0.0.1:${a.port}`);
  });
});

describe('rooms proxy: WebSocket', () => {
  const open = (path: string, protocols: string[]): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}${path}`, protocols);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    });

  it('relays text and binary frames both ways, and the room is offered no token in the subprotocol', async () => {
    const ws = await open('/r/a/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    expect(ws.protocol).toBe(WS_SUBPROTOCOL);
    const got: Array<string | Buffer> = [];
    ws.on('message', (data, isBinary) => got.push(isBinary ? (data as Buffer) : String(data)));
    ws.send('hello');
    ws.send(Buffer.from([0, 1, 2, 255]), { binary: true });
    await vi_waitFor(() => got.length === 2);
    expect(got[0]).toBe('a:hello');
    expect([...(got[1] as Buffer)]).toEqual([0, 1, 2, 255]);
    expect(a.protocols[0]).toEqual([WS_SUBPROTOCOL]);
    expect(JSON.stringify(a.seen)).not.toContain(DIRECTOR);
    expect(b.seen).toEqual([]);
    ws.close();
  });

  it('two sockets go to their own rooms', async () => {
    const one = await open('/r/a/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    const two = await open('/r/b/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    const got: string[] = [];
    one.on('message', (d) => got.push(String(d)));
    two.on('message', (d) => got.push(String(d)));
    one.send('x');
    two.send('y');
    await vi_waitFor(() => got.length === 2);
    expect(got.sort()).toEqual(['a:x', 'b:y']);
    expect(a.protocols[0]?.join()).not.toContain(DIRECTOR);
    expect(b.protocols[0]?.join()).not.toContain(DIRECTOR);
    one.close();
    two.close();
  });

  it('refuses without the Director token, with a room token, to another path, to the agents\' paths, and for a missing room', async () => {
    await expect(open('/r/a/ws', [WS_SUBPROTOCOL])).rejects.toThrow(/401/);
    await expect(open('/r/a/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + TOKEN_A])).rejects.toThrow(/401/);
    await expect(open('/r/a/api/state', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR])).rejects.toThrow(/404/);
    await expect(open('/r/a/mcp', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR])).rejects.toThrow(/404/);
    await expect(open('/r/zz/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR])).rejects.toThrow(/404/);
    await expect(open('/r/down/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR])).rejects.toThrow(/503/);
    expect(a.seen).toEqual([]);
  });

  it('closeSockets ends every open socket (the Director token changed), and the page may open a new one', async () => {
    const one = await open('/r/a/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    const two = await open('/r/b/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    const closed = Promise.all([one, two].map((ws) => new Promise<void>((resolve) => ws.once('close', () => resolve()))));
    proxyUnderTest.closeSockets();
    await closed;
    const again = await open('/r/a/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    again.close();
  });

  it('closing one side closes the other', async () => {
    const ws = await open('/r/a/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await a.close();
    await closed;
  });
});

describe('rooms proxy: the login', () => {
  const session = { cookie: 'gonogo-session=s1' };
  const origin = { origin: 'http://127.0.0.1' };
  const withOrigin = (): Record<string, string> => ({ ...session, origin: base, host: new URL(base).host });

  it('a session cookie opens the API; a change needs an Origin that is this server (CSRF), a read does not', async () => {
    expect((await get('/api/state', session)).status).toBe(200);
    expect((await get('/api/messages', session, 'POST', '{}')).status).toBe(403);
    expect((await get('/api/messages', { ...session, ...origin }, 'POST', '{}')).status, 'a foreign Origin').toBe(403);
    expect((await get('/api/messages', withOrigin(), 'POST', '{}')).status).toBe(200);
    // an unknown or revoked session is nobody
    aliveSessions.delete('s1');
    expect((await get('/api/state', session)).status).toBe(401);
  });

  it('B1: an encoded name does not skip the login: every decision is made on the decoded path, and the room is sent the path built again from it', async () => {
    for (const path of ['/%61pi/state', '/%41PI/state', '/API/state', '/r/a/%61pi/state', '/r/main/%61%70i/state', '/api%2Fstate', '/%77s', '/%57S', '/r/a/%77s', '/%61pi/%73tate?x=1']) {
      const status = (await get(path)).status;
      expect([400, 401, 404], path).toContain(status);
    }
    expect(a.seen).toEqual([]);
    expect(main.seen).toEqual([]);
    // with a login the room sees the ordinary spelling, not the one that was sent
    expect((await get('/%61pi/%73tate?x=1', session)).status).toBe(200);
    expect(main.seen.at(-1)?.url).toBe('/api/state?x=1');
    expect((await get('/r/a/%61pi/state', session)).status).toBe(200);
    expect(a.seen.at(-1)?.url).toBe('/api/state');
    // a key is held to its scope on the decoded path too
    for (const path of ['/api/%74erminal/x', '/%61pi/%74erminal/x', '/api/%63learance', '/api/%6beys']) expect((await get(path, { authorization: 'Bearer gnk_read' })).status, path).toBe(403);
    expect((await get('/api/%6dessages', { authorization: 'Bearer gnk_read' }, 'POST', '{}')).status).toBe(403);
    expect((await get('/%61pi/%6dessages', { authorization: 'Bearer gnk_act' }, 'POST', '{}')).status).toBe(401);
  });

  it('the page and its assets need no login and no cookie reaches the room', async () => {
    expect((await get('/assets/app.js', session)).status).toBe(200);
    expect(main.seen.at(-1)?.headers.cookie).toBeUndefined();
    expect(main.seen.at(-1)?.headers.authorization).toBeUndefined();
  });

  it('holds a key to its scope: read reads, full does the rest, neither reaches /api/auth', async () => {
    expect((await get('/api/state', { authorization: 'Bearer gnk_read' })).status).toBe(200);
    expect((await get('/api/messages', { authorization: 'Bearer gnk_read' }, 'POST', '{}')).status).toBe(403);
    expect((await get('/api/messages', { authorization: 'Bearer gnk_full' }, 'POST', '{}')).status).toBe(200);
    expect((await get('/api/terminal/x', { authorization: 'Bearer gnk_read' })).status).toBe(403);
    // a key is not a cookie: no Origin is asked of it
    expect((await get('/api/agents/ana/hold', { authorization: 'Bearer gnk_full' }, 'POST', '{}')).status).toBe(200);
  });

  it('puts its own CSP on a page of a room, whatever the room said', async () => {
    const res = await get('/page');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    // replaced, not joined: one nosniff, not "nosniff, nosniff"
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('<p>room</p>');
    // not on an answer that is not a page
    expect((await get('/api/state', director)).headers.get('content-security-policy')).toBeNull();
  });

  it('step-up: a session not checked for five minutes is asked again for the listed changes, the body decides a hire and an edit, and what is not listed passes', async () => {
    const stale = { cookie: 'gonogo-session=s2', origin: base, host: new URL(base).host, 'content-type': 'application/json' };
    const fresh = { ...stale, cookie: 'gonogo-session=s1' };
    const send = (headers: Record<string, string>, method: string, path: string, body: unknown) => get(path, headers, method, JSON.stringify(body));
    // a hire with a command of its own, or an unattended mode, and an edit of mode, command or role
    expect((await send(stale, 'POST', '/api/agents', { name: 'x', command: 'sh' })).status).toBe(403);
    expect((await send(stale, 'POST', '/api/agents', { name: 'x', mode: 'bypassPermissions' })).status).toBe(403);
    expect((await send(stale, 'POST', '/api/agents', { name: 'x', mode: 'default' })).status).toBe(200);
    expect((await send(stale, 'PATCH', '/api/agents/ana', { role: 'new role' })).status).toBe(403);
    expect((await send(stale, 'PATCH', '/api/agents/ana', { model: 'x' })).status).toBe(200);
    // the edit is an allow-list: a folder, the Clean Room, a worktree, remote control and keys all ask
    for (const body of [{ cleanRoom: false }, { dir: '/' }, { confirmBypass: true }, { worktree: true }, { remoteControl: true }, { keys: { K: 'v' } }]) expect((await send(stale, 'PATCH', '/api/agents/ana', body)).status, JSON.stringify(body)).toBe(403);
    expect((await send(stale, 'POST', '/api/agents', { name: 'x', cleanRoom: false })).status).toBe(403);
    // the body that went through reached the room whole
    expect(main.seen.filter((x) => x.method === 'PATCH').at(-1)?.body).toBe('{"model":"x"}');
    for (const [method, path] of [['PUT', '/api/permissions'], ['PUT', '/api/payload-defaults/servers/x'], ['PUT', '/api/features/relay'], ['POST', '/api/uplinks'], ['PUT', '/api/relay'], ['POST', '/api/docking/pair'], ['PUT', '/api/agents/ana/file'], ['POST', '/api/agents/ana/git/commit'], ['POST', '/api/update'], ['PUT', '/api/engines/claude']] as const) expect((await send(stale, method, path, {})).status, `${method} ${path}`).toBe(403);
    // auto-update: turning it on or moving its window asks (the body decides); turning it off and skipping a version do not
    expect((await send(stale, 'PUT', '/api/autoupdate', { enabled: true })).status).toBe(403);
    expect((await send(stale, 'PUT', '/api/autoupdate', { windows: [{ from: '01:00', to: '02:00' }] })).status).toBe(403);
    expect((await send(stale, 'PUT', '/api/autoupdate', { enabled: false })).status).toBe(200);
    expect((await send(stale, 'POST', '/api/autoupdate/skip', { version: '0.6.3' })).status).toBe(200);
    expect((await send(fresh, 'PUT', '/api/autoupdate', { enabled: true })).status).toBe(200);
    for (const path of ['/api/%61utoupdate', '/%61pi/autoupdate', '/r/a/api/autoupdat%65']) expect((await send(stale, 'PUT', path, { enabled: true })).status, path).toBe(403);
    // an encoded spelling of a listed route is the same route
    for (const path of ['/api/%70ermissions', '/%61pi/permissions', '/r/a/api/%66eatures/relay']) expect((await send(stale, 'PUT', path, {})).status, path).toBe(403);
    // shell-equivalent already, and not behind it: a message, an answer, hold, resume, restart, a fresh session for all of it
    for (const [method, path] of [['POST', '/api/messages'], ['POST', '/api/agents/ana/answer'], ['POST', '/api/agents/ana/hold'], ['POST', '/api/agents/ana/restart']] as const) expect((await send(stale, method, path, {})).status, `${method} ${path}`).toBe(200);
    expect((await send(fresh, 'POST', '/api/agents', { name: 'x', command: 'sh' })).status).toBe(200);
    expect((await send(fresh, 'PUT', '/api/permissions', {})).status).toBe(200);
    // a read is never asked about
    expect((await get('/api/permissions', { cookie: 'gonogo-session=s2' })).status).toBe(200);
    // and a key or the old token is not a session: the check is the session's
    expect((await send({ authorization: 'Bearer gnk_full', 'content-type': 'application/json' }, 'PUT', '/api/permissions', {})).status).toBe(200);
  });

  const openAs = (path: string, headers: Record<string, string>, protocols: string[] = [WS_SUBPROTOCOL]): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}${path}`, protocols, { headers });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    });

  it('rebind: a session whose id was minted again keeps its socket, now bound to the new id', async () => {
    const ws = await openAs('/ws', { ...session, origin: base });
    proxyUnderTest.rebind('s1', 's9');
    proxyUnderTest.closeSessions(['s1']);
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    // and its input counts for the NEW id, not the dead one
    touched.length = 0;
    ws.send('type');
    await vi_waitFor(() => touched.length > 0);
    expect(touched).toEqual(['s9']);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    proxyUnderTest.closeSessions(['s9']);
    await closed;
  });

  it('a cookie opens a socket only from a page (Origin), and the socket is bound to its session', async () => {
    await expect(openAs('/ws', session)).rejects.toThrow(/403/);
    await expect(openAs('/ws', {})).rejects.toThrow(/401/);
    const ws = await openAs('/ws', { ...session, origin: base });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    // another session's end leaves it alone; its own ends it
    proxyUnderTest.closeSessions(['s2']);
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    proxyUnderTest.closeSessions(['s1']);
    await closed;
  });

  it('input to a socket counts as use of the session, a pong does not', async () => {
    const ws = await openAs('/ws', { ...session, origin: base });
    ws.send('type');
    await vi_waitFor(() => touched.length > 0);
    expect(touched).toContain('s1');
    touched.length = 0;
    ws.pong();
    await new Promise((r) => setTimeout(r, 100));
    expect(touched).toEqual([]);
    ws.close();
  });

  it('a key opens a socket by the subprotocol, with no Origin asked and no session to bind', async () => {
    aliveSessions.clear();
    const ws = await openAs('/ws', {}, [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    proxyUnderTest.closeSessions(['s1']);
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('room ids', () => {
  it('are lower case, start with a letter and carry nothing a path could use', () => {
    for (const id of ['a', 'main', 'team-2', 'x'.repeat(24)]) expect(validRoomId(id), id).toBe(true);
    for (const id of ['', 'A', '1', '-a', 'a_b', 'a.b', 'a/b', '..', 'x'.repeat(25), 'é', 'a b', undefined, 5]) expect(validRoomId(id), String(id)).toBe(false);
  });
});

async function vi_waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
