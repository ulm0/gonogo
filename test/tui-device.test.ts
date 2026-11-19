// The terminal's side of the device login: tui.json, the flow, the order of credentials, and what is never done (docs/login-spec.md, TUI device login).
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteStored, deviceFlow, normalizeOrigin, readStored, saveStored, transportProblem, tuiConfigPath } from '../src/server/tui-device.js';
import type { FlowIo } from '../src/server/tui-device.js';
import { parseTuiArgs, sessionFor, tuiMain } from '../src/server/tui-cli.js';
import type { TuiDeps, TuiIo } from '../src/server/tui-cli.js';

const TOKEN = `gnt_${'A'.repeat(43)}`;
let dir: string;
let env: Record<string, string>;
let out: string[];
let err: string[];

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const io = (tty = true): TuiIo => ({ stdin: { isTTY: tty } as never, stdout: { isTTY: tty, write: (t: string) => void out.push(t) } as never, stderr: { write: (t: string) => void err.push(t) } });
function deps(handler: (url: string, init: RequestInit) => Response | Promise<Response>, clock = { t: 1_000_000 }): { deps: TuiDeps; seen: Array<{ url: string; init: RequestInit }>; clock: { t: number } } {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const flow: FlowIo = {
    write: (t) => void err.push(t),
    fetch: async (url, init = {}) => (seen.push({ url, init }), handler(url, init)),
    sleep: async (ms) => void (clock.t += ms),
    now: () => clock.t,
  };
  return { deps: { flow }, seen, clock };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gng-tuidev-'));
  env = { XDG_CONFIG_HOME: dir };
  out = [];
  err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tui.json', () => {
  it('is in XDG_CONFIG_HOME/gonogo, the directory 0700 and the file 0600, one entry per normalized origin', () => {
    const path = tuiConfigPath(env);
    expect(path).toBe(join(dir, 'gonogo', 'tui.json'));
    saveStored(path, 'https://gonogo.example.com', { token: TOKEN, label: 'laptop', created: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'gonogo')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, servers: { 'https://gonogo.example.com': { token: TOKEN, label: 'laptop', created: 1 } } });
    expect(readStored(path, 'https://gonogo.example.com')).toEqual({ stored: { token: TOKEN, label: 'laptop', created: 1 } });
    // another origin has none: the token is for that exact origin only
    for (const other of ['https://gonogo.example.com:8443', 'http://gonogo.example.com', 'https://evil.example', 'https://gonogo.example.org']) expect(readStored(path, other), other).toEqual({ stored: null });
    saveStored(path, 'https://b.example', { token: TOKEN, label: '', created: 2 });
    deleteStored(path, 'https://gonogo.example.com');
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).servers)).toEqual(['https://b.example']);
  });

  it('normalizes the origin: lower-case host, default port removed, no path, only http and https', () => {
    expect(normalizeOrigin('HTTPS://Gonogo.Example.com:443/some/path?x=1')).toBe('https://gonogo.example.com');
    expect(normalizeOrigin('http://Host:80')).toBe('http://host');
    expect(normalizeOrigin('https://host:8443/x')).toBe('https://host:8443');
    for (const bad of ['ftp://x', 'x', '', 'javascript:alert(1)']) expect(normalizeOrigin(bad), bad).toBeNull();
  });

  it('refuses a file that others can read, with the chmod to run, and never reads it; a damaged file is said to be', () => {
    const path = tuiConfigPath(env);
    saveStored(path, 'https://a.example', { token: TOKEN, label: '', created: 1 });
    chmodSync(path, 0o640);
    const wide = readStored(path, 'https://a.example');
    expect(wide).toEqual({ error: expect.stringContaining('chmod 600') });
    expect(JSON.stringify(wide)).not.toContain(TOKEN);
    chmodSync(path, 0o600);
    writeFileSync(path, '{broken', { mode: 0o600 });
    expect(readStored(path, 'https://a.example')).toEqual({ error: expect.stringContaining('damaged') });
    writeFileSync(path, JSON.stringify({ version: 1, servers: { 'https://a.example': { token: 'not a token', label: 'x', created: 1 } } }), { mode: 0o600 });
    expect(readStored(path, 'https://a.example')).toEqual({ stored: null });
  });
});

describe('the flow', () => {
  const started = { device_code: 'D'.repeat(43), user_code: 'ABCD-2345', verification_uri: 'https://gonogo.example.com/login/device', expires_in: 600, interval: 5 };

  it('prints the address and the code apart, polls every interval, adds five seconds after slow_down, and returns the token', async () => {
    const polls: number[] = [];
    const { deps: d, clock } = deps((url) => {
      if (url.endsWith('/api/auth/device')) return json(200, started);
      polls.push(clock.t);
      return polls.length === 1 ? json(400, { error: 'authorization_pending' }) : polls.length === 2 ? json(400, { error: 'slow_down' }) : polls.length === 3 ? json(400, { error: 'authorization_pending' }) : json(200, { token: TOKEN });
    });
    const t0 = clock.t;
    const result = await deviceFlow('https://gonogo.example.com', d.flow, 'laptop');
    expect(result).toEqual({ token: TOKEN });
    expect(polls.map((p) => p - t0)).toEqual([5000, 10_000, 20_000, 30_000]);
    const said = err.join('');
    expect(said).toContain('https://gonogo.example.com/login/device');
    expect(said).toContain('ABCD-2345');
    expect(said).not.toContain('?code=');
    expect(said).not.toContain(started.device_code);
    expect(said).not.toContain(TOKEN);
  });

  it('says why when it is denied, when the code expired (by the server, or by the clock), and when the server has no such login', async () => {
    const run = async (poll: Response, firstStatus = 200): Promise<{ token: string } | { error: string }> => deviceFlow('https://s.example', deps((url) => (url.endsWith('/api/auth/device') ? (firstStatus === 200 ? json(200, started) : json(firstStatus, { error: 'x' })) : poll)).deps.flow, 'l');
    expect(await run(json(400, { error: 'access_denied' }))).toEqual({ error: expect.stringContaining('denied') });
    expect(await run(json(400, { error: 'expired_token' }))).toEqual({ error: expect.stringContaining('expired') });
    expect(await run(json(429, {}))).toEqual({ error: expect.stringContaining('too many') });
    expect(await run(json(200, {}), 404)).toEqual({ error: expect.stringContaining('gonogo auth key add') });
    const never = await deviceFlow('https://s.example', deps((url) => (url.endsWith('/api/auth/device') ? json(200, { ...started, expires_in: 30 }) : json(400, { error: 'authorization_pending' }))).deps.flow, 'l');
    expect(never).toEqual({ error: expect.stringContaining('expired') });
  });

  it('a redirect is never followed, at the start or at a poll, and the message says so', async () => {
    const redirect = new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    expect(await deviceFlow('https://s.example', deps(() => redirect).deps.flow, 'l')).toEqual({ error: expect.stringContaining('redirect') });
    expect(await deviceFlow('https://s.example', deps((url) => (url.endsWith('/api/auth/device') ? json(200, started) : redirect)).deps.flow, 'l')).toEqual({ error: expect.stringContaining('redirect') });
  });

  it('sends the label, nothing else of the machine', async () => {
    const { deps: d, seen } = deps((url) => (url.endsWith('/api/auth/device') ? json(200, started) : json(200, { token: TOKEN })));
    await deviceFlow('https://s.example', d.flow, 'my box');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ label: 'my box' });
    expect(Object.keys(seen[0]?.init.headers ?? {})).toEqual(['Content-Type']);
  });
});

describe('which credential, and where it goes', () => {
  it('uses the stored session when the server still takes it, and sends it to that origin only', async () => {
    saveStored(tuiConfigPath(env), 'https://s.example', { token: TOKEN, label: 'l', created: 1 });
    const { deps: d, seen } = deps(() => json(200, {}));
    expect(await sessionFor('https://S.example:443/x', env, io(), d)).toEqual({ token: TOKEN });
    expect(seen.map((s) => s.url)).toEqual(['https://s.example/api/state']);
    expect((seen[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    // another origin never gets it: it starts a flow of its own
    const other = deps((url) => (url.endsWith('/api/auth/device') ? json(200, { device_code: 'D'.repeat(43), user_code: 'ABCD-2345', verification_uri: 'https://o.example/login/device', expires_in: 600, interval: 5 }) : json(200, { token: `gnt_${'B'.repeat(43)}` })));
    expect(await sessionFor('https://o.example', env, io(), other.deps)).toEqual({ token: `gnt_${'B'.repeat(43)}` });
    for (const s of other.seen) expect(JSON.stringify(s.init)).not.toContain(TOKEN);
  });

  it('a 401 clears the stored entry and starts the flow again; the new token is stored 0600', async () => {
    const path = tuiConfigPath(env);
    saveStored(path, 'https://s.example', { token: TOKEN, label: 'l', created: 1 });
    const fresh = `gnt_${'C'.repeat(43)}`;
    const { deps: d } = deps((url, init) => {
      if (url.endsWith('/api/state')) return json(401, {});
      if (url.endsWith('/api/auth/device')) return json(200, { device_code: 'D'.repeat(43), user_code: 'ABCD-2345', verification_uri: 'https://s.example/login/device', expires_in: 600, interval: 5 });
      void init;
      return json(200, { token: fresh });
    });
    expect(await sessionFor('https://s.example', env, io(), d)).toEqual({ token: fresh });
    expect((readStored(path, 'https://s.example') as { stored: { token: string } }).stored.token).toBe(fresh);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(err.join('')).toContain('no longer good');
  });

  it('does not follow a redirect with the stored token, and does not delete it for one', async () => {
    const path = tuiConfigPath(env);
    saveStored(path, 'https://s.example', { token: TOKEN, label: 'l', created: 1 });
    const { deps: d } = deps(() => new Response(null, { status: 302, headers: { location: 'http://evil.example/' } }));
    expect(await sessionFor('https://s.example', env, io(), d)).toEqual({ error: expect.stringContaining('302') });
    expect(readStored(path, 'https://s.example')).toEqual({ stored: expect.objectContaining({ token: TOKEN }) });
  });

  it('S2: http to a public name is refused before anything is sent; http to a private name is warned about; there is no way to skip the certificate', async () => {
    const { deps: d, seen } = deps(() => json(200, {}));
    expect(await sessionFor('http://gonogo.example.com', env, io(), d)).toEqual({ error: expect.stringContaining('http on a public name') });
    expect(seen).toEqual([]);
    expect(transportProblem('https://gonogo.example.com')).toBeNull();
    expect(transportProblem('http://127.0.0.1:7357')).toBeNull();
    expect(transportProblem('http://192.168.1.5:7357')).toEqual({ warn: expect.stringContaining('not encrypted') });
    expect(transportProblem('http://203.0.113.9')).toEqual({ refuse: expect.any(String) });
    for (const flag of ['--insecure', '--ca', '-k', '--no-verify']) expect(parseTuiArgs([flag]), flag).toMatchObject({ kind: 'error' });
    const source = readFileSync(new URL('../src/server/tui-device.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/server/tui-cli.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized|\bca:/);
  });
});

describe('tuiMain', () => {
  it('never starts a flow from a script: with no terminal it says so, sends nothing, and for a remote server names the key to use', async () => {
    const { deps: d, seen } = deps(() => json(200, {}));
    expect(await tuiMain(['--url', 'https://s.example'], env, io(false), d)).toBe(2);
    expect(seen).toEqual([]);
    expect(err.join('')).toContain('gonogo auth key add');
    expect(existsSync(tuiConfigPath(env))).toBe(false);
  });

  it('--logout ends the session on the server with its own token and forgets it here; with none stored it says so; unreachable it says to revoke it in LOGIN', async () => {
    const path = tuiConfigPath(env);
    saveStored(path, 'https://s.example', { token: TOKEN, label: 'l', created: 1 });
    const { deps: d, seen } = deps(() => json(200, { ok: true }));
    expect(await tuiMain(['--logout', '--url', 'https://s.example'], env, io(false), d)).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://s.example/api/auth/logout');
    expect((seen[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(out.join('')).toContain('Signed out');
    expect(readStored(path, 'https://s.example')).toEqual({ stored: null });
    expect(await tuiMain(['--logout', '--url', 'https://s.example'], env, io(false), d)).toBe(0);
    expect(out.join('')).toContain('No session is stored');
    saveStored(path, 'https://s.example', { token: TOKEN, label: 'l', created: 1 });
    const down = deps(() => Promise.reject(new Error('down')));
    expect(await tuiMain(['--logout', '--url', 'https://s.example'], env, io(false), down.deps)).toBe(0);
    expect(out.join('')).toContain('revoke it in Flight Rules');
    expect(readStored(path, 'https://s.example')).toEqual({ stored: null });
  });

  it('parses --logout, and nothing in its output holds the token', () => {
    expect(parseTuiArgs(['--logout', '--url', 'https://s.example'])).toEqual({ kind: 'run', logout: true, url: 'https://s.example' });
    expect(out.join('') + err.join('')).not.toContain(TOKEN);
  });
});
