import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaimResult, KnowledgeCounts, LogEntry } from '../src/shared/protocol.js';
import { createKnowledge, KNOWLEDGE_LIST_HEADING, KNOWLEDGE_RECHECK_MS, legOfLogAnchor } from '../src/server/knowledge.js';
import type { Knowledge, KnowledgeEngine } from '../src/server/knowledge.js';
import { createProposalStore } from '../src/server/knowledgeproposals.js';
import { createKnowledgeStore } from '../src/server/knowledgestore.js';
import type { KnowledgeStore } from '../src/server/knowledgestore.js';
import { noLegs } from '../src/server/claimsfile.js';
import { createSafeGit } from '../src/server/safegit.js';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

let root: string;
let now: number;
let on: boolean;
let places: Record<string, string>;
let told: Array<[string, string]>;
let changed: Array<Record<string, KnowledgeCounts>>;
let engineCalls: Array<{ root: string; ids: string[] }>;
let store: KnowledgeStore;
let k: Knowledge;

async function repo(name: string, remote = 'https://github.com/o/r.git'): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  await writeFile(join(path, 'a.txt'), 'the limit is 5\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'x');
  git(path, 'remote', 'add', 'origin', remote);
  return realpath(path);
}

const engine: KnowledgeEngine = {
  run: async (r, claims) => {
    engineCalls.push({ root: r, ids: claims.map((c) => c.id) });
    return claims.map((c): ClaimResult => ({ id: c.id, root: r, branch: 'main', commit: 'abc1234', worst: 'stale', legs: [{ state: 'stale', note: 'not confirmed' }], checkedAt: now }));
  },
};

function build(withEngine = true): void {
  store = createKnowledgeStore({ dir: join(root, 'store'), now: () => now, log: quiet });
  k = createKnowledge({
    store,
    proposals: createProposalStore({ dir: join(root, 'room', 'knowledge-proposals'), now: () => now, parseLegs: noLegs }),
    git: createSafeGit({ ms: 30_000 }),
    ...(withEngine ? { engine } : {}),
    now: () => now,
    on: () => on,
    agents: () => Object.keys(places),
    place: async (n) => places[n] ?? null,
    tell: (agent, text) => void told.push([agent, text]),
    changed: (c) => void changed.push(c),
    log: { warn: () => undefined },
  });
}
const leg = { mode: 'present' as const, glob: 'a.txt', literal: 'limit' };
const refused = async (run: () => Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await run();
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code ?? '', message: err.message };
  }
  throw new Error('it was not refused');
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gonogo-kservice-')));
  now = Date.UTC(2026, 10, 21, 12);
  on = true;
  told = [];
  changed = [];
  engineCalls = [];
  places = { ana: await repo('a') };
  build();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('what an agent can do', () => {
  it('proposes from a bound checkout and gets its id back and nothing else', async () => {
    const made = await k.propose('ana', { statement: 'The limit is 5', legs: [leg] });
    expect(made).toEqual({ id: 'p1' });
    const view = await k.view({});
    expect(view.repos[0]?.proposals[0]).toMatchObject({ id: 'p1', agent: 'ana', status: 'pending', branch: 'main' });
    expect(view.repos[0]?.roots).toEqual([{ path: places.ana, branch: 'main', bound: true, agents: ['ana'] }]);
    expect(changed.at(-1) && Object.values(changed.at(-1) ?? {})[0]).toMatchObject({ pending: 1 });
  });

  it('is refused off the switch, outside a repository, for an agent that is not hired, and from a checkout that is not bound (S11)', async () => {
    on = false;
    expect((await refused(() => k.propose('ana', { statement: 's', legs: [leg] }))).code).toBe('feature_off');
    expect((await refused(() => k.list('ana'))).code).toBe('feature_off');
    on = true;
    await mkdir(join(root, 'plain'));
    places.plain = join(root, 'plain');
    expect((await refused(() => k.propose('plain', { statement: 's', legs: [leg] }))).message).toMatch(/not in a git repository/);
    expect((await refused(() => k.propose('ghost', { statement: 's', legs: [leg] }))).message).toMatch(/not in a git repository/);
    // a forged checkout seen first owns the id; the real one is not bound until the Director clicks
    const forged = await repo('forged');
    places.mal = forged;
    await k.list('mal');
    const real = await repo('real');
    places.real = real;
    expect((await refused(() => k.propose('real', { statement: 's', legs: [leg] }))).code).toBe('forbidden');
    expect((await refused(() => k.list('real'))).code).toBe('forbidden');
  });

  it('S11: forged first, then real: both listed, the real one needs the click, UNBIND of the forged one takes its access away', async () => {
    const forged = await repo('forged');
    const real = await repo('real');
    places = { mal: forged, ana: real };
    // mal is first and binds; its folder claims the id of the real one
    await k.propose('mal', { statement: 'forged', legs: [leg] });
    const repoId = (await k.view({})).repos[0]?.repoId ?? '';
    const roots = (await k.view({})).repos[0]?.roots ?? [];
    expect(roots.map((r) => [r.path, r.bound])).toEqual([[forged, true], [real, false]]);
    await k.bind({ repoId, path: real, action: 'bind' });
    await k.bind({ repoId, path: forged, action: 'unbind' });
    await expect(k.propose('ana', { statement: 'real', legs: [leg] })).resolves.toMatchObject({ id: expect.any(String) });
    expect((await refused(() => k.propose('mal', { statement: 'again', legs: [leg] }))).code).toBe('forbidden');
    expect((await refused(() => k.list('mal'))).code).toBe('forbidden');
    // a path that is not a checkout of this room's agents is not a path to bind
    expect((await refused(() => k.bind({ repoId, path: '/etc', action: 'bind' }))).code).toBe('not_found');
    expect((await refused(() => k.bind({ repoId, path: real, action: 'maybe' }))).code).toBe('bad_request');
  });

  it('lists accepted store claims only, under a fixed first line, and never a proposal, a repo-file claim or a retired one', async () => {
    await k.propose('ana', { statement: 'PROPOSAL-TEXT', legs: [leg] });
    const repoId = (await k.view({})).repos[0]?.repoId ?? '';
    await k.addClaim(repoId, { statement: 'Accepted one', anchors: '' });
    await k.addClaim(repoId, { statement: 'Retired one', anchors: '' });
    await k.updateClaim(repoId, 'K-2', { state: 'retired' });
    await mkdir(join(places.ana ?? '', '.gonogo'));
    await writeFile(join(places.ana ?? '', '.gonogo', 'claims.md'), '| R-1 | REPO-FILE-TEXT | repo | active | 2026-01-01 | repo |\n');
    const text = await k.list('ana');
    expect(text.split('\n')[0]).toBe(KNOWLEDGE_LIST_HEADING);
    expect(text).toContain('K-1: Accepted one');
    expect(text).not.toMatch(/PROPOSAL-TEXT|REPO-FILE-TEXT|Retired one/);
    // the Director sees the repo file claim, labelled
    expect((await k.view({})).repos[0]?.claims.map((c) => [c.id, c.source])).toEqual([['R-1', 'repo'], ['K-1', 'store'], ['K-2', 'store']]);
  });
});

describe('what the Director does', () => {
  it('accepts a proposal into K-n with its authority and source, and the agent is told only "accepted p1"', async () => {
    await k.propose('ana', { statement: 'The limit is 5', legs: [leg] });
    const repoId = (await k.view({})).repos[0]?.repoId ?? '';
    const after = await k.accept(repoId, 'p1');
    expect(after.claims[0]).toMatchObject({ id: 'K-1', statement: 'The limit is 5', authority: 'agent-accepted', from: 'proposed by ana', source: 'store' });
    expect(after.proposals[0]).toMatchObject({ id: 'p1', status: 'accepted' });
    expect(told).toEqual([['ana', 'proposal p1 accepted']]);
    expect((await refused(() => k.accept(repoId, 'p1'))).code).toBe('conflict');
    expect((await refused(() => k.accept(repoId, 'p9'))).code).toBe('not_found');
  });

  it('rejects with a reason that stays with the Director: the agent gets "rejected p1" and no reason', async () => {
    await k.propose('ana', { statement: 'x', legs: [leg] });
    const repoId = (await k.view({})).repos[0]?.repoId ?? '';
    const after = await k.reject(repoId, 'p1', { reason: 'too vague' });
    expect(after.proposals[0]).toMatchObject({ status: 'rejected', reason: 'too vague' });
    expect(told).toEqual([['ana', 'proposal p1 rejected']]);
    expect(JSON.stringify(told)).not.toContain('vague');
  });

  it('a trial run goes to the Director and is rate limited like a recheck; the agent never sees it', async () => {
    const made = await k.propose('ana', { statement: 'x', legs: [leg] });
    expect(JSON.stringify(made)).not.toMatch(/trial|stale/);
    const repoId = (await k.view({})).repos[0]?.repoId ?? '';
    const after = await k.trial(repoId, 'p1');
    expect(after.proposals[0]?.trial).toMatchObject({ worst: 'stale', id: 'p1' });
    expect(engineCalls).toEqual([{ root: places.ana, ids: ['p1'] }]);
    const again = await refused(() => k.trial(repoId, 'p1'));
    expect(again).toMatchObject({ code: 'rate_limited', message: 'checked 0 s ago: again in 30 s' });
    now += KNOWLEDGE_RECHECK_MS;
    await k.trial(repoId, 'p1');
    expect(engineCalls).toHaveLength(2);
    // nothing an agent can call returns it
    expect(await k.list('ana')).not.toMatch(/stale|trial/);
  });

  it('RECHECK runs the engine once per 30 s and the answer says how long to wait', async () => {
    await k.propose('ana', { statement: 'x', legs: [leg] });
    const repoId = (await k.view({})).repos[0]?.repoId ?? '';
    await k.addClaim(repoId, { statement: 'A claim', anchors: '' });
    const done = await k.recheck(repoId);
    expect(done.results[0]).toMatchObject({ id: 'K-1', worst: 'stale' });
    expect(Object.values(changed.at(-1) ?? {})[0]).toMatchObject({ stale: 1, pending: 1 });
    now += 12_000;
    const e = (await refused(() => k.recheck(repoId))) as { code: string; message: string };
    expect(e).toMatchObject({ code: 'rate_limited', message: 'checked 12 s ago: again in 18 s' });
    try {
      await k.recheck(repoId);
    } catch (error) {
      expect((error as { retryAfter?: number }).retryAfter).toBe(18);
    }
  });

  it('claims are added, edited, retired and deleted; bad anchors come back with their lines; with the switch off nothing is written', async () => {
    await k.propose('ana', { statement: 'x', legs: [leg] });
    const repoId = (await k.view({})).repos[0]?.repoId ?? '';
    expect((await k.addClaim(repoId, { statement: ' Two\nlines ', anchors: 'brain:a "x"\n\n  brain:b /y/ absent ' })).claims[0]).toMatchObject({ id: 'K-1', statement: 'Two lines', authority: 'director' });
    expect((await k.updateClaim(repoId, 'K-1', { state: 'retired' })).claims[0]?.state).toBe('retired');
    expect((await refused(() => k.updateClaim(repoId, 'K-1', {}))).message).toMatch(/nothing to change/);
    expect((await refused(() => k.updateClaim(repoId, 'K-1', { state: 'proposed' }))).code).toBe('bad_request');
    expect((await refused(() => k.addClaim(repoId, { statement: 's', anchors: 5 }))).code).toBe('bad_request');
    expect((await refused(() => k.addClaim(repoId, { statement: 's', anchors: Array.from({ length: 21 }, () => 'brain:a "x"').join('\n') }))).message).toMatch(/at most 20/);
    expect((await k.deleteClaim(repoId, 'K-1')).claims).toEqual([]);
    on = false;
    expect((await refused(() => k.addClaim(repoId, { statement: 's', anchors: '' }))).code).toBe('feature_off');
    expect(await k.view({ ana: 2 })).toEqual({ enabled: false, repos: [], agents: {} });
  });

  it('PROMOTE makes a store claim of the anchors of a log entry, from a bound checkout of one repository only', async () => {
    await k.propose('ana', { statement: 'x', legs: [leg] });
    const entry = (anchors: LogEntryAnchors): LogEntry => ({ id: 'l17', title: 'The limit is 5', body: 'b', tags: [], author: 'ana', createdAt: 1, updatedAt: 2, anchors });
    const a = { root: places.ana ?? '', file: 'a.txt', text: 'the "limit"', mode: 'present' as const };
    const promoted = await k.promote(entry([a, { root: a.root, text: 'old name', mode: 'absent' }]));
    expect(promoted.claim).toMatchObject({ id: 'K-1', statement: 'The limit is 5', authority: 'log-anchor', from: 'from l17', source: 'store' });
    expect(legOfLogAnchor(a)).toBe('brain:a.txt "the \\"limit\\"" present');
    expect(legOfLogAnchor({ root: a.root, text: 'x', mode: 'absent' })).toBe('brain:** "x" absent');
    expect((await refused(() => k.promote(entry([])))).message).toMatch(/no anchors/);
    expect((await refused(() => k.promote(entry([a, { ...a, root: join(root, 'elsewhere') }])))).message).toMatch(/more than one repository/);
    expect((await refused(() => k.promote(entry([{ ...a, root: join(root, 'plain') }])))).code).toBe('bad_request');
  });

  it('MOVE and KEEP: the claims of a look-alike repository come here, or the two are kept apart', async () => {
    const rewritten = await repo('rewritten');
    // a history of its own with the same remote: another root commit
    git(rewritten, 'checkout', '-q', '--orphan', 'fresh');
    await writeFile(join(rewritten, 'z.txt'), 'z');
    git(rewritten, 'add', '-A');
    git(rewritten, 'commit', '-q', '-m', 'new root');
    places.fresh = rewritten;
    const view = await k.view({});
    expect(view.repos).toHaveLength(2);
    const [a, b] = view.repos;
    expect(a?.candidates.map((c) => c.repoId)).toContain(b?.repoId);
    await k.addClaim(a?.repoId ?? '', { statement: 'old claim', anchors: '' });
    const kept = await k.move(b?.repoId ?? '', { from: a?.repoId, action: 'keep' });
    expect(kept.candidates).toEqual([]);
    expect((await refused(() => k.move(b?.repoId ?? '', { from: a?.repoId, action: 'merge' }))).code).toBe('bad_request');
  });
});

type LogEntryAnchors = NonNullable<LogEntry['anchors']>;

describe('S2: a repo file', () => {
  it('that is a link out of the repository is not read', async () => {
    const dir = places.ana ?? '';
    await mkdir(join(dir, '.gonogo'));
    await writeFile(join(root, 'secret.md'), '| X-1 | OUTSIDE-SECRET | repo | active | 2026-01-01 | repo |\n');
    await symlink(join(root, 'secret.md'), join(dir, '.gonogo', 'claims.md'));
    await k.propose('ana', { statement: 'x', legs: [leg] });
    const claims = (await k.view({})).repos[0]?.claims ?? [];
    expect(JSON.stringify(claims)).not.toContain('OUTSIDE-SECRET');
  });
});
