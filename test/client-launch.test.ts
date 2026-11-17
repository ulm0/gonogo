import { afterAll, describe, expect, it } from 'vitest';
import { SCHEDULE_NAME_MAX_CHARS } from '../src/shared/protocol.js';
import type { AgentView, ScheduleView } from '../src/shared/protocol.js';
import { emptyValues, lastText, nextText, previewOf, recipients, requestOf, toText, validate, valuesOf, whenText, zoneNote } from '../src/client/launch.js';

// Set while the file loads: the dates below are made when the describe blocks are collected.
const savedZone = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

const at = (y: number, month: number, d: number, h = 0, min = 0): number => new Date(y, month - 1, d, h, min).getTime();
const HOUR = 3_600_000;

function agent(name: string, extra: Partial<AgentView> = {}): AgentView {
  return { name, boss: false, provider: 'claude', position: null, ...extra } as AgentView;
}

const schedule = (extra: Partial<ScheduleView> = {}): ScheduleView => ({
  id: 's1',
  name: 'Standup',
  to: 'ana',
  subject: 'status',
  body: 'Where are you?',
  rule: '0 9 * * mon-fri',
  enabled: true,
  createdAt: 1,
  lastRunAt: null,
  lastResult: null,
  nextAt: null,
  ...extra,
});

describe('whenText', () => {
  const now = at(2026, 11, 17, 5, 20); // a Tuesday

  it('says how far and when, in the clock of the browser', () => {
    expect(whenText(at(2026, 11, 17, 9, 0), now)).toBe('in 4 h, 09:00 Tue');
    expect(whenText(now + 20 * 60_000, now)).toBe('in 20 min, 05:40 Tue');
    expect(whenText(now + 30_000, now)).toBe('in 1 min, 05:20 Tue');
    expect(whenText(now + 61_000, now)).toBe('in 2 min, 05:21 Tue');
    expect(whenText(now - 5_000, now)).toBe('now, 05:19 Tue');
    expect(whenText(at(2026, 11, 18, 9, 0), now)).toBe('in 28 h, 09:00 Wed');
  });

  it('counts days from two days on, and names the date from six days on', () => {
    expect(whenText(at(2026, 11, 20, 9, 0), now)).toBe('in 3 d, 09:00 Fri');
    expect(whenText(at(2026, 11, 23, 9, 0), now)).toBe('in 6 d, 09:00 Mon 23 Nov');
    expect(whenText(at(2027, 1, 1, 0, 0), now)).toBe('in 45 d, 00:00 Fri 1 Jan');
  });
});

describe('the rows', () => {
  const now = at(2026, 11, 17, 5, 20);

  it('shows the next fire, off, or never', () => {
    expect(nextText(schedule({ nextAt: now + HOUR }), now)).toBe('in 1 h, 06:20 Tue');
    expect(nextText(schedule({ enabled: false, nextAt: null }), now)).toBe('off');
    expect(nextText(schedule({ nextAt: null }), now)).toBe('never');
  });

  it('shows the last run with what the hub answered', () => {
    expect(lastText(schedule())).toBe('Not run yet');
    expect(lastText(schedule({ lastRunAt: at(2026, 11, 17, 9, 0), lastResult: 'sent m3: queued' }))).toBe('Ran 09:00 Tue: sent m3: queued');
  });

  it('names the recipient the way the room does', () => {
    const agents = { flight: agent('flight', { boss: true }), ana: agent('ana', { position: 'fido' }), ben: agent('ben') };
    expect(toText('boss', agents)).toBe('FLIGHT');
    expect(toText('ana', agents)).toBe('FIDO');
    expect(toText('ben', agents)).toBe('BEN');
    expect(toText('ghost', agents)).toBe('GHOST');
  });
});

describe('previewOf', () => {
  const now = at(2026, 11, 20, 10, 0); // a Friday

  it('gives the next three fires as you type, nothing for an empty field and the reason for a bad rule', () => {
    expect(previewOf('0 9 * * mon-fri', now)).toEqual({ times: ['in 3 d, 09:00 Mon', 'in 4 d, 09:00 Tue', 'in 5 d, 09:00 Wed'], problem: null });
    expect(previewOf('', now)).toEqual({ times: [], problem: null });
    expect(previewOf('   ', now)).toEqual({ times: [], problem: null });
    expect(previewOf('0 9 *', now)).toEqual({ times: [], problem: 'a rule has 5 fields: minute hour day-of-month month day-of-week' });
    expect(previewOf('0 25 * * *', now).problem).toBe('hour: 25 is not from 0 to 23');
  });
});

describe('zoneNote', () => {
  it('is silent when the zones are the same and says what differs otherwise', () => {
    expect(zoneNote('UTC', 'UTC')).toBeNull();
    expect(zoneNote('Europe/Madrid', 'America/Santiago')).toBe('This page shows times in America/Santiago; the rules run in Europe/Madrid.');
  });
});

describe('the form', () => {
  const good = { ...emptyValues('boss'), name: 'Standup', body: 'Status?', rule: '0 9 * * *' };

  it('starts empty, on, for the boss', () => {
    expect(emptyValues('boss')).toEqual({ name: '', to: 'boss', subject: '', body: '', rule: '', enabled: true });
    expect(valuesOf(schedule())).toEqual({ name: 'Standup', to: 'ana', subject: 'status', body: 'Where are you?', rule: '0 9 * * mon-fri', enabled: true });
  });

  it('accepts a good one and sends it trimmed', () => {
    expect(validate(good)).toEqual({});
    expect(requestOf({ ...good, name: '  Standup ', subject: ' hi ', rule: ' 0 9 * * * ' })).toEqual({ name: 'Standup', to: 'boss', subject: 'hi', body: 'Status?', rule: '0 9 * * *', enabled: true });
  });

  it('says what is missing or wrong, field by field', () => {
    expect(validate(emptyValues('boss'))).toEqual({ name: 'Give it a name.', body: 'Write the message.', rule: 'Give the rule.' });
    expect(validate({ ...good, to: '' }).to).toBe('Pick who gets it.');
    expect(validate({ ...good, name: 'n'.repeat(SCHEDULE_NAME_MAX_CHARS + 1) }).name).toBe('At most 60 characters.');
    expect(validate({ ...good, rule: '0 9 *' }).rule).toBe('a rule has 5 fields: minute hour day-of-month month day-of-week');
    expect(validate({ ...good, name: 'n'.repeat(60), subject: 's'.repeat(140) }).subject).toBe('The name and the subject together are too long (at most 183).');
  });
});

describe('recipients', () => {
  it('offers the boss as "boss", then the consoles that can read mail, and keeps a gone recipient', () => {
    const list = [agent('flight', { boss: true }), agent('ana', { position: 'fido' }), agent('ben', { provider: 'custom' }), agent('cy')];
    const all = Object.fromEntries(list.map((a) => [a.name, a]));
    expect(recipients(list, all, null)).toEqual([
      { value: 'boss', label: 'FLIGHT (the boss)' },
      { value: 'ana', label: 'FIDO' },
      { value: 'cy', label: 'CY' },
    ]);
    expect(recipients(list, all, 'ana').map((r) => r.value)).toEqual(['boss', 'ana', 'cy']);
    expect(recipients(list, all, 'ghost').at(-1)).toEqual({ value: 'ghost', label: 'ghost (not in the room)' });
    expect(recipients(list, all, 'ben').at(-1)).toEqual({ value: 'ben', label: 'ben (cannot read mail)' });
  });
});
