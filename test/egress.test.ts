import http, { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/shared/protocol.js';
import { createEgress, EGRESS_CONCURRENT_MAX, publicAddress } from '../src/server/egress.js';
import type { Egress } from '../src/server/egress.js';
import { createEgressSettings } from '../src/server/egresssettings.js';

// Egress (src/server/egress.ts): the reverse proxy for api.anthropic.com. A fake upstream on 127.0.0.1 stands for Anthropic; the proxy is told to allow that one address.

const REAL = 'sk-ant-api03-the-real-key-REAL';
const PLACEHOLDER = 'gnp_0123456789abcdef0123456789abcdef';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let upstream: Server;
let upstreamPort: number;
let seen: Seen[];
let reply: (req: IncomingMessage, res: ServerResponse, body: string) => void;
let front: Server;
let frontPort: number;
let egress: Egress;
let logs: string[];
const log: Logger = {
  debug: (m) => void logs.push(m),
  info: (m) => void logs.push(m),
  warn: (m) => void logs.push(m),
  error: (m) => void logs.push(m),
  child: () => log,
};

const listen = (server: Server): Promise<number> => new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
const close = (server: Server): Promise<void> => new Promise((r) => (server.closeAllConnections(), server.close(() => r())));

/** `realGuard`: leave the address check as it is in production (the fake upstream is on 127.0.0.1, so every request is refused). */
async function boot(realGuard = false): Promise<void> {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      reply(req, res, body);
    });
  });
  upstreamPort = await listen(upstream);
  egress = createEgress({ upstream: { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort }, ...(realGuard ? {} : { allowAddress: () => true }), log });
  front = createServer((req, res) => void egress.handle(req, res));
  frontPort = await listen(front);
}

beforeEach(() => {
  seen = [];
  logs = [];
  reply = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1' });
    res.end('{"ok":true}');
  };
});
afterEach(async () => {
  await close(front);
  await close(upstream);
});

const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; text: string; headers: Headers }> => {
  const res = await fetch(`http://127.0.0.1:${frontPort}${path}`, { redirect: 'manual', ...init });
  return { status: res.status, text: await res.text(), headers: res.headers };
};
const base = (token: string): string => egress.basePath(token);

describe('the proxy', () => {
  it('removes the credentials the client sent and sets the real key, forwards the rest, and returns the answer', async () => {
    await boot();
    const token = egress.issue('ana', () => REAL);
    const res = await call(`${base(token)}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'x-api-key': PLACEHOLDER, authorization: `Bearer ${PLACEHOLDER}`, cookie: 'session=abc', 'x-forwarded-for': '10.0.0.9', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': 'claude-cli/9' },
      body: '{"model":"m","messages":[]}',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"ok":true}');
    expect(res.headers.get('request-id')).toBe('req_1');
    expect(seen).toHaveLength(1);
    const got = seen[0] as Seen;
    expect(got.method).toBe('POST');
    expect(got.url).toBe('/v1/messages?beta=true');
    expect(got.body).toBe('{"model":"m","messages":[]}');
    expect(got.headers['x-api-key']).toBe(REAL);
    expect(got.headers.authorization).toBeUndefined();
    expect(got.headers.cookie).toBeUndefined();
    expect(got.headers['x-forwarded-for']).toBeUndefined();
    expect(got.headers['anthropic-version']).toBe('2023-06-01');
    expect(got.headers['user-agent']).toBe('claude-cli/9');
    expect(got.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
    // the placeholder reached nobody: not in what Anthropic saw
    expect(JSON.stringify(got.headers)).not.toContain(PLACEHOLDER);
  });

  it('streams a long answer as it comes (server-sent events)', async () => {
    await boot();
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\n\n');
      setTimeout(() => res.end('event: b\n\n'), 30);
    };
    const token = egress.issue('ana', () => REAL);
    const res = await fetch(`http://127.0.0.1:${frontPort}${base(token)}/v1/messages`, { method: 'POST', body: '{}' });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('event: a\n\n');
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toBe('event: b\n\n');
  });

  it('a wrong or malformed token is refused and nothing reaches the upstream; after the agent stops its token is worth nothing, and so is the one a restart replaced', async () => {
    await boot();
    const token = egress.issue('ana', () => REAL);
    expect((await call(`${base('a'.repeat(64))}/v1/models`)).status).toBe(403);
    expect((await call(`/egress/short/anthropic/v1/models`)).status).toBe(404);
    expect((await call(`/egress/${token}/openai/v1/models`)).status).toBe(404);
    expect((await call(`${base(token)}/v1/models`)).status).toBe(200);
    const second = egress.issue('ana', () => REAL);
    expect((await call(`${base(token)}/v1/models`)).status).toBe(403);
    expect((await call(`${base(second)}/v1/models`)).status).toBe(200);
    egress.revoke('ana');
    expect(egress.has('ana')).toBe(false);
    expect((await call(`${base(second)}/v1/models`)).status).toBe(403);
    expect(seen).toHaveLength(2);
    // another agent's token is not this one's
    const other = egress.issue('ben', () => REAL);
    egress.revoke('ana');
    expect((await call(`${base(other)}/v1/models`)).status).toBe(200);
  });

  it('forwards only /v1/ with GET, HEAD, POST and DELETE, and no path that leaves it, however it is spelled', async () => {
    await boot();
    const token = egress.issue('ana', () => REAL);
    for (const path of ['/v2/messages', '/api/oauth/profile', '/v1', '/', '', '/v1/../admin', '/v1/%2e%2e/admin', '/v1/%2E%2e/x', '/v1/a%2fb', '/v1/a%5cb', '/v1/%00', '/v1/x%2f..']) {
      const status = (await call(`${base(token)}${path}`)).status;
      expect(status, path).toBe(404);
    }
    // a client that does not tidy the path (fetch does) cannot get a dot segment through either
    for (const raw of ['/v1/../x', '/v1/a/../../b', '/v1/./x']) {
      const status = await new Promise<number>((resolve) => http.get({ host: '127.0.0.1', port: frontPort, path: `${base(token)}${raw}` }, (r) => (r.resume(), resolve(r.statusCode ?? 0))));
      expect(status, raw).toBe(404);
    }
    expect((await call(`${base(token)}/v1/models`, { method: 'PUT', body: '{}' })).status).toBe(405);
    expect((await call(`${base(token)}/v1/models`, { method: 'PATCH', body: '{}' })).status).toBe(405);
    expect((await call(`${base(token)}/v1/messages/batches/b1`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`${base(token)}/v1/models`, { method: 'HEAD' })).status).toBe(200);
    expect(seen.map((s) => s.method)).toEqual(['DELETE', 'HEAD']);
  });

  it('does not follow a redirect: it goes back to the client, with the upstream host turned into this proxy, and any other host dropped', async () => {
    await boot();
    reply = (req, res) => {
      res.writeHead(req.url === '/v1/other' ? 302 : 307, { location: req.url === '/v1/other' ? 'https://evil.example/steal' : `http://127.0.0.1:${upstreamPort}/v1/moved` });
      res.end();
    };
    const token = egress.issue('ana', () => REAL);
    const same = await call(`${base(token)}/v1/old`);
    expect(same.status).toBe(307);
    expect(same.headers.get('location')).toBe(`${base(token)}/v1/moved`);
    const other = await call(`${base(token)}/v1/other`);
    expect(other.status).toBe(302);
    expect(other.headers.get('location')).toBeNull();
    // nothing was fetched after the redirect, and no second request went anywhere
    expect(seen.map((s) => s.url)).toEqual(['/v1/old', '/v1/other']);
  });

  it('asks for the key at every request: a changed key applies at once, no key is 503, and a key with a line break is refused and never sent', async () => {
    await boot();
    let key: string | undefined = REAL;
    const token = egress.issue('ana', () => key);
    await call(`${base(token)}/v1/models`);
    key = 'sk-ant-the-second';
    await call(`${base(token)}/v1/models`);
    expect(seen.map((s) => s.headers['x-api-key'])).toEqual([REAL, 'sk-ant-the-second']);
    for (const bad of [undefined, '', 'sk\r\nX-Evil: 1', 'sk\nx', 'has space', 'a\0b']) {
      key = bad;
      expect((await call(`${base(token)}/v1/models`)).status, JSON.stringify(bad)).toBe(503);
    }
    expect(seen).toHaveLength(2);
  });

  it('refuses a request that is too many at once, and an upstream address that is not public, whatever the name resolves to', async () => {
    // no allowAddress: the real guard. The test upstream is on 127.0.0.1, so it must be refused, and nothing is sent
    await boot(true);
    const token = egress.issue('ana', () => REAL);
    const res = await call(`${base(token)}/v1/models`);
    expect(res.status).toBe(502);
    expect(res.text).toContain('not allowed');
    expect(seen).toEqual([]);
    expect(logs.join('\n')).toContain('refused address');
    await close(front);
    await close(upstream);
    await boot();
    const hung: Array<() => void> = [];
    reply = (_req, res) => void hung.push(() => res.end('{}'));
    const t = egress.issue('cy', () => REAL);
    const open = Array.from({ length: EGRESS_CONCURRENT_MAX }, () => fetch(`http://127.0.0.1:${frontPort}${base(t)}/v1/models`));
    for (let i = 0; i < 200 && hung.length < EGRESS_CONCURRENT_MAX; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(hung.length).toBe(EGRESS_CONCURRENT_MAX);
    expect((await call(`${base(t)}/v1/models`)).status).toBe(429);
    for (const release of hung) release();
    await Promise.all(open);
    reply = (_req, res) => res.end('{}');
    expect((await call(`${base(t)}/v1/models`)).status).toBe(200);
  });

  it('logs no header, no key, no token, no placeholder and no path of the client', async () => {
    await boot();
    const token = egress.issue('ana', () => REAL);
    await call(`${base(token)}/v1/messages?secret=querysecret`, { method: 'POST', headers: { 'x-api-key': PLACEHOLDER, authorization: 'Bearer bearersecret', 'x-secret-header': 'hdrsecret' }, body: 'bodysecret' });
    await call(`${base('f'.repeat(64))}/v1/messages`);
    egress.revoke('ana');
    const all = logs.join('\n');
    for (const secret of [REAL, token, PLACEHOLDER, 'bearersecret', 'hdrsecret', 'querysecret', 'bodysecret', '/v1/messages']) expect(all, secret).not.toContain(secret);
    expect(all).toMatch(/ana POST 200/);
  });
});

describe('which addresses are public', () => {
  it('refuses this machine, private and link-local ranges, carrier-grade NAT, the cloud metadata address, multicast, and the machine\'s own addresses; allows the rest', () => {
    for (const ip of ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', 'not an address', '']) expect(publicAddress(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '160.79.104.10', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(publicAddress(ip), ip).toBe(true);
    const own = Object.values(networkInterfaces()).flatMap((l) => l ?? []).find((i) => !i.internal);
    if (own !== undefined) expect(publicAddress(own.address)).toBe(false);
    expect(publicAddress('8.8.8.8', new Set(['8.8.8.8']))).toBe(false);
  });
});

describe('the room setting', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gonogo-egress-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  // no upstream is booted by these two: the shared afterEach closes servers that were not made
  beforeEach(async () => {
    await boot();
  });

  it('is off, saved in a 0600 file, kept across a restart, and takes only a boolean', async () => {
    const store = createEgressSettings({ dir });
    await store.load();
    expect(store.view()).toEqual({ anthropic: false });
    expect(await store.set({ anthropic: true })).toEqual({ anthropic: true });
    expect((await stat(join(dir, 'egress.json'))).mode & 0o777).toBe(0o600);
    const again = createEgressSettings({ dir });
    await again.load();
    expect(again.view()).toEqual({ anthropic: true });
    for (const bad of [{ anthropic: 'yes' }, {}, { anthropic: true, hosts: [] }, 'on', null, []]) await expect(store.set(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'bad_request' });
    expect(store.view()).toEqual({ anthropic: true });
  });

  it('a file that is damaged leaves it off, and the file holds no key', async () => {
    await writeFile(join(dir, 'egress.json'), '{ nope');
    const store = createEgressSettings({ dir, log });
    await store.load();
    expect(store.view()).toEqual({ anthropic: false });
    await store.set({ anthropic: true });
    expect(await readFile(join(dir, 'egress.json'), 'utf8')).toBe(JSON.stringify({ version: 1, anthropic: true }, null, 2));
  });
});
