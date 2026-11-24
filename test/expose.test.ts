/**
 * Publishing gonogo (docs/expose-spec.md): the one Host normalizer, hooks-only hosts, the start-up refusals, `gonogo expose` (print and write, never
 * run) and `gonogo expose check`. Real HTTP on a real front port with stand-in rooms. A real tunnel, certificate or provider is not reachable here.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostClass } from '../src/server/auth.js';
import { checkExposure, EXPOSE_PROVIDERS, exposeCommand, exposePlan } from '../src/server/exposecli.js';
import { exposureProblem, parsePublicUrl } from '../src/server/exposure.js';
import { normalizeHost, splitAllowed } from '../src/server/hosts.js';
import { startSupervisor } from '../src/server/supervisor.js';
import type { Supervisor } from '../src/server/supervisor.js';
import { parseArgs, USAGE } from '../src/server/cli.js';
const USAGE_TEXT = (): string => USAGE;

const FAKE = new URL('./fake-room.mjs', import.meta.url).pathname;
const COSTS = { argon2: { memory: 16, passes: 1, parallelism: 1 }, scrypt: { N: 16, r: 1, p: 1 } };
let home: string;
let sup: Supervisor | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gng-expose-'));
  sup = undefined;
});
afterEach(async () => {
  await sup?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('the one Host normalizer (R10)', () => {
  it('lower-cases and strips the port, the brackets and one trailing dot; the same name every time', () => {
    for (const [header, name] of [
      ['Gonogo.Example.COM', 'gonogo.example.com'],
      ['gonogo.example.com:8443', 'gonogo.example.com'],
      ['gonogo.example.com.', 'gonogo.example.com'],
      ['GONOGO.example.com.:443', 'gonogo.example.com'],
      ['[::1]:7777', '::1'],
      [' localhost ', 'localhost'],
    ] as const) expect(normalizeHost(header), header).toBe(name);
  });

  it('refuses what no Host is: spaces, slashes, at signs, a second dot, an empty name, an unbracketed IPv6', () => {
    for (const bad of ['', ' ', 'a b', 'a/b', 'user@host', 'host..', '.', 'host:', 'host:1:2', '::1', '[]', '[::1', 'ho st:80', 'a.example.com\u0000']) expect(normalizeHost(bad), JSON.stringify(bad)).toBeNull();
  });

  it('the login class and the allow-lists read a Host the same way', () => {
    for (const h of ['gonogo.example.com.', 'GONOGO.example.com:443', 'gonogo.example.com']) expect(hostClass(h), h).toBe('public');
    expect(hostClass('LOCALHOST.')).toBe('loopback');
    expect(hostClass('[::1]:7777')).toBe('loopback');
    expect(hostClass('nas.local.:80')).toBe('private');
    expect(hostClass('a b')).toBe('public');
  });

  it('splits --allow-host entries into page hosts and hooks hosts; a name in both is a page host; a bad entry is an error', () => {
    const got = splitAllowed(['gonogo.example.com', 'Hooks.Example.com:hooks', 'both.example.com', 'both.example.com:hooks', 'nas.local.']);
    expect(got).toEqual({ pages: new Set(['gonogo.example.com', 'both.example.com', 'nas.local']), hooks: new Set(['hooks.example.com']) });
    expect(splitAllowed(['a b'])).toMatch(/not a host name/);
    expect(splitAllowed([':hooks'])).toMatch(/not a host name/);
  });
});

describe('the public URL and the start-up rules', () => {
  const ok = { pages: [] as string[], hooks: [] as string[], bindHost: '127.0.0.1', port: 7777, inContainer: false, publicUrl: null, account: 'account' as const, mfa: true };

  it('is an origin: https or http, no path, query, fragment or password', () => {
    expect(parsePublicUrl('https://Gonogo.Example.com/')).toEqual({ origin: 'https://gonogo.example.com', host: 'gonogo.example.com' });
    expect(parsePublicUrl('http://nas.local:7777')).toEqual({ origin: 'http://nas.local:7777', host: 'nas.local' });
    for (const bad of ['gonogo.example.com', 'ftp://x.example.com', 'https://x.example.com/path', 'https://x.example.com/?a=1', 'https://x.example.com/#t', 'https://u:p@x.example.com', '']) expect(typeof parsePublicUrl(bad), bad).toBe('string');
  });

  it('a public page host needs the account, its second factor and an https public URL', () => {
    const pub = parsePublicUrl('https://gonogo.example.com');
    const input = { ...ok, pages: ['gonogo.example.com'], publicUrl: pub as { origin: string; host: string } };
    expect(exposureProblem(input)).toBeNull();
    expect(exposureProblem({ ...input, account: 'fresh' })).toMatch(/login is not set up/);
    expect(exposureProblem({ ...input, account: 'none' })).toMatch(/login is not set up/);
    expect(exposureProblem({ ...input, mfa: false })).toMatch(/second factor/);
    expect(exposureProblem({ ...input, publicUrl: null })).toMatch(/--public-url https:\/\/gonogo\.example\.com/);
    expect(exposureProblem({ ...input, publicUrl: parsePublicUrl('http://gonogo.example.com') as { origin: string; host: string } })).toMatch(/--public-url https/);
  });

  it('a private name may stay plain http with no public URL; a hooks-only host needs no login; the public URL must name an allowed host', () => {
    expect(exposureProblem({ ...ok, pages: ['nas.local'], account: 'fresh' })).toBeNull();
    expect(exposureProblem({ ...ok, hooks: ['hooks.example.com'], account: 'fresh' })).toBeNull();
    expect(exposureProblem({ ...ok, pages: ['nas.local'], publicUrl: parsePublicUrl('http://nas.local') as { origin: string; host: string } })).toBeNull();
    expect(exposureProblem({ ...ok, pages: ['nas.local'], publicUrl: parsePublicUrl('https://other.example.com') as { origin: string; host: string } })).toMatch(/not an allowed host/);
    expect(exposureProblem({ ...ok, hooks: ['localhost'] })).toMatch(/this machine/);
  });

  it('a refusal names what to drop, the real port and the way out (RETRO)', () => {
    const pub = parsePublicUrl('https://gonogo.example.com') as { origin: string; host: string };
    const base = { ...ok, pages: ['gonogo.example.com'], publicUrl: pub, account: 'fresh' as const, port: 8123 };
    const text = exposureProblem(base) as string;
    expect(text).toContain('start gonogo without --allow-host gonogo.example.com (and with --host 127.0.0.1)');
    expect(text).toContain('http://127.0.0.1:8123/');
    expect(text).not.toContain('7777');
    expect(text).toMatch(/make the account and turn on the second factor.*then add the option back/);
    expect(exposureProblem({ ...base, port: 0 })).toContain('<the port gonogo prints>');
    // inside a container --host 127.0.0.1 would cut off the published port: the text keeps the image's 0.0.0.0
    const docker = exposureProblem({ ...base, inContainer: true }) as string;
    expect(docker).toContain("keep the image's --host 0.0.0.0, drop GONOGO_ALLOWED_HOSTS once, and open http://127.0.0.1:<the published port>/ on the host");
    expect(docker).not.toContain('--host 127.0.0.1');
    expect(docker).not.toContain('GONOGO_HOST');
    expect(exposureProblem({ ...ok, bindHost: '0.0.0.0', account: 'fresh', port: 9000 })).toMatch(/start gonogo without --host 0\.0\.0\.0 \(and with --host 127\.0\.0\.1\).*http:\/\/127\.0\.0\.1:9000\//);
  });

  it('a bind other machines can reach, outside a container, needs the account; in a container the wildcard is normal', () => {
    expect(exposureProblem({ ...ok, bindHost: '0.0.0.0', account: 'fresh' })).toMatch(/other machines can reach/);
    expect(exposureProblem({ ...ok, bindHost: '192.168.1.5', account: 'none' })).toMatch(/login is not set up/);
    expect(exposureProblem({ ...ok, bindHost: '0.0.0.0', account: 'account' })).toBeNull();
    expect(exposureProblem({ ...ok, bindHost: '0.0.0.0', account: 'fresh', inContainer: true })).toBeNull();
    expect(exposureProblem({ ...ok, bindHost: '127.0.0.1', account: 'fresh' })).toBeNull();
  });

  it('the supervisor refuses to start on these and holds nothing after it: a second start works', async () => {
    const base = { home, host: '127.0.0.1', port: 0, command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '' }, authCosts: COSTS, tamperEveryMs: 0 };
    await expect(startSupervisor({ ...base, allowedHosts: ['gonogo.example.com'], publicUrl: 'https://gonogo.example.com' })).rejects.toThrow(/public page address, but the login is not set up/);
    await expect(startSupervisor({ ...base, host: '0.0.0.0', allowedHosts: [] })).rejects.toThrow(/other machines can reach/);
    await expect(startSupervisor({ ...base, allowedHosts: ['a b'] })).rejects.toThrow(/not a host name/);
    await expect(startSupervisor({ ...base, allowedHosts: [], publicUrl: 'nonsense' })).rejects.toThrow(/not a URL/);
    // the lock and the account file were released each time
    sup = await startSupervisor({ ...base, host: '0.0.0.0', allowedHosts: ['hooks.example.com:hooks'], inContainer: true });
    expect(sup.port).toBeGreaterThan(0);
  });
});

describe('a hooks-only host serves the webhooks and nothing else', () => {
  const ask = (host: string, path: string, method = 'GET'): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: (sup as Supervisor).port, path, method, headers: { host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });

  beforeEach(async () => {
    sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: ['hooks.example.com:hooks', 'nas.local'], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '' }, authCosts: COSTS, tamperEveryMs: 0 });
    await sup.whenReady(15_000);
  });

  it('answers /uplink/* and /dock/* (the room gets them) in every spelling of the Host', async () => {
    for (const host of ['hooks.example.com', 'HOOKS.example.com:443', 'hooks.example.com.']) {
      expect((await ask(host, '/uplink/slack')).status, host).toBe(200);
      expect((await ask(host, '/dock/pair', 'POST')).status, host).toBe(200);
      expect((await ask(host, '/r/main/uplink/slack')).status, host).toBe(200);
    }
  });

  it('has no page, no login, no API, no list, no socket: 404, never the room, never a login page', async () => {
    const paths = ['/', '/index.html', '/api/state', '/api/auth/status', '/api/rooms', '/login', '/setup', '/rooms', '/r/main/', '/ws', '/assets/x.js', '/internal/busy', '/hook/x/Stop', '/mcp'];
    for (const path of paths) {
      const answer = await ask('hooks.example.com', path);
      expect(answer.status, path).toBe(404);
      expect(answer.text, path).not.toContain('room at');
    }
  });

  it('the segment check is on the parsed path: dot segments, double slashes, encodings and case cannot step into the API', async () => {
    const tricks = ['/uplink/../api/state', '/uplink/%2e%2e/api/state', '/uplink%2f..%2fapi', '//api/state', '/%2e%2e/api', '/UPLINK/x', '/Dock/x', '/uplink\\..\\api', '/uplink/%00', '/%75plink/../api', '/uplink/./../api', '/r/main/uplink/../api/state'];
    for (const path of tricks) {
      const answer = await ask('hooks.example.com', path);
      expect([400, 404], path).toContain(answer.status);
      expect(answer.text, path).not.toContain('room at');
    }
  });

  it('an unknown Host is forbidden everywhere (default deny), a hooks host is not a page host, and another page host still serves the page', async () => {
    expect((await ask('evil.example.com', '/uplink/x')).status).toBe(403);
    expect((await ask('hooks.example.com.evil.com', '/uplink/x')).status).toBe(403);
    expect([200, 303]).toContain((await ask('nas.local', '/login')).status); // the login or its setup: a page host serves it
    // /hook and /mcp are 404 on every Host, loopback included: the agents use the room's own port
    for (const host of ['nas.local', `127.0.0.1:${(sup as Supervisor).port}`]) {
      expect((await ask(host, '/hook/ana/Stop', 'POST')).status, host).toBe(404);
      expect((await ask(host, '/mcp', 'POST')).status, host).toBe(404);
    }
    expect((await ask('host.docker.internal', '/hook/ana/Stop', 'POST')).status).toBe(403);
    // a hooks host has no page: the old main's paths are no redirect there, and neither is the list at /
    for (const path of ['/assets/x.js', '/', '/index.html']) expect((await ask('hooks.example.com', path)).status, path).toBe(404);
  });
});

describe('gonogo expose prints and writes, and never runs', () => {
  const run = async (args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await exposeCommand(args, home, env, { out: (t) => void (out += t), err: (t) => void (err += t) });
    return { code, out, err };
  };

  it('every provider prints its flags, its steps and what the provider can see; none starts a process', async () => {
    for (const provider of EXPOSE_PROVIDERS) {
      const { code, out } = await run([provider, '--public-url', 'https://gonogo.example.com']);
      expect(code, provider).toBe(0);
      expect(out, provider).toContain('--allow-host gonogo.example.com');
      expect(out, provider).toContain('--public-url https://gonogo.example.com');
      expect(out, provider).toContain('--trusted-proxy 127.0.0.1');
      expect(out, provider).toContain('gonogo expose check');
      expect(out, provider).toContain('What the provider sees:');
    }
  });

  it('says which providers end the TLS and see every password, cookie, TOTP code and terminal byte (R11)', async () => {
    for (const provider of ['cloudflare', 'ngrok'] as const) expect(exposePlan(provider, { publicUrl: 'https://g.example.com', host: 'g.example.com', port: 7777 }).sees, provider).toMatch(/ends the TLS.*password.*cookie.*TOTP.*terminal byte/);
    for (const provider of ['tailscale', 'funnel'] as const) expect(exposePlan(provider, { publicUrl: 'https://g.ts.net', host: 'g.ts.net', port: 7777 }).sees, provider).toMatch(/do(es)? not decrypt/);
    expect(exposePlan('caddy', { publicUrl: 'https://g.example.com', host: 'g.example.com', port: 7777 }).sees).toMatch(/your own machine/);
  });

  it('the proxy configs it writes set X-Forwarded-For and keep the public Host', () => {
    const caddy = exposePlan('caddy', { publicUrl: 'https://g.example.com', host: 'g.example.com', port: 7777 }).files.Caddyfile ?? '';
    expect(caddy).toContain('header_up X-Forwarded-For {remote_host}');
    expect(caddy).toMatch(/^g\.example\.com \{/m);
    expect(caddy).not.toMatch(/header_up Host/);
    const cf = exposePlan('cloudflare', { publicUrl: 'https://g.example.com', host: 'g.example.com', port: 7777 });
    expect(cf.files['config.yml']).toContain('httpHostHeader: g.example.com');
    expect(cf.files['config.yml']).toContain('service: http://127.0.0.1:7777');
    expect(cf.gonogo.join(' ')).toContain('--client-ip-header cf-connecting-ip');
  });

  it('--write writes only files into <home>/expose/<provider>/ with mode 0600, keeps one that exists, and nothing else of the home changes', async () => {
    writeFileSync(join(home, 'marker'), 'x');
    const first = await run(['caddy', '--public-url', 'https://g.example.com', '--write']);
    expect(first.code).toBe(0);
    const file = join(home, 'expose', 'caddy', 'Caddyfile');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'expose', 'caddy')).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toContain('reverse_proxy 127.0.0.1:7777');
    expect(first.out).toContain(`wrote ${file}`);
    writeFileSync(file, 'mine');
    const again = await run(['caddy', '--public-url', 'https://g.example.com', '--write']);
    expect(again.err).toContain('exists and was left as it is');
    expect(readFileSync(file, 'utf8')).toBe('mine');
    expect(readdirSync(home).sort()).toEqual(['expose', 'marker']);
    // without --write nothing is written; a provider with no file writes none
    const printed = await run(['tailscale', '--public-url', 'https://g.ts.net', '--write']);
    expect(printed.code).toBe(0);
    expect(readdirSync(home).sort()).toEqual(['expose', 'marker']);
  });

  it('refuses a missing or bad public URL, an unknown provider and stray options, and prints the usage', async () => {
    expect((await run(['caddy'])).err).toMatch(/--public-url/);
    expect((await run(['caddy'], { GONOGO_PUBLIC_URL: 'https://env.example.com' })).out).toContain('--allow-host env.example.com');
    expect((await run(['caddy', '--public-url', 'nope'])).code).toBe(2);
    expect((await run(['tunnelbear', '--public-url', 'https://g.example.com'])).err).toContain('unknown provider');
    expect((await run(['caddy', '--public-url', 'https://g.example.com', '--evil'])).code).toBe(2);
    expect((await run([])).err).toContain('Usage: gonogo expose');
  });

  it('is a command of gonogo, with the home flag', () => {
    expect(parseArgs(['expose', 'caddy', '--public-url', 'https://g.example.com', '--home', '/h'])).toEqual({ kind: 'expose', args: ['caddy', '--public-url', 'https://g.example.com'], home: '/h' });
  });

  it('expose check refuses while the login is not set up, and says why', async () => {
    const answer = await run(['check', '--public-url', 'https://g.example.com']);
    expect(answer.code).toBe(1);
    expect(answer.err).toContain('login is not set up');
  });
});

describe('gonogo expose check', () => {
  let server: http.Server;
  let url: string;
  /** How the stand-in public address behaves. */
  const mode = { state: 'account', host: 'public', stateStatus: 401, legacy: 401, hook: 404, mcp: 404, ws: 'refuse' as 'refuse' | 'open' | 'missing', csp: true, gonogo: true };
  beforeEach(async () => {
    Object.assign(mode, { state: 'account', host: 'public', stateStatus: 401, legacy: 401, hook: 404, mcp: 404, ws: 'refuse', csp: true, gonogo: true });
    server = http.createServer((req, res) => {
      const path = req.url ?? '';
      if (!mode.gonogo) return void res.writeHead(200, { 'content-type': 'text/html' }).end('<p>something else</p>');
      if (path === '/api/auth/status') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: mode.state, host: mode.host }));
      if (path === '/api/state') return void res.writeHead(req.headers.authorization === undefined ? mode.stateStatus : mode.legacy).end('{}');
      if (path.startsWith('/hook/')) return void res.writeHead(mode.hook).end();
      if (path === '/mcp') return void res.writeHead(mode.mcp).end();
      if (path === '/login') return void res.writeHead(200, mode.csp ? { 'content-security-policy': "default-src 'none'; style-src 'self'" } : {}).end('login');
      res.writeHead(404).end();
    });
    server.on('upgrade', (_req, socket) => {
      if (mode.ws === 'open') socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      else socket.end(`HTTP/1.1 ${mode.ws === 'missing' ? 404 : 401} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const failed = async (): Promise<string[]> => (await checkExposure({ url })).filter((l) => !l.ok).map((l) => l.text);

  it('passes when the address is closed as it should be: 401 with no credential, a token refused, /hook and /mcp 404, the socket 401, the CSP there', async () => {
    const lines = await checkExposure({ url });
    expect(lines.filter((l) => !l.ok)).toEqual([]);
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toMatch(/a token is refused on TCP/);
    expect(text).toMatch(/\/hook is 404/);
    expect(text).toMatch(/WebSocket upgrade with no credential answers 401/);
  });

  it('fails when a token is accepted through the public address (a tunnel that made remote traffic look local)', async () => {
    mode.legacy = 200;
    expect((await failed()).join('\n')).toMatch(/made-up token was accepted/);
  });

  it('fails on each open door: /api/state with no credential, /hook, /mcp, a socket that opens, a dropped upgrade, no CSP', async () => {
    mode.stateStatus = 200;
    mode.hook = 200;
    mode.mcp = 200;
    mode.ws = 'open';
    mode.csp = false;
    const text = (await failed()).join('\n');
    for (const part of [/\/api\/state answered 200/, /\/hook\/x\/Stop answered 200/, /\/mcp answered 200/, /WebSocket opened with no credential/, /no Content-Security-Policy/]) expect(text).toMatch(part);
    mode.ws = 'missing';
    expect((await failed()).join('\n')).toMatch(/upgrade answered 404/);
  });

  it('fails when the login is not set up, when the answer is not gonogo, and when nothing answers', async () => {
    mode.state = 'fresh';
    expect((await failed()).join('\n')).toMatch(/login is not set up \(fresh\)/);
    mode.gonogo = false;
    expect((await failed()).join('\n')).toMatch(/did not answer like gonogo/);
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    expect((await failed()).join('\n')).toMatch(/no answer/);
  });

  it('a bad URL is one failed line', async () => {
    expect(await checkExposure({ url: 'nonsense' })).toEqual([{ ok: false, text: expect.stringContaining('not a URL') as string }]);
  });

  it('never sends a credential of this gonogo: the probe is a made-up 64-hex token, new every run, and nothing reads <home>/token', async () => {
    const seen: string[] = [];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.headers.authorization !== undefined) seen.push(req.headers.authorization);
      res.writeHead(401).end();
    });
    await checkExposure({ url });
    await checkExposure({ url });
    expect(seen).toHaveLength(2);
    for (const header of seen) expect(header).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(seen[0]).not.toBe(seen[1]);
    // the probe a test gives is the probe sent; no other source of a token exists in the module
    seen.length = 0;
    await checkExposure({ url, probeToken: 'f'.repeat(64) });
    expect(seen).toEqual(['Bearer ' + 'f'.repeat(64)]);
    const text = readFileSync(new URL('../src/server/exposecli.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/readFile|readFileSync|'token'|"token"|\/token/);
  });
});

describe('what the page says about it', () => {
  it('Flight Rules names the hosts and whether the login stands behind them', async () => {
    const { exposureText } = await import('../src/client/exposure.js');
    expect(exposureText(undefined, 'account', true)).toEqual({ line: 'Exposed to: this machine and your local network only (no --allow-host).', warn: false });
    const view = { pages: ['gonogo.example.com'], hooks: ['hooks.example.com'], publicUrl: 'https://gonogo.example.com' };
    expect(exposureText(view, 'account', true)).toEqual({ line: 'Exposed to: gonogo.example.com (page), hooks.example.com (webhooks only). Login: ready (account and second factor). Public address: https://gonogo.example.com.', warn: false });
    expect(exposureText(view, 'account', false).warn).toBe(true);
    expect(exposureText(view, 'account', false).line).toMatch(/turn on the second factor/);
    expect(exposureText(view, 'fresh', false)).toMatchObject({ warn: true });
    // a hooks-only host is not a page: no warning for it alone
    expect(exposureText({ pages: [], hooks: ['hooks.example.com'], publicUrl: null }, 'fresh', false).warn).toBe(false);
  });

  it('the webhook addresses use the public address when there is one, and ignore anything that is not an origin', async () => {
    const { roomOrigin, setPublicOrigin } = await import('../src/client/base.js');
    setPublicOrigin('https://gonogo.example.com');
    expect(roomOrigin()).toBe('https://gonogo.example.com');
    setPublicOrigin('https://gonogo.example.com/evil');
    setPublicOrigin('javascript:alert(1)');
    setPublicOrigin(null);
    expect(() => roomOrigin()).toThrow(); // no location in this test: it fell back to the page's own address
  });
});

describe('the pages say what the command prints', () => {
  it('each provider page holds the gonogo flags, the steps and the files the command prints', () => {
    for (const provider of EXPOSE_PROVIDERS) {
      const host = provider === 'tailscale' || provider === 'funnel' ? 'gonogo.tailnet-name.ts.net' : provider === 'ngrok' ? 'gonogo.example.ngrok.app' : 'gonogo.example.com';
      const plan = exposePlan(provider, { publicUrl: `https://${host}`, host, port: 7777 });
      const page = readFileSync(new URL(`../docs/expose/${provider}.md`, import.meta.url), 'utf8');
      expect(page, provider).toContain(`gonogo ${plan.gonogo.join(' ')}`);
      expect(page, provider).toContain('<ExposeMock provider="' + provider + '"');
      expect(page, provider).toContain('**Tried:**');
      for (const step of plan.steps) if (!step.startsWith('Then,') && !step.startsWith('Check ') && !/^tailscale serve status|^tailscale funnel status/.test(step)) expect(page, `${provider}: ${step}`).toContain(step);
      for (const content of Object.values(plan.files)) for (const line of content.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('# gonogo expose'))) expect(page, `${provider}: ${line}`).toContain(line.trimEnd());
    }
  });

  it('the overview names every provider and the requirements it enforces', () => {
    const text = readFileSync(new URL('../docs/features/expose.md', import.meta.url), 'utf8');
    for (const part of ['tailscale.md', 'cloudflare.md', 'caddy.md', 'funnel.md', 'ngrok.md', ':hooks', '--public-url', '--client-ip-header', 'default deny', 'second factor']) expect(text, part).toContain(part);
  });
});

describe('the Director\'s own container still starts (RETRO 7)', () => {
  it('gonogo rooms with GONOGO_HOST=0.0.0.0, GONOGO_PORT=7777 and four private names, in Docker, with no account yet: the settings read and the supervisor starts', async () => {
    const { resolveSettings } = await import('../src/server/cli.js');
    const env = { GONOGO_INSTALL: 'docker', GONOGO_HOST: '0.0.0.0', GONOGO_PORT: '7777', GONOGO_ALLOWED_HOSTS: 'zimaos,zimaos.local,192.168.86.28,192.168.86.67', PATH: process.env.PATH ?? '' };
    const parsed = parseArgs(['rooms']);
    // `rooms` alone is still gonogo, kept for one release: the same run as no argument
    expect(parsed).toEqual({ kind: 'run', options: {} });
    expect(parseArgs([])).toEqual({ kind: 'run', options: {} });
    expect(parseArgs(['rooms', '--port', '7777', '--allow-host', 'zimaos'])).toEqual({ kind: 'run', options: { port: 7777, allowedHosts: ['zimaos'] } });
    const settings = resolveSettings({ ...(parsed as { options: Parameters<typeof resolveSettings>[0] }).options, env });
    expect(settings.host).toBe('0.0.0.0');
    expect(settings.port).toBe(7777);
    expect(settings.allowedHosts).toEqual(['zimaos', 'zimaos.local', '192.168.86.28', '192.168.86.67']);
    // every name is private: no account, no second factor and no public URL are asked for
    for (const name of settings.allowedHosts) expect(hostClass(name), name).toBe('private');
    expect(exposureProblem({ pages: [...settings.allowedHosts], hooks: [], bindHost: settings.host, port: settings.port, inContainer: true, publicUrl: null, account: 'fresh', mfa: false })).toBeNull();
    // and the real start, on a free port (7777 may be taken here)
    sup = await startSupervisor({ home, host: settings.host, port: 0, allowedHosts: settings.allowedHosts, inContainer: true, command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '' }, authCosts: COSTS, tamperEveryMs: 0 });
    expect(sup.port).toBeGreaterThan(0);
    // outside a container the same bind with no account is the refusal the CHANGELOG describes
    await sup.stop();
    sup = undefined;
    await expect(startSupervisor({ home, host: settings.host, port: 0, allowedHosts: settings.allowedHosts, inContainer: false, command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '' }, authCosts: COSTS, tamperEveryMs: 0 })).rejects.toThrow(/other machines can reach/);
  });

  it('every private name answers the page on the real front port in that config', async () => {
    sup = await startSupervisor({ home, host: '0.0.0.0', port: 0, allowedHosts: ['zimaos', 'zimaos.local', '192.168.86.28', '192.168.86.67'], inContainer: true, command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '' }, authCosts: COSTS, tamperEveryMs: 0 });
    await sup.whenReady(15_000);
    for (const host of ['zimaos', 'zimaos.local:7777', '192.168.86.28', '192.168.86.67:7777']) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: (sup as Supervisor).port, path: '/login', headers: { host } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
        req.on('error', reject);
        req.end();
      });
      expect([200, 303], host).toContain(status);
    }
  });
});

describe('RETRO\'s small ones', () => {
  it('no passkey is offered on a Host with a trailing dot (the browser signs the dot, gonogo reads the name without it)', async () => {
    const { relyingParty } = await import('../src/server/passkeys.js');
    expect(relyingParty('gonogo.example.com', 'public')).toMatchObject({ rpId: 'gonogo.example.com', origin: 'https://gonogo.example.com' });
    expect(relyingParty('gonogo.example.com:8443', 'public')).toMatchObject({ origin: 'https://gonogo.example.com:8443' });
    expect(relyingParty('gonogo.example.com.', 'public')).toBeNull();
    expect(relyingParty('gonogo.example.com.:8443', 'public')).toBeNull();
  });

  it('ngrok prints --domain next to --url, and every provider says what the proxy address is in Docker', () => {
    const ngrok = exposePlan('ngrok', { publicUrl: 'https://g.ngrok.app', host: 'g.ngrok.app', port: 7777 });
    expect(ngrok.steps.join('\n')).toMatch(/--url=g\.ngrok\.app[\s\S]*--domain=g\.ngrok\.app.*before 3\.16/);
    for (const provider of EXPOSE_PROVIDERS) expect(exposePlan(provider, { publicUrl: 'https://g.example.com', host: 'g.example.com', port: 7777 }).notes.join('\n'), provider).toMatch(/Docker.*bridge gateway.*172\.17\.0\.1.*not 127\.0\.0\.1/);
  });

  it('the help names --public-url once, for a page or a hooks-only host', () => {
    expect(USAGE_TEXT()).toMatch(/--public-url <url>\s+the address other machines reach this gonogo by: its page, or for a name:hooks host its webhooks/);
  });
});
