import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAutoReview, parseSettingsPatch, skipReason, JOBS_PER_HOUR, REPO_RE } from '../src/server/autoreview.js';
import type { AutoReview, ListedPr } from '../src/server/autoreview.js';
import { stepUpReason, weakensEgress } from '../src/server/stepup.js';
import { DEFAULT_SETTINGS } from '../src/server/autoreview.js';

let dir: string;
let made: AutoReview[] = [];
let clock = 1_800_000_000_000;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-autoreview-'));
  made = [];
});
afterEach(async () => {
  await Promise.all(made.map((r) => r.close()));
  await rm(dir, { recursive: true, force: true });
});

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const pr = (over: Partial<ListedPr> = {}): ListedPr => ({ number: 7, headRefOid: sha(1), isDraft: false, isCrossRepository: false, author: { login: 'ulm0' }, headRepositoryOwner: { login: 'ulm0' }, changedFiles: 3, additions: 40, deletions: 10, title: 'Fix x', ...over });

let listed: Record<string, ListedPr[]>;
const calls: string[][] = [];
const make = async (): Promise<AutoReview> => {
  const r = createAutoReview({
    dir,
    now: () => clock,
    pollMs: 0,
    list: async (repo, author) => {
      calls.push([repo, author]);
      return listed[`${repo}|${author}`] ?? [];
    },
  });
  made.push(r);
  await r.load();
  return r;
};
const on = (r: AutoReview, extra: Record<string, unknown> = {}) => r.set({ enabled: true, repos: ['ulm0/gonogo'], ...extra });

beforeEach(() => {
  listed = {};
  calls.length = 0;
});

describe('settings', () => {
  it('is off by default, with the spec defaults', async () => {
    const r = await make();
    expect(r.view().settings).toEqual({ ...DEFAULT_SETTINGS });
    expect(r.view().settings).toMatchObject({ enabled: false, autoPost: false, positions: ['rso', 'retro'], maxUsdPerPr: 2, maxUsdPerDay: 10, maxLines: 1500, maxFiles: 40 });
  });
  it('refuses unknown fields and bad values', () => {
    for (const bad of [{ nope: 1 }, { enabled: 'yes' }, { repos: ['not a repo'] }, { repos: ['a/b/c'] }, { repos: ['../x'] }, { authors: ['a b'] }, { positions: [] }, { maxUsdPerPr: 0 }, { maxFiles: 1.5 }, { model: 'bad model' }, { focus: 5 }, []]) {
      expect(parseSettingsPatch(bad)).toMatchObject({ ok: false });
    }
    expect(parseSettingsPatch({ repos: ['ulm0/gonogo', 'ulm0/gonogo'], model: null })).toMatchObject({ ok: true, patch: { repos: ['ulm0/gonogo'] } });
  });
  it('is saved 0600 and kept across a restart; an unreadable file leaves it off', async () => {
    const r = await make();
    await on(r, { authors: ['ulm0'] });
    expect((await stat(join(dir, 'auto-review.json'))).mode & 0o777).toBe(0o600);
    const again = await make();
    expect(again.view().settings).toMatchObject({ enabled: true, repos: ['ulm0/gonogo'], authors: ['ulm0'] });
    await rm(join(dir, 'auto-review.json'));
    await (await import('node:fs/promises')).writeFile(join(dir, 'auto-review.json'), '{not json');
    expect((await make()).view().settings.enabled).toBe(false);
  });
  it('turning it on needs a step-up, turning it off does not, and an API key may only turn it off', () => {
    expect(stepUpReason('PUT', '/api/auto-review', { enabled: true })).toMatch(/auto-review/);
    expect(stepUpReason('PUT', '/api/auto-review', { repos: ['a/b'] })).toMatch(/auto-review/);
    expect(stepUpReason('PUT', '/api/auto-review', { autoPost: true })).toMatch(/auto-review/);
    expect(stepUpReason('PUT', '/api/auto-review', { enabled: false })).toBeNull();
    expect(stepUpReason('PUT', '/api/auto-review', { enabled: false, autoPost: false })).toBeNull();
    expect(weakensEgress('PUT', '/api/auto-review', { enabled: true })).toBe(true);
    expect(weakensEgress('PUT', '/api/auto-review', { autoPost: true })).toBe(true);
    expect(weakensEgress('PUT', '/api/auto-review', { enabled: false })).toBe(false);
    expect(weakensEgress('PUT', '/api/auto-review', {})).toBe(true);
    expect(weakensEgress('PUT', '/api/auto-review', null)).toBe(true);
  });
});

describe('a restart', () => {
  it('tells that auto-review is on, and keeps auto-post OFF until the Director turns it on again (the file too)', async () => {
    const r = await make();
    await on(r, { autoPost: true, authors: ['ulm0'] });
    expect(r.view().settings.autoPost).toBe(true);
    const again = await make();
    expect(again.view().settings).toMatchObject({ enabled: true, autoPost: false });
    expect(again.startupNotices()).toEqual(['Auto-review is on for 1 repo.', 'Auto-post was on before the restart and is off again: turn it on in Flight Rules, AUTO-REVIEW, to confirm it.']);
    expect(again.startupNotices()).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'auto-review.json'), 'utf8')).autoPost).toBe(false);
    // off stays quiet
    const off = await (async () => {
      await rm(join(dir, 'auto-review.json'));
      return make();
    })();
    expect(off.startupNotices()).toEqual([]);
    // turning it on again is the confirmation
    await on(off, { autoPost: true });
    expect(off.view().settings.autoPost).toBe(true);
  });
});

describe('the eligibility gate', () => {
  const base = { ...DEFAULT_SETTINGS, repos: ['ulm0/gonogo'], authors: ['ulm0'] };
  it('lets a same-repo, non-draft, small PR by a listed author through', () => {
    expect(skipReason(pr(), 'ulm0/gonogo', base, false)).toBeNull();
    expect(skipReason(pr({ author: { login: 'ULM0' } }), 'ulm0/gonogo', base, false)).toBeNull();
  });
  it('skips a fork, a head owned by someone else, a draft, an unlisted author, a large PR, a bad head', () => {
    expect(skipReason(pr({ isCrossRepository: true }), 'ulm0/gonogo', base, false)).toMatch(/fork/);
    expect(skipReason(pr({ headRepositoryOwner: { login: 'evil' } }), 'ulm0/gonogo', base, false)).toMatch(/another owner/);
    expect(skipReason(pr({ headRepositoryOwner: null }), 'ulm0/gonogo', base, false)).toMatch(/another owner/);
    expect(skipReason(pr({ headRepositoryOwner: { login: 5 } as never }), 'ulm0/gonogo', base, false)).toMatch(/another owner/);
    expect(skipReason(pr({ headRepositoryOwner: {} as never }), 'ulm0/gonogo', base, false)).toMatch(/another owner/);
    expect(skipReason(pr({ isDraft: true }), 'ulm0/gonogo', base, false)).toMatch(/draft/);
    expect(skipReason(pr({ author: { login: 'mallory' } }), 'ulm0/gonogo', base, false)).toMatch(/not on the list/);
    expect(skipReason(pr({ changedFiles: 41 }), 'ulm0/gonogo', base, false)).toMatch(/too large/);
    expect(skipReason(pr({ additions: 1500, deletions: 1 }), 'ulm0/gonogo', base, false)).toMatch(/too large/);
    expect(skipReason(pr({ headRefOid: 'main' }), 'ulm0/gonogo', base, false)).toMatch(/head commit/);
    expect(skipReason(pr({ number: 0 }), 'ulm0/gonogo', base, false)).toMatch(/number/);
  });
  it('with no author list the room\'s own login (the server\'s @me filter) is enough, but a fork is still skipped', () => {
    expect(skipReason(pr({ author: { login: 'whoever' } }), 'ulm0/gonogo', { ...base, authors: [] }, true)).toBeNull();
    expect(skipReason(pr({ isCrossRepository: true }), 'ulm0/gonogo', { ...base, authors: [] }, true)).toMatch(/fork/);
  });
  it('the repo name is checked before gh sees it', () => {
    expect(REPO_RE.test('ulm0/gonogo')).toBe(true);
    for (const bad of ['ulm0', 'a/b/c', '-x', 'a b/c', 'a/b;rm', '$(x)/y', '']) expect(REPO_RE.test(bad)).toBe(false);
  });
});

describe('the poller', () => {
  it('does nothing while off, and asks `@me` when there is no author list', async () => {
    const r = await make();
    expect(await r.pollNow()).toEqual([]);
    expect(calls).toEqual([]);
    await on(r);
    listed['ulm0/gonogo|@me'] = [pr()];
    const jobs = await r.pollNow();
    expect(calls).toEqual([['ulm0/gonogo', '@me']]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ repo: 'ulm0/gonogo', pr: 7, status: 'queued', key: `ulm0/gonogo#7@${sha(1)}` });
  });
  it('one job per head: the same head is not made twice, even after a restart; a new head supersedes the old job', async () => {
    const r = await make();
    await on(r, { authors: ['ulm0'] });
    listed['ulm0/gonogo|ulm0'] = [pr()];
    expect(await r.pollNow()).toHaveLength(1);
    expect(await r.pollNow()).toHaveLength(0);
    expect(await (await make()).pollNow()).toHaveLength(0);
    clock += 1000;
    listed['ulm0/gonogo|ulm0'] = [pr({ headRefOid: sha(2) })];
    const second = await r.pollNow();
    expect(second).toHaveLength(1);
    const jobs = r.view().jobs;
    expect(jobs.find((j) => j.sha === sha(1))?.status).toBe('superseded');
    expect(jobs.find((j) => j.sha === sha(2))?.status).toBe('queued');
  });
  it('records a skipped PR once with its reason, and makes no job for it', async () => {
    const r = await make();
    await on(r, { authors: ['ulm0'] });
    listed['ulm0/gonogo|ulm0'] = [pr({ isCrossRepository: true }), pr({ number: 8, isDraft: true })];
    expect(await r.pollNow()).toEqual([]);
    expect(await r.pollNow()).toEqual([]);
    const jobs = r.view().jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.status === 'skipped' && typeof j.reason === 'string')).toBe(true);
  });
  it('a head the gate skipped is judged again, once: ready later it becomes a job; a skip that was not the gate\'s is never revived', async () => {
    const r = await make();
    await on(r, { authors: ['ulm0'] });
    listed['ulm0/gonogo|ulm0'] = [pr({ isDraft: true })];
    expect(await r.pollNow()).toEqual([]);
    expect(r.view().jobs).toHaveLength(1);
    listed['ulm0/gonogo|ulm0'] = [pr({ isDraft: false })];
    const [job] = await r.pollNow();
    expect(job).toMatchObject({ status: 'queued', pr: 7 });
    expect(r.view().jobs).toHaveLength(1);
    expect(r.view().jobs[0]?.gate).toBeUndefined();
    // the Director (or the runner) skipped it: the same head is not made again
    await r.mark(job!.id, { status: 'skipped', reason: 'skipped by the Director' });
    expect(await r.pollNow()).toEqual([]);
    expect(r.view().jobs[0]?.status).toBe('skipped');
  });
  it('a storm guard: at most JOBS_PER_HOUR jobs per repo an hour; the rest wait', async () => {
    const r = await make();
    await on(r, { authors: ['ulm0'] });
    listed['ulm0/gonogo|ulm0'] = Array.from({ length: JOBS_PER_HOUR + 2 }, (_, i) => pr({ number: 10 + i, headRefOid: sha(100 + i) }));
    expect(await r.pollNow()).toHaveLength(JOBS_PER_HOUR);
    clock += 3_600_001;
    expect(await r.pollNow()).toHaveLength(2);
  });
  it('a failed list is told in lastPoll and the next repo is still read', async () => {
    const r = createAutoReview({
      dir,
      now: () => clock,
      pollMs: 0,
      list: async (repo) => {
        if (repo === 'ulm0/bad') throw new Error('gh pr list failed (1)');
        return [pr()];
      },
    });
    made.push(r);
    await r.load();
    await r.set({ enabled: true, repos: ['ulm0/bad', 'ulm0/gonogo'], authors: ['ulm0'] });
    expect(await r.pollNow()).toHaveLength(1);
    expect(r.view().lastPoll?.error).toContain('gh pr list failed');
  });
  it('the jobs file holds the title cleaned of control characters and nothing of the diff', async () => {
    const r = await make();
    await on(r, { authors: ['ulm0'] });
    listed['ulm0/gonogo|ulm0'] = [pr({ title: 'Fix\u0007 ‮x\nnext' })];
    await r.pollNow();
    const text = await readFile(join(dir, 'auto-review-jobs.json'), 'utf8');
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(JSON.parse(text).jobs[0].title).toBe('Fix  ‮x next');
  });
});
