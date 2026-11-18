import { describe, expect, it } from 'vitest';
import { defaultView } from '../src/shared/livery.js';
import type { ActivityItem, Mission, StateSnapshot, Task } from '../src/shared/protocol.js';
import { MISSION_NAME_MAX_CHARS } from '../src/shared/protocol.js';
import { actionsOf, draftFromBrief, emptyMissionValues, missionOptions, nameOf, progressOf, sortMissions, tasksOf, validateMission } from '../src/client/missions.js';
import { requestOf } from '../src/client/plan.js';
import { commands } from '../src/client/shell.js';
import { applyServerFrame, emptyState, openNewMission, selectMission, showMissions, store } from '../src/client/store.js';
import { currentMission, missionOf } from '../src/client/wall.js';

const mission = (id: string, patch: Partial<Mission> = {}): Mission => ({
  id, name: `Mission ${id}`, goal: '', status: 'planned', lead: 'flight', createdBy: 'user', createdAt: 1, updatedAt: 1, startedAt: null, endedAt: null, history: [], ...patch,
});
const task = (id: string, status: Task['status'], missionId?: string): Task => ({ id, title: id, detail: '', status, assignee: null, createdBy: 'user', createdAt: 1, updatedAt: 1, notes: [], ...(missionId === undefined ? {} : { missionId }) });
const brief = (id: string, at: number, subject = 'Brief', body = 'Add CSV export'): ActivityItem => ({ id, from: 'user', to: 'flight', subject, body, at, status: 'delivered' }) as ActivityItem;

describe('progress', () => {
  it('counts the tasks that serve the mission, done out of all, and says so when there are none', () => {
    const tasks = [task('t1', 'done', 'ms1'), task('t2', 'doing', 'ms1'), task('t3', 'done'), task('t4', 'done', 'ms2')];
    expect(progressOf(tasks, 'ms1')).toEqual({ done: 1, total: 2, text: '1 / 2' });
    expect(progressOf(tasks, 'ms2').text).toBe('1 / 1');
    expect(progressOf(tasks, 'ms9')).toEqual({ done: 0, total: 0, text: 'no tasks' });
    expect(tasksOf(tasks, 'ms1').map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('the keys of a status', () => {
  it('offers START, DONE and ABORT to a planned mission, and only what changes something', () => {
    expect(actionsOf('planned').map((a) => a.label)).toEqual(['START', 'DONE', 'ABORT']);
    expect(actionsOf('active').map((a) => a.label)).toEqual(['PAUSE', 'DONE', 'ABORT']);
    expect(actionsOf('paused').map((a) => [a.label, a.to])).toEqual([['RESUME', 'active'], ['DONE', 'done'], ['ABORT', 'aborted']]);
    expect(actionsOf('done').map((a) => a.label)).toEqual(['REOPEN']);
    expect(actionsOf('aborted').map((a) => a.label)).toEqual(['REOPEN', 'DONE']);
  });
});

describe('the list', () => {
  it('puts active first, then paused and planned, finished last, each newest change first', () => {
    const list = [mission('ms1', { status: 'done', updatedAt: 9 }), mission('ms2', { status: 'planned', updatedAt: 5 }), mission('ms3', { status: 'active', updatedAt: 1 }), mission('ms4', { status: 'paused', updatedAt: 3 }), mission('ms5', { status: 'planned', updatedAt: 8 })];
    expect(sortMissions(list).map((m) => m.id)).toEqual(['ms3', 'ms4', 'ms5', 'ms2', 'ms1']);
  });

  it('offers a task no mission and the unfinished ones, and keeps the one it has even when it is finished or gone', () => {
    const list = [mission('ms1', { status: 'done' }), mission('ms2', { status: 'active' })];
    expect(missionOptions(list, null).map((o) => o.value)).toEqual(['', 'ms2']);
    expect(missionOptions(list, 'ms1').map((o) => o.label)).toEqual(['No mission', 'Mission ms2', 'Mission ms1 (done)']);
    expect(missionOptions(list, 'ms7').at(-1)).toEqual({ value: 'ms7', label: 'ms7 (gone)' });
    expect(nameOf(list, 'ms2')).toBe('Mission ms2');
    expect(nameOf(list, 'ms7')).toBe('ms7');
  });
});

describe('the form', () => {
  it('asks for a name of one line within the limit and a goal within the limit', () => {
    const v = emptyMissionValues();
    expect(validateMission(v, 80, 2000)).toEqual({ name: 'Give it a name.' });
    expect(validateMission({ ...v, name: 'a\nb' }, 80, 2000).name).toBe('One line.');
    expect(validateMission({ ...v, name: 'x'.repeat(81) }, 80, 2000).name).toMatch(/^At most 80/);
    expect(validateMission({ ...v, name: 'ok', goal: 'g'.repeat(2001) }, 80, 2000).goal).toMatch(/^At most 2000/);
    expect(validateMission({ ...v, name: 'ok' }, 80, 2000)).toEqual({});
  });

  it('makes a draft from the brief: the first line is the name, the whole text the goal', () => {
    expect(draftFromBrief('\n  Ship 0.2\nwith the docs', MISSION_NAME_MAX_CHARS)).toEqual({ name: 'Ship 0.2', goal: 'Ship 0.2\nwith the docs' });
    expect(draftFromBrief('x'.repeat(100), 10).name).toBe('xxxxxxxxx…');
    expect(emptyMissionValues({ name: 'n', goal: 'g' })).toEqual({ name: 'n', goal: 'g', lead: '' });
  });

  it('sends a task\'s mission only when it has one', () => {
    expect(requestOf({ title: 'a', detail: '', assignee: '', missionId: '' })).not.toHaveProperty('missionId');
    expect(requestOf({ title: 'a', detail: '', assignee: '', missionId: 'ms1' })).toMatchObject({ missionId: 'ms1' });
  });
});

describe('the mission on the wall', () => {
  it('is none, or the guess from the brief, when no mission is active', () => {
    expect(currentMission([], [], 'flight')).toBeNull();
    expect(currentMission([], [brief('m1', 5)], 'flight')).toEqual({ text: 'Add CSV export', at: 5 });
    expect(currentMission([mission('ms1'), mission('ms2', { status: 'done', startedAt: 9 })], [brief('m1', 5)], 'flight')).toEqual(missionOf([brief('m1', 5)], 'flight'));
  });

  it('is the active mission that started last, and the other takes over when it pauses', () => {
    const a = mission('ms1', { status: 'active', startedAt: 100, name: 'First' });
    const b = mission('ms2', { status: 'active', startedAt: 200, name: 'Second' });
    expect(currentMission([a], [brief('m1', 5)], 'flight')).toEqual({ text: 'First', at: 100, id: 'ms1' });
    expect(currentMission([a, b], [], 'flight')).toEqual({ text: 'Second', at: 200, id: 'ms2' });
    expect(currentMission([a, { ...b, status: 'paused' }], [], 'flight')).toMatchObject({ id: 'ms1' });
  });
});

describe('the store', () => {
  const snapshot = (missions?: Mission[]): StateSnapshot =>
    ({ info: { cwd: '/' }, agents: [], activity: [], poll: null, governor: { limit: null, working: 0, holding: 0 }, tasks: [], ...(missions === undefined ? {} : { missions }), downlink: { unread: 0, items: [] }, livery: defaultView() }) as unknown as StateSnapshot;

  it('takes the list from the state and replaces it at every missions frame; none from an older server', () => {
    const m = mission('ms1');
    const withOne = applyServerFrame(emptyState(), { t: 'state', state: snapshot([m]) }, 1);
    expect(withOne.missions).toEqual([m]);
    expect(applyServerFrame(withOne, { t: 'missions', missions: [{ ...m, status: 'active' }] }, 2).missions[0]!.status).toBe('active');
    expect(applyServerFrame(withOne, { t: 'missions', missions: [] }, 3).missions).toEqual([]);
    expect(applyServerFrame(emptyState(), { t: 'state', state: snapshot() }, 1).missions).toEqual([]);
  });

  it('opens the view from the wall and the brief, with or without a draft, and selects a mission', () => {
    showMissions();
    expect(store.getState()).toMatchObject({ view: 'missions', missionDraft: null });
    openNewMission({ name: 'n', goal: 'g' });
    expect(store.getState()).toMatchObject({ view: 'missions', missionDraft: { name: 'n', goal: 'g' }, selectedMission: null });
    selectMission('ms2');
    expect(store.getState()).toMatchObject({ selectedMission: 'ms2', missionDraft: null });
    selectMission(null);
  });
});

describe('the Patch Panel', () => {
  it('has the Missions view and a New mission action', () => {
    const list = commands({ agents: [], legends: {}, poll: null, unread: 0, livery: defaultView() });
    expect(list.find((c) => c.id === 'view:missions')).toMatchObject({ label: 'Missions', group: 'View' });
    expect(list.find((c) => c.id === 'new-mission')).toMatchObject({ label: 'New mission', group: 'Action', act: { kind: 'new-mission' } });
  });
});
