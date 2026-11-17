import { providerInfo, TASK_DETAIL_MAX_CHARS, TASK_TITLE_MAX_CHARS } from '../shared/protocol.js';
import type { AgentView, Task, TaskRequest, TaskStatus } from '../shared/protocol.js';
import { legendOf } from './loop.js';
import { ledOf, tileKind } from './room.js';
import type { TileKind } from './room.js';

// What Flight Plan shows and asks, kept out of FlightPlan.tsx so that it can be tested without a DOM.

/** The five columns, left to right. Blocked sits before done: a stuck card is closer to the work than a finished one. */
export const COLUMNS: readonly { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'TODO' },
  { status: 'doing', label: 'DOING' },
  { status: 'review', label: 'REVIEW' },
  { status: 'blocked', label: 'BLOCKED' },
  { status: 'done', label: 'DONE' },
];

export const labelOf = (status: TaskStatus): string => COLUMNS.find((c) => c.status === status)?.label ?? status.toUpperCase();

/** The tasks of each column: the order they were made, except done, where the newest change is first. */
export function columnsOf(tasks: readonly Task[]): Record<TaskStatus, Task[]> {
  const out: Record<TaskStatus, Task[]> = { todo: [], doing: [], review: [], blocked: [], done: [] };
  for (const task of tasks) out[task.status].push(task);
  out.done.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** The tasks that are being worked on or are stuck: the small count on the top bar and the phone bar. */
export function activeOf(tasks: readonly Task[]): { doing: number; blocked: number } {
  let doing = 0;
  let blocked = 0;
  for (const task of tasks) {
    if (task.status === 'doing') doing += 1;
    else if (task.status === 'blocked') blocked += 1;
  }
  return { doing, blocked };
}

/** "2 doing, 1 blocked", or "" when nothing is. */
export function activeText({ doing, blocked }: { doing: number; blocked: number }): string {
  return [doing > 0 ? `${doing} doing` : '', blocked > 0 ? `${blocked} blocked` : ''].filter(Boolean).join(', ');
}

/** The call sign of a task's assignee for its card, or UNASSIGNED. */
export const assigneeText = (task: Task, agents: Readonly<Record<string, AgentView>>): string => (task.assignee === null ? 'UNASSIGNED' : legendOf(task.assignee, agents));

/** The LED of a card: the state of the assignee's console. An assignee that is gone reads as stopped; nobody has no light. */
export function ledKindOf(task: Task, agents: Readonly<Record<string, AgentView>>): { kind: TileKind | undefined; on: boolean; blink: boolean } {
  if (task.assignee === null) return { kind: undefined, on: false, blink: false };
  const agent = Object.hasOwn(agents, task.assignee) ? agents[task.assignee] : undefined;
  const kind = agent === undefined ? 'stopped' : tileKind(agent);
  return { kind, ...ledOf(kind) };
}

export interface Assignee {
  value: string;
  label: string;
}

/** Who a task can be given to: nobody, then every console that can read mail (FLIGHT too). `keep` stays in the list even when it is gone. */
export function assignees(agents: readonly AgentView[], all: Readonly<Record<string, AgentView>>, keep: string | null): Assignee[] {
  const out: Assignee[] = [{ value: '', label: 'Nobody' }];
  for (const a of agents) if (providerInfo(a.provider).mcp) out.push({ value: a.name, label: legendOf(a.name, all) });
  if (keep !== null && !out.some((o) => o.value === keep)) out.push({ value: keep, label: `${keep} (${Object.hasOwn(all, keep) ? 'cannot read mail' : 'not in the room'})` });
  return out;
}

export interface Values {
  title: string;
  detail: string;
  /** An agent name, or '' for nobody. */
  assignee: string;
}
export type Field = 'title' | 'detail' | 'assignee';
export type Problems = Partial<Record<Field, string>>;
export const FIELDS: readonly Field[] = ['title', 'detail', 'assignee'];

export const emptyValues = (): Values => ({ title: '', detail: '', assignee: '' });

export function validate(v: Values): Problems {
  const problems: Problems = {};
  const title = v.title.trim();
  if (title === '') problems.title = 'Give it a title.';
  else if (title.length > TASK_TITLE_MAX_CHARS) problems.title = `At most ${TASK_TITLE_MAX_CHARS} characters.`;
  else if (title.includes('\n')) problems.title = 'One line.';
  if (v.detail.length > TASK_DETAIL_MAX_CHARS) problems.detail = `At most ${TASK_DETAIL_MAX_CHARS} characters.`;
  return problems;
}

export const requestOf = (v: Values): TaskRequest => ({ title: v.title.trim(), detail: v.detail.trim(), assignee: v.assignee === '' ? null : v.assignee });

/** The id of a card's element, for the focus that follows a move. */
export const cardId = (id: string): string => `plan-card-${id}`;
