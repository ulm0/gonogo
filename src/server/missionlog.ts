/**
 * Mission Log: one memory shared by every agent, searchable (docs/mission-log-spec.md).
 *
 * One markdown file per entry, `<home>/mission-log/<id>.md`: a small front matter (id, title, tags, author, createdAt, updatedAt,
 * each value written as JSON on one line) and then the body. The Director (the browser routes) and every agent (the MCP tools
 * log_write, log_search, log_read) use the same store. The entries are held in memory and indexed for BM25 search (logsearch.ts) at
 * start and at every write; a write goes to the file first, so a refusal of the disk reaches the caller and nothing changes in memory.
 * The author is stamped by the server from the agent's token. An agent may change only what it wrote; the Director may change or
 * remove any entry. The clock is injected for tests.
 *
 * shortcut: every entry is held in memory (at the limits, 2000 entries of 20,000 characters is about 40 MB) and the list of the page
 * shows the newest LOG_SEARCH_MAX; page it or read the files on demand if a log ever gets that big.
 * shortcut: `author` is an agent name, so a renamed agent can no longer change what it wrote (the Director still can), and a new
 * agent hired under the name of a removed one may change what the old one wrote; stamp a per-hire id if that ever matters.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_BODY_MAX_CHARS, LOG_ENTRIES_MAX, LOG_QUERY_MAX_CHARS, LOG_SEARCH_MAX, LOG_TAG_PATTERN, LOG_TAGS_MAX, LOG_TITLE_MAX_CHARS } from '../shared/protocol.js';
import type { LogChart, LogEntry, LogFrame, LogHit, Logger, LogSearch } from '../shared/protocol.js';
import { DIR_MODE, FILE_MODE, LOG_DIR } from './constants.js';
import { isRecord } from './hooks.js';
import { HubError } from './hub.js';
import { buildChart } from './logchart.js';
import { createIndex, snippet } from './logsearch.js';
import { UNSAFE_IN_NAME } from './schedules.js';

const ID_RE = /^l[1-9]\d{0,5}$/;
const FILE_RE = /^(l[1-9]\d{0,5})\.md$/;
const TAG_RE = new RegExp(LOG_TAG_PATTERN);
const FIELDS = ['title', 'body', 'tags'];
/** Holds the highest id ever given, so that the id of a removed entry is not given again after a restart. */
const SEQ_FILE = '.seq';

export interface MissionLogOptions {
  /** gonogo's home: the folder mission-log/ lives here. */
  dir: string;
  now(): number;
  /** Entries were written, changed or removed: ids and titles only. */
  emit(frame: LogFrame): void;
  log: Logger;
}

export interface MissionLog {
  /** Reads every entry; a file that is not an entry is skipped with a warning and kept. */
  load(): Promise<void>;
  /** The entries that hold a word of the query, best first; an empty query gives the newest. At most `limit` hits. */
  search(query: string, limit?: number): LogSearch;
  get(id: string): LogEntry;
  /** Star Chart: the newest entries with their tags, authors and mentions of each other (logchart.ts). */
  chart(): LogChart;
  /** The input is a JSON value from the wire; a bad one throws a HubError (bad_request, field). The title and the body are required. */
  create(author: string, input: unknown): Promise<LogEntry>;
  /** `by` is the agent that asks, who may change only its own entries; null is the Director. The fields given change; at least one. */
  update(id: string, input: unknown, by: string | null): Promise<LogEntry>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
const copy = (entry: LogEntry): LogEntry => ({ ...entry, tags: [...entry.tags] });

interface Fields {
  title?: string;
  body?: string;
  tags?: string[];
}

function validate(input: unknown, whole: boolean): Fields {
  if (!isRecord(input)) throw bad('request body must be a JSON object');
  for (const key of Object.keys(input)) if (!FIELDS.includes(key)) throw bad(`unknown field "${key}"`, key);
  if (whole && (input.title === undefined || input.body === undefined)) throw bad('title and body are required', input.title === undefined ? 'title' : 'body');
  if (!whole && Object.keys(input).length === 0) throw bad('nothing to change: give a title, a body or tags');
  const out: Fields = {};
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title === '' || title.length > LOG_TITLE_MAX_CHARS || UNSAFE_IN_NAME.test(title)) throw bad(`title must be 1 to ${LOG_TITLE_MAX_CHARS} characters on one line`, 'title');
    out.title = title;
  }
  if (input.body !== undefined) {
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (body === '' || body.length > LOG_BODY_MAX_CHARS) throw bad(`body must be 1 to ${LOG_BODY_MAX_CHARS} characters`, 'body');
    out.body = body;
  }
  if (input.tags !== undefined) {
    const tags = Array.isArray(input.tags) ? input.tags.map((t: unknown) => (typeof t === 'string' ? t.trim().toLowerCase() : '')) : [];
    if (!Array.isArray(input.tags) || tags.length > LOG_TAGS_MAX || !tags.every((t) => TAG_RE.test(t))) {
      throw bad(`tags must be a list of at most ${LOG_TAGS_MAX} words of 1 to 30 letters, digits, dots, dashes or underscores`, 'tags');
    }
    out.tags = [...new Set(tags)];
  }
  return out;
}

const render = (e: LogEntry): string =>
  [
    '---',
    'version: 1',
    `id: ${JSON.stringify(e.id)}`,
    `title: ${JSON.stringify(e.title)}`,
    `tags: ${JSON.stringify(e.tags)}`,
    `author: ${JSON.stringify(e.author)}`,
    `createdAt: ${JSON.stringify(new Date(e.createdAt).toISOString())}`,
    `updatedAt: ${JSON.stringify(new Date(e.updatedAt).toISOString())}`,
    '---',
    e.body,
    '',
  ].join('\n');

/** The entry in a file; a file that is not one throws, and the caller skips it. */
function parse(text: string, id: string): LogEntry {
  const found = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!found) throw new Error('no front matter');
  const values = new Map<string, unknown>();
  for (const line of (found[1] ?? '').split('\n')) {
    const at = line.indexOf(': ');
    if (at < 0) throw new Error('a front matter line is not "key: value"');
    values.set(line.slice(0, at), JSON.parse(line.slice(at + 2)) as unknown);
  }
  const { version, title, tags, author, createdAt, updatedAt } = Object.fromEntries(values) as Record<string, unknown>;
  const at = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : Number.NaN);
  // an entry from before there was a version has none and reads as version 1
  if (version !== undefined && version !== 1) throw new Error(`format version ${String(version)} was saved by another gonogo; this one reads version 1`);
  if (values.get('id') !== id) throw new Error('the id does not match the name of the file');
  if (typeof title !== 'string' || title === '' || title.length > LOG_TITLE_MAX_CHARS) throw new Error('no valid title');
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) throw new Error('no valid tags');
  if (typeof author !== 'string' || author === '') throw new Error('no valid author');
  if (Number.isNaN(at(createdAt)) || Number.isNaN(at(updatedAt))) throw new Error('no valid times');
  const body = (found[2] ?? '').replace(/\n$/, '');
  return { id, title, body: body.slice(0, LOG_BODY_MAX_CHARS), tags: tags as string[], author, createdAt: at(createdAt), updatedAt: at(updatedAt) };
}

export function createMissionLog(options: MissionLogOptions): MissionLog {
  const { log } = options;
  // Strictly increasing: two writes in the same millisecond must not tie, or the order of the newest-first list is a coin toss.
  let lastAt = 0;
  const now = (): number => (lastAt = Math.max(options.now(), lastAt + 1));
  const dir = join(options.dir, LOG_DIR);
  const entries = new Map<string, LogEntry>();
  const index = createIndex();
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();

  /** One write at a time, so the limit and the ids hold; a failure goes to the caller and the next write goes on. */
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /** Written whole to a temporary file and renamed, so a crash leaves the old text or the new, never half. */
  const writeFileAtomic = async (name: string, text: string): Promise<void> => {
    const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
    await rename(tmp, join(dir, name));
  };

  const keep = (entry: LogEntry): void => {
    entries.set(entry.id, entry);
    index.add({ id: entry.id, title: entry.title, tags: entry.tags, body: entry.body, at: entry.updatedAt });
  };

  const find = (id: string): LogEntry => {
    const entry = ID_RE.test(id) ? entries.get(id) : undefined;
    if (!entry) throw new HubError('not_found', 'unknown entry');
    return entry;
  };

  const hit = (e: LogEntry, query: string): LogHit => ({ id: e.id, title: e.title, author: e.author, tags: e.tags, updatedAt: e.updatedAt, snippet: snippet(e.body, query) });

  return {
    async load() {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      for (const name of await readdir(dir)) {
        const id = FILE_RE.exec(name)?.[1];
        if (id === undefined) continue;
        seq = Math.max(seq, Number(id.slice(1)));
        try {
          keep(parse(await readFile(join(dir, name), 'utf8'), id));
        } catch (error) {
          // the file stays as it is: it may be a hand edit that the Director wants to mend
          log.warn(`${LOG_DIR}/${name} was skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const saved = Number(await readFile(join(dir, SEQ_FILE), 'utf8').catch(() => '0'));
      if (Number.isSafeInteger(saved) && saved > seq) seq = saved;
    },

    search(query, limit = LOG_SEARCH_MAX) {
      const q = query.slice(0, LOG_QUERY_MAX_CHARS);
      const cap = Math.min(Math.max(Math.trunc(limit), 1), LOG_SEARCH_MAX);
      const found = q.trim() === '' ? [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt).slice(0, cap) : index.search(q, cap).map((r) => find(r.id));
      return { total: entries.size, hits: found.map((e) => hit(e, q)) };
    },

    get: (id) => copy(find(id)),

    chart: () => buildChart([...entries.values()]),

    create(author, input) {
      return locked(async () => {
        const fields = validate(input, true);
        if (entries.size >= LOG_ENTRIES_MAX) throw new HubError('conflict', `the Mission Log holds at most ${LOG_ENTRIES_MAX} entries: remove one first`, 'log');
        const at = now();
        const entry: LogEntry = { id: `l${seq + 1}`, title: fields.title ?? '', body: fields.body ?? '', tags: fields.tags ?? [], author, createdAt: at, updatedAt: at };
        await writeFileAtomic(`${entry.id}.md`, render(entry));
        seq += 1;
        keep(entry);
        options.emit({ t: 'log', changed: [{ id: entry.id, title: entry.title }], removed: [] });
        return copy(entry);
      });
    },

    update(id, input, by) {
      return locked(async () => {
        const old = find(id);
        if (by !== null && old.author !== by) throw new HubError('forbidden', `${id} was written by ${old.author}: only its author or the Director may change it`);
        const fields = validate(input, false);
        const next: LogEntry = { ...old, ...fields, updatedAt: now() };
        if (next.title === old.title && next.body === old.body && next.tags.join() === old.tags.join()) return copy(old);
        await writeFileAtomic(`${id}.md`, render(next));
        keep(next);
        options.emit({ t: 'log', changed: [{ id, title: next.title }], removed: [] });
        return copy(next);
      });
    },

    remove(id) {
      return locked(async () => {
        find(id);
        await writeFileAtomic(SEQ_FILE, String(seq));
        // force: a file already deleted by hand must not leave an entry that can never be removed
        await rm(join(dir, `${id}.md`), { force: true });
        entries.delete(id);
        index.remove(id);
        options.emit({ t: 'log', changed: [], removed: [id] });
      });
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
