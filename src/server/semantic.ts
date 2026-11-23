/**
 * Search by meaning (docs/semantic-search-spec.md, phase 1): the Mission Log entries as vectors, next to the word search, off unless the
 * Director turns it on and names an Ollama endpoint (embedder.ts).
 *
 * Files, per room, `<home>/semantic/`, 0600 in a 0700 folder, never exported, never shared with another room, removed with the room:
 *   config.json       the endpoint, the model and the host the Director confirmed (written only through `setConfig`, behind a step-up)
 *   index.meta.json   version, model, dimension and one row per chunk: the entry id, the chunk number, a hash of its text
 *   index.bin         the vectors of those rows, normalized, as float32, row after row
 * A damaged file is renamed `.bad` and the search goes on with words; a different model or dimension renames the index `.old` and builds
 * a new one: two models are never mixed in one answer.
 *
 * The vectors are searched by brute force (`nearest`), the one function that a vector index could replace; at 2000 entries of a few
 * chunks each that is a few milliseconds. The result is fused with the word ranking by reciprocal rank fusion, which needs no score
 * calibration, and an entry that has no vector yet still ranks by its words. Search never waits for the embedder: the index is filled by
 * a background loop (at most 4 chunks a second, one request at a time), and a query that cannot be embedded in a moment is a word search.
 *
 * Budget (E5): a daily cap of chunks for the room, of which one writer (the author of an entry, or whoever searches) may use half;
 * re-embedding an edited entry and embedding a query count too. Past it nothing is embedded until tomorrow, the Director is told once with
 * counts only, and the word search goes on.
 *
 * shortcut: the whole index is kept in memory and rewritten at every checkpoint (40 chunks and when the queue is empty): 2000 entries of
 * 3 chunks at 768 floats is 18 MB; append to the file instead if that ever hurts. The loop does not pause when Max Q holds work back.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEntry, Logger } from '../shared/protocol.js';
import { DIR_MODE, FILE_MODE } from './constants.js';
import { checkEndpoint, DEFAULT_ENDPOINT, DEFAULT_MODEL, embed, EmbedError, endpointText, parseEndpoint } from './embedder.js';
import type { EmbedOptions } from './embedder.js';
import { HubError } from './hub.js';

export const SEMANTIC_DIR = 'semantic';
export const CHUNK_CHARS = 800;
export const CHUNKS_PER_ENTRY_MAX = 20;
export const EMBED_PER_SECOND = 4;
export const DAILY_CHUNKS_MAX = 20_000;
/** How long a search waits for its query to be embedded before it is a word search. */
export const QUERY_WAIT_MS = 3000;
const CANDIDATES = 50;
const RRF_K = 60;
const CHECKPOINT_CHUNKS = 40;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const INDEX_VERSION = 1;
/** After a failure the loop leaves the endpoint alone for this long. */
const RETRY_MS = 30_000;

/** The text of an entry in pieces of about CHUNK_CHARS on paragraph breaks, the title in front of each, at most CHUNKS_PER_ENTRY_MAX. */
export function chunkEntry(entry: Pick<LogEntry, 'title' | 'body'>): string[] {
  const out: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim() !== '') out.push(`${entry.title}\n${current.trim()}`);
    current = '';
  };
  for (const paragraph of entry.body.split(/\n\s*\n/)) {
    // a paragraph longer than a chunk is cut at the chunk size
    for (let at = 0; at < Math.max(paragraph.length, 1); at += CHUNK_CHARS) {
      const piece = paragraph.slice(at, at + CHUNK_CHARS);
      if (current !== '' && current.length + piece.length + 2 > CHUNK_CHARS) flush();
      current += (current === '' ? '' : '\n\n') + piece;
    }
  }
  flush();
  return (out.length === 0 ? [entry.title] : out).slice(0, CHUNKS_PER_ENTRY_MAX);
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The rank-fusion of lists of ids, best first: each list gives an id 1 / (60 + its place). */
export function fuse(lists: ReadonlyArray<readonly string[]>): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, place) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + place + 1)));
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/* ------------------------------------------------------------------------------------------------ the vectors */

interface Row {
  id: string;
  c: number;
  h: string;
}

/** Vectors by brute force. `nearest` is the only way in: a vector index (sqlite-vec) would replace this and nothing else. */
export class VectorIndex {
  rows: Row[] = [];
  data = new Float32Array(0);
  constructor(
    public model: string,
    public dim: number,
  ) {}

  /** The entries nearest to the query vector (cosine: the rows are normalized), best chunk of each, at most `k`. */
  nearest(query: ArrayLike<number>, k: number): Array<{ id: string; score: number }> {
    if (this.dim === 0 || query.length !== this.dim || this.rows.length === 0) return [];
    const unit = normalized(query);
    if (unit === null) return [];
    const best = new Map<string, number>();
    for (let r = 0; r < this.rows.length; r += 1) {
      let dot = 0;
      const base = r * this.dim;
      for (let i = 0; i < this.dim; i += 1) dot += (this.data[base + i] as number) * (unit[i] as number);
      const id = (this.rows[r] as Row).id;
      if (dot > (best.get(id) ?? -2)) best.set(id, dot);
    }
    return [...best].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, k);
  }

  has(id: string, c: number, h: string): boolean {
    return this.rows.some((r) => r.id === id && r.c === c && r.h === h);
  }

  add(id: string, c: number, h: string, vector: ArrayLike<number>): void {
    const unit = normalized(vector);
    if (unit === null) throw new EmbedError('a vector has no length');
    const grown = new Float32Array((this.rows.length + 1) * this.dim);
    grown.set(this.data);
    grown.set(unit, this.rows.length * this.dim);
    this.data = grown;
    this.rows.push({ id, c, h });
  }

  /** Drops the rows of `id` that are not in `keep` (chunk number and hash), or all of them with no `keep`. */
  prune(id: string, keep?: ReadonlyArray<{ c: number; h: string }>): void {
    const kept = this.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.id !== id || (keep?.some((k) => k.c === r.c && k.h === r.h) ?? false));
    if (kept.length === this.rows.length) return;
    const data = new Float32Array(kept.length * this.dim);
    kept.forEach(({ i }, to) => data.set(this.data.subarray(i * this.dim, (i + 1) * this.dim), to * this.dim));
    this.data = data;
    this.rows = kept.map(({ r }) => r);
  }
}

function normalized(v: ArrayLike<number>): Float32Array | null {
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) sum += (v[i] as number) ** 2;
  if (!(sum > 0) || !Number.isFinite(sum)) return null;
  const out = new Float32Array(v.length);
  const norm = Math.sqrt(sum);
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] as number) / norm;
  return out;
}

/* ------------------------------------------------------------------------------------------------ the service */

export interface SemanticConfig {
  endpoint: string;
  model: string;
  /** The host the Director confirmed may get his notes (null for loopback). */
  confirmed: string | null;
}

export interface SemanticStatus {
  /** The switch is on. */
  enabled: boolean;
  endpoint: string;
  model: string;
  /** The host the Director confirmed, or null. */
  confirmed: string | null;
  state: 'off' | 'idle' | 'indexing' | 'error' | 'cap';
  /** Fixed words about the last failure, or ''. */
  reason: string;
  /** Chunks with a vector, and chunks the entries have. */
  indexed: number;
  total: number;
  dimension: number;
  /** Chunks used today, and the daily cap. */
  used: number;
  cap: number;
}

export interface SemanticOptions {
  /** `<home>/semantic`. */
  dir: string;
  now(): number;
  /** The entries of the Mission Log now. */
  entries(): LogEntry[];
  /** Is the feature on? */
  on(): boolean;
  /** A message for the Director's inbox: counts and fixed words only. */
  notify(text: string): void;
  log: Logger;
  /** For tests: the embedder. Default: the endpoint of the config. */
  embedder?: (config: SemanticConfig, texts: string[], timeoutMs?: number) => Promise<number[][]>;
  /** Milliseconds between the batches of the background loop (default 1000: 4 chunks a second). */
  tickMs?: number;
  dailyCap?: number;
  /** Is there still something to tell the page (the status changed)? */
  changed?(): void;
}

export interface Semantic {
  load(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  status(): SemanticStatus;
  /** Saves the endpoint, the model and the confirmation: a HubError (bad_request, field) for what is not allowed. Needs the step-up of the route. */
  setConfig(input: unknown): Promise<SemanticStatus>;
  /** One request to the endpoint with a short text, for the TEST button: the dimension it answers with. */
  test(): Promise<{ dimension: number }>;
  /** An entry was written or changed (it is queued), or removed (its vectors go). */
  changed(id: string): void;
  removed(id: string): void;
  /** The entries nearest to a query in meaning, or null when there is no meaning search now (off, no endpoint, an empty index, over the budget, or too slow). `who` is the agent, or "user". */
  rank(query: string, who: string): Promise<string[] | null>;
  /** The vector index, for tests and the one function. */
  nearest(query: ArrayLike<number>, k: number): Array<{ id: string; score: number }>;
  /** Waits until the background loop has nothing queued (tests). */
  idle(): Promise<void>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);

export function createSemantic(options: SemanticOptions): Semantic {
  const { log } = options;
  const cap = options.dailyCap ?? DAILY_CHUNKS_MAX;
  const configPath = join(options.dir, 'config.json');
  const metaPath = join(options.dir, 'index.meta.json');
  const binPath = join(options.dir, 'index.bin');
  let config: SemanticConfig = { endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, confirmed: null };
  let configured = false;
  let index = new VectorIndex(DEFAULT_MODEL, 0);
  const pending: string[] = [];
  /** Entries that the budget stopped: asked again after the next write of them or the next day. */
  const skipped = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();
  let state: SemanticStatus['state'] = 'idle';
  let reason = '';
  let unsaved = 0;
  let day = '';
  let used = 0;
  const usedBy = new Map<string, number>();
  let told = false;
  let lastQuery = 0;
  let retryAt = 0;

  const embedder = options.embedder ?? ((c: SemanticConfig, texts: string[], timeoutMs?: number) => embed({ endpoint: c.endpoint, model: c.model, confirmed: c.confirmed, ...(timeoutMs === undefined ? {} : { timeoutMs }) } satisfies EmbedOptions, texts));

  async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  const aside = async (path: string, suffix: string): Promise<void> => void (await rename(path, `${path}.${suffix}`).catch(() => undefined));

  async function save(): Promise<void> {
    await mkdir(options.dir, { recursive: true, mode: DIR_MODE });
    await writeAtomic(binPath, new Uint8Array(index.data.buffer, index.data.byteOffset, index.data.byteLength));
    await writeAtomic(metaPath, JSON.stringify({ version: INDEX_VERSION, model: index.model, dim: index.dim, rows: index.rows }));
    unsaved = 0;
  }

  /** Reads the index; a file that is not one, or that does not fit the other, is renamed `.bad` and the index starts empty. */
  async function loadIndex(): Promise<void> {
    let meta: { version?: unknown; model?: unknown; dim?: unknown; rows?: unknown };
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8')) as typeof meta;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('the semantic index could not be read; it is kept as .bad and search goes on with words');
      await aside(metaPath, 'bad');
      await aside(binPath, 'bad');
      return;
    }
    try {
      const rows = meta.rows;
      if (meta.version !== INDEX_VERSION || typeof meta.model !== 'string' || typeof meta.dim !== 'number' || !Array.isArray(rows)) throw new Error('not an index');
      const dim = meta.dim;
      if (!Number.isInteger(dim) || dim < 1 || dim > 4096) throw new Error('bad dimension');
      const bin = await readFile(binPath);
      if (bin.length !== rows.length * dim * 4) throw new Error('size does not fit');
      const checked: Row[] = rows.map((r: unknown) => {
        const x = r as Partial<Row>;
        if (typeof x.id !== 'string' || typeof x.c !== 'number' || typeof x.h !== 'string') throw new Error('bad row');
        return { id: x.id, c: x.c, h: x.h };
      });
      const next = new VectorIndex(meta.model, dim);
      next.rows = checked;
      next.data = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
      index = next;
    } catch {
      log.warn('the semantic index is damaged; it is kept as .bad and search goes on with words');
      await aside(metaPath, 'bad');
      await aside(binPath, 'bad');
    }
  }

  const today = (): string => new Date(options.now()).toISOString().slice(0, 10);
  function rollDay(): void {
    if (day === today()) return;
    day = today();
    if (state === 'cap') state = 'idle';
    used = 0;
    usedBy.clear();
    told = false;
    // what the budget stopped is tried again
    for (const id of skipped) pending.push(id);
    skipped.clear();
  }
  /** One chunk of budget for `who`: false when the room's cap, or half of it for one writer, is spent. */
  function charge(who: string): boolean {
    rollDay();
    if (used >= cap || (who !== 'user' && (usedBy.get(who) ?? 0) >= Math.floor(cap / 2))) {
      if (used >= cap && !told) {
        told = true;
        options.notify(`Search by meaning: today's limit of ${cap} chunks is reached, so nothing more is embedded until tomorrow. Word search goes on.`);
      }
      return false;
    }
    used += 1;
    usedBy.set(who, (usedBy.get(who) ?? 0) + 1);
    return true;
  }

  function total(): number {
    return options.entries().reduce((n, e) => n + chunkEntry(e).length, 0);
  }

  const status = (): SemanticStatus => ({
    enabled: options.on(),
    endpoint: config.endpoint,
    model: config.model,
    confirmed: config.confirmed,
    state: !options.on() ? 'off' : state,
    reason,
    indexed: index.rows.length,
    total: options.on() ? total() : 0,
    dimension: index.dim,
    used,
    cap,
  });

  /** A different model, or a dimension the endpoint now answers with: the old index is kept as `.old` and a new one is built from every entry. */
  async function rebuild(model: string, dim: number): Promise<void> {
    if (index.rows.length > 0) {
      await aside(metaPath, 'old');
      await aside(binPath, 'old');
    }
    index = new VectorIndex(model, dim);
    unsaved = 0;
    pending.length = 0;
    for (const e of options.entries()) pending.push(e.id);
    skipped.clear();
  }

  /** One batch: up to 4 chunks of the entry at the head of the queue, in one request. */
  async function step(): Promise<void> {
    if (!options.on() || !configured) {
      state = 'idle';
      return;
    }
    rollDay();
    if (options.now() < retryAt) return;
    const id = pending[0];
    if (id === undefined) {
      if (unsaved > 0) await save().catch((e: unknown) => log.warn('the semantic index could not be saved', e));
      if (state === 'indexing') state = 'idle';
      return;
    }
    const entry = options.entries().find((e) => e.id === id);
    if (entry === undefined) {
      pending.shift();
      index.prune(id);
      return;
    }
    const chunks = chunkEntry(entry).map((text, c) => ({ text, c, h: hashOf(text) }));
    const missing = chunks.filter((k) => !index.has(id, k.c, k.h));
    if (missing.length === 0) {
      pending.shift();
      index.prune(id, chunks);
      return;
    }
    const batch: typeof missing = [];
    for (const k of missing) {
      if (batch.length >= EMBED_PER_SECOND) break;
      if (!charge(entry.author)) {
        // the budget is spent for this writer (or the room): the entry waits for tomorrow or for its next edit
        pending.shift();
        skipped.add(id);
        state = used >= cap ? 'cap' : state;
        return;
      }
      batch.push(k);
    }
    state = 'indexing';
    try {
      const vectors = await embedder(config, batch.map((k) => k.text));
      const dim = vectors[0]?.length ?? 0;
      if (index.rows.length > 0 && (index.dim !== dim || index.model !== config.model)) await rebuild(config.model, dim);
      if (index.rows.length === 0) index = new VectorIndex(config.model, dim);
      batch.forEach((k, i) => index.add(id, k.c, k.h, vectors[i] as number[]));
      unsaved += batch.length;
      reason = '';
      if (unsaved >= CHECKPOINT_CHUNKS) await save();
    } catch (e) {
      // fixed words only: nothing the endpoint said is kept
      reason = e instanceof EmbedError ? e.message : 'the embedding failed';
      state = 'error';
      retryAt = options.now() + RETRY_MS;
      options.changed?.();
    }
  }

  const tick = (): void => {
    running = running.then(async () => {
      try {
        await step();
        // off or not set up, step() leaves `pending` as it is and changes nothing: no frame (it told the page every tick, for ever)
        if (options.on() && configured && (pending.length > 0 || state === 'indexing')) options.changed?.();
      } catch (e) {
        log.warn('the semantic loop failed', e);
      }
    });
  };

  return {
    async load() {
      await mkdir(options.dir, { recursive: true, mode: DIR_MODE });
      try {
        const saved = JSON.parse(await readFile(configPath, 'utf8')) as Partial<SemanticConfig>;
        const parsed = parseEndpoint(saved.endpoint);
        if (typeof parsed === 'string' || typeof saved.model !== 'string' || !MODEL_PATTERN.test(saved.model)) throw new Error('bad config');
        config = { endpoint: endpointText(parsed), model: saved.model, confirmed: typeof saved.confirmed === 'string' ? saved.confirmed : null };
        configured = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('the semantic config could not be read; it is kept as .bad and the feature has no endpoint');
          await aside(configPath, 'bad');
        }
      }
      await loadIndex();
      if (configured && index.rows.length > 0 && index.model !== config.model) await rebuild(config.model, 0);
      else for (const e of options.entries()) pending.push(e.id);
    },

    start() {
      if (timer !== null) return;
      timer = setInterval(tick, options.tickMs ?? Math.round(1000));
      timer.unref();
    },

    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running;
      if (unsaved > 0) await save().catch(() => undefined);
    },

    status,

    async setConfig(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw bad('request body must be a JSON object');
      const body = input as Record<string, unknown>;
      for (const key of Object.keys(body)) if (!['endpoint', 'model', 'confirm'].includes(key)) throw bad(`unknown field "${key}"`, key);
      const model = body.model === undefined ? config.model : body.model;
      if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) throw bad('the model is a name like nomic-embed-text', 'model');
      const text = body.endpoint === undefined ? config.endpoint : body.endpoint;
      const parsed = parseEndpoint(text);
      if (typeof parsed === 'string') throw bad(parsed, 'endpoint');
      const confirm = body.confirm === undefined ? null : body.confirm;
      if (confirm !== null && (typeof confirm !== 'string' || confirm !== parsed.host)) throw bad(`confirm must be the host ${parsed.host}, written the same`, 'confirm');
      // the address the host resolves to NOW decides; the confirmation is kept only for a host that is not this machine
      const checked = await checkEndpoint(endpointText(parsed), confirm, undefined);
      if (typeof checked === 'string') throw bad(checked, /confirm/.test(checked) ? 'confirm' : 'endpoint');
      const next: SemanticConfig = { endpoint: endpointText(parsed), model, confirmed: checked.resolved.class === 'loopback' ? null : parsed.host };
      await mkdir(options.dir, { recursive: true, mode: DIR_MODE });
      await writeAtomic(configPath, JSON.stringify(next));
      const modelChanged = configured && next.model !== config.model;
      config = next;
      configured = true;
      reason = '';
      state = 'idle';
      retryAt = 0;
      if (modelChanged || (index.rows.length > 0 && index.model !== next.model)) await rebuild(next.model, 0);
      else {
        pending.length = 0;
        for (const e of options.entries()) pending.push(e.id);
      }
      options.changed?.();
      return status();
    },

    async test() {
      if (!configured) throw bad('no endpoint is set');
      try {
        const [vector] = await embedder(config, ['gonogo']);
        return { dimension: vector?.length ?? 0 };
      } catch (e) {
        // fixed words: what the endpoint said is not passed on
        throw new HubError('unavailable', e instanceof EmbedError ? e.message : 'the embedding failed');
      }
    },

    changed(id) {
      skipped.delete(id);
      if (!pending.includes(id)) pending.push(id);
    },

    removed(id) {
      const at = pending.indexOf(id);
      if (at >= 0) pending.splice(at, 1);
      skipped.delete(id);
      index.prune(id);
    },

    async rank(query, who) {
      if (!options.on() || !configured || index.rows.length === 0 || query.trim() === '') return null;
      // one query at a time and no faster than the loop: a search that comes too soon is a word search, not a wait
      const now = options.now();
      if (now - lastQuery < 250) return null;
      if (!charge(who)) return null;
      lastQuery = now;
      try {
        const [vector] = await embedder(config, [query.slice(0, 500)], QUERY_WAIT_MS);
        return index.nearest(vector ?? [], CANDIDATES).map((r) => r.id);
      } catch {
        return null;
      }
    },

    nearest: (query, k) => index.nearest(query, k),

    async idle() {
      for (let i = 0; i < 1000; i += 1) {
        tick();
        await running;
        if (state === 'error' || state === 'cap' || (pending.length === 0 && state !== 'indexing')) break;
      }
      if (unsaved > 0) await save();
    },
  };
}
