/**
 * `gonogo expose <provider> [--write]` and `gonogo expose check` (docs/expose-spec.md): print or write the configuration that publishes gonogo
 * through a tunnel or a proxy, and then prove from this machine that the public address is as closed as it should be.
 *
 * Print and write only: this file runs no tunnel, installs nothing, holds no provider credential and starts no process (it does not import
 * child_process; a test makes any spawn fail). Files go to `<home>/expose/<provider>/`, mode 0600, and an existing file is never replaced.
 * `check` makes one set of requests to the Director's own public address and changes nothing.
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authStateOf } from './auth.js';
import { hostClass } from './auth.js';
import { parsePublicUrl } from './exposure.js';

export const EXPOSE_PROVIDERS = ['tailscale', 'cloudflare', 'caddy', 'funnel', 'ngrok'] as const;
export type ExposeProvider = (typeof EXPOSE_PROVIDERS)[number];

export const EXPOSE_USAGE = `Usage: gonogo expose <provider> --public-url https://<name> [--port <n>] [--write] [--home <dir>]
       gonogo expose check [--public-url https://<name>] [--home <dir>]

  providers   tailscale (Serve, private to your tailnet), cloudflare (a named tunnel), caddy, funnel (Tailscale Funnel, public), ngrok
  --write     also write the files (Caddyfile, cloudflared config) to <home>/expose/<provider>/, mode 0600; a file that exists is kept
  check       asks your public address, from this machine, whether it is closed as it should be (it changes nothing)

gonogo never runs a tunnel, installs anything or holds a provider's login: it prints what to run. Quick Tunnels (trycloudflare.com) are for
testing only: their name changes on every run, so --allow-host, --public-url and passkeys break.
`;

export interface ExposeIo {
  out(text: string): void;
  err(text: string): void;
}

export interface ExposePlan {
  provider: ExposeProvider;
  title: string;
  /** Who can open the page. */
  reach: string;
  /** What the provider can see of the traffic (R11): said first. */
  sees: string;
  /** The gonogo flags this needs. */
  gonogo: string[];
  /** The provider's own steps, run by the Director. */
  steps: string[];
  /** File name to content (only with --write). */
  files: Record<string, string>;
  notes: string[];
}

export function exposePlan(provider: ExposeProvider, input: { publicUrl: string; host: string; port: number }): ExposePlan {
  const { host, port } = input;
  const origin = `http://127.0.0.1:${port}`;
  const flags = (header: string): string[] => [`--allow-host ${host}`, `--public-url ${input.publicUrl}`, '--trusted-proxy 127.0.0.1', `--client-ip-header ${header}`];
  const verify = 'Then, on this machine: gonogo expose check';
  switch (provider) {
    case 'tailscale':
      return {
        provider,
        title: 'Tailscale Serve: the page for your tailnet only',
        reach: 'only devices on your tailnet (the phone joins the tailnet)',
        sees: 'Tailscale does not decrypt the traffic: the TLS ends on this machine.',
        gonogo: flags('x-forwarded-for'),
        steps: [`tailscale serve --bg ${origin}`, 'tailscale serve status    # the https name it prints is your public URL', verify],
        files: {},
        notes: ['Needs MagicDNS and HTTPS certificates switched on for the tailnet (Tailscale admin console).', 'Not verified: whether Serve puts the client address in X-Forwarded-For. If it does not, gonogo sees every client as 127.0.0.1 and one shared rate-limit bucket does the work.'],
      };
    case 'funnel':
      return {
        provider,
        title: 'Tailscale Funnel: the page on the public internet',
        reach: 'anyone who has the address (your login and second factor are the only wall)',
        sees: 'Tailscale relay servers do not decrypt the traffic: the TLS ends on this machine.',
        gonogo: flags('x-forwarded-for'),
        steps: [`tailscale funnel --bg ${origin}`, 'tailscale funnel status', verify],
        files: {},
        notes: ['Needs a `funnel` node attribute for this machine and HTTPS certificates; only ports 443, 8443 and 10000; only <machine>.<tailnet>.ts.net names; the bandwidth is limited and not configurable.'],
      };
    case 'cloudflare':
      return {
        provider,
        title: 'Cloudflare named tunnel: public, outbound-only, no open port',
        reach: 'anyone who has the address (add Cloudflare Access in front as a second layer; gonogo still logs in)',
        sees: 'Cloudflare ends the TLS: it can see every password, cookie, TOTP code and terminal byte that passes. Use Tailscale Serve if that is not acceptable.',
        gonogo: flags('cf-connecting-ip'),
        steps: ['cloudflared tunnel login', 'cloudflared tunnel create gonogo', `cloudflared tunnel route dns gonogo ${host}`, `cloudflared tunnel --config <home>/expose/cloudflare/config.yml run gonogo`, verify],
        files: {
          'config.yml': [
            '# gonogo expose cloudflare: edit the two paths, then run it with the command printed by `gonogo expose cloudflare`.',
            'tunnel: gonogo',
            'credentials-file: /home/YOU/.cloudflared/<TUNNEL-UUID>.json',
            'ingress:',
            `  - hostname: ${host}`,
            `    service: ${origin}`,
            '    originRequest:',
            `      httpHostHeader: ${host}   # keep the public Host: gonogo's Host check and the login's class use it`,
            '  - service: http_status:404',
            '',
          ].join('\n'),
        },
        notes: ['Cloudflare closes idle WebSockets after a time it does not state: the page pings, and `gonogo expose check` cannot see an idle close (not verified).', 'Not verified for Tunnel: how Host is mapped and WebSocket behaviour; `expose check` shows the Host gonogo sees.'],
      };
    case 'caddy':
      return {
        provider,
        title: 'Caddy on a server with ports 80 and 443 open',
        reach: 'anyone who has the address',
        sees: 'Caddy ends the TLS on your own machine: nobody else sees the traffic.',
        gonogo: flags('x-forwarded-for'),
        steps: [`caddy run --config <home>/expose/caddy/Caddyfile`, verify],
        files: {
          Caddyfile: [
            `${host} {`,
            `\treverse_proxy 127.0.0.1:${port} {`,
            '\t\t# the client address, set here and not taken from the client; the Host stays the public one (Caddy passes it unchanged)',
            '\t\theader_up X-Forwarded-For {remote_host}',
            '\t}',
            '}',
            '',
          ].join('\n'),
        },
        notes: ['The name must point at this machine in DNS and ports 80 and 443 must be open for Caddy to get its certificate.', 'Not verified: WebSocket proxying details on the Caddy page read; `gonogo expose check` opens one.'],
      };
    case 'ngrok':
      return {
        provider,
        title: 'ngrok: public, the last choice',
        reach: 'anyone who has the address',
        sees: 'ngrok ends the TLS: it can see every password, cookie, TOTP code and terminal byte that passes.',
        gonogo: flags('x-forwarded-for'),
        steps: [`ngrok http --url=${host} ${origin}`, 'Check `ngrok http --help` for your version: the flag for a fixed name has changed over time.', verify],
        files: {},
        notes: ['Free-plan features, WebSocket support and any interstitial page were not read: `gonogo expose check` is the proof.'],
      };
  }
}

export function formatPlan(plan: ExposePlan, written: string[]): string {
  const lines = [
    `${plan.title}`,
    '',
    `Who can open it: ${plan.reach}`,
    `What the provider sees: ${plan.sees}`,
    '',
    'Start gonogo with:',
    `  gonogo ${plan.gonogo.join(' ')}`,
    '  (the login and its second factor must already be set up: gonogo refuses to start on this name without them)',
    '',
    'Then, in order:',
    ...plan.steps.map((s) => `  ${s}`),
    '',
    ...plan.notes.map((n) => `Note: ${n}`),
    ...(written.length === 0 ? [] : ['', ...written.map((w) => `wrote ${w}`)]),
  ];
  return lines.join('\n') + '\n';
}

/* ---------------------------------------------------------------- check */

export interface CheckLine {
  ok: boolean;
  text: string;
}

export interface CheckOptions {
  url: string;
  /** The made-up token the probe sends (default: 64 random hex characters). Never a real credential: a typo in the address, a stale DNS record or a plain-http hop would hand it to a stranger. */
  probeToken?: string;
  timeoutMs?: number;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function ask(url: URL, method: string, path: string, headers: Record<string, string>, timeoutMs: number, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port === '' ? undefined : Number(url.port), path, method, headers: { ...headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, 4096) }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

/** One WebSocket upgrade with no credential: the answer to a refused one is a plain HTTP status. */
function socketProbe(url: URL, timeoutMs: number): Promise<number | 'opened'> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port === '' ? undefined : Number(url.port), path: '/ws', method: 'GET', timeout: timeoutMs, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: url.origin } });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve('opened');
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
    req.end();
  });
}

/** The proof that the public address is closed the way the spec says. A line that fails says what to look at; nothing is changed. */
export async function checkExposure(options: CheckOptions): Promise<CheckLine[]> {
  const parsed = parsePublicUrl(options.url);
  if (typeof parsed === 'string') return [{ ok: false, text: parsed }];
  const url = new URL(parsed.origin);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const lines: CheckLine[] = [];
  const add = (ok: boolean, text: string): void => void lines.push({ ok, text });
  const secure = url.protocol === 'https:';
  const pub = hostClass(url.host) === 'public';
  add(secure || !pub, secure ? 'TLS: the address is https and answered' : pub ? 'TLS: a public address must be https' : 'TLS: not https (a private name may be plain http: traffic on your network is not encrypted)');
  const step = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      add(false, `${label}: no answer (${error instanceof Error ? error.message : 'error'})`);
    }
  };
  await step('the address', async () => {
    const status = await ask(url, 'GET', '/api/auth/status', {}, timeoutMs);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(status.body) as Record<string, unknown>;
    } catch {
      // not gonogo's JSON: said below
    }
    add(status.status === 200 && typeof body.state === 'string', status.status === 200 && typeof body.state === 'string' ? `reached gonogo (login: ${String(body.state)})` : `this address did not answer like gonogo (status ${status.status})`);
    if (body.state !== undefined) add(body.state === 'account', body.state === 'account' ? 'the login is set up' : `the login is not set up (${String(body.state)}): gonogo should not be on a public name`);
    // the Host gonogo sees must be the public name: a proxy that rewrites it to 127.0.0.1 would make a remote client look local
    if (typeof body.host === 'string') add(pub ? body.host === 'public' : true, pub ? (body.host === 'public' ? 'the Host gonogo sees is the public name' : `gonogo sees this request as "${body.host}", not public: the proxy rewrites or hides the Host (keep it, and set X-Forwarded-For)`) : `gonogo sees this request as "${body.host}"`);
  });
  await step('/api/state', async () => {
    const a = await ask(url, 'GET', '/api/state', {}, timeoutMs);
    add(a.status === 401, a.status === 401 ? '/api/state answers 401 with no credential' : `/api/state answered ${a.status} with no credential: it must be 401`);
  });
  // a token shaped like the old browser token, made up for this probe: once an account exists no token works on TCP, whoever holds it
  await step('a token', async () => {
    const probe = options.probeToken ?? randomBytes(32).toString('hex');
    const a = await ask(url, 'GET', '/api/state', { authorization: `Bearer ${probe}` }, timeoutMs);
    add(a.status === 401, a.status === 401 ? 'a token is refused on TCP: a made-up 64-hex token gets 401 through the public address' : `a made-up token was accepted through the public address (${a.status}): a tunnel can make remote traffic look local; keep the proxy from dropping its forwarding headers, and run gonogo auth reset`);
  });
  await step('/hook', async () => {
    const a = await ask(url, 'POST', '/hook/x/Stop', { 'content-type': 'application/json' }, timeoutMs, '{}');
    add(a.status === 404, a.status === 404 ? '/hook is 404 off this machine' : `/hook/x/Stop answered ${a.status}: it must be 404`);
  });
  await step('/mcp', async () => {
    const a = await ask(url, 'POST', '/mcp', { 'content-type': 'application/json' }, timeoutMs, '{}');
    add(a.status === 404, a.status === 404 ? '/mcp is 404 off this machine' : `/mcp answered ${a.status}: it must be 404`);
  });
  await step('/ws', async () => {
    const s = await socketProbe(url, timeoutMs);
    add(s === 401, s === 401 ? 'a WebSocket upgrade with no credential answers 401 (the path and the upgrade pass the proxy)' : s === 'opened' ? 'a WebSocket opened with no credential: close it at once' : `a WebSocket upgrade answered ${s}: it must be 401 (a proxy that drops the upgrade shows 400 or 404)`);
  });
  await step('/login', async () => {
    const a = await ask(url, 'GET', '/login', {}, timeoutMs);
    const csp = String(a.headers['content-security-policy'] ?? '');
    add(csp.includes("default-src 'none'") || csp.includes("default-src 'self'"), csp === '' ? 'the login page has no Content-Security-Policy: something in front strips it' : 'the login page has its Content-Security-Policy');
  });
  return lines;
}

/* ---------------------------------------------------------------- the command */

export async function exposeCommand(args: readonly string[], home: string, env: NodeJS.ProcessEnv, io: ExposeIo): Promise<number> {
  const [first, ...rest] = args;
  if (first === undefined) return (io.err(EXPOSE_USAGE), 2);
  const options = { publicUrl: (env.GONOGO_PUBLIC_URL ?? '').trim(), port: 7777, write: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg === '--write') options.write = true;
    else if (arg === '--public-url' && rest[i + 1] !== undefined) options.publicUrl = (rest[(i += 1)] ?? '').trim();
    else if (arg === '--port' && /^\d{1,5}$/.test(rest[i + 1] ?? '')) options.port = Number(rest[(i += 1)]);
    else return (io.err(`gonogo expose: unexpected ${arg}\n\n${EXPOSE_USAGE}`), 2);
  }
  if (first === 'check') {
    if (options.publicUrl === '') return (io.err('gonogo expose check: give --public-url (or set GONOGO_PUBLIC_URL)\n'), 2);
    if (authStateOf(home) !== 'account') return (io.err('gonogo expose check: the login is not set up on this home, so nothing should be published yet. Set it up first (docs: login).\n'), 1);
    // nothing of this home is read for the probe: the address may be a typo, a stale record or a hop that is not encrypted
    const lines = await checkExposure({ url: options.publicUrl });
    for (const line of lines) io.out(`${line.ok ? 'pass' : 'FAIL'}  ${line.text}\n`);
    const failed = lines.filter((l) => !l.ok).length;
    io.out(failed === 0 ? '\nAll checks passed. (Nothing was changed.)\n' : `\n${failed} check${failed === 1 ? '' : 's'} failed. Nothing was changed.\n`);
    return failed === 0 ? 0 : 1;
  }
  if (!(EXPOSE_PROVIDERS as readonly string[]).includes(first)) return (io.err(`gonogo expose: unknown provider "${first}"\n\n${EXPOSE_USAGE}`), 2);
  if (options.publicUrl === '') return (io.err('gonogo expose: give the public address with --public-url https://<name> (or GONOGO_PUBLIC_URL): gonogo does not guess it\n'), 2);
  const parsed = parsePublicUrl(options.publicUrl);
  if (typeof parsed === 'string') return (io.err(`gonogo expose: ${parsed}\n`), 2);
  const plan = exposePlan(first as ExposeProvider, { publicUrl: parsed.origin, host: parsed.host, port: options.port });
  const written: string[] = [];
  if (options.write) {
    const dir = join(home, 'expose', plan.provider);
    for (const [name, content] of Object.entries(plan.files)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, name);
      try {
        await writeFile(file, content, { flag: 'wx', mode: 0o600 });
        written.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') io.err(`gonogo expose: ${file} exists and was left as it is\n`);
        else throw error;
      }
    }
  }
  io.out(formatPlan(plan, written));
  return 0;
}
