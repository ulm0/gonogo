import type { ActivityItem, AgentView, FuelGauge, FuelLimits, FuelWindow, GovernorView, PollView } from '../shared/protocol.js';
import { HISTORY_WINDOW_MS, MAX_AGENTS, providerInfo, STATIC_FIRE_POSITIONS } from '../shared/protocol.js';

// Pure logic of the wall (mission, sequence, T-minus, Max Q), kept out of Wall.tsx so that it can be tested without a DOM.

/** Call signs by agent name, as the room shows them (room.ts builds it). A name that is not in it is shown in capitals. */
export type Legends = Readonly<Record<string, string>>;

export const legendOf = (legends: Legends, name: string): string => (Object.hasOwn(legends, name) ? legends[name] : name.toUpperCase());

/* ---- mission ---- */

export interface Mission {
  text: string;
  /** Server time of the message: the clock counts up from here. */
  at: number;
}

const firstLine = (text: string): string => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

/**
 * The latest message from the Director to the boss that is not a T-minus poll or a Relief answer. Its subject, or the first line of its body
 * when the subject says nothing ("Brief" is what the brief box sends). `activity` is newest first.
 */
export function missionOf(activity: readonly ActivityItem[], boss: string | null): Mission | null {
  if (boss === null) return null;
  const item = activity.find((i) => i.from === 'user' && i.to === boss && !i.subject.startsWith('T-minus:') && !i.subject.startsWith('Relief:'));
  if (item === undefined) return null;
  const subject = item.subject.trim();
  const fromBody = firstLine(item.body);
  const text = subject === '' || subject.toLowerCase() === 'brief' ? fromBody || subject : subject;
  return { text, at: item.at };
}

/** `HH:MM:SS` for a duration in ms; hours do not stop at 99, a negative duration (a clock that runs behind) is zero. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

/** `22:31`, local time. */
export function briefedText(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---- sequence ---- */

export type SeqKind = 'work' | 'needs' | 'custom';
export interface SeqSpan {
  kind: SeqKind;
  /** Percent of the window, 0 = HISTORY_WINDOW_MS ago, 100 = now. */
  from: number;
  to: number;
}

const percent = (value: number): number => Math.round(value * 100) / 100;

/** The spans of one agent: its history cut to the window; only working and needs-you states draw. */
export function sequenceSpans(agent: Pick<AgentView, 'history' | 'provider'>, now: number, windowMs = HISTORY_WINDOW_MS): SeqSpan[] {
  const start = now - windowMs;
  const spans: SeqSpan[] = [];
  agent.history.forEach((change, i) => {
    const kind: SeqKind | null = change.state === 'working' ? (agent.provider === 'custom' ? 'custom' : 'work') : change.state === 'needs_you' ? 'needs' : null;
    if (kind === null) return;
    const from = Math.max(change.at, start);
    const to = Math.min(i + 1 < agent.history.length ? agent.history[i + 1].at : now, now);
    if (to > from) spans.push({ kind, from: percent(((from - start) / windowMs) * 100), to: percent(((to - start) / windowMs) * 100) });
  });
  return spans;
}

/** `38 s`, `2 m`, `3 h`: time in a state, rounded down. */
export const sinceText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} m` : `${Math.floor(s / 3600)} h`;
};

const join = (names: readonly string[]): string => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The accessible label of the sequence: who works now and who has needed the Director for how long. */
export function sequenceLabel(agents: readonly AgentView[], legends: Legends, now: number): string {
  const working = agents.filter((a) => a.state === 'working').map((a) => legendOf(legends, a.name));
  const needing = agents.filter((a) => a.state === 'needs_you');
  const parts: string[] = [];
  if (working.length > 0) parts.push(`${join(working)} ${working.length === 1 ? 'is' : 'are'} working now`);
  for (const a of needing) parts.push(`${legendOf(legends, a.name)} has needed you for ${sinceText(now - a.stateSince)}`);
  return parts.length > 0 ? parts.join('; ') : 'Nobody is working and nobody needs you';
}

/* ---- T-minus ---- */

export type WallTone = 'none' | 'lit' | 'go' | 'nogo';

export interface PollWord {
  word: string;
  /** `3/5` while polling, else null. */
  count: string | null;
  /** The wall floods in this tone; none = the dark wall. */
  tone: WallTone;
  /** The word is the ghost grey (no poll). */
  ghost: boolean;
}

/** The giant word of T-minus and the colour the whole wall takes with it. A hold with a no-go is NO-GO; a hold the Director called is HOLD. */
export function pollWord(poll: PollView | null): PollWord {
  if (poll === null) return { word: 'STANDBY', count: null, tone: 'none', ghost: true };
  switch (poll.status) {
    case 'open':
      return { word: 'POLLING', count: `${poll.entries.filter((e) => e.vote !== null).length}/${poll.entries.length}`, tone: 'none', ghost: false };
    case 'go':
      return { word: 'GO', count: null, tone: 'go', ghost: false };
    case 'hold':
      return poll.entries.some((e) => e.vote === 'no-go')
        ? { word: 'NO-GO', count: null, tone: 'nogo', ghost: false }
        : { word: 'HOLD', count: null, tone: 'lit', ghost: false };
    case 'aborted':
      return { word: 'ABORTED', count: null, tone: 'nogo', ghost: false };
  }
}

/** Agents a poll started from the wall asks: running agents with the gonogo tools except the boss (the server's own default). */
export function pollTargets(agents: readonly AgentView[]): AgentView[] {
  return agents.filter((a) => a.state !== 'stopped' && a.transition === null && providerInfo(a.provider).mcp && !a.boss);
}

/** Agents a static fire briefs: the poll targets in the SIMSUP or RETRO position (the server picks the same). */
export function fireTargets(agents: readonly AgentView[]): AgentView[] {
  return pollTargets(agents).filter((a) => (STATIC_FIRE_POSITIONS as readonly string[]).includes(a.position ?? ''));
}

/** The heading of the poll block: STATIC FIRE while one is on the wall, else T-MINUS. */
export const pollHeading = (poll: PollView | null): string => (poll?.subject === undefined ? 'T-MINUS' : 'STATIC FIRE');

export type Verdict = 'GO' | 'NO-GO' | 'WAIT' | 'READY';
export interface VoteChip {
  agent: string;
  text: string;
  verdict: Verdict;
}

/** One chip per entry, in the order of the poll: `GUIDO GO`. With no poll, one READY chip per console that can be asked. */
export function voteChips(poll: PollView | null, targets: readonly AgentView[], legends: Legends): VoteChip[] {
  if (poll === null) return targets.map((a) => ({ agent: a.name, verdict: 'READY', text: `${legendOf(legends, a.name)} READY` }));
  return poll.entries.map((entry) => {
    const verdict: Verdict = entry.vote === 'go' ? 'GO' : entry.vote === 'no-go' ? 'NO-GO' : 'WAIT';
    return { agent: entry.agent, verdict, text: `${legendOf(legends, entry.agent)} ${verdict}` };
  });
}

/** The note under the word: the server's note, then each reason given so far. With no poll, who can be asked. */
export function noteLine(poll: PollView | null, targets: readonly AgentView[], legends: Legends): string {
  if (poll === null) {
    if (targets.length === 0) return 'No poll. Nobody to ask: no running Claude agent besides FLIGHT.';
    return `No poll. ${targets.length} ${targets.length === 1 ? 'console' : 'consoles'} can be asked.`;
  }
  const reasons = poll.entries.flatMap((e) => (e.vote !== null && e.reason !== '' ? [`${legendOf(legends, e.agent)}: ${e.reason}`] : []));
  return [poll.subject ?? '', poll.note, ...reasons].filter((part) => part !== '').join(' · ');
}

export type PollButton = 'poll' | 'hold' | 'abort' | 'clear';

/** Which buttons the poll in this status offers: poll when there is none, hold and abort while open, abort and clear on hold, clear when finished. */
export function pollButtons(poll: PollView | null): PollButton[] {
  if (poll === null) return ['poll'];
  switch (poll.status) {
    case 'open':
      return ['hold', 'abort'];
    case 'hold':
      return ['abort', 'clear'];
    case 'go':
    case 'aborted':
      return ['clear'];
  }
}

/* ---- Max Q ---- */

export interface Gauge {
  /** Number of segments: the limit; 0 when the limit is off. */
  total: number;
  filled: number;
  /** At the limit or beyond it: the segments are all lit. */
  full: boolean;
  /** More agents work than the limit allows (the limit was lowered under them). */
  over: boolean;
}

export function gaugeSegments(governor: GovernorView): Gauge {
  const total = governor.limit ?? 0;
  const filled = Math.min(governor.working, total);
  return { total, filled, full: total > 0 && governor.working >= total, over: total > 0 && governor.working > total };
}

/** The limit after a click on minus or plus; null when the step is not possible. From "off" plus starts at the number working (at least 1). */
export function stepLimit(governor: GovernorView, direction: 'minus' | 'plus'): number | null {
  const { limit } = governor;
  if (direction === 'minus') return limit !== null && limit > 1 ? limit - 1 : null;
  if (limit === null) return Math.min(MAX_AGENTS, Math.max(1, governor.working));
  return limit < MAX_AGENTS ? limit + 1 : null;
}

/** The text of the live region for Max Q: the limit and what waits, not the working count (that changes too often to announce). */
export function governorSummary(governor: GovernorView): string {
  const limit = governor.limit === null ? 'Max Q off' : `Max Q limit ${governor.limit}`;
  return governor.holding > 0 ? `${limit}, holding ${governor.holding}` : limit;
}

/* ---- Propellant ---- */

const WARN_AT = 0.8;

export type FuelLevel = 'none' | 'ok' | 'warn' | 'over';

/** How full the window is: no limit, under 80 %, from 80 %, or at or past the limit. */
export function fuelLevel(gauge: FuelGauge, window: FuelWindow): FuelLevel {
  const limit = gauge.limits[window];
  if (limit === undefined) return 'none';
  const used = gauge.used[window];
  return used >= limit ? 'over' : used >= limit * WARN_AT ? 'warn' : 'ok';
}

/** The limits with this window set to `tokens`, or removed for null. */
export function withLimit(limits: FuelLimits, window: FuelWindow, tokens: number | null): FuelLimits {
  const next: FuelLimits = { ...limits };
  if (tokens === null) delete next[window];
  else next[window] = tokens;
  return next;
}

