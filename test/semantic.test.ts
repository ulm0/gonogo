import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry, Logger } from '../src/shared/protocol.js';
import { EmbedError } from '../src/server/embedder.js';
import { createMissionLog } from '../src/server/missionlog.js';
import type { MissionLog } from '../src/server/missionlog.js';
import { chunkEntry, CHUNK_CHARS, CHUNKS_PER_ENTRY_MAX, createSemantic, fuse, VectorIndex } from '../src/server/semantic.js';
import type { Semantic, SemanticConfig, SemanticOptions } from '../src/server/semantic.js';

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const DAY = 86_400_000;
let dir: string;
let now: number;
let entries: LogEntry[];
let told: string[];
let calls: Array<{ model: string; texts: string[] }>;
let fail: string | null;
let dim: number;

const entry = (id: string, title: string, body: string, author = 'ana'): LogEntry => ({ id, title, body, tags: [], author, createdAt: 1, updatedAt: 1 });
/** A stand-in model: one axis per concept, so "compile" and "build" are near and "invoice" is far. */
const CONCEPTS = [['build', 'compile', 'compiling', 'make'], ['deploy', 'release', 'ship'], ['invoice', 'payment', 'billing'], ['cache', 'memo'], ['login', 'password', 'auth']];
function vectorOf(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const v = Array.from({ length: dim }, (_, i) => (i >= CONCEPTS.length ? 0.001 * (i + 1) : 0));
  CONCEPTS.forEach((group, i) => {
    for (const w of words) if (group.includes(w) && i < dim) v[i] = (v[i] ?? 0) + 1;
  });
  return v.some((x) => x !== 0) ? v : v.map((_, i) => (i === 0 ? 0.01 : 0));
}
const fake: SemanticOptions['embedder'] = async (c: SemanticConfig, texts: string[]) => {
  calls.push({ model: c.model, texts });
  if (fail !== null) throw new EmbedError(fail);
  return texts.map(vectorOf);
};

const make = (over: Partial<SemanticOptions> = {}): Semantic =>
  createSemantic({ dir: join(dir, 'semantic'), now: () => now, entries: () => entries, on: () => true, notify: (t) => void told.push(t), log: quiet, embedder: fake, ...over });
/** A search a moment after the last one (the service does not embed queries closer than 250 ms). */
const ask = async (s: Semantic, q: string, who = 'user'): Promise<string[] | null> => {
  now += 300;
  return s.rank(q, who);
};
const configured = async (over: Partial<SemanticOptions> = {}): Promise<Semantic> => {
  const s = make(over);
  await s.load();
  await s.setConfig({ endpoint: 'http://127.0.0.1:11434', model: 'test-model' });
  return s;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-semantic-'));
  now = Date.UTC(2026, 10, 21, 12);
  entries = [entry('l1', 'Build', 'how to compile the project'), entry('l2', 'Deploy', 'release the build to production'), entry('l3', 'Invoices', 'payment and billing')];
  told = [];
  calls = [];
  fail = null;
  dim = 5;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('chunks', () => {
  it('are one for a short entry, with the title in front; paragraphs are kept together up to about 800 characters', () => {
    expect(chunkEntry({ title: 'T', body: 'one\n\ntwo' })).toEqual(['T\none\n\ntwo']);
    const para = (n: number): string => `${n}`.repeat(500);
    const chunks = chunkEntry({ title: 'T', body: [para(1), para(2), para(3)].join('\n\n') });
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(c.startsWith('T\n')).toBe(true);
    expect(chunkEntry({ title: 'T', body: 'x'.repeat(CHUNK_CHARS * 2 + 5) })).toHaveLength(3);
  });

  it('are at most 20 for the largest entry, and an empty body is the title alone', () => {
    expect(chunkEntry({ title: 'T', body: 'y'.repeat(20_000) })).toHaveLength(CHUNKS_PER_ENTRY_MAX);
    expect(chunkEntry({ title: 'Only a title', body: '  ' })).toEqual(['Only a title']);
  });
});

describe('fuse', () => {
  it('ranks by reciprocal rank: an id in both lists beats one that is first in one', () => {
    expect(fuse([['a', 'b', 'c'], ['d', 'b']])[0]).toBe('b');
    expect(fuse([['a', 'b', 'c'], ['d', 'b']])).toEqual(['b', 'a', 'd', 'c']);
    expect(fuse([['a'], []])).toEqual(['a']);
    expect(fuse([])).toEqual([]);
  });
});

describe('the vectors', () => {
  it('nearest is cosine, the best chunk of each entry, at most k, and nothing for another size', () => {
    const i = new VectorIndex('m', 3);
    i.add('a', 0, 'h1', [1, 0, 0]);
    i.add('a', 1, 'h2', [0, 1, 0]);
    i.add('b', 0, 'h3', [0.9, 0.1, 0]);
    i.add('c', 0, 'h4', [0, 0, 5]);
    expect(i.nearest([2, 0, 0], 10).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(i.nearest([2, 0, 0], 10)[0]?.score).toBeCloseTo(1);
    expect(i.nearest([2, 0, 0], 2)).toHaveLength(2);
    expect(i.nearest([1, 0], 5)).toEqual([]);
    expect(i.nearest([0, 0, 0], 5)).toEqual([]);
    expect(new VectorIndex('m', 3).nearest([1, 0, 0], 5)).toEqual([]);
  });

  it('prune drops the rows of an entry that are not kept', () => {
    const i = new VectorIndex('m', 2);
    i.add('a', 0, 'h1', [1, 0]);
    i.add('a', 1, 'h2', [0, 1]);
    i.add('b', 0, 'h3', [1, 1]);
    i.prune('a', [{ c: 0, h: 'h1' }]);
    expect(i.rows.map((r) => `${r.id}${r.c}`)).toEqual(['a0', 'b0']);
    expect(i.data).toHaveLength(4);
    expect(i.nearest([0, 1], 5).map((r) => r.id)).toEqual(['b', 'a']);
    i.prune('a');
    expect(i.rows.map((r) => r.id)).toEqual(['b']);
  });
});

describe('the index of a room', () => {
  it('fills in the background, four chunks a request, and finds an entry by meaning: "compiling" finds the entry about the build, not the invoices', async () => {
    const s = await configured();
    await s.idle();
    expect(s.status()).toMatchObject({ state: 'idle', indexed: 3, total: 3, dimension: 5, model: 'test-model' });
    expect(Math.max(...calls.map((c) => c.texts.length))).toBeLessThanOrEqual(4);
    const ranked = await ask(s, 'compiling the code', 'user');
    expect(ranked?.[0]).toBe('l1');
    expect(ranked?.indexOf('l3') ?? -1).toBeGreaterThan(ranked?.indexOf('l2') ?? -1);
  });

  it('is saved in a 0600 file of a 0700 folder, and read back after a restart without embedding again', async () => {
    const s = await configured();
    await s.idle();
    await s.stop();
    for (const name of ['config.json', 'index.meta.json', 'index.bin']) expect((await stat(join(dir, 'semantic', name))).mode & 0o777, name).toBe(0o600);
    expect((await stat(join(dir, 'semantic'))).mode & 0o777).toBe(0o700);
    const before = calls.length;
    const again = make();
    await again.load();
    await again.idle();
    expect(calls.length).toBe(before);
    expect(again.status()).toMatchObject({ indexed: 3, model: 'test-model' });
    expect((await ask(again, 'build', 'user'))?.[0]).toBe('l1');
  });

  it('with the switch off nothing is embedded and there is no meaning search; with no endpoint set the same', async () => {
    let on = false;
    const s = await configured({ on: () => on });
    await s.idle();
    expect(calls).toEqual([]);
    expect(s.status().state).toBe('off');
    expect(await ask(s, 'build', 'user')).toBeNull();
    const none = createSemantic({ dir: join(dir, 'empty'), now: () => now, entries: () => entries, on: () => true, notify: () => undefined, log: quiet, embedder: fake });
    await none.load();
    await none.idle();
    expect(calls).toEqual([]);
    expect(await ask(none, 'build', 'user')).toBeNull();
    on = true;
    await s.idle();
    expect(s.status().indexed).toBe(3);
  });

  it('an entry that is edited is embedded again, one that is removed leaves no vector, a new one is added', async () => {
    const s = await configured();
    await s.idle();
    const first = calls.length;
    entries[2] = entry('l3', 'Invoices', 'now it is about the cache');
    s.changed('l3');
    await s.idle();
    expect(calls.length).toBe(first + 1);
    expect((await ask(s, 'memo', 'user'))?.[0]).toBe('l3');
    entries = entries.filter((e) => e.id !== 'l2');
    s.removed('l2');
    expect(s.status().indexed).toBe(2);
    entries.push(entry('l4', 'Login', 'password and auth'));
    s.changed('l4');
    await s.idle();
    expect(s.status().indexed).toBe(3);
    expect((await ask(s, 'password', 'user'))?.[0]).toBe('l4');
    // an unchanged entry is not sent again
    const n = calls.length;
    s.changed('l1');
    await s.idle();
    expect(calls.length).toBe(n);
  });

  it('a different model renames the index .old and builds a new one: two models are never mixed', async () => {
    const s = await configured();
    await s.idle();
    await s.setConfig({ model: 'other-model' });
    expect(s.status().indexed).toBe(0);
    expect(await ask(s, 'build', 'user')).toBeNull();
    await s.idle();
    expect(s.status()).toMatchObject({ indexed: 3, model: 'other-model' });
    expect(calls.at(-1)?.model).toBe('other-model');
    expect((await readdir(join(dir, 'semantic'))).sort()).toEqual(expect.arrayContaining(['index.bin.old', 'index.meta.json.old']));
  });

  it('a dimension that changes under the same model name rebuilds, never mixes', async () => {
    const s = await configured();
    await s.idle();
    dim = 7;
    entries[0] = entry('l1', 'Build', 'a changed text about compile');
    s.changed('l1');
    await s.idle();
    expect(s.status()).toMatchObject({ dimension: 7, indexed: 3 });
    expect(s.nearest(Array.from({ length: 5 }, () => 1), 5)).toEqual([]);
  });

  it('a damaged index or config is renamed .bad and search goes on without it', async () => {
    const s = await configured();
    await s.idle();
    await s.stop();
    await writeFile(join(dir, 'semantic', 'index.bin'), 'short');
    const a = make();
    await a.load();
    expect(a.status().indexed).toBe(0);
    expect((await readdir(join(dir, 'semantic'))).filter((f) => f.endsWith('.bad')).sort()).toEqual(['index.bin.bad', 'index.meta.json.bad']);
    await writeFile(join(dir, 'semantic', 'config.json'), '{ nope');
    const b = make();
    await b.load();
    expect(await ask(b, 'build', 'user')).toBeNull();
    expect((await readdir(join(dir, 'semantic'))).some((f) => f === 'config.json.bad')).toBe(true);
  });

  it('an endpoint that fails leaves the old index usable, says why in fixed words, and is left alone for a while', async () => {
    const s = await configured();
    await s.idle();
    entries.push(entry('l4', 'Login', 'password'));
    s.changed('l4');
    fail = 'the endpoint answered 500';
    await s.idle();
    expect(s.status()).toMatchObject({ state: 'error', reason: 'the endpoint answered 500', indexed: 3 });
    // the vectors that are there are still searched
    expect(s.nearest(vectorOf('build'), 3)[0]?.id).toBe('l1');
    const n = calls.length;
    await s.idle();
    expect(calls.length).toBe(n);
    // a query that cannot be embedded is a word search, without an error
    expect(await ask(s, 'build again', 'user')).toBeNull();
    fail = null;
    now += 31_000;
    await s.idle();
    expect(s.status()).toMatchObject({ state: 'idle', reason: '', indexed: 4 });
  });
});

describe('with a real endpoint', () => {
  it('embeds through an Ollama-shaped server on this machine, end to end, and never sends the title of nothing it was not asked', async () => {
    const { createServer } = await import('node:http');
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] };
        seen.push(req.url ?? '', ...body.input);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ embeddings: body.input.map(vectorOf) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const s = make({ embedder: undefined });
      await s.load();
      await s.setConfig({ endpoint: `http://127.0.0.1:${port}`, model: 'm' });
      expect(await s.test()).toEqual({ dimension: 5 });
      await s.idle();
      expect(s.status()).toMatchObject({ indexed: 3, dimension: 5 });
      expect(seen.filter((x) => x === '/api/embed').length).toBeGreaterThan(0);
      expect(seen.some((x) => x.includes('Build') && x.includes('compile'))).toBe(true);
      expect((await ask(s, 'compiling', 'user'))?.[0]).toBe('l1');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('the budget (E5)', () => {
  it('one writer may use half of the day, an edit counts again, and past the cap nothing is embedded and the Director is told once, with counts', async () => {
    entries = Array.from({ length: 8 }, (_, i) => entry(`l${i + 1}`, `T${i}`, `build ${i}`, i < 6 ? 'loop' : 'ben'));
    const s = await configured({ dailyCap: 8 });
    await s.idle();
    // 'loop' stopped at 4 (half of 8); 'ben' then used the rest of the room's day
    expect(s.status().indexed).toBe(6);
    expect(s.status().used).toBe(6);
    expect(told).toEqual([]);
    entries[6] = entry('l7', 'T6', 'edited', 'ben');
    s.changed('l7');
    entries[7] = entry('l8', 'T7', 'edited too', 'ben');
    s.changed('l8');
    entries.push(entry('l9', 'T8', 'one more', 'ben'));
    s.changed('l9');
    await s.idle();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/limit of 8 chunks is reached/);
    expect(told[0]).not.toMatch(/build|edited/);
    expect(s.status().state).toBe('cap');
    const n = calls.length;
    await s.idle();
    expect(calls.length).toBe(n);
    // tomorrow what was stopped is tried again
    now += DAY;
    await s.idle();
    expect(s.status().indexed).toBeGreaterThan(6);
    expect(told).toHaveLength(1);
  });

  it('a query costs a chunk of its asker, one asker may use half of the day, and over the budget it is a word search', async () => {
    const s = await configured({ dailyCap: 8 });
    await s.idle();
    expect(s.status().used).toBe(3);
    for (let i = 0; i < 4; i += 1) expect(await ask(s, 'build', 'carol'), String(i)).not.toBeNull();
    // carol has used half of 8
    expect(await ask(s, 'build', 'carol')).toBeNull();
    expect(await ask(s, 'build', 'user')).not.toBeNull();
    // the room's cap is spent
    expect(await ask(s, 'build', 'user')).toBeNull();
    expect(s.status().used).toBe(8);
  });

  it('queries too close together are not embedded: a word search, not a wait', async () => {
    const s = await configured();
    await s.idle();
    expect(await ask(s, 'build', 'user')).not.toBeNull();
    expect(await s.rank('compile', 'user')).toBeNull();
    expect(await ask(s, 'compile', 'user')).not.toBeNull();
  });
});

describe('the setting of the endpoint', () => {
  it('is checked: a host and a port, a model name, the confirmation of a host that is not this machine, and nothing else in the body', async () => {
    const s = make();
    await s.load();
    const refused = async (body: unknown): Promise<{ message: string; field?: string }> => {
      try {
        await s.setConfig(body);
      } catch (e) {
        return { message: (e as Error).message, field: (e as { field?: string }).field };
      }
      throw new Error('it was not refused');
    };
    expect((await refused('x')).message).toMatch(/JSON object/);
    expect(await refused({ extra: 1 })).toMatchObject({ field: 'extra' });
    expect(await refused({ endpoint: 'http://user:pw@127.0.0.1:11434' })).toMatchObject({ field: 'endpoint' });
    expect(await refused({ endpoint: 'http://127.0.0.1:11434/api/embed' })).toMatchObject({ field: 'endpoint' });
    expect(await refused({ endpoint: 'http://169.254.169.254' })).toMatchObject({ field: 'endpoint' });
    expect(await refused({ endpoint: 'http://0.0.0.0:11434', confirm: '0.0.0.0' })).toMatchObject({ field: 'endpoint' });
    expect(await refused({ endpoint: 'http://192.168.1.10:11434' })).toMatchObject({ field: 'confirm' });
    expect(await refused({ endpoint: 'http://192.168.1.10:11434', confirm: 'elsewhere' })).toMatchObject({ field: 'confirm' });
    expect(await refused({ endpoint: 'http://8.8.8.8', confirm: '8.8.8.8' })).toMatchObject({ field: 'endpoint', message: expect.stringMatching(/https/) });
    expect(await refused({ model: 'bad model' })).toMatchObject({ field: 'model' });
    expect(await refused({ model: '../etc' })).toMatchObject({ field: 'model' });
    const ok = await s.setConfig({ endpoint: 'http://192.168.1.10:11434/', model: 'nomic-embed-text:latest', confirm: '192.168.1.10' });
    expect(ok).toMatchObject({ endpoint: 'http://192.168.1.10:11434', confirmed: '192.168.1.10', model: 'nomic-embed-text:latest' });
    expect(JSON.parse(await readFile(join(dir, 'semantic', 'config.json'), 'utf8'))).toEqual({ mode: 'remote', endpoint: 'http://192.168.1.10:11434', model: 'nomic-embed-text:latest', confirmed: '192.168.1.10' });
    // back to this machine: the confirmation is dropped
    expect((await s.setConfig({ endpoint: 'http://127.0.0.1:11434' })).confirmed).toBeNull();
  });

  it('TEST says the dimension, or fixed words; with no endpoint set it is a bad request', async () => {
    const s = make();
    await s.load();
    await expect(s.test()).rejects.toMatchObject({ code: 'bad_request' });
    await s.setConfig({ endpoint: 'http://127.0.0.1:11434' });
    expect(await s.test()).toEqual({ dimension: 5 });
    fail = 'the endpoint answered 404';
    await expect(s.test()).rejects.toMatchObject({ code: 'unavailable', message: 'the endpoint answered 404' });
  });

  it('keeps the old index when only the endpoint changes, and starts a check of every entry', async () => {
    const s = await configured();
    await s.idle();
    const n = calls.length;
    await s.setConfig({ endpoint: 'http://localhost:11434' });
    expect(s.status().indexed).toBe(3);
    await s.idle();
    expect(calls.length).toBe(n);
    await mkdir(join(dir, 'x'), { recursive: true });
  });
});

describe('the Mission Log with meaning', () => {
  let logDir: string;
  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), 'gonogo-semantic-log-'));
  });
  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });
  const open = async (rank: ((q: string, who: string) => Promise<string[] | null>) | null, seen: string[] = []): Promise<MissionLog> => {
    const log = createMissionLog({
      dir: logDir,
      now: () => now,
      emit: () => undefined,
      log: quiet,
      ...(rank === null ? {} : { semantic: { rank, changed: (id) => void seen.push(`changed ${id}`), removed: (id) => void seen.push(`removed ${id}`) } }),
    });
    await log.load();
    return log;
  };

  it('with no meaning a search is the word search, byte for byte, and says nothing of meaning', async () => {
    const log = await open(null);
    await log.create('ana', { title: 'Cache key', body: 'the cache key has the node version' });
    const words = log.search('cache');
    expect(await log.searchMeaning('cache', undefined, 'user')).toEqual(words);
    expect(words).not.toHaveProperty('mode');
    // and the same when meaning has no answer (off, no index, over budget, slow)
    const none = await open(async () => null);
    expect(await none.searchMeaning('cache', undefined, 'user')).toEqual(none.search('cache'));
  });

  it('fuses the words with the entries nearest in meaning, labels it, and an entry with no vector yet still ranks by its words', async () => {
    const log = await open(async () => ['l2', 'l1']);
    await log.create('ana', { title: 'Compile the project', body: 'steps to build it' });
    await log.create('ana', { title: 'Invoices', body: 'payment run on friday' });
    await log.create('ana', { title: 'Release notes', body: 'what shipped, with the build number' });
    // 'build' by words: l1 (body) and l3 (body); by meaning the index says l2 then l1
    const found = await log.searchMeaning('build', undefined, 'user');
    expect(found.mode).toBe('meaning');
    expect(found.total).toBe(3);
    const ids = found.hits.map((h) => h.id);
    expect(ids).toContain('l2');
    expect(ids).toContain('l3');
    // l1 is in both lists
    expect(ids[0]).toBe('l1');
    expect(found.hits.find((h) => h.id === 'l3')?.snippet).toContain('build');
  });

  it('drops what is no longer an entry, honours the limit, and does not ask for meaning for an empty query', async () => {
    const asked: string[] = [];
    const log = await open(async (q) => {
      asked.push(q);
      return ['l9', 'l1'];
    });
    await log.create('ana', { title: 'One', body: 'text' });
    expect((await log.searchMeaning('text', 1, 'ana')).hits.map((h) => h.id)).toEqual(['l1']);
    expect(asked).toEqual(['text']);
    const empty = await log.searchMeaning('   ', undefined, 'ana');
    expect(empty).toEqual(log.search('   '));
    expect(asked).toEqual(['text']);
  });

  it('tells the index of every write, change and removal, and lists the entries', async () => {
    const seen: string[] = [];
    const log = await open(async () => null, seen);
    await log.create('ana', { title: 'One', body: 'text' });
    await log.update('l1', { body: 'changed' }, 'ana');
    await log.remove('l1');
    expect(seen).toEqual(['changed l1', 'changed l1', 'removed l1']);
    expect(log.all()).toEqual([]);
    await log.create('ana', { title: 'Two', body: 'text' });
    expect(log.all().map((e) => e.id)).toEqual(['l2']);
  });
});

describe('while the feature is off', () => {
  it('after a restart, an entry written while it was off is queued and indexed once it is on (the queue is rebuilt from the log at load)', async () => {
    const first = await configured();
    await first.idle();
    await first.stop();
    const before = calls.length;
    entries.push(entry('l4', 'Cache', 'the memo cache key'));
    let on = false;
    const second = make({ on: () => on });
    await second.load();
    await second.idle();
    expect(calls.length, 'nothing is sent while it is off').toBe(before);
    on = true;
    await second.idle();
    const sent = calls.slice(before).flatMap((c) => c.texts).join(' ');
    expect(sent).toContain('memo cache key');
    expect(sent, 'the entries that were indexed already are not sent again').not.toContain('compile');
    await second.stop();
  });

  it('a written entry makes no frame for the page: nothing is indexed, so nothing changes (it sent an empty log frame every tick)', async () => {
    let frames = 0;
    const s = make({ on: () => false, changed: () => void (frames += 1), tickMs: 5 });
    await s.load();
    s.changed('l1');
    s.start();
    await new Promise((r) => setTimeout(r, 60));
    await s.stop();
    expect(frames).toBe(0);
  });
});

/** The managed Ollama and the remote key: the real embedder against a stand-in Ollama on loopback, and a stand-in for the managed server. */
describe('the managed mode and the remote key', () => {
  let ollama: import('node:http').Server;
  let url: string;
  let requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }>;

  beforeEach(async () => {
    requests = [];
    const { createServer } = await import('node:http');
    ollama = createServer((req, res) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        const body = JSON.parse(text) as { input: string[] } & Record<string, unknown>;
        requests.push({ authorization: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ embeddings: body.input.map(vectorOf) }));
      });
    });
    await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => ollama.close(() => resolve()));
  });

  /** A managed server that is a stand-in: it answers with the address of the stand-in Ollama, and notes what it was asked. */
  function fakeManaged(shared = false): { m: import('../src/server/ollama.js').ManagedOllama; calls: string[]; state: { value: import('../src/server/ollama.js').ManagedState } } {
    const calls: string[] = [];
    const state = { value: 'off' as import('../src/server/ollama.js').ManagedState };
    let settings = { keepAlive: '5m', idleMinutes: 10, threads: 0, memoryMb: 0 };
    const m: import('../src/server/ollama.js').ManagedOllama = {
      status: () => ({ state: state.value, reason: '', version: '0.40.18', port: 1, progress: null, rssMb: null, restarts: 0, shared, settings }),
      acquire: async (model) => {
        calls.push(`acquire ${model}`);
        state.value = 'ready';
        return url;
      },
      touch: () => void calls.push('touch'),
      start: async (model) => void calls.push(`start ${model}`),
      stop: async () => {
        calls.push('stop');
        state.value = 'off';
      },
      settings: (patch) => {
        if (patch !== undefined) settings = { ...settings, ...patch };
        return settings;
      },
      logs: () => ['line one'],
      needsDownload: async () => false,
    };
    return { m, calls, state };
  }

  it('embeds through the managed server, with its keep-alive and threads, no key, and touches it after each request', async () => {
    const { m, calls: managedCalls } = fakeManaged();
    const s = make({ embedder: undefined, managed: m });
    await s.load();
    const status = await s.setConfig({ mode: 'managed', model: 'nomic-embed-text', keepAlive: '30s', threads: 4, idleMinutes: 3, memoryMb: 900 });
    expect(status).toMatchObject({ mode: 'managed', configured: true, apiKeySet: false, managed: { settings: { keepAlive: '30s', threads: 4, idleMinutes: 3, memoryMb: 900 } } });
    // switching it on starts it at once, so that the download and the pull show their progress
    expect(managedCalls).toContain('acquire nomic-embed-text');
    await s.idle();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.body).toMatchObject({ model: 'nomic-embed-text', keep_alive: '30s', options: { num_thread: 4 } });
    expect(requests[0]?.authorization).toBeUndefined();
    expect(managedCalls).toContain('touch');
    // the saved file holds the mode and the settings of the managed server, and still no key
    const saved = JSON.parse(await readFile(join(dir, 'semantic', 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ mode: 'managed', model: 'nomic-embed-text', managed: { keepAlive: '30s', idleMinutes: 3, threads: 4, memoryMb: 900 } });
    await s.stop();
    expect(managedCalls.at(-1)).toBe('stop');
  });

  it('a search that comes while the managed server is not up is a word search, and starts it for the next one', async () => {
    const { m, calls: managedCalls, state } = fakeManaged();
    const s = make({ embedder: undefined, managed: m });
    await s.load();
    await s.setConfig({ mode: 'managed', model: 'nomic-embed-text' });
    await s.idle();
    expect(s.status().indexed).toBeGreaterThan(0);
    state.value = 'off';
    managedCalls.length = 0;
    expect(await ask(s, 'compile')).toBeNull();
    expect(managedCalls).toEqual(['acquire nomic-embed-text']);
    // up again: the same question is answered by meaning
    expect((await ask(s, 'compile'))?.[0]).toBe('l1');
  });

  it('leaving the managed mode stops the server; the start and stop keys need it', async () => {
    const { m, calls: managedCalls } = fakeManaged();
    const s = make({ embedder: undefined, managed: m });
    await s.load();
    await expect(s.managedAction('start')).rejects.toMatchObject({ field: 'action' });
    await s.setConfig({ mode: 'managed', model: 'nomic-embed-text' });
    await s.managedAction('start');
    expect(managedCalls).toContain('start nomic-embed-text');
    await expect(s.managedAction('reboot')).rejects.toMatchObject({ field: 'action' });
    expect(s.managedLogs()).toEqual(['line one']);
    await s.setConfig({ mode: 'remote', endpoint: url, model: 'nomic-embed-text' });
    expect(managedCalls.at(-1)).toBe('stop');
    expect(s.status().mode).toBe('remote');
    await expect(s.managedAction('start')).rejects.toMatchObject({ field: 'action' });
  });

  it('is refused where there is no managed Ollama, and for settings it does not know', async () => {
    const none = make();
    await none.load();
    await expect(none.setConfig({ mode: 'managed', model: 'x' })).rejects.toMatchObject({ field: 'mode' });
    await expect(none.setConfig({ endpoint: url, model: 'x', threads: 2 })).rejects.toMatchObject({ field: 'threads' });
    await expect(none.setConfig({ mode: 'cloud' })).rejects.toMatchObject({ field: 'mode' });
    const { m } = fakeManaged();
    const s = make({ managed: m });
    await s.load();
    await expect(s.setConfig({ mode: 'managed', model: 'nomic-embed-text', keepAlive: 'forever' })).rejects.toMatchObject({ field: 'keepAlive' });
    await expect(s.setConfig({ mode: 'managed', model: 'nomic-embed-text', threads: -2 })).rejects.toMatchObject({ field: 'threads' });
    await expect(s.setConfig({ mode: 'managed', model: 'nomic-embed-text', apiKey: 'k' })).rejects.toMatchObject({ field: 'apiKey' });
    expect(s.status().configured).toBe(false);
  });

  it('where the Clean Rooms share the network, managed Ollama runs only after the Director said he understands', async () => {
    const { m, calls: managedCalls } = fakeManaged(true);
    const s = make({ embedder: undefined, managed: m });
    await s.load();
    const refused = await s.setConfig({ mode: 'managed', model: 'nomic-embed-text' }).then(() => null, (e: unknown) => e as { field?: string; message: string });
    expect(refused?.field).toBe('acknowledge');
    expect(refused?.message).toMatch(/Clean Room/);
    expect(refused?.message).toMatch(/no login/);
    await expect(s.setConfig({ mode: 'managed', model: 'nomic-embed-text', acknowledge: 'yes' })).rejects.toMatchObject({ field: 'acknowledge' });
    expect(s.status()).toMatchObject({ configured: false, acknowledged: false });
    expect(managedCalls).toEqual([]);
    const done = await s.setConfig({ mode: 'managed', model: 'nomic-embed-text', acknowledge: true });
    expect(done).toMatchObject({ mode: 'managed', acknowledged: true, managed: { shared: true } });
    expect(managedCalls).toContain('acquire nomic-embed-text');
    expect(JSON.parse(await readFile(join(dir, 'semantic', 'config.json'), 'utf8'))).toMatchObject({ mode: 'managed', acknowledged: true });
    // later saves keep it (he is not asked again for a setting)
    expect((await s.setConfig({ keepAlive: '1m' })).acknowledged).toBe(true);
    // Remote never needs it
  });

  it('a saved managed setup that was never acknowledged on such a network does not start the server', async () => {
    await mkdir(join(dir, 'semantic'), { recursive: true });
    await writeFile(join(dir, 'semantic', 'config.json'), JSON.stringify({ mode: 'managed', endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text', confirmed: null }));
    const { m, calls: managedCalls } = fakeManaged(true);
    const s = make({ embedder: undefined, managed: m });
    await s.load();
    expect(s.status()).toMatchObject({ mode: 'managed', acknowledged: false });
    await s.idle();
    expect(managedCalls).toEqual([]);
    expect(s.status()).toMatchObject({ state: 'error', reason: expect.stringContaining('accept that a Clean Room can reach it') });
    await expect(s.managedAction('start')).rejects.toMatchObject({ field: 'acknowledge' });
    // stop only does less: it is always allowed
    await expect(s.managedAction('stop')).resolves.toMatchObject({ mode: 'managed' });
    expect(managedCalls).toEqual(['stop']);
    managedCalls.length = 0;
    expect(await ask(s, 'compile')).toBeNull();
    expect(managedCalls).toEqual([]);
    // Remote is not asked
    await s.setConfig({ mode: 'remote', endpoint: url, model: 'nomic-embed-text' });
    expect(s.status().mode).toBe('remote');
  });

  it('sends the key of a remote Ollama as Authorization: Bearer, keeps it in its own 0600 file, and never shows it', async () => {
    const s = make({ embedder: undefined });
    await s.load();
    const status = await s.setConfig({ mode: 'remote', endpoint: url, model: 'nomic-embed-text', apiKey: 'sk-secret-key-123' });
    expect(status.apiKeySet).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sk-secret');
    await s.idle();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.authorization === 'Bearer sk-secret-key-123')).toBe(true);
    const file = join(dir, 'semantic', 'api-key');
    expect(await readFile(file, 'utf8')).toBe('sk-secret-key-123');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'semantic', 'config.json'), 'utf8')).not.toContain('sk-secret');
    // a restart reads it again; removing it removes the file and the header
    const again = make({ embedder: undefined });
    await again.load();
    expect(again.status().apiKeySet).toBe(true);
    const cleared = await again.setConfig({ apiKey: null });
    expect(cleared.apiKeySet).toBe(false);
    await expect(stat(file)).rejects.toThrow();
    requests.length = 0;
    again.changed('l1');
    await again.idle();
    expect(requests.every((r) => r.authorization === undefined)).toBe(true);
  });

  it('refuses a key it would send in the clear to another machine, or that is not a key', async () => {
    const s = make({ embedder: undefined });
    await s.load();
    await expect(s.setConfig({ mode: 'remote', endpoint: 'http://192.168.1.10:11434', confirm: '192.168.1.10', model: 'nomic-embed-text', apiKey: 'k' })).rejects.toMatchObject({ field: 'apiKey' });
    await expect(s.setConfig({ mode: 'remote', endpoint: url, model: 'nomic-embed-text', apiKey: 'has a space' })).rejects.toMatchObject({ field: 'apiKey' });
    await expect(s.setConfig({ mode: 'remote', endpoint: url, model: 'nomic-embed-text', apiKey: 'x'.repeat(501) })).rejects.toMatchObject({ field: 'apiKey' });
    // loopback takes a key over http (a proxy on this machine); the embedder itself refuses the same key to a private host over http
    const { embed } = await import('../src/server/embedder.js');
    await expect(embed({ endpoint: 'http://192.168.1.10:11434', model: 'm', confirmed: '192.168.1.10', apiKey: 'k', resolver: async () => [{ address: '192.168.1.10', family: 4 }] }, ['x'])).rejects.toThrow(/only over https/);
  });
});
