/**
 * gonogo tui (docs/tui-spec.md): the command line. It finds the server and the browser token the way the page's user would:
 * the token file in gonogo's home (the same user can read it), or --token / GONOGO_TOKEN for a server somewhere else, and
 * --url for its address. The token is read and never printed. It needs a terminal: with none it says so and exits 2.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BROWSER_TOKEN_FILE, DEFAULT_HOME_DIRNAME, DEFAULT_HOST, DEFAULT_PORT } from './constants.js';

type Env = Record<string, string | undefined>;

export const TUI_USAGE = `Usage: gonogo tui [--url <address>] [--token <token>] [--home <dir>]

A terminal client of a running gonogo: the room, the Downlink with replies, the go and no-go
questions, and a console you type into. It uses the same server as the page, and both can be open.

Options:
  --url <address>    the server (default http://127.0.0.1:<GONOGO_PORT or ${DEFAULT_PORT}>)
  --token <token>    the browser token (env GONOGO_TOKEN); visible in \`ps\`, so prefer the environment
  --home <dir>       gonogo's state directory, where the token file is (default ~/${DEFAULT_HOME_DIRNAME}; env GONOGO_HOME)
  -h, --help         show this help

Keys: 1 2 3 4 or Tab switch screens, ? lists the rest. In a console, Ctrl-] then q comes back.
Needs an ANSI terminal (xterm-compatible) of at least 20 columns and 6 rows. NO_COLOR is honoured.
`;

export type TuiArgs = { kind: 'run'; url?: string; token?: string; home?: string } | { kind: 'help' } | { kind: 'error'; message: string };

/** The arguments after `tui`. */
export function parseTuiArgs(argv: readonly string[]): TuiArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  const out: { url?: string; token?: string; home?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== '--url' && flag !== '--token' && flag !== '--home') return { kind: 'error', message: `unknown option ${arg}` };
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
    else out.home = value;
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

/** The browser token: --token, else GONOGO_TOKEN, else the file in gonogo's home. */
export function resolveToken(token: string | undefined, home: string | undefined, env: Env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): { token: string } | { error: string } {
  const given = token ?? (env.GONOGO_TOKEN === '' ? undefined : env.GONOGO_TOKEN);
  if (given !== undefined) return { token: given.trim() };
  const dir = resolve(home ?? (env.GONOGO_HOME || join(homedir(), DEFAULT_HOME_DIRNAME)));
  try {
    const text = read(join(dir, BROWSER_TOKEN_FILE)).trim();
    if (text !== '') return { token: text };
  } catch {
    // no file: the message below says what to do
  }
  return { error: `no browser token: there is none in ${dir}. Start gonogo first (or pass --home), or give --token / GONOGO_TOKEN and --url for a server elsewhere.` };
}

export interface TuiIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: { write(text: string): unknown };
}

/** `gonogo tui`: answers the exit code. */
export async function tuiMain(argv: readonly string[], env: Env, io: TuiIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  const args = parseTuiArgs(argv);
  if (args.kind === 'help') {
    io.stdout.write(TUI_USAGE);
    return 0;
  }
  if (args.kind === 'error') {
    io.stderr.write(`gonogo tui: ${args.message}\n\n${TUI_USAGE}`);
    return 2;
  }
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) {
    io.stderr.write('gonogo tui: this needs a terminal (stdin and stdout are not one). For a script, use the REST API.\n');
    return 2;
  }
  const url = resolveUrl(args.url, env);
  if ('error' in url) {
    io.stderr.write(`gonogo tui: ${url.error}\n`);
    return 2;
  }
  const token = resolveToken(args.token, args.home, env);
  if ('error' in token) {
    io.stderr.write(`gonogo tui: ${token.error}\n`);
    return 1;
  }
  const { runTui } = await import('./tui-app.js');
  return runTui({ url: url.url, token: token.token, stdin: io.stdin, stdout: io.stdout, env });
}
