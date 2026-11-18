import { describe, expect, it } from 'vitest';
import type { AgentView, ReviewLine, ReviewNote } from '../src/shared/protocol.js';
import { REVIEW_SUMMARY_MAX_CHARS } from '../src/shared/protocol.js';
import { actionProblems, authorText, countNotes, emptyNote, lineDomId, lineKey, noteProblem, noteRequest, numberOf, peerCandidates, placeText, sentText, sideOf, threadsByLine, threadsOf } from '../src/client/review.js';

const note = (id: string, patch: Partial<ReviewNote> = {}): ReviewNote => ({
  id, file: 'a.ts', side: 'new', line: 3, summary: `s${id}`, author: 'user', tone: 'info', status: 'open', replyTo: null, at: Number(id.slice(1)), sentAt: null, outdated: false, ...patch,
});
const agent = (name: string, provider: AgentView['provider'] = 'claude'): AgentView => ({ name, provider }) as AgentView;

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
  it('puts a reply under its parent in the order they were made, and a reply with no parent stands alone', () => {
    const notes = [note('n3', { replyTo: 'n1', author: 'ana' }), note('n1'), note('n2', { line: 9 }), note('n4', { replyTo: 'n1' }), note('n5', { replyTo: 'n99' })];
    const threads = threadsOf(notes);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([['n1', ['n3', 'n4']], ['n2', []], ['n5', []]]);
  });

  it('groups the threads by line, and leaves an outdated one out of the lines', () => {
    const byLine = threadsByLine([note('n1'), note('n2', { replyTo: 'n1' }), note('n3', { line: 9 }), note('n4', { outdated: true, line: 12 }), note('n5', { side: 'old' })]);
    expect(byLine.get(lineKey('a.ts', 'new', 3))!.map((t) => t.root.id)).toEqual(['n1']);
    expect(byLine.get(lineKey('a.ts', 'new', 3))![0]!.replies.map((r) => r.id)).toEqual(['n2']);
    expect(byLine.get(lineKey('a.ts', 'new', 9))).toHaveLength(1);
    expect(byLine.get(lineKey('a.ts', 'old', 3))).toHaveLength(1);
    expect(byLine.has(lineKey('a.ts', 'new', 12))).toBe(false);
  });
});

describe('counts and actions', () => {
  it('counts open, resolved and outdated notes, and the Director\'s notes that are waiting to be sent', () => {
    const notes = [note('n1'), note('n2', { sentAt: 5 }), note('n3', { status: 'resolved' }), note('n4', { author: 'ana' }), note('n5', { outdated: true })];
    expect(countNotes(notes)).toEqual({ open: 4, resolved: 1, outdated: 1, toSend: 2 });
    expect(countNotes([])).toEqual({ open: 0, resolved: 0, outdated: 0, toSend: 0 });
  });

  it('says why an action cannot run: no note to send, an agent without tools, a console that is gone', () => {
    expect(actionProblems(agent('ana'), { open: 1, resolved: 0, outdated: 0, toSend: 1 })).toEqual({ send: null, walkthrough: null, peer: null });
    expect(actionProblems(agent('ana'), { open: 0, resolved: 0, outdated: 0, toSend: 0 }).send).toMatch(/waiting to be sent/);
    expect(actionProblems(agent('qwen', 'qwen'), { open: 1, resolved: 0, outdated: 0, toSend: 1 })).toMatchObject({ send: expect.stringContaining('cannot read mail'), walkthrough: expect.stringContaining('cannot read mail') });
    expect(actionProblems(undefined, { open: 1, resolved: 0, outdated: 0, toSend: 1 }).peer).toMatch(/gone/);
  });

  it('offers as reviewers the other agents that read mail', () => {
    expect(peerCandidates([agent('ana'), agent('ben'), agent('qwen', 'qwen'), agent('cmd', 'custom')], 'ana').map((a) => a.name)).toEqual(['ben']);
  });
});

describe('the form', () => {
  it('asks for a line of words within the limit', () => {
    expect(noteProblem('  ')).toMatch(/Write what/);
    expect(noteProblem('x'.repeat(REVIEW_SUMMARY_MAX_CHARS + 1))).toMatch(/At most 200/);
    expect(noteProblem('Why?')).toBeNull();
  });

  it('sends the words trimmed with the tone, the reason only when there is one, and a reply by its parent', () => {
    expect(noteRequest({ ...emptyNote(), summary: ' Why? ' }, { file: 'a.ts', side: 'new', line: 3 })).toEqual({ file: 'a.ts', side: 'new', line: 3, summary: 'Why?', tone: 'info' });
    expect(noteRequest({ summary: 'Bug', rationale: ' it leaks ', tone: 'error' }, { replyTo: 'n1' })).toEqual({ replyTo: 'n1', summary: 'Bug', rationale: 'it leaks', tone: 'error' });
  });

  it('words a place, an author and what was sent', () => {
    expect(placeText({ file: 'src/a.ts', line: 12, side: 'old' })).toBe('src/a.ts:12 (old)');
    expect(authorText({ author: 'user' })).toBe('You');
    expect(authorText({ author: 'ana' })).toBe('ana');
    expect(sentText(1, 'ana')).toBe('1 note sent to ana.');
    expect(sentText(3, 'ana')).toBe('3 notes sent to ana.');
  });
});
