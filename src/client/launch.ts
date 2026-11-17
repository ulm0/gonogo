import { nextFires, parseCron } from '../shared/cron.js';
import { BODY_MAX_CHARS, CRON_MAX_CHARS, providerInfo, SCHEDULE_NAME_MAX_CHARS, scheduleSubject, SUBJECT_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView, ScheduleRequest, ScheduleView } from '../shared/protocol.js';
import { legendOf } from './loop.js';

// What Launch Window shows and asks, kept out of LaunchWindow.tsx so that it can be tested without a DOM.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const pad = (n: number): string => String(n).padStart(2, '0');

/** "in 3 h, 09:00 Mon": how far away and when, in the clock of this browser. A week or more away it also names the date. */
export function whenText(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000);
  const hours = Math.round(minutes / 60);
  const far = minutes < 1 ? 'now' : minutes < 60 ? `in ${minutes} min` : hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
  const d = new Date(at);
  const date = at - now >= 6 * 86_400_000 ? ` ${d.getDate()} ${MONTHS[d.getMonth()]}` : '';
  return `${far}, ${pad(d.getHours())}:${pad(d.getMinutes())} ${DAYS[d.getDay()]}${date}`;
}

/** The next fire of a schedule for its row: words, "off" or "never". */
export function nextText(schedule: ScheduleView, now: number): string {
  if (!schedule.enabled) return 'off';
  return schedule.nextAt === null ? 'never' : whenText(schedule.nextAt, now);
}

/** The last run of a schedule for its row. */
export function lastText(schedule: ScheduleView): string {
  if (schedule.lastRunAt === null) return 'Not run yet';
  const d = new Date(schedule.lastRunAt);
  return `Ran ${pad(d.getHours())}:${pad(d.getMinutes())} ${DAYS[d.getDay()]}${schedule.lastResult === null ? '' : `: ${schedule.lastResult}`}`;
}

/** What a rule field says as you type: the next three fires, or why it is not a rule. */
export function previewOf(rule: string, now: number): { times: string[]; problem: string | null } {
  if (rule.trim() === '') return { times: [], problem: null };
  const parsed = parseCron(rule);
  if (typeof parsed === 'string') return { times: [], problem: parsed };
  return { times: nextFires(parsed, now, 3).map((at) => whenText(at, now)), problem: null };
}

/** The server's zone differs from this browser's: the times on this page are in the browser's zone, the rules run in the server's. */
export function zoneNote(server: string, browser: string): string | null {
  return server === browser ? null : `This page shows times in ${browser}; the rules run in ${server}.`;
}

export interface Values {
  name: string;
  to: string;
  subject: string;
  body: string;
  rule: string;
  enabled: boolean;
}
export type Field = 'name' | 'to' | 'subject' | 'body' | 'rule';
export type Problems = Partial<Record<Field, string>>;
export const FIELDS: readonly Field[] = ['name', 'to', 'subject', 'body', 'rule'];

export const emptyValues = (to: string): Values => ({ name: '', to, subject: '', body: '', rule: '', enabled: true });
export const valuesOf = (s: ScheduleView): Values => ({ name: s.name, to: s.to, subject: s.subject, body: s.body, rule: s.rule, enabled: s.enabled });

export function validate(v: Values): Problems {
  const problems: Problems = {};
  const name = v.name.trim();
  if (name === '') problems.name = 'Give it a name.';
  else if (name.length > SCHEDULE_NAME_MAX_CHARS) problems.name = `At most ${SCHEDULE_NAME_MAX_CHARS} characters.`;
  if (v.to === '') problems.to = 'Pick who gets it.';
  if (scheduleSubject(name, v.subject.trim()).length > SUBJECT_MAX_CHARS) problems.subject = `The name and the subject together are too long (at most ${SUBJECT_MAX_CHARS - 'Launch Window: : '.length}).`;
  if (v.body.trim() === '') problems.body = 'Write the message.';
  else if (v.body.length > BODY_MAX_CHARS) problems.body = `At most ${BODY_MAX_CHARS} characters.`;
  if (v.rule.trim() === '') problems.rule = 'Give the rule.';
  else if (v.rule.length > CRON_MAX_CHARS) problems.rule = `At most ${CRON_MAX_CHARS} characters.`;
  else {
    const parsed = parseCron(v.rule);
    if (typeof parsed === 'string') problems.rule = parsed;
  }
  return problems;
}

export const requestOf = (v: Values): ScheduleRequest => ({ name: v.name.trim(), to: v.to, subject: v.subject.trim(), body: v.body, rule: v.rule.trim(), enabled: v.enabled });

export interface Recipient {
  value: string;
  label: string;
}

/** Who a schedule can write to: FLIGHT as "boss" (it follows whoever is the boss), then every console with the gonogo tools. `keep` stays in the list even when it is gone. */
export function recipients(agents: readonly AgentView[], all: Readonly<Record<string, AgentView>>, keep: string | null): Recipient[] {
  const out: Recipient[] = [{ value: 'boss', label: 'FLIGHT (the boss)' }];
  for (const a of agents) if (!a.boss && providerInfo(a.provider).mcp) out.push({ value: a.name, label: legendOf(a.name, all) });
  if (keep !== null && !out.some((r) => r.value === keep)) out.push({ value: keep, label: `${keep} (${Object.hasOwn(all, keep) ? 'cannot read mail' : 'not in the room'})` });
  return out;
}

/** The legend of a schedule's recipient for a row. */
export const toText = (to: string, agents: Readonly<Record<string, AgentView>>): string => (to === 'boss' ? 'FLIGHT' : Object.hasOwn(agents, to) ? legendOf(to, agents) : to.toUpperCase());
