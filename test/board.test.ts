import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOARD_MAX_CHARS } from '../src/shared/protocol.js';
import { createBoard } from '../src/server/board.js';
import type { Board } from '../src/server/board.js';
import { BOARD_FILE } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';

let dir: string;
let now: number;

const make = (): Board => createBoard({ dir, now: () => now });
const file = (): Promise<string> => readFile(join(dir, BOARD_FILE), 'utf8');

async function loaded(): Promise<Board> {
  const board = make();
  await board.load();
  return board;
}

/** What the code throws for a bad request: the code and the field it names. */
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
  dir = await mkdtemp(join(tmpdir(), 'gonogo-board-'));
  now = Date.UTC(2026, 10, 18, 9, 30);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the Plot Board', () => {
  it('starts empty, at revision 0, written by nobody', async () => {
    const board = await loaded();
    expect(board.get()).toEqual({ text: '', revision: 0, author: null, updatedAt: null });
    await expect(stat(join(dir, BOARD_FILE))).rejects.toThrow();
  });

  it('writes the text with its author and a new revision, to a file of mode 0600 that has a version', async () => {
    const board = await loaded();
    const view = await board.write('flight', { text: '# Plan\n\n- ship it', revision: 0 });
    expect(view).toEqual({ text: '# Plan\n\n- ship it', revision: 1, author: 'flight', updatedAt: now });
    expect(board.get()).toEqual(view);
    expect(await file()).toBe('---\nversion: 1\nrevision: 1\nauthor: "flight"\nupdatedAt: "2026-11-18T09:30:00.000Z"\n---\n# Plan\n\n- ship it\n');
    expect((await stat(join(dir, BOARD_FILE))).mode & 0o777).toBe(0o600);
    // no temporary file is left behind
    expect((await readdir(dir)).filter((name) => name !== BOARD_FILE)).toEqual([]);
  });

  it('is read again from the file at the next start', async () => {
    const first = await loaded();
    await first.write('user', { text: 'one', revision: 0 });
    now += 1000;
    await first.write('flight', { text: 'two\n---\nthree', revision: 1 });
    const again = await loaded();
    expect(again.get()).toEqual({ text: 'two\n---\nthree', revision: 2, author: 'flight', updatedAt: now });
  });

  it('refuses a write that names another revision than the current one, and changes nothing', async () => {
    const board = await loaded();
    await board.write('flight', { text: 'mine', revision: 0 });
    const refusal = await refused(() => board.write('user', { text: 'his', revision: 0 }));
    expect(refusal.code).toBe('conflict');
    expect(refusal.field).toBe('revision');
    expect(refusal.message).toBe('the Plot Board is at revision 1, not 0: read it again, then write');
    expect(board.get().text).toBe('mine');
    expect((await refused(() => board.write('user', { text: 'his', revision: 2 }))).code).toBe('conflict');
  });

  it('lets only one of two writes of the same revision through', async () => {
    const board = await loaded();
    const results = await Promise.allSettled([board.write('flight', { text: 'a', revision: 0 }), board.write('user', { text: 'b', revision: 0 })]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(board.get()).toMatchObject({ text: 'a', revision: 1, author: 'flight' });
  });

  it('changes nothing and writes nothing for the same text, and ends the text at its last word', async () => {
    const board = await loaded();
    await board.write('flight', { text: 'plan', revision: 0 });
    now += 5000;
    const same = await board.write('user', { text: 'plan  \r\n\n', revision: 1 });
    expect(same).toMatchObject({ text: 'plan', revision: 1, author: 'flight' });
    expect((await file()).includes('"user"')).toBe(false);
  });

  it('takes an empty text, which clears the board', async () => {
    const board = await loaded();
    await board.write('flight', { text: 'plan', revision: 0 });
    expect(await board.write('user', { text: '', revision: 1 })).toMatchObject({ text: '', revision: 2, author: 'user' });
  });

  it('keeps line ends as \\n', async () => {
    const board = await loaded();
    expect((await board.write('flight', { text: 'a\r\nb\rc', revision: 0 })).text).toBe('a\nb\nc');
  });

  describe('refuses what is not a plan', () => {
    it.each([
      ['a body that is not an object', 'text', undefined],
      ['an array', [{ text: 'x', revision: 0 }], undefined],
      ['no text', { revision: 0 }, 'text'],
      ['a text that is a number', { text: 5, revision: 0 }, 'text'],
      ['a text over the limit', { text: 'x'.repeat(BOARD_MAX_CHARS + 1), revision: 0 }, 'text'],
      ['a NUL character', { text: 'a\0b', revision: 0 }, 'text'],
      ['no revision', { text: 'x' }, 'revision'],
      ['a revision that is a string', { text: 'x', revision: '0' }, 'revision'],
      ['a negative revision', { text: 'x', revision: -1 }, 'revision'],
      ['a revision that is not whole', { text: 'x', revision: 0.5 }, 'revision'],
      ['a field of its own (the author)', { text: 'x', revision: 0, author: 'flight' }, 'author'],
    ] as const)('%s', async (_name, input, field) => {
      const board = await loaded();
      const refusal = await refused(() => board.write('flight', input));
      expect(refusal.code).toBe('bad_request');
      expect(refusal.field).toBe(field);
      expect(board.get().revision).toBe(0);
    });

    it('takes a text of exactly the limit', async () => {
      const board = await loaded();
      expect((await board.write('flight', { text: 'x'.repeat(BOARD_MAX_CHARS), revision: 0 })).text).toHaveLength(BOARD_MAX_CHARS);
    });

    it('does not let a front matter in the text change who wrote it', async () => {
      const board = await loaded();
      await board.write('flight', { text: '---\nauthor: "user"\n---\nsneaky', revision: 0 });
      const again = await loaded();
      expect(again.get()).toMatchObject({ author: 'flight', text: '---\nauthor: "user"\n---\nsneaky' });
    });
  });

  describe('the file', () => {
    it('is read as the plan itself when it was written by hand', async () => {
      await writeFile(join(dir, BOARD_FILE), '# My plan\r\n\r\n- one\n\n');
      const board = await loaded();
      expect(board.get()).toMatchObject({ text: '# My plan\n\n- one', revision: 0, author: null });
      expect(board.get().updatedAt).toBeGreaterThan(0);
      // the first write replaces it, from revision 0
      expect(await board.write('user', { text: 'new', revision: 0 })).toMatchObject({ revision: 1 });
    });

    it('is read as the plan itself when it starts with a front matter of somebody else', async () => {
      await writeFile(join(dir, BOARD_FILE), '---\ntitle: My plan\n---\nbody\n');
      expect((await loaded()).get().text).toBe('---\ntitle: My plan\n---\nbody');
    });

    it('is cut at the limit when it is longer', async () => {
      await writeFile(join(dir, BOARD_FILE), 'x'.repeat(BOARD_MAX_CHARS + 50));
      expect((await loaded()).get().text).toHaveLength(BOARD_MAX_CHARS);
    });

    it('stops the start when it was saved by a newer gonogo, and is not changed', async () => {
      const text = '---\nversion: 2\nrevision: 7\nauthor: "flight"\nupdatedAt: "2026-11-18T09:30:00.000Z"\n---\nplan\n';
      await writeFile(join(dir, BOARD_FILE), text);
      await expect(make().load()).rejects.toThrow(/was saved by a newer gonogo \(format version 2; this one reads up to 1\)/);
      expect(await file()).toBe(text);
    });

    it('reads a revision or an author that makes no sense as revision 0 and nobody', async () => {
      await writeFile(join(dir, BOARD_FILE), '---\nversion: 1\nrevision: -4\nauthor: 5\nupdatedAt: "not a date"\n---\nplan\n');
      expect((await loaded()).get()).toMatchObject({ text: 'plan', revision: 0, author: null });
    });

    it('is replaced, not followed, when it is a link: a write never changes the file the link points at', async () => {
      const target = join(dir, 'elsewhere.txt');
      await writeFile(target, 'keep me');
      await symlink(target, join(dir, BOARD_FILE));
      const board = await loaded();
      await board.write('user', { text: 'plan', revision: board.get().revision });
      expect(await readFile(target, 'utf8')).toBe('keep me');
      expect((await file()).endsWith('plan\n')).toBe(true);
    });
  });
});
