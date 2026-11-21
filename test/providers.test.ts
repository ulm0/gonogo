/**
 * Engine Bay (docs/engine-bay-spec.md): the start of each other agent CLI, the Gemini hook shim against a local server,
 * and the PATH check of the hire form. No agent CLI runs here.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord, Launcher, Provider } from '../src/shared/protocol.js';
import { buildRoleText, createLauncher } from '../src/server/launcher.js';
import { AGY_HOOK_SHIM, AGY_MODES, buildAgyHooks, buildGeminiSettings, GEMINI_HOOKS, GEMINI_SETTINGS_FILE, HOOK_SHIM, installedProviders, shellQuote } from '../src/server/providers.js';

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';
const HUB = 'http://127.0.0.1:7777';
const START = { generation: 1, flag: null } as const;

let tmp: string;
let home: string;
let work: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-providers-'));
  home = join(tmp, 'home');
  work = join(tmp, 'work');
  await mkdir(work, { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const launcher = (seed = false): Launcher =>
  createLauncher({ homeDir: home, hubUrl: () => HUB, seed, env: { PATH: '/usr/bin:/bin', HOME: join(tmp, 'user') }, coauthor: () => ({ enabled: false, prFooter: false }) });
const agent = (provider: Provider, over: Partial<AgentRecord> = {}): AgentRecord => ({
  name: 'ana',
  role: 'Reviews pull requests.',
  dir: work,
  mode: 'default',
  sessionId: SID,
  desk: 1,
  boss: false,
  createdAt: 1,
  provider,
  ...over,
});
const agentDir = (): string => join(home, 'agents', 'ana');
const roleText = (): string => buildRoleText('ana', 'Reviews pull requests.', join(agentDir(), 'memory.md'));

describe('prepareStart for another agent CLI', () => {
  it('the PR footer is Claude Code\'s setting: with it on in the room, another engine\'s files carry no attribution', async () => {
    const on = createLauncher({ homeDir: home, hubUrl: () => HUB, seed: false, env: { PATH: '/usr/bin:/bin', HOME: join(tmp, 'user') }, coauthor: () => ({ enabled: false, prFooter: true }) });
    await on.prepareStart(agent('gemini'), START);
    for (const file of await readdir(agentDir())) {
      const text = await readFile(join(agentDir(), file), 'utf8').catch(() => '');
      expect(text, file).not.toContain('attribution');
      expect(text, file).not.toContain('gonogo.ulm0.com');
    }
  });

  it('gemini: its own settings file through GEMINI_CLI_SYSTEM_SETTINGS_PATH, hooks to the hub, the role as the first prompt', async () => {
    const l = launcher();
    const prepared = await l.prepareStart(agent('gemini'), START);
    const { spec } = prepared;
    expect(spec.file).toBe('gemini');
    expect(spec.args).toStrictEqual(['--approval-mode', 'default', '--prompt-interactive', roleText()]);
    expect(spec.cwd).toBe(work);
    const settingsPath = join(agentDir(), GEMINI_SETTINGS_FILE);
    expect(spec.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(settingsPath);
    expect(spec.env.GONOGO_TOKEN).toBe(prepared.token);
    expect(spec.env.IS_DEMO).toBeUndefined();
    expect(l.resolveToken(prepared.token)).toEqual({ agent: 'ana', generation: 1 });
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      mcpServers: Record<string, { httpUrl: string; headers: Record<string, string>; trust: boolean }>;
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    };
    expect(settings.mcpServers.gonogo).toStrictEqual({ httpUrl: `${HUB}/mcp`, headers: { Authorization: 'Bearer ${GONOGO_TOKEN}' }, trust: true });
    expect(Object.keys(settings.hooks)).toStrictEqual(Object.keys(GEMINI_HOOKS));
    const stop = settings.hooks.AfterAgent[0].hooks[0];
    expect(stop.type).toBe('command');
    expect(stop.command).toContain(shellQuote(`${HUB}/hook/ana/Stop`));
    expect(stop.command).toContain(shellQuote(join(agentDir(), 'token')));
    // Nothing goes into the owner's project or their home.
    expect(await readdir(work)).toStrictEqual([]);
    expect((await readdir(agentDir())).sort()).toStrictEqual([GEMINI_SETTINGS_FILE, 'memory.md', 'token']);
  });

  it('gemini: the permission modes map onto its approval modes, and seed mode trusts the folder for the run only', async () => {
    const l = launcher(true);
    expect((await l.prepareStart(agent('gemini', { mode: 'acceptEdits' }), START)).spec.args.slice(0, 2)).toStrictEqual(['--approval-mode', 'auto_edit']);
    const bypass = await l.prepareStart(agent('gemini', { mode: 'bypassPermissions' }), START);
    expect(bypass.spec.args.slice(0, 3)).toStrictEqual(['--approval-mode', 'yolo', '--skip-trust']);
    expect(bypass.spec.env.IS_DEMO).toBeUndefined();
  });

  it('codex: the gonogo server through -c overrides for this run, the mode as its flags, the role as the prompt', async () => {
    const { spec } = await launcher().prepareStart(agent('codex', { mode: 'bypassPermissions' }), START);
    expect(spec.file).toBe('codex');
    expect(spec.args).toStrictEqual([
      '-c',
      `mcp_servers.gonogo.url="${HUB}/mcp"`,
      '-c',
      'mcp_servers.gonogo.bearer_token_env_var="GONOGO_TOKEN"',
      '--dangerously-bypass-approvals-and-sandbox',
      roleText(),
    ]);
    expect(spec.env.CODEX_HOME).toBeUndefined();
  });

  it('opencode, kimi and copilot: a config file in the agent folder; kimi and copilot carry the token, mode 0600', async () => {
    const l = launcher();
    const open = await l.prepareStart(agent('opencode'), START);
    expect(open.spec.env.OPENCODE_CONFIG).toBe(join(agentDir(), 'opencode.json'));
    expect(open.spec.args).toStrictEqual(['--prompt', roleText()]);
    expect(JSON.parse(await readFile(join(agentDir(), 'opencode.json'), 'utf8'))).toStrictEqual({
      mcp: { gonogo: { type: 'remote', url: `${HUB}/mcp`, headers: { Authorization: 'Bearer {env:GONOGO_TOKEN}' }, enabled: true } },
    });
    const kimi = await l.prepareStart(agent('kimi'), START);
    expect(kimi.spec.args).toStrictEqual(['--mcp-config-file', join(agentDir(), 'kimi-mcp.json')]);
    const kimiFile = join(agentDir(), 'kimi-mcp.json');
    expect(JSON.parse(await readFile(kimiFile, 'utf8'))).toStrictEqual({
      mcpServers: { gonogo: { type: 'http', url: `${HUB}/mcp`, headers: { Authorization: `Bearer ${kimi.token}` } } },
    });
    expect((await stat(kimiFile)).mode & 0o777).toBe(0o600);
    const copilot = await l.prepareStart(agent('copilot'), START);
    expect(copilot.spec.args).toStrictEqual(['--additional-mcp-config', `@${join(agentDir(), 'copilot-mcp.json')}`]);
    expect(JSON.parse(await readFile(join(agentDir(), 'copilot-mcp.json'), 'utf8')).mcpServers.gonogo.tools).toStrictEqual(['*']);
  });

  it('Payload: gemini and kimi get the servers beside gonogo in their own file; gemini trusts only the gonogo tools; no skills are written', async () => {
    const l = launcher();
    const servers = { files: { command: 'npx', args: ['-y', 'x'], env: { ROOT: '/work' } }, remote: { type: 'http' as const, url: 'https://example.test/mcp', headers: { Authorization: 'Bearer abc' } } };
    await l.prepareStart(agent('gemini', { payload: { mcpServers: servers } }), START);
    const gemini = JSON.parse(await readFile(join(agentDir(), GEMINI_SETTINGS_FILE), 'utf8')) as { mcpServers: Record<string, { trust?: boolean }> };
    expect(Object.keys(gemini.mcpServers)).toEqual(['files', 'remote', 'gonogo']);
    expect(gemini.mcpServers.files).toEqual(servers.files);
    expect(gemini.mcpServers.remote).toEqual(servers.remote);
    expect(gemini.mcpServers.gonogo.trust).toBe(true);
    expect(gemini.mcpServers.files).not.toHaveProperty('trust');
    const kimi = await l.prepareStart(agent('kimi', { payload: { mcpServers: servers } }), START);
    const file = JSON.parse(await readFile(join(agentDir(), 'kimi-mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(file.mcpServers)).toEqual(['files', 'remote', 'gonogo']);
    expect(file.mcpServers.files).toEqual(servers.files);
    expect(kimi.spec.args).toStrictEqual(['--mcp-config-file', join(agentDir(), 'kimi-mcp.json')]);
    expect((await readdir(agentDir())).filter((name) => name.includes('plugin'))).toEqual([]);
  });

  it('pi gets the bare role in its system prompt; the screen-only CLIs are started by name alone', async () => {
    const l = launcher();
    expect((await l.prepareStart(agent('pi'), START)).spec).toMatchObject({ file: 'pi', args: ['--append-system-prompt', 'Reviews pull requests.'] });
    for (const provider of ['qwen', 'grok', 'crush'] as const) {
      expect((await l.prepareStart(agent(provider), START)).spec).toMatchObject({ file: provider, args: [] });
    }
    expect((await l.prepareStart(agent('cursor'), START)).spec).toMatchObject({ file: 'cursor-agent', args: [] });
  });
});

describe('the Gemini hook shim', () => {
  const runShim = (url: string, tokenFile: string, input: string): Promise<string> =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, ['-e', HOOK_SHIM, url, tokenFile], { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', fail);
      child.on('close', () => done(out));
      child.stdin.end(input);
    });

  it('forwards the fields the hub reads with the token from the file and prints the answer', async () => {
    const seen: Array<{ url: string | undefined; auth: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"decision":"block","reason":"gonogo: 1 new message from user. Call read_messages."}');
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    try {
      const { port } = server.address() as AddressInfo;
      const tokenFile = join(tmp, 'token');
      await writeFile(tokenFile, 'abc123\n');
      const input = JSON.stringify({ hook_event_name: 'AfterAgent', prompt: 'p', prompt_response: 'long', transcript_path: '/t.json', session_id: SID });
      const out = await runShim(`http://127.0.0.1:${port}/hook/ana/Stop`, tokenFile, input);
      expect(JSON.parse(out)).toStrictEqual({ decision: 'block', reason: 'gonogo: 1 new message from user. Call read_messages.' });
      expect(seen).toStrictEqual([{ url: '/hook/ana/Stop', auth: 'Bearer abc123', body: { prompt: 'p' } }]);
    } finally {
      server.close();
    }
  });

  it('the command in the settings file runs through a shell as one word per argument, even with a space in the path', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization }));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    try {
      const { port } = server.address() as AddressInfo;
      const tokenFile = join(tmp, 'my dir', 'token');
      await mkdir(join(tmp, 'my dir'));
      await writeFile(tokenFile, 'abc123\n');
      const settings = buildGeminiSettings({ hubUrl: `http://127.0.0.1:${port}`, name: 'ana', tokenFile }) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const command = settings.hooks.BeforeTool[0].hooks[0].command;
      const out = await new Promise<string>((done, fail) => {
        const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'inherit'] });
        let text = '';
        child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
        child.on('error', fail);
        child.on('close', () => done(text));
        child.stdin.end('{"tool_name":"ls"}');
      });
      expect(JSON.parse(out)).toStrictEqual({ url: '/hook/ana/PreToolUse', auth: 'Bearer abc123' });
    } finally {
      server.close();
    }
  });

  it('prints {} when the hub cannot be reached, so Gemini goes on', async () => {
    const tokenFile = join(tmp, 'token');
    await writeFile(tokenFile, 'abc123\n');
    expect(await runShim('http://127.0.0.1:9/hook/ana/Stop', tokenFile, '{}')).toBe('{}');
  });

  it('shellQuote keeps a path with spaces and quotes as one word', () => {
    expect(shellQuote("/Volumes/My Disk/it's")).toBe(`'/Volumes/My Disk/it'\\''s'`);
  });
});

describe('installedProviders', () => {
  it('lists the CLIs found on PATH as executable files, claude when GONOGO_AGENT_CMD stands in, and custom always', async () => {
    const bin = join(tmp, 'bin');
    await mkdir(join(bin, 'codex'), { recursive: true }); // a directory is not a program
    await writeFile(join(bin, 'gemini'), '#!/bin/sh\n');
    await chmod(join(bin, 'gemini'), 0o755);
    await writeFile(join(bin, 'pi'), ''); // not executable
    expect(installedProviders(bin, false)).toStrictEqual(['gemini', 'custom']);
    expect(installedProviders(`/nowhere:${bin}`, true)).toStrictEqual(['claude', 'gemini', 'custom']);
    expect(installedProviders(undefined, false)).toStrictEqual(['custom']);
  });
});

describe('the Antigravity (agy) hook shim and hooks.json', () => {
  const runShim = (url: string, tokenFile: string, input: string): Promise<string> =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, ['-e', AGY_HOOK_SHIM, url, tokenFile], { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', fail);
      child.on('close', () => done(out));
      child.stdin.end(input);
    });
  const hub = async (answer: string): Promise<{ port: number; seen: Array<{ url?: string; auth?: string; body: unknown }>; close(): void }> => {
    const seen: Array<{ url?: string; auth?: string; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(answer);
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    return { port: (server.address() as AddressInfo).port, seen, close: () => server.close() };
  };

  it('maps camelCase input to the hub fields, and the hub block to agy continue', async () => {
    const h = await hub('{"decision":"block","reason":"gonogo: 1 new message from user. Call read_messages."}');
    try {
      const tokenFile = join(tmp, 'token');
      await writeFile(tokenFile, 'abc123\n');
      const input = JSON.stringify({ conversationId: 'c1', lastUserInput: 'hello', toolCall: { name: 'run_command', args: { cmd: 'ls' } }, fullyIdle: true });
      const out = await runShim(`http://127.0.0.1:${h.port}/hook/ana/Stop`, tokenFile, input);
      expect(JSON.parse(out)).toStrictEqual({ decision: 'continue', reason: 'gonogo: 1 new message from user. Call read_messages.' });
      expect(h.seen).toStrictEqual([{ url: '/hook/ana/Stop', auth: 'Bearer abc123', body: { prompt: 'hello', tool_name: 'run_command', tool_input: { cmd: 'ls' } } }]);
    } finally {
      h.close();
    }
  });

  it('sends a PostToolUse with an error to PostToolUseFailure, and answers a PreToolUse with a decision', async () => {
    const h = await hub('{}');
    try {
      const tokenFile = join(tmp, 'token');
      await writeFile(tokenFile, 'abc123\n');
      expect(await runShim(`http://127.0.0.1:${h.port}/hook/ana/PostToolUse`, tokenFile, '{"toolCall":{"name":"x"},"error":"boom"}')).toBe('{}');
      expect(await runShim(`http://127.0.0.1:${h.port}/hook/ana/PostToolUse`, tokenFile, '{"toolCall":{"name":"x"}}')).toBe('{}');
      expect(JSON.parse(await runShim(`http://127.0.0.1:${h.port}/hook/ana/PreToolUse`, tokenFile, '{"toolCall":{"name":"x"}}'))).toStrictEqual({ decision: 'allow' });
      expect(h.seen.map((s) => s.url)).toStrictEqual(['/hook/ana/PostToolUseFailure', '/hook/ana/PostToolUse', '/hook/ana/PreToolUse']);
    } finally {
      h.close();
    }
  });

  it('fails open: {} for a Stop, allow for a PreToolUse, when the hub cannot be reached or says nothing', async () => {
    const tokenFile = join(tmp, 'token');
    await writeFile(tokenFile, 'abc123\n');
    expect(await runShim('http://127.0.0.1:9/hook/ana/Stop', tokenFile, '{}')).toBe('{}');
    expect(JSON.parse(await runShim('http://127.0.0.1:9/hook/ana/PreToolUse', tokenFile, '{}'))).toStrictEqual({ decision: 'allow' });
    expect(await runShim('http://127.0.0.1:9/hook/ana/Stop', tokenFile, 'not json')).toBe('{}');
  });

  it('writes hooks.json in agy shape: a matcher wrapper for the tool events, a plain list for the others, timeouts in seconds', () => {
    const hooks = buildAgyHooks({ hubUrl: 'http://127.0.0.1:7777', name: 'ana', tokenFile: '/h/agents/ana/token' }) as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toStrictEqual(['PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
    const wrapped = hooks.PreToolUse[0] as { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> };
    expect(wrapped.matcher).toBe('*');
    expect(wrapped.hooks[0]).toMatchObject({ type: 'command', timeout: 11 });
    expect(wrapped.hooks[0].command).toContain("'http://127.0.0.1:7777/hook/ana/PreToolUse'");
    const plain = hooks.PreInvocation[0] as { type: string; command: string };
    expect(plain.type).toBe('command');
    expect(plain.command).toContain('/hook/ana/UserPromptSubmit');
  });

  it('maps the permission modes onto agy flags', () => {
    expect(AGY_MODES).toStrictEqual({ default: [], acceptEdits: ['--mode', 'accept-edits'], auto: ['--mode', 'auto'], bypassPermissions: ['--dangerously-skip-permissions'] });
  });
});

describe('antigravity (agy) start', () => {
  it('passes the mode, the model and the bare role as -i; no hooks, no MCP, no files in the agent folder', async () => {
    const l = launcher();
    const accept = (await l.prepareStart(agent('antigravity', { mode: 'acceptEdits', model: 'some-model' }), START)).spec;
    expect(accept.file).toBe('agy');
    expect(accept.args.slice(0, 4)).toStrictEqual(['--mode', 'accept-edits', '--model', 'some-model']);
    expect(accept.args.slice(-2, -1)).toStrictEqual(['-i']);
    expect(accept.args.at(-1)).not.toContain('read_messages');
    const bypass = (await l.prepareStart(agent('antigravity', { mode: 'bypassPermissions' }), START)).spec;
    expect(bypass.args[0]).toBe('--dangerously-skip-permissions');
    expect(bypass.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
  });
});
