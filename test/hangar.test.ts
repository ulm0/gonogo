import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANGAR_FILE_MAX_BYTES } from '../src/shared/protocol.js';
import { HANGAR_LIST_MAX, createHangar, createRoots, inside, isGitName, pathParts } from '../src/server/hangar.js';
import type { Hangar, Place } from '../src/server/hangar.js';

let base: string;
let home: string;
let dir: string;
let outside: string;
let places: Record<string, Place>;
let hangar: Hangar;

/** The HubError a call throws, as its code and field, or the answer. */
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
  base = await mkdtemp(join(tmpdir(), 'gonogo-hangar-'));
  home = join(base, 'home');
  dir = join(base, 'project');
  outside = join(base, 'outside');
  await Promise.all([mkdir(home), mkdir(dir), mkdir(outside)]);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  places = { ana: { dir, cleanRoom: false } };
  hangar = createHangar(createRoots({ home, agent: (name) => places[name] ?? null }));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('pathParts', () => {
  it('splits a relative path and drops empty and dot segments', () => {
    expect(pathParts('')).toEqual([]);
    expect(pathParts('a//b/./c.txt')).toEqual(['a', 'b', 'c.txt']);
  });

  it.each([
    ['..', 'forbidden'],
    ['a/../../b', 'forbidden'],
    ['/etc/passwd', 'forbidden'],
    ['//etc', 'forbidden'],
    ['.git/config', 'forbidden'],
    ['a/.GIT/hooks', 'forbidden'],
    ['.g​it/config', 'forbidden'],
    ['a\0b', 'bad_request'],
    ['x'.repeat(1025), 'bad_request'],
  ])('refuses %j', (path, code) => {
    expect(() => pathParts(path)).toThrow(expect.objectContaining({ code }));
  });

  it('refuses what is not a string', () => {
    expect(() => pathParts(7)).toThrow(expect.objectContaining({ code: 'bad_request' }));
  });

  it('knows the names a file system may take for .git', () => {
    expect([isGitName('.git'), isGitName('.GIT'), isGitName('.g﻿it'), isGitName('.gitignore'), isGitName('git')]).toEqual([true, true, true, false, false]);
  });

  it('tells a path inside a folder from a sibling that starts with the same letters', () => {
    expect([inside('/a/b', '/a/b'), inside('/a/b', '/a/b/c'), inside('/a/b', '/a/bc'), inside('/a/b', '/a'), inside('/', '/a')]).toEqual([true, true, false, false, true]);
  });
});

describe('list', () => {
  it('lists folders first, then files by name, with sizes, and leaves .git out', async () => {
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, 'b.txt'), 'bb');
    await writeFile(join(dir, 'a.txt'), 'a');
    await symlink('a.txt', join(dir, 'link'));
    expect(await hangar.list('ana', '')).toEqual({
      path: '',
      truncated: false,
      entries: [
        { name: 'src', kind: 'dir', size: 0 },
        { name: 'a.txt', kind: 'file', size: 1 },
        { name: 'b.txt', kind: 'file', size: 2 },
        { name: 'link', kind: 'link', size: 0 },
      ],
    });
  });

  it('lists a subfolder, and says so when a folder has more entries than it shows', async () => {
    await mkdir(join(dir, 'big'));
    await Promise.all(Array.from({ length: HANGAR_LIST_MAX + 1 }, (_, i) => writeFile(join(dir, 'big', `f${i}`), '')));
    const listing = await hangar.list('ana', 'big/');
    expect(listing.path).toBe('big');
    expect(listing.entries).toHaveLength(HANGAR_LIST_MAX);
    expect(listing.truncated).toBe(true);
  });

  it('answers a file, a missing path and an unknown agent', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    expect(await fails(hangar.list('ana', 'a.txt'))).toMatchObject({ code: 'bad_request' });
    expect(await fails(hangar.list('ana', 'nope'))).toMatchObject({ code: 'not_found' });
    expect(await fails(hangar.list('bob', ''))).toMatchObject({ code: 'not_found', message: 'unknown agent' });
  });

  it('refuses .git, a path that goes up and a link that leads out', async () => {
    await mkdir(join(dir, '.git'));
    await symlink(outside, join(dir, 'out'));
    await symlink(join(dir, '.git'), join(dir, 'inner'));
    for (const path of ['.git', '..', 'out', 'out/..', 'inner']) expect((await fails(hangar.list('ana', path))).code, path).toBe('forbidden');
  });

  it('says so when the folder of the agent is gone', async () => {
    await rm(dir, { recursive: true });
    expect(await fails(hangar.list('ana', ''))).toMatchObject({ code: 'not_found', message: expect.stringContaining('gone') });
  });
});

describe('gonogo\'s own folder', () => {
  it('is left out of a listing and cannot be read, when it is inside the agent\'s folder', async () => {
    const own = join(dir, '.gonogo');
    await mkdir(own);
    await writeFile(join(own, 'agents.json'), '{}');
    await writeFile(join(dir, 'a.txt'), 'a');
    places.ana = { dir, cleanRoom: false };
    hangar = createHangar(createRoots({ home: own, agent: (name) => places[name] ?? null }));
    expect((await hangar.list('ana', '')).entries.map((e) => e.name)).toEqual(['a.txt']);
    expect((await fails(hangar.read('ana', '.gonogo/agents.json'))).code).toBe('forbidden');
    expect((await fails(hangar.create('ana', { path: '.gonogo/x' }))).code).toBe('forbidden');
  });

  it('is the root of an agent in a Clean Room when it is its worktree: the worktree can be read and the rest of the home cannot', async () => {
    await mkdir(join(home, 'cleanroom', 'ana'), { recursive: true });
    await writeFile(join(home, 'cleanroom', 'ana', 'a.txt'), 'in the worktree');
    await writeFile(join(home, 'agents.json'), '{}');
    await symlink(join(home, 'agents.json'), join(home, 'cleanroom', 'ana', 'state'));
    places.ana = { dir, cleanRoom: true };
    expect((await hangar.read('ana', 'a.txt')).text).toBe('in the worktree');
    expect((await fails(hangar.read('ana', 'state'))).code).toBe('forbidden');
  });

  it('opens the worktree of an agent with its own worktree, not its folder, and keeps the rest of the home out', async () => {
    await mkdir(join(home, 'worktrees', 'ana'), { recursive: true });
    await writeFile(join(home, 'worktrees', 'ana', 'a.txt'), 'in the worktree');
    await writeFile(join(dir, 'a.txt'), 'in the main folder');
    await writeFile(join(home, 'agents.json'), '{}');
    await symlink(join(home, 'agents.json'), join(home, 'worktrees', 'ana', 'state'));
    places.ana = { dir, cleanRoom: false, worktree: true };
    expect((await hangar.read('ana', 'a.txt')).text).toBe('in the worktree');
    expect((await fails(hangar.read('ana', 'state'))).code).toBe('forbidden');
  });

  it('says to start the agent when its worktree is not made yet', async () => {
    places.ana = { dir, cleanRoom: false, worktree: true };
    expect(await fails(hangar.list('ana', ''))).toMatchObject({ code: 'not_found', message: expect.stringContaining('start the agent') });
  });

  it('says to start the agent when the Clean Room has no worktree yet', async () => {
    places.ana = { dir, cleanRoom: true };
    expect(await fails(hangar.list('ana', ''))).toMatchObject({ code: 'not_found', message: expect.stringContaining('start the agent') });
  });
});

describe('read', () => {
  it('reads text with its size and an etag that follows the content', async () => {
    await writeFile(join(dir, 'a.txt'), 'héllo\n');
    const first = await hangar.read('ana', 'a.txt');
    expect(first).toMatchObject({ path: 'a.txt', text: 'héllo\n', size: 7 });
    await writeFile(join(dir, 'a.txt'), 'héllp\n');
    expect((await hangar.read('ana', 'a.txt')).etag).not.toBe(first.etag);
  });

  it('keeps a byte order mark and line endings as they are', async () => {
    await writeFile(join(dir, 'a.txt'), '﻿a\r\nb');
    expect((await hangar.read('ana', 'a.txt')).text).toBe('﻿a\r\nb');
  });

  it('refuses a binary file, text that is not UTF-8, a file over the limit, a folder and the root', async () => {
    await writeFile(join(dir, 'bin'), Buffer.from([0x61, 0, 0x62]));
    await writeFile(join(dir, 'latin'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await writeFile(join(dir, 'big'), Buffer.alloc(HANGAR_FILE_MAX_BYTES + 1, 0x61));
    await mkdir(join(dir, 'folder'));
    expect((await fails(hangar.read('ana', 'bin'))).code).toBe('unsupported');
    expect((await fails(hangar.read('ana', 'latin'))).code).toBe('unsupported');
    expect((await fails(hangar.read('ana', 'big'))).code).toBe('too_large');
    expect((await fails(hangar.read('ana', 'folder'))).code).toBe('unsupported');
    expect((await fails(hangar.read('ana', ''))).code).toBe('bad_request');
    await writeFile(join(dir, 'exact'), Buffer.alloc(HANGAR_FILE_MAX_BYTES, 0x61));
    expect((await hangar.read('ana', 'exact')).size).toBe(HANGAR_FILE_MAX_BYTES);
  });

  it('does not wait on a pipe', async () => {
    execFileSync('mkfifo', [join(dir, 'pipe')]);
    expect((await fails(hangar.read('ana', 'pipe'))).code).toBe('unsupported');
  });

  it('follows a link that stays inside and refuses one that leaves, or one into .git', async () => {
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.git', 'config'), '[core]');
    await writeFile(join(dir, 'a.txt'), 'a');
    await symlink('a.txt', join(dir, 'inside'));
    await symlink(join(outside, 'secret.txt'), join(dir, 'leak'));
    await symlink('.git/config', join(dir, 'cfg'));
    await symlink('../outside', join(dir, 'up'));
    expect((await hangar.read('ana', 'inside')).text).toBe('a');
    expect((await fails(hangar.read('ana', 'leak'))).code).toBe('forbidden');
    expect((await fails(hangar.read('ana', 'cfg'))).code).toBe('forbidden');
    expect((await fails(hangar.read('ana', 'up/secret.txt'))).code).toBe('forbidden');
    expect((await fails(hangar.read('ana', '../outside/secret.txt'))).code).toBe('forbidden');
    expect((await fails(hangar.read('ana', outside + '/secret.txt'))).code).toBe('forbidden');
  });
});

describe('save', () => {
  it('writes the text, answers the new etag and leaves nothing beside the file', async () => {
    await writeFile(join(dir, 'a.txt'), 'old');
    const { etag } = await hangar.read('ana', 'a.txt');
    const saved = await hangar.save('ana', { path: 'a.txt', text: 'new é', etag });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new é');
    expect(saved).toEqual({ path: 'a.txt', size: 6, etag: (await hangar.read('ana', 'a.txt')).etag });
    expect(await readdir(dir)).toEqual(['a.txt']);
    // the new etag saves again
    await hangar.save('ana', { path: 'a.txt', text: 'newer', etag: saved.etag });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('newer');
  });

  it('refuses when the file changed on disk since it was read, and writes nothing', async () => {
    await writeFile(join(dir, 'a.txt'), 'old');
    const { etag } = await hangar.read('ana', 'a.txt');
    await writeFile(join(dir, 'a.txt'), 'changed by the agent');
    expect(await fails(hangar.save('ana', { path: 'a.txt', text: 'mine', etag }))).toMatchObject({ code: 'conflict', field: 'etag' });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('changed by the agent');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('refuses when the file changed in the same second with the same size', async () => {
    await writeFile(join(dir, 'a.txt'), 'aaa');
    const { etag } = await hangar.read('ana', 'a.txt');
    await writeFile(join(dir, 'a.txt'), 'bbb');
    expect((await fails(hangar.save('ana', { path: 'a.txt', text: 'x', etag }))).code).toBe('conflict');
  });

  it('lets one of several saves made at once with the same etag win, and refuses the rest', async () => {
    await writeFile(join(dir, 'a.txt'), 'old');
    const { etag } = await hangar.read('ana', 'a.txt');
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => hangar.save('ana', { path: 'a.txt', text: `writer ${i}`, etag })));
    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
    expect(won).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'conflict', field: 'etag' });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe(`writer ${won[0]}`);
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('keeps the mode of the file', async () => {
    await writeFile(join(dir, 'run.sh'), '#!/bin/sh\n');
    await chmod(join(dir, 'run.sh'), 0o755);
    const { etag } = await hangar.read('ana', 'run.sh');
    await hangar.save('ana', { path: 'run.sh', text: '#!/bin/sh\necho\n', etag });
    expect((await stat(join(dir, 'run.sh'))).mode & 0o777).toBe(0o755);
  });

  it('refuses a read-only file, a file that is gone, a folder, a link out and an escape', async () => {
    await writeFile(join(dir, 'ro.txt'), 'ro');
    await chmod(join(dir, 'ro.txt'), 0o444);
    await mkdir(join(dir, 'folder'));
    await symlink(join(outside, 'secret.txt'), join(dir, 'leak'));
    const etag = (await hangar.read('ana', 'ro.txt')).etag;
    expect((await fails(hangar.save('ana', { path: 'ro.txt', text: 'x', etag }))).code).toBe('forbidden');
    expect((await fails(hangar.save('ana', { path: 'gone.txt', text: 'x', etag }))).code).toBe('not_found');
    expect((await fails(hangar.save('ana', { path: 'folder', text: 'x', etag }))).code).toBe('unsupported');
    expect((await fails(hangar.save('ana', { path: 'leak', text: 'x', etag }))).code).toBe('forbidden');
    expect((await fails(hangar.save('ana', { path: '../outside/secret.txt', text: 'x', etag }))).code).toBe('forbidden');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('refuses a body that is wrong: no etag, text that is not a string, a NUL, too much text', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { etag } = await hangar.read('ana', 'a.txt');
    expect(await fails(hangar.save('ana', { path: 'a.txt', text: 'x' }))).toMatchObject({ code: 'bad_request', field: 'etag' });
    expect(await fails(hangar.save('ana', { path: 'a.txt', text: 1, etag }))).toMatchObject({ code: 'bad_request', field: 'text' });
    expect(await fails(hangar.save('ana', { path: 'a.txt', text: 'a\0', etag }))).toMatchObject({ code: 'bad_request', field: 'text' });
    expect((await fails(hangar.save('ana', { path: 'a.txt', text: 'x'.repeat(HANGAR_FILE_MAX_BYTES + 1), etag }))).code).toBe('too_large');
    expect((await fails(hangar.save('ana', [1]))).code).toBe('bad_request');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a');
  });

  it('does not write into .git', async () => {
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.git', 'config'), '[core]');
    expect((await fails(hangar.save('ana', { path: '.git/config', text: 'x', etag: 'a' }))).code).toBe('forbidden');
  });
});

describe('create', () => {
  it('makes a new file, empty or with text, with the etag of what it holds', async () => {
    await mkdir(join(dir, 'src'));
    expect(await hangar.create('ana', { path: 'src/new.ts' })).toMatchObject({ path: 'src/new.ts', size: 0 });
    const made = await hangar.create('ana', { path: 'b.txt', text: 'hi' });
    expect(made.etag).toBe((await hangar.read('ana', 'b.txt')).etag);
    expect((await stat(join(dir, 'b.txt'))).mode & 0o777 & ~0o022).toBe(0o644);
  });

  it('never replaces a file, and never writes through a link', async () => {
    await writeFile(join(dir, 'a.txt'), 'keep');
    await symlink(join(outside, 'planted.txt'), join(dir, 'dangling'));
    await symlink(join(outside, 'secret.txt'), join(dir, 'leak'));
    expect((await fails(hangar.create('ana', { path: 'a.txt', text: 'x' }))).code).toBe('conflict');
    expect((await fails(hangar.create('ana', { path: 'dangling', text: 'x' }))).code).toBe('conflict');
    expect((await fails(hangar.create('ana', { path: 'leak', text: 'x' }))).code).toBe('conflict');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('keep');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(await readdir(outside)).toEqual(['secret.txt']);
    expect((await lstat(join(dir, 'dangling'))).isSymbolicLink()).toBe(true);
  });

  it('refuses a folder that is not there, an escape, a path in .git, a folder that is a link out and a name that is no file', async () => {
    await symlink(outside, join(dir, 'out'));
    await writeFile(join(dir, 'a.txt'), 'a');
    expect((await fails(hangar.create('ana', { path: 'nope/x.txt' }))).code).toBe('not_found');
    expect((await fails(hangar.create('ana', { path: '../x.txt' }))).code).toBe('forbidden');
    expect((await fails(hangar.create('ana', { path: '.git/x' }))).code).toBe('forbidden');
    expect((await fails(hangar.create('ana', { path: 'out/x.txt' }))).code).toBe('forbidden');
    expect((await fails(hangar.create('ana', { path: 'a.txt/x' }))).code).toBe('bad_request');
    expect((await fails(hangar.create('ana', { path: '' }))).code).toBe('bad_request');
    expect((await fails(hangar.create('ana', { path: 'x'.repeat(300) }))).code).toBe('bad_request');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });
});
