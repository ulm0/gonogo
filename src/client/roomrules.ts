/** Room rules (docs/features/door.md): the pure parts of the RULES block of Flight Rules. */

/** The cap of the rules file when the server did not say (it does: `max` of the view). */
export const RULES_MAX_BYTES = 8192;

/** The size the server measures: UTF-8 bytes, not characters. */
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** What is wrong with the text before it is sent, or null. The server decides in the end; this only saves the trip. */
export function rulesProblem(text: string, max: number = RULES_MAX_BYTES): string | null {
  if (text.includes('\u0000')) return 'The rules cannot contain a NUL character.';
  const bytes = bytesOf(text);
  return bytes > max ? `The rules are ${bytes.toLocaleString('en-US')} bytes: at most ${max.toLocaleString('en-US')} (a letter with an accent or an emoji is more than one byte).` : null;
}

/** `1,204 / 8,192 bytes`. */
export const bytesText = (bytes: number, max: number): string => `${bytes.toLocaleString('en-US')} / ${max.toLocaleString('en-US')} bytes`;
