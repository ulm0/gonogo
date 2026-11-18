/**
 * Post-Flight Review (docs/review-spec.md): notes on the lines of one agent's diff, written by the Director or by agents, kept in
 * <home>/agents/<name>/review.json, and the three messages the Director sends from the Recorder (SEND NOTES, ASK WALKTHROUGH,
 * PEER REVIEW). The diff is `git diff HEAD` of the agent's folder (its Clean Room or worktree), read through the Recorder; a
 * note keeps the text of the line it was made on, and when that line is not in the diff any more, or says something else, the
 * note is marked outdated and kept. Everything is native: no external program, no broker.
 *
 * Who may do what: the Director everything. An agent may read the diff and the notes of its own folder, and add notes to it
 * (its self-walkthrough); another agent may too, once the Director asked it to review that diff (PEER REVIEW), and never
 * before. A text an agent writes is data: it is cut, put on one line and never run.
 *
 * shortcut: every call reads and writes the small file again (at most REVIEW_NOTES_MAX notes), one write at a time for each agent.
 * shortcut: untracked files have no diff until they are staged, as in the Recorder.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { textAt } from '../shared/diff.js';
import {
  AGENT_NAME_PATTERN,
  BODY_MAX_CHARS,
  REVIEW_AGENTS_MAX,
  REVIEW_BATCH_MAX,
  REVIEW_NOTES_MAX,
  REVIEW_RATIONALE_MAX_CHARS,
  REVIEW_SIDES,
  REVIEW_STATUSES,
  REVIEW_SUMMARY_MAX_CHARS,
  REVIEW_TONES,
  SUBJECT_MAX_CHARS,
} from '../shared/protocol.js';
import type { AgentSendRequest, Logger, ReviewFileDiff, ReviewNote, ReviewNoteRequest, ReviewSent, ReviewSide, ReviewStatus, ReviewTone, ReviewView, SendResult } from '../shared/protocol.js';
import { parseDiff } from '../shared/diff.js';
import { AGENTS_DIR, DIR_MODE, FILE_MODE } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';
import { UNSAFE_IN_NAME } from './schedules.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const ID_RE = /^n[1-9]\d{0,5}$/;
const REVIEW_FILE = 'review.json';
const NOTE_FIELDS = ['file', 'side', 'line', 'summary', 'rationale', 'tone', 'replyTo'];
/** The longest path and line number a note may name. */
const PATH_MAX = 1000;
const LINE_MAX = 10_000_000;

/** Who writes a note: the Director (the browser) or an agent, by the name of its token. */
export type ReviewActor = { kind: 'user' } | { kind: 'agent'; name: string };

export interface ReviewOptions {
  /** gonogo's home: the notes of an agent are in <dir>/agents/<name>/review.json. */
  dir: string;
  now(): number;
  /** Is this an agent of the room, and can it read mail (a console with the gonogo tools)? Null for a name that is not in the room. */
  agent(name: string): { mailable: boolean } | null;
  /** `git diff HEAD` of the agent's folder. Throws a HubError (conflict) when the folder is not a repository. */
  diff(name: string): Promise<{ diff: string; truncated: boolean }>;
  /** Hub.sendFromUser: the Director's messages. */
  send(request: AgentSendRequest): SendResult;
  log: Logger;
}

export interface Review {
  /** The diff and the notes, for the Director or for the tool of an agent that is allowed to see them. */
  view(name: string, as?: ReviewActor): Promise<ReviewView>;
  /** The Director adds one note (or a reply). A bad one throws a HubError (bad_request, field). */
  addNote(actor: ReviewActor, name: string, input: unknown): Promise<ReviewNote>;
  /** An agent adds up to REVIEW_BATCH_MAX notes: each good one is kept, each bad one is named by its index. */
  addNotes(actor: ReviewActor, name: string, inputs: unknown): Promise<{ added: ReviewNote[]; rejected: Array<{ index: number; error: string }> }>;
  /** The Director resolves or reopens a note. */
  update(name: string, id: string, input: unknown): Promise<ReviewNote>;
  remove(name: string, id: string): Promise<void>;
  /** The open notes of the Director that were not sent yet, to the author, as one message. */
  send(name: string): Promise<ReviewSent>;
  /** Asks the author to annotate its own diff. */
  walkthrough(name: string): Promise<ReviewSent>;
  /** Asks another agent to review the diff of `name`, and lets it read the diff and write notes on it. */
  peer(name: string, reviewer: unknown): Promise<ReviewSent>;
  close(): Promise<void>;
}

interface Stored {
  id: string;
  file: string;
  side: ReviewSide;
  line: number;
  /** The text of the line when the note was made: what \`outdated\` compares with. */
  anchor: string;
  summary: string;
  rationale?: string;
  author: string;
  tone: ReviewTone;
  status: ReviewStatus;
  replyTo: string | null;
  at: number;
  sentAt: number | null;
}
interface File {
  seq: number;
  notes: Stored[];
  reviewers: string[];
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Is the note's line still what it was? Unknown (a diff cut short that does not reach the line) is not outdated. */
export function isOutdated(note: Pick<Stored, 'file' | 'side' | 'line' | 'anchor'>, files: readonly ReviewFileDiff[], truncated: boolean): boolean {
  const now = textAt(files, note.file, note.side, note.line);
  if (now === null) return !truncated;
  return now !== note.anchor;
}

/* ---- the three messages: the format is part of the feature, so it is exported and tested ---- */

const MORE_ROOM = 400;

/** The Director's open notes as one message: `file:line (side) [tone] summary`, then the reason. */
export function notesMessage(agent: string, notes: ReadonlyArray<Pick<ReviewNote, 'id' | 'file' | 'side' | 'line' | 'tone' | 'summary' | 'rationale'>>): { subject: string; body: string } {
  const head = 'The Director left notes on your changes. Read them with review_read, answer each with review_note (replyTo is its id), fix what is right, and tell the Director what you did.';
  const lines: string[] = [];
  let used = head.length + MORE_ROOM;
  let shown = 0;
  for (const n of notes) {
    const text = `- ${n.id} ${n.file}:${n.line} (${n.side}) [${n.tone}] ${n.summary}${n.rationale === undefined ? '' : `\n  Why: ${n.rationale}`}`;
    if (used + text.length > BODY_MAX_CHARS) break;
    lines.push(text);
    used += text.length + 1;
    shown += 1;
  }
  const rest = notes.length - shown;
  const body = [head, '', ...lines, ...(rest > 0 ? ['', `...and ${rest} more: read them with review_read(agent: "${agent}").`] : [])].join('\n');
  return { subject: cut(`Review: ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} on your diff`, SUBJECT_MAX_CHARS), body };
}

export function walkthroughMessage(agent: string): { subject: string; body: string } {
  return {
    subject: 'Review: walk through your diff',
    body: `The Director asks you to annotate your own changes before they are reviewed. Read the diff with review_read(agent: "${agent}"), then add notes with review_note: one note on the line where each meaningful change starts, a short summary of what it does, and in rationale why. Use tone "info" for explanations and "warning" for what you are unsure of. Add all of them in one or two calls, then tell the Director you are done.`,
  };
}

export function peerMessage(agent: string, reviewer: string): { subject: string; body: string } {
  return {
    subject: cut(`Review: peer review of ${agent}'s diff`, SUBJECT_MAX_CHARS),
    body: `${reviewer}, the Director asks you to review the uncommitted changes of ${agent}. Read them with review_read(agent: "${agent}"), then add notes with review_note(agent: "${agent}"): tone "error" for a bug, "warning" for a risk or a missing test, "info" for a question, each on the line it is about, with a one-line summary and the reason in rationale. Do not change ${agent}'s files. Tell the Director when you are done.`,
  };
}

export function createReview(options: ReviewOptions): Review {
  const { dir, now, log } = options;
  /** Writes of one agent go one after the other. */
  const chains = new Map<string, Promise<unknown>>();

  const folder = (name: string): string => join(dir, AGENTS_DIR, name);
  const path = (name: string): string => join(folder(name), REVIEW_FILE);

  function checkName(name: string): void {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HubError('not_found', 'unknown agent');
  }

  async function read(name: string): Promise<File> {
    try {
      const saved: unknown = JSON.parse(await readFile(path(name), 'utf8'));
      if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.notes)) throw new Error('not a version 1 review file');
      const notes = saved.notes.flatMap((raw): Stored[] => {
        const note = storedFrom(raw);
        return note === null ? [] : [note];
      });
      const seq = typeof saved.seq === 'number' && Number.isSafeInteger(saved.seq) ? saved.seq : 0;
      const reviewers = Array.isArray(saved.reviewers) ? saved.reviewers.filter((r): r is string => typeof r === 'string' && NAME_RE.test(r)).slice(0, REVIEW_AGENTS_MAX) : [];
      return { seq: Math.max(seq, ...notes.map((n) => Number(n.id.slice(1)))), notes, reviewers };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { seq: 0, notes: [], reviewers: [] };
      // kept aside, so that the next write cannot overwrite the notes
      log.error(`${REVIEW_FILE} of ${name} could not be read; it starts empty and the file is kept as ${REVIEW_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
      await rename(path(name), `${path(name)}.bad`).catch(() => undefined);
      return { seq: 0, notes: [], reviewers: [] };
    }
  }

  async function write(name: string, file: File): Promise<void> {
    await mkdir(folder(name), { recursive: true, mode: DIR_MODE });
    const temp = join(folder(name), `.${REVIEW_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temp, JSON.stringify({ version: 1, seq: file.seq, reviewers: file.reviewers, notes: file.notes }, null, 2), { mode: FILE_MODE, flag: 'wx' });
    await rename(temp, path(name));
  }

  /** One change of an agent's file at a time: read, change, write. */
  function change<T>(name: string, work: (file: File) => T | Promise<T>): Promise<T> {
    const run = (chains.get(name) ?? Promise.resolve()).then(async () => {
      const file = await read(name);
      const result = await work(file);
      await write(name, file);
      return result;
    });
    chains.set(name, run.catch(() => undefined));
    return run;
  }

  const target = (name: string): { mailable: boolean } => {
    checkName(name);
    const found = options.agent(name);
    if (found === null) throw new HubError('not_found', 'unknown agent');
    return found;
  };

  async function readDiff(name: string): Promise<{ files: ReviewFileDiff[]; truncated: boolean; problem: string | null }> {
    try {
      const { diff, truncated } = await options.diff(name);
      return { files: parseDiff(diff), truncated, problem: null };
    } catch (error) {
      if (error instanceof HubError && error.code === 'conflict') return { files: [], truncated: false, problem: error.message };
      throw error;
    }
  }

  /** An agent may see and annotate the diff of its own folder, and of another's once the Director asked it to review it. */
  function mayReview(actor: ReviewActor, name: string, file: File): boolean {
    return actor.kind === 'user' || actor.name === name || file.reviewers.includes(actor.name);
  }

  function viewOf(file: File, diff: { files: ReviewFileDiff[]; truncated: boolean }): ReviewNote[] {
    return file.notes.map((n) => ({
      id: n.id,
      file: n.file,
      side: n.side,
      line: n.line,
      summary: n.summary,
      ...(n.rationale === undefined ? {} : { rationale: n.rationale }),
      author: n.author,
      tone: n.tone,
      status: n.status,
      replyTo: n.replyTo,
      at: n.at,
      sentAt: n.sentAt,
      outdated: isOutdated(n, diff.files, diff.truncated),
    }));
  }

  /** One request checked, and anchored on the diff: a note names a line that is in it, a reply takes its parent's line. */
  function toStored(actor: ReviewActor, input: unknown, file: File, diff: { files: ReviewFileDiff[] }, at: number): Stored {
    if (!isRecord(input)) throw bad('a note must be a JSON object');
    for (const key of Object.keys(input)) if (!NOTE_FIELDS.includes(key)) throw bad(`unknown field "${key}"`, key);
    const summary = typeof input.summary === 'string' ? oneLine(input.summary) : '';
    if (summary === '' || summary.length > REVIEW_SUMMARY_MAX_CHARS || UNSAFE_IN_NAME.test(summary)) throw bad(`summary must be 1 to ${REVIEW_SUMMARY_MAX_CHARS} characters on one line`, 'summary');
    let rationale: string | undefined;
    if (input.rationale !== undefined) {
      if (typeof input.rationale !== 'string' || input.rationale.length > REVIEW_RATIONALE_MAX_CHARS) throw bad(`rationale must be text of at most ${REVIEW_RATIONALE_MAX_CHARS} characters`, 'rationale');
      // line breaks stay (a reason may have a few), the rest of the control characters do not
      rationale = input.rationale.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim() || undefined;
    }
    const tone = input.tone === undefined ? 'info' : input.tone;
    if (typeof tone !== 'string' || !(REVIEW_TONES as readonly string[]).includes(tone)) throw bad(`tone must be one of: ${REVIEW_TONES.join(', ')}`, 'tone');
    const author = actor.kind === 'user' ? 'user' : actor.name;
    const common = { summary, ...(rationale === undefined ? {} : { rationale }), author, tone: tone as ReviewTone, status: 'open' as const, at, sentAt: null };
    if (file.notes.length >= REVIEW_NOTES_MAX) throw new HubError('conflict', `at most ${REVIEW_NOTES_MAX} notes on one diff: resolve and remove some first`, 'notes');
    const id = `n${file.seq + 1}`;
    if (input.replyTo !== undefined) {
      if (typeof input.replyTo !== 'string' || !ID_RE.test(input.replyTo)) throw bad('replyTo must be the id of a note', 'replyTo');
      const parent = file.notes.find((n) => n.id === input.replyTo);
      if (parent === undefined) throw bad('replyTo names no note of this diff', 'replyTo');
      if (input.file !== undefined || input.side !== undefined || input.line !== undefined) throw bad('a reply sits on the line of the note it answers: leave out file, side and line', 'replyTo');
      return { id, file: parent.file, side: parent.side, line: parent.line, anchor: parent.anchor, replyTo: parent.id, ...common };
    }
    if (typeof input.file !== 'string' || input.file === '' || input.file.length > PATH_MAX) throw bad('file must be a path of the diff', 'file');
    if (typeof input.side !== 'string' || !(REVIEW_SIDES as readonly string[]).includes(input.side)) throw bad(`side must be one of: ${REVIEW_SIDES.join(', ')}`, 'side');
    if (typeof input.line !== 'number' || !Number.isSafeInteger(input.line) || input.line < 1 || input.line > LINE_MAX) throw bad('line must be a whole number from 1', 'line');
    const anchor = textAt(diff.files, input.file, input.side as ReviewSide, input.line);
    if (anchor === null) throw bad(`${input.file}:${input.line} (${input.side}) is not a line of the diff: a note is on a line the diff shows`, 'line');
    return { id, file: input.file, side: input.side as ReviewSide, line: input.line, anchor: anchor.slice(0, 2000), replyTo: null, ...common };
  }

  function sent(result: SendResult): string {
    if (!result.ok) throw new HubError('conflict', result.note ?? `${result.to} could not be reached`, 'agent');
    return result.id;
  }

  const mailable = (name: string): void => {
    if (!target(name).mailable) throw new HubError('conflict', `${name} cannot read mail: its engine has no gonogo tools`, 'agent');
  };

  return {
    async view(name, as = { kind: 'user' }) {
      target(name);
      const file = await read(name);
      if (!mayReview(as, name, file)) throw new HubError('forbidden', 'only the author, or an agent the Director asked to review this diff, may read it');
      const diff = await readDiff(name);
      if (diff.problem !== null) return { repo: false, reason: diff.problem, files: [], truncated: false, notes: viewOf(file, { files: [], truncated: true }), reviewers: [...file.reviewers] };
      return { repo: true, files: diff.files, truncated: diff.truncated, notes: viewOf(file, diff), reviewers: [...file.reviewers] };
    },

    async addNote(actor, name, input) {
      target(name);
      const diff = await readDiff(name);
      if (diff.problem !== null) throw new HubError('conflict', diff.problem);
      return change(name, (file) => {
        if (!mayReview(actor, name, file)) throw new HubError('forbidden', 'only the author, or an agent the Director asked to review this diff, may add notes');
        const stored = toStored(actor, input, file, diff, now());
        file.seq += 1;
        file.notes.push(stored);
        return viewOf({ ...file, notes: [stored] }, diff)[0] as ReviewNote;
      });
    },

    async addNotes(actor, name, inputs) {
      target(name);
      if (!Array.isArray(inputs) || inputs.length === 0) throw bad('notes must be a list of at least one note', 'notes');
      if (inputs.length > REVIEW_BATCH_MAX) throw bad(`at most ${REVIEW_BATCH_MAX} notes in one call`, 'notes');
      const diff = await readDiff(name);
      if (diff.problem !== null) throw new HubError('conflict', diff.problem);
      return change(name, (file) => {
        if (!mayReview(actor, name, file)) throw new HubError('forbidden', 'only the author, or an agent the Director asked to review this diff, may add notes');
        const added: ReviewNote[] = [];
        const rejected: Array<{ index: number; error: string }> = [];
        inputs.forEach((input: unknown, index) => {
          try {
            const stored = toStored(actor, input, file, diff, now());
            file.seq += 1;
            file.notes.push(stored);
            added.push(viewOf({ ...file, notes: [stored] }, diff)[0] as ReviewNote);
          } catch (error) {
            if (!(error instanceof HubError)) throw error;
            rejected.push({ index, error: error.message });
          }
        });
        return { added, rejected };
      });
    },

    async update(name, id, input) {
      target(name);
      if (!isRecord(input) || Object.keys(input).some((k) => k !== 'status')) throw bad('give a status: open or resolved', 'status');
      if (typeof input.status !== 'string' || !(REVIEW_STATUSES as readonly string[]).includes(input.status)) throw bad(`status must be one of: ${REVIEW_STATUSES.join(', ')}`, 'status');
      const status = input.status as ReviewStatus;
      const diff = await readDiff(name);
      return change(name, (file) => {
        const note = ID_RE.test(id) ? file.notes.find((n) => n.id === id) : undefined;
        if (note === undefined) throw new HubError('not_found', 'unknown note');
        note.status = status;
        return viewOf({ ...file, notes: [note] }, diff)[0] as ReviewNote;
      });
    },

    async remove(name, id) {
      target(name);
      await change(name, (file) => {
        const note = ID_RE.test(id) ? file.notes.find((n) => n.id === id) : undefined;
        if (note === undefined) throw new HubError('not_found', 'unknown note');
        // a note goes with the replies to it
        const gone = new Set([note.id, ...file.notes.filter((n) => n.replyTo === note.id).map((n) => n.id)]);
        file.notes = file.notes.filter((n) => !gone.has(n.id));
      });
    },

    async send(name) {
      mailable(name);
      return change(name, (file) => {
        const todo = file.notes.filter((n) => n.author === 'user' && n.status === 'open' && n.sentAt === null);
        if (todo.length === 0) throw new HubError('conflict', 'no open note of yours is waiting to be sent', 'notes');
        const { subject, body } = notesMessage(name, todo);
        const message = sent(options.send({ to: name, subject, body }));
        const at = now();
        for (const n of todo) n.sentAt = at;
        return { sent: todo.length, message };
      });
    },

    async walkthrough(name) {
      mailable(name);
      const { subject, body } = walkthroughMessage(name);
      return { sent: 0, message: sent(options.send({ to: name, subject, body })) };
    },

    async peer(name, reviewer) {
      mailable(name);
      if (typeof reviewer !== 'string' || !NAME_RE.test(reviewer)) throw bad('reviewer must be the name of an agent', 'reviewer');
      if (reviewer === name) throw bad('an agent does not peer-review itself: use ASK WALKTHROUGH', 'reviewer');
      mailable(reviewer);
      const { subject, body } = peerMessage(name, reviewer);
      return change(name, (file) => {
        // the message first: a reviewer that cannot be reached gets no right to the diff
        const message = sent(options.send({ to: reviewer, subject, body }));
        if (!file.reviewers.includes(reviewer)) {
          if (file.reviewers.length >= REVIEW_AGENTS_MAX) throw new HubError('conflict', `at most ${REVIEW_AGENTS_MAX} reviewers for one diff`, 'reviewer');
          file.reviewers.push(reviewer);
        }
        return { sent: 0, message };
      });
    },

    close() {
      return Promise.all([...chains.values()]).then(() => undefined);
    },
  };
}

/** A saved note read back; one that is not a note is skipped. */
function storedFrom(raw: unknown): Stored | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  const { file, side, line, anchor, summary, rationale, author, tone, status, replyTo, at, sentAt } = raw;
  if (typeof file !== 'string' || file === '' || !(REVIEW_SIDES as readonly unknown[]).includes(side) || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return null;
  if (typeof summary !== 'string' || summary === '' || typeof author !== 'string') return null;
  return {
    id: raw.id,
    file,
    side: side as ReviewSide,
    line,
    anchor: typeof anchor === 'string' ? anchor : '',
    summary: summary.slice(0, REVIEW_SUMMARY_MAX_CHARS),
    ...(typeof rationale === 'string' && rationale !== '' ? { rationale: rationale.slice(0, REVIEW_RATIONALE_MAX_CHARS) } : {}),
    author: author === 'user' || NAME_RE.test(author) ? author : 'user',
    tone: (REVIEW_TONES as readonly unknown[]).includes(tone) ? (tone as ReviewTone) : 'info',
    status: status === 'resolved' ? 'resolved' : 'open',
    replyTo: typeof replyTo === 'string' && ID_RE.test(replyTo) ? replyTo : null,
    at: typeof at === 'number' ? at : 0,
    sentAt: typeof sentAt === 'number' ? sentAt : null,
  };
}
