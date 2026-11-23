/** Docking 2 (docs/docking-collab-spec.md): the words and the choices of the link views, with no React. */
import type { Deliverable, DockView, LinkEventView, LinkState, LinkView, TaskStatus } from '../shared/protocol.js';
import { atText } from './uplink.js';

export type LinkItem = LinkView;
export type TrailItem = LinkEventView;

const STATUS_WORDS: Record<TaskStatus, string> = { todo: 'to do', doing: 'doing', blocked: 'blocked', review: 'in review', done: 'done' };

/** The one line of a card for a link, plain words, never colour only: "at lab: doing · "waiting on a key"", "at lab → at ops: doing". */
export function linkLine(link: LinkItem): string {
  const peer = link.peerName;
  if (link.role === 'receiver') {
    const from = `from ${peer}`;
    switch (link.state) {
      case 'delivered': return `${from}: delivered, waiting for them to accept`;
      case 'returned': return `${from}: you gave it back`;
      case 'recalled': return `${from}: they withdrew it`;
      case 'done': return `${from}: accepted`;
      case 'detached': return `${from}: undocked`;
      default: return link.chain === undefined || link.chain.length === 0 ? from : `${from} (${link.chain.map((h) => `${h.station} ${h.task}`).join(' → ')})`;
    }
  }
  switch (link.state) {
    case 'offered': return `offered to ${peer}, not taken yet`;
    case 'delivered': return `delivered by ${peer}: ready for you to accept`;
    case 'returned': return `returned by ${peer}`;
    case 'recalled': return `you withdrew it from ${peer}`;
    case 'done': return `accepted from ${peer}`;
    case 'refused': return `${peer} refused it`;
    case 'detached': return `undocked from ${peer}${link.peerStatus === null ? '' : ` (last known: ${STATUS_WORDS[link.peerStatus as TaskStatus]})`}`;
    default: {
      // a station further on reported through this one: its own word comes after the arrow ("ops: doing")
      if (link.via !== undefined) return `at ${peer} → ${link.via}`;
      return `at ${peer}: ${link.peerStatus === null ? 'taken' : STATUS_WORDS[link.peerStatus as TaskStatus]}`;
    }
  }
}

/** Said when the other station does not answer and events are waiting for it. Null when there is nothing to say. */
export const waitingLine = (link: LinkItem, dock: DockView | undefined): string | null =>
  link.waiting > 0 && dock?.status === 'down' ? `${link.peerName}: not reachable, ${link.waiting} ${link.waiting === 1 ? 'event' : 'events'} waiting` : null;

/** "2 of 3 delivered" for a split, "at lab: 3 of 5" for a mission. */
export function progressLine(link: LinkItem): string | null {
  if (link.progress === undefined) return null;
  const { done, total } = link.progress;
  return link.kind === 'mission' ? `at ${link.peerName}: ${done} of ${total}` : `${done} of ${total} delivered`;
}

/** "lab: $3.10 of $5.00 (estimate)", or that no cost is reported. An estimate at list prices, never a bill. */
/** The cap of a link: the one the other station says it applied, else the budget of the offer. */
const capOf = (link: LinkItem): number | null => link.cost?.cap ?? link.budget;

export function costLine(link: LinkItem): string {
  if (link.cost === undefined || link.cost === null) return 'cost not reported';
  const usd = (n: number): string => '$' + n.toFixed(2);
  const cap = capOf(link);
  return `${link.peerName}: ${usd(link.cost.usd)}${cap === null ? '' : ` of ${usd(cap)}`} (estimate)`;
}

export const overCap = (link: LinkItem): boolean => {
  const cap = capOf(link);
  return link.cost !== undefined && link.cost !== null && cap !== null && link.cost.usd >= cap;
};

/** Due and priority, for both cards. */
export function dueLine(link: LinkItem): string | null {
  const parts = [link.due === null ? '' : `due ${link.due}`, link.priority === 'normal' ? '' : `${link.priority} priority`].filter((p) => p !== '');
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The one line of a trail event: "14:03 ana@lab: status doing". `lost` has no author line. */
export function trailLine(event: TrailItem, now: number): string {
  const when = atText(event.at, now);
  if (event.kind === 'lost') return `${when} ${event.text}${event.first === undefined ? '' : ` (events ${event.first} to ${event.seq})`}`;
  const kind = event.kind === 'status' ? 'status' : event.kind;
  return `${when} ${event.by}: ${kind}${event.text === '' ? '' : ` ${event.text}`}${event.via === undefined ? '' : ` (via ${event.via})`}`;
}

/** A deliverable as a link: only an https address is one (a PR or a URL), opened by the person and never fetched by gonogo. Others are plain text. */
export function attachmentHref(a: Deliverable): string | null {
  if (a.kind !== 'pr' && a.kind !== 'url') return null;
  try {
    const url = new URL(a.ref);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null;
  } catch {
    return null;
  }
}

export const KIND_WORDS: Record<Deliverable['kind'], string> = { pr: 'Pull request', branch: 'Branch', commit: 'Commit', file: 'File', url: 'Link' };

/** The outgoing links of a task or mission (the card shows them), the incoming one (a task has at most one). */
export const outgoing = (links: readonly LinkItem[], kind: LinkItem['kind'], mine: string): LinkItem[] => links.filter((l) => l.role === 'sender' && (l.kind ?? 'task') === kind && l.mine === mine);
export const incoming = (links: readonly LinkItem[], kind: LinkItem['kind'], mine: string): LinkItem | undefined => links.find((l) => l.role === 'receiver' && (l.kind ?? 'task') === kind && l.mine === mine);

/** States in which the sender has something to do: a delivery to accept or return. */
export const needsReview = (link: LinkItem): boolean => link.role === 'sender' && link.state === 'delivered';
/** A task given back or delivered: the receiver may still give it back, the sender may recall only what is not done. */
export const canReturn = (link: LinkItem): boolean => link.role === 'receiver' && (link.state === 'accepted' || link.state === 'offered');
export const canRecall = (link: LinkItem): boolean => link.role === 'sender' && (link.state === 'offered' || link.state === 'accepted');

export const STATE_FILTERS: ReadonlyArray<{ id: 'all' | 'open' | 'review' | 'closed'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'review', label: 'To review' },
  { id: 'closed', label: 'Closed' },
];
const CLOSED: readonly LinkState[] = ['done', 'recalled', 'refused', 'detached', 'returned'];

/** The board: one direction (OUT sent, IN held), filtered by station and by state group; the ones to review first. */
export function boardRows(links: readonly LinkItem[], direction: 'out' | 'in', station: string, filter: 'all' | 'open' | 'review' | 'closed'): LinkItem[] {
  const wanted = links.filter((l) => (direction === 'out' ? l.role === 'sender' : l.role === 'receiver') && (station === '' || l.peer === station));
  const shown = wanted.filter((l) => (filter === 'all' ? true : filter === 'closed' ? CLOSED.includes(l.state) : filter === 'review' ? needsReview(l) : !CLOSED.includes(l.state)));
  return shown.map((l, i) => ({ l, i })).sort((a, b) => Number(needsReview(b.l)) - Number(needsReview(a.l)) || b.l.updatedAt - a.l.updatedAt || a.i - b.i).map(({ l }) => l);
}

/** The count a Docking row shows: what waits for the Director (a delivery to review). */
export const reviewCount = (links: readonly LinkItem[]): number => links.filter(needsReview).length;
