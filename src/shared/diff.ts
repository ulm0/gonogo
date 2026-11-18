/**
 * Post-Flight Review (docs/review-spec.md): a unified diff read into files, hunks and numbered lines, so that a note can name a
 * file, a side and a line. Pure, and used by the server (to anchor and judge notes, and to answer review_read) and by the page
 * (to draw the diff). It reads what `git diff --no-color` prints; it never throws, and a diff cut in the middle gives the
 * files and lines up to the cut.
 */
import { REVIEW_TEXT_MAX_CHARS } from './protocol.js';
import type { ReviewFileDiff, ReviewHunk, ReviewLine, ReviewPlace, ReviewSide } from './protocol.js';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `b/path` or `a/path` to `path`; a trailing tab (git adds one after a name with a space) goes. */
function nameOf(raw: string): string | null {
  const text = raw.replace(/\t.*$/, '');
  if (text === '/dev/null') return null;
  return text.replace(/^[ab]\//, '');
}

/** The files of a diff, in order. A binary file has no hunks and says so. */
export function parseDiff(diff: string): ReviewFileDiff[] {
  const files: ReviewFileDiff[] = [];
  let file: ReviewFileDiff | null = null;
  let hunk: ReviewHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      const both = /^diff --git a\/(.+) b\/(.+)$/.exec(text);
      file = { path: both?.[2] ?? text.slice(11), status: 'modified', binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;
    if (hunk === null) {
      if (text.startsWith('new file mode')) file.status = 'added';
      else if (text.startsWith('deleted file mode')) file.status = 'deleted';
      else if (text.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = text.slice(12);
      } else if (text.startsWith('Binary files ') || text.startsWith('GIT binary patch')) file.binary = true;
      else if (text.startsWith('--- ')) {
        const old = nameOf(text.slice(4));
        if (old === null) file.status = 'added';
        else if (file.status === 'deleted') file.path = old;
      } else if (text.startsWith('+++ ')) {
        const now = nameOf(text.slice(4));
        if (now !== null) file.path = now;
      }
    }
    const header = HUNK.exec(text);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunk = { header: text.slice(0, 200), oldStart: oldLine, oldCount: header[2] === undefined ? 1 : Number(header[2]), newStart: newLine, newCount: header[4] === undefined ? 1 : Number(header[4]), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null || text === '' || text.startsWith('\\')) continue;
    const sign = text[0];
    // a file with CRLF line ends: the CR is not part of the line
    const body = text.slice(1).replace(/\r$/, '');
    let line: ReviewLine;
    if (sign === '+') line = { kind: 'add', old: null, new: newLine++, text: body };
    else if (sign === '-') line = { kind: 'del', old: oldLine++, new: null, text: body };
    else if (sign === ' ') line = { kind: 'ctx', old: oldLine++, new: newLine++, text: body };
    else continue;
    hunk.lines.push(line);
  }
  return files;
}

/** The number of a line on one side, or null when the line is not on that side (an added line has no old number). */
export const lineNumber = (line: ReviewLine, side: ReviewSide): number | null => (side === 'old' ? line.old : line.new);

/** The text of one line of the diff on a side, or null when the file or the line is not in it. */
export function textAt(files: readonly ReviewFileDiff[], file: string, side: ReviewSide, line: number): string | null {
  const found = files.find((f) => f.path === file);
  if (found === undefined) return null;
  for (const hunk of found.hunks) for (const l of hunk.lines) if (lineNumber(l, side) === line) return l.text;
  return null;
}

/**
 * The same text, whatever the indentation or the spacing: a note stays on a line that was only re-indented. A note keeps at most
 * REVIEW_TEXT_MAX_CHARS of its line, so both sides are cut the same way before they are compared: a longer line is still itself.
 */
const squash = (text: string): string => text.slice(0, REVIEW_TEXT_MAX_CHARS).replace(/\s+/g, ' ').trim();

/** The lines of one file of the diff that are on a side, with their number on it. */
function onSide(file: ReviewFileDiff | undefined, side: ReviewSide): Array<{ no: number; text: string }> {
  const out: Array<{ no: number; text: string }> = [];
  for (const hunk of file?.hunks ?? []) {
    for (const l of hunk.lines) {
      const no = lineNumber(l, side);
      if (no !== null) out.push({ no, text: l.text });
    }
  }
  return out;
}

/**
 * Where a note is in the diff now. Exact: the same side and number hold the same text. Moved: that text is on that side at another
 * number (once: there; several: the nearest to where it was). Outdated: it is not found. A diff cut short that does not reach the
 * line says unknown instead of outdated. A note is never lost by this: it is worked out at every read and stores nothing.
 */
export function locate(note: { path: string; side: ReviewSide; line: number; text: string }, files: readonly ReviewFileDiff[], truncated = false): ReviewPlace {
  const lines = onSide(files.find((f) => f.path === note.path), note.side);
  const want = squash(note.text);
  const same = lines.find((l) => l.no === note.line);
  if (same !== undefined && squash(same.text) === want) return { state: 'exact', line: note.line };
  const found = lines.filter((l) => squash(l.text) === want);
  if (found.length > 0) {
    const nearest = found.reduce((best, l) => (Math.abs(l.no - note.line) < Math.abs(best.no - note.line) ? l : best));
    return { state: 'moved', line: nearest.no };
  }
  return { state: truncated ? 'unknown' : 'outdated', line: note.line };
}
