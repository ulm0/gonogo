import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costOf, DEFAULT_PRICES, mergePrices, moneyText, priceFor } from '../src/shared/prices.js';
import { createPropellant, lineUsage, parseBudget, parsePropellantRequest } from '../src/server/propellant.js';
import type { Propellant } from '../src/server/propellant.js';
import { createPrices, parsePricesRequest } from '../src/server/prices.js';
import type { DownlinkEventKind, Logger } from '../src/shared/protocol.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-17T12:00:00Z');

/** One reply as the transcript writes it, with a model. */
function reply(id: string, model: string | null, usage: Record<string, number>, at = NOW): string {
  const message: Record<string, unknown> = { id, usage };
  if (model !== null) message.model = model;
  return JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), requestId: `req_${id}`, message }) + '\n';
}

let root: string;
let home: string;
let projects: string;
let transcript: string;
let clock: number;
let events: [DownlinkEventKind, string][];
/** Every ledger a test made: its appends are asynchronous, so they are finished before the folder is removed (rm races a write: ENOTEMPTY). */
let made: Propellant[] = [];
const keep = (p: Propellant): Propellant => (made.push(p), p);

const make = async (): Promise<Propellant> => {
  const p = keep(createPropellant({ dir: home, projectsRoot: projects, now: () => clock, log: quiet, notify: (k, t) => events.push([k, t]) }));
  await p.load();
  return p;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gonogo-cost-'));
  home = join(root, 'home');
  projects = join(root, 'claude', 'projects');
  await mkdir(home);
  await mkdir(join(projects, '-work-ana'), { recursive: true });
  transcript = join(projects, '-work-ana', 'session.jsonl');
  clock = NOW;
  events = [];
});

afterEach(async () => {
  await Promise.all(made.map((p) => p.close()));
  made = [];
  await rm(root, { recursive: true, force: true });
});

const PRICE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

describe('prices', () => {
  it('prices a built-in model by its id with a date, and calls anything else unpriced', () => {
    const rows = mergePrices();
    const pick = (m: string): unknown => priceFor(rows, m);
    expect(pick('claude-sonnet-5-5-20260101')).toMatchObject(DEFAULT_PRICES['claude-sonnet-5-5'] ?? {});
    expect(pick('claude-sonnet-5-5')).toMatchObject(DEFAULT_PRICES['claude-sonnet-5-5'] ?? {});
    expect(pick('claude-opus-5-5[1m]')).toMatchObject(DEFAULT_PRICES['claude-opus-5-5'] ?? {});
    expect(pick('claude-opus-4-1-20250805')).toMatchObject(DEFAULT_PRICES['claude-opus-4-1'] ?? {});
    expect(pick('claude-haiku-4-5-latest')).toMatchObject(DEFAULT_PRICES['claude-haiku-4-5'] ?? {});
    // a newer model that starts the same is not guessed
    expect(pick('claude-sonnet-5-6')).toBeNull();
    expect(pick('claude-sonnet-5-1')).toBeNull();
    expect(pick('claude-opus-5-5x')).toBeNull();
    expect(pick('gpt-9')).toBeNull();
    expect(priceFor(rows, undefined)).toBeNull();
    expect(priceFor(rows, '')).toBeNull();
  });

  it('matches your own rows as prefixes, the longest first', () => {
    const rows = mergePrices({ 'claude-sonnet-5': { ...PRICE, input: 7 }, 'claude-sonnet-5-6': { ...PRICE, input: 9 } });
    expect(priceFor(rows, 'claude-sonnet-5-6-x')?.input).toBe(9);
    expect(priceFor(rows, 'claude-sonnet-5-1')?.input).toBe(7);
  });

  it("lets the owner's rows win over the defaults and names each source", () => {
    const rows = mergePrices({ 'claude-sonnet-5-5': PRICE, 'my-model': PRICE });
    expect(rows['claude-sonnet-5-5']).toMatchObject({ ...PRICE, source: 'file' });
    expect(rows['my-model']?.source).toBe('file');
    expect(rows['claude-haiku-4-5']).toMatchObject({ source: 'default', asOf: expect.stringMatching(/^\d{4}-\d\d-\d\d$/) as string });
    expect(priceFor(rows, 'claude-sonnet-5-5-20260101')).toMatchObject(PRICE);
  });

  it('costs each of the four kinds and does not round', () => {
    expect(costOf({ i: 1_000_000, cw: 0, o: 0, cr: 0 }, PRICE)).toBe(3);
    expect(costOf({ i: 0, cw: 1_000_000, o: 0, cr: 0 }, PRICE)).toBe(3.75);
    expect(costOf({ i: 0, cw: 0, o: 1_000_000, cr: 0 }, PRICE)).toBe(15);
    expect(costOf({ i: 0, cw: 0, o: 0, cr: 1_000_000 }, PRICE)).toBeCloseTo(0.3);
    expect(costOf({ i: 1, cw: 0, o: 0, cr: 0 }, PRICE)).toBeCloseTo(0.000003, 10);
  });

  it('writes money the way people read it', () => {
    expect(moneyText(0.42)).toBe('$0.42');
    expect(moneyText(12.4)).toBe('$12.40');
    expect(moneyText(1234)).toBe('$1.2k');
  });
});

describe('the prices file', () => {
  it('saves your rows with mode 0600, merges them, and goes back to the default on remove', async () => {
    const prices = createPrices({ dir: home, log: quiet });
    await prices.load();
    expect(prices.table()['claude-haiku-4-5']?.source).toBe('default');
    await prices.replace({ 'claude-haiku-4-5': PRICE });
    expect(prices.table()['claude-haiku-4-5']).toMatchObject({ ...PRICE, source: 'file' });
    const path = join(home, 'prices.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, currency: 'USD', models: { 'claude-haiku-4-5': PRICE } });
    const again = createPrices({ dir: home, log: quiet });
    await again.load();
    expect(again.table()['claude-haiku-4-5']?.source).toBe('file');
    expect(await again.remove('claude-haiku-4-5')).toBe(true);
    expect(await again.remove('claude-haiku-4-5')).toBe(false);
    expect(again.table()['claude-haiku-4-5']?.source).toBe('default');
  });

  it('refuses unknown fields, negative or huge numbers and odd prefixes', () => {
    const ok = { models: { 'a.b-c_1': PRICE } };
    expect(parsePricesRequest(ok)).toMatchObject({ ok: true });
    expect(parsePricesRequest({ ...ok, extra: 1 })).toMatchObject({ ok: false, field: 'extra' });
    expect(parsePricesRequest({ models: { a: { ...PRICE, input: -1 } } })).toMatchObject({ ok: false, field: 'models' });
    expect(parsePricesRequest({ models: { a: { ...PRICE, input: 10_001 } } })).toMatchObject({ ok: false });
    expect(parsePricesRequest({ models: { a: { ...PRICE, input: Number.NaN } } })).toMatchObject({ ok: false });
    expect(parsePricesRequest({ models: { a: { ...PRICE, bonus: 1 } } })).toMatchObject({ ok: false });
    expect(parsePricesRequest({ models: { a: { input: 1 } } })).toMatchObject({ ok: false });
    expect(parsePricesRequest({ models: { 'a b': PRICE } })).toMatchObject({ ok: false });
    expect(parsePricesRequest({ models: { '../x': PRICE } })).toMatchObject({ ok: false });
    expect(parsePricesRequest({ models: { ['a'.repeat(81)]: PRICE } })).toMatchObject({ ok: false });
    expect(parsePricesRequest({ models: {}, currency: 'dollars' })).toMatchObject({ ok: false, field: 'currency' });
    expect(parsePricesRequest({})).toMatchObject({ ok: false, field: 'models' });
  });

  it('starts with the defaults when the file is broken', async () => {
    await writeFile(join(home, 'prices.json'), '{ nope');
    const prices = createPrices({ dir: home, log: quiet });
    await prices.load();
    expect(Object.values(prices.table()).every((r) => r.source === 'default')).toBe(true);
  });
});

describe('lineUsage', () => {
  it('returns the model and the four-way split', () => {
    const line = JSON.stringify({ message: { id: 'm', model: 'claude-sonnet-5-5-20260101', usage: { input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4 } } });
    expect(lineUsage(line)).toMatchObject({ model: 'claude-sonnet-5-5-20260101', tokens: 6, split: { i: 1, cw: 2, o: 3, cr: 4 } });
  });
});

describe('cost in the view', () => {
  it('prices two models with cache reads, keeps cache reads out of the tokens, and sums the unpriced apart', async () => {
    await writeFile(
      transcript,
      reply('a', 'claude-sonnet-5-5-20260101', { input_tokens: 1_000_000, cache_creation_input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 2_000_000 }) +
        reply('b', 'claude-haiku-4-5-20251001', { output_tokens: 1_000_000 }) +
        reply('c', 'some-other-model', { output_tokens: 12_000 }),
    );
    const p = await make();
    expect(await p.record('ana', transcript)).toBe(4_012_000); // tokens plus the 2M cache reads
    const v = p.view();
    // sonnet 5.5: 1M input at $2 + 2M cache reads at $0.10 = $2.20; haiku 4.5: 1M output at $5
    expect(v.cost.room.usd.day).toBeCloseTo(7.2, 6);
    expect(v.cost.room.unpriced.day).toBe(12_000);
    expect(v.cost.agents.ana?.usd['5h']).toBeCloseTo(7.2, 6);
    expect(v.room.used.day).toBe(2_012_000);
    expect(v.cost.pricedSince).toBe(NOW);
    expect(v.cost.days).toHaveLength(14);
    expect(v.cost.days.at(-1)?.usd).toBeCloseTo(7.2, 6);
    expect(v.cost.days.at(-1)?.byAgent.ana).toBeCloseTo(7.2, 6);
  });

  it('re-prices the whole history when the table changes', async () => {
    await writeFile(transcript, reply('a', 'claude-haiku-4-5', { output_tokens: 1_000_000 }));
    let table = mergePrices();
    const p = keep(createPropellant({ dir: home, projectsRoot: projects, now: () => clock, log: quiet, prices: () => table }));
    await p.load();
    await p.record('ana', transcript);
    expect(p.view().cost.room.usd.day).toBeCloseTo(5, 6);
    table = mergePrices({ 'claude-haiku-4-5': { ...PRICE, output: 10 } });
    expect(p.view().cost.room.usd.day).toBeCloseTo(10, 6);
    table = mergePrices({ 'claude-haiku-4-5': { ...PRICE, output: 0 } });
    expect(p.view().cost.room.usd.day).toBe(0);
  });

  it('writes the new ledger line and reads old and new lines together after a restart', async () => {
    const old = JSON.stringify({ at: NOW - HOUR, agent: 'ana', tokens: 500 });
    await writeFile(join(home, 'fuel.jsonl'), old + '\n');
    await writeFile(transcript, reply('a', 'claude-haiku-4-5', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 99 }));
    const p = await make();
    await p.record('ana', transcript);
    await p.close();
    const lines = (await readFile(join(home, 'fuel.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '')).toEqual({ at: NOW, agent: 'ana', model: 'claude-haiku-4-5', i: 10, cw: 0, o: 20, cr: 99, tokens: 30 });
    const again = await make();
    const v = again.view();
    expect(v.room.used.day).toBe(530);
    expect(v.cost.room.unpriced.day).toBe(500); // the old line is unpriced, not zero cost
    expect(v.cost.room.usd.day).toBeGreaterThan(0);
    expect(v.cost.pricedSince).toBe(NOW);
  });

  it('merges one minute of one model into one line and keeps models apart', async () => {
    await writeFile(
      transcript,
      reply('a', 'claude-haiku-4-5', { output_tokens: 1 }) + reply('b', 'claude-sonnet-5-5', { output_tokens: 2 }) + reply('c', 'claude-haiku-4-5', { output_tokens: 3 }),
    );
    const p = await make();
    await p.record('ana', transcript);
    await p.close();
    const lines = (await readFile(join(home, 'fuel.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { model: string; o: number });
    expect(lines.map((l) => [l.model, l.o])).toEqual([
      ['claude-haiku-4-5', 4],
      ['claude-sonnet-5-5', 2],
    ]);
  });

  it('counts a reply that only read the cache for cost but not for tokens', async () => {
    await writeFile(transcript, reply('a', 'claude-haiku-4-5', { cache_read_input_tokens: 1_000_000 }));
    const p = await make();
    // not 0: the caller checks the budget whenever a read added anything, cache reads included
    expect(await p.record('ana', transcript)).toBe(1_000_000);
    expect(p.view().room.used.day).toBe(0);
    expect(p.view().cost.room.usd.day).toBeCloseTo(0.1, 6);
  });

  it('trips a budget on a reply that only read the cache', async () => {
    const p = await make();
    await p.setBudget({ agents: { ana: { day: 0.05 } } });
    await appendFile(transcript, reply('a', 'claude-haiku-4-5', { cache_read_input_tokens: 1_000_000 }));
    expect(await p.record('ana', transcript)).toBeGreaterThan(0);
    expect(p.over('ana')?.reason).toBe('out of propellant: ana spent $0.10 of $0.05 in 24 h');
  });

  it('re-runs the 80 % warning and the over check when a price changes', async () => {
    let table = mergePrices();
    const p = keep(createPropellant({ dir: home, projectsRoot: projects, now: () => clock, log: quiet, prices: () => table, notify: (k, t) => events.push([k, t]) }));
    await p.load();
    await appendFile(transcript, reply('a', 'claude-haiku-4-5', { output_tokens: 1_000_000 })); // $5
    await p.record('ana', transcript);
    await p.setBudget({ agents: { ana: { day: 10 } } });
    expect(events).toEqual([]);
    expect(p.over('ana')).toBeNull();
    table = mergePrices({ 'claude-haiku-4-5': { ...PRICE, output: 9 } }); // $9 = 90 %
    p.recheck();
    expect(events).toEqual([['redline', 'ana is at 90 % of its day budget']]);
    table = mergePrices({ 'claude-haiku-4-5': { ...PRICE, output: 11 } });
    expect(p.over('ana')?.reason).toBe('out of propellant: ana spent $11.00 of $10.00 in 24 h');
    p.recheck();
    expect(events).toHaveLength(1);
  });
});

describe('budget', () => {
  // haiku 4.5 output costs $5 per million: 1M output tokens are $5
  const spend = async (p: Propellant, id: string, tokens: number): Promise<void> => {
    await appendFile(transcript, reply(id, 'claude-haiku-4-5', { output_tokens: tokens }, clock));
    await p.record('ana', transcript);
  };

  it('checks the agent budget then the room budget, with the reason in dollars', async () => {
    const p = await make();
    await spend(p, 'a', 2_480_000); // $12.40
    expect(p.over('ana')).toBeNull();
    await p.setBudget({ agents: { ana: { day: 10 } } });
    expect(p.over('ana')).toEqual({ scope: 'agent', reason: 'out of propellant: ana spent $12.40 of $10.00 in 24 h' });
    await p.setBudget({ agents: { ana: {} }, room: { week: 12 } });
    expect(p.over('ana')).toEqual({ scope: 'room', reason: 'room out of propellant: the room spent $12.40 of $12.00 in 7 d' });
    expect(p.over('ben')?.scope).toBe('room');
    await p.setBudget({ room: {} });
    expect(p.over('ana')).toBeNull();
  });

  it('puts the agent budget before the room budget', async () => {
    const p = await make();
    await spend(p, 'a', 2_000_000); // $10
    await p.setBudget({ room: { day: 5 }, agents: { ana: { day: 5 } } });
    expect(p.over('ana')?.scope).toBe('agent');
  });

  it('allows one more turn after a Resume: the budget is checked at the next reading, as a token limit is', async () => {
    const p = await make();
    await p.setBudget({ agents: { ana: { day: 1 } } });
    await spend(p, 'a', 100_000); // $0.50
    expect(p.over('ana')).toBeNull();
    await spend(p, 'b', 200_000); // $1.50
    expect(p.over('ana')).not.toBeNull();
  });

  it('posts one event at 80 % per agent and window, not 79 %, not twice, and again after it dropped below', async () => {
    const p = await make();
    await p.setBudget({ agents: { ana: { day: 10 } } });
    await spend(p, 'a', 1_580_000); // $7.90 = 79 %
    expect(events).toEqual([]);
    await spend(p, 'b', 20_000); // $8.00 = 80 %
    expect(events).toEqual([['redline', 'ana is at 80 % of its day budget']]);
    await spend(p, 'c', 100_000); // $8.50
    expect(events).toHaveLength(1);
    // the window rolls on: the spend is more than a day old, below 80 % again, which re-arms the event
    clock = NOW + 25 * HOUR;
    p.view();
    await spend(p, 'd', 1_700_000); // $8.50 in the new window
    expect(events).toHaveLength(2);
  });

  it('warns for the room and for a window of its own, and not again after a restart', async () => {
    const p = await make();
    await p.setBudget({ room: { '5h': 4, week: 100 } });
    await spend(p, 'a', 700_000); // $3.50 = 87 % of the 5 h budget
    expect(events).toEqual([['redline', 'the room is at 87 % of its 5-hour budget']]);
    await p.close();
    const again = await make();
    await spend(again, 'b', 10_000);
    expect(events).toHaveLength(1);
  });

  it('warns at once when a new budget is already past 80 %', async () => {
    const p = await make();
    await spend(p, 'a', 1_000_000); // $5
    await p.setBudget({ agents: { ana: { day: 6 } } });
    expect(events).toEqual([['redline', 'ana is at 83 % of its day budget']]);
  });

  it('refuses a bad budget and names the field', () => {
    expect(parseBudget({ day: 10, week: null }, 'room')).toEqual({ day: 10 });
    expect(parseBudget({ day: 0.005 }, 'room')).toMatch(/room\.day/);
    expect(parseBudget({ day: 1.234 }, 'room')).toMatch(/whole cents/);
    expect(parseBudget({ day: 1_000_001 }, 'room')).toMatch(/room\.day/);
    expect(parseBudget({ day: '5' }, 'room')).toMatch(/room\.day/);
    expect(parseBudget({ hour: 5 }, 'room')).toMatch(/unknown window/);
    expect(parseBudget({ day: 19.99 }, 'room')).toEqual({ day: 19.99 });
    expect(parsePropellantRequest({ budget: { room: { day: -1 } } })).toMatchObject({ ok: false, field: 'budget' });
    expect(parsePropellantRequest({ budget: { agents: { 'bad name': { day: 1 } } } })).toMatchObject({ ok: false, field: 'budget' });
    expect(parsePropellantRequest({ budget: { extra: 1 } })).toMatchObject({ ok: false, field: 'budget' });
    expect(parsePropellantRequest({ budget: { room: { day: 5 }, agents: { ana: { week: 9 } } } })).toEqual({ ok: true, value: { budget: { room: { day: 5 }, agents: { ana: { week: 9 } } } } });
  });

  it('keeps the budget in propellant.json across a restart', async () => {
    const p = await make();
    await p.setBudget({ room: { month: 50 }, agents: { ben: { day: 3 } } });
    await p.close();
    const saved = JSON.parse(await readFile(join(home, 'propellant.json'), 'utf8')) as { version: number; budget: unknown };
    expect(saved.version).toBe(1);
    expect(saved.budget).toEqual({ room: { month: 50 }, agents: { ben: { day: 3 } }, missions: {} });
    const again = await make();
    expect(again.view().cost.room.budget).toEqual({ month: 50 });
    expect(again.view().cost.agents.ben?.budget).toEqual({ day: 3 });
  });

  it('starts a renamed agent from zero (the known limit: the ledger is keyed by name)', async () => {
    const p = await make();
    await p.setBudget({ agents: { ana: { day: 1 }, ana2: { day: 1 } } });
    await spend(p, 'a', 1_000_000);
    expect(p.over('ana')).not.toBeNull();
    expect(p.over('ana2')).toBeNull();
  });
});
