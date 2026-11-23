/**
 * gonogo service install | uninstall | status: run gonogo under the user's own service manager (docs/guide/service.md).
 *
 * systemd (a user unit), launchd (a LaunchAgent) or OpenRC (an init script that runs as the invoking user). Nothing here runs as root
 * and nothing runs sudo: a file is written where the invoking user may write it, and what needs more is printed for the person to run.
 * install writes the file and prints the commands that activate it; with --now it also runs them. The unit pins the absolute path of node
 * and of the gonogo entry as installed, and the PATH of the shell that installed it, so claude, git and gh are found at boot.
 *
 * Reload and Update: the supervisor's reload used to start the next gonogo itself. Under a manager that would leave two (the manager
 * restarts the one that exited), so the unit sets GONOGO_SERVICE and the supervisor then just exits 0 and the manager starts it again
 * (Restart=always, KeepAlive, supervise-daemon). The agents' pty host must outlive that exit, hence KillMode=process and
 * AbandonProcessGroup: the manager ends only the main process, and gonogo's own SIGTERM stops the agents and the host.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { InstallKind } from '../shared/protocol.js';
import { DEFAULT_HOME_DIRNAME } from './constants.js';

export type Manager = 'systemd' | 'launchd' | 'openrc';
export const MANAGERS: readonly Manager[] = ['systemd', 'launchd', 'openrc'];

export const SERVICE_NAME = 'gonogo';
export const LAUNCHD_LABEL = 'com.ulm0.gonogo';
/** How long a manager waits for gonogo to stop its rooms before it kills the main process. */
const STOP_TIMEOUT_S = 90;

export interface ServiceOptions {
  home?: string;
  host?: string;
  port?: number;
  ptyHost?: boolean;
  now?: boolean;
  manager?: Manager;
  /** OpenRC only, when the command runs as root: the user the service runs as (else SUDO_USER). */
  user?: string;
}

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Everything the commands read from the machine, so a test can give it a fake. */
export interface ServiceHost {
  platform: NodeJS.Platform;
  uid: number;
  user: string;
  group: string;
  userHome: string;
  env: Record<string, string | undefined>;
  node: string;
  /** The gonogo entry as it was started (process.argv[1], symlinks not resolved), or undefined. */
  entry: string | undefined;
  kind: InstallKind;
  /** Runs one program, no shell. Never called with sudo. */
  run(file: string, args: string[]): Ran;
  openrcRun: string;
  initDir: string;
}

export interface Result {
  code: number;
  lines: string[];
}

/** What the unit runs: the program, its arguments, the environment it needs. */
export interface Spec {
  /** argv of the service: the program first. */
  argv: string[];
  path: string;
  home: string;
}

/* ---------------------------------------------------------------- quoting */

const PLAIN = /^[A-Za-z0-9_@+=:,./-]+$/;

/** A value that goes into a text file read line by line: no control character at all, or one value could end the line and add its own. */
function checkText(label: string, value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} holds a control character (a new line or a NUL): nothing was written`);
  return value;
}

/** One word of a systemd command line: % and $ are doubled (specifiers and variables), anything unusual goes in double quotes. */
export function systemdWord(word: string): string {
  const escaped = word.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (PLAIN.test(word)) return escaped;
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* ---------------------------------------------------------------- files */

export function renderSystemd(spec: Spec): string {
  const pathValue = spec.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return [
    '# Written by `gonogo service install`; `gonogo service uninstall` removes it. Edit gonogo\'s flags by installing again.',
    '[Unit]',
    'Description=gonogo, mission control for coding agents',
    'Documentation=https://gonogo.ulm0.com/guide/service',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${spec.argv.map(systemdWord).join(' ')}`,
    `Environment="PATH=${pathValue}"`,
    'Environment=GONOGO_SERVICE=systemd',
    // a reload and an Update make gonogo exit 0 on purpose: start it again whatever the exit status
    'Restart=always',
    'RestartSec=3',
    // only the main process is ended with the service: the agents' pty host must outlive a reload; gonogo's own SIGTERM stops host and agents
    'KillMode=process',
    `TimeoutStopSec=${STOP_TIMEOUT_S}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderLaunchd(spec: Spec, log: string): string {
  const args = spec.argv.map((a) => `    <string>${xmlText(a)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by `gonogo service install`; `gonogo service uninstall` removes it. -->',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${xmlText(spec.path)}</string>`,
    '    <key>GONOGO_SERVICE</key>',
    '    <string>launchd</string>',
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // a reload and an Update make gonogo exit 0 on purpose: start it again whatever the exit status
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    `  <key>ExitTimeOut</key>`,
    `  <integer>${STOP_TIMEOUT_S}</integer>`,
    // the agents' pty host must outlive a reload: launchd must not end the rest of the process group
    '  <key>AbandonProcessGroup</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlText(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlText(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function renderOpenrc(spec: Spec, user: string, group: string, userHome: string): string {
  const [program, ...args] = spec.argv;
  return [
    '#!/sbin/openrc-run',
    '# Written by `gonogo service install`; `gonogo service uninstall` prints how to remove it. It runs gonogo as an ordinary user.',
    `name="gonogo"`,
    `description="gonogo, mission control for coding agents"`,
    `command=${shellQuote(program ?? '')}`,
    `command_args=${shellQuote(args.join(' '))}`,
    `command_user=${shellQuote(`${user}:${group}`)}`,
    // supervise-daemon starts it again when it exits, and a reload and an Update make gonogo exit 0 on purpose
    'supervisor="supervise-daemon"',
    'respawn_delay=3',
    'respawn_max=0',
    `output_log="/var/log/gonogo.log"`,
    `error_log="/var/log/gonogo.log"`,
    `retry="TERM/${STOP_TIMEOUT_S}/KILL/5"`,
    `export HOME=${shellQuote(userHome)}`,
    `export USER=${shellQuote(user)}`,
    // appended, not replaced: openrc-run's own helpers (checkpath, mountinfo) are found through the PATH it sets
    `export PATH="$PATH:"${shellQuote(spec.path)}`,
    'export GONOGO_SERVICE=openrc',
    '',
    'depend() {',
    '\tneed net',
    '}',
    '',
    'start_pre() {',
    `\tcheckpath -f -m 0640 -o ${shellQuote(`${user}:${group}`)} /var/log/gonogo.log`,
    '}',
    '',
  ].join('\n');
}

/* ---------------------------------------------------------------- the spec */

/** The unit's command line from what this process is and the flags given; throws a sentence when this install cannot be a service. */
export function resolveSpec(host: ServiceHost, options: ServiceOptions): Spec {
  if (host.kind === 'docker') throw new Error('this gonogo runs in a container: the container is its service (restart: unless-stopped in compose.yaml). See Running in Docker.');
  if (host.kind === 'dlx') throw new Error('this gonogo was started by pnpm dlx, which keeps nothing installed: install it first (npm i -g @ulm0/gonogo@latest), then run gonogo service install from that one.');
  const entry = host.entry;
  if (entry === undefined || !isAbsolute(entry)) throw new Error('cannot tell where the gonogo command is: run it by its path or from the PATH, not through a loader');
  let program: string[];
  if (/[\\/]\.pnpm[\\/]/.test(entry)) {
    // pnpm's folder carries the version and is replaced by an update; its shim in PNPM_HOME is the stable name
    const pnpmHome = host.env.PNPM_HOME;
    const shim = pnpmHome === undefined || pnpmHome === '' ? null : join(pnpmHome, 'gonogo');
    if (shim === null || !existsSync(shim)) throw new Error('this gonogo runs from pnpm\'s versioned folder, which an update replaces, and the pnpm shim ($PNPM_HOME/gonogo) was not found: set PNPM_HOME, or install with npm (npm i -g @ulm0/gonogo@latest)');
    program = [shim];
  } else {
    program = [host.node, entry];
  }
  const home = resolve(options.home ?? join(host.userHome, DEFAULT_HOME_DIRNAME));
  const flags = ['--home', home];
  if (options.host !== undefined) flags.push('--host', options.host);
  if (options.port !== undefined) flags.push('--port', String(options.port));
  if (options.ptyHost === true) flags.push('--pty-host');
  const argv = [...program, ...flags].map((word, i) => checkText(i === 0 ? 'the program path' : 'an option', word));
  // node's own folder first, so the `node` a shim or a script asks for is the one that runs gonogo
  const dirs = [dirname(host.node), ...(host.env.PATH ?? '').split(':').filter((d) => d !== '')];
  const path = checkText('PATH', [...new Set(dirs)].join(':'));
  return { argv, path, home };
}

/* ---------------------------------------------------------------- the manager */

function ranOk(r: Ran): boolean {
  return r.code === 0;
}

/** Which manager this machine has, or null. A user's systemd has to answer: a container with systemd files but no running user manager is not one. */
export function detectManager(host: ServiceHost): Manager | null {
  if (host.platform === 'darwin') return 'launchd';
  if (host.platform !== 'linux') return null;
  if (ranOk(host.run('systemctl', ['--user', 'show-environment']))) return 'systemd';
  if (existsSync(host.openrcRun)) return 'openrc';
  return null;
}

const UNSUPPORTED = 'no service manager found here (systemd --user, launchd or OpenRC): run gonogo yourself, for example in tmux or screen, or from a script of your own.';

function filePath(host: ServiceHost, manager: Manager): string {
  if (manager === 'systemd') {
    const xdg = host.env.XDG_CONFIG_HOME;
    return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(host.userHome, '.config'), 'systemd', 'user', `${SERVICE_NAME}.service`);
  }
  if (manager === 'launchd') return join(host.userHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  return join(host.initDir, SERVICE_NAME);
}

function write(path: string, text: string, mode = 0o644, dirMode = 0o755): boolean {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  writeFileSync(path, text, { mode });
  return before !== null;
}

function describeFailure(what: string, r: Ran): string {
  return `${what} failed${r.code === null ? '' : ` (exit ${r.code})`}${r.stderr.trim() === '' ? '' : `: ${r.stderr.trim().split('\n')[0]}`}`;
}

function resolveManager(host: ServiceHost, options: ServiceOptions): { manager: Manager } | { result: Result } {
  const found = detectManager(host);
  const manager = options.manager ?? found;
  if (manager === null || manager === undefined) return { result: { code: 1, lines: [UNSUPPORTED] } };
  if (options.manager !== undefined && options.now === true && found !== manager) return { result: { code: 1, lines: [`--now needs a running ${manager} here, and this machine has ${found ?? 'none'}: install without --now and activate the file where ${manager} runs.`] } };
  return { manager };
}

/** The user an OpenRC service runs as: the invoking user, or when this runs as root through sudo the one who asked for sudo, or --user. Never root. */
function openrcUser(host: ServiceHost, options: ServiceOptions): { user: string; group: string } {
  if (host.uid !== 0) return { user: host.user, group: host.group };
  const name = options.user ?? host.env.SUDO_USER;
  if (name === undefined || name === '' || name === 'root') throw new Error('this runs as root, and gonogo does not run agents as root: say which user the service runs as with --user <name>');
  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(name)) throw new Error(`"${name}" is not a user name`);
  return { user: name, group: name };
}

/* ---------------------------------------------------------------- install */

export function serviceInstall(host: ServiceHost, options: ServiceOptions): Result {
  const lines: string[] = [];
  const picked = resolveManager(host, options);
  if ('result' in picked) return picked.result;
  const { manager } = picked;
  if (host.uid === 0 && manager !== 'openrc') return { code: 1, lines: ['gonogo does not run as root: run this as the user that should own the agents (a root gonogo cannot start Claude Code with bypassPermissions).'] };
  // OpenRC may run as root for another user: the default --home is that user's
  const who = manager === 'openrc' ? openrcUser(host, options) : { user: host.user, group: host.group };
  const spec = resolveSpec(manager === 'openrc' && host.uid === 0 ? { ...host, userHome: passwdHome(who.user) } : host, options);
  const target = filePath(host, manager);
  const pty = options.ptyHost === true ? [] : ['tip: add --pty-host to the install so that a reload and an Update keep the agents running (gonogo service install --pty-host).'];

  if (manager === 'systemd') {
    const replaced = write(target, renderSystemd(spec));
    lines.push(`${replaced ? 'replaced' : 'wrote'} ${target}`, `runs: ${spec.argv.join(' ')}`);
    if (options.now === true) {
      for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', `${SERVICE_NAME}.service`]]) {
        const r = host.run('systemctl', args);
        if (!ranOk(r)) return { code: 1, lines: [...lines, describeFailure(`systemctl ${args.join(' ')}`, r)] };
      }
      lines.push('enabled and started.');
    } else {
      lines.push('to start it now and at every login:', `  systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_NAME}.service`);
    }
    lines.push('to keep it running when you are logged out, and to start it at boot (it may ask for authorisation; gonogo never runs it):', `  loginctl enable-linger ${host.user}`, ...pty);
    return { code: 0, lines };
  }

  if (manager === 'launchd') {
    const log = join(host.userHome, 'Library', 'Logs', 'gonogo.log');
    mkdirSync(dirname(log), { recursive: true, mode: 0o755 });
    const replaced = write(target, renderLaunchd(spec, log));
    lines.push(`${replaced ? 'replaced' : 'wrote'} ${target}`, `runs: ${spec.argv.join(' ')}`, `log: ${log}`);
    const domain = `gui/${host.uid}`;
    if (options.now === true) {
      host.run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
      const r = host.run('launchctl', ['bootstrap', domain, target]);
      if (!ranOk(r)) return { code: 1, lines: [...lines, describeFailure('launchctl bootstrap', r)] };
      lines.push('loaded and started (it starts again at every login).');
    } else {
      lines.push('to start it now and at every login:', `  launchctl bootstrap ${domain} ${target}`);
    }
    lines.push(...pty);
    return { code: 0, lines };
  }

  // OpenRC: /etc/init.d needs root. As the invoking user the file is staged in the home and the commands are printed.
  const { user, group } = who;
  for (const word of spec.argv) if (!PLAIN.test(word)) return { code: 1, lines: [`OpenRC cannot take "${word}" in a command line: use a path without spaces or special characters for node, gonogo and --home.`] };
  const text = renderOpenrc(spec, user, group, host.uid === 0 ? passwdHome(user) : host.userHome);
  if (host.uid !== 0) {
    const staged = join(spec.home, 'service', 'gonogo.initd');
    write(staged, text, 0o755, 0o700);
    lines.push(`wrote ${staged} (it runs gonogo as ${user}); /etc/init.d needs root, so install it yourself:`, `  sudo install -m 0755 ${staged} ${target}`, `  sudo rc-update add ${SERVICE_NAME} default`, `  sudo rc-service ${SERVICE_NAME} start`, `runs: ${spec.argv.join(' ')}`);
    if (options.now === true) lines.push('--now was not applied: it needs root, and gonogo never runs sudo.');
    lines.push(...pty);
    return { code: 0, lines };
  }
  const replaced = write(target, text, 0o755);
  lines.push(`${replaced ? 'replaced' : 'wrote'} ${target} (it runs gonogo as ${user})`, `runs: ${spec.argv.join(' ')}`);
  if (options.now === true) {
    for (const [file, args] of [['rc-update', ['add', SERVICE_NAME, 'default']], ['rc-service', [SERVICE_NAME, 'restart']]] as const) {
      const r = host.run(file, [...args]);
      if (!ranOk(r)) return { code: 1, lines: [...lines, describeFailure(`${file} ${args.join(' ')}`, r)] };
    }
    lines.push('added to the default runlevel and started.');
  } else lines.push('to start it now and at boot:', `  rc-update add ${SERVICE_NAME} default`, `  rc-service ${SERVICE_NAME} start`);
  lines.push(...pty);
  return { code: 0, lines };
}

/* ---------------------------------------------------------------- uninstall */

export function serviceUninstall(host: ServiceHost, options: ServiceOptions): Result {
  const picked = resolveManager(host, { ...options, now: false });
  if ('result' in picked) return picked.result;
  const { manager } = picked;
  const target = filePath(host, manager);
  const lines: string[] = [];
  if (manager === 'systemd') {
    host.run('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`]);
    const had = existsSync(target);
    rmSync(target, { force: true });
    host.run('systemctl', ['--user', 'daemon-reload']);
    lines.push(had ? `stopped and removed ${target}` : `no ${target}; nothing to remove`);
    return { code: 0, lines };
  }
  if (manager === 'launchd') {
    host.run('launchctl', ['bootout', `gui/${host.uid}/${LAUNCHD_LABEL}`]);
    const had = existsSync(target);
    rmSync(target, { force: true });
    lines.push(had ? `stopped and removed ${target}` : `no ${target}; nothing to remove`);
    return { code: 0, lines };
  }
  if (host.uid !== 0) {
    lines.push(`/etc/init.d needs root, so run these yourself:`, `  sudo rc-service ${SERVICE_NAME} stop`, `  sudo rc-update del ${SERVICE_NAME} default`, `  sudo rm ${target}`);
    return { code: 0, lines };
  }
  host.run('rc-service', [SERVICE_NAME, 'stop']);
  host.run('rc-update', ['del', SERVICE_NAME, 'default']);
  const had = existsSync(target);
  rmSync(target, { force: true });
  lines.push(had ? `stopped and removed ${target}` : `no ${target}; nothing to remove`);
  return { code: 0, lines };
}

/* ---------------------------------------------------------------- status */

/** Exit code: 0 active, 3 installed but not active, 4 not installed, 1 no manager (the numbers systemctl uses). */
export function serviceStatus(host: ServiceHost, options: ServiceOptions): Result {
  const picked = resolveManager(host, { ...options, now: false });
  if ('result' in picked) return picked.result;
  const { manager } = picked;
  const target = filePath(host, manager);
  const installed = existsSync(target);
  const lines = [`manager: ${manager}${manager === 'systemd' ? ' (user)' : manager === 'launchd' ? ' (LaunchAgent)' : ''}`, `file: ${target}${installed ? '' : ' (not there)'}`];
  if (!installed) return { code: 4, lines: [...lines, 'installed: no', manager === 'openrc' && host.uid !== 0 ? `(a staged copy may be in <home>/service/gonogo.initd; /etc/init.d needs root)` : 'run: gonogo service install'] };
  let active: boolean;
  let detail = '';
  if (manager === 'systemd') {
    const r = host.run('systemctl', ['--user', 'is-active', `${SERVICE_NAME}.service`]);
    active = r.code === 0;
    detail = r.stdout.trim();
    const enabled = host.run('systemctl', ['--user', 'is-enabled', `${SERVICE_NAME}.service`]);
    lines.push(`enabled: ${enabled.stdout.trim() === '' ? 'unknown' : enabled.stdout.trim()}`);
  } else if (manager === 'launchd') {
    const r = host.run('launchctl', ['print', `gui/${host.uid}/${LAUNCHD_LABEL}`]);
    active = r.code === 0 && /state = running/.test(r.stdout);
    detail = r.code !== 0 ? 'not loaded' : /state = (\w+)/.exec(r.stdout)?.[1] ?? 'loaded';
  } else {
    const r = host.run('rc-service', [SERVICE_NAME, 'status']);
    active = r.code === 0;
    detail = r.stdout.trim().replace(/^\*\s*/, '').replace(/^status:\s*/, '') || (active ? 'started' : 'stopped');
  }
  lines.push(`active: ${active ? 'yes' : 'no'}${detail === '' ? '' : ` (${detail})`}`);
  return { code: active ? 0 : 3, lines };
}

/* ---------------------------------------------------------------- the real machine */

export function realHost(kind: InstallKind, entry: string | undefined, env: Record<string, string | undefined> = process.env, userInfo: { username: string; homedir: string; gid: number } | null = null): ServiceHost {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const user = userInfo?.username ?? env.USER ?? env.LOGNAME ?? 'user';
  return {
    platform: process.platform,
    uid,
    user,
    group: groupName(gid, user),
    userHome: userInfo?.homedir ?? env.HOME ?? '/',
    env,
    node: process.execPath,
    entry,
    kind,
    run(file, args) {
      const r = spawnSync(file, args, { encoding: 'utf8', timeout: 60_000, env });
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.error === undefined ? (r.stderr ?? '') : String(r.error.message) };
    },
    openrcRun: '/sbin/openrc-run',
    initDir: '/etc/init.d',
  };
}

/** A user's home from /etc/passwd, else /home/<name>. */
function passwdHome(user: string): string {
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] === user && f[5] !== undefined && f[5] !== '') return f[5];
    }
  } catch {
    // no /etc/passwd: the usual place
  }
  return join('/home', user);
}

/** The group name for a gid: from /etc/group, else the user's name (the usual private group). */
function groupName(gid: number, fallback: string): string {
  try {
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const [name, , id] = line.split(':');
      if (name !== undefined && id === String(gid)) return name;
    }
  } catch {
    // no /etc/group (macOS reads it elsewhere): the fallback
  }
  return fallback;
}
