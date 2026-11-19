// The logic of push in the page (src/client/push.ts): what the settings screen says for each device, and the pieces of the subscription.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceId, deviceName, keyBytes, openTarget, PUSH_TEXT, pushStatus, subscriptionBody } from '../src/client/push.js';
import type { PushFacts } from '../src/client/push.js';

const facts = (patch: Partial<PushFacts> = {}): PushFacts => ({ supported: true, secure: true, standalone: false, ios: false, permission: 'default', subscribed: false, ...patch });

describe('the status of push on a device', () => {
  it('says what stands in the way, in the order that helps: install on iOS, https, support, a blocked permission', () => {
    expect(pushStatus(facts({ ios: true, supported: false }))).toBe('install-first');
    expect(pushStatus(facts({ ios: true, standalone: true }))).toBe('off');
    expect(pushStatus(facts({ ios: true, secure: false }))).toBe('insecure');
    expect(pushStatus(facts({ secure: false }))).toBe('insecure');
    expect(pushStatus(facts({ supported: false }))).toBe('unsupported');
    expect(pushStatus(facts({ permission: 'denied' }))).toBe('denied');
  });

  it('is on only with a granted permission and a subscription the server holds', () => {
    expect(pushStatus(facts({ permission: 'granted', subscribed: true }))).toBe('on');
    expect(pushStatus(facts({ permission: 'granted' }))).toBe('off');
    expect(pushStatus(facts({ permission: 'default', subscribed: true }))).toBe('off');
  });

  it('has a sentence for every status, and the iOS one says Home Screen and the https one says what to do', () => {
    for (const status of ['unsupported', 'insecure', 'install-first', 'denied', 'off', 'on'] as const) expect(PUSH_TEXT[status].length).toBeGreaterThan(20);
    expect(PUSH_TEXT['install-first']).toMatch(/Home Screen/);
    expect(PUSH_TEXT.insecure).toMatch(/https/);
    expect(PUSH_TEXT.on).toMatch(/nothing is approved/);
  });
});

describe('the pieces of a subscription', () => {
  it('turns the server key into bytes', () => {
    const key = Buffer.from([4, ...Array.from({ length: 64 }, (_, i) => i)]);
    expect([...keyBytes(key.toString('base64url'))]).toEqual([...key]);
  });

  it('gives the device the id the server gives it', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(await deviceId(endpoint)).toBe(createHash('sha256').update(new URL(endpoint).href).digest('hex').slice(0, 16));
  });

  it('names a device by its platform and browser, and says when it is the app', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', true)).toBe('iPhone or iPad, Safari (app)');
    expect(deviceName('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36', false)).toBe('Android, Chrome');
    expect(deviceName('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', false)).toBe('Linux, Firefox');
    expect(deviceName('', false)).toBe('Device, browser');
  });

  it('builds the body of the subscribe call from the browser\'s JSON, and none when the keys are missing', () => {
    expect(subscriptionBody({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }, 'Phone', true)).toEqual({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' }, device: 'Phone', snippet: true });
    expect(subscriptionBody({ endpoint: 'https://x' }, 'Phone', false)).toBeNull();
    expect(subscriptionBody({ keys: { p256dh: 'a', auth: 'b' } }, 'Phone', false)).toBeNull();
  });

  it('takes only the two places a tap may go', () => {
    expect([openTarget('downlink'), openTarget('room'), openTarget('x'), openTarget(null), openTarget(undefined)]).toEqual(['downlink', 'room', null, null, null]);
  });
});
