/**
 * Launch Window's rules: five fields (minute hour day-of-month month day-of-week) in the local time zone of the machine
 * that runs this code. The server runs them in its own zone (TZ); a browser previews them in its own. No imports, so the
 * client and the server compile the same file and agree on every rule.
 *
 * Each field is a list of `*`, a number, a range `a-b` or `*` or a range with a step (`*` `/n`, `a-b/n`). Months
 * take jan to dec and days of week sun to sat (any case); day of week 7 is Sunday. When both day fields are limited
 * (neither starts with `*`) a day matches when either does, as in Vixie cron.
 *
 * shortcut: a time that does not exist (the hour a clock skips in spring) does not fire that day, and one that happens
 * twice (the hour a clock repeats in autumn) fires once; Vixie cron runs the first late. Add that if it ever matters.
 */

export interface CronRule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 to 6, 0 = Sunday. */
  weekdays: ReadonlySet<number>;
  /** The day-of-month field starts with `*`. */
  daysStar: boolean;
  /** The day-of-week field starts with `*`. */
  weekdaysStar: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day of week', min: 0, max: 7, names: DAY_NAMES },
];
/** Days in each month, February with its leap day: a rule that needs more never fires. */
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** The most a rule can look ahead: a 29 February needs up to eight years. */
const HORIZON_MS = 9 * 366 * 86_400_000;
const MAX_STEPS = 200_000;

function value(text: string, spec: FieldSpec): number | string {
  let n = NaN;
  if (/^\d{1,3}$/.test(text)) n = Number(text);
  else if (spec.names) {
    const at = spec.names.indexOf(text.toLowerCase());
    if (at >= 0) n = at + (spec.name === 'month' ? 1 : 0);
  }
  if (Number.isNaN(n)) return `${spec.name}: "${text}" is not a number${spec.names ? ' or a name' : ''}`;
  if (n < spec.min || n > spec.max) return `${spec.name}: ${n} is not from ${spec.min} to ${spec.max}`;
  return n;
}

function field(text: string, spec: FieldSpec): Set<number> | string {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', step, extra] = part.split('/');
    if (part === '' || extra !== undefined) return `${spec.name}: "${part}" is not a value, a range or a step`;
    let from: number | string;
    let to: number | string;
    if (range === '*') {
      from = spec.min;
      to = spec.name === 'day of week' ? 6 : spec.max;
    } else if (range.includes('-')) {
      const [a = '', b = '', more] = range.split('-');
      if (more !== undefined) return `${spec.name}: "${range}" is not a range`;
      from = value(a, spec);
      to = value(b, spec);
    } else {
      from = value(range, spec);
      to = from;
      if (step !== undefined) return `${spec.name}: a step needs * or a range, as in */5 or 1-30/5`;
    }
    if (typeof from === 'string') return from;
    if (typeof to === 'string') return to;
    if (from > to) return `${spec.name}: the range ${range} ends before it starts`;
    let by = 1;
    if (step !== undefined) {
      if (!/^\d{1,3}$/.test(step) || Number(step) < 1) return `${spec.name}: the step "${step}" is not a positive number`;
      by = Number(step);
    }
    for (let v = from; v <= to; v += by) out.add(spec.name === 'day of week' && v === 7 ? 0 : v);
  }
  return out;
}

/** A rule from its text, or the reason it is not one (one line, for the person who typed it). */
export function parseCron(text: string): CronRule | string {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return 'a rule has 5 fields: minute hour day-of-month month day-of-week';
  const sets: Array<Set<number>> = [];
  for (const [i, spec] of FIELDS.entries()) {
    const set = field(parts[i] ?? '', spec);
    if (typeof set === 'string') return set;
    sets.push(set);
  }
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const rule: CronRule = { minutes, hours, days, months, weekdays, daysStar: parts[2]?.startsWith('*') === true, weekdaysStar: parts[4]?.startsWith('*') === true };
  // With the day of week free, only the days of the month count: 31 February is a rule that never fires.
  if (!rule.daysStar && rule.weekdaysStar && ![...months].some((m) => [...days].some((d) => d <= (MONTH_DAYS[m] ?? 0)))) {
    return 'day of month: that day never comes in the months given';
  }
  return rule;
}

function dayMatches(rule: CronRule, d: Date): boolean {
  const day = rule.days.has(d.getDate());
  const weekday = rule.weekdays.has(d.getDay());
  return rule.daysStar || rule.weekdaysStar ? day && weekday : day || weekday;
}

/** The first minute after `after` (ms epoch) the rule fires, in local time, or null when none comes within nine years. */
export function nextFire(rule: CronRule, after: number): number | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + HORIZON_MS;
  // Each step moves to the start of the next month, day, hour or minute, so a rule is found in a few hundred steps.
  for (let steps = 0; steps < MAX_STEPS && d.getTime() <= limit; steps += 1) {
    if (!rule.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(rule, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!rule.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!rule.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d.getTime();
    }
  }
  return null;
}

/** The next `count` fire times after `after`. */
export function nextFires(rule: CronRule, after: number, count: number): number[] {
  const out: number[] = [];
  let at = after;
  while (out.length < count) {
    const next = nextFire(rule, at);
    if (next === null) break;
    out.push(next);
    at = next;
  }
  return out;
}
