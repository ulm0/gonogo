import { describe, expect, it } from 'vitest';
import { RELIEF_RULES_DEFAULT } from '../src/shared/protocol.js';
import type { AgentView, Logger, ReliefRules } from '../src/shared/protocol.js';
import { AUTOSCALE_GRACE_MS, AUTOSCALE_NOTE_MS, createAutoscale } from '../src/server/autoscale.js';
import type { AutoscaleOptions } from '../src/server/autoscale.js';

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 24, 12, 0);
const agent = (name: string, extra: Partial<AgentView> = {}): AgentView => ({ name, boss: false, state: 'idle', transition: null, generation: 1, stateSince: T0 - 3 * H, position: null, ...extra }) as unknown as AgentView;

function rig(rules: Partial<ReliefRules>, views: AgentView[], tasks: Array<{ status: string; assignee: string | null; position?: string }>) {
  const state: { rules: ReliefRules; views: AgentView[]; tasks: unknown[]; now: number; refuse?: string } = { rules: { ...RELIEF_RULES_DEFAULT, autoApprove: true, crewBudgetUsd: 5, positions: ['guido', 'fido'], autoscale: 'on', ...rules }, views, tasks, now: T0 };
  const calls: string[] = [];
  const lines: string[] = [];
  const relief: AutoscaleOptions['relief'] = {
    staff: async (_b, position, how) => {
      calls.push(`staff:${position}:${how}`);
      if (how === 'dry') return { id: 'dry', status: 'dry', name: `${position}-1`, note: 'would hire' };
      if (state.refuse !== undefined) return { id: 'none', status: 'refused', note: state.refuse };
      return { id: `hired:${position}-1`, status: 'hired', name: `${position}-1`, note: 'ok' };
    },
    retire: async (_b, name, how) => void calls.push(`${how}:${name}`),
  };
  const options: AutoscaleOptions = { rules: { view: () => state.rules, check: async () => undefined }, tasks: { list: () => state.tasks as never }, views: () => state.views, relief, now: () => state.now, notify: (_k, t) => void lines.push(t), log: quiet };
  return { state, calls, lines, scale: createAutoscale(options) };
}
const boss = agent('flight', { boss: true });
const crew = (name: string, extra: Partial<AgentView> = {}) => agent(name, { hiredBy: 'boss', hiredAt: T0 - 5 * H, position: name.split('-')[0] ?? null, ...extra });
const todo = (position: string, n: number) => Array.from({ length: n }, () => ({ status: 'todo', assignee: null, position }));

describe('autoscale up', () => {
  it('hires one agent of a position when enough unassigned todo tasks name it and none of it runs; one action a tick', async () => {
    const r = rig({}, [boss], [...todo('guido', 3), ...todo('fido', 4)]);
    expect(await r.scale.tick()).toBe('hired guido-1');
    expect(r.calls).toEqual(['staff:guido:rules-only']);
  });

  it('does nothing below the threshold, for assigned or position-less tasks, or when a boss-hired agent of it runs; a stopped one does not count', async () => {
    const tasks = [...todo('guido', 2), { status: 'todo', assignee: 'ana', position: 'guido' }, { status: 'todo', assignee: null }, { status: 'doing', assignee: null, position: 'guido' }];
    expect(await rig({}, [boss], tasks).scale.tick()).toBeNull();
    const busy = rig({}, [boss, crew('guido-1')], todo('guido', 5));
    expect(await busy.scale.tick()).toBeNull();
    const stopped = rig({}, [boss, crew('guido-1', { state: 'stopped' })], todo('guido', 5));
    expect(await stopped.scale.tick()).toBe('hired guido-1');
  });

  it('a position outside the rules is never hired', async () => {
    expect(await rig({ positions: ['fido'] }, [boss], todo('guido', 9)).scale.tick()).toBeNull();
  });

  it('a rule that says no leaves one line an hour and no request; the next position is tried', async () => {
    const r = rig({}, [boss], [...todo('guido', 3), ...todo('fido', 3)]);
    r.state.refuse = 'maxCrew is 3';
    expect(await r.scale.tick()).toBeNull();
    expect(r.calls).toEqual(['staff:guido:rules-only', 'staff:fido:rules-only']);
    expect(r.lines).toHaveLength(2);
    await r.scale.tick();
    expect(r.lines).toHaveLength(2);
    r.state.now += AUTOSCALE_NOTE_MS + 1;
    await r.scale.tick();
    expect(r.lines).toHaveLength(4);
  });
});

describe('autoscale, switches and dry run', () => {
  it('is off when autoscale is off, and stops at once when automatic approval goes off, even with autoscale on', async () => {
    const r = rig({ autoscale: 'off' }, [boss], todo('guido', 9));
    expect(await r.scale.tick()).toBeNull();
    r.state.rules = { ...r.state.rules, autoscale: 'on', autoApprove: false };
    expect(await r.scale.tick()).toBeNull();
    expect(r.calls).toEqual([]);
    r.state.rules = { ...r.state.rules, autoApprove: true };
    expect(await r.scale.tick()).toBe('hired guido-1');
  });

  it('a dry run changes nothing, says what it would do, and rate limits its lines to one an hour per position', async () => {
    const r = rig({ autoscale: 'dry-run', idleStopMinutes: 30 }, [boss, crew('fido-1')], todo('guido', 5));
    expect(await r.scale.tick()).toBe('would hire guido-1');
    expect(r.calls).toEqual(['staff:guido:dry']);
    expect(r.lines).toEqual(['autoscale (dry run): would hire guido-1 for 5 unassigned GUIDO tasks']);
    await r.scale.tick();
    await r.scale.tick();
    expect(r.lines).toHaveLength(1);
  });

  it('with no boss in the room it does nothing', async () => {
    expect(await rig({}, [], todo('guido', 9)).scale.tick()).toBeNull();
  });
});

describe('autoscale down', () => {
  it('stops an idle boss-hired agent with no open task after the idle time, never a new one, a busy one or one with a task', async () => {
    const r = rig({ idleStopMinutes: 60 }, [boss, crew('guido-1'), crew('guido-2', { state: 'working' }), crew('guido-3'), crew('guido-4', { hiredAt: T0 - 60_000, stateSince: T0 - 3 * H }), crew('guido-5', { stateSince: T0 - 10 * 60_000 }), crew('guido-6', { protected: true })], [{ status: 'doing', assignee: 'guido-3' }]);
    expect(await r.scale.tick()).toBe('stopped guido-1');
    expect(r.calls).toEqual(['stop:guido-1']);
    // guido-2 works, guido-3 has a task, guido-4 was just hired, guido-5 was idle only ten minutes, guido-6 is protected
    r.state.views = r.state.views.filter((v) => v.name !== 'guido-1');
    expect(await r.scale.tick()).toBeNull();
  });

  it('never touches an agent the Director hired, and stopping needs mayStop', async () => {
    const r = rig({ idleStopMinutes: 60 }, [boss, agent('ana', { stateSince: T0 - 9 * H })], []);
    expect(await r.scale.tick()).toBeNull();
    const off = rig({ idleStopMinutes: 60, mayStop: false }, [boss, crew('guido-1')], []);
    expect(await off.scale.tick()).toBeNull();
  });

  it('removes a boss-hired agent stopped long enough, only with mayRemove, and never one with an open task', async () => {
    const stopped = crew('guido-1', { state: 'stopped', stateSince: T0 - 30 * H });
    const r = rig({ removeStoppedHours: 24, mayRemove: true }, [boss, stopped], []);
    expect(await r.scale.tick()).toBe('removed guido-1');
    expect(r.calls).toEqual(['remove:guido-1']);
    expect(await rig({ removeStoppedHours: 24 }, [boss, stopped], []).scale.tick()).toBeNull();
    expect(await rig({ removeStoppedHours: 24, mayRemove: true }, [boss, stopped], [{ status: 'todo', assignee: 'guido-1' }]).scale.tick()).toBeNull();
    expect(await rig({ removeStoppedHours: 24, mayRemove: true }, [boss, crew('guido-1', { state: 'stopped', stateSince: T0 - 2 * H })], []).scale.tick()).toBeNull();
  });

  it('one action per tick of any kind: a hire and a stop never happen together', async () => {
    const r = rig({ idleStopMinutes: 60 }, [boss, crew('fido-1')], todo('guido', 5));
    expect(await r.scale.tick()).toBe('hired guido-1');
    expect(r.calls).toEqual(['staff:guido:rules-only']);
  });

  it('keeps the grace after a hire', () => {
    expect(AUTOSCALE_GRACE_MS).toBe(10 * 60_000);
  });
});
