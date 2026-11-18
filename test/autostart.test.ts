import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_STATE_MAX_AGE_MS } from '../src/server/constants.js';
import { createRunState } from '../src/server/runstate.js';
import { createStartupStore } from '../src/server/startup.js';
import { editRequest, hireRequest } from '../src/client/form.js';
import type { Values } from '../src/client/form.js';

let dir: string;
let now: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-'));
  now = 1_800_000_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const file = (): Promise<{ version: number; at: number; running: Array<{ name: string; working: boolean }> }> => readFile(join(dir, 'run-state.json'), 'utf8').then((text) => JSON.parse(text));

describe('run state', () => {
  it('has no previous set without a file, and writes nothing before anybody says something', async () => {
    const state = createRunState({ dir, now: () => now });
    await state.load();
    expect(state.previous()).toBeNull();
    await state.close();
    expect(await stat(join(dir, 'run-state.json')).catch(() => null)).toBeNull();
  });

  it('writes the set in a private file as agents start, work, and stop, and reads it back', async () => {
    const state = createRunState({ dir, now: () => now });
    await state.load();
    state.mark('flight', true, false);
    state.mark('ana', true, true);
    state.mark('ana', true, true);
    state.mark('ben', true, false);
    state.mark('ben', false, false);
    state.mark('ghost', false, false);
    await state.close();
    expect((await stat(join(dir, 'run-state.json'))).mode & 0o777).toBe(0o600);
    expect(await file()).toEqual({ version: 1, at: now, running: [{ name: 'flight', working: false }, { name: 'ana', working: true }] });
    const next = createRunState({ dir, now: () => now + 1000 });
    await next.load();
    expect(next.previous()).toEqual([{ name: 'flight', working: false }, { name: 'ana', working: true }]);
  });

  it('keeps what the last run left until the hub says otherwise, so a crash during the boot loses nothing', async () => {
    await writeFile(join(dir, 'run-state.json'), JSON.stringify({ version: 1, at: now, running: [{ name: 'ana', working: false }, { name: 'ben', working: true }] }));
    const state = createRunState({ dir, now: () => now });
    await state.load();
    state.mark('ana', false, false);
    await state.close();
    expect((await file()).running).toEqual([{ name: 'ben', working: true }]);
    // the previous set is the one of the load, whatever was marked since
    expect(state.previous()).toHaveLength(2);
  });

  it('ignores a file older than a week, from the future, damaged or of another version', async () => {
    for (const text of [
      JSON.stringify({ version: 1, at: now - RUN_STATE_MAX_AGE_MS - 1, running: [{ name: 'ana', working: false }] }),
      JSON.stringify({ version: 1, at: now + 3_600_000, running: [{ name: 'ana', working: false }] }),
      JSON.stringify({ version: 2, at: now, running: [] }),
      '{ nope',
    ]) {
      await writeFile(join(dir, 'run-state.json'), text);
      const state = createRunState({ dir, now: () => now });
      await state.load();
      expect(state.previous(), text).toBeNull();
    }
    await writeFile(join(dir, 'run-state.json'), JSON.stringify({ version: 1, at: now - RUN_STATE_MAX_AGE_MS, running: [{ name: 'ana', working: false }, { nope: 1 }] }));
    const edge = createRunState({ dir, now: () => now });
    await edge.load();
    expect(edge.previous()).toEqual([{ name: 'ana', working: false }]);
  });

  it('a stale write time does not matter once the file is written again', async () => {
    const state = createRunState({ dir, now: () => now });
    await state.load();
    state.mark('ana', true, false);
    await state.close();
    await utimes(join(dir, 'run-state.json'), 1, 1);
    expect((await file()).at).toBe(now);
  });
});

describe('the startup policy', () => {
  it('is the boss only with the carry-on message at first, and is saved when changed', async () => {
    const store = createStartupStore({ dir });
    await store.load();
    expect(store.view()).toEqual({ policy: 'boss', carryOn: true, bossMayStart: true });
    expect(await store.set({ policy: 'running' })).toEqual({ policy: 'running', carryOn: true, bossMayStart: true });
    expect(await store.set({ carryOn: false })).toEqual({ policy: 'running', carryOn: false, bossMayStart: true });
    expect((await stat(join(dir, 'startup.json'))).mode & 0o777).toBe(0o600);
    const again = createStartupStore({ dir });
    await again.load();
    expect(again.view()).toEqual({ policy: 'running', carryOn: false, bossMayStart: true });
    await store.close();
  });

  it('keeps the switch of start_agent, on at first, and refuses a value that is not a boolean', async () => {
    const store = createStartupStore({ dir });
    await store.load();
    expect(store.view().bossMayStart).toBe(true);
    expect((await store.set({ bossMayStart: false })).bossMayStart).toBe(false);
    const again = createStartupStore({ dir });
    await again.load();
    expect(again.view()).toEqual({ policy: 'boss', carryOn: true, bossMayStart: false });
    await expect(store.set({ bossMayStart: 'no' })).rejects.toMatchObject({ field: 'bossMayStart' });
    await store.close();
  });

  it('refuses a policy it does not know, a field it does not know and a carryOn that is not a boolean', async () => {
    const store = createStartupStore({ dir });
    await store.load();
    await expect(store.set({ policy: 'all' })).rejects.toMatchObject({ code: 'bad_request', field: 'policy' });
    await expect(store.set({ policy: 'off', extra: 1 })).rejects.toMatchObject({ field: 'extra' });
    await expect(store.set({ carryOn: 'yes' })).rejects.toMatchObject({ field: 'carryOn' });
    await expect(store.set([])).rejects.toMatchObject({ code: 'bad_request' });
    expect(store.view()).toEqual({ policy: 'boss', carryOn: true, bossMayStart: true });
  });

  it('leaves a file it cannot read where it is, and moves aside only one with wrong content', async () => {
    await mkdir(join(dir, 'startup.json'));
    const store = createStartupStore({ dir });
    await store.load();
    expect(store.view().policy).toBe('boss');
    expect((await stat(join(dir, 'startup.json'))).isDirectory()).toBe(true);
    expect(await stat(join(dir, 'startup.json.bad')).catch(() => null)).toBeNull();
  });

  it('falls back to the boss only when the file is damaged, and keeps it aside', async () => {
    await writeFile(join(dir, 'startup.json'), JSON.stringify({ version: 1, policy: 'everybody' }));
    const store = createStartupStore({ dir });
    await store.load();
    expect(store.view()).toEqual({ policy: 'boss', carryOn: true, bossMayStart: true });
    expect((await stat(join(dir, 'startup.json.bad'))).isFile()).toBe(true);
  });
});

describe('the Start with gonogo box of the form', () => {
  const EMPTY = { provider: 'claude', position: '', name: 'ana', role: 'does things', dir: '/work', mode: 'default', confirm: false, command: '', servers: '', skills: '', cleanRoom: false, worktree: false, remoteControl: false, autostart: true, coauthor: true, rules: '', model: '', keys: [], keysRemoved: [] } as unknown as Values;
  it('says nothing when ticked, and false when not; an edit sends it only when it changes', () => {
    expect(hireRequest(EMPTY)).not.toHaveProperty('autostart');
    expect(hireRequest({ ...EMPTY, autostart: false })).toMatchObject({ autostart: false });
    expect(hireRequest(EMPTY)).not.toHaveProperty('coauthor');
    expect(hireRequest({ ...EMPTY, coauthor: false })).toMatchObject({ coauthor: false });
    const view = { name: 'ana', role: 'does things', dir: '/work', mode: 'default', provider: 'claude', autostart: true, keys: {} } as never;
    expect(editRequest({ ...EMPTY, autostart: false }, view, false)).toEqual({ autostart: false });
    expect(editRequest(EMPTY, view, false)).toBeNull();
  });
});
