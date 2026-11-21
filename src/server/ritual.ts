/**
 * The closing ritual of a Mission (docs/features/missions.md, "The closing ritual"): a short checklist, copied into the mission when it is made, shown when it is
 * closed. Printed, never checked, never a gate. The template is the room's own file `<home>/ritual.md`, which the Director edits in Flight Rules (step-up).
 * Nothing is read from a repo in this phase.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';
import { RITUAL_ITEMS_MAX, RITUAL_ITEM_MAX_CHARS, RITUAL_TEMPLATE_MAX_BYTES } from '../shared/protocol.js';
import type { RitualItem, RitualTemplateView } from '../shared/protocol.js';
import { FILE_MODE } from './constants.js';
import { HubError } from './hub.js';

export const RITUAL_FILE_MAX_BYTES = 16 * 1024;
/** Control, bidi and zero-width characters (and line and paragraph separators): never in a line of the ritual. */
/** Built from code points, so that no invisible character sits in this file. */
const UNSAFE = new RegExp(`[${['0000-001f', '007f-009f', '061c', '180e', '200b-200f', '2028-2029', '202a-202e', '2060-2064', '2066-2069', 'feff', 'fff9-fffb'].map((r) => r.split('-').map((c) => `\\u${c}`).join('-')).join('')}\\u{e0000}-\\u{e007f}]`, 'gu');

/** One line of text, cleaned and cut. */
export function cleanLine(text: string): string {
  const line = text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= RITUAL_ITEM_MAX_CHARS ? line : `${line.slice(0, RITUAL_ITEM_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * The lines of a ritual file: blank lines, headings (`#`) and comments (`<!-- -->`, also over several lines) dropped, a list marker (`-`, `*`, `+`, `1.` and a `[ ]` or `[x]` box)
 * taken off. Returns the first RITUAL_ITEMS_MAX and how many there were.
 */
export function parseRitual(content: string): { lines: string[]; total: number } {
  const all: string[] = [];
  let inComment = false;
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    let text = raw;
    if (inComment) {
      const end = text.indexOf('-->');
      if (end < 0) continue;
      inComment = false;
      text = text.slice(end + 3);
    }
    for (let start = text.indexOf('<!--'); start >= 0; start = text.indexOf('<!--')) {
      const end = text.indexOf('-->', start + 4);
      if (end < 0) {
        inComment = true;
        text = text.slice(0, start);
        break;
      }
      text = text.slice(0, start) + text.slice(end + 3);
    }
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const line = cleanLine(trimmed.replace(/^(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, ''));
    if (line !== '') all.push(line);
  }
  return { lines: all.slice(0, RITUAL_ITEMS_MAX), total: all.length };
}

/** A regular file read through its realpath, which must be `root` itself or lie under it, without following a link at the end; null when it is not one or cannot be read. */
export function readInside(root: string, file: string): string | null {
  let fd = -1;
  try {
    // the file itself is not a link (not even to another file of the same folder: ritual.md -> auth.json), and its folders resolve inside the root
    if (lstatSync(file).isSymbolicLink()) return null;
    const realRoot = realpathSync(root);
    const real = realpathSync(file);
    if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return null;
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(info.size, RITUAL_FILE_MAX_BYTES));
    let got = 0;
    while (got < buffer.length) {
      const n = readSync(fd, buffer, got, buffer.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return buffer.subarray(0, got).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export const RITUAL_FILE = 'ritual.md';

/** The items of a new mission from the room's template: `from: 'room'`, the first RITUAL_ITEMS_MAX; `omitted` is how many more the file had. */
export function readTemplate(home: string): { items: RitualItem[]; omitted: number } {
  const file = readInside(home, join(home, RITUAL_FILE));
  if (file === null) return { items: [], omitted: 0 };
  const { lines, total } = parseRitual(file);
  return { items: lines.map((text) => ({ text, done: false, from: 'room' as const })), omitted: total - lines.length };
}

const UNSAFE_ONE = new RegExp(UNSAFE.source, 'u');

/** The line of an item the Director or the boss writes: one line of plain text with no control, escape, direction or zero-width character, 1 to RITUAL_ITEM_MAX_CHARS characters; refused otherwise (named by `field`). */
export function itemText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new HubError('bad_request', 'an item is text', field);
  const text = value.trim().replace(/ {2,}/g, ' ');
  if (text === '' || text.length > RITUAL_ITEM_MAX_CHARS || UNSAFE_ONE.test(text)) {
    throw new HubError('bad_request', `an item is 1 to ${RITUAL_ITEM_MAX_CHARS} characters on one line, with no control or direction character`, field);
  }
  return text;
}

export interface RitualTemplateStore {
  view(): Promise<RitualTemplateView>;
  /** The text of the file (comments and headings allowed); refused over RITUAL_TEMPLATE_MAX_BYTES or with a NUL or control character other than a line break and a tab. */
  set(text: unknown): Promise<RitualTemplateView>;
}

/** `<home>/ritual.md`, 0600, written whole through a temporary file. Reads go through readInside (a link in its place is not followed). */
export function createRitualTemplate(options: { dir: string; now(): number }): RitualTemplateStore {
  const path = join(options.dir, RITUAL_FILE);
  let chain: Promise<unknown> = Promise.resolve();
  const view = async (): Promise<RitualTemplateView> => {
    const text = readInside(options.dir, path) ?? '';
    const info = await stat(path).catch(() => null);
    return { text, bytes: Buffer.byteLength(text), max: RITUAL_TEMPLATE_MAX_BYTES, updatedAt: info === null ? null : Math.round(info.mtimeMs) };
  };
  return {
    view,
    set(text) {
      if (typeof text !== 'string') throw new HubError('bad_request', 'text must be a string', 'text');
      if (Buffer.byteLength(text) > RITUAL_TEMPLATE_MAX_BYTES) throw new HubError('bad_request', `the template is at most ${RITUAL_TEMPLATE_MAX_BYTES} bytes`, 'text');
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new HubError('bad_request', 'the template has a control character', 'text');
      const run = chain.then(async () => {
        const temp = join(options.dir, `.${RITUAL_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        await writeFile(temp, text, { mode: FILE_MODE, flag: 'wx' });
        await rename(temp, path);
        return view();
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}


