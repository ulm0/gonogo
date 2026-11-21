import { describe, expect, it } from 'vitest';
import { LOG_BODY_MAX_CHARS, LOG_TAGS_MAX, LOG_TITLE_MAX_CHARS } from '../src/shared/protocol.js';
import type { LogEntry, LogSearch } from '../src/shared/protocol.js';
import { semanticStatusText } from '../src/client/semanticview.js';
import { countText, emptyValues, FIELDS, newsText, NO_LOG_NEWS, parseTags, requestOf, rowId, validate, valuesOf } from '../src/client/log.js';

const entry: LogEntry = { id: 'l1', title: 'Cache key', body: 'The cache key has the node version.', tags: ['build', 'cache'], author: 'ana', createdAt: 1, updatedAt: 2 };
const search = (total: number, hits: number): LogSearch => ({
  total,
  hits: Array.from({ length: hits }, (_, i) => ({ id: `l${i + 1}`, title: 't', author: 'ana', tags: [], updatedAt: 1, snippet: 's' })),
});

describe('the tags of the form', () => {
  it('are words separated by spaces or commas, lowercase, each once', () => {
    expect(parseTags(' Build, cache  build\ncache,, ')).toEqual(['build', 'cache']);
    expect(parseTags('')).toEqual([]);
  });
});

describe('the form', () => {
  const ok = { title: 'Cache key', tags: 'build', body: 'text' };

  it('starts empty, or with the values of the entry', () => {
    expect(emptyValues()).toEqual({ title: '', tags: '', body: '' });
    expect(valuesOf(entry)).toEqual({ title: 'Cache key', tags: 'build cache', body: 'The cache key has the node version.' });
    expect(FIELDS).toEqual(['title', 'tags', 'body']);
  });

  it('accepts a good entry, with no tags too', () => {
    expect(validate(ok)).toEqual({});
    expect(validate({ ...ok, tags: '' })).toEqual({});
    expect(validate({ title: 'x'.repeat(LOG_TITLE_MAX_CHARS), tags: Array.from({ length: LOG_TAGS_MAX }, (_, i) => `t${i}`).join(' '), body: 'x'.repeat(LOG_BODY_MAX_CHARS) })).toEqual({});
  });

  it('says what is wrong with each field', () => {
    expect(validate({ ...ok, title: '  ' }).title).toBe('Give it a title.');
    expect(validate({ ...ok, title: 'x'.repeat(LOG_TITLE_MAX_CHARS + 1) }).title).toMatch(/At most 200/);
    expect(validate({ ...ok, title: 'two\nlines' }).title).toBe('One line.');
    expect(validate({ ...ok, tags: 'ok bad! tag' }).tags).toMatch(/1 to 30 letters/);
    expect(validate({ ...ok, tags: 'x'.repeat(31) }).tags).toMatch(/1 to 30 letters/);
    expect(validate({ ...ok, tags: Array.from({ length: LOG_TAGS_MAX + 1 }, (_, i) => `t${i}`).join(' ') }).tags).toBe(`At most ${LOG_TAGS_MAX} tags.`);
    expect(validate({ ...ok, body: ' \n' }).body).toBe('Write the entry.');
    expect(validate({ ...ok, body: 'x'.repeat(LOG_BODY_MAX_CHARS + 1) }).body).toMatch(/At most 20000/);
  });

  it('is sent trimmed, with its tags as a list', () => {
    expect(requestOf({ title: ' Cache key ', tags: 'Build, cache', body: '\n text \n' })).toEqual({ title: 'Cache key', body: 'text', tags: ['build', 'cache'] });
    expect(requestOf({ title: 'T', tags: '', body: 'b' }).tags).toEqual([]);
  });
});

describe('the label of a search', () => {
  it('says which search it was only when Search by meaning is on', () => {
    expect(countText('cache', search(5, 2))).toBe('2 found in 5 entries.');
    expect(countText('cache', search(5, 2), true)).toBe('2 found in 5 entries. Word search.');
    expect(countText('cache', { ...search(5, 2), mode: 'meaning' }, true)).toBe('2 found in 5 entries. Meaning + word search.');
    expect(countText('', search(5, 5), true)).toBe('5 entries.');
  });

  it('the status line is counts and fixed words', () => {
    const v = { enabled: true, endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text', confirmed: null, state: 'indexing' as const, reason: '', indexed: 340, total: 1900, dimension: 768, used: 120, cap: 20000 };
    expect(semanticStatusText(v)).toBe('Indexing 340 of 1,900 chunks. nomic-embed-text, 768 numbers. 120 of 20,000 used today.');
    expect(semanticStatusText({ ...v, state: 'idle', indexed: 1900 })).toMatch(/^1,900 of 1,900 chunks indexed\./);
    expect(semanticStatusText({ ...v, state: 'error', reason: 'the endpoint answered 500' })).toMatch(/^The endpoint does not answer: the endpoint answered 500\./);
    expect(semanticStatusText({ ...v, state: 'cap' })).toMatch(/limit of 20,000 chunks is reached: word search goes on/);
    expect(semanticStatusText({ ...v, state: 'off', dimension: 0 })).toBe('Off. 120 of 20,000 used today.');
  });
});

describe('the words of the page', () => {
  it('counts the entries under the search box', () => {
    expect(countText('', search(0, 0))).toBe('No entries yet.');
    expect(countText('', search(1, 1))).toBe('1 entry.');
    expect(countText('', search(3, 3))).toBe('3 entries.');
    expect(countText(' ', search(340, 20))).toBe('20 newest of 340 entries.');
    expect(countText('cache', search(340, 3))).toBe('3 found in 340 entries.');
    expect(countText('cache', search(1, 1))).toBe('1 found in 1 entry.');
    expect(countText('unicorn', search(340, 0))).toBe('Nothing in 340 entries.');
  });

  it('says what a frame changed, by title, and what it removed, by id', () => {
    expect(newsText(NO_LOG_NEWS)).toBe('');
    expect(newsText({ rev: 1, changed: [{ id: 'l1', title: 'Cache key' }], removed: [] })).toBe('Written or changed: Cache key');
    expect(newsText({ rev: 2, changed: [], removed: ['l3'] })).toBe('Removed: l3');
    expect(newsText({ rev: 3, changed: [{ id: 'l1', title: 'A' }, { id: 'l2', title: 'B' }], removed: ['l3', 'l4'] })).toBe('Written or changed: A, B. Removed: l3, l4');
  });

  it('gives each row an element id for the keyboard', () => {
    expect(rowId('l7')).toBe('log-row-l7');
  });
});
