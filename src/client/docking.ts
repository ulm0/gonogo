import type { DockHandoffRequest, DockView, LinkPriority, Task } from '../shared/protocol.js';
import { atText } from './uplink.js';

// What Docking shows and asks, kept out of DockingPanel.tsx so that it can be tested without a DOM.

/** A docking code starts with this; the server checks the rest. */
export const CODE_PREFIX = 'gonogo-dock:';

/** The server's rule, so that a slip is told before the call: a web address with no path. Undefined when it is fine. */
export function addressProblem(text: string): string | undefined {
  const fail = 'Type a web address such as https://gonogo.example.com, with /r/<room> after it when the dock is in another room of that station.';
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return fail;
  }
  const plain = (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.search === '' && url.hash === '' && (url.pathname === '/' || /^\/r\/[a-z][a-z0-9-]{0,23}\/?$/.test(url.pathname));
  return plain ? undefined : fail;
}

/** Only an empty box is told here: the server reads a code with or without its first words, with spaces or line breaks, and says what is wrong with one that is cut short. */
export const codeProblem = (text: string): string | undefined => (text.trim() === '' ? 'Paste the whole code from the other station.' : undefined);

/** The address to start the Address box with: the page's own, unless that works only on this computer and the server knows a network address of it. */
export function suggestedAddress(origin: string, addresses: readonly string[]): string {
  try {
    const url = new URL(origin);
    const here = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.') || url.hostname === '0.0.0.0';
    const first = addresses[0];
    return here && first !== undefined ? `${url.protocol}//${first}${url.port === '' ? '' : `:${url.port}`}` : origin;
  } catch {
    return origin;
  }
}

/** The page's own address is the default answer, but the other station cannot reach a name that works only on this computer. */
export function localNote(address: string, container = false): string | null {
  let host: string;
  try {
    host = new URL(address).hostname;
  } catch {
    return null;
  }
  const here = host === 'localhost' || host === '[::1]' || host.startsWith('127.') || host === '0.0.0.0';
  if (!here) return null;
  return container
    ? 'This address works only on this computer. gonogo runs in a container, so it cannot tell the computer\'s own address: use the host\'s network address (the one in your browser\'s address bar from another machine).'
    : 'This address works only on this computer. The other station needs one it can reach: this computer\'s address on your network, a public name or a VPN address.';
}

export const toneOf = (dock: DockView): 'go' | 'nogo' | 'quiet' => (dock.status === 'ok' ? 'go' : dock.status === 'down' ? 'nogo' : 'quiet');

/** The word of the chip of a dock: the colour is not the only thing that says it. */
export const wordOf = (dock: DockView): string => (dock.status === 'ok' ? 'DOCKED' : dock.status === 'down' ? 'NO ANSWER' : 'WAITING');

/** How the last pull went, for a dock's row. */
export function statusText(dock: DockView, now: number): string {
  if (dock.status === 'new') return 'Waiting for the first answer.';
  if (dock.status === 'ok') return `Answered at ${atText(dock.seenAt ?? now, now)}.`;
  return `Not answering${dock.seenAt === null ? '' : `, last seen ${atText(dock.seenAt, now)}`}: ${dock.error ?? 'no reason given'}`;
}

export const expiresText = (expiresAt: number, now: number): string => `It works once, until ${atText(expiresAt, now)}.`;

export const undockedText = (name: string, told: boolean): string =>
  told ? `Undocked from ${name}.` : `Undocked from ${name}. It could not be reached, so it still lists this station until it is undocked there too.`;

export interface Choice {
  value: string;
  label: string;
}

/** Who gets a task handed to a station: one of its agents, or nobody yet (the task lands unassigned). */
export const handoffChoices = (dock: DockView): Choice[] => [
  { value: '', label: 'Nobody yet' },
  ...dock.agents.map((agent) => ({ value: agent.name, label: agent.boss ? `${agent.name} (boss)` : agent.name })),
];

/** A task that is open here and was not handed off can go, when a station is docked. */
export const canHandOff = (task: Task, docks: readonly DockView[]): boolean => docks.length > 0 && task.status !== 'done' && task.handedOff === undefined;

/** The terms of an offer as the form holds them (text), and what they say to the server: nothing for a box left empty. */
export interface OfferTerms {
  due: string;
  priority: '' | LinkPriority;
  onward: boolean;
  budget: string;
}
export const NO_TERMS: OfferTerms = { due: '', priority: '', onward: false, budget: '' };

/** One line per box that is wrong, before the call (the server says the same words): a date as YYYY-MM-DD, dollars from 0 to 1,000,000. */
export function offerProblems(terms: OfferTerms): { due?: string; budget?: string } {
  const out: { due?: string; budget?: string } = {};
  const due = terms.due.trim();
  if (due !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due + 'T00:00:00Z')) || new Date(due + 'T00:00:00Z').toISOString().slice(0, 10) !== due)) out.due = 'Type a date as YYYY-MM-DD.';
  const budget = terms.budget.trim();
  if (budget !== '' && (!/^\d{1,7}(\.\d{1,2})?$/.test(budget) || Number(budget) > 1_000_000)) out.budget = 'Type dollars, 0 to 1000000, with at most two decimals.';
  return out;
}

const termFields = (terms: OfferTerms): Pick<DockHandoffRequest, 'due' | 'priority' | 'onward' | 'budget'> => ({
  ...(terms.due.trim() === '' ? {} : { due: terms.due.trim() }),
  ...(terms.priority === '' ? {} : { priority: terms.priority }),
  ...(terms.onward ? { onward: true } : {}),
  ...(terms.budget.trim() === '' ? {} : { budget: Number(terms.budget) }),
});

export const handoffRequest = (task: Task, assignee: string, terms: OfferTerms = NO_TERMS): DockHandoffRequest => ({ task: task.id, assignee: assignee === '' ? null : assignee, ...termFields(terms) });

/** A mission is offered with a date and a priority only: no onward, no budget (the other station makes its own mission). */
export const missionOffer = (mission: string, terms: OfferTerms): { mission: string; due?: string; priority?: LinkPriority } => {
  const { due, priority } = termFields(terms);
  return { mission, ...(due === undefined ? {} : { due }), ...(priority === undefined ? {} : { priority }) };
};
