import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hub, ServerInfo, TerminalHost } from '../src/shared/protocol.js';
import { nullLogger } from '../src/server/constants.js';
import { HANGAR_BODY_MAX_BYTES, createHangar, createRoots } from '../src/server/hangar.js';
import { createRecorder } from '../src/server/recorder.js';
import { createWebServer } from '../src/server/web.js';
import type { WebOptions, WebServer } from '../src/server/web.js';

const TOKEN = 'ab'.repeat(32);

let base: string;
let dir: string;
let web: WebServer;
let port: number;

interface Answer {
  status: number;
  json: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function start(over: Partial<WebOptions> = {}): Promise<void> {
  const home = join(base, 'home');
  const roots = createRoots({ home, agent: (name) => (name === 'ana' ? { dir, cleanRoom: false } : null) });
  web = createWebServer({
    host: '127.0.0.1',
    port: 0,
    browserToken: TOKEN,
    allowedHosts: [],
    staticDir: null,
    hub: {} as Hub,
    terminals: {} as TerminalHost,
    resolveToken: () => null,
    info: () => ({}) as ServerInfo,
    isReady: () => true,
    hangar: createHangar(roots),
    recorder: createRecorder(roots, { PATH: process.env.PATH, HOME: join(base, 'user') }),
    log: nullLogger,
    ...over,
  });
  port = (await web.listen()).port;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gonogo-hangar-routes-'));
  dir = join(base, 'project');
  await Promise.all([mkdir(dir), mkdir(join(base, 'home')), mkdir(join(base, 'user'))]);
  await writeFile(join(base, 'user', '.gitconfig'), '[user]\n\tname = Ada\n\temail = ada@example.test\n');
  await writeFile(join(dir, 'a.txt'), 'one\n');
});
afterEach(async () => {
  await web.close();
  await rm(base, { recursive: true, force: true });
});

const ROUTES: Array<[string, string]> = [
  ['GET', '/api/agents/ana/files'],
  ['GET', '/api/agents/ana/file?path=a.txt'],
  ['PUT', '/api/agents/ana/file'],
  ['POST', '/api/agents/ana/file'],
  ['GET', '/api/agents/ana/git'],
  ['GET', '/api/agents/ana/git/diff'],
  ['GET', '/api/agents/ana/git/log'],
  ['POST', '/api/agents/ana/git/commit'],
];

describe('the routes of Hangar and Recorder', () => {
  it.each(ROUTES)('%s %s needs the browser token', async (method, path) => {
    await start();
    expect((await call(method, path, method === 'GET' ? undefined : {}, {})).status).toBe(401);
    expect((await call(method, path, method === 'GET' ? undefined : {}, { Authorization: `Bearer ${'cd'.repeat(32)}` })).status).toBe(401);
    // an agent's token is not the browser's
    expect((await call(method, path, method === 'GET' ? undefined : {}, { Authorization: 'Bearer agent-token' })).status).toBe(401);
  });

  it('answers 404 for every route when the parts are not there, and for a name that is no agent', async () => {
    await start({ hangar: undefined, recorder: undefined });
    for (const [method, path] of ROUTES) expect((await call(method, path, method === 'GET' ? undefined : {})).status, path).toBe(404);
    await web.close();
    await start();
    expect((await call('GET', '/api/agents/bob/files')).status).toBe(404);
    expect((await call('GET', '/api/agents/Bad%20Name/git')).status).toBe(404);
    expect((await call('GET', '/api/agents/ana/git/nothing')).status).toBe(404);
  });

  it('lists, reads, saves and creates', async () => {
    await start();
    expect((await call('GET', '/api/agents/ana/files')).json).toMatchObject({ path: '', entries: [{ name: 'a.txt', kind: 'file', size: 4 }] });
    const read = await call('GET', '/api/agents/ana/file?path=a.txt');
    expect(read).toMatchObject({ status: 200, json: { path: 'a.txt', text: 'one\n', size: 4 } });
    const saved = await call('PUT', '/api/agents/ana/file', { path: 'a.txt', text: 'two\n', etag: read.json.etag });
    expect(saved.status).toBe(200);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('two\n');
    expect((await call('PUT', '/api/agents/ana/file', { path: 'a.txt', text: 'three\n', etag: read.json.etag })).status).toBe(409);
    expect((await call('POST', '/api/agents/ana/file', { path: 'b.txt', text: 'b' })).status).toBe(200);
    expect((await call('POST', '/api/agents/ana/file', { path: 'b.txt', text: 'b' })).json).toMatchObject({ code: 'conflict' });
  });

  it('maps the errors to their status', async () => {
    await start();
    await writeFile(join(dir, 'bin'), Buffer.from([0, 1, 2]));
    expect((await call('GET', '/api/agents/ana/file?path=..%2F..%2Fetc%2Fpasswd')).status).toBe(403);
    expect((await call('GET', '/api/agents/ana/file?path=%2Fetc%2Fpasswd')).status).toBe(403);
    expect((await call('GET', '/api/agents/ana/file?path=a%00.txt')).status).toBe(400);
    expect((await call('GET', '/api/agents/ana/file?path=nope')).status).toBe(404);
    expect((await call('GET', '/api/agents/ana/file?path=bin')).status).toBe(415);
    expect((await call('GET', '/api/agents/ana/file')).status).toBe(400);
    expect((await call('GET', '/api/agents/ana/files?path=.git')).status).toBe(403);
  });

  it('refuses a method the route does not take, a body that is not JSON and one that is too large', async () => {
    await start();
    expect((await call('DELETE', '/api/agents/ana/file?path=a.txt')).status).toBe(405);
    expect((await call('POST', '/api/agents/ana/files', {})).status).toBe(405);
    expect((await call('GET', '/api/agents/ana/git/commit')).status).toBe(405);
    expect((await call('PUT', '/api/agents/ana/file', '{nope')).status).toBe(400);
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/ana/file`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
    const big = await call('POST', '/api/agents/ana/file', { path: 'big.txt', text: 'x'.repeat(HANGAR_BODY_MAX_BYTES) });
    expect(big.status).toBe(413);
    // the git routes keep the small limit of every other route
    expect((await call('POST', '/api/agents/ana/git/commit', { message: 'x'.repeat(300 * 1024), scope: 'all' })).status).toBe(413);
  });

  it('shows git, then commits', async () => {
    await start();
    expect((await call('GET', '/api/agents/ana/git')).json).toEqual({ repo: false, reason: 'this folder is not in a git repository' });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: join(base, 'user') } });
    const status = await call('GET', '/api/agents/ana/git');
    expect(status.json).toMatchObject({ repo: true, files: [{ path: 'a.txt', index: '?', tree: '?' }], author: { name: 'Ada' } });
    expect((await call('GET', '/api/agents/ana/git/log')).json).toEqual([]);
    expect((await call('POST', '/api/agents/ana/git/commit', { message: '', scope: 'all' })).status).toBe(400);
    const done = await call('POST', '/api/agents/ana/git/commit', { message: 'first', scope: 'all' });
    expect(done).toMatchObject({ status: 200, json: { commit: { subject: 'first', author: 'Ada' } } });
    await writeFile(join(dir, 'a.txt'), 'two\n');
    expect((await call('GET', '/api/agents/ana/git/diff?path=a.txt')).json).toMatchObject({ truncated: false, diff: expect.stringContaining('+two') });
    expect((await call('GET', '/api/agents/ana/git/diff?staged=1')).json).toMatchObject({ diff: '' });
    expect((await call('GET', '/api/agents/ana/git/diff?path=..%2Fx')).status).toBe(403);
    expect((await call('POST', '/api/agents/ana/git/commit', { message: 'again', scope: 'staged' })).status).toBe(409);
  });
});
