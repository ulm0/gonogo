// The push routes of the supervisor (src/server/pushhttp.ts) behind a stand-in for its login, the manifest of the installed app, and the
// files the build ships for it. The login itself (a session, a key, the token) is the supervisor's and is tried in rooms.test.ts.
import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestOf } from '../src/server/manifest.js';
import { createPush } from '../src/server/push.js';
import type { Push } from '../src/server/push.js';
import { isPushPath, pushApi } from '../src/server/pushhttp.js';
import { createWebServer } from '../src/server/web.js';
import type { WebServer } from '../src/server/web.js';
import { INSTRUMENT } from '../src/shared/livery.js';
import type { Hub, LiveryView, Logger, ServerInfo, TerminalHost } from '../src/shared/protocol.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet } as unknown as Logger;
let dir: string;
let front: http.Server | null = null;
let web: WebServer | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gng-pushr-'));
});
afterEach(async () => {
  front?.closeAllConnections();
  await new Promise<void>((r) => (front ? front.close(() => r()) : r()));
  front = null;
  await web?.close();
  web = null;
  rmSync(dir, { recursive: true, force: true });
});

const ua = createECDH('prime256v1');
ua.generateKeys();
const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc'): Record<string, unknown> => ({ endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.from('0123456789abcdef').toString('base64url') }, device: 'Phone' });

/** A server that answers the push routes the way the supervisor does, with the session named by the `x-test-session` header standing in for the login. */
async function start(): Promise<{ base: string; push: Push; sent: string[] }> {
  const sent: string[] = [];
  const push = createPush({ dir, now: () => 1, fetch: (async (url: URL) => (sent.push(String(url)), new Response(null, { status: 201 }))) as unknown as typeof fetch, log: quiet });
  await push.load();
  front = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (!isPushPath(path)) return void res.writeHead(404).end();
    const session = req.headers['x-test-session'];
    void pushApi(push, req, res, path, typeof session === 'string' ? session : null);
  });
  await new Promise<void>((r) => front?.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(front?.address() as AddressInfo).port}`, push, sent };
}

const call = async (base: string, method: string, path: string, body?: unknown, session?: string): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session === undefined ? {} : { 'x-test-session': session }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
};

describe('the push routes', () => {
  it('know their own paths and no others', () => {
    for (const path of ['/api/push', '/api/push/subscription', '/api/push/test']) expect(isPushPath(path), path).toBe(true);
    for (const path of ['/api/push/', '/api/push/x', '/api/pushx', '/api/rooms', '/api/push/subscription/1', '/push']) expect(isPushPath(path), path).toBe(false);
  });

  it('subscribe for the session of the login, list the devices, test one and unsubscribe', async () => {
    const { base } = await start();
    const none = await call(base, 'GET', '/api/push', undefined, 's1');
    expect(none.status).toBe(200);
    expect(Buffer.from(none.json.publicKey as string, 'base64url')).toHaveLength(65);
    const made = await call(base, 'PUT', '/api/push/subscription', subscription(), 's1');
    expect(made.status).toBe(200);
    const devices = made.json.devices as Array<{ id: string; mine: boolean; name: string }>;
    expect(devices).toMatchObject([{ name: 'Phone', mine: true }]);
    expect((await call(base, 'GET', '/api/push', undefined, 's2')).json.devices).toMatchObject([{ mine: false }]);
    expect((await call(base, 'POST', '/api/push/test', { id: devices[0]?.id }, 's1')).json).toEqual({ ok: true, note: 'push service answered 201' });
    expect((await call(base, 'DELETE', '/api/push/subscription', { id: devices[0]?.id }, 's1')).json.devices).toEqual([]);
  });

  it('refuse a subscription from a caller with no session (a key, the old token, the local socket), and an endpoint that is not a vendor push host', async () => {
    const { base, sent } = await start();
    expect((await call(base, 'PUT', '/api/push/subscription', subscription())).status).toBe(403);
    expect((await call(base, 'POST', '/api/push/test', { id: 'x' })).status).toBe(403);
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x']) {
      const res = await call(base, 'PUT', '/api/push/subscription', subscription(endpoint), 's1');
      expect([res.status, res.json.field], endpoint).toEqual([400, 'endpoint']);
    }
    expect((await call(base, 'GET', '/api/push', undefined, 's1')).json.devices).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('answer a wrong method with 405 and its Allow, a body that is not JSON with 400, and a missing device with 404', async () => {
    const { base } = await start();
    const wrong = await fetch(`${base}/api/push`, { method: 'POST', headers: { 'x-test-session': 's1', 'content-type': 'application/json' }, body: '{}' });
    expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, 'GET']);
    expect((await fetch(`${base}/api/push/subscription`, { method: 'PUT', headers: { 'x-test-session': 's1' }, body: '{}' })).status).toBe(400);
    expect((await fetch(`${base}/api/push/subscription`, { method: 'PUT', headers: { 'x-test-session': 's1', 'content-type': 'application/json' }, body: '[1]' })).status).toBe(400);
    expect((await fetch(`${base}/api/push/subscription`, { method: 'PUT', headers: { 'x-test-session': 's1', 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(5000) }) })).status).toBe(400);
    expect((await call(base, 'DELETE', '/api/push/subscription', { id: 'nope' }, 's1')).status).toBe(404);
  });
});

describe('the manifest', () => {
  it('is one app for every room: the root as scope and start, absolute addresses, the livery\'s colour, the three icons', () => {
    expect(manifestOf(null)).toMatchObject({ name: 'gonogo', display: 'standalone', start_url: '/', scope: '/', id: '/', background_color: INSTRUMENT.tokens['--body'], theme_color: INSTRUMENT.tokens['--body'] });
    const night: LiveryView = { current: 'night', liveries: [{ slug: 'night', name: 'Night', description: '', builtin: false, author: null, tokens: { ...INSTRUMENT.tokens, '--body': 'rgb(16, 20, 24)' } }] } as unknown as LiveryView;
    const m = manifestOf(night);
    expect(m).toMatchObject({ background_color: '#101418', theme_color: '#101418' });
    expect(m.icons.map((i) => [i.src, i.sizes, i.purpose])).toEqual([['/icon-192.png', '192x192', 'any'], ['/icon-512.png', '512x512', 'any'], ['/icon-maskable-512.png', '512x512', 'maskable']]);
  });

  it('is served by a room with its own type, with no login and no cache', async () => {
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    web = createWebServer({ host: '127.0.0.1', port: 0, browserToken: 'b'.repeat(64), allowedHosts: [], staticDir: dir, hub: {} as Hub, terminals: {} as TerminalHost, resolveToken: () => null, info: () => ({}) as ServerInfo, isReady: () => true, log: quiet });
    const { port } = await web.listen();
    const res = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    expect([res.status, res.headers.get('content-type'), res.headers.get('cache-control')]).toEqual([200, 'application/manifest+json; charset=utf-8', 'no-cache']);
    expect(((await res.json()) as { scope: string }).scope).toBe('/');
  });
});

describe('the files the build ships for the app', () => {
  const root = new URL('../public/', import.meta.url);
  const png = (name: string): Buffer => readFileSync(new URL(name, root));

  it('has the icons at the sizes the manifest names', () => {
    for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]] as const) {
      const b = png(name);
      expect([b.subarray(1, 4).toString(), b.readUInt32BE(16), b.readUInt32BE(20)], name).toEqual(['PNG', size, size]);
    }
  });

  it('has a service worker that keeps the shell only, and shows a push with nothing to approve', () => {
    const sw = readFileSync(new URL('sw.js', root), 'utf8');
    // the live parts, the login, the other rooms and the list of rooms are never kept
    expect(sw).toMatch(/NEVER = \/\^\(api\|ws\|hook\|mcp\|uplink\|dock\|r\|rooms\|login\|setup\|internal\)/);
    expect(sw).toContain("request.method !== 'GET'");
    expect(sw).toContain("request.headers.has('authorization')");
    // only the hashed assets are cached at run time; no put of anything else
    expect(sw.match(/cache\.put\(/g)).toHaveLength(1);
    expect(sw).toContain("local.startsWith('assets/')");
    // a notification has no action buttons
    expect(sw).not.toMatch(/actions\s*:/);
    expect(() => new Function(sw)).not.toThrow();
  });
});
