import { describe, expect, it } from 'vitest';
import { callbackData, callbackTag, verifyCallback } from '../src/server/phonetag.js';

const SECRET = 'uplink-secret-0123456789';
const call = { kind: 'permission', id: '17', verdict: 'go' } as const;

describe('phone callback tags', () => {
  it('round-trips a button and fits Telegram 64 bytes', () => {
    const data = callbackData(SECRET, call);
    expect(data).toMatch(/^a:permission:17:go:[0-9a-f]{8}$/);
    expect(Buffer.byteLength(data ?? '')).toBeLessThanOrEqual(64);
    expect(verifyCallback(SECRET, data)).toEqual(call);
    expect(verifyCallback(SECRET, callbackData(SECRET, { kind: 'relief', id: 'r12', verdict: 'open' }))).toEqual({ kind: 'relief', id: 'r12', verdict: 'open' });
  });

  it('refuses a wrong verdict, id, kind, secret or a cut tag', () => {
    const data = callbackData(SECRET, call) ?? '';
    const tag = data.split(':')[4] ?? '';
    expect(verifyCallback(SECRET, data.replace(':go:', ':nogo:'))).toBeNull();
    expect(verifyCallback(SECRET, data.replace(':17:', ':18:'))).toBeNull();
    expect(verifyCallback(SECRET, data.replace('permission', 'relief'))).toBeNull();
    expect(verifyCallback('another-secret-0123456789', data)).toBeNull();
    expect(verifyCallback(SECRET, data.slice(0, -1))).toBeNull();
    expect(verifyCallback(SECRET, `${data}0`)).toBeNull();
    expect(verifyCallback(SECRET, data.replace(tag, tag.toUpperCase()))).toBeNull();
    expect(verifyCallback('', data)).toBeNull();
  });

  it('refuses anything that is not a button', () => {
    for (const odd of [undefined, null, 5, '', 'a', 'a:permission:17:go', 'b:permission:17:go:00000000', `a:permission:17:go:${'0'.repeat(8)}:x`, 'a'.repeat(100)]) {
      expect(verifyCallback(SECRET, odd)).toBeNull();
    }
  });

  it('signs nothing odd: bad ids, kinds, verdicts and an empty secret', () => {
    expect(callbackTag(SECRET, { ...call, id: 'a:b' })).toBeNull();
    expect(callbackTag(SECRET, { ...call, id: '' })).toBeNull();
    expect(callbackTag(SECRET, { ...call, id: 'x'.repeat(25) })).toBeNull();
    expect(callbackTag(SECRET, { ...call, kind: 'bypass' as never })).toBeNull();
    expect(callbackTag(SECRET, { ...call, verdict: 'maybe' as never })).toBeNull();
    expect(callbackTag('', call)).toBeNull();
    expect(callbackData(SECRET, { ...call, id: '\n1' })).toBeNull();
  });
});
