/**
 * Flight Plan: the task board (docs/flight-plan-spec.md).
 *
 * The Director (the browser) and every agent (the MCP tools task_list, task_create, task_update) change one list, kept in
 * tasks.json. The server stamps who did what: `createdBy`, and one history line per change. Assigning a task to an agent
 * sends that agent a message through the normal path: Hub.sendFromUser for the Director, Hub.sendFromAgent for an agent, so
 * the send limit, Redline, held mail and the hop limit apply. The clock and the send are injected for tests.
 *
 * shortcut: the whole list is in every frame and every snapshot; at the limits (500 open tasks with 4000-character details)
 * that nears the 4 MB socket buffer of web.ts. Send the details on demand if a board ever gets that big.
 * shortcut: `assignee` is an agent name, so a task does not follow a renamed console and keeps the name of a removed one;
 * key by record id if renames get common.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_NAME_PATTERN,
  STATION_NAME_PATTERN,
  SUBJECT_MAX_CHARS,
  TASK_DETAIL_MAX_CHARS,
  TASK_NOTE_MAX_CHARS,
  TASK_STATUSES,
  TASK_TITLE_MAX_CHARS,
  TASKS_OPEN_MAX,
  taskSubject,
} from '../shared/protocol.js';
import type { AgentSendRequest, DownlinkNotify, Logger, SendResult, Task, TaskStatus } from '../shared/protocol.js';
import { FILE_MODE, TASK_NOTES_MAX, TASKS_DONE_KEEP, TASKS_FILE } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';
import { UNSAFE_IN_NAME } from './schedules.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const STATION_RE = new RegExp(STATION_NAME_PATTERN);
const ID_RE = /^t[1-9]\d{0,5}$/;
const CREATE_FIELDS = ['title', 'detail', 'assignee'];
const PATCH_FIELDS = ['status', 'assignee', 'note'];

/**
 * Who changes the board: the Director, an agent with the generation of its token (the message of an assignment is sent as that
 * agent), or the Director of a docked station that handed a task over (the message is sent as "director@<station>").
 */
export type Actor = { kind: 'user' } | { kind: 'agent'; name: string; generation: number } | { kind: 'dock'; station: string };

export interface TasksOptions {
  /** gonogo's home: tasks.json lives here. */
  dir: string;
  now(): number;
  /** Is this the name of an agent in the room? */
  isAgent(name: string): boolean;
  /** Hub.sendFromUser or Hub.sendFromAgent: the message that tells an agent about its task. May throw a HubError. */
  send(actor: Actor, request: AgentSendRequest): SendResult;
  /** The whole list changed (a task made, changed or removed). */
  emit(tasks: Task[]): void;
  /** Downlink: an agent moved a task to blocked or review. */
  notify?: DownlinkNotify;
  log: Logger;
}

export interface Tasks {
  load(): Promise<void>;
  /** In the order the tasks were made. */
  list(): Task[];
  /** The input is a JSON value from the wire; a bad one throws a HubError (bad_request, field). */
  create(actor: Actor, input: unknown): Promise<Task>;
  /** Docking: the task was copied to `station`. It is done here, and says where it went. conflict when it is done or was handed off already. */
  handOff(id: string, station: string, assignee: string | null): Promise<Task>;
  /** A change that changes nothing answers with the task as it is and writes nothing. */
  update(actor: Actor, id: string, input: unknown): Promise<Task>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
const copy = (task: Task): Task => ({ ...task, notes: [...task.notes] });
const isOpen = (task: Task): boolean => task.status !== 'done';
/** "2026-11-17 14:03 UTC": a history line starts with it. */
const stamp = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const director = (actor: Actor): string => (actor.kind === 'dock' ? `Director of ${actor.station}` : 'Director');
const line = (actor: Actor, text: string, at: number): string => `${stamp(at)} ${actor.kind === 'agent' ? actor.name : director(actor)}: ${text}`;

interface Fields {
  title?: string;
  detail?: string;
  status?: TaskStatus;
  assignee?: string | null;
  note?: string;
}

/** The fields a request may carry, checked one by one. A task is made with a title; a change has at least one field. */
function validate(input: unknown, whole: boolean, isAgent: (name: string) => boolean): Fields {
  if (!isRecord(input)) throw bad('request body must be a JSON object');
  const allowed = whole ? CREATE_FIELDS : PATCH_FIELDS;
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw bad(`unknown field "${key}"`, key);
  if (whole && input.title === undefined) throw bad('title is required', 'title');
  if (!whole && Object.keys(input).length === 0) throw bad('nothing to change: give a status, an assignee or a note');
  const out: Fields = {};
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title === '' || title.length > TASK_TITLE_MAX_CHARS || UNSAFE_IN_NAME.test(title)) {
      throw bad(`title must be 1 to ${TASK_TITLE_MAX_CHARS} characters on one line`, 'title');
    }
    out.title = title;
  }
  if (input.detail !== undefined) {
    if (typeof input.detail !== 'string' || input.detail.length > TASK_DETAIL_MAX_CHARS) throw bad(`detail must be text of at most ${TASK_DETAIL_MAX_CHARS} characters`, 'detail');
    out.detail = input.detail.trim();
  }
  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(input.status)) throw bad(`status must be one of: ${TASK_STATUSES.join(', ')}`, 'status');
    out.status = input.status as TaskStatus;
  }
  if (input.assignee !== undefined) {
    if (input.assignee !== null && (typeof input.assignee !== 'string' || !NAME_RE.test(input.assignee) || !isAgent(input.assignee))) {
      throw bad('assignee must be the name of an agent in the room, or null', 'assignee');
    }
    out.assignee = input.assignee;
  }
  if (input.note !== undefined) {
    // one line: the history is a list of lines
    const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim() : '';
    if (note === '' || note.length > TASK_NOTE_MAX_CHARS || UNSAFE_IN_NAME.test(note)) throw bad(`note must be 1 to ${TASK_NOTE_MAX_CHARS} characters`, 'note');
    out.note = note;
  }
  return out;
}

/** A saved record read back; one that is not a task throws, and the caller skips it. Unlike a request, it may name an agent that is gone. */
function fromRecord(raw: unknown, at: number): Task {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error('no valid id');
  const { id, title, detail, status, assignee, createdBy, createdAt, updatedAt, notes, handedOff } = raw;
  if (typeof title !== 'string' || title === '' || title.length > TASK_TITLE_MAX_CHARS) throw new Error('no valid title');
  if (typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status)) throw new Error('no valid status');
  return {
    id,
    title,
    detail: typeof detail === 'string' ? detail.slice(0, TASK_DETAIL_MAX_CHARS) : '',
    status: status as TaskStatus,
    assignee: typeof assignee === 'string' && NAME_RE.test(assignee) ? assignee : null,
    createdBy: typeof createdBy === 'string' && NAME_RE.test(createdBy) ? createdBy : 'user',
    createdAt: typeof createdAt === 'number' ? createdAt : at,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : at,
    notes: Array.isArray(notes) ? notes.filter((n): n is string => typeof n === 'string').slice(-TASK_NOTES_MAX) : [],
    ...(typeof handedOff === 'string' && STATION_RE.test(handedOff) ? { handedOff } : {}),
  };
}

export function createTasks(options: TasksOptions): Tasks {
  const { dir, now, log } = options;
  const path = join(dir, TASKS_FILE);
  let tasks: Task[] = [];
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const later = (fn: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => log.error('flight plan could not write', error));
    return run.then(() => undefined);
  };

  const save = (): Promise<void> => {
    // `seq` is the number of the last id given, so an id that was removed or dropped is not given again after a restart
    const json = JSON.stringify({ version: 1, seq, tasks }, null, 2);
    return later(async () => {
      const tmp = join(dir, `.${TASKS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    });
  };

  const list = (): Task[] => tasks.map(copy);
  /** Tells the browsers and saves. */
  const changed = (): Promise<void> => {
    options.emit(list());
    return save();
  };

  const find = (id: string): Task => {
    const task = ID_RE.test(id) ? tasks.find((x) => x.id === id) : undefined;
    if (!task) throw new HubError('not_found', 'unknown task');
    return task;
  };

  const full = (): HubError => new HubError('conflict', `at most ${TASKS_OPEN_MAX} open tasks: finish or remove one first`, 'tasks');

  /** Done tasks are history: the newest TASKS_DONE_KEEP stay, so the file and every frame stop growing. */
  const prune = (): void => {
    const done = tasks.filter((x) => !isOpen(x));
    if (done.length <= TASKS_DONE_KEEP) return;
    const drop = new Set(done.sort((a, b) => b.updatedAt - a.updatedAt).slice(TASKS_DONE_KEEP));
    tasks = tasks.filter((x) => !drop.has(x));
  };

  /**
   * Tells the assignee of `task`. Runs before the change is stored, so a refusal of the hub (the session of the acting agent
   * ended, the recipient is being removed) leaves the board as it was. A message that was made but not delivered is a note.
   */
  const tell = (actor: Actor, task: Task, at: number): void => {
    const to = task.assignee;
    if (to === null || (actor.kind === 'agent' && actor.name === to)) return;
    const by = actor.kind === 'agent' ? actor.name : `the ${director(actor)}`;
    const body = `${task.detail === '' ? '(no detail)' : task.detail}\n\nAssigned by ${by}. Set its status with task_update.`;
    const sent = options.send(actor, { to, subject: taskSubject(task.id, task.title).slice(0, SUBJECT_MAX_CHARS), body });
    if (!sent.ok) task.notes.push(line(actor, `the message to ${to} was not delivered: ${sent.note ?? 'no reason given'}`, at));
  };

  return {
    async load() {
      let saved: unknown = null;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.tasks)) throw new Error('not a version 1 tasks file');
      } catch (error) {
        saved = null;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // kept aside, so that the next save cannot overwrite what the Director and the agents wrote
          log.error(`${TASKS_FILE} could not be read; the board starts empty and the file is kept as ${TASKS_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
          await rename(path, `${path}.bad`).catch(() => undefined);
        }
      }
      const records: unknown[] = isRecord(saved) && Array.isArray(saved.tasks) ? saved.tasks : [];
      if (isRecord(saved) && typeof saved.seq === 'number' && Number.isSafeInteger(saved.seq) && saved.seq > 0) seq = saved.seq;
      for (const raw of records) {
        try {
          const task = fromRecord(raw, now());
          if (tasks.some((x) => x.id === task.id)) throw new Error(`the id ${task.id} is used twice`);
          tasks.push(task);
          seq = Math.max(seq, Number(task.id.slice(1)));
        } catch (error) {
          log.warn(`${TASKS_FILE}: a task was skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },

    list,

    async create(actor, input) {
      const request = validate(input, true, options.isAgent);
      if (tasks.filter(isOpen).length >= TASKS_OPEN_MAX) throw full();
      const at = now();
      const task: Task = {
        id: `t${seq + 1}`,
        title: request.title ?? '',
        detail: request.detail ?? '',
        status: 'todo',
        assignee: request.assignee ?? null,
        createdBy: actor.kind === 'agent' ? actor.name : 'user',
        createdAt: at,
        updatedAt: at,
        notes: [],
      };
      task.notes.push(line(actor, task.assignee === null ? 'created' : `created; assigned to ${task.assignee}`, at));
      tell(actor, task, at);
      seq += 1;
      tasks.push(task);
      prune();
      await changed();
      return copy(task);
    },

    async handOff(id, station, assignee) {
      const task = find(id);
      if (!isOpen(task) || task.handedOff !== undefined) throw new HubError('conflict', 'only a task that is open here can be handed off', 'task');
      const at = now();
      const next = copy(task);
      next.status = 'done';
      next.handedOff = station;
      next.updatedAt = at;
      next.notes.push(line({ kind: 'user' }, `handed off to ${assignee === null ? '' : `${assignee}@`}${station}`, at));
      next.notes = next.notes.slice(-TASK_NOTES_MAX);
      tasks[tasks.indexOf(task)] = next;
      prune();
      await changed();
      return copy(next);
    },

    async update(actor, id, input) {
      const task = find(id);
      const patch = validate(input, false, options.isAgent);
      const at = now();
      const next = copy(task);
      const parts: string[] = [];
      if (patch.status !== undefined && patch.status !== task.status) {
        if (!isOpen(task) && patch.status !== 'done' && tasks.filter(isOpen).length >= TASKS_OPEN_MAX) throw full();
        next.status = patch.status;
        parts.push(`status ${patch.status}`);
      }
      if (patch.assignee !== undefined && patch.assignee !== task.assignee) {
        next.assignee = patch.assignee;
        parts.push(patch.assignee === null ? 'unassigned' : `assigned to ${patch.assignee}`);
      }
      if (patch.note !== undefined) parts.push(patch.note);
      if (parts.length === 0) return copy(task);
      next.updatedAt = at;
      next.notes.push(line(actor, parts.join('; '), at));
      if (next.assignee !== task.assignee) tell(actor, next, at);
      next.notes = next.notes.slice(-TASK_NOTES_MAX);
      tasks[tasks.indexOf(task)] = next;
      // the Director sees what he moved himself; the inbox is for what an agent did
      if (actor.kind === 'agent' && next.status !== task.status && (next.status === 'blocked' || next.status === 'review')) {
        options.notify?.('flight-plan', `${actor.name} moved ${next.id} to ${next.status}: ${next.title}`);
      }
      prune();
      await changed();
      return copy(next);
    },

    async remove(id) {
      const task = find(id);
      tasks = tasks.filter((x) => x !== task);
      await changed();
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
