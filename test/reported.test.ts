// What the engine reports itself (src/server/reported.ts): per (agent, session) totals, deltas worked out on read, a restart that counts nothing twice.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPropellant } from '../src/server/propellant.js';
import { createReported, MAX_SESSIONS, MAX_SESSIONS_PER_AGENT, parseReport, REPORTED_FILE } from '../src/server/reported.js';
import type { Reported } from '../src/server/reported.js';
import { mergePrices } from '../src/shared/prices.js';
import type { Logger } from '../src/shared/protocol.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;
const DAY = 24 * 3_600_000;
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const dayOf = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let dir: string;
let clock: number;
const opened: Reported[] = [];
/** A file that was made long ago, so that no session counts as "already running" (that rule has its own test). */
const oldFile = async (): Promise<void> => {
  await writeFile(join(dir, REPORTED_FILE), `${JSON.stringify({ created: NOW - 2 * DAY })}\n`);
};
const make = async (): Promise<Reported> => {
  if (!(await readFile(join(dir, REPORTED_FILE)).then(() => true, () => false))) await oldFile();
  const r = createReported({ dir, now: () => clock, log: quiet });
  opened.push(r);
  await r.load();
  return r;
};
const file = async (): Promise<string[]> => (await readFile(join(dir, REPORTED_FILE), 'utf8').catch(() => '')).split('\n').filter((l) => l.includes('"session"'));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-reported-'));
  clock = NOW;
});
afterEach(async () => {
  for (const r of opened.splice(0)) await r.close();
  await rm(dir, { recursive: true, force: true });
});

describe('parseReport', () => {
  it('takes a session and a total, and nothing else of a status-line body', () => {
    expect(parseReport({ session: 'abc-1', total: 1.5, rate_limits: {}, cwd: '/x' })).toEqual({ session: 'abc-1', total: 1.5 });
    expect(parseReport({ session: 'abc-1', total: 1.5, at: 1_700_000_000_000.4 })).toEqual({ session: 'abc-1', total: 1.5, at: 1_700_000_000_000 });
    for (const at of ['x', -1, 0, Number.NaN]) expect(parseReport({ session: 'abc-1', total: 1, at }), String(at)).toEqual({ session: 'abc-1', total: 1 });
    for (const bad of [null, 'x', [], {}, { session: 'abc' }, { total: 1 }, { session: 'a b', total: 1 }, { session: '', total: 1 }, { session: 'abc', total: -1 }, { session: 'abc', total: Number.NaN }, { session: 'abc', total: '2' }, { session: 'abc', total: 2_000_000 }, { session: 'x'.repeat(81), total: 1 }, { session: '../x', total: 1 }]) expect(parseReport(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('recording and reading', () => {
  it('writes a line only when a session\'s total changed, and the dollars are worked out on read', async () => {
    const r = await make();
    r.record('ana', { session: 's1', total: 1 });
    r.record('ana', { session: 's1', total: 1 });
    clock += 1000;
    r.record('ana', { session: 's1', total: 1.75 });
    r.record('ana', { session: 's1', total: 1.75 });
    await r.close();
    expect(await file()).toHaveLength(2);
    expect(r.window(NOW - DAY, dayOf).agents.ana).toEqual({ usd: 1.75, sessions: 1 });
  });

  it('keys by session: two sessions add up, an agent is credited what it posted, and a session that changes name does not count its total again', async () => {
    const r = await make();
    r.record('ana', { session: 's1', total: 2 });
    r.record('ana', { session: 's2', total: 3 });
    r.record('ben', { session: 's3', total: 4 });
    // the same session under a new name (a rename): only what it spent since counts, credited to the new name
    clock += 1000;
    r.record('cy', { session: 's1', total: 2.5 });
    const w = r.window(NOW - DAY, dayOf).agents;
    expect(w.ana).toEqual({ usd: 5, sessions: 2 });
    expect(w.ben).toEqual({ usd: 4, sessions: 1 });
    expect(w.cy?.usd).toBeCloseTo(0.5, 9);
    const total = Object.values(w).reduce((s, x) => s + x.usd, 0);
    expect(total).toBeCloseTo(9.5, 9);
  });

  it('a total below the last one is a reset: the new total is the delta, never negative', async () => {
    const r = await make();
    r.record('ana', { session: 's1', total: 5 });
    clock += 1000;
    r.record('ana', { session: 's1', total: 1 });
    clock += 1000;
    r.record('ana', { session: 's1', total: 3 });
    expect(r.window(NOW - DAY, dayOf).agents.ana?.usd).toBeCloseTo(5 + 1 + 2, 9);
  });

  it('two reports swapped on the way: the older one (by the shim\'s own time) is dropped, and its lower total is no reset; a lower total with a newer time is one', async () => {
    const r = await make();
    r.record('ana', { session: 's1', total: 5, at: NOW });
    // the report of NOW - 2 s, with a lower total, arrives after: it was overtaken
    clock += 500;
    r.record('ana', { session: 's1', total: 4, at: NOW - 2000 });
    clock += 500;
    r.record('ana', { session: 's1', total: 5.5, at: NOW + 1000 });
    expect(r.window(NOW - DAY, dayOf).agents.ana?.usd).toBeCloseTo(5.5, 9);
    // a real reset: lower, and posted later
    clock += 5000;
    r.record('ana', { session: 's1', total: 1, at: NOW + 5000 });
    expect(r.window(NOW - DAY, dayOf).agents.ana?.usd).toBeCloseTo(6.5, 9);
    await r.close();
    expect(await file()).toHaveLength(3);
  });

  it('a time that is missing, from the future or very old is taken as arriving now', async () => {
    const r = await make();
    r.record('ana', { session: 's1', total: 1, at: NOW + 3_600_000 });
    clock += 1000;
    // were the future time believed, this later report would look older than it and be dropped
    r.record('ana', { session: 's1', total: 2, at: NOW + 1000 });
    r.record('ana', { session: 's2', total: 1, at: 1 });
    expect(r.window(NOW - DAY, dayOf).agents.ana).toEqual({ usd: 3, sessions: 2 });
  });

  it('a restart of gonogo counts nothing twice and takes up where the totals were', async () => {
    const first = await make();
    first.record('ana', { session: 's1', total: 2 });
    clock += 1000;
    first.record('ana', { session: 's1', total: 3 });
    await first.close();
    const again = await make();
    // the same total after the restart is not a change
    again.record('ana', { session: 's1', total: 3 });
    clock += 1000;
    again.record('ana', { session: 's1', total: 3.5 });
    await again.close();
    expect(again.window(NOW - DAY, dayOf).agents.ana?.usd).toBeCloseTo(3.5, 9);
    expect(await file()).toHaveLength(3);
  });

  it('a day is the local day the line arrived on', async () => {
    const r = await make();
    r.record('ana', { session: 's1', total: 1 });
    clock += DAY;
    r.record('ana', { session: 's1', total: 4 });
    const { byDay } = r.window(NOW - 2 * DAY, dayOf);
    expect(byDay[dayOf(NOW)]).toEqual({ ana: 1 });
    expect(byDay[dayOf(NOW + DAY)]).toEqual({ ana: 3 });
  });

  it('what came before the window is a baseline, not spend inside it', async () => {
    const r = await make();
    r.record('ana', { session: 's1', total: 10 });
    clock += 2 * DAY;
    r.record('ana', { session: 's1', total: 10.5 });
    expect(r.window(NOW + DAY, dayOf).agents.ana?.usd).toBeCloseTo(0.5, 9);
  });

  it('a damaged line is skipped, and a baseline older than the ledger keeps stays for its session', async () => {
    const old = NOW - 40 * DAY;
    await writeFile(join(dir, REPORTED_FILE), [JSON.stringify({ at: old, agent: 'ana', session: 's1', total: 8 }), '{torn', JSON.stringify({ at: NOW - DAY, agent: 'ana', session: 's1', total: 9 }), JSON.stringify({ at: old, agent: 'ben', session: 's9', total: 1 })].join('\n') + '\n');
    const r = await make();
    // ana's day line is a delta of 1 over the old baseline of 8; ben's old line is the baseline, outside the window
    expect(r.window(NOW - 2 * DAY, dayOf).agents).toEqual({ ana: { usd: 1, sessions: 1 } });
    // the torn line is skipped on read, not repaired
    const kept = (await file()).flatMap((l) => {
      try {
        return [JSON.parse(l) as { total: number }];
      } catch {
        return [];
      }
    });
    // ben's only line is older than the window and its session has nothing since: it goes whole; ana's baseline stays
    expect(kept.map((l) => l.total).sort((a, b) => a - b)).toEqual([8, 9]);
  });
});

describe('a session that was already running (the upgrade day)', () => {
  it('the first line of a session seen within ten minutes of the file being made counts 0; what it spends after counts; one seen later counts its own total', async () => {
    const fresh = createReported({ dir, now: () => clock, log: quiet });
    opened.push(fresh);
    await fresh.load();
    fresh.record('ana', { session: 'old', total: 40 });
    clock += 60_000;
    fresh.record('ana', { session: 'old', total: 41 });
    clock += 8 * 60_000;
    fresh.record('ana', { session: 'also-old', total: 7 });
    // eleven minutes after the file was made: a session that really began since, with its first total
    clock += 2 * 60_000;
    fresh.record('ana', { session: 'new', total: 0.25 });
    expect(fresh.window(NOW - DAY, dayOf).agents.ana).toEqual({ usd: 1.25, sessions: 3 });
    await fresh.close();
    const text = await readFile(join(dir, REPORTED_FILE), 'utf8');
    expect(JSON.parse(text.split('\n')[0] ?? '{}')).toEqual({ created: NOW });
    // after a restart the rule still holds, and a file with no first line (an older one) marks nothing
    const again = createReported({ dir, now: () => clock, log: quiet });
    opened.push(again);
    await again.load();
    expect(again.window(NOW - DAY, dayOf).agents.ana).toEqual({ usd: 1.25, sessions: 3 });
    await rm(join(dir, REPORTED_FILE));
    await writeFile(join(dir, REPORTED_FILE), JSON.stringify({ at: NOW, agent: 'ana', session: 'x', total: 3 }) + '\n');
    const legacy = createReported({ dir, now: () => clock, log: quiet });
    opened.push(legacy);
    await legacy.load();
    legacy.record('ana', { session: 'y', total: 2 });
    expect(legacy.window(NOW - DAY, dayOf).agents.ana?.usd).toBe(5);
  });
});

describe('growth', () => {
  it('RSO: an agent posting endless fresh session ids is capped, the log says so once, and it cannot crowd out another agent', async () => {
    const warnings: string[] = [];
    const loud = { ...quiet, warn: (...a: unknown[]) => void warnings.push(String(a[0])) } as unknown as Logger;
    const r = createReported({ dir, now: () => clock, log: loud });
    opened.push(r);
    await oldFile();
    await r.load();
    for (let i = 0; i < MAX_SESSIONS_PER_AGENT + 300; i += 1) r.record('noisy', { session: `s${i}`, total: 1 });
    expect(r.size()).toBe(MAX_SESSIONS_PER_AGENT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/sessions are kept for noisy/);
    r.record('quiet', { session: 'mine', total: 2 });
    expect(r.size()).toBe(MAX_SESSIONS_PER_AGENT + 1);
    expect(r.window(NOW - DAY, dayOf).agents.quiet?.usd).toBe(2);
    // the sessions it had keep reporting
    r.record('noisy', { session: 's0', total: 3 });
    expect(r.window(NOW - DAY, dayOf).agents.noisy?.usd).toBe(MAX_SESSIONS_PER_AGENT + 2);
    // and the whole is capped too
    for (let a = 0; a < Math.ceil(MAX_SESSIONS / MAX_SESSIONS_PER_AGENT) + 1; a += 1) for (let i = 0; i < MAX_SESSIONS_PER_AGENT; i += 1) r.record(`agent${a}`, { session: `a${a}-${i}`, total: 1 });
    expect(r.size()).toBe(MAX_SESSIONS);
    // the whole cap is told once too, and each telling is made once however many more are refused
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/sessions are kept in all/);
    r.record('another', { session: 'nope', total: 1 });
    r.record('noisy', { session: 'nope2', total: 1 });
    expect(warnings).toHaveLength(2);
    await r.close();
  }, 180_000); // ~10 s alone: 25,000 records, each counting the agent's sessions; 40 to 60 s on a loaded machine

  it('RSO: the memory and the file are pruned while it runs, not only at load: an old session goes, an active one keeps its baseline', async () => {
    const r = await make();
    r.record('ana', { session: 'gone', total: 1 });
    r.record('ana', { session: 'active', total: 10 });
    clock += 40 * DAY;
    r.record('ana', { session: 'active', total: 12 });
    // enough lines to reach the pruning count
    for (let i = 0; i < 205; i += 1) r.record('ben', { session: `b${i}`, total: 1 });
    expect(r.size()).toBe(206);
    await r.close();
    const lines = await file();
    expect(lines.some((l) => l.includes('"gone"'))).toBe(false);
    expect(lines.filter((l) => l.includes('"active"'))).toHaveLength(2);
    // what is in the window is what it was
    expect(r.window(clock - 2 * DAY, dayOf).agents.ana?.usd).toBe(2);
  });
});

describe('beside the estimate', () => {
  it('GET /api/cost carries it as `reported`, never added to the estimate, with the basis of each agent and "n of m agents"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gonogo-reported-cost-'));
    try {
      const home = join(root, 'home');
      await mkdir(home);
      const line = (agent: string): string => JSON.stringify({ at: NOW - 1000, agent, model: 'claude-test', i: 1_000_000, cw: 0, o: 0, cr: 0, tokens: 1_000_000 }) + '\n';
      await writeFile(join(home, 'fuel.jsonl'), line('ana') + line('ben') + line('cy'));
      const reported = await make();
      reported.record('ana', { session: 's1', total: 7 });
      reported.record('dee', { session: 's2', total: 1 }); // an agent with a report and no ledger line
      const p = createPropellant({ dir: home, projectsRoot: join(root, 'p'), now: () => clock, log: quiet, prices: () => mergePrices({ 'claude-test': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } }), reported });
      await p.load();
      const r = p.report(1);
      // the estimate is the ledger's alone: 3 agents x $3
      expect(r.room.usd).toBeCloseTo(9, 6);
      expect(r.room.reported).toBeCloseTo(8, 9);
      expect(r.room.reportedAgents).toEqual({ have: 2, of: 4 });
      expect(r.agents.ana).toMatchObject({ basis: 'reported', reported: 7, sessions: 1 });
      expect(r.agents.ana?.usd).toBeCloseTo(3, 6);
      expect(r.agents.ben).toMatchObject({ basis: 'estimated', reported: null, sessions: 0 });
      expect(r.agents.dee).toMatchObject({ basis: 'reported', reported: 1, usd: 0 });
      expect(r.sessions).toBe(2);
      expect(r.days.at(-1)?.reported).toBeCloseTo(8, 9);
      expect(r.dayBoundary).toBe('local');
      expect(r.partial).toBe(false);
      expect(r.unpricedModels).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('without a reported source the figures are estimates only, and the models with no price are named', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gonogo-reported-cost-'));
    try {
      const home = join(root, 'home');
      await mkdir(home);
      await writeFile(join(home, 'fuel.jsonl'), JSON.stringify({ at: NOW - 1000, agent: 'ana', model: 'claude-mystery-9', i: 5, cw: 0, o: 5, cr: 0, tokens: 10 }) + '\n');
      const p = createPropellant({ dir: home, projectsRoot: join(root, 'p'), now: () => clock, log: quiet, prices: () => mergePrices() });
      await p.load();
      const r = p.report(1);
      expect(r.room.reported).toBeNull();
      expect(r.room.reportedAgents).toEqual({ have: 0, of: 1 });
      expect(r.agents.ana).toMatchObject({ basis: 'estimated', reported: null });
      expect(r.unpricedModels).toEqual(['claude-mystery-9']);
      expect(r.room.unpriced).toBe(10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
