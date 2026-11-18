/**
 * Launcher tests (contract 10.2): a temp home, no claude, no network. `node:fs/promises.rename` is wrapped so that a test can
 * play the part of a claude that rewrites .claude.json between our write and our read-back (open item O11).
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord, Launcher, LauncherOptions, Logger } from '../src/shared/protocol.js';
import {
  ROLE_PREAMBLE,
  SCRUB_ENV_EXACT,
  SCRUB_ENV_PREFIXES,
  TRUST_VERIFY_ATTEMPTS,
  TRUST_VERIFY_DELAY_MS,
} from '../src/server/constants.js';
import {
  buildArgv,
  buildChildEnv,
  buildMcpConfig,
  buildRoleText,
  buildSettings,
  createLauncher,
  parseAgentCmd,
  transcriptDirName,
} from '../src/server/launcher.js';
import { readCustomCommand } from '../src/server/command.js';
import { shellQuote, STATUS_LINE_SHIM } from '../src/server/providers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';
const SID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HUB = 'http://127.0.0.1:7777';
const ROLE = 'Reviews pull requests.';
const START = { generation: 1, flag: null } as const;
const EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
];

let tmp: string;
let home: string;
let work: string;
let claudeDir: string;
let claudeJson: string;
let fakeHome: string;
let savedHome: string | undefined;
let logs: { log: Logger; lines: { level: string; message: string }[] };

function collector(): typeof logs {
  const lines: { level: string; message: string }[] = [];
  const log: Logger = {
    debug: (message, ...extra) => void lines.push({ level: 'debug', message: [message, ...extra.map(String)].join(' ') }),
    info: (message, ...extra) => void lines.push({ level: 'info', message: [message, ...extra.map(String)].join(' ') }),
    warn: (message, ...extra) => void lines.push({ level: 'warn', message: [message, ...extra.map(String)].join(' ') }),
    error: (message, ...extra) => void lines.push({ level: 'error', message: [message, ...extra.map(String)].join(' ') }),
    child: () => log,
  };
  return { log, lines };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-'));
  home = join(tmp, 'home');
  work = join(tmp, 'work');
  claudeDir = join(tmp, 'claude');
  claudeJson = join(claudeDir, '.claude.json');
  fakeHome = join(tmp, 'userhome');
  await Promise.all([mkdir(home), mkdir(work), mkdir(fakeHome)]);
  // Whatever a test forgets to pin must land in the temp tree, never in the owner's real ~/.claude*
  savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  vi.mocked(rename).mockClear();
  logs = collector();
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  vi.useRealTimers();
  vi.mocked(rename).mockImplementation(fsActual.rename);
  await rm(tmp, { recursive: true, force: true });
});

const baseEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  PATH: '/usr/bin:/bin',
  CLAUDE_CONFIG_DIR: claudeDir,
  ...extra,
});

function launcher(over: Partial<LauncherOptions> = {}): Launcher {
  return createLauncher({ homeDir: home, hubUrl: () => HUB, seed: false, env: baseEnv(), log: logs.log, coauthor: () => ({ enabled: false }), ...over });
}

function seedLauncher(over: Partial<LauncherOptions> = {}): Launcher {
  return launcher({ seed: true, ...over });
}

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  return { name: 'ana', role: ROLE, dir: work, mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...over };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a value that is not an Error: ${String(error)}`);
  }
  throw new Error('expected the promise to reject');
}

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const text = (path: string): Promise<string> => readFile(path, 'utf8');
const json = async (path: string): Promise<unknown> => JSON.parse(await text(path)) as unknown;
const agentFile = (name: string, file: string): string => join(home, 'agents', name, file);
const renamesTo = (file: string): number =>
  vi.mocked(rename).mock.calls.filter(([, to]) => basename(String(to)) === file).length;

/** The same text as ROLE_PREAMBLE with the three placeholders filled, built without String.replace so the test is not the code under test. */
function expectedRole(name: string, role: string, memoryPath: string): string {
  const values: Record<string, string> = { '{name}': name, '{memory}': memoryPath, '{role}': role.trim() };
  return ROLE_PREAMBLE.split(/(\{name\}|\{memory\}|\{role\})/)
    .map((part) => values[part] ?? part)
    .join('');
}

function expectedArgs(
  flag: '--session-id' | '--resume',
  over: { name?: string; mode?: string; role?: string; sessionId?: string } = {},
): string[] {
  const name = over.name ?? 'ana';
  const base = join(home, 'agents', name);
  return [
    flag,
    over.sessionId ?? SID,
    '--permission-mode',
    over.mode ?? 'default',
    '--settings',
    join(base, 'settings.json'),
    '--strict-mcp-config',
    '--mcp-config',
    join(base, 'mcp.json'),
    '--append-system-prompt',
    expectedRole(name, over.role ?? ROLE, join(base, 'memory.md')),
    '--system-prompt-snapshot',
    'off',
    '--allowedTools',
    'mcp__gonogo__send_message',
    'mcp__gonogo__list_roster',
    'mcp__gonogo__read_messages',
    'mcp__gonogo__go_nogo',
    'mcp__gonogo__task_list',
    'mcp__gonogo__task_create',
    'mcp__gonogo__task_update',
    'mcp__gonogo__log_write',
    'mcp__gonogo__log_search',
    'mcp__gonogo__log_read',
    'mcp__gonogo__board_read',
    'mcp__gonogo__board_write',
    'mcp__gonogo__livery_submit',
    'mcp__gonogo__hire_agent',
    'mcp__gonogo__start_agent',
  ];
}

function expectedSettings(hubUrl: string, name: string, memoryPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: 'http',
            url: `${hubUrl}/hook/${name}/${event}`,
            timeout: 10,
            headers: { Authorization: 'Bearer $GONOGO_TOKEN' },
            allowedEnvVars: ['GONOGO_TOKEN'],
          },
        ],
      },
    ];
  }
  return {
    hooks,
    tui: 'fullscreen',
    promptSuggestionEnabled: false,
    crossSessionInbound: 'refuse',
    permissions: {
      deny: ['SendMessage', 'ListAgents'],
      allow: [`Read(//${memoryPath.slice(1)})`, `Edit(//${memoryPath.slice(1)})`],
    },
    ...extra,
  };
}

/** What prepareStart writes: the settings of buildSettings plus the plan-quota status line (docs/quota-spec.md), with no chained command of the Director's. */
function startSettings(hubUrl: string, name: string, memoryPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const command = [process.execPath, '-e', STATUS_LINE_SHIM, `${hubUrl}/hook/${name}/StatusLine`].map(shellQuote).join(' ');
  return { ...expectedSettings(hubUrl, name, memoryPath, extra), statusLine: { type: 'command', command, refreshInterval: 300 } };
}

describe('parseAgentCmd', () => {
  it('returns null for undefined, empty and blank values', () => {
    expect(parseAgentCmd(undefined)).toBeNull();
    expect(parseAgentCmd('')).toBeNull();
    expect(parseAgentCmd('  \t\n ')).toBeNull();
  });

  it('splits the plain form on runs of whitespace', () => {
    expect(parseAgentCmd('node test/fake-claude.mjs')).toStrictEqual(['node', 'test/fake-claude.mjs']);
    expect(parseAgentCmd('  node \t test/fake-claude.mjs   --slow\n')).toStrictEqual(['node', 'test/fake-claude.mjs', '--slow']);
    expect(parseAgentCmd('claude')).toStrictEqual(['claude']);
  });

  it('reads a JSON array so that paths with spaces survive', () => {
    expect(parseAgentCmd('["node","/path with space/fake claude.mjs"]')).toStrictEqual(['node', '/path with space/fake claude.mjs']);
    expect(parseAgentCmd('  [ "claude" ]  ')).toStrictEqual(['claude']);
  });

  it('rejects a JSON form that is broken or is not an array of strings', () => {
    expect(() => parseAgentCmd('["node"')).toThrow(new Error('GONOGO_AGENT_CMD: not a valid JSON array'));
    expect(() => parseAgentCmd('[')).toThrow(new Error('GONOGO_AGENT_CMD: not a valid JSON array'));
    for (const bad of ['[]', '[1]', '["node", 2]', '[["node"]]', '[null]']) {
      expect(() => parseAgentCmd(bad)).toThrow(new Error('GONOGO_AGENT_CMD: expected a JSON array of one or more strings'));
    }
  });
});

describe('parseAgentCmd and readCustomCommand: the NUL rule and the neutral reasons', () => {
  it('refuses a NUL character in either form', () => {
    expect(() => parseAgentCmd('sh -c \u0000')).toThrow(new Error('GONOGO_AGENT_CMD: the command cannot contain a NUL character'));
    // the JSON escape for NUL (a backslash, u and four zeros) is caught after the array is parsed
    expect(() => parseAgentCmd(String.raw`["sh","a\u0000b"]`)).toThrow(new Error('GONOGO_AGENT_CMD: the command cannot contain a NUL character'));
  });

  it('readCustomCommand returns the words, or an error that does not name the environment variable', () => {
    expect(readCustomCommand('node a.js')).toStrictEqual(['node', 'a.js']);
    expect(readCustomCommand('["node","a b.js"]')).toStrictEqual(['node', 'a b.js']);
    for (const [bad, reason] of [
      ['', 'it is empty'],
      ['  ', 'it is empty'],
      ['[""]', 'it is empty'],
      ['["a"', 'not a valid JSON array'],
      ['[1]', 'expected a JSON array of one or more strings'],
      ['sh \u0000', 'the command cannot contain a NUL character'],
    ] as const) {
      expect(() => readCustomCommand(bad), bad).toThrow(new Error(`the command is not usable: ${reason}`));
    }
  });
});

describe('transcriptDirName', () => {
  it('replaces every character that is not an ASCII letter or digit', () => {
    expect(transcriptDirName('/Volumes/Work Disk/.tmp/build-7/-Users-x/proj-b')).toBe(
      '-Volumes-Work-Disk--tmp-build-7--Users-x-proj-b',
    );
    expect(transcriptDirName('/a/ü/é_9')).toBe('-a-----9');
    expect(transcriptDirName('')).toBe('');
  });
});

describe('buildRoleText', () => {
  const memory = '/h/agents/ana/memory.md';

  it('fills the preamble with the name, the memory path and the trimmed role', () => {
    const out = buildRoleText('ana', '\n  Reviews pull requests.  \n', memory);
    expect(out).toBe(expectedRole('ana', ROLE, memory));
    expect(out.startsWith('You are "ana", an agent in a gonogo operations room: a team of Claude Code agents run by one human owner.\n')).toBe(true);
    expect(out).toContain(`Your memory file is ${memory}. Read it when you start.`);
    expect(out.endsWith('\nYour role:\nReviews pull requests.')).toBe(true);
    expect(out).not.toMatch(/\{(name|memory|role)\}/);
  });

  it('keeps $&, $$, $\' and $` of the role as they are', () => {
    const role = 'Budget is $$5 and cost $& more; $\' then $` then $1 and $<x>.';
    const out = buildRoleText('ana', role, memory);
    expect(out).toContain(role);
    expect(out).toBe(expectedRole('ana', role, memory));
  });

  it('does not expand placeholders that the owner wrote inside the role', () => {
    const role = 'Read {memory} first, you are {name}, your role is {role}.';
    const out = buildRoleText('ana', role, memory);
    expect(out.endsWith(`\nYour role:\n${role}`)).toBe(true);
    expect(out).toBe(expectedRole('ana', role, memory));
    expect(out.split('{memory}')).toHaveLength(2);
  });

  it('keeps $ sequences of the memory path and of the name too', () => {
    const out = buildRoleText('ana', ROLE, '/h/$&/$$/memory.md');
    expect(out).toContain('Your memory file is /h/$&/$$/memory.md.');
  });
});

describe('buildSettings', () => {
  const memory = '/h/agents/ana/memory.md';
  const input = { hubUrl: HUB, name: 'ana', mode: 'default', memoryPath: memory, apiKeyHelper: false } as const;

  it('writes the ten http hooks, the pinned keys and the memory rules for default mode', () => {
    expect(buildSettings(input)).toStrictEqual(expectedSettings(HUB, 'ana', memory));
    expect(Object.keys(buildSettings(input))).toStrictEqual(['hooks', 'tui', 'promptSuggestionEnabled', 'crossSessionInbound', 'permissions']);
    expect(Object.keys(buildSettings(input).hooks as object)).toStrictEqual(EVENTS);
  });

  it('is the same for acceptEdits and auto and adds the skip key only for bypassPermissions', () => {
    expect(buildSettings({ ...input, mode: 'acceptEdits' })).toStrictEqual(expectedSettings(HUB, 'ana', memory));
    expect(buildSettings({ ...input, mode: 'auto' })).toStrictEqual(expectedSettings(HUB, 'ana', memory));
    expect(buildSettings({ ...input, mode: 'bypassPermissions' })).toStrictEqual(
      expectedSettings(HUB, 'ana', memory, { skipDangerousModePermissionPrompt: true }),
    );
  });

  it('adds apiKeyHelper after the skip key when asked to', () => {
    expect(buildSettings({ ...input, apiKeyHelper: true })).toStrictEqual(
      expectedSettings(HUB, 'ana', memory, { apiKeyHelper: 'printenv GONOGO_API_KEY' }),
    );
    const both = buildSettings({ ...input, mode: 'bypassPermissions', apiKeyHelper: true });
    expect(Object.keys(both).slice(5)).toStrictEqual(['skipDangerousModePermissionPrompt', 'apiKeyHelper']);
  });

  it('keeps the URL it was given, an IPv6 loopback included', () => {
    const url = 'http://[::1]:7777';
    expect(buildSettings({ ...input, hubUrl: url })).toStrictEqual(expectedSettings(url, 'ana', memory));
  });
});

describe('buildMcpConfig', () => {
  it('names the server gonogo, sets the type and keeps the token out of the file', () => {
    expect(buildMcpConfig(HUB)).toStrictEqual({
      mcpServers: { gonogo: { type: 'http', url: 'http://127.0.0.1:7777/mcp', headers: { Authorization: 'Bearer ${GONOGO_TOKEN}' } } },
    });
    expect(buildMcpConfig('http://[::1]:9')).toStrictEqual({
      mcpServers: { gonogo: { type: 'http', url: 'http://[::1]:9/mcp', headers: { Authorization: 'Bearer ${GONOGO_TOKEN}' } } },
    });
  });
});

describe('buildArgv', () => {
  const input = {
    flag: 'session-id',
    sessionId: SID,
    mode: 'acceptEdits',
    settingsPath: '/h/agents/ana/settings.json',
    mcpPath: '/h/agents/ana/mcp.json',
    roleText: 'the role\nwith a second line',
  } as const;

  it('puts --session-id first and --allowedTools last on a first start', () => {
    expect(buildArgv(input)).toStrictEqual([
      '--session-id',
      SID,
      '--permission-mode',
      'acceptEdits',
      '--settings',
      '/h/agents/ana/settings.json',
      '--strict-mcp-config',
      '--mcp-config',
      '/h/agents/ana/mcp.json',
      '--append-system-prompt',
      'the role\nwith a second line',
      '--system-prompt-snapshot',
      'off',
      '--allowedTools',
      'mcp__gonogo__send_message',
      'mcp__gonogo__list_roster',
      'mcp__gonogo__read_messages',
      'mcp__gonogo__go_nogo',
      'mcp__gonogo__task_list',
      'mcp__gonogo__task_create',
      'mcp__gonogo__task_update',
      'mcp__gonogo__log_write',
      'mcp__gonogo__log_search',
      'mcp__gonogo__log_read',
      'mcp__gonogo__board_read',
      'mcp__gonogo__board_write',
      'mcp__gonogo__livery_submit',
      'mcp__gonogo__hire_agent',
      'mcp__gonogo__start_agent',
    ]);
  });

  it('is the same list with --resume in place of --session-id on a later start', () => {
    const first = buildArgv(input);
    const later = buildArgv({ ...input, flag: 'resume' });
    expect(later).toStrictEqual(['--resume', ...first.slice(1)]);
  });
});

describe('buildChildEnv', () => {
  it('removes every exact name and every prefix of the scrub lists and keeps the operator settings', () => {
    const base: Record<string, string | undefined> = {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_MESSAGING_SOCKET: '/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/bin/claude',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'b',
      CLAUDE_PID: '42',
      CLAUDE_EFFORT: 'high',
      AI_AGENT: 'x',
      GONOGO_UPDATE_HOOK: 'http://h/',
      GONOGO_UPDATE_HOOK_TOKEN: 'ht',
      GONOGO_TOKEN: 'stale',
      GONOGO_API_KEY: 'stale-key',
      CLAUDE_CODE_MESSAGING_FUTURE: 'x',
      CLAUDE_CODE_SESSION_FUTURE: 'x',
      CLAUDE_CODE_BRIDGE_FUTURE: 'x',
      CLAUDE_CODE_CHILD_FUTURE: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CONFIG_DIR: '/state/claude',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'haiku',
      HTTPS_PROXY: 'http://proxy:3128',
      PATH: '/usr/bin',
      HOME: '/home/node',
    };
    for (const name of SCRUB_ENV_EXACT) base[name] = 'x';
    for (const prefix of SCRUB_ENV_PREFIXES) base[`${prefix}EXTRA`] = 'x';
    expect(buildChildEnv({ base, token: 'tok', seed: false })).toStrictEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CONFIG_DIR: '/state/claude',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'haiku',
      HTTPS_PROXY: 'http://proxy:3128',
      PATH: '/usr/bin',
      HOME: '/home/node',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      GONOGO_TOKEN: 'tok',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    });
  });

  it('drops undefined values, replaces TERM and friends, and leaves its input alone', () => {
    const base = { A: 'a', B: undefined, TERM: 'dumb', COLORTERM: 'no', GONOGO_TOKEN: 'stale' };
    const before = { ...base };
    const env = buildChildEnv({ base, token: 'fresh', seed: false });
    expect(env).toStrictEqual({
      A: 'a',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      GONOGO_TOKEN: 'fresh',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    });
    expect(base).toStrictEqual(before);
  });

  it('merges the loopback hosts into NO_PROXY and no_proxy without duplicates', () => {
    const merged = (base: Record<string, string>): Record<string, string | undefined> => {
      const env = buildChildEnv({ base, token: 't', seed: false });
      return { NO_PROXY: env.NO_PROXY, no_proxy: env.no_proxy };
    };
    expect(merged({ NO_PROXY: 'corp.local' })).toStrictEqual({ NO_PROXY: 'corp.local,127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
    expect(merged({ no_proxy: 'corp.local, *.example.com' })).toStrictEqual({
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: 'corp.local,*.example.com,127.0.0.1,localhost',
    });
    expect(merged({ NO_PROXY: 'localhost' }).NO_PROXY).toBe('localhost,127.0.0.1');
    expect(merged({ NO_PROXY: '127.0.0.1,LOCALHOST' }).NO_PROXY).toBe('127.0.0.1,LOCALHOST');
    expect(merged({ NO_PROXY: '127.0.0.1,localhost,corp.local' }).NO_PROXY).toBe('127.0.0.1,localhost,corp.local');
    expect(merged({ NO_PROXY: '' }).NO_PROXY).toBe('127.0.0.1,localhost');
    expect(merged({ NO_PROXY: ' , a ,, ' }).NO_PROXY).toBe('a,127.0.0.1,localhost');
  });

  it('adds IS_DEMO and moves the API key only in seed mode', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', PATH: '/bin' };
    const seeded = buildChildEnv({ base, token: 't', seed: true });
    expect(seeded.IS_DEMO).toBe('1');
    expect(seeded.ANTHROPIC_API_KEY).toBeUndefined();
    expect('ANTHROPIC_API_KEY' in seeded).toBe(false);
    expect(seeded.GONOGO_API_KEY).toBe('sk-key');
    expect(seeded.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');

    const plain = buildChildEnv({ base, token: 't', seed: false });
    expect('IS_DEMO' in plain).toBe(false);
    expect(plain.ANTHROPIC_API_KEY).toBe('sk-key');
    expect('GONOGO_API_KEY' in plain).toBe(false);
  });

  it('leaves an empty ANTHROPIC_API_KEY alone in seed mode', () => {
    const env = buildChildEnv({ base: { ANTHROPIC_API_KEY: '' }, token: 't', seed: true });
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect('GONOGO_API_KEY' in env).toBe(false);
    expect(env.IS_DEMO).toBe('1');
  });

  describe('GONOGO_SCRUB_ENV (the operator adds to the scrub lists)', () => {
    it('removes what it lists: an entry ending in _ is a prefix, any other entry an exact name', () => {
      const base: Record<string, string> = {
        GONOGO_SCRUB_ENV: ' HERDR_ , TMUX_PANE,, STY ,',
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'p1',
        HERDR_: 'the prefix itself',
        TMUX_PANE: '%3',
        STY: '123.pts-0',
        HERDR: 'no underscore, so not under the prefix',
        TMUX_PANEL: 'longer than the exact name',
        TMUX: '/run/tmux/default,1,0',
        PATH: '/usr/bin',
      };
      const env = buildChildEnv({ base, token: 't', seed: false });
      for (const name of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_', 'TMUX_PANE', 'STY']) expect(env, name).not.toHaveProperty(name);
      expect(env).toMatchObject({ HERDR: base.HERDR, TMUX_PANEL: base.TMUX_PANEL, TMUX: base.TMUX, PATH: '/usr/bin' });
    });

    it('changes nothing when it is unset, empty or only separators', () => {
      const plain = buildChildEnv({ base: { A: 'a', HERDR_ENV: '1' }, token: 't', seed: false });
      for (const value of [undefined, '', ' ', ' , ,']) {
        const env = buildChildEnv({ base: { A: 'a', HERDR_ENV: '1', GONOGO_SCRUB_ENV: value }, token: 't', seed: false });
        expect(env.HERDR_ENV, JSON.stringify(value)).toBe('1');
        expect(env.A).toBe('a');
        expect(Object.keys(env).filter((key) => key !== 'GONOGO_SCRUB_ENV')).toStrictEqual(Object.keys(plain));
      }
    });

    it('cannot take away what gonogo sets itself after the scrub', () => {
      const list = 'TERM,COLORTERM,GONOGO_TOKEN,NO_PROXY,no_proxy,IS_DEMO,GONOGO_API_KEY';
      const env = buildChildEnv({ base: { GONOGO_SCRUB_ENV: list, ANTHROPIC_API_KEY: 'k' }, token: 'fresh', seed: true });
      expect(env).toMatchObject({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        GONOGO_TOKEN: 'fresh',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        IS_DEMO: '1',
      });
    });

    it('reaches the child through the environment the launcher receives', async () => {
      const env = baseEnv({ GONOGO_SCRUB_ENV: 'HERDR_,TMUX_PANE', HERDR_ENV: '1', HERDR_SOCKET_PATH: '/run/herdr.sock', TMUX_PANE: '%1', TMUX_TMPDIR: '/keep' });
      const { spec } = await launcher({ env }).prepareStart(agent(), START);
      for (const name of ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'TMUX_PANE']) expect(spec.env, name).not.toHaveProperty(name);
      expect(spec.env.TMUX_TMPDIR).toBe('/keep');
    });
  });
});

describe('prepareStart', () => {
  it('builds the first start: argv, environment, files and modes', async () => {
    const prepared = await launcher().prepareStart(agent(), START);
    const base = join(home, 'agents', 'ana');
    const memory = join(base, 'memory.md');

    expect(prepared.flag).toBe('session-id');
    expect(prepared.spec.file).toBe('claude');
    expect(prepared.spec.cwd).toBe(work);
    expect(prepared.spec.args).toStrictEqual(expectedArgs('--session-id'));
    expect(prepared.token).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.spec.env).toStrictEqual({
      PATH: '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: claudeDir,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      GONOGO_TOKEN: prepared.token,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    });

    const settingsText = await text(join(base, 'settings.json'));
    expect(settingsText).toBe(JSON.stringify(startSettings(HUB, 'ana', memory), null, 2));
    expect(
      settingsText.startsWith(
        '{\n  "hooks": {\n    "UserPromptSubmit": [\n      {\n        "hooks": [\n          {\n            "type": "http",\n' +
          '            "url": "http://127.0.0.1:7777/hook/ana/UserPromptSubmit",\n            "timeout": 10,\n' +
          '            "headers": {\n              "Authorization": "Bearer $GONOGO_TOKEN"\n            },\n' +
          '            "allowedEnvVars": [\n              "GONOGO_TOKEN"\n            ]\n          }\n        ]\n      }\n    ],\n',
      ),
    ).toBe(true);
    expect(
      settingsText.includes(
        '  },\n  "tui": "fullscreen",\n  "promptSuggestionEnabled": false,\n  "crossSessionInbound": "refuse",\n' +
          '  "permissions": {\n    "deny": [\n      "SendMessage",\n      "ListAgents"\n    ],\n    "allow": [\n' +
          `      "Read(//${memory.slice(1)})",\n      "Edit(//${memory.slice(1)})"\n    ]\n  },\n`,
      ),
    ).toBe(true);
    expect(await text(join(base, 'mcp.json'))).toBe(
      [
        '{',
        '  "mcpServers": {',
        '    "gonogo": {',
        '      "type": "http",',
        '      "url": "http://127.0.0.1:7777/mcp",',
        '      "headers": {',
        '        "Authorization": "Bearer ${GONOGO_TOKEN}"',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(await text(join(base, 'token'))).toBe(`${prepared.token}\n`);
    expect(await text(memory)).toBe('# Memory of ana\n\nNotes that survive restarts. Keep it short.\n');

    expect(await modeOf(base)).toBe(0o700);
    for (const file of ['settings.json', 'mcp.json', 'token', 'memory.md']) expect(await modeOf(join(base, file))).toBe(0o600);
    expect((await readdir(base)).sort()).toStrictEqual(['mcp.json', 'memory.md', 'settings.json', 'token']);
  });

  it('uses --resume for the same list once a transcript exists in the agent project directory', async () => {
    const projectDir = join(claudeDir, 'projects', transcriptDirName(work));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${SID}.jsonl`), '{}\n');
    const prepared = await launcher().prepareStart(agent(), START);
    expect(prepared.flag).toBe('resume');
    expect(prepared.spec.args).toStrictEqual(expectedArgs('--resume'));
  });

  it('finds a transcript in another project directory (the agent changed directory since)', async () => {
    const other = join(claudeDir, 'projects', '-somewhere-else');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, `${SID}.jsonl`), '{}\n');
    expect((await launcher().prepareStart(agent(), START)).flag).toBe('resume');
  });

  it('finds a transcript stored under the real path when the working directory is a symlink', async () => {
    const link = join(tmp, 'link');
    await symlink(work, link);
    const projectDir = join(claudeDir, 'projects', transcriptDirName(await realpath(work)));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${SID}.jsonl`), '{}\n');
    expect((await launcher().prepareStart(agent({ dir: link }), START)).flag).toBe('resume');
  });

  it.skipIf(process.getuid?.() === 0)('looks in the project directory of the working directory and of its real path before listing', async () => {
    const link = join(tmp, 'link');
    await symlink(work, link);
    const projects = join(claudeDir, 'projects');
    const byLink = join(projects, transcriptDirName(link));
    const byReal = join(projects, transcriptDirName(await realpath(work)));
    await mkdir(byLink, { recursive: true });
    await mkdir(byReal, { recursive: true });
    await writeFile(join(byLink, `${SID}.jsonl`), '{}\n');
    await writeFile(join(byReal, `${SID2}.jsonl`), '{}\n');
    await chmod(projects, 0o111); // searchable, not listable: only a direct path can find a transcript
    try {
      const l = launcher();
      const flagOf = async (sessionId: string, generation: number): Promise<string> =>
        (await l.prepareStart(agent({ dir: link, sessionId }), { generation, flag: null })).flag;
      expect(await flagOf(SID, 1)).toBe('resume');
      expect(await flagOf(SID2, 2)).toBe('resume');
      expect(await flagOf('11111111-2222-4333-8444-555555555555', 3)).toBe('session-id');
    } finally {
      await chmod(projects, 0o700);
    }
  });

  it('starts fresh when the only transcripts belong to other sessions or are not files', async () => {
    const projectDir = join(claudeDir, 'projects', transcriptDirName(work));
    await mkdir(join(projectDir, `${SID}.jsonl`), { recursive: true });
    await writeFile(join(projectDir, `${SID2}.jsonl`), '{}\n');
    expect((await launcher().prepareStart(agent(), START)).flag).toBe('session-id');
  });

  it('starts fresh when the projects directory is missing or unreadable', async () => {
    expect((await launcher().prepareStart(agent(), START)).flag).toBe('session-id');
    await writeFile(join(tmp, 'afile'), 'x');
    const odd = launcher({ env: baseEnv({ CLAUDE_CONFIG_DIR: join(tmp, 'afile') }) });
    expect((await odd.prepareStart(agent({ name: 'ben' }), START)).flag).toBe('session-id');
  });

  it('lets a forced flag win over what the transcript says', async () => {
    const projectDir = join(claudeDir, 'projects', transcriptDirName(work));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${SID}.jsonl`), '{}\n');
    const forcedFirst = await launcher().prepareStart(agent(), { generation: 2, flag: 'session-id' });
    expect(forcedFirst.flag).toBe('session-id');
    expect(forcedFirst.spec.args.slice(0, 2)).toStrictEqual(['--session-id', SID]);
    await rm(join(projectDir, `${SID}.jsonl`));
    const forcedResume = await launcher().prepareStart(agent(), { generation: 3, flag: 'resume' });
    expect(forcedResume.flag).toBe('resume');
    expect(forcedResume.spec.args.slice(0, 2)).toStrictEqual(['--resume', SID]);
  });

  it('puts each mode in the argv and the settings, and the skip key only for bypassPermissions', async () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      const name = `m-${mode.toLowerCase()}`;
      const prepared = await launcher().prepareStart(agent({ name, mode }), START);
      expect(prepared.spec.args.slice(2, 4)).toStrictEqual(['--permission-mode', mode]);
      const memory = join(home, 'agents', name, 'memory.md');
      const extra = mode === 'bypassPermissions' ? { skipDangerousModePermissionPrompt: true } : {};
      expect(await json(agentFile(name, 'settings.json'))).toStrictEqual(startSettings(HUB, name, memory, extra));
    }
  });

  it('keeps $&, $$, $\' and a literal {memory} of the role verbatim in the argv element', async () => {
    const role = "Budget is $$5 and cost $& more, $' and $` and {memory} and {name}.";
    const prepared = await launcher().prepareStart(agent({ role }), START);
    const element = prepared.spec.args[prepared.spec.args.indexOf('--append-system-prompt') + 1];
    expect(element).toBe(expectedRole('ana', role, agentFile('ana', 'memory.md')));
    expect(element).toContain(role);
    expect(element).toBe(buildRoleText('ana', role, agentFile('ana', 'memory.md')));
  });

  it('replaces the executable with claudeBin and prepends the agentCmd arguments', async () => {
    const bin = await launcher({ claudeBin: '/opt/claude/bin/claude' }).prepareStart(agent(), START);
    expect(bin.spec.file).toBe('/opt/claude/bin/claude');
    expect(bin.spec.args).toStrictEqual(expectedArgs('--session-id'));

    const cmd = await launcher({ agentCmd: ['node', '/x/fake claude.mjs', '--slow'] }).prepareStart(agent(), START);
    expect(cmd.spec.file).toBe('node');
    expect(cmd.spec.args).toStrictEqual(['/x/fake claude.mjs', '--slow', ...expectedArgs('--session-id')]);

    for (const agentCmd of [null, []]) {
      const plain = await launcher({ agentCmd, claudeBin: undefined }).prepareStart(agent({ name: 'ben' }), START);
      expect(plain.spec.file).toBe('claude');
    }
  });

  it('rejects when the working directory is missing or is not a directory, and touches nothing', async () => {
    const missing = join(tmp, 'nope');
    const message = `working directory does not exist: ${missing}`;
    expect((await rejection(launcher().prepareStart(agent({ dir: missing }), START))).message).toBe(message);
    const file = join(tmp, 'a-file');
    await writeFile(file, 'x');
    expect((await rejection(launcher().prepareStart(agent({ dir: file }), START))).message).toBe(`working directory does not exist: ${file}`);
    expect(await readdir(home)).toStrictEqual([]);
  });

  it('creates memory.md once and never overwrites it', async () => {
    const l = launcher();
    await l.prepareStart(agent(), START);
    const memory = agentFile('ana', 'memory.md');
    await writeFile(memory, 'my own notes\n');
    await chmod(memory, 0o644);
    await l.prepareStart(agent(), { generation: 2, flag: null });
    expect(await text(memory)).toBe('my own notes\n');
    expect(await modeOf(memory)).toBe(0o644);
  });

  it('tightens an agent directory that exists with another mode', async () => {
    const base = join(home, 'agents', 'ana');
    await mkdir(base, { recursive: true, mode: 0o755 });
    await chmod(base, 0o755);
    await launcher().prepareStart(agent(), START);
    expect(await modeOf(base)).toBe(0o700);
  });

  it('writes files over older ones (a leftover token file is replaced, mode 0600)', async () => {
    const base = join(home, 'agents', 'ana');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'token'), 'old\n', { mode: 0o644 });
    await writeFile(join(base, 'settings.json'), '{"stale":true}', { mode: 0o644 });
    const prepared = await launcher().prepareStart(agent(), START);
    expect(await text(join(base, 'token'))).toBe(`${prepared.token}\n`);
    expect(await modeOf(join(base, 'token'))).toBe(0o600);
    expect(await modeOf(join(base, 'settings.json'))).toBe(0o600);
    expect(await json(join(base, 'settings.json'))).toHaveProperty('hooks');
  });

  it.each([
    ['an empty name', { name: '' }],
    ['an uppercase name', { name: 'Ana' }],
    ['a path as name', { name: '../evil' }],
    ['a slash in the name', { name: 'a/b' }],
    ['a leading hyphen', { name: '-ana' }],
    ['a 33 character name', { name: 'a'.repeat(33) }],
    ['a trailing newline', { name: 'ana\n' }],
  ])('rejects %s before it touches the disk', async (_label, over) => {
    expect((await rejection(launcher().prepareStart(agent(over), START))).message).toBe('invalid agent name');
    expect(await readdir(home)).toStrictEqual([]);
  });

  it.each(['', 'not-a-uuid', '../../etc/passwd', `${SID}x`, `${SID}\n`])('rejects the session id %j', async (sessionId) => {
    expect((await rejection(launcher().prepareStart(agent({ sessionId }), START))).message).toBe('invalid session id for ana');
    expect(await readdir(home)).toStrictEqual([]);
  });

  it.each(['--dangerously-skip-permissions', 'plan', ''])('rejects the permission mode %j', async (mode) => {
    const bad = agent({ mode: mode as AgentRecord['mode'] });
    expect((await rejection(launcher().prepareStart(bad, START))).message).toBe('unknown permission mode for ana');
    expect(await readdir(home)).toStrictEqual([]);
  });

  it.each([
    '',
    'http://localhost:7777',
    'http://192.168.1.5:7777',
    'http://0.0.0.0:7777',
    'https://127.0.0.1:7777',
    'http://127.0.0.1',
    'http://127.0.0.1:7777/x',
    'http://[::1]',
    'http://127.0.0.1:1234567',
  ])('rejects the hub URL %j (claude would block it without a word)', async (url) => {
    const error = await rejection(launcher({ hubUrl: () => url }).prepareStart(agent(), START));
    expect(error.message).toBe(`the hub URL must be http://127.0.0.1:<port> or http://[::1]:<port>, got ${JSON.stringify(url)}`);
    expect(await readdir(home)).toStrictEqual([]);
  });

  it('rejects, rather than throws, when hubUrl itself throws', async () => {
    const l = launcher({
      hubUrl: () => {
        throw new Error('not listening yet');
      },
    });
    expect((await rejection(l.prepareStart(agent(), START))).message).toBe('not listening yet');
  });

  it('reads hubUrl at every start and writes loopback URLs unchanged, IPv6 included', async () => {
    let url = 'http://127.0.0.1:7777';
    const l = launcher({ hubUrl: () => url });
    for (const hub of ['http://127.0.0.1:7777', 'http://[::1]:7777', 'http://127.0.0.1:8081/']) {
      url = hub;
      await l.prepareStart(agent(), { generation: 1, flag: null });
      const shown = hub.replace(/\/$/, '');
      const files = [await text(agentFile('ana', 'settings.json')), await text(agentFile('ana', 'mcp.json'))];
      const urls = files.flatMap((file) => file.match(/"https?:\/\/[^"]*"/g) ?? []);
      expect(urls).toHaveLength(11);
      for (const found of urls) expect(found.startsWith(`"${shown}/`)).toBe(true);
      expect(JSON.parse(files[1]).mcpServers.gonogo.url).toBe(`${shown}/mcp`);
    }
  });

  it('points every hook at /hook/<name>/<Event> for the ten events and nothing else', async () => {
    await launcher().prepareStart(agent({ name: 'zed-9' }), START);
    const settings = (await json(agentFile('zed-9', 'settings.json'))) as { hooks: Record<string, { hooks: { url: string; type: string }[] }[]> };
    expect(Object.keys(settings.hooks)).toStrictEqual(EVENTS);
    for (const event of EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event][0].hooks).toHaveLength(1);
      expect(settings.hooks[event][0].hooks[0].url).toBe(`${HUB}/hook/zed-9/${event}`);
      expect(settings.hooks[event][0].hooks[0].type).toBe('http');
    }
  });

  it('writes no secret into the files, the argv or the log', async () => {
    const secrets = { ANTHROPIC_API_KEY: 'sk-ant-api03-TOPSECRETKEY', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-OAUTHSECRET' };
    for (const seed of [false, true]) {
      const l = launcher({ seed, env: baseEnv(secrets) });
      const prepared = await l.prepareStart(agent({ name: seed ? 'sec-on' : 'sec-off' }), START);
      const name = seed ? 'sec-on' : 'sec-off';
      const haystacks = [
        await text(agentFile(name, 'settings.json')),
        await text(agentFile(name, 'mcp.json')),
        prepared.spec.args.join('\n'),
        logs.lines.map((line) => line.message).join('\n'),
      ];
      for (const haystack of haystacks) {
        for (const secret of [prepared.token, ...Object.values(secrets)]) expect(haystack).not.toContain(secret);
      }
    }
  });

  it('handles a working directory with spaces, quotes and non-ASCII characters', async () => {
    const odd = join(tmp, 'wörk "x" dir\'s');
    await mkdir(odd);
    const prepared = await seedLauncher().prepareStart(agent({ dir: odd }), START);
    expect(prepared.spec.cwd).toBe(odd);
    const trusted = (await json(claudeJson)) as { projects: Record<string, unknown> };
    expect(trusted.projects[odd]).toStrictEqual({ hasTrustDialogAccepted: true });
  });

  it('derives the environment from process.env when no env option is given', async () => {
    const keys = ['CLAUDE_CONFIG_DIR', 'GONOGO_TEST_MARKER', 'CLAUDECODE'];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.GONOGO_TEST_MARKER = 'present';
    process.env.CLAUDECODE = '1';
    try {
      const l = createLauncher({ homeDir: home, hubUrl: () => HUB, seed: false, log: logs.log });
      const { spec } = await l.prepareStart(agent(), START);
      expect(spec.env.GONOGO_TEST_MARKER).toBe('present');
      expect(spec.env.CLAUDECODE).toBeUndefined();
      expect(spec.env.CLAUDE_CONFIG_DIR).toBe(claudeDir);
      expect(spec.env.HOME).toBe(fakeHome);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('never creates the Claude config directory when seed mode is off', async () => {
    await launcher().prepareStart(agent(), START);
    expect(await exists(claudeDir)).toBe(false);
    expect(await exists(join(fakeHome, '.claude.json'))).toBe(false);
  });
});

describe('prepareStart for a custom agent', () => {
  const custom = (command: string | undefined, over: Partial<AgentRecord> = {}): AgentRecord =>
    agent({ provider: 'custom', command, ...over });

  it('parses the command, runs it in the agent dir and writes no file at all', async () => {
    const l = launcher({ env: baseEnv({ GONOGO_TOKEN: 'leak', CLAUDECODE: '1', GONOGO_SCRUB_ENV: 'MY_SECRET', MY_SECRET: 'x', KEEP: 'y' }) });
    const words = await l.prepareStart(custom('htop -d 5'), START);
    expect(words.spec.file).toBe('htop');
    expect(words.spec.args).toStrictEqual(['-d', '5']);
    expect(words.spec.cwd).toBe(work);
    expect(words.token).toBe('');
    expect(words.spec.env).toStrictEqual({
      PATH: '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: claudeDir,
      GONOGO_SCRUB_ENV: 'MY_SECRET',
      KEEP: 'y',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    });
    expect(await readdir(home)).toStrictEqual([]);
    expect(l.resolveToken(words.token)).toBeNull();

    const array = await l.prepareStart(custom('["node","/x/my server.js","--flag"]', { name: 'ben' }), START);
    expect([array.spec.file, ...array.spec.args]).toStrictEqual(['node', '/x/my server.js', '--flag']);
    expect(await readdir(home)).toStrictEqual([]);
  });

  it('does not seed trust or move the API key even in seed mode', async () => {
    const l = seedLauncher({ env: baseEnv({ ANTHROPIC_API_KEY: 'sk-x' }) });
    const { spec } = await l.prepareStart(custom('htop'), START);
    expect(spec.env.IS_DEMO).toBeUndefined();
    expect(spec.env.ANTHROPIC_API_KEY).toBe('sk-x');
    expect(await exists(claudeJson)).toBe(false);
  });

  it('rejects a command it cannot parse, an empty first word, or a missing directory, with a one-line reason', async () => {
    const l = launcher();
    expect((await rejection(l.prepareStart(custom('[1, 2'), START))).message).toBe('the command of ana cannot be read: not a valid JSON array');
    expect((await rejection(l.prepareStart(custom('["a", 3]'), START))).message).toBe(
      'the command of ana cannot be read: expected a JSON array of one or more strings',
    );
    for (const command of [undefined, '   ', '["", "x"]']) {
      expect((await rejection(l.prepareStart(custom(command), START))).message).toBe('the command of ana is empty');
    }
    const missing = join(tmp, 'nope');
    expect((await rejection(l.prepareStart(custom('htop', { dir: missing }), START))).message).toBe(`working directory does not exist: ${missing}`);
    expect(await readdir(home)).toStrictEqual([]);
  });
});

describe('tokens', () => {
  it('issues 64 hex characters per start and resolves them to the agent and generation', async () => {
    const l = launcher();
    const a = await l.prepareStart(agent(), { generation: 3, flag: null });
    const b = await l.prepareStart(agent({ name: 'ben' }), { generation: 1, flag: null });
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(l.resolveToken(a.token)).toStrictEqual({ agent: 'ana', generation: 3 });
    expect(l.resolveToken(b.token)).toStrictEqual({ agent: 'ben', generation: 1 });
    expect(l.resolveToken('0'.repeat(64))).toBeNull();
  });

  it('a started agent never gets the update hook or its token', async () => {
    const l = launcher({ env: { ...baseEnv(), GONOGO_UPDATE_HOOK: 'http://watchtower/v1/update', GONOGO_UPDATE_HOOK_TOKEN: 'hook-secret' } });
    const { spec } = await l.prepareStart(agent(), { generation: 1, flag: null });
    expect(Object.keys(spec.env).filter((name) => name.startsWith('GONOGO_UPDATE'))).toEqual([]);
    expect(JSON.stringify(spec)).not.toContain('hook-secret');
  });

  it('answers null for anything that is not a live token', () => {
    const l = launcher();
    for (const value of ['', ' ', 'x'.repeat(100_000), '__proto__', 'constructor', 'toString', '\u0000']) {
      expect(l.resolveToken(value)).toBeNull();
    }
    expect(l.resolveToken(undefined as unknown as string)).toBeNull();
    expect(l.resolveToken(42 as unknown as string)).toBeNull();
  });

  it('keeps one live token per agent: a new start revokes the older token', async () => {
    const l = launcher();
    const first = await l.prepareStart(agent(), { generation: 1, flag: null });
    const second = await l.prepareStart(agent(), { generation: 2, flag: null });
    expect(l.resolveToken(first.token)).toBeNull();
    expect(l.resolveToken(second.token)).toStrictEqual({ agent: 'ana', generation: 2 });
    expect(await text(agentFile('ana', 'token'))).toBe(`${second.token}\n`);
  });

  describe('live reload: tokens saved as hashes', () => {
    const file = (): string => join(home, 'run', 'tokens.json');
    const withFile = (): Launcher => {
      mkdirSync(join(home, 'run'), { recursive: true });
      return launcher({ tokensFile: file() });
    };

    it('keeps working for a new launcher on the same file, and the file holds the hash, never the token, at 0600', async () => {
      const first = withFile();
      const { token } = await first.prepareStart(agent(), { generation: 3, flag: null });
      const saved = await text(file());
      expect(saved).not.toContain(token);
      expect(saved).toMatch(/[0-9a-f]{64}/);
      expect(statSync(file()).mode & 0o777).toBe(0o600);
      const next = withFile();
      expect(next.resolveToken(token)).toStrictEqual({ agent: 'ana', generation: 3 });
      expect(next.resolveToken(token + 'x')).toBeNull();
    });

    it('a token that was revoked stays revoked after a reload', async () => {
      const first = withFile();
      const { token } = await first.prepareStart(agent(), { generation: 1, flag: null });
      first.revoke('ana', 1);
      expect(withFile().resolveToken(token)).toBeNull();
    });

    it('keepTokens drops the tokens of agents that no longer run there', async () => {
      const first = withFile();
      const a = await first.prepareStart(agent(), { generation: 1, flag: null });
      const b = await first.prepareStart(agent({ name: 'ben' }), { generation: 2, flag: null });
      const next = withFile();
      next.keepTokens([{ name: 'ben', generation: 2 }]);
      expect(next.resolveToken(a.token)).toBeNull();
      expect(next.resolveToken(b.token)).toStrictEqual({ agent: 'ben', generation: 2 });
      expect(withFile().resolveToken(a.token), 'the file follows').toBeNull();
    });

    it('ignores a damaged file and entries that are not hashes', async () => {
      mkdirSync(join(home, 'run'), { recursive: true });
      writeFileSync(file(), '{not json');
      expect(() => launcher({ tokensFile: file() })).not.toThrow();
      writeFileSync(file(), JSON.stringify({ version: 1, tokens: [{ name: 'ana', generation: 1, hash: 'plain-token' }, { name: '../x', generation: 1, hash: 'a'.repeat(64) }] }));
      const l = launcher({ tokensFile: file() });
      expect(l.resolveToken('plain-token')).toBeNull();
    });
  });

  it('does nothing when the exit of an older generation arrives after a newer start', async () => {
    const l = launcher();
    await l.prepareStart(agent(), { generation: 1, flag: null });
    const second = await l.prepareStart(agent(), { generation: 2, flag: null });
    l.revoke('ana', 1);
    expect(l.resolveToken(second.token)).toStrictEqual({ agent: 'ana', generation: 2 });
    expect(await text(agentFile('ana', 'token'))).toBe(`${second.token}\n`);
    l.revoke('ana', 3);
    expect(l.resolveToken(second.token)).not.toBeNull();
  });

  it('revoke forgets the token and deletes its file at once, and a second revoke does nothing', async () => {
    const l = launcher();
    const prepared = await l.prepareStart(agent(), { generation: 4, flag: null });
    l.revoke('ana', 4);
    expect(l.resolveToken(prepared.token)).toBeNull();
    expect(await exists(agentFile('ana', 'token'))).toBe(false);
    l.revoke('ana', 4);
    l.revoke('nobody', 1);
    l.revoke('../x', 1);
    l.revoke('ana', Number.NaN);
    expect(logs.lines.filter((line) => line.level === 'warn')).toStrictEqual([]);
  });

  it('keeps the other agents when one is revoked, and never deletes the files of another agent', async () => {
    const l = launcher();
    const a = await l.prepareStart(agent(), START);
    const b = await l.prepareStart(agent({ name: 'ben' }), START);
    l.revoke('ana', 1);
    expect(l.resolveToken(b.token)).toStrictEqual({ agent: 'ben', generation: 1 });
    expect(await exists(agentFile('ben', 'token'))).toBe(true);
    expect(l.resolveToken(a.token)).toBeNull();
  });

  it('logs a warning when the token file cannot be deleted for another reason than being gone', async () => {
    const l = launcher();
    await l.prepareStart(agent(), START);
    const file = agentFile('ana', 'token');
    await rm(file);
    await mkdir(join(file, 'inside'), { recursive: true });
    l.revoke('ana', 1);
    expect(logs.lines.some((line) => line.level === 'warn' && line.message.startsWith('could not delete the token file of ana: '))).toBe(true);
  });

  it('revokes the token of a start that failed, so nothing is half-registered', async () => {
    const l = seedLauncher();
    const first = await l.prepareStart(agent(), START);
    expect(l.resolveToken(first.token)).not.toBeNull();
    await writeFile(claudeJson, '{ not json');
    const error = await rejection(l.prepareStart(agent(), { generation: 2, flag: null }));
    expect(error.message).toMatch(/^cannot record folder trust in /);
    expect(l.resolveToken(first.token)).toBeNull();
    expect(await exists(agentFile('ana', 'token'))).toBe(false);
    await writeFile(claudeJson, '{}');
    const again = await l.prepareStart(agent(), { generation: 3, flag: null });
    expect(l.resolveToken(again.token)).toStrictEqual({ agent: 'ana', generation: 3 });
  });
});

describe('seed mode', () => {
  const trustedProjects = async (): Promise<Record<string, unknown>> => ((await json(claudeJson)) as { projects: Record<string, unknown> }).projects;

  it('is off by default: no IS_DEMO, no claude file touched, the API key stays where it is', async () => {
    const l = launcher({ env: baseEnv({ ANTHROPIC_API_KEY: 'sk-key' }) });
    const { spec } = await l.prepareStart(agent(), START);
    expect('IS_DEMO' in spec.env).toBe(false);
    expect(spec.env.ANTHROPIC_API_KEY).toBe('sk-key');
    expect('GONOGO_API_KEY' in spec.env).toBe(false);
    expect(await json(agentFile('ana', 'settings.json'))).not.toHaveProperty('apiKeyHelper');
    expect(await exists(claudeDir)).toBe(false);
  });

  it('creates the config directory (0700) and .claude.json with the trust key, then sets IS_DEMO', async () => {
    const nested = join(tmp, 'state', 'deeper', 'claude');
    const l = seedLauncher({ env: baseEnv({ CLAUDE_CONFIG_DIR: nested }) });
    const { spec } = await l.prepareStart(agent(), START);
    const file = join(nested, '.claude.json');
    const real = await realpath(work);
    const projects = Object.fromEntries([...new Set([real, work])].map((dir) => [dir, { hasTrustDialogAccepted: true }]));
    expect(await text(file)).toBe(JSON.stringify({ projects }, null, 2));
    expect(await modeOf(file)).toBe(0o600);
    expect(await modeOf(nested)).toBe(0o700);
    expect(spec.env.IS_DEMO).toBe('1');
    expect((await readdir(nested)).sort()).toStrictEqual(['.claude.json']);
  });

  it('records both the real path and the resolved path when they differ', async () => {
    const link = join(tmp, 'link');
    await symlink(work, link);
    await seedLauncher().prepareStart(agent({ dir: link }), START);
    const projects = await trustedProjects();
    expect(Object.keys(projects)).toStrictEqual([await realpath(work), link]);
    for (const entry of Object.values(projects)) expect(entry).toStrictEqual({ hasTrustDialogAccepted: true });
  });

  it('merges into an existing file without losing keys and keeps its mode', async () => {
    await mkdir(claudeDir);
    const other = '/some/other/project';
    const before = {
      numStartups: 7,
      userID: 'u-1',
      projects: {
        [other]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false, history: [1, 2] },
        [work]: { allowedTools: [], hasTrustDialogAccepted: false },
      },
      customApiKeyResponses: { approved: ['abc'], rejected: [] },
    };
    await writeFile(claudeJson, JSON.stringify(before), { mode: 0o644 });
    await chmod(claudeJson, 0o644);
    await seedLauncher().prepareStart(agent(), START);
    const after = (await json(claudeJson)) as typeof before & { projects: Record<string, unknown> };
    expect(after.numStartups).toBe(7);
    expect(after.userID).toBe('u-1');
    expect(after.customApiKeyResponses).toStrictEqual(before.customApiKeyResponses);
    expect(after.projects[other]).toStrictEqual(before.projects[other]);
    expect(after.projects[work]).toStrictEqual({ allowedTools: [], hasTrustDialogAccepted: true });
    expect(Object.keys(after)).toStrictEqual(['numStartups', 'userID', 'projects', 'customApiKeyResponses']);
    expect(await modeOf(claudeJson)).toBe(0o644);
    expect((await readdir(claudeDir)).sort()).toStrictEqual(['.claude.json']);
  });

  it('does not write at all when every key is already true', async () => {
    await mkdir(claudeDir);
    const real = await realpath(work);
    const compact = JSON.stringify({ projects: { [real]: { hasTrustDialogAccepted: true }, [work]: { hasTrustDialogAccepted: true } } });
    await writeFile(claudeJson, compact);
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(claudeJson, old, old);
    await seedLauncher().prepareStart(agent(), START);
    expect(await text(claudeJson)).toBe(compact);
    expect((await stat(claudeJson)).mtimeMs).toBe(old.getTime());
    expect(renamesTo('.claude.json')).toBe(0);
  });

  it('writes once for two agents in the same folder and leaves no temp file', async () => {
    const l = seedLauncher();
    await l.prepareStart(agent(), START);
    await l.prepareStart(agent({ name: 'ben', sessionId: SID2 }), START);
    expect(renamesTo('.claude.json')).toBe(1);
    expect((await readdir(claudeDir)).filter((name) => name.endsWith('.tmp'))).toStrictEqual([]);
  });

  it('serialises the writes of agents that start together', async () => {
    const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
    const dirs = await Promise.all(
      names.map(async (name) => {
        const dir = join(tmp, `dir-${name}`);
        await mkdir(dir);
        return dir;
      }),
    );
    const l = seedLauncher();
    await Promise.all(names.map((name, i) => l.prepareStart(agent({ name, dir: dirs[i], sessionId: `00000000-0000-4000-8000-00000000000${i}` }), START)));
    const projects = await trustedProjects();
    for (const dir of dirs) expect(projects[dir]).toStrictEqual({ hasTrustDialogAccepted: true });
    expect(renamesTo('.claude.json')).toBe(names.length);
  });

  it('keeps a symlinked .claude.json a symlink and updates its target', async () => {
    await mkdir(claudeDir);
    const target = join(tmp, 'dotfiles-claude.json');
    await writeFile(target, '{"keep":1}');
    await symlink(target, claudeJson);
    await seedLauncher().prepareStart(agent(), START);
    expect((await lstat(claudeJson)).isSymbolicLink()).toBe(true);
    const after = (await json(target)) as { keep: number; projects: Record<string, unknown> };
    expect(after.keep).toBe(1);
    expect(after.projects[work]).toStrictEqual({ hasTrustDialogAccepted: true });
  });

  it('uses ~/.claude.json and ~/.claude/projects when CLAUDE_CONFIG_DIR is not set', async () => {
    expect(homedir()).toBe(fakeHome); // the guard that keeps this test away from the real home
    const l = createLauncher({ homeDir: home, hubUrl: () => HUB, seed: true, env: { PATH: '/usr/bin' }, log: logs.log });
    expect((await l.prepareStart(agent(), START)).flag).toBe('session-id');
    const projects = ((await json(join(fakeHome, '.claude.json'))) as { projects: Record<string, unknown> }).projects;
    expect(projects[work]).toStrictEqual({ hasTrustDialogAccepted: true });
    const projectDir = join(fakeHome, '.claude', 'projects', transcriptDirName(work));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${SID}.jsonl`), '{}\n');
    expect((await l.prepareStart(agent(), { generation: 2, flag: null })).flag).toBe('resume');
    expect(await exists(claudeDir)).toBe(false);
  });

  describe('a folder that is too broad to trust', () => {
    const reason = (dir: string, why: string): string =>
      `cannot record folder trust for ${dir}: ${why} and trust covers every folder below it; use a project folder instead`;

    /** The start is refused with the one-line reason, and nothing was recorded: no Claude file, no token left behind. */
    async function refused(dir: string, why: string, over: Partial<LauncherOptions> = {}): Promise<void> {
      const error = await rejection(seedLauncher(over).prepareStart(agent({ dir }), START));
      expect(error.message).toBe(reason(dir, why));
      expect(await exists(join(over.homeDir ?? home, 'agents', 'ana', 'token'))).toBe(false);
      expect(await exists(claudeDir)).toBe(false);
      expect(await exists(join(fakeHome, '.claude.json'))).toBe(false);
    }

    it('refuses the root of the file system', async () => {
      await refused('/', 'it is the root of the file system');
    });

    it('refuses the home directory of the user, and a folder that holds it', async () => {
      await refused(fakeHome, 'it is your home directory');
      await refused(tmp, `it holds your home directory (${fakeHome})`);
    });

    it('refuses gonogo\'s own home directory and a folder that holds it', async () => {
      const stateHome = join(tmp, 'state', 'gonogo');
      await mkdir(stateHome, { recursive: true });
      await refused(stateHome, "it is gonogo's home directory", { homeDir: stateHome });
      await refused(join(tmp, 'state'), `it holds gonogo's home directory (${stateHome})`, { homeDir: stateHome });
    });

    it("refuses Claude Code's configuration folder and a folder that holds it", async () => {
      const nested = join(tmp, 'state', 'deeper', 'claude');
      await mkdir(nested, { recursive: true });
      const env = baseEnv({ CLAUDE_CONFIG_DIR: nested });
      await refused(nested, "it is Claude Code's configuration folder", { env });
      await refused(join(tmp, 'state'), `it holds Claude Code's configuration folder (${nested})`, { env });
      // without CLAUDE_CONFIG_DIR the configuration is ~/.claude
      await mkdir(join(fakeHome, '.claude'));
      await refused(join(fakeHome, '.claude'), "it is Claude Code's configuration folder", { env: { PATH: '/usr/bin' } });
    });

    it('looks through a symlink: the link is the folder the owner named, the target is what would be trusted', async () => {
      const link = join(tmp, 'link');
      await symlink(tmp, link);
      await refused(link, `it holds your home directory (${fakeHome})`);
    });

    it('accepts a project folder, also one below the home directory, and everything outside seed mode', async () => {
      const project = join(fakeHome, 'projects', 'app');
      await mkdir(project, { recursive: true });
      await seedLauncher().prepareStart(agent({ dir: project }), START);
      expect(Object.keys(await trustedProjects())).toContain(project);

      await launcher().prepareStart(agent({ name: 'ben', sessionId: SID2, dir: tmp }), START);
      await launcher().prepareStart(agent({ name: 'cy', sessionId: SID2, dir: '/' }), START);
    });
  });

  describe('when the trust cannot be recorded', () => {
    async function failsWith(expected: string): Promise<void> {
      const error = await rejection(seedLauncher().prepareStart(agent(), START));
      expect(error.message).toBe(`cannot record folder trust in ${claudeJson}: ${expected}`);
      expect(await exists(agentFile('ana', 'token'))).toBe(false);
    }

    it('rejects an invalid JSON file and leaves it untouched', async () => {
      await mkdir(claudeDir);
      await writeFile(claudeJson, '{ "projects": {');
      await failsWith('the file is not valid JSON; fix or delete it');
      expect(await text(claudeJson)).toBe('{ "projects": {');
      expect(await readdir(claudeDir)).toStrictEqual(['.claude.json']);
    });

    it.each(['', '   ', '[]', 'null', '"text"', '7', 'true'])('rejects the content %j', async (content) => {
      await mkdir(claudeDir);
      await writeFile(claudeJson, content);
      const error = await rejection(seedLauncher().prepareStart(agent(), START));
      const reason = ['[]', 'null', '"text"', '7', 'true'].includes(content)
        ? 'the file does not hold a JSON object; fix or delete it'
        : 'the file is not valid JSON; fix or delete it';
      expect(error.message).toBe(`cannot record folder trust in ${claudeJson}: ${reason}`);
      expect(await text(claudeJson)).toBe(content);
    });

    it('rejects a "projects" value or an entry that is not an object, and leaves the file untouched', async () => {
      await mkdir(claudeDir);
      await writeFile(claudeJson, '{"projects":5}');
      expect((await rejection(seedLauncher().prepareStart(agent(), START))).message).toBe(
        `cannot record folder trust in ${claudeJson}: "projects" is not an object; fix or delete the file`,
      );
      expect(await text(claudeJson)).toBe('{"projects":5}');
      const real = await realpath(work);
      await writeFile(claudeJson, JSON.stringify({ projects: { [real]: 'yes', [work]: 'yes' } }));
      expect((await rejection(seedLauncher().prepareStart(agent(), START))).message).toBe(
        `cannot record folder trust in ${claudeJson}: the entry of ${real} under "projects" is not an object; fix or delete the file`,
      );
    });

    it('rejects when .claude.json is a directory', async () => {
      await mkdir(claudeJson, { recursive: true });
      const error = await rejection(seedLauncher().prepareStart(agent(), START));
      expect(error.message).toMatch(new RegExp(`^cannot record folder trust in ${reEscape(claudeJson)}: EISDIR`));
    });

    it('rejects when the config directory cannot be created', async () => {
      await writeFile(claudeDir, 'a file where the directory should be');
      await failsWith(`EEXIST: file already exists, mkdir '${claudeDir}'`);
      expect(await text(claudeDir)).toBe('a file where the directory should be');

      const nested = join(claudeDir, 'sub');
      const error = await rejection(seedLauncher({ env: baseEnv({ CLAUDE_CONFIG_DIR: nested }) }).prepareStart(agent(), START));
      expect(error.message).toMatch(new RegExp(`^cannot record folder trust in ${reEscape(join(nested, '.claude.json'))}: ENOTDIR`));
    });

    it.skipIf(process.getuid?.() === 0)('rejects when the config directory is read-only and leaves the file untouched', async () => {
      await mkdir(claudeDir);
      await writeFile(claudeJson, '{"keep":1}', { mode: 0o600 });
      await chmod(claudeDir, 0o500);
      try {
        const error = await rejection(seedLauncher().prepareStart(agent(), START));
        expect(error.message).toMatch(new RegExp(`^cannot record folder trust in ${reEscape(claudeJson)}: EACCES`));
        expect(await text(claudeJson)).toBe('{"keep":1}');
        expect(await readdir(claudeDir)).toStrictEqual(['.claude.json']);
      } finally {
        await chmod(claudeDir, 0o700);
      }
    });

    it('rejects when the rename fails and leaves no temp file behind', async () => {
      await mkdir(claudeDir);
      await writeFile(claudeJson, '{"keep":1}');
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (basename(String(to)) === '.claude.json') throw new Error('disk full');
        await fsActual.rename(from, to);
      });
      await failsWith('disk full');
      expect(await text(claudeJson)).toBe('{"keep":1}');
      expect(await readdir(claudeDir)).toStrictEqual(['.claude.json']);
    });

    it('retries a write that was lost between the rename and the read-back, up to the attempt limit', async () => {
      await mkdir(claudeDir);
      await writeFile(claudeJson, '{"keep":1}');
      let lost = 1;
      vi.mocked(rename).mockImplementation(async (from, to) => {
        await fsActual.rename(from, to);
        if (basename(String(to)) === '.claude.json' && lost-- > 0) await fsActual.writeFile(to, '{"keep":1,"claudeWrote":true}');
      });
      const started = Date.now();
      const { spec } = await seedLauncher().prepareStart(agent(), START);
      expect(Date.now() - started).toBeGreaterThanOrEqual(TRUST_VERIFY_DELAY_MS - 20);
      expect(renamesTo('.claude.json')).toBe(2);
      const after = (await json(claudeJson)) as { keep: number; claudeWrote: boolean; projects: Record<string, unknown> };
      expect(after.claudeWrote).toBe(true);
      expect(after.projects[work]).toStrictEqual({ hasTrustDialogAccepted: true });
      expect(spec.env.IS_DEMO).toBe('1');
    });

    it('gives up after TRUST_VERIFY_ATTEMPTS lost writes and never returns a child environment', async () => {
      await mkdir(claudeDir);
      await writeFile(claudeJson, '{"keep":1}');
      vi.mocked(rename).mockImplementation(async (from, to) => {
        await fsActual.rename(from, to);
        if (basename(String(to)) === '.claude.json') await fsActual.writeFile(to, '{"keep":1}');
      });
      await failsWith(`the trust entry did not stay in the file (${TRUST_VERIFY_ATTEMPTS} attempts)`);
      expect(renamesTo('.claude.json')).toBe(TRUST_VERIFY_ATTEMPTS);
      expect(await text(claudeJson)).toBe('{"keep":1}');
      expect((await readdir(claudeDir)).filter((name) => name.endsWith('.tmp'))).toStrictEqual([]);
    });
  });

  describe('the API key', () => {
    const keyEnv = { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRET' };

    it('moves to GONOGO_API_KEY and adds apiKeyHelper to the settings', async () => {
      const { spec } = await seedLauncher({ env: baseEnv(keyEnv) }).prepareStart(agent(), START);
      expect('ANTHROPIC_API_KEY' in spec.env).toBe(false);
      expect(spec.env.GONOGO_API_KEY).toBe(keyEnv.ANTHROPIC_API_KEY);
      expect(spec.env.IS_DEMO).toBe('1');
      expect(await json(agentFile('ana', 'settings.json'))).toStrictEqual(
        startSettings(HUB, 'ana', agentFile('ana', 'memory.md'), { apiKeyHelper: 'printenv GONOGO_API_KEY' }),
      );
      expect(logs.lines.filter((line) => line.level === 'warn')).toStrictEqual([]);
    });

    it('adds nothing for a missing or empty key', async () => {
      for (const env of [baseEnv(), baseEnv({ ANTHROPIC_API_KEY: '' })]) {
        const { spec } = await seedLauncher({ env }).prepareStart(agent(), START);
        expect('GONOGO_API_KEY' in spec.env).toBe(false);
        expect(await json(agentFile('ana', 'settings.json'))).toStrictEqual(startSettings(HUB, 'ana', agentFile('ana', 'memory.md')));
      }
    });

    it('keeps CLAUDE_CODE_OAUTH_TOKEN and warns once per start when both credentials are set', async () => {
      const env = baseEnv({ ...keyEnv, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-OAUTH' });
      const { spec } = await seedLauncher({ env }).prepareStart(agent(), START);
      expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-OAUTH');
      expect(spec.env.GONOGO_API_KEY).toBe(keyEnv.ANTHROPIC_API_KEY);
      expect(logs.lines.filter((line) => line.level === 'warn').map((line) => line.message)).toStrictEqual([
        'both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; the API key is used',
      ]);
    });

    it('stays quiet about the OAuth token alone and outside seed mode', async () => {
      await seedLauncher({ env: baseEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' }) }).prepareStart(agent(), START);
      await launcher({ env: baseEnv({ ...keyEnv, CLAUDE_CODE_OAUTH_TOKEN: 'oat' }) }).prepareStart(agent({ name: 'ben' }), START);
      expect(logs.lines.filter((line) => line.level === 'warn')).toStrictEqual([]);
    });
  });

  it('seeds and sets IS_DEMO for a custom agent command too', async () => {
    const { spec } = await seedLauncher({ agentCmd: ['node', '/x/fake.mjs'] }).prepareStart(agent(), START);
    expect(spec.file).toBe('node');
    expect(spec.env.IS_DEMO).toBe('1');
    expect((await trustedProjects())[work]).toStrictEqual({ hasTrustDialogAccepted: true });
  });

  describe('the check after the start (open item O11)', () => {
    async function afterTwoSeconds(): Promise<void> {
      await vi.advanceTimersByTimeAsync(2000);
      vi.useRealTimers();
    }
    const warnings = (): string[] => logs.lines.filter((line) => line.level === 'warn').map((line) => line.message);

    it('warns when claude rewrote the file without the trust entry', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      await seedLauncher().prepareStart(agent(), START);
      await writeFile(claudeJson, '{"claudeWrote":true}');
      await afterTwoSeconds();
      await vi.waitFor(() => expect(warnings()).toHaveLength(1));
      expect(warnings()).toStrictEqual([`the trust entry of ana's folder is no longer in ${claudeJson} 2 s after its start; the next start records it again`]);
    });

    it('is silent while the entry is there, and only debug-logs a file it cannot read', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      await seedLauncher().prepareStart(agent(), START);
      await afterTwoSeconds();
      await new Promise((done) => setTimeout(done, 100)); // nothing to wait for: give a wrong warning time to show up
      expect(warnings()).toStrictEqual([]);

      vi.useFakeTimers({ toFake: ['setTimeout'] });
      await seedLauncher().prepareStart(agent({ name: 'ben' }), START);
      await writeFile(claudeJson, 'garbage');
      await afterTwoSeconds();
      const recheckFailed = (): boolean =>
        logs.lines.some((line) => line.level === 'debug' && line.message.startsWith('could not re-check the folder trust of ben: '));
      await vi.waitFor(() => expect(recheckFailed()).toBe(true));
      expect(warnings()).toStrictEqual([]);
    });
  });
});

describe('renameAgentFiles and memoryPath', () => {
  it('moves the whole agent directory, memory included', async () => {
    const l = launcher();
    await l.prepareStart(agent(), START);
    await writeFile(agentFile('ana', 'memory.md'), 'kept notes\n');
    await l.renameAgentFiles('ana', 'bob');
    expect(await exists(join(home, 'agents', 'ana'))).toBe(false);
    expect(await text(agentFile('bob', 'memory.md'))).toBe('kept notes\n');
    expect(l.memoryPath('bob')).toBe(agentFile('bob', 'memory.md'));
  });

  // The hub shows this text under the name field: the owner must be able to act on it and never sees <home>/agents/<name>
  const LEFTOVER = 'the name "bob" is taken by a notes folder left over from a removed agent; choose another name, or delete that folder from the agents folder of the gonogo home';

  it('rejects when the new directory exists and leaves both alone', async () => {
    const l = launcher();
    await l.prepareStart(agent(), START);
    await l.prepareStart(agent({ name: 'bob', sessionId: SID2 }), START);
    const error = await rejection(l.renameAgentFiles('ana', 'bob'));
    expect(error.message).toBe(LEFTOVER);
    expect(error.message).not.toContain('agents/');
    expect(error.message).not.toContain(home);
    expect(await exists(agentFile('ana', 'memory.md'))).toBe(true);
    expect(await exists(agentFile('bob', 'memory.md'))).toBe(true);
  });

  it('rejects an existing target even when the old directory is missing', async () => {
    const l = launcher();
    await l.prepareStart(agent({ name: 'bob', sessionId: SID2 }), START);
    expect((await rejection(l.renameAgentFiles('ghost', 'bob'))).message).toBe(LEFTOVER);
  });

  it('resolves and creates nothing when the old directory does not exist', async () => {
    await launcher().renameAgentFiles('ghost', 'bob');
    expect(await readdir(home)).toStrictEqual([]);
  });

  it('refuses names that are not agent names', async () => {
    const l = launcher();
    await l.prepareStart(agent(), START);
    for (const [from, to] of [['ana', '../x'], ['../ana', 'bob'], ['ana', ''], ['ana', 'A']] as const) {
      expect((await rejection(l.renameAgentFiles(from, to))).message).toBe('invalid agent name');
    }
    expect(await exists(agentFile('ana', 'memory.md'))).toBe(true);
    expect(await exists(join(tmp, 'x'))).toBe(false);
  });

  it('builds memoryPath from the home directory and refuses a bad name', () => {
    const l = launcher();
    expect(l.memoryPath('ana')).toBe(join(home, 'agents', 'ana', 'memory.md'));
    expect(() => l.memoryPath('../ana')).toThrow(new Error('invalid agent name'));
    expect(() => l.memoryPath('')).toThrow(new Error('invalid agent name'));
  });
});

describe('Payload: MCP servers and skills', () => {
  const files = { command: 'npx', args: ['-y', 'server-files'], env: { ROOT: '/work' } };
  const remote = { type: 'http' as const, url: 'https://example.test/mcp', headers: { Authorization: 'Bearer abc' } };
  const skill = (name: string): string => join(tmp, 'skills', name);
  const makeSkill = async (name: string): Promise<string> => {
    await mkdir(skill(name), { recursive: true });
    await writeFile(join(skill(name), 'SKILL.md'), `---\nname: ${name}\ndescription: Use for ${name}.\n---\nBody.\n`);
    return skill(name);
  };
  const mcpOf = async (): Promise<{ mcpServers: Record<string, unknown> }> => (await json(agentFile('ana', 'mcp.json'))) as { mcpServers: Record<string, unknown> };

  it('buildMcpConfig puts the servers beside gonogo, and gonogo cannot be replaced', () => {
    const config = buildMcpConfig(HUB, { files, remote, gonogo: { command: 'evil' } });
    expect(Object.keys(config.mcpServers as object)).toEqual(['files', 'remote', 'gonogo']);
    expect((config.mcpServers as Record<string, unknown>).files).toEqual(files);
    expect((config.mcpServers as Record<string, { type?: string }>).gonogo.type).toBe('http');
  });

  it('buildArgv adds --plugin-dir before the role, and nothing without one; --allowedTools stays last and is not widened', () => {
    const input = { flag: 'session-id', sessionId: SID, mode: 'default', settingsPath: '/s', mcpPath: '/m', roleText: 'r' } as const;
    expect(buildArgv(input)).toStrictEqual(buildArgv({ ...input, pluginDir: null }));
    const argv = buildArgv({ ...input, pluginDir: '/h/agents/ana/payload-plugin' });
    expect(argv.slice(argv.indexOf('--mcp-config'), argv.indexOf('--append-system-prompt'))).toStrictEqual(['--mcp-config', '/m', '--plugin-dir', '/h/agents/ana/payload-plugin']);
    expect(argv.slice(argv.indexOf('--allowedTools'))).toStrictEqual(['--allowedTools', ...expectedArgs('--session-id').slice(-15)]);
  });

  it('writes the servers into mcp.json (mode 0600) and the skills as a plugin of symlinks, loaded with --plugin-dir', async () => {
    const review = await makeSkill('review');
    const triage = await makeSkill('triage');
    const prepared = await launcher().prepareStart(agent({ payload: { mcpServers: { files, remote }, skills: [review, triage] } }), START);
    const base = join(home, 'agents', 'ana');
    const plugin = join(base, 'payload-plugin');
    expect(prepared.spec.args).toStrictEqual(
      buildArgv({ flag: 'session-id', sessionId: SID, mode: 'default', settingsPath: join(base, 'settings.json'), mcpPath: join(base, 'mcp.json'), roleText: expectedRole('ana', ROLE, join(base, 'memory.md')), pluginDir: plugin }),
    );
    const mcp = await mcpOf();
    expect(Object.keys(mcp.mcpServers)).toEqual(['files', 'remote', 'gonogo']);
    expect(mcp.mcpServers.files).toEqual(files);
    expect(mcp.mcpServers.remote).toEqual(remote);
    expect(await modeOf(join(base, 'mcp.json'))).toBe(0o600);
    expect(await json(join(plugin, '.claude-plugin', 'plugin.json'))).toEqual({ name: 'gonogo-payload', description: 'Skills chosen for this agent in gonogo' });
    expect((await readdir(join(plugin, 'skills'))).sort()).toEqual(['review', 'triage']);
    for (const name of ['review', 'triage']) {
      expect((await lstat(join(plugin, 'skills', name))).isSymbolicLink()).toBe(true);
      expect(await realpath(join(plugin, 'skills', name))).toBe(await realpath(skill(name)));
    }
    for (const dir of [plugin, join(plugin, '.claude-plugin'), join(plugin, 'skills')]) expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(join(plugin, '.claude-plugin', 'plugin.json'))).toBe(0o600);
    // nothing outside the agent's own folder and the owner's skill folders is touched
    expect((await readdir(work)).length).toBe(0);
    expect(await exists(join(claudeDir, 'skills'))).toBe(false);
  });

  it('servers alone give no plugin and no --plugin-dir; MCP tools are not added to --allowedTools', async () => {
    const prepared = await launcher().prepareStart(agent({ payload: { mcpServers: { files } } }), START);
    expect(prepared.spec.args).toStrictEqual(expectedArgs('--session-id'));
    expect(await exists(join(home, 'agents', 'ana', 'payload-plugin'))).toBe(false);
    expect(Object.keys((await mcpOf()).mcpServers)).toEqual(['files', 'gonogo']);
  });

  it('rebuilds the plugin at every start: removed skills disappear, the owner folder stays', async () => {
    const review = await makeSkill('review');
    const triage = await makeSkill('triage');
    const l = launcher();
    await l.prepareStart(agent({ payload: { skills: [review, triage] } }), START);
    await l.prepareStart(agent({ payload: { skills: [triage] } }), START);
    const plugin = join(home, 'agents', 'ana', 'payload-plugin');
    expect(await readdir(join(plugin, 'skills'))).toEqual(['triage']);
    const none = await l.prepareStart(agent(), START);
    expect(await exists(plugin)).toBe(false);
    expect(none.spec.args).not.toContain('--plugin-dir');
    expect(await exists(join(review, 'SKILL.md'))).toBe(true);
    expect(await exists(join(triage, 'SKILL.md'))).toBe(true);
  });

  it('a skill folder that is gone or has no SKILL.md fails the start with its path, and revokes the token', async () => {
    await mkdir(skill('empty'), { recursive: true });
    const l = launcher();
    expect((await rejection(l.prepareStart(agent({ payload: { skills: [skill('empty')] } }), START))).message).toBe(`the skill folder has no SKILL.md: ${skill('empty')}`);
    expect((await rejection(l.prepareStart(agent({ payload: { skills: [skill('gone')] } }), START))).message).toContain(skill('gone'));
    expect(await exists(join(home, 'agents', 'ana', 'token'))).toBe(false);
  });
});

function reEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
