/**
 * Post-Flight Review (docs/review-spec.md): a unified diff read into files, hunks and numbered lines, so that a note can name a
 * file, a side and a line. Pure, and used by the server (to anchor and judge notes, and to answer review_read) and by the page
 * (to draw the diff). It reads what `git diff --no-color` prints; it never throws, and a diff cut in the middle gives the
 * files and lines up to the cut.
 */
import type { ReviewFileDiff, ReviewHunk, ReviewLine, ReviewSide } from './protocol.js';

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
      newLine = Number(header[2]);
      hunk = { header: text.slice(0, 200), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null || text === '' || text.startsWith('\\')) continue;
    const sign = text[0];
    let line: ReviewLine;
    if (sign === '+') line = { kind: 'add', old: null, new: newLine++, text: text.slice(1) };
    else if (sign === '-') line = { kind: 'del', old: oldLine++, new: null, text: text.slice(1) };
    else if (sign === ' ') line = { kind: 'ctx', old: oldLine++, new: newLine++, text: text.slice(1) };
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
