// Which Host the front port answers to: localhost and the allowed names as before, and any IP address (docs/security.md, "The Host check").
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forbiddenHostText, hostIpRange, isIpLiteralHost } from '../src/server/hosts.js';
import { startSupervisor } from '../src/server/supervisor.js';
import type { Supervisor } from '../src/server/supervisor.js';

describe('isIpLiteralHost', () => {
  it('is true for the addresses of this computer and its network (loopback, private, link-local, CGNAT, ULA), with or without a port, and for nothing else', () => {
    for (const host of ['192.168.1.5', '192.168.1.5:7777', '10.0.0.1', '172.16.0.9', '172.31.255.1', '100.64.0.1', '100.127.9.9:80', '169.254.1.1', '127.0.0.1', '127.0.0.2', '[::1]', '[::1]:7777', '[fd00::5]:7777', '[fc00::1]', '[fe80::1]', '[::ffff:192.168.1.5]', '192.168.1.5.']) {
      expect(isIpLiteralHost(host), host).toBe(true);
    }
    for (const host of ['8.8.8.8', '8.8.8.8:80', '172.32.0.1', '172.15.0.1', '100.63.0.1', '100.128.0.1', '0.0.0.0', '[2001:db8::1]', '[::]', '[::ffff:8.8.8.8]', '[::ffff:c0a8:105]',
      undefined, '', 'localhost', 'gonogo.example.com', '1.2.3.4.evil.com', '192.168.1.5.evil.com', '1.2.3.4.nip.io', '0x7f.1', '0x7f.0.0.1', '2130706433', '017700000001', '017.0.0.1', '127.1', '010.0.0.1', '1.2.3', '256.1.1.1', '192.168.1.05', '1.2.3.4.5', '::1', 'fe80::1', 'fe80::1%eth0', '[fe80::1%eth0]', '192.168.1.5/x', '192.168.1.5@evil.com', ' 192.168.1.5 evil.com', '[::1', '192.168.1.5:99999x']) {
      expect(isIpLiteralHost(host), String(host)).toBe(false);
    }
  });
  it('hostIpRange says which range, and null for a name', () => {
    expect(hostIpRange('192.168.1.5')).toBe('private');
    expect(hostIpRange('8.8.8.8:80')).toBe('public');
    expect(hostIpRange('[::ffff:10.0.0.1]')).toBe('private');
    expect(hostIpRange('[2001:db8::1]')).toBe('public');
    expect(hostIpRange('nas.lan')).toBeNull();
    expect(hostIpRange('0x7f.1')).toBeNull();
  });
});

describe('forbiddenHostText', () => {
  it('starts with the two old words, names the name, says what to do, and echoes only a clean name', () => {
    const text = forbiddenHostText('Gonogo.Example.com:7777');
    expect(text.startsWith('forbidden host')).toBe(true);
    expect(text).toContain('does not answer to gonogo.example.com');
    expect(text).toContain('--allow-host gonogo.example.com');
    expect(text).toContain('GONOGO_ALLOWED_HOSTS=gonogo.example.com');
    expect(text).toContain('Open it by its IP address on your network');
    const pub = forbiddenHostText('8.8.8.8:7777');
    expect(pub).toContain('a public address. Add it with --allow-host 8.8.8.8 (or GONOGO_ALLOWED_HOSTS=8.8.8.8), and set up the login first.');
    for (const hostile of ['<script>alert(1)</script>', 'a b', 'x"y', undefined]) {
      const out = forbiddenHostText(hostile);
      expect(out, String(hostile)).not.toMatch(/script|alert|a b|x"y/);
      expect(out).toContain('that name');
    }
    expect(forbiddenHostText('x'.repeat(200)).length).toBeLessThan(400);
  });
});

describe('the front port', () => {
  let sup: Supervisor | null = null;
  let home = '';
  afterEach(async () => {
    await sup?.stop();
    sup = null;
    if (home !== '') rmSync(home, { recursive: true, force: true });
  });

  const get = (port: number, host: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/rooms', method: 'GET', headers: { host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });

  it('answers any IP address and localhost with no configuration, refuses a name that is not allowed (with what to do), and allows it once listed', async () => {
    home = mkdtempSync(join(tmpdir(), 'gng-hosts-'));
    const base = { home, host: '127.0.0.1', port: 0, command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], env: { PATH: process.env.PATH ?? '' } };
    sup = await startSupervisor({ ...base, allowedHosts: [] });
    for (const host of ['192.168.1.5:7777', '10.1.2.3', '100.64.1.2', '[fd00::5]:7777', 'localhost', '127.0.0.1']) {
      const res = await get(sup.port, host);
      expect(res.status, host).toBe(401); // past the Host check, asked for a login
    }
    const refused = await get(sup.port, 'nas.lan:7777');
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('forbidden host: gonogo does not answer to nas.lan');
    expect(refused.body).toContain('--allow-host nas.lan');
    expect((await get(sup.port, '1.2.3.4.evil.com')).status).toBe(403);
    const publicIp = await get(sup.port, '8.8.8.8:80');
    expect(publicIp.status).toBe(403);
    expect(publicIp.body).toContain('Add it with --allow-host 8.8.8.8');
    expect((await get(sup.port, '0.0.0.0:7777')).status).toBe(403);
    expect((await get(sup.port, '0x7f.1')).status).toBe(403);
    await sup.stop();
    sup = await startSupervisor({ ...base, allowedHosts: ['nas.lan'] });
    expect((await get(sup.port, 'nas.lan:7777')).status).toBe(401);
  }, 40_000);
});
