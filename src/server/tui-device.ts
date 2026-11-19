/**
 * The terminal's side of the device login (docs/login-spec.md, TUI device login): the stored sessions in `tui.json`, and the flow that gets one.
 *
 * `$XDG_CONFIG_HOME/gonogo/tui.json` (else `~/.config/gonogo/tui.json`): directory 0700, file 0600, written atomically, `{version: 1, servers:
 * {"<origin>": {token, label, created}}}`. The key is the normalized origin and the token is sent only to that exact origin; a redirect is never
 * followed (an https to http one would leak it). A file that others can read is refused, as ssh does with a key, and the token is never printed or
 * put in an argument. There is no flag and no variable here that turns off the checking of a certificate: a certificate that cannot be verified is a failure.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { cleanText, hostClass } from './auth.js';

type Env = Record<string, string | undefined>;
export interface Stored {
  token: string;
  label: string;
  created: number;
}

export const tuiConfigPath = (env: Env): string => join(env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config'), 'gonogo', 'tui.json');

/** The origin as the key of a stored session: lower-case host, default port removed; null for anything that is not an http(s) address. */
export function normalizeOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** What the file says for this origin, null when nothing, or a message when the file must not be trusted (too open, damaged). */
export function readStored(path: string, origin: string): { stored: Stored | null } | { error: string } {
  if (!existsSync(path)) return { stored: null };
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) return { error: `${path} can be read by others (mode ${mode.toString(8)}): run  chmod 600 ${path}  and start again` };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const servers = typeof parsed === 'object' && parsed !== null ? (parsed as { servers?: unknown }).servers : undefined;
    const entry = typeof servers === 'object' && servers !== null ? (servers as Record<string, unknown>)[origin] : undefined;
    if (typeof entry !== 'object' || entry === null) return { stored: null };
    const e = entry as Record<string, unknown>;
    if (typeof e.token !== 'string' || !/^gnt_[\w-]{20,100}$/.test(e.token)) return { stored: null };
    return { stored: { token: e.token, label: typeof e.label === 'string' ? e.label : '', created: typeof e.created === 'number' ? e.created : 0 } };
  } catch {
    return { error: `${path} is damaged: delete it and sign in again` };
  }
}

function load(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const servers = typeof parsed === 'object' && parsed !== null ? (parsed as { servers?: unknown }).servers : undefined;
    return typeof servers === 'object' && servers !== null ? { ...(servers as Record<string, unknown>) } : {};
  } catch {
    return {};
  }
}

function write(path: string, servers: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

export function saveStored(path: string, origin: string, stored: Stored): void {
  write(path, { ...load(path), [origin]: stored });
}
export function deleteStored(path: string, origin: string): void {
  if (!existsSync(path)) return;
  const servers = load(path);
  delete servers[origin];
  write(path, servers);
}

export interface FlowIo {
  write(text: string): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** A fetch that never follows a redirect: the token goes to the origin it was stored for, and nowhere else. */
export const noRedirect = (url: string, init: RequestInit = {}): Promise<Response> => fetch(url, { ...init, redirect: 'manual' });

/** Whether it is safe to talk to this address: http to a public name is refused, http to a private one is warned about. */
export function transportProblem(origin: string): { refuse: string } | { warn: string } | null {
  const url = new URL(origin);
  if (url.protocol === 'https:') return null;
  if (hostClass(url.host) === 'public') return { refuse: `${origin} is http on a public name: the code and the session would cross the internet unencrypted. Use https.` };
  return hostClass(url.host) === 'loopback' ? null : { warn: `${origin} is not encrypted: anyone on this network can read what is typed in the terminal session. Go on only on a network you trust.` };
}

/** The name this terminal gives itself: the host name, cleaned, at most 40 characters. */
export const deviceLabel = (): string => cleanText(hostname(), 40);

/**
 * Asks for a session and waits for the Director to approve it in a browser. Prints the address and the code (never the code in the address); polls every
 * `interval` seconds, 5 more after `slow_down`. Returns the token, or a message saying why not.
 */
export async function deviceFlow(origin: string, io: FlowIo, label = deviceLabel()): Promise<{ token: string } | { error: string }> {
  const json = { 'Content-Type': 'application/json' };
  let started: Response;
  try {
    started = await io.fetch(`${origin}/api/auth/device`, { method: 'POST', headers: json, body: JSON.stringify({ label }) });
  } catch {
    return { error: `could not reach ${origin}` };
  }
  if (started.status >= 300 && started.status < 400) return { error: `${origin} answered with a redirect, which is not followed: use the address the server is really at` };
  if (started.status === 404) return { error: `${origin} does not offer a terminal login (no account yet, or a public name whose account has no second factor or passkey). Make a key on that machine with  gonogo auth key add <name> --scope full --remote  and give it with --token.` };
  const body = (await started.json().catch(() => null)) as Record<string, unknown> | null;
  if (started.status === 429) return { error: typeof body?.error === 'string' ? body.error : 'too many tries: wait, then try again' };
  if (!started.ok || typeof body?.device_code !== 'string' || typeof body.user_code !== 'string' || typeof body.verification_uri !== 'string') return { error: `${origin} did not answer the way gonogo does` };
  const expires = io.now() + (typeof body.expires_in === 'number' ? body.expires_in : 600) * 1000;
  let interval = typeof body.interval === 'number' && body.interval >= 1 ? body.interval : 5;
  io.write(`\nTo sign in this terminal, open  ${body.verification_uri}  in a browser where you are signed in to gonogo,\nand type this code (it is not in the address):\n\n    ${body.user_code}\n\nIt works for ${Math.round((typeof body.expires_in === 'number' ? body.expires_in : 600) / 60)} minutes. Approve only if you started this just now. Waiting...\n`);
  while (io.now() < expires) {
    await io.sleep(interval * 1000);
    let polled: Response;
    try {
      polled = await io.fetch(`${origin}/api/auth/device/token`, { method: 'POST', headers: json, body: JSON.stringify({ device_code: body.device_code }) });
    } catch {
      continue;
    }
    if (polled.status >= 300 && polled.status < 400) return { error: `${origin} answered with a redirect, which is not followed` };
    const answer = (await polled.json().catch(() => null)) as Record<string, unknown> | null;
    if (polled.ok && typeof answer?.token === 'string') return { token: answer.token };
    const error = typeof answer?.error === 'string' ? answer.error : '';
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (error === 'access_denied') return { error: 'the Director denied it in the browser' };
    if (error === 'expired_token') return { error: 'the code expired: start again' };
    if (polled.status === 429) return { error: 'too many polls: wait, then start again' };
    return { error: `${origin} answered ${polled.status}` };
  }
  return { error: 'the code expired: start again' };
}
