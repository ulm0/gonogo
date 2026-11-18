import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MISSION_GOAL_MAX_CHARS, MISSION_NAME_MAX_CHARS, MISSIONS_OPEN_MAX } from '../src/shared/protocol.js';
import type { AgentSendRequest, Logger, Mission, SendResult, Task } from '../src/shared/protocol.js';
import { MISSION_NOTES_MAX, MISSIONS_DONE_KEEP } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { createMissions } from '../src/server/missions.js';
import type { MissionActor, Missions } from '../src/server/missions.js';
import { createTasks } from '../src/server/tasks.js';
import type { Tasks } from '../src/server/tasks.js';

const USER: MissionActor = { kind: 'user' };
const FLIGHT: MissionActor = { kind: 'agent', name: 'flight', generation: 2 };
let dir: string;
let now: number;
let sent: Array<{ actor: unknown; request: AgentSendRequest }>;
let emitted: Mission[][];
let posted: Array<[string, string]>;
let logs: string[];
let answer: (request: AgentSendRequest) => SendResult;
let boss: string | null;
const open: Array<{ close(): Promise<void> }> = [];

const quiet = (sink: string[]): Logger => {
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: (m) => void sink.push(m), error: (m, ...e) => void sink.push([m, ...e.map(String)].join(' ')), child: () => log };
  return log;
};

/** The two stores joined the way cli.ts joins them. */
function make(): { tasks: Tasks; missions: Missions } {
  let missions: Missions | null = null;
  const tasks = createTasks({
    dir,
    now: () => now,
    isAgent: (n) => ['ana', 'ben', 'flight'].includes(n),
    hasMission: (id) => missions?.has(id) ?? false,
    afterChange: (list) => missions?.observe(list),
    send: () => ({ ok: true, id: 'm0', to: 'x', status: 'queued', note: null }),
    emit: () => undefined,
    log: quiet(logs),
  });
  missions = createMissions({
    dir,
    now: () => now,
    isAgent: (n) => ['ana', 'ben', 'flight'].includes(n),
    boss: () => boss,
    tasks: () => tasks.list(),
    unlink: (id) => tasks.unlinkMission(id),
    send: (actor, request) => {
      sent.push({ actor, request });
      return answer(request);
    },
    emit: (list) => void emitted.push(list),
    notify: (kind, text) => void posted.push([kind, text]),
    log: quiet(logs),
  });
  open.push(tasks, missions);
  return { tasks, missions };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-missions-'));
  now = Date.UTC(2026, 10, 18, 14, 3);
  sent = [];
  emitted = [];
  posted = [];
  logs = [];
  boss = 'flight';
  answer = (request) => ({ ok: true, id: 'm1', to: request.to, status: 'queued', note: null });
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  await rm(dir, { recursive: true, force: true });
});

const fails = async (run: Promise<unknown>, code: string, field?: string): Promise<HubError> => {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HubError);
  expect(error).toMatchObject({ code, ...(field === undefined ? {} : { field }) });
  return error as HubError;
};

describe('the store', () => {
  it('makes a planned mission with the boss as lead and a history line by the real actor', async () => {
    const { missions } = make();
    const made = await missions.create(USER, { name: ' Ship 0.2 ', goal: 'all green' });
    expect(made).toMatchObject({ id: 'ms1', name: 'Ship 0.2', goal: 'all green', status: 'planned', lead: 'flight', createdBy: 'user', startedAt: null, endedAt: null });
    expect(made.history).toEqual(['2026-11-18 14:03 UTC Director: created; lead flight']);
    const byBoss = await missions.create(FLIGHT, { name: 'Second', lead: 'ana' });
    expect(byBoss).toMatchObject({ id: 'ms2', createdBy: 'flight', lead: 'ana' });
    expect(byBoss.history[0]).toBe('2026-11-18 14:03 UTC flight: created; lead ana');
    expect(emitted).toHaveLength(2);
    expect((await missions.create(USER, { name: 'No boss', lead: null })).lead).toBeNull();
  });

  it('checks every field and names the bad one', async () => {
    const { missions } = make();
    await fails(missions.create(USER, null), 'bad_request');
    await fails(missions.create(USER, {}), 'bad_request', 'name');
    await fails(missions.create(USER, { name: 'a\nb' }), 'bad_request', 'name');
    await fails(missions.create(USER, { name: 'x'.repeat(MISSION_NAME_MAX_CHARS + 1) }), 'bad_request', 'name');
    await fails(missions.create(USER, { name: 'x', goal: 'g'.repeat(MISSION_GOAL_MAX_CHARS + 1) }), 'bad_request', 'goal');
    await fails(missions.create(USER, { name: 'x', lead: 'nobody' }), 'bad_request', 'lead');
    await fails(missions.create(USER, { name: 'x', createdBy: 'flight' }), 'bad_request', 'createdBy');
    await fails(missions.create(USER, { name: 'x', status: 'active' }), 'bad_request', 'status');
    const made = await missions.create(USER, { name: 'x' });
    await fails(missions.update(USER, made.id, {}), 'bad_request');
    await fails(missions.update(USER, made.id, { status: 'finished' }), 'bad_request', 'status');
    await fails(missions.update(USER, made.id, { note: '' }), 'bad_request', 'note');
    await fails(missions.update(USER, 'ms99', { note: 'x' }), 'not_found');
    await fails(missions.update(USER, 'nope', { note: 'x' }), 'not_found');
  });

  it('moves between any two statuses, sets startedAt and endedAt, and writes nothing for a change that changes nothing', async () => {
    const { missions } = make();
    const made = await missions.create(USER, { name: 'x' });
    now += 60_000;
    const active = await missions.update(USER, made.id, { status: 'active', note: 'kicked off' });
    expect(active).toMatchObject({ status: 'active', startedAt: now, endedAt: null, updatedAt: now });
    expect(active.history.at(-1)).toBe('2026-11-18 14:04 UTC Director: status active; kicked off');
    now += 60_000;
    const done = await missions.update(USER, made.id, { status: 'done' });
    expect(done).toMatchObject({ status: 'done', endedAt: now, startedAt: now - 60_000 });
    const again = await missions.update(USER, made.id, { status: 'active' });
    expect(again).toMatchObject({ endedAt: null, startedAt: now });
    const writes = emitted.length;
    expect(await missions.update(USER, made.id, { status: 'active' })).toMatchObject({ id: made.id });
    expect(emitted).toHaveLength(writes);
  });

  it('lets the boss change the status and add notes, and only the Director edit the name, goal or lead', async () => {
    const { missions } = make();
    const made = await missions.create(USER, { name: 'x' });
    expect(await missions.update(FLIGHT, made.id, { status: 'paused', note: 'waiting on review' })).toMatchObject({ status: 'paused' });
    await fails(missions.update(FLIGHT, made.id, { name: 'y' }), 'forbidden', 'name');
    await fails(missions.update(FLIGHT, made.id, { goal: 'y' }), 'forbidden', 'goal');
    await fails(missions.update(FLIGHT, made.id, { lead: 'ana' }), 'forbidden', 'lead');
    expect(await missions.update(USER, made.id, { name: 'y', goal: 'z', lead: 'ana' })).toMatchObject({ name: 'y', goal: 'z', lead: 'ana' });
  });

  it('never reuses an id, also after a restart', async () => {
    const first = make();
    await first.missions.create(USER, { name: 'a' });
    const b = await first.missions.create(USER, { name: 'b' });
    await first.missions.remove(b.id, false);
    await first.missions.close();
    const second = make();
    await second.missions.load();
    expect(second.missions.list().map((m) => m.id)).toEqual(['ms1']);
    expect((await second.missions.create(USER, { name: 'c' })).id).toBe('ms3');
    expect((await stat(join(dir, 'missions.json'))).mode & 0o777).toBe(0o600);
  });

  it('keeps an unreadable file as .bad and skips one bad record', async () => {
    await writeFile(join(dir, 'missions.json'), '{ nope');
    const broken = make();
    await broken.missions.load();
    expect(broken.missions.list()).toEqual([]);
    expect(await readFile(join(dir, 'missions.json.bad'), 'utf8')).toBe('{ nope');
    const good = { id: 'ms4', name: 'ok', goal: '', status: 'active', lead: 'ana', createdBy: 'user', createdAt: 1, updatedAt: 1, startedAt: 1, endedAt: null, history: ['x'] };
    await writeFile(join(dir, 'missions.json'), JSON.stringify({ version: 1, seq: 2, missions: [good, { id: 'bad', name: 'x' }, { ...good, id: 'ms5', status: 'nope' }, { ...good }] }));
    const loaded = make();
    await loaded.missions.load();
    expect(loaded.missions.list().map((m) => m.id)).toEqual(['ms4']);
    expect(logs.some((l) => l.includes('a mission was skipped'))).toBe(true);
    expect((await loaded.missions.create(USER, { name: 'next' })).id).toBe('ms5');
  });

  it('caps the unfinished missions, and trims the finished ones to the newest', async () => {
    const { missions } = make();
    for (let i = 0; i < MISSIONS_OPEN_MAX; i++) await missions.create(USER, { name: `m${i}` });
    await fails(missions.create(USER, { name: 'one more' }), 'conflict', 'missions');
    await missions.update(USER, 'ms1', { status: 'done' });
    await missions.create(USER, { name: 'fits now' });
  });

  it('trims the finished missions to the newest', async () => {
    const many = make();
    for (let i = 0; i < MISSIONS_DONE_KEEP + 3; i++) {
      now += 1000;
      const m = await many.missions.create(USER, { name: `f${i}` });
      await many.missions.update(USER, m.id, { status: 'aborted' });
    }
    expect(many.missions.list().filter((m) => m.status === 'aborted')).toHaveLength(MISSIONS_DONE_KEEP);
  });

  it('keeps the newest history lines only', async () => {
    const { missions } = make();
    const made = await missions.create(USER, { name: 'x' });
    for (let i = 0; i < MISSION_NOTES_MAX + 5; i++) await missions.update(USER, made.id, { note: `n${i}` });
    const history = missions.list()[0]!.history;
    expect(history).toHaveLength(MISSION_NOTES_MAX);
    expect(history.at(-1)).toContain(`n${MISSION_NOTES_MAX + 4}`);
  });
});

describe('tasks and missions', () => {
  it('links a task by missionId, refuses an unknown id, and null unlinks', async () => {
    const { tasks, missions } = make();
    await fails(tasks.create(USER, { title: 't', missionId: 'ms1' }), 'bad_request', 'missionId');
    const m = await missions.create(USER, { name: 'x' });
    const t = await tasks.create(USER, { title: 't', missionId: m.id });
    expect(t.missionId).toBe(m.id);
    expect(t.notes[0]).toContain(`mission ${m.id}`);
    await fails(tasks.create(USER, { title: 't', missionId: null }), 'bad_request', 'missionId');
    await fails(tasks.update(USER, t.id, { missionId: 'ms42' }), 'bad_request', 'missionId');
    await fails(tasks.update(USER, t.id, { missionId: 7 }), 'bad_request', 'missionId');
    const free = await tasks.update(USER, t.id, { missionId: null });
    expect(free.missionId).toBeUndefined();
    expect(free.notes.at(-1)).toContain('unlinked from its mission');
    const other = await tasks.create(USER, { title: 'u' });
    expect((await tasks.update(USER, other.id, { missionId: m.id })).missionId).toBe(m.id);
  });

  it('removes a mission only with unlink when it has tasks, and the tasks stay unlinked on the board', async () => {
    const { tasks, missions } = make();
    const m = await missions.create(USER, { name: 'x' });
    const t = await tasks.create(USER, { title: 't', missionId: m.id });
    await fails(missions.remove(m.id, false), 'conflict', 'unlink');
    expect(missions.list()).toHaveLength(1);
    await missions.remove(m.id, true);
    expect(missions.list()).toEqual([]);
    const after = tasks.list().find((x) => x.id === t.id)!;
    expect(after.missionId).toBeUndefined();
    expect(after.notes.at(-1)).toContain('mission ms1 was removed');
    const empty = await missions.create(USER, { name: 'no tasks' });
    await missions.remove(empty.id, false);
    await fails(missions.remove('ms77', false), 'not_found');
  });

  it('keeps a missionId over a restart', async () => {
    const first = make();
    const m = await first.missions.create(USER, { name: 'x' });
    await first.tasks.create(USER, { title: 't', missionId: m.id });
    await first.tasks.close();
    await first.missions.close();
    const second = make();
    await second.tasks.load();
    expect(second.tasks.list()[0]!.missionId).toBe('ms1');
  });
});

describe('the briefing and the events', () => {
  it('briefs the boss once when a mission becomes active, with the goal and the open tasks', async () => {
    const { tasks, missions } = make();
    const m = await missions.create(USER, { name: 'Ship 0.2', goal: 'all green' });
    await tasks.create(USER, { title: 'Write docs', assignee: 'ana', missionId: m.id });
    const done = await tasks.create(USER, { title: 'Old', missionId: m.id });
    await tasks.update(USER, done.id, { status: 'done' });
    await missions.update(USER, m.id, { status: 'active' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.actor).toEqual(USER);
    expect(sent[0]!.request).toMatchObject({ to: 'flight', subject: 'Mission: Ship 0.2' });
    expect(sent[0]!.request.body).toContain('all green');
    expect(sent[0]!.request.body).toContain('t1 [todo] Write docs (ana)');
    expect(sent[0]!.request.body).not.toContain('Old');
    await missions.update(USER, m.id, { status: 'paused' });
    await missions.update(USER, m.id, { note: 'a note' });
    expect(sent).toHaveLength(1);
    expect(posted).toEqual([['mission', 'Mission started: Ship 0.2']]);
  });

  it('does not brief the boss about its own start, and turns a refusal into a history note', async () => {
    const { missions } = make();
    const a = await missions.create(USER, { name: 'a' });
    await missions.update(FLIGHT, a.id, { status: 'active' });
    expect(sent).toEqual([]);
    answer = (request) => ({ ok: false, id: '', to: request.to, status: 'undelivered', note: 'flight is on hold' });
    const b = await missions.create(USER, { name: 'b' });
    const started = await missions.update(USER, b.id, { status: 'active' });
    expect(started.status).toBe('active');
    expect(started.history.some((l) => l.includes('the briefing to flight was not delivered: flight is on hold'))).toBe(true);
    boss = null;
    const c = await missions.create(USER, { name: 'c' });
    await missions.update(USER, c.id, { status: 'active' });
    expect(sent).toHaveLength(1);
  });

  it('tells the Director when a mission ends, and once when its last open task is done, and never closes it by itself', async () => {
    const { tasks, missions } = make();
    const m = await missions.create(USER, { name: 'Ship' });
    const t1 = await tasks.create(USER, { title: 'a', missionId: m.id });
    const t2 = await tasks.create(USER, { title: 'b', missionId: m.id });
    await missions.update(USER, m.id, { status: 'active' });
    posted.length = 0;
    await tasks.update(USER, t1.id, { status: 'done' });
    expect(posted).toEqual([]);
    await tasks.update(USER, t2.id, { status: 'done' });
    expect(posted).toEqual([['mission', 'All 2 tasks of Ship are done: close it?']]);
    await tasks.update(USER, t2.id, { note: 'again' });
    expect(posted).toHaveLength(1);
    expect(missions.list()[0]!.status).toBe('active');
    const reopened = await tasks.update(USER, t2.id, { status: 'doing' });
    await tasks.update(USER, reopened.id, { status: 'done' });
    expect(posted).toHaveLength(2);
    posted.length = 0;
    await missions.update(USER, m.id, { status: 'done' });
    expect(posted).toEqual([['mission', 'Mission done: Ship (2 of 2 tasks done)']]);
  });

  it('still announces the last open task after a restart, once observe has seen the loaded tasks', async () => {
    const first = make();
    const m = await first.missions.create(USER, { name: 'Ship' });
    await first.tasks.create(USER, { title: 'a', missionId: m.id });
    await first.tasks.create(USER, { title: 'b', missionId: m.id });
    await first.missions.update(USER, m.id, { status: 'active' });
    await first.tasks.close();
    await first.missions.close();
    const again = make();
    await again.tasks.load();
    await again.missions.load();
    again.missions.observe(again.tasks.list());
    posted.length = 0;
    await again.tasks.update(USER, 't1', { status: 'done' });
    await again.tasks.update(USER, 't2', { status: 'done' });
    expect(posted).toEqual([['mission', 'All 2 tasks of Ship are done: close it?']]);
  });

  it('misses it without that look: the first change after a restart only counts', async () => {
    const first = make();
    const m = await first.missions.create(USER, { name: 'Ship' });
    await first.tasks.create(USER, { title: 'a', missionId: m.id });
    await first.missions.update(USER, m.id, { status: 'active' });
    await first.tasks.close();
    await first.missions.close();
    const again = make();
    await again.tasks.load();
    await again.missions.load();
    posted.length = 0;
    await again.tasks.update(USER, 't1', { status: 'done' });
    expect(posted).toEqual([]);
  });

  it('says nothing for a paused mission, or one with no tasks', async () => {
    const { tasks, missions } = make();
    const m = await missions.create(USER, { name: 'Quiet' });
    await missions.update(USER, m.id, { status: 'active' });
    const t = await tasks.create(USER, { title: 'a' });
    await tasks.update(USER, t.id, { status: 'done' });
    expect(posted.filter(([, text]) => text.includes('close it'))).toEqual([]);
  });
});
