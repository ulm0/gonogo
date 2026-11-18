import type { ActivityItem } from '../shared/protocol.js';
import { subjectOf } from './loop.js';

// What Party Line shows: the messages of the room as conversations. Kept out of PartyLine.tsx so that it can be tested without a DOM.

/**
 * A conversation. The messages carry no thread id; two things say which belong together:
 * - a reply chain: a message whose `inReplyTo` is a message of the list joins that message's conversation, when its sender is the
 *   Director or one of the two ends of that message (an agent picks its own `inReplyTo`: it may not write itself into the
 *   conversation of others, where it would also become the one the Director's answer goes to by default);
 * - the same two parties and the same subject (a leading "Re:" or "Fwd:" does not count, case and spacing do not count).
 */
export interface Thread {
  /** The id of the first message of the list that is in it. */
  id: string;
  /** The subject of that message without "Re:", empty when it had none: what a reply is titled "Re: <subject>" from. */
  subject: string;
  /** What the list shows: the subject, or the first line of the body when there is none. */
  title: string;
  /** Agent names and "user", in the order they first speak or are spoken to. */
  who: string[];
  /** Oldest first. */
  items: ActivityItem[];
  /** The newest message. */
  last: ActivityItem;
}

const REPLY_PREFIXES = /^(?:\s*(?:re|fwd?)\s*:)*/i;

/** The subject without its leading "Re:" and "Fwd:" (any number of them). One pass over the text, anchored: no backtracking beyond one scan. */
export const stripReplyPrefix = (subject: string): string => subject.replace(REPLY_PREFIXES, '').trim();

const keyOf = (item: ActivityItem): string => JSON.stringify([item.from, item.to].sort().concat(stripReplyPrefix(item.subject).replace(/\s+/g, ' ').toLowerCase()));

/**
 * The conversations of a list of messages, the one with the newest message first. `items` is newest first, as the store keeps
 * them. Only the messages in the list are known: a conversation whose start has left the list begins at its oldest message
 * still there.
 */
export function groupThreads(items: readonly ActivityItem[]): Thread[] {
  const ofMessage = new Map<string, Thread>();
  const byId = new Map<string, ActivityItem>();
  const ofKey = new Map<string, Thread>();
  // a Set keeps the order of insertion: a thread that gets a message is taken out and put back, so the newest comes last
  const order = new Set<Thread>();
  for (const item of [...items].reverse()) {
    const key = keyOf(item);
    const target = item.inReplyTo === null ? undefined : byId.get(item.inReplyTo);
    const chained = target !== undefined && (item.from === 'user' || item.from === target.from || item.from === target.to);
    let thread = (chained ? ofMessage.get(target.id) : undefined) ?? ofKey.get(key);
    if (thread === undefined) {
      const subject = stripReplyPrefix(item.subject);
      thread = { id: item.id, subject, title: subject === '' ? subjectOf(item) : subject, who: [], items: [], last: item };
    }
    thread.items.push(item);
    thread.last = item;
    for (const name of [item.from, item.to]) if (!thread.who.includes(name)) thread.who.push(name);
    ofMessage.set(item.id, thread);
    byId.set(item.id, item);
    if (!ofKey.has(key)) ofKey.set(key, thread);
    order.delete(thread);
    order.add(thread);
  }
  return [...order].reverse();
}

/** An agent the Director can write to: not himself, and not a `name@station` (the hub refuses those from him). */
const isAgent = (name: string): boolean => name !== 'user' && !name.includes('@');

/**
 * The agents of a thread the Director can answer, the likely one first: whoever spoke last, and when the Director alone has
 * spoken, whom he spoke to last. Empty when the thread is only with another station.
 */
export function repliers(thread: Thread): string[] {
  const agents = thread.who.filter(isAgent);
  let likely: string = thread.last.to;
  for (let i = thread.items.length - 1; i >= 0; i -= 1) {
    const item = thread.items[i];
    if (item !== undefined && item.from !== 'user') {
      likely = item.from;
      break;
    }
  }
  return agents.includes(likely) ? [likely, ...agents.filter((name) => name !== likely)] : agents;
}

/** What `Reply` takes: the answer goes to `to`, titled "Re: <subject>" and in reply to the newest message, so that it joins the thread. */
export const replyTarget = (thread: Thread, to: string): { id: string; from: string; subject: string } => ({ id: thread.last.id, from: to, subject: thread.subject });
