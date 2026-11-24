/**
 * Engine Bay, pi (src/server/piextension.ts): the start gonogo prepares for pi, and gonogo's own extension run against a fake pi and a local
 * hook server, so each pi event is checked to reach the hub as the hook Claude Code would send, and a Stop block to come back as pi's continuation.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/shared/protocol.js';
import { createLauncher } from '../src/server/launcher.js';
import { buildPiConfig, PI_EXTENSION_SOURCE, piServers } from '../src/server/piextension.js';
import type { GatePolicy } from '../src/server/toolgate.js';

const BYPASS: GatePolicy = { mode: 'bypassPermissions', rules: {}, allowed: [], cwd: '/work', home: '/home/me' };

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-pi-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('the servers pi gets', () => {
  it('converts stdio and http servers to pi\'s shape with every tool direct, and leaves out SSE (pi has no SSE transport)', () => {
    const { servers, skipped } = piServers({
      files: { command: 'npx', args: ['-y', 'fs'], env: { ROOT: '/w' } },
      docs: { type: 'http', url: 'https://d.example/mcp', headers: { Authorization: 'Bearer k' } },
      old: { type: 'sse', url: 'https://o.example/sse' },
      gonogo: { type: 'http', url: 'http://evil.example' },
    });
    expect(servers).toStrictEqual({
      files: { command: 'npx', args: ['-y', 'fs'], env: { ROOT: '/w' }, exposure: 'direct' },
      docs: { url: 'https://d.example/mcp', headers: { Authorization: 'Bearer k' }, exposure: 'direct' },
    });
    expect(skipped).toStrictEqual(['old']);
  });

  it('points the hooks and the gonogo MCP server at the hub', () => {
    const { config } = buildPiConfig({ hubUrl: 'http://127.0.0.1:7777', name: 'ana', policy: BYPASS });
    expect(config).toMatchObject({ hookUrl: 'http://127.0.0.1:7777/hook/ana/', mcpUrl: 'http://127.0.0.1:7777/mcp', servers: {} });
  });
});

describe('prepareStart for pi', () => {
  const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'ana', role: 'Reviews pull requests.', dir: tmp, mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, provider: 'pi', ...over });

  it('writes the extension and its settings (0600), passes skills, and keeps the sessions in the agent\'s folder', async () => {
    const home = join(tmp, 'home');
    await mkdir(join(tmp, 'skills', 'review'), { recursive: true });
    const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { PATH: '/usr/bin:/bin', HOME: join(tmp, 'user') }, coauthor: () => ({ enabled: false, prFooter: false }) });
    const { spec } = await launcher.prepareStart(agent({ payload: { mcpServers: { files: { command: 'npx' } }, skills: [join(tmp, 'skills', 'review')] } }), { generation: 1, flag: null });
    const dir = join(home, 'agents', 'ana');
    expect(spec.args).toContain('--skill');
    expect(spec.args[spec.args.indexOf('--skill') + 1]).toBe(join(tmp, 'skills', 'review'));
    expect(spec.args[spec.args.indexOf('--session-dir') + 1]).toBe(join(dir, 'pi-sessions'));
    expect(await readFile(join(dir, 'gonogo-pi.ts'), 'utf8')).toBe(PI_EXTENSION_SOURCE);
    const config = JSON.parse(await readFile(join(dir, 'gonogo-pi.json'), 'utf8'));
    expect(config.servers).toStrictEqual({ files: { command: 'npx', exposure: 'direct' } });
    expect((await stat(join(dir, 'gonogo-pi.json'))).mode & 0o777).toBe(0o600);
    // the token is read from the environment, never written into the extension's files
    expect(spec.env.GONOGO_TOKEN).toMatch(/.{20,}/);
    expect(await readFile(join(dir, 'gonogo-pi.json'), 'utf8')).not.toContain(spec.env.GONOGO_TOKEN as string);
  });

  it('a handoff written for this session is named in the role; one for another session is not', async () => {
    const home = join(tmp, 'home');
    const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { PATH: '/usr/bin:/bin', HOME: join(tmp, 'user') }, coauthor: () => ({ enabled: false, prFooter: false }) });
    await launcher.writeHandoff({ ...agent(), provider: 'opencode', sessionId: 'old' }, agent());
    const role = (args: string[]): string => args[args.indexOf('--append-system-prompt') + 1] as string;
    const with1 = await launcher.prepareStart(agent(), { generation: 1, flag: null });
    expect(role(with1.spec.args)).toContain(join(home, 'agents', 'ana', 'handoff.md'));
    const other = await launcher.prepareStart(agent({ sessionId: '11111111-2222-4333-8444-555555555555' }), { generation: 2, flag: null });
    expect(role(other.spec.args)).not.toContain('handoff.md');
    // Claude Code gets the same line in its role text, and so does opencode in its instructions file
    await launcher.writeHandoff({ ...agent(), sessionId: 'old' }, { ...agent(), provider: undefined });
    const claude = await launcher.prepareStart({ ...agent(), provider: undefined }, { generation: 3, flag: 'session-id' });
    expect(role(claude.spec.args)).toContain(join(home, 'agents', 'ana', 'handoff.md'));
    await launcher.writeHandoff({ ...agent(), sessionId: 'old' }, { ...agent(), provider: 'opencode' });
    await launcher.prepareStart({ ...agent(), provider: 'opencode' }, { generation: 4, flag: null });
    expect(await readFile(join(home, 'agents', 'ana', 'opencode-role.md'), 'utf8')).toContain(join(home, 'agents', 'ana', 'handoff.md'));
  });
});

/** A fake pi: what the extension registers, and its handlers to call. */
function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const servers: Record<string, Record<string, unknown>> = {};
  return {
    handlers,
    servers,
    api: {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
      registerMcpServer: (name: string, config: Record<string, unknown>) => {
        servers[name] = config;
      },
    },
    fire: (event: string, payload: unknown) => (handlers.get(event) as (event: unknown, ctx: unknown) => Promise<unknown>)(payload, {}),
  };
}

describe('the extension against a hook server', () => {
  it('posts each event as Claude Code\'s hook with the token, and turns a Stop block into a continuation', async () => {
    const posts: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];
    let stopReply: Record<string, unknown> = { decision: 'block', reason: 'You have 1 new message: call read_messages.' };
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk)).on('end', () => {
        posts.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(data) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url?.endsWith('/Stop') ? stopReply : {}));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    const saved = { config: process.env.GONOGO_PI_CONFIG, token: process.env.GONOGO_TOKEN };
    try {
      const { config } = buildPiConfig({ hubUrl: `http://127.0.0.1:${port}`, name: 'ana', servers: { files: { command: 'npx' } }, policy: BYPASS });
      await writeFile(join(tmp, 'gonogo-pi.json'), JSON.stringify(config));
      await writeFile(join(tmp, 'gonogo-pi.ts'), PI_EXTENSION_SOURCE);
      process.env.GONOGO_PI_CONFIG = join(tmp, 'gonogo-pi.json');
      process.env.GONOGO_TOKEN = 'tok-123';
      const pi = fakePi();
      const mod = (await import(join(tmp, 'gonogo-pi.ts'))) as { default: (api: unknown) => void };
      mod.default(pi.api);
      expect(pi.servers.files).toStrictEqual({ command: 'npx', exposure: 'direct' });
      expect(pi.servers.gonogo).toMatchObject({ url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer tok-123' }, exposure: 'direct' });

      await pi.fire('session_start', { reason: 'startup' });
      await pi.fire('before_agent_start', { messageType: 'user', prompt: 'hello' });
      await pi.fire('before_agent_start', { messageType: 'custom' });
      await pi.fire('tool_call', { toolName: 'bash', input: { command: 'ls' } });
      await pi.fire('tool_result', { toolName: 'bash', input: { command: 'ls' }, isError: true });
      await pi.fire('tool_result', { toolName: 'mcp__gonogo__send_message', input: {}, isError: false });
      expect(await pi.fire('agent_before_settle', { entries: [], continue: true, outcome: 'completed' })).toBeUndefined();
      const blocked = await pi.fire('agent_before_settle', { entries: [], continue: false, outcome: 'completed' });
      expect(blocked).toStrictEqual({ entries: [{ type: 'custom_message', customType: 'gonogo', content: 'You have 1 new message: call read_messages.', display: true }], continue: true });
      stopReply = {};
      expect(await pi.fire('agent_before_settle', { entries: [], continue: false, outcome: 'completed' })).toBeUndefined();
      expect(await pi.fire('agent_before_settle', { entries: [], continue: false, outcome: 'aborted' })).toBeUndefined();
      // the gate, in default mode: a command asks (no console here, so it is refused), a deny rule refuses at once, gonogo's own tools run
      const gated = fakePi();
      await writeFile(join(tmp, 'gonogo-pi.json'), JSON.stringify({ ...config, policy: { ...BYPASS, mode: 'default', rules: { deny: ['Read(./.env)'] }, allowed: ['mcp__gonogo__send_message'] } }));
      mod.default(gated.api);
      const before = posts.length;
      expect(await gated.fire('tool_call', { toolName: 'bash', input: { command: 'rm x' } })).toMatchObject({ block: true });
      expect(await gated.fire('tool_call', { toolName: 'read', input: { path: '/work/.env' } })).toStrictEqual({ block: true, reason: 'gonogo: denied by the rule Read(./.env)' });
      expect(await gated.fire('tool_call', { toolName: 'mcp__gonogo__send_message', input: {} })).toBeUndefined();
      expect(posts.slice(before).map((post) => post.url)).toStrictEqual(['/hook/ana/PreToolUse', '/hook/ana/PermissionRequest', '/hook/ana/Notification', '/hook/ana/PreToolUse', '/hook/ana/PostToolUseFailure', '/hook/ana/PreToolUse']);
      posts.splice(before);

      expect(posts.every((post) => post.auth === 'Bearer tok-123')).toBe(true);
      expect(posts.map((post) => [post.url, post.body])).toStrictEqual([
        ['/hook/ana/Notification', { notification_type: 'session_start' }],
        ['/hook/ana/UserPromptSubmit', { prompt: 'hello' }],
        ['/hook/ana/PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
        ['/hook/ana/PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
        ['/hook/ana/PostToolUse', { tool_name: 'mcp__gonogo__send_message', tool_input: {} }],
        ['/hook/ana/Stop', {}],
        ['/hook/ana/Stop', {}],
        ['/hook/ana/StopFailure', { error: 'aborted' }],
      ]);
    } finally {
      process.env.GONOGO_PI_CONFIG = saved.config;
      process.env.GONOGO_TOKEN = saved.token;
      if (saved.config === undefined) delete process.env.GONOGO_PI_CONFIG;
      if (saved.token === undefined) delete process.env.GONOGO_TOKEN;
      server.close();
    }
  });

  it('a hub that does not answer lets pi go on', async () => {
    const { config } = buildPiConfig({ hubUrl: 'http://127.0.0.1:9', name: 'ana', policy: BYPASS });
    await writeFile(join(tmp, 'c.json'), JSON.stringify({ ...config, timeoutMs: 500 }));
    await writeFile(join(tmp, 'ext.ts'), PI_EXTENSION_SOURCE);
    const saved = process.env.GONOGO_PI_CONFIG;
    process.env.GONOGO_PI_CONFIG = join(tmp, 'c.json');
    try {
      const pi = fakePi();
      ((await import(join(tmp, 'ext.ts'))) as { default: (api: unknown) => void }).default(pi.api);
      expect(await pi.fire('agent_before_settle', { entries: [], continue: false, outcome: 'completed' })).toBeUndefined();
      await pi.fire('tool_call', { toolName: 'read', input: {} });
    } finally {
      if (saved === undefined) delete process.env.GONOGO_PI_CONFIG;
      else process.env.GONOGO_PI_CONFIG = saved;
    }
  });
});
