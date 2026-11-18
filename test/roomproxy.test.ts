// The rooms proxy (docs/rooms-spec.md): what it passes, what it swaps, and what it must never carry from one room to another.
// Two fake rooms (an HTTP server and a WebSocket server each) stand behind a real proxy on a real port.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createRoomProxy } from '../src/server/roomproxy.js';
import { validRoomId } from '../src/server/rooms.js';
import { WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from '../src/shared/protocol.js';

const DIRECTOR = 'd'.repeat(64);
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
interface Fake {
  port: number;
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
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/elsewhere' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-room': name, connection: 'close' });
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
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
let front: http.Server;
let base: string;
let stoppedRoom = false;

beforeEach(async () => {
  a = await fakeRoom('a');
  b = await fakeRoom('b');
  stoppedRoom = false;
  const proxy = createRoomProxy({
    directorToken: DIRECTOR,
    allowedNames: new Set(['rooms.example']),
    rooms: () => [
      { id: 'a', port: a.port, token: TOKEN_A },
      { id: 'b', port: b.port, token: TOKEN_B },
      { id: 'down', port: stoppedRoom ? null : null, token: null },
    ],
  });
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
  front.closeAllConnections();
  await new Promise<void>((resolve) => front.close(() => resolve()));
  await a.close();
  await b.close();
});

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
  it('leaves the supervisor its own paths', async () => {
    expect(await (await get('/')).text()).toBe('supervisor');
  });

  it('strips the prefix, passes method, query and body, and answers with the room\'s status and headers', async () => {
    const res = await get('/r/a/api/state?x=1', director, 'POST', '{"go":true}');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-room')).toBe('a');
    expect(await res.text()).toBe('room a POST /api/state?x=1');
    expect(a.seen[0]).toMatchObject({ method: 'POST', url: '/api/state?x=1', body: '{"go":true}' });
    expect(b.seen).toEqual([]);
  });

  it('swaps the Director token for the room\'s own, and never forwards the Director token', async () => {
    await get('/r/a/api/state', director);
    await get('/r/b/api/state', director);
    expect(a.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(b.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN_B}`);
    for (const seen of [...a.seen, ...b.seen]) expect(JSON.stringify(seen)).not.toContain(DIRECTOR);
    // a room's token is never in what the other room saw
    expect(JSON.stringify(a.seen)).not.toContain(TOKEN_B);
    expect(JSON.stringify(b.seen)).not.toContain(TOKEN_A);
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
    for (const path of ['/r/a/hook/ana/Stop', '/r/a/mcp', '/r/a/mcp/x']) {
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

  it('relays text and binary frames both ways, and swaps the token in the subprotocol', async () => {
    const ws = await open('/r/a/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    expect(ws.protocol).toBe(WS_SUBPROTOCOL);
    const got: Array<string | Buffer> = [];
    ws.on('message', (data, isBinary) => got.push(isBinary ? (data as Buffer) : String(data)));
    ws.send('hello');
    ws.send(Buffer.from([0, 1, 2, 255]), { binary: true });
    await vi_waitFor(() => got.length === 2);
    expect(got[0]).toBe('a:hello');
    expect([...(got[1] as Buffer)]).toEqual([0, 1, 2, 255]);
    expect(a.protocols[0]).toEqual([WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + TOKEN_A]);
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
    expect(a.protocols[0]?.join()).toContain(TOKEN_A);
    expect(b.protocols[0]?.join()).toContain(TOKEN_B);
    expect(a.protocols[0]?.join()).not.toContain(TOKEN_B);
    expect(b.protocols[0]?.join()).not.toContain(TOKEN_A);
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

  it('closing one side closes the other', async () => {
    const ws = await open('/r/a/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + DIRECTOR]);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await a.close();
    await closed;
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
