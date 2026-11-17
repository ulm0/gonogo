import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextFire, nextFires, parseCron } from '../src/shared/cron.js';
import type { CronRule } from '../src/shared/cron.js';

// New York has both clock changes, and none of them fall on the machine that runs the test by chance.
const savedZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const at = (y: number, month: number, d: number, h = 0, min = 0): number => new Date(y, month - 1, d, h, min).getTime();
const text = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${DAYS[d.getDay()]}`;
};
const rule = (source: string): CronRule => {
  const parsed = parseCron(source);
  if (typeof parsed === 'string') throw new Error(`${source}: ${parsed}`);
  return parsed;
};
const fires = (source: string, from: number, count: number): string[] => nextFires(rule(source), from, count).map(text);

describe('parseCron', () => {
  it.each(['* * * * *', '*/15 9-17 * * mon-fri', '0 0 1,15 jan,JUL *', '0 12 * * 7', '5-10/2 * * * *', '  0   9 * * MON  ', '0 0 29 2 *', '0 0 31 2 mon'])('takes %j', (source) => {
    expect(typeof parseCron(source)).toBe('object');
  });

  it.each([
    ['* * * *', 'a rule has 5 fields: minute hour day-of-month month day-of-week'],
    ['', 'a rule has 5 fields: minute hour day-of-month month day-of-week'],
    ['* * * * * *', 'a rule has 5 fields: minute hour day-of-month month day-of-week'],
    ['60 * * * *', 'minute: 60 is not from 0 to 59'],
    ['* 24 * * *', 'hour: 24 is not from 0 to 23'],
    ['* * 0 * *', 'day of month: 0 is not from 1 to 31'],
    ['* * * 13 *', 'month: 13 is not from 1 to 12'],
    ['* * * * 8', 'day of week: 8 is not from 0 to 7'],
    ['* * * * funday', 'day of week: "funday" is not a number or a name'],
    ['x * * * *', 'minute: "x" is not a number'],
    ['*/0 * * * *', 'minute: the step "0" is not a positive number'],
    ['*/x * * * *', 'minute: the step "x" is not a positive number'],
    ['5/2 * * * *', 'minute: a step needs * or a range, as in */5 or 1-30/5'],
    ['1,,2 * * * *', 'minute: "" is not a value, a range or a step'],
    ['1/2/3 * * * *', 'minute: "1/2/3" is not a value, a range or a step'],
    ['5-3 * * * *', 'minute: the range 5-3 ends before it starts'],
    ['1-2-3 * * * *', 'minute: "1-2-3" is not a range'],
    ['-5 * * * *', 'minute: "" is not a number'],
    ['0 0 31 2 *', 'day of month: that day never comes in the months given'],
    ['0 0 30,31 feb *', 'day of month: that day never comes in the months given'],
  ])('refuses %j: %s', (source, why) => {
    expect(parseCron(source)).toBe(why);
  });

  it('turns day of week 7 into Sunday and lists, ranges and steps into sets', () => {
    expect([...rule('0 0 * * 5-7').weekdays].sort()).toEqual([0, 5, 6]);
    expect([...rule('*/20 1,3,5-6 * * *').minutes]).toEqual([0, 20, 40]);
    expect([...rule('0 1,3,5-6 * * *').hours]).toEqual([1, 3, 5, 6]);
    expect([...rule('0 0 * * *').weekdays].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...rule('0 0 1-10/3 mar-may *').months]).toEqual([3, 4, 5]);
  });
});

describe('nextFire', () => {
  it('finds the next minute strictly after the time, and ignores seconds', () => {
    const r = rule('*/15 * * * *');
    expect(text(nextFire(r, at(2026, 11, 17, 9, 0))!)).toBe('2026-11-17 09:15 Tue');
    expect(text(nextFire(r, at(2026, 11, 17, 9, 14) + 59_999)!)).toBe('2026-11-17 09:15 Tue');
    expect(text(nextFire(r, at(2026, 11, 17, 9, 15) - 1)!)).toBe('2026-11-17 09:15 Tue');
    expect(text(nextFire(r, at(2026, 11, 17, 9, 15))!)).toBe('2026-11-17 09:30 Tue');
  });

  it('runs the working week: weekdays at 09:00', () => {
    expect(fires('0 9 * * mon-fri', at(2026, 11, 20, 10), 3)).toEqual(['2026-11-23 09:00 Mon', '2026-11-24 09:00 Tue', '2026-11-25 09:00 Wed']);
  });

  it('goes over the end of a month and a year', () => {
    expect(fires('30 23 31 * *', at(2026, 11, 17), 3)).toEqual(['2026-12-31 23:30 Thu', '2027-01-31 23:30 Sun', '2027-03-31 23:30 Wed']);
    expect(fires('0 0 1 jan *', at(2026, 11, 17), 2)).toEqual(['2027-01-01 00:00 Fri', '2028-01-01 00:00 Sat']);
  });

  it('matches a day when either day field does if both are limited, and only both when one is a star', () => {
    expect(fires('0 0 13 * fri', at(2026, 12, 1), 4)).toEqual(['2026-12-04 00:00 Fri', '2026-12-11 00:00 Fri', '2026-12-13 00:00 Sun', '2026-12-18 00:00 Fri']);
    expect(fires('0 0 * * fri', at(2026, 12, 1), 2)).toEqual(['2026-12-04 00:00 Fri', '2026-12-11 00:00 Fri']);
    expect(fires('0 0 */10 * fri', at(2026, 12, 1), 2)).toEqual(['2026-12-11 00:00 Fri', '2027-01-01 00:00 Fri']);
  });

  it('finds a 29 February years away', () => {
    expect(fires('0 0 29 2 *', at(2026, 3, 1), 2)).toEqual(['2028-02-29 00:00 Tue', '2032-02-29 00:00 Sun']);
    expect(fires('0 0 29 2 *', at(2096, 3, 1), 1)).toEqual(['2104-02-29 00:00 Fri']);
  });

  it('skips a time the clock does not have, and fires once for a time it has twice', () => {
    // 2026-03-08 02:00 to 03:00 does not exist; 2026-11-01 01:00 to 02:00 happens twice
    expect(fires('30 2 * * *', at(2026, 3, 7, 12), 2)).toEqual(['2026-03-09 02:30 Mon', '2026-03-10 02:30 Tue']);
    const twice = nextFires(rule('30 1 * * *'), at(2026, 10, 31, 12), 3);
    expect(twice.map(text)).toEqual(['2026-11-01 01:30 Sun', '2026-11-02 01:30 Mon', '2026-11-03 01:30 Tue']);
    expect(twice[1]! - twice[0]!).toBe(25 * 3_600_000);
  });

  it('every minute is every minute', () => {
    expect(fires('* * * * *', at(2026, 11, 17, 23, 58), 3)).toEqual(['2026-11-17 23:59 Tue', '2026-11-18 00:00 Wed', '2026-11-18 00:01 Wed']);
  });
});
