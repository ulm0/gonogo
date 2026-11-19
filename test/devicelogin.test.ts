// The device login of a terminal (docs/login-spec.md, TUI device login): the flows, the caps, the session of kind tui.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanText, LIFETIME, networkOf, openAuth, TUI_PREFIX } from '../src/server/auth.js';
import type { AuthStore, Who } from '../src/server/auth.js';
import { createDevices, DEVICE_EXPIRES_S, normalizeCode } from '../src/server/devicelogin.js';
import type { Devices } from '../src/server/devicelogin.js';

const COSTS = { argon2: { memory: 16, passes: 1, parallelism: 1 }, scrypt: { N: 16, r: 1, p: 1 } };
const PASSWORD = 'correct horse battery staple';
const URI = 'https://gonogo.example.com/login/device';
let home: string;
let clock: number;
let alerts: string[];
let notices: string[];
let auth: AuthStore;
let devices: Devices;

const who = (over: Partial<Who> = {}): Who => ({ address: '203.0.113.5', agent: 'gonogo-tui/1', cls: 'public', ...over });
const browser = (over: Partial<Who> = {}): Who => ({ address: '203.0.113.9', agent: 'Firefox', cls: 'public', ...over });
const codeOf = (flow: { user_code: string }): string => flow.user_code;
const start = (w = who(), label: unknown = 'laptop'): { device_code: string; user_code: string } => {
  const r = devices.start(w, label, URI);
  if (!r.ok) throw new Error(`start refused: ${r.reason}`);
  return r.flow;
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gng-device-'));
  clock = Date.now();
  alerts = [];
  notices = [];
  auth = openAuth({ home, alert: (t) => alerts.push(t), notice: (t) => notices.push(t), now: () => clock, costs: COSTS, tamperEveryMs: 0 });
  auth.ensureSetupToken();
  const made = await auth.setup({ address: '127.0.0.1', agent: 'x', cls: 'loopback' }, { token: readFileSync(join(home, 'setup-token'), 'utf8').trim(), user: 'director', password: PASSWORD }, null);
  if (!made.ok) throw new Error('setup');
  devices = createDevices({ auth, now: () => clock, alert: (t) => alerts.push(t), notice: (t) => notices.push(t) });
  alerts.length = 0;
});
afterEach(() => {
  auth.close();
  rmSync(home, { recursive: true, force: true });
});

describe('starting a flow', () => {
  it('gives the device code, an eight-letter code shown as XXXX-XXXX from an alphabet without 0 O 1 I L, the address (with no code in it), ten minutes and five seconds', () => {
    const r = devices.start(who(), 'laptop', URI);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow).toMatchObject({ verification_uri: URI, expires_in: 600, interval: 5 });
    expect(r.flow.user_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
    expect(r.flow.device_code).toMatch(/^[\w-]{43}$/);
    expect(r.flow.verification_uri).not.toContain(r.flow.user_code.replace('-', ''));
    expect(DEVICE_EXPIRES_S).toBe(600);
  });

  it('puts a notice on the open pages when a flow starts, naming the address, and nothing secret', () => {
    const flow = start();
    expect(notices).toEqual([expect.stringContaining('203.0.113.5')]);
    expect(notices.join()).not.toContain(flow.device_code);
    expect(notices.join()).not.toContain(flow.user_code);
    expect(alerts).toEqual([]);
  });

  it('M2: the name and the program are cut and cleaned: markup stays as inert text, control and direction marks go', () => {
    const flow = start(who({ agent: `agent‮\u0007 ${'x'.repeat(300)}` }), `<img src=x onerror=alert(1)>‮gnp.exe​${'y'.repeat(100)}`);
    const found = devices.find('s', browser(), flow.user_code);
    expect(found).toHaveProperty('view');
    if (found === null || 'wait' in found) return;
    // the markup is kept as plain text (the page writes it as text, never as HTML); the direction mark and the zero-width character are gone
    expect(found.view.label.startsWith('<img src=x onerror=alert(1)>')).toBe(true);
    expect(found.view.label).not.toMatch(/[‮​\u0007]/);
    expect(found.view.label.length).toBeLessThanOrEqual(40);
    expect(found.view.agent).not.toMatch(/[‮\u0007]/);
    expect(found.view.agent.length).toBeLessThanOrEqual(200);
    expect(cleanText(undefined, 40)).toBe('');
    expect(cleanText(5, 40)).toBe('');
  });

  it('S1: two waiting at once per address and five in all; the sixth is refused, and an address is not taken out by another', () => {
    start(who());
    start(who());
    expect(devices.start(who(), 'x', URI)).toEqual({ ok: false, reason: 'cap' });
    for (const n of [6, 7, 8]) start(who({ address: `203.0.113.${n}` }));
    expect(devices.start(who({ address: '203.0.113.99' }), 'x', URI)).toEqual({ ok: false, reason: 'cap' });
  });

  it('five starts per address in ten minutes, then a wait; thirty an hour in all', () => {
    for (let i = 0; i < 5; i += 1) {
      const f = start(who());
      devices.decide('s', browser(), f.user_code, false);
      devices.poll(who(), f.device_code);
    }
    expect(devices.start(who(), 'x', URI)).toEqual({ ok: false, reason: 'rate' });
    clock += 10 * 60_000 + 1000;
    expect(devices.start(who(), 'x', URI).ok).toBe(true);
    // in all: thirty, from many addresses
    clock += 3_600_000;
    let made = 0;
    for (let i = 0; made < 30; i += 1) {
      const w = who({ address: `198.51.${Math.floor(i / 2)}.${i % 250}` });
      const r = devices.start(w, 'x', URI);
      if (r.ok) {
        made += 1;
        devices.decide('s', browser(), r.flow.user_code, false);
        devices.poll(w, r.flow.device_code);
        clock += 1000;
      }
      if (i > 400) break;
    }
    expect(made).toBe(30);
    expect(devices.start(who({ address: '192.0.2.77' }), 'x', URI)).toEqual({ ok: false, reason: 'rate' });
  });
});

describe('the poll', () => {
  it('pending, slow_down for a poll before the interval (and five more seconds asked), the token once approved, and then nothing', () => {
    const flow = start();
    expect(devices.poll(who(), flow.device_code)).toEqual({ error: 'authorization_pending' });
    clock += 1000;
    expect(devices.poll(who(), flow.device_code)).toEqual({ error: 'slow_down' });
    clock += 6000;
    expect(devices.poll(who(), flow.device_code)).toEqual({ error: 'authorization_pending' });
    expect(devices.decide('s1', browser(), flow.user_code, true)).toMatchObject({ ok: true });
    clock += 6000;
    const got = devices.poll(who(), flow.device_code);
    expect(got).toMatchObject({ token: expect.stringMatching(new RegExp(`^${TUI_PREFIX}[\\w-]{43}$`)) });
    clock += 6000;
    expect(devices.poll(who(), flow.device_code)).toEqual({ error: 'expired_token' });
    expect(devices.open()).toBe(0);
  });

  it('M4: two polls at once with one device code give exactly one token and one session', () => {
    const flow = start();
    devices.decide('s1', browser(), flow.user_code, true);
    clock += 6000;
    const results = [devices.poll(who(), flow.device_code), devices.poll(who(), flow.device_code), devices.poll(who(), flow.device_code)];
    expect(results.filter((r) => 'token' in r)).toHaveLength(1);
    expect(auth.sessions().filter((s) => s.kind === 'tui')).toHaveLength(1);
  });

  it('a wrong, an unknown and an oversized device code are expired; a denied flow says so once', () => {
    const flow = start();
    for (const bad of ['nonsense', '', 5, null, 'x'.repeat(500)]) expect(devices.poll(who(), bad), String(bad)).toEqual({ error: 'expired_token' });
    expect(devices.decide('s1', browser(), flow.user_code, false)).toMatchObject({ ok: true });
    clock += 6000;
    expect(devices.poll(who(), flow.device_code)).toEqual({ error: 'access_denied' });
    clock += 6000;
    expect(devices.poll(who(), flow.device_code)).toEqual({ error: 'expired_token' });
  });

  it('ten minutes end a flow, and an approved one that nobody polls within two minutes', () => {
    const slow = start();
    clock += 601_000;
    expect(devices.poll(who(), slow.device_code)).toEqual({ error: 'expired_token' });
    expect(devices.find('s', browser(), slow.user_code)).toBeNull();
    const idle = start();
    devices.decide('s1', browser(), idle.user_code, true);
    clock += 121_000;
    expect(devices.poll(who(), idle.device_code)).toEqual({ error: 'expired_token' });
  });

  it('a poll faster than the interval, many times, ends in a refusal', () => {
    const flow = start();
    devices.poll(who(), flow.device_code);
    let last: unknown;
    for (let i = 0; i < 40; i += 1) last = devices.poll(who(), flow.device_code);
    expect(last).toEqual({ rate: true });
  });
});

describe('approving', () => {
  it('a code is typed in any case, with or without the dash, and works once: approve, deny and a second try all end it', () => {
    const flow = start();
    expect(normalizeCode(' ab-cd 23k4 ')).toBe('ABCD23K4');
    const typed = flow.user_code.toLowerCase().replace('-', ' ');
    expect(devices.find('s1', browser(), typed)).toHaveProperty('view');
    expect(devices.decide('s1', browser(), typed, true)).toMatchObject({ ok: true, label: 'laptop' });
    expect(devices.decide('s1', browser(), typed, true)).toEqual({ ok: false, reason: 'none' });
    expect(devices.decide('s1', browser(), flow.user_code, false)).toEqual({ ok: false, reason: 'none' });
  });

  it('M3: the flow acted on is the one the typed code names; another flow\'s device code or a wrong code names nothing', () => {
    const one = start(who({ address: '203.0.113.5' }), 'one');
    const two = start(who({ address: '203.0.113.6' }), 'two');
    expect(devices.decide('s1', browser(), two.user_code, true)).toMatchObject({ ok: true, label: 'two' });
    clock += 6000;
    expect(devices.poll(who({ address: '203.0.113.5' }), one.device_code)).toEqual({ error: 'authorization_pending' });
    expect(devices.poll(who({ address: '203.0.113.6' }), two.device_code)).toHaveProperty('token');
    expect(devices.decide('s1', browser(), one.device_code, true)).toEqual({ ok: false, reason: 'none' });
  });

  it('five wrong codes in ten minutes from one session, then it waits; another session is not held', () => {
    const flow = start();
    for (let i = 0; i < 5; i += 1) expect(devices.find('s1', browser(), 'AAAA-AAA' + i)).toBeNull();
    expect(devices.find('s1', browser(), flow.user_code)).toEqual({ wait: true });
    expect(devices.find('s2', browser(), flow.user_code)).toHaveProperty('view');
    clock += 10 * 60_000 + 1000;
  });

  it('the page shows whether the terminal is on another network than the browser: /24 and /64', () => {
    const near = start(who({ address: '203.0.113.5' }));
    const far = start(who({ address: '198.51.100.7' }));
    const a = devices.find('s', browser({ address: '203.0.113.200' }), near.user_code);
    const b = devices.find('s', browser({ address: '203.0.113.200' }), far.user_code);
    expect(a && 'view' in a && a.view.far).toBe(false);
    expect(b && 'view' in b && b.view.far).toBe(true);
    expect(networkOf('203.0.113.5')).toBe('203.0.113.0/24');
    expect(networkOf('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(networkOf('::ffff:10.1.2.3')).toBe('10.1.2.0/24');
  });

  it('an approval is a redline alert with the label, the terminal and the browser, and no secret; a denial and an expiry are not', () => {
    const flow = start(who(), 'build box');
    devices.decide('s1', browser({ address: '203.0.113.9', agent: 'Firefox 140' }), flow.user_code, true);
    clock += 6000;
    const got = devices.poll(who(), flow.device_code);
    expect(alerts).toEqual([expect.stringMatching(/TUI session approved: build box, from 203\.0\.113\.5, approved from 203\.0\.113\.9 \(Firefox 140\)/)]);
    expect(alerts.join()).not.toContain(flow.device_code);
    expect(alerts.join()).not.toContain((got as { token: string }).token);
    const denied = start(who({ address: '203.0.113.6' }));
    devices.decide('s1', browser(), denied.user_code, false);
    clock += 700_000;
    start(who({ address: '203.0.113.7' }));
    expect(alerts).toHaveLength(1);
  });
});

describe('the session of a terminal', () => {
  async function approved(): Promise<string> {
    const flow = start();
    devices.decide('s1', browser(), flow.user_code, true);
    clock += 6000;
    return (devices.poll(who(), flow.device_code) as { token: string }).token;
  }

  it('is a session of kind tui in the list, with its label and address, found by its token and not by a cookie', async () => {
    const token = await approved();
    const [s] = auth.sessions().filter((x) => x.kind === 'tui');
    expect(s).toMatchObject({ label: 'laptop', address: '203.0.113.5', kind: 'tui' });
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).not.toContain(token);
    expect(auth.tuiSession(token, who(), 'api')?.kind).toBe('tui');
    // the same value as a cookie opens nothing, and a cookie of a browser session is not a terminal token
    expect(auth.session(token, who(), 'api')).toBeNull();
    expect(auth.tuiSession('gnt_nonsense', who())).toBeNull();
    expect(auth.tuiSession('abc', who())).toBeNull();
  });

  it('lives 7 days idle and 30 in all, on any name, and use keeps it from being idle', async () => {
    expect(LIFETIME.tui).toEqual({ idle: 7 * 86_400_000, absolute: 30 * 86_400_000 });
    const token = await approved();
    for (let i = 0; i < 4; i += 1) {
      clock += 6 * 86_400_000;
      expect(auth.tuiSession(token, who(), 'api'), `week ${i}`).not.toBeNull();
    }
    // 24 days in, kept alive by use; the 30 days in all end it whatever the use
    clock += 7 * 86_400_000;
    expect(auth.tuiSession(token, who(), 'api')).toBeNull();
    const second = await approved();
    clock += 8 * 86_400_000;
    expect(auth.tuiSession(second, who(), 'api')).toBeNull();
  });

  it('S3: the first use from another network is one notice naming the session and the new address; later ones are quiet', async () => {
    const token = await approved();
    notices.length = 0;
    expect(auth.tuiSession(token, who({ address: '203.0.113.77' }), 'api')).not.toBeNull();
    expect(notices).toEqual([]);
    expect(auth.tuiSession(token, who({ address: '198.51.100.4' }), 'api')).not.toBeNull();
    expect(notices).toEqual([expect.stringMatching(/"laptop" was used from a new network \(198\.51\.100\.4\)/)]);
    auth.tuiSession(token, who({ address: '192.0.2.8' }), 'api');
    auth.tuiSession(token, who({ address: '198.51.100.4' }), 'api');
    expect(notices).toHaveLength(1);
    expect(alerts.filter((a) => /new network/.test(a))).toEqual([]);
  });

  it('a password change, a revoke and log out everywhere end it, and the socket id is the session\'s', async () => {
    const token = await approved();
    const id = auth.sessions().find((s) => s.kind === 'tui')?.id as string;
    const ended: string[][] = [];
    auth.onEnded((ids) => ended.push(ids));
    expect(auth.revoke(id.slice(0, 16))).toBe(true);
    expect(ended.at(-1)).toEqual([id]);
    expect(auth.tuiSession(token, who(), 'api')).toBeNull();
    const again = await approved();
    expect(auth.logoutEverywhere()).toBeGreaterThanOrEqual(1);
    expect(auth.tuiSession(again, who(), 'api')).toBeNull();
  });
});
