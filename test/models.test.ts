/** Default models: the store (a real temp folder), the routes (a fake store) and the launcher's rule that the agent's own model wins. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord, Hub, Provider, ServerInfo, TerminalHost } from '../src/shared/protocol.js';
import { nullLogger } from '../src/server/constants.js';
import { createLauncher } from '../src/server/launcher.js';
import { createModelDefaults } from '../src/server/models.js';
import { createWebServer } from '../src/server/web.js';
import type { WebServer } from '../src/server/web.js';

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';
const TOKEN = 'ab'.repeat(32);
let tmp: string;
let web: WebServer | null = null;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-models-'));
});
afterEach(async () => {
  await web?.close();
  web = null;
  await rm(tmp, { recursive: true, force: true });
});

describe('the store', () => {
  it('starts empty, sets and clears a model per engine, and keeps it across a reload', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    expect(store.view()).toEqual({ models: {} });
    expect(await store.set('claude', ' sonnet ')).toEqual({ models: { claude: 'sonnet' } });
    expect(await store.set('gemini', 'flash')).toEqual({ models: { claude: 'sonnet', gemini: 'flash' } });
    const again = createModelDefaults({ dir: tmp });
    await again.load();
    expect(again.get('claude')).toBe('sonnet');
    expect(await again.set('claude', null)).toEqual({ models: { gemini: 'flash' } });
    expect(await again.set('gemini', '')).toEqual({ models: {} });
    expect(JSON.parse(await readFile(join(tmp, 'models.json'), 'utf8'))).toEqual({ version: 1, models: {} });
  });

  it('refuses an engine with no model field, an unknown one and a bad name, and writes nothing', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    await expect(store.set('opencode', 'x')).rejects.toMatchObject({ field: 'provider' });
    await expect(store.set('nope', 'x')).rejects.toMatchObject({ field: 'provider' });
    await expect(store.set('claude', '-rf')).rejects.toMatchObject({ field: 'model' });
    await expect(store.set('claude', 3)).rejects.toMatchObject({ field: 'model' });
    expect(store.view()).toEqual({ models: {} });
  });

  it('keeps a damaged file aside and starts empty; drops entries it cannot use', async () => {
    await writeFile(join(tmp, 'models.json'), '{ not json');
    const broken = createModelDefaults({ dir: tmp });
    await broken.load();
    expect(broken.view()).toEqual({ models: {} });
    expect(await readFile(join(tmp, 'models.json.bad'), 'utf8')).toBe('{ not json');
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: { claude: 'opus', opencode: 'x', gemini: '--bad' } }));
    const mixed = createModelDefaults({ dir: tmp });
    await mixed.load();
    expect(mixed.view()).toEqual({ models: { claude: 'opus' } });
  });
});

describe('the routes', () => {
  async function start(withStore: boolean): Promise<number> {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
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
      ...(withStore ? { models: store } : {}),
      log: nullLogger,
    });
    return (await web.listen()).port;
  }
  const call = async (port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('GET answers the defaults, PUT sets and clears one, and a bad one is 400 with its field', async () => {
    const port = await start(true);
    expect(await call(port, 'GET', '/api/models')).toEqual({ status: 200, json: { models: {} } });
    expect(await call(port, 'PUT', '/api/models/claude', { model: 'haiku' })).toEqual({ status: 200, json: { models: { claude: 'haiku' } } });
    expect(await call(port, 'PUT', '/api/models/claude', { model: null })).toEqual({ status: 200, json: { models: {} } });
    const badName = await call(port, 'PUT', '/api/models/claude', { model: '-x' });
    expect(badName.status).toBe(400);
    expect(badName.json).toMatchObject({ field: 'model' });
    const badEngine = await call(port, 'PUT', '/api/models/custom', { model: 'x' });
    expect(badEngine.status).toBe(400);
    expect(badEngine.json).toMatchObject({ field: 'provider' });
  });

  it('answers a bad % escape in the engine with 400, not 500', async () => {
    const port = await start(true);
    const bad = await call(port, 'PUT', '/api/models/%E0%A4%A', { model: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ field: 'provider' });
  });

  it('answers 404 without the store', async () => {
    const port = await start(false);
    expect((await call(port, 'GET', '/api/models')).status).toBe(404);
  });
});

describe('the launcher', () => {
  const agent = (provider: Provider, over: Partial<AgentRecord> = {}): AgentRecord => ({
    name: 'ana', role: 'r', dir: join(tmp, 'work'), mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...(provider === 'claude' ? {} : { provider }), ...over,
  });
  const make = (defaults: Partial<Record<Provider, string>>) =>
    createLauncher({ homeDir: join(tmp, 'home'), hubUrl: () => 'http://127.0.0.1:1', seed: false, env: { PATH: '/usr/bin:/bin', HOME: join(tmp, 'user') }, defaultModel: (p) => defaults[p] });
  const flag = (args: string[]): string | undefined => (args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined);

  it('uses the room default when the agent has no model, and the agent\'s own model wins', async () => {
    await mkdir(join(tmp, 'work'), { recursive: true });
    const l = make({ claude: 'sonnet', gemini: 'flash' });
    expect(flag((await l.prepareStart(agent('claude'), { generation: 1, flag: null })).spec.args)).toBe('sonnet');
    expect(flag((await l.prepareStart(agent('claude', { model: 'opus' }), { generation: 2, flag: null })).spec.args)).toBe('opus');
    expect(flag((await l.prepareStart(agent('gemini'), { generation: 1, flag: null })).spec.args)).toBe('flash');
    expect(flag((await l.prepareStart(agent('pi'), { generation: 1, flag: null })).spec.args)).toBeUndefined();
  });
});
