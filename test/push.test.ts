// Web Push (src/server/push.ts): the payload encryption against the example of RFC 8291, the VAPID signature, the endpoint check (R9),
// the lifecycle of a device tied to a session, and what each event pushes. No real push service and no phone: a stand-in `fetch` plays
// the service and a receiver written from the RFC reads what it was sent.
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEndpoint, createPush, encryptPayload, makeVapid, PUSH_DEVICES_MAX, PUSH_FILE, pushNotice, vapidHeader } from '../src/server/push.js';
import type { Push } from '../src/server/push.js';
import type { ActivityFrame, Logger } from '../src/shared/protocol.js';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet } as unknown as Logger;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gng-push-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const b64 = (b: Buffer): string => b.toString('base64url');

/** What a browser holds for one subscription: its key pair and its auth secret. */
function phone(): { p256dh: string; auth: string; receive(body: Buffer): string } {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return {
    p256dh: b64(ua.getPublicKey()),
    auth: b64(auth),
    // RFC 8291 section 3.4, the receiving side
    receive(body) {
      const salt = body.subarray(0, 16);
      expect(body.readUInt32BE(16)).toBe(4096);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const secret = ua.computeSecret(asPublic);
      const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const rest = body.subarray(21 + idlen);
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(rest.subarray(rest.length - 16));
      const plain = Buffer.concat([decipher.update(rest.subarray(0, rest.length - 16)), decipher.final()]);
      expect(plain[plain.length - 1]).toBe(2);
      return plain.subarray(0, plain.length - 1).toString('utf8');
    },
  };
}

describe('the payload and the signature', () => {
  it('encrypts the example of RFC 8291 byte for byte', () => {
    const as = createECDH('prime256v1');
    as.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    const body = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', as, Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'));
    expect(body.toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('a receiver written from the RFC reads what a fresh send made', () => {
    const p = phone();
    expect(p.receive(encryptPayload(Buffer.from('hello ✓'), p.p256dh, p.auth))).toBe('hello ✓');
  });

  it('signs the VAPID token with ES256 for the origin of the endpoint, and names the public key', () => {
    const vapid = makeVapid();
    const header = vapidHeader(vapid, new URL('https://fcm.googleapis.com/fcm/send/abc'), 1_700_000_000_000);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m as RegExpExecArray;
    expect(k).toBe(vapid.publicKey);
    expect(JSON.parse(Buffer.from(h as string, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(c as string, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600 });
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s as string, 'base64url'))).toBe(true);
  });
});

describe('the endpoint check (R9)', () => {
  it('lets the push hosts of the vendors through', () => {
    for (const url of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/Qx', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://FCM.GoogleAPIs.com:443/x']) {
      expect(checkEndpoint(url), url).toMatchObject({ ok: true });
    }
  });

  it('refuses everything else: plain http, an address, the LAN, a look-alike, a credential, another port, a bad URL, a long one', () => {
    const refused = [
      'http://fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://192.168.1.10/x',
      'https://localhost/x',
      'https://fcm.googleapis.com.evil.test/x',
      'https://evilfcm.googleapis.com/x',
      'https://notpush.apple.com/x',
      'https://push.apple.com/x',
      'https://evil.test/https://fcm.googleapis.com/',
      'https://fcm.googleapis.com@evil.test/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://fcm.googleapis.com./x',
      'ftp://fcm.googleapis.com/x',
      'not a url',
      '',
      `https://fcm.googleapis.com/${'a'.repeat(1100)}`,
    ];
    for (const url of refused) expect(checkEndpoint(url).ok, url).toBe(false);
    for (const value of [null, 5, {}, undefined]) expect(checkEndpoint(value).ok).toBe(false);
  });
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  redirect: string | undefined;
}

function harness(status = 201): { push: Push; sent: Sent[]; status(n: number): void; time(n: number): void } {
  const sent: Sent[] = [];
  let code = status;
  let t = 1_700_000_000_000;
  const fake = (async (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array), redirect: init.redirect });
    return new Response(null, { status: code });
  }) as unknown as typeof fetch;
  const push = createPush({ dir, now: () => t, fetch: fake, log: quiet });
  return { push, sent, status: (n) => (code = n), time: (n) => (t = n) };
}

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
const sub = (p: ReturnType<typeof phone>, extra: Record<string, unknown> = {}, endpoint = ENDPOINT): Record<string, unknown> => ({ endpoint, keys: { p256dh: p.p256dh, auth: p.auth }, device: 'My phone', ...extra });
const message = (from: string, subject: string, body: string): ActivityFrame => ({ t: 'activity', item: { id: 'm1', from, to: 'user', subject, body, inReplyTo: null, hops: 1, at: 1, truncated: false } }) as unknown as ActivityFrame;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('the devices', () => {
  it('makes a key pair on first use, in a file only the owner reads, and keeps it', async () => {
    const h = harness();
    await h.push.load();
    const key = h.push.view(null).publicKey;
    expect(Buffer.from(key, 'base64url')).toHaveLength(65);
    expect(statSync(join(dir, PUSH_FILE)).mode & 0o777).toBe(0o600);
    const again = harness();
    await again.push.load();
    expect(again.push.view(null).publicKey).toBe(key);
  });

  it('needs a login session, checks the keys and the endpoint, and refuses unknown fields', async () => {
    const h = harness();
    await h.push.load();
    const p = phone();
    await expect(h.push.subscribe(sub(p), null)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.push.subscribe(sub(p, {}, 'https://127.0.0.1/x'), 's1')).rejects.toMatchObject({ field: 'endpoint' });
    await expect(h.push.subscribe({ ...sub(p), keys: { p256dh: 'AAAA', auth: p.auth } }, 's1')).rejects.toMatchObject({ field: 'keys' });
    await expect(h.push.subscribe({ ...sub(p), keys: { p256dh: p.p256dh, auth: 'AAAA' } }, 's1')).rejects.toMatchObject({ field: 'keys' });
    await expect(h.push.subscribe({ ...sub(p), extra: 1 }, 's1')).rejects.toMatchObject({ field: 'extra' });
    await expect(h.push.subscribe(sub(p, { snippet: 'yes' }), 's1')).rejects.toMatchObject({ field: 'snippet' });
    await expect(h.push.subscribe('x', 's1')).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.push.view('s1').devices).toEqual([]);
  });

  it('stores a device with a clean name, marks the caller\'s own, and replaces the same endpoint', async () => {
    const h = harness();
    await h.push.load();
    const p = phone();
    let v = await h.push.subscribe(sub(p, { device: 'My‮ phone\n'.padEnd(90, 'x') }), 's1');
    expect(v.devices).toHaveLength(1);
    expect(v.devices[0]?.name).toHaveLength(60);
    expect(v.devices[0]?.name).not.toMatch(/[‮\n]/);
    expect(v.devices[0]).toMatchObject({ mine: true, snippet: false });
    expect(h.push.view('other').devices[0]?.mine).toBe(false);
    v = await h.push.subscribe(sub(p, { snippet: true }), 's2');
    expect(v.devices).toHaveLength(1);
    expect(v.devices[0]).toMatchObject({ mine: true, snippet: true });
    expect(readFileSync(join(dir, PUSH_FILE), 'utf8')).toContain('"session": "s2"');
  });

  it('holds at most so many devices', async () => {
    const h = harness();
    await h.push.load();
    const p = phone();
    for (let i = 0; i < PUSH_DEVICES_MAX; i++) await h.push.subscribe(sub(p, {}, `https://fcm.googleapis.com/fcm/send/${i}`), 's1');
    await expect(h.push.subscribe(sub(p, {}, 'https://fcm.googleapis.com/fcm/send/one-more'), 's1')).rejects.toMatchObject({ code: 'conflict' });
    // the same endpoint again is a replace, not a new device
    await h.push.subscribe(sub(p, { device: 'again' }, 'https://fcm.googleapis.com/fcm/send/3'), 's1');
    expect(h.push.view('s1').devices).toHaveLength(PUSH_DEVICES_MAX);
  });

  it('goes with its session, and with a reset', async () => {
    const h = harness();
    await h.push.load();
    const p = phone();
    await h.push.subscribe(sub(p, {}, 'https://fcm.googleapis.com/fcm/send/a'), 's1');
    await h.push.subscribe(sub(p, {}, 'https://fcm.googleapis.com/fcm/send/b'), 's2');
    await h.push.dropSessions(['s1', 'unknown']);
    expect(h.push.view('s2').devices.map((d) => d.mine)).toEqual([true]);
    await h.push.dropAll();
    expect(h.push.view('s2').devices).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, PUSH_FILE), 'utf8')).devices).toEqual([]);
  });

  it('removes a device on request, and a device a push service says is gone (404, 410)', async () => {
    const h = harness();
    await h.push.load();
    const p = phone();
    const v = await h.push.subscribe(sub(p), 's1');
    await expect(h.push.unsubscribe({ id: 'nope' }, 's1')).rejects.toMatchObject({ code: 'not_found' });
    expect((await h.push.unsubscribe({ id: v.devices[0]?.id }, 's1')).devices).toEqual([]);
    await h.push.subscribe(sub(p), 's1');
    h.status(410);
    h.push.event('permission', 'x');
    await settle();
    await settle();
    expect(h.push.view('s1').devices).toEqual([]);
  });

  it('does not keep a device whose endpoint was edited in the file to somewhere else', async () => {
    const h = harness();
    await h.push.load();
    await h.push.subscribe(sub(phone()), 's1');
    const file = JSON.parse(readFileSync(join(dir, PUSH_FILE), 'utf8'));
    file.devices[0].endpoint = 'https://127.0.0.1:9/x';
    writeFileSync(join(dir, PUSH_FILE), JSON.stringify(file));
    const again = harness();
    await again.push.load();
    expect(again.push.view('s1').devices).toEqual([]);
  });

  it('puts a damaged file aside and starts with a new key', async () => {
    writeFileSync(join(dir, PUSH_FILE), '{"version": 1, ');
    const h = harness();
    await h.push.load();
    expect(readFileSync(join(dir, `${PUSH_FILE}.bad`), 'utf8')).toBe('{"version": 1, ');
    expect(Buffer.from(h.push.view(null).publicKey, 'base64url')).toHaveLength(65);
  });
});

describe('what is pushed', () => {
  it('sends an encrypted, signed request to the endpoint, never following a redirect, and the phone can read it', async () => {
    const h = harness();
    await h.push.load();
    const p = phone();
    await h.push.subscribe(sub(p), 's1');
    h.push.observe(message('ana', 'Deploy', 'the secret plan'));
    await settle();
    expect(h.sent).toHaveLength(1);
    const req = h.sent[0] as Sent;
    expect(req.url).toBe(ENDPOINT);
    expect(req.redirect).toBe('error');
    expect(req.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '3600' });
    expect(req.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    // generic: nothing of the message is on the lock screen
    const shown = JSON.parse(p.receive(req.body)) as Record<string, string>;
    expect(shown).toEqual({ title: 'gonogo', body: '1 new message', tag: 'gonogo-message-ana', open: 'downlink' });
  });

  it('shows the sender and the first words only to a device that chose it, cut and cleaned', async () => {
    const h = harness();
    await h.push.load();
    const p = phone();
    await h.push.subscribe(sub(p, { snippet: true }), 's1');
    h.push.observe(message('ana‮', 'Deploy', `line one\nline two ${'x'.repeat(200)}`));
    await settle();
    const shown = JSON.parse(p.receive((h.sent[0] as Sent).body)) as Record<string, string>;
    expect(shown.title).toBe('ana');
    expect(shown.body).toHaveLength(80);
    expect(shown.body.startsWith('Deploy: line one line two x')).toBe(true);
    expect(shown.body).not.toMatch(/[\n‮]/);
  });

  it('pushes the events that wait for the Director and no others, and a message to anyone else not at all', async () => {
    const h = harness();
    await h.push.load();
    await h.push.subscribe(sub(phone()), 's1');
    for (const kind of ['redline', 'tminus', 'relief', 'permission']) h.push.event(kind, 'text');
    await settle();
    expect(h.sent).toHaveLength(4);
    for (const kind of ['launch-window', 'uplink', 'flight-plan', 'livery', 'mission', 'review', 'startup', 'nope']) h.push.event(kind, 'text');
    h.push.observe({ ...message('ana', 's', 'b'), item: { ...(message('ana', 's', 'b') as unknown as { item: object }).item, to: 'ben' } } as unknown as ActivityFrame);
    await settle();
    expect(h.sent).toHaveLength(4);
  });

  it('sends nothing when no device is subscribed, and a test only to a device of a session', async () => {
    const h = harness();
    await h.push.load();
    h.push.event('permission', 'x');
    await settle();
    expect(h.sent).toHaveLength(0);
    const v = await h.push.subscribe(sub(phone()), 's1');
    await expect(h.push.test({ id: v.devices[0]?.id }, null)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await h.push.test({ id: v.devices[0]?.id }, 's1')).toEqual({ ok: true, note: 'push service answered 201' });
  });

  it('the notice of each kind: generic by default, the text when asked', () => {
    expect(pushNotice('permission', 'ana: Bash: rm -rf /', false)).toMatchObject({ title: 'gonogo', body: 'An agent needs you', open: 'room' });
    expect(pushNotice('permission', 'ana: Bash: rm -rf /', true)).toMatchObject({ body: 'ana: Bash: rm -rf /' });
    expect(pushNotice('tminus', 'x', false).body).toBe('A T-minus poll wants a call');
    expect(pushNotice('redline', 'x', false).body).toBe('A limit tripped (Redline)');
    expect(pushNotice('relief', 'x', false).body).toBe('A hire request waits for your GO');
    expect(pushNotice('message', 'x', false).open).toBe('downlink');
  });
});
