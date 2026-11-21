/**
 * The door (docs/features/door.md): the rules of the room and a pointer to the repository's own `AGENTS.md` reach an agent through the role
 * text, the one channel each engine already has. Nothing is written into a repository, and nothing of a repository goes into the role text:
 * the pointer is a fixed sentence, the room's rules are the Director's own file (rules.ts). Text from a repository is written by agents, and
 * the role text is read by an engine as part of its system prompt: pasting a repository's text there would let one agent instruct all the others.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROVIDERS } from '../shared/protocol.js';
import type { Provider } from '../shared/protocol.js';

/** Whether an engine loads `AGENTS.md` on its own: `yes` (its documentation says so), `no` (it loads another file), `unknown` (not found in its documentation). */
export type ReadsAgentsMd = 'yes' | 'no' | 'unknown';
/** How the role reaches an engine: `preamble` (the gonogo preamble and the role), `role` (the role alone), `none` (no checked way to pass one). */
export type RoleChannel = 'preamble' | 'role' | 'none';

/**
 * Per engine, read from the vendor's own documentation or repository on 2026-11-21 (the sources are in docs/door-spec.md); no CLI but claude was run here.
 * `unknown` and `no` both get the pointer: a duplicate sentence costs a line, a missed file costs the project's rules.
 */
export const DOOR: Readonly<Record<Provider, { reads: ReadsAgentsMd; channel: RoleChannel }>> = {
  // Claude Code reads CLAUDE.md; its documentation pages disagree on AGENTS.md (one says it does not, one that it can)
  claude: { reads: 'unknown', channel: 'preamble' },
  // GEMINI.md by default; another name only with the `context.fileName` setting
  gemini: { reads: 'no', channel: 'preamble' },
  antigravity: { reads: 'unknown', channel: 'role' },
  codex: { reads: 'yes', channel: 'preamble' },
  opencode: { reads: 'yes', channel: 'preamble' },
  qwen: { reads: 'yes', channel: 'none' },
  grok: { reads: 'yes', channel: 'none' },
  // the system prompt template can include the merged AGENTS.md (`${KIMI_AGENTS_MD}`); whether the default one does was not read
  kimi: { reads: 'unknown', channel: 'none' },
  // only the global ~/.config/AGENTS.md is documented in its README
  crush: { reads: 'unknown', channel: 'none' },
  pi: { reads: 'unknown', channel: 'role' },
  copilot: { reads: 'yes', channel: 'none' },
  cursor: { reads: 'yes', channel: 'none' },
  custom: { reads: 'unknown', channel: 'none' },
};

/** The project's own rules file in the agent's working directory, as far as the door is concerned. */
export type ProjectFile = 'AGENTS.md' | 'CLAUDE.md';

/**
 * Which of the two files the working directory has as a regular file (lstat: a link is not followed, and nothing is read), AGENTS.md first.
 * Only the name of the file is used afterwards: nothing of what is in it.
 */
export async function projectFile(dir: string): Promise<ProjectFile | null> {
  for (const name of ['AGENTS.md', 'CLAUDE.md'] as const) {
    if ((await lstat(join(dir, name)).catch(() => null))?.isFile() === true) return name;
  }
  return null;
}

/** Fixed text: the file name is one of two constants, and no other word of it comes from a repository. */
export const pointerOf = (file: ProjectFile): string => `The project's rules are in the file ${file} in your working directory: read it first.`;
export const ROOM_RULES_HEADING = 'Room rules, written by the Director for every agent of this room:';

/** Whether the engine must be told where the file is: AGENTS.md unless it loads it itself; CLAUDE.md for every engine but Claude Code. */
const needsPointer = (provider: Provider, file: ProjectFile): boolean => (file === 'AGENTS.md' ? DOOR[provider].reads !== 'yes' : provider !== 'claude');

/**
 * What goes after the role text for this engine: the room's rules, then the pointer when the working directory has the project's file and the engine
 * does not load it itself. Empty for an engine that takes no role text. `rules` is the Director's text, already checked by rules.ts.
 */
export function doorText(provider: Provider, rules: string, file: ProjectFile | null = null): string {
  const { channel } = DOOR[provider];
  if (channel === 'none') return '';
  const parts = [rules.trim() === '' ? '' : `${ROOM_RULES_HEADING}\n${rules.trim()}`, file !== null && needsPointer(provider, file) ? pointerOf(file) : ''].filter((part) => part !== '');
  return parts.length === 0 ? '' : `\n\n${parts.join('\n\n')}`;
}

/** The table of `gonogo doctor`: per engine, whether it loads AGENTS.md itself and whether gonogo can pass it a role. */
export function doorTable(): string {
  const rows = PROVIDERS.map((p) => `  ${p.padEnd(12)} reads AGENTS.md: ${DOOR[p].reads.padEnd(8)} role from gonogo: ${DOOR[p].channel === 'none' ? 'no' : 'yes'}`);
  return ['Room rules and the project file (docs/features/door.md): "unknown" is treated as "not loaded".', ...rows].join('\n');
}
