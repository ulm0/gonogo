// GET /api/cost (docs/features/cost.md): the ledger priced, room and agents and days, with input, output and cache apart.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPropellant } from '../src/server/propellant.js';
import type { Propellant } from '../src/server/propellant.js';
import { costSplit, mergePrices, PRICES_AS_OF } from '../src/shared/prices.js';
import type { Logger } from '../src/shared/protocol.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;
const DAY = 24 * 3_600_000;
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const PRICE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

let root: string;
let home: string;
let clock: number;

const line = (at: number, agent: string, model: string | undefined, i: number, cw: number, o: number, cr: number): string => JSON.stringify({ at, agent, ...(model === undefined ? {} : { model }), i, cw, o, cr, tokens: i + cw + o }) + '\n';
async function make(lines: string[]): Promise<Propellant> {
  await writeFile(join(home, 'fuel.jsonl'), lines.join(''));
  const p = createPropellant({ dir: home, projectsRoot: join(root, 'p'), now: () => clock, log: quiet, prices: () => mergePrices({ 'claude-test': PRICE }) });
  await p.load();
  return p;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gonogo-cost-report-'));
  home = join(root, 'home');
  await mkdir(home);
  clock = NOW;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('costSplit', () => {
  it('keeps the dollars apart by kind of token, and they add up to costOf', () => {
    const split = costSplit({ i: 1_000_000, cw: 2_000_000, o: 1_000_000, cr: 10_000_000 }, PRICE);
    expect(split).toEqual({ input: 3, output: 15, cacheWrite: 7.5, cacheRead: 3 });
  });
});

describe('the cost report', () => {
  it('says it is an estimate, names the days it covers and when the default prices were copied', async () => {
    const p = await make([]);
    const r = p.report(14);
    expect(r).toMatchObject({ estimate: true, currency: 'USD', priceAsOf: PRICES_AS_OF, pricedSince: null });
    expect(r.days).toHaveLength(14);
    expect(r.to).toBe('2026-11-17');
    expect(r.from).toBe('2026-11-04');
    expect(r.room.usd).toBe(0);
  });

  it('the room, each agent and each day, with input, output and cache apart', async () => {
    const p = await make([
      line(NOW - 1000, 'ana', 'claude-test', 1_000_000, 0, 1_000_000, 0), // 3 + 15
      line(NOW - 2000, 'ana', 'claude-test', 0, 1_000_000, 0, 10_000_000), // 3.75 + 3
      line(NOW - DAY, 'ben', 'claude-test', 0, 0, 2_000_000, 0), // 30, yesterday
    ]);
    const r = p.report(14);
    expect(r.room.usdSplit.input).toBeCloseTo(3, 6);
    expect(r.room.usdSplit.output).toBeCloseTo(45, 6);
    expect(r.room.usdSplit.cacheWrite).toBeCloseTo(3.75, 6);
    expect(r.room.usdSplit.cacheRead).toBeCloseTo(3, 6);
    expect(r.room.usd).toBeCloseTo(54.75, 6);
    expect(r.room.tokens).toEqual({ input: 1_000_000, output: 3_000_000, cacheWrite: 1_000_000, cacheRead: 10_000_000 });
    expect(Object.keys(r.agents)).toEqual(['ana', 'ben']);
    expect(r.agents.ana?.usd).toBeCloseTo(24.75, 6);
    expect(r.agents.ben?.usdSplit.output).toBeCloseTo(30, 6);
    const [today, yesterday] = [r.days.at(-1), r.days.at(-2)];
    expect(today?.date).toBe('2026-11-17');
    expect(today?.usd).toBeCloseTo(24.75, 6);
    expect(today?.byAgent).toEqual({ ana: expect.closeTo(24.75, 6) });
    expect(yesterday?.byAgent).toEqual({ ben: expect.closeTo(30, 6) });
    // the parts add up to the whole
    for (const scope of [r.room, ...Object.values(r.agents), ...r.days]) expect(scope.usdSplit.input + scope.usdSplit.output + scope.usdSplit.cacheWrite + scope.usdSplit.cacheRead).toBeCloseTo(scope.usd, 9);
  });

  it('an unpriced line (an old one, or a model with no price) adds to unpriced tokens and to no dollars', async () => {
    const p = await make([line(NOW - 1000, 'ana', undefined, 100, 0, 50, 0), line(NOW - 1000, 'ana', 'claude-unknown-9', 10, 0, 5, 0), line(NOW - 1000, 'ana', 'claude-test', 1_000_000, 0, 0, 0)]);
    const r = p.report(1);
    expect(r.room.unpriced).toBe(165);
    expect(r.room.usd).toBeCloseTo(3, 6);
    expect(r.agents.ana?.unpriced).toBe(165);
    expect(r.pricedSince).toBe(NOW - 1000);
  });

  it('only the days asked for, and a line older than that is left out', async () => {
    const p = await make([line(NOW - 1000, 'ana', 'claude-test', 1_000_000, 0, 0, 0), line(NOW - 3 * DAY, 'ana', 'claude-test', 1_000_000, 0, 0, 0)]);
    expect(p.report(1).room.usd).toBeCloseTo(3, 6);
    expect(p.report(2).room.usd).toBeCloseTo(3, 6);
    expect(p.report(4).room.usd).toBeCloseTo(6, 6);
    // a count outside 1 to 31 is brought inside, never an error or an empty answer
    expect(p.report(0).days).toHaveLength(1);
    expect(p.report(500).days).toHaveLength(31);
    expect(p.report(Number.NaN).days).toHaveLength(1);
  });

  it('follows the prices: a change of the table re-prices the whole report', async () => {
    let table = mergePrices({ 'claude-test': PRICE });
    await writeFile(join(home, 'fuel.jsonl'), line(NOW - 1000, 'ana', 'claude-test', 1_000_000, 0, 0, 0));
    const p = createPropellant({ dir: home, projectsRoot: join(root, 'p'), now: () => clock, log: quiet, prices: () => table });
    await p.load();
    expect(p.report(1).room.usd).toBeCloseTo(3, 6);
    table = mergePrices({ 'claude-test': { ...PRICE, input: 6 } });
    expect(p.report(1).room.usd).toBeCloseTo(6, 6);
  });
});
