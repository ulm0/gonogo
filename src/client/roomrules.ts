/** Room rules (docs/features/door.md): the pure parts of the editors of Flight Rules (the rules, the template of the closing checklist). */

/** The cap of the text when the server did not say (it does: `max` of the view). */
export const RULES_MAX_BYTES = 8192;

/**
 * What the server keeps of a text: a line break is one `\n`, and for the rules the whole text is trimmed (an all-whitespace text clears them). The
 * server measures and judges this, so the page does too.
 */
export const asSaved = (text: string, trim: boolean): string => {
  const lines = text.replace(/\r\n?/g, '\n');
  return trim ? lines.trim() : lines;
};

/** The size the server measures: UTF-8 bytes, not characters. */
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** A character the server refuses: control (but not tab and line feed), a bidi mark, a zero-width one, a byte order mark. */
// eslint-disable-next-line no-control-regex
const REFUSED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

/** What is wrong with the text before it is sent, or null. The server decides in the end; this only saves the trip. */
export function rulesProblem(text: string, max: number = RULES_MAX_BYTES, trim = true): string | null {
  const saved = asSaved(text, trim);
  if (REFUSED.test(saved)) return 'The text has a control, direction or zero-width character, which gonogo does not keep (a tab and a line break are fine).';
  const bytes = bytesOf(saved);
  return bytes > max ? `The text is ${bytes.toLocaleString('en-US')} bytes: at most ${max.toLocaleString('en-US')} (a letter with an accent or an emoji is more than one byte).` : null;
}

/** `1,204 / 8,192 bytes`. */
export const bytesText = (bytes: number, max: number): string => `${bytes.toLocaleString('en-US')} / ${max.toLocaleString('en-US')} bytes`;
