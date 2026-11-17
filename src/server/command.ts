/**
 * How a command written as text is read: a JSON array of strings when it starts with `[`, words split on whitespace
 * otherwise (no quoting: a path with spaces needs the array form). One reader for GONOGO_AGENT_CMD, for the command of a
 * custom agent when it is hired, edited, loaded from the roster file and started. No imports: home.ts, web.ts and the
 * launcher all use it.
 */

const ENV_PREFIX = 'GONOGO_AGENT_CMD: ';

export function parseAgentCmd(value: string | undefined): string[] | null {
  const text = value?.trim();
  if (!text) return null;
  // A NUL ends a C string: the program would be started with an argument cut short.
  if (text.includes('\u0000')) throw new Error(`${ENV_PREFIX}the command cannot contain a NUL character`);
  if (!text.startsWith('[')) return text.split(/\s+/);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${ENV_PREFIX}not a valid JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${ENV_PREFIX}expected a JSON array of one or more strings`);
  }
  // The same rule for an escaped NUL (\u0000) that JSON.parse has just turned into the character.
  if (parsed.some((item) => item.includes('\u0000'))) throw new Error(`${ENV_PREFIX}the command cannot contain a NUL character`);
  return parsed;
}

/** The words of a custom agent's command, or an Error with a one-line reason (no mention of the environment variable). */
export function readCustomCommand(command: string): string[] {
  let words: string[] | null;
  try {
    words = parseAgentCmd(command);
  } catch (error) {
    throw new Error(`the command is not usable: ${(error instanceof Error ? error.message : String(error)).replace(ENV_PREFIX, '')}`);
  }
  if (words === null || words[0] === undefined || words[0] === '') throw new Error('the command is not usable: it is empty');
  return words;
}
