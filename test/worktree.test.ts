/**
 * Worktrees (docs/worktrees-spec.md): the setting reader, the git worktree of an agent and where a plain start runs, with a real
 * git repository in a temp folder. No Docker, no model.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/shared/protocol.js';
import { WORKTREE_NOTE } from '../src/server/constants.js';
import { createLauncher } from '../src/server/launcher.js';
import { checkWorktree, parseWorktree, prepareWorktree, worktreeBranch, worktreePath } from '../src/server/worktree.js';
import { cleanRoomEnv, fakeDockerBin, makeRepo } from './clean-room-helpers.js';

const SID = '0b2f5c1e-6d3a-4f7e-9a1b-2c3d4e5f6a7b';

let tmp: string;
let home: string;
let repo: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-'));
  home = join(tmp, 'home');
  repo = join(tmp, 'repo');
  await mkdir(home);
  await mkdir(repo);
  repo = await realpath(repo);
  await makeRepo(repo);
  env = cleanRoomEnv(await fakeDockerBin(tmp));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  name: 'ana',
  role: 'reviews',
  dir: repo,
  mode: 'default',
  sessionId: SID,
  desk: 1,
  boss: false,
  createdAt: 1,
  worktree: {},
  ...patch,
});

describe('parseWorktree', () => {
  it('takes an object without fields, and nothing else', () => {
    expect(parseWorktree({})).toEqual({ ok: true, worktree: {} });
    expect(parseWorktree({ base: undefined })).toEqual({ ok: true, worktree: {} });
    for (const bad of [null, [], 'yes', 3, true]) expect(parseWorktree(bad)).toEqual({ ok: false, error: 'worktree must be an object' });
    expect(parseWorktree({ branch: 'x' })).toEqual({ ok: false, error: 'worktree has no field "branch"' });
  });

  it('puts the worktree in <home>/worktrees/<name> on the branch of a Clean Room', () => {
    expect(worktreePath('/h', 'ana')).toBe('/h/worktrees/ana');
    expect(worktreeBranch('ana')).toBe('gonogo/ana');
  });
});

describe('checkWorktree', () => {
  it('is null inside a repository (a sub-folder too) and says why outside one', async () => {
    expect(await checkWorktree(repo, env)).toBeNull();
    expect(await checkWorktree(join(repo, 'sub'), env)).toBeNull();
    const outside = join(tmp, 'plain');
    await mkdir(outside);
    expect(await checkWorktree(outside, env)).toMatch(/a worktree needs the directory to be inside a git repository/);
  });
});

describe('prepareWorktree', () => {
  it('makes the worktree once on a new branch from HEAD, starts in the same sub-folder, and finds it again', async () => {
    const place = await prepareWorktree(record({ dir: join(repo, 'sub') }), home, env);
    expect(place).toEqual({ worktree: join(home, 'worktrees', 'ana'), branch: 'gonogo/ana', cwd: join(home, 'worktrees', 'ana', 'sub') });
    expect(await readFile(join(place.cwd, 'b.txt'), 'utf8')).toBe('b\n');
    expect(git(place.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('gonogo/ana');
    await writeFile(join(place.cwd, 'work.txt'), 'kept\n');
    await prepareWorktree(record({ dir: join(repo, 'sub') }), home, env);
    expect(await readFile(join(place.cwd, 'work.txt'), 'utf8')).toBe('kept\n');
  });

  it('makes a deleted folder again on the old branch, and uses a branch that exists as it is', async () => {
    const first = await prepareWorktree(record(), home, env);
    await writeFile(join(first.worktree, 'c.txt'), 'c\n');
    git(first.worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'add', 'c.txt');
    git(first.worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'work');
    await rm(first.worktree, { recursive: true });
    const again = await prepareWorktree(record(), home, env);
    expect(await readFile(join(again.worktree, 'c.txt'), 'utf8')).toBe('c\n');
  });

  it('gives two agents two worktrees with no shared index', async () => {
    const ana = await prepareWorktree(record(), home, env);
    const ben = await prepareWorktree(record({ name: 'ben' }), home, env);
    expect(ana.worktree).not.toBe(ben.worktree);
    await writeFile(join(ana.worktree, 'only-ana.txt'), 'x\n');
    git(ana.worktree, 'add', 'only-ana.txt');
    expect(git(ben.worktree, 'status', '--porcelain')).toBe('');
    expect(await exists(join(ben.worktree, 'only-ana.txt'))).toBe(false);
  });

  it('refuses a directory outside a repository, a folder git does not know, and a folder that is not committed', async () => {
    const outside = join(tmp, 'plain');
    await mkdir(outside);
    await expect(prepareWorktree(record({ dir: outside }), home, env)).rejects.toThrow(/inside a git repository/);
    await mkdir(join(home, 'worktrees', 'ana'), { recursive: true });
    await expect(prepareWorktree(record(), home, env)).rejects.toThrow(/exists but is not a worktree of/);
    await mkdir(join(repo, 'draft'));
    await expect(prepareWorktree(record({ name: 'cy', dir: join(repo, 'draft') }), home, env)).rejects.toThrow(/draft is not in the worktree .*not committed/);
  });
});

describe('the launcher starts a worktree agent in its worktree', () => {
  const launcher = () => createLauncher({ homeDir: home, hubUrl: () => 'http://127.0.0.1:7777', seed: false, env });

  it('runs claude on the host in the same sub-folder of the worktree, with the note in the role', async () => {
    const { spec } = await launcher().prepareStart(record({ dir: join(repo, 'sub') }), { generation: 1, flag: null });
    const cwd = join(home, 'worktrees', 'ana', 'sub');
    expect(spec.cwd).toBe(cwd);
    expect(spec.file).not.toBe('docker');
    const role = spec.args[spec.args.indexOf('--append-system-prompt') + 1] ?? spec.args.join('\n');
    expect(spec.args.join('\n')).toContain(WORKTREE_NOTE.replace('{branch}', 'gonogo/ana'));
    expect(role).toBeTruthy();
  });

  it('leaves an agent without the setting in its own folder, with no note', async () => {
    const plain = record();
    delete plain.worktree;
    const { spec } = await launcher().prepareStart(plain, { generation: 1, flag: null });
    expect(spec.cwd).toBe(repo);
    expect(spec.args.join('\n')).not.toContain('git worktree on the branch');
    expect(await exists(join(home, 'worktrees'))).toBe(false);
  });

  it('refuses to start when the folder is no longer inside a repository, and leaves nothing behind', async () => {
    const outside = join(tmp, 'plain');
    await mkdir(outside);
    await expect(launcher().prepareStart(record({ dir: outside }), { generation: 1, flag: null })).rejects.toThrow(/inside a git repository/);
  });
});
