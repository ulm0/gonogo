import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord, GlobalMcpServer, Logger, McpServer } from '../src/shared/protocol.js';
import { createLauncher } from '../src/server/launcher.js';
import { createGlobalMcpStore, globalView, mergeGlobal, readGlobalMcp } from '../src/server/globalmcp.js';
import { parsePayloadOff } from '../src/server/payload.js';

// Global MCP servers (src/server/globalmcp.ts): the `claude mcp add --scope user` servers of the user's Claude Code config, under the room's defaults and the agent's own.

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';
const TOKEN = 'Bearer ghp_theSecretTokenOfTheGlobalServer0123456789';
let dir: string;
let logs: string[];
const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m) => void logs.push(m),
  error: (m) => void logs.push(m),
  child: () => log,
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-gmcp-'));
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const GLOBALS = {
  mcpServers: {
    pulsar: { type: 'http', url: 'https://gamma.pulsar.codes/mcp?key=urlsecret', headers: { Authorization: TOKEN } },
    files: { command: 'npx', args: ['-y', 'some-server', '--token', 'argsecret'], env: { API_KEY: 'envsecret' } },
    'Mixed.Case': { type: 'sse', url: 'https://mcp.pulsar.codes/sse' },
    gonogo: { type: 'http', url: 'https://evil.example/mcp' },
    'bad name': { command: 'x' },
    extra: { command: 'x', cwd: '/tmp' },
    notaserver: 'text',
  },
  projects: { '/work': { history: ['a very long history'] } },
};
const claudeJson = async (value: unknown, name = '.claude.json'): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

describe('reading the user-scope servers', () => {
  it('takes the ones the Payload reader accepts, with the file\'s names, and skips the rest with a line that names the server and never a value', async () => {
    const got = await readGlobalMcp(await claudeJson(GLOBALS), log);
    expect(Object.keys(got)).toEqual(['pulsar', 'files', 'Mixed.Case']);
    expect(got.pulsar).toEqual({ type: 'http', url: 'https://gamma.pulsar.codes/mcp?key=urlsecret', headers: { Authorization: TOKEN } });
    const said = logs.join('\n');
    expect(said).toContain('"gonogo" is reserved');
    expect(said).toContain('"extra" was skipped');
    expect(said).toContain('"notaserver" was skipped');
    expect(said).toContain('a name that is not usable');
    for (const secret of [TOKEN, 'urlsecret', 'argsecret', 'envsecret', 'ghp_']) expect(said, secret).not.toContain(secret);
  });

  it('a missing file, a directory, a damaged file, no mcpServers, and a mcpServers that is not an object each add nothing and do not throw', async () => {
    expect(await readGlobalMcp(join(dir, 'nothing.json'), log)).toEqual({});
    expect(logs).toEqual([]);
    await mkdir(join(dir, 'folder'));
    expect(await readGlobalMcp(join(dir, 'folder'), log)).toEqual({});
    expect(await readGlobalMcp(await claudeJson('{ nope', 'bad.json'), log)).toEqual({});
    expect(logs.at(-1)).toContain('not valid JSON');
    expect(await readGlobalMcp(await claudeJson({ projects: {} }, 'none.json'), log)).toEqual({});
    expect(await readGlobalMcp(await claudeJson({ mcpServers: ['x'] }, 'array.json'), log)).toEqual({});
    expect(logs.at(-1)).toContain('is not an object');
    expect(await readGlobalMcp(await claudeJson('[]', 'top.json'), log)).toEqual({});
  });

  it('at most 16 are used, and a name like __proto__ is not a usable name and pollutes nothing', async () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { command: 'x' }]));
    expect(Object.keys(await readGlobalMcp(await claudeJson({ mcpServers: many }, 'many.json'), log))).toHaveLength(16);
    expect(logs.join()).toContain('only the first 16');
    const proto = await readGlobalMcp(await claudeJson('{"mcpServers":{"__proto__":{"command":"x"},"ok":{"command":"y"}}}', 'p.json'), log);
    expect(Object.keys(proto)).toEqual(['ok']);
    expect(logs.join()).toContain('a name that is not usable');
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });
});

describe('the merge', () => {
  const g: Record<string, McpServer> = { a: { command: 'global-a' }, b: { command: 'global-b' }, c: { command: 'global-c' } };

  it('global, then the room and agent payload: the same name, the later wins, whole', () => {
    const out = mergeGlobal(g, undefined, { b: { command: 'payload-b', args: ['x'] }, d: { command: 'payload-d' } });
    expect(out).toEqual({ a: { command: 'global-a' }, b: { command: 'payload-b', args: ['x'] }, c: { command: 'global-c' }, d: { command: 'payload-d' } });
    expect(Object.keys(out)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('an agent can switch a global server off by its name, and a payload server of that name still comes', () => {
    expect(Object.keys(mergeGlobal(g, ['a', 'c'], undefined))).toEqual(['b']);
    expect(mergeGlobal(g, ['a'], { a: { command: 'mine' } })).toEqual({ b: g.b, c: g.c, a: { command: 'mine' } });
  });

  it('the gonogo server is never one of the global ones', () => {
    expect(mergeGlobal({ ...g, gonogo: { command: 'evil' } }, undefined, undefined)).not.toHaveProperty('gonogo');
  });

  it('payloadOff accepts the name of a global server that a Payload name could not be', () => {
    expect(parsePayloadOff({ mcpServers: ['Mixed.Case', 'pulsar'] })).toEqual({ ok: true, off: { mcpServers: ['Mixed.Case', 'pulsar'] } });
    expect(parsePayloadOff({ mcpServers: ['bad name'] }).ok).toBe(false);
    expect(parsePayloadOff({ mcpServers: ['../x'] }).ok).toBe(false);
  });
});

describe('what the page may see', () => {
  it('the name, the type and the origin of the address (or the command), and which are replaced by a room default; never an argument, a header, an env value or a query', async () => {
    const got = await readGlobalMcp(await claudeJson(GLOBALS), log);
    const view = globalView(got, (name) => (name === 'files' ? 'room' : null));
    expect(view).toEqual([
      { name: 'pulsar', type: 'http', target: 'https://gamma.pulsar.codes', overriddenBy: null },
      { name: 'files', type: 'stdio', target: 'npx', overriddenBy: 'room' },
      { name: 'Mixed.Case', type: 'sse', target: 'https://mcp.pulsar.codes', overriddenBy: null },
    ]);
    const text = JSON.stringify(view);
    for (const secret of [TOKEN, 'urlsecret', 'argsecret', 'envsecret', 'some-server', '--token']) expect(text, secret).not.toContain(secret);
  });
});

describe('the room\'s switches', () => {
  it('host agents on and Clean Room agents off by default, saved 0600, and kept', async () => {
    const store = createGlobalMcpStore({ dir, log });
    await store.load();
    expect(store.view()).toEqual({ host: true, cleanRoom: false });
    expect(store.enabled(false)).toBe(true);
    expect(store.enabled(true)).toBe(false);
    expect(await store.set({ cleanRoom: true })).toEqual({ host: true, cleanRoom: true });
    expect(await store.set({ host: false })).toEqual({ host: false, cleanRoom: true });
    expect((await stat(join(dir, 'global-mcp.json'))).mode & 0o777).toBe(0o600);
    const again = createGlobalMcpStore({ dir, log });
    await again.load();
    expect(again.view()).toEqual({ host: false, cleanRoom: true });
    expect(again.enabled(true)).toBe(true);
    expect(again.enabled(false)).toBe(false);
  });

  it('takes booleans only, and a damaged file leaves the defaults', async () => {
    const store = createGlobalMcpStore({ dir, log });
    await store.load();
    for (const bad of [{}, { host: 'yes' }, { cleanRoom: 1 }, { host: true, more: 1 }, 'x', null, []]) await expect(store.set(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'bad_request' });
    await writeFile(join(dir, 'global-mcp.json'), '{ nope');
    const damaged = createGlobalMcpStore({ dir, log });
    await damaged.load();
    expect(damaged.view()).toEqual({ host: true, cleanRoom: false });
  });
});

describe('the start of a host agent', () => {
  const agentRecord = (over: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'ana', role: 'reviews', dir: join(dir, 'work'), mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...over });
  const mcp = async (over: Partial<AgentRecord>, opts: { host?: boolean; room?: Record<string, McpServer> } = {}): Promise<Record<string, McpServer>> => {
    await mkdir(join(dir, 'work'), { recursive: true });
    await claudeJson(GLOBALS, '.claude.json');
    const l = createLauncher({
      homeDir: join(dir, 'home'),
      hubUrl: () => 'http://127.0.0.1:7777',
      seed: false,
      env: { PATH: '/usr/bin:/bin', HOME: join(dir, 'user'), CLAUDE_CONFIG_DIR: dir },
      coauthor: () => ({ enabled: false, prFooter: false }),
      globalMcp: { enabled: (cleanRoom) => (cleanRoom ? false : opts.host !== false) },
      ...(opts.room === undefined ? {} : { payloadDefaults: () => ({ mcpServers: opts.room }) }),
      log,
    });
    const { spec } = await l.prepareStart(agentRecord(over), { generation: 1, flag: null });
    const path = spec.args[spec.args.indexOf('--mcp-config') + 1] as string;
    return (JSON.parse(await readFile(path, 'utf8')) as { mcpServers: Record<string, McpServer> }).mcpServers;
  };

  it('has the global servers, with gonogo\'s own last and untouched', async () => {
    const servers = await mcp({});
    expect(Object.keys(servers)).toEqual(['pulsar', 'files', 'Mixed.Case', 'gonogo']);
    expect(servers.gonogo).toMatchObject({ type: 'http', url: 'http://127.0.0.1:7777/mcp' });
    expect(JSON.stringify(servers.gonogo)).not.toContain('evil.example');
    expect(servers.pulsar?.headers?.Authorization).toBe(TOKEN);
  });

  it('a room default and then the agent\'s own payload replace a global one of the same name', async () => {
    const servers = await mcp({ payload: { mcpServers: { files: { command: 'agent-files' } } } }, { room: { pulsar: { command: 'room-pulsar' }, files: { command: 'room-files' } } });
    expect(servers.pulsar).toEqual({ command: 'room-pulsar' });
    expect(servers.files).toEqual({ command: 'agent-files' });
    expect(servers['Mixed.Case']).toEqual({ type: 'sse', url: 'https://mcp.pulsar.codes/sse' });
  });

  it('payloadOff switches one global server off for this agent only', async () => {
    const servers = await mcp({ payloadOff: { mcpServers: ['pulsar'] } });
    expect(Object.keys(servers)).toEqual(['files', 'Mixed.Case', 'gonogo']);
  });

  it('with the room switch off there are none, and a missing config is no failure', async () => {
    expect(Object.keys(await mcp({}, { host: false }))).toEqual(['gonogo']);
    await rm(join(dir, '.claude.json'));
    const l = createLauncher({ homeDir: join(dir, 'home2'), hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { PATH: '/usr/bin:/bin', HOME: join(dir, 'user'), CLAUDE_CONFIG_DIR: dir }, coauthor: () => ({ enabled: false, prFooter: false }), globalMcp: { enabled: () => true }, log });
    await mkdir(join(dir, 'work'), { recursive: true });
    const { spec } = await l.prepareStart(agentRecord(), { generation: 1, flag: null });
    const written = JSON.parse(await readFile(spec.args[spec.args.indexOf('--mcp-config') + 1] as string, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers)).toEqual(['gonogo']);
  });
});

describe('a new name at a start', () => {
  const srv = (name: string, target: string): GlobalMcpServer => ({ name, type: 'stdio', target, overriddenBy: null });
  it('the first start only records; a new name later is returned once, with its target, and stays until it is gone', async () => {
    const store = createGlobalMcpStore({ dir, log });
    await store.load();
    expect(await store.observe([srv('a', 'npx')])).toEqual([]);
    expect(await store.observe([srv('a', 'npx')])).toEqual([]);
    expect(await store.observe([srv('a', 'npx'), srv('b', 'https://x.test')])).toEqual([srv('b', 'https://x.test')]);
    expect(await store.observe([srv('a', 'npx'), srv('b', 'https://x.test')])).toEqual([]);
    expect(store.added()).toEqual([{ name: 'b', target: 'https://x.test' }]);
    // kept across a restart, and a name that went and came back is new again
    const again = createGlobalMcpStore({ dir, log });
    await again.load();
    expect(again.added()).toEqual([{ name: 'b', target: 'https://x.test' }]);
    await again.observe([srv('a', 'npx')]);
    expect(again.added()).toEqual([]);
    expect(await again.observe([srv('a', 'npx'), srv('b', 'https://x.test')])).toHaveLength(1);
  });
  it('the launcher tells the room of the servers it read, and the saved file carries names and targets only', async () => {
    await mkdir(join(dir, 'work'), { recursive: true });
    await claudeJson({ mcpServers: { pulsar: { type: 'http', url: 'https://gamma.pulsar.codes/mcp?k=SECRETQ', headers: { Authorization: 'Bearer SECRETH' } } } });
    const store = createGlobalMcpStore({ dir, log });
    const seen: string[][] = [];
    const l = createLauncher({
      homeDir: join(dir, 'home'),
      hubUrl: () => 'http://127.0.0.1:7777',
      seed: false,
      env: { PATH: '/usr/bin:/bin', HOME: join(dir, 'user'), CLAUDE_CONFIG_DIR: dir },
      coauthor: () => ({ enabled: false, prFooter: false }),
      globalMcp: { enabled: () => true, saw: (servers) => void seen.push(servers.map((s) => `${s.name}=${s.target}`)) },
      log,
    });
    await l.prepareStart({ name: 'ana', role: 'r', dir: join(dir, 'work'), mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1 } as AgentRecord, { generation: 1, flag: null });
    expect(seen).toEqual([['pulsar=https://gamma.pulsar.codes']]);
    await store.observe([srv('pulsar', 'https://gamma.pulsar.codes')]);
    expect(await readFile(join(dir, 'global-mcp.json'), 'utf8')).not.toMatch(/SECRET/);
  });
});
