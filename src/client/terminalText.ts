/** Text out of a terminal's lines, for the toolbar of the console (Copy, Find). Pure, so it is tested without a terminal. */

/** What follows the last line that starts with the prompt mark, as Claude Code draws it (`>` or `❯` and a space), trimmed. Without such a line, everything. */
// shortcut: another engine's prompt is not known; when more engines are supported, give each its own mark.
export function lastAnswer(lines: readonly string[]): string {
  let start = 0;
  for (let y = lines.length - 1; y >= 0; y -= 1) {
    if (/^\s*[>❯]\s/.test(lines[y])) {
      start = y + 1;
      break;
    }
  }
  return lines.slice(start).join('\n').trim();
}

/** The next (or previous) line, going round the buffer from `from`, that holds `query` without regard to case: its line and the column of the match; null when none does. */
export function findLine(lines: readonly string[], query: string, from: number, backwards: boolean): { line: number; column: number } | null {
  if (query === '') return null;
  const needle = query.toLowerCase();
  const n = lines.length;
  for (let i = 1; i <= n; i += 1) {
    const line = (((backwards ? from - i : from + i) % n) + n) % n;
    const column = lines[line].toLowerCase().indexOf(needle);
    if (column >= 0) return { line, column };
  }
  return null;
}
