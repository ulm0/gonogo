/**
 * Missions (docs/missions-spec.md): a named goal with a status, a lead and a history. Its tasks are the tasks of the Flight Plan
 * whose `missionId` is its id, so the list of a mission is derived and a task is in one place only.
 *
 * The Director (the browser) changes everything; the boss may make a mission and change its status through the MCP tools
 * (mission_create, mission_update), every other agent only reads. The server stamps the actor on each history line. Becoming
 * `active` briefs the boss once (a message from the Director, or from the boss itself when it did it). Nothing closes a mission by
 * itself: when the last open task of an active mission is done, the Director is told once and decides. The clock, the lists of the
 * room and the send are injected for tests.
 *
 * shortcut: the whole list is in every frame and every snapshot; at the limits (50 open missions with 2000-character goals) that
 * is far below the 4 MB socket buffer of web.ts.
 * shortcut: `lead` is an agent name, so a mission does not follow a renamed console, as `assignee` of a task does not.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_NAME_PATTERN,
  MISSION_GOAL_MAX_CHARS,
  MISSION_NAME_MAX_CHARS,
  MISSION_NOTE_MAX_CHARS,
  MISSION_RITUAL_MAX,
  MISSION_STATUSES,
  MISSIONS_OPEN_MAX,
  missionSubject,
  SUBJECT_MAX_CHARS,
} from '../shared/protocol.js';
import type { AgentSendRequest, DownlinkNotify, Logger, Mission, MissionStatus, RitualItem, SendResult, Task } from '../shared/protocol.js';
import { FILE_MODE, MISSION_NOTES_MAX, MISSIONS_DONE_KEEP, MISSIONS_FILE } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';
import { UNSAFE_IN_NAME } from './schedules.js';
import type { Actor } from './tasks.js';
import { cleanLine, itemText, readTemplate } from './ritual.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const ID_RE = /^ms[1-9]\d{0,5}$/;
const CREATE_FIELDS = ['name', 'goal', 'lead', 'ritual'];
const PATCH_FIELDS = ['name', 'goal', 'status', 'lead', 'note', 'ritual'];

/** What a change of the closing ritual does (the Director's only, after the mission is made). */
export type RitualOp = { add: string } | { remove: number } | { index: number; done?: boolean; text?: string };
/** The Director of a docked station never changes missions: only the browser and the agents do. */
export type MissionActor = Exclude<Actor, { kind: 'dock' }>;

export interface MissionsOptions {
  /** gonogo's home: missions.json lives here. */
  dir: string;
  now(): number;
  /** Is this the name of an agent in the room? */
  isAgent(name: string): boolean;
  /** The name of the boss, or null. A mission without a lead starts with it, and it is who a briefing goes to. */
  boss(): string | null;
  /** The tasks of the Flight Plan: a mission's progress and its briefing are derived from them. */
  tasks(): Task[];
  /** Unlinks every task of a mission (the tasks stay on the board). Called by `remove`. */
  unlink(missionId: string): Promise<void>;
  /** Hub.sendFromUser or Hub.sendFromAgent: the briefing of the boss. May throw a HubError. */
  send(actor: MissionActor, request: AgentSendRequest): SendResult;
  /** The whole list changed (a mission made, changed or removed). */
  emit(missions: Mission[]): void;
  /** Downlink: a mission started or ended, or all its tasks are done. */
  notify?: DownlinkNotify;
  log: Logger;
}

export interface Missions {
  load(): Promise<void>;
  /** In the order the missions were made. */
  list(): Mission[];
  /** Does a mission with this id exist? Tasks check their `missionId` with it. */
  has(id: string): boolean;
  /** The input is a JSON value from the wire; a bad one throws a HubError (bad_request, field). */
  create(actor: MissionActor, input: unknown): Promise<Mission>;
  /** A change that changes nothing answers with the mission as it is and writes nothing. */
  update(actor: MissionActor, id: string, input: unknown): Promise<Mission>;
  /** The Director's only. A mission with tasks needs `unlink`, else it is a conflict (field `unlink`). */
  remove(id: string, unlink: boolean): Promise<void>;
  /** Called after the Flight Plan changed: tells the Director once when the last open task of an active mission is done. */
  observe(tasks: Task[]): void;
  close(): Promise<void>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
const copy = (m: Mission): Mission => ({ ...m, history: [...m.history], ...(m.ritual === undefined ? {} : { ritual: m.ritual.map((i) => ({ ...i })) }) });
const isFinished = (m: Mission): boolean => m.status === 'done' || m.status === 'aborted';
const stamp = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const line = (actor: MissionActor, text: string, at: number): string => `${stamp(at)} ${actor.kind === 'agent' ? actor.name : 'Director'}: ${text}`;

interface Fields {
  name?: string;
  goal?: string;
  status?: MissionStatus;
  lead?: string | null;
  note?: string;
  /** At creation: items the boss passes. */
  ritualNew?: string[];
  /** After: one change of the checklist. */
  ritualOp?: RitualOp;
}

function validate(input: unknown, whole: boolean, isAgent: (name: string) => boolean): Fields {
  if (!isRecord(input)) throw bad('request body must be a JSON object');
  const allowed = whole ? CREATE_FIELDS : PATCH_FIELDS;
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw bad(`unknown field "${key}"`, key);
  if (whole && input.name === undefined) throw bad('name is required', 'name');
  if (!whole && Object.keys(input).length === 0) throw bad('nothing to change: give a name, a goal, a status, a lead or a note');
  const out: Fields = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > MISSION_NAME_MAX_CHARS || UNSAFE_IN_NAME.test(name)) throw bad(`name must be 1 to ${MISSION_NAME_MAX_CHARS} characters on one line`, 'name');
    out.name = name;
  }
  if (input.goal !== undefined) {
    if (typeof input.goal !== 'string' || input.goal.length > MISSION_GOAL_MAX_CHARS) throw bad(`goal must be text of at most ${MISSION_GOAL_MAX_CHARS} characters`, 'goal');
    out.goal = input.goal.trim();
  }
  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !(MISSION_STATUSES as readonly string[]).includes(input.status)) throw bad(`status must be one of: ${MISSION_STATUSES.join(', ')}`, 'status');
    out.status = input.status as MissionStatus;
  }
  if (input.lead !== undefined) {
    if (input.lead !== null && (typeof input.lead !== 'string' || !NAME_RE.test(input.lead) || !isAgent(input.lead))) throw bad('lead must be the name of an agent in the room, or null', 'lead');
    out.lead = input.lead;
  }
  if (input.note !== undefined) {
    const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim() : '';
    if (note === '' || note.length > MISSION_NOTE_MAX_CHARS || UNSAFE_IN_NAME.test(note)) throw bad(`note must be 1 to ${MISSION_NOTE_MAX_CHARS} characters`, 'note');
    out.note = note;
  }
  if (input.ritual !== undefined) {
    if (whole) {
      if (!Array.isArray(input.ritual) || input.ritual.length > MISSION_RITUAL_MAX) throw bad(`ritual is a list of at most ${MISSION_RITUAL_MAX} lines of text`, 'ritual');
      out.ritualNew = input.ritual.map((t) => itemText(t, 'ritual'));
    } else {
      out.ritualOp = ritualOp(input.ritual);
    }
  }
  return out;
}

function ritualOp(r: unknown): RitualOp {
  const shape = 'ritual must be { add: text }, { remove: number } or { index: number, done?: boolean, text?: string }';
  if (!isRecord(r)) throw bad(shape, 'ritual');
  const keys = Object.keys(r);
  const number = (v: unknown): number => {
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) >= MISSION_RITUAL_MAX) throw bad('index is the number of an item, from 0', 'index');
    return v as number;
  };
  if (keys.length === 1 && keys[0] === 'add') return { add: itemText(r.add, 'text') };
  if (keys.length === 1 && keys[0] === 'remove') return { remove: number(r.remove) };
  if (r.index !== undefined && keys.every((k) => k === 'index' || k === 'done' || k === 'text') && (r.done !== undefined || r.text !== undefined)) {
    if (r.done !== undefined && typeof r.done !== 'boolean') throw bad('done is true or false', 'done');
    return { index: number(r.index), ...(r.done === undefined ? {} : { done: r.done as boolean }), ...(r.text === undefined ? {} : { text: itemText(r.text, 'text') }) };
  }
  throw bad(shape, 'ritual');
}

/** A saved record read back; one that is not a mission throws, and the caller skips it. */
function fromRecord(raw: unknown, at: number): Mission {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error('no valid id');
  const { id, name, goal, status, lead, createdBy, createdAt, updatedAt, startedAt, endedAt, history, ritual, ritualOmitted } = raw;
  if (typeof name !== 'string' || name === '' || name.length > MISSION_NAME_MAX_CHARS) throw new Error('no valid name');
  if (typeof status !== 'string' || !(MISSION_STATUSES as readonly string[]).includes(status)) throw new Error('no valid status');
  const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id,
    name,
    goal: typeof goal === 'string' ? goal.slice(0, MISSION_GOAL_MAX_CHARS) : '',
    status: status as MissionStatus,
    lead: typeof lead === 'string' && NAME_RE.test(lead) ? lead : null,
    createdBy: typeof createdBy === 'string' && NAME_RE.test(createdBy) ? createdBy : 'user',
    createdAt: time(createdAt) ?? at,
    updatedAt: time(updatedAt) ?? at,
    startedAt: time(startedAt),
    endedAt: time(endedAt),
    history: Array.isArray(history) ? history.filter((n): n is string => typeof n === 'string').slice(-MISSION_NOTES_MAX) : [],
    ...(Array.isArray(ritual) ? { ritual: readRitual(ritual) } : {}),
    ...(typeof ritualOmitted === 'number' && Number.isSafeInteger(ritualOmitted) && ritualOmitted > 0 ? { ritualOmitted } : {}),
  };
}

/** The saved items of a ritual: each is cleaned again, so a file edited by hand cannot bring a control character or a long line back, and only the Director can have ticked. */
function readRitual(raw: unknown[]): RitualItem[] {
  const items: RitualItem[] = [];
  for (const item of raw.slice(0, MISSION_RITUAL_MAX)) {
    if (!isRecord(item) || typeof item.text !== 'string') continue;
    const text = cleanLine(item.text);
    if (text === '') continue;
    const from = item.from === 'director' || item.from === 'agent' ? item.from : 'room';
    items.push({
      text,
      done: item.done === true,
      from,
      ...(from === 'agent' && typeof item.agent === 'string' && NAME_RE.test(item.agent) ? { agent: item.agent } : {}),
      ...(item.by === 'user' ? { by: 'user' } : {}),
      ...(typeof item.at === 'number' && Number.isFinite(item.at) ? { at: item.at } : {}),
    });
  }
  return items;
}

export function createMissions(options: MissionsOptions): Missions {
  const { dir, now, log } = options;
  const path = join(dir, MISSIONS_FILE);
  let missions: Mission[] = [];
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  /** Open tasks of each active mission at the last look, to tell once when the last one is done. */
  const openBefore = new Map<string, number>();

  const later = (fn: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => log.error('missions could not write', error));
    return run.then(() => undefined);
  };

  const save = (): Promise<void> => {
    // `seq` is the number of the last id given, so an id that was removed or trimmed is not given again after a restart
    const json = JSON.stringify({ version: 1, seq, missions }, null, 2);
    return later(async () => {
      const tmp = join(dir, `.${MISSIONS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    });
  };

  const list = (): Mission[] => missions.map(copy);
  const changed = (): Promise<void> => {
    options.emit(list());
    return save();
  };

  const find = (id: string): Mission => {
    const mission = ID_RE.test(id) ? missions.find((x) => x.id === id) : undefined;
    if (!mission) throw new HubError('not_found', 'unknown mission');
    return mission;
  };

  const linked = (id: string): Task[] => options.tasks().filter((t) => t.missionId === id);
  const open = (id: string): Task[] => linked(id).filter((t) => t.status !== 'done');
  const full = (): HubError => new HubError('conflict', `at most ${MISSIONS_OPEN_MAX} missions that are not finished: finish or remove one first`, 'missions');

  /** The 20 most recent finished missions stay, so the file and every frame stop growing. */
  const prune = (): void => {
    const done = missions.filter(isFinished);
    if (done.length <= MISSIONS_DONE_KEEP) return;
    const drop = new Set(done.sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt)).slice(MISSIONS_DONE_KEEP));
    missions = missions.filter((x) => !drop.has(x));
    for (const m of drop) void options.unlink(m.id).catch(() => undefined);
  };

  /** The briefing of the boss when a mission starts: once, as a message from whoever started it. A refusal is a note, not a failure. */
  const brief = (actor: MissionActor, mission: Mission, at: number): void => {
    const boss = options.boss();
    if (boss === null || (actor.kind === 'agent' && actor.name === boss)) return;
    const tasks = open(mission.id);
    const taskLines = tasks.length === 0 ? 'No tasks are linked yet.' : `Open tasks:\n${tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.assignee === null ? '' : ` (${t.assignee})`}`).join('\n')}`;
    const body = `${mission.goal === '' ? '(no goal written)' : mission.goal}\n\n${taskLines}\n\nStarted by ${actor.kind === 'agent' ? actor.name : 'the Director'}. See mission_list; link tasks with missionId.`;
    try {
      const sent = options.send(actor, { to: boss, subject: missionSubject(mission.name).slice(0, SUBJECT_MAX_CHARS), body });
      if (!sent.ok) mission.history.push(line(actor, `the briefing to ${boss} was not delivered: ${sent.note ?? 'no reason given'}`, at));
    } catch (error) {
      mission.history.push(line(actor, `the briefing to ${boss} was not sent: ${error instanceof HubError ? error.message : 'it failed'}`, at));
    }
  };

  return {
    async load() {
      let saved: unknown = null;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.missions)) throw new Error('not a version 1 missions file');
      } catch (error) {
        saved = null;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // kept aside, so that the next save cannot overwrite what the Director and the boss wrote
          log.error(`${MISSIONS_FILE} could not be read; the room starts with no missions and the file is kept as ${MISSIONS_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
          await rename(path, `${path}.bad`).catch(() => undefined);
        }
      }
      const records: unknown[] = isRecord(saved) && Array.isArray(saved.missions) ? saved.missions : [];
      if (isRecord(saved) && typeof saved.seq === 'number' && Number.isSafeInteger(saved.seq) && saved.seq > 0) seq = saved.seq;
      for (const raw of records) {
        try {
          const mission = fromRecord(raw, now());
          if (missions.some((x) => x.id === mission.id)) throw new Error(`the id ${mission.id} is used twice`);
          missions.push(mission);
          seq = Math.max(seq, Number(mission.id.slice(2)));
        } catch (error) {
          log.warn(`${MISSIONS_FILE}: a mission was skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },

    list,
    has: (id) => ID_RE.test(id) && missions.some((x) => x.id === id),

    async create(actor, input) {
      const request = validate(input, true, options.isAgent);
      if (missions.filter((m) => !isFinished(m)).length >= MISSIONS_OPEN_MAX) throw full();
      const at = now();
      const lead = request.lead === undefined ? options.boss() : request.lead;
      // the room's template first, then the lines the boss passed (labelled with its name); at most MISSION_RITUAL_MAX
      const template = readTemplate(dir);
      const given: RitualItem[] = (request.ritualNew ?? []).map((text) => (actor.kind === 'agent' ? { text, done: false, from: 'agent' as const, agent: actor.name } : { text, done: false, from: 'director' as const }));
      const items = [...template.items, ...given].slice(0, MISSION_RITUAL_MAX);
      const omitted = template.omitted + (template.items.length + given.length - items.length);
      const mission: Mission = {
        id: `ms${seq + 1}`,
        name: request.name ?? '',
        goal: request.goal ?? '',
        status: 'planned',
        lead,
        createdBy: actor.kind === 'agent' ? actor.name : 'user',
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        endedAt: null,
        history: [line(actor, lead === null ? 'created' : `created; lead ${lead}`, at)],
        ...(items.length === 0 ? {} : { ritual: items }),
        ...(omitted > 0 ? { ritualOmitted: omitted } : {}),
      };
      seq += 1;
      missions.push(mission);
      prune();
      await changed();
      return copy(mission);
    },

    async update(actor, id, input) {
      const mission = find(id);
      const patch = validate(input, false, options.isAgent);
      // an agent (the boss) changes the status and writes notes; the name, the goal and the lead are the Director's
      if (actor.kind === 'agent') {
        for (const key of ['name', 'goal', 'lead'] as const) if (patch[key] !== undefined) throw new HubError('forbidden', `only the Director changes the ${key} of a mission`, key);
        // the closing checklist: an agent can read it (mission_list) and give lines when it makes a mission, never tick, edit or remove
        if (patch.ritualOp !== undefined) throw new HubError('forbidden', 'only the Director changes the closing checklist of a mission', 'ritual');
      }
      const at = now();
      const next = copy(mission);
      const parts: string[] = [];
      if (patch.name !== undefined && patch.name !== mission.name) {
        next.name = patch.name;
        parts.push('renamed');
      }
      if (patch.goal !== undefined && patch.goal !== mission.goal) {
        next.goal = patch.goal;
        parts.push('goal changed');
      }
      if (patch.lead !== undefined && patch.lead !== mission.lead) {
        next.lead = patch.lead;
        parts.push(patch.lead === null ? 'lead removed' : `lead ${patch.lead}`);
      }
      if (patch.ritualOp !== undefined) {
        const items = (next.ritual ??= []);
        const op = patch.ritualOp;
        if ('add' in op) {
          if (items.length >= MISSION_RITUAL_MAX) throw new HubError('conflict', `a mission has at most ${MISSION_RITUAL_MAX} closing items`, 'ritual');
          items.push({ text: op.add, done: false, from: 'director' });
          parts.push(`closing item ${items.length} added`);
        } else if ('remove' in op) {
          if (items[op.remove] === undefined) throw new HubError('not_found', 'this mission has no closing item with that number', 'index');
          items.splice(op.remove, 1);
          parts.push(`closing item ${op.remove + 1} removed`);
        } else {
          const item = items[op.index];
          if (item === undefined) throw new HubError('not_found', 'this mission has no closing item with that number', 'index');
          if (op.text !== undefined && op.text !== item.text) {
            // the Director's words now, whoever wrote the line before
            item.text = op.text;
            item.from = 'director';
            delete item.agent;
            parts.push(`closing item ${op.index + 1} edited`);
          }
          if (op.done !== undefined && op.done !== item.done) {
            item.done = op.done;
            if (op.done) Object.assign(item, { by: 'user', at });
            else {
              delete item.by;
              delete item.at;
            }
            parts.push(`closing item ${op.index + 1} ${op.done ? 'ticked' : 'unticked'}`);
          }
        }
      }
      let started = false;
      let ended = false;
      if (patch.status !== undefined && patch.status !== mission.status) {
        if (isFinished(mission) && !isFinished({ ...mission, status: patch.status }) && missions.filter((m) => !isFinished(m)).length >= MISSIONS_OPEN_MAX) throw full();
        next.status = patch.status;
        parts.push(`status ${patch.status}`);
        if (patch.status === 'active') {
          next.startedAt = at;
          started = true;
        }
        next.endedAt = isFinished(next) ? at : null;
        ended = isFinished(next);
      }
      if (patch.note !== undefined) parts.push(patch.note);
      if (parts.length === 0) return copy(mission);
      next.updatedAt = at;
      next.history.push(line(actor, parts.join('; '), at));
      if (started) brief(actor, next, at);
      next.history = next.history.slice(-MISSION_NOTES_MAX);
      missions[missions.indexOf(mission)] = next;
      if (started) {
        openBefore.set(next.id, open(next.id).length);
        options.notify?.('mission', `Mission started: ${next.name}`);
      }
      if (ended) {
        openBefore.delete(next.id);
        const counted = linked(next.id);
        // closing with items open is allowed and says so, with the lines (cleaned; those of an agent are labelled by being quoted, and cut)
        const left = (next.ritual ?? []).filter((i) => !i.done);
        const ritual = left.length === 0 ? '' : `; ${left.length} of ${(next.ritual ?? []).length} closing items left: ${left.slice(0, 5).map((i) => `"${i.text.slice(0, 60)}"`).join(', ')}${left.length > 5 ? ', ...' : ''}`;
        options.notify?.('mission', `Mission ${next.status}: ${next.name} (${counted.filter((t) => t.status === 'done').length} of ${counted.length} tasks done${ritual})`);
      }
      if (next.status !== 'active') openBefore.delete(next.id);
      prune();
      await changed();
      return copy(next);
    },

    async remove(id, unlink) {
      const mission = find(id);
      const tasks = linked(id);
      if (tasks.length > 0 && !unlink) throw new HubError('conflict', `the mission has ${tasks.length} linked ${tasks.length === 1 ? 'task' : 'tasks'}: remove it with unlink to keep them on the board`, 'unlink');
      if (tasks.length > 0) await options.unlink(id);
      missions = missions.filter((x) => x !== mission);
      openBefore.delete(id);
      await changed();
    },

    observe(tasks) {
      for (const mission of missions) {
        if (mission.status !== 'active') continue;
        const mine = tasks.filter((t) => t.missionId === mission.id);
        const openNow = mine.filter((t) => t.status !== 'done').length;
        const before = openBefore.get(mission.id);
        openBefore.set(mission.id, openNow);
        if (before !== undefined && before > 0 && openNow === 0 && mine.length > 0) {
          options.notify?.('mission', `All ${mine.length} ${mine.length === 1 ? 'task' : 'tasks'} of ${mission.name} are done: close it?`);
        }
      }
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
