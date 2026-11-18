/**
 * Post-Flight Review (docs/review-spec.md): what the page decides, with no React. Notes are grouped into threads and by the line
 * they are on now (a note whose line moved is drawn where it went, an outdated one is listed apart), the filter, the verdict line,
 * the soft commit gate, the keys that walk through the notes, and the form are checked here so that the tests can run them.
 */
import { REVIEW_BODY_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView, ReviewLine, ReviewNote, ReviewNoteRequest, ReviewSide, ReviewTone, ReviewView } from '../shared/protocol.js';
import { providerInfo } from '../shared/protocol.js';

/** The key of a line of the diff: a file, a side and a number. */
export const lineKey = (path: string, side: ReviewSide, line: number): string => `${path}\u0000${side}\u0000${line}`;

/** The side a click on a line of the diff means: a removed line is on the old side, an added or unchanged line on the new one. */
export const sideOf = (line: ReviewLine): ReviewSide => (line.kind === 'del' ? 'old' : 'new');

/** The number a click on a line means on its side, or null. */
export const numberOf = (line: ReviewLine): number | null => (line.kind === 'del' ? line.old : line.new);

export interface Thread {
  root: ReviewNote;
  replies: ReviewNote[];
}

const order = (a: ReviewNote, b: ReviewNote): number => a.createdAt - b.createdAt || Number(a.id.slice(2)) - Number(b.id.slice(2));

/** The notes as threads, a root and its replies in the order they were made, the roots as the server sent them (open first). A reply whose parent is gone stands as a root. */
export function threadsOf(notes: readonly ReviewNote[]): Thread[] {
  const ids = new Set(notes.map((n) => n.id));
  return notes
    .filter((n) => n.replyTo === undefined || !ids.has(n.replyTo))
    .map((root) => ({ root, replies: notes.filter((n) => n.replyTo === root.id).sort(order) }));
}

export type Filter = 'all' | 'mine' | 'agents' | 'open';
export const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'agents', label: 'Agents' },
  { id: 'open', label: 'Open' },
];

/** The threads a filter keeps: by the author of the root, or by its status. */
export function filterThreads(threads: readonly Thread[], filter: Filter): Thread[] {
  return threads.filter(({ root }) => (filter === 'mine' ? root.author === 'user' : filter === 'agents' ? root.author !== 'user' : filter === 'open' ? root.status === 'open' : true));
}

/** The threads drawn on a line of the diff, by the line each is on now (where it moved to, when it moved). Outdated and unknown ones are not on a line. */
export function threadsByLine(threads: readonly Thread[]): Map<string, Thread[]> {
  const out = new Map<string, Thread[]>();
  for (const thread of threads) {
    const { place, path, side } = thread.root;
    if (place.state !== 'exact' && place.state !== 'moved') continue;
    const key = lineKey(path, side, place.line);
    out.set(key, [...(out.get(key) ?? []), thread]);
  }
  return out;
}

/** The threads whose line is not in the diff any more: listed in their own group, with the old place and text. */
export const outdatedThreads = (threads: readonly Thread[]): Thread[] => threads.filter((t) => t.root.place.state === 'outdated' || t.root.place.state === 'unknown');

export interface Counts {
  open: number;
  addressed: number;
  resolved: number;
  outdated: number;
}

/** Counts of the threads (a reply is part of its root). */
export function countThreads(threads: readonly Thread[]): Counts {
  return {
    open: threads.filter((t) => t.root.status === 'open').length,
    addressed: threads.filter((t) => t.root.status === 'addressed').length,
    resolved: threads.filter((t) => t.root.status === 'resolved').length,
    outdated: threads.filter((t) => t.root.place.state === 'outdated').length,
  };
}

export const TONE_LABELS: Readonly<Record<ReviewTone, string>> = { info: 'NOTE', warning: 'WARNING', error: 'PROBLEM' };
export const TONE_CHIPS: Readonly<Record<ReviewTone, 'quiet' | 'amber' | 'nogo'>> = { info: 'quiet', warning: 'amber', error: 'nogo' };
export const STATUS_LABELS = { open: 'OPEN', addressed: 'ADDRESSED', resolved: 'RESOLVED' } as const;

/** `src/a.ts:12 (new)`. */
export const placeText = (note: Pick<ReviewNote, 'path' | 'line' | 'side'>): string => `${note.path}:${note.line} (${note.side})`;

export const authorText = (note: Pick<ReviewNote, 'author'>): string => (note.author === 'user' ? 'You' : note.author);

/** The id of the row of a note in the page, for jump-to. */
export const noteDomId = (id: string): string => `review-note-${id}`;
/** The id of the row of a line in the page. */
export const lineDomId = (path: string, side: ReviewSide, line: number): string => `review-line-${encodeURIComponent(path)}-${side}-${line}`;

/** The note after or before `current` in the list a reader walks through (n and p keys), wrapping at both ends; the first when none is current. */
export function stepNote(ids: readonly string[], current: string | null, direction: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return direction === 1 ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);
  return ids[(at + direction + ids.length) % ids.length] ?? null;
}

/** The agents a peer review can be asked of: ones that read mail, running or not, other than the author. */
export function peerCandidates(agents: readonly AgentView[], author: string): AgentView[] {
  return agents.filter((a) => a.name !== author && providerInfo(a.provider).mcp);
}

/** Why the actions cannot run now, or null. The server judges again. */
export function actionProblems(author: AgentView | undefined, counts: Counts, repo: boolean): { approve: string | null; changes: string | null; ask: string | null } {
  const mail = author === undefined ? 'That console is gone.' : !providerInfo(author.provider).mcp ? `${author.name} has no gonogo tools, so it cannot read mail.` : null;
  const git = repo ? null : 'This folder is not a repository, so there is no diff to judge.';
  return {
    approve: mail ?? git,
    changes: mail ?? git ?? (counts.open === 0 ? 'No note is open: add a note first.' : null),
    ask: mail,
  };
}

/** The line under the verdict keys: what the Director said last, and whether it was about this diff. */
export function verdictText(view: Pick<ReviewView, 'verdict' | 'stale'>, at: (ms: number) => string): string {
  if (view.verdict === null) return 'No verdict yet.';
  const what = view.verdict.verdict === 'approved' ? 'Approved' : 'Changes requested';
  return view.stale ? `${what} ${at(view.verdict.at)}: an older diff (the changes have moved on since).` : `${what} ${at(view.verdict.at)}.`;
}

/**
 * The soft gate of COMMIT: why the Director should stop to look before committing, or null. It speaks when a review has started and
 * notes are open, or the last verdict was not an approval of this diff. A review that never started says nothing. It is a question,
 * not a lock: the server commits for anyone who asks, and so does an agent on the host, so a hard block would suggest a safety that
 * is not there.
 */
export function commitGate(view: Pick<ReviewView, 'notes' | 'verdict' | 'stale'> | null): string | null {
  if (view === null) return null;
  const open = view.notes.filter((n) => n.replyTo === undefined && n.status === 'open').length;
  const reasons: string[] = [];
  if (open > 0) reasons.push(`${open} ${open === 1 ? 'note is' : 'notes are'} still open`);
  if (view.verdict !== null && (view.verdict.verdict !== 'approved' || view.stale)) reasons.push(view.verdict.verdict !== 'approved' ? 'changes were requested and not approved since' : 'the approval was of an older diff');
  return reasons.length === 0 ? null : `${reasons.join(', and ')[0]?.toUpperCase() ?? ''}${reasons.join(', and ').slice(1)}.`;
}

/** A note form checked before it is sent. */
export function bodyProblem(body: string): string | null {
  const text = body.trim();
  if (text === '') return 'Write what you want to say.';
  if (text.length > REVIEW_BODY_MAX_CHARS) return `At most ${REVIEW_BODY_MAX_CHARS} characters.`;
  return null;
}

export interface NoteValues {
  body: string;
  tone: ReviewTone;
}
export const emptyNote = (): NoteValues => ({ body: '', tone: 'info' });

/** The body of POST .../review/notes for a note on a line, or for a reply (which has no tone). */
export function noteRequest(values: NoteValues, place: { path: string; side: ReviewSide; line: number } | { replyTo: string }): ReviewNoteRequest {
  return 'replyTo' in place ? { replyTo: place.replyTo, body: values.body.trim() } : { ...place, body: values.body.trim(), tone: values.tone };
}
