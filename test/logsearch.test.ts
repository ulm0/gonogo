import { describe, expect, it } from 'vitest';
import { LOG_SNIPPET_CHARS } from '../src/server/constants.js';
import { createIndex, snippet, tokenize } from '../src/server/logsearch.js';
import type { IndexedDoc, LogIndex } from '../src/server/logsearch.js';

const doc = (id: string, title: string, body: string, at = 1, tags: string[] = []): IndexedDoc => ({ id, title, body, tags, at });
const ids = (index: LogIndex, query: string, limit = 20): string[] => index.search(query, limit).map((r) => r.id);

describe('tokenize', () => {
  it('lowercases, splits on anything that is not a letter or a digit and drops one-character words', () => {
    expect(tokenize('Node_modules, v1.2: a build-step (C++)!')).toEqual(['node', 'modules', 'v1', 'build', 'step']);
  });

  it('keeps accented letters and digits', () => {
    expect(tokenize('Configuración 2026 ñandú')).toEqual(['configuración', '2026', 'ñandú']);
  });

  it('gives nothing for a text without words', () => {
    expect(tokenize('  -- ! a ')).toEqual([]);
  });
});

describe('the BM25 index', () => {
  it('returns only the entries that hold a word of the query, and nothing for a word nobody wrote', () => {
    const index = createIndex();
    index.add(doc('l1', 'Build', 'run npm test before the build'));
    index.add(doc('l2', 'Deploy', 'the deploy needs a token'));
    expect(ids(index, 'deploy')).toEqual(['l2']);
    expect(ids(index, 'unicorn')).toEqual([]);
    expect(ids(index, '')).toEqual([]);
    expect(ids(createIndex(), 'build')).toEqual([]);
  });

  it('ranks a word in the title above the same word in the body', () => {
    const index = createIndex();
    index.add(doc('l1', 'Notes', 'the cache is cleared at night, and the cache key has the node version'));
    index.add(doc('l2', 'Cache', 'cleared at night, and the key has the node version'));
    expect(ids(index, 'cache')).toEqual(['l2', 'l1']);
  });

  it('counts a tag like a word of the title', () => {
    const index = createIndex();
    index.add(doc('l1', 'Notes', 'something about the cache', 1));
    index.add(doc('l2', 'Notes', 'something about the cache', 1, ['cache']));
    expect(ids(index, 'cache')).toEqual(['l2', 'l1']);
  });

  it('ranks a rare word above a common one', () => {
    const index = createIndex();
    for (let i = 1; i <= 6; i += 1) index.add(doc(`l${i}`, 'Plain', `the server restarts at night ${i}`));
    index.add(doc('l7', 'Plain', 'the server uses a kraken queue'));
    index.add(doc('l8', 'Plain', 'the server restarts'));
    // "server" is in all of them, "kraken" in one: the entry with the rare word is first for either word order
    expect(ids(index, 'server kraken')[0]).toBe('l7');
    expect(ids(index, 'kraken server')[0]).toBe('l7');
  });

  it('ranks the shorter text first when two hold the word once, and a word that comes often gains less each time', () => {
    const index = createIndex();
    const filler = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    index.add(doc('l1', 'A', `${filler} cache`));
    index.add(doc('l2', 'A', 'cache and a few words'));
    expect(ids(index, 'cache')).toEqual(['l2', 'l1']);
    index.add(doc('l3', 'A', 'cache cache cache cache cache cache cache cache cache cache'));
    const score = (id: string): number => index.search('cache', 5).find((r) => r.id === id)?.score ?? 0;
    // ten times the word is not ten times the score
    expect(score('l3')).toBeGreaterThan(score('l1'));
    expect(score('l3')).toBeLessThan(score('l2') * 10);
  });

  it('adds the words of the query: an entry with both words beats one with only the common word', () => {
    const index = createIndex();
    index.add(doc('l1', 'One', 'redis cache for the session store'));
    index.add(doc('l2', 'Two', 'redis redis redis for the queue'));
    index.add(doc('l3', 'Three', 'a cache for images'));
    expect(ids(index, 'redis cache')[0]).toBe('l1');
    // a repeated word in the query counts once
    expect(index.search('redis redis redis cache', 5)).toEqual(index.search('redis cache', 5));
  });

  it('puts the newer entry first when the score is the same', () => {
    const index = createIndex();
    index.add(doc('l1', 'Same', 'same text', 10));
    index.add(doc('l2', 'Same', 'same text', 30));
    index.add(doc('l3', 'Same', 'same text', 20));
    expect(ids(index, 'same')).toEqual(['l2', 'l3', 'l1']);
  });

  it('cuts the answer at the limit', () => {
    const index = createIndex();
    for (let i = 1; i <= 30; i += 1) index.add(doc(`l${i}`, 'Same', 'same text', i));
    expect(ids(index, 'same', 5)).toHaveLength(5);
    expect(ids(index, 'same', 5)[0]).toBe('l30');
  });

  it('forgets the old text of an entry that is added again, and an entry that is removed', () => {
    const index = createIndex();
    index.add(doc('l1', 'Old', 'about the printer'));
    index.add(doc('l2', 'Other', 'about the printer too'));
    index.add(doc('l1', 'New', 'about the scanner'));
    expect(ids(index, 'printer')).toEqual(['l2']);
    expect(ids(index, 'scanner')).toEqual(['l1']);
    index.remove('l1');
    index.remove('l1');
    index.remove('l9');
    expect(ids(index, 'scanner')).toEqual([]);
    expect(ids(index, 'printer')).toEqual(['l2']);
    index.remove('l2');
    expect(ids(index, 'printer')).toEqual([]);
    // the lengths went with the entries: a new entry scores as it would in a fresh index
    index.add(doc('l3', 'Fresh', 'printer'));
    const fresh = createIndex();
    fresh.add(doc('l3', 'Fresh', 'printer'));
    expect(index.search('printer', 1)).toEqual(fresh.search('printer', 1));
  });
});

describe('snippet', () => {
  const filler = (n: number): string => Array.from({ length: n }, (_, i) => `filler${i}`).join(' ');

  it('is the start of the text when no word matches', () => {
    expect(snippet('The first line.\nThe second line.', 'unicorn')).toBe('The first line. The second line.');
    expect(snippet('The first line.', '')).toBe('The first line.');
  });

  it('shows the whole text, with no dots, when it is short', () => {
    expect(snippet('a short note about the cache', 'cache')).toBe('a short note about the cache');
  });

  it('is cut around the match, with a dot on each side that was cut, whole words, and not longer than the limit', () => {
    const text = `${filler(60)} the cache key is the node version ${filler(60)}`;
    const found = snippet(text, 'cache');
    expect(found.startsWith('…')).toBe(true);
    expect(found.endsWith('…')).toBe(true);
    expect(found).toContain('the cache key is the node version');
    expect(found.length).toBeLessThanOrEqual(LOG_SNIPPET_CHARS + 2);
    const words = found.replace(/…/g, '').trim().split(' ');
    for (const w of words) expect(text.split(' ')).toContain(w);
  });

  it('shows the whole text when it fits in a snippet, also when the match is near its end', () => {
    const text = 'The cache key has the node version and the lockfile hash.';
    expect(snippet(text, 'lockfile')).toBe(text);
  });

  it('gives a match near the end of a long text the room that is left before it', () => {
    const text = `${filler(80)} the lockfile hash`;
    const found = snippet(text, 'lockfile');
    expect(found.endsWith('…')).toBe(false);
    expect(found.endsWith('the lockfile hash')).toBe(true);
    expect(found.length).toBeGreaterThan(LOG_SNIPPET_CHARS - 20);
    expect(found.length).toBeLessThanOrEqual(LOG_SNIPPET_CHARS + 1);
  });

  it('has no dot at the start when the match is at the start, and none at the end when the text ends there', () => {
    expect(snippet(`cache ${filler(80)}`, 'cache').startsWith('cache')).toBe(true);
    expect(snippet(`${filler(80)} cache`, 'cache').endsWith('…')).toBe(false);
    expect(snippet(`cache ${filler(80)}`, 'cache').endsWith('…')).toBe(true);
  });

  it('picks the place where most of the words of the query are close together', () => {
    const text = `alpha ${filler(80)} alpha beta gamma are together here ${filler(80)} beta`;
    const found = snippet(text, 'alpha beta gamma');
    expect(found).toContain('alpha beta gamma are together');
    expect(found.startsWith('…')).toBe(true);
  });

  it('takes the first place on a tie, and matches without regard to case', () => {
    const text = `one CACHE ${filler(80)} two cache ${filler(10)}`;
    const found = snippet(text, 'Cache');
    expect(found).toContain('one CACHE');
    expect(found).not.toContain('two cache');
  });

  it('puts the text on one line', () => {
    expect(snippet('line one\n\n\tline   two cache', 'cache')).toBe('line one line two cache');
  });
});
