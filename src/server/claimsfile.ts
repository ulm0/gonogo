/**
 * The `claims.md` of a repository's knowledge (docs/knowledge-spec.md 0b.1): multivac's six-column table, so the file is a valid
 * multivac `invariants.md`, with the anchor comment lines of a claim under its row:
 *
 *   | ID | statement | authority | state | date | source |
 *   | K-1 | The limit is 5. | director | active | 2026-11-21 | store |
 *   <!-- @anchor K-1 brain:src/** /limit = 5/ present -->
 *
 * Columns are counted from the end (a statement may hold `|`). This module only reads and writes the shape of the file: an anchor
 * line is kept as text, and what it means (the legs) is the grammar's (`parseLegs`, injected: K2 supplies the real one). Text that came
 * from a file is never trusted: a line that is not a row, a row that has not six cells, an id that is not an id: all are diagnostics.
 */
import type { Claim, Leg } from '../shared/protocol.js';

export const CLAIMS_FILE_MAX_BYTES = 256 * 1024;
export const CLAIMS_MAX = 200;
export const LEGS_MAX = 500;
export const STATEMENT_MAX_CHARS = 300;

/** What the grammar says of anchor lines: the legs, and what is wrong with them (lines are 1-based in the file). */
export type ParseLegs = (lines: ReadonlyArray<{ line: number; text: string }>, claimId: string) => { legs: Leg[]; diagnostics: Array<{ line: number; message: string }> };
/** Until the grammar of K2 is there: every anchor line is kept as text and means no leg. */
export const noLegs: ParseLegs = () => ({ legs: [], diagnostics: [] });

/** A claim as the file holds it. */
export interface Row {
  id: string;
  statement: string;
  authority: string;
  state: 'active' | 'retired';
  date: string;
  source: string;
  /** The anchor comment lines, as written. */
  anchors: string[];
}

export interface Parsed {
  rows: Row[];
  claims: Claim[];
  diagnostics: Array<{ line: number; message: string }>;
  /** Why the whole file cannot be trusted (too large, no table), or null. */
  damaged: string | null;
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,15}-\d{1,6}$/;
const WORD = /^[a-z][a-z0-9-]{0,30}$/;
const ANCHOR_LINE = /^<!--\s*@anchor\s+(\S+)\s[\s\S]*-->\s*$/;
const HEADER = ['ID', 'statement', 'authority', 'state', 'date', 'source'];

/** One line of text for a statement: control, bidi and zero-width characters out, whitespace collapsed, cut to 300 (S6). */
export const cleanStatement = (text: string): string => text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, STATEMENT_MAX_CHARS);

export function parseClaimsFile(text: string, source: 'store' | 'repo', parseLegs: ParseLegs = noLegs): Parsed {
  const out: Parsed = { rows: [], claims: [], diagnostics: [], damaged: null };
  if (Buffer.byteLength(text) > CLAIMS_FILE_MAX_BYTES) return { ...out, damaged: `larger than ${CLAIMS_FILE_MAX_BYTES / 1024} KiB` };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let sawTable = false;
  const anchorsOf = new Map<string, Array<{ line: number; text: string }>>();
  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const comment = ANCHOR_LINE.exec(line);
    if (comment) {
      const id = comment[1] ?? '';
      const row = out.rows.find((r) => r.id === id);
      if (row === undefined) out.diagnostics.push({ line: n, message: `an anchor for ${id.slice(0, 20)}, which has no row above it` });
      else {
        row.anchors.push(line);
        anchorsOf.set(id, [...(anchorsOf.get(id) ?? []), { line: n, text: line }]);
      }
      continue;
    }
    if (line.startsWith('<!--')) continue;
    if (!line.startsWith('|')) {
      out.diagnostics.push({ line: n, message: 'a line that is neither a table row nor an anchor' });
      continue;
    }
    const parts = line.replace(/^\|/, '').replace(/\|$/, '').split('|');
    const cells = parts.map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) {
      sawTable = true;
      continue;
    }
    if (cells.length < 6) {
      out.diagnostics.push({ line: n, message: `a row needs six columns, this has ${cells.length}` });
      continue;
    }
    const [id = '', ...rest] = cells;
    const [authority = '', state = '', date = '', rowSource = ''] = rest.slice(-4);
    // the statement is what is left between the id and the last four cells, with its own | and spaces as they were written
    const statement = parts.slice(1, parts.length - 4).join('|').trim();
    if (id === HEADER[0] && statement === HEADER[1]) {
      sawTable = true;
      continue;
    }
    if (!ID.test(id)) out.diagnostics.push({ line: n, message: 'the id of a claim is letters, a dash and a number, like K-1' });
    else if (out.rows.some((r) => r.id === id)) out.diagnostics.push({ line: n, message: `${id} is repeated` });
    else if (state !== 'active' && state !== 'retired') out.diagnostics.push({ line: n, message: `${id}: the state is active or retired` });
    else if (statement === '' || !WORD.test(authority)) out.diagnostics.push({ line: n, message: `${id}: a statement and an authority are needed` });
    else {
      const row: Row = { id, statement: cleanStatement(statement), authority, state, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', source: rowSource.replace(UNSAFE, ' ').trim().slice(0, 80), anchors: [] };
      out.rows.push(row);
    }
    if (out.rows.length > CLAIMS_MAX) return { ...out, rows: [], claims: [], damaged: `more than ${CLAIMS_MAX} claims` };
  }
  if (!sawTable && out.rows.length === 0 && text.trim() !== '' && out.diagnostics.length > 0) return { ...out, damaged: 'no claims table' };
  let legCount = 0;
  for (const row of out.rows) {
    const parsed = parseLegs(anchorsOf.get(row.id) ?? [], row.id);
    legCount += row.anchors.length;
    out.claims.push({
      id: row.id,
      statement: row.statement,
      authority: row.authority,
      state: row.state,
      date: row.date,
      source,
      ...(row.source === '' ? {} : { from: row.source }),
      legs: parsed.legs,
      diagnostics: parsed.diagnostics,
    });
  }
  if (legCount > LEGS_MAX) return { ...out, rows: [], claims: [], damaged: `more than ${LEGS_MAX} anchors` };
  return out;
}

const cell = (text: string): string => text.replace(/\|/g, '¦');

/** The file for these rows. A `|` inside a cell other than the statement is replaced (the statement is read back from the end). */
export function renderClaimsFile(rows: readonly Row[]): string {
  const out = ['# Claims', '', '<!-- gonogo knowledge store. The format of multivac\'s invariants.md; edit it here or in the page. -->', '', `| ${HEADER.join(' | ')} |`, '|----|-------|-----------|-------|------|--------|'];
  for (const r of rows) {
    out.push(`| ${r.id} | ${r.statement.replace(UNSAFE, ' ')} | ${cell(r.authority)} | ${r.state} | ${r.date} | ${cell(r.source)} |`);
    out.push(...r.anchors);
  }
  return `${out.join('\n')}\n`;
}
