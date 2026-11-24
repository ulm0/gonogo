import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMoney, parseTokens, tokenText } from '../src/shared/fuel.js';
import { createPropellant, lineUsage, parseLimits, parsePropellantRequest, reportedUsage } from '../src/server/propellant.js';
import type { Propellant } from '../src/server/propellant.js';
import { budgetLevel, fuelLevel, withBudget, withLimit } from '../src/client/wall.js';
import type { Logger } from '../src/shared/protocol.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-17T12:00:00Z');

/** One reply of claude as the transcript writes it: one line per content block, all with the same id and usage. */
function reply(id: string, usage: Record<string, number>, at = NOW, blocks = 2): string {
  const line = JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), requestId: `req_${id}`, message: { id, usage } });
  return Array.from({ length: blocks }, () => line).join('\n') + '\n';
}

let root: string;
let home: string;
let projects: string;
let transcript: string;
let clock: number;

const make = async (): Promise<Propellant> => {
  const p = createPropellant({ dir: home, projectsRoot: projects, now: () => clock, log: quiet });
  await p.load();
  return p;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gonogo-fuel-'));
  home = join(root, 'home');
  projects = join(root, 'claude', 'projects');
  await mkdir(home);
  await mkdir(join(projects, '-work-ana'), { recursive: true });
  transcript = join(projects, '-work-ana', 'session.jsonl');
  clock = NOW;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('lineUsage', () => {
  it('counts input, cache creation and output, not cache reads', () => {
    const line = JSON.stringify({ message: { id: 'msg_1', usage: { input_tokens: 2, cache_creation_input_tokens: 40, cache_read_input_tokens: 9000, output_tokens: 250 } }, timestamp: '2026-11-17T12:00:00Z' });
    expect(lineUsage(line)).toEqual({ id: 'msg_1', at: NOW, tokens: 292, model: null, split: { i: 2, cw: 40, o: 250, cr: 9000 } });
  });

  it('ignores lines without usage, broken JSON and negative or odd numbers', () => {
    expect(lineUsage('{"type":"user","message":{"content":"hi"}}')).toBeNull();
    expect(lineUsage('{not json')).toBeNull();
    expect(lineUsage(JSON.stringify({ message: { usage: { output_tokens: 5 } } }))).toBeNull();
    expect(lineUsage(JSON.stringify({ message: { id: 'm', usage: { output_tokens: -5, input_tokens: '7' } } }))).toEqual({ id: 'm', at: null, tokens: 0, model: null, split: { i: 0, cw: 0, o: 0, cr: 0 } });
  });
});

describe('Propellant', () => {
  it('counts the replies pi and opencode report as it counts a transcript, each id once, and drops what is not well formed', async () => {
    const p = await make();
    const usage = reportedUsage([
      { id: 'r1', at: NOW, model: 'claude-haiku-5-5', i: 100, cw: 20, o: 30, cr: 1000 },
      { id: 'r2', at: NOW, model: 'claude-haiku-5-5', i: 1, o: 2 },
      { id: '', i: 5 },
      'nope',
      { id: 'r3', i: -4, o: 'x' },
    ]);
    expect(usage.map((u) => u.id)).toStrictEqual(['r1', 'r2', 'r3']);
    expect(usage[2]?.split).toStrictEqual({ i: 0, cw: 0, o: 0, cr: 0 });
    // tokens are input + cache write + output; the cache reads come back too, for the budget check
    expect(await p.recordUsage('pip', usage)).toBe(150 + 1000 + 3);
    expect(await p.recordUsage('pip', usage)).toBe(0);
    expect(p.view().agents.pip?.used['5h']).toBe(153);
    await p.close();
    const again = await make();
    expect(again.view().agents.pip?.used['5h']).toBe(153);
  });

  it('counts each reply once, reads only what is new, and keeps the ledger across a restart', async () => {
    await writeFile(transcript, reply('msg_a', { input_tokens: 100, output_tokens: 50 }));
    const p = await make();
    expect(await p.record('ana', transcript)).toBe(150);
    expect(await p.record('ana', transcript)).toBe(0);
    await appendFile(transcript, reply('msg_b', { input_tokens: 10, output_tokens: 5 }, NOW, 3));
    expect(await p.record('ana', transcript)).toBe(15);
    expect(p.view().agents.ana?.used).toEqual({ '5h': 165, day: 165, week: 165, month: 165 });
    await p.close();
    // a new server: the cursor and the ledger come back, nothing is counted twice
    const again = await make();
    expect(again.view().room.used['5h']).toBe(165);
    expect(await again.record('ana', transcript)).toBe(0);
  });

  it('waits for a line to be complete', async () => {
    const half = reply('msg_a', { output_tokens: 40 }, NOW, 1);
    await writeFile(transcript, half.slice(0, 20));
    const p = await make();
    expect(await p.record('ana', transcript)).toBe(0);
    await appendFile(transcript, half.slice(20));
    expect(await p.record('ana', transcript)).toBe(40);
  });

  it('puts old replies in the window of their own time', async () => {
    await writeFile(transcript, reply('old', { output_tokens: 1000 }, NOW - 2 * 24 * HOUR) + reply('new', { output_tokens: 10 }));
    const p = await make();
    await p.record('ana', transcript);
    expect(p.view().room.used).toEqual({ '5h': 10, day: 10, week: 1010, month: 1010 });
  });

  it('refuses a transcript outside the projects folder, also through a symlink', async () => {
    const outside = join(root, 'secret.jsonl');
    await writeFile(outside, reply('x', { output_tokens: 99 }));
    await symlink(outside, join(projects, '-work-ana', 'link.jsonl'));
    const p = await make();
    expect(await p.record('ana', outside)).toBe(0);
    expect(await p.record('ana', join(projects, '-work-ana', 'link.jsonl'))).toBe(0);
    expect(await p.record('ana', join(projects, '-work-ana', 'missing.jsonl'))).toBe(0);
    expect(p.view().room.used['5h']).toBe(0);
  });

  it('checks the agent limit first, then the room limit', async () => {
    await writeFile(transcript, reply('a', { output_tokens: 1500 }));
    const p = await make();
    await p.record('ana', transcript);
    expect(p.over('ana')).toBeNull();
    await p.setLimits({ room: { week: 1000 } });
    expect(p.over('ana')).toEqual({ scope: 'room', reason: 'room out of propellant: 1.5k of 1k tokens in week' });
    expect(p.over('ben')?.scope).toBe('room');
    await p.setLimits({ agents: { ana: { '5h': 1200 } } });
    expect(p.over('ana')).toEqual({ scope: 'agent', reason: 'out of propellant: 1.5k of 1.2k tokens in 5h' });
    await p.setLimits({ room: {}, agents: { ana: {} } });
    expect(p.over('ana')).toBeNull();
    expect(p.view().agents.ana?.limits).toEqual({});
  });

  it('saves the limits and drops ledger lines older than 31 days', async () => {
    await writeFile(transcript, reply('a', { output_tokens: 7 }));
    const p = await make();
    await p.record('ana', transcript);
    await p.setLimits({ room: { month: 5_000_000 }, agents: { ben: { day: 10 } } });
    await p.close();
    clock = NOW + 32 * 24 * HOUR;
    const later = await make();
    const { cost, ...fuel } = later.view();
    expect(cost.days).toHaveLength(14);
    expect(fuel).toEqual({
      room: { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: { month: 5_000_000 } },
      agents: { ben: { used: { '5h': 0, day: 0, week: 0, month: 0 }, limits: { day: 10 } } },
    });
    await later.close();
    expect(await readFile(join(home, 'fuel.jsonl'), 'utf8')).toBe('');
  });

  it('writes the limits file with a version, and reads one from before it had a version', async () => {
    const p = await make();
    await p.setLimits({ room: { day: 9 } });
    await p.close();
    const saved = JSON.parse(await readFile(join(home, 'propellant.json'), 'utf8')) as Record<string, unknown>;
    expect(saved.version).toBe(1);
    delete saved.version;
    await writeFile(join(home, 'propellant.json'), JSON.stringify(saved));
    const again = await make();
    expect(again.view().room.limits).toEqual({ day: 9 });
  });
});

describe('limits from the wire', () => {
  it('takes whole numbers per known window and null to skip', () => {
    expect(parseLimits({ '5h': 10, day: null }, 'room')).toEqual({ '5h': 10 });
    expect(parseLimits({ hour: 1 }, 'room')).toBe('room: unknown window "hour"');
    expect(parseLimits({ day: 1.5 }, 'room')).toMatch(/whole number/);
    expect(parseLimits({ day: 0 }, 'room')).toMatch(/whole number/);
    expect(parseLimits([], 'room')).toMatch(/must be an object/);
  });

  it('checks the request', () => {
    expect(parsePropellantRequest({ room: { week: 5 }, agents: { ana: {} } })).toEqual({ ok: true, value: { room: { week: 5 }, agents: { ana: {} } } });
    expect(parsePropellantRequest({ rooms: {} })).toMatchObject({ ok: false, field: 'rooms' });
    expect(parsePropellantRequest({ agents: { 'Bad Name': {} } })).toMatchObject({ ok: false, field: 'agents' });
    expect(parsePropellantRequest({ agents: [] })).toMatchObject({ ok: false, field: 'agents' });
  });
});

describe('token amounts', () => {
  it('reads and writes them the way people do', () => {
    expect(tokenText(950)).toBe('950');
    expect(tokenText(12_500)).toBe('12.5k');
    expect(tokenText(1_200_000)).toBe('1.2M');
    expect(parseTokens('2M')).toBe(2_000_000);
    expect(parseTokens(' 500k ')).toBe(500_000);
    expect(parseTokens('1,500')).toBe(1500);
    expect(parseTokens('1.5m')).toBe(1_500_000);
    expect(parseTokens('0')).toBeNull();
    expect(parseTokens('-5')).toBeNull();
    expect(parseTokens('lots')).toBeNull();
  });

  it('tells the meter level and edits one window', () => {
    const gauge = { used: { '5h': 80, day: 100, week: 10, month: 10 }, limits: { '5h': 100, day: 100 } };
    expect(fuelLevel(gauge, '5h')).toBe('warn');
    expect(fuelLevel(gauge, 'day')).toBe('over');
    expect(fuelLevel(gauge, 'week')).toBe('none');
    expect(fuelLevel({ ...gauge, used: { ...gauge.used, '5h': 10 } }, '5h')).toBe('ok');
    expect(withLimit({ '5h': 1 }, 'day', 5)).toEqual({ '5h': 1, day: 5 });
    expect(withLimit({ '5h': 1, day: 5 }, 'day', null)).toEqual({ '5h': 1 });
  });
});

describe('dollars in the meter', () => {
  it('reads dollars the way people type them', () => {
    expect(parseMoney('12')).toBe(12);
    expect(parseMoney('$12.40')).toBe(12.4);
    expect(parseMoney(' 1.5k ')).toBe(1500);
    expect(parseMoney('0.005')).toBeNull();
    expect(parseMoney('0')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('2000k')).toBeNull();
    expect(parseMoney('ten')).toBeNull();
  });

  it('tells the budget level and edits one window', () => {
    const cost = { usd: { '5h': 8, day: 10, week: 1, month: 1 }, unpriced: { '5h': 0, day: 0, week: 0, month: 0 }, budget: { '5h': 10, day: 10 } };
    expect(budgetLevel(cost, '5h')).toBe('warn');
    expect(budgetLevel(cost, 'day')).toBe('over');
    expect(budgetLevel(cost, 'week')).toBe('none');
    expect(withBudget({ '5h': 1 }, 'day', 5)).toEqual({ '5h': 1, day: 5 });
    expect(withBudget({ '5h': 1, day: 5 }, 'day', null)).toEqual({ '5h': 1 });
  });
});
