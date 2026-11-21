import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry, Logger } from '../src/shared/protocol.js';
import { EmbedError } from '../src/server/embedder.js';
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
    expect(JSON.parse(await readFile(join(dir, 'semantic', 'config.json'), 'utf8'))).toEqual({ endpoint: 'http://192.168.1.10:11434', model: 'nomic-embed-text:latest', confirmed: '192.168.1.10' });
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
