/**
 * Clearance (docs/engine-bay-spec.md): the keys the Director sets for one agent. The shape rules, the file (mode 0600, a damaged
 * one kept aside), and that a value never comes back in an error, a log line or the roster.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../src/shared/protocol.js';
import { checkKeys, createClearance, keyNameProblem } from '../src/server/clearance.js';

const SECRET = 'sk-test-0123456789abcdef';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-clearance-'));
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const lines: string[] = [];
const log: Logger = {
  debug: (m, ...e) => void lines.push([m, ...e].join(' ')),
  info: (m, ...e) => void lines.push([m, ...e].join(' ')),
  warn: (m, ...e) => void lines.push([m, ...e].join(' ')),
  error: (m, ...e) => void lines.push([m, ...e].join(' ')),
  child: () => log,
};

describe('checkKeys', () => {
  it('reads names to values, stamps them and keeps the names that were there', () => {
    const checked = checkKeys({ OPENAI_API_KEY: SECRET }, { GEMINI_API_KEY: 5 }, 100, false);
    expect(checked).toEqual({ ok: true, patch: { OPENAI_API_KEY: SECRET }, names: { GEMINI_API_KEY: 5, OPENAI_API_KEY: 100 } });
  });

  it('an edit removes a key with null; a hire has nothing to remove', () => {
    expect(checkKeys({ GEMINI_API_KEY: null }, { GEMINI_API_KEY: 5 }, 100, false)).toEqual({ ok: true, patch: { GEMINI_API_KEY: null }, names: {} });
    expect(checkKeys({ GEMINI_API_KEY: null }, undefined, 100, true)).toMatchObject({ ok: false });
  });

  it.each([
    ['a lower case name', { openai_api_key: SECRET }],
    ['a name that starts with a digit', { '1KEY': SECRET }],
    ['a name with a dash', { 'A-B': SECRET }],
    ['__proto__ as an own key', JSON.parse('{"__proto__":"v"}')],
    ['PATH', { PATH: SECRET }],
    ['NODE_OPTIONS', { NODE_OPTIONS: '--require=x' }],
    ['LD_PRELOAD', { LD_PRELOAD: '/tmp/x.so' }],
    ['DYLD_INSERT_LIBRARIES', { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' }],
    ['a name of gonogo', { GONOGO_TOKEN: SECRET }],
    ['BASH_ENV, which makes every bash source a file', { BASH_ENV: '/tmp/x.sh' }],
    ['PYTHONSTARTUP', { PYTHONSTARTUP: '/tmp/x.py' }],
    ['GIT_SSH_COMMAND', { GIT_SSH_COMMAND: 'sh -c x' }],
    ['GIT_CONFIG_COUNT, which injects git settings', { GIT_CONFIG_COUNT: '1' }],
    ['DOCKER_HOST, which would move a Clean Room to another daemon', { DOCKER_HOST: 'tcp://203.0.113.1:2375' }],
    ['TERM', { TERM: 'dumb' }],
    ['CLAUDE_CONFIG_DIR', { CLAUDE_CONFIG_DIR: '/tmp/x' }],
    ['an empty value', { OPENAI_API_KEY: '' }],
    ['a value with a space', { OPENAI_API_KEY: 'a b' }],
    ['a value with a line break', { OPENAI_API_KEY: 'a\nb' }],
    ['a value with a NUL', { OPENAI_API_KEY: 'a\u0000b' }],
    ['a value that is not text', { OPENAI_API_KEY: 5 }],
    ['a value of 4097 characters', { OPENAI_API_KEY: 'x'.repeat(4097) }],
  ])('refuses %s', (_what, input) => {
    expect(checkKeys(input, undefined, 1, true)).toMatchObject({ ok: false });
  });

  it('accepts 4096 characters and at most 16 keys in all', () => {
    expect(checkKeys({ A: 'x'.repeat(4096) }, undefined, 1, true)).toMatchObject({ ok: true });
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`K${i}`, 'v']));
    expect(checkKeys(many, undefined, 1, true)).toEqual({ ok: false, error: 'at most 16 keys' });
    const held = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`K${i}`, 1]));
    expect(checkKeys({ NEW_KEY: 'v' }, held, 1, false)).toEqual({ ok: false, error: 'at most 16 keys' });
    // a key that is replaced does not count twice
    expect(checkKeys({ K1: 'v' }, held, 1, false)).toMatchObject({ ok: true });
  });

  it('is not an object: refused', () => {
    for (const input of [null, 'x', 5, ['A'], undefined]) expect(checkKeys(input, undefined, 1, true)).toMatchObject({ ok: false });
  });

  it('never repeats a value or a badly spelled name in what it says', () => {
    const badName = checkKeys({ [SECRET]: 'v' }, undefined, 1, true);
    const badValue = checkKeys({ OPENAI_API_KEY: `${SECRET} with a space` }, undefined, 1, true);
    for (const result of [badName, badValue]) expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(keyNameProblem('openai')).not.toContain('openai');
  });
});

describe('the key store', () => {
  it('keeps values in keys.json with mode 0600, version 1, and gives them back for one agent only', async () => {
    const store = createClearance({ dir, log });
    await store.load();
    await store.apply('ana', { OPENAI_API_KEY: SECRET });
    await store.apply('ben', { GEMINI_API_KEY: 'g-1' });
    expect(store.values('ana')).toEqual({ OPENAI_API_KEY: SECRET });
    expect(store.values('ben')).toEqual({ GEMINI_API_KEY: 'g-1' });
    expect(store.values('cat')).toEqual({});
    const file = join(dir, 'keys.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, agents: { ana: { OPENAI_API_KEY: SECRET }, ben: { GEMINI_API_KEY: 'g-1' } } });
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('merges an edit, removes with null, drops an agent left with none, and starts again from none for a hire', async () => {
    const store = createClearance({ dir, log });
    await store.apply('ana', { A_KEY: '1', B_KEY: '2' });
    await store.apply('ana', { A_KEY: '3', B_KEY: null });
    expect(store.values('ana')).toEqual({ A_KEY: '3' });
    await store.apply('ana', { C_KEY: '4' }, true);
    expect(store.values('ana')).toEqual({ C_KEY: '4' });
    await store.apply('ana', { C_KEY: null });
    expect(JSON.parse(await readFile(join(dir, 'keys.json'), 'utf8')).agents).toEqual({});
  });

  it('hands out a copy: changing it does not change the store', async () => {
    const store = createClearance({ dir, log });
    await store.apply('ana', { A_KEY: '1' });
    store.values('ana').A_KEY = 'changed';
    expect(store.values('ana')).toEqual({ A_KEY: '1' });
  });

  it('moves the keys of a renamed agent and drops those of a removed one', async () => {
    const store = createClearance({ dir, log });
    await store.apply('ana', { A_KEY: '1' });
    await store.rename('ana', 'bea');
    expect(store.values('ana')).toEqual({});
    expect(store.values('bea')).toEqual({ A_KEY: '1' });
    await store.remove('bea');
    expect(store.values('bea')).toEqual({});
    expect(JSON.parse(await readFile(join(dir, 'keys.json'), 'utf8')).agents).toEqual({});
  });

  it('writes nothing when nothing changes', async () => {
    const store = createClearance({ dir, log });
    await store.apply('ana', {}, true);
    await store.remove('ana');
    await store.rename('ana', 'bea');
    expect(await readdir(dir)).toEqual([]);
  });

  it('survives a restart: the next process reads the same values', async () => {
    const first = createClearance({ dir, log });
    await first.apply('ana', { A_KEY: SECRET });
    const second = createClearance({ dir, log });
    await second.load();
    expect(second.values('ana')).toEqual({ A_KEY: SECRET });
  });

  it('keeps a damaged file aside, starts without keys and does not log what the file held', async () => {
    lines.length = 0;
    await writeFile(join(dir, 'keys.json'), `{"version":1,"agents":{"ana":{"A_KEY":"${SECRET}"`);
    const store = createClearance({ dir, log });
    await store.load();
    expect(store.values('ana')).toEqual({});
    expect((await readdir(dir)).sort()).toEqual(['keys.json.bad']);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).toContain('keys.json.bad');
  });

  it('skips a name or a value that is not valid in a file written by hand', async () => {
    await writeFile(join(dir, 'keys.json'), JSON.stringify({ version: 1, agents: { ana: { GOOD_KEY: 'v', 'bad name': 'v', PATH: 'x', EMPTY_KEY: '' }, bad: 'x' } }));
    const store = createClearance({ dir, log });
    await store.load();
    expect(store.values('ana')).toEqual({ GOOD_KEY: 'v' });
  });

  it('a write that fails leaves the old values, rejects, and does not repeat the value', async () => {
    const store = createClearance({ dir: join(dir, 'missing'), log });
    await expect(store.apply('ana', { A_KEY: SECRET })).rejects.toThrow(/could not save the keys/);
    await expect(store.apply('ana', { A_KEY: SECRET })).rejects.not.toThrow(new RegExp(SECRET));
    expect(store.values('ana')).toEqual({});
    // the next write works once the folder exists
    await mkdir(join(dir, 'missing'));
    await store.apply('ana', { A_KEY: SECRET });
    expect(store.values('ana')).toEqual({ A_KEY: SECRET });
  });

  it('writes one after the other: two quick changes both land', async () => {
    const store = createClearance({ dir, log });
    await Promise.all([store.apply('ana', { A_KEY: '1' }), store.apply('ana', { B_KEY: '2' }), store.rename('ana', 'bea')]);
    expect(store.values('bea')).toEqual({ A_KEY: '1', B_KEY: '2' });
    expect(JSON.parse(await readFile(join(dir, 'keys.json'), 'utf8')).agents).toEqual({ bea: { A_KEY: '1', B_KEY: '2' } });
  });
});
