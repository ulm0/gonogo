// What the Hangar page decides, kept out of Hangar.tsx so that it can be tested without a DOM.

export type Eol = '\n' | '\r\n';

/**
 * A textarea turns every line ending into LF, so a CRLF file is edited as LF and written back as CRLF. A file that mixes the
 * two, or has a lone CR, cannot go back as it was: null, and the page shows it read-only.
 */
export function splitEol(text: string): { text: string; eol: Eol } | null {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  const cr = (text.match(/\r/g)?.length ?? 0) - crlf;
  if (cr > 0 || (crlf > 0 && lf > 0)) return null;
  return crlf > 0 ? { text: text.replace(/\r\n/g, '\n'), eol: '\r\n' } : { text, eol: '\n' };
}

export const joinEol = (text: string, eol: Eol): string => (eol === '\n' ? text : text.replace(/\n/g, '\r\n'));

/** What Tab writes: a tab when the file has a line that starts with one, else the indent of its first indented line (4 or 2 spaces). */
export function indentUnit(text: string): string {
  if (/^\t/m.test(text)) return '\t';
  const spaces = /^( +)\S/m.exec(text)?.[1].length ?? 0;
  return spaces > 0 && spaces % 4 === 0 ? '    ' : '  ';
}

/** Replace `value[from, to)` with `insert`, then select [start, end). */
export interface Edit {
  from: number;
  to: number;
  insert: string;
  start: number;
  end: number;
}

/**
 * What Tab (or Shift+Tab, `shift`) does with the selection [start, end) of `value`. A selection inside one line takes a tab
 * stop; one across lines, or Shift+Tab, changes the indent of every line it touches (a line the selection only enters at its
 * very start is not touched).
 */
export function indentEdit(value: string, start: number, end: number, shift: boolean, unit: string): Edit {
  if (!shift && !value.slice(start, end).includes('\n')) return { from: start, to: end, insert: unit, start: start + unit.length, end: start + unit.length };
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const found = value.indexOf('\n', last);
  const to = found === -1 ? value.length : found;
  const lines = value.slice(from, to).split('\n');
  const deltas: number[] = [];
  const changed = lines.map((line) => {
    const out = shift ? line.slice(line.startsWith('\t') ? 1 : Math.min(unit === '\t' ? 4 : unit.length, /^ */.exec(line)?.[0].length ?? 0)) : line === '' ? line : unit + line;
    deltas.push(out.length - line.length);
    return out;
  });
  const total = deltas.reduce((a, b) => a + b, 0);
  return { from, to, insert: changed.join('\n'), start: Math.max(from, start + (deltas[0] ?? 0)), end: Math.max(from, end + total) };
}

/** "1\n2\n...\nn", the numbers beside the text. */
export const gutterText = (count: number): string => Array.from({ length: count }, (_, i) => String(i + 1)).join('\n');

export const lineCount = (text: string): number => text.split('\n').length;

export const sizeText = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export const joinPath = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);
export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Why a path typed for a new file cannot be one, or null. The server judges it again. */
export function newPathProblem(path: string): string | null {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (path.trim() === '' || path.endsWith('/') || parts.length === 0) return 'Give the file a name.';
  if (path.startsWith('/')) return 'Use a path inside the agent\'s folder, not an absolute one.';
  if (parts.includes('..')) return 'A path cannot go up with ..';
  if (parts.some((p) => p.toLowerCase() === '.git')) return '.git is not reachable.';
  if (path.includes('\0')) return 'The path has a NUL character.';
  return null;
}

/** An edit that was not saved when the page was left, by agent, so that coming back finds it as it was. */
export interface Draft {
  path: string;
  /** What is in the editor (LF line ends). */
  value: string;
  /** What the file held when it was read, and the etag of that. */
  base: string;
  etag: string;
  eol: Eol;
}
export const drafts = new Map<string, Draft>();
