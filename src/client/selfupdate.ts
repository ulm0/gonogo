/** Docker self-update (docs/self-update-spec.md): the words of the confirmation the Update button shows in a container, with no React. */
import type { AgentState, StartupPolicy } from '../shared/protocol.js';

/** Agents that would be cut off by the stop (working, or waiting for you) and those that are idle; stopped ones are not counted. */
export function agentCounts(states: readonly AgentState[]): { working: number; idle: number } {
  const working = states.filter((s) => s === 'working' || s === 'needs_you').length;
  const idle = states.filter((s) => s === 'idle' || s === 'starting').length;
  return { working, idle };
}

const AFTER: Record<StartupPolicy, string> = {
  running: 'Autostart is on (all that were running): they start again by themselves in waves, and one that was mid-turn is told to carry on.',
  boss: 'Autostart brings back only the boss: the others wait for you to start them.',
  off: 'Autostart is off: they stay stopped until you start them.',
};

/** The one confirmation of a container update: what stops, and what brings it back. What the update runs is in UPDATE_TRUST_TEXT, under a fold of the same box. */
export function updateDialogText(version: string, counts: { working: number; idle: number }, policy: StartupPolicy | null): string {
  const who = counts.working + counts.idle === 0 ? 'No agent is running.' : `${counts.working} ${counts.working === 1 ? 'agent is' : 'agents are'} working and ${counts.idle} ${counts.idle === 1 ? 'is' : 'are'} idle: they will all stop.`;
  return `Update to ${version}? gonogo stops and the new container starts; the old one comes back if it is not healthy. ${who} ${policy === null ? '' : AFTER[policy]}`.replace(/ +$/, '');
}

export const UPDATE_TRUST_TEXT = 'The update runs the image publisher\u2019s code on this host, with the Docker socket. It pulls the image first and checks its signature.';

/**
 * What to say when gonogo cannot vouch for the image it pulled (UpdateView.verify), once and short: the problem, how to fix it when there is a way, and the key that goes on
 * without checking. `failed` is not here: a failed check has no key that goes on.
 */
export function verifyPanel(verify: 'unattested' | 'unchecked'): { problem: string; fix: string | null; button: string } {
  return verify === 'unchecked'
    ? {
        problem: 'Can\u2019t verify this image\u2019s signature right now: GitHub refused the check.',
        fix: 'GitHub answers a check without a login only so many times an hour, or the network is down. Try again in a while, or log in once from a console of room main with `gh auth login` (or set GH_TOKEN in the container).',
        button: 'Update without checking',
      }
    : { problem: 'This image has no signature to check: it was published before they were made.', fix: null, button: 'Update without checking' };
}

/**
 * Whether the update strip stays hidden: the Director dismissed the version it shows, and nothing is being installed. A result that is already there (done, rolled back)
 * does not bring a dismissed strip back; an update that is running always shows.
 */
export const stripDismissed = (dismissed: string | null, shown: string, busy: boolean): boolean => dismissed !== null && dismissed !== '' && dismissed === shown && !busy;
