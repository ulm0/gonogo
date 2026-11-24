import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFree, mergePrices, priceFor } from '../src/shared/prices.js';
import { createPropellant, reportedUsage } from '../src/server/propellant.js';
import type { Propellant } from '../src/server/propellant.js';
import type { Logger } from '../src/shared/protocol.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;
const NOW = Date.parse('2026-11-17T12:00:00Z');
let root: string;
let made: Propellant[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gonogo-fuel-engines-'));
  await mkdir(join(root, 'home'));
});
afterEach(async () => {
  await Promise.all(made.map((p) => p.close()));
  made = [];
  await rm(root, { recursive: true, force: true });
});

const engines: Record<string, string> = { ana: 'claude', pip: 'pi', ozzy: 'opencode' };
const make = async (prices?: ReturnType<typeof mergePrices>): Promise<Propellant> => {
  const p = createPropellant({ dir: join(root, 'home'), projectsRoot: join(root, 'projects'), now: () => NOW, log: quiet, engineOf: (a) => engines[a], plan: () => null, ...(prices === undefined ? {} : { prices: () => prices }) });
  made.push(p);
  await p.load();
  return p;
};
const use = (id: string, model: string, provider: string | null, i: number, o: number) => ({ id, at: NOW - 60_000, model, provider, split: { i, cw: 0, o, cr: 0 } });

describe('prices: free is not unpriced, and a provider can change the price', () => {
  it('big-pickle is a row of zeros; an unknown model stays unpriced', () => {
    const table = mergePrices();
    const free = priceFor(table, 'big-pickle');
    expect(free).not.toBeNull();
    expect(isFree(free!)).toBe(true);
    expect(priceFor(table, 'some-new-model')).toBeNull();
  });
  it('a `<provider>/<model>` row wins over the model row for that provider only', () => {
    const table = mergePrices({ 'bedrock/claude-opus-5-5': { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } });
    expect(priceFor(table, 'claude-opus-5-5', 'bedrock')?.input).toBe(1);
    expect(priceFor(table, 'claude-opus-5-5', 'anthropic')?.input).toBe(4);
    expect(priceFor(table, 'claude-opus-5-5')?.input).toBe(4);
  });
});

describe('the ledger carries the engine and the provider', () => {
  it('reportedUsage keeps a plain provider name and drops a bad one', () => {
    const got = reportedUsage([{ id: 'a', model: 'm', provider: 'opencode', i: 1 }, { id: 'b', model: 'm', provider: 'bad name!', i: 1 }, { id: 'c', model: 'm', i: 1 }]);
    expect(got.map((g) => g.provider)).toEqual(['opencode', null, null]);
  });

  it('new lines say engine and provider; same model through two engines are two rows, and the total is their sum', async () => {
    const p = await make();
    await p.recordUsage('pip', [use('1', 'claude-opus-5-5', 'anthropic', 1000, 100)]);
    await p.recordUsage('ana', [use('2', 'claude-opus-5-5', 'anthropic', 2000, 200)]);
    await p.recordUsage('ozzy', [use('3', 'big-pickle', 'opencode', 5000, 500)]);
    const rows = p.view().cost.breakdown?.day ?? [];
    const key = (r: { engine: string; provider: string; model: string }): string => `${r.engine}|${r.provider}|${r.model}`;
    expect(rows.map(key).sort()).toEqual(['claude|anthropic|claude-opus-5-5', 'opencode|opencode|big-pickle', 'pi|anthropic|claude-opus-5-5']);
    const free = rows.find((r) => r.model === 'big-pickle')!;
    expect(free).toMatchObject({ free: true, usd: 0, unpriced: 0, tokens: 5500, agents: { ozzy: { tokens: 5500, usd: 0, unpriced: 0 } } });
    expect(rows.find((r) => r.engine === 'claude')?.agents.ana?.tokens).toBe(2200);
    // the room total is the sum of the rows
    const total = rows.reduce((s, r) => s + r.usd, 0);
    expect(total).toBeCloseTo(p.view().cost.room.usd.day, 10);
    expect(rows.reduce((s, r) => s + r.tokens, 0)).toBe(p.view().room.used.day);
    const line = (await readFile(join(root, 'home', 'fuel.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(line.find((l) => l.agent === 'pip')).toMatchObject({ engine: 'pi', provider: 'anthropic' });
  });

  it('an old line without them shows as unknown, and an unpriced model is unpriced, not free', async () => {
    await mkdir(join(root, 'home'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'home', 'fuel.jsonl'), `${JSON.stringify({ at: NOW - 1000, agent: 'ana', model: 'claude-sonnet-5-5', i: 10, cw: 0, o: 5, cr: 0, tokens: 15 })}\n${JSON.stringify({ at: NOW - 1000, agent: 'ana', tokens: 40 })}\n${JSON.stringify({ at: NOW - 1000, agent: 'pip', model: 'mystery-1', i: 7, cw: 0, o: 0, cr: 0, tokens: 7, engine: 'pi', provider: 'acme' })}\n`);
    const p = await make();
    const rows = p.view().cost.breakdown?.day ?? [];
    expect(rows.find((r) => r.model === 'claude-sonnet-5-5')).toMatchObject({ engine: 'unknown', provider: 'unknown', free: false, tokens: 15 });
    expect(rows.find((r) => r.model === 'unknown')).toMatchObject({ unpriced: 40, free: false });
    expect(rows.find((r) => r.model === 'mystery-1')).toMatchObject({ engine: 'pi', provider: 'acme', unpriced: 7, free: false });
  });

  it('claudePlan is set for Claude Code only when the room has a plan quota', async () => {
    const withPlan = createPropellant({ dir: join(root, 'home'), projectsRoot: join(root, 'projects'), now: () => NOW, log: quiet, engineOf: (a) => engines[a], plan: () => ({ session: { used: 0.1, resetsAt: NOW } }) as never });
    made.push(withPlan);
    await withPlan.load();
    await withPlan.recordUsage('ana', [use('1', 'claude-sonnet-5-5', 'anthropic', 10, 1)]);
    await withPlan.recordUsage('pip', [use('2', 'claude-sonnet-5-5', 'anthropic', 10, 1)]);
    const rows = withPlan.view().cost.breakdown?.day ?? [];
    expect(rows.find((r) => r.engine === 'claude')?.claudePlan).toBe(true);
    expect(rows.find((r) => r.engine === 'pi')?.claudePlan).toBe(false);
  });

  it('the report for the days carries the same rows', async () => {
    const p = await make();
    await p.recordUsage('ozzy', [use('1', 'big-pickle', 'opencode', 100, 10)]);
    expect(p.report(7).breakdown?.map((r) => r.model)).toEqual(['big-pickle']);
  });
});

describe('budgets per engine and per provider', () => {
  const makeB = async (): Promise<Propellant> => {
    const p = createPropellant({ dir: join(root, 'home'), projectsRoot: join(root, 'projects'), now: () => NOW, log: quiet, engineOf: (a) => engines[a], plan: () => null });
    made.push(p);
    await p.load();
    return p;
  };
  it('parses engines and providers, refuses a bad name, and an empty budget clears one', async () => {
    const { parsePropellantRequest } = await import('../src/server/propellant.js');
    expect(parsePropellantRequest({ budget: { engines: { pi: { day: 5 } }, providers: { openai: { week: 20 } } } })).toMatchObject({ ok: true, value: { budget: { engines: { pi: { day: 5 } }, providers: { openai: { week: 20 } } } } });
    expect(parsePropellantRequest({ budget: { engines: { 'bad name': { day: 5 } } } })).toMatchObject({ ok: false, field: 'budget' });
    expect(parsePropellantRequest({ budget: { engines: { pi: { day: -1 } } } })).toMatchObject({ ok: false });
    const p = await makeB();
    await p.setBudget({ engines: { pi: { day: 5 } } });
    expect(Object.keys(p.view().cost.groups ?? {})).toEqual(['engine:pi']);
    await p.setBudget({ engines: { pi: {} } });
    expect(p.view().cost.groups).toEqual({});
  });

  it('an engine budget holds only that engine: its use counts, its agents stop, the others do not', async () => {
    const p = await makeB();
    await p.setBudget({ engines: { pi: { day: 0.01 } } });
    await p.recordUsage('pip', [use('1', 'claude-opus-5-5', 'anthropic', 1_000_000, 0)]);
    await p.recordUsage('ana', [use('2', 'claude-opus-5-5', 'anthropic', 1_000_000, 0)]);
    expect(p.over('pip')).toMatchObject({ scope: 'group', group: 'engine:pi' });
    expect(p.over('pip')?.reason).toContain('engine pi spent');
    expect(p.over('ana')).toBeNull();
    expect(p.inGroup('pip', 'engine:pi')).toBe(true);
    expect(p.inGroup('ana', 'engine:pi')).toBe(false);
    // only pi's own use counted: $4, not $8
    expect(p.view().cost.groups?.['engine:pi']?.usd.day).toBeCloseTo(4, 6);
  });

  it('a provider budget counts that provider\'s use and holds the agents whose latest reply used it; a free model costs nothing', async () => {
    const p = await makeB();
    await p.setBudget({ providers: { openai: { day: 1 }, opencode: { day: 0.01 } } });
    await p.recordUsage('ozzy', [use('1', 'big-pickle', 'opencode', 5_000_000, 0)]);
    expect(p.over('ozzy')).toBeNull();
    await p.recordUsage('pip', [{ ...use('2', 'gpt-x', 'openai', 1, 0), model: 'claude-opus-5-5', split: { i: 1_000_000, cw: 0, o: 0, cr: 0 } }]);
    expect(p.over('pip')).toMatchObject({ scope: 'group', group: 'provider:openai' });
    expect(p.inGroup('pip', 'provider:openai')).toBe(true);
    expect(p.inGroup('ozzy', 'provider:openai')).toBe(false);
  });

  it('is kept across a restart, and old lines without an engine belong to no group', async () => {
    const p = await makeB();
    await p.setBudget({ engines: { claude: { day: 1 } } });
    await p.close();
    const again = await makeB();
    expect(Object.keys(again.view().cost.groups ?? {})).toEqual(['engine:claude']);
  });
});
