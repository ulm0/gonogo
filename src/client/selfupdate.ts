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

export function updateDialogText(version: string, counts: { working: number; idle: number }, policy: StartupPolicy | null): string {
  const who = counts.working + counts.idle === 0 ? 'No agent is running.' : `${counts.working} ${counts.working === 1 ? 'agent is' : 'agents are'} working and ${counts.idle} ${counts.idle === 1 ? 'is' : 'are'} idle: they will all stop.`;
  return `Update this container to ${version}? It pulls the image, stops gonogo, starts the new container and waits for it to be healthy, and puts the old one back if it is not. ${who} ${policy === null ? '' : AFTER[policy]} Trust: the update runs the image publisher's code on this host, with the Docker socket.`;
}
