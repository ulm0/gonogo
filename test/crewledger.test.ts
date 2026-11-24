import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREW_LEDGER_FILE, createCrewLedger } from '../src/server/crewledger.js';

let dir: string;
let now: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-ledger-'));
  now = Date.UTC(2026, 10, 24, 12, 0);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const make = () => createCrewLedger({ dir, now: () => now });

describe('the crew ledger', () => {
  it('counts the hires of the last hour and the names of the last 24 hours, and forgets older ones', async () => {
    const l = make();
    await l.load();
    await l.hired('a');
    now += 30 * 60_000;
    await l.hired('b');
    expect(l.hiresLastHour()).toBe(2);
    now += 40 * 60_000;
    expect(l.hiresLastHour()).toBe(1);
    expect(l.recentNames().sort()).toEqual(['a', 'b']);
    now += 24 * 3_600_000;
    expect(l.recentNames()).toEqual([]);
    expect(l.hiresLastHour()).toBe(0);
  });

  it('survives a restart (the file is 0600) and starts empty from a bad file', async () => {
    const l = make();
    await l.load();
    await l.hired('a');
    const again = make();
    await again.load();
    expect(again.recentNames()).toEqual(['a']);
    expect(JSON.parse(await readFile(join(dir, CREW_LEDGER_FILE), 'utf8')).hires).toHaveLength(1);
    await writeFile(join(dir, CREW_LEDGER_FILE), '{ no');
    const bad = make();
    await bad.load();
    expect(bad.recentNames()).toEqual([]);
  });
});
