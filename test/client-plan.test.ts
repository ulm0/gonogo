import { describe, expect, it } from 'vitest';
import { TASK_DETAIL_MAX_CHARS, TASK_TITLE_MAX_CHARS } from '../src/shared/protocol.js';
import type { AgentView, Task } from '../src/shared/protocol.js';
import { activeOf, activeText, assigneeText, assignees, cardId, columnsOf, COLUMNS, emptyValues, labelOf, ledKindOf, requestOf, validate } from '../src/client/plan.js';

const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, detail: '', status: 'todo', assignee: null, createdBy: 'user', createdAt: 1, updatedAt: 1, notes: [], ...extra });
const agent = (name: string, extra: Partial<AgentView> = {}): AgentView => ({ name, boss: false, provider: 'claude', position: null, state: 'idle', ...extra }) as AgentView;
const room = (...list: AgentView[]): Record<string, AgentView> => Object.fromEntries(list.map((a) => [a.name, a]));

describe('the columns', () => {
  it('are the five statuses, blocked before done', () => {
    expect(COLUMNS.map((c) => c.status)).toEqual(['todo', 'doing', 'review', 'blocked', 'done']);
    expect(labelOf('review')).toBe('REVIEW');
  });

  it('hold the tasks in the order they were made, and the done ones with the newest change first', () => {
    const tasks = [task('t1', { status: 'done', updatedAt: 5 }), task('t2'), task('t3', { status: 'doing' }), task('t4', { status: 'done', updatedAt: 9 }), task('t5')];
    const columns = columnsOf(tasks);
    expect(Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v.map((t) => t.id)]))).toEqual({
      todo: ['t2', 't5'],
      doing: ['t3'],
      review: [],
      blocked: [],
      done: ['t4', 't1'],
    });
    expect(tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });
});

describe('the count of the top bar', () => {
  it('counts the tasks that are doing and the ones that are blocked, and says so in words', () => {
    const tasks = [task('t1', { status: 'doing' }), task('t2', { status: 'doing' }), task('t3', { status: 'blocked' }), task('t4', { status: 'review' }), task('t5', { status: 'done' }), task('t6')];
    expect(activeOf(tasks)).toEqual({ doing: 2, blocked: 1 });
    expect(activeText({ doing: 2, blocked: 1 })).toBe('2 doing, 1 blocked');
    expect(activeText({ doing: 0, blocked: 3 })).toBe('3 blocked');
    expect(activeText({ doing: 1, blocked: 0 })).toBe('1 doing');
    expect(activeText(activeOf([task('t1')]))).toBe('');
  });
});

describe('a card', () => {
  const all = room(agent('flight', { boss: true }), agent('ana', { position: 'capcom', state: 'working' }), agent('ben', { state: 'needs_you' }), agent('cat', { state: 'stopped' }));

  it('names its assignee by call sign, FLIGHT for the boss, or UNASSIGNED', () => {
    expect(assigneeText(task('t1'), all)).toBe('UNASSIGNED');
    expect(assigneeText(task('t1', { assignee: 'flight' }), all)).toBe('FLIGHT');
    expect(assigneeText(task('t1', { assignee: 'ana' }), all)).toBe('CAPCOM');
    expect(assigneeText(task('t1', { assignee: 'ben' }), all)).toBe('BEN');
    expect(assigneeText(task('t1', { assignee: 'gone' }), all)).toBe('GONE');
  });

  it('lights the LED of the assignee: lit while it works, saffron when it needs you, dark when it is gone, none for nobody', () => {
    expect(ledKindOf(task('t1'), all)).toEqual({ kind: undefined, on: false, blink: false });
    expect(ledKindOf(task('t1', { assignee: 'ana' }), all)).toEqual({ kind: 'working', on: true, blink: true });
    expect(ledKindOf(task('t1', { assignee: 'ben' }), all)).toEqual({ kind: 'needs', on: true, blink: true });
    expect(ledKindOf(task('t1', { assignee: 'flight' }), all)).toEqual({ kind: 'idle', on: false, blink: false });
    expect(ledKindOf(task('t1', { assignee: 'cat' }), all)).toEqual({ kind: 'stopped', on: false, blink: false });
    expect(ledKindOf(task('t1', { assignee: 'gone' }), all)).toEqual({ kind: 'stopped', on: false, blink: false });
  });

  it('has an id for the element that takes the focus after a move', () => {
    expect(cardId('t12')).toBe('plan-card-t12');
  });
});

describe('who a task can be given to', () => {
  const list = [agent('flight', { boss: true }), agent('ana', { position: 'capcom' }), agent('dev', { provider: 'custom', command: 'sleep 1' })];
  const all = room(...list);

  it('is nobody, then every console that can read mail, the boss included', () => {
    expect(assignees(list, all, null)).toEqual([
      { value: '', label: 'Nobody' },
      { value: 'flight', label: 'FLIGHT' },
      { value: 'ana', label: 'CAPCOM' },
    ]);
  });

  it('keeps the current assignee in the list when it is gone or cannot read mail', () => {
    expect(assignees(list, all, 'ana').map((a) => a.value)).toEqual(['', 'flight', 'ana']);
    expect(assignees(list, all, 'gone').at(-1)).toEqual({ value: 'gone', label: 'gone (not in the room)' });
    expect(assignees(list, all, 'dev').at(-1)).toEqual({ value: 'dev', label: 'dev (cannot read mail)' });
  });
});

describe('the form', () => {
  it('asks for a title of one line and a detail within the limit', () => {
    expect(validate(emptyValues())).toEqual({ title: 'Give it a title.' });
    expect(validate({ title: '  ', detail: '', assignee: '', missionId: '' })).toEqual({ title: 'Give it a title.' });
    expect(validate({ title: 'x'.repeat(TASK_TITLE_MAX_CHARS + 1), detail: '', assignee: '', missionId: '' }).title).toMatch(/^At most 200/);
    expect(validate({ title: 'a\nb', detail: '', assignee: '', missionId: '' }).title).toBe('One line.');
    expect(validate({ title: 'a', detail: 'x'.repeat(TASK_DETAIL_MAX_CHARS + 1), assignee: '', missionId: '' }).detail).toMatch(/^At most 4000/);
    expect(validate({ title: 'x'.repeat(TASK_TITLE_MAX_CHARS), detail: 'y'.repeat(TASK_DETAIL_MAX_CHARS), assignee: 'ana', missionId: '' })).toEqual({});
  });

  it('sends the title and detail trimmed, and nobody as null', () => {
    expect(requestOf({ title: ' Write it ', detail: ' one page ', assignee: '', missionId: '' })).toEqual({ title: 'Write it', detail: 'one page', assignee: null });
    expect(requestOf({ title: 'a', detail: '', assignee: 'ana', missionId: '' })).toEqual({ title: 'a', detail: '', assignee: 'ana' });
  });
});
