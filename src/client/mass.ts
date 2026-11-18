import { providerInfo } from '../shared/protocol.js';
import type { AgentView, MemoryView, ReflectResult } from '../shared/protocol.js';
import { whenText } from './inbox.js';

// What Mass Budget shows and says, kept out of MassBudget.tsx so that it can be tested without a DOM.

/** Only an agent with the gonogo tools has a memory file to condense and can be asked to. */
export const hasBudget = (agent: AgentView): boolean => providerInfo(agent.provider).mcp;

/** A stopped agent is not asked: the hub would send the message back to the Director. */
export const canAsk = (agent: AgentView): boolean => agent.state !== 'stopped' && agent.transition === null;

/** "812 B", "3.2 KB", "1.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "63 lines · 2.1 KB", "not made yet". A file too big to count has no lines. */
export function sizeLine(view: MemoryView): string {
  if (!view.exists) return 'not made yet';
  return [view.lines === null ? null : `${view.lines} ${view.lines === 1 ? 'line' : 'lines'}`, sizeText(view.bytes)].filter(Boolean).join(' · ');
}

/** The warning, or null under the soft limit. */
export function overText(view: MemoryView): string | null {
  return view.over ? `Over the soft limit of ${view.softLines} lines or ${sizeText(view.softBytes)}` : null;
}

/** What is known of the last request, from the copy and the file: null when none was made. The copy's time is when it was asked. */
export function askedText(view: MemoryView, now: number): string | null {
  const copy = view.backup;
  if (copy === null) return null;
  const when = whenText(copy.at, now);
  if (view.changedAt === null || view.changedAt <= copy.at) return `Asked at ${when}. The notes have not changed since.`;
  return `Asked at ${when}. The notes changed since: ${sizeText(copy.bytes)} then, ${sizeText(view.bytes)} now.`;
}

/** What the Director is told after the request. */
export function resultText(name: string, result: ReflectResult): string {
  if (!result.send.ok) return `Not sent: ${result.send.note ?? 'the hub did not deliver it'}.`;
  // the request went out before the copy was made; a folder (or anything else) standing at memory.md.bak leaves no copy
  const kept = result.memory.backup === null ? 'No copy was kept: memory.md.bak could not be written.' : 'The old file is kept as memory.md.bak.';
  return `Asked ${name} to condense its notes. It reads the request when it is idle. ${kept}`;
}
