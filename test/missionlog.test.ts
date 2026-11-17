import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_BODY_MAX_CHARS, LOG_ENTRIES_MAX, LOG_SEARCH_MAX, LOG_TAGS_MAX, LOG_TITLE_MAX_CHARS } from '../src/shared/protocol.js';
import type { LogFrame, Logger } from '../src/shared/protocol.js';
import { LOG_DIR } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { createMissionLog } from '../src/server/missionlog.js';
import type { MissionLog } from '../src/server/missionlog.js';

const MIN = 60_000;
let dir: string;
let now: number;
let frames: LogFrame[];
let logs: string[];

const quiet = (sink: string[]): Logger => {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void sink.push(message),
    error: (message, ...extra) => void sink.push([message, ...extra.map(String)].join(' ')),
    child: () => log,
  };
  return log;
};

const make = (): MissionLog => createMissionLog({ dir, now: () => now, emit: (frame) => void frames.push(frame), log: quiet(logs) });
const files = async (): Promise<string[]> => (await readdir(join(dir, LOG_DIR))).filter((f) => !f.startsWith('.')).sort();
const fileText = (name: string): Promise<string> => readFile(join(dir, LOG_DIR, name), 'utf8');

async function loaded(): Promise<MissionLog> {
  const log = make();
  await log.load();
  return log;
}

/** What the code throws for a bad request: the field it names, or undefined. */
async function refused(run: () => Promise<unknown>): Promise<{ code: string; field: string | undefined; message: string }> {
  try {
    await run();
  } catch (e) {
    if (e instanceof HubError) return { code: e.code, field: e.field, message: e.message };
    throw e;
  }
  throw new Error('it was not refused');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-log-'));
  now = Date.UTC(2026, 10, 17, 14, 3);
  frames = [];
  logs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Mission Log: writing', () => {
  it('writes one markdown file for an entry, in a private folder, and tells the browsers its id and title only', async () => {
    const log = await loaded();
    const entry = await log.create('ana', { title: 'Cache key', body: 'The cache key has the node version.\n\nSecond paragraph.', tags: ['Build', 'cache', 'build'] });
    expect(entry).toEqual({ id: 'l1', title: 'Cache key', body: 'The cache key has the node version.\n\nSecond paragraph.', tags: ['build', 'cache'], author: 'ana', createdAt: now, updatedAt: now });
    expect(await files()).toEqual(['l1.md']);
    expect(await fileText('l1.md')).toBe(
      [
        '---',
        'version: 1',
        'id: "l1"',
        'title: "Cache key"',
        'tags: ["build","cache"]',
        'author: "ana"',
        'createdAt: "2026-11-17T14:03:00.000Z"',
        'updatedAt: "2026-11-17T14:03:00.000Z"',
        '---',
        'The cache key has the node version.',
        '',
        'Second paragraph.',
        '',
      ].join('\n'),
    );
    expect((await stat(join(dir, LOG_DIR, 'l1.md'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, LOG_DIR))).mode & 0o777).toBe(0o700);
    expect(frames).toEqual([{ t: 'log', changed: [{ id: 'l1', title: 'Cache key' }], removed: [] }]);
    expect(JSON.stringify(frames)).not.toContain('node version');
    expect((await log.create('user', { title: 'Second', body: 'x' })).id).toBe('l2');
  });

  it('gives each of several writes at once its own id', async () => {
    const log = await loaded();
    const made = await Promise.all([1, 2, 3, 4, 5].map((n) => log.create('ana', { title: `T${n}`, body: `body ${n}` })));
    expect(made.map((e) => e.id).sort()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    expect(await files()).toEqual(['l1.md', 'l2.md', 'l3.md', 'l4.md', 'l5.md']);
  });

  it('refuses a bad request and names the field, and writes nothing', async () => {
    const log = await loaded();
    const ok = { title: 'T', body: 'b' };
    const cases: Array<[unknown, string | undefined]> = [
      [null, undefined],
      [[], undefined],
      [{ body: 'b' }, 'title'],
      [{ title: 'T' }, 'body'],
      [{ ...ok, author: 'ben' }, 'author'],
      [{ ...ok, id: 'l1' }, 'id'],
      [{ title: '', body: 'b' }, 'title'],
      [{ title: '   ', body: 'b' }, 'title'],
      [{ title: 'two\nlines', body: 'b' }, 'title'],
      [{ title: 'x'.repeat(LOG_TITLE_MAX_CHARS + 1), body: 'b' }, 'title'],
      [{ title: 5, body: 'b' }, 'title'],
      [{ title: 'T', body: '' }, 'body'],
      [{ title: 'T', body: ' \n ' }, 'body'],
      [{ title: 'T', body: 'x'.repeat(LOG_BODY_MAX_CHARS + 1) }, 'body'],
      [{ title: 'T', body: ['b'] }, 'body'],
      [{ ...ok, tags: 'build' }, 'tags'],
      [{ ...ok, tags: ['Has Space'] }, 'tags'],
      [{ ...ok, tags: ['-lead'] }, 'tags'],
      [{ ...ok, tags: [''] }, 'tags'],
      [{ ...ok, tags: [3] }, 'tags'],
      [{ ...ok, tags: ['x'.repeat(31)] }, 'tags'],
      [{ ...ok, tags: Array.from({ length: LOG_TAGS_MAX + 1 }, (_, i) => `t${i}`) }, 'tags'],
    ];
    for (const [input, field] of cases) expect(await refused(() => log.create('ana', input)), JSON.stringify(input).slice(0, 80)).toMatchObject({ code: 'bad_request', field });
    expect(await refused(() => log.create('ana', {}))).toMatchObject({ code: 'bad_request', field: 'title' });
    expect(log.search('').total).toBe(0);
    expect(await files()).toEqual([]);
    expect(frames).toEqual([]);
  });

  it('takes the longest title, body and tag list the limits allow, and keeps a body that holds a line of dashes', async () => {
    const log = await loaded();
    const body = `before\n---\nafter: still the body\n---\n${'x'.repeat(LOG_BODY_MAX_CHARS - 40)}`;
    await log.create('ana', { title: 'x'.repeat(LOG_TITLE_MAX_CHARS), body, tags: Array.from({ length: LOG_TAGS_MAX }, (_, i) => `t${i}`) });
    const again = await loaded();
    expect(again.get('l1').body).toBe(body);
    expect(again.get('l1').tags).toHaveLength(LOG_TAGS_MAX);
  });

  it('refuses the 2001st entry', async () => {
    const log = make();
    await log.load();
    // the files of 2000 entries, as an older run would have left them
    for (let i = 1; i <= LOG_ENTRIES_MAX; i += 1) {
      await writeFile(join(dir, LOG_DIR, `l${i}.md`), `---\nid: "l${i}"\ntitle: "T${i}"\ntags: []\nauthor: "ana"\ncreatedAt: "2026-11-17T14:03:00.000Z"\nupdatedAt: "2026-11-17T14:03:00.000Z"\n---\nb\n`);
    }
    const full = await loaded();
    expect(full.search('').total).toBe(LOG_ENTRIES_MAX);
    expect(await refused(() => full.create('ana', { title: 'one more', body: 'b' }))).toMatchObject({ code: 'conflict', field: 'log' });
    await full.remove('l7');
    expect((await full.create('ana', { title: 'one more', body: 'b' })).id).toBe(`l${LOG_ENTRIES_MAX + 1}`);
  }, 30_000);

  it('tells the caller when the disk refuses, and keeps the entries as they were', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'First', body: 'b' });
    await rm(join(dir, LOG_DIR), { recursive: true });
    await expect(log.create('ana', { title: 'Second', body: 'b' })).rejects.toThrow();
    expect(log.search('').total).toBe(1);
    expect(frames).toHaveLength(1);
    await expect(log.update('l1', { body: 'changed' }, 'ana')).rejects.toThrow();
    expect(log.get('l1').body).toBe('b');
  });
});

describe('Mission Log: changing and removing', () => {
  it('lets an agent change what it wrote, with only the fields it gives, and stamps the time', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'Cache key', body: 'old text', tags: ['build'] });
    now += 5 * MIN;
    const changed = await log.update('l1', { body: 'new text about the cache' }, 'ana');
    expect(changed).toEqual({ id: 'l1', title: 'Cache key', body: 'new text about the cache', tags: ['build'], author: 'ana', createdAt: now - 5 * MIN, updatedAt: now });
    expect(await fileText('l1.md')).toContain('updatedAt: "2026-11-17T14:08:00.000Z"');
    expect(await fileText('l1.md')).toContain('createdAt: "2026-11-17T14:03:00.000Z"');
    await log.update('l1', { tags: [], title: 'Cache keys' }, 'ana');
    expect(log.get('l1')).toMatchObject({ title: 'Cache keys', tags: [], body: 'new text about the cache' });
    expect(frames.at(-1)).toEqual({ t: 'log', changed: [{ id: 'l1', title: 'Cache keys' }], removed: [] });
    // the index follows: the old words are gone and the new ones are found
    expect(log.search('old').hits).toEqual([]);
    expect(log.search('cache').hits.map((h) => h.id)).toEqual(['l1']);
  });

  it('refuses an agent that did not write the entry, and lets the Director change any entry without changing its author', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'Mine', body: 'b' });
    expect(await refused(() => log.update('l1', { body: 'mine now' }, 'ben'))).toMatchObject({ code: 'forbidden', message: expect.stringContaining('written by ana') });
    expect(log.get('l1').body).toBe('b');
    await log.update('l1', { body: 'edited by the Director' }, null);
    expect(log.get('l1')).toMatchObject({ body: 'edited by the Director', author: 'ana' });
    await log.create('user', { title: 'His', body: 'b' });
    expect(await refused(() => log.update('l2', { body: 'x' }, 'ana'))).toMatchObject({ code: 'forbidden' });
  });

  it('checks the fields of a change, and wants at least one', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'T', body: 'b' });
    expect(await refused(() => log.update('l1', {}, 'ana'))).toMatchObject({ code: 'bad_request', message: expect.stringContaining('nothing to change') });
    expect(await refused(() => log.update('l1', { title: '' }, 'ana'))).toMatchObject({ code: 'bad_request', field: 'title' });
    expect(await refused(() => log.update('l1', { author: 'ben' }, 'ana'))).toMatchObject({ code: 'bad_request', field: 'author' });
    expect(await refused(() => log.update('l1', 'text', 'ana'))).toMatchObject({ code: 'bad_request' });
    expect(await refused(() => log.update('l9', { body: 'x' }, 'ana'))).toMatchObject({ code: 'not_found' });
    expect(await refused(() => log.update('../x', { body: 'x' }, null))).toMatchObject({ code: 'not_found' });
  });

  it('writes nothing and sends no frame for a change that changes nothing', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'T', body: 'b', tags: ['x'] });
    const before = await fileText('l1.md');
    now += MIN;
    const same = await log.update('l1', { title: 'T', body: 'b', tags: ['X'] }, 'ana');
    expect(same.updatedAt).toBe(now - MIN);
    expect(await fileText('l1.md')).toBe(before);
    expect(frames).toHaveLength(1);
  });

  it('removes an entry: its file, its words and a frame; and does not give its id again, also after a restart', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'First', body: 'the printer' });
    await log.create('ana', { title: 'Second', body: 'the scanner' });
    await log.remove('l2');
    expect(await files()).toEqual(['l1.md']);
    expect(log.search('scanner').hits).toEqual([]);
    expect(frames.at(-1)).toEqual({ t: 'log', changed: [], removed: ['l2'] });
    expect(await refused(() => log.remove('l2'))).toMatchObject({ code: 'not_found' });
    expect((await log.create('ana', { title: 'Third', body: 'b' })).id).toBe('l3');
    await log.remove('l3');
    const restarted = await loaded();
    expect((await restarted.create('ana', { title: 'Fourth', body: 'b' })).id).toBe('l4');
    expect((await stat(join(dir, LOG_DIR, '.seq'))).mode & 0o777).toBe(0o600);
    // a file deleted by hand while gonogo runs: the entry can still be removed
    await rm(join(dir, LOG_DIR, 'l4.md'));
    await restarted.remove('l4');
    expect(restarted.search('').hits.map((h) => h.id)).toEqual(['l1']);
  });
});

describe('Mission Log: reading it back', () => {
  it('finds every entry again at start, as it was written', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'Quotes "and" colons: yes', body: 'Línea con ñ y 日本語\n---\nend', tags: ['a.b', 'c_d'] });
    now += MIN;
    await log.create('user', { title: 'Second', body: 'b' });
    const again = await loaded();
    expect(again.get('l1')).toEqual(log.get('l1'));
    expect(again.get('l2')).toEqual(log.get('l2'));
    expect(again.search('').total).toBe(2);
  });

  it('skips a file that is not an entry, says why, keeps it, and never gives its id to a new entry', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'Good', body: 'b' });
    const folder = join(dir, LOG_DIR);
    await writeFile(join(folder, 'l5.md'), 'just text, no front matter\n');
    await writeFile(join(folder, 'l6.md'), '---\nid: "l7"\ntitle: "Wrong id"\ntags: []\nauthor: "ana"\ncreatedAt: "2026-11-17T14:03:00.000Z"\nupdatedAt: "2026-11-17T14:03:00.000Z"\n---\nb\n');
    await writeFile(join(folder, 'l8.md'), '---\nid: "l8"\ntitle: "Bad time"\ntags: []\nauthor: "ana"\ncreatedAt: "yesterday"\nupdatedAt: "2026-11-17T14:03:00.000Z"\n---\nb\n');
    await writeFile(join(folder, 'l9.md'), '---\nid: "l9"\ntitle: not json\n---\nb\n');
    await writeFile(join(folder, 'notes.txt'), 'not an entry');
    await writeFile(join(folder, 'l10.md.bak'), 'not an entry');
    logs = [];
    const again = await loaded();
    expect(again.search('').hits.map((h) => h.id)).toEqual(['l1']);
    expect(logs).toHaveLength(4);
    expect(logs.join('\n')).toMatch(/l5\.md was skipped: no front matter/);
    expect(logs.join('\n')).toMatch(/l6\.md was skipped: the id does not match/);
    expect(logs.join('\n')).toMatch(/l8\.md was skipped: no valid times/);
    expect(logs.join('\n')).toMatch(/l9\.md was skipped/);
    expect(await fileText('l5.md')).toBe('just text, no front matter\n');
    expect((await again.create('ana', { title: 'Next', body: 'b' })).id).toBe('l10');
  });

  it('reads an entry that has no version as version 1, and skips and keeps one saved by a newer gonogo', async () => {
    await loaded();
    const folder = join(dir, LOG_DIR);
    const entry = (id: string, version: string): string =>
      `---\n${version}id: "${id}"\ntitle: "T ${id}"\ntags: []\nauthor: "ana"\ncreatedAt: "2026-11-17T14:03:00.000Z"\nupdatedAt: "2026-11-17T14:03:00.000Z"\n---\nb\n`;
    await writeFile(join(folder, 'l1.md'), entry('l1', ''));
    await writeFile(join(folder, 'l2.md'), entry('l2', 'version: 1\n'));
    await writeFile(join(folder, 'l3.md'), entry('l3', 'version: 2\n'));
    logs = [];
    const again = await loaded();
    expect(again.search('').hits.map((h) => h.id).sort()).toEqual(['l1', 'l2']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/l3\.md was skipped: format version 2 was saved by another gonogo; this one reads version 1/);
    expect(await fileText('l3.md')).toBe(entry('l3', 'version: 2\n'));
    expect((await again.create('ana', { title: 'Next', body: 'b' })).id).toBe('l4');
  });

  it('reads a file with Windows line ends, and a body that was edited by hand', async () => {
    await loaded();
    const text = ['---', 'id: "l1"', 'title: "By hand"', 'tags: ["x"]', 'author: "user"', 'createdAt: "2026-11-17T14:03:00.000Z"', 'updatedAt: "2026-11-17T14:03:00.000Z"', '---', 'one', 'two', ''].join('\r\n');
    await writeFile(join(dir, LOG_DIR, 'l1.md'), text);
    expect((await loaded()).get('l1')).toMatchObject({ title: 'By hand', body: 'one\ntwo', author: 'user' });
  });
});

describe('Mission Log: search and get', () => {
  it('answers a search with the best entries first, a snippet and no body, and counts every entry', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'Release steps', body: 'Run the tests, then tag the release and push the tag.', tags: ['release'] });
    now += MIN;
    await log.create('ben', { title: 'Cache key', body: 'The cache key has the node version. A release does not clear it.' });
    now += MIN;
    await log.create('ana', { title: 'Lunch', body: 'Nothing to do with the build.' });
    const found = log.search('release');
    expect(found.total).toBe(3);
    expect(found.hits.map((h) => h.id)).toEqual(['l1', 'l2']);
    expect(found.hits[0]).toEqual({ id: 'l1', title: 'Release steps', author: 'ana', tags: ['release'], updatedAt: Date.UTC(2026, 10, 17, 14, 3), snippet: 'Run the tests, then tag the release and push the tag.' });
    expect(found.hits[1]?.snippet).toContain('A release does not clear it.');
    expect(found.hits[0]).not.toHaveProperty('body');
  });

  it('lists the newest entries for an empty query, and cuts at the limit, which never goes above 20', async () => {
    const log = await loaded();
    for (let i = 1; i <= 25; i += 1) {
      now += MIN;
      await log.create('ana', { title: `Entry ${i}`, body: `body ${i}` });
    }
    const all = log.search('  ');
    expect(all.total).toBe(25);
    expect(all.hits).toHaveLength(LOG_SEARCH_MAX);
    expect(all.hits[0]?.id).toBe('l25');
    expect(log.search('', 3).hits.map((h) => h.id)).toEqual(['l25', 'l24', 'l23']);
    expect(log.search('body', 500).hits).toHaveLength(LOG_SEARCH_MAX);
    expect(log.search('body', 0).hits).toHaveLength(1);
  });

  it('puts an entry that was just changed first in the list', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'Old', body: 'b' });
    now += MIN;
    await log.create('ana', { title: 'New', body: 'b' });
    now += MIN;
    await log.update('l1', { body: 'changed' }, null);
    expect(log.search('').hits.map((h) => h.id)).toEqual(['l1', 'l2']);
  });

  it('reads an entry, as a copy, and says so for an id it does not hold', async () => {
    const log = await loaded();
    await log.create('ana', { title: 'T', body: 'b', tags: ['x'] });
    const entry = log.get('l1');
    entry.tags.push('changed');
    entry.body = 'changed';
    expect(log.get('l1')).toMatchObject({ body: 'b', tags: ['x'] });
    for (const id of ['l2', '', 'x', 'l01', '../l1']) expect(() => log.get(id), id).toThrow(HubError);
  });
});
