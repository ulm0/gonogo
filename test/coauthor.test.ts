import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/shared/protocol.js';
import { ALWAYS_LINKED, coauthorEnv, createCoauthorStore, dispatchText, doctorLine, ensureHooksDir, gitHasEnvConfig, GIT_HOOK_NAMES, parseGitVersion, realHookNames, trailerOf } from '../src/server/coauthor.js';
import { createLauncher } from '../src/server/launcher.js';
import { createRoots } from '../src/server/hangar.js';
import { createRecorder } from '../src/server/recorder.js';

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';
let root: string;
let repo: string;
let agentDir: string;
let hooks: string;
const CLAUDE = 'Co-Authored-By: Claude <noreply@anthropic.com>';

const baseEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' });
const run = (cwd: string, args: string[], env: Record<string, string> = baseEnv(), input?: string) => spawnSync('git', args, { cwd, env, encoding: 'utf8', input });
const git = (cwd: string, ...args: string[]): string => {
  const done = run(cwd, args);
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout;
};
const agentEnv = (name = 'flight'): Record<string, string> => ({ ...baseEnv(), ...coauthorEnv(baseEnv(), hooks) });
const message = (cwd: string, ref = 'HEAD'): string => git(cwd, 'log', '-1', '--format=%B', ref);
const trailer = trailerOf('flight');
const count = (text: string, line: string): number => text.split('\n').filter((l) => l === line).length;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gonogo-co-'));
  repo = join(root, 'repo');
  agentDir = join(root, 'agent');
  await mkdir(repo);
  await mkdir(agentDir);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'first');
  hooks = await ensureHooksDir(agentDir, 'flight', []);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const change = async (name = 'a.txt', text = `${Math.random()}\n`): Promise<void> => {
  await writeFile(join(repo, name), text);
  git(repo, 'add', '-A');
};

describe('the trailer', () => {
  it('is added to a commit message, once, with the invalid mailbox', async () => {
    await change();
    expect(run(repo, ['commit', '-q', '-m', 'work'], agentEnv()).status).toBe(0);
    const text = await message(repo);
    expect(text).toContain(`work\n\n${trailer}`);
    expect(trailer).toBe('Co-Authored-By: flight (gonogo) <flight@gonogo.invalid>');
  });

  it('is added after the trailer of Claude, which stays', async () => {
    await change();
    run(repo, ['commit', '-q', '-m', `work\n\n${CLAUDE}`], agentEnv());
    const lines = (await message(repo)).trim().split('\n');
    expect(lines.slice(-2)).toEqual([CLAUDE, trailer]);
  });

  it('is not added twice by an amend, and --no-verify does not stop it', async () => {
    await change();
    run(repo, ['commit', '-q', '--no-verify', '-m', 'work'], agentEnv());
    expect(count(await message(repo), trailer)).toBe(1);
    expect(run(repo, ['commit', '-q', '--amend', '--no-edit'], agentEnv()).status).toBe(0);
    expect(run(repo, ['commit', '-q', '--amend', '-m', 'reworded'], agentEnv()).status).toBe(0);
    const text = await message(repo);
    expect(text).toContain('reworded');
    expect(count(text, trailer)).toBe(1);
  });

  it('is added to a message that comes from a template, and works in a linked worktree', async () => {
    await writeFile(join(root, 'tpl.txt'), '# a comment only\n');
    git(repo, 'config', 'commit.template', join(root, 'tpl.txt'));
    await change();
    const env = { ...agentEnv(), GIT_EDITOR: 'true' };
    await writeFile(join(root, 'msg.txt'), 'from a file\n');
    expect(run(repo, ['commit', '-q', '-F', join(root, 'msg.txt')], env).status).toBe(0);
    expect(count(await message(repo), trailer)).toBe(1);
    git(repo, 'worktree', 'add', '-q', '-b', 'side', join(root, 'wt'));
    await writeFile(join(root, 'wt', 'b.txt'), 'b\n');
    git(join(root, 'wt'), 'add', '-A');
    expect(run(join(root, 'wt'), ['commit', '-q', '-m', 'in a worktree'], agentEnv()).status).toBe(0);
    expect(count(await message(join(root, 'wt')), trailer)).toBe(1);
  });

  it('is not added to a merge or a squash', async () => {
    git(repo, 'checkout', '-q', '-b', 'topic');
    await writeFile(join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'on topic');
    git(repo, 'checkout', '-q', 'main');
    await writeFile(join(repo, 'c.txt'), 'c\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'on main');
    expect(run(repo, ['merge', '-q', '--no-edit', 'topic'], { ...agentEnv(), GIT_EDITOR: 'true' }).status).toBe(0);
    expect(await message(repo)).not.toContain('gonogo');
    git(repo, 'checkout', '-q', '-b', 'sq', 'HEAD~1');
    expect(run(repo, ['merge', '-q', '--squash', 'topic'], agentEnv()).status).toBe(0);
    // `git commit` with no -m after a squash has the source `squash`: no line either
    expect(run(repo, ['commit', '-q'], { ...agentEnv(), GIT_EDITOR: 'true' }).status).toBe(0);
    expect(await message(repo)).not.toContain('gonogo');
  });

  it('is added to every agent name, with a mailbox that git and GitHub read as one', () => {
    for (const name of ['flight', 'guido-2', 'a', 'x'.repeat(32), '9lives']) {
      expect(trailerOf(name)).toBe(`Co-Authored-By: ${name} (gonogo) <${name}@gonogo.invalid>`);
      expect(dispatchText(name)).toContain(`"${trailerOf(name)}"`);
    }
    expect(() => dispatchText('Bad Name"; rm -rf /')).toThrow('not an agent name');
    expect(() => dispatchText('a$(touch x)')).toThrow('not an agent name');
  });
});

describe('only the agent\'s own commits', () => {
  const other = (): void => {
    git(repo, 'checkout', '-q', '-b', 'theirs');
    return undefined as never;
  };
  const theirCommit = async (): Promise<string> => {
    other();
    await writeFile(join(repo, 'theirs.txt'), 't\n');
    git(repo, 'add', '-A');
    const env = { ...baseEnv(), GIT_AUTHOR_NAME: 'Director', GIT_AUTHOR_EMAIL: 'd@example.test', GIT_COMMITTER_NAME: 'Director', GIT_COMMITTER_EMAIL: 'd@example.test' };
    expect(run(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'the Director\'s work'], env).status).toBe(0);
    const sha = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'checkout', '-q', 'main');
    return sha;
  };

  it('a cherry-pick of somebody else\'s commit gets no line (the sequencer is running)', async () => {
    const sha = await theirCommit();
    expect(run(repo, ['cherry-pick', sha], agentEnv()).status).toBe(0);
    expect(await message(repo)).not.toContain('gonogo');
  });

  it('a rebase of commits that are not the agent\'s adds nothing', async () => {
    const sha = await theirCommit();
    git(repo, 'checkout', '-q', 'theirs');
    await writeFile(join(repo, 'a.txt'), 'moved on\n');
    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-a', '-m', 'on theirs');
    expect(run(repo, ['rebase', '-q', 'main'], agentEnv()).status).toBe(0);
    expect(git(repo, 'log', '--format=%B', 'main..theirs')).not.toContain('gonogo');
    expect(sha.length).toBeGreaterThan(0);
  });

  it('an amend of the Director\'s commit keeps it his: no line; an amend of the agent\'s own commit keeps its one line', async () => {
    await theirCommit();
    git(repo, 'checkout', '-q', 'theirs');
    const amended = run(repo, ['commit', '-q', '--amend', '-m', 'reworded by the agent'], agentEnv());
    expect(amended.status).toBe(0);
    expect(await message(repo)).not.toContain('gonogo');
    git(repo, 'checkout', '-q', 'main');
    await change();
    run(repo, ['commit', '-q', '-m', 'mine'], agentEnv());
    run(repo, ['commit', '-q', '--amend', '--no-edit'], agentEnv());
    expect(count(await message(repo), trailer)).toBe(1);
  });

  it('a commit with the agent\'s identity set in the environment, or none at all, gets its line', async () => {
    await change();
    const env = { ...agentEnv() } as Record<string, string | undefined>;
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    git(repo, 'config', 'user.name', 'agent');
    git(repo, 'config', 'user.email', 'agent@example.test');
    expect(run(repo, ['commit', '-q', '-m', 'configured identity'], env as Record<string, string>).status).toBe(0);
    expect(count(await message(repo), trailer)).toBe(1);
  });
});

describe('the hooks of the repository keep working', () => {
  it('runs a husky-style relative core.hooksPath pre-commit first, and a failing one still fails the commit', async () => {
    await mkdir(join(repo, '.husky', '_'), { recursive: true });
    await writeFile(join(repo, '.husky', '_', 'pre-commit'), '#!/bin/sh\necho ran >> "$(git rev-parse --show-toplevel)/pre.log"\n[ -f "$(git rev-parse --show-toplevel)/block" ] && exit 1\nexit 0\n');
    await chmod(join(repo, '.husky', '_', 'pre-commit'), 0o755);
    git(repo, 'config', 'core.hooksPath', '.husky/_');
    const extra = await realHookNames(repo, baseEnv());
    expect(extra).toContain('pre-commit');
    await ensureHooksDir(agentDir, 'flight', extra);
    await change();
    expect(run(repo, ['commit', '-q', '-m', 'ok'], agentEnv()).status).toBe(0);
    expect((await readFile(join(repo, 'pre.log'), 'utf8')).trim()).toBe('ran');
    expect(count(await message(repo), trailer)).toBe(1);
    await writeFile(join(repo, 'block'), '1');
    await change();
    const failed = run(repo, ['commit', '-q', '-m', 'blocked'], agentEnv());
    expect(failed.status).not.toBe(0);
    expect(git(repo, 'log', '--format=%s')).not.toContain('blocked');
  });

  it('gives a hook its arguments and its standard input, and its failure is the hook\'s', async () => {
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await writeFile(join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho "$1 $2" > "$PWD/push.args"\ncat > "$PWD/push.stdin"\nexit 3\n');
    await chmod(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    await ensureHooksDir(agentDir, 'flight', await realHookNames(repo, baseEnv()));
    const done = spawnSync(join(hooks, 'pre-push'), ['origin', 'url'], { cwd: repo, env: baseEnv(), input: 'refs/heads/main abc refs/heads/main def\n', encoding: 'utf8' });
    expect(done.status).toBe(3);
    expect((await readFile(join(repo, 'push.args'), 'utf8')).trim()).toBe('origin url');
    expect(await readFile(join(repo, 'push.stdin'), 'utf8')).toBe('refs/heads/main abc refs/heads/main def\n');
  });

  it('chains a hook name that only the repository has (found at start), and skips one that is not executable', async () => {
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await writeFile(join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho post >> "$PWD/post.log"\n');
    await chmod(join(repo, '.git', 'hooks', 'post-commit'), 0o755);
    await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho no >> "$PWD/pre.log"\nexit 1\n');
    await chmod(join(repo, '.git', 'hooks', 'pre-commit'), 0o644);
    await writeFile(join(repo, '.git', 'hooks', 'zz-custom'), '#!/bin/sh\nexit 0\n');
    await chmod(join(repo, '.git', 'hooks', 'zz-custom'), 0o755);
    const extra = await realHookNames(repo, baseEnv());
    expect(extra).toEqual(expect.arrayContaining(['post-commit', 'zz-custom']));
    expect(extra).not.toContain('pre-commit');
    const dir = await ensureHooksDir(agentDir, 'flight', extra);
    expect(await readlink(join(dir, 'zz-custom'))).toBe('dispatch');
    await change();
    expect(run(repo, ['commit', '-q', '-m', 'x'], agentEnv()).status).toBe(0);
    expect((await readFile(join(repo, 'post.log'), 'utf8')).trim()).toBe('post');
    await expect(stat(join(repo, 'pre.log'))).rejects.toThrow();
  });

  it('runs a hook the repository got after the console started (husky install, lefthook install)', async () => {
    // the folder was made before the repository had any hook of its own
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho late >> "$PWD/late.log"\n');
    await chmod(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
    await writeFile(join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 7\n');
    await chmod(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    await change();
    expect(run(repo, ['commit', '-q', '-m', 'x'], agentEnv()).status).toBe(0);
    expect((await readFile(join(repo, 'late.log'), 'utf8')).trim()).toBe('late');
    expect(spawnSync(join(hooks, 'pre-push'), ['o', 'u'], { cwd: repo, env: baseEnv() }).status).toBe(7);
  });

  it('never blocks a commit when git cannot add the line', async () => {
    await writeFile(join(root, 'msg'), 'x\n');
    const done = spawnSync(join(hooks, 'prepare-commit-msg'), [join(root, 'msg'), 'message'], { cwd: repo, env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    expect(done.status).toBe(0);
    expect(await readFile(join(root, 'msg'), 'utf8')).toBe('x\n');
  });

  it('does not run itself when the repository points at the same folder', async () => {
    git(repo, 'config', 'core.hooksPath', hooks);
    await change();
    expect(run(repo, ['commit', '-q', '-m', 'loop'], agentEnv()).status).toBe(0);
  });
});

describe('the environment and the folder', () => {
  it('extends an existing GIT_CONFIG_COUNT and does not replace it', () => {
    expect(coauthorEnv({}, '/h')).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/h', GONOGO_GIT_CONFIG_COUNT: '0' });
    expect(coauthorEnv({ GIT_CONFIG_COUNT: '2' }, '/h')).toEqual({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/h', GONOGO_GIT_CONFIG_COUNT: '2' });
    expect(coauthorEnv({ GIT_CONFIG_COUNT: 'many' }, '/h').GIT_CONFIG_COUNT).toBe('1');
  });

  it('holds the dispatcher and a link for the commit and push hooks and the hooks the repository has, nothing else, and is the same when made again', async () => {
    expect((await readdir(hooks)).sort()).toEqual(['dispatch', ...ALWAYS_LINKED].sort());
    expect((await readdir(hooks))).not.toContain('reference-transaction');
    expect(await readlink(join(hooks, 'prepare-commit-msg'))).toBe('dispatch');
    expect((await stat(join(hooks, 'dispatch'))).mode & 0o777).toBe(0o700);
    await ensureHooksDir(agentDir, 'flight', ['reference-transaction']);
    expect((await readdir(hooks)).sort()).toEqual(['dispatch', 'reference-transaction', ...ALWAYS_LINKED].sort());
    // a hook the repository no longer has loses its link; a name that is not a hook name (a path) is not made
    await ensureHooksDir(agentDir, 'flight', ['../evil', 'a b']);
    expect((await readdir(hooks)).sort()).toEqual(['dispatch', ...ALWAYS_LINKED].sort());
    await expect(lstat(join(agentDir, 'evil'))).rejects.toThrow();
    expect(GIT_HOOK_NAMES).toContain('pre-commit');
  });

  it('finds the hooks of a linked worktree (an absolute path), whatever directory it is asked from', async () => {
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    await chmod(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
    git(repo, 'worktree', 'add', '-q', '-b', 'side2', join(root, 'wt2'));
    await mkdir(join(root, 'wt2', 'sub'));
    expect(await realHookNames(join(root, 'wt2'), baseEnv())).toContain('pre-commit');
    expect(await realHookNames(join(root, 'wt2', 'sub'), baseEnv())).toContain('pre-commit');
  });

  it('keeps the Director\'s own GIT_CONFIG entries when it looks for the repository\'s hooks', async () => {
    const theirs = join(root, 'their-hooks');
    await mkdir(theirs);
    await writeFile(join(theirs, 'pre-commit'), '#!/bin/sh\necho theirs >> "$PWD/their.log"\n');
    await chmod(join(theirs, 'pre-commit'), 0o755);
    const own = { ...baseEnv(), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: theirs };
    expect(await realHookNames(repo, own)).toContain('pre-commit');
    await ensureHooksDir(agentDir, 'flight', ['pre-commit']);
    await change();
    expect(run(repo, ['commit', '-q', '-m', 'x'], { ...own, ...coauthorEnv(own, hooks) }).status).toBe(0);
    expect((await readFile(join(repo, 'their.log'), 'utf8')).trim()).toBe('theirs');
    expect(count(await message(repo), trailer)).toBe(1);
  });

  it('writes neither the repository config nor the user\'s git config', async () => {
    const before = [await readFile(join(repo, '.git', 'config'), 'utf8'), await readdir(join(repo, '.git', 'hooks'))];
    const global = join(homedir(), '.gitconfig');
    const globalBefore = await readFile(global, 'utf8').catch(() => null);
    await change();
    run(repo, ['commit', '-q', '-m', 'x'], agentEnv());
    expect([await readFile(join(repo, '.git', 'config'), 'utf8'), await readdir(join(repo, '.git', 'hooks'))]).toEqual(before);
    expect(await readFile(global, 'utf8').catch(() => null)).toBe(globalBefore);
  });

  it('reads the git version for doctor', () => {
    expect(parseGitVersion('git version 2.39.5')).toEqual([2, 39]);
    expect(gitHasEnvConfig('git version 2.31.0')).toBe(true);
    expect(gitHasEnvConfig('git version 2.30.9')).toBe(false);
    expect(gitHasEnvConfig('git version 3.0.0')).toBe(true);
    expect(doctorLine('git version 2.39.5')).toMatch(/^ok  co-author line/);
    expect(doctorLine('git version 2.20.1')).toContain('needs git 2.31 or newer');
    expect(doctorLine(null)).toContain('not found');
  });
});

describe('the room setting', () => {
  it('is on at first, is saved in a private file, and refuses what is not a boolean', async () => {
    const store = createCoauthorStore({ dir: root });
    await store.load();
    expect(store.view()).toEqual({ enabled: true });
    expect(await store.set({ enabled: false })).toEqual({ enabled: false });
    expect((await stat(join(root, 'coauthor.json'))).mode & 0o777).toBe(0o600);
    const again = createCoauthorStore({ dir: root });
    await again.load();
    expect(again.view().enabled).toBe(false);
    await expect(store.set({ enabled: 'no' })).rejects.toMatchObject({ field: 'enabled' });
    await expect(store.set({ enabled: true, x: 1 })).rejects.toMatchObject({ field: 'x' });
    await store.close();
  });

  it('is on when the file is damaged, which is kept aside, and left alone when it cannot be read', async () => {
    await writeFile(join(root, 'coauthor.json'), '{ nope');
    const store = createCoauthorStore({ dir: root });
    await store.load();
    expect(store.view().enabled).toBe(true);
    expect((await stat(join(root, 'coauthor.json.bad'))).isFile()).toBe(true);
    const other = await mkdtemp(join(tmpdir(), 'gonogo-co-'));
    await mkdir(join(other, 'coauthor.json'));
    const unreadable = createCoauthorStore({ dir: other });
    await unreadable.load();
    expect(unreadable.view().enabled).toBe(true);
    await expect(stat(join(other, 'coauthor.json.bad'))).rejects.toThrow();
    await rm(other, { recursive: true, force: true });
  });
});

describe('the launcher', () => {
  const agent = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'ana', role: 'r', dir: repo, mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...patch });
  const start = async (patch: Partial<AgentRecord>, enabled = true, provider?: 'gemini' | 'custom') => {
    const home = await mkdtemp(join(tmpdir(), 'gonogo-co-home-'));
    try {
      const launcher = createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null' }, coauthor: () => ({ enabled }) });
      const { spec } = await launcher.prepareStart(agent({ ...(provider === undefined ? {} : { provider }), ...(provider === 'custom' ? { command: 'sh' } : {}), ...patch }), { generation: 1, flag: null });
      return { env: spec.env, home, dir: join(home, 'agents', 'ana', 'githooks') };
    } finally {
      // the folder is read by the caller after: removed by the test's own cleanup below
    }
  };
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
  });

  it('sets core.hooksPath for a Claude Code agent, an agent of another engine and a custom command', async () => {
    for (const provider of [undefined, 'gemini', 'custom'] as const) {
      const { env, home, dir } = await start({}, true, provider);
      homes.push(home);
      expect(env.GIT_CONFIG_COUNT, String(provider)).toBe('1');
      expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
      expect(env.GIT_CONFIG_VALUE_0).toBe(dir);
      expect((await readdir(dir)).sort()).toEqual(expect.arrayContaining(['dispatch', 'prepare-commit-msg', 'pre-commit']));
    }
  });

  it('sets nothing for an agent that opted out, when the room is off, and for a Clean Room agent', async () => {
    for (const [patch, enabled] of [[{ coauthor: false as const }, true], [{}, false], [{ cleanRoom: {} }, true]] as const) {
      const { env, home } = await start(patch, enabled);
      homes.push(home);
      expect(env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(await readdir(join(home, 'agents', 'ana')).then((n) => n.includes('githooks'))).toBe(false);
    }
  });
});

describe('the Director\'s commits through Recorder', () => {
  it('get no line, even with the agent\'s environment around', async () => {
    const roots = createRoots({ home: root, agent: () => ({ dir: repo, cleanRoom: false }) });
    git(repo, 'config', 'user.name', 'Director');
    git(repo, 'config', 'user.email', 'd@example.test');
    const recorder = createRecorder(roots, { PATH: process.env.PATH ?? '', ...agentEnv() });
    await writeFile(join(repo, 'r.txt'), 'r\n');
    await recorder.commit('ana', { message: 'by the Director', scope: 'all' });
    const text = await message(repo);
    expect(text).toContain('by the Director');
    expect(text).not.toContain('gonogo');
  });
});
