import type { AuditGitState, AuditKind, AuditView } from '../shared/protocol.js';

// What the Black Box shows, kept out of BlackBox.tsx so that it can be tested without a DOM.

/** The chip of an event: the part of the room it comes from, and how loud it is. */
export const KIND_CHIPS: Readonly<Record<AuditKind, { text: string; tone: 'amber' | 'nogo' | 'quiet' }>> = {
  crew: { text: 'CREW', tone: 'quiet' },
  redline: { text: 'REDLINE', tone: 'nogo' },
  poll: { text: 'T-MINUS', tone: 'amber' },
  answer: { text: 'ANSWER', tone: 'amber' },
  plan: { text: 'PLAN', tone: 'quiet' },
  uplink: { text: 'UPLINK', tone: 'amber' },
  config: { text: 'CONFIG', tone: 'quiet' },
  audit: { text: 'BLACK BOX', tone: 'quiet' },
};

/** One line on the state of git, for the head of the page. */
export function gitText(view: Pick<AuditView, 'git' | 'note'>): string {
  const states: Record<AuditGitState, string> = {
    ok: 'Events are committed to a git repository, in batches.',
    missing: `${view.note}. Events are written to the folder and not committed. Install git and restart gonogo.`,
    error: `git failed: ${view.note}. Events are written to the folder; the next batch commits them again.`,
  };
  return states[view.git];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "2026-11-18 14:03:07" in the time zone of the browser; an `at` outside the range of a Date reads "--" and cannot take the page down. */
export function stampText(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '--';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const countText = (shown: number): string => (shown === 0 ? 'Nothing recorded yet.' : `${shown} newest event${shown === 1 ? '' : 's'}. Older ones are in the repository.`);

/** Puts text on the clipboard; false when the browser refuses (a page that is not a secure context has no clipboard). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
