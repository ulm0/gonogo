import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoots } from '../src/server/hangar.js';
import type { Place } from '../src/server/hangar.js';
import { RECORDER_LOG_MAX } from '../src/shared/protocol.js';
import { RECORDER_DIFF_CAP, createRecorder } from '../src/server/recorder.js';
import type { Recorder } from '../src/server/recorder.js';

let base: string;
let home: string;
let dir: string;
let identityHome: string;
let places: Record<string, Place>;
let recorder: Recorder;

const IDENTITY = '[user]\n\tname = Ada Director\n\temail = ada@example.test\n';

/** git as the test's own user, in the repository, never with the identity or the config of whoever runs the tests. */
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', ...args], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: identityHome }, encoding: 'utf8' });

const make = (env: Record<string, string>): Recorder => createRecorder(createRoots({ home, agent: (name) => places[name] ?? null }), { PATH: process.env.PATH, HOME: identityHome, ...env });

async function fails(work: Promise<unknown>): Promise<{ code: string; message: string; field?: string }> {
  try {
    await work;
  } catch (e) {
    const { code, message, field } = e as { code: string; message: string; field?: string };
    return { code, message, ...(field === undefined ? {} : { field }) };
  }
  throw new Error('the call did not fail');
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gonogo-recorder-'));
  home = join(base, 'home');
  dir = join(base, 'project');
  identityHome = join(base, 'user');
  await Promise.all([mkdir(home), mkdir(dir), mkdir(identityHome)]);
  await writeFile(join(identityHome, '.gitconfig'), IDENTITY);
  places = { ana: { dir, cleanRoom: false } };
  recorder = make({});
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const init = async (): Promise<void> => {
  git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
};

describe('status', () => {
  it('says why a folder is not a repository, and that a subfolder of one is not its top', async () => {
    expect(await recorder.status('ana')).toEqual({ repo: false, reason: 'this folder is not in a git repository' });
    await init();
    await mkdir(join(dir, 'sub'));
    places.sub = { dir: join(dir, 'sub'), cleanRoom: false };
    expect(await recorder.status('sub')).toMatchObject({ repo: false, reason: expect.stringContaining('works at the top of a repository') });
  });

  it('refuses a repository that holds gonogo\'s own folder', async () => {
    await init();
    const inner = join(dir, '.gonogo');
    await mkdir(inner);
    recorder = createRecorder(createRoots({ home: inner, agent: (name) => places[name] ?? null }), { PATH: process.env.PATH, HOME: identityHome });
    expect(await recorder.status('ana')).toMatchObject({ repo: false, reason: expect.stringContaining('gonogo\'s own folder') });
    expect((await fails(recorder.commit('ana', { message: 'm', scope: 'all' }))).code).toBe('conflict');
  });

  it('lists the branch, the author of the git config and each file with its index and tree letters', async () => {
    await init();
    await writeFile(join(dir, 'b.txt'), 'b\n');
    await writeFile(join(dir, 'c.txt'), 'c\n');
    git('add', 'c.txt');
    await writeFile(join(dir, 'c.txt'), 'c2\n');
    await writeFile(join(dir, 'a.txt'), 'one more\n');
    git('mv', 'a.txt', 'renamed.txt');
    await writeFile(join(dir, 'renamed.txt'), 'edited\n');
    const status = await recorder.status('ana');
    expect(status).toMatchObject({ repo: true, branch: 'main', more: 0, author: { name: 'Ada Director', email: 'ada@example.test' } });
    if (!status.repo) throw new Error('not a repo');
    expect(status.files).toEqual(
      expect.arrayContaining([
        { path: 'b.txt', index: '?', tree: '?' },
        { path: 'c.txt', index: 'A', tree: 'M' },
        { path: 'renamed.txt', index: 'R', tree: 'M', from: 'a.txt' },
      ]),
    );
    expect(status.files).toHaveLength(3);
  });

  it('knows a repository with no commit, and a git config with no author', async () => {
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'a.txt'), 'x');
    await unlink(join(identityHome, '.gitconfig'));
    const status = await recorder.status('ana');
    expect(status).toMatchObject({ repo: true, author: null, branch: expect.stringContaining('No commits yet') });
  });

  it('is not moved by GIT_DIR in the environment gonogo runs in', async () => {
    await init();
    const other = make({ GIT_DIR: join(base, 'nowhere'), GIT_WORK_TREE: base });
    expect(await other.status('ana')).toMatchObject({ repo: true, branch: 'main' });
  });

  it('does not run the program a repository names as its file system monitor', async () => {
    await init();
    const marker = join(base, 'ran');
    await writeFile(join(base, 'monitor.sh'), `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(join(base, 'monitor.sh'), 0o755);
    git('config', 'core.fsmonitor', `"${join(base, 'monitor.sh')}"`);
    await writeFile(join(dir, 'a.txt'), 'changed\n');
    git('status');
    expect(existsSync(marker), 'plain git runs it').toBe(true);
    await unlink(marker);
    await recorder.status('ana');
    await recorder.diff('ana', '', false);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('diff', () => {
  beforeEach(init);

  it('shows the working tree against the index, or the index against the last commit, for one file or all', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await writeFile(join(dir, 'b.txt'), 'b\n');
    git('add', 'b.txt');
    expect((await recorder.diff('ana', 'a.txt', false)).diff).toContain('+two');
    expect((await recorder.diff('ana', '', false)).diff).not.toContain('b.txt');
    expect((await recorder.diff('ana', '', true)).diff).toContain('+++ b/b.txt');
    expect((await recorder.diff('ana', 'a.txt', true)).diff).toBe('');
    expect(await recorder.diff('ana', 'a.txt', false)).toMatchObject({ truncated: false });
  });

  it('cuts a diff that is larger than the cap', async () => {
    await writeFile(join(dir, 'a.txt'), Array.from({ length: 30_000 }, (_, i) => `line number ${i}`).join('\n'));
    const diff = await recorder.diff('ana', '', false);
    expect(diff.truncated).toBe(true);
    expect(diff.diff.length).toBeLessThanOrEqual(RECORDER_DIFF_CAP);
  });

  it('takes a path as a name, not as a pathspec, and refuses one that leaves the folder or enters .git', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    expect((await recorder.diff('ana', ':(exclude)a.txt', false)).diff).toBe('');
    expect((await recorder.diff('ana', ':(top)a.txt', false)).diff).toBe('');
    for (const path of ['../x', '/etc/passwd', '.git/config']) expect((await fails(recorder.diff('ana', path, false))).code, path).toBe('forbidden');
  });
});

describe('log', () => {
  it('lists nothing before the first commit', async () => {
    git('init', '-q', '-b', 'main');
    expect(await recorder.log('ana')).toEqual([]);
  });

  it('lists the last 50 commits, newest first, with author, time and subject', async () => {
    await init();
    for (let i = 0; i < RECORDER_LOG_MAX + 4; i += 1) git('commit', '-q', '--allow-empty', '-m', `commit ${i}`);
    const commits = await recorder.log('ana');
    expect(commits).toHaveLength(RECORDER_LOG_MAX);
    expect(commits[0]).toMatchObject({ author: 'Seed', subject: `commit ${RECORDER_LOG_MAX + 3}` });
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(Math.abs((commits[0]?.at ?? 0) - Date.now())).toBeLessThan(60_000);
  });
});

describe('commit', () => {
  beforeEach(init);

  it('commits every change, new files included, as the author of the git config', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await writeFile(join(dir, 'new.txt'), 'new\n');
    const { commit } = await recorder.commit('ana', { message: '-fix: a  "quoted" thing\n\nbody', scope: 'all' });
    expect(commit).toMatchObject({ author: 'Ada Director', subject: '-fix: a  "quoted" thing' });
    expect(git('status', '--porcelain')).toBe('');
    expect(git('log', '-1', '--format=%an <%ae>%n%B')).toBe('Ada Director <ada@example.test>\n-fix: a  "quoted" thing\n\nbody\n\n');
  });

  it('commits only what is staged, and leaves the rest as it was', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await writeFile(join(dir, 'staged.txt'), 's\n');
    git('add', 'staged.txt');
    await recorder.commit('ana', { message: 'only staged', scope: 'staged' });
    expect(git('show', '--stat', '--format=', 'HEAD')).toContain('staged.txt');
    expect(git('show', '--stat', '--format=', 'HEAD')).not.toContain('a.txt');
    expect(git('status', '--porcelain')).toBe(' M a.txt\n');
  });

  it('refuses when there is nothing to commit, and when nothing is staged', async () => {
    expect(await fails(recorder.commit('ana', { message: 'm', scope: 'all' }))).toMatchObject({ code: 'conflict', message: expect.stringContaining('nothing to commit') });
    await writeFile(join(dir, 'a.txt'), 'two\n');
    expect(await fails(recorder.commit('ana', { message: 'm', scope: 'staged' }))).toMatchObject({ code: 'conflict', message: 'nothing is staged' });
    expect(git('status', '--porcelain')).toBe(' M a.txt\n');
  });

  it('refuses a message that is empty, too long or has a NUL, and a scope it does not know', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    expect(await fails(recorder.commit('ana', { message: '  \n', scope: 'all' }))).toMatchObject({ code: 'bad_request', field: 'message' });
    expect((await fails(recorder.commit('ana', { message: 'x'.repeat(10_001), scope: 'all' }))).field).toBe('message');
    expect((await fails(recorder.commit('ana', { message: 'a\0b', scope: 'all' }))).field).toBe('message');
    expect((await fails(recorder.commit('ana', { message: 'm', scope: 'everything' }))).field).toBe('scope');
    expect((await fails(recorder.commit('ana', { message: 'm' }))).field).toBe('scope');
    expect((await fails(recorder.commit('ana', [1]))).code).toBe('bad_request');
    expect(git('status', '--porcelain')).toBe(' M a.txt\n');
  });

  it('says so and commits nothing when git has no author, and never invents one', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await unlink(join(identityHome, '.gitconfig'));
    expect(await fails(recorder.commit('ana', { message: 'm', scope: 'all' }))).toMatchObject({ code: 'conflict', field: 'author', message: expect.stringContaining('git has no author') });
    expect(git('log', '--format=%s')).toBe('first\n');
    expect(git('status', '--porcelain')).toBe(' M a.txt\n');
  });

  it('runs no hook, neither the repository\'s own nor one a config names', async () => {
    const marker = join(base, 'hook-ran');
    const hook = `#!/bin/sh\ntouch "${marker}"\nexit 1\n`;
    await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), hook);
    await chmod(join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
    await writeFile(join(dir, 'a.txt'), 'two\n');
    git('add', '-A');
    expect(() => git('commit', '-q', '-m', 'control')).toThrow();
    expect(existsSync(marker), 'plain git runs it').toBe(true);
    await unlink(marker);
    await mkdir(join(dir, 'myhooks'));
    await writeFile(join(dir, 'myhooks', 'pre-commit'), hook);
    await chmod(join(dir, 'myhooks', 'pre-commit'), 0o755);
    git('config', 'core.hooksPath', join(dir, 'myhooks'));
    await recorder.commit('ana', { message: 'hooks off', scope: 'all' });
    expect(existsSync(marker)).toBe(false);
    expect(git('log', '-1', '--format=%s')).toBe('hooks off\n');
  });

  it('turns a failure of git into an answer with its first line', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await writeFile(join(dir, '.git', 'index.lock'), '');
    expect(await fails(recorder.commit('ana', { message: 'm', scope: 'all' }))).toMatchObject({ code: 'conflict', message: expect.stringContaining('git refused') });
  });
});
