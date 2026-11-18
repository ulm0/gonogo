/** Post-Flight Review: the diff parser and locate, the store (a real temp folder, a fake diff), the mail, and the Recorder's `git diff HEAD`. */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locate, parseDiff, textAt } from '../src/shared/diff.js';
import { REVIEW_BATCH_MAX, REVIEW_MAIL_MAX_CHARS, REVIEW_NOTES_MAX, REVIEW_REQUEST_TTL_MS } from '../src/shared/protocol.js';
import type { AgentSendRequest, Logger, SendResult } from '../src/shared/protocol.js';
import { buildDockerArgs } from '../src/server/cleanroom.js';
import { createRoots } from '../src/server/hangar.js';
import { createRecorder } from '../src/server/recorder.js';
import { HubError } from '../src/server/hub.js';
import { approvedMessage, changesMessage, createReview, peerMessage, walkthroughMessage } from '../src/server/review.js';
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
  it('reads files, hunks, the ranges of a hunk and the numbers of every line on both sides', () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.binary, f.hunks.length])).toEqual([
      ['src/a.ts', 'modified', false, 2],
      ['new.txt', 'added', false, 1],
      ['gone.txt', 'deleted', false, 1],
      ['pic.png', 'modified', true, 0],
    ]);
    const first = files[0]!.hunks[0]!;
    expect([first.oldStart, first.oldCount, first.newStart, first.newCount]).toEqual([1, 4, 1, 5]);
    expect(first.lines.map((l) => [l.kind, l.old, l.new, l.text])).toEqual([
      ['ctx', 1, 1, 'import x from "x";'],
      ['del', 2, null, 'const a = 1;'],
      ['add', null, 2, 'const a = 2;'],
      ['add', null, 3, 'const b = 3;'],
      ['ctx', 3, 4, 'export {};'],
      ['ctx', 4, 5, '// end'],
    ]);
    const second = files[0]!.hunks[1]!;
    expect([second.header, second.oldStart, second.newStart]).toEqual(['@@ -20,2 +21,2 @@ function f() {', 20, 21]);
    // a hunk header with no count means one line
    expect([files[2]!.hunks[0]!.oldCount, files[2]!.hunks[0]!.newCount]).toEqual([1, 0]);
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

  it('takes a renamed file by its new name, drops the CR of a CRLF file, and never throws on a diff cut short or on text that is no diff', () => {
    const renamed = parseDiff('diff --git a/old name.txt b/new name.txt\nsimilarity index 90%\nrename from old name.txt\nrename to new name.txt\n--- a/old name.txt\t\n+++ b/new name.txt\t\n@@ -1 +1 @@\n-a\r\n+b\r\n');
    expect(renamed[0]).toMatchObject({ path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed' });
    expect(renamed[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['a', 'b']);
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('not a diff\n@@ nonsense')).toEqual([]);
    expect(parseDiff(DIFF.slice(0, 190))[0]!.hunks[0]!.lines.length).toBeGreaterThan(0);
    // a content line that looks like a header is content
    const tricky = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- a/y\n+++ b/y\n');
    expect(tricky[0]!.path).toBe('x');
    expect(tricky[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(['-- a/y', '++ b/y']);
  });
});

describe('locate', () => {
  const diff = (lines: string[], start = 1): ReturnType<typeof parseDiff> => parseDiff(['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts', `@@ -0,0 +${start},${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n'));
  const at = (line: number, text: string) => ({ path: 'f.ts', side: 'new' as const, line, text });

  it('is exact when the same line holds the same text', () => {
    expect(locate(at(2, 'beta'), diff(['alpha', 'beta', 'gamma']))).toEqual({ state: 'exact', line: 2 });
  });

  it('is moved when the text is at another number: there when it is once, the nearest when it is several', () => {
    expect(locate(at(2, 'beta'), diff(['x', 'alpha', 'beta']))).toEqual({ state: 'moved', line: 3 });
    expect(locate(at(5, 'dup'), diff(['dup', 'a', 'b', 'dup', 'c', 'd', 'dup']))).toEqual({ state: 'moved', line: 4 });
    expect(locate(at(1, 'dup'), diff(['a', 'dup', 'b', 'dup']))).toEqual({ state: 'moved', line: 2 });
  });

  it('is outdated when the text, the file or the side is gone', () => {
    expect(locate(at(2, 'beta'), diff(['alpha', 'BETA', 'gamma']))).toEqual({ state: 'outdated', line: 2 });
    expect(locate({ ...at(2, 'beta'), path: 'other.ts' }, diff(['alpha', 'beta']))).toMatchObject({ state: 'outdated' });
    expect(locate({ ...at(2, 'beta'), side: 'old' }, diff(['alpha', 'beta']))).toMatchObject({ state: 'outdated' });
    expect(locate(at(2, 'beta'), [])).toMatchObject({ state: 'outdated' });
  });

  it('keeps a note on a line that was only re-indented or re-spaced', () => {
    expect(locate(at(2, 'if (a) {'), diff(['x', '    if   (a)  {']))).toEqual({ state: 'exact', line: 2 });
    expect(locate(at(2, '  return 1;'), diff(['x', 'y', '\treturn 1;']))).toEqual({ state: 'moved', line: 3 });
  });

  it('says unknown, not outdated, when a diff cut short does not reach the line', () => {
    expect(locate(at(9, 'late'), diff(['alpha']), true)).toEqual({ state: 'unknown', line: 9 });
    expect(locate(at(9, 'late'), diff(['alpha']), false)).toMatchObject({ state: 'outdated' });
    expect(locate(at(1, 'alpha'), diff(['alpha']), true)).toMatchObject({ state: 'exact' });
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
let posted: Array<[string, string]>;
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
    notify: (kind, text) => void posted.push([kind, text]),
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
  posted = [];
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
const note = { path: 'src/a.ts', side: 'new', line: 3, body: 'Why a second constant?' };

describe('notes', () => {
  it('adds a note on a line of the diff, copies the text of the line from the diff, and shows it with the diff and where it is', async () => {
    const review = make();
    const made = await review.addNote(USER, 'ana', { ...note, tone: 'warning' });
    expect(made).toMatchObject({ id: 'rn1', agent: 'ana', path: 'src/a.ts', side: 'new', line: 3, text: 'const b = 3;', body: 'Why a second constant?', tone: 'warning', author: 'user', status: 'open', createdAt: now, place: { state: 'exact', line: 3 } });
    expect(made.replyTo).toBeUndefined();
    const view = await review.view('ana');
    expect(view).toMatchObject({ repo: true, truncated: false, verdict: null, stale: false, asked: [] });
    expect(view.files.map((f) => f.path)).toEqual(['src/a.ts', 'new.txt', 'gone.txt', 'pic.png']);
    expect(view.diffHash).toMatch(/^[0-9a-f]{16}$/);
    expect(view.notes).toHaveLength(1);
  });

  it('keeps the notes in <home>/reviews.json, written whole, and nothing in the folder of the agent (a Clean Room could write there)', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    expect(JSON.parse(await readFile(join(dir, 'reviews.json'), 'utf8'))).toMatchObject({ version: 1, seq: 1, notes: [{ id: 'rn1', agent: 'ana', text: 'const b = 3;' }], verdicts: {}, requests: [] });
    expect((await readdir(dir)).sort()).toEqual(['reviews.json']);
  });

  it('is out of the reach of a Clean Room: the container mounts its worktree and its own agent folder, never the home that holds reviews.json', () => {
    const home = '/state/gonogo';
    const args = buildDockerArgs({
      image: 'gonogo-agent',
      uid: 1000,
      gid: 1000,
      place: { container: 'gonogo-cr-ana', network: null, home: `${home}/cleanroom-home/ana`, worktree: `${home}/cleanroom/ana`, cwd: `${home}/cleanroom/ana` } as never,
      agentDir: `${home}/agents/ana`,
      names: [],
      command: ['claude'],
    });
    const mounted = args.flatMap((a, i) => (args[i - 1] === '-v' ? [a.split(':')[0] as string] : []));
    expect(mounted).toContain(`${home}/agents/ana`);
    // a path the container can write is under one of these three; reviews.json is in none of them
    const reviews = `${home}/reviews.json`;
    expect(mounted.some((m) => reviews === m || reviews.startsWith(`${m}/`))).toBe(false);
    expect(mounted.every((m) => !m.endsWith('reviews.json'))).toBe(true);
  });

  it('refuses a line that is not in the diff, a bad field and any field it does not have, naming the field', async () => {
    const review = make();
    await fails(review.addNote(USER, 'ana', { ...note, line: 99 }), 'bad_request', 'line');
    await fails(review.addNote(USER, 'ana', { ...note, path: 'nope.ts' }), 'bad_request', 'line');
    await fails(review.addNote(USER, 'ana', { ...note, path: '../etc/passwd' }), 'bad_request', 'path');
    await fails(review.addNote(USER, 'ana', { ...note, path: '.git/config' }), 'bad_request', 'path');
    await fails(review.addNote(USER, 'ana', { ...note, path: '/abs' }), 'bad_request', 'path');
    await fails(review.addNote(USER, 'ana', { ...note, side: 'left' }), 'bad_request', 'side');
    await fails(review.addNote(USER, 'ana', { ...note, line: 0 }), 'bad_request', 'line');
    await fails(review.addNote(USER, 'ana', { ...note, body: '' }), 'bad_request', 'body');
    await fails(review.addNote(USER, 'ana', { ...note, body: 'x'.repeat(2001) }), 'bad_request', 'body');
    await fails(review.addNote(USER, 'ana', { ...note, tone: 'loud' }), 'bad_request', 'tone');
    await fails(review.addNote(USER, 'ana', { ...note, author: 'ben' }), 'bad_request', 'author');
    await fails(review.addNote(USER, 'ana', { ...note, text: 'forged' }), 'bad_request', 'text');
    await fails(review.addNote(USER, 'ana', null), 'bad_request');
    await fails(review.addNote(USER, 'zed', note), 'not_found');
    expect((await review.view('ana')).notes).toEqual([]);
  });

  it('keeps line breaks in a body and takes the other control and bidi characters out', async () => {
    const made = await make().addNote(USER, 'ana', { ...note, body: 'a\n\nb\u0007c‮d' });
    expect(made.body).toBe('a\n\nb c d');
  });

  it('a reply sits on the line of its parent, has no tone, and a reply to a reply goes to the root', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    const reply = await review.addNote(ANA, 'ana', { replyTo: 'rn1', body: 'Fixed' });
    expect(reply).toMatchObject({ id: 'rn2', path: 'src/a.ts', side: 'new', line: 3, text: 'const b = 3;', replyTo: 'rn1', author: 'ana' });
    expect(reply.tone).toBeUndefined();
    expect((await review.addNote(USER, 'ana', { replyTo: 'rn2', body: 'Thanks' })).replyTo).toBe('rn1');
    await fails(review.addNote(ANA, 'ana', { replyTo: 'rn9', body: 'x' }), 'bad_request', 'replyTo');
    await fails(review.addNote(ANA, 'ana', { replyTo: 'nope', body: 'x' }), 'bad_request', 'replyTo');
    await fails(review.addNote(ANA, 'ana', { replyTo: 'rn1', body: 'x', line: 4 }), 'bad_request', 'line');
    await fails(review.addNote(ANA, 'ana', { replyTo: 'rn1', body: 'x', tone: 'info' }), 'bad_request', 'tone');
  });

  it('refuses a reply to the note of another agent\'s diff', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    await fails(review.addNote(USER, 'ben', { replyTo: 'rn1', body: 'x' }), 'bad_request', 'replyTo');
    await fails(review.update('ben', 'rn1', { status: 'resolved' }), 'not_found');
    await fails(review.remove('ben', 'rn1'), 'not_found');
  });

  it('a reply by the reviewed agent marks the note it answers as addressed, and one by anybody else does not', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    await review.addNote(USER, 'ana', { ...note, line: 2, body: 'second' });
    await review.addNote(USER, 'ana', { replyTo: 'rn2', body: 'the Director again' });
    expect((await review.view('ana')).notes.find((n) => n.id === 'rn2')!.status).toBe('open');
    await review.addNotes(ANA, 'ana', [{ replyTo: 'rn1', body: 'Fixed' }]);
    const notes = (await review.view('ana')).notes;
    expect(notes.find((n) => n.id === 'rn1')!.status).toBe('addressed');
    expect(notes.find((n) => n.id === 'rn2')!.status).toBe('open');
    // the Director reopens it
    expect((await review.update('ana', 'rn1', { status: 'open' })).status).toBe('open');
  });

  it('puts a note by the reviewed agent on its own diff (its walkthrough) as addressed: it waits for nobody', async () => {
    const review = make();
    const [walk] = await review.addNotes(ANA, 'ana', [{ ...note, body: 'This is the second constant' }]);
    expect(walk).toMatchObject({ author: 'ana', status: 'addressed', tone: 'info' });
  });

  it('sets a status or a body, deletes a note with its replies, and never reuses an id', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    await review.addNote(ANA, 'ana', { replyTo: 'rn1', body: 'Fixed' });
    expect((await review.update('ana', 'rn1', { status: 'resolved' })).status).toBe('resolved');
    expect((await review.update('ana', 'rn1', { body: 'Better words' })).body).toBe('Better words');
    await fails(review.update('ana', 'rn1', { status: 'done' }), 'bad_request', 'status');
    await fails(review.update('ana', 'rn1', { body: '' }), 'bad_request', 'body');
    await fails(review.update('ana', 'rn1', { tone: 'error' }), 'bad_request', 'tone');
    await fails(review.update('ana', 'rn1', {}), 'bad_request');
    await fails(review.update('ana', 'rn7', { status: 'open' }), 'not_found');
    await review.remove('ana', 'rn1');
    expect((await review.view('ana')).notes).toEqual([]);
    await fails(review.remove('ana', 'rn1'), 'not_found');
    expect((await make().addNote(USER, 'ana', note)).id).toBe('rn3');
  });

  it('sends the open notes first, a thread together, in the order they were made', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    now += 1000;
    await review.addNote(USER, 'ana', { ...note, line: 2, body: 'second' });
    await review.addNote(ANA, 'ana', { replyTo: 'rn1', body: 'reply to the first' });
    await review.update('ana', 'rn1', { status: 'resolved' });
    expect((await review.view('ana')).notes.map((n) => n.id)).toEqual(['rn2', 'rn1', 'rn3']);
  });

  it('keeps the notes of each agent apart, and says when the folder is not a repository', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    expect((await review.view('ben')).notes).toEqual([]);
    notRepo = 'this folder is not in a git repository';
    const view = await review.view('ana');
    expect(view).toMatchObject({ repo: false, reason: 'this folder is not in a git repository', files: [] });
    expect(view.notes).toHaveLength(1);
    expect(view.notes[0]!.place.state).toBe('unknown');
    await fails(review.addNote(USER, 'ana', note), 'conflict');
  });

  it('keeps a damaged file aside and starts empty, and skips a record that is not a note', async () => {
    await writeFile(join(dir, 'reviews.json'), '{ nope');
    const review = make();
    expect((await review.view('ana')).notes).toEqual([]);
    expect(await readFile(join(dir, 'reviews.json.bad'), 'utf8')).toBe('{ nope');
    await rm(join(dir, 'reviews.json.bad'));
    await writeFile(join(dir, 'reviews.json'), JSON.stringify({ version: 1, seq: 7, notes: [{ id: 'rn7', agent: 'ana', path: 'src/a.ts', side: 'new', line: 3, text: 'const b = 3;', body: 'kept', author: 'user', status: 'open', createdAt: 1, updatedAt: 1 }, { id: 'bad' }, { id: 'rn8', agent: 'ana', path: '../x', side: 'new', line: 1, body: 'x', author: 'user' }], verdicts: {}, requests: [] }));
    const again = make();
    expect((await again.view('ana')).notes.map((n) => n.id)).toEqual(['rn7']);
    expect((await again.addNote(USER, 'ana', note)).id).toBe('rn8');
  });
});

describe('the caps', () => {
  it('drops the oldest resolved note, with its replies, to make room, and refuses when none is resolved', async () => {
    const review = make();
    for (let i = 0; i < REVIEW_NOTES_MAX; i += 1) {
      now += 1;
      await review.addNote(USER, 'ana', note);
    }
    await fails(review.addNote(USER, 'ana', note), 'conflict', 'notes');
    await review.update('ana', 'rn5', { status: 'resolved' });
    await review.update('ana', 'rn3', { status: 'resolved' });
    await review.addNote(USER, 'ana', note);
    const ids = (await review.view('ana')).notes.map((n) => n.id);
    expect(ids).toHaveLength(REVIEW_NOTES_MAX);
    expect(ids).not.toContain('rn3');
    expect(ids).toContain('rn5');
  });
});

describe('outdated', () => {
  it('follows a note whose line moved, marks one whose line changed outdated and keeps it, and brings it back with the line', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    diffText = DIFF.replace('+const a = 2;\n', '+// a new line\n+const a = 2;\n');
    const moved = (await review.view('ana')).notes[0]!;
    expect(moved.place).toEqual({ state: 'moved', line: 4 });
    expect(moved.line).toBe(3);
    diffText = DIFF.replace('+const b = 3;', '+const b = 4;');
    expect((await review.view('ana')).notes[0]!.place.state).toBe('outdated');
    diffText = '';
    expect((await review.view('ana')).notes).toHaveLength(1);
    expect((await review.view('ana')).notes[0]!.place.state).toBe('outdated');
    diffText = DIFF;
    expect((await review.view('ana')).notes[0]!.place.state).toBe('exact');
  });

  it('says unknown for a line a diff cut short does not reach, and gives a reply the place of its root', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    await review.addNote(ANA, 'ana', { replyTo: 'rn1', body: 'x' });
    truncated = true;
    diffText = DIFF.slice(0, 120);
    const notes = (await review.view('ana')).notes;
    expect(notes.map((n) => n.place.state)).toEqual(['unknown', 'unknown']);
  });
});

describe('who may read and write', () => {
  it('lets an agent read and annotate its own diff, and nobody else\'s without the Director\'s request', async () => {
    const review = make();
    expect((await review.read('ana', ANA)).view.repo).toBe(true);
    await fails(review.read('ana', BEN), 'forbidden');
    await fails(review.addNotes(BEN, 'ana', [note]), 'forbidden');
    expect((await review.addNotes(ANA, 'ana', [note]))[0]).toMatchObject({ author: 'ana' });
  });

  it('gives a peer the right while the request is pending, ends it when the peer sends its notes, and for that diff only', async () => {
    const review = make();
    await review.ask('ana', { kind: 'peer', reviewer: 'ben' });
    expect((await review.view('ana')).asked).toEqual(['ben']);
    expect((await review.read('ana', BEN)).view.repo).toBe(true);
    await fails(review.read('ben', ANA), 'forbidden');
    const [peer] = await review.addNotes(BEN, 'ana', [{ ...note, line: 2, body: 'Rename it', tone: 'warning' }]);
    expect(peer).toMatchObject({ author: 'ben', status: 'open', line: 2 });
    expect((await review.view('ana')).asked).toEqual([]);
    await fails(review.read('ana', BEN), 'forbidden');
    await fails(review.addNotes(BEN, 'ana', [note]), 'forbidden');
  });

  it('ends a request after 24 hours', async () => {
    const review = make();
    await review.ask('ana', { kind: 'peer', reviewer: 'ben' });
    now += REVIEW_REQUEST_TTL_MS - 1;
    expect((await review.read('ana', BEN)).view.repo).toBe(true);
    now += 2;
    await fails(review.read('ana', BEN), 'forbidden');
    expect((await review.view('ana')).asked).toEqual([]);
  });

  it('gives no right when the message to the reviewer was refused', async () => {
    const review = make();
    answer = (request) => ({ ok: false, id: '', to: request.to, status: 'undelivered', note: 'ben is stopped' });
    await fails(review.ask('ana', { kind: 'peer', reviewer: 'ben' }), 'conflict', 'agent');
    await fails(review.read('ana', BEN), 'forbidden');
  });

  it('takes the notes of a batch all or none, and names the first bad one', async () => {
    const review = make();
    const made = await review.addNotes(ANA, 'ana', [note, { ...note, line: 2 }]);
    expect(made.map((n) => n.id)).toEqual(['rn1', 'rn2']);
    const error = await fails(review.addNotes(ANA, 'ana', [{ ...note, line: 1 }, { ...note, line: 99 }, { ...note, line: 4 }]), 'bad_request', 'line');
    expect(error.message).toContain('note 2:');
    expect((await review.view('ana')).notes).toHaveLength(2);
    await fails(review.addNotes(ANA, 'ana', []), 'bad_request', 'notes');
    await fails(review.addNotes(ANA, 'ana', 'x'), 'bad_request', 'notes');
    await fails(review.addNotes(ANA, 'ana', Array.from({ length: REVIEW_BATCH_MAX + 1 }, () => note)), 'bad_request', 'notes');
  });

  it('takes the author from the actor, whatever the note claims, and refuses an agent that is not in the room', async () => {
    const review = make();
    await fails(review.addNotes(ANA, 'ana', [{ ...note, author: 'user' }]), 'bad_request', 'author');
    await fails(make().read('zed', ANA), 'not_found');
  });

  it('tells the Downlink when an agent adds notes, and not for the Director', async () => {
    const review = make();
    await review.addNote(USER, 'ana', note);
    expect(posted).toEqual([]);
    await review.ask('ana', { kind: 'peer', reviewer: 'ben' });
    await review.addNotes(BEN, 'ana', [note, { ...note, line: 2 }]);
    await review.addNotes(ANA, 'ana', [{ replyTo: 'rn1', body: 'Fixed' }]);
    expect(posted).toEqual([['review', 'ben added 2 review notes on ana'], ['review', 'ana added 1 review note on its own diff']]);
  });
});

describe('reading for an agent', () => {
  it('gives the patch only on request, of one file when asked, and cuts it at 100 KiB', async () => {
    const review = make();
    expect((await review.read('ana', ANA)).patch).toBeUndefined();
    const all = await review.read('ana', ANA, { patch: true });
    expect(all.patch).toBe(DIFF);
    const one = await review.read('ana', ANA, { patch: true, path: 'new.txt' });
    expect(one.patch).toContain('diff --git a/new.txt b/new.txt');
    expect(one.patch).not.toContain('src/a.ts');
    await fails(review.read('ana', ANA, { patch: true, path: '../x' }), 'bad_request', 'path');
    diffText = `diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1 @@\n+${'x'.repeat(150_000)}\n`;
    const big = await review.read('ana', ANA, { patch: true });
    expect(big.patchTruncated).toBe(true);
    expect(Buffer.byteLength(big.patch ?? '')).toBeLessThanOrEqual(100 * 1024);
  });
});

describe('the verdict and the mail', () => {
  it('requests changes: the open notes go to the author as one message, the verdict is stored with the hash of the diff', async () => {
    const review = make();
    await review.addNote(USER, 'ana', { ...note, tone: 'error', body: 'Dead code' });
    await review.addNote(USER, 'ana', { path: 'new.txt', side: 'new', line: 1, body: 'Greeting?' });
    await review.addNote(USER, 'ana', { replyTo: 'rn1', body: 'reply: not carried' });
    await review.addNote(USER, 'ana', { ...note, line: 2, body: 'resolved one' });
    await review.update('ana', 'rn4', { status: 'resolved' });
    const out = await review.verdict('ana', { verdict: 'changes', summary: 'Almost there' });
    expect(out).toMatchObject({ message: 'm9', notes: 2, verdict: { verdict: 'changes', by: 'user', at: now } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ana', subject: 'Review: changes requested (2 open notes)' });
    expect(sent[0]!.body).toContain('The Director says: Almost there');
    expect(sent[0]!.body).toContain('- src/a.ts:3 [error] Dead code');
    expect(sent[0]!.body).toContain('- new.txt:1 [info] Greeting?');
    expect(sent[0]!.body).not.toContain('reply: not carried');
    expect(sent[0]!.body).not.toContain('resolved one');
    const view = await review.view('ana');
    expect(view.verdict).toMatchObject({ verdict: 'changes', diffHash: view.diffHash });
    expect(view.stale).toBe(false);
  });

  it('refuses REQUEST CHANGES with no open note, keeps the verdict unset when the message is refused, and an agent that cannot read mail', async () => {
    const review = make();
    await fails(review.verdict('ana', { verdict: 'changes' }), 'conflict', 'notes');
    await review.addNote(USER, 'ana', note);
    answer = (request) => ({ ok: false, id: '', to: request.to, status: 'undelivered', note: 'ana is stopped' });
    await fails(review.verdict('ana', { verdict: 'changes' }), 'conflict', 'agent');
    expect((await review.view('ana')).verdict).toBeNull();
    await fails(review.verdict('plain', { verdict: 'approved' }), 'conflict', 'agent');
    await fails(review.verdict('ana', { verdict: 'maybe' }), 'bad_request', 'verdict');
    await fails(review.verdict('ana', { verdict: 'approved', extra: 1 }), 'bad_request', 'extra');
  });

  it('approves, and says the approval was of an older diff once the diff changes', async () => {
    const review = make();
    const out = await review.verdict('ana', { verdict: 'approved' });
    expect(out.notes).toBe(0);
    expect(sent[0]).toMatchObject({ to: 'ana', subject: 'Review: approved' });
    expect((await review.view('ana')).stale).toBe(false);
    diffText = DIFF.replace('+const b = 3;', '+const b = 4;');
    const later = await review.view('ana');
    expect(later.verdict!.verdict).toBe('approved');
    expect(later.stale).toBe(true);
  });

  it('asks the author for a walkthrough, with how to do it, and takes no note to send', async () => {
    const review = make();
    expect(await review.ask('ana', { kind: 'walkthrough' })).toEqual({ message: 'm9', notes: 0 });
    expect(sent[0]).toMatchObject({ to: 'ana', subject: 'Review: walk through your diff' });
    expect(sent[0]!.body).toContain('review_read(agent: "ana"');
    expect(sent[0]!.body).toContain('review_note');
    await fails(review.ask('plain', { kind: 'walkthrough' }), 'conflict', 'agent');
    await fails(review.ask('ana', { kind: 'walkthrough', reviewer: 'ben' }), 'bad_request', 'reviewer');
  });

  it('asks a peer, and refuses an agent that reviews itself, one that cannot read mail and a bad kind', async () => {
    const review = make();
    expect(await review.ask('ana', { kind: 'peer', reviewer: 'ben' })).toEqual({ message: 'm9', notes: 0 });
    expect(sent[0]).toMatchObject({ to: 'ben', subject: "Review: peer review of ana's diff" });
    await review.ask('ana', { kind: 'peer', reviewer: 'ben' });
    expect((await review.view('ana')).asked).toEqual(['ben']);
    await fails(review.ask('ana', { kind: 'peer', reviewer: 'ana' }), 'bad_request', 'reviewer');
    await fails(review.ask('ana', { kind: 'peer', reviewer: 'BAD NAME' }), 'bad_request', 'reviewer');
    await fails(review.ask('ana', { kind: 'peer', reviewer: 'zed' }), 'not_found');
    await fails(review.ask('ana', { kind: 'peer', reviewer: 'plain' }), 'conflict', 'agent');
    await fails(review.ask('ana', { kind: 'other' }), 'bad_request', 'kind');
  });

  it('formats a note as path:line [tone] text, an agent\'s own under its name', () => {
    const { subject, body } = changesMessage('ana', [
      { path: 'src/a.ts', line: 12, tone: 'warning', body: 'Why?\nMore\nwords', author: 'user' },
      { path: 'b.ts', line: 3, tone: 'error', body: 'Leak', author: 'ben' },
    ]);
    expect(subject).toBe('Review: changes requested (2 open notes)');
    expect(body.split('\n').slice(2)).toEqual(['- src/a.ts:12 [warning] Why? More words', '- b.ts:3 [error] (ben) Leak']);
    expect(changesMessage('ana', [{ path: 'a', line: 1, tone: 'info', body: 'x', author: 'user' }]).subject).toBe('Review: changes requested (1 open note)');
    expect(approvedMessage().subject).toBe('Review: approved');
  });

  it('cuts a message that is too long and says how many notes it left out', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ path: 'f.ts', line: i + 1, tone: 'info' as const, body: 'w'.repeat(390), author: 'user' }));
    const { body } = changesMessage('ana', many);
    expect(body.length).toBeLessThanOrEqual(REVIEW_MAIL_MAX_CHARS);
    expect(body).toMatch(/\.\.\.and \d+ more: call review_read\(agent: "ana"\)\.$/);
    expect(walkthroughMessage('ana').body.length).toBeLessThan(REVIEW_MAIL_MAX_CHARS);
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
