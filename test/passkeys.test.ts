// Passkeys (docs/login-spec.md): the ceremonies of passkeys.ts with a software authenticator (test/helpers/softkey.ts) and the real library.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAuth } from '../src/server/auth.js';
import type { AuthStore, Who } from '../src/server/auth.js';
import { createPasskeys, relyingParty } from '../src/server/passkeys.js';
import type { Passkeys, RelyingParty } from '../src/server/passkeys.js';
import { softKey } from './helpers/softkey.js';

const COSTS = { argon2: { memory: 16, passes: 1, parallelism: 1 }, scrypt: { N: 16, r: 1, p: 1 } };
const PASSWORD = 'correct horse battery staple';
let home: string;
let clock: number;
let alerts: string[];
let auth: AuthStore;
let keys: Passkeys;
let session: string;
let rp: RelyingParty;

const who = (over: Partial<Who> = {}): Who => ({ address: '203.0.113.7', agent: 'test browser', cls: 'public', ...over });
const options = (o: Record<string, unknown>): { challenge: string } => o as { challenge: string };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gng-passkeys-'));
  clock = Date.now();
  alerts = [];
  auth = openAuth({ home, alert: (t) => alerts.push(t), now: () => clock, costs: COSTS, tamperEveryMs: 0 });
  auth.ensureSetupToken();
  const made = await auth.setup({ address: '127.0.0.1', agent: 'x', cls: 'loopback' }, { token: readFileSync(join(home, 'setup-token'), 'utf8').trim(), user: 'director', password: PASSWORD }, null);
  if (!made.ok) throw new Error('setup');
  session = auth.sessions()[0]?.id as string;
  keys = createPasskeys(auth, () => clock);
  rp = relyingParty('gonogo.example.com', 'public') as RelyingParty;
  alerts.length = 0;
});
afterEach(() => {
  auth.close();
  rmSync(home, { recursive: true, force: true });
});

/** A passkey made for rp by `key`, through the server's own options. */
async function enrol(key = softKey(), name = 'laptop', over: { origin?: string; rpId?: string; verified?: boolean; type?: string } = {}): Promise<{ key: ReturnType<typeof softKey>; answer: string }> {
  const challenge = options(await keys.registerOptions(session, rp)).challenge;
  const answer = await keys.registerFinish(session, who(), rp, key.create({ rpId: over.rpId ?? rp.rpId, origin: over.origin ?? rp.origin, challenge, ...(over.verified === undefined ? {} : { verified: over.verified }), ...(over.type === undefined ? {} : { type: over.type }) }), name);
  return { key, answer };
}

describe('where a passkey can be offered', () => {
  it('a public domain name, with its origin (the port stays in the origin, not in the rp id); nothing else', () => {
    expect(relyingParty('gonogo.example.com', 'public')).toEqual({ rpId: 'gonogo.example.com', origin: 'https://gonogo.example.com' });
    expect(relyingParty('Gonogo.Example.com:8443', 'public')).toEqual({ rpId: 'gonogo.example.com', origin: 'https://gonogo.example.com:8443' });
    for (const host of ['203.0.113.7', '203.0.113.7:7357', '[2001:db8::1]:7357', 'localhost', 'com', 'a_b.example.com', '-a.example.com', 'example.123', 'a..b.com', '', undefined]) expect(relyingParty(host, 'public'), String(host)).toBeNull();
    // the class says it too: a name that is not public is not offered one
    for (const cls of ['loopback', 'private'] as const) expect(relyingParty('gonogo.example.com', cls)).toBeNull();
  });
});

describe('registering', () => {
  it('stores the public key, the rp id and the counter, for a name and an alert; the private part never exists here', async () => {
    const { answer } = await enrol();
    expect(answer).toBe('ok');
    const [p] = auth.passkeys();
    expect(p).toMatchObject({ name: 'laptop', rpId: 'gonogo.example.com', counter: 0, last: null });
    expect(alerts).toEqual([expect.stringMatching(/a passkey was added \(laptop, for gonogo\.example\.com\)/)]);
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain(p?.id as string);
    expect(keys.has(rp)).toBe(true);
    expect(keys.has({ rpId: 'other.example.com', origin: 'https://other.example.com' })).toBe(false);
  });

  it('refuses an origin that is not https at this name, another rp id, a missing user verification and a response of the wrong type', async () => {
    for (const over of [{ origin: 'http://gonogo.example.com' }, { origin: 'https://evil.example' }, { rpId: 'evil.example' }, { verified: false }, { type: 'webauthn.get' }]) {
      expect((await enrol(softKey(), 'x', over)).answer, JSON.stringify(over)).toBe('bad');
    }
    expect(auth.passkeys()).toEqual([]);
  });

  it('a challenge is used once, by the session that asked for it, and not after five minutes', async () => {
    const key = softKey();
    const challenge = options(await keys.registerOptions(session, rp)).challenge;
    const response = key.create({ rpId: rp.rpId, origin: rp.origin, challenge });
    expect(await keys.registerFinish('another-session', who(), rp, response, 'x')).toBe('bad');
    // used up by the failed try
    expect(await keys.registerFinish(session, who(), rp, response, 'x')).toBe('bad');
    const late = options(await keys.registerOptions(session, rp)).challenge;
    clock += 5 * 60_000 + 1000;
    expect(await keys.registerFinish(session, who(), rp, softKey().create({ rpId: rp.rpId, origin: rp.origin, challenge: late }), 'x')).toBe('bad');
    expect(await keys.registerFinish(session, who(), rp, { nonsense: true }, 'x')).toBe('bad');
  });

  it('the same credential twice is "full", and the name has no markup', async () => {
    const key = softKey();
    expect((await enrol(key, '<b>my "phone"</b>')).answer).toBe('ok');
    expect(auth.passkeys()[0]?.name).not.toMatch(/[<>"]/);
    expect((await enrol(key)).answer).toBe('full');
  });

  it('remove: a prefix names one, and an alert says so', async () => {
    await enrol(softKey(), 'a');
    await enrol(softKey(), 'b');
    const [first, second] = auth.passkeys();
    expect(auth.passkeyRemove('short')).toBe(false);
    expect(auth.passkeyRemove((first?.id as string).slice(0, 24))).toBe(true);
    expect(auth.passkeys().map((p) => p.id)).toEqual([second?.id]);
    expect(alerts.at(-1)).toBe('a passkey was removed (a)');
  });
});

describe('signing in with a passkey', () => {
  async function login(key: ReturnType<typeof softKey>, over: { origin?: string; rpId?: string; verified?: boolean; counter?: number; address?: string } = {}) {
    const o = await keys.loginOptions(rp);
    if (o === null) throw new Error('no options');
    const challenge = options(o).challenge;
    return keys.loginFinish(who({ address: over.address ?? '203.0.113.7' }), rp, key.get({ rpId: over.rpId ?? rp.rpId, origin: over.origin ?? rp.origin, challenge, ...(over.verified === undefined ? {} : { verified: over.verified }), ...(over.counter === undefined ? {} : { counter: over.counter }) }));
  }

  it('no options without a passkey for this name; with one, no credential id is handed out (discoverable) and the user must be verified', async () => {
    expect(await keys.loginOptions(rp)).toBeNull();
    const { key } = await enrol();
    const o = (await keys.loginOptions(rp)) as { allowCredentials?: Array<{ id: string }>; userVerification: string; rpId: string };
    expect(o.allowCredentials ?? []).toEqual([]);
    expect(JSON.stringify(o)).not.toContain(key.id);
    expect(o.userVerification).toBe('required');
    expect(o.rpId).toBe('gonogo.example.com');
  });

  it('a verified assertion is a full login with no password and no code (both factors), even with TOTP on; the counter moves', async () => {
    const { key } = await enrol();
    // a public name asks a password login for a second factor; a passkey is both
    expect(await auth.login(who(), { user: 'director', password: PASSWORD })).toEqual({ ok: false, reason: 'needmfa' });
    const result = await login(key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(auth.session(result.session, who(), 'api')).not.toBeNull();
    expect(auth.passkeys()[0]).toMatchObject({ counter: 1, last: clock });
    expect(alerts.some((a) => /first login from a new device/.test(a))).toBe(true);
  });

  it('is not slowed by the failure waits, and its failures do not slow a password login either', async () => {
    const { key } = await enrol();
    for (let i = 0; i < 6; i += 1) expect((await login(softKey(), { address: '198.51.100.9' })).ok).toBe(false);
    expect((await login(key, { address: '198.51.100.9' })).ok).toBe(true);
    // a wrong password from that address is still its own first failure
    expect(await auth.login(who({ address: '198.51.100.9', cls: 'private' }), { user: 'director', password: 'not the password' })).toEqual({ ok: false, reason: 'wrong' });
  });

  it('refuses a key that was never registered, a wrong origin or rp id, no user verification, and a challenge used before', async () => {
    const { key } = await enrol();
    expect((await login(softKey())).ok).toBe(false);
    for (const over of [{ origin: 'https://evil.example' }, { origin: 'http://gonogo.example.com' }, { rpId: 'evil.example' }, { verified: false }]) expect((await login(key, over)).ok, JSON.stringify(over)).toBe(false);
    const o = options((await keys.loginOptions(rp)) as Record<string, unknown>);
    const answer = key.get({ rpId: rp.rpId, origin: rp.origin, challenge: o.challenge });
    expect((await keys.loginFinish(who(), rp, answer)).ok).toBe(true);
    expect((await keys.loginFinish(who(), rp, answer)).ok).toBe(false);
  });

  it('a counter that does not go up is refused and says a copy may exist', async () => {
    const { key } = await enrol();
    expect((await login(key, { counter: 5 })).ok).toBe(true);
    alerts.length = 0;
    expect((await login(key, { counter: 5 })).ok).toBe(false);
    expect((await login(key, { counter: 3 })).ok).toBe(false);
    expect(alerts.filter((a) => /counter did not go up/.test(a))).toHaveLength(2);
    expect((await login(key, { counter: 6 })).ok).toBe(true);
  });

  it('N1: login challenges are not kept, so any number of anonymous requests cannot push the Director\'s out', async () => {
    const { key } = await enrol();
    const mine = options((await keys.loginOptions(rp)) as Record<string, unknown>).challenge;
    for (let i = 0; i < 1500; i += 1) await keys.loginOptions(rp);
    for (let i = 0; i < 300; i += 1) await keys.registerOptions(session, rp);
    expect((await keys.loginFinish(who(), rp, key.get({ rpId: rp.rpId, origin: rp.origin, challenge: mine }))).ok).toBe(true);
  });

  it('a login challenge is spent only when an assertion with it verified, and not before: a failed try leaves it good', async () => {
    const { key } = await enrol();
    const challenge = options((await keys.loginOptions(rp)) as Record<string, unknown>).challenge;
    // someone who saw the challenge and has another key, or a wrong origin: refused, the challenge stays
    expect((await keys.loginFinish(who(), rp, softKey().get({ rpId: rp.rpId, origin: rp.origin, challenge }))).ok).toBe(false);
    expect((await keys.loginFinish(who(), rp, key.get({ rpId: rp.rpId, origin: 'https://evil.example', challenge }))).ok).toBe(false);
    const answer = key.get({ rpId: rp.rpId, origin: rp.origin, challenge });
    expect((await keys.loginFinish(who(), rp, answer)).ok).toBe(true);
    // now it is spent
    expect((await keys.loginFinish(who(), rp, key.get({ rpId: rp.rpId, origin: rp.origin, challenge }))).ok).toBe(false);
  });

  it('a login challenge that was not made here, was changed, is for another name or is old is refused', async () => {
    const { key } = await enrol();
    const good = options((await keys.loginOptions(rp)) as Record<string, unknown>).challenge;
    const text = Buffer.from(good, 'base64url').toString('utf8');
    const forged = [Buffer.from('not a challenge at all').toString('base64url'), Buffer.from(text.replace(/.$/, text.endsWith('A') ? 'B' : 'A')).toString('base64url'), Buffer.from(`${text.split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAA`).toString('base64url'), Buffer.from('').toString('base64url')];
    for (const challenge of forged) expect((await keys.loginFinish(who(), rp, key.get({ rpId: rp.rpId, origin: rp.origin, challenge }))).ok, challenge).toBe(false);
    clock += 5 * 60_000 + 1000;
    expect((await keys.loginFinish(who(), rp, key.get({ rpId: rp.rpId, origin: rp.origin, challenge: good }))).ok).toBe(false);
    // a challenge made for one name is not good for another (a second name with its own passkey)
    const other = relyingParty('b.example.com', 'public') as RelyingParty;
    const made = await keys.loginOptions(rp);
    expect(options(made as Record<string, unknown>).challenge).not.toBe(good);
    expect(await keys.loginOptions(other)).toBeNull();
  });

  it('a passkey of one name does not work at another: the rp id is fixed at registration', async () => {
    const { key } = await enrol();
    const other = relyingParty('b.example.com', 'public') as RelyingParty;
    expect(await keys.loginOptions(other)).toBeNull();
    expect((await keys.loginFinish(who(), other, key.get({ rpId: 'b.example.com', origin: other.origin, challenge: 'x' }))).ok).toBe(false);
  });

  it('is refused while remote logins are paused, as a password login is', async () => {
    const { key } = await enrol();
    const real = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
    (await import('node:fs')).writeFileSync(join(home, 'auth.json'), JSON.stringify({ ...real, user: 'planted' }));
    auth.checkTamper(true);
    expect(auth.locked()).toBe(true);
    expect(await login(key)).toEqual({ ok: false, reason: 'locked' });
  });
});

describe('step-up with a passkey', () => {
  it('confirms the session without a password, mints its id again, and a wrong or reused answer does not', async () => {
    const { key } = await enrol();
    const o = options((await keys.stepOptions(session, rp)) as Record<string, unknown>);
    const answer = key.get({ rpId: rp.rpId, origin: rp.origin, challenge: o.challenge });
    // asked for by another session: not accepted
    expect(await keys.stepFinish('another', rp, answer)).toEqual({ ok: false });
    const o2 = options((await keys.stepOptions(session, rp)) as Record<string, unknown>);
    const done = await keys.stepFinish(session, rp, key.get({ rpId: rp.rpId, origin: rp.origin, challenge: o2.challenge }));
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(auth.session(done.session, who(), 'api')).not.toBeNull();
    expect(await keys.stepFinish(session, rp, answer)).toEqual({ ok: false });
    // a login challenge cannot be spent as a step-up
    const login = options((await keys.loginOptions(rp)) as Record<string, unknown>);
    expect(await keys.stepFinish(session, rp, key.get({ rpId: rp.rpId, origin: rp.origin, challenge: login.challenge }))).toEqual({ ok: false });
  });
});
