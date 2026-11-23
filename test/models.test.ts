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
    expect(store.view()).toEqual({ models: {}, positions: {} });
    expect(await store.set('claude', ' sonnet ')).toEqual({ models: { claude: 'sonnet' }, positions: {} });
    expect(await store.set('gemini', 'flash')).toEqual({ models: { claude: 'sonnet', gemini: 'flash' }, positions: {} });
    const again = createModelDefaults({ dir: tmp });
    await again.load();
    expect(again.get('claude')).toBe('sonnet');
    expect(await again.set('claude', null)).toEqual({ models: { gemini: 'flash' }, positions: {} });
    expect(await again.set('gemini', '')).toEqual({ models: {}, positions: {} });
    expect(JSON.parse(await readFile(join(tmp, 'models.json'), 'utf8'))).toEqual({ version: 1, models: {}, positions: {} });
  });

  it('refuses an engine with no model field, an unknown one and a bad name, and writes nothing', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    await expect(store.set('opencode', 'x')).rejects.toMatchObject({ field: 'provider' });
    await expect(store.set('nope', 'x')).rejects.toMatchObject({ field: 'provider' });
    await expect(store.set('claude', '-rf')).rejects.toMatchObject({ field: 'model' });
    await expect(store.set('claude', 3)).rejects.toMatchObject({ field: 'model' });
    expect(store.view()).toEqual({ models: {}, positions: {} });
  });

  it('keeps a damaged file aside and starts empty; drops entries it cannot use', async () => {
    await writeFile(join(tmp, 'models.json'), '{ not json');
    const broken = createModelDefaults({ dir: tmp });
    await broken.load();
    expect(broken.view()).toEqual({ models: {}, positions: {} });
    expect(await readFile(join(tmp, 'models.json.bad'), 'utf8')).toBe('{ not json');
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: { claude: 'opus', opencode: 'x', gemini: '--bad' } }));
    const mixed = createModelDefaults({ dir: tmp });
    await mixed.load();
    expect(mixed.view()).toEqual({ models: { claude: 'opus' }, positions: {} });
  });
});

describe('the default sandbox flavor', () => {
  it('starts as docker (none), is kept across a reload, goes back with null or docker, and an old file still loads', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    expect(store.sandbox()).toBeUndefined();
    expect(await store.setSandbox('gvisor')).toEqual({ models: {}, positions: {}, sandbox: 'gvisor' });
    const again = createModelDefaults({ dir: tmp });
    await again.load();
    expect(again.sandbox()).toBe('gvisor');
    expect(JSON.parse(await readFile(join(tmp, 'models.json'), 'utf8'))).toMatchObject({ version: 1, sandbox: 'gvisor' });
    expect(await again.setSandbox('docker')).toEqual({ models: {}, positions: {} });
    expect(await again.setSandbox('microvm')).toMatchObject({ sandbox: 'microvm' });
    expect(await again.setSandbox(null)).toEqual({ models: {}, positions: {} });
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: {} }));
    const old = createModelDefaults({ dir: tmp });
    await old.load();
    expect(old.sandbox()).toBeUndefined();
  });

  it('refuses a flavor that is not one and writes nothing; a file with a bad one drops it', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    for (const bad of ['runc', 'kata', 3, '']) await expect(store.setSandbox(bad), String(bad)).rejects.toMatchObject({ code: 'bad_request', field: 'sandbox' });
    expect(store.view()).toEqual({ models: {}, positions: {} });
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: {}, sandbox: 'warp' }));
    const file = createModelDefaults({ dir: tmp });
    await file.load();
    expect(file.sandbox()).toBeUndefined();
  });
});

describe('the default permission mode', () => {
  it('starts as none (ask), is kept across a reload, and goes back with null or default', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    expect(store.mode()).toBeUndefined();
    expect(await store.setMode('acceptEdits')).toEqual({ models: {}, positions: {}, mode: 'acceptEdits' });
    const again = createModelDefaults({ dir: tmp });
    await again.load();
    expect(again.mode()).toBe('acceptEdits');
    expect(JSON.parse(await readFile(join(tmp, 'models.json'), 'utf8'))).toMatchObject({ version: 1, mode: 'acceptEdits' });
    expect(await again.setMode('default')).toEqual({ models: {}, positions: {} });
    expect(await again.setMode('auto')).toMatchObject({ mode: 'auto' });
    expect(await again.setMode(null)).toEqual({ models: {}, positions: {} });
  });

  it('refuses bypassPermissions without confirmBypass: true, and a mode that is not one, and writes nothing', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    await expect(store.setMode('bypassPermissions')).rejects.toMatchObject({ code: 'bad_request', field: 'confirmBypass' });
    await expect(store.setMode('bypassPermissions', 'yes')).rejects.toMatchObject({ field: 'confirmBypass' });
    await expect(store.setMode('yolo')).rejects.toMatchObject({ field: 'mode' });
    await expect(store.setMode(3)).rejects.toMatchObject({ field: 'mode' });
    expect(store.view()).toEqual({ models: {}, positions: {} });
    expect(await store.setMode('bypassPermissions', true)).toMatchObject({ mode: 'bypassPermissions' });
  });

  it('bypassPermissions is read back only with the stamp setMode writes: a planted file does not preselect it', async () => {
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: {}, mode: 'bypassPermissions' }));
    const planted = createModelDefaults({ dir: tmp });
    await planted.load();
    expect(planted.mode()).toBeUndefined();
    const store = createModelDefaults({ dir: tmp });
    await store.setMode('bypassPermissions', true);
    const saved = JSON.parse(await readFile(join(tmp, 'models.json'), 'utf8'));
    expect(typeof saved.bypassConfirmedAt).toBe('number');
    const again = createModelDefaults({ dir: tmp });
    await again.load();
    expect(again.mode()).toBe('bypassPermissions');
    await again.setMode('auto');
    expect(JSON.parse(await readFile(join(tmp, 'models.json'), 'utf8'))).not.toHaveProperty('bypassConfirmedAt');
  });

  it('are dropped from a file when not usable, and an older file without one still loads', async () => {
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: { claude: 'opus' }, mode: 'warp' }));
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    expect(store.view()).toEqual({ models: { claude: 'opus' }, positions: {} });
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: {} }));
    const old = createModelDefaults({ dir: tmp });
    await old.load();
    expect(old.mode()).toBeUndefined();
  });
});

describe('the default engine and effort', () => {
  it('start as Claude Code and none, are kept across a reload, and go back with null', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    expect([store.engine(), store.effort()]).toEqual(['claude', undefined]);
    expect(await store.setEngine('pi')).toEqual({ models: {}, positions: {}, engine: 'pi' });
    expect(await store.setEffort('xhigh')).toEqual({ models: {}, positions: {}, engine: 'pi', effort: 'xhigh' });
    const again = createModelDefaults({ dir: tmp });
    await again.load();
    expect([again.engine(), again.effort()]).toEqual(['pi', 'xhigh']);
    expect(await again.setEngine(null)).toEqual({ models: {}, positions: {}, effort: 'xhigh' });
    expect(await again.setEffort(null)).toEqual({ models: {}, positions: {} });
    expect(again.engine()).toBe('claude');
  });

  it('refuse a custom command, an unknown engine and a level that is not one, and write nothing', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    await expect(store.setEngine('custom')).rejects.toMatchObject({ field: 'engine' });
    await expect(store.setEngine('vim')).rejects.toMatchObject({ field: 'engine' });
    await expect(store.setEngine(3)).rejects.toMatchObject({ field: 'engine' });
    await expect(store.setEffort('ultra')).rejects.toMatchObject({ field: 'effort' });
    expect(store.view()).toEqual({ models: {}, positions: {} });
  });

  it('are dropped from a file when they are not usable', async () => {
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: {}, engine: 'custom', effort: 'warp' }));
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    expect(store.view()).toEqual({ models: {}, positions: {} });
  });

  it('go through PUT /api/models/engine and /effort, with the field on a bad one', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    web = createWebServer({ host: '127.0.0.1', port: 0, browserToken: TOKEN, allowedHosts: [], staticDir: null, hub: {} as Hub, terminals: {} as TerminalHost, resolveToken: () => null, info: () => ({}) as ServerInfo, isReady: () => true, models: store, log: nullLogger });
    const { port } = await web.listen();
    const put = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    expect(await put('/api/models/engine', { engine: 'opencode' })).toEqual({ status: 200, json: { models: {}, positions: {}, engine: 'opencode' } });
    expect(await put('/api/models/effort', { effort: 'low' })).toMatchObject({ status: 200, json: { effort: 'low' } });
    expect((await put('/api/models/engine', { engine: 'custom' })).json).toMatchObject({ field: 'engine' });
    expect((await put('/api/models/effort', { effort: 'nope' })).json).toMatchObject({ field: 'effort' });
  });

  it('reach the launcher: the room\'s effort when the agent has none, and the agent\'s own wins', async () => {
    await mkdir(join(tmp, 'work'), { recursive: true });
    const l = createLauncher({ homeDir: join(tmp, 'home'), hubUrl: () => 'http://127.0.0.1:1', seed: false, env: { PATH: '/usr/bin:/bin', HOME: join(tmp, 'user') }, defaultEffort: () => 'medium' });
    const rec = (over: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'ana', role: 'r', dir: join(tmp, 'work'), mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...over });
    const level = (args: string[]): string | undefined => (args.includes('--effort') ? args[args.indexOf('--effort') + 1] : undefined);
    expect(level((await l.prepareStart(rec(), { generation: 1, flag: null })).spec.args)).toBe('medium');
    expect(level((await l.prepareStart(rec({ effort: 'max' }), { generation: 2, flag: null })).spec.args)).toBe('max');
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
    expect(await call(port, 'GET', '/api/models')).toEqual({ status: 200, json: { models: {}, positions: {} } });
    expect(await call(port, 'PUT', '/api/models/claude', { model: 'haiku' })).toEqual({ status: 200, json: { models: { claude: 'haiku' }, positions: {} } });
    expect(await call(port, 'PUT', '/api/models/claude', { model: null })).toEqual({ status: 200, json: { models: {}, positions: {} } });
    const badName = await call(port, 'PUT', '/api/models/claude', { model: '-x' });
    expect(badName.status).toBe(400);
    expect(badName.json).toMatchObject({ field: 'model' });
    const badEngine = await call(port, 'PUT', '/api/models/custom', { model: 'x' });
    expect(badEngine.status).toBe(400);
    expect(badEngine.json).toMatchObject({ field: 'provider' });
  });

  it('answers a % in the engine name with 400, not 500, and a bad escape with the router\'s 404', async () => {
    const port = await start(true);
    const lone = await call(port, 'PUT', '/api/models/%25', { model: 'x' });
    expect(lone.status).toBe(400);
    expect(lone.json).toMatchObject({ field: 'provider' });
    const twice = await call(port, 'PUT', '/api/models/%2541', { model: 'x' });
    expect(twice.status).toBe(400);
    const res = await fetch(`http://127.0.0.1:${port}/api/models/%E0%A4%A`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });

  it('PUT /api/models/positions/<id> sets and clears a position\'s model, and a bad one is 400 with its field', async () => {
    const port = await start(true);
    expect(await call(port, 'PUT', '/api/models/positions/guido', { model: 'opus' })).toEqual({ status: 200, json: { models: {}, positions: { guido: 'opus' } } });
    expect(await call(port, 'PUT', '/api/models/positions/guido', { model: null })).toEqual({ status: 200, json: { models: {}, positions: {} } });
    const unknown = await call(port, 'PUT', '/api/models/positions/nobody', { model: 'x' });
    expect(unknown.status).toBe(400);
    expect(unknown.json).toMatchObject({ field: 'position' });
    expect((await call(port, 'PUT', '/api/models/positions/guido', { model: '-x' })).json).toMatchObject({ field: 'model' });
    expect((await call(port, 'PUT', '/api/models/other/guido', { model: 'x' })).status).toBe(404);
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

describe('a model per position', () => {
  it('stores, clears and validates one, and keeps it across a reload', async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    expect(await store.setPosition('guido', ' opus ')).toEqual({ models: {}, positions: { guido: 'opus' } });
    expect(store.getPosition('guido')).toBe('opus');
    await expect(store.setPosition('nobody', 'x')).rejects.toMatchObject({ field: 'position' });
    await expect(store.setPosition('guido', '-x')).rejects.toMatchObject({ field: 'model' });
    expect(store.getPosition('guido')).toBe('opus');
    const again = createModelDefaults({ dir: tmp });
    await again.load();
    expect(again.view().positions).toEqual({ guido: 'opus' });
    expect(await again.setPosition('guido', null)).toEqual({ models: {}, positions: {} });
    expect(JSON.parse(await readFile(join(tmp, 'models.json'), 'utf8'))).toEqual({ version: 1, models: {}, positions: {} });
  });

  it('drops a position it does not know and a file from before positions reads as none', async () => {
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: { claude: 'sonnet' }, positions: { guido: 'opus', nobody: 'x', fido: '--bad' } }));
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    expect(store.view()).toEqual({ models: { claude: 'sonnet' }, positions: { guido: 'opus' } });
    await writeFile(join(tmp, 'models.json'), JSON.stringify({ version: 1, models: { claude: 'sonnet' } }));
    const old = createModelDefaults({ dir: tmp });
    await old.load();
    expect(old.view().positions).toEqual({});
  });
});

describe('the launcher and a position', () => {
  const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'ana', role: 'r', dir: join(tmp, 'work'), mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...over });
  const make = async () => {
    const store = createModelDefaults({ dir: tmp });
    await store.load();
    await store.set('claude', 'sonnet');
    await store.set('gemini', 'flash');
    await store.setPosition('guido', 'opus');
    return createLauncher({ homeDir: join(tmp, 'home'), hubUrl: () => 'http://127.0.0.1:1', seed: false, env: { PATH: '/usr/bin:/bin', HOME: join(tmp, 'user') }, defaultModel: (p, position) => store.resolve(p, position) });
  };
  const flag = (args: string[]): string | undefined => (args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined);

  it('asks for the model with the agent\'s position: position, then engine, and the agent\'s own model wins', async () => {
    await mkdir(join(tmp, 'work'), { recursive: true });
    const l = await make();
    expect(flag((await l.prepareStart(agent({ position: 'guido' }), { generation: 1, flag: null })).spec.args)).toBe('opus');
    expect(flag((await l.prepareStart(agent({ position: 'fido' }), { generation: 2, flag: null })).spec.args)).toBe('sonnet');
    expect(flag((await l.prepareStart(agent(), { generation: 3, flag: null })).spec.args)).toBe('sonnet');
    expect(flag((await l.prepareStart(agent({ position: 'guido', model: 'haiku' }), { generation: 4, flag: null })).spec.args)).toBe('haiku');
    expect(flag((await l.prepareStart(agent({ position: 'guido', provider: 'gemini' }), { generation: 5, flag: null })).spec.args)).toBe('flash');
  });
});
