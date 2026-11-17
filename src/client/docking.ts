import type { DockHandoffRequest, DockView, Task } from '../shared/protocol.js';
import { atText } from './uplink.js';

// What Docking shows and asks, kept out of DockingPanel.tsx so that it can be tested without a DOM.

/** A docking code starts with this; the server checks the rest. */
export const CODE_PREFIX = 'gonogo-dock:';

/** The server's rule, so that a slip is told before the call: a web address with no path. Undefined when it is fine. */
export function addressProblem(text: string): string | undefined {
  const fail = 'Type a web address with no path, such as https://gonogo.example.com.';
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return fail;
  }
  const plain = (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.search === '' && url.hash === '' && url.pathname === '/';
  return plain ? undefined : fail;
}

export const codeProblem = (text: string): string | undefined => (text.trim().startsWith(CODE_PREFIX) ? undefined : `Paste the whole code from the other station. It starts with ${CODE_PREFIX}`);

/** The page's own address is the default answer, but the other station cannot reach a name that works only on this computer. */
export function localNote(address: string): string | null {
  let host: string;
  try {
    host = new URL(address).hostname;
  } catch {
    return null;
  }
  const here = host === 'localhost' || host === '[::1]' || host.startsWith('127.') || host === '0.0.0.0';
  return here ? 'This address works only on this computer. The other station needs one it can reach, such as a public name or a VPN address.' : null;
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

export const handoffRequest = (task: Task, assignee: string): DockHandoffRequest => ({ task: task.id, assignee: assignee === '' ? null : assignee });
