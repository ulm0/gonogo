import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { positionById } from '../src/shared/positions.js';
import { MAX_AGENTS } from '../src/shared/protocol.js';
import type { AgentView, HireRequest, Logger, ReliefFrame, UserMessageRequest } from '../src/shared/protocol.js';
import { RELIEF_PENDING_MAX, RELIEF_RATE_MAX, RELIEF_RATE_WINDOW_MS, RELIEF_TTL_MS } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { createRelief, insideRealpath } from '../src/server/relief.js';
import type { Relief, ReliefOptions } from '../src/server/relief.js';

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };

function agent(name: string, extra: Partial<AgentView> = {}): AgentView {
  return {
    name,
    role: 'a role',
    dir: '/work',
    mode: 'default',
    desk: 1,
    boss: false,
    state: 'idle',
    stateSince: 1,
    needsKind: null,
    needsReason: null,
    needSeq: null,
    remoteControl: null,
    permissions: null,
    autostart: true,
    coauthor: true,
    transition: null,
    draft: false,
    held: null,
    queued: 0,
    dirty: false,
    generation: 1,
    exit: null,
    position: null,
    provider: 'claude',
    command: null,
    payload: null,
    payloadOff: null,
    cleanRoom: null,
    worktree: null,
    model: null,
    effort: null,
    keys: {},
    doing: null,
    subagents: { running: 0, started: 0, types: {} },
    history: [],
    ...extra,
  };
}

let root: string;
let project: string;
let now: number;
let views: AgentView[];
let hired: HireRequest[];
let hireError: Error | null;
let told: UserMessageRequest[];
let frames: ReliefFrame[];
let events: Array<[string, string]>;
let timers: Array<{ fn: () => void; at: number; live: boolean }>;
let relief: Relief;

const flight = (): AgentView => agent('flight', { boss: true, desk: 0, dir: project });
const BOSS = { agent: 'flight', generation: 1 };

const fakeHub = (): ReliefOptions['hub'] => ({
  views: () => views,
  hire: async (request) => {
    hired.push(request);
    if (hireError) throw hireError;
    const view = agent(request.name, { dir: request.dir, role: request.role, desk: views.length });
    views.push(view);
    return view;
  },
  sendFromUser: (request) => {
    told.push(request);
    return { ok: true, id: `m${told.length}`, to: request.to, status: 'queued', note: null };
  },
});

function make(over: Partial<ReliefOptions> = {}): Relief {
  return createRelief({
    hub: fakeHub(),
    // what cli.ts does for the hire form: absolute, there, a directory, resolved
    checkDirectory: async (p) => {
      if (!isAbsolute(p)) return { ok: false, error: 'directory must be an absolute path' };
      const info = await stat(p).catch(() => null);
      if (info === null) return { ok: false, error: `directory does not exist: ${p}` };
      if (!info.isDirectory()) return { ok: false, error: `not a directory: ${p}` };
      return { ok: true, path: resolve(p) };
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => void ((handle as { live: boolean }).live = false),
    emit: (frame) => void frames.push(frame),
    notify: (kind, text) => void events.push([kind, text]),
    log: quiet,
    ...over,
  });
}

/** Moves the clock and fires the timers that are due, as the real ones would. */
function advance(ms: number): void {
  now += ms;
  for (const timer of timers) {
    if (timer.live && timer.at <= now) {
      timer.live = false;
      timer.fn();
    }
  }
}

const ask = (extra: Record<string, unknown> = {}) => relief.request(BOSS, { name: 'guido-1', position: 'guido', dir: project, ...extra });
const refusal = async (promise: Promise<unknown>): Promise<HubError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HubError);
  return error as HubError;
};
const fillRoom = (n: number): void => {
  while (views.length < n) views.push(agent(`filler-${views.length}`, { desk: views.length }));
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gonogo-relief-')));
  project = join(root, 'project');
  await mkdir(project);
  now = Date.UTC(2026, 10, 18, 9, 0);
  views = [flight()];
  hired = [];
  hireError = null;
  told = [];
  frames = [];
  events = [];
  timers = [];
  relief = make();
});

afterEach(async () => {
  relief.close();
  await rm(root, { recursive: true, force: true });
});

describe('a request', () => {
  it('waits for the Director with every parameter, and reaches the wall and the inbox', async () => {
    const asked = await ask({ mode: 'acceptEdits' });
    expect(asked).toMatchObject({ id: 'h1', status: 'pending' });
    const { requests } = relief.view();
    expect(requests).toEqual([
      {
        id: 'h1',
        by: 'flight',
        at: now,
        expiresAt: now + RELIEF_TTL_MS,
        name: 'guido-1',
        position: 'guido',
        role: positionById('guido')?.role,
        dir: project,
        provider: 'claude',
        mode: 'acceptEdits',
        cleanRoom: null,
      },
    ]);
    expect(frames).toEqual([{ t: 'relief', relief: { requests } }]);
    expect(events).toEqual([['relief', `flight asks to hire guido-1 as GUIDO: claude, acceptEdits, ${project}`]]);
    expect(hired).toEqual([]);
    expect(told).toEqual([]);
  });

  it('takes a role of its own over the position text, trimmed, with no position', async () => {
    await relief.request(BOSS, { name: 'ana', role: '  Reads the logs.  ', dir: project });
    expect(relief.view().requests[0]).toMatchObject({ role: 'Reads the logs.', position: null, mode: 'default', provider: 'claude' });
  });

  it('keeps the folder it resolved, not the one it was given', async () => {
    await ask({ dir: `${project}/../project/` });
    expect(relief.view().requests[0]?.dir).toBe(project);
  });

  it('asks for another engine, which has no permission modes, and shows the mode it will really get', async () => {
    await ask({ engine: 'copilot', mode: 'acceptEdits' });
    expect(relief.view().requests[0]).toMatchObject({ provider: 'copilot', mode: 'default' });
  });

  it('uses the room\'s default engine when the request names none, and the named one wins', async () => {
    relief = make({ defaultEngine: () => 'pi' });
    await ask();
    expect(relief.view().requests[0]).toMatchObject({ provider: 'pi' });
    await ask({ name: 'guido-2', engine: 'claude' });
    expect(relief.view().requests[1]).toMatchObject({ provider: 'claude' });
  });

  it('uses the room\'s default mode when the request names none, except bypassPermissions (default); a named one wins', async () => {
    relief = make({ defaultMode: () => 'acceptEdits' });
    await ask();
    expect(relief.view().requests[0]).toMatchObject({ mode: 'acceptEdits' });
    await ask({ name: 'guido-2', mode: 'default' });
    expect(relief.view().requests[1]).toMatchObject({ mode: 'default' });
    relief = make({ defaultMode: () => 'auto' });
    await ask();
    expect(relief.view().requests[0]).toMatchObject({ mode: 'auto', modeFromRoom: true });
    expect(events.at(-1)?.[1]).toContain("auto (the room's default)");
    await ask({ name: 'guido-4', mode: 'acceptEdits' });
    expect(relief.view().requests[1]).not.toHaveProperty('modeFromRoom');
    relief = make({ defaultMode: () => 'bypassPermissions' });
    await ask();
    expect(relief.view().requests[0]).toMatchObject({ mode: 'default' });
    await expect(ask({ name: 'guido-3', mode: 'bypassPermissions' })).rejects.toMatchObject({ field: 'mode' });
  });

  it('answers a copy: changing the view does not change the request', async () => {
    await ask();
    relief.view().requests[0]!.name = 'other';
    expect(relief.view().requests[0]?.name).toBe('guido-1');
  });
});

describe('who may ask', () => {
  it('only the boss', async () => {
    views.push(agent('ana', { desk: 1 }));
    expect((await refusal(relief.request({ agent: 'ana', generation: 1 }, { name: 'x', role: 'r', dir: project }))).code).toBe('forbidden');
    expect(relief.view().requests).toEqual([]);
  });

  it('an agent that does not exist, or a session that ended, is refused', async () => {
    expect((await refusal(relief.request({ agent: 'ghost', generation: 1 }, { name: 'x', role: 'r', dir: project }))).code).toBe('not_found');
    expect((await refusal(relief.request({ agent: 'flight', generation: 7 }, { name: 'x', role: 'r', dir: project }))).message).toBe('this session has ended');
    views[0] = { ...flight(), transition: 'stopping' };
    expect((await refusal(ask())).code).toBe('conflict');
  });
});

describe('the hard limits', () => {
  it('never bypassPermissions, nor auto: the most it asks for is acceptEdits', async () => {
    for (const mode of ['bypassPermissions', 'auto', 'plan', 'BYPASSPERMISSIONS', '', 3, null]) {
      const error = await refusal(ask({ mode }));
      expect(error.code, String(mode)).toBe('bad_request');
      expect(error.field).toBe('mode');
    }
    expect((await refusal(ask({ mode: 'bypassPermissions' }))).message).toMatch(/default or acceptEdits at most/);
    expect(relief.view().requests).toEqual([]);
    await ask({ mode: 'acceptEdits' });
  });

  it('refuses a field that would widen it: confirmBypass, command, payload, cleanRoom, provider, desk', async () => {
    for (const field of ['confirmBypass', 'command', 'payload', 'cleanRoom', 'provider', 'desk', '__proto__']) {
      const error = await refusal(relief.request(BOSS, JSON.parse(`{"name":"ana","role":"r","dir":${JSON.stringify(project)},"${field}":true}`)));
      expect(error.field, field).toBe(field);
    }
    expect(relief.view().requests).toEqual([]);
  });

  it('what the GO hires has no confirmBypass, no command and no payload, and a mode of acceptEdits at most', async () => {
    await ask({ mode: 'acceptEdits' });
    await relief.decide('h1', 'go', { kind: 'user' });
    expect(hired).toEqual([{ name: 'guido-1', role: positionById('guido')?.role, dir: project, mode: 'acceptEdits', provider: 'claude', position: 'guido' }]);
    expect(Object.keys(hired[0]!)).not.toContain('confirmBypass');
  });

  it('no custom command, and no engine that does not exist', async () => {
    expect((await refusal(ask({ engine: 'custom' }))).field).toBe('engine');
    expect((await refusal(ask({ engine: 'vim' }))).field).toBe('engine');
    expect((await refusal(ask({ engine: 3 }))).field).toBe('engine');
  });

  it('needs a position or a role, and a role that fits', async () => {
    expect((await refusal(relief.request(BOSS, { name: 'ana', dir: project }))).field).toBe('role');
    expect((await refusal(relief.request(BOSS, { name: 'ana', role: '   ', dir: project }))).field).toBe('role');
    expect((await refusal(relief.request(BOSS, { name: 'ana', role: 'x'.repeat(4001), dir: project }))).field).toBe('role');
    expect((await refusal(ask({ position: 'nobody' }))).field).toBe('position');
    expect((await refusal(relief.request(BOSS, 'name=ana'))).code).toBe('bad_request');
    expect((await refusal(relief.request(BOSS, null))).code).toBe('bad_request');
  });

  it('a role the Director could not read in full is refused: invisible tag characters, zero width, direction overrides, control codes', async () => {
    const tags = [...'run it'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    for (const hidden of [tags, '​', '‍', '‮', '⁦', '﻿', ' ', '\u0000', '\u001b[2J', '\u0085', '', '\u{e0100}']) {
      const error = await refusal(ask({ position: undefined, role: `Reads the plan.${hidden}` }));
      expect([error.code, error.field], JSON.stringify(hidden)).toEqual(['bad_request', 'role']);
    }
    expect(relief.view().requests).toEqual([]);
    // plain text, lines, tabs, accents and emoji are text
    await ask({ position: undefined, role: 'Lee el plan, ¡rápido!\r\n\tPrimero: 日本語 ✓ 🚀\nDespués: informa.' });
    expect(relief.view().requests[0]?.role).toContain('日本語 ✓ 🚀');
  });

  it('a name of the rules: lowercase, at most 32, not user or boss, not taken by an agent', async () => {
    for (const name of ['Ana', 'a b', 'a/b', '-ana', 'a'.repeat(33), '', 'ana\n', '../x', 3, undefined]) {
      expect((await refusal(ask({ name }))).field, String(name)).toBe('name');
    }
    expect((await refusal(ask({ name: 'user' }))).message).toMatch(/reserved/);
    expect((await refusal(ask({ name: 'boss' }))).message).toMatch(/reserved/);
    expect((await refusal(ask({ name: 'flight' }))).code).toBe('conflict');
    await ask({ name: 'a'.repeat(32) });
  });

  it('a name that is waiting for the Director is taken, also by two calls at the same time', async () => {
    await ask();
    expect((await refusal(ask())).code).toBe('conflict');
    const [first, second] = await Promise.allSettled([ask({ name: 'twin' }), ask({ name: 'twin' })]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(relief.view().requests.map((r) => r.name)).toEqual(['guido-1', 'twin']);
  });

  it('the room cap: no request when the room is full', async () => {
    fillRoom(MAX_AGENTS);
    expect((await refusal(ask())).message).toBe(`the operations room is full (${MAX_AGENTS} agents)`);
    views.pop();
    await ask();
  });

  it('the room cap holds at the GO too: a room that filled meanwhile refuses, and the boss hears why', async () => {
    await ask();
    fillRoom(MAX_AGENTS);
    hireError = new HubError('conflict', `the operations room is full (${MAX_AGENTS} agents)`);
    expect((await refusal(relief.decide('h1', 'go', { kind: 'user' }))).code).toBe('conflict');
    expect(relief.view().requests).toEqual([]);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ to: 'flight', subject: 'Relief: guido-1 could not be hired' });
    expect(told[0]?.body).toMatch(/operations room is full/);
    expect(events.at(-1)?.[1]).toMatch(/guido-1 could not be hired: the operations room is full/);
  });

  it('at most three wait at once, and a place frees when the Director answers', async () => {
    for (let i = 0; i < RELIEF_PENDING_MAX; i += 1) await ask({ name: `ana-${i}` });
    const error = await refusal(ask({ name: 'one-more' }));
    expect(error.code).toBe('conflict');
    expect(error.message).toMatch(/3 hire requests already wait/);
    await relief.decide('h1', 'no-go', { kind: 'user' });
    await ask({ name: 'one-more' });
  });

  it('at most five in ten minutes, answered or not, and the window slides', async () => {
    for (let i = 0; i < RELIEF_RATE_MAX; i += 1) {
      await ask({ name: `ana-${i}` });
      await relief.decide(`h${i + 1}`, 'no-go', { kind: 'user' });
      advance(1000);
    }
    expect((await refusal(ask({ name: 'late' }))).code).toBe('rate_limited');
    advance(RELIEF_RATE_WINDOW_MS - RELIEF_RATE_MAX * 1000 - 1);
    expect((await refusal(ask({ name: 'late' }))).code).toBe('rate_limited');
    advance(1000);
    await ask({ name: 'late' });
  });

  it('a refused request does not use up the rate limit', async () => {
    for (let i = 0; i < RELIEF_RATE_MAX * 2; i += 1) await refusal(ask({ mode: 'bypassPermissions' }));
    await ask();
  });

  it('expires: it is gone, the boss is told once, and a late GO finds nothing', async () => {
    await ask();
    advance(RELIEF_TTL_MS - 1);
    expect(relief.view().requests).toHaveLength(1);
    advance(2);
    expect(relief.view().requests).toEqual([]);
    expect(frames.at(-1)).toEqual({ t: 'relief', relief: { requests: [] } });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ to: 'flight', subject: 'Relief: request for guido-1 expired' });
    expect(events.at(-1)).toEqual(['relief', 'request to hire guido-1 expired unanswered']);
    expect((await refusal(relief.decide('h1', 'go', { kind: 'user' }))).code).toBe('not_found');
    expect(hired).toEqual([]);
  });

  it('expires without its timer too: the next call looks at the clock', async () => {
    await ask();
    now += RELIEF_TTL_MS;
    expect((await refusal(relief.decide('h1', 'go', { kind: 'user' }))).code).toBe('not_found');
    expect(hired).toEqual([]);
    expect(told).toHaveLength(1);
    await ask();
  });

  it('close clears the timers and the requests', async () => {
    await ask();
    relief.close();
    expect(timers.every((t) => !t.live)).toBe(true);
    expect(relief.view().requests).toEqual([]);
  });
});

describe('the folder', () => {
  it('passes the check of the hire form: absolute, there, a directory', async () => {
    expect((await refusal(ask({ dir: 'relative/path' }))).field).toBe('dir');
    expect((await refusal(ask({ dir: join(root, 'missing') }))).message).toMatch(/does not exist/);
    expect((await refusal(ask({ dir: join(root, 'project', '..', 'nope') }))).field).toBe('dir');
    expect((await refusal(ask({ dir: '' }))).field).toBe('dir');
    expect((await refusal(ask({ dir: 'x'.repeat(1025) }))).field).toBe('dir');
    expect((await refusal(relief.request(BOSS, { name: 'ana', role: 'r' }))).field).toBe('dir');
    expect((await refusal(ask({ dir: 5 }))).field).toBe('dir');
  });

  it('is asked of the very check that the form uses', async () => {
    const seen: string[] = [];
    relief = make({ checkDirectory: async (p) => (seen.push(p), { ok: true, path: p }) });
    await ask();
    expect(seen).toEqual([project]);
  });
});

describe('a worktree asked for in the request (the Own git worktree box of the form)', () => {
  const git = async (dir: string): Promise<string | null> => (dir.endsWith('plain') ? `${dir} is not in a git repository` : null);

  it('is true or false, shown in the request, checked like the form (the folder must be in a git repository), and applied at the hire', async () => {
    const checked: string[] = [];
    relief = make({ checkWorktree: async (dir) => (checked.push(dir), git(dir)) });
    await relief.request(BOSS, { name: 'ana', role: 'r', dir: project, worktree: true });
    await relief.request(BOSS, { name: 'ben', role: 'r', dir: project, worktree: false });
    await relief.request(BOSS, { name: 'cat', role: 'r', dir: project });
    expect(relief.view().requests.map((r) => [r.name, r.worktree ?? null])).toEqual([['ana', {}], ['ben', null], ['cat', null]]);
    expect(checked).toEqual([project]); // only when it is asked for
    expect(events[0]?.[1]).toBe(`flight asks to hire ana: claude, default, ${project}, in its own git worktree`);
    expect(events[1]?.[1]).not.toContain('worktree');
    await relief.decide('h1', 'go', { kind: 'user' });
    await relief.decide('h2', 'go', { kind: 'user' });
    expect(hired[0]).toMatchObject({ name: 'ana', worktree: {} });
    expect(hired[1]).not.toHaveProperty('worktree');
  });

  it('is refused at the request, with the field named, for a folder outside a git repository, a value that is not true or false, and a Clean Room boss; nothing waits', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    relief = make({ checkWorktree: git });
    const e1 = await refusal(relief.request(BOSS, { name: 'ana', role: 'r', dir: plain, worktree: true }));
    expect([e1.code, e1.field]).toEqual(['bad_request', 'worktree']);
    expect(e1.message).toMatch(/not in a git repository/);
    for (const bad of ['yes', 1, {}, null, ['x']]) {
      const e = await refusal(relief.request(BOSS, { name: 'ben', role: 'r', dir: project, worktree: bad }));
      expect([e.code, e.field], JSON.stringify(bad)).toEqual(['bad_request', 'worktree']);
    }
    const box = join(root, 'box2');
    await mkdir(box);
    views = [{ ...flight(), dir: box, cleanRoom: { image: 'img:1' } }];
    const e2 = await refusal(relief.request(BOSS, { name: 'cat', role: 'r', worktree: true }));
    expect([e2.code, e2.field]).toEqual(['bad_request', 'worktree']);
    expect(e2.message).toMatch(/Clean Room agent has a worktree already/);
    expect(relief.view().requests).toEqual([]);
    // a check that throws is a refusal too, not a request the Director cannot grant
    relief = make({ checkWorktree: async () => { throw new Error('boom'); } });
    expect((await refusal(relief.request(BOSS, { name: 'dan', role: 'r', dir: project, worktree: true }))).field).toBe('worktree');
  });

  it('a hire that fails at GO (the folder is no longer a repository) tells the Director why, as for any hire', async () => {
    relief = make({ checkWorktree: async () => null });
    await relief.request(BOSS, { name: 'ana', role: 'r', dir: project, worktree: true });
    hireError = new HubError('bad_request', 'a worktree needs a git repository', 'worktree');
    await expect(relief.decide('h1', 'go', { kind: 'user' })).rejects.toThrow(/git repository/);
  });
});

describe('a Clean Room boss', () => {
  let box: string;
  beforeEach(async () => {
    box = join(root, 'box');
    await mkdir(join(box, 'sub'), { recursive: true });
    views = [{ ...flight(), dir: box, cleanRoom: { image: 'img:1' } }];
  });

  it('shows the sandbox flavor the new agent gets (the boss\'s own, else the room\'s default) and says when that is below the room\'s default; notes it in the Downlink', async () => {
    relief = make({ defaultSandbox: () => 'gvisor' });
    views = [{ ...flight(), dir: box, cleanRoom: {} }];
    await relief.request(BOSS, { name: 'ana', role: 'r' }); // boss has no flavor: the room's
    views = [{ ...flight(), dir: box, cleanRoom: { flavor: 'docker' } }];
    await relief.request(BOSS, { name: 'ben', role: 'r' }); // the boss's own is weaker than the room's
    views = [{ ...flight(), dir: box, cleanRoom: { flavor: 'microvm' } }];
    await relief.request(BOSS, { name: 'cat', role: 'r' });
    expect(relief.view().requests.map((r) => [r.flavor, r.flavorBelowRoom])).toEqual([['gvisor', undefined], ['docker', true], ['microvm', undefined]]);
    expect(events.filter(([, t]) => t.includes('Clean Room sandbox')).map(([, t]) => t.replace(/^.*Clean Room sandbox /, ''))).toEqual(['gvisor', "docker (below the room's default)", 'microvm']);
    relief = make({ defaultSandbox: () => 'gvisor' });
    views = [flight()];
    await relief.request(BOSS, { name: 'dan', role: 'r', dir: project });
    expect(relief.view().requests.at(-1)).not.toHaveProperty('flavor');
  });

  it('hires Clean Room agents in its own folder, by default there', async () => {
    await relief.request(BOSS, { name: 'ana', role: 'r' });
    await relief.request(BOSS, { name: 'ben', role: 'r', dir: join(box, 'sub') });
    expect(relief.view().requests.map((r) => [r.dir, r.cleanRoom])).toEqual([
      [box, { image: 'img:1' }],
      [join(box, 'sub'), { image: 'img:1' }],
    ]);
    await relief.decide('h1', 'go', { kind: 'user' });
    expect(hired[0]).toMatchObject({ cleanRoom: { image: 'img:1' }, dir: box });
  });

  it('cannot hire outside its box: another folder, the parent, a prefix twin, a ".." path', async () => {
    await mkdir(join(root, 'box-evil'));
    for (const dir of [project, root, join(root, 'box-evil'), join(box, '..', 'project'), join(box, 'sub', '..', '..')]) {
      const error = await refusal(relief.request(BOSS, { name: 'ana', role: 'r', dir }));
      expect(error.code, dir).toBe('forbidden');
      expect(error.field).toBe('dir');
    }
    expect(relief.view().requests).toEqual([]);
  });

  it('cannot hire outside its box through a symbolic link that points out', async () => {
    await symlink(project, join(box, 'way-out'));
    await symlink(root, join(box, 'sub', 'up'));
    for (const dir of [join(box, 'way-out'), join(box, 'sub', 'up'), join(box, 'sub', 'up', 'project')]) {
      expect((await refusal(relief.request(BOSS, { name: 'ana', role: 'r', dir }))).code, dir).toBe('forbidden');
    }
  });

  it('a symbolic link that stays inside is fine', async () => {
    await symlink(join(box, 'sub'), join(box, 'shortcut'));
    await relief.request(BOSS, { name: 'ana', role: 'r', dir: join(box, 'shortcut') });
  });

  it('cannot hire an engine that is not Claude Code, because it could not be in a Clean Room', async () => {
    expect((await refusal(relief.request(BOSS, { name: 'ana', role: 'r', engine: 'gemini' }))).field).toBe('engine');
    await relief.request(BOSS, { name: 'ana', role: 'r', engine: 'claude' });
  });

  it('looks at the box again at the GO: a folder that became a link out is refused', async () => {
    await mkdir(join(box, 'work'));
    await relief.request(BOSS, { name: 'ana', role: 'r', dir: join(box, 'work') });
    await rm(join(box, 'work'), { recursive: true });
    await symlink(project, join(box, 'work'));
    expect((await refusal(relief.decide('h1', 'go', { kind: 'user' }))).code).toBe('forbidden');
    expect(hired).toEqual([]);
    expect(told[0]).toMatchObject({ subject: 'Relief: ana could not be hired' });
  });

  it('a boss that became a Clean Room agent after it asked cannot get a host agent through the GO', async () => {
    views = [flight()];
    await relief.request(BOSS, { name: 'ana', role: 'r', dir: project });
    views = [{ ...flight(), dir: box, cleanRoom: {} }];
    expect((await refusal(relief.decide('h1', 'go', { kind: 'user' }))).code).toBe('forbidden');
    expect(hired).toEqual([]);
    expect(told[0]).toMatchObject({ subject: 'Relief: ana could not be hired' });
  });

  it('insideRealpath: the root itself, a child, a twin, a missing folder', async () => {
    expect(await insideRealpath(box, box)).toBe(true);
    expect(await insideRealpath(box, join(box, 'sub'))).toBe(true);
    expect(await insideRealpath(box, root)).toBe(false);
    expect(await insideRealpath(box, join(box, 'missing'))).toBe(false);
    expect(await insideRealpath(join(root, 'missing'), box)).toBe(false);
  });
});

describe('the Director answers', () => {
  it('GO hires through the hire of the form, once, and tells the boss', async () => {
    await ask({ mode: 'acceptEdits' });
    const answered = await relief.decide('h1', 'go', { kind: 'user' });
    expect(answered.requests).toEqual([]);
    expect(hired).toHaveLength(1);
    expect(views.map((v) => v.name)).toEqual(['flight', 'guido-1']);
    expect(told).toEqual([{ to: 'flight', subject: 'Relief: guido-1 is staffed', body: `The Director said go. guido-1 is hired in ${project} and starting. Brief it with send_message.` }]);
    expect(events.at(-1)).toEqual(['relief', 'guido-1 hired (asked by flight)']);
    expect(frames.at(-1)).toEqual({ t: 'relief', relief: { requests: [] } });
  });

  it('NO-GO hires nobody and tells the boss', async () => {
    await ask();
    await relief.decide('h1', 'no-go', { kind: 'user' });
    expect(hired).toEqual([]);
    expect(told[0]).toMatchObject({ to: 'flight', subject: 'Relief: request for guido-1 refused' });
    expect(events.at(-1)).toEqual(['relief', 'hire of guido-1 refused']);
  });

  it('the boss cannot approve, or refuse, its own request, nor can another agent', async () => {
    await ask();
    for (const by of [{ kind: 'agent', name: 'flight' }, { kind: 'agent', name: 'ana' }, { kind: 'agent', name: 'user' }, { kind: 'x' }, null, undefined] as never[]) {
      const error = await refusal(relief.decide('h1', 'go', by));
      expect(error.code, JSON.stringify(by)).toBe('forbidden');
    }
    expect(await refusal(relief.decide('h1', 'no-go', { kind: 'agent', name: 'flight' }))).toBeInstanceOf(HubError);
    expect(hired).toEqual([]);
    expect(relief.view().requests).toHaveLength(1);
    expect(told).toEqual([]);
  });

  it('two GOs at once hire once', async () => {
    await ask();
    const [a, b] = await Promise.allSettled([relief.decide('h1', 'go', { kind: 'user' }), relief.decide('h1', 'go', { kind: 'user' })]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(hired).toHaveLength(1);
  });

  it('an id that is not one, or is gone, is not found, and a verdict that is not one is refused', async () => {
    await ask();
    for (const id of ['h2', 'h0', 'x', '', 'h1 ', 'h01', '../h1', 'H1']) expect((await refusal(relief.decide(id, 'go', { kind: 'user' }))).code, id).toBe('not_found');
    expect((await refusal(relief.decide('h1', 'maybe' as never, { kind: 'user' }))).code).toBe('bad_request');
    expect(relief.view().requests).toHaveLength(1);
  });

  it('a hire that fails for another reason leaves no request, a message and an error, and no secret', async () => {
    await ask();
    hireError = new HubError('bad_request', 'directory does not exist: /gone', 'dir');
    expect((await refusal(relief.decide('h1', 'go', { kind: 'user' }))).message).toBe('directory does not exist: /gone');
    expect(told[0]?.body).toBe('The Director said go, but the hire failed: directory does not exist: /gone.');
    expect(relief.view().requests).toEqual([]);
    hireError = new Error('ENOSPC: /secret/path/token=abc');
    await ask({ name: 'second' });
    await relief.decide('h2', 'go', { kind: 'user' }).catch(() => undefined);
    expect(told[1]?.body).toBe('The Director said go, but the hire failed: an internal error.');
    expect(events.at(-1)?.[1]).not.toContain('secret');
  });

  it('a message to the boss that cannot be sent does not stop the answer', async () => {
    relief = make({
      hub: {
        ...fakeHub(),
        sendFromUser: () => {
          throw new HubError('bad_request', 'there is no boss');
        },
      },
    });
    await ask();
    await relief.decide('h1', 'go', { kind: 'user' });
    expect(hired).toHaveLength(1);
  });
});
