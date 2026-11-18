/**
 * Post-Flight Review (docs/review-spec.md): what the page decides, with no React. Notes are grouped by the line they are on, a
 * reply goes under its parent, the three actions say whether they can run, and the form is checked before it is sent.
 */
import { REVIEW_SUMMARY_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView, ReviewLine, ReviewNote, ReviewNoteRequest, ReviewSide, ReviewTone } from '../shared/protocol.js';
import { providerInfo } from '../shared/protocol.js';

/** The key of a line of the diff: a file, a side and a number. */
export const lineKey = (file: string, side: ReviewSide, line: number): string => `${file}\u0000${side}\u0000${line}`;

/** The side a click on a line of the diff means: a removed line is on the old side, an added or unchanged line on the new one. */
export const sideOf = (line: ReviewLine): ReviewSide => (line.kind === 'del' ? 'old' : 'new');

/** The number a click on a line means on its side, or null. */
export const numberOf = (line: ReviewLine): number | null => (line.kind === 'del' ? line.old : line.new);

export interface Thread {
  root: ReviewNote;
  replies: ReviewNote[];
}

/** The notes as threads, a root and its replies in the order they were made. A reply whose parent is gone stands as a root. */
export function threadsOf(notes: readonly ReviewNote[]): Thread[] {
  const ids = new Set(notes.map((n) => n.id));
  const order = (a: ReviewNote, b: ReviewNote): number => a.at - b.at || Number(a.id.slice(1)) - Number(b.id.slice(1));
  const sorted = [...notes].sort(order);
  const roots = sorted.filter((n) => n.replyTo === null || !ids.has(n.replyTo));
  return roots.map((root) => ({ root, replies: sorted.filter((n) => n.replyTo === root.id) }));
}

/** The threads that sit on a line the diff shows now, by line; an outdated thread is not on any line (the list shows it). */
export function threadsByLine(notes: readonly ReviewNote[]): Map<string, Thread[]> {
  const out = new Map<string, Thread[]>();
  for (const thread of threadsOf(notes)) {
    if (thread.root.outdated) continue;
    const key = lineKey(thread.root.file, thread.root.side, thread.root.line);
    out.set(key, [...(out.get(key) ?? []), thread]);
  }
  return out;
}

export interface Counts {
  open: number;
  resolved: number;
  outdated: number;
  /** Open notes of the Director that SEND NOTES would carry. */
  toSend: number;
}

export function countNotes(notes: readonly ReviewNote[]): Counts {
  return {
    open: notes.filter((n) => n.status === 'open').length,
    resolved: notes.filter((n) => n.status === 'resolved').length,
    outdated: notes.filter((n) => n.outdated).length,
    toSend: notes.filter((n) => n.author === 'user' && n.status === 'open' && n.sentAt === null).length,
  };
}

export const TONE_LABELS: Readonly<Record<ReviewTone, string>> = { info: 'NOTE', warning: 'WARNING', error: 'PROBLEM' };
export const TONE_CHIPS: Readonly<Record<ReviewTone, 'quiet' | 'amber' | 'nogo'>> = { info: 'quiet', warning: 'amber', error: 'nogo' };

/** `src/a.ts:12 (new)`. */
export const placeText = (note: Pick<ReviewNote, 'file' | 'line' | 'side'>): string => `${note.file}:${note.line} (${note.side})`;

export const authorText = (note: Pick<ReviewNote, 'author'>): string => (note.author === 'user' ? 'You' : note.author);

/** The id of the row of a note in the page, for jump-to. */
export const noteDomId = (id: string): string => `review-note-${id}`;
/** The id of the row of a line in the page. */
export const lineDomId = (file: string, side: ReviewSide, line: number): string => `review-line-${encodeURIComponent(file)}-${side}-${line}`;

/** The agents a peer review can be asked of: ones that read mail, running or not, other than the author. */
export function peerCandidates(agents: readonly AgentView[], author: string): AgentView[] {
  return agents.filter((a) => a.name !== author && providerInfo(a.provider).mcp);
}

/** Why the three actions cannot run now, or null. The server judges again. */
export function actionProblems(author: AgentView | undefined, counts: Counts): { send: string | null; walkthrough: string | null; peer: string | null } {
  const mail = author === undefined ? 'That console is gone.' : !providerInfo(author.provider).mcp ? `${author.name} has no gonogo tools, so it cannot read mail.` : null;
  return {
    send: mail ?? (counts.toSend === 0 ? 'No open note of yours is waiting to be sent.' : null),
    walkthrough: mail,
    peer: mail,
  };
}

/** A note form checked before it is sent. */
export function noteProblem(summary: string): string | null {
  const text = summary.trim();
  if (text === '') return 'Write what you want to say, on one line.';
  if (text.length > REVIEW_SUMMARY_MAX_CHARS) return `At most ${REVIEW_SUMMARY_MAX_CHARS} characters; put the rest in the reason.`;
  return null;
}

export interface NoteValues {
  summary: string;
  rationale: string;
  tone: ReviewTone;
}
export const emptyNote = (): NoteValues => ({ summary: '', rationale: '', tone: 'info' });

/** The body of POST .../review/notes for a note on a line, or for a reply. */
export function noteRequest(values: NoteValues, place: { file: string; side: ReviewSide; line: number } | { replyTo: string }): ReviewNoteRequest {
  const rationale = values.rationale.trim();
  return { ...place, summary: values.summary.trim(), ...(rationale === '' ? {} : { rationale }), tone: values.tone };
}

/** What the page says after an action. */
export const sentText = (sent: number, to: string): string => `${sent} ${sent === 1 ? 'note' : 'notes'} sent to ${to}.`;
