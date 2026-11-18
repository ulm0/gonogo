/** Post-Flight Review: the diff parser, the store (a real temp folder, a fake diff), the three messages, and the Recorder's `git diff HEAD`. */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDiff, textAt } from '../src/shared/diff.js';
import { BODY_MAX_CHARS, REVIEW_BATCH_MAX, REVIEW_NOTES_MAX } from '../src/shared/protocol.js';
import type { AgentSendRequest, Logger, SendResult } from '../src/shared/protocol.js';
import { createRoots } from '../src/server/hangar.js';
import { createRecorder } from '../src/server/recorder.js';
import { HubError } from '../src/server/hub.js';
import { createReview, isOutdated, notesMessage, peerMessage, walkthroughMessage } from '../src/server/review.js';
import type { Review, ReviewActor } from '../src/server/review.js';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' import x from "x";',
  '-const a = 1;',
  '+const a = 2;',
  '+const b = 3;',
  ' export {};',
  ' // end',
  '@@ -20,2 +21,2 @@ function f() {',
  '-  return 1;',
  '+  return 2;',
  ' }',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
  '\\ No newline at end of file',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/pic.png b/pic.png',
  'Binary files a/pic.png and b/pic.png differ',
  '',
].join('\n');

describe('parseDiff', () => {
  it('reads files, hunks and the numbers of every line on both sides', () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.binary, f.hunks.length])).toEqual([
      ['src/a.ts', 'modified', false, 2],
      ['new.txt', 'added', false, 1],
      ['gone.txt', 'deleted', false, 1],
      ['pic.png', 'modified', true, 0],
    ]);
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => [l.kind, l.old, l.new, l.text])).toEqual([
      ['ctx', 1, 1, 'import x from "x";'],
      ['del', 2, null, 'const a = 1;'],
      ['add', null, 2, 'const a = 2;'],
      ['add', null, 3, 'const b = 3;'],
      ['ctx', 3, 4, 'export {};'],
      ['ctx', 4, 5, '// end'],
    ]);
    expect(files[0]!.hunks[1]!.header).toBe('@@ -20,2 +21,2 @@ function f() {');
    expect(files[0]!.hunks[1]!.lines[0]).toEqual({ kind: 'del', old: 20, new: null, text: '  return 1;' });
    // the "no newline" marker is not a line
    expect(files[1]!.hunks[0]!.lines).toHaveLength(2);
  });

  it('finds the text of a line by file, side and number, and null when it is not there', () => {
    const files = parseDiff(DIFF);
    expect(textAt(files, 'src/a.ts', 'new', 3)).toBe('const b = 3;');
    expect(textAt(files, 'src/a.ts', 'old', 2)).toBe('const a = 1;');
    expect(textAt(files, 'src/a.ts', 'old', 99)).toBeNull();
    expect(textAt(files, 'nope.ts', 'new', 1)).toBeNull();
    expect(textAt(files, 'gone.txt', 'old', 1)).toBe('bye');
    expect(textAt(files, 'gone.txt', 'new', 1)).toBeNull();
  });

  it('takes a renamed file by its new name, keeps the old one, and never throws on a diff cut short or on text that is no diff', () => {
    const renamed = parseDiff('diff --git a/old name.txt b/new name.txt\nsimilarity index 90%\nrename from old name.txt\nrename to new name.txt\n--- a/old name.txt\t\n+++ b/new name.txt\t\n@@ -1 +1 @@\n-a\n+b\n');
    expect(renamed[0]).toMatchObject({ path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed' });
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('not a diff\n@@ nonsense')).toEqual([]);
    expect(parseDiff(DIFF.slice(0, 190))[0]!.hunks[0]!.lines.length).toBeGreaterThan(0);
    // a content line that looks like a header is content
    const tricky = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- a/y\n+++ b/y\n');
    expect(tricky[0]!.path).toBe('x');
    expect(tricky[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['-- a/y', '++ b/y']);
  });
});

/* ---- the store ---- */

const USER: ReviewActor = { kind: 'user' };
const ANA: ReviewActor = { kind: 'agent', name: 'ana' };
const BEN: ReviewActor = { kind: 'agent', name: 'ben' };
let dir: string;
let now: number;
let diffText: string;
let truncated: boolean;
let notRepo: string | null;
let sent: AgentSendRequest[];
let answer: (request: AgentSendRequest) => SendResult;
let logs: string[];
const open: Review[] = [];

const quiet = (sink: string[]): Logger => {
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: (m) => void sink.push(m), error: (m, ...e) => void sink.push([m, ...e.map(String)].join(' ')), child: () => log };
  return log;
};

function make(): Review {
  const review = createReview({
    dir,
    now: () => now,
    agent: (name) => ({ ana: { mailable: true }, ben: { mailable: true }, plain: { mailable: false } })[name as 'ana'] ?? null,
    diff: async () => {
      if (notRepo !== null) throw new HubError('conflict', notRepo);
      return { diff: diffText, truncated };
    },
    send: (request) => {
      sent.push(request);
      return answer(request);
    },
    log: quiet(logs),
  });
  open.push(review);
  return review;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-review-'));
  now = Date.UTC(2026, 10, 18, 15, 0);
  diffText = DIFF;
  truncated = false;
  notRepo = null;
  sent = [];
  logs = [];
  answer = (request) => ({ ok: true, id: 'm9', to: request.to, status: 'queued', note: null });
});
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
  await rm(dir, { recursive: true, force: true });
});

const fails = async (run: Promise<unknown>, code: string, field?: string): Promise<HubError> => {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HubError);
  expect(error).toMatchObject({ code, ...(field === undefined ? {} : { field }) });
  return error as HubError;
};
const note = { file: 'src/a.ts', side: 'new', line: 3, summary: 'Why a second constant?' };

describe('notes', () => {
  it('adds a note on a line of the diff, anchored on its text, and shows it with the diff', async () => {
    const review = make();
    const made = await review.addNote(USER, 'ana', { ...note, rationale: 'b is unused', tone: 'warning' });
    expect(made).toMatchObject({ id: 'n1', file: 'src/a.ts', side: 'new', line: 3, summary: 'Why a second constant?', rationale: 'b is unused', author: 'user', tone: 'warning', status: 'open', replyTo: null, sentAt: null, outdated: false });
    const view = await review.view('ana');
    expect(view).toMatchObject({ repo: true, truncated: false, reviewers: [] });
    expect(view.files.map((f) => f.path)).toEqual(['src/a.ts', 'new.txt', 'gone.txt', 'pic.png']);
    expect(view.notes).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(dir, 'agents', 'ana', 'review.json'), 'utf8'));
    expect(saved).toMatchObject({ version: 1, seq: 1, notes: [{ id: 'n1', anchor: 'const b = 3;' }] });
  });

  it('refuses a line that is not in the diff, a bad field, and any field it does not have, naming the field', async () => {
    const review = make();
    await fails(review.addNote(USER, 'ana', { ...note, line: 99 }), 'bad_request', 'line');
    await fails(review.addNote(USER, 'ana', { ...note, file: 'nope.ts' }), 'bad_request', 'line');
    await fails(review.addNote(USER, 'ana', { ...note, side: 'left' }), 'bad_request', 'side');
    await fails(review.addNote(USER, 'ana', { ...note, line: 0 }), 'bad_request', 'line');
    await fails(review.addNote(USER, 'ana', { ...note, summary: '' }), 'bad_request', 'summary');
    await fails(review.addNote(USER, 'ana', { ...note, summary: 'x'.repeat(201) }), 'bad_request', 'summary');
    await fails(review.addNote(USER, 'ana', { ...note, tone: 'loud' }), 'bad_request', 'tone');
    await fails(review.addNote(USER, 'ana', { ...note, author: 'ben' }), 'bad_request', 'author');
    await fails(review.addNote(USER, 'ana', null), 'bad_request');
    await fails(review.addNote(USER, 'zed', note), 'not_found');
    expect((await review.view('ana')).notes).toEqual([]);
  });

  it('puts a summary on one line, refuses control and bidi characters in it, and takes them out of a reason', async () => {
    const review = make();
    const made = await review.addNote(ANA, 'ana', { ...note, summary: '  two\nlines  here ', rationale: 'a\n\nb\u0007c\u202ed' });
    expect(made.summary).toBe('two lines here');
    expect(made.rationale).toBe('a\n\nb c d');
    await fails(review.addNote(ANA, 'ana', { ...note, summary: 'x\u202ey' }), 'bad_request', 'summary');
    expect(made.author).toBe('ana');
  });

  it('a reply sits on the line of its parent and takes no line of its own', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    const reply = await review.addNote(ANA, 'ana', { replyTo: 'n1', summary: 'Fixed' });
    expect(reply).toMatchObject({ id: 'n2', file: 'src/a.ts', side: 'new', line: 3, replyTo: 'n1', author: 'ana' });
    await fails(review.addNote(ANA, 'ana', { replyTo: 'n9', summary: 'x' }), 'bad_request', 'replyTo');
    await fails(review.addNote(ANA, 'ana', { replyTo: 'n1', summary: 'x', line: 4 }), 'bad_request', 'replyTo');
    await fails(review.addNote(ANA, 'ana', { replyTo: 'nope', summary: 'x' }), 'bad_request', 'replyTo');
  });

  it('resolves and reopens a note, removes it with its replies, and never reuses an id', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    await review.addNote(ANA, 'ana', { replyTo: 'n1', summary: 'Fixed' });
    expect((await review.update('ana', 'n1', { status: 'resolved' })).status).toBe('resolved');
    expect((await review.update('ana', 'n1', { status: 'open' })).status).toBe('open');
    await fails(review.update('ana', 'n1', { status: 'done' }), 'bad_request', 'status');
    await fails(review.update('ana', 'n1', { summary: 'x' }), 'bad_request', 'status');
    await fails(review.update('ana', 'n7', { status: 'open' }), 'not_found');
    await review.remove('ana', 'n1');
    expect((await review.view('ana')).notes).toEqual([]);
    await fails(review.remove('ana', 'n1'), 'not_found');
    const again = make();
    expect((await again.addNote(USER, 'ana', note)).id).toBe('n3');
  });

  it('keeps the notes of each agent apart, and says when the folder is not a repository', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    expect((await review.view('ben')).notes).toEqual([]);
    notRepo = 'this folder is not in a git repository';
    const view = await review.view('ana');
    expect(view).toMatchObject({ repo: false, reason: 'this folder is not in a git repository', files: [] });
    expect(view.notes).toHaveLength(1);
    await fails(review.addNote(USER, 'ana', note), 'conflict');
  });

  it('caps the notes of one diff', async () => {
    const review = make();
    for (let i = 0; i < REVIEW_NOTES_MAX; i += 1) await review.addNote(USER, 'ana', note);
    await fails(review.addNote(USER, 'ana', note), 'conflict', 'notes');
  });

  it('keeps a damaged file aside and starts empty', async () => {
    await mkdir(join(dir, 'agents', 'ana'), { recursive: true });
    await writeFile(join(dir, 'agents', 'ana', 'review.json'), '{ nope');
    const review = make();
    expect((await review.view('ana')).notes).toEqual([]);
    expect(await readFile(join(dir, 'agents', 'ana', 'review.json.bad'), 'utf8')).toBe('{ nope');
    expect((await review.addNote(USER, 'ana', note)).id).toBe('n1');
  });
});

describe('outdated', () => {
  const files = parseDiff(DIFF);
  const anchored = { file: 'src/a.ts', side: 'new' as const, line: 3, anchor: 'const b = 3;' };

  it('is false while the line is the same, true when its text changed or the line or the file left the diff', () => {
    expect(isOutdated(anchored, files, false)).toBe(false);
    expect(isOutdated({ ...anchored, anchor: 'const b = 4;' }, files, false)).toBe(true);
    expect(isOutdated({ ...anchored, line: 40 }, files, false)).toBe(true);
    expect(isOutdated({ ...anchored, file: 'gone-file.ts' }, files, false)).toBe(true);
  });

  it('is unknown, so not outdated, for a line a diff cut short does not reach', () => {
    expect(isOutdated({ ...anchored, line: 40 }, files, true)).toBe(false);
    expect(isOutdated({ ...anchored, anchor: 'other' }, files, true)).toBe(true);
  });

  it('marks a note outdated when the diff changes under it, keeps it, and it comes back when the line does', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    diffText = DIFF.replace('+const b = 3;', '+const b = 4;');
    const changed = await review.view('ana');
    expect(changed.notes).toHaveLength(1);
    expect(changed.notes[0]!.outdated).toBe(true);
    diffText = '';
    expect((await review.view('ana')).notes[0]!.outdated).toBe(true);
    diffText = DIFF;
    expect((await review.view('ana')).notes[0]!.outdated).toBe(false);
  });
});

describe('who may read and write', () => {
  it('lets an agent read and annotate its own diff, and nobody else\'s until the Director asks it to review', async () => {
    const review = make();
    expect((await review.view('ana', ANA)).repo).toBe(true);
    await fails(review.view('ana', BEN), 'forbidden');
    await fails(review.addNotes(BEN, 'ana', [note]), 'forbidden');
    const own = await review.addNotes(ANA, 'ana', [note]);
    expect(own.added[0]).toMatchObject({ author: 'ana' });
    await review.peer('ana', 'ben');
    expect((await review.view('ana', BEN)).reviewers).toEqual(['ben']);
    const peer = await review.addNotes(BEN, 'ana', [{ ...note, line: 2, summary: 'Rename it' }]);
    expect(peer.added[0]).toMatchObject({ author: 'ben', line: 2 });
    // the right is for that diff only
    await fails(review.view('ben', ANA), 'forbidden');
  });

  it('adds a batch note by note: the good ones are kept and each bad one is named by its index', async () => {
    const review = make();
    const out = await review.addNotes(ANA, 'ana', [note, { ...note, line: 99 }, { ...note, line: 2 }, 'not a note', { ...note, tone: 'x' }]);
    expect(out.added.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(out.rejected.map((r) => r.index)).toEqual([1, 3, 4]);
    expect(out.rejected[0]!.error).toContain('is not a line of the diff');
    await fails(review.addNotes(ANA, 'ana', []), 'bad_request', 'notes');
    await fails(review.addNotes(ANA, 'ana', 'x'), 'bad_request', 'notes');
    await fails(review.addNotes(ANA, 'ana', Array.from({ length: REVIEW_BATCH_MAX + 1 }, () => note)), 'bad_request', 'notes');
    expect((await review.view('ana')).notes).toHaveLength(2);
  });

  it('answers 404 for an agent that is not in the room', async () => {
    await fails(make().view('zed', ANA), 'not_found');
  });
});

describe('the three messages', () => {
  it('sends the open notes of the Director that were not sent, as one message, once', async () => {
    const review = make();
    await review.addNote(USER, 'ana', { ...note, tone: 'error', rationale: 'dead code' });
    await review.addNote(USER, 'ana', { file: 'new.txt', side: 'new', line: 1, summary: 'Greeting?' });
    await review.addNote(ANA, 'ana', { replyTo: 'n1', summary: 'by the agent: not carried' });
    await review.addNote(USER, 'ana', { ...note, line: 2, summary: 'resolved one' });
    await review.update('ana', 'n4', { status: 'resolved' });
    const out = await review.send('ana');
    expect(out).toEqual({ sent: 2, message: 'm9' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ana', subject: 'Review: 2 notes on your diff' });
    expect(sent[0]!.body).toContain('- n1 src/a.ts:3 (new) [error] Why a second constant?\n  Why: dead code');
    expect(sent[0]!.body).toContain('- n2 new.txt:1 (new) [info] Greeting?');
    expect(sent[0]!.body).not.toContain('by the agent');
    expect(sent[0]!.body).not.toContain('resolved one');
    expect((await review.view('ana')).notes.filter((n) => n.sentAt !== null).map((n) => n.id)).toEqual(['n1', 'n2']);
    await fails(review.send('ana'), 'conflict', 'notes');
    expect(sent).toHaveLength(1);
    await review.addNote(USER, 'ana', { ...note, line: 4, summary: 'one more' });
    expect((await review.send('ana')).sent).toBe(1);
  });

  it('keeps the notes unsent when the message was refused, and refuses an agent that cannot read mail', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    answer = (request) => ({ ok: false, id: '', to: request.to, status: 'undelivered', note: 'ana is stopped' });
    await fails(review.send('ana'), 'conflict', 'agent');
    answer = (request) => ({ ok: true, id: 'm1', to: request.to, status: 'queued', note: null });
    expect((await review.send('ana')).sent).toBe(1);
    await fails(review.send('plain'), 'conflict', 'agent');
    await fails(review.walkthrough('plain'), 'conflict', 'agent');
  });

  it('asks the author for a walkthrough, with how to do it', async () => {
    const review = make();
    expect(await review.walkthrough('ana')).toEqual({ sent: 0, message: 'm9' });
    expect(sent[0]).toMatchObject({ to: 'ana', subject: 'Review: walk through your diff' });
    expect(sent[0]!.body).toContain('review_read(agent: "ana")');
    expect(sent[0]!.body).toContain('review_note');
  });

  it('asks a peer, and only then lets it read and annotate; an unreachable peer gets no right', async () => {
    const review = make();
    answer = (request) => ({ ok: false, id: '', to: request.to, status: 'undelivered', note: 'ben is stopped' });
    await fails(review.peer('ana', 'ben'), 'conflict', 'agent');
    await fails(review.view('ana', BEN), 'forbidden');
    answer = (request) => ({ ok: true, id: 'm2', to: request.to, status: 'queued', note: null });
    expect(await review.peer('ana', 'ben')).toEqual({ sent: 0, message: 'm2' });
    expect(sent.at(-1)).toMatchObject({ to: 'ben', subject: "Review: peer review of ana's diff" });
    expect((await review.view('ana', BEN)).reviewers).toEqual(['ben']);
    await review.peer('ana', 'ben');
    expect((await review.view('ana')).reviewers).toEqual(['ben']);
    await fails(review.peer('ana', 'ana'), 'bad_request', 'reviewer');
    await fails(review.peer('ana', 'BAD NAME'), 'bad_request', 'reviewer');
    await fails(review.peer('ana', 'zed'), 'not_found');
    await fails(review.peer('ana', 'plain'), 'conflict', 'agent');
  });

  it('formats a note line as id, file:line (side), tone and summary, with the reason under it', () => {
    const { subject, body } = notesMessage('ana', [{ id: 'n7', file: 'src/a.ts', side: 'old', line: 12, tone: 'warning', summary: 'Why?', rationale: 'because' }]);
    expect(subject).toBe('Review: 1 note on your diff');
    expect(body.split('\n').slice(2)).toEqual(['- n7 src/a.ts:12 (old) [warning] Why?', '  Why: because']);
    expect(body).toContain('review_read');
  });

  it('cuts a message that is too long and says how many notes it left out', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `n${i + 1}`, file: 'f.ts', side: 'new' as const, line: i + 1, tone: 'info' as const, summary: 's'.repeat(190), rationale: 'r'.repeat(900) }));
    const { body } = notesMessage('ana', many);
    expect(body.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
    expect(body).toMatch(/\.\.\.and \d+ more: read them with review_read\(agent: "ana"\)\.$/);
    expect(walkthroughMessage('ana').body.length).toBeLessThan(BODY_MAX_CHARS);
    expect(peerMessage('ana', 'ben').body).toContain('Do not change ana');
  });
});

/* ---- the Recorder's diff against the last commit, with real git ---- */

describe('the Recorder diff for a review', () => {
  let base: string;
  let work: string;
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { cwd: work, env: { PATH: process.env.PATH ?? '', HOME: base }, encoding: 'utf8' });
  const recorder = (): ReturnType<typeof createRecorder> =>
    createRecorder(createRoots({ home: join(base, 'home'), agent: (name) => (name === 'ana' ? { dir: work, cleanRoom: false } : null) }), { PATH: process.env.PATH, HOME: base });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'gonogo-review-git-'));
    work = join(base, 'project');
    await mkdir(join(base, 'home'));
    await mkdir(work);
    git('init', '-q', '-b', 'main');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('is what differs from the last commit, staged or not, and not an untracked file', async () => {
    await writeFile(join(work, 'a.txt'), 'one\ntwo\n');
    await writeFile(join(work, 'b.txt'), 'b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    await writeFile(join(work, 'a.txt'), 'one\ntwo\nthree\n');
    git('add', 'a.txt');
    await writeFile(join(work, 'b.txt'), 'changed\n');
    await writeFile(join(work, 'untracked.txt'), 'x\n');
    const { diff } = await recorder().reviewDiff('ana');
    const files = parseDiff(diff);
    expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(textAt(files, 'a.txt', 'new', 3)).toBe('three');
    expect(textAt(files, 'b.txt', 'old', 1)).toBe('b');
  });

  it('gives what is staged when there is no commit yet, and says conflict outside a repository', async () => {
    await writeFile(join(work, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    expect(parseDiff((await recorder().reviewDiff('ana')).diff).map((f) => f.path)).toEqual(['a.txt']);
    await rm(join(work, '.git'), { recursive: true, force: true });
    await expect(recorder().reviewDiff('ana')).rejects.toMatchObject({ code: 'conflict' });
  });
});
