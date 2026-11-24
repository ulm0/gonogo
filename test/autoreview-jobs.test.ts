import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAutoReview, DEFAULT_SETTINGS } from '../src/server/autoreview.js';
import type { AutoReview } from '../src/server/autoreview.js';
import { createLauncher } from '../src/server/launcher.js';
import { createReviewRunner, ghReview, reviewBody, withoutIgnored } from '../src/server/reviewjobs.js';
import type { GhReview, ReviewOps } from '../src/server/reviewjobs.js';
import { cleanSubmission, cleanText } from '../src/server/reviewclean.js';
import type { AgentRecord } from '../src/shared/protocol.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line one
-old two
+new two
+new three
 line four
diff --git a/docs/x.md b/docs/x.md
new file mode 100644
--- /dev/null
+++ b/docs/x.md
@@ -0,0 +1,2 @@
+hello
+world
`;
const sha = (n: number): string => n.toString(16).padStart(40, '0');

describe('cleaning', () => {
  it('neutralizes mentions, references, slash commands, images, HTML, links and secrets, and removes control and bidi characters', () => {
    const out = cleanText('ping @octocat and @org/team, see #12 and ulm0/gonogo#3\n/lgtm\n  /merge now ![x](https://evil.test/a.png) <img src=x onerror=1> [click](https://evil.test/p?token=abc) Bearer sk-abcdefghijklmnopqrstuv ‮\u0007done', 2000);
    expect(out).not.toMatch(/@octocat|@org|[\s(]#12|gonogo#3/);
    expect(out).toContain('@​octocat');
    expect(out).toContain('#​12');
    expect(out).toContain('gonogo#​3');
    expect(out).toMatch(/^> \/lgtm$/m);
    expect(out).toMatch(/^> \/merge now/m);
    expect(out).not.toMatch(/!\[|<img|https?:\/\//);
    expect(out).toContain('[image removed]');
    expect(out).toContain('click (');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(out).not.toMatch(/[‮\u0007]/);
  });
  it('is cut to the limit', () => {
    expect(cleanText('ab '.repeat(2000), 100)).toHaveLength(100);
  });
  it('keeps a finding only when its file and line are in the diff (the new side), drops the rest with why', () => {
    const out = cleanSubmission(
      {
        summary: 'Looks fine @bob',
        findings: [
          { file: 'src/a.ts', line: 2, severity: 'high', text: 'bad @x' },
          { file: 'src/a.ts', line: 99, severity: 'low', text: 'nowhere' },
          { file: 'nope.ts', line: 1, severity: 'low', text: 'no file' },
          { file: 'docs/x.md', line: 1, severity: 'urgent', text: 'bad severity' },
          { file: 'docs/x.md', line: 2, severity: 'info', text: '' },
          { file: 'docs/x.md', line: 2, severity: 'info', text: 'ok' },
        ],
      },
      DIFF,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.findings.map((f) => `${f.file}:${f.line}`)).toEqual(['src/a.ts:2', 'docs/x.md:2']);
    expect(out.findings[0]?.text).toContain('@​x');
    expect(out.dropped).toHaveLength(4);
    expect(out.summary).toContain('@​bob');
  });
  it('refuses a shape that is not a review, and more than 20 findings', () => {
    expect(cleanSubmission(null, DIFF)).toMatchObject({ ok: false });
    expect(cleanSubmission({ summary: '', findings: [] }, DIFF)).toMatchObject({ ok: false });
    expect(cleanSubmission({ summary: 's', findings: 'x' }, DIFF)).toMatchObject({ ok: false });
    expect(cleanSubmission({ summary: 's', findings: Array.from({ length: 21 }, () => ({})) }, DIFF)).toMatchObject({ ok: false });
  });
  it('ignorePaths takes whole files out of the diff', () => {
    expect(withoutIgnored(DIFF, ['docs/'])).not.toContain('docs/x.md');
    expect(withoutIgnored(DIFF, ['*.ts'])).not.toContain('src/a.ts');
    expect(withoutIgnored(DIFF, ['src/a.ts'])).toContain('docs/x.md');
    expect(withoutIgnored(DIFF, [])).toBe(DIFF);
  });
});

describe('the only gh write', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gonogo-reviewgh-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  /** A gh that records its argv and the file it was given, and answers a fixed address. */
  const fakeGh = async (): Promise<string> => {
    const bin = join(dir, 'gh');
    await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ni=0\nfor a in "$@"; do if [ "$prev" = "--input" ]; then cp "$a" "${dir}/input"; fi; prev="$a"; done\necho https://github.com/o/r/pull/7#pullrequestreview-1\n`);
    await chmod(bin, 0o755);
    return bin;
  };
  it('posts with `gh api -X POST repos/<repo>/pulls/<n>/reviews --input <file>`, the body only in the file, event COMMENT', async () => {
    const bin = await fakeGh();
    const gh = ghReview({ dir, env: { PATH: process.env.PATH }, bin });
    const url = await gh.post('o/r', 7, { commit_id: sha(1), event: 'COMMENT', body: 'SECRETBODY', comments: [{ path: 'a.ts', line: 2, side: 'RIGHT', body: 'c' }] });
    expect(url).toBe('https://github.com/o/r/pull/7#pullrequestreview-1');
    const argv = (await readFile(join(dir, 'argv'), 'utf8')).trim().split('\n');
    expect(argv.slice(0, 5)).toEqual(['api', '-X', 'POST', 'repos/o/r/pulls/7/reviews', '--input']);
    expect(argv.join(' ')).not.toContain('SECRETBODY');
    expect(JSON.parse(await readFile(join(dir, 'input'), 'utf8'))).toMatchObject({ commit_id: sha(1), event: 'COMMENT', body: 'SECRETBODY' });
    // the temporary file is gone
    await expect(stat(argv[5] ?? '')).rejects.toThrow();
  });
  it('reads the head of any pull request with `gh pr view <n> --repo <repo> --json headRefOid -q .headRefOid`, whoever wrote it', async () => {
    const bin = join(dir, 'gh');
    await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\necho ${sha(5)}\n`);
    await chmod(bin, 0o755);
    const gh = ghReview({ dir, env: { PATH: process.env.PATH }, bin });
    expect(await gh.head('o/r', 7)).toBe(sha(5));
    expect((await readFile(join(dir, 'argv'), 'utf8')).trim().split('\n')).toEqual(['pr', 'view', '7', '--repo', 'o/r', '--json', 'headRefOid', '-q', '.headRefOid']);
    await expect(gh.head('o/r;x', 7)).rejects.toThrow();
  });
  it('reads the diff with `gh pr diff <n> --repo <repo>` only, and refuses a bad repo, a bad number and any event but COMMENT', async () => {
    const bin = await fakeGh();
    const gh = ghReview({ dir, env: { PATH: process.env.PATH }, bin });
    await gh.diff('o/r', 7);
    expect((await readFile(join(dir, 'argv'), 'utf8')).trim().split('\n')).toEqual(['pr', 'diff', '7', '--repo', 'o/r']);
    await expect(gh.diff('o/r;rm', 7)).rejects.toThrow();
    await expect(gh.diff('o/r', 0)).rejects.toThrow();
    await expect(gh.diff('o/r', 1.5)).rejects.toThrow();
    await expect(gh.post('o/r', 7, { commit_id: sha(1), event: 'APPROVE' as 'COMMENT', body: '', comments: [] })).rejects.toThrow(/only a comment/);
    await expect(gh.post('a b/r', 7, { commit_id: sha(1), event: 'COMMENT', body: '', comments: [] })).rejects.toThrow();
  });
});

describe('a review job', () => {
  let dir: string;
  let review: AutoReview;
  let clock = 1_800_000_000_000;
  const hired: Array<{ name: string; role: string; dir: string; model: string | null; position: string }> = [];
  const briefs: Array<{ name: string; subject: string; body: string }> = [];
  const fired: string[] = [];
  const posted: GhReview[] = [];
  let head: string | null;
  let spentToday: number;
  let opened = 0;
  let closed: string[] = [];
  const ops = (): ReviewOps => ({
    gh: { diff: async () => DIFF, head: async () => head, post: async (_r, _n, r) => (posted.push(r), 'https://github.com/o/r/pull/7#pullrequestreview-9') },
    hire: async (s) => void hired.push(s),
    fire: async (n, settle) => void fired.push(settle ? `${n}!` : n),
    brief: async (name, subject, body) => void briefs.push({ name, subject, body }),
    mission: async () => `ms${(opened += 1)}`,
    tasks: async () => `t${opened}`,
    close: async (job, how) => void closed.push(`${job.id}:${how}`),
    spent: () => 0.42,
    spentToday: () => spentToday,
  });
  const listed = (n: number, h: string) => ({ number: n, headRefOid: h, isDraft: false, isCrossRepository: false, author: { login: 'ulm0' }, headRepositoryOwner: { login: 'ulm0' }, changedFiles: 2, additions: 4, deletions: 1, title: 'Fix' });
  let runner: ReturnType<typeof createReviewRunner>;
  const make = async (settings: Record<string, unknown> = {}): Promise<void> => {
    review = createAutoReview({ dir, now: () => clock, pollMs: 0, list: async () => [listed(7, sha(1))] });
    await review.load();
    await review.set({ enabled: true, repos: ['ulm0/gonogo'], authors: ['ulm0'], ...settings });
    runner = createReviewRunner({ dir, now: () => clock, store: { settings: () => review.view().settings, jobs: () => review.jobs(), mark: (id, c) => review.mark(id, c) }, ops: ops() });
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gonogo-reviewjob-'));
    hired.length = 0;
    briefs.length = 0;
    fired.length = 0;
    posted.length = 0;
    closed = [];
    head = sha(1);
    spentToday = 0;
    opened = 0;
  });
  afterEach(async () => {
    await review.close();
    await rm(dir, { recursive: true, force: true });
  });
  const start = async (): Promise<string> => {
    const [job] = await review.pollNow();
    await runner.run(job!);
    return job!.id;
  };
  const submit = (agent: string, over: Record<string, unknown> = {}) => runner.submit(agent, { summary: 'ok', findings: [{ file: 'src/a.ts', line: 2, severity: 'high', text: 'bug' }], ...over });

  it('writes the diff to a 0600 file, hires one read-only reviewer per position with the untrusted line, and never puts the diff in the brief', async () => {
    await make();
    const id = await start();
    expect(hired.map((h) => h.name)).toEqual([`${id}-rso`, `${id}-retro`]);
    expect(hired[0]?.role).toContain('untrusted data');
    expect(hired[0]?.role).toContain('cannot run commands');
    expect((await stat(join(dir, 'review', id, 'diff.patch'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'review', id, 'diff.patch'), 'utf8')).toBe(DIFF);
    expect(briefs).toHaveLength(2);
    for (const b of briefs) {
      expect(b.body).toContain('untrusted data');
      expect(b.body).not.toContain('new three');
    }
    expect(review.view().jobs[0]).toMatchObject({ status: 'running', reviewers: [`${id}-rso`, `${id}-retro`], submitted: [], task: 't1', mission: 'ms1' });
  });

  it('only a reviewer of a running job may submit, once; the draft is cleaned and nothing is posted before the click', async () => {
    await make();
    const id = await start();
    expect(runner.reviews(`${id}-rso`)).toBe(true);
    expect(runner.reviews('ana')).toBe(false);
    expect(runner.isReviewer(`${id}-rso`)).toBe(true);
    expect(runner.isReviewer('ana')).toBe(false);
    await expect(submit('ana')).rejects.toMatchObject({ code: 'forbidden' });
    const one = await submit(`${id}-rso`, { summary: 'ping @bob', findings: [{ file: 'src/a.ts', line: 2, severity: 'high', text: 'bad' }, { file: 'src/a.ts', line: 50, severity: 'low', text: 'off' }] });
    expect(one).toMatchObject({ accepted: 1 });
    expect(one.dropped).toHaveLength(1);
    expect(runner.reviews(`${id}-rso`)).toBe(false);
    await expect(submit(`${id}-rso`)).rejects.toMatchObject({ code: 'forbidden' });
    expect(review.view().jobs[0]?.status).toBe('running');
    await submit(`${id}-retro`);
    // its tools stay cut after it has submitted, until it is gone
    expect(runner.isReviewer(`${id}-rso`)).toBe(true);
    expect(runner.reviews(`${id}-rso`)).toBe(false);
    expect(fired).toEqual([`${id}-rso!`, `${id}-retro!`]);
    expect(review.view().jobs[0]?.status).toBe('done');
    expect(closed).toEqual([`${id}:done`]);
    const draft = await runner.draft(id);
    expect(draft?.parts.map((p) => p.position)).toEqual(['rso', 'retro']);
    expect(draft?.parts[0]?.summary).toContain('@​bob');
    expect(draft?.usd).toBe(0.42);
    expect(posted).toEqual([]);
    expect((await stat(join(dir, 'review', id, 'draft.json'))).mode & 0o777).toBe(0o600);
    await expect(runner.submit(`${id}-rso`, { summary: 'x', findings: 'bad' })).rejects.toBeDefined();
  });

  it('the click posts ONE comment review on the reviewed head; twice is refused; a moved head is refused', async () => {
    await make();
    const id = await start();
    await submit(`${id}-rso`);
    await expect(runner.post(id)).rejects.toMatchObject({ code: 'conflict' });
    await submit(`${id}-retro`, { findings: [] });
    head = sha(2);
    await expect(runner.post(id)).rejects.toThrow(/new head commit/);
    expect(posted).toEqual([]);
    head = sha(1);
    const job = await runner.post(id);
    expect(job).toMatchObject({ status: 'posted', url: 'https://github.com/o/r/pull/7#pullrequestreview-9' });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ commit_id: sha(1), event: 'COMMENT' });
    expect(posted[0]?.body).toContain('Review by gonogo (RSO, RETRO)');
    expect(posted[0]?.comments).toEqual([{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: '**RSO** (high): bug' }]);
    await expect(runner.post(id)).rejects.toThrow(/posted already/);
  });

  it('autoPost posts when the last reviewer submits, and not otherwise', async () => {
    await make({ autoPost: true });
    const id = await start();
    await submit(`${id}-rso`);
    expect(posted).toHaveLength(0);
    await submit(`${id}-retro`);
    expect(posted).toHaveLength(1);
    expect(review.view().jobs[0]?.status).toBe('posted');
  });

  it('autoPost leaves a job that went over its per-PR cap for the click', async () => {
    await make({ autoPost: true, maxUsdPerPr: 0.1 });
    const id = await start();
    // spent() answers 0.42 in this harness: over the cap
    await submit(`${id}-rso`);
    await submit(`${id}-retro`);
    expect(posted).toHaveLength(0);
    expect(review.view().jobs[0]?.status).toBe('done');
    expect((await runner.post(id)).status).toBe('posted');
  });

  it('a reached day cap leaves the job queued, and the next try runs it; ignorePaths and an empty diff are honoured', async () => {
    await make({ maxUsdPerDay: 5 });
    spentToday = 5;
    const [job] = await review.pollNow();
    await runner.run(job!);
    expect(hired).toHaveLength(0);
    expect(review.view().jobs[0]?.status).toBe('queued');
    spentToday = 1;
    await runner.drain();
    expect(hired).toHaveLength(2);
    await review.close();
    hired.length = 0;
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), 'gonogo-reviewjob-'));
    await make({ ignorePaths: ['src/', 'docs/'] });
    const [j2] = await review.pollNow();
    await runner.run(j2!);
    expect(hired).toHaveLength(0);
    expect(review.view().jobs[0]).toMatchObject({ status: 'skipped', reason: 'nothing left in the diff' });
  });

  it('a skip or a new head removes the reviewers and closes the work', async () => {
    await make();
    const id = await start();
    await runner.end(id, 'skipped', 'skipped by the Director');
    expect(fired).toEqual([`${id}-rso`, `${id}-retro`]);
    expect(closed).toEqual([`${id}:ended`]);
    expect(review.view().jobs[0]).toMatchObject({ status: 'skipped', reason: 'skipped by the Director' });
    await expect(runner.post(id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a start that fails marks the job failed and removes what was hired', async () => {
    await make();
    const bad = createReviewRunner({ dir, now: () => clock, store: { settings: () => review.view().settings, jobs: () => review.jobs(), mark: (id, c) => review.mark(id, c) }, ops: { ...ops(), hire: async () => { throw new Error('no such position'); } } });
    const [job] = await review.pollNow();
    await bad.run(job!);
    expect(review.view().jobs[0]).toMatchObject({ status: 'failed', reason: 'the reviewers could not be started' });
  });

  it('the body of a review has the header, the summaries and the count, and says it does not approve', () => {
    const { body, comments } = reviewBody({ job: 'rv1', repo: 'o/r', pr: 7, sha: sha(1), parts: [{ position: 'rso', summary: 'fine', findings: [], dropped: [] }] });
    expect(body).toContain('**Review by gonogo (RSO)**');
    expect(body).toContain('0 comments on lines');
    expect(body).toContain('does not approve or block');
    expect(comments).toEqual([]);
    expect(DEFAULT_SETTINGS.autoPost).toBe(false);
  });
});

describe('the reviewer agent at its start', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gonogo-reviewer-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const SID = '11111111-1111-4111-8111-111111111111';
  const record = (over: Partial<AgentRecord> = {}): AgentRecord => ({ name: 'rv1-rso', role: 'reviews', dir: join(dir, 'work'), mode: 'default', sessionId: SID, desk: 1, boss: false, createdAt: 1, ...over });
  const prepare = async (agent: AgentRecord): Promise<{ mcp: { mcpServers: Record<string, unknown> }; settings: { permissions: { allow?: string[]; deny?: string[] } }; env: Record<string, string | undefined>; allowed: string[] }> => {
    await mkdir(join(dir, 'work'), { recursive: true });
    await writeFile(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { pulsar: { type: 'http', url: 'https://gamma.pulsar.codes' } } }));
    const l = createLauncher({
      homeDir: join(dir, 'home'),
      hubUrl: () => 'http://127.0.0.1:7777',
      seed: false,
      env: { PATH: '/usr/bin:/bin', HOME: join(dir, 'user'), CLAUDE_CONFIG_DIR: dir },
      coauthor: () => ({ enabled: false, prFooter: false }),
      globalMcp: { enabled: () => true },
      payloadDefaults: () => ({ mcpServers: { files: { command: 'npx', args: ['x'] } } }),
      keys: () => ({ SECRET_KEY: 'v' }),
      roomKeys: () => ({ ROOM_KEY: 'v' }),
      defaultPermissions: () => ({ allow: ['Bash(git *)'], deny: ['Read(//etc/**)'] }),
    });
    const { spec } = await l.prepareStart(agent, { generation: 1, flag: null });
    const read = async (flag: string): Promise<string> => readFile(spec.args[spec.args.indexOf(flag) + 1] as string, 'utf8');
    const allowed = spec.args.slice(spec.args.indexOf('--allowedTools') + 1);
    return { mcp: JSON.parse(await read('--mcp-config')), settings: JSON.parse(await read('--settings')), env: spec.env as Record<string, string | undefined>, allowed };
  };
  it('has only gonogo\'s MCP server (no global, no room default), the write/run/fetch tools denied, one tool allowed, and no keys', async () => {
    const out = await prepare(record({ reviewOnly: true }));
    expect(Object.keys(out.mcp.mcpServers)).toEqual(['gonogo']);
    for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit']) expect(out.settings.permissions.deny).toContain(tool);
    expect(out.settings.permissions.deny).toContain('Read(//etc/**)');
    expect(out.settings.permissions.allow).toEqual(expect.arrayContaining(['mcp__gonogo__pr_review_submit']));
    expect(JSON.stringify(out.settings.permissions.allow)).not.toContain('Bash(git');
    expect(out.env.SECRET_KEY).toBeUndefined();
    expect(out.env.ROOM_KEY).toBeUndefined();
    // pre-approved: its one answer and its mailbox, not the whole gonogo set (R2)
    expect(out.allowed).toEqual(['mcp__gonogo__pr_review_submit', 'mcp__gonogo__read_messages']);
    expect(out.settings.permissions.allow).not.toContain('mcp__gonogo__send_message');
  });
  it('an ordinary agent still gets the global and the room servers, its keys and every gonogo tool', async () => {
    const out = await prepare(record());
    expect(out.allowed).toEqual(expect.arrayContaining(['mcp__gonogo__send_message', 'mcp__gonogo__log_write', 'mcp__gonogo__go_nogo']));
    expect(Object.keys(out.mcp.mcpServers).sort()).toEqual(['files', 'gonogo', 'pulsar']);
    expect(out.env.SECRET_KEY).toBe('v');
  });
});
