import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUBJECT_MAX_CHARS, TASK_DETAIL_MAX_CHARS, TASK_NOTE_MAX_CHARS, TASK_TITLE_MAX_CHARS, TASKS_OPEN_MAX } from '../src/shared/protocol.js';
import type { AgentSendRequest, Logger, SendResult, Task } from '../src/shared/protocol.js';
import { TASK_NOTES_MAX, TASKS_DONE_KEEP } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { createTasks } from '../src/server/tasks.js';
import type { Actor, Tasks } from '../src/server/tasks.js';

const MIN = 60_000;
const USER: Actor = { kind: 'user' };
const ANA: Actor = { kind: 'agent', name: 'ana', generation: 3 };
const BEN: Actor = { kind: 'agent', name: 'ben', generation: 1 };
let dir: string;
let now: number;
let sent: Array<{ actor: Actor; request: AgentSendRequest }>;
let emitted: Task[][];
let logs: string[];
let posted: Array<[string, string]>;
let answer: (request: AgentSendRequest) => SendResult;
const open: Tasks[] = [];

const quiet = (sink: string[]): Logger => {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void sink.push(message),
    error: (message, ...extra) => void sink.push([message, ...extra.map(String)].join(' ')),
    child: () => log,
  };
  return log;
};

function make(agents: string[] = ['ana', 'ben', 'flight']): Tasks {
  const t = createTasks({
    dir,
    now: () => now,
    isAgent: (name) => agents.includes(name),
    send: (actor, request) => {
      sent.push({ actor, request });
      return answer(request);
    },
    emit: (list) => void emitted.push(list),
    notify: (kind, text) => void posted.push([kind, text]),
    log: quiet(logs),
  });
  open.push(t);
  return t;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-tasks-'));
  now = Date.UTC(2026, 10, 17, 14, 3);
  sent = [];
  emitted = [];
  logs = [];
  posted = [];
  let n = 0;
  answer = (request) => ({ ok: true, id: `m${++n}`, to: request.to, status: 'queued', note: null });
});

afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  await rm(dir, { recursive: true, force: true });
});

const fails = async (run: Promise<unknown>, code: string, field?: string): Promise<HubError> => {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HubError);
  expect(error).toMatchObject({ code, field });
  return error as HubError;
};

describe('flight plan: make and change', () => {
  it('makes a task that is todo, stamped with who made it and when', async () => {
    const t = make();
    await t.load();
    expect(await t.create(USER, { title: '  Write the spec ', detail: 'one page' })).toEqual({
      id: 't1',
      title: 'Write the spec',
      detail: 'one page',
      status: 'todo',
      assignee: null,
      createdBy: 'user',
      createdAt: now,
      updatedAt: now,
      notes: ['2026-11-17 14:03 UTC Director: created'],
    });
    now += MIN;
    const second = await t.create(ANA, { title: 'Review it' });
    expect(second).toMatchObject({ id: 't2', createdBy: 'ana', detail: '', notes: ['2026-11-17 14:04 UTC ana: created'] });
    expect(t.list().map((x) => x.id)).toEqual(['t1', 't2']);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.map((x) => x.id)).toEqual(['t1', 't2']);
    expect(sent).toEqual([]);
  });

  it('keeps the list as copies: a caller cannot change the board by editing what it was given', async () => {
    const t = make();
    await t.load();
    const made = await t.create(USER, { title: 'a' });
    made.title = 'changed';
    made.notes.push('x');
    t.list()[0]?.notes.push('y');
    expect(t.list()[0]).toMatchObject({ title: 'a', notes: ['2026-11-17 14:03 UTC Director: created'] });
  });

  it('refuses a bad request with the name of the field', async () => {
    const t = make();
    await t.load();
    await fails(t.create(USER, [1]), 'bad_request');
    await fails(t.create(USER, {}), 'bad_request', 'title');
    await fails(t.create(USER, { title: '  ' }), 'bad_request', 'title');
    await fails(t.create(USER, { title: 'two\nlines' }), 'bad_request', 'title');
    await fails(t.create(USER, { title: 'x'.repeat(TASK_TITLE_MAX_CHARS + 1) }), 'bad_request', 'title');
    await fails(t.create(USER, { title: 7 }), 'bad_request', 'title');
    await fails(t.create(USER, { title: 'a', detail: 'x'.repeat(TASK_DETAIL_MAX_CHARS + 1) }), 'bad_request', 'detail');
    await fails(t.create(USER, { title: 'a', detail: 3 }), 'bad_request', 'detail');
    await fails(t.create(USER, { title: 'a', assignee: 'nobody' }), 'bad_request', 'assignee');
    await fails(t.create(USER, { title: 'a', assignee: 'user' }), 'bad_request', 'assignee');
    await fails(t.create(USER, { title: 'a', assignee: 4 }), 'bad_request', 'assignee');
    await fails(t.create(USER, { title: 'a', status: 'doing' }), 'bad_request', 'status');
    expect(t.list()).toEqual([]);
    expect(await t.create(USER, { title: 'x'.repeat(TASK_TITLE_MAX_CHARS), detail: 'y'.repeat(TASK_DETAIL_MAX_CHARS) })).toMatchObject({ id: 't1' });
  });

  it('moves a task, adds a note and writes one history line for the change', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'a' });
    now += MIN;
    const moved = await t.update(ANA, 't1', { status: 'doing', note: ' started\n now ' });
    expect(moved).toMatchObject({ status: 'doing', updatedAt: now, createdAt: now - MIN });
    expect(moved.notes).toEqual(['2026-11-17 14:03 UTC Director: created', '2026-11-17 14:04 UTC ana: status doing; started now']);
    expect(emitted).toHaveLength(2);
  });

  it('writes nothing when a change changes nothing, and refuses an empty one', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'a' });
    now += MIN;
    expect(await t.update(USER, 't1', { status: 'todo', assignee: null })).toMatchObject({ updatedAt: now - MIN });
    expect(emitted).toHaveLength(1);
    await fails(t.update(USER, 't1', {}), 'bad_request');
    await fails(t.update(USER, 't1', { title: 'new' }), 'bad_request', 'title');
    await fails(t.update(USER, 't1', { status: 'finished' }), 'bad_request', 'status');
    await fails(t.update(USER, 't1', { note: '   ' }), 'bad_request', 'note');
    await fails(t.update(USER, 't1', { note: 'x'.repeat(TASK_NOTE_MAX_CHARS + 1) }), 'bad_request', 'note');
    await fails(t.update(USER, 't1', { note: 'a‮b' }), 'bad_request', 'note');
    await fails(t.update(USER, 't2', { status: 'done' }), 'not_found');
    await fails(t.update(USER, '../x', { status: 'done' }), 'not_found');
  });

  it('tells the Downlink when an agent moves a task to blocked or review, and of nothing else', async () => {
    const t = make();
    await t.load();
    await t.create(ANA, { title: 'Write the spec' });
    await t.update(ANA, 't1', { status: 'doing' });
    await t.update(ANA, 't1', { note: 'still going' });
    expect(posted).toEqual([]);
    await t.update(ANA, 't1', { status: 'blocked', note: 'waiting' });
    await t.update(ANA, 't1', { status: 'blocked' });
    await t.update(BEN, 't1', { status: 'review' });
    await t.update(ANA, 't1', { status: 'done' });
    expect(posted).toEqual([
      ['flight-plan', 'ana moved t1 to blocked: Write the spec'],
      ['flight-plan', 'ben moved t1 to review: Write the spec'],
    ]);
    // what the Director moved himself is not news to him
    await t.update(USER, 't1', { status: 'review' });
    await t.update(USER, 't1', { status: 'blocked' });
    expect(posted).toHaveLength(2);
  });

  it('keeps the newest history lines only', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'a' });
    for (let i = 0; i < TASK_NOTES_MAX + 5; i += 1) await t.update(USER, 't1', { note: `n${i}` });
    const notes = t.list()[0]?.notes ?? [];
    expect(notes).toHaveLength(TASK_NOTES_MAX);
    expect(notes.at(-1)).toMatch(/n24$/);
    expect(notes[0]).toMatch(/n5$/);
  });

  it('removes a task and does not use its id again, in this run or the next', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'a' });
    await t.create(USER, { title: 'b' });
    await t.remove('t2');
    await fails(t.remove('t2'), 'not_found');
    expect((await t.create(USER, { title: 'c' })).id).toBe('t3');
    expect(t.list().map((x) => x.id)).toEqual(['t1', 't3']);
    // nor after a restart, when the highest id was the one removed
    await t.remove('t3');
    await t.close();
    const again = make();
    await again.load();
    expect((await again.create(USER, { title: 'd' })).id).toBe('t4');
  });
});

describe('flight plan: assigning sends a message', () => {
  it('tells the assignee from the Director through the normal path', async () => {
    const t = make();
    await t.load();
    const task = await t.create(USER, { title: 'Write the spec', detail: 'one page', assignee: 'ana' });
    expect(task.assignee).toBe('ana');
    expect(task.notes).toEqual(['2026-11-17 14:03 UTC Director: created; assigned to ana']);
    expect(sent).toEqual([
      {
        actor: USER,
        request: { to: 'ana', subject: 'Flight Plan: t1 assigned to you: Write the spec', body: 'one page\n\nAssigned by the Director. Set its status with task_update.' },
      },
    ]);
  });

  it('sends as the agent that assigns, with its generation, and says when there is no detail', async () => {
    const t = make();
    await t.load();
    await t.create(ANA, { title: 'a' });
    await t.update(ANA, 't1', { assignee: 'ben' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.actor).toEqual(ANA);
    expect(sent[0]?.request).toMatchObject({ to: 'ben', subject: 'Flight Plan: t1 assigned to you: a', body: '(no detail)\n\nAssigned by ana. Set its status with task_update.' });
  });

  it('sends only when the assignee changes, and never to the agent that assigns itself', async () => {
    const t = make();
    await t.load();
    await t.create(ANA, { title: 'a', assignee: 'ana' });
    await t.update(ANA, 't1', { assignee: 'ana', note: 'mine' });
    await t.update(USER, 't1', { assignee: null });
    await t.update(USER, 't1', { assignee: null, status: 'doing' });
    expect(sent).toEqual([]);
    expect(t.list()[0]?.notes.at(-1)).toBe('2026-11-17 14:03 UTC Director: status doing');
    await t.update(USER, 't1', { assignee: 'ben' });
    await t.update(USER, 't1', { assignee: 'ben', note: 'again' });
    await t.update(USER, 't1', { assignee: 'ana' });
    expect(sent.map((s) => s.request.to)).toEqual(['ben', 'ana']);
  });

  it('cuts the subject to the limit of a subject', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'x'.repeat(TASK_TITLE_MAX_CHARS), assignee: 'ana' });
    expect(sent[0]?.request.subject).toHaveLength(SUBJECT_MAX_CHARS);
    expect(sent[0]?.request.subject?.startsWith('Flight Plan: t1 assigned to you: xxx')).toBe(true);
  });

  it('keeps the assignment and notes it when the message was made but not delivered', async () => {
    const t = make();
    await t.load();
    answer = (request) => ({ ok: false, id: 'm9', to: request.to, status: 'undelivered', note: 'ben is stopped; the message went to the user' });
    const task = await t.create(ANA, { title: 'a', assignee: 'ben' });
    expect(task.assignee).toBe('ben');
    expect(task.notes.at(-1)).toBe('2026-11-17 14:03 UTC ana: the message to ben was not delivered: ben is stopped; the message went to the user');
  });

  it('changes nothing when the hub refuses the message', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'a' });
    const refuse = (): never => {
      throw new HubError('conflict', 'this session has ended');
    };
    const broken = createTasks({ dir, now: () => now, isAgent: () => true, send: refuse, emit: () => undefined, log: quiet(logs) });
    open.push(broken);
    await broken.load();
    await fails(broken.update(BEN, 't1', { assignee: 'ana', status: 'doing' }), 'conflict');
    await fails(broken.create(BEN, { title: 'b', assignee: 'ana' }), 'conflict');
    expect(broken.list()).toHaveLength(1);
    expect(broken.list()[0]).toMatchObject({ status: 'todo', assignee: null });
    expect((await broken.create(BEN, { title: 'c' })).id).toBe('t2');
  });
});

describe('flight plan: limits', () => {
  it('refuses the 501st open task and lets a done task make room', async () => {
    const t = make();
    await t.load();
    for (let i = 0; i < TASKS_OPEN_MAX; i += 1) await t.create(USER, { title: `t${i}` });
    await fails(t.create(USER, { title: 'one more' }), 'conflict', 'tasks');
    await t.update(USER, 't1', { status: 'done' });
    expect((await t.create(USER, { title: 'one more' })).id).toBe(`t${TASKS_OPEN_MAX + 1}`);
    // t1 is done and the board is full again: it cannot come back
    await fails(t.update(USER, 't1', { status: 'doing' }), 'conflict', 'tasks');
    expect(await t.update(USER, 't1', { note: 'still done' })).toMatchObject({ status: 'done' });
  }, 30_000);

  it('keeps the newest done tasks only', async () => {
    const t = make();
    await t.load();
    for (let i = 0; i < TASKS_DONE_KEEP + 3; i += 1) {
      await t.create(USER, { title: `t${i}` });
      now += 1000;
      await t.update(USER, `t${i + 1}`, { status: 'done' });
    }
    const left = t.list();
    expect(left).toHaveLength(TASKS_DONE_KEEP);
    expect(left[0]?.id).toBe('t4');
    expect(left.at(-1)?.id).toBe(`t${TASKS_DONE_KEEP + 3}`);
  });
});

describe('flight plan: the file', () => {
  const file = (): string => join(dir, 'tasks.json');

  it('writes a version 1 file of mode 0600 after every change, and reads it back with the ids going on', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'a', assignee: 'ana' });
    await t.create(ANA, { title: 'b' });
    await t.update(ANA, 't2', { status: 'review' });
    await t.close();
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file(), 'utf8')) as { version: number; tasks: Task[] };
    expect(saved.version).toBe(1);
    expect(saved.tasks.map((x) => [x.id, x.status])).toEqual([['t1', 'todo'], ['t2', 'review']]);
    const again = make();
    await again.load();
    expect(again.list()).toEqual(saved.tasks);
    expect((await again.create(USER, { title: 'c' })).id).toBe('t3');
  });

  it('starts empty without a file', async () => {
    const t = make();
    await t.load();
    expect(t.list()).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('keeps a file that cannot be read as tasks.json.bad, starts empty and does not log its text', async () => {
    await writeFile(file(), '{"version":1,"tasks":[{"id":"t1","title":"SECRET-TEXT",', { mode: 0o600 });
    const t = make();
    await t.load();
    expect(t.list()).toEqual([]);
    expect(await readFile(`${file()}.bad`, 'utf8')).toContain('SECRET-TEXT');
    expect(logs.join('\n')).toContain('tasks.json could not be read');
    expect(logs.join('\n')).not.toContain('SECRET-TEXT');
    await t.create(USER, { title: 'a' });
    expect(await readFile(`${file()}.bad`, 'utf8')).toContain('SECRET-TEXT');
    await writeFile(file(), '{"version":2,"tasks":[]}');
    await make().load();
    expect(await readFile(`${file()}.bad`, 'utf8')).toContain('"version":2');
  });

  it('skips a bad record with a warning, repairs a loose one and keeps the rest', async () => {
    const good = { id: 't1', title: 'a', detail: 'd', status: 'doing', assignee: 'gone', createdBy: 'ana', createdAt: 5, updatedAt: 6, notes: ['x'] };
    await writeFile(
      file(),
      JSON.stringify({
        version: 1,
        tasks: [
          good,
          { ...good, id: 't1', title: 'twice' },
          { ...good, id: 't2', status: 'finished' },
          { ...good, id: 'x3' },
          { ...good, id: 't4', title: '' },
          'text',
          { id: 't5', title: 'loose', status: 'todo', assignee: 'Bad Name', createdBy: 7, notes: [1, 'ok'] },
        ],
      }),
    );
    const t = make();
    now = 99;
    await t.load();
    expect(t.list()).toEqual([
      good,
      { id: 't5', title: 'loose', detail: '', status: 'todo', assignee: null, createdBy: 'user', createdAt: 99, updatedAt: 99, notes: ['ok'] },
    ]);
    expect(logs.filter((l) => l.includes('a task was skipped'))).toHaveLength(5);
    expect((await t.create(USER, { title: 'n' })).id).toBe('t6');
  });

  it('does not leave a temporary file behind', async () => {
    const t = make();
    await t.load();
    await mkdir(join(dir, 'other'));
    await t.create(USER, { title: 'a' });
    await t.close();
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).sort()).toEqual(['other', 'tasks.json']);
  });
});

describe('flight plan: docking', () => {
  const DOCK: Actor = { kind: 'dock', station: 'lab' };

  it('a task handed over by a station is made as the Director of that station, and its assignee is told so', async () => {
    const t = make();
    await t.load();
    const task = await t.create(DOCK, { title: 'Fix the build', detail: 'Handed off from lab (its task t4).', assignee: 'ana' });
    expect(task).toMatchObject({ id: 't1', createdBy: 'user', assignee: 'ana', status: 'todo' });
    expect(task.notes).toEqual(['2026-11-17 14:03 UTC Director of lab: created; assigned to ana']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.actor).toEqual(DOCK);
    expect(sent[0]?.request.to).toBe('ana');
    expect(sent[0]?.request.body).toContain('Assigned by the Director of lab.');
  });

  it('hands a task off: done here, with the station it went to and a line in its history', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'Move me' });
    now += MIN;
    const moved = await t.handOff('t1', 'lab', 'bob');
    expect(moved).toMatchObject({ id: 't1', status: 'done', handedOff: 'lab', updatedAt: now });
    expect(moved.notes.at(-1)).toBe('2026-11-17 14:04 UTC Director: handed off to bob@lab');
    expect(emitted.at(-1)?.[0]?.handedOff).toBe('lab');
    await fails(t.handOff('t1', 'lab', null), 'conflict', 'task');
    // it is saved, and a restart brings it back
    await t.close();
    const again = make();
    await again.load();
    expect(again.list()[0]).toMatchObject({ status: 'done', handedOff: 'lab' });
  });

  it('a task without an assignee says only the station', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'Move me' });
    expect((await t.handOff('t1', 'lab', null)).notes.at(-1)).toMatch(/handed off to lab$/);
  });

  it('only an open task that is here can be handed off', async () => {
    const t = make();
    await t.load();
    await t.create(USER, { title: 'Done already' });
    await t.update(USER, 't1', { status: 'done' });
    await fails(t.handOff('t1', 'lab', null), 'conflict', 'task');
    await fails(t.handOff('t9', 'lab', null), 'not_found');
    expect(emitted.at(-1)?.[0]).not.toHaveProperty('handedOff');
  });

  it('reads back a station name that is valid, and drops one that is not', async () => {
    const good = { id: 't1', title: 'a', detail: '', status: 'done', assignee: null, createdBy: 'user', createdAt: 1, updatedAt: 1, notes: [], handedOff: 'lab' };
    await writeFile(join(dir, 'tasks.json'), JSON.stringify({ version: 1, seq: 2, tasks: [good, { ...good, id: 't2', handedOff: 'Not A Station' }, { ...good, id: 't3', handedOff: 5 }] }));
    const t = make();
    await t.load();
    expect(t.list().map((x) => x.handedOff)).toEqual(['lab', undefined, undefined]);
  });
});
