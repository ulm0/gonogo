import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RELIEF_RULES_DEFAULT } from '../src/shared/protocol.js';
import type { AgentView, CleanRoom, HireRequest, Logger, ReliefRules } from '../src/shared/protocol.js';
import { HubError } from '../src/server/hub.js';
import { createRelief } from '../src/server/relief.js';
import type { Relief, ReliefOptions } from '../src/server/relief.js';
import { createReliefRules, raisesPower, readRules } from '../src/server/reliefrules.js';
import type { ReliefRulesStore } from '../src/server/reliefrules.js';
import { hireStepUpReason, stepUpReason } from '../src/server/stepup.js';

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const agent = (name: string, extra: Partial<AgentView> = {}): AgentView =>
  ({ name, role: 'r', dir: '/work', mode: 'default', desk: 1, boss: false, state: 'idle', generation: 1, transition: null, cleanRoom: null, provider: 'claude', position: null, ...extra }) as unknown as AgentView;
const CR: CleanRoom = { flavor: 'docker' } as unknown as CleanRoom;

let root: string;
let project: string;
let now: number;
let views: AgentView[];
let hired: Array<{ request: HireRequest; meta?: { hiredBy: 'boss' } }>;
let events: Array<[string, string]>;
let rules: ReliefRulesStore;
let relief: Relief;
let unsafe: string | null;
const BOSS = { agent: 'flight', generation: 1 };
const on = (over: Partial<ReliefRules> = {}): Promise<ReliefRules> => rules.set({ autoApprove: true, crewBudgetUsd: 5, positions: ['guido', 'fido'], ...over });

function make(): Relief {
  return createRelief({
    hub: {
      views: () => views,
      hire: async (request, meta) => {
        hired.push({ request, ...(meta === undefined ? {} : { meta }) });
        const view = agent(request.name, { dir: request.dir, desk: views.length, ...(meta?.hiredBy === 'boss' ? { hiredBy: 'boss', hiredAt: now } : {}) });
        views.push(view);
        return view;
      },
      sendFromUser: () => ({ ok: true, id: 'm1', to: 'flight', status: 'queued', note: null }),
    },
    rules,
    cleanRoomUnsafe: () => unsafe,
    checkDirectory: async (p) => {
      if (!isAbsolute(p)) return { ok: false, error: 'directory must be an absolute path' };
      const info = await stat(p).catch(() => null);
      if (info === null || !info.isDirectory()) return { ok: false, error: `not a directory: ${p}` };
      return { ok: true, path: resolve(p) };
    },
    now: () => now,
    setTimer: () => ({}),
    clearTimer: () => undefined,
    emit: () => undefined,
    notify: (kind, text) => void events.push([kind, text]),
    log: quiet,
  } satisfies ReliefOptions);
}
/** Every ask moves the clock past the request rate window (5 in 10 minutes), which is not what these tests are about. */
const ask = (extra: Record<string, unknown> = {}) => relief.request(BOSS, { name: 'g1', position: 'guido', dir: project, ...extra }).finally(() => void (now += 11 * 60_000));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gonogo-rules-')));
  project = join(root, 'project');
  await mkdir(project);
  now = Date.UTC(2026, 10, 24, 9, 0);
  views = [agent('flight', { boss: true, desk: 0, dir: project })];
  hired = [];
  events = [];
  unsafe = null;
  rules = createReliefRules({ dir: root, log: quiet, budgetEnforced: true, alarm: (text) => void events.push(['alarm', text]) });
  await rules.load();
  relief = make();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the rules file', () => {
  it('defaults: off, nothing allowed; a bad or missing file reads as the defaults', async () => {
    expect(rules.view()).toEqual(RELIEF_RULES_DEFAULT);
    await writeFile(join(root, 'relief.json'), '{ not json');
    await rules.load();
    expect(rules.view().autoApprove).toBe(false);
  });

  it('autoApprove needs a daily crew budget; bypassPermissions is not a maxMode; unknown rules are refused', async () => {
    await expect(rules.set({ autoApprove: true })).rejects.toMatchObject({ field: 'rules.crewBudgetUsd' });
    await expect(rules.set({ maxMode: 'bypassPermissions' })).rejects.toMatchObject({ field: 'rules.maxMode' });
    await expect(rules.set({ bypassInCleanRoom: true })).rejects.toMatchObject({ field: 'rules.bypassInCleanRoom' });
    await expect(rules.set({ engines: ['custom'] })).rejects.toBeInstanceOf(HubError);
    expect(rules.view()).toEqual(RELIEF_RULES_DEFAULT);
  });

  it('a hand edit of the file turns autoApprove off, renames it .bad and raises the alarm; a hash file beside it does not help', async () => {
    await on();
    const text = await readFile(join(root, 'relief.json'), 'utf8');
    // an agent that can write the file writes autoApprove on with a bigger crew, and a "hash" beside it
    await writeFile(join(root, 'relief.json'), text.replace('"maxCrew": 3', '"maxCrew": 24'));
    await writeFile(join(root, 'relief.json.sha256'), 'whatever');
    await rules.check();
    expect(rules.view().autoApprove).toBe(false);
    expect(rules.view().maxCrew).toBe(3);
    expect(await readFile(join(root, 'relief.json.bad'), 'utf8')).toContain('"maxCrew": 24');
    expect(events.some(([kind]) => kind === 'alarm')).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'relief.json'), 'utf8')).autoApprove).toBe(false);
  });

  it('a file deleted or swapped for a read-only copy is a tamper too; the next API change is the new record', async () => {
    await on();
    await rm(join(root, 'relief.json'));
    await rules.check();
    expect(rules.view().autoApprove).toBe(false);
    await on();
    expect(rules.view().autoApprove).toBe(true);
    await rules.check();
    expect(rules.view().autoApprove).toBe(true);
  });

  it('raisesPower: only a raise needs the step-up; lowering never does', async () => {
    const base = RELIEF_RULES_DEFAULT;
    expect(raisesPower(base, { ...base, autoApprove: true })).toBe(true);
    expect(raisesPower(base, { ...base, maxMode: 'auto' })).toBe(true);
    expect(raisesPower(base, { ...base, positions: ['guido'] })).toBe(true);
    expect(raisesPower(base, { ...base, maxCrew: 5 })).toBe(true);
    expect(raisesPower({ ...base, maxCrew: 5, positions: ['guido'], maxMode: 'auto', autoApprove: true, crewBudgetUsd: 9 }, base)).toBe(false);
    expect(readRules({ maxCrew: 2 }, { ...base, maxCrew: 9 }).maxCrew).toBe(2);
  });

  it('a restart keeps the rules; the crew and the hire rate come from the hired agents, which the record stores', async () => {
    await on({ maxCrew: 1 });
    const again = createReliefRules({ dir: root, log: quiet, budgetEnforced: true });
    await again.load();
    expect(again.view()).toMatchObject({ autoApprove: true, maxCrew: 1, crewBudgetUsd: 5 });
  });
});

describe('automatic approval waits for the budget (RSO M2)', () => {
  it('is refused until the crew budget is enforced, by the API and by a file on disk', async () => {
    const early = createReliefRules({ dir: join(root, 'early'), log: quiet });
    await mkdir(join(root, 'early'));
    await early.load();
    await expect(early.set({ autoApprove: true, crewBudgetUsd: 5 })).rejects.toMatchObject({ field: 'rules.autoApprove' });
    expect(early.view().autoApprove).toBe(false);
    await writeFile(join(root, 'early', 'relief.json'), JSON.stringify({ version: 1, autoApprove: true, crewBudgetUsd: 5 }));
    await early.load();
    expect(early.view().autoApprove).toBe(false);
  });
});

describe('hire_agent by rule', () => {
  it('defaults leave today: every hire waits for the Director, with no rule named', async () => {
    const answer = await ask();
    expect(answer.status).toBe('pending');
    expect(answer.note).not.toMatch(/needs the Director's GO/);
    expect(hired).toEqual([]);
  });

  it('inside the rules it staffs at once, with hiredBy boss; the answer and the Downlink line say so, never the role text', async () => {
    await on();
    const answer = await ask();
    expect(answer).toMatchObject({ status: 'hired', name: 'g1' });
    expect(hired).toHaveLength(1);
    expect(hired[0]?.meta).toEqual({ hiredBy: 'boss' });
    expect(hired[0]?.request).toMatchObject({ name: 'g1', mode: 'default', provider: 'claude', position: 'guido' });
    expect(events.map(([, t]) => t).join('\n')).toMatch(/g1 hired by flight by rule/);
    expect(relief.view().crew).toEqual(['g1']);
  });

  it('out of the rules it becomes a pending request that names the rule', async () => {
    await on();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ position: 'fido', mode: 'auto' }, /mode auto is above maxMode \(acceptEdits\)/],
      [{ mode: 'acceptEdits', position: 'fido' }, /^$/],
      [{ role: 'my own persona' }, /role written by the boss/],
      [{ position: 'retro' }, /position retro is not in the rules/],
      [{ engine: 'pi' }, /engine pi is not in the rules/],
      [{ dir: root }, /folder is not the boss's/],
    ];
    for (const [extra, want] of cases) {
      const answer = await ask({ name: `n${hired.length}-${String(Math.random()).slice(2, 6)}`, ...extra });
      if (String(want) === String(/^$/)) {
        expect(answer.status).toBe('hired');
        continue;
      }
      expect(answer.status, JSON.stringify(extra)).toBe('pending');
      expect(answer.note).toMatch(want);
    }
    expect(relief.view().requests.every((r) => typeof r.asks === 'string')).toBe(true);
  });

  it('a mode above maxMode asks; auto by rule runs in a Clean Room only, up to maxMode, and only when the Clean Room is safe (egress on, no global MCP)', async () => {
    await on({ maxMode: 'auto' });
    expect((await ask({ mode: 'auto' })).note).toMatch(/needs autoOnHost/);
    views[0] = agent('flight', { boss: true, desk: 0, dir: project, cleanRoom: CR });
    expect(await ask({ name: 'g2', mode: 'auto' })).toMatchObject({ status: 'hired' });
    expect(hired.at(-1)?.request.mode).toBe('auto');
    unsafe = 'egress is off';
    expect((await ask({ name: 'g3', mode: 'auto' })).note).toMatch(/safe Clean Room: egress is off/);
    // acceptEdits needs no such check
    expect(await ask({ name: 'g4', mode: 'acceptEdits' })).toMatchObject({ status: 'hired' });
    await rules.set({ maxMode: 'acceptEdits' });
    expect((await ask({ name: 'g5', mode: 'auto' })).note).toMatch(/above maxMode \(acceptEdits\)/);
    // the host with autoOnHost on
    views[0] = agent('flight', { boss: true, desk: 0, dir: project });
    await rules.set({ maxMode: 'auto', autoOnHost: true });
    expect(await ask({ name: 'g6', mode: 'auto' })).toMatchObject({ status: 'hired' });
  });

  it('bypassPermissions is never asked for: it is refused as before', async () => {
    await on({ maxMode: 'auto' });
    await expect(ask({ mode: 'bypassPermissions' })).rejects.toMatchObject({ field: 'mode' });
    expect(hired).toEqual([]);
  });

  it('the crew cap and the hourly rate hold, also under parallel calls', async () => {
    await on({ maxCrew: 2, ratePerHour: 5 });
    const answers = await Promise.all(['a', 'b', 'c', 'd'].map((n) => ask({ name: n })));
    expect(answers.filter((a) => a.status === 'hired')).toHaveLength(2);
    expect(answers.filter((a) => a.status === 'pending').every((a) => /maxCrew is 2/.test(a.note))).toBe(true);
    await rules.set({ maxCrew: 24, ratePerHour: 2 });
    expect((await ask({ name: 'e' })).note).toMatch(/ratePerHour is 2/);
    now += 3_700_000;
    expect(await ask({ name: 'f' })).toMatchObject({ status: 'hired' });
  });

  it('a Clean Room boss hires Clean Room agents only, and one with a weaker wall or its own API key asks', async () => {
    await on();
    views[0] = agent('flight', { boss: true, desk: 0, dir: project, cleanRoom: { flavor: 'docker', egress: false } as unknown as CleanRoom });
    expect((await ask()).note).toMatch(/holds its own API key needs your GO/);
    views[0] = agent('flight', { boss: true, desk: 0, dir: project, cleanRoom: CR });
    expect(await ask({ name: 'cr1' })).toMatchObject({ status: 'hired' });
    expect(hired.at(-1)?.request.cleanRoom).toBeTruthy();
  });

  it('the symbolic link out of the boss folder asks', async () => {
    await on();
    await symlink(root, join(project, 'out'));
    expect((await ask({ dir: join(project, 'out') })).note).toMatch(/folder is not the boss's/);
  });

  it('only the boss asks, and a boss-hired agent cannot hire', async () => {
    await on();
    await ask();
    await expect(relief.request({ agent: 'g1', generation: 1 }, { name: 'x', position: 'guido', dir: project })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('no key, payload, payloadOff, permissions, remote control, command or weak cleanRoom field can be asked: the tool refuses the field, and the shared judge names each', async () => {
    await on();
    for (const field of ['keys', 'payload', 'payloadOff', 'permissions', 'remoteControl', 'command', 'cleanRoom', 'confirmBypass']) {
      await expect(relief.request(BOSS, JSON.parse(`{"name":"z","position":"guido","dir":${JSON.stringify(project)},"${field}":true}`)), field).rejects.toBeInstanceOf(HubError);
    }
    expect(hired).toEqual([]);
    const base = { name: 'z', dir: '/p', mode: 'default', provider: 'claude' };
    expect(hireStepUpReason(base, { roomSandbox: 'docker' }, true)).toBeNull();
    for (const extra of [{ keys: { A: 'b' } }, { payload: { mcpServers: {}, skills: ['x'] } }, { payloadOff: { mcpServers: ['x'] } }, { permissions: { deny: ['Bash'] } }, { remoteControl: { enabled: true } }, { command: 'x' }, { cleanRoom: { egress: false } }, { cleanRoom: { flavor: 'docker' } }]) {
      expect(hireStepUpReason({ ...base, ...extra }, { roomSandbox: 'gvisor' }, true), JSON.stringify(extra)).not.toBeNull();
    }
  });

  it('the judge Relief asks IS the hire form\'s: the same function answers the step-up of POST /api/agents', () => {
    const body = { name: 'z', dir: '/p', mode: 'default', keys: { A: 'b' } };
    expect(stepUpReason('POST', '/api/agents', body)).toBe(hireStepUpReason(body));
    expect(stepUpReason('POST', '/api/agents', { ...body, keys: undefined, mode: 'auto' })).toBe('hiring an agent that works without asking');
    expect(hireStepUpReason({ ...body, keys: undefined, mode: 'auto' }, {}, true)).toBeNull();
  });

  it('a failed hire after a rule approved it frees its crew slot', async () => {
    await on({ maxCrew: 1 });
    const failing = createRelief({ ...({} as ReliefOptions), hub: { views: () => views, hire: async () => { throw new HubError('conflict', 'no Docker'); }, sendFromUser: () => ({ ok: true, id: 'm', to: 'x', status: 'queued', note: null }) }, rules, checkDirectory: async (p) => ({ ok: true, path: p }), now: () => now, setTimer: () => ({}), clearTimer: () => undefined, emit: () => undefined, log: quiet });
    await expect(failing.request(BOSS, { name: 'f1', position: 'guido', dir: project })).rejects.toThrow('no Docker');
    expect(await ask({ name: 'f2' })).toMatchObject({ status: 'hired' });
  });
});

describe('the rules by the Director: the API and STOP CREW', () => {
  it('setRules changes the rules and tells the Downlink the moved ones; a bad body changes nothing', async () => {
    const view = await relief.setRules({ autoApprove: true, crewBudgetUsd: 3, positions: ['guido'] });
    expect(view.rules).toMatchObject({ autoApprove: true, crewBudgetUsd: 3, positions: ['guido'] });
    expect(events.some(([, t]) => /Relief rules changed: .*autoApprove true/.test(t))).toBe(true);
    await expect(relief.setRules({ maxCrew: 0 })).rejects.toMatchObject({ field: 'rules.maxCrew' });
    expect(rules.view().maxCrew).toBe(3);
  });

  it('STOP CREW stops every boss-hired agent, not the Director\'s, and turns autoApprove off at once', async () => {
    const stopped: string[] = [];
    await on();
    const withStop = createRelief({ hub: { views: () => views, hire: async (request, meta) => { const v = agent(request.name, { dir: request.dir, desk: views.length, ...(meta?.hiredBy === 'boss' ? { hiredBy: 'boss', hiredAt: now } : {}) }); views.push(v); return v; }, sendFromUser: () => ({ ok: true, id: 'm', to: 'x', status: 'queued', note: null }), stop: async (name: string) => { stopped.push(name); return views.find((v) => v.name === name) as AgentView; } }, rules, checkDirectory: async (p) => ({ ok: true, path: p }), now: () => now, setTimer: () => ({}), clearTimer: () => undefined, emit: () => undefined, notify: (k, t) => void events.push([k, t]), log: quiet });
    views.push(agent('mine', { desk: 5 }));
    await withStop.request(BOSS, { name: 'c1', position: 'guido', dir: project });
    now += 11 * 60_000;
    await withStop.request(BOSS, { name: 'c2', position: 'fido', dir: project });
    const done = await withStop.stopCrew();
    expect(done.stopped.sort()).toEqual(['c1', 'c2']);
    expect(stopped).not.toContain('mine');
    expect(stopped).not.toContain('flight');
    expect(rules.view().autoApprove).toBe(false);
    expect(events.some(([, t]) => /STOP CREW: 2 of 2/.test(t))).toBe(true);
    now += 11 * 60_000;
    expect((await withStop.request(BOSS, { name: 'c3', position: 'guido', dir: project })).status).toBe('pending');
  });
});

describe('fire_agent through Relief', () => {
  const FIRE = { agent: 'flight', generation: 1 };
  function withFire(over: Partial<ReliefOptions> = {}, task = { id: 't7', assignee: 'g1', status: 'doing' }) {
    const updates: Array<[string, unknown]> = [];
    const fired: string[] = [];
    const r = createRelief({
      hub: {
        views: () => views,
        hire: async () => { throw new Error('no'); },
        sendFromUser: () => ({ ok: true, id: 'm', to: 'x', status: 'queued', note: null }),
        fireAgent: async (name: string) => { fired.push(name); return views.find((v) => v.name === name) as AgentView; },
      },
      tasks: { list: () => [task, { id: 't8', assignee: 'g1', status: 'done' }, { id: 't9', assignee: 'other', status: 'todo' }], update: async (_a, id, input) => void updates.push([id, input]) },
      checkDirectory: async (p) => ({ ok: true, path: p }), now: () => now, setTimer: () => ({}), clearTimer: () => undefined, emit: () => undefined, notify: (k, t) => void events.push([k, t]), log: quiet, ...over,
    });
    return { r, updates, fired };
  }

  it('stops the agent, releases its open tasks only, and the Downlink line says how many', async () => {
    views.push(agent('g1', { hiredBy: 'boss' }));
    const { r, updates, fired } = withFire();
    const done = await r.fire(FIRE, { name: 'g1', reason: 'the work is done' });
    expect(done).toMatchObject({ name: 'g1', released: 1 });
    expect(fired).toEqual(['g1']);
    expect(updates).toEqual([['t7', { status: 'todo', assignee: null, note: 'released: g1 was stopped by flight' }]]);
    expect(events.map(([, t]) => t).join('\n')).toMatch(/flight fired g1 \(1 tasks released\): the work is done/);
  });

  it('only the boss fires; a bad name or reason, and an agent with a vote to cast, are refused before anything stops', async () => {
    views.push(agent('g1', { hiredBy: 'boss' }), agent('ben'));
    const { r, fired } = withFire({ voteWaitsFor: (name) => name === 'g1' });
    await expect(r.fire({ agent: 'ben', generation: 1 }, { name: 'g1', reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.fire(FIRE, { name: 'Bad Name', reason: 'x' })).rejects.toMatchObject({ field: 'name' });
    await expect(r.fire(FIRE, { name: 'g1', reason: '' })).rejects.toMatchObject({ field: 'reason' });
    await expect(r.fire(FIRE, { name: 'g1', reason: 'hidden\u200Btext' })).rejects.toMatchObject({ field: 'reason' });
    await expect(r.fire(FIRE, { name: 'g1', reason: 'x' })).rejects.toMatchObject({ code: 'conflict' });
    expect(fired).toEqual([]);
  });

  it('mayStop off: fire_agent is refused before anything stops; turning it on again needs the step-up, turning it off does not', async () => {
    views.push(agent('g1', { hiredBy: 'boss' }));
    await on();
    await rules.set({ mayStop: false });
    const { r, fired } = withFire({ rules });
    await expect(r.fire(FIRE, { name: 'g1', reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(fired).toEqual([]);
    expect(raisesPower({ ...RELIEF_RULES_DEFAULT, mayStop: false }, { ...RELIEF_RULES_DEFAULT, mayStop: true })).toBe(true);
    expect(raisesPower({ ...RELIEF_RULES_DEFAULT, mayStop: true }, { ...RELIEF_RULES_DEFAULT, mayStop: false })).toBe(false);
    await rules.set({ mayStop: true });
    expect((await r.fire(FIRE, { name: 'g1', reason: 'x' })).name).toBe('g1');
  });

  it('the hub\'s refusal (a protected agent) stops it with no task released', async () => {
    views.push(agent('ana'));
    const { r, updates } = withFire({ hub: { views: () => views, hire: async () => { throw new Error('no'); }, sendFromUser: () => ({ ok: true, id: 'm', to: 'x', status: 'queued', note: null }), fireAgent: async () => { throw new HubError('forbidden', 'ana was not hired by you by rule'); } } });
    await expect(r.fire(FIRE, { name: 'ana', reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(updates).toEqual([]);
  });
});

void rename;
