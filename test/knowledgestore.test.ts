import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/shared/protocol.js';
import { parseClaimsFile, renderClaimsFile } from '../src/server/claimsfile.js';
import type { ParseLegs } from '../src/server/claimsfile.js';
import { ClaimsError, createKnowledgeStore } from '../src/server/knowledgestore.js';
import type { KnowledgeStore } from '../src/server/knowledgestore.js';
import { repoIdOf } from '../src/server/repoid.js';
import type { RepoIdentity } from '../src/server/repoid.js';

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
let dir: string;
let now: number;

const who = (over: Partial<RepoIdentity> = {}): RepoIdentity => {
  const remoteKey = over.remoteKey === undefined ? 'github.com/o/r' : over.remoteKey;
  const rootCommit = over.rootCommit === undefined ? 'a'.repeat(40) : over.rootCommit;
  const full = repoIdOf(remoteKey, rootCommit ?? '');
  return { repoId: full.slice(0, 16), full, remoteKey, rootCommit, provisional: false, local: remoteKey === null, label: 'r', top: '/work/r', commonDir: '/work/r/.git', ...over };
};
const open = (parseLegs?: ParseLegs): KnowledgeStore => createKnowledgeStore({ dir, now: () => now, log: quiet, ...(parseLegs ? { parseLegs } : {}) });
/** A grammar that refuses a leg that holds the word "bad". */
const strict: ParseLegs = (lines) => ({ legs: [], diagnostics: lines.filter((l) => l.text.includes('bad')).map((l) => ({ line: l.line, message: 'bad leg' })) });

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'gonogo-knowledge-')), 'knowledge');
  now = Date.UTC(2026, 10, 21, 12);
});
afterEach(async () => {
  await rm(join(dir, '..'), { recursive: true, force: true });
});

describe('claims.md', () => {
  it('is multivac\'s table, counted from the end so a | in a statement survives, with the anchors under their row', () => {
    const rows = [{ id: 'K-1', statement: 'Use a | pipe, or not', authority: 'director', state: 'active' as const, date: '2026-11-21', source: 'store', anchors: ['<!-- @anchor K-1 brain:src/** "x" present -->'] }];
    const text = renderClaimsFile(rows);
    expect(text).toContain('| ID | statement | authority | state | date | source |');
    expect(text).toContain('| K-1 | Use a | pipe, or not | director | active | 2026-11-21 | store |\n<!-- @anchor K-1');
    const back = parseClaimsFile(text, 'store');
    expect(back.damaged).toBeNull();
    expect(back.rows).toEqual(rows);
    expect(back.claims[0]).toMatchObject({ id: 'K-1', statement: 'Use a | pipe, or not', source: 'store', from: 'store', legs: [] });
  });

  it('says what is wrong with a row, a state, a repeated id and a stray anchor, with its line, and cleans a statement', () => {
    const text = ['| ID | statement | authority | state | date | source |', '|--|--|--|--|--|--|', '| K-1 | ok | director | active | 2026-01-01 | store |', '| K-1 | again | director | active | 2026-01-01 | store |', '| K-2 | s | director | maybe | 2026-01-01 | store |', '| bad id | s | director | active | 2026-01-01 | store |', '| K-3 | too | few |', '<!-- @anchor K-9 brain:x "y" -->', 'free text', `| K-4 | a‮b c${' x'.repeat(200)} | director | active | 2026-01-01 | store |`].join('\n');
    const parsed = parseClaimsFile(text, 'store');
    expect(parsed.rows.map((r) => r.id)).toEqual(['K-1', 'K-4']);
    expect(parsed.rows[1]?.statement).toHaveLength(300);
    expect(parsed.rows[1]?.statement).not.toMatch(/[\u202e]/);
    expect(parsed.diagnostics.map((d) => d.line)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(parseClaimsFile('| K-1 | ‮​x   y | director | active | 2026-01-01 | store |', 'store').rows[0]?.statement).toBe('x y');
  });

  it('a file over 256 KiB, or with over 200 claims, is damaged', () => {
    expect(parseClaimsFile('x'.repeat(256 * 1024 + 1), 'store').damaged).toMatch(/larger than 256 KiB/);
    const many = Array.from({ length: 201 }, (_, i) => `| K-${i + 1} | s | director | active | 2026-01-01 | store |`).join('\n');
    expect(parseClaimsFile(many, 'store').damaged).toMatch(/more than 200 claims/);
  });
});

describe('who is seen', () => {
  it('a new repository is in the index, bound when a hired agent works at its top, and a shallow one writes nothing', async () => {
    const s = open();
    await s.load();
    expect(await s.see(who(), true)).toMatchObject({ bound: true, provisional: false });
    expect(await s.isBound(who().repoId, '/work/r/.git')).toBe(true);
    expect(Object.keys(await s.repos())).toEqual([who().repoId]);
    // not a hired agent's top: seen, not bound
    const other = who({ remoteKey: 'github.com/o/x', commonDir: '/else/.git', label: 'x' });
    expect(await s.see(other, false)).toMatchObject({ bound: false });
    expect(await s.isBound(other.repoId, '/else/.git')).toBe(false);
    const shallow = who({ provisional: true, rootCommit: null, remoteKey: 'github.com/o/s' });
    expect(await s.see(shallow, true)).toEqual({ repoId: shallow.repoId, bound: false, provisional: true });
    expect(Object.keys(await s.repos())).not.toContain(shallow.repoId);
  });

  it('S11: a forged checkout seen first, then the real one: both are listed, the real one needs the click, UNBIND takes the forged one away', async () => {
    const s = open();
    const forged = who({ commonDir: '/agent/forged/.git', top: '/agent/forged' });
    const real = who({ commonDir: '/work/real/.git', top: '/work/real' });
    expect((await s.see(forged, true)).bound).toBe(true);
    expect((await s.see(real, true)).bound).toBe(false);
    const roots = (await s.repos())[real.repoId]?.roots ?? [];
    expect(roots.map((r) => [r.gitCommonDir, r.bound])).toEqual([['/agent/forged/.git', true], ['/work/real/.git', false]]);
    await s.bind(real.repoId, '/work/real/.git', 'bind');
    await s.bind(real.repoId, '/agent/forged/.git', 'unbind');
    expect(await s.isBound(real.repoId, '/work/real/.git')).toBe(true);
    expect(await s.isBound(real.repoId, '/agent/forged/.git')).toBe(false);
    await s.bind(real.repoId, '/work/real/.git', 'ignore');
    expect((await s.repos())[real.repoId]?.roots[1]).toMatchObject({ bound: false, ignored: true });
    await expect(s.bind(real.repoId, '/nowhere/.git', 'bind')).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.bind('zzzz', '/x', 'bind')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a repository that goes by an alias is the canonical one', async () => {
    const s = open();
    const a = who();
    const fork = who({ remoteKey: 'github.com/me/r', commonDir: '/fork/.git' });
    await s.see(a, true);
    await s.see(fork, true);
    await s.alias(fork.repoId, a.repoId);
    expect((await s.see(fork, false)).repoId).toBe(a.repoId);
    await expect(s.alias(a.repoId, fork.repoId)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('looks for the repository it may be (same remote and another root, or the reverse), and keeps apart what the Director says', async () => {
    const s = open();
    const a = who();
    const rewritten = who({ rootCommit: 'b'.repeat(40), label: 'r2' });
    const moved = who({ remoteKey: 'github.com/new/r', label: 'r3' });
    for (const x of [a, rewritten, moved]) await s.see(x, true);
    expect((await s.candidates(a.repoId)).map((c) => [c.label, c.why]).sort()).toEqual([
      ['r2', 'the same remote, another root commit'],
      ['r3', 'the same root commit, another remote'],
    ]);
    await s.keepSeparate(a.repoId, rewritten.repoId);
    expect((await s.candidates(a.repoId)).map((c) => c.label)).toEqual(['r3']);
    expect((await s.candidates(rewritten.repoId)).map((c) => c.label)).not.toContain('r');
  });

  it('remembers the remotes the Director identifies by remote alone', async () => {
    const s = open();
    await s.setRemoteOnly('github.com/o/r', true);
    expect([...(await s.remoteOnly())]).toEqual(['github.com/o/r']);
    await s.setRemoteOnly('github.com/o/r', false);
    expect((await s.remoteOnly()).size).toBe(0);
  });
});

describe('the claims', () => {
  const ready = async (parse?: ParseLegs): Promise<{ s: KnowledgeStore; id: string }> => {
    const s = open(parse);
    await s.see(who(), true);
    return { s, id: who().repoId };
  };

  it('are added with ids K-1, K-2, never used twice even after a delete, in a 0600 file in a 0700 folder', async () => {
    const { s, id } = await ready();
    const one = await s.addClaim(id, { statement: 'The limit is 5.', legs: ['brain:src/** "limit = 5" present'], authority: 'director', source: 'store' });
    expect(one).toMatchObject({ id: 'K-1', statement: 'The limit is 5.', authority: 'director', state: 'active', date: '2026-11-21', source: 'store' });
    await s.deleteClaim(id, 'K-1');
    const two = await s.addClaim(id, { statement: 'Two', legs: [], authority: 'agent-accepted', source: 'proposed by ana' });
    expect(two.id).toBe('K-2');
    expect(two).toMatchObject({ authority: 'agent-accepted', from: 'proposed by ana' });
    expect((await s.claims(id)).claims.map((c) => c.id)).toEqual(['K-2']);
    expect((await stat(join(dir, id, 'claims.md'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, id))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'index.json'))).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, id))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // another process's store reads the same file
    expect((await open().claims(id)).claims.map((c) => c.id)).toEqual(['K-2']);
  });

  it('are edited, retired and refused with the line of what is wrong; a statement is cleaned', async () => {
    const { s, id } = await ready(strict);
    await s.addClaim(id, { statement: 'A', legs: ['brain:a "x"'], authority: 'director', source: 'store' });
    expect((await s.updateClaim(id, 'K-1', { statement: ' B‮\n  c ' })).statement).toBe('B c');
    expect((await s.updateClaim(id, 'K-1', { state: 'retired' })).state).toBe('retired');
    const refused = await s.addClaim(id, { statement: 'C', legs: ['brain:a "x"', 'brain:b "bad"'], authority: 'director', source: 'store' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ClaimsError);
    expect((refused as ClaimsError).diagnostics).toEqual([{ line: 2, message: 'bad leg' }]);
    expect((refused as ClaimsError).field).toBe('anchors');
    expect((await s.claims(id)).claims).toHaveLength(1);
    for (const leg of ['x --> y', 'x <!-- y', 'a\nb', '']) await expect(s.updateClaim(id, 'K-1', { legs: [leg] })).rejects.toBeInstanceOf(ClaimsError);
    await expect(s.updateClaim(id, 'K-9', { state: 'active' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.updateClaim(id, 'K-1', { statement: '  \n ' })).rejects.toMatchObject({ code: 'bad_request', field: 'statement' });
    await expect(s.deleteClaim(id, 'K-9')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('two writers at once make twenty claims with twenty ids, and a stale lock is taken over', async () => {
    const { id } = await ready();
    const [a, b] = [open(), open()];
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).addClaim(id, { statement: `c${i}`, legs: [], authority: 'director', source: 'store' })));
    const ids = (await open().claims(id)).claims.map((c) => c.id);
    expect(new Set(ids).size).toBe(20);
    expect(ids.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `K-${i + 1}`).sort());
    // a lock of a process that is gone, and one that is old
    await writeFile(join(dir, '.lock'), `999999999 ${Date.now()}`);
    await a.addClaim(id, { statement: 'after a dead lock', legs: [], authority: 'director', source: 'store' });
    await writeFile(join(dir, '.lock'), `${process.pid} ${Date.now() - 60_000}`);
    await b.addClaim(id, { statement: 'after an old lock', legs: [], authority: 'director', source: 'store' });
    expect((await open().claims(id)).claims).toHaveLength(22);
  });

  it('a damaged file is kept as claims.md.bad, said so every time, and a new claim starts a new file', async () => {
    const { s, id } = await ready();
    await s.addClaim(id, { statement: 'ok', legs: [], authority: 'director', source: 'store' });
    await writeFile(join(dir, id, 'claims.md'), 'x'.repeat(256 * 1024 + 1));
    expect((await s.claims(id)).damaged).toMatch(/larger than/);
    expect((await readdir(join(dir, id))).sort()).toEqual(['claims.md.bad']);
    expect((await s.claims(id)).damaged).toMatch(/larger than/);
    expect((await s.addClaim(id, { statement: 'again', legs: [], authority: 'director', source: 'store' })).id).toBe('K-2');
    expect((await s.claims(id)).damaged).toBeNull();
  });

  it('an index that is not valid is kept as index.json.bad and the store starts a new one', async () => {
    const s = open();
    await s.load();
    await writeFile(join(dir, 'index.json'), '{ nope');
    expect(await s.repos()).toEqual({});
    expect((await readdir(dir)).sort()).toContain('index.json.bad');
  });

  it('MOVE takes the claims to the target in one rename, refuses a target that has claims, and makes the old id an alias', async () => {
    const s = open();
    const a = who();
    const b = who({ rootCommit: 'b'.repeat(40), label: 'r2', commonDir: '/work/r2/.git' });
    await s.see(a, true);
    await s.see(b, true);
    await s.addClaim(a.repoId, { statement: 'old', legs: [], authority: 'director', source: 'store' });
    await s.addClaim(b.repoId, { statement: 'new', legs: [], authority: 'director', source: 'store' });
    await expect(s.move(b.repoId, a.repoId)).rejects.toMatchObject({ code: 'conflict' });
    expect((await s.claims(a.repoId)).claims.map((c) => c.statement)).toEqual(['old']);
    await s.deleteClaim(b.repoId, 'K-1');
    await rm(join(dir, b.repoId, 'claims.md'));
    await s.move(b.repoId, a.repoId);
    expect((await s.claims(b.repoId)).claims.map((c) => c.statement)).toEqual(['old']);
    expect((await s.see(a, true)).repoId).toBe(b.repoId);
    // ids go on from the larger counter: none is reused
    expect((await s.addClaim(b.repoId, { statement: 'next', legs: [], authority: 'director', source: 'store' })).id).toBe('K-2');
    await mkdir(join(dir, 'x'), { recursive: true });
  });
});
