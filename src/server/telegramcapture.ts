/**
 * Telegram capture (docs/telegram-capture.md): a way to record what the real Bot API sends, so the tests replay shapes that were seen and not only
 * shapes that were read in documentation. OFF unless the environment of gonogo has `GONOGO_TELEGRAM_CAPTURE=<folder>[:<N>]`; there is no route,
 * no flag and no page for it. It wraps the one `fetch` that Telegram polling and Telegram files share, so the bot token never leaves the process:
 * what is written is the answer of `getUpdates` (one file per update) and of `getFile` (the whole answer, errors included), after REDACTION.
 *
 * Redaction is an allowlist: a string is "<redacted>" unless its key is one of a few structural ones (`type`, `mime_type`, `description`, ...), an
 * identifying number (an id, a date) becomes a fixed fake one of the same kind, and `file_path` keeps its folder and its extension. The file download
 * (`/file/bot.../`) is never read, so no byte of a file is kept. Before a file is written its text is searched for the token and for every real id
 * that was seen: a hit refuses the file (and says so, without saying what). Files are 0600 in a 0700 folder and are never replaced; after N the capture stops.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';

export const CAPTURE_DEFAULT = 12;
export const CAPTURE_MAX = 50;

/** `GONOGO_TELEGRAM_CAPTURE` as `<folder>` or `<folder>:<N>`; null when it is unset or empty. */
export function parseCaptureEnv(value: string | undefined): { dir: string; max: number } | null {
  const text = (value ?? '').trim();
  if (text === '') return null;
  const m = /^(.*):(\d{1,3})$/.exec(text);
  const dir = m === null ? text : (m[1] as string);
  if (dir === '' || !dir.startsWith('/')) return null;
  const n = m === null ? CAPTURE_DEFAULT : Number(m[2]);
  return { dir, max: Math.min(Math.max(n, 1), CAPTURE_MAX) };
}

/** String values that are structure, not content: kept as they are. */
const KEEP = new Set(['type', 'mime_type', 'description', 'language_code', 'file_path', 'status', 'ok_note']);

export interface Redactor {
  /** The redacted copy of a JSON value. */
  redact(value: unknown): unknown;
  /** The real numbers that were seen as ids, as text: what must not be left in a written file. */
  seen(): string[];
}

/** A redactor that keeps its fake numbers stable across the files of one capture (the same chat is the same fake chat). */
export function createRedactor(): Redactor {
  const maps = new Map<string, Map<number, number>>();
  const real = new Set<string>();
  const fake = (kind: 'chat' | 'message' | 'update' | 'date', n: number): number => {
    let map = maps.get(kind);
    if (map === undefined) maps.set(kind, (map = new Map()));
    let out = map.get(n);
    if (out === undefined) {
      const index = map.size + 1;
      out = kind === 'chat' ? 700_000_000 + index : kind === 'message' ? 100 + index : kind === 'update' ? 9_000 + index : 1_700_000_000 + index * 60;
      map.set(n, out);
    }
    return out;
  };
  const kindOf = (key: string): 'chat' | 'message' | 'update' | 'date' | null =>
    key === 'update_id' ? 'update' : key === 'message_id' || key === 'message_thread_id' ? 'message' : key === 'date' || key.endsWith('_date') ? 'date' : key === 'id' || key === 'user_id' || key === 'chat_id' || key === 'forward_from_message_id' ? (key === 'forward_from_message_id' ? 'message' : 'chat') : null;
  const filePath = (path: string): string => {
    // photos/file_12.jpg -> photos/file_1.jpg: the folder and the extension are the shape; the number is an id
    const m = /^([A-Za-z0-9_-]{1,40})\/[A-Za-z0-9_-]{1,80}(\.[A-Za-z0-9]{1,5})?$/.exec(path);
    return m === null ? '<redacted>' : `${m[1]}/file_1${m[2] ?? ''}`;
  };
  const walk = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    if (typeof value === 'number') {
      const kind = kindOf(key);
      if (kind === null) return value;
      real.add(String(value));
      return fake(kind, value);
    }
    if (typeof value === 'string') {
      if (key === 'file_path') return filePath(value);
      return KEEP.has(key) ? value : '<redacted>';
    }
    return value;
  };
  return { redact: (value) => walk(value, ''), seen: () => [...real] };
}

export interface CaptureOptions {
  dir: string;
  max: number;
  /** The bot token, to be sure it is nowhere in what is written. */
  token(): string | null;
  log: Logger;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The `fetch` to give Telegram polling and files: the same, with a copy of the answers it is asked to keep. */
export function captureFetch(inner: Fetch, options: CaptureOptions): Fetch {
  const redactor = createRedactor();
  let count = 0;
  let writing: Promise<void> = Promise.resolve();

  async function keep(method: string, status: number, body: unknown): Promise<void> {
    if (count >= options.max) return;
    // an empty getUpdates is a lull, not a capture
    const items = method === 'getUpdates' && typeof body === 'object' && body !== null && Array.isArray((body as { result?: unknown }).result) ? ((body as { result: unknown[] }).result) : [body];
    for (const item of items) {
      if (count >= options.max) return;
      const out = JSON.stringify({ method, status, body: redactor.redact(item) }, null, 2);
      const token = options.token();
      // the seen ids are collected by the redaction above: any of them still in the text, or the token, refuses the file
      const leaks = [...(token === null ? [] : [token]), ...redactor.seen().filter((n) => n.length >= 5)];
      if (leaks.some((l) => out.includes(l))) {
        options.log.warn('telegram capture: a file was not written: it still held an id or the token after redaction');
        continue;
      }
      count += 1;
      const file = join(options.dir, `${String(count).padStart(2, '0')}-${method}.json`);
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      await writeFile(file, `${out}\n`, { flag: 'wx', mode: 0o600 });
    }
  }

  return async (url, init) => {
    const res = await inner(url, init);
    // the method is the last part of the address; the file download (`/file/bot.../`) has none of these and is never read
    const method = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(getUpdates|getFile)$/.exec(url)?.[1];
    if (method === undefined || count >= options.max) return res;
    const copy = res.clone();
    writing = writing
      .then(async () => keep(method, copy.status, await copy.json()))
      .catch((error: unknown) => options.log.warn(`telegram capture: not written (${error instanceof Error ? error.name : 'error'})`));
    return res;
  };
}
