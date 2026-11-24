/**
 * Engine Bay, opencode (src/server/opencodeplugin.ts): the config gonogo writes, and gonogo's plugin run against a fake opencode client and a
 * local hook server: hooks as Claude Code sends them, the tool gate answering opencode's permission questions, subagents, usage and mail.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    const { config, names } = buildOpencodeConfig({ hubUrl: 'http://127.0.0.1:7', pluginPath: '/a/p.js', rolePath: '/a/role.md', servers: { 'my-files': { command: 'x' } }, skills: ['/skills/review'], effort: 'high', anthropicBaseUrl: 'http://h/egress/t/anthropic' });
    expect(Object.keys(config.mcp as object)).toStrictEqual(['my-files', 'gonogo']);
    expect(names).toStrictEqual(['my-files', 'gonogo']);
    expect(config).toMatchObject({
      plugin: ['file:///a/p.js'],
      instructions: ['/a/role.md'],
      skills: { paths: ['/skills/review'] },
      agent: { build: { variant: 'high' }, plan: { variant: 'high' } },
      provider: { anthropic: { options: { baseURL: 'http://h/egress/t/anthropic/v1', apiKey: '{env:ANTHROPIC_API_KEY}' } } },
    });
  });
});

describe('the plugin against a hook server', () => {
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
      const settings = buildOpencodeSettings({ hubUrl: `http://127.0.0.1:${port}`, name: 'ana', servers: ['my-files', 'gonogo'], policy: POLICY, subagentLimit: 1 });
      await writeFile(join(tmp, 's.json'), JSON.stringify(settings));
      await writeFile(join(tmp, 'plugin.mjs'), OPENCODE_PLUGIN_SOURCE);
      process.env.GONOGO_OPENCODE_CONFIG = join(tmp, 's.json');
      process.env.GONOGO_TOKEN = 'tok';
      const replies: Array<{ id: string; response: string }> = [];
      const prompts: string[] = [];
      const client = {
        postSessionIdPermissionsPermissionId: async ({ path, body }: { path: { permissionID: string }; body: { response: string } }) => void replies.push({ id: path.permissionID, response: body.response }),
        session: { promptAsync: async ({ body }: { body: { parts: Array<{ text: string }> } }) => void prompts.push(body.parts[0]?.text ?? '') },
      };
      const mod = (await import(join(tmp, 'plugin.mjs'))) as { Gonogo: (input: unknown) => Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> };
      const hooks = await mod.Gonogo({ client });
      const event = (type: string, properties: Record<string, unknown>) => hooks.event?.({ event: { type, properties } });
      await new Promise((done) => setTimeout(done, 100));

      await hooks['chat.message']?.({ sessionID: 'ses_main' }, { parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'ctx', synthetic: true }] });
      // a command asks: opencode's question is passed on to the Director
      await hooks['tool.execute.before']?.({ tool: 'bash', sessionID: 'ses_main', callID: 'c1' }, { args: { command: 'ls' } });
      await event('permission.asked', { id: 'per1', sessionID: 'ses_main', permission: 'bash', tool: { callID: 'c1' } });
      await event('permission.replied', { sessionID: 'ses_main', requestID: 'per1', reply: 'once' });
      await hooks['tool.execute.after']?.({ tool: 'bash', sessionID: 'ses_main', callID: 'c1', args: { command: 'ls' } }, { metadata: {} });
      // a read is allowed by the mode: the plugin answers opencode itself
      await hooks['tool.execute.before']?.({ tool: 'read', sessionID: 'ses_main', callID: 'c2' }, { args: { filePath: '/work/a.ts' } });
      await event('permission.asked', { id: 'per2', sessionID: 'ses_main', permission: 'read', tool: { callID: 'c2' } });
      // a denied read never runs
      await expect(hooks['tool.execute.before']?.({ tool: 'read', sessionID: 'ses_main', callID: 'c3' }, { args: { filePath: '/work/.env' } })).rejects.toThrow('gonogo: denied by the rule Read(./.env)');
      // an MCP tool is named as Claude Code names it
      await hooks['tool.execute.before']?.({ tool: 'my-files_read_file', sessionID: 'ses_main', callID: 'c4' }, { args: {} });
      await hooks['tool.execute.before']?.({ tool: 'gonogo_send_message', sessionID: 'ses_main', callID: 'c5' }, { args: {} });
      await event('permission.asked', { id: 'per5', sessionID: 'ses_main', permission: 'gonogo_send_message', tool: { callID: 'c5' } });
      // a subagent: its own session's prompt, tools and end are not the agent's turn; a second one at once is over the room's limit
      await hooks['tool.execute.before']?.({ tool: 'task', sessionID: 'ses_main', callID: 't1' }, { args: { subagent_type: 'general', prompt: 'p' } });
      await expect(hooks['tool.execute.before']?.({ tool: 'task', sessionID: 'ses_main', callID: 't2' }, { args: {} })).rejects.toThrow('the room allows 1 subagents at once');
      await event('session.created', { info: { id: 'ses_child', parentID: 'ses_main' } });
      await hooks['chat.message']?.({ sessionID: 'ses_child' }, { parts: [{ type: 'text', text: 'p' }] });
      await event('session.idle', { sessionID: 'ses_child' });
      await hooks['tool.execute.after']?.({ tool: 'task', sessionID: 'ses_main', callID: 't1', args: {} }, { metadata: {} });
      // usage of a finished reply, counted once
      const info = { id: 'msg1', role: 'assistant', modelID: 'm', time: { completed: 5 }, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 7, write: 3 } } };
      await event('message.updated', { info });
      await event('message.updated', { info });
      // the end of the turn: mail goes to the same session as the next prompt, which is not the Director's
      await event('session.idle', { sessionID: 'ses_main' });
      await new Promise((done) => setTimeout(done, 50));
      expect(prompts).toStrictEqual(['You have mail.']);
      await hooks['chat.message']?.({ sessionID: 'ses_main' }, { parts: [{ type: 'text', text: 'You have mail.' }] });
      stop = {};
      await event('session.idle', { sessionID: 'ses_main' });

      expect(replies).toStrictEqual([
        { id: 'per2', response: 'once' },
        { id: 'per5', response: 'once' },
      ]);
      expect(posts.map((post) => post.url)).toStrictEqual([
        'Notification',
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest',
        'Notification',
        'PostToolUse',
        'PreToolUse',
        'PreToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'PreToolUse',
        'PreToolUse',
        'SubagentStart',
        'PreToolUse',
        'PostToolUseFailure',
        'SubagentStop',
        'PostToolUse',
        'Stop',
        'Stop',
      ]);
      expect(posts[1]?.body).toStrictEqual({ prompt: 'hello', session_id: 'ses_main' });
      expect(posts[3]?.body).toStrictEqual({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      expect(posts[4]?.body).toStrictEqual({ notification_type: 'permission_answered' });
      expect(posts[9]?.body).toStrictEqual({ tool_name: 'mcp__my-files__read_file', tool_input: {} });
      expect(posts[12]?.body).toStrictEqual({ agent_id: 't1', agent_type: 'general' });
      expect(posts[17]?.body).toStrictEqual({ session_id: 'ses_main', usage: [{ id: 'msg1', at: 5, model: 'm', i: 10, cw: 3, o: 25, cr: 7 }] });
      expect(posts[18]?.body).toStrictEqual({ session_id: 'ses_main' });
    } finally {
      if (saved.config === undefined) delete process.env.GONOGO_OPENCODE_CONFIG;
      else process.env.GONOGO_OPENCODE_CONFIG = saved.config;
      if (saved.token === undefined) delete process.env.GONOGO_TOKEN;
      else process.env.GONOGO_TOKEN = saved.token;
      server.close();
    }
  });
});
