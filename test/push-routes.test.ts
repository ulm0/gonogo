// The push routes of a room and the manifest of the installed app (docs/features/mobile.md), through a real web server with its local
// socket (the door the supervisor uses) and over TCP with the token; and the shell files the build ships for the app.
import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestOf } from '../src/server/manifest.js';
import { createPush } from '../src/server/push.js';
import { createWebServer } from '../src/server/web.js';
import type { WebServer } from '../src/server/web.js';
import { INSTRUMENT } from '../src/shared/livery.js';
import type { Hub, LiveryView, Logger, ServerInfo, TerminalHost } from '../src/shared/protocol.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet } as unknown as Logger;
const TOKEN = 'b'.repeat(64);
let dir: string;
let web: WebServer | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gng-pushr-'));
});
afterEach(async () => {
  await web?.close();
  web = null;
  rmSync(dir, { recursive: true, force: true });
});

const ua = createECDH('prime256v1');
ua.generateKeys();
const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc'): Record<string, unknown> => ({ endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.from('0123456789abcdef').toString('base64url') }, device: 'Phone' });

async function start(extra: Record<string, unknown> = {}): Promise<{ port: number; sock: string; sent: string[] }> {
  const sent: string[] = [];
  const push = createPush({ dir, now: () => 1, fetch: (async (url: URL) => (sent.push(String(url)), new Response(null, { status: 201 }))) as unknown as typeof fetch, log: quiet });
  await push.load();
  const sock = join(dir, 's.sock');
  web = createWebServer({ host: '127.0.0.1', port: 0, browserToken: TOKEN, allowedHosts: [], staticDir: null, hub: {} as Hub, terminals: {} as TerminalHost, resolveToken: () => null, info: () => ({}) as ServerInfo, isReady: () => true, push, localSocket: sock, log: quiet, ...extra });
  return { port: (await web.listen()).port, sock, sent };
}

/** A request on the local socket, with the session header the supervisor would set. */
const viaSocket = (sock: string, method: string, path: string, body?: unknown, session?: string): Promise<{ status: number; json: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath: sock, method, path, headers: { host: '127.0.0.1:1', ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...(session === undefined ? {} : { 'x-gonogo-session': session }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) }));
    });
    req.on('error', reject);
    req.end(text);
  });

describe('the push routes', () => {
  it('subscribe for the session the supervisor names, list the devices, and unsubscribe', async () => {
    const { sock } = await start();
    const none = await viaSocket(sock, 'GET', '/api/push', undefined, 's1');
    expect(none.status).toBe(200);
    expect(Buffer.from(none.json.publicKey as string, 'base64url')).toHaveLength(65);
    const made = await viaSocket(sock, 'PUT', '/api/push/subscription', subscription(), 's1');
    expect(made.status).toBe(200);
    const devices = made.json.devices as Array<{ id: string; mine: boolean; name: string }>;
    expect(devices).toMatchObject([{ name: 'Phone', mine: true }]);
    expect((await viaSocket(sock, 'GET', '/api/push', undefined, 's2')).json.devices).toMatchObject([{ mine: false }]);
    const test = await viaSocket(sock, 'POST', '/api/push/test', { id: devices[0]?.id }, 's1');
    expect(test.json).toEqual({ ok: true, note: 'push service answered 201' });
    const gone = await viaSocket(sock, 'DELETE', '/api/push/subscription', { id: devices[0]?.id }, 's1');
    expect(gone.json.devices).toEqual([]);
  });

  it('refuse a subscription with no session, a bad session header, or an endpoint that is not a vendor push host', async () => {
    const { sock } = await start();
    expect((await viaSocket(sock, 'PUT', '/api/push/subscription', subscription())).status).toBe(403);
    expect((await viaSocket(sock, 'PUT', '/api/push/subscription', subscription(), 'bad session!')).status).toBe(403);
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x']) {
      const res = await viaSocket(sock, 'PUT', '/api/push/subscription', subscription(endpoint), 's1');
      expect([res.status, res.json.field], endpoint).toEqual([400, 'endpoint']);
    }
    expect((await viaSocket(sock, 'GET', '/api/push', undefined, 's1')).json.devices).toEqual([]);
  });

  it('take the session from the socket only: over TCP with the token a header means nothing', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/push/subscription`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'x-gonogo-session': 's1' }, body: JSON.stringify(subscription()) });
    // with a local socket the room accepts no token on TCP at all; either way nothing is stored
    expect([401, 403]).toContain(res.status);
  });

  it('ended: only the socket may say which sessions ended, and their devices go', async () => {
    const { sock } = await start();
    await viaSocket(sock, 'PUT', '/api/push/subscription', subscription('https://fcm.googleapis.com/fcm/send/1'), 's1');
    await viaSocket(sock, 'PUT', '/api/push/subscription', subscription('https://fcm.googleapis.com/fcm/send/2'), 's2');
    expect((await viaSocket(sock, 'POST', '/api/push/ended', { ids: 'nope' })).status).toBe(400);
    expect((await viaSocket(sock, 'POST', '/api/push/ended', { ids: ['s1'] })).status).toBe(204);
    expect((await viaSocket(sock, 'GET', '/api/push', undefined, 's2')).json.devices).toMatchObject([{ mine: true }]);
  });

  it('are 404 without a push store, and a wrong method is 405', async () => {
    const { sock } = await start({ push: undefined });
    expect((await viaSocket(sock, 'GET', '/api/push')).status).toBe(404);
    await web?.close();
    const second = await start();
    expect((await viaSocket(second.sock, 'POST', '/api/push')).status).toBe(405);
  });
});

describe('the manifest', () => {
  it('is the room\'s own: its tab name, its livery\'s body colour, relative addresses, and the three icons', () => {
    expect(manifestOf(null, null)).toMatchObject({ name: 'gonogo', short_name: 'gonogo', display: 'standalone', start_url: './', scope: './', id: './', background_color: INSTRUMENT.tokens['--body'], theme_color: INSTRUMENT.tokens['--body'] });
    const night: LiveryView = { current: 'night', liveries: [{ slug: 'night', name: 'Night', description: '', builtin: false, author: null, tokens: { ...INSTRUMENT.tokens, '--body': 'rgb(16, 20, 24)' } }] } as unknown as LiveryView;
    const m = manifestOf({ name: 'Ops room with a long name', fallback: null }, night);
    expect(m).toMatchObject({ name: 'Ops room with a long name · gonogo', short_name: 'Ops room wit', background_color: '#101418' });
    expect(m.icons.map((i) => [i.src, i.sizes, i.purpose])).toEqual([['icon-192.png', '192x192', 'any'], ['icon-512.png', '512x512', 'any'], ['icon-maskable-512.png', '512x512', 'maskable']]);
    for (const icon of m.icons) expect(icon.src.startsWith('/') || icon.src.includes(':')).toBe(false);
  });

  it('is served with its own type, with no login and no cache, from the static root', async () => {
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    const { port } = await start({ staticDir: dir });
    const res = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    expect([res.status, res.headers.get('content-type'), res.headers.get('cache-control')]).toEqual([200, 'application/manifest+json; charset=utf-8', 'no-cache']);
    expect(((await res.json()) as { name: string }).name).toBe('gonogo');
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
    // the live parts and the other rooms are never kept
    expect(sw).toMatch(/NEVER = \/\^\(api\|ws\|hook\|mcp\|uplink\|dock\|r\|rooms\)/);
    expect(sw).toContain("request.method !== 'GET'");
    expect(sw).toContain("request.headers.has('authorization')");
    // only the hashed assets are cached at run time; no put of anything else
    expect(sw.match(/cache\.put\(/g)).toHaveLength(1);
    expect(sw).toContain("rest.startsWith('assets/')");
    // a notification has no action buttons
    expect(sw).not.toMatch(/actions\s*:/);
    expect(() => new Function(sw)).not.toThrow();
  });
});
