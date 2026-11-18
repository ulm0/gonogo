import { SUBJECT_MAX_CHARS } from '../shared/protocol.js';
import type { ActivityItem, AgentView, UserMessageRequest } from '../shared/protocol.js';
import { positionById } from '../shared/positions.js';
import { plainActivityNote } from './wording.js';

// What the comm loop shows, kept out of Activity.tsx so that it can be tested without a DOM.

export const FILTERS = [
  { id: 'all', label: 'ALL' },
  { id: 'you', label: 'TO YOU' },
  { id: 'held', label: 'HELD' },
  { id: 'lost', label: 'UNDELIVERED' },
] as const;
export type FilterId = (typeof FILTERS)[number]['id'];

const MATCHES: Record<FilterId, (item: ActivityItem) => boolean> = {
  all: () => true,
  you: (item) => item.to === 'user',
  held: (item) => item.status === 'held',
  lost: (item) => item.status === 'undelivered',
};

export const filterItems = (items: readonly ActivityItem[], filter: FilterId): ActivityItem[] => items.filter(MATCHES[filter]);

export function filterCounts(items: readonly ActivityItem[]): Record<FilterId, number> {
  const counts: Record<FilterId, number> = { all: 0, you: 0, held: 0, lost: 0 };
  for (const item of items) for (const { id } of FILTERS) if (MATCHES[id](item)) counts[id] += 1;
  return counts;
}

export interface Chip {
  text: string;
  tone: 'lit' | 'amber' | 'nogo' | 'quiet';
}

/** The status chip of a row: the three that ask for attention are lit, amber and orange, the rest are quiet. */
export function chipOf(item: ActivityItem): Chip {
  switch (item.status) {
    case 'to_user':
      return { text: 'TO YOU', tone: 'lit' };
    case 'held':
      return { text: 'HELD', tone: 'amber' };
    case 'undelivered':
      return { text: 'UNDELIVERED', tone: 'nogo' };
    default:
      return { text: item.status.toUpperCase(), tone: 'quiet' };
  }
}

/** What the room calls a name: DIRECTOR for the human, FLIGHT for the boss, the call sign of a seat, else the name in capitals. */
export function legendOf(name: string, agents: Readonly<Record<string, AgentView>>): string {
  if (name === 'user') return 'DIRECTOR';
  const agent = Object.hasOwn(agents, name) ? agents[name] : undefined;
  if (agent?.boss === true) return 'FLIGHT';
  return (positionById(agent?.position)?.callSign ?? name).toUpperCase();
}

export const routeText = (item: ActivityItem, agents: Readonly<Record<string, AgentView>>): string =>
  `${legendOf(item.from, agents)} › ${legendOf(item.to, agents)}`;

/** The subject, or the first line of the body when the sender left it empty. */
export function subjectOf(item: Pick<ActivityItem, 'subject' | 'body'>): string {
  if (item.subject.trim() !== '') return item.subject;
  return item.body.trim().split('\n')[0] ?? '';
}

export const noteOf = (item: ActivityItem): string => (item.note === null ? '' : plainActivityNote(item.note));

/** The reply to a message for the Director goes to its sender, in its thread. */
export function replyRequest(item: Pick<ActivityItem, 'id' | 'from' | 'subject'>, body: string): UserMessageRequest {
  const subject = item.subject.trim() === '' ? '' : `Re: ${item.subject}`.slice(0, SUBJECT_MAX_CHARS);
  return { to: item.from, subject, body, inReplyTo: item.id };
}

/** The newest messages to or from one agent (the list is newest first). */
export const trafficOf = (items: readonly ActivityItem[], name: string, limit = 3): ActivityItem[] =>
  items.filter((item) => item.from === name || item.to === name).slice(0, limit);

/** The messages to or from one agent, all of them (the TRAFFIC filter); null is everyone. */
export const ofAgent = (items: readonly ActivityItem[], name: string | null): readonly ActivityItem[] => (name === null ? items : items.filter((item) => item.from === name || item.to === name));
