/**
 * Engine Bay additions (docs/engine-bay-spec.md): the model of an agent, its keys (Clearance) in the child's environment, and
 * Pad Check (`gonogo doctor`). No agent CLI runs; the programs asked for their version are shell scripts of this test.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord, EngineCheck, Provider } from '../src/shared/protocol.js';
import { PROVIDER_INFO, PROVIDERS } from '../src/shared/protocol.js';
import { buildArgv, buildChildEnv, createLauncher } from '../src/server/launcher.js';
import { checkEngines, findOnPath, formatDoctor, versionLine } from '../src/server/providers.js';
import { cleanRoomEnv, fakeDockerBin, makeRepo } from './clean-room-helpers.js';
import { parseArgs, USAGE } from '../src/server/cli.js';
import { DOCS_URL } from '../src/shared/protocol.js';

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';
const HUB = 'http://127.0.0.1:7777';
const START = { generation: 1, flag: null } as const;
const SECRET = 'sk-test-secret-value-1234';

let tmp: string;
let home: string;
let work: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-engines-'));
  home = join(tmp, 'home');
  work = join(tmp, 'work');
  await mkdir(work, { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const agent = (provider: Provider, over: Partial<AgentRecord> = {}): AgentRecord => ({
  name: 'ana',
  role: 'Reviews pull requests.',
  dir: work,
  mode: 'default',
  sessionId: SID,
  desk: 1,
  boss: false,
  createdAt: 1,
  ...(provider === 'claude' ? {} : { provider }),
  ...over,
});
const launcher = (extra: { env?: Record<string, string>; keys?: (name: string) => Record<string, string>; seed?: boolean } = {}) =>
  createLauncher({ homeDir: home, hubUrl: () => HUB, seed: extra.seed ?? false, env: { PATH: '/usr/bin:/bin', HOME: join(tmp, 'user'), ...extra.env }, keys: extra.keys });

describe('PROVIDER_INFO: model, install and docs', () => {
  it('the engines with a model setting are the ones whose `--model` was checked, and custom has none', () => {
    expect(PROVIDERS.filter((p) => PROVIDER_INFO[p].model !== null).sort()).toEqual(['antigravity', 'claude', 'codex', 'cursor', 'gemini', 'kimi', 'pi']);
    expect(PROVIDER_INFO.custom).toMatchObject({ model: null, install: null, docs: '' });
  });

  it('every engine has a page that says how to install it, and no install command runs anything but what the vendor wrote', () => {
    for (const p of PROVIDERS.filter((x) => x !== 'custom')) {
      expect(PROVIDER_INFO[p].docs, p).toMatch(/^https:\/\//);
      const install = PROVIDER_INFO[p].install;
      if (install !== null) expect(install, p).not.toMatch(/[\n;]/);
    }
  });
});

describe('the effort on the command line', () => {
  const base = { flag: 'session-id', sessionId: SID, mode: 'default', settingsPath: '/s', mcpPath: '/m', roleText: 'r' } as const;
  it('claude: --effort before the variadic --allowedTools, and never when none is set', () => {
    const args = buildArgv({ ...base, effort: 'xhigh' });
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'xhigh']);
    expect(args.indexOf('--effort')).toBeLessThan(args.indexOf('--allowedTools'));
    expect(buildArgv(base)).not.toContain('--effort');
    expect(buildArgv({ ...base, effort: '' })).not.toContain('--effort');
  });

  it('through the launcher, a restart keeps it, and an agent with none gets none', async () => {
    const l = launcher();
    expect((await l.prepareStart(agent('claude', { effort: 'high' }), START)).spec.args).toContain('--effort');
    const again = (await l.prepareStart(agent('claude', { effort: 'high' }), { generation: 2, flag: 'resume' })).spec.args;
    expect(again[again.indexOf('--effort') + 1]).toBe('high');
    expect((await l.prepareStart(agent('claude'), { generation: 3, flag: null })).spec.args).not.toContain('--effort');
  });
});

describe('the model on the command line', () => {
  it('claude: --model before the variadic --allowedTools, never when none is set', () => {
    const base = { flag: 'session-id', sessionId: SID, mode: 'default', settingsPath: '/s', mcpPath: '/m', roleText: 'r' } as const;
    const withModel = buildArgv({ ...base, model: 'sonnet' });
    expect(withModel.slice(withModel.indexOf('--model'), withModel.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
    expect(withModel.indexOf('--model')).toBeLessThan(withModel.indexOf('--allowedTools'));
    expect(buildArgv(base)).not.toContain('--model');
    expect(buildArgv({ ...base, model: '' })).not.toContain('--model');
  });

  it('claude through the launcher, and a restart keeps it', async () => {
    const l = launcher();
    const { spec } = await l.prepareStart(agent('claude', { model: 'opus' }), START);
    expect(spec.args.slice(spec.args.indexOf('--model'), spec.args.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    const { spec: again } = await l.prepareStart(agent('claude', { model: 'opus' }), { generation: 2, flag: 'resume' });
    expect(again.args).toContain('opus');
    expect((await l.prepareStart(agent('claude'), { generation: 3, flag: null })).spec.args).not.toContain('--model');
  });

  it.each([
    ['gemini', ['--approval-mode', 'default', '--model', 'flash']],
    ['codex', ['--model', 'o-model']],
    ['kimi', ['--mcp-config-file', '*', '--model', 'k-model']],
    ['pi', ['--append-system-prompt', 'Reviews pull requests.', '--model', 'sonnet:high']],
    ['cursor', ['--model', 'c-model']],
  ] as Array<[Provider, string[]]>)('%s takes it as one argument', async (provider, expected) => {
    const model = { gemini: 'flash', codex: 'o-model', kimi: 'k-model', pi: 'sonnet:high', cursor: 'c-model' }[provider as 'gemini'];
    const { spec } = await launcher().prepareStart(agent(provider, { model }), START);
    const joined = spec.args.join('\0');
    for (const word of expected) {
      if (word !== '*') expect(joined, word).toContain(word);
    }
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe(model);
    const none = await launcher().prepareStart(agent(provider, { name: 'ben' }), START);
    expect(none.spec.args).not.toContain('--model');
  });

  it('gemini and codex keep the role last: a prompt after the flags', async () => {
    const gemini = (await launcher().prepareStart(agent('gemini', { model: 'pro' }), START)).spec.args;
    expect(gemini.slice(-2, -1)).toEqual(['--prompt-interactive']);
    const codex = (await launcher().prepareStart(agent('codex', { model: 'x1' }), START)).spec.args;
    expect(codex[codex.length - 1]).toContain('Reviews pull requests.');
    expect(codex.indexOf('--model')).toBeLessThan(codex.length - 1);
  });

  it('a name that looks like a flag is a value, not an option: the hub refuses it, and the launcher still passes it as one word', async () => {
    const { spec } = await launcher().prepareStart(agent('codex', { model: 'a b;c' }), START);
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('a b;c');
  });

  it('an engine without a model setting gets no flag even if a roster says so', async () => {
    const { spec } = await launcher().prepareStart(agent('opencode'), START);
    expect(spec.args).not.toContain('--model');
  });
});

describe('Clearance: keys in the environment of one agent', () => {
  it('buildChildEnv: a key beats the same name of the host, GONOGO_SCRUB_ENV does not take it away, others stay', () => {
    const env = buildChildEnv({
      base: { PATH: '/bin', OPENAI_API_KEY: 'from-the-host', GEMINI_API_KEY: 'host-gemini', GONOGO_SCRUB_ENV: 'OPENAI_API_KEY,GEMINI_API_KEY' },
      token: 't',
      seed: false,
      keys: { OPENAI_API_KEY: SECRET },
    });
    expect(env.OPENAI_API_KEY).toBe(SECRET);
    // the host's own value of a scrubbed name is still gone
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GONOGO_TOKEN).toBe('t');
  });

  it('buildChildEnv: without keys it is what it was', () => {
    expect(buildChildEnv({ base: { PATH: '/bin', A: '1' }, token: null, seed: false })).toMatchObject({ PATH: '/bin', A: '1' });
  });

  it('claude gets its own keys only: another agent has none of them, and the host environment is the base', async () => {
    const keys = (name: string): Record<string, string> => (name === 'ana' ? { OPENAI_API_KEY: SECRET } : {});
    const l = launcher({ keys, env: { OPENAI_API_KEY: 'host-value', OTHER: 'x' } });
    const ana = await l.prepareStart(agent('claude'), START);
    expect(ana.spec.env.OPENAI_API_KEY).toBe(SECRET);
    expect(ana.spec.env.OTHER).toBe('x');
    const ben = await l.prepareStart(agent('claude', { name: 'ben' }), START);
    expect(ben.spec.env.OPENAI_API_KEY).toBe('host-value');
  });

  it('no key is written to a file of the agent or to the command line', async () => {
    const l = launcher({ keys: () => ({ OPENAI_API_KEY: SECRET }) });
    const { spec } = await l.prepareStart(agent('claude'), START);
    expect(spec.args.join('\n')).not.toContain(SECRET);
    for (const file of ['settings.json', 'mcp.json', 'token', 'memory.md']) {
      expect(await readFile(join(home, 'agents', 'ana', file), 'utf8'), file).not.toContain(SECRET);
    }
  });

  it('another engine and a custom command get them too', async () => {
    const l = launcher({ keys: () => ({ GEMINI_API_KEY: SECRET }) });
    expect((await l.prepareStart(agent('gemini'), START)).spec.env.GEMINI_API_KEY).toBe(SECRET);
    expect((await l.prepareStart(agent('custom', { command: 'htop', name: 'ben' }), START)).spec.env.GEMINI_API_KEY).toBe(SECRET);
    expect((await l.prepareStart(agent('pi', { name: 'cat' }), START)).spec.env.GEMINI_API_KEY).toBe(SECRET);
  });

  it('an engine adapter variable of gonogo wins over a key of the same name', async () => {
    const l = launcher({ keys: () => ({ OPENCODE_CONFIG: '/evil.json' }) });
    const { spec } = await l.prepareStart(agent('opencode'), START);
    expect(spec.env.OPENCODE_CONFIG).toBe(join(home, 'agents', 'ana', 'opencode.json'));
  });

  it('seed mode: a key ANTHROPIC_API_KEY goes through the key helper like the host one, and never stays as ANTHROPIC_API_KEY', async () => {
    const l = launcher({ seed: true, keys: () => ({ ANTHROPIC_API_KEY: SECRET }) });
    const { spec } = await l.prepareStart(agent('claude'), START);
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec.env.GONOGO_API_KEY).toBe(SECRET);
    expect(JSON.parse(await readFile(join(home, 'agents', 'ana', 'settings.json'), 'utf8')).apiKeyHelper).toBe('printenv GONOGO_API_KEY');
  });

  it('a Clean Room: the container gets the key by name only, and the value is in docker\'s own environment', async () => {
    const repo = join(tmp, 'repo');
    await mkdir(repo);
    await makeRepo(repo);
    const bin = await fakeDockerBin(tmp);
    const env = cleanRoomEnv(bin, { AWS_SECRET_ACCESS_KEY: 'not-for-the-container', OPENAI_API_KEY: 'host-openai' });
    const l = createLauncher({ homeDir: home, hubUrl: () => HUB, seed: false, env, keys: () => ({ OPENAI_API_KEY: SECRET, XAI_API_KEY: 'other-secret-value' }) });
    const { spec } = await l.prepareStart(agent('claude', { dir: repo, cleanRoom: {} }), START);
    expect(spec.file).toBe('docker');
    const named = spec.args.flatMap((arg, i) => (spec.args[i - 1] === '-e' && !arg.includes('=') ? [arg] : []));
    expect(named).toContain('OPENAI_API_KEY');
    expect(named).toContain('XAI_API_KEY');
    expect(named).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(spec.env.OPENAI_API_KEY).toBe(SECRET);
    expect(spec.env.XAI_API_KEY).toBe('other-secret-value');
    const line = spec.args.join('\n');
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('other-secret-value');
    expect(line).not.toContain('host-openai');
    // each name once
    expect(named.filter((n) => n === 'OPENAI_API_KEY')).toHaveLength(1);
  });
});

describe('Pad Check', () => {
  const script = (body: string): string => `#!/bin/sh\n${body}\n`;
  async function bins(): Promise<string> {
    const dir = join(tmp, 'bin');
    await mkdir(dir, { recursive: true });
    const make = async (name: string, body: string): Promise<void> => {
      await writeFile(join(dir, name), script(body));
      await chmod(join(dir, name), 0o755);
    };
    await make('claude', 'echo "2.1.325 (Claude Code)"');
    await make('gemini', 'echo "0.59.0 secret=${GEMINI_API_KEY:-none}"');
    await make('codex', 'sleep 30');
    await make('pi', 'printf "\\033[1mpi\\033[0m 1.5.2\\n"');
    await make('kimi', 'exit 3');
    // not executable
    await writeFile(join(dir, 'grok'), script('echo hi'));
    return dir;
  }

  it('versionLine: the first line with something in it, no control characters, cut to 80', () => {
    expect(versionLine('\n\n 1.2.3 (x)\nmore')).toBe('1.2.3 (x)');
    expect(versionLine('\u001b[1mpi\u001b[0m 1.5.2')).toBe('pi 1.5.2');
    expect(versionLine('\u001b]0;title\u0007x 1.0\u009b31m\u202e')).toBe('x 1.031m');
    expect(versionLine('x'.repeat(200))).toHaveLength(80);
    expect(versionLine('')).toBeNull();
    expect(versionLine('\n \n')).toBeNull();
  });

  it('findOnPath: the first executable file, null for a missing or a non-executable one or an empty name', async () => {
    const dir = await bins();
    expect(findOnPath('claude', `/nowhere${delimiter}${dir}`)).toBe(join(dir, 'claude'));
    expect(findOnPath('grok', dir)).toBeNull();
    expect(findOnPath('nope', dir)).toBeNull();
    expect(findOnPath('', dir)).toBeNull();
    expect(findOnPath('claude', undefined)).toBeNull();
    expect(findOnPath('claude', '')).toBeNull();
  });

  it('checkEngines: where each engine is, its version, and the install command of one that is missing', async () => {
    const dir = await bins();
    const checks = await checkEngines({ PATH: dir, HOME: tmp, GEMINI_API_KEY: SECRET });
    expect(checks.map((c) => c.provider)).toEqual(PROVIDERS.filter((p) => p !== 'custom'));
    const by = (p: string): EngineCheck => checks.find((c) => c.provider === p) as EngineCheck;
    expect(by('claude')).toMatchObject({ path: join(dir, 'claude'), version: '2.1.325 (Claude Code)', bin: 'claude' });
    // the program is asked its version with PATH, HOME and LANG only: a key of gonogo's environment does not reach it
    expect(by('gemini').version).toBe('0.59.0 secret=none');
    expect(by('pi').version).toContain('1.5.2');
    expect(by('kimi')).toMatchObject({ path: join(dir, 'kimi'), version: null });
    expect(by('grok')).toMatchObject({ path: null, version: null, install: PROVIDER_INFO.grok.install });
    expect(by('opencode')).toMatchObject({ path: null, install: PROVIDER_INFO.opencode.install, docs: PROVIDER_INFO.opencode.docs });
  }, 20_000);

  it('a program that does not answer in time is found, with no version, and the check goes on', async () => {
    const dir = await bins();
    const started = Date.now();
    const checks = await checkEngines({ PATH: dir, HOME: tmp });
    expect(checks.find((c) => c.provider === 'codex')).toMatchObject({ path: join(dir, 'codex'), version: null });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('formatDoctor: ok lines, then the install command and page of each missing engine, and the note that nothing is run', () => {
    const text = formatDoctor(
      [
        { provider: 'claude', label: 'Claude Code', bin: 'claude', path: '/bin/claude', version: '2.1.325', install: 'curl x | bash', docs: 'https://a.example' },
        { provider: 'codex', label: 'Codex', bin: 'codex', path: null, version: null, install: 'npm install -g @openai/codex', docs: 'https://b.example' },
        { provider: 'kimi', label: 'Kimi CLI', bin: 'kimi', path: null, version: null, install: null, docs: 'https://c.example' },
        { provider: 'pi', label: 'pi', bin: 'pi', path: '/bin/pi', version: null, install: 'x', docs: 'https://d.example' },
      ],
      null,
    );
    expect(text).toContain('ok  Claude Code (claude)  2.1.325  /bin/claude');
    expect(text).toContain('--  Codex (codex)  not found\n    install: npm install -g @openai/codex\n    docs: https://b.example');
    expect(text).toContain('--  Kimi CLI (kimi)  not found\n    no install command was checked; see https://c.example');
    expect(text).toContain('ok  pi (pi)  no version printed  /bin/pi');
    expect(text).toContain('doctor never runs an install command');
    expect(text).not.toContain('GONOGO_AGENT_CMD');
    expect(formatDoctor([], 'node fake.mjs')).toContain('GONOGO_AGENT_CMD is set (node fake.mjs): it replaces claude.');
  });
});

describe('the command line: doctor, update and the opt-out', () => {
  it('doctor and update stand alone', () => {
    expect(parseArgs(['doctor'])).toEqual({ kind: 'doctor' });
    // live reload
    expect(parseArgs(['reload'])).toEqual({ kind: 'reload' });
    expect(parseArgs(['reload', '--home', '/h'])).toEqual({ kind: 'reload', home: '/h' });
    expect(parseArgs(['reload', '--port', '1'])).toEqual({ kind: 'error', message: 'reload takes only --home <dir>' });
    expect(parseArgs(['ptyhost', '--home', '/h'])).toEqual({ kind: 'ptyhost', home: '/h' });
    expect(parseArgs(['ptyhost'])).toEqual({ kind: 'error', message: 'ptyhost needs --home <dir>' });
    expect(parseArgs(['--pty-host'])).toEqual({ kind: 'run', options: { ptyHost: true } });
    expect(parseArgs([])).toEqual({ kind: 'run', options: {} });
    expect(parseArgs(['update'])).toEqual({ kind: 'update' });
    expect(parseArgs(['doctor', '--port', '1'])).toEqual({ kind: 'error', message: 'doctor takes no arguments' });
    expect(parseArgs(['update', 'now'])).toEqual({ kind: 'error', message: 'update takes no arguments' });
    expect(parseArgs(['--port=1', 'doctor'])).toEqual({ kind: 'error', message: 'unknown option doctor' });
    expect(parseArgs(['doctor', '--help'])).toEqual({ kind: 'help' });
  });

  it('--no-update-check turns the check off; without it the option is not there (the environment decides)', () => {
    expect(parseArgs(['--no-update-check'])).toEqual({ kind: 'run', options: { updateCheck: false } });
    expect(parseArgs(['--port=1', '--no-update-check', '--seed-claude'])).toEqual({ kind: 'run', options: { port: 1, updateCheck: false, seed: true } });
    expect(parseArgs(['--no-update-check=1'])).toEqual({ kind: 'error', message: 'unknown option --no-update-check=1' });
    expect(parseArgs([])).toEqual({ kind: 'run', options: {} });
  });

  it('the usage and the doctor name the online docs', () => {
    expect(DOCS_URL).toBe('https://gonogo.ulm0.com/');
    expect(USAGE).toContain(`Docs: ${DOCS_URL}`);
    expect(formatDoctor([], null)).toContain(`docs: ${DOCS_URL}`);
  });

  it('the usage names the commands, the flag and the variable', () => {
    for (const word of ['gonogo doctor', 'gonogo update', '--no-update-check', 'GONOGO_UPDATE_CHECK']) expect(USAGE, word).toContain(word);
  });
});
