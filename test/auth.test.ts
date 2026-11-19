// The login account (docs/login-spec.md): hashing, setup, sessions, device cookies and buckets, keys, alerts, reset and the tamper alarm.
// Cheap hash costs and an injected clock; the real argon2id/scrypt are the ones Node ships.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_FILE, authStateOf, base32, hashPassword, hostClass, keyMayDo, LIFETIME, matchTotp, openAuth, RECOVERY_COUNT, resetAuthFiles, SETUP_TOKEN_FILE, STEP_UP_MS, totpCode, verifyPassword } from '../src/server/auth.js';
import type { AuthStore, LoginResult, Who } from '../src/server/auth.js';

const COSTS = { argon2: { memory: 16, passes: 1, parallelism: 1 }, scrypt: { N: 16, r: 1, p: 1 } };
const PASSWORD = 'correct horse battery staple';
const HOUR = 3600_000;
let home: string;
let clock: number;
let alerts: string[];
let stores: AuthStore[];

const who = (over: Partial<Who> = {}): Who => ({ address: '127.0.0.1', agent: 'test browser', cls: 'loopback', ...over });
const open = (): AuthStore => {
  const store = openAuth({ home, alert: (text) => alerts.push(text), now: () => clock, costs: COSTS, tamperEveryMs: 0 });
  stores.push(store);
  return store;
};
const setupToken = (): string => readFileSync(join(home, SETUP_TOKEN_FILE), 'utf8').trim();
/** An account made through setup; returns the store and the first session. */
async function account(extra: Partial<Who> = {}): Promise<{ auth: AuthStore; session: string; device: string }> {
  const auth = open();
  auth.ensureSetupToken();
  const made = await auth.setup(who(extra), { token: setupToken(), user: 'director', password: PASSWORD }, null);
  if (!made.ok) throw new Error(`setup failed: ${made.reason}`);
  alerts.length = 0;
  return { auth, session: made.session, device: made.device };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gng-auth-'));
  clock = Date.now();
  alerts = [];
  stores = [];
});
afterEach(() => {
  for (const s of stores) s.close();
  rmSync(home, { recursive: true, force: true });
});

describe('host classes', () => {
  it('tell loopback, private and public names and addresses apart', () => {
    for (const h of ['localhost', 'localhost:7357', '127.0.0.1', '127.0.0.1:80', '[::1]:7357', '::1', 'app.localhost']) expect(hostClass(h), h).toBe('loopback');
    for (const h of ['192.168.1.5', '10.0.0.2:7357', '172.16.0.1', '172.31.9.9', '169.254.1.1', '100.64.0.1', 'nas', 'nas.local', 'box.lan', 'fd12::1', '[fe80::1]:80', 'x.home.arpa']) expect(hostClass(h), h).toBe('private');
    for (const h of ['gonogo.example.com', 'example.com:443', '8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.9', '2001:db8::1', undefined]) expect(hostClass(h), String(h)).toBe('public');
  });
});

describe('passwords', () => {
  it('hash and verify with argon2id and with scrypt, per hash parameters, and a wrong password is refused', async () => {
    for (const algo of ['argon2id', 'scrypt'] as const) {
      const stored = await hashPassword(PASSWORD, COSTS, algo);
      expect(stored.algo).toBe(algo);
      expect(stored.hash).not.toContain(PASSWORD);
      expect((await verifyPassword(PASSWORD, stored, COSTS)).ok).toBe(true);
      expect((await verifyPassword(`${PASSWORD}x`, stored, COSTS)).ok).toBe(false);
    }
  });

  it('a hash made with an older algorithm or cost is made again at the next login', async () => {
    const first = await account();
    expect(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).password).toMatchObject({ algo: 'argon2id', m: 16, t: 1 });
    first.auth.close();
    // the server restarts with a higher cost: the stored hash is stale
    const next = openAuth({ home, alert: (t) => alerts.push(t), now: () => clock, costs: { argon2: { memory: 32, passes: 2, parallelism: 1 }, scrypt: COSTS.scrypt }, tamperEveryMs: 0 });
    stores.push(next);
    expect((await next.login(who(), { user: 'director', password: PASSWORD })).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).password).toMatchObject({ algo: 'argon2id', m: 32, t: 2 });
    // and the new hash still opens it
    expect((await next.login(who(), { user: 'director', password: PASSWORD })).ok).toBe(true);
  });

  it('a wrong name and a wrong password are the same answer, and both cost a hash', async () => {
    const { auth } = await account();
    const time = async (user: string, password: string): Promise<number> => {
      // far enough apart that the wait of the buckets is over
      clock += 20 * 60_000;
      const t = process.hrtime.bigint();
      const result = await auth.login(who({ address: `9.9.9.${Math.floor(Math.random() * 200)}`, device: undefined }), { user, password });
      expect(result).toEqual({ ok: false, reason: 'wrong' });
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const wrongName = [await time('nobody', PASSWORD), await time('nobody', PASSWORD)];
    const wrongPassword = [await time('director', 'x'.repeat(14)), await time('director', 'x'.repeat(14))];
    // both took a derivation: the ratio of the best of each stays near 1 (a skipped hash would be orders of magnitude faster)
    const ratio = Math.min(...wrongName) / Math.min(...wrongPassword);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(5);
  });
});

describe('setup', () => {
  it('needs the setup token: single use, one hour, in a 0600 file made when there is no account', async () => {
    const auth = open();
    const made = auth.ensureSetupToken();
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(home, SETUP_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(auth.ensureSetupToken()).toBeNull();
    expect(await auth.setup(who(), { token: 'nope', user: 'director', password: PASSWORD }, null)).toEqual({ ok: false, reason: 'wrong' });
    clock += 2000;
    const ok = await auth.setup(who({ address: '2.2.2.2' }), { token: setupToken(), user: 'director', password: PASSWORD }, null);
    expect(ok.ok).toBe(true);
    // gone with the account, and a second setup is refused
    expect(existsSync(join(home, SETUP_TOKEN_FILE))).toBe(false);
    expect(await auth.setup(who(), { token: made as string, user: 'x', password: PASSWORD }, null)).toEqual({ ok: false, reason: 'off' });
    expect(auth.state()).toBe('account');
  });

  it('an expired setup token opens nothing, and a new one is made', async () => {
    const auth = open();
    const first = auth.ensureSetupToken() as string;
    clock += HOUR + 1000;
    expect(await auth.setup(who(), { token: first, user: 'director', password: PASSWORD }, null)).toEqual({ ok: false, reason: 'wrong' });
    const second = auth.ensureSetupToken();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('is answered on a loopback or private Host and never on a public one, even with the right token', async () => {
    const auth = open();
    auth.ensureSetupToken();
    const token = setupToken();
    expect(await auth.setup(who({ cls: 'public' }), { token, user: 'director', password: PASSWORD }, null)).toEqual({ ok: false, reason: 'setup' });
    expect(auth.state()).toBe('fresh');
    expect((await auth.setup(who({ cls: 'private', address: '192.168.1.9' }), { token, user: 'director', password: PASSWORD }, null)).ok).toBe(true);
  });

  it('takes the old browser token on a fresh install only, and the token dies with the account (R1)', async () => {
    const legacy = 'ab'.repeat(32);
    writeFileSync(join(home, 'token'), `${legacy}\n`, { mode: 0o600 });
    const auth = open();
    expect(auth.tokenAllowed()).toBe(true);
    expect((await auth.setup(who(), { token: legacy, user: 'director', password: PASSWORD }, legacy)).ok).toBe(true);
    expect(existsSync(join(home, 'token'))).toBe(false);
    expect(auth.tokenAllowed()).toBe(false);
    expect(authStateOf(home)).toBe('account');
    // a tombstone: after a reset no TCP token comes back, and the old token does not open setup
    resetAuthFiles(home);
    const again = open();
    expect(again.state()).toBe('none');
    expect(again.tokenAllowed()).toBe(false);
    expect(await again.setup(who({ address: '3.3.3.3' }), { token: legacy, user: 'director', password: PASSWORD }, legacy)).toEqual({ ok: false, reason: 'wrong' });
  });

  it('refuses a short password and a name with odd characters, and keeps no password in the file', async () => {
    const auth = open();
    auth.ensureSetupToken();
    expect(await auth.setup(who(), { token: setupToken(), user: 'director', password: 'short' }, null)).toEqual({ ok: false, reason: 'weak' });
    expect(await auth.setup(who(), { token: setupToken(), user: '<script>', password: PASSWORD }, null)).toEqual({ ok: false, reason: 'weak' });
    expect(auth.state()).toBe('fresh');
    await auth.setup(who(), { token: setupToken(), user: 'director', password: PASSWORD }, null);
    const text = readFileSync(join(home, AUTH_FILE), 'utf8');
    expect(text).not.toContain(PASSWORD);
    expect(statSync(join(home, AUTH_FILE)).mode & 0o777).toBe(0o600);
  });
});

describe('login, sessions and devices', () => {
  it('logs in with the right name and password, stores only a hash of the session, and alerts on the first login from a new device', async () => {
    const { auth, device } = await account();
    const known = who({ device });
    const ok = await auth.login(known, { user: 'director', password: PASSWORD });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.newDevice).toBe(false);
    expect(alerts).toEqual([]);
    expect(readFileSync(join(home, AUTH_FILE), 'utf8')).not.toContain(ok.session);
    const found = auth.session(ok.session, known, 'api');
    expect(found?.address).toBe('127.0.0.1');
    // a browser without the device cookie is a new device: one alert, with the address and never a secret
    const other = await auth.login(who({ address: '5.5.5.5', agent: 'phone' }), { user: 'director', password: PASSWORD });
    expect(other.ok && other.newDevice).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/first login from a new device \(5\.5\.5\.5, phone\)/);
    expect(alerts[0]).not.toContain(PASSWORD);
  });

  it('lifetimes: a public name is 2 h idle and 7 days; a loopback or private name 12 h and 30 days', async () => {
    const { auth, id } = await (async () => {
      const made = await account();
      made.auth.mfaBegin();
      const secret = Buffer.from(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).totp.secret, 'base64url');
      made.auth.mfaEnable(made.auth.sessions()[0]?.id as string, who(), totpCode(secret, Math.floor(clock / 1000 / 30)));
      return { ...made, id: secret };
    })();
    // a public name needs the second factor, so these two logins give the code
    const full = async (w: Who): Promise<LoginResult> => {
      clock += 31_000;
      const first = await auth.login(w, { user: 'director', password: PASSWORD });
      return first.ok || first.reason !== 'second' ? first : auth.second(w, first.pending, totpCode(id, Math.floor(clock / 1000 / 30)));
    };
    const pub = await full(who({ cls: 'public', address: '8.8.8.8' }));
    const loc = await full(who({ cls: 'private', address: '192.168.0.2' }));
    if (!pub.ok || !loc.ok) throw new Error('login failed');
    const p = who({ cls: 'public' });
    clock += 119 * 60_000;
    expect(auth.session(pub.session, p, 'api')).not.toBeNull();
    clock += 119 * 60_000;
    expect(auth.session(pub.session, p, 'api')).not.toBeNull(); // kept alive by use, in 2 h steps
    clock += 121 * 60_000;
    expect(auth.session(pub.session, p, 'api')).toBeNull(); // 2 h idle
    expect(auth.session(loc.session, who(), 'none')).not.toBeNull(); // 12 h not yet
    clock += 11 * HOUR;
    expect(auth.session(loc.session, who(), 'api')).toBeNull(); // idle 12 h
    // the absolute limit holds against use
    const long = await full(who({ cls: 'public', address: '8.8.4.4' }));
    if (!long.ok) throw new Error('x');
    for (let step = 0; step < 111; step += 1) {
      clock += 90 * 60_000;
      expect(auth.session(long.session, p, 'api'), `step ${step}`).not.toBeNull();
    }
    clock += 90 * 60_000 + 60_000;
    expect(LIFETIME.public.absolute).toBe(7 * 24 * HOUR);
    expect(auth.session(long.session, p, 'api')).toBeNull();
  });

  it('terminal output does not keep a session alive; input does, at most once a minute', async () => {
    const { auth, session } = await account();
    const first = auth.session(session, who(), 'api');
    const t0 = first?.last as number;
    clock += 30_000;
    expect(auth.session(session, who(), 'input')?.last).toBe(t0); // inside the minute: not written
    clock += 40_000;
    expect(auth.session(session, who(), 'input')?.last).toBe(clock);
    const later = clock;
    clock += 10 * 60_000;
    expect(auth.session(session, who(), 'none')?.last).toBe(later); // no touch: output alone changes nothing
  });

  it('revoke, log out, log out everywhere and a password change end sessions and say which ones', async () => {
    const { auth, session, device } = await account();
    const ended: string[][] = [];
    auth.onEnded((ids) => ended.push(ids));
    const w = who({ device });
    const second = await auth.login(w, { user: 'director', password: PASSWORD });
    const third = await auth.login(w, { user: 'director', password: PASSWORD });
    if (!second.ok || !third.ok) throw new Error('x');
    const list = auth.sessions();
    expect(list).toHaveLength(3);
    expect(auth.revoke(list[1]?.short as string)).toBe(true);
    expect(ended.at(-1)).toHaveLength(1);
    expect(auth.revoke('short')).toBe(false);
    expect(auth.session(second.session, w, 'api')).toBeNull();
    // a password change keeps the session that made it and ends every other
    const mine = auth.sessions().find((s) => auth.session(session, w, 'none')?.id === s.id)?.id as string;
    expect(await auth.changePassword(mine, 'wrong password!!', 'another long password')).toBe('wrong');
    expect(await auth.changePassword(mine, PASSWORD, 'another long password')).toBe('wait');
    clock += 2000;
    expect(await auth.changePassword(mine, PASSWORD, 'short')).toBe('weak');
    expect(await auth.changePassword(mine, PASSWORD, 'another long password')).toBe('ok');
    expect(auth.session(session, w, 'api')).not.toBeNull();
    expect(auth.session(third.session, w, 'api')).toBeNull();
    expect(alerts).toContain('the password was changed');
    expect((await auth.login(w, { user: 'director', password: PASSWORD })).ok).toBe(false);
    clock += 2000;
    expect((await auth.login(w, { user: 'director', password: 'another long password' })).ok).toBe(true);
    const extra = await auth.login(who({ device }), { user: 'director', password: 'another long password' });
    expect(extra.ok).toBe(true);
    const out = auth.logoutEverywhere(mine);
    expect(out).toBeGreaterThanOrEqual(1);
    auth.logout(mine);
    expect(auth.sessions()).toEqual([]);
  });
});

describe('after review of the login', () => {
  it('N4: a prefix names one session or key, or none', async () => {
    const { auth, device } = await account();
    const w = who({ device });
    for (let i = 0; i < 3; i += 1) await auth.login(w, { user: 'director', password: PASSWORD });
    // every id here starts with the same eight characters? none does: but a prefix that fits two is refused, and one that fits one works
    const ids = auth.sessions().map((s) => s.id);
    expect(auth.revoke(ids[0]?.slice(0, 7) as string)).toBe(false);
    expect(auth.sessions()).toHaveLength(ids.length);
    expect(auth.revoke(ids[0]?.slice(0, 16) as string)).toBe(true);
    const k1 = auth.addKey('a', 'read', 30, false);
    expect(auth.revokeKey(k1.key.id.slice(0, 7))).toBe(false);
    expect(auth.revokeKey(k1.key.id.slice(0, 12))).toBe(true);
  });

  it('N3: a file with a hash whose cost is huge or odd is damaged, not obeyed', async () => {
    await account();
    const real = JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8'));
    for (const bad of [{ m: 2_000_000_000 }, { t: 1_000_000 }, { p: 500 }, { m: 4 }, { algo: 'scrypt', m: 17, t: 1, p: 1 }, { algo: 'scrypt', m: 2 ** 30, t: 8, p: 1 }, { m: 1.5 }]) {
      writeFileSync(join(home, AUTH_FILE), JSON.stringify({ ...real, password: { ...real.password, ...bad } }));
      expect(open().state(), JSON.stringify(bad)).toBe('damaged');
      rmSync(join(home, `${AUTH_FILE}.bad`), { force: true });
    }
  });

  it('RETRO 3: a reset or an outside edit is seen before the next save writes over it', async () => {
    const { auth, device } = await account();
    resetAuthFiles(home);
    // no check has run since: a login (which saves a session) must not write over the reset
    clock += 2000;
    const result = await auth.login(who({ device }), { user: 'director', password: PASSWORD });
    expect(result.ok).toBe(false);
    expect(auth.state()).toBe('none');
    expect(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).password).toBeNull();
    expect(alerts.filter((a) => /^gonogo auth reset/.test(a))).toHaveLength(1);
  });

  it('RETRO 3: an outside edit, then an own save, is the alarm and not a silent overwrite', async () => {
    const { auth, session } = await account();
    const real = JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8'));
    writeFileSync(join(home, AUTH_FILE), JSON.stringify({ ...real, keys: [{ id: 'e'.repeat(64), name: 'backdoor', scope: 'full', remote: true, created: clock, expires: clock + 1e10, last: null, lastAddress: null }] }));
    // an own write (a key made) before any check
    auth.addKey('mine', 'read', 30, false);
    expect(alerts.some((a) => /changed outside gonogo/.test(a))).toBe(true);
    expect(auth.keys().map((k) => k.name)).toEqual(['mine']);
    expect(auth.locked()).toBe(true);
    expect(auth.session(session, who(), 'none')).not.toBeNull();
  });

  it('RETRO 4: two setups at once make one account, and the second is turned away', async () => {
    const auth = open();
    auth.ensureSetupToken();
    const token = setupToken();
    const both = await Promise.all([
      auth.setup(who({ address: '1.1.1.1' }), { token, user: 'director', password: PASSWORD }, null),
      auth.setup(who({ address: '2.2.2.2' }), { token, user: 'intruder', password: 'another long password' }, null),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(auth.user()).toBe('director');
    expect((await auth.login(who({ address: '3.3.3.3' }), { user: 'director', password: PASSWORD })).ok).toBe(true);
  });

  it('B3: a socket opened by a key is alive while the key is: revoked or expired, it is not', async () => {
    const { auth } = await account();
    const ended: string[][] = [];
    auth.onEnded((ids) => ended.push(ids));
    const made = auth.addKey('k', 'full', 1, false);
    const id = `key:${made.key.id}`;
    expect(auth.alive(id)).toBe(true);
    expect(auth.revokeKey(made.key.id.slice(0, 12))).toBe(true);
    expect(ended.at(-1)).toEqual([id]);
    expect(auth.alive(id)).toBe(false);
    const again = auth.addKey('k2', 'full', 1, false);
    clock += 2 * 24 * HOUR;
    expect(auth.alive(`key:${again.key.id}`)).toBe(false);
    auth.expiredSweep();
    expect(ended.at(-1)).toEqual([`key:${again.key.id}`]);
  });

  it('RETRO 2: setting the account up tells the listener, so a socket of the old token can be closed', async () => {
    const auth = open();
    let told = 0;
    auth.onAccountMade(() => (told += 1));
    auth.ensureSetupToken();
    await auth.setup(who(), { token: setupToken(), user: 'director', password: PASSWORD }, null);
    expect(told).toBe(1);
  });
});

describe('failure buckets (R6)', () => {
  const bad = (auth: AuthStore, w: Who) => auth.login(w, { user: 'director', password: 'not the password' });

  it('wait 1, 2, 4 ... seconds per address, no permanent lockout', async () => {
    const { auth } = await account();
    const w = who({ address: '6.6.6.6' });
    expect(await bad(auth, w)).toEqual({ ok: false, reason: 'wrong' });
    const second = await bad(auth, w);
    expect(second).toMatchObject({ ok: false, reason: 'wait' });
    clock += 1100;
    expect(await bad(auth, w)).toEqual({ ok: false, reason: 'wrong' });
    clock += 1500;
    expect(await bad(auth, w)).toMatchObject({ reason: 'wait' });
    clock += 2100;
    expect(await bad(auth, w)).toEqual({ ok: false, reason: 'wrong' });
    // the wait grows to 15 minutes and stays there; the right password after the wait still works
    for (let i = 0; i < 20; i += 1) {
      clock += 16 * 60_000;
      await bad(auth, w);
    }
    clock += 16 * 60_000;
    expect((await auth.login(w, { user: 'director', password: PASSWORD })).ok).toBe(true);
  });

  it('a flood from unknown devices does not slow a known device, and the global bucket slows other unknown ones', async () => {
    const { auth, device } = await account();
    for (let i = 0; i < 25; i += 1) {
      clock += 20_000;
      await bad(auth, who({ address: `7.7.${i}.1` }));
    }
    const known = who({ address: '7.7.99.9', device });
    expect((await auth.login(known, { user: 'director', password: PASSWORD })).ok).toBe(true);
    // a stranger on a fresh address meets the global bucket
    expect(await auth.login(who({ address: '7.7.200.1' }), { user: 'director', password: PASSWORD })).toMatchObject({ ok: false, reason: 'wait' });
    // twenty failures from unknown devices in ten minutes raised an alert, once
    expect(alerts.filter((a) => /failed logins/.test(a)).length).toBe(1);
  });

  it('a known device has its own bucket: its failures slow it, not the others', async () => {
    const { auth, device } = await account();
    const known = who({ device });
    await bad(auth, known);
    expect(await bad(auth, known)).toMatchObject({ reason: 'wait' });
    expect((await auth.login(who({ address: '8.1.1.1' }), { user: 'director', password: PASSWORD })).ok).toBe(true);
  });

  it('a device cookie signed with another key is a stranger', async () => {
    const { auth, device } = await account();
    expect(auth.deviceOf(device)).not.toBeNull();
    expect(auth.deviceOf(`${device.split('.')[0]}.AAAA`)).toBeNull();
    expect(auth.deviceOf('nonsense')).toBeNull();
    expect(auth.deviceOf(undefined)).toBeNull();
  });
});

describe('API keys (R7)', () => {
  it('are shown once, stored hashed, expire (90 days by default), and carry their last use with the address', async () => {
    const { auth } = await account();
    const { secret, key } = auth.addKey('ci', 'act', null, false);
    expect(secret).toMatch(/^gnk_[\w-]{43}$/);
    expect(readFileSync(join(home, AUTH_FILE), 'utf8')).not.toContain(secret);
    expect(key.expires - key.created).toBe(90 * 24 * HOUR);
    expect(alerts.at(-1)).toMatch(/new API key was made \(ci, act\)/);
    expect(auth.key(secret, who({ address: '4.4.4.4' }))?.scope).toBe('act');
    expect(auth.keys()[0]).toMatchObject({ last: clock, lastAddress: '4.4.4.4' });
    expect(auth.key(`${secret}x`, who())).toBeNull();
    expect(auth.key('gnk_nonsense', who())).toBeNull();
    clock += 91 * 24 * HOUR;
    expect(auth.key(secret, who())).toBeNull();
  });

  it('are refused from a public Host unless made with --remote, and can be revoked', async () => {
    const { auth } = await account();
    const local = auth.addKey('local', 'read', 30, false).secret;
    const remote = auth.addKey('remote', 'read', 30, true).secret;
    expect(auth.key(local, who({ cls: 'public' }))).toBeNull();
    expect(auth.key(remote, who({ cls: 'public' }))).not.toBeNull();
    expect(auth.key(local, who({ cls: 'private' }))).not.toBeNull();
    const short = auth.keys().find((k) => k.name === 'remote')?.short as string;
    expect(auth.revokeKey(short)).toBe(true);
    expect(auth.key(remote, who({ cls: 'public' }))).toBeNull();
    expect(auth.revokeKey('abc')).toBe(false);
  });

  it('scopes: read reads, act adds messages, answers, hold and resume, full does the rest but never the account', () => {
    expect(keyMayDo('read', 'GET', '/api/state')).toBe(true);
    expect(keyMayDo('read', 'GET', '/api/terminal/x')).toBe(false);
    expect(keyMayDo('read', 'POST', '/api/messages')).toBe(false);
    expect(keyMayDo('act', 'POST', '/api/messages')).toBe(true);
    expect(keyMayDo('act', 'POST', '/api/agents/ana/answer')).toBe(true);
    expect(keyMayDo('act', 'POST', '/api/agents/ana/hold')).toBe(true);
    expect(keyMayDo('act', 'POST', '/api/agents/ana/resume')).toBe(true);
    expect(keyMayDo('act', 'POST', '/api/relief/r1/go')).toBe(true);
    expect(keyMayDo('act', 'POST', '/api/agents')).toBe(false);
    expect(keyMayDo('act', 'DELETE', '/api/agents/ana')).toBe(false);
    expect(keyMayDo('full', 'POST', '/api/agents')).toBe(true);
    for (const scope of ['read', 'act', 'full'] as const) expect(keyMayDo(scope, 'GET', '/api/auth/account'), scope).toBe(false);
  });
});

describe('reset and the tamper alarm', () => {
  it('gonogo auth reset, offline, empties the account and writes the setup token without returning it', async () => {
    const { auth } = await account();
    const message = resetAuthFiles(home);
    expect(message).not.toMatch(/[0-9a-f]{64}/);
    expect(statSync(join(home, SETUP_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    // a running server sees it: the alert, every session ends, the account is empty, public hosts see "not set up"
    const ended: string[][] = [];
    auth.onEnded((ids) => ended.push(ids));
    auth.checkTamper(true);
    expect(alerts).toEqual([expect.stringMatching(/^gonogo auth reset/)]);
    expect(ended).toHaveLength(1);
    expect(auth.state()).toBe('none');
    expect(auth.sessions()).toEqual([]);
    expect(auth.keys()).toEqual([]);
    expect(auth.locked()).toBe(false);
    expect(await auth.login(who(), { user: 'director', password: PASSWORD })).toEqual({ ok: false, reason: 'off' });
    expect(await auth.setup(who({ cls: 'public' }), { token: setupToken(), user: 'director', password: PASSWORD }, null)).toEqual({ ok: false, reason: 'setup' });
    // a reset while the server is stopped is the same, noticed at the next start
    const second = await (async () => {
      const made = await auth.setup(who(), { token: setupToken(), user: 'director', password: PASSWORD }, null);
      return made;
    })();
    expect(second.ok).toBe(true);
    auth.close();
    resetAuthFiles(home);
    alerts.length = 0;
    const restarted = open();
    expect(restarted.state()).toBe('none');
    expect(alerts).toEqual([expect.stringMatching(/^gonogo auth reset/)]);
  });

  it('a write to auth.json by another process raises the alert, drops what gonogo did not make, and pauses remote logins until the Director confirms', async () => {
    const { auth, session, device } = await account();
    const real = JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8'));
    const planted = { ...real, sessions: [...real.sessions, { id: 'f'.repeat(64), created: clock, last: clock, address: '6.6.6.6', agent: 'x', device: 'd', cls: 'public' }], keys: [{ id: 'e'.repeat(64), name: 'backdoor', scope: 'full', remote: true, created: clock, expires: clock + 1e10, last: null, lastAddress: null }], serverKey: 'planted' };
    writeFileSync(join(home, AUTH_FILE), JSON.stringify(planted));
    const ended: string[][] = [];
    auth.onEnded((ids) => ended.push(ids));
    auth.checkTamper(true);
    expect(alerts).toEqual([expect.stringMatching(/auth\.json changed outside gonogo/)]);
    expect(auth.keys()).toEqual([]);
    expect(auth.sessions().map((s) => s.id)).not.toContain('f'.repeat(64));
    // what gonogo made itself stays
    expect(auth.session(session, who({ device }), 'api')).not.toBeNull();
    expect(auth.locked()).toBe(true);
    // the file is put back from memory: the planted serverKey is gone, and a device cookie forged with it is invalid
    expect(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).serverKey).toBe(real.serverKey);
    expect(auth.deviceOf(device)).not.toBeNull();
    // remote logins are paused; local ones are not
    expect(await auth.login(who({ cls: 'public', address: '1.1.1.1' }), { user: 'director', password: PASSWORD })).toEqual({ ok: false, reason: 'locked' });
    expect((await auth.login(who({ address: '127.0.0.1', device }), { user: 'director', password: PASSWORD })).ok).toBe(true);
    // the server's own writes do not raise it again
    alerts.length = 0;
    auth.checkTamper(true);
    expect(alerts).toEqual([]);
  });

  it('confirming needs the Director\'s password, checked against the account in memory: a password planted in the file confirms nothing', async () => {
    const { auth } = await account();
    const planted = await hashPassword('planted password!!', COSTS);
    const real = JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8'));
    writeFileSync(join(home, AUTH_FILE), JSON.stringify({ ...real, password: planted }));
    auth.checkTamper(true);
    expect(auth.locked()).toBe(true);
    expect(await auth.confirm(who(), 'planted password!!')).toBe('wrong');
    expect(auth.locked()).toBe(true);
    clock += 3000;
    expect(await auth.confirm(who(), PASSWORD)).toBe('ok');
    expect(auth.locked()).toBe(false);
    expect(await auth.confirm(who(), PASSWORD)).toBe('none');
    // and the planted password never opened a login
    expect((await auth.login(who({ address: '2.3.4.5' }), { user: 'director', password: 'planted password!!' })).ok).toBe(false);
  });

  it('a write labelled as a reset that carries a session, key, device or password is reduced to the empty account', async () => {
    const { auth } = await account();
    const real = JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8'));
    writeFileSync(join(home, AUTH_FILE), JSON.stringify({ ...real, reset: true }));
    auth.checkTamper(true);
    expect(auth.state()).toBe('none');
    expect(auth.sessions()).toEqual([]);
    expect(auth.devices()).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).password).toBeNull();
    expect(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).reset).toBeUndefined();
  });

  it('a removed or garbled file is the same alarm and is put back', async () => {
    const { auth, session } = await account();
    rmSync(join(home, AUTH_FILE));
    auth.checkTamper(true);
    expect(alerts).toEqual([expect.stringMatching(/removed outside gonogo/)]);
    expect(existsSync(join(home, AUTH_FILE))).toBe(true);
    alerts.length = 0;
    writeFileSync(join(home, AUTH_FILE), '{not json');
    auth.checkTamper(true);
    expect(alerts).toEqual([expect.stringMatching(/changed outside gonogo/)]);
    expect(auth.state()).toBe('account');
    // the account in memory is the truth: what gonogo made stays, the file is written back
    expect(auth.session(session, who(), 'api')).not.toBeNull();
    expect(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).user).toBe('director');
  });

  it('the check runs once a second on a request, and on a timer', async () => {
    const auth = openAuth({ home, alert: (t) => alerts.push(t), now: () => clock, costs: COSTS, tamperEveryMs: 20 });
    stores.push(auth);
    auth.ensureSetupToken();
    const made = await auth.setup(who(), { token: setupToken(), user: 'director', password: PASSWORD }, null);
    expect(made.ok).toBe(true);
    alerts.length = 0;
    const real = JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8'));
    writeFileSync(join(home, AUTH_FILE), JSON.stringify({ ...real, user: 'someone else' }));
    await new Promise((r) => setTimeout(r, 120));
    expect(alerts).toEqual([expect.stringMatching(/changed outside gonogo/)]);
    expect(auth.user()).toBe('director');
  });
});

describe('a damaged file', () => {
  it('is kept as .bad, and page logins are refused until a reset', async () => {
    writeFileSync(join(home, AUTH_FILE), '{"version": 1, "user": 5}');
    chmodSync(join(home, AUTH_FILE), 0o600);
    const auth = open();
    expect(auth.state()).toBe('damaged');
    expect(auth.tokenAllowed()).toBe(false);
    expect(existsSync(join(home, `${AUTH_FILE}.bad`))).toBe(true);
    expect(await auth.login(who(), { user: 'director', password: PASSWORD })).toEqual({ ok: false, reason: 'damaged' });
    expect(auth.ensureSetupToken()).toBeNull();
    expect(authStateOf(home)).toBe('damaged');
    resetAuthFiles(home);
    expect(open().state()).toBe('none');
  });
});

/* ------------------------------------------------------------------ PR 2: the second factor and step-up */

describe('TOTP (RFC 6238, SHA-1, six digits, thirty seconds)', () => {
  const rfc = Buffer.from('12345678901234567890');
  it('gives the codes of the RFC\'s vectors (its eight digits, last six)', () => {
    expect(totpCode(rfc, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(rfc, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(rfc, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totpCode(rfc, Math.floor(2000000000 / 30))).toBe('279037');
    expect(base32(rfc)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('takes one step either side and no more, and a step only once', () => {
    const at = 1_700_000_000_000;
    const step = Math.floor(at / 1000 / 30);
    expect(matchTotp(rfc, totpCode(rfc, step), at, 0)).toBe(step);
    expect(matchTotp(rfc, totpCode(rfc, step - 1), at, 0)).toBe(step - 1);
    expect(matchTotp(rfc, totpCode(rfc, step + 1), at, 0)).toBe(step + 1);
    expect(matchTotp(rfc, totpCode(rfc, step + 2), at, 0)).toBeNull();
    expect(matchTotp(rfc, totpCode(rfc, step - 2), at, 0)).toBeNull();
    // the last accepted step and the ones before it are spent
    expect(matchTotp(rfc, totpCode(rfc, step), at, step)).toBeNull();
    expect(matchTotp(rfc, totpCode(rfc, step - 1), at, step)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456']) expect(matchTotp(rfc, bad, at, 0), bad).toBeNull();
  });
});

describe('turning the second factor on and logging in with it', () => {
  const secretOf = (): Buffer => Buffer.from(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).totp.secret, 'base64url');
  const codeNow = (): string => totpCode(secretOf(), Math.floor(clock / 1000 / 30));
  /** An account with TOTP on; returns the recovery codes. */
  async function withTotp(): Promise<{ auth: AuthStore; session: string; device: string; recovery: string[]; id: string }> {
    const made = await account();
    const id = made.auth.sessions()[0]?.id as string;
    const begun = made.auth.mfaBegin();
    expect(begun.uri).toMatch(/^otpauth:\/\/totp\/gonogo:director\?secret=[A-Z2-7]+&issuer=gonogo&algorithm=SHA1&digits=6&period=30$/);
    expect(begun.secret).toBe(base32(secretOf()));
    const on = made.auth.mfaEnable(id, who(), codeNow());
    if (!on.ok) throw new Error('enable failed');
    alerts.length = 0;
    clock += 31_000;
    return { ...made, recovery: on.recovery, id };
  }

  it('a first valid code switches it on, and the ten recovery codes are shown once and stored hashed', async () => {
    const made = await account();
    const id = made.auth.sessions()[0]?.id as string;
    expect(made.auth.mfa()).toEqual({ enabled: false, pending: false, recoveryLeft: 0 });
    made.auth.mfaBegin();
    expect(made.auth.mfa()).toEqual({ enabled: false, pending: true, recoveryLeft: 0 });
    // a wrong code leaves it off, and waits
    expect(made.auth.mfaEnable(id, who(), '000000')).toEqual({ ok: false, reason: 'wrong' });
    expect(made.auth.mfaEnable(id, who(), codeNow())).toEqual({ ok: false, reason: 'wait' });
    clock += 2000;
    const on = made.auth.mfaEnable(id, who(), codeNow());
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.recovery).toHaveLength(RECOVERY_COUNT);
    expect(new Set(on.recovery).size).toBe(RECOVERY_COUNT);
    for (const code of on.recovery) expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
    const file = readFileSync(join(home, AUTH_FILE), 'utf8');
    for (const code of on.recovery) expect(file).not.toContain(code);
    expect(made.auth.mfa()).toEqual({ enabled: true, pending: false, recoveryLeft: 10 });
    expect(alerts).toContain('a second factor (TOTP) was turned on');
    // already on: a new secret cannot be asked for without turning it off first
    expect(made.auth.mfaEnable(id, who(), codeNow())).toEqual({ ok: false, reason: 'none' });
  });

  it('a login with the password alone answers "second", and the code finishes it; the code works once', async () => {
    const { auth } = await withTotp();
    const first = await auth.login(who({ address: '9.9.9.9' }), { user: 'director', password: PASSWORD });
    expect(first).toMatchObject({ ok: false, reason: 'second' });
    if (first.ok || first.reason !== 'second') return;
    const done = await auth.second(who({ address: '9.9.9.9' }), first.pending, codeNow());
    expect(done.ok).toBe(true);
    // the same code again (same 30-second step) is refused, the token of a login is spent, and a later step opens
    const spent = await auth.login(who({ address: '9.9.9.6' }), { user: 'director', password: PASSWORD });
    if (spent.ok || spent.reason !== 'second') throw new Error('x');
    expect(await auth.second(who({ address: '9.9.9.6' }), spent.pending, codeNow())).toEqual({ ok: false, reason: 'wrong' });
    clock += 40_000;
    expect((await auth.second(who({ address: '9.9.9.6' }), spent.pending, codeNow())).ok).toBe(true);
    const third = await auth.login(who({ address: '9.9.9.7' }), { user: 'director', password: PASSWORD });
    if (third.ok || third.reason !== 'second') throw new Error('x');
    expect(await auth.second(who({ address: '9.9.9.7' }), third.pending, codeNow())).toEqual({ ok: false, reason: 'wrong' });
    expect(await auth.second(who({ address: '9.9.9.7' }), first.pending, codeNow())).toEqual({ ok: false, reason: 'wrong' });
  });

  it('a wrong code counts in the same buckets as a wrong password, and a right password does not clear them', async () => {
    const { auth } = await withTotp();
    const w = who({ address: '4.4.4.4' });
    const first = await auth.login(w, { user: 'director', password: PASSWORD });
    if (first.ok || first.reason !== 'second') throw new Error('x');
    expect(await auth.second(w, first.pending, '000000')).toEqual({ ok: false, reason: 'wrong' });
    // the next try is made to wait, whichever of the two it is
    expect(await auth.second(w, first.pending, '000000')).toMatchObject({ reason: 'wait' });
    expect(await auth.login(w, { user: 'director', password: PASSWORD })).toMatchObject({ reason: 'wait' });
    clock += 1100;
    // a password that is right again does not wipe the failure: the code is not guessable round after round
    const second = await auth.login(w, { user: 'director', password: PASSWORD });
    if (second.ok || second.reason !== 'second') throw new Error('x');
    expect(await auth.second(w, second.pending, '111111')).toEqual({ ok: false, reason: 'wrong' });
    clock += 1500;
    expect(await auth.second(w, second.pending, '111111')).toMatchObject({ reason: 'wait' });
  });

  it('five wrong codes end the login: the password has to be given again', async () => {
    const { auth } = await withTotp();
    const w = who({ address: '4.5.6.7' });
    const first = await auth.login(w, { user: 'director', password: PASSWORD });
    if (first.ok || first.reason !== 'second') throw new Error('x');
    for (let i = 0; i < 5; i += 1) {
      clock += 20 * 60_000;
      expect(await auth.second(w, first.pending, '000000')).toEqual({ ok: false, reason: 'wrong' });
    }
    clock += 20 * 60_000;
    expect(await auth.second(w, first.pending, codeNow())).toEqual({ ok: false, reason: 'wrong' });
  });

  it('a recovery code logs in once, in any case and with spaces or dashes, and the count goes down', async () => {
    const { auth, recovery } = await withTotp();
    const w = who({ address: '3.2.1.0' });
    const first = await auth.login(w, { user: 'director', password: PASSWORD });
    if (first.ok || first.reason !== 'second') throw new Error('x');
    const typed = `${recovery[0]?.slice(0, 5).toLowerCase()}-${recovery[0]?.slice(5)}`;
    expect((await auth.second(w, first.pending, typed)).ok).toBe(true);
    expect(auth.mfa().recoveryLeft).toBe(9);
    expect(alerts).toContain('a recovery code was used (9 left)');
    clock += 20 * 60_000;
    const again = await auth.login(w, { user: 'director', password: PASSWORD });
    if (again.ok || again.reason !== 'second') throw new Error('x');
    expect(await auth.second(w, again.pending, recovery[0] as string)).toEqual({ ok: false, reason: 'wrong' });
  });

  it('a pending login is good for five minutes', async () => {
    const { auth } = await withTotp();
    const first = await auth.login(who({ address: '8.7.6.5' }), { user: 'director', password: PASSWORD });
    if (first.ok || first.reason !== 'second') throw new Error('x');
    clock += 5 * 60_000 + 1000;
    expect(await auth.second(who({ address: '8.7.6.5' }), first.pending, codeNow())).toEqual({ ok: false, reason: 'wrong' });
  });

  it('a public name needs a second factor: with none on, the password alone is refused there and still works on this machine', async () => {
    const { auth } = await account();
    expect(await auth.login(who({ cls: 'public', address: '1.2.3.4' }), { user: 'director', password: PASSWORD })).toEqual({ ok: false, reason: 'needmfa' });
    expect((await auth.login(who({ cls: 'private', address: '192.168.1.2' }), { user: 'director', password: PASSWORD })).ok).toBe(true);
    expect((await auth.login(who(), { user: 'director', password: PASSWORD })).ok).toBe(true);
    // with TOTP on, a public name asks for the code and lets it in
    const id = auth.sessions()[0]?.id as string;
    auth.mfaBegin();
    clock += 2000;
    auth.mfaEnable(id, who(), codeNow());
    clock += 31_000;
    const pub = who({ cls: 'public', address: '1.2.3.4' });
    const first = await auth.login(pub, { user: 'director', password: PASSWORD });
    if (first.ok || first.reason !== 'second') throw new Error('x');
    expect((await auth.second(pub, first.pending, codeNow())).ok).toBe(true);
  });

  it('turning it off, or making new recovery codes, needs the password and a current code, and a stolen session alone cannot', async () => {
    const { auth, id, recovery } = await withTotp();
    expect(await auth.mfaDisable(id, who(), { password: PASSWORD, code: '000000' })).toBe('wrong');
    clock += 2000;
    expect(await auth.mfaDisable(id, who(), { password: 'not the password', code: codeNow() })).toBe('wrong');
    clock += 3000;
    expect(auth.mfa().enabled).toBe(true);
    const fresh = await auth.mfaRecovery(id, who(), { password: PASSWORD, code: codeNow() });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.recovery).not.toEqual(recovery);
    expect(alerts.at(-1)).toMatch(/new recovery codes were made/);
    // the old codes are dead, the new ones are not
    clock += 60_000;
    expect(await auth.mfaDisable(id, who(), { password: PASSWORD, code: recovery[0] as string })).toBe('wrong');
    clock += 20 * 60_000;
    expect(await auth.mfaDisable(id, who(), { password: PASSWORD, code: fresh.recovery[0] as string })).toBe('ok');
    expect(auth.mfa()).toEqual({ enabled: false, pending: false, recoveryLeft: 0 });
    expect(alerts.at(-1)).toBe('the second factor (TOTP) was turned off');
    expect(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).totp).toBeNull();
  });

  it('a recovery code left in the file is no second factor once TOTP is off', async () => {
    const { auth, id, recovery } = await withTotp();
    clock += 20 * 60_000;
    expect(await auth.mfaDisable(id, who(), { password: PASSWORD, code: recovery[0] as string })).toBe('ok');
    // the codes are gone with it; a file that still held one (an outside write) would not do either
    const real = JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8'));
    expect(real.recovery).toEqual([]);
    clock += 60_000;
    expect(await auth.stepUp(id, who(), { password: PASSWORD, code: recovery[1] as string })).toMatchObject({ ok: true });
    expect(await auth.mfaRecovery(id, who(), { password: PASSWORD, code: recovery[2] as string })).toEqual({ ok: false, reason: 'none' });
  });

  it('survives a restart, and a reset takes it away', async () => {
    const { auth } = await withTotp();
    auth.close();
    const again = open();
    expect(again.mfa()).toEqual({ enabled: true, pending: false, recoveryLeft: 10 });
    resetAuthFiles(home);
    again.checkTamper(true);
    expect(again.mfa()).toEqual({ enabled: false, pending: false, recoveryLeft: 0 });
  });
});

describe('step-up', () => {
  it('a session is fresh for five minutes after its password check; then the check is asked again, and the id is minted again', async () => {
    const { auth, session } = await account();
    const id = auth.sessions()[0]?.id as string;
    const moved: Array<[string, string]> = [];
    auth.onReminted((from, to) => moved.push([from, to]));
    expect(auth.stepFresh(id)).toBe(true);
    clock += STEP_UP_MS + 1000;
    expect(auth.stepFresh(id)).toBe(false);
    expect(await auth.stepUp(id, who(), { password: 'not the password', code: '' })).toEqual({ ok: false, reason: 'wrong' });
    clock += 2000;
    const done = await auth.stepUp(id, who(), { password: PASSWORD, code: '' });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    // the old cookie value is dead and the new one is fresh; the sockets are told
    expect(auth.session(session, who(), 'api')).toBeNull();
    const next = auth.session(done.session, who(), 'api');
    expect(next).not.toBeNull();
    expect(auth.stepFresh(next?.id as string)).toBe(true);
    expect(moved).toEqual([[id, next?.id]]);
    expect(await auth.stepUp(id, who(), { password: PASSWORD, code: '' })).toEqual({ ok: false, reason: 'gone' });
  });

  it('asks for a code too when a second factor is on', async () => {
    const made = await account();
    const id = made.auth.sessions()[0]?.id as string;
    made.auth.mfaBegin();
    const secret = Buffer.from(JSON.parse(readFileSync(join(home, AUTH_FILE), 'utf8')).totp.secret, 'base64url');
    made.auth.mfaEnable(id, who(), totpCode(secret, Math.floor(clock / 1000 / 30)));
    clock += STEP_UP_MS + 31_000;
    expect(await made.auth.stepUp(id, who(), { password: PASSWORD, code: '' })).toEqual({ ok: false, reason: 'wrong' });
    clock += 2000;
    expect((await made.auth.stepUp(id, who(), { password: PASSWORD, code: totpCode(secret, Math.floor(clock / 1000 / 30)) })).ok).toBe(true);
  });
});
