import { describe, expect, it } from 'vitest';
import type { AgentView, ReviewLine, ReviewNote, ReviewVerdict } from '../src/shared/protocol.js';
import { REVIEW_BODY_MAX_CHARS } from '../src/shared/protocol.js';
import { actionProblems, authorText, bodyProblem, commitGate, countThreads, emptyNote, filterThreads, lineDomId, lineKey, noteRequest, numberOf, outdatedThreads, peerCandidates, placeText, sideOf, stepNote, threadsByLine, threadsOf, verdictText } from '../src/client/review.js';

const note = (id: string, patch: Partial<ReviewNote> = {}): ReviewNote => ({
  id, agent: 'ana', path: 'a.ts', side: 'new', line: 3, text: 'x', body: `b${id}`, tone: 'info', author: 'user', status: 'open', createdAt: Number(id.slice(2)), updatedAt: 1, place: { state: 'exact', line: 3 }, ...patch,
});
const agent = (name: string, provider: AgentView['provider'] = 'claude'): AgentView => ({ name, provider }) as AgentView;
const verdict = (v: ReviewVerdict['verdict']): ReviewVerdict => ({ verdict: v, at: 1, diffHash: 'h', by: 'user' });

describe('lines', () => {
  it('puts a note on the old side for a removed line and on the new side for the others', () => {
    const del: ReviewLine = { kind: 'del', old: 7, new: null, text: 'x' };
    const add: ReviewLine = { kind: 'add', old: null, new: 8, text: 'y' };
    const ctx: ReviewLine = { kind: 'ctx', old: 9, new: 10, text: 'z' };
    expect([sideOf(del), numberOf(del)]).toEqual(['old', 7]);
    expect([sideOf(add), numberOf(add)]).toEqual(['new', 8]);
    expect([sideOf(ctx), numberOf(ctx)]).toEqual(['new', 10]);
    expect(lineKey('a.ts', 'new', 3)).not.toBe(lineKey('a.ts', 'old', 3));
    expect(lineDomId('src/a b.ts', 'old', 4)).toBe('review-line-src%2Fa%20b.ts-old-4');
  });
});

describe('threads', () => {
  it('puts a reply under its parent in the order they were made, keeps the roots as sent, and a reply with no parent stands alone', () => {
    const notes = [note('rn5', { replyTo: 'rn99' }), note('rn1'), note('rn3', { replyTo: 'rn1', tone: undefined, author: 'ana' }), note('rn2', { line: 9 }), note('rn4', { replyTo: 'rn1', tone: undefined })];
    expect(threadsOf(notes).map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([['rn5', []], ['rn1', ['rn3', 'rn4']], ['rn2', []]]);
  });

  it('filters by author and by status', () => {
    const threads = threadsOf([note('rn1'), note('rn2', { author: 'ben', status: 'addressed' }), note('rn3', { status: 'resolved' })]);
    const ids = (f: Parameters<typeof filterThreads>[1]): string[] => filterThreads(threads, f).map((t) => t.root.id);
    expect(ids('all')).toEqual(['rn1', 'rn2', 'rn3']);
    expect(ids('mine')).toEqual(['rn1', 'rn3']);
    expect(ids('agents')).toEqual(['rn2']);
    expect(ids('open')).toEqual(['rn1']);
  });

  it('draws a note where its line is now: a moved note on the new number, an outdated or unknown one on no line', () => {
    const threads = threadsOf([
      note('rn1'),
      note('rn2', { place: { state: 'moved', line: 8 } }),
      note('rn3', { place: { state: 'outdated', line: 3 } }),
      note('rn4', { place: { state: 'unknown', line: 3 } }),
      note('rn5', { side: 'old' }),
    ]);
    const byLine = threadsByLine(threads);
    expect(byLine.get(lineKey('a.ts', 'new', 3))!.map((t) => t.root.id)).toEqual(['rn1']);
    expect(byLine.get(lineKey('a.ts', 'new', 8))!.map((t) => t.root.id)).toEqual(['rn2']);
    expect(byLine.get(lineKey('a.ts', 'old', 3))!.map((t) => t.root.id)).toEqual(['rn5']);
    expect(outdatedThreads(threads).map((t) => t.root.id)).toEqual(['rn3', 'rn4']);
  });

  it('counts threads by status and the outdated ones', () => {
    const threads = threadsOf([note('rn1'), note('rn2', { status: 'addressed' }), note('rn3', { status: 'resolved' }), note('rn4', { place: { state: 'outdated', line: 1 } }), note('rn5', { replyTo: 'rn1' })]);
    expect(countThreads(threads)).toEqual({ open: 2, addressed: 1, resolved: 1, outdated: 1 });
  });
});

describe('walking through the notes', () => {
  it('goes to the next and the previous, wraps at both ends, and starts at an end when none is current', () => {
    const ids = ['a', 'b', 'c'];
    expect(stepNote(ids, null, 1)).toBe('a');
    expect(stepNote(ids, null, -1)).toBe('c');
    expect(stepNote(ids, 'a', 1)).toBe('b');
    expect(stepNote(ids, 'c', 1)).toBe('a');
    expect(stepNote(ids, 'a', -1)).toBe('c');
    expect(stepNote(ids, 'gone', 1)).toBe('a');
    expect(stepNote([], 'a', 1)).toBeNull();
  });
});

describe('the actions', () => {
  const counts = { open: 1, addressed: 0, resolved: 0, outdated: 0 };
  it('says why one cannot run: no open note, an agent without tools, a console that is gone, no repository', () => {
    expect(actionProblems(agent('ana'), counts, true)).toEqual({ approve: null, changes: null, ask: null });
    expect(actionProblems(agent('ana'), { ...counts, open: 0 }, true).changes).toMatch(/No note is open/);
    expect(actionProblems(agent('qwen', 'qwen'), counts, true)).toMatchObject({ approve: expect.stringContaining('cannot read mail'), ask: expect.stringContaining('cannot read mail') });
    expect(actionProblems(undefined, counts, true).ask).toMatch(/gone/);
    expect(actionProblems(agent('ana'), counts, false).approve).toMatch(/not a repository/);
  });

  it('offers as reviewers the other agents that read mail', () => {
    expect(peerCandidates([agent('ana'), agent('ben'), agent('qwen', 'qwen'), agent('cmd', 'custom')], 'ana').map((a) => a.name)).toEqual(['ben']);
  });
});

describe('the verdict line and the commit gate', () => {
  const at = (): string => 'just now';
  it('says what was decided and whether it was about this diff', () => {
    expect(verdictText({ verdict: null, stale: false }, at)).toBe('No verdict yet.');
    expect(verdictText({ verdict: verdict('approved'), stale: false }, at)).toBe('Approved just now.');
    expect(verdictText({ verdict: verdict('changes'), stale: false }, at)).toBe('Changes requested just now.');
    expect(verdictText({ verdict: verdict('approved'), stale: true }, at)).toMatch(/Approved just now: an older diff/);
  });

  it('says nothing when no review has started or everything is settled', () => {
    expect(commitGate(null)).toBeNull();
    expect(commitGate({ notes: [], verdict: null, stale: false })).toBeNull();
    expect(commitGate({ notes: [note('rn1', { status: 'resolved' }), note('rn2', { status: 'addressed' })], verdict: verdict('approved'), stale: false })).toBeNull();
    expect(commitGate({ notes: [note('rn1', { replyTo: 'rn9' })], verdict: null, stale: false })).toBeNull();
  });

  it('stops to ask when notes are open, or the last verdict was not an approval of this diff', () => {
    expect(commitGate({ notes: [note('rn1'), note('rn2'), note('rn3', { replyTo: 'rn1' })], verdict: null, stale: false })).toBe('2 notes are still open.');
    expect(commitGate({ notes: [note('rn1')], verdict: null, stale: false })).toBe('1 note is still open.');
    expect(commitGate({ notes: [], verdict: verdict('changes'), stale: false })).toBe('Changes were requested and not approved since.');
    expect(commitGate({ notes: [], verdict: verdict('approved'), stale: true })).toBe('The approval was of an older diff.');
    expect(commitGate({ notes: [note('rn1')], verdict: verdict('approved'), stale: true })).toBe('1 note is still open, and the approval was of an older diff.');
  });
});

describe('the form', () => {
  it('asks for words within the limit', () => {
    expect(bodyProblem('  ')).toMatch(/Write what/);
    expect(bodyProblem('x'.repeat(REVIEW_BODY_MAX_CHARS + 1))).toMatch(/At most 2000/);
    expect(bodyProblem('Why?')).toBeNull();
  });

  it('sends a note with its tone and a reply without one', () => {
    expect(noteRequest({ ...emptyNote(), body: ' Why? ' }, { path: 'a.ts', side: 'new', line: 3 })).toEqual({ path: 'a.ts', side: 'new', line: 3, body: 'Why?', tone: 'info' });
    expect(noteRequest({ body: 'Fixed', tone: 'error' }, { replyTo: 'rn1' })).toEqual({ replyTo: 'rn1', body: 'Fixed' });
  });

  it('words a place and an author', () => {
    expect(placeText({ path: 'src/a.ts', line: 12, side: 'old' })).toBe('src/a.ts:12 (old)');
    expect(authorText({ author: 'user' })).toBe('You');
    expect(authorText({ author: 'ana' })).toBe('ana');
  });
});
