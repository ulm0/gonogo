import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLegLines } from '../src/server/anchorgrammar.js';
import { nullLogger } from '../src/server/constants.js';
import { BUNDLE_MAX_BYTES, BUNDLE_REPOS_MAX, escapeEre, exportBundle, planImport, readBundleFile, toMultivac } from '../src/server/knowledgeio.js';
import type { Bundle } from '../src/server/knowledgeio.js';
import { runKnowledgeCli } from '../src/server/knowledgecli.js';
import { createKnowledgeStore } from '../src/server/knowledgestore.js';
import type { KnowledgeStore } from '../src/server/knowledgestore.js';
import { repoIdOf } from '../src/server/repoid.js';
import type { RepoIdentity } from '../src/server/repoid.js';

// Export and import of the Knowledge store (src/server/knowledgeio.ts, knowledgecli.ts): a real store in a temporary folder, the real grammar.

const ROOT_A = 'a'.repeat(40);
const ROOT_B = 'b'.repeat(40);
const NOW = Date.UTC(2026, 10, 21, 12, 0);
let tmp: string;
let dir: string;
let store: KnowledgeStore;

const who = (remoteKey: string | null, rootCommit: string, label = 'proj'): RepoIdentity => {
  const full = repoIdOf(remoteKey, rootCommit);
  return { repoId: full.slice(0, 16), full, remoteKey, rootCommit, provisional: false, local: remoteKey === null, label, top: `/work/${label}`, commonDir: `/work/${label}/.git` };
};
const open = (path: string): KnowledgeStore => createKnowledgeStore({ dir: path, now: () => NOW, parseLegs: parseLegLines, log: nullLogger });
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gonogo-kio-'));
  dir = join(tmp, 'knowledge');
  store = open(dir);
  await store.load();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const A = who('github.com/o/proj', ROOT_A);
/** A repository with two claims, one of them with a literal leg and a regex leg, and a ritual. */
async function seed(): Promise<void> {
  await store.see(A, true);
  await store.addClaim(A.repoId, { statement: 'The limit is 5.', legs: ['brain:src/**/limit.ts "LIMIT = 5"', 'brain:src/** !src/old/** /export const [A-Z]+/ count=2'], authority: 'director', source: 'store' });
  await store.addClaim(A.repoId, { statement: 'No console.log.', legs: ['brain:src/** /console\\.log/ absent'], authority: 'director', source: 'store' });
}

describe('the multivac form', () => {
  it('escapes every operator of POSIX ERE, the slash included, and nothing else', () => {
    expect(escapeEre('a.b(c)[d]{e}|f*g+h?i^j$k\\l/m')).toBe('a\\.b\\(c\\)\\[d\\]\\{e\\}\\|f\\*g\\+h\\?i\\^j\\$k\\\\l\\/m');
    expect(escapeEre('plain words-and_digits 123, "quoted"')).toBe('plain words-and_digits 123, "quoted"');
  });

  it('rewrites a literal leg as an escaped regex that the gate accepts and that means the same, keeping the exclusions and the mode', () => {
    const line = '<!-- @anchor K-1 brain:src/** !src/old/** "a.b(c)" count=2 -->';
    const out = toMultivac(`| K-1 | x | director | active | 2026-11-21 | store |\n${line}\n`);
    const anchor = out.text.split('\n').find((l) => l.startsWith('<!--')) as string;
    expect(anchor).toBe('<!-- @anchor K-1 brain:src/** !src/old/** /a\\.b\\(c\\)/ count=2 -->');
    const leg = parseLegLines([{ line: 1, text: anchor }], 'K-1');
    expect(leg.diagnostics).toEqual([]);
    expect(leg.legs[0]).toMatchObject({ mode: 'count', count: 2, excludes: ['src/old/**'], pattern: { kind: 'regex', source: 'a\\.b\\(c\\)', i: false } });
    expect(out.notes).toEqual([]);
  });

  it('leaves a regex leg and every other line as it was, and drops a leg whose regex would pass the limit, saying so', () => {
    const regex = '<!-- @anchor K-2 brain:src/** /console\\.log/ absent -->';
    const row = '| K-2 | y | director | active | 2026-11-21 | store |';
    const long = `<!-- @anchor K-2 brain:src/** "${'.'.repeat(120)}" -->`;
    const out = toMultivac(`${row}\n${regex}\n${long}\n`);
    expect(out.text.split('\n')).toEqual([row, regex, '']);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toMatch(/K-2: a leg was left out/);
  });
});

describe('export', () => {
  it('is one bundle of version 1 with the claims, the ritual and the identity, and no path, binding or proposal', async () => {
    await seed();
    await mkdir(join(dir, A.repoId), { recursive: true });
    await writeFile(join(dir, A.repoId, 'ritual.md'), '- tell flight\n');
    const { bundle } = await exportBundle(store, dir, { multivac: false, now: () => NOW });
    expect(bundle.version).toBe(1);
    expect(bundle.exportedAt).toBe(new Date(NOW).toISOString());
    expect(bundle.repos).toHaveLength(1);
    const repo = bundle.repos[0] as Bundle['repos'][number];
    expect(repo).toMatchObject({ repoId: A.repoId, label: 'proj', remoteKey: 'github.com/o/proj', rootCommit: ROOT_A, ritual: '- tell flight\n' });
    expect(repo.claims).toContain('| K-1 | The limit is 5. | director | active | 2026-11-21 | store |');
    expect(repo.claims).toContain('<!-- @anchor K-1 brain:src/**/limit.ts "LIMIT = 5" -->');
    expect(repo.multivac).toBeUndefined();
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('/work/');
    expect(json).not.toContain('gitCommonDir');
    expect(json).not.toContain('roots');
  });

  it('with multivac adds the converted claims beside the originals', async () => {
    await seed();
    const { bundle } = await exportBundle(store, dir, { multivac: true, now: () => NOW });
    const repo = bundle.repos[0] as Bundle['repos'][number];
    expect(repo.claims).toContain('"LIMIT = 5"');
    expect(repo.multivac).toContain('/LIMIT = 5/');
    expect(repo.multivac).not.toContain('"LIMIT = 5"');
  });

  it('leaves out an alias and a repository with nothing in it, and says why when one was asked for', async () => {
    await seed();
    const fork = who('github.com/me/proj', ROOT_A);
    await store.see(fork, true);
    await store.alias(fork.repoId, A.repoId);
    const all = await exportBundle(store, dir, { multivac: false, now: () => NOW });
    expect(all.bundle.repos.map((r) => r.repoId)).toEqual([A.repoId]);
    const asked = await exportBundle(store, dir, { only: fork.repoId, multivac: false, now: () => NOW });
    expect(asked.bundle.repos).toEqual([]);
    expect(asked.notes[0]).toContain('alias');
    await expect(exportBundle(store, dir, { only: '0'.repeat(16), multivac: false, now: () => NOW })).rejects.toThrow(/no repository/);
  });
});

/** A bundle for the repository `A` with the claims of `seed()`, written by hand, to import into an empty store. */
async function bundleOf(over: Partial<Bundle['repos'][number]> = {}, repos = 1): Promise<string> {
  await seed();
  const { bundle } = await exportBundle(store, dir, { multivac: false, now: () => NOW });
  await rm(dir, { recursive: true, force: true });
  store = open(dir);
  await store.load();
  const base = bundle.repos[0] as Bundle['repos'][number];
  return JSON.stringify({ ...bundle, repos: Array.from({ length: repos }, (_, i) => ({ ...base, ...over, ...(i === 0 ? {} : { repoId: `${i.toString(16).padStart(16, '0')}` }) })) });
}

describe('import', () => {
  it('is a plan first: it lists what would be added and writes nothing', async () => {
    const text = await bundleOf();
    const plans = await planImport(store, text, 'bundle.json', { replace: false });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ repoId: A.repoId, add: ['K-1', 'K-2'], skip: [], replace: [], rejected: [] });
    expect(await store.repos()).toEqual({});
  });

  it('applies: the ids are kept, the authority is "imported", the source names the file, no checkout is bound, and the next id is after the highest', async () => {
    const text = await bundleOf();
    const { applyImport } = await import('../src/server/knowledgeio.js');
    const plans = await planImport(store, text, '/some/where/my bundle.json', { replace: false });
    const done = await applyImport(store, plans, { replace: false });
    expect(done).toEqual([{ repoId: A.repoId, label: 'proj', added: 2, replaced: 0, skipped: 0, ritual: 'none' }]);
    const read = await store.claims(A.repoId);
    expect(read.claims.map((c) => [c.id, c.authority, c.from])).toEqual([
      ['K-1', 'imported', 'import: my bundle.json'],
      ['K-2', 'imported', 'import: my bundle.json'],
    ]);
    expect(read.claims[0]?.legs).toHaveLength(2);
    const repo = (await store.repos())[A.repoId];
    expect(repo?.roots).toEqual([]);
    expect(repo?.nextClaim).toBe(3);
    expect((await store.addClaim(A.repoId, { statement: 'next', legs: [], authority: 'director', source: 'store' })).id).toBe('K-3');
  });

  it('skips a claim whose id is there, and replaces it only with replace', async () => {
    const text = await bundleOf();
    await store.see(A, false);
    await store.addClaim(A.repoId, { statement: 'Mine, K-1.', legs: [], authority: 'director', source: 'store' });
    const { applyImport } = await import('../src/server/knowledgeio.js');
    const plan = await planImport(store, text, 'b.json', { replace: false });
    expect(plan[0]).toMatchObject({ add: ['K-2'], skip: ['K-1'] });
    await applyImport(store, plan, { replace: false });
    expect((await store.claims(A.repoId)).claims.find((c) => c.id === 'K-1')?.statement).toBe('Mine, K-1.');
    const again = await planImport(store, text, 'b.json', { replace: true });
    expect(again[0]).toMatchObject({ replace: ['K-1', 'K-2'], skip: [] });
    await applyImport(store, again, { replace: true });
    expect((await store.claims(A.repoId)).claims.find((c) => c.id === 'K-1')?.statement).toBe('The limit is 5.');
  });

  it('keeps an existing ritual unless replace, and writes one that is not there', async () => {
    const text = await bundleOf({ ritual: '- from the bundle\n' });
    const { applyImport } = await import('../src/server/knowledgeio.js');
    expect((await applyImport(store, await planImport(store, text, 'b.json', { replace: false }), { replace: false }))[0]?.ritual).toBe('written');
    expect(await store.ritual(A.repoId)).toBe('- from the bundle\n');
    await writeFile(join(dir, A.repoId, 'ritual.md'), '- mine\n');
    expect((await planImport(store, text, 'b.json', { replace: false }))[0]?.ritual).toBe('keep');
    expect((await applyImport(store, await planImport(store, text, 'b.json', { replace: false }), { replace: false }))[0]?.ritual).toBe('kept');
    expect(await store.ritual(A.repoId)).toBe('- mine\n');
  });

  it('lists a claim whose anchor does not parse as rejected and still takes the others; statements are cleaned as when a claim is accepted', async () => {
    const claims = [
      '| ID | statement | authority | state | date | source |',
      '|----|---|---|---|---|---|',
      '| K-1 | Good‮   and   spaced. | director | active | 2026-11-21 | store |',
      '<!-- @anchor K-1 brain:src/** /ok/ present -->',
      '| K-2 | Bad leg. | director | active | 2026-11-21 | store |',
      '<!-- @anchor K-2 brain:src/** /(a+)+/ present -->',
      '| K-3 | x | director | sideways | 2026-11-21 | store |',
    ].join('\n');
    const plans = await planImport(store, await bundleOf({ claims }), 'b.json', { replace: false });
    expect(plans[0]?.add).toEqual(['K-1']);
    expect(plans[0]?.rejected.map((r) => r.id)).toEqual(expect.arrayContaining(['K-2', 'line 7']));
    expect(plans[0]?.rows[0]?.statement).toBe('Good and spaced.');
  });

  it('refuses a repository whose id is not the hash of its remote and root commit, or whose remote carries a credential', async () => {
    const forged = await planImport(store, await bundleOf({ repoId: '1234567890abcdef' }), 'b.json', { replace: false });
    expect(forged[0]?.refused).toMatch(/does not match/);
    for (const remoteKey of ['https://user:ghp_secret@github.com/o/proj', 'user@github.com/o/proj', 'github.com/o/proj?x=y', 'git@github.com:o/proj']) {
      const plans = await planImport(store, await bundleOf({ remoteKey }), 'b.json', { replace: false });
      expect(plans[0]?.refused, remoteKey).toMatch(/remote or the root commit/);
    }
    expect((await planImport(store, await bundleOf({ rootCommit: null }), 'b.json', { replace: false }))[0]?.refused).toBeDefined();
    expect((await planImport(store, await bundleOf({ rootCommit: 'xyz' }), 'b.json', { replace: false }))[0]?.refused).toMatch(/remote or the root commit/);
  });

  it('is refused whole for a text that is not a bundle, one with too many repositories, and a repository twice; a damaged claims file refuses only its repository', async () => {
    await expect(planImport(store, 'not json', 'b.json', { replace: false })).rejects.toThrow(/not JSON/);
    await expect(planImport(store, '{"version":2,"repos":[]}', 'b.json', { replace: false })).rejects.toThrow(/version 1/);
    const many = JSON.stringify({ version: 1, repos: Array.from({ length: BUNDLE_REPOS_MAX + 1 }, () => ({})) });
    await expect(planImport(store, many, 'b.json', { replace: false })).rejects.toThrow(/at most 50/);
    const twice = JSON.parse(await bundleOf()) as { repos: unknown[] };
    twice.repos.push(twice.repos[0]);
    expect((await planImport(store, JSON.stringify(twice), 'b.json', { replace: false })).map((p) => p.refused)).toEqual([undefined, 'the repository is in the bundle twice']);
    const big = '| ID | statement | authority | state | date | source |\n' + Array.from({ length: 201 }, (_, i) => `| K-${i + 1} | s | director | active | 2026-11-21 | store |`).join('\n');
    expect((await planImport(store, await bundleOf({ claims: big }), 'b.json', { replace: false }))[0]?.refused).toMatch(/more than 200 claims/);
    expect((await planImport(store, await bundleOf({ claims: 'x'.repeat(256 * 1024 + 1) }), 'b.json', { replace: false }))[0]?.refused).toMatch(/over 256 KiB/);
  });
});

describe('the bundle file', () => {
  it('is refused over 8 MiB before anything is parsed, and when it is not a plain file', async () => {
    const huge = join(tmp, 'huge.json');
    await writeFile(huge, Buffer.alloc(BUNDLE_MAX_BYTES + 1, 0x7b));
    await expect(readBundleFile(huge)).rejects.toThrow(/over 8 MiB: nothing was read/);
    const exact = join(tmp, 'exact.json');
    await writeFile(exact, Buffer.alloc(BUNDLE_MAX_BYTES, 0x20));
    expect((await readBundleFile(exact)).length).toBe(BUNDLE_MAX_BYTES);
    await expect(readBundleFile(tmp)).rejects.toThrow(/plain file|EISDIR/);
    await expect(readBundleFile(join(tmp, 'missing.json'))).rejects.toThrow(/ENOENT/);
  });
});

describe('the command line', () => {
  it('takes --home out of the arguments, as expose does', async () => {
    const { parseArgs } = await import('../src/server/cli.js');
    expect(parseArgs(['knowledge', 'export', '--out', 'f.json', '--home', '/h'])).toEqual({ kind: 'knowledge', args: ['export', '--out', 'f.json'], home: '/h' });
    expect(parseArgs(['knowledge', 'list'])).toEqual({ kind: 'knowledge', args: ['list'] });
    expect(parseArgs(['knowledge', 'list', '--home'])).toMatchObject({ kind: 'error' });
  });
});

describe('the command', () => {
  const run = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await runKnowledgeCli(args, { dir, now: () => NOW, io: { out: (t) => (out += t), err: (t) => (err += t) } });
    return { code, out, err };
  };

  it('export writes a new file, 0600, and refuses one that is there, a link included', async () => {
    await seed();
    const file = join(tmp, 'out.json');
    const done = await run(['export', '--out', file]);
    expect(done.code).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(((JSON.parse(await readFile(file, 'utf8')) as Bundle).repos[0] as Bundle['repos'][number]).repoId).toBe(A.repoId);
    expect((await run(['export', '--out', file])).err).toContain('does not replace');
    await writeFile(join(tmp, 'target.txt'), 'keep');
    await symlink(join(tmp, 'target.txt'), join(tmp, 'link.json'));
    expect((await run(['export', '--out', join(tmp, 'link.json')])).code).toBe(1);
    expect(await readFile(join(tmp, 'target.txt'), 'utf8')).toBe('keep');
    await symlink(join(tmp, 'nowhere'), join(tmp, 'dangling.json'));
    expect((await run(['export', '--out', join(tmp, 'dangling.json')])).code).toBe(1);
    await expect(stat(join(tmp, 'nowhere'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('export prints the bundle without --out, and --repo takes an id of the store', async () => {
    await seed();
    const all = await run(['export']);
    expect(all.code).toBe(0);
    expect((JSON.parse(all.out) as Bundle).repos).toHaveLength(1);
    expect((await run(['export', '--repo', A.repoId, '--multivac'])).out).toContain('/LIMIT = 5/');
    expect((await run(['export', '--repo', '/definitely/not/a/repo'])).err).toContain('not a repository id');
  });

  it('import is a dry run unless --apply, and says what it did without quoting a statement', async () => {
    const file = join(tmp, 'b.json');
    await writeFile(file, await bundleOf());
    const dry = await run(['import', file]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('would add 2');
    expect(dry.out).toContain('dry run: nothing was written');
    expect(await store.repos()).toEqual({});
    const done = await run(['import', file, '--apply']);
    expect(done.out).toContain('add 2');
    expect(done.out).toContain('no checkout was bound');
    expect(done.out).not.toContain('The limit is 5');
    expect(Object.keys(await open(dir).repos())).toEqual([A.repoId]);
    expect((await run(['import', file, '--apply'])).out).toContain('skip 2');
  });

  it('alias, move and keep take two ids; list shows the repositories that look alike; a wrong id or argument is a one-line error', async () => {
    await seed();
    const moved = who('github.com/o/proj', ROOT_B);
    await store.see(moved, true);
    const listed = await run(['list']);
    expect(listed.out).toContain(`${A.repoId}  proj  (github.com/o/proj)  2 claims`);
    expect(listed.out).toContain(`looks like ${moved.repoId} proj: the same remote, another root commit`);
    expect((await run(['move', A.repoId, moved.repoId])).code).toBe(0);
    expect((await store.claims(moved.repoId)).claims).toHaveLength(2);
    expect((await open(dir).repos())[A.repoId]?.alias).toBe(moved.repoId);
    const fork = who('github.com/me/proj', ROOT_B);
    await store.see(fork, true);
    expect((await run(['alias', fork.repoId, moved.repoId])).code).toBe(0);
    expect((await open(dir).repos())[fork.repoId]?.alias).toBe(moved.repoId);
    expect((await run(['keep', A.repoId, fork.repoId])).code).toBe(0);
    expect((await run(['alias', 'nope', moved.repoId])).err).toContain('two repository ids');
    expect((await run(['alias', moved.repoId, moved.repoId])).code).toBe(1);
    expect((await run(['export', '--nope'])).code).toBe(1);
    expect((await run(['import'])).err).toContain('needs one file');
    expect((await run(['frobnicate'])).code).toBe(1);
  });
});
