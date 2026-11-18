import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURES, FEATURE_TOOLS, featureById, featureOfRoute, planFeatures, toolsOff } from '../src/shared/features.js';
import { createFeatureStore } from '../src/server/features.js';
import { commands, VIEW_FEATURE } from '../src/client/shell.js';
import { planText } from '../src/client/Features.js';
import { MCP_TOOL_NAMES } from '../src/shared/protocol.js';

describe('the table', () => {
  it('has unique ids, and every requires and enhances names a feature', () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FEATURES) for (const need of [...f.requires, ...f.enhances]) expect(featureById(need), `${f.id} -> ${need}`).toBeDefined();
  });

  it('has no cycle of requires', () => {
    const reaches = (from: string, seen: string[] = []): void => {
      expect(seen.includes(from), `${[...seen, from].join(' -> ')}`).toBe(false);
      for (const need of featureById(from)?.requires ?? []) reaches(need, [...seen, from]);
    };
    for (const f of FEATURES) reaches(f.id);
  });

  it('has no core feature that needs a switchable one, and no switchable one that the core needs', () => {
    for (const f of FEATURES.filter((x) => x.core !== undefined)) expect(f.requires).toEqual([]);
    for (const f of FEATURES) for (const need of f.requires) expect(featureById(need)?.core, `${f.id} needs ${need}`).toBeUndefined();
  });

  it('names real MCP tools, each in one feature, and never the core ones', () => {
    const owned = Object.values(FEATURE_TOOLS).flat();
    expect(new Set(owned).size).toBe(owned.length);
    for (const tool of owned) expect(MCP_TOOL_NAMES as readonly string[]).toContain(tool);
    for (const core of ['send_message', 'list_roster', 'read_messages']) expect(owned).not.toContain(core);
    for (const id of Object.keys(FEATURE_TOOLS)) expect(featureById(id)?.core).toBeUndefined();
    expect(toolsOff(['relief', 'flight-plan'])).toEqual(['hire_agent', 'task_list', 'task_create', 'task_update']);
  });

  it('maps the routes of the features that are wired, and no route of a core feature', () => {
    expect(featureOfRoute(['governor'])).toBe('maxq');
    expect(featureOfRoute(['poll', 'hold'])).toBe('tminus');
    expect(featureOfRoute(['log', 'chart'])).toBe('star-chart');
    expect(featureOfRoute(['log', 'l1'])).toBe('mission-log');
    expect(featureOfRoute(['agents', 'ana', 'git', 'log'])).toBe('recorder');
    expect(featureOfRoute(['agents', 'ana', 'review'])).toBe('review');
    expect(featureOfRoute(['agents', 'ana', 'files'])).toBe('hangar');
    expect(featureOfRoute(['agents', 'ana', 'telemetry'])).toBe('telemetry');
    expect(featureOfRoute(['relay', 'phone'])).toBeNull();
    for (const core of [['agents'], ['agents', 'ana'], ['agents', 'ana', 'stop'], ['agents', 'ana', 'hold'], ['messages'], ['downlink'], ['state'], ['features'], ['models'], ['permissions']]) {
      expect(featureOfRoute(core), core.join('/')).toBeNull();
    }
  });
});

describe('plan', () => {
  it('turns off what was asked, and what needs it, and says what loses something', () => {
    const plan = planFeatures([], ['tminus']);
    expect(plan).toMatchObject({ turnOff: ['tminus'], forced: ['static-fire'], turnOn: [], blocked: [], off: ['tminus', 'static-fire'] });
    const chain = planFeatures([], ['hangar']);
    expect(chain.forced).toEqual(['recorder', 'review']);
    expect(planFeatures([], ['uplink']).forced).toEqual(['relay']);
    expect(planFeatures([], ['relay']).degraded.map((d) => d.id)).toEqual(['phone-approvals']);
  });

  it('turns on what a feature that is turned on needs', () => {
    // only Static fire is turned on again: it needs T-minus, so T-minus is turned on too
    expect(planFeatures(['tminus', 'static-fire'], ['tminus'])).toMatchObject({ turnOn: ['tminus'], turnOff: [], forced: [], off: [] });
    // both turned on: nothing extra
    expect(planFeatures(['tminus', 'static-fire'], [])).toMatchObject({ turnOn: [], off: [] });
    // only T-minus is turned on while Static fire stays off: that is allowed
    expect(planFeatures(['tminus', 'static-fire'], ['static-fire'])).toMatchObject({ turnOn: [], off: ['static-fire'] });
    // a chain: turning Recorder on turns Hangar on
    expect(planFeatures(['hangar', 'recorder', 'review'], ['hangar', 'review'])).toMatchObject({ turnOn: ['hangar'], off: ['review'] });
  });

  it('refuses a core feature, an unknown id and one that cannot be switched yet, and applies nothing', () => {
    expect(planFeatures([], ['redline']).blocked).toEqual([{ id: 'redline', why: expect.stringContaining('core') }]);
    expect(planFeatures([], ['nope']).blocked).toEqual([{ id: 'nope', why: 'there is no such feature' }]);
    expect(planFeatures([], ['propellant']).blocked).toEqual([{ id: 'propellant', why: expect.stringContaining('cannot be switched off yet') }]);
    expect(planFeatures([], ['party-line']).blocked).toHaveLength(1);
    // a feature already off that cannot be switched is left alone
    expect(planFeatures(['party-line'], ['party-line']).blocked).toEqual([]);
  });

  it('is the same asked twice, and an empty change is an empty plan', () => {
    expect(planFeatures(['maxq'], ['maxq'])).toEqual({ turnOff: [], forced: [], turnOn: [], degraded: [], blocked: [], off: ['maxq'] });
    expect(planFeatures([], [])).toMatchObject({ turnOff: [], off: [] });
  });

  it('puts the lines of a plan in words', () => {
    expect(planText(planFeatures([], ['tminus']), false)).toEqual(['Turning off T-minus poll also turns off Static fire, which needs it.']);
    expect(planText(planFeatures([], ['redline']), false)[0]).toContain('core');
  });
});

describe('plan, with what the room is doing', () => {
  it('Black Box is core: the audit trail cannot be switched off', () => {
    expect(featureById('black-box')?.core).toBeDefined();
    expect(planFeatures([], ['black-box']).blocked).toEqual([{ id: 'black-box', why: expect.stringContaining('core') }]);
  });

  it('does not turn T-minus or Static fire off while a poll is open', () => {
    expect(planFeatures([], ['tminus'], { pollOpen: true }).blocked.map((b) => b.id)).toEqual(['tminus', 'static-fire']);
    expect(planFeatures([], ['static-fire'], { pollOpen: true }).blocked.map((b) => b.id)).toEqual(['static-fire']);
    expect(planFeatures([], ['tminus'], { pollOpen: false }).blocked).toEqual([]);
    expect(planFeatures([], ['maxq'], { pollOpen: true }).blocked).toEqual([]);
    // already off: turning something else on or off does not trip over an open poll
    expect(planFeatures(['tminus', 'static-fire'], ['tminus', 'static-fire', 'maxq'], { pollOpen: true }).blocked).toEqual([]);
  });

  it('says which running agents must restart to get the tools of a feature that comes back', () => {
    const plan = planFeatures(['flight-plan', 'missions'], ['flight-plan', 'missions'].filter((id) => id !== 'missions' && id !== 'flight-plan'), { running: ['flight', 'ana'] });
    expect(plan.degraded).toEqual(expect.arrayContaining([{ id: 'flight-plan', lines: ['restart flight, ana to get task_list, task_create, task_update back'] }]));
    expect(planFeatures(['flight-plan', 'missions'], [], { running: [] }).degraded).toEqual([]);
    expect(planFeatures(['maxq'], [], { running: ['ana'] }).degraded).toEqual([]);
  });
});

describe('the store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gonogo-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has everything on, and a plan changes nothing', async () => {
    const store = createFeatureStore({ dir });
    await store.load();
    expect(store.view()).toEqual({ off: [] });
    expect(store.isOn('maxq')).toBe(true);
    expect(store.plan({ off: ['maxq'] })).toMatchObject({ turnOff: ['maxq'] });
    expect(store.isOn('maxq')).toBe(true);
    expect(await stat(join(dir, 'features.json')).catch(() => null)).toBeNull();
  });

  it('applies the plan it works out again, saves only the off ids in a private file, tells the browsers, and survives a restart', async () => {
    const told: string[][] = [];
    const store = createFeatureStore({ dir, emit: (view) => told.push(view.off) });
    await store.load();
    const done = await store.apply({ off: ['tminus'], expect: ['tminus', 'static-fire'] });
    expect(done.plan.forced).toEqual(['static-fire']);
    expect(done.view).toEqual({ off: ['tminus', 'static-fire'] });
    expect(store.isOn('static-fire')).toBe(false);
    expect(told).toEqual([['tminus', 'static-fire']]);
    expect((await stat(join(dir, 'features.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, 'features.json'), 'utf8'))).toEqual({ version: 1, off: ['tminus', 'static-fire'] });
    const again = createFeatureStore({ dir });
    await again.load();
    expect(again.view()).toEqual({ off: ['tminus', 'static-fire'] });
    expect(store.label('tminus')).toBe('T-minus poll');
  });

  it('applies only the plan that was read: another one is a 409 and changes nothing, and a missing expect is a 400', async () => {
    const store = createFeatureStore({ dir });
    await store.load();
    await expect(store.apply({ off: ['tminus'], confirm: true })).rejects.toMatchObject({ code: 'bad_request', field: 'expect' });
    await expect(store.apply({ off: ['tminus'], expect: ['tminus'] })).rejects.toMatchObject({ code: 'conflict', field: 'expect' });
    expect(store.view()).toEqual({ off: [] });
    await store.apply({ off: ['tminus'], expect: ['tminus', 'static-fire'] });
    expect(store.view().off).toEqual(['tminus', 'static-fire']);
  });

  it('does not turn T-minus off while a poll is open, and tells the hub when something changed', async () => {
    let poll = true;
    let changed = 0;
    const store = createFeatureStore({ dir, context: () => ({ pollOpen: poll }), changed: () => (changed += 1) });
    await store.load();
    await expect(store.apply({ off: ['tminus'], expect: ['tminus', 'static-fire'] })).rejects.toMatchObject({ code: 'conflict', field: 'off' });
    expect(changed).toBe(0);
    poll = false;
    await store.apply({ off: ['maxq'], expect: ['maxq'] });
    expect(changed).toBe(1);
  });

  it('refuses a blocked plan with a 409 and keeps what was', async () => {
    const store = createFeatureStore({ dir });
    await store.load();
    await expect(store.apply({ off: ['redline'], expect: [] })).rejects.toMatchObject({ code: 'conflict', field: 'off' });
    expect(store.view()).toEqual({ off: [] });
    await expect(store.apply({ off: 'maxq', expect: [] })).rejects.toMatchObject({ code: 'bad_request', field: 'off' });
    await expect(store.apply({ off: [], expect: [], extra: 1 })).rejects.toMatchObject({ code: 'bad_request', field: 'extra' });
    expect(() => store.plan([])).toThrow(/JSON object/);
  });

  it('closes the file over requires and drops unknown, core and not-switchable ids, and keeps a damaged file aside with everything on', async () => {
    await writeFile(join(dir, 'features.json'), JSON.stringify({ version: 1, off: ['maxq', 'something-new', 'redline', 'black-box', 'propellant', 'party-line', 'tminus'] }));
    const store = createFeatureStore({ dir });
    await store.load();
    expect(store.view()).toEqual({ off: ['maxq', 'tminus', 'static-fire'] });
    await writeFile(join(dir, 'features.json'), '{ nope');
    const damaged = createFeatureStore({ dir });
    await damaged.load();
    expect(damaged.view()).toEqual({ off: [] });
    expect((await stat(join(dir, 'features.json.bad'))).isFile()).toBe(true);
  });

  it('leaves a file it cannot read where it is', async () => {
    await mkdir(join(dir, 'features.json'));
    const store = createFeatureStore({ dir });
    await store.load();
    expect(store.view()).toEqual({ off: [] });
    expect(await stat(join(dir, 'features.json.bad')).catch(() => null)).toBeNull();
  });
});

describe('the page', () => {
  const input = { agents: [], legends: {}, poll: null, unread: 0, livery: { liveries: [] } as never };
  it('leaves the views, the poll and the new mission out of the Patch Panel when their features are off', () => {
    const ids = (off: string[]) => commands({ ...input, off }).map((c) => c.id);
    expect(ids([])).toContain('view:plan');
    expect(ids(['flight-plan'])).not.toContain('view:plan');
    expect(ids(['launch-window', 'mission-log', 'livery', 'hangar', 'recorder', 'plot-board', 'missions'])).not.toEqual(expect.arrayContaining(['view:window']));
    expect(ids(['missions'])).not.toContain('new-mission');
    expect(ids([])).toContain('new-mission');
    // the core views stay
    expect(ids(['flight-plan', 'mission-log'])).toEqual(expect.arrayContaining(['view:room', 'view:rules', 'view:downlink', 'view:loop']));
    for (const view of Object.keys(VIEW_FEATURE)) expect(featureById(VIEW_FEATURE[view as keyof typeof VIEW_FEATURE] as string)).toBeDefined();
  });
});
