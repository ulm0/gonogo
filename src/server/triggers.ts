/**
 * The history of triggers (docs/features/triggers.md): one append-only log per room of everything that fired by itself or came in from outside:
 * an uplink delivery (a webhook, or a polled Telegram update), a Launch Window run, a Docking hand-off or an inbound call from a station.
 * Each line says what fired, when, what it did (the message id, the agent it went to) and how it ended.
 *
 * `<home>/triggers.jsonl`, mode 0600, one JSON object per line. The file is rotated to `triggers.1.jsonl` (the one before it is dropped) when it passes
 * 1 MiB or its first line is older than 90 days; a read looks at both and ignores lines older than 90 days. What is written is the SMALL part of a
 * payload only: its first 160 characters on one line, with everything that looks like a secret replaced (`redactSecrets`), never a header, a
 * secret or a whole body. A bad signature is not a trigger (anyone who guesses an id could fill the log): it is counted by the uplink as before.
 *
 * shortcut: a read parses both files each time (at most about 2 MiB); a room with a very busy webhook would want an index.
 */
import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TRIGGER_KINDS } from '../shared/protocol.js';
import type { Logger, TriggerEntry, TriggerKind, TriggerQuery } from '../shared/protocol.js';
import { FILE_MODE, nullLogger } from './constants.js';
import { isRecord } from './hooks.js';

export const TRIGGERS_FILE = 'triggers.jsonl';
export const TRIGGERS_OLD_FILE = 'triggers.1.jsonl';
export const TRIGGERS_ROTATE_BYTES = 1024 * 1024;
export const TRIGGERS_KEEP_MS = 90 * 24 * 3_600_000;
export const TRIGGERS_LIMIT_DEFAULT = 100;
export const TRIGGERS_LIMIT_MAX = 500;
const WHAT_CHARS = 160;
const NOTE_CHARS = 200;
const NAME_CHARS = 80;

/** Replaces what looks like a secret: bearer and token values, key=value pairs of a secret's name, the known token shapes of the services gonogo talks to, and any long unbroken run. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(token|access_token|secret|client_secret|password|passwd|pwd|api[_-]?key|apikey|authorization|signature|sig|credential)(["']?\s*[=:]\s*["']?)[^\s"'&#,}]+/gi, '$1$2[redacted]')
    // user:password@ in a URL (https://oauth2:glpat-...@gitlab.com): the userinfo goes, the host stays
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, '[redacted]')
    .replace(/\bxapp-[A-Za-z0-9-]{8,}/g, '[redacted]')
    .replace(/\bglpat-[\w-]{20,}/g, '[redacted]')
    .replace(/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\bgnk_[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, '[redacted]');
}

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]+', 'g');

/** One line of the payload, safe to keep: control characters and line breaks to spaces, secrets out, then cut. */
export function excerptOf(text: string, max: number = WHAT_CHARS): string {
  const one = redactSecrets(text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim());
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What a part of the server tells the log; the time is the log's. */
export type TriggerInput = Omit<TriggerEntry, 'at'>;

export interface Triggers {
  load(): Promise<void>;
  /** Appends one entry. Never throws: a failed write is logged, the trigger itself must go on. */
  record(input: TriggerInput): void;
  /** Newest first, filtered; `limit` default 100, at most 500. */
  list(query?: TriggerQuery): Promise<TriggerEntry[]>;
  close(): Promise<void>;
}

const word = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.:@ -]/g, '').slice(0, max) : '');

/** An entry from outside the log (a line of the file, an input of a caller): the shape it must have, with every text cut and redacted; null when it is none. */
export function cleanEntry(raw: unknown, now: number): TriggerEntry | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(TRIGGER_KINDS as readonly string[]).includes(kind)) return null;
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : now;
  const source = word(raw.source, 40);
  const outcome = word(raw.outcome, 20);
  if (source === '' || outcome === '') return null;
  const out: TriggerEntry = { at, kind: kind as TriggerKind, source, name: excerptOf(typeof raw.name === 'string' ? raw.name : '', NAME_CHARS), outcome, what: excerptOf(typeof raw.what === 'string' ? raw.what : '') };
  const service = word(raw.service, 20);
  if (service !== '') out.service = service;
  const message = word(raw.message, 20);
  if (message !== '') out.message = message;
  const agent = word(raw.agent, 40);
  if (agent !== '') out.agent = agent;
  const note = excerptOf(typeof raw.note === 'string' ? raw.note : '', NOTE_CHARS);
  if (note !== '') out.note = note;
  return out;
}

export function createTriggers(options: { dir: string; now: () => number; log?: Logger }): Triggers {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, TRIGGERS_FILE);
  const old = join(options.dir, TRIGGERS_OLD_FILE);
  let chain: Promise<unknown> = Promise.resolve();
  let size = 0;
  let firstAt: number | null = null;

  const readFileLines = async (file: string): Promise<TriggerEntry[]> => {
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    const out: TriggerEntry[] = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        const entry = cleanEntry(JSON.parse(line), options.now());
        if (entry !== null) out.push(entry);
      } catch {
        // a torn last line after a crash: skipped
      }
    }
    return out;
  };

  const rotate = async (): Promise<void> => {
    await rename(path, old);
    await writeFile(path, '', { mode: FILE_MODE });
    size = 0;
    firstAt = null;
  };

  return {
    async load() {
      try {
        size = (await stat(path)).size;
      } catch {
        size = 0;
      }
      firstAt = (await readFileLines(path))[0]?.at ?? null;
    },

    record(input) {
      const entry = cleanEntry(input, options.now());
      if (entry === null) return;
      const line = `${JSON.stringify({ ...entry, at: options.now() })}\n`;
      const bytes = Buffer.byteLength(line);
      chain = chain
        .then(async () => {
          // by age too: a quiet room's first line may be months old
          if (size > 0 && (size + bytes > TRIGGERS_ROTATE_BYTES || (firstAt !== null && options.now() - firstAt > TRIGGERS_KEEP_MS))) await rotate();
          await appendFile(path, line, { mode: FILE_MODE });
          size += bytes;
          firstAt ??= options.now();
        })
        .catch((error: unknown) => log.warn(`the trigger history could not be written (${error instanceof Error ? error.name : 'error'})`));
    },

    async list(query = {}) {
      await chain;
      const cut = options.now() - TRIGGERS_KEEP_MS;
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? TRIGGERS_LIMIT_DEFAULT) || TRIGGERS_LIMIT_DEFAULT, 1), TRIGGERS_LIMIT_MAX);
      const all = [...(await readFileLines(old)), ...(await readFileLines(path))];
      const out: TriggerEntry[] = [];
      for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const e = all[i] as TriggerEntry;
        if (e.at < cut) continue;
        if (query.kind !== undefined && e.kind !== query.kind) continue;
        if (query.source !== undefined && e.source !== query.source) continue;
        if (query.outcome !== undefined && e.outcome !== query.outcome) continue;
        out.push(e);
      }
      return out;
    },

    close: () => chain.then(() => undefined),
  };
}
