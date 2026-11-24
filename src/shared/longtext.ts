/**
 * Long text from the Director (docs/features/comms.md, "Long text"). A message body holds BODY_MAX_CHARS; a brief or a reply of
 * more is still sent: the server saves the whole text as a file in the recipient's own folder, and the message carries the
 * path and the first lines. Up to LONG_TEXT_MAX_CHARS; more is refused before anything is sent.
 */
import { BODY_MAX_CHARS } from './protocol.js';

/** The most the Director can send in one message, saved to a file. About 1 MB of UTF-8 text, a long log. */
export const LONG_TEXT_MAX_CHARS = 1_000_000;
/** How much of a long text the message itself carries, cut at the end of a line when one is near. */
export const LONG_TEXT_EXCERPT_CHARS = 2000;
/** The name of the file, after `<message id>-` in the agent's `inbox-files` folder (where Telegram files go too, and the 30-day pruning applies). */
export const LONG_TEXT_NAME = 'long-text.txt';

const count = (n: number): string => n.toLocaleString('en-US');

export type LongTextKind = 'short' | 'file' | 'too_long';

/** What happens to a text of this length: sent as it is, saved to a file, or refused. */
export function longTextKind(length: number): LongTextKind {
  if (length <= BODY_MAX_CHARS) return 'short';
  return length <= LONG_TEXT_MAX_CHARS ? 'file' : 'too_long';
}

/** The line under a compose box, or null when there is nothing to say (the text fits in a message). `to` is how the box names the recipient. */
export function longTextNote(length: number, to: string): { text: string; tone: 'hint' | 'danger' } | null {
  const kind = longTextKind(length);
  if (kind === 'short') return null;
  if (kind === 'too_long') {
    return { text: `Too long to send: ${count(length)} characters. The most is ${count(LONG_TEXT_MAX_CHARS)}. Cut it, or save it as a file and send the path.`, tone: 'danger' };
  }
  return {
    text: `Long text: ${count(length)} characters. A message holds ${count(BODY_MAX_CHARS)}, so it is saved as a file for ${to}; the message carries its path and the first lines.`,
    tone: 'hint',
  };
}

/** The first lines of a long text: at most LONG_TEXT_EXCERPT_CHARS, cut after a line end in the last quarter when there is one. */
export function longTextExcerpt(text: string): string {
  if (text.length <= LONG_TEXT_EXCERPT_CHARS) return text;
  let cut = text.slice(0, LONG_TEXT_EXCERPT_CHARS);
  const end = cut.lastIndexOf('\n');
  if (end >= LONG_TEXT_EXCERPT_CHARS * 0.75) cut = cut.slice(0, end);
  // never end on half of a surrogate pair
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/** The body of the message that stands for a long text saved at `path`. Always under BODY_MAX_CHARS. */
export function longTextBody(text: string, path: string): string {
  const lines = text.split('\n').length;
  return (
    `Long text from the Director: ${count(text.length)} characters, ${count(lines)} lines, too long for a message. ` +
    `gonogo saved all of it in this file: ${path}\n` +
    `Read the whole file before you act on it. Its first lines:\n\n` +
    `${longTextExcerpt(text)}\n…`
  );
}
