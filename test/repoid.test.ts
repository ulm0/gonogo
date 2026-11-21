import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identify, normalizeRemote, repoIdOf } from '../src/server/repoid.js';
import { createSafeGit } from '../src/server/safegit.js';

const TOKEN = 'ghp_SECRETTOKEN0123456789';
let root: string;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const safe = createSafeGit();

async function repo(path: string, commits = 1): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  for (let i = 0; i < commits; i += 1) {
    await writeFile(join(path, `f${i}.txt`), String(i));
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', `c${i}`);
  }
  return realpath(path);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gonogo-repoid-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the remote key', () => {
  it('is host/path whatever the form, and carries no scheme, user, token, port, query or fragment', () => {
    for (const url of [
      'https://github.com/o/r.git',
      'https://github.com/o/r',
      'https://github.com/o/r/',
      'HTTPS://GitHub.com/o/r.git',
      'git@github.com:o/r.git',
      'ssh://git@github.com/o/r.git',
      'ssh://git@github.com:22/o/r.git',
      'git://github.com/o/r.git',
      `https://x-access-token:${TOKEN}@github.com/o/r?x=y#frag`,
      `https://user:${TOKEN}@github.com:443/o/r.git?tab=1`,
      '  https://github.com/o/r.git \n',
    ]) {
      expect(normalizeRemote(url), url).toBe('github.com/o/r');
    }
    expect(normalizeRemote('https://gitlab.example.com/group/sub/r.git')).toBe('gitlab.example.com/group/sub/r');
  });

  it('is null for what names no host', () => {
    for (const url of ['', '   ', '/srv/git/r.git', '../r', 'file:///srv/git/r.git', 'https://github.com', 'https://github.com/', 'C:\\repos\\r']) expect(normalizeRemote(url), url).toBeNull();
  });

  it('never keeps the token anywhere in its answer', () => {
    expect(normalizeRemote(`https://x-access-token:${TOKEN}@github.com/o/r?x=y`)).not.toContain(TOKEN);
  });
});

describe('who a checkout is', () => {
  it('is the same for two clones of one history with one remote, and different for a fork (another remote)', async () => {
    const a = await repo(join(root, 'a'));
    git(a, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    const b = join(root, 'b');
    git(root, 'clone', '-q', a, b);
    git(b, 'remote', 'set-url', 'origin', `git@github.com:o/r`);
    const fork = join(root, 'fork');
    git(root, 'clone', '-q', a, fork);
    git(fork, 'remote', 'set-url', 'origin', 'https://github.com/me/r.git');
    const [ia, ib, ifork] = await Promise.all([identify(safe, a), identify(safe, b), identify(safe, fork)]);
    expect(ia?.remoteKey).toBe('github.com/o/r');
    expect(ib?.repoId).toBe(ia?.repoId);
    expect(ifork?.repoId).not.toBe(ia?.repoId);
    expect(ifork?.rootCommit).toBe(ia?.rootCommit);
    expect(ia?.repoId).toMatch(/^[0-9a-f]{16}$/);
    expect(ia?.full).toHaveLength(64);
    expect(ia).toMatchObject({ provisional: false, local: false, label: 'a' });
  });

  it('uses origin, else the only remote, else none (then the id comes from the root commit alone and is local)', async () => {
    const a = await repo(join(root, 'a'));
    expect(await identify(safe, a)).toMatchObject({ remoteKey: null, local: true });
    git(a, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    expect((await identify(safe, a))?.remoteKey).toBe('example.com/u/r');
    git(a, 'remote', 'add', 'other', 'https://example.com/x/y.git');
    expect((await identify(safe, a))?.remoteKey).toBeNull();
    git(a, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    expect((await identify(safe, a))?.remoteKey).toBe('example.com/o/r');
    const none = await repo(join(root, 'none'));
    const id = await identify(safe, none);
    expect(id?.full).toBe(repoIdOf(null, id?.rootCommit ?? ''));
  });

  it('a remote URL with a token appears nowhere in what identify returns', async () => {
    const a = await repo(join(root, 'a'));
    git(a, 'remote', 'add', 'origin', `https://x-access-token:${TOKEN}@github.com/o/r?x=y#f`);
    const id = await identify(safe, a);
    expect(JSON.stringify(id)).not.toContain(TOKEN);
    expect(id?.remoteKey).toBe('github.com/o/r');
  });

  it('a worktree has the id of its main checkout and the same common directory', async () => {
    const a = await repo(join(root, 'a'));
    git(a, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    const wt = join(root, 'wt');
    git(a, 'worktree', 'add', '-q', '-b', 'side', wt);
    const [ia, iw] = await Promise.all([identify(safe, a), identify(safe, wt)]);
    expect(iw?.repoId).toBe(ia?.repoId);
    expect(iw?.commonDir).toBe(ia?.commonDir);
    expect(iw?.top).toBe(await realpath(wt));
    expect(iw?.top).not.toBe(ia?.top);
  });

  it('with several root commits takes the smallest', async () => {
    const a = await repo(join(root, 'a'), 2);
    git(a, 'checkout', '-q', '--orphan', 'other');
    await writeFile(join(a, 'o.txt'), 'o');
    git(a, 'add', 'o.txt');
    git(a, 'commit', '-q', '-m', 'root2');
    git(a, 'checkout', '-q', 'main');
    git(a, 'merge', '-q', '--allow-unrelated-histories', '-m', 'merge', 'other');
    const roots = git(a, 'rev-list', '--max-parents=0', 'HEAD').trim().split('\n').sort();
    expect(roots).toHaveLength(2);
    expect((await identify(safe, a))?.rootCommit).toBe(roots[0]);
  });

  it('a shallow clone is provisional, until the Director identifies it by its remote alone', async () => {
    const a = await repo(join(root, 'a'), 3);
    const s = join(root, 's');
    git(root, 'clone', '-q', '--depth', '1', `file://${a}`, s);
    git(s, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    const prov = await identify(safe, s);
    expect(prov).toMatchObject({ provisional: true, rootCommit: null, remoteKey: 'github.com/o/r' });
    const byRemote = await identify(safe, s, new Set(['github.com/o/r']));
    expect(byRemote?.provisional).toBe(false);
    expect(byRemote?.full).toBe(repoIdOf('github.com/o/r', ''));
    // the unshallowed clone has its own, final, id
    git(s, 'fetch', '-q', '--unshallow', `file://${a}`);
    const full = await identify(safe, s);
    expect(full?.provisional).toBe(false);
    expect(full?.repoId).not.toBe(prov?.repoId);
  });

  it('is provisional with no commit yet, and null outside a repository', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    git(empty, 'init', '-q', '-b', 'main');
    expect(await identify(safe, empty)).toMatchObject({ provisional: true, rootCommit: null });
    const plain = join(root, 'plain');
    await mkdir(plain);
    expect(await identify(safe, plain)).toBeNull();
  });
});
