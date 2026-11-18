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
import { TASK_STATUSES } from '../shared/protocol.js';
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
const EDIT_FIELDS = ['name', 'role', 'dir', 'mode', 'position', 'command', 'payload', 'cleanRoom'];
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
  stop: ['crew', 'Director stopped'],
  remove: ['crew', 'Director removed'],
  edit: ['config', (args) => `Director edited ${plain(args[0]) ?? 'an agent'}: ${fieldsOf(args[1], EDIT_FIELDS).join(', ') || 'nothing'}`],
  resume: ['redline', 'Director resumed'],
  answer: ['answer', (args) => `Director answered ${plain(args[0]) ?? 'an agent'}: ${isRecord(args[1]) && args[1].go === true ? 'go' : 'no-go'}`],
  startPoll: ['poll', 'Director started a T-minus poll'],
  holdPoll: ['poll', 'Director held the poll'],
  abortPoll: ['poll', 'Director aborted the poll'],
  clearPoll: ['poll', 'Director cleared the poll'],
  setGovernor: ['config', (_args, result) => `Director set Max Q to ${isRecord(result) && typeof result.limit === 'number' ? `${result.limit} working` : 'no limit'}`],
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
