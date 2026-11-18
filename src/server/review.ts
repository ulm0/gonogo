/**
 * Post-Flight Review (docs/review-spec.md): notes on the lines of one agent's diff, the Director's verdict on it, and the mail that
 * carries both to the agent. The diff is `git diff HEAD` of the agent's folder (its Clean Room or worktree), read through the
 * Recorder. Everything is native: no external program, no broker.
 *
 * The notes are in <home>/reviews.json, never under agents/<name>/: a Clean Room mounts that folder writable, so a file there
 * could be forged by the agent it is about. A note keeps the text of its line, copied by the server from the diff, and at every
 * read is located again (exact, moved, outdated): nothing about that is stored.
 *
 * Who may do what. The Director: everything, over the browser routes. An agent reads and annotates its own diff; the notes it
 * writes there are its walkthrough. Another agent reads and annotates a diff only while a peer request from the Director is
 * pending for it (PEER REVIEW; it ends after 24 hours or when that agent sends its notes). No tool changes a verdict, resolves or
 * deletes: closing a discussion is the Director's. A reply by the reviewed agent marks the note it answers as addressed.
 *
 * shortcut: every call reads and writes the one file again (at most REVIEW_NOTES_MAX notes for each agent), one write at a time.
 * shortcut: notes name the agent, so a renamed agent leaves its notes under the old name, as a task keeps its assignee.
 * shortcut: untracked files have no diff until they are staged, as in the Recorder.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { locate, parseDiff, textAt } from '../shared/diff.js';
import {
  AGENT_NAME_PATTERN,
  REVIEW_BATCH_MAX,
  REVIEW_BODY_MAX_CHARS,
  REVIEW_MAIL_MAX_CHARS,
  REVIEW_NOTES_MAX,
  REVIEW_PATCH_MAX_BYTES,
  REVIEW_REQUEST_TTL_MS,
  REVIEW_SIDES,
  REVIEW_STATUSES,
  REVIEW_TEXT_MAX_CHARS,
  REVIEW_TONES,
  REVIEW_VERDICTS,
  SUBJECT_MAX_CHARS,
} from '../shared/protocol.js';
import type {
  AgentSendRequest,
  DownlinkNotify,
  Logger,
  ReviewFileDiff,
  ReviewNote,
  ReviewSent,
  ReviewSide,
  ReviewStatus,
  ReviewTone,
  ReviewVerdict,
  ReviewVerdictKind,
  ReviewView,
  SendResult,
} from '../shared/protocol.js';
import { FILE_MODE } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const ID_RE = /^rn[1-9]\d{0,5}$/;
const REVIEWS_FILE = 'reviews.json';
const NOTE_FIELDS = ['path', 'side', 'line', 'body', 'tone', 'replyTo'];
const PATH_MAX = 1000;
const LINE_MAX = 10_000_000;
const SUMMARY_MAX = 500;

/** Who writes a note: the Director (the browser) or an agent, by the name of its token. */
export type ReviewActor = { kind: 'user' } | { kind: 'agent'; name: string };

export interface ReviewOptions {
  /** gonogo's home: the notes are in <dir>/reviews.json. */
  dir: string;
  now(): number;
  /** Is this an agent of the room, and can it read mail (a console with the gonogo tools)? Null for a name that is not in the room. */
  agent(name: string): { mailable: boolean } | null;
  /** `git diff HEAD` of the agent's folder. Throws a HubError (conflict) when the folder is not a repository. */
  diff(name: string): Promise<{ diff: string; truncated: boolean }>;
  /** Hub.sendFromUser: the Director's messages. */
  send(request: AgentSendRequest): SendResult;
  /** Downlink: an agent added notes or replied. */
  notify?: DownlinkNotify;
  log: Logger;
}

export interface Review {
  /** The diff, the notes (with where each is now) and the verdict, for the Director. */
  view(name: string): Promise<ReviewView>;
  /** The same for an agent that may see this diff (`patch`: the raw patch too, of `path` when given, cut at 100 KiB). */
  read(name: string, as: ReviewActor, options?: { patch?: boolean; path?: unknown }): Promise<{ view: ReviewView; patch?: string; patchTruncated?: boolean }>;
  /** The Director adds a note or a reply. A bad one throws a HubError (bad_request, field). */
  addNote(actor: ReviewActor, name: string, input: unknown): Promise<ReviewNote>;
  /** An agent adds up to REVIEW_BATCH_MAX notes: all of them, or none (the first bad one is named). */
  addNotes(actor: ReviewActor, name: string, inputs: unknown): Promise<ReviewNote[]>;
  /** The Director sets a status or rewrites the body. */
  update(name: string, id: string, input: unknown): Promise<ReviewNote>;
  /** The Director deletes a note and its replies. */
  remove(name: string, id: string): Promise<void>;
  /** APPROVE, or REQUEST CHANGES (the open notes go to the author as one message). The verdict is stored with the hash of this diff. */
  verdict(name: string, input: unknown): Promise<ReviewSent & { verdict: ReviewVerdict }>;
  /** ASK WALKTHROUGH (the author explains its own diff) or PEER REVIEW (another agent reviews it, and may read and annotate it). */
  ask(name: string, input: unknown): Promise<ReviewSent>;
  close(): Promise<void>;
}

interface Request {
  agent: string;
  reviewer: string;
  at: number;
}
interface Stored {
  notes: StoredNote[];
  verdicts: Record<string, ReviewVerdict>;
  requests: Request[];
  seq: number;
}
type StoredNote = Omit<ReviewNote, 'place'>;

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const hashOf = (diff: string): string => createHash('sha256').update(diff).digest('hex').slice(0, 16);

/** A path of the diff: relative to the Recorder's root, no `..`, no `.git` (the diff would never name one, and a note must not either). */
function pathProblem(path: string): boolean {
  return path === '' || path.length > PATH_MAX || path.startsWith('/') || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '.git');
}

/* ---- the mail: the format is part of the feature, so it is exported and tested ---- */

type Mailed = Pick<ReviewNote, 'path' | 'line' | 'tone' | 'body' | 'author'>;

/** REQUEST CHANGES: each open note as `path:line [tone] text`, an agent's own note under its name, cut with "and K more: call review_read". */
export function changesMessage(agent: string, notes: readonly Mailed[], summary?: string): { subject: string; body: string } {
  const head = `${summary === undefined || summary === '' ? '' : `The Director says: ${summary}\n\n`}The Director asks for changes. Fix what is right, answer each note with review_note (replyTo is its id; read them with review_read), and tell the Director when you are done.`;
  const lines: string[] = [];
  let used = head.length + 120;
  for (const n of notes) {
    const text = `- ${n.path}:${n.line} [${n.tone ?? 'info'}] ${n.author === 'user' ? '' : `(${n.author}) `}${cut(oneLine(n.body), 400)}`;
    if (used + text.length > REVIEW_MAIL_MAX_CHARS) break;
    lines.push(text);
    used += text.length + 1;
  }
  const rest = notes.length - lines.length;
  const body = [head, '', ...lines, ...(rest > 0 ? ['', `...and ${rest} more: call review_read(agent: "${agent}").`] : [])].join('\n');
  return { subject: cut(`Review: changes requested (${notes.length} open ${notes.length === 1 ? 'note' : 'notes'})`, SUBJECT_MAX_CHARS), body };
}

export function approvedMessage(summary?: string): { subject: string; body: string } {
  return { subject: 'Review: approved', body: `${summary === undefined || summary === '' ? '' : `${summary}\n\n`}The Director approved your changes as they are now.` };
}

export function walkthroughMessage(agent: string): { subject: string; body: string } {
  return {
    subject: 'Review: walk through your diff',
    body: `The Director asks you to explain your own changes before they are reviewed. Read the diff with review_read(agent: "${agent}"; add patch: true for the lines), then add notes with review_note: one on the line where each meaningful change starts, saying what it does and why (tone "info"), and "warning" on what you are unsure of. Add them in one call, then tell the Director you are done.`,
  };
}

export function peerMessage(agent: string, reviewer: string): { subject: string; body: string } {
  return {
    subject: cut(`Review: peer review of ${agent}'s diff`, SUBJECT_MAX_CHARS),
    body: `${reviewer}, the Director asks you to review the uncommitted changes of ${agent}. Read them with review_read(agent: "${agent}", patch: true), then send your notes in one review_note call (agent: "${agent}"): tone "error" for a bug, "warning" for a risk or a missing test, "info" for a question, each on the line it is about. Your right to read and note this diff ends when you send them. Do not change ${agent}'s files. Tell the Director when you are done.`,
  };
}

/* ---- the store ---- */

export function createReview(options: ReviewOptions): Review {
  const { dir, now, log } = options;
  const path = join(dir, REVIEWS_FILE);
  let chain: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Stored> {
    try {
      const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.notes)) throw new Error('not a version 1 reviews file');
      const notes = saved.notes.flatMap((raw): StoredNote[] => {
        const note = noteFrom(raw);
        return note === null ? [] : [note];
      });
      const verdicts: Record<string, ReviewVerdict> = {};
      if (isRecord(saved.verdicts)) {
        for (const [agent, raw] of Object.entries(saved.verdicts)) {
          const v = verdictFrom(raw);
          if (v !== null && NAME_RE.test(agent)) verdicts[agent] = v;
        }
      }
      const requests = Array.isArray(saved.requests)
        ? saved.requests.flatMap((r): Request[] => (isRecord(r) && typeof r.agent === 'string' && typeof r.reviewer === 'string' && typeof r.at === 'number' && NAME_RE.test(r.agent) && NAME_RE.test(r.reviewer) ? [{ agent: r.agent, reviewer: r.reviewer, at: r.at }] : []))
        : [];
      const seq = typeof saved.seq === 'number' && Number.isSafeInteger(saved.seq) ? saved.seq : 0;
      return { notes, verdicts, requests, seq: Math.max(seq, 0, ...notes.map((n) => Number(n.id.slice(2)))) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { notes: [], verdicts: {}, requests: [], seq: 0 };
      // kept aside, so that the next write cannot overwrite the notes
      log.error(`${REVIEWS_FILE} could not be read; reviews start empty and the file is kept as ${REVIEWS_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
      await rename(path, `${path}.bad`).catch(() => undefined);
      return { notes: [], verdicts: {}, requests: [], seq: 0 };
    }
  }

  async function write(data: Stored): Promise<void> {
    const temp = join(dir, `.${REVIEWS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temp, JSON.stringify({ version: 1, seq: data.seq, notes: data.notes, verdicts: data.verdicts, requests: data.requests }, null, 2), { mode: FILE_MODE, flag: 'wx' });
    await rename(temp, path);
  }

  /** One change at a time: read, change, write. A change that throws writes nothing. */
  function change<T>(work: (data: Stored) => T | Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const data = await read();
      pruneRequests(data, now());
      const result = await work(data);
      await write(data);
      return result;
    });
    chain = run.catch(() => undefined);
    return run;
  }

  const pruneRequests = (data: Stored, at: number): void => {
    data.requests = data.requests.filter((r) => at - r.at < REVIEW_REQUEST_TTL_MS);
  };

  function target(name: string): { mailable: boolean } {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HubError('not_found', 'unknown agent');
    const found = options.agent(name);
    if (found === null) throw new HubError('not_found', 'unknown agent');
    return found;
  }

  const mailable = (name: string): void => {
    if (!target(name).mailable) throw new HubError('conflict', `${name} cannot read mail: its engine has no gonogo tools`, 'agent');
  };

  async function readDiff(name: string): Promise<{ files: ReviewFileDiff[]; truncated: boolean; diff: string; problem: string | null }> {
    try {
      const { diff, truncated } = await options.diff(name);
      return { files: parseDiff(diff), truncated, diff, problem: null };
    } catch (error) {
      if (error instanceof HubError && error.code === 'conflict') return { files: [], truncated: false, diff: '', problem: error.message };
      throw error;
    }
  }

  /** An agent may see and annotate the diff of its own folder, and another's only while the Director's request to it is pending. */
  function mayReview(actor: ReviewActor, name: string, data: Stored): boolean {
    return actor.kind === 'user' || actor.name === name || data.requests.some((r) => r.agent === name && r.reviewer === actor.name);
  }
  const forbidden = (): HubError => new HubError('forbidden', 'only the author, or an agent the Director asked to review this diff, may do that');

  function viewOf(name: string, data: Stored, diff: { files: ReviewFileDiff[]; truncated: boolean; diff: string; problem: string | null }): ReviewView {
    const mine = data.notes.filter((n) => n.agent === name);
    const rank: Record<ReviewStatus, number> = { open: 0, addressed: 1, resolved: 2 };
    const root = (n: StoredNote): StoredNote => (n.replyTo === undefined ? n : (mine.find((m) => m.id === n.replyTo) ?? n));
    const places = new Map<string, ReturnType<typeof locate>>();
    for (const n of mine) if (n.replyTo === undefined) places.set(n.id, diff.problem !== null ? { state: 'unknown', line: n.line } : locate(n, diff.files, diff.truncated));
    // open first, then addressed, then resolved; a thread keeps together, in the order it was made
    const ordered = [...mine].sort((a, b) => rank[root(a).status] - rank[root(b).status] || Number(root(a).id.slice(2)) - Number(root(b).id.slice(2)) || Number(a.id.slice(2)) - Number(b.id.slice(2)));
    const hash = hashOf(diff.diff);
    const verdict = data.verdicts[name] ?? null;
    return {
      repo: diff.problem === null,
      ...(diff.problem === null ? {} : { reason: diff.problem }),
      files: diff.files,
      truncated: diff.truncated,
      diffHash: hash,
      notes: ordered.map((n) => ({ ...n, place: places.get(root(n).id) ?? { state: 'unknown', line: n.line } })),
      verdict,
      stale: verdict !== null && diff.problem === null && verdict.diffHash !== hash,
      asked: data.requests.filter((r) => r.agent === name).map((r) => r.reviewer),
    };
  }

  /** One request checked and anchored: a note names a line that is in the diff, a reply takes the place of the note it answers. */
  function toNote(actor: ReviewActor, name: string, input: unknown, data: Stored, files: readonly ReviewFileDiff[], at: number): StoredNote {
    if (!isRecord(input)) throw bad('a note must be a JSON object');
    for (const key of Object.keys(input)) if (!NOTE_FIELDS.includes(key)) throw bad(`unknown field "${key}"`, key);
    if (typeof input.body !== 'string') throw bad(`body must be text of 1 to ${REVIEW_BODY_MAX_CHARS} characters`, 'body');
    // line breaks stay (a note may have a few), the other control and bidi characters become spaces
    const body = input.body.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim();
    if (body === '' || body.length > REVIEW_BODY_MAX_CHARS) throw bad(`body must be text of 1 to ${REVIEW_BODY_MAX_CHARS} characters`, 'body');
    const author = actor.kind === 'user' ? 'user' : actor.name;
    const id = `rn${data.seq + 1}`;
    const base = { id, agent: name, body, author, createdAt: at, updatedAt: at };
    if (input.replyTo !== undefined) {
      if (typeof input.replyTo !== 'string' || !ID_RE.test(input.replyTo)) throw bad('replyTo must be the id of a note', 'replyTo');
      const parent = data.notes.find((n) => n.id === input.replyTo && n.agent === name);
      if (parent === undefined) throw bad('replyTo names no note of this diff', 'replyTo');
      for (const key of ['path', 'side', 'line']) if (input[key] !== undefined) throw bad('a reply sits on the line of the note it answers: leave out path, side and line', key);
      if (input.tone !== undefined) throw bad('a reply has no tone', 'tone');
      const rootId = parent.replyTo ?? parent.id;
      const root = data.notes.find((n) => n.id === rootId) ?? parent;
      return { ...base, path: root.path, side: root.side, line: root.line, text: root.text, replyTo: root.id, status: 'open' };
    }
    const tone = input.tone === undefined ? 'info' : input.tone;
    if (typeof tone !== 'string' || !(REVIEW_TONES as readonly string[]).includes(tone)) throw bad(`tone must be one of: ${REVIEW_TONES.join(', ')}`, 'tone');
    if (typeof input.path !== 'string' || pathProblem(input.path)) throw bad('path must be a file of the diff', 'path');
    if (typeof input.side !== 'string' || !(REVIEW_SIDES as readonly string[]).includes(input.side)) throw bad(`side must be one of: ${REVIEW_SIDES.join(', ')}`, 'side');
    if (typeof input.line !== 'number' || !Number.isSafeInteger(input.line) || input.line < 1 || input.line > LINE_MAX) throw bad('line must be a whole number from 1', 'line');
    const text = textAt(files, input.path, input.side as ReviewSide, input.line);
    if (text === null) throw bad(`${input.path}:${input.line} (${input.side}) is not in the diff: a note is on a line the diff shows`, 'line');
    // a note by the reviewed agent on its own diff is its walkthrough: it is not waiting for anybody
    const status: ReviewStatus = actor.kind === 'agent' && actor.name === name ? 'addressed' : 'open';
    return { ...base, path: input.path, side: input.side as ReviewSide, line: input.line, text: text.slice(0, REVIEW_TEXT_MAX_CHARS), tone: tone as ReviewTone, status };
  }

  /** Makes room for `count` more notes of one agent: resolved ones go first, oldest first, with their replies. */
  function room(data: Stored, name: string, count: number): void {
    const over = (): number => data.notes.filter((n) => n.agent === name).length + count - REVIEW_NOTES_MAX;
    while (over() > 0) {
      const gone = data.notes.filter((n) => n.agent === name && n.status === 'resolved' && n.replyTo === undefined).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (gone === undefined) throw new HubError('conflict', `at most ${REVIEW_NOTES_MAX} notes on one diff, and none is resolved: resolve or delete some first`, 'notes');
      data.notes = data.notes.filter((n) => n.id !== gone.id && n.replyTo !== gone.id);
    }
  }

  function sent(result: SendResult): string {
    if (!result.ok) throw new HubError('conflict', result.note ?? `${result.to} could not be reached`, 'agent');
    return result.id;
  }

  const placed = (n: StoredNote, view: ReviewView): ReviewNote => view.notes.find((x) => x.id === n.id) as ReviewNote;

  async function add(actor: ReviewActor, name: string, inputs: unknown[], batch: boolean): Promise<ReviewNote[]> {
    target(name);
    const diff = await readDiff(name);
    if (diff.problem !== null) throw new HubError('conflict', diff.problem);
    const made = await change((data) => {
      if (!mayReview(actor, name, data)) throw forbidden();
      room(data, name, inputs.length);
      const at = now();
      const out: StoredNote[] = [];
      inputs.forEach((input, index) => {
        let note: StoredNote;
        try {
          note = toNote(actor, name, input, data, diff.files, at);
        } catch (error) {
          // the whole batch or nothing: the first bad note is named
          if (error instanceof HubError && batch) throw new HubError(error.code, `note ${index + 1}: ${error.message}`, error.field);
          throw error;
        }
        data.seq += 1;
        data.notes.push(note);
        out.push(note);
        // a reply by the reviewed agent answers the note it replies to
        if (note.replyTo !== undefined && actor.kind === 'agent' && actor.name === name) {
          const parent = data.notes.find((n) => n.id === note.replyTo);
          if (parent !== undefined && parent.status === 'open') {
            parent.status = 'addressed';
            parent.updatedAt = at;
          }
        }
      });
      // a peer's right ends when it sends its notes
      if (actor.kind === 'agent' && actor.name !== name) data.requests = data.requests.filter((r) => !(r.agent === name && r.reviewer === actor.name));
      return { out, view: viewOf(name, data, diff) };
    });
    if (actor.kind === 'agent') options.notify?.('review', `${actor.name} added ${inputs.length} review ${inputs.length === 1 ? 'note' : 'notes'} on ${actor.name === name ? 'its own diff' : name}`);
    return made.out.map((n) => placed(n, made.view));
  }

  return {
    async view(name) {
      target(name);
      const diff = await readDiff(name);
      const data = await read();
      pruneRequests(data, now());
      return viewOf(name, data, diff);
    },

    async read(name, as, opts = {}) {
      target(name);
      const diff = await readDiff(name);
      const data = await read();
      pruneRequests(data, now());
      if (!mayReview(as, name, data)) throw forbidden();
      const view = viewOf(name, data, diff);
      if (opts.patch !== true) return { view };
      if (opts.path !== undefined && (typeof opts.path !== 'string' || pathProblem(opts.path))) throw bad('path must be a file of the diff', 'path');
      // the raw patch, of one file or of all: a diff is split at its "diff --git" lines
      const parts = diff.diff.split(/^(?=diff --git )/m).filter((p) => p !== '');
      const wanted = opts.path === undefined ? parts : parts.filter((p, i) => view.files[i]?.path === opts.path);
      const text = wanted.join('');
      const buffer = Buffer.from(text, 'utf8');
      return buffer.length > REVIEW_PATCH_MAX_BYTES ? { view, patch: buffer.subarray(0, REVIEW_PATCH_MAX_BYTES).toString('utf8'), patchTruncated: true } : { view, patch: text };
    },

    async addNote(actor, name, input) {
      const [note] = await add(actor, name, [input], false);
      return note as ReviewNote;
    },

    async addNotes(actor, name, inputs) {
      if (!Array.isArray(inputs) || inputs.length === 0) throw bad('notes must be a list of at least one note', 'notes');
      if (inputs.length > REVIEW_BATCH_MAX) throw bad(`at most ${REVIEW_BATCH_MAX} notes in one call`, 'notes');
      return add(actor, name, inputs as unknown[], true);
    },

    async update(name, id, input) {
      target(name);
      if (!isRecord(input) || Object.keys(input).length === 0) throw bad('give a status or a body');
      for (const key of Object.keys(input)) if (key !== 'status' && key !== 'body') throw bad(`unknown field "${key}"`, key);
      let status: ReviewStatus | undefined;
      if (input.status !== undefined) {
        if (typeof input.status !== 'string' || !(REVIEW_STATUSES as readonly string[]).includes(input.status)) throw bad(`status must be one of: ${REVIEW_STATUSES.join(', ')}`, 'status');
        status = input.status as ReviewStatus;
      }
      let body: string | undefined;
      if (input.body !== undefined) {
        body = typeof input.body === 'string' ? input.body.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim() : '';
        if (body === '' || body.length > REVIEW_BODY_MAX_CHARS) throw bad(`body must be text of 1 to ${REVIEW_BODY_MAX_CHARS} characters`, 'body');
      }
      const diff = await readDiff(name);
      const out = await change((data) => {
        const note = ID_RE.test(id) ? data.notes.find((n) => n.id === id && n.agent === name) : undefined;
        if (note === undefined) throw new HubError('not_found', 'unknown note');
        if (status !== undefined) note.status = status;
        if (body !== undefined) note.body = body;
        note.updatedAt = now();
        return { note, view: viewOf(name, data, diff) };
      });
      return placed(out.note, out.view);
    },

    async remove(name, id) {
      target(name);
      await change((data) => {
        const note = ID_RE.test(id) ? data.notes.find((n) => n.id === id && n.agent === name) : undefined;
        if (note === undefined) throw new HubError('not_found', 'unknown note');
        // a note goes with the replies to it
        data.notes = data.notes.filter((n) => n.id !== note.id && n.replyTo !== note.id);
      });
    },

    async verdict(name, input) {
      mailable(name);
      if (!isRecord(input)) throw bad('the body must be an object');
      for (const key of Object.keys(input)) if (key !== 'verdict' && key !== 'summary') throw bad(`unknown field "${key}"`, key);
      if (typeof input.verdict !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) throw bad(`verdict must be one of: ${REVIEW_VERDICTS.join(', ')}`, 'verdict');
      const kind = input.verdict as ReviewVerdictKind;
      let summary: string | undefined;
      if (input.summary !== undefined) {
        summary = typeof input.summary === 'string' ? oneLine(input.summary) : '';
        if (summary.length > SUMMARY_MAX) throw bad(`summary must be text of at most ${SUMMARY_MAX} characters`, 'summary');
      }
      const diff = await readDiff(name);
      if (diff.problem !== null) throw new HubError('conflict', diff.problem);
      return change((data) => {
        const open = data.notes.filter((n) => n.agent === name && n.replyTo === undefined && n.status === 'open');
        if (kind === 'changes' && open.length === 0) throw new HubError('conflict', 'no note is open: add a note first, then ask for changes', 'notes');
        const { subject, body } = kind === 'changes' ? changesMessage(name, open, summary) : approvedMessage(summary);
        const message = sent(options.send({ to: name, subject, body }));
        const verdict: ReviewVerdict = { verdict: kind, at: now(), diffHash: hashOf(diff.diff), by: 'user' };
        data.verdicts[name] = verdict;
        return { message, notes: kind === 'changes' ? open.length : 0, verdict };
      });
    },

    async ask(name, input) {
      mailable(name);
      if (!isRecord(input)) throw bad('the body must be an object');
      for (const key of Object.keys(input)) if (key !== 'kind' && key !== 'reviewer') throw bad(`unknown field "${key}"`, key);
      if (input.kind === 'walkthrough') {
        if (input.reviewer !== undefined) throw bad('a walkthrough is asked of the author: leave out reviewer', 'reviewer');
        const { subject, body } = walkthroughMessage(name);
        return { message: sent(options.send({ to: name, subject, body })), notes: 0 };
      }
      if (input.kind !== 'peer') throw bad('kind must be walkthrough or peer', 'kind');
      const reviewer = input.reviewer;
      if (typeof reviewer !== 'string' || !NAME_RE.test(reviewer)) throw bad('reviewer must be the name of an agent', 'reviewer');
      if (reviewer === name) throw bad('an agent does not peer-review itself: ask for a walkthrough', 'reviewer');
      mailable(reviewer);
      const { subject, body } = peerMessage(name, reviewer);
      return change((data) => {
        // the message first: a reviewer that cannot be reached gets no right to the diff
        const message = sent(options.send({ to: reviewer, subject, body }));
        data.requests = data.requests.filter((r) => !(r.agent === name && r.reviewer === reviewer));
        data.requests.push({ agent: name, reviewer, at: now() });
        return { message, notes: 0 };
      });
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}

/** A saved note read back; one that is not a note is skipped. */
function noteFrom(raw: unknown): StoredNote | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  const { agent, path, side, line, text, body, tone, author, replyTo, status, createdAt, updatedAt } = raw;
  if (typeof agent !== 'string' || !NAME_RE.test(agent) || typeof path !== 'string' || path === '' || pathProblem(path)) return null;
  if (!(REVIEW_SIDES as readonly unknown[]).includes(side) || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return null;
  if (typeof body !== 'string' || body === '' || typeof author !== 'string') return null;
  return {
    id: raw.id,
    agent,
    path,
    side: side as ReviewSide,
    line,
    text: typeof text === 'string' ? text.slice(0, REVIEW_TEXT_MAX_CHARS) : '',
    body: body.slice(0, REVIEW_BODY_MAX_CHARS),
    ...((REVIEW_TONES as readonly unknown[]).includes(tone) ? { tone: tone as ReviewTone } : {}),
    author: author === 'user' || NAME_RE.test(author) ? author : 'user',
    ...(typeof replyTo === 'string' && ID_RE.test(replyTo) ? { replyTo } : {}),
    status: (REVIEW_STATUSES as readonly unknown[]).includes(status) ? (status as ReviewStatus) : 'open',
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  };
}

function verdictFrom(raw: unknown): ReviewVerdict | null {
  if (!isRecord(raw) || !(REVIEW_VERDICTS as readonly unknown[]).includes(raw.verdict) || typeof raw.diffHash !== 'string' || typeof raw.at !== 'number') return null;
  return { verdict: raw.verdict as ReviewVerdictKind, at: raw.at, diffHash: raw.diffHash.slice(0, 64), by: 'user' };
}
