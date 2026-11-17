import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { UPLINK_NAME_MAX_CHARS } from '../src/shared/protocol.js';
import type { UplinkView } from '../src/shared/protocol.js';
import { atText, copyText, emptyValues, endpointOf, lastText, requestOf, toneOf, validate, valuesOf } from '../src/client/uplink.js';

// Set while the file loads: the dates below are made when the describe blocks are collected.
const savedZone = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

const at = (y: number, month: number, d: number, h = 0, min = 0): number => new Date(y, month - 1, d, h, min).getTime();

const uplink = (extra: Partial<UplinkView> = {}): UplinkView => ({ id: 'u1', name: 'GitHub', kind: 'generic', to: 'ana', enabled: true, createdAt: 1, deliveries: [], ...extra });

describe('endpointOf', () => {
  it('is the origin of the page and /uplink/<id>', () => {
    expect(endpointOf('http://127.0.0.1:7777', 'u3')).toBe('http://127.0.0.1:7777/uplink/u3');
    expect(endpointOf('https://gonogo.example.com', 'u1')).toBe('https://gonogo.example.com/uplink/u1');
  });
});

describe('atText', () => {
  const now = at(2026, 11, 17, 15, 30);

  it('is the time for today and the date with the time for another day', () => {
    expect(atText(at(2026, 11, 17, 9, 5), now)).toBe('09:05');
    expect(atText(at(2026, 11, 16, 23, 59), now)).toBe('16 Nov 23:59');
    expect(atText(at(2025, 12, 1, 0, 0), now)).toBe('1 Dec 00:00');
  });
});

describe('lastText', () => {
  const now = at(2026, 11, 17, 15, 30);

  it('says there is none, or names the newest delivery with its note', () => {
    expect(lastText(uplink(), now)).toBe('No deliveries yet');
    const deliveries = [
      { at: at(2026, 11, 17, 15, 0), status: 'held' as const, note: 'm9: waiting for Max Q: 2 of 2 agents working' },
      { at: at(2026, 11, 16, 8, 0), status: 'queued' as const, note: 'm8' },
    ];
    expect(lastText(uplink({ deliveries }), now)).toBe('Last delivery 15:00: m9: waiting for Max Q: 2 of 2 agents working');
  });
});

describe('toneOf', () => {
  it('is go for mail on its way, amber for held mail and no-go for a delivery that did not make it', () => {
    expect(['queued', 'delivered', 'read'].map((s) => toneOf(s as never))).toEqual(['go', 'go', 'go']);
    expect(toneOf('held')).toBe('amber');
    expect(['undelivered', 'refused'].map((s) => toneOf(s as never))).toEqual(['nogo', 'nogo']);
    expect(toneOf('to_user')).toBe('quiet');
  });
});

describe('the form', () => {
  it('starts on the boss, on, and gives back what an uplink holds', () => {
    expect(emptyValues('boss')).toEqual({ name: '', to: 'boss', enabled: true });
    expect(valuesOf(uplink({ enabled: false, to: 'ben' }))).toEqual({ name: 'GitHub', to: 'ben', enabled: false });
  });

  it('wants a name of one to the limit and a recipient', () => {
    expect(validate({ name: '  ', to: 'boss', enabled: true })).toEqual({ name: 'Give it a name.' });
    expect(validate({ name: 'x'.repeat(UPLINK_NAME_MAX_CHARS + 1), to: '', enabled: true })).toEqual({ name: `At most ${UPLINK_NAME_MAX_CHARS} characters.`, to: 'Pick who gets it.' });
    expect(validate({ name: 'x'.repeat(UPLINK_NAME_MAX_CHARS), to: 'ana', enabled: false })).toEqual({});
  });

  it('asks for the trimmed name, and leaves the kind to the server', () => {
    expect(requestOf({ name: '  GitHub ', to: 'ana', enabled: false })).toEqual({ name: 'GitHub', to: 'ana', enabled: false });
  });
});

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true when the clipboard took the text, false when it refuses or there is none', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: (text: string) => Promise.resolve(void written.push(text)) } });
    expect(await copyText('abc')).toBe(true);
    expect(written).toEqual(['abc']);
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    expect(await copyText('abc')).toBe(false);
    vi.stubGlobal('navigator', {});
    expect(await copyText('abc')).toBe(false);
  });
});
