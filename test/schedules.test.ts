import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEDULE_NAME_MAX_CHARS, SCHEDULES_MAX } from '../src/shared/protocol.js';
import type { Logger, ScheduleView, SendResult, UserMessageRequest } from '../src/shared/protocol.js';
import { HubError } from '../src/server/hub.js';
import { createSchedules } from '../src/server/schedules.js';
import type { Schedules } from '../src/server/schedules.js';

const savedZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

const at = (y: number, month: number, d: number, h = 0, min = 0): number => new Date(y, month - 1, d, h, min).getTime();
let START = 0; // made in beforeEach: the zone is set in beforeAll
const MIN = 60_000;

/** A clock that moves only when the test says so, and runs the timers that fall due on the way. */
function fakeClock(start: number) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): number => {
      timers.set(nextId, { at: now + ms, fn });
      return nextId++;
    },
    clearTimer: (handle: unknown): void => void timers.delete(handle as number),
    pending: (): number => timers.size,
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    /** The machine slept: time passes and no timer ran. The first one that was due runs on wake. */
    sleep(ms: number): void {
      now += ms;
      const due = [...timers.entries()].find(([, t]) => t.at <= now);
      if (due) {
        timers.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

let dir: string;
let clock: ReturnType<typeof fakeClock>;
let sent: UserMessageRequest[];
let emitted: ScheduleView[][];
let logs: string[];
let posted: Array<[string, string]>;
let answer: (request: UserMessageRequest) => SendResult;
const open: Schedules[] = [];

const quiet = (sink: string[]): Logger => {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void sink.push(message),
    error: (message) => void sink.push(message),
    child: () => log,
  };
  return log;
};

async function make(enabled?: () => boolean): Promise<Schedules> {
  const s = createSchedules({
    dir,
    enabled,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    send: (request) => {
      sent.push(request);
      return answer(request);
    },
    emit: (list) => void emitted.push(list),
    notify: (kind, text) => void posted.push([kind, text]),
    log: quiet(logs),
  });
  open.push(s);
  await s.load();
  return s;
}

const standup = { name: 'Standup', to: 'ana', subject: 'status', body: 'Tell me where you are.', rule: '*/5 * * * *' };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-window-'));
  START = at(2026, 11, 17, 12, 0);
  clock = fakeClock(START);
  sent = [];
  emitted = [];
  logs = [];
  posted = [];
  let n = 0;
  answer = () => ({ ok: true, id: `m${++n}`, to: 'ana', status: 'queued', note: null });
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  await rm(dir, { recursive: true, force: true });
});

const refusal = async (promise: Promise<unknown>): Promise<{ code: string; field?: string; message: string }> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HubError) return { code: error.code, field: error.field, message: error.message };
    throw error;
  }
  throw new Error('it was not refused');
};

describe('Launch Window', () => {
  it('makes a schedule with the next fire time, saves it in a private file and tells the browsers', async () => {
    const s = await make();
    const made = await s.create(standup);
    expect(made).toEqual({
      ...standup,
      id: 's1',
      enabled: true,
      createdAt: START,
      lastRunAt: null,
      lastResult: null,
      nextAt: at(2026, 11, 17, 12, 5),
    });
    expect(s.list()).toEqual([made]);
    expect(emitted).toHaveLength(1);
    expect((await stat(join(dir, 'schedules.json'))).mode & 0o777).toBe(0o600);
    const file = JSON.parse(await readFile(join(dir, 'schedules.json'), 'utf8')) as { version: number; schedules: Array<Record<string, unknown>> };
    expect(file.version).toBe(1);
    expect(file.schedules).toHaveLength(1);
    expect(file.schedules[0]).toMatchObject({ id: 's1', name: 'Standup', rule: '*/5 * * * *' });
    expect(file.schedules[0]).not.toHaveProperty('nextAt');
  });

  it('fires nothing while Launch Window is switched off, and does not catch up when it is switched on again', async () => {
    let on = false;
    const s = await make(() => on);
    await s.create(standup);
    clock.advance(20 * MIN);
    expect(sent).toEqual([]);
    // the next fire is in the future again, so nothing was saved up
    expect(s.list()[0]?.nextAt).toBe(at(2026, 11, 17, 12, 25));
    on = true;
    clock.advance(5 * MIN);
    expect(sent).toHaveLength(1);
  });

  it('sends a message from the Director on the minute, once, with the name in the subject', async () => {
    const s = await make();
    await s.create(standup);
    clock.advance(4 * MIN + 59_000);
    expect(sent).toEqual([]);
    clock.advance(1_000);
    expect(sent).toEqual([{ to: 'ana', subject: 'Launch Window: Standup: status', body: 'Tell me where you are.' }]);
    const [view] = s.list();
    expect(view).toMatchObject({ lastRunAt: at(2026, 11, 17, 12, 5), lastResult: 'sent m1: queued', nextAt: at(2026, 11, 17, 12, 10) });
    expect(emitted.at(-1)).toEqual(s.list());
    clock.advance(4 * MIN + 59_000);
    expect(sent).toHaveLength(1);
    clock.advance(1_000);
    expect(sent).toHaveLength(2);
  });

  it('goes through the hub path, so a hold or a refusal is what the result says', async () => {
    const s = await make();
    await s.create({ ...standup, subject: '' });
    answer = () => ({ ok: true, id: 'm7', to: 'ana', status: 'held', note: 'waiting: load limit (3 of 3 agents working)' });
    clock.advance(5 * MIN);
    expect(sent[0]?.subject).toBe('Launch Window: Standup');
    expect(s.list()[0]?.lastResult).toBe('sent m7: held (waiting: load limit (3 of 3 agents working))');
    answer = () => ({ ok: false, id: 'm8', to: 'ana', status: 'undelivered', note: 'ana is stopped' });
    clock.advance(5 * MIN);
    expect(s.list()[0]?.lastResult).toBe('undelivered m8: ana is stopped');
    answer = () => {
      throw new HubError('not_found', 'unknown recipient "ana". Known: flight');
    };
    clock.advance(5 * MIN);
    expect(s.list()[0]?.lastResult).toBe('not sent: unknown recipient "ana". Known: flight');
    expect(s.list()[0]?.enabled).toBe(true);
  });

  it('tells the Downlink of a fire that failed, and of nothing else', async () => {
    const s = await make();
    await s.create({ ...standup, subject: '' });
    answer = () => ({ ok: true, id: 'm7', to: 'ana', status: 'held', note: 'waiting: load limit' });
    clock.advance(5 * MIN);
    expect(posted).toEqual([]);
    answer = () => ({ ok: false, id: 'm8', to: 'ana', status: 'undelivered', note: 'ana is stopped' });
    clock.advance(5 * MIN);
    answer = () => {
      throw new HubError('not_found', 'unknown recipient "ana". Known: flight');
    };
    clock.advance(5 * MIN);
    expect(posted).toEqual([
      ['launch-window', 'Standup: undelivered m8: ana is stopped'],
      ['launch-window', 'Standup: not sent: unknown recipient "ana". Known: flight'],
    ]);
  });

  it('does not fire a schedule that is off, and starts again when it is turned on', async () => {
    const s = await make();
    const made = await s.create({ ...standup, enabled: false });
    expect(made.enabled).toBe(false);
    expect(made.nextAt).toBeNull();
    clock.advance(30 * MIN);
    expect(sent).toEqual([]);
    const on = await s.update('s1', { enabled: true });
    expect(on.nextAt).toBe(at(2026, 11, 17, 12, 35));
    clock.advance(5 * MIN);
    expect(sent).toHaveLength(1);
    const off = await s.update('s1', { enabled: false });
    expect(off.nextAt).toBeNull();
    clock.advance(30 * MIN);
    expect(sent).toHaveLength(1);
  });

  it('changes the rule and the text, and keeps the rest', async () => {
    const s = await make();
    await s.create(standup);
    const changed = await s.update('s1', { rule: '0   13 * * *', name: ' Lunch ', body: 'Eat.' });
    expect(changed).toMatchObject({ rule: '0 13 * * *', name: 'Lunch', body: 'Eat.', to: 'ana', subject: 'status', nextAt: at(2026, 11, 17, 13, 0) });
    clock.advance(70 * MIN);
    expect(sent).toEqual([{ to: 'ana', subject: 'Launch Window: Lunch: status', body: 'Eat.' }]);
  });

  it('runs now, on or off, and shows what the hub answered even when it refused', async () => {
    const s = await make();
    await s.create({ ...standup, enabled: false });
    const ran = await s.run('s1');
    expect(ran).toMatchObject({ lastRunAt: START, lastResult: 'sent m1: queued', nextAt: null, enabled: false });
    answer = () => {
      throw new HubError('bad_request', 'there is no boss agent', 'to');
    };
    expect((await s.run('s1')).lastResult).toBe('not sent: there is no boss agent');
    expect(await refusal(s.run('s9'))).toEqual({ code: 'not_found', field: undefined, message: 'unknown schedule' });
    expect(await refusal(s.run('nope'))).toMatchObject({ code: 'not_found' });
  });

  it('removes a schedule, and a removed one never fires; ids are not used twice in a run', async () => {
    const s = await make();
    await s.create(standup);
    await s.remove('s1');
    expect(s.list()).toEqual([]);
    clock.advance(10 * MIN);
    expect(sent).toEqual([]);
    expect((await s.create(standup)).id).toBe('s2');
    expect(await refusal(s.remove('s1'))).toMatchObject({ code: 'not_found' });
  });

  it('skips a fire that is more than a minute late and does not replay it', async () => {
    const s = await make();
    await s.create(standup);
    clock.sleep(2 * 3_600_000);
    expect(sent).toEqual([]);
    expect(logs).toEqual([expect.stringContaining('launch window "Standup" missed its fire at')]);
    expect(s.list()[0]).toMatchObject({ lastRunAt: null, nextAt: at(2026, 11, 17, 14, 5) });
    clock.advance(5 * MIN);
    expect(sent).toHaveLength(1);
  });

  it('still fires one that is a few seconds late', async () => {
    const s = await make();
    await s.create(standup);
    clock.sleep(5 * MIN + 20_000);
    expect(sent).toHaveLength(1);
  });

  it('keeps its schedules over a restart, logs the fires missed meanwhile once and does not replay them', async () => {
    const first = await make();
    await first.create(standup);
    await first.create({ name: 'Hourly', to: 'boss', body: 'Report.', rule: '0 * * * *' });
    clock.advance(5 * MIN);
    await first.close();
    expect(sent).toHaveLength(1);
    clock.advance(3 * 3_600_000);
    const again = await make();
    expect(sent).toHaveLength(1);
    expect(again.list().map((v) => [v.id, v.name, v.lastResult])).toEqual([
      ['s1', 'Standup', 'sent m1: queued'],
      ['s2', 'Hourly', null],
    ]);
    expect(again.list()[0]?.nextAt).toBe(at(2026, 11, 17, 15, 10));
    expect(logs).toEqual([expect.stringContaining('(Standup, Hourly); missed fires are not replayed')]);
    expect((await again.create(standup)).id).toBe('s3');
  });

  it('logs a fire missed in the last minute before a start too, and does not send it', async () => {
    const first = await make();
    await first.create(standup);
    await first.close();
    clock.advance(5 * MIN + 30_000); // down over 12:05, up again at 12:05:30
    const again = await make();
    expect(sent).toEqual([]);
    expect(logs).toEqual([expect.stringContaining('(Standup); missed fires are not replayed')]);
    expect(again.list()[0]?.nextAt).toBe(at(2026, 11, 17, 12, 10));
  });

  it('does not log a restart that missed nothing, nor a schedule that is off', async () => {
    const first = await make();
    await first.create(standup);
    await first.create({ ...standup, name: 'Off', enabled: false });
    await first.close();
    clock.advance(2 * MIN);
    await make();
    expect(logs).toEqual([]);
  });

  it('stops its timer on close', async () => {
    const s = await make();
    expect(clock.pending()).toBe(1);
    await s.close();
    expect(clock.pending()).toBe(0);
    clock.advance(10 * MIN);
    expect(sent).toEqual([]);
  });

  it('puts a file it cannot read aside and starts empty, and skips one bad schedule among good ones', async () => {
    await writeFile(join(dir, 'schedules.json'), '{ not json');
    const s = await make();
    expect(s.list()).toEqual([]);
    expect(logs[0]).toContain('kept as schedules.json.bad');
    expect(await readFile(join(dir, 'schedules.json.bad'), 'utf8')).toBe('{ not json');
    await s.create(standup);
    await s.close();
    const good = { id: 's2', name: 'Fine', to: 'ben', subject: '', body: 'x', rule: '0 9 * * 1', enabled: true, createdAt: START, lastRunAt: null, lastResult: null };
    await writeFile(join(dir, 'schedules.json'), JSON.stringify({ version: 1, schedules: [{ ...good, id: 's1', rule: 'soon' }, good, { ...good, id: 'x' }, { ...good, to: 'user', id: 's3' }, { ...good, name: 'Twin' }] }));
    logs = [];
    const again = await make();
    expect(again.list().map((v) => [v.id, v.name])).toEqual([['s2', 'Fine']]);
    expect(logs).toHaveLength(4);
    expect(logs[3]).toContain('the id s2 is used twice');
  });

  describe('what it refuses', () => {
    it.each([
      [{ ...standup, extra: 1 }, 'extra'],
      [{ ...standup, name: '' }, 'name'],
      [{ ...standup, name: 'a'.repeat(SCHEDULE_NAME_MAX_CHARS + 1) }, 'name'],
      [{ ...standup, name: 'two\nlines' }, 'name'],
      [{ ...standup, name: 7 }, 'name'],
      [{ ...standup, to: 'user' }, 'to'],
      [{ ...standup, to: 'Not A Name' }, 'to'],
      [{ ...standup, to: 3 }, 'to'],
      [{ ...standup, subject: 3 }, 'subject'],
      [{ ...standup, subject: 'x'.repeat(190) }, 'subject'],
      [{ ...standup, body: '   ' }, 'body'],
      [{ ...standup, rule: '61 * * * *' }, 'rule'],
      [{ ...standup, rule: 'x'.repeat(101) }, 'rule'],
      [{ ...standup, rule: 5 }, 'rule'],
      [{ ...standup, enabled: 'yes' }, 'enabled'],
    ])('%j: bad_request on %s', async (input, field) => {
      const s = await make();
      expect(await refusal(s.create(input))).toMatchObject({ code: 'bad_request', field });
      expect(s.list()).toEqual([]);
    });

    it('needs name, to, body and rule, and a JSON object', async () => {
      const s = await make();
      for (const field of ['name', 'to', 'body', 'rule']) {
        const { [field]: _gone, ...rest } = standup as Record<string, unknown>;
        expect(await refusal(s.create(rest))).toEqual({ code: 'bad_request', field, message: `${field} is required` });
      }
      expect(await refusal(s.create([]))).toMatchObject({ code: 'bad_request', field: undefined });
      expect(await refusal(s.create(null))).toMatchObject({ code: 'bad_request' });
    });

    it('holds a field back on edit, and an unknown id', async () => {
      const s = await make();
      await s.create(standup);
      expect(await refusal(s.update('s1', { rule: 'every day' }))).toMatchObject({ code: 'bad_request', field: 'rule' });
      expect(await refusal(s.update('s1', { name: 'n'.repeat(60), subject: 's'.repeat(130) }))).toMatchObject({ code: 'bad_request', field: 'subject' });
      expect(s.list()[0]).toMatchObject({ name: 'Standup', rule: '*/5 * * * *' });
      expect(await refusal(s.update('s2', {}))).toMatchObject({ code: 'not_found' });
    });

    it('takes at most SCHEDULES_MAX', async () => {
      const s = await make();
      for (let i = 0; i < SCHEDULES_MAX; i += 1) await s.create({ ...standup, name: `n${i}` });
      expect(await refusal(s.create(standup))).toEqual({ code: 'conflict', field: undefined, message: `at most ${SCHEDULES_MAX} schedules` });
    });
  });
});
