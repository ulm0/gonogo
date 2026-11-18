/**
 * Plot Board: the one current plan of the room (docs/plot-board-spec.md).
 *
 * One file, `<home>/board.md`: a small front matter (version, revision, author, updatedAt; each value JSON on one line) and then the
 * plan as plain text. The Director (the browser route) and the boss (the MCP tool board_write) write it; every agent reads it. Who
 * may write is decided by the caller (the route is the Director's, the tool checks for the boss): this store only checks the text and
 * the revision. A write names the revision it read and is refused when the board has moved on, so a write never replaces text its
 * author did not see. The file is written whole to a temporary file and renamed. A file without our front matter (written by hand) is
 * read as the plan itself. The clock is injected for tests.
 *
 * shortcut: a hand edit made while gonogo runs is not seen until the next start, and the next write replaces it; read the file again
 * on each get if that ever matters.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOARD_MAX_CHARS } from '../shared/protocol.js';
import type { BoardView } from '../shared/protocol.js';
import { BOARD_FILE, FILE_MODE } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';

export interface BoardOptions {
  /** gonogo's home: board.md lives here. */
  dir: string;
  now(): number;
}

export interface Board {
  /** Reads the file. A file saved by a newer gonogo throws: the start stops, as for the JSON files (migrate.ts). */
  load(): Promise<void>;
  get(): BoardView;
  /** `by` is "user" or an agent name. The input is a JSON value from the wire, `{ text, revision }`; a bad one throws a HubError (bad_request, field; conflict for a revision that is not the current one). */
  write(by: string, input: unknown): Promise<BoardView>;
  close(): Promise<void>;
}

const FIELDS = ['text', 'revision'];
/** The keys of our front matter; a file whose first lines are anything else is a plan written by hand. */
const FRONT_KEYS = ['version', 'revision', 'author', 'updatedAt'];
const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);

const render = (view: BoardView): string =>
  [
    '---',
    'version: 1',
    `revision: ${JSON.stringify(view.revision)}`,
    `author: ${JSON.stringify(view.author)}`,
    `updatedAt: ${JSON.stringify(view.updatedAt === null ? null : new Date(view.updatedAt).toISOString())}`,
    '---',
    view.text,
    '',
  ].join('\n');

/** The board in a file; one that has our front matter is read by it, any other text is the plan itself. */
function parse(text: string, mtime: number, path: string): BoardView {
  const found = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  const values = new Map<string, unknown>();
  try {
    for (const line of found === null ? [] : (found[1] ?? '').split('\n')) {
      const at = line.indexOf(': ');
      if (at < 0 || !FRONT_KEYS.includes(line.slice(0, at))) throw new Error('not ours');
      values.set(line.slice(0, at), JSON.parse(line.slice(at + 2)) as unknown);
    }
  } catch {
    values.clear();
  }
  if (found === null || values.size === 0) return { text: text.replace(/\r\n/g, '\n').trimEnd().slice(0, BOARD_MAX_CHARS), revision: 0, author: null, updatedAt: mtime };
  const { version, revision, author, updatedAt } = Object.fromEntries(values) as Record<string, unknown>;
  if (version !== undefined && version !== 1) {
    throw new Error(`${path} was saved by a newer gonogo (format version ${String(version)}; this one reads up to 1). Start the gonogo that saved it, or move the file away to start without it.`);
  }
  const at = typeof updatedAt === 'string' ? Date.parse(updatedAt) : Number.NaN;
  return {
    text: (found[2] ?? '').replace(/\n$/, '').slice(0, BOARD_MAX_CHARS),
    revision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    author: typeof author === 'string' && author !== '' ? author : null,
    updatedAt: Number.isNaN(at) ? mtime : at,
  };
}

export function createBoard(options: BoardOptions): Board {
  const { now } = options;
  const path = join(options.dir, BOARD_FILE);
  let current: BoardView = { text: '', revision: 0, author: null, updatedAt: null };
  let chain: Promise<unknown> = Promise.resolve();

  /** One write at a time, so that two writers of one revision cannot both succeed; a failure goes to the caller and the next write goes on. */
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      current = parse(text, (await stat(path)).mtimeMs, path);
    },

    get: () => ({ ...current }),

    write(by, input) {
      return locked(async () => {
        if (!isRecord(input)) throw bad('request body must be a JSON object');
        for (const key of Object.keys(input)) if (!FIELDS.includes(key)) throw bad(`unknown field "${key}"`, key);
        if (typeof input.text !== 'string') throw bad('text is required', 'text');
        const text = input.text.replace(/\r\n?/g, '\n').trimEnd();
        if (text.length > BOARD_MAX_CHARS) throw bad(`text must be at most ${BOARD_MAX_CHARS} characters`, 'text');
        if (text.includes('\0')) throw bad('text must not hold a NUL character', 'text');
        if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0) throw bad('revision must be a whole number, the one you read', 'revision');
        if (input.revision !== current.revision) {
          throw new HubError('conflict', `the Plot Board is at revision ${current.revision}, not ${input.revision}: read it again, then write`, 'revision');
        }
        // the same text again changes nothing: no new revision, no new file
        if (text === current.text) return { ...current };
        const next: BoardView = { text, revision: current.revision + 1, author: by, updatedAt: now() };
        const tmp = join(options.dir, `.${BOARD_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        await writeFile(tmp, render(next), { mode: FILE_MODE, flag: 'wx' });
        await rename(tmp, path);
        current = next;
        return { ...current };
      });
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
