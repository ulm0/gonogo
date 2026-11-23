/** Docking 2 per-dock rules and the Director's GO on a handoff FLIGHT asks to send (docs/docking-collab-spec.md, section 4 and 6), with no React. */
import type { DockRules, HandoffAsk } from '../shared/protocol.js';

export interface RuleField {
  key: keyof Omit<DockRules, 'staleHours'>;
  label: string;
  /** One plain line: what it does. */
  help: (station: string) => string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

export const RULE_FIELDS: readonly RuleField[] = [
  {
    key: 'handoff',
    label: 'FLIGHT sends tasks to this station',
    help: (s) => `Ask: FLIGHT's every handoff to ${s} waits for your GO, with the whole text that would leave. Allow: it sends without asking. Your own Hand off key always works.`,
    options: [{ value: 'ask', label: 'Ask me first' }, { value: 'allow', label: 'Allow' }],
  },
  {
    key: 'incoming',
    label: 'Tasks that arrive from this station',
    help: (s) => `Automatic: a task from ${s} becomes a card for your boss, and you see one line. Ask: it waits for you. Refuse: none are taken.`,
    options: [{ value: 'auto', label: 'Take them' }, { value: 'ask', label: 'Ask me first' }, { value: 'off', label: 'Refuse' }],
  },
  {
    key: 'autoAccept',
    label: 'When this station says it is done',
    help: (s) => `You review the delivery, or the task closes by itself when ${s} delivers it.`,
    options: [{ value: 'off', label: 'I review it' }, { value: 'on', label: 'Close it by itself' }],
  },
  {
    key: 'reportCost',
    label: 'Tell this station what its tasks cost here',
    help: (s) => `Dollars to the cent, as an estimate, nothing else. Off: ${s} sees "cost not reported".`,
    options: [{ value: 'off', label: 'Do not report' }, { value: 'on', label: 'Report' }],
  },
  {
    key: 'serve',
    label: 'Answer knowledge questions from this station',
    help: (s) => `Only for Mission Log entries and claims you marked as shareable with ${s}. Off: it gets nothing.`,
    options: [{ value: 'off', label: 'Do not answer' }, { value: 'on', label: 'Answer' }],
  },
];

export const STALE_HELP = (s: string): string => `A task ${s} accepted and has not touched for this many hours tells your boss. 0 turns it off.`;

/** The staleHours box: a whole number of hours from 0 to a year; a message when it is not one. */
export function staleProblem(text: string): string | undefined {
  return /^\d{1,4}$/.test(text.trim()) && Number(text) <= 8760 ? undefined : 'Type a whole number of hours, 0 to 8760.';
}

/** The box that turns the rule to Allow in the GO of a handoff: the words the spec fixes (outgoing is a new data path). */
export const alwaysText = (station: string): string => `Always for ${station}: FLIGHT can then send tasks, and what it writes in them, to ${station} without asking you.`;

export const askTitle = (ask: HandoffAsk, legend: string): string => `${legend} wants to send a task to ${ask.station}`;

/** The whole text that would leave, in the order it is read: the title, then the detail. */
export const askText = (ask: HandoffAsk): string => (ask.task.detail === '' ? ask.task.title : `${ask.task.title}\n\n${ask.task.detail}`);
