/**
 * gonogo tui (docs/tui-spec.md): the command line. It finds the server and the browser token the way the page's user would:
 * the token file in gonogo's home (the same user can read it), or --token / GONOGO_BROWSER_TOKEN for a server somewhere else, and
 * --url for its address. The token is read and never printed. It needs a terminal: with none it says so and exits 2.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { deleteStored, deviceFlow, deviceLabel, noRedirect, normalizeOrigin, readStored, saveStored, transportProblem, tuiConfigPath } from './tui-device.js';
import type { FlowIo } from './tui-device.js';
import { BROWSER_TOKEN_FILE, DEFAULT_HOME_DIRNAME, DEFAULT_HOST, DEFAULT_PORT } from './constants.js';

type Env = Record<string, string | undefined>;

export const TUI_USAGE = `Usage: gonogo tui [--room <id>] [--url <address>] [--token <token>] [--home <dir>]
       gonogo tui --logout [--url <address>]

A terminal client of a running gonogo: the room, the Downlink with replies, the go and no-go
questions, and a console you type into. It uses the same server as the page, and both can be open.

Options:
  --room <id>        the room to open (default main); the token is the Director token of the root home
  --url <address>    the server (default http://127.0.0.1:<GONOGO_PORT or ${DEFAULT_PORT}>)
  --token <token>    an API key (gonogo auth key add <name> --scope full --remote) for a server elsewhere, or the browser token of an install with no account
                     (env GONOGO_BROWSER_TOKEN); visible in \`ps\`, so prefer the environment
  --logout           end the session this terminal has for --url and forget it

On a server elsewhere with no --token: the session stored for it (~/.config/gonogo/tui.json), else the terminal shows a code to type in a browser
where you are signed in to gonogo, and waits for you to approve it.
  --home <dir>       gonogo's state directory, where the token file is (default ~/${DEFAULT_HOME_DIRNAME}; env GONOGO_HOME)
  -h, --help         show this help

Keys: 1 2 3 4 or Tab switch screens, ? lists the rest. In a console, Ctrl-] then q comes back.
Needs an ANSI terminal (xterm-compatible) of at least 20 columns and 6 rows. NO_COLOR is honoured.
`;

export type TuiArgs = { kind: 'run'; url?: string; token?: string; home?: string; room?: string; logout?: boolean } | { kind: 'help' } | { kind: 'error'; message: string };

/** The arguments after `tui`. */
export function parseTuiArgs(argv: readonly string[]): TuiArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  const out: { url?: string; token?: string; home?: string; room?: string; logout?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--logout') {
      out.logout = true;
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== '--url' && flag !== '--token' && flag !== '--home' && flag !== '--room') return { kind: 'error', message: `unknown option ${arg}` };
    let value: string;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) return { kind: 'error', message: `${flag} needs a value` };
      value = next;
      i += 1;
    }
    if (value === '') return { kind: 'error', message: `${flag} needs a value` };
    if (flag === '--url') out.url = value;
    else if (flag === '--token') out.token = value;
    else if (flag === '--room') {
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(value)) return { kind: 'error', message: '--room is a room id: lower-case letters, digits and dashes' };
      out.room = value;
    } else out.home = value;
  }
  return { kind: 'run', ...out };
}

/** Where the server is, from the options and the environment; an error text when it cannot be told. */
export function resolveUrl(url: string | undefined, env: Env): { url: string } | { error: string } {
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: `--url must be http or https, not ${parsed.protocol}` };
      return { url: `${parsed.protocol}//${parsed.host}` };
    } catch {
      return { error: `--url is not an address: ${url}` };
    }
  }
  const port = Number(env.GONOGO_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'GONOGO_PORT is not a port' };
  const host = env.GONOGO_HOST === undefined || ['', '0.0.0.0', '::', '[::]'].includes(env.GONOGO_HOST) ? DEFAULT_HOST : env.GONOGO_HOST;
  return { url: `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}` };
}

/** The browser token: --token, else GONOGO_BROWSER_TOKEN, else the file in gonogo's home. */
export function resolveToken(token: string | undefined, home: string | undefined, env: Env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): { token: string } | { error: string } {
  const given = token ?? (env.GONOGO_BROWSER_TOKEN === '' ? undefined : env.GONOGO_BROWSER_TOKEN);
  if (given !== undefined) return { token: given.trim() };
  const dir = resolve(home ?? (env.GONOGO_HOME || join(homedir(), DEFAULT_HOME_DIRNAME)));
  try {
    const text = read(join(dir, BROWSER_TOKEN_FILE)).trim();
    if (text !== '') return { token: text };
  } catch {
    // no file: the message below says what to do
  }
  return { error: `no browser token: there is none in ${dir}. Start gonogo first (or pass --home of the root; a room's own folder has no token, use --room), or give --token / GONOGO_BROWSER_TOKEN and --url for a server elsewhere.` };
}

export interface TuiIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: { write(text: string): unknown };
}

/** The supervisor's socket in gonogo's home, when it is there and is a socket (a stale file left by a crash fails at the first call and says so). */
export function localSocketOf(home: string | undefined, env: Env, stat: (path: string) => { isSocket(): boolean } | null = (p) => { try { return statSync(p); } catch { return null; } }): string | null {
  const dir = resolve(home ?? (env.GONOGO_HOME || join(homedir(), DEFAULT_HOME_DIRNAME)));
  const path = join(dir, 'run', 'api.sock');
  return stat(path)?.isSocket() === true ? path : null;
}

/** `gonogo tui`: answers the exit code. */
export interface TuiDeps {
  flow: FlowIo;
}
const realDeps = (): TuiDeps => ({ flow: { write: (t) => void process.stderr.write(t), fetch: noRedirect, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => Date.now() } });

/** The session of this terminal for a server: the stored one when the server still takes it, else a new one approved in a browser. */
export async function sessionFor(address: string, env: Env, io: TuiIo, deps: TuiDeps): Promise<{ token: string } | { error: string }> {
  const origin = normalizeOrigin(address);
  if (origin === null) return { error: `${address} is not an http or https address` };
  const problem = transportProblem(origin);
  if (problem !== null && 'refuse' in problem) return { error: problem.refuse };
  const path = tuiConfigPath(env);
  const found = readStored(path, origin);
  if ('error' in found) return { error: found.error };
  if (found.stored !== null) {
    let res: Response;
    try {
      res = await deps.flow.fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${found.stored.token}` } });
    } catch {
      return { error: `could not reach ${origin}` };
    }
    if (res.status === 200) return { token: found.stored.token };
    if (res.status !== 401) return { error: `${origin} answered ${res.status} (a redirect is not followed)` };
    // the server does not know it any more (revoked, expired): forget it and ask again
    deleteStored(path, origin);
    io.stderr.write('gonogo tui: the stored session is no longer good; signing in again.\n');
  }
  if (problem !== null && 'warn' in problem) io.stderr.write(`gonogo tui: ${problem.warn}\n`);
  const flow = await deviceFlow(origin, deps.flow);
  if ('error' in flow) return flow;
  saveStored(path, origin, { token: flow.token, label: deviceLabel(), created: deps.flow.now() });
  io.stderr.write('Signed in. This terminal keeps the session in ' + path + '; end it with  gonogo tui --logout --url ' + origin + '.\n');
  return { token: flow.token };
}

/** `gonogo tui --logout`: ends the session of this terminal on the server and forgets it here. */
async function logout(address: string, env: Env, io: TuiIo, deps: TuiDeps): Promise<number> {
  const origin = normalizeOrigin(address);
  if (origin === null) return (io.stderr.write(`gonogo tui: ${address} is not an http or https address\n`), 2);
  const path = tuiConfigPath(env);
  const found = readStored(path, origin);
  if ('error' in found) return (io.stderr.write(`gonogo tui: ${found.error}\n`), 1);
  if (found.stored === null) return (io.stdout.write(`No session is stored for ${origin}.\n`), 0);
  let ended = false;
  try {
    const res = await deps.flow.fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${found.stored.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    ended = res.ok || res.status === 401;
  } catch {
    ended = false;
  }
  deleteStored(path, origin);
  io.stdout.write(ended ? `Signed out of ${origin}.\n` : `Forgot the session for ${origin}, but could not reach it to end it there: revoke it in Flight Rules, LOGIN.\n`);
  return 0;
}

export async function tuiMain(argv: readonly string[], env: Env, io: TuiIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, deps: TuiDeps = realDeps()): Promise<number> {
  const args = parseTuiArgs(argv);
  if (args.kind === 'help') {
    io.stdout.write(TUI_USAGE);
    return 0;
  }
  if (args.kind === 'error') {
    io.stderr.write(`gonogo tui: ${args.message}\n\n${TUI_USAGE}`);
    return 2;
  }
  const url = resolveUrl(args.url, env);
  if ('error' in url) {
    io.stderr.write(`gonogo tui: ${url.error}\n`);
    return 2;
  }
  if (args.logout === true) return logout(url.url, env, io, deps);
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) {
    io.stderr.write(`gonogo tui: this needs a terminal (stdin and stdout are not one).${args.url === undefined ? '' : ' A script gives an API key: gonogo auth key add <name> --scope full --remote on the machine gonogo runs on, then --token or GONOGO_BROWSER_TOKEN.'}\n`);
    return 2;
  }
  // on the machine gonogo runs on, once an account exists, the local socket is the door: no token, no URL (docs/login-spec.md R2)
  if (args.url === undefined && args.token === undefined && env.GONOGO_BROWSER_TOKEN === undefined) {
    const socketPath = localSocketOf(args.home, env);
    if (socketPath !== null) {
      const { runTui } = await import('./tui-app.js');
      const prefix = args.room === undefined || args.room === 'main' ? '' : `/r/${args.room}`;
      return runTui({ url: `http://localhost${prefix}`, token: '', socketPath, stdin: io.stdin, stdout: io.stdout, env });
    }
  }
  // a server elsewhere and no key: the session stored for it, else the device login of the terminal (docs/login-spec.md). Never from a script (the check above).
  const given = args.token ?? (env.GONOGO_BROWSER_TOKEN === undefined || env.GONOGO_BROWSER_TOKEN === '' ? undefined : env.GONOGO_BROWSER_TOKEN);
  if (args.url !== undefined && given === undefined) {
    const got = await sessionFor(url.url, env, io, deps);
    if ('error' in got) {
      io.stderr.write(`gonogo tui: ${got.error}\n`);
      return 1;
    }
    const { runTui } = await import('./tui-app.js');
    const where = args.room === undefined || args.room === 'main' ? url.url : `${url.url}/r/${args.room}`;
    return runTui({ url: where, token: got.token, stdin: io.stdin, stdout: io.stdout, env });
  }
  const token = resolveToken(args.token, args.home, env);
  if ('error' in token) {
    io.stderr.write(`gonogo tui: ${token.error}\n`);
    return 1;
  }
  const { runTui } = await import('./tui-app.js');
  // room main is at the root; another room is under /r/<id> (the Director token opens every room through the front port)
  const address = args.room === undefined || args.room === 'main' ? url.url : `${url.url}/r/${args.room}`;
  return runTui({ url: address, token: token.token, stdin: io.stdin, stdout: io.stdout, env });
}
