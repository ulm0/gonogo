/**
 * What the Black Box is told, and by whom (docs/black-box-spec.md).
 *
 * `audited(store, record, table)` returns a copy of a store (the hub, the tasks, the uplinks, ...) whose listed methods tell the
 * Black Box after they succeed; a call that throws tells nothing, and the answer the caller gets is the one the store gave. The
 * table says, for each method, the kind of the event and its words: a plain label (followed by the first argument or answer field that
 * is a plain name or id) or a function. Every text is made of those labels, names, ids, statuses and counts, never of a message, a
 * title, a note, a schedule's text, a secret or a path, so that the record holds nothing a reader of the repository should not see.
 */
import type { AuditKind, AuditRecord } from '../shared/protocol.js';
import { MISSION_STATUSES, REVIEW_STATUSES, TASK_STATUSES } from '../shared/protocol.js';
import { isRecord } from './hooks.js';

/** A name or an id: letters, digits, dots, dashes, underscores and an at sign, at most 64. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const plain = (value: unknown): string | null => (typeof value === 'string' && PLAIN.test(value) ? value : null);

/** The words of an event, from the arguments of the call and what it answered; null says nothing. */
export type Describe = (args: unknown[], result: unknown) => string | null;
export type Table = Record<string, [AuditKind, string | Describe]>;

/** The first argument that is a plain name or id, else the id or the name of the answer. */
function subjectOf(args: unknown[], result: unknown): string | null {
  for (const arg of args) {
    const found = plain(arg);
    if (found !== null) return found;
  }
  return isRecord(result) ? (plain(result.id) ?? plain(result.name)) : null;
}

export function audited<T extends object>(store: T, record: AuditRecord, table: Table): T {
  const out = { ...store } as Record<string, unknown>;
  for (const [method, [kind, words]] of Object.entries(table)) {
    const original = (store as Record<string, unknown>)[method];
    if (typeof original !== 'function') throw new Error(`audited: no method ${method}`);
    out[method] = (...args: unknown[]): unknown => {
      const done = (result: unknown): unknown => {
        let text: string | null;
        try {
          text = typeof words === 'string' ? [words, subjectOf(args, result)].filter(Boolean).join(' ') : words(args, result);
        } catch {
          text = null;
        }
        if (text !== null) record(kind, text);
        return result;
      };
      const result: unknown = original.apply(store, args);
      return result instanceof Promise ? result.then(done) : done(result);
    };
  }
  return out as T;
}

/** The fields an edit names: the names of the fields only, never their values. */
const EDIT_FIELDS = ['name', 'role', 'dir', 'mode', 'position', 'command', 'payload', 'payloadOff', 'cleanRoom', 'worktree', 'remoteControl', 'permissions', 'autostart', 'coauthor'];
const fieldsOf = (value: unknown, allowed: string[]): string[] => (isRecord(value) ? Object.keys(value).filter((key) => allowed.includes(key) && value[key] !== undefined) : []);

const actorName = (actor: unknown): string => {
  if (!isRecord(actor)) return 'Director';
  if (actor.kind === 'agent') return plain(actor.name) ?? 'an agent';
  return actor.kind === 'dock' ? `Director of ${plain(actor.station) ?? 'a station'}` : 'Director';
};

/** What the Director does to the room through the hub (the browser routes use this copy of it). */
export const HUB_AUDIT: Table = {
  hire: ['crew', 'Director hired'],
  restart: ['crew', 'Director restarted'],
  // the boss's `start_agent` tool: the caller's name and the agent's, never anything else
  startAgent: ['crew', (args) => `${plain(args[1]) ?? 'the boss'} started ${plain(args[0]) ?? 'an agent'}`],
  stop: ['crew', 'Director stopped'],
  remove: ['crew', 'Director removed'],
  edit: ['config', (args) => `Director edited ${plain(args[0]) ?? 'an agent'}: ${fieldsOf(args[1], EDIT_FIELDS).join(', ') || 'nothing'}`],
  hold: ['redline', (args) => `Director put ${plain(args[0]) ?? 'an agent'} on hold`],
  resume: ['redline', 'Director resumed'],
  holdAll: ['redline', (_args, result) => `Director pressed ALL STOP: ${isRecord(result) && Array.isArray(result.held) ? result.held.length : 0} held`],
  resumeAll: ['redline', (_args, result) => `Director pressed ALL RESUME: ${isRecord(result) && Array.isArray(result.resumed) ? result.resumed.length : 0} resumed`],
  answer: ['answer', (args) => `Director answered ${plain(args[0]) ?? 'an agent'}: ${isRecord(args[1]) && args[1].go === true ? 'go' : 'no-go'}`],
  startPoll: ['poll', 'Director started a T-minus poll'],
  holdPoll: ['poll', 'Director held the poll'],
  abortPoll: ['poll', 'Director aborted the poll'],
  clearPoll: ['poll', 'Director cleared the poll'],
  setGovernor: ['config', (_args, result) => `Director set Max Q to ${isRecord(result) && typeof result.limit === 'number' ? `${result.limit} working` : 'no limit'}`],
};

/** Relief: the Director's go or no-go to a hire request, by the request's id (never the name, role, directory or text of the request). */
export const RELIEF_AUDIT: Table = {
  decide: ['answer', (args) => `Director answered hire request ${plain(args[0]) ?? '?'}: ${args[1] === 'go' ? 'go' : 'no-go'}`],
};

/** Room editor: that the layout was saved or reset, and which part; never a number of it. */
export const ROOM_AUDIT: Table = {
  save: ['config', 'Director saved the room layout'],
  reset: ['config', (args) => (args[0] === 'desks' ? 'Director reset the order of the desks' : 'Director reset the room layout')],
};

/** Tab name: that it was set or cleared, never the name. */
export const TABNAME_AUDIT: Table = {
  set: ['config', (args) => (args[0] === null || args[0] === '' || args[0] === undefined ? 'Director cleared the tab name' : 'Director set the tab name')],
};

/** Missions: who made or changed a mission, and what kind of change (the status, never a name, goal or note). */
export const MISSIONS_AUDIT: Table = {
  create: ['plan', (args, result) => `${actorName(args[0])} created mission ${isRecord(result) ? (plain(result.id) ?? '?') : '?'}`],
  update: [
    'plan',
    (args) => {
      const input = isRecord(args[2]) ? args[2] : {};
      const status = (MISSION_STATUSES as readonly unknown[]).includes(input.status) ? ` status ${String(input.status)}` : '';
      const other = ['name', 'goal', 'lead', 'note'].filter((k) => input[k] !== undefined).join(' ');
      return `${actorName(args[0])} updated mission ${plain(args[1]) ?? '?'}:${status}${other === '' ? '' : ` ${other}`}`;
    },
  ],
  remove: ['plan', (args) => `Director removed mission ${plain(args[0]) ?? '?'}${args[1] === true ? ' and unlinked its tasks' : ''}`],
};

/** Post-Flight Review: who added notes to whose diff and what the Director did with them: ids, names and counts, never a body, a path or a line. */
export const REVIEW_AUDIT: Table = {
  addNote: ['plan', (args) => `Director added a review note on ${plain(args[1]) ?? '?'}`],
  addNotes: ['plan', (args, result) => `${actorName(args[0])} added ${Array.isArray(result) ? result.length : 0} review notes on ${plain(args[1]) ?? '?'}`],
  update: [
    'plan',
    (args) => {
      const input = isRecord(args[2]) ? args[2] : {};
      const status = (REVIEW_STATUSES as readonly unknown[]).includes(input.status) ? ` to ${String(input.status)}` : '';
      return `Director changed review note ${plain(args[1]) ?? '?'} of ${plain(args[0]) ?? '?'}${status}${input.body !== undefined ? ' (edited)' : ''}`;
    },
  ],
  remove: ['plan', (args) => `Director deleted review note ${plain(args[1]) ?? '?'} of ${plain(args[0]) ?? '?'}`],
  verdict: ['plan', (args, result) => `Director gave a verdict on ${plain(args[0]) ?? '?'}: ${isRecord(result) && isRecord(result.verdict) && result.verdict.verdict === 'approved' ? 'approved' : 'changes requested'}`],
  ask: ['plan', (args) => (isRecord(args[1]) && args[1].kind === 'peer' ? `Director asked ${plain(args[1].reviewer) ?? '?'} to review the diff of ${plain(args[0]) ?? '?'}` : `Director asked ${plain(args[0]) ?? '?'} for a walkthrough of its diff`)],
};

/** Flight Plan: who made or changed a task, and what kind of change (the status and the assignee, never a title, detail or note). */
export const TASKS_AUDIT: Table = {
  create: ['plan', (args, result) => `${actorName(args[0])} created task ${isRecord(result) ? (plain(result.id) ?? '?') : '?'}`],
  update: [
    'plan',
    (args) => {
      const input = isRecord(args[2]) ? args[2] : {};
      const status = (TASK_STATUSES as readonly unknown[]).includes(input.status) ? ` status ${String(input.status)}` : '';
      const assignee = input.assignee === null ? ' unassigned' : plain(input.assignee) !== null ? ` assignee ${String(input.assignee)}` : '';
      return `${actorName(args[0])} updated task ${plain(args[1]) ?? '?'}:${status}${assignee}${typeof input.note === 'string' ? ' note' : ''}`;
    },
  ],
  remove: ['plan', 'Director removed task'],
  handOff: ['plan', (args) => `Director handed off task ${plain(args[0]) ?? '?'} to ${plain(args[1]) ?? 'a station'}`],
};

/** Plot Board: who wrote it and how long it is; the text is in board.md and not here. */
export const BOARD_AUDIT: Table = {
  write: [
    'plan',
    (args, result) => {
      const view = isRecord(result) ? result : {};
      const sent = isRecord(args[1]) ? args[1] : {};
      // the same text again made no revision
      if (typeof view.revision !== 'number' || view.revision === sent.revision) return null;
      return `${args[0] === 'user' ? 'Director' : (plain(args[0]) ?? 'an agent')} wrote the Plot Board: revision ${view.revision}, ${typeof view.text === 'string' ? view.text.length : 0} characters`;
    },
  ],
};

/** Uplink: a delivery that made a message, and what the Director does to the list. */
export const UPLINKS_AUDIT: Table = {
  deliver: [
    'uplink',
    (args, result) => (isRecord(result) && typeof result.id === 'string' ? `Uplink ${plain(args[0]) ?? '?'} delivered message ${plain(result.id) ?? '?'}` : null),
  ],
  create: ['config', 'Director made an uplink'],
  update: ['config', 'Director changed uplink'],
  remove: ['config', 'Director removed uplink'],
  rotate: ['config', 'Director rotated the secret of uplink'],
};

/** The rest of what the Director configures from the browser. */
export const SCHEDULES_AUDIT: Table = {
  create: ['config', 'Director made a schedule'],
  update: ['config', 'Director changed schedule'],
  remove: ['config', 'Director removed schedule'],
  run: ['config', 'Director ran schedule'],
};
export const PERMISSIONS_AUDIT: Table = { set: ['config', "Director changed the room's tool rules"] };
/** Payload defaults: which item changed, by its name (a server name or a folder name) and never a value, an argument or a path. */
export const PAYLOAD_DEFAULTS_AUDIT: Table = {
  setServer: ['config', (args) => `Director set the default MCP server ${plain(args[0]) ?? '(unnamed)'}`],
  removeServer: ['config', (args) => `Director removed the default MCP server ${plain(args[0]) ?? '(unnamed)'}`],
  addSkill: ['config', 'Director added a default skill folder'],
  removeSkill: ['config', (args) => `Director removed the default skill ${plain(args[0]) ?? '(unnamed)'}`],
};
/** Room keys: which key changed, by its name (a name is plain capitals) and never a value. */
export const ROOM_KEYS_AUDIT: Table = {
  set: ['config', (args) => `Director set the room key ${plain(args[0]) ?? '(unnamed)'}`],
  remove: ['config', (args) => `Director removed the room key ${plain(args[0]) ?? '(unnamed)'}`],
};
/** Room rules: who changed them and how long they are, never the text (it is the system prompt of every agent). */
export const RULES_AUDIT: Table = {
  set: ['config', (_args, result) => (isRecord(result) && typeof result.bytes === 'number' ? (result.bytes === 0 ? 'Director removed the room rules' : `Director changed the room rules (${result.bytes} bytes)`) : null)],
};
export const COAUTHOR_AUDIT: Table = { set: ['config', 'Director changed the co-author setting'] };
export const SUBAGENTS_AUDIT: Table = { set: ['config', 'Director changed the subagent setting'] };
export const AUTOUPDATE_AUDIT: Table = { set: ['config', 'Director changed auto-update'], skip: ['config', 'Director skipped a version for auto-update'] };
export const STARTUP_AUDIT: Table = { set: ['config', 'Director changed the startup policy'] };
/** Feature toggles: which features were switched, by id (ids are plain words). */
export const FEATURES_AUDIT: Table = {
  apply: [
    'config',
    (_args, result) => {
      const plan = isRecord(result) && isRecord(result.plan) ? result.plan : {};
      const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => plain(id) !== null) : []);
      const off = [...ids(plan.turnOff), ...ids(plan.forced)];
      const on = ids(plan.turnOn);
      const parts = [off.length > 0 ? `off ${off.join(', ')}` : '', on.length > 0 ? `on ${on.join(', ')}` : ''].filter(Boolean);
      return `Director switched features: ${parts.join('; ') || 'turned the rest on'}`;
    },
  ],
};
export const PROPELLANT_AUDIT: Table = {
  setLimits: ['config', 'Director changed the Propellant limits'],
  setBudget: ['config', 'Director changed the Propellant budget'],
};
export const PRICES_AUDIT: Table = { replace: ['config', 'Director changed the model prices'], remove: ['config', 'Director removed a model price'] };
export const RELAY_AUDIT: Table = {
  set: ['config', 'Director set up Relay target'],
  remove: ['config', 'Director removed Relay target'],
  forward: ['config', 'Director changed what Relay forwards'],
};
export const LIVERIES_AUDIT: Table = { select: ['config', 'Director chose a livery'], remove: ['config', 'Director removed livery'] };
export const DOCKING_AUDIT: Table = {
  createCode: ['config', 'Director made a docking code'],
  pair: ['config', 'Director paired a station'],
  undock: ['config', 'Director undocked'],
};

/** What a Redline trip says to the Downlink is "<name>: <reason>", and the reason can hold a command line: the Black Box keeps the name and the rule. */
const TRIP_RULES = ['loop', 'error storm', 'ping-pong', 'out of propellant', 'room out of propellant'];
export function tripText(text: string): string {
  const at = text.indexOf(': ');
  const reason = at < 0 ? '' : text.slice(at + 2);
  const rule = TRIP_RULES.find((candidate) => reason === candidate || reason.startsWith(`${candidate}:`)) ?? 'another rule';
  return `${(at < 0 ? null : plain(text.slice(0, at))) ?? 'An agent'} tripped the Redline: ${rule}`;
}

/** A T-minus result is "<STATUS>: <note>", and the note is made of agent names and fixed words (hub.ts pollNote), never of a vote's reason. */
export const pollText = (text: string): string => `T-minus poll ${text}`;
