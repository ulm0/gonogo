/**
 * Launch Window: messages the Director wrote once and gonogo sends by itself on a cron rule (docs/launch-window-spec.md).
 *
 * A firing is `Hub.sendFromUser`, the same path as a message typed in the Brief box, so Max Q, Redline and held mail apply.
 * One timer runs on the minute: it fires what is due and starts again. A fire more than SCHEDULE_GRACE_MS late (the
 * machine slept, the event loop stalled) is skipped and logged, never replayed, and so are fires missed while gonogo was down.
 * The clock, the timers and the send are injected, so tests run it on a fake clock.
 *
 * shortcut: a schedule that was disabled for a while and then enabled reports "missed" at the next start if its rule
 * would have fired in between; track when it was turned off if the log line ever confuses.
 * shortcut: `to` is an agent name, so after a rename the schedule writes to the old name and its fires end as
 * "not sent: unknown recipient"; follow renames (key by record id) if renames get common.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nextFire, parseCron } from '../shared/cron.js';
import type { CronRule } from '../shared/cron.js';
import {
  AGENT_NAME_PATTERN,
  BODY_MAX_CHARS,
  CRON_MAX_CHARS,
  SCHEDULE_NAME_MAX_CHARS,
  SCHEDULES_MAX,
  scheduleSubject,
  SUBJECT_MAX_CHARS,
} from '../shared/protocol.js';
import type { DownlinkNotify, Logger, Schedule, SchedulePatch, ScheduleRequest, ScheduleView, SendResult, TimerHandle, UserMessageRequest } from '../shared/protocol.js';
import { FILE_MODE, SCHEDULE_GRACE_MS, SCHEDULE_RESULT_MAX_CHARS, SCHEDULES_FILE } from './constants.js';
import { HubError } from './hub.js';

const NAME_RE = new RegExp(AGENT_NAME_PATTERN);
const ID_RE = /^s[1-9]\d{0,5}$/;
const EDITABLE = ['name', 'to', 'subject', 'body', 'rule', 'enabled'];
// C0, DEL, C1 and bidi controls: the name is part of a subject and must stay one clean line.
export const UNSAFE_IN_NAME = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
const MINUTE_MS = 60_000;

export interface SchedulesOptions {
  /** gonogo's home: schedules.json lives here. */
  dir: string;
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** Hub.sendFromUser: a message from the Director, through Max Q, Redline and held mail. May throw a HubError. */
  send(request: UserMessageRequest): SendResult;
  /** The whole list changed (a schedule made, edited, removed or run). */
  emit(schedules: ScheduleView[]): void;
  /** Downlink: a fire the hub refused or could not take. */
  notify?: DownlinkNotify;
  log: Logger;
}

export interface Schedules {
  /** Reads the file, logs the fires missed while gonogo was down and starts the timer. */
  load(): Promise<void>;
  list(): ScheduleView[];
  /** The input is a JSON value from the wire; a bad one throws a HubError (bad_request, field). */
  create(input: unknown): Promise<ScheduleView>;
  update(id: string, input: unknown): Promise<ScheduleView>;
  remove(id: string): Promise<void>;
  /** Sends now, whether the schedule is on or off. The answer of the hub is in `lastResult`, also when it is a refusal. */
  run(id: string): Promise<ScheduleView>;
  close(): Promise<void>;
}

interface Entry {
  schedule: Schedule;
  rule: CronRule;
  next: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (message: string, field: string): HubError => new HubError('bad_request', message, field);

function ruleOf(text: string): CronRule {
  const rule = parseCron(text);
  if (typeof rule === 'string') throw bad(rule, 'rule');
  return rule;
}

/** The fields a request may carry, checked one by one. With `whole` the four that have no default must be there. */
function validate(input: unknown, whole: boolean): SchedulePatch {
  if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
  for (const key of Object.keys(input)) if (!EDITABLE.includes(key)) throw bad(`unknown field "${key}"`, key);
  if (whole) for (const key of ['name', 'to', 'body', 'rule']) if (input[key] === undefined) throw bad(`${key} is required`, key);
  const out: SchedulePatch = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > SCHEDULE_NAME_MAX_CHARS || UNSAFE_IN_NAME.test(name)) {
      throw bad(`name must be 1 to ${SCHEDULE_NAME_MAX_CHARS} characters on one line`, 'name');
    }
    out.name = name;
  }
  if (input.to !== undefined) {
    if (typeof input.to !== 'string' || (input.to !== 'boss' && (input.to === 'user' || !NAME_RE.test(input.to)))) {
      throw bad('to must be an agent name or "boss"', 'to');
    }
    out.to = input.to;
  }
  if (input.subject !== undefined) {
    if (typeof input.subject !== 'string') throw bad('subject must be text', 'subject');
    out.subject = input.subject.trim();
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' || input.body.trim() === '' || input.body.length > BODY_MAX_CHARS) {
      throw bad(`body must be 1 to ${BODY_MAX_CHARS} characters`, 'body');
    }
    out.body = input.body;
  }
  if (input.rule !== undefined) {
    if (typeof input.rule !== 'string' || input.rule.length > CRON_MAX_CHARS) throw bad(`rule must be text of at most ${CRON_MAX_CHARS} characters`, 'rule');
    ruleOf(input.rule);
    out.rule = input.rule.trim().split(/\s+/).join(' ');
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw bad('enabled must be true or false', 'enabled');
    out.enabled = input.enabled;
  }
  return out;
}

/** The whole subject has to fit the hub's limit once the prefix is on it. */
function checkSubject(schedule: Schedule): void {
  if (scheduleSubject(schedule.name, schedule.subject).length > SUBJECT_MAX_CHARS) {
    throw bad(`the name and the subject together must be at most ${SUBJECT_MAX_CHARS - 'Launch Window: : '.length} characters`, 'subject');
  }
}

const cut = (text: string): string => text.slice(0, SCHEDULE_RESULT_MAX_CHARS);

export function createSchedules(options: SchedulesOptions): Schedules {
  const { dir, now, log } = options;
  const path = join(dir, SCHEDULES_FILE);
  let entries: Entry[] = [];
  let seq = 0;
  let timer: TimerHandle | null = null;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();

  const later = (fn: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => log.error('launch window could not write', error));
    return run.then(() => undefined);
  };

  const save = (): Promise<void> => {
    const json = JSON.stringify({ version: 1, schedules: entries.map((e) => e.schedule) }, null, 2);
    return later(async () => {
      const tmp = join(dir, `.${SCHEDULES_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    });
  };

  const view = (e: Entry): ScheduleView => ({ ...e.schedule, nextAt: e.next });
  const list = (): ScheduleView[] => entries.map(view);
  /** Tells the browsers and saves; a failed save is logged by `later`, so the caller that does not wait may ignore it. */
  const changed = (): Promise<void> => {
    options.emit(list());
    return save();
  };

  const entryOf = (id: string): Entry => {
    const e = ID_RE.test(id) ? entries.find((x) => x.schedule.id === id) : undefined;
    if (!e) throw new HubError('not_found', 'unknown schedule');
    return e;
  };

  const nextOf = (e: Entry): number | null => (e.schedule.enabled ? nextFire(e.rule, now()) : null);

  const fire = (e: Entry): void => {
    const s = e.schedule;
    s.lastRunAt = now();
    let failed = false;
    try {
      const sent = options.send({ to: s.to, subject: scheduleSubject(s.name, s.subject), body: s.body });
      failed = !sent.ok;
      s.lastResult = cut(sent.ok ? `sent ${sent.id}: ${sent.status}${sent.note ? ` (${sent.note})` : ''}` : `undelivered ${sent.id}: ${sent.note ?? 'no reason given'}`);
    } catch (error) {
      failed = true;
      s.lastResult = cut(`not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (failed) options.notify?.('launch-window', `${s.name}: ${s.lastResult}`);
  };

  const tick = (): void => {
    const t = now();
    let any = false;
    for (const e of entries) {
      if (e.next === null || e.next > t) continue;
      const due = e.next;
      e.next = nextFire(e.rule, t);
      any = true;
      if (t - due > SCHEDULE_GRACE_MS) log.warn(`launch window "${e.schedule.name}" missed its fire at ${new Date(due).toISOString()}; missed fires are not replayed`);
      else fire(e);
    }
    if (any) void changed().catch(() => undefined);
    arm();
  };

  // On the minute: a timer that fires a millisecond early only finds nothing due and starts again for that millisecond.
  function arm(): void {
    if (!closed) timer = options.setTimer(tick, MINUTE_MS - (now() % MINUTE_MS));
  }

  return {
    async load() {
      let saved: unknown = null;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.schedules)) throw new Error('not a version 1 schedules file');
      } catch (error) {
        saved = null;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // kept aside, so that the next save cannot overwrite what the Director wrote
          log.error(`${SCHEDULES_FILE} could not be read; schedules start empty and the file is kept as ${SCHEDULES_FILE}.bad`, error);
          await rename(path, `${path}.bad`).catch(() => undefined);
        }
      }
      const t = now();
      const records: unknown[] = isRecord(saved) && Array.isArray(saved.schedules) ? saved.schedules : [];
      for (const raw of records) {
        try {
          if (!isRecord(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error('no valid id');
          if (entries.some((x) => x.schedule.id === raw.id)) throw new Error(`the id ${raw.id} is used twice`);
          const { id, createdAt, lastRunAt, lastResult } = raw;
          const own = validate(Object.fromEntries(EDITABLE.map((k) => [k, raw[k]])), true) as ScheduleRequest;
          const schedule: Schedule = {
            id,
            name: own.name,
            to: own.to,
            subject: own.subject ?? '',
            body: own.body,
            rule: own.rule,
            enabled: own.enabled === true,
            createdAt: typeof createdAt === 'number' ? createdAt : t,
            lastRunAt: typeof lastRunAt === 'number' ? lastRunAt : null,
            lastResult: typeof lastResult === 'string' ? cut(lastResult) : null,
          };
          checkSubject(schedule);
          const e: Entry = { schedule, rule: ruleOf(schedule.rule), next: null };
          e.next = nextOf(e);
          entries.push(e);
          seq = Math.max(seq, Number(id.slice(1)));
        } catch (error) {
          log.warn(`${SCHEDULES_FILE}: a schedule was skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const missed = entries.filter((e) => {
        const at = e.schedule.enabled ? nextFire(e.rule, e.schedule.lastRunAt ?? e.schedule.createdAt) : null;
        // every fire before now counts: one in the last minute before the start is not sent either, so it is logged too
        return at !== null && at <= t;
      });
      if (missed.length > 0) log.warn(`launch window: fires were missed while gonogo was down (${missed.map((e) => e.schedule.name).join(', ')}); missed fires are not replayed`);
      arm();
    },

    list,

    async create(input) {
      const request = validate(input, true) as ScheduleRequest;
      if (entries.length >= SCHEDULES_MAX) throw new HubError('conflict', `at most ${SCHEDULES_MAX} schedules`);
      const schedule: Schedule = {
        id: `s${seq + 1}`,
        name: request.name,
        to: request.to,
        subject: request.subject ?? '',
        body: request.body,
        rule: request.rule,
        enabled: request.enabled ?? true,
        createdAt: now(),
        lastRunAt: null,
        lastResult: null,
      };
      checkSubject(schedule);
      seq += 1;
      const e: Entry = { schedule, rule: ruleOf(schedule.rule), next: null };
      e.next = nextOf(e);
      entries.push(e);
      await changed();
      return view(e);
    },

    async update(id, input) {
      const e = entryOf(id);
      const patch = validate(input, false);
      const next: Schedule = { ...e.schedule, ...patch };
      checkSubject(next);
      e.schedule = next;
      e.rule = ruleOf(next.rule);
      e.next = nextOf(e);
      await changed();
      return view(e);
    },

    async remove(id) {
      const e = entryOf(id);
      entries = entries.filter((x) => x !== e);
      await changed();
    },

    async run(id) {
      const e = entryOf(id);
      fire(e);
      await changed();
      return view(e);
    },

    close() {
      closed = true;
      if (timer !== null) options.clearTimer(timer);
      timer = null;
      return chain.then(() => undefined);
    },
  };
}
