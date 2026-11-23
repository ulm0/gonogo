// The banner of an insecure setup: the findings, their dismissal, and who may dismiss.
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dismiss, EXPOSURE_DISMISSED_FILE, findingsOf, readDismissed } from '../src/server/exposurefindings.js';
import type { FindingsInput } from '../src/server/exposurefindings.js';
import { startSupervisor } from '../src/server/supervisor.js';
import type { Supervisor } from '../src/server/supervisor.js';

const base: FindingsInput = { account: 'account', mfa: true, bindHost: '127.0.0.1', inContainer: false, pages: [], hooks: [], requestHost: '127.0.0.1:7777', requestHttps: false, dockerSocketMounted: false };
const ids = (input: Partial<FindingsInput>): string[] => findingsOf({ ...base, ...input }).map((f) => f.id);

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
    expect(findingsOf({ ...base, dockerSocketMounted: true })[0]).toMatchObject({ severity: 'info', text: expect.stringContaining('root over the host') as string });
  });
  it('every finding has plain words for what it is and what to do', () => {
    const all = findingsOf({ ...base, account: 'fresh', mfa: false, bindHost: '0.0.0.0', pages: ['8.8.8.8', 'gonogo.example.com'], requestHost: '192.168.1.5', dockerSocketMounted: true });
    expect(all.map((f) => f.id)).toEqual(['no-login', 'plain-http', 'public-ip-listed', 'docker-socket']);
    for (const f of all) {
      expect(f.text.length).toBeGreaterThan(20);
      expect(f.fix.length).toBeGreaterThan(20);
    }
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
    expect(lan.map((f) => f.id)).toEqual(['no-login', 'plain-http']);
    expect((await call(s.port, 'POST', '/api/exposure/dismiss', '192.168.1.5', token, { id: 'docker-socket' })).status).toBe(400); // not a finding now
    expect((await call(s.port, 'POST', '/api/exposure/dismiss', '192.168.1.5', token, {})).status).toBe(400);
    expect((await call(s.port, 'POST', '/api/exposure/dismiss', '192.168.1.5', token, { id: 'plain-http' })).status).toBe(200);
    expect(readDismissed(home)).toEqual(['plain-http']);
    const after = (await call(s.port, 'GET', '/api/exposure/findings', '192.168.1.5', token)).json.findings as Array<{ id: string }>;
    expect(after.map((f) => f.id)).toEqual(['no-login']); // plain-http stays hidden, no-login is another id and still shows
    await s.stop();
    const again = await boot();
    const text = (await call(again.port, 'GET', '/api/exposure/findings', '192.168.1.5', again.directorToken as string)).json.findings as Array<{ id: string }>;
    expect(text.map((f) => f.id)).toEqual(['no-login']);
    expect(existsSync(join(home, EXPOSURE_DISMISSED_FILE))).toBe(true);
    expect(readFileSync(join(home, EXPOSURE_DISMISSED_FILE), 'utf8')).toContain('plain-http');
  }, 40_000);
});
