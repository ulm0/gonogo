// The banner of an insecure setup: the findings, their dismissal, and who may dismiss.
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dismiss, EXPOSURE_DISMISSED_FILE, findingId, findingsOf, readDismissed } from '../src/server/exposurefindings.js';
import type { FindingsInput } from '../src/server/exposurefindings.js';
import { startSupervisor } from '../src/server/supervisor.js';
import type { Supervisor } from '../src/server/supervisor.js';

const base: FindingsInput = { account: 'account', accountEpoch: 0, mfa: true, bindHost: '127.0.0.1', inContainer: false, pages: [], hooks: [], requestHost: '127.0.0.1:7777', requestHttps: false, dockerSocketMounted: false, trustedProxies: [], keys: [], now: 1_800_000_000_000, agents: [], folders: [], updateChecksOff: false, behind: null };
const ids = (input: Partial<FindingsInput>): string[] => findingsOf({ ...base, ...input }).map((f) => f.kind);

describe('findingsOf', () => {
  it('has nothing to say about a login on this machine', () => {
    expect(ids({})).toEqual([]);
    expect(ids({ account: 'fresh' })).toEqual([]); // no login, but nothing reaches it beyond this machine
  });
  it('no login while it can be reached beyond this machine: by its bind address, by a listed name, or by the address this request came to', () => {
    expect(ids({ account: 'fresh', bindHost: '0.0.0.0' })).toEqual(['no-login']);
    expect(ids({ account: 'fresh', pages: ['nas.lan'] })).toEqual(['no-login']);
    expect(ids({ account: 'fresh', inContainer: true, bindHost: '0.0.0.0' })).toEqual([]); // the wildcard bind of a container is normal
    expect(ids({ account: 'fresh', inContainer: true, bindHost: '0.0.0.0', requestHost: '192.168.1.5:7777' })).toEqual(['no-login', 'plain-http']);
    expect(ids({ account: 'account', bindHost: '0.0.0.0' })).toEqual([]);
  });
  it('plain http on a non-loopback address, only for the request that is on it; https (or a trusted proxy that says so) is fine', () => {
    expect(ids({ requestHost: '192.168.1.5:7777' })).toEqual(['plain-http']);
    expect(ids({ requestHost: 'nas.lan' })).toEqual(['plain-http']);
    expect(ids({ requestHost: '192.168.1.5:7777', requestHttps: true })).toEqual([]);
    expect(ids({ requestHost: 'localhost:7777' })).toEqual([]);
  });
  it('a public address in the allow-list, and a public name with no second factor', () => {
    expect(ids({ pages: ['8.8.8.8'] })).toEqual(['public-ip-listed']);
    expect(ids({ hooks: ['8.8.8.8'] })).toEqual(['public-ip-listed']);
    expect(ids({ pages: ['192.168.1.5'] })).toEqual([]);
    expect(ids({ pages: ['gonogo.example.com'], mfa: false })).toEqual(['public-name-no-mfa']);
    expect(ids({ pages: ['gonogo.example.com'], mfa: true })).toEqual([]);
    expect(ids({ pages: ['nas.lan'], mfa: false })).toEqual([]);
  });
  it('the Docker socket mounted in a container', () => {
    expect(ids({ dockerSocketMounted: true })).toEqual(['docker-socket']);
    expect(findingsOf({ ...base, dockerSocketMounted: true })[0]).toMatchObject({ severity: 'info', text: 'The agents can reach the Docker socket too, which is root on this host; the Update key and Clean Room need it.' });
  });
  it('every finding has plain words for what it is and what to do', () => {
    const all = findingsOf({ ...base, account: 'fresh', mfa: false, bindHost: '0.0.0.0', pages: ['8.8.8.8', 'gonogo.example.com'], requestHost: '192.168.1.5', dockerSocketMounted: true });
    expect(all.map((f) => f.kind)).toEqual(['no-login', 'plain-http', 'public-ip-listed', 'docker-socket']);
    for (const f of all) {
      expect(f.text.length).toBeGreaterThan(20);
      expect(f.fix.length).toBeGreaterThan(20);
    }
  });
});

describe('findingsOf: the findings that carry a subject', () => {
  const DAY = 24 * 3600_000;
  it('a trusted proxy that is a public address or a range, by name', () => {
    expect(ids({ trustedProxies: ['127.0.0.1', '192.168.1.2'] })).toEqual([]);
    expect(ids({ trustedProxies: ['8.8.8.8'] })).toEqual(['trusted-proxy-wide']);
    expect(ids({ trustedProxies: ['10.0.0.0/8'] })).toEqual(['trusted-proxy-wide']);
    expect(findingsOf({ ...base, trustedProxies: ['8.8.8.8'] })[0]?.text).toContain('8.8.8.8');
  });
  it('agents that work without asking outside a Clean Room, one per agent, by name; a Clean Room or a mode that asks is fine', () => {
    const agents = [
      { room: 'main', name: 'ana', mode: 'bypassPermissions', cleanRoom: false },
      { room: 'main', name: 'ben', mode: 'auto', cleanRoom: false },
      { room: 'docs', name: 'ana', mode: 'bypassPermissions', cleanRoom: false },
      { room: 'main', name: 'cy', mode: 'bypassPermissions', cleanRoom: true },
      { room: 'main', name: 'di', mode: 'default', cleanRoom: false },
    ];
    const found = findingsOf({ ...base, agents });
    expect(found.map((f) => f.kind)).toEqual(['agent-unattended', 'agent-unattended', 'agent-unattended']);
    expect(new Set(found.map((f) => f.id)).size).toBe(3); // the same name in another room is another finding
    expect(found[0]?.text).toContain('ana (room main) works without asking (bypassPermissions)');
  });
  it('a project folder that holds gonogo, by room', () => {
    expect(findingsOf({ ...base, folders: [{ room: 'docs' }] })[0]).toMatchObject({ kind: 'folder-holds-home', text: expect.stringContaining('room docs') as string });
  });
  it('a remote full key that is old or lives for years, by name; a short-lived, local or narrower one is fine; the secret is never there', () => {
    const now = base.now;
    const key = (over: Record<string, unknown>) => ({ id: 'k1', name: 'ops', scope: 'full', remote: true, created: now - DAY, expires: now + 30 * DAY, ...over });
    expect(ids({ keys: [key({})] })).toEqual([]);
    expect(ids({ keys: [key({ created: now - 100 * DAY })] })).toEqual(['old-remote-key']);
    expect(ids({ keys: [key({ expires: now + 400 * DAY })] })).toEqual(['old-remote-key']);
    expect(ids({ keys: [key({ remote: false, created: now - 100 * DAY })] })).toEqual([]);
    expect(ids({ keys: [key({ scope: 'read', created: now - 100 * DAY })] })).toEqual([]);
    expect(findingsOf({ ...base, keys: [key({ created: now - 100 * DAY })] })[0]?.text).toContain('"ops"');
  });
  it('update checks off, or the running version behind the latest release (info)', () => {
    expect(ids({ updateChecksOff: true })).toEqual(['update-checks-off']);
    expect(ids({ behind: { running: '0.12.0', latest: '0.13.0' } })).toEqual(['version-behind']);
    expect(ids({ updateChecksOff: true, behind: { running: '0.12.0', latest: '0.13.0' } })).toEqual(['update-checks-off']);
    expect(findingsOf({ ...base, updateChecksOff: true })[0]?.severity).toBe('info');
  });
  it('the id is a hash of the kind and the subject: stable, different per subject, the bare kind without one', () => {
    expect(findingId('no-login')).toBe('no-login');
    expect(findingId('agent-unattended', 'main/ana')).toBe(findingId('agent-unattended', 'main/ana'));
    expect(findingId('agent-unattended', 'main/ana')).not.toBe(findingId('agent-unattended', 'main/ben'));
    expect(findingId('agent-unattended', 'main/ana')).toMatch(/^agent-unattended-[0-9a-f]{12}$/);
  });
});

describe('the dismissal file', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const root = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'gng-exp-'));
    dirs.push(d);
    return d;
  };
  it('keeps ids, 0600, once each; ignores junk; keeps at most 50', () => {
    const r = root();
    expect(readDismissed(r)).toEqual([]);
    dismiss(r, 'plain-http');
    dismiss(r, 'plain-http');
    dismiss(r, 'no-login');
    expect(readDismissed(r)).toEqual(['plain-http', 'no-login']);
    expect(statSync(join(r, EXPOSURE_DISMISSED_FILE)).mode & 0o777).toBe(0o600);
    writeFileSync(join(r, EXPOSURE_DISMISSED_FILE), JSON.stringify({ ids: ['ok', 7, 'X Y', '../x', 'a'.repeat(100), 'fine-id'] }));
    expect(readDismissed(r)).toEqual(['ok', 'fine-id']);
    writeFileSync(join(r, EXPOSURE_DISMISSED_FILE), 'not json');
    expect(readDismissed(r)).toEqual([]);
    for (let i = 0; i < 60; i += 1) dismiss(r, `id-${i}`);
    expect(readDismissed(r)).toHaveLength(50);
    expect(readDismissed(r)[0]).toBe('id-10'); // the oldest went
    expect(readDismissed(r).at(-1)).toBe('id-59');
  });
});

describe('the routes of the supervisor', () => {
  let sup: Supervisor | null = null;
  let home = '';
  afterEach(async () => {
    await sup?.stop();
    sup = null;
    if (home !== '') rmSync(home, { recursive: true, force: true });
    home = '';
  });
  const call = (port: number, method: string, path: string, host: string, token: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host, 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }), origin: `http://${host}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const boot = async (): Promise<Supervisor> => {
    if (home === '') home = mkdtempSync(join(tmpdir(), 'gng-exp-'));
    sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], env: { PATH: process.env.PATH ?? '' } });
    return sup;
  };

  it('lists the findings for the request that asks, hides a dismissed one for good (also after a restart), and shows a new id again', async () => {
    const s = await boot();
    const token = s.directorToken as string;
    expect((await call(s.port, 'GET', '/api/exposure/findings', '127.0.0.1', null)).status).toBe(401);
    expect((await call(s.port, 'GET', '/api/exposure/findings', '127.0.0.1', token)).json).toEqual({ findings: [] });
    const lan = (await call(s.port, 'GET', '/api/exposure/findings', '192.168.1.5', token)).json.findings as Array<{ id: string }>;
    expect(lan.map((f) => f.id.replace(/-[0-9a-f]{12}$/, ''))).toEqual(['no-login', 'plain-http']);
    const plain = lan[1]?.id ?? '';
    expect(plain).toBe(findingId('plain-http', '192.168.1.5'));
    expect(lan.every((f) => !('kind' in f))).toBe(true);
    expect((await call(s.port, 'POST', '/api/exposure/dismiss', '192.168.1.5', token, { id: 'docker-socket' })).status).toBe(400); // not a finding now
    expect((await call(s.port, 'POST', '/api/exposure/dismiss', '192.168.1.5', token, {})).status).toBe(400);
    expect((await call(s.port, 'POST', '/api/exposure/dismiss', '192.168.1.5', token, { id: plain })).status).toBe(200);
    expect(readDismissed(home)).toEqual([plain]);
    const after = (await call(s.port, 'GET', '/api/exposure/findings', '192.168.1.5', token)).json.findings as Array<{ id: string }>;
    expect(after.map((f) => f.id)).toEqual([lan[0]?.id]); // plain-http stays hidden, no-login is another id and still shows
    await s.stop();
    const again = await boot();
    const text = (await call(again.port, 'GET', '/api/exposure/findings', '192.168.1.5', again.directorToken as string)).json.findings as Array<{ id: string }>;
    expect(text.map((f) => f.id)).toEqual([lan[0]?.id]);
    expect(existsSync(join(home, EXPOSURE_DISMISSED_FILE))).toBe(true);
    expect(readFileSync(join(home, EXPOSURE_DISMISSED_FILE), 'utf8')).toContain(plain);
  }, 40_000);
});

describe('findings that change with the situation', () => {
  const id = (input: Partial<FindingsInput>, kind: string): string | undefined => findingsOf({ ...base, ...input }).find((f) => f.kind === kind)?.id;
  it('no-login: a new account (or a reset after one) is a new situation, the same one is not', () => {
    const open = { account: 'fresh', bindHost: '0.0.0.0' };
    expect(id({ ...open, accountEpoch: 0 }, 'no-login')).toBe(id({ ...open, accountEpoch: 0 }, 'no-login'));
    expect(id({ ...open, accountEpoch: 0 }, 'no-login')).not.toBe(id({ ...open, accountEpoch: 1_700_000_000_000 }, 'no-login'));
  });
  it('plain-http: by host; public-name-no-mfa: by the public name', () => {
    expect(id({ requestHost: '192.168.1.5:7777' }, 'plain-http')).not.toBe(id({ requestHost: '192.168.1.6:7777' }, 'plain-http'));
    expect(id({ mfa: false, pages: ['a.example.com'] }, 'public-name-no-mfa')).not.toBe(id({ mfa: false, pages: ['b.example.com'] }, 'public-name-no-mfa'));
    expect(id({ mfa: false, pages: ['a.example.com'] }, 'public-name-no-mfa')).toBe(id({ mfa: false, pages: ['a.example.com'] }, 'public-name-no-mfa'));
  });
});
