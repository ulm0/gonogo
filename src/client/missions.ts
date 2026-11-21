/**
 * Missions (docs/missions-spec.md): the words and the small logic of the page, with no React. Progress is derived from the tasks
 * (a mission stores none), the keys a status offers, and the select a task uses to name its mission.
 */
import { tokenText } from '../shared/fuel.js';
import { moneyText } from '../shared/prices.js';
import { RITUAL_ITEM_MAX_CHARS, RITUAL_ITEMS_MAX } from '../shared/protocol.js';
import type { Mission, MissionStatus, RitualItem, SpendOf, Task } from '../shared/protocol.js';

export const STATUS_LABELS: Readonly<Record<MissionStatus, string>> = { planned: 'PLANNED', active: 'ACTIVE', paused: 'PAUSED', done: 'DONE', aborted: 'ABORTED' };
/** The chip tone of a status: an active mission is lit, a finished one is quiet. */
export const STATUS_TONES: Readonly<Record<MissionStatus, 'go' | 'amber' | 'quiet' | 'nogo'>> = { planned: 'quiet', active: 'go', paused: 'amber', done: 'quiet', aborted: 'nogo' };

export const tasksOf = (tasks: readonly Task[], missionId: string): Task[] => tasks.filter((t) => t.missionId === missionId);

/** `3 / 7`: tasks done out of all linked tasks. A mission with no task says so instead of `0 / 0`. */
export function progressOf(tasks: readonly Task[], missionId: string): { done: number; total: number; text: string } {
  const mine = tasksOf(tasks, missionId);
  const done = mine.filter((t) => t.status === 'done').length;
  return { done, total: mine.length, text: mine.length === 0 ? 'no tasks' : `${done} / ${mine.length}` };
}

/** The keys a mission shows, in order: START (or RESUME) and PAUSE and DONE and ABORT, each only when it changes something. */
export function actionsOf(status: MissionStatus): Array<{ to: MissionStatus; label: string }> {
  const out: Array<{ to: MissionStatus; label: string }> = [];
  if (status !== 'active') out.push({ to: 'active', label: status === 'paused' ? 'RESUME' : status === 'planned' ? 'START' : 'REOPEN' });
  if (status === 'active') out.push({ to: 'paused', label: 'PAUSE' });
  if (status !== 'done') out.push({ to: 'done', label: 'DONE' });
  if (status !== 'aborted' && status !== 'done') out.push({ to: 'aborted', label: 'ABORT' });
  return out;
}

/** Missions before a finished one, the active first, then by the time of the last change, newest first. */
export function sortMissions(missions: readonly Mission[]): Mission[] {
  const rank: Record<MissionStatus, number> = { active: 0, paused: 1, planned: 2, done: 3, aborted: 3 };
  return [...missions].sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt);
}

/** The select of a task: no mission, then every unfinished mission (and the one it has now, even when finished). */
export function missionOptions(missions: readonly Mission[], keep: string | null): Array<{ value: string; label: string }> {
  const out = [{ value: '', label: 'No mission' }];
  for (const m of sortMissions(missions)) {
    if (m.status === 'done' || m.status === 'aborted') {
      if (m.id === keep) out.push({ value: m.id, label: `${m.name} (${m.status})` });
    } else out.push({ value: m.id, label: m.name });
  }
  if (keep !== null && !out.some((o) => o.value === keep)) out.push({ value: keep, label: `${keep} (gone)` });
  return out;
}

export const nameOf = (missions: readonly Mission[], id: string): string => missions.find((m) => m.id === id)?.name ?? id;

/** Values of the new-mission form. `lead` is '' for the boss (the server's default). */
export interface MissionValues {
  name: string;
  goal: string;
  lead: string;
}
export type MissionProblems = Partial<Record<'name' | 'goal', string>>;
export const emptyMissionValues = (draft?: { name: string; goal: string } | null): MissionValues => ({ name: draft?.name ?? '', goal: draft?.goal ?? '', lead: '' });

export function validateMission(v: MissionValues, nameMax: number, goalMax: number): MissionProblems {
  const out: MissionProblems = {};
  const name = v.name.trim();
  if (name === '') out.name = 'Give it a name.';
  else if (name.length > nameMax) out.name = `At most ${nameMax} characters.`;
  else if (name.includes('\n')) out.name = 'One line.';
  if (v.goal.length > goalMax) out.goal = `At most ${goalMax} characters.`;
  return out;
}

/** The brief box's text as a draft for a new mission: the first line (cut) is the name, the whole text the goal. */
export function draftFromBrief(text: string, nameMax: number): { name: string; goal: string } {
  const first = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  const name = first.length > nameMax ? `${first.slice(0, nameMax - 1)}…` : first;
  return { name, goal: text.trim() };
}

/** What a mission or a task has cost, in words: "$1.20", "$1.20 of $10.00", with the tokens that have no price. Empty when nothing was spent and there is no budget. */
export function spendText(spend: SpendOf | undefined): string {
  if (spend === undefined) return '';
  const parts: string[] = [];
  if (spend.usd > 0 || spend.budget !== undefined) parts.push(spend.budget === undefined ? moneyText(spend.usd) : `${moneyText(spend.usd)} of ${moneyText(spend.budget)}`);
  if (spend.unpriced > 0) parts.push(`${tokenText(spend.unpriced)} tokens unpriced`);
  return parts.join(' · ');
}

/** The share of a mission's budget spent, 0 to 1 and over; null with no budget. */
export const budgetShare = (spend: SpendOf | undefined): number | null => (spend?.budget === undefined ? null : spend.usd / spend.budget);

/** How much of a mission's closing checklist is left: `2 of 5 closing items left`, `all 5 closing items ticked`, or '' when it has none. Never a gate. */
export function ritualProgress(mission: Pick<Mission, 'ritual'>): { left: number; total: number; text: string } {
  const items = mission.ritual ?? [];
  const left = items.filter((i) => !i.done).length;
  if (items.length === 0) return { left: 0, total: 0, text: '' };
  return { left, total: items.length, text: left === 0 ? `All ${items.length} closing ${items.length === 1 ? 'item is' : 'items are'} ticked.` : `${left} of ${items.length} closing ${items.length === 1 ? 'item' : 'items'} left.` };
}

/** The words that say where a line came from, or '' for the Director's own: a line an agent wrote is never passed off as the Director's. */
export const sourceText = (item: RitualItem): string => (item.from === 'agent' ? `set by ${item.agent ?? 'an agent'}` : item.from === 'room' ? 'room template' : item.from === 'repo' ? 'from the repo' : '');

/** What is wrong with the text of a line before it is sent, or null. */
export function ritualTextProblem(text: string, count: number, adding: boolean): string | null {
  const t = text.trim();
  if (t === '') return 'Write the line.';
  if (t.length > RITUAL_ITEM_MAX_CHARS) return `At most ${RITUAL_ITEM_MAX_CHARS} characters (${t.length} now).`;
  if (/[\r\n]/.test(t)) return 'One line only.';
  if (adding && count >= RITUAL_ITEMS_MAX) return `At most ${RITUAL_ITEMS_MAX} lines.`;
  return null;
}

/** Who ticked a line and when, for under it; '' when it is not ticked. */
export const tickedText = (item: RitualItem): string => (item.done ? `ticked${item.by === undefined ? '' : ` by ${item.by === 'user' ? 'you' : item.by}`}${item.at === undefined ? '' : ` ${new Date(item.at).toLocaleString()}`}` : '');
