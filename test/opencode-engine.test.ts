/**
 * Engine Bay, opencode (src/server/opencodeplugin.ts): the config gonogo writes, and gonogo's plugin run against a fake opencode client and a
 * local hook server: hooks as Claude Code sends them, the tool gate answering opencode's permission questions, subagents, usage and mail.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOpencodeConfig, buildOpencodeSettings, OPENCODE_PLUGIN_SOURCE, opencodeServers } from '../src/server/opencodeplugin.js';
import type { GatePolicy } from '../src/server/toolgate.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-opencode-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const POLICY: GatePolicy = { mode: 'default', rules: { deny: ['Read(./.env)'] }, allowed: ['mcp__gonogo__send_message'], cwd: '/work', home: '/home/me' };

describe('the config gonogo writes', () => {
  it('converts the servers to opencode\'s local and remote entries, leaves SSE out, and gonogo\'s own comes last', () => {
    expect(opencodeServers({ files: { command: 'npx', args: ['-y', 'fs'], env: { A: '1' } }, docs: { type: 'http', url: 'https://d.example/mcp', headers: { K: 'v' } }, old: { type: 'sse', url: 'https://o.example' } })).toStrictEqual({
      servers: { files: { type: 'local', command: ['npx', '-y', 'fs'], environment: { A: '1' }, enabled: true }, docs: { type: 'remote', url: 'https://d.example/mcp', headers: { K: 'v' }, enabled: true } },
      skipped: ['old'],
    });
    const { config, names } = buildOpencodeConfig({ hubUrl: 'http://127.0.0.1:7', pluginPath: '/a/p', rolePath: '/a/role.md', servers: { 'my-files': { command: 'x' } }, skills: ['/skills/review'], effort: 'high', anthropicBaseUrl: 'http://h/egress/t/anthropic' });
    expect(Object.keys(config.mcp as object)).toStrictEqual(['my-files', 'gonogo']);
    expect(names).toStrictEqual(['my-files', 'gonogo']);
    expect(config).toMatchObject({
      plugin: ['/a/p'],
      instructions: ['/a/role.md'],
      skills: { paths: ['/skills/review'] },
      agent: { build: { variant: 'high' }, plan: { variant: 'high' } },
      provider: { anthropic: { options: { baseURL: 'http://h/egress/t/anthropic/v1', apiKey: '{env:ANTHROPIC_API_KEY}' } } },
    });
  });
});

describe('the gate of the plugin (opencode 2): what RSO asked of #286', () => {
  /** Runs the plugin's permission hook alone, against the given policy and own folder. */
  async function evaluate(policy: GatePolicy, ownDir: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const settings = buildOpencodeSettings({ hubUrl: 'http://127.0.0.1:9', name: 'ana', servers: ['gonogo'], policy, ownDir });
    await writeFile(join(tmp, 'g.json'), JSON.stringify(settings));
    await writeFile(join(tmp, 'g.mjs'), OPENCODE_PLUGIN_SOURCE);
    const saved = process.env.GONOGO_OPENCODE_CONFIG;
    process.env.GONOGO_OPENCODE_CONFIG = join(tmp, 'g.json');
    try {
      let hook: ((i: Record<string, unknown>) => Promise<void>) | undefined;
      const ctx = {
        session: { hook: () => undefined, get: async () => ({}), synthetic: async () => undefined },
        tool: { hook: () => undefined },
        permission: { hook: (_: string, cb: (i: Record<string, unknown>) => Promise<void>) => void (hook = cb) },
        event: { subscribe: async function* () { /* none */ } },
      };
      const mod = (await import(`${join(tmp, 'g.mjs')}?${Math.random()}`)) as { default: { setup: (c: unknown) => Promise<void> } };
      await mod.default.setup(ctx);
      await hook?.(input);
      return input;
    } finally {
      if (saved === undefined) delete process.env.GONOGO_OPENCODE_CONFIG;
      else process.env.GONOGO_OPENCODE_CONFIG = saved;
    }
  }
  const own = (): string => join(tmp, 'agent');

  it('the agent\'s own folder is its own only for real: a \"..\" way out, a link that leaves it and another folder are asked; the folder itself and what is inside are allowed', async () => {
    await mkdir(join(own(), 'sub'), { recursive: true });
    await mkdir(join(tmp, 'elsewhere'), { recursive: true });
    await symlink(join(tmp, 'elsewhere'), join(own(), 'link'));
    const ask = async (dir: string): Promise<unknown> => (await evaluate(POLICY, own(), { action: 'external_directory', resources: [dir], effect: 'ask' })).effect;
    expect(await ask(`${own()}/*`)).toBe('allow');
    expect(await ask(`${own()}/sub/*`)).toBe('allow');
    expect(await ask(`${own()}/../../etc/*`)).toBe('ask');
    expect(await ask(`${own()}/sub/../../..`)).toBe('ask');
    expect(await ask(`${own()}/link/*`)).toBe('ask');
    expect(await ask('/etc/*')).toBe('ask');
    expect(await ask(`${own()}-other/*`)).toBe('ask');
  });

  it('`bash` and `shell` are both Bash: a deny rule holds for either, in bypassPermissions too', async () => {
    const policy: GatePolicy = { ...POLICY, mode: 'bypassPermissions', rules: { deny: ['Bash(rm -rf *)'] } };
    for (const action of ['bash', 'shell']) {
      expect(await evaluate(policy, own(), { action, resources: ['rm -rf /'], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'deny' });
      expect(await evaluate(policy, own(), { action, resources: ['ls'], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'allow' });
    }
  });

  it('an edit that names its files is judged file by file, and one with no path is asked under acceptEdits and auto; todoread is the quiet TodoRead and codesearch a WebSearch', async () => {
    const policy: GatePolicy = { ...POLICY, mode: 'acceptEdits', cwd: '/work', rules: {} };
    expect(await evaluate(policy, own(), { action: 'edit', resources: ['/work/a.ts', '/work/b.ts'], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'allow' });
    expect(await evaluate(policy, own(), { action: 'edit', resources: ['/work/a.ts', '/etc/passwd'], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'ask' });
    expect(await evaluate(policy, own(), { action: 'edit', resources: [], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'ask' });
    expect(await evaluate({ ...policy, mode: 'auto' }, own(), { action: 'patch', resources: [], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'ask' });
    const deny: GatePolicy = { ...policy, rules: { deny: ['Edit(//work/secret.ts)'] } };
    expect(await evaluate(deny, own(), { action: 'edit', resources: ['/work/a.ts', '/work/secret.ts'], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'deny' });
    const asking: GatePolicy = { ...POLICY, mode: 'default', rules: { allow: ['TodoRead'], ask: ['WebSearch'] } };
    expect(await evaluate(asking, own(), { action: 'todoread', resources: [], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'allow' });
    expect(await evaluate(asking, own(), { action: 'codesearch', resources: ['q'], metadata: {}, effect: 'ask' })).toMatchObject({ effect: 'ask' });
  });

  it('lsp and doom_loop are always asked, whatever the mode', async () => {
    for (const action of ['lsp', 'doom_loop']) expect(await evaluate({ ...POLICY, mode: 'bypassPermissions', rules: {} }, own(), { action, resources: ['*'], metadata: {}, effect: 'allow' })).toMatchObject({ effect: 'ask' });
  });
});

describe('the plugin against a hook server (opencode 2: the plugin context is a fake)', () => {
  type Hook = (input: Record<string, unknown>) => Promise<void> | void;
  it('posts the hooks, answers permission questions with the gate, keeps subagents apart, reports usage and hands mail over', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    let stop: Record<string, unknown> = { decision: 'block', reason: 'You have mail.' };
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk)).on('end', () => {
        posts.push({ url: (req.url ?? '').replace('/hook/ana/', ''), body: JSON.parse(data) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url?.endsWith('/Stop') ? stop : {}));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    const saved = { config: process.env.GONOGO_OPENCODE_CONFIG, token: process.env.GONOGO_TOKEN };
    try {
      const settings = buildOpencodeSettings({ hubUrl: `http://127.0.0.1:${port}`, name: 'ana', servers: ['my-files', 'gonogo'], policy: POLICY, subagentLimit: 1, ownDir: '/h/agents/ana' });
      await writeFile(join(tmp, 's.json'), JSON.stringify(settings));
      await writeFile(join(tmp, 'plugin.mjs'), OPENCODE_PLUGIN_SOURCE);
      process.env.GONOGO_OPENCODE_CONFIG = join(tmp, 's.json');
      process.env.GONOGO_TOKEN = 'tok';
      const hooks: Record<string, Hook> = {};
      const events: Array<Record<string, unknown>> = [];
      let wake: () => void = () => undefined;
      const synthetic: Array<{ sessionID: string; text: string }> = [];
      const ctx = {
        session: {
          hook: (name: string, callback: Hook) => void (hooks[`session.${name}`] = callback),
          get: async ({ sessionID }: { sessionID: string }) => (sessionID === 'ses_child' ? { id: sessionID, parentID: 'ses_main' } : { id: sessionID }),
          synthetic: async (input: { sessionID: string; text: string }) => void synthetic.push(input),
        },
        tool: { hook: (name: string, callback: Hook) => void (hooks[`tool.${name}`] = callback) },
        permission: { hook: (name: string, callback: Hook) => void (hooks[`permission.${name}`] = callback) },
        event: {
          subscribe: async function* () {
            for (;;) {
              while (events.length > 0) yield events.shift();
              await new Promise<void>((done) => (wake = done));
            }
          },
        },
      };
      const mod = (await import(join(tmp, 'plugin.mjs'))) as { default: { id: string; setup: (ctx: unknown) => Promise<void> } };
      expect(mod.default.id).toBe('gonogo');
      await mod.default.setup(ctx);
      const event = async (type: string, data: Record<string, unknown>) => {
        events.push({ type, id: `e${events.length}`, created: 5, data });
        wake();
        await new Promise((done) => setTimeout(done, 30));
      };
      await new Promise((done) => setTimeout(done, 100));

      await hooks['session.model.request']?.({ model: { id: 'm' } });
      await hooks['session.prompt']?.({ sessionID: 'ses_main', prompt: { text: 'hello', files: [] } });
      // a command asks: the question stays opencode's, and the Director is told
      await hooks['tool.execute.before']?.({ tool: 'shell', sessionID: 'ses_main', id: 'c1', input: { command: 'ls' } });
      const bash: Record<string, unknown> = { action: 'shell', resources: ['ls'], metadata: {}, effect: 'ask' };
      await hooks['permission.evaluate']?.(bash);
      expect(bash.effect).toBe('ask');
      await event('permission.replied', {});
      await hooks['tool.execute.after']?.({ tool: 'shell', sessionID: 'ses_main', id: 'c1', input: { command: 'ls' }, status: 'completed' });
      // a read the mode allows is answered by the plugin; a denied one is refused with the rule's words
      const read: Record<string, unknown> = { action: 'read', resources: ['/work/a.ts'], metadata: { path: '/work/a.ts' }, effect: 'ask' };
      await hooks['permission.evaluate']?.(read);
      expect(read.effect).toBe('allow');
      const env: Record<string, unknown> = { action: 'read', resources: ['/work/.env'], metadata: { path: '/work/.env' }, effect: 'ask' };
      await hooks['permission.evaluate']?.(env);
      expect(env).toMatchObject({ effect: 'deny', message: 'gonogo: denied by the rule Read(./.env)' });
      // an MCP tool is named as Claude Code names it; gonogo's own is allowed
      const mcp: Record<string, unknown> = { action: 'gonogo_send_message', resources: ['*'], metadata: {}, effect: 'ask' };
      await hooks['permission.evaluate']?.(mcp);
      expect(mcp.effect).toBe('allow');
      await hooks['tool.execute.before']?.({ tool: 'my-files_read_file', sessionID: 'ses_main', id: 'c4', input: {} });
      // a folder outside the project: the agent's own is its own, another one is asked
      const own: Record<string, unknown> = { action: 'external_directory', resources: ['/h/agents/ana/*'], effect: 'ask' };
      await hooks['permission.evaluate']?.(own);
      expect(own.effect).toBe('allow');
      const other: Record<string, unknown> = { action: 'external_directory', resources: ['/etc/*'], effect: 'ask' };
      await hooks['permission.evaluate']?.(other);
      expect(other.effect).toBe('ask');
      // a subagent: its own session's prompt and end are not the agent's turn; a second one at once is over the room's limit
      await hooks['tool.execute.before']?.({ tool: 'subagent', sessionID: 'ses_main', id: 't1', input: { agent: 'general' } });
      const second: Record<string, unknown> = { action: 'subagent', resources: ['*'], metadata: {}, effect: 'ask' };
      await hooks['permission.evaluate']?.(second);
      expect(second).toMatchObject({ effect: 'deny', message: expect.stringContaining('the room allows 1 subagents at once') });
      await hooks['session.prompt']?.({ sessionID: 'ses_child', prompt: { text: 'p' } });
      await hooks['session.experimental.idle']?.({ sessionID: 'ses_child' });
      await hooks['tool.execute.after']?.({ tool: 'subagent', sessionID: 'ses_main', id: 't1', input: {}, status: 'completed' });
      // usage of the session: the difference since the last report, once
      await event('session.usage.updated', { sessionID: 'ses_main', tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 7, write: 3 } } });
      await event('session.usage.updated', { sessionID: 'ses_main', tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 7, write: 3 } } });
      // the end of the turn: the mail goes into the same session, and the turn goes on
      await hooks['session.experimental.idle']?.({ sessionID: 'ses_main' });
      expect(synthetic).toStrictEqual([{ sessionID: 'ses_main', text: 'You have mail.' }]);
      stop = {};
      await hooks['session.experimental.idle']?.({ sessionID: 'ses_main' });
      // a turn the Director stopped (a NO-GO) ends the turn for the hub too; a failed one is a StopFailure
      await event('session.execution.interrupted', { sessionID: 'ses_main' });
      await event('session.execution.failed', { sessionID: 'ses_main' });
      await event('session.execution.interrupted', { sessionID: 'ses_child' });

      expect(posts.map((post) => post.url)).toStrictEqual([
        'Notification',
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest',
        'Notification',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'PermissionRequest',
        'PreToolUse',
        'SubagentStart',
        'PostToolUseFailure',
        'SubagentStop',
        'PostToolUse',
        'Stop',
        'Stop',
        'Stop',
        'StopFailure',
      ]);
      expect(posts[1]?.body).toStrictEqual({ prompt: 'hello', session_id: 'ses_main' });
      expect(posts[3]?.body).toStrictEqual({ tool_name: 'Bash', tool_input: {} });
      expect(posts[4]?.body).toStrictEqual({ notification_type: 'permission_answered' });
      expect(posts[7]?.body).toStrictEqual({ tool_name: 'mcp__my-files__read_file', tool_input: {} });
      expect(posts[10]?.body).toStrictEqual({ agent_id: 't1', agent_type: 'general' });
      expect(posts[14]?.body).toMatchObject({ session_id: 'ses_main', usage: [{ id: 'ses_main:e0', at: 5, model: 'm', i: 10, cw: 3, o: 25, cr: 7 }] });
    } finally {
      server.close();
      for (const [key, value] of Object.entries({ GONOGO_OPENCODE_CONFIG: saved.config, GONOGO_TOKEN: saved.token })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
