/**
 * Cost per mission and task, and a budget per mission through Redline (docs/cost-spec.md, section "Missions and tasks").
 * The ledger line keeps the mission and task the agent had on `doing` when its reply was counted.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPropellant, parsePropellantRequest } from '../src/server/propellant.js';
import type { Propellant } from '../src/server/propellant.js';
import { budgetShare, spendText } from '../src/client/missionsModel.js';
import type { DownlinkEventKind, Logger } from '../src/shared/protocol.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet } as unknown as Logger;
const NOW = Date.parse('2026-11-17T12:00:00Z');

const reply = (id: string, tokens: number, model: string | null = 'claude-haiku-4-5'): string =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(NOW).toISOString(), requestId: `req_${id}`, message: { id, ...(model === null ? {} : { model }), usage: { output_tokens: tokens } } }) + '\n';

let root: string;
let home: string;
let transcript: string;
let events: [DownlinkEventKind, string][];
/** What the Flight Plan says each agent is doing now. */
let on: Record<string, { mission?: string; task?: string }>;
/** The task each docking link is bound to here. */
let linkTasks: Record<string, string>;

const make = async (): Promise<Propellant> => {
  const projects = join(root, 'claude', 'projects');
  const p = createPropellant({ dir: home, projectsRoot: projects, now: () => NOW, log: quiet, notify: (k, t) => events.push([k, t]), attribute: (agent) => on[agent] ?? {}, linkTask: (id) => linkTasks[id] });
  await p.load();
  return p;
};
// haiku 4.5 output is $5 per million: 1M tokens are $5
const spend = async (p: Propellant, id: string, tokens: number, agent = 'ana'): Promise<void> => {
  await appendFile(transcript, reply(id, tokens));
  await p.record(agent, transcript);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gonogo-mcost-'));
  home = join(root, 'home');
  await mkdir(home);
  await mkdir(join(root, 'claude', 'projects', '-work-ana'), { recursive: true });
  transcript = join(root, 'claude', 'projects', '-work-ana', 'session.jsonl');
  events = [];
  on = {};
  linkTasks = {};
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a docking link budget (the cap a peer offers)', () => {
  const LINK = 'dl_0123456789abcdef';

  it('holds only the one linked task: the agent on it is over, the others and the room are not, and it is never an agent or room scope', async () => {
    const p = await make();
    linkTasks = { [LINK]: 't4' };
    await p.setBudget({ links: { [LINK]: 0.5 } });
    on = { ana: { task: 't4' }, ben: { task: 't5' } };
    await spend(p, 'a', 40_000, 'ana'); // $0.20
    expect(p.over('ana')).toBeNull();
    await spend(p, 'b', 100_000, 'ana'); // $0.50 in all with the first
    await spend(p, 'c', 400_000, 'ben'); // $2 on another task
    expect(p.over('ana')).toMatchObject({ scope: 'link', link: LINK, task: 't4' });
    expect(p.over('ana')?.reason).toMatch(/task t4 reached the cap its link allows: spent \$0\.70 of \$0\.50/);
    expect(p.over('ben')).toBeNull();
    expect(p.over('cat')).toBeNull();
  });

  it('a $0.01 budget is valid, is saved and read back, raised or cleared locally (null) and then holds nothing; the view says what the task spent against it', async () => {
    const p = await make();
    linkTasks = { [LINK]: 't4' };
    on = { ana: { task: 't4' } };
    await p.setBudget({ links: { [LINK]: 0.01 } });
    await spend(p, 'a', 40_000);
    expect(p.over('ana')).toMatchObject({ scope: 'link' });
    expect(p.view().cost.links).toEqual({ [LINK]: { usd: 0.2, unpriced: 0, budget: 0.01 } });
    const again = await make();
    expect(again.view().cost.links?.[LINK]?.budget).toBe(0.01);
    await p.setBudget({ links: { [LINK]: 5 } });
    expect(p.over('ana')).toBeNull();
    await p.setBudget({ links: { [LINK]: null } });
    expect(p.view().cost.links).toEqual({});
  });

  it('is read from a request in whole cents with a link id, or null; anything else is refused', () => {
    expect(parsePropellantRequest({ budget: { links: { [LINK]: 0.5, dl_fedcba9876543210: null } } })).toEqual({ ok: true, value: { budget: { links: { [LINK]: 0.5, dl_fedcba9876543210: null } } } });
    for (const links of [{ nope: 1 }, { [LINK]: 'x' }, { [LINK]: 0 }, { [LINK]: 1.005 }, 3]) expect(parsePropellantRequest({ budget: { links } }), JSON.stringify(links)).toMatchObject({ ok: false, field: 'budget' });
  });
});

describe('attribution', () => {
  it('writes the mission and task of the agent into the ledger line, and prices them per mission and per task', async () => {
    const p = await make();
    on = { ana: { mission: 'ms1', task: 't4' } };
    await spend(p, 'a', 1_000_000); // $5
    on = { ana: { mission: 'ms1', task: 't5' } };
    await spend(p, 'b', 400_000); // $2
    on = {};
    await spend(p, 'c', 200_000); // $1, no mission
    const cost = p.view().cost;
    expect(cost.missions).toEqual({ ms1: { usd: 7, unpriced: 0 } });
    expect(cost.tasks).toEqual({ t4: { usd: 5, unpriced: 0 }, t5: { usd: 2, unpriced: 0 } });
    expect(cost.room.usd.day).toBe(8);
    const lines = (await readFile(join(home, 'fuel.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.mission, l.task])).toEqual([['ms1', 't4'], ['ms1', 't5'], [undefined, undefined]]);
  });

  it('keeps it across a restart, and ignores an id that is not one', async () => {
    const p = await make();
    on = { ana: { mission: 'ms2', task: 't1' } };
    await spend(p, 'a', 1_000_000);
    await p.close();
    await appendFile(join(home, 'fuel.jsonl'), JSON.stringify({ at: NOW, agent: 'ana', tokens: 5, model: 'claude-haiku-4-5', i: 0, cw: 0, o: 5, cr: 0, mission: '../x', task: 'zz' }) + '\n');
    const again = await make();
    expect(again.view().cost.missions).toEqual({ ms2: { usd: 5, unpriced: 0 } });
    expect(again.view().cost.tasks).toEqual({ t1: { usd: 5, unpriced: 0 } });
  });

  it('counts an unpriced model in tokens, not dollars', async () => {
    const p = await make();
    on = { ana: { mission: 'ms1' } };
    await appendFile(transcript, reply('a', 1000, 'us.anthropic.claude-sonnet-4-6'));
    await p.record('ana', transcript);
    expect(p.view().cost.missions?.ms1).toEqual({ usd: 0, unpriced: 1000 });
  });
});

describe('a budget per mission', () => {
  it('warns once at 80 %, trips the agent working on it at 100 %, and names the mission in the reason', async () => {
    const p = await make();
    on = { ana: { mission: 'ms1', task: 't4' } };
    await p.setBudget({ missions: { ms1: 10 } });
    await spend(p, 'a', 1_400_000); // $7
    expect(events).toEqual([]);
    await spend(p, 'b', 200_000); // $8 = 80 %
    expect(events).toEqual([['redline', 'mission ms1 is at 80 % of its budget']]);
    await spend(p, 'c', 100_000); // $8.50: no second warning
    expect(events).toHaveLength(1);
    expect(p.over('ana')).toBeNull();
    await spend(p, 'd', 300_000); // $10.00
    expect(p.over('ana')).toEqual({ scope: 'mission', mission: 'ms1', reason: 'out of propellant: mission ms1 spent $10.00 of $10.00' });
    expect(p.view().cost.missions?.ms1).toEqual({ usd: 10, unpriced: 0, budget: 10 });
  });

  it('does not stop an agent that is on another mission or on none, and stops every agent on the mission', async () => {
    const p = await make();
    on = { ana: { mission: 'ms1' }, ben: { mission: 'ms1' }, cy: { mission: 'ms2' }, di: {} };
    await p.setBudget({ missions: { ms1: 1 } });
    await spend(p, 'a', 400_000); // $2
    expect(p.over('ana')?.scope).toBe('mission');
    expect(p.over('ben')?.scope).toBe('mission');
    expect(p.over('cy')).toBeNull();
    expect(p.over('di')).toBeNull();
    on = { ana: {} };
    expect(p.over('ana')).toBeNull(); // its task is not on doing any more
  });

  it('puts the agent budget before the mission budget and the mission before the room', async () => {
    const p = await make();
    on = { ana: { mission: 'ms1' } };
    await spend(p, 'a', 1_000_000); // $5
    await p.setBudget({ missions: { ms1: 2 }, room: { week: 3 } });
    expect(p.over('ana')?.scope).toBe('mission');
    await p.setBudget({ agents: { ana: { day: 1 } } });
    expect(p.over('ana')?.scope).toBe('agent');
  });

  it('raising, clearing or re-arming: a new budget is checked at once, null clears, and the warning comes again below 80 %', async () => {
    const p = await make();
    on = { ana: { mission: 'ms1' } };
    await spend(p, 'a', 1_000_000); // $5
    await p.setBudget({ missions: { ms1: 6 } }); // 83 %
    expect(events).toEqual([['redline', 'mission ms1 is at 83 % of its budget']]);
    await p.setBudget({ missions: { ms1: 100 } });
    await p.setBudget({ missions: { ms1: 6 } });
    expect(events).toHaveLength(2);
    await p.setBudget({ missions: { ms1: null } });
    expect(p.over('ana')).toBeNull();
    expect(p.view().cost.missions?.ms1).toEqual({ usd: 5, unpriced: 0 });
  });

  it('survives a restart and is not warned again', async () => {
    const p = await make();
    on = { ana: { mission: 'ms1' } };
    await spend(p, 'a', 1_000_000);
    await p.setBudget({ missions: { ms1: 6 } });
    expect(events).toHaveLength(1);
    await p.close();
    const again = await make();
    expect(again.view().cost.missions?.ms1?.budget).toBe(6);
    expect(events).toHaveLength(1);
  });
});

describe('the request', () => {
  it('reads a mission budget in whole cents, or null, and refuses the rest', () => {
    expect(parsePropellantRequest({ budget: { missions: { ms3: 25, ms4: null, ms5: 12.5 } } })).toEqual({ ok: true, value: { budget: { missions: { ms3: 25, ms4: null, ms5: 12.5 } } } });
    for (const bad of [{ ms3: 0 }, { ms3: 0.001 }, { ms3: '5' }, { ms3: 2_000_000 }, { '../x': 5 }, { ms0: 5 }]) {
      expect(parsePropellantRequest({ budget: { missions: bad } }), JSON.stringify(bad)).toMatchObject({ ok: false, field: 'budget' });
    }
    expect(parsePropellantRequest({ budget: { missions: [] } })).toMatchObject({ ok: false });
  });
});

describe('the words of the Missions view', () => {
  it('says what was spent, of what budget, and what has no price', () => {
    expect(spendText(undefined)).toBe('');
    expect(spendText({ usd: 0, unpriced: 0 })).toBe('');
    expect(spendText({ usd: 1.2, unpriced: 0 })).toBe('$1.20');
    expect(spendText({ usd: 1.2, unpriced: 0, budget: 10 })).toBe('$1.20 of $10.00');
    expect(spendText({ usd: 0, unpriced: 12_000 })).toMatch(/12.*tokens unpriced/);
    expect(budgetShare({ usd: 8, unpriced: 0, budget: 10 })).toBe(0.8);
    expect(budgetShare({ usd: 8, unpriced: 0 })).toBeNull();
  });
});

describe('the boss-hired crew budget (docs/hire-fire-spec.md)', () => {
  it('holds the crew together once the crew has spent its dollars today, and no one else', async () => {
    let crew: { names: string[]; budgetUsd: number } | null = { names: ['ana', 'rt1'], budgetUsd: 10 };
    const projects = join(root, 'claude', 'projects');
    const p = createPropellant({ dir: home, projectsRoot: projects, now: () => NOW, log: quiet, crew: () => crew });
    await p.load();
    await spend(p, 'a', 1_400_000, 'ana'); // $7
    expect(p.over('ana')).toBeNull();
    await spend(p, 'b', 600_000, 'ana'); // $10
    expect(p.over('ana')).toEqual({ scope: 'crew', names: ['ana', 'rt1'], reason: 'crew budget reached: the boss-hired crew spent $10.00 of $10.00 today' });
    // a stopped crew member that never spent still shares the hold; an agent of the Director is never in it
    expect(p.over('rt1')?.scope).toBe('crew');
    expect(p.over('ben')).toBeNull();
    // no ceiling, no hold
    crew = null;
    expect(p.over('ana')).toBeNull();
  });
});
