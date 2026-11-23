/**
 * gonogo service install | uninstall | start | stop | restart | status: run gonogo under the user's own service manager (docs/guide/service.md).
 *
 * systemd (a user unit), launchd (a LaunchAgent) or OpenRC (an init script that runs as the invoking user). The service always runs as the
 * person's own user, never as root, and gonogo never runs sudo itself. install writes the file and starts the service (--no-start only writes it);
 * a step that needs root and is not root stops with the one line to run again with sudo. The unit pins the absolute path of node and of the
 * gonogo entry as installed, the PATH of the shell that installed it (so claude, git and gh are found at boot) and the user's home as the
 * working folder. Run as root through sudo, the same install is done for SUDO_USER: lingering is turned on, then the install runs as that user.
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
import { DEFAULT_HOME_DIRNAME, DEFAULT_PORT } from './constants.js';

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
  /** Write the file and do not start the service. */
  noStart?: boolean;
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
  /** True when something accepts connections on host:port. */
  portInUse(host: string, port: number): boolean;
  /** Where a running systemd shows itself (root's way to tell systemd from OpenRC). */
  systemdRunDir: string;
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
  /** The folder it runs in: the user's home. */
  cwd: string;
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
    `WorkingDirectory=${systemdWord(spec.cwd)}`,
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
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlText(spec.cwd)}</string>`,
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

export function renderOpenrc(spec: Spec, user: string, group: string): string {
  const [program, ...args] = spec.argv;
  return [
    '#!/sbin/openrc-run',
    '# Written by `gonogo service install`; `gonogo service uninstall` prints how to remove it. It runs gonogo as an ordinary user.',
    `name="gonogo"`,
    `description="gonogo, mission control for coding agents"`,
    `command=${shellQuote(program ?? '')}`,
    `command_args=${shellQuote(args.join(' '))}`,
    `command_user=${shellQuote(`${user}:${group}`)}`,
    `directory=${shellQuote(spec.cwd)}`,
    // supervise-daemon starts it again when it exits, and a reload and an Update make gonogo exit 0 on purpose
    'supervisor="supervise-daemon"',
    'respawn_delay=3',
    'respawn_max=0',
    `output_log="/var/log/gonogo.log"`,
    `error_log="/var/log/gonogo.log"`,
    `retry="TERM/${STOP_TIMEOUT_S}/KILL/5"`,
    `export HOME=${shellQuote(spec.cwd)}`,
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
  return { argv, path, home, cwd: resolve(host.userHome) };
}

/* ---------------------------------------------------------------- the manager */

function ranOk(r: Ran): boolean {
  return r.code === 0;
}

/** Which manager this machine has, or null. A user's systemd has to answer: a container with systemd files but no running user manager is not one. */
export function detectManager(host: ServiceHost): Manager | null {
  if (host.platform === 'darwin') return 'launchd';
  if (host.platform !== 'linux') return null;
  // root has no user manager of its own: systemd is the one that runs the machine
  if (host.uid === 0 ? existsSync(host.systemdRunDir) : ranOk(host.run('systemctl', ['--user', 'show-environment']))) return 'systemd';
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

type Picked = { manager: Manager } | { result: Result };

function resolveManager(host: ServiceHost, options: ServiceOptions, start = false): Picked {
  const found = detectManager(host);
  const manager = options.manager ?? found;
  if (manager === null || manager === undefined) return { result: { code: 1, lines: [UNSUPPORTED] } };
  if (options.manager !== undefined && start && found !== manager) return { result: { code: 1, lines: [`starting needs a running ${manager} here, and this machine has ${found ?? 'none'}: use --no-start and activate the file where ${manager} runs.`] } };
  return { manager };
}

/** The flags as the person gave them, for a command line printed back to them. */
export function flagsText(options: ServiceOptions): string {
  const parts: string[] = [];
  const add = (flag: string, value?: string | number): void => {
    parts.push(flag);
    if (value !== undefined) parts.push(PLAIN.test(String(value)) ? String(value) : shellQuote(String(value)));
  };
  if (options.home !== undefined) add('--home', options.home);
  if (options.host !== undefined) add('--host', options.host);
  if (options.port !== undefined) add('--port', options.port);
  if (options.ptyHost === true) add('--pty-host');
  if (options.noStart === true) add('--no-start');
  if (options.manager !== undefined) add('--manager', options.manager);
  if (options.user !== undefined) add('--user', options.user);
  return parts.join(' ');
}

/** The first lines when a step needs root and this is not root: the exact command to run again with sudo. */
export function needsRoot(host: ServiceHost, action: string, options: ServiceOptions): string[] {
  const tail = `service ${action}${flagsText(options) === '' ? '' : ` ${flagsText(options)}`}`;
  return [`This needs root: run \`sudo gonogo ${tail}\``, `(if sudo does not find gonogo: sudo ${host.node} ${host.entry ?? 'gonogo'} ${tail})`, 'The service still runs as you, never as root.'];
}

/** The user a root-run command is for: --user, or the one who ran sudo. Never root. */
function targetUser(host: ServiceHost, options: ServiceOptions): string {
  const name = options.user ?? host.env.SUDO_USER;
  if (name === undefined || name === '' || name === 'root') throw new Error('this runs as root, and gonogo does not run agents as root: run it with sudo from the account that should own the agents, or say which user with --user <name>');
  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(name)) throw new Error(`"${name}" is not a user name`);
  return name;
}

/** The port the file pins (--port), else gonogo's default: what a foreground gonogo would be holding. */
function pinnedPort(file: string): number {
  try {
    const m = /--port(?:<\/string>\s*<string>|[\s=]+)(\d{1,5})/.exec(readFileSync(file, 'utf8'));
    return m === null ? DEFAULT_PORT : Number(m[1]);
  } catch {
    return DEFAULT_PORT;
  }
}

function portRefusal(port: number): string[] {
  return [`not started: a gonogo (or something else) is already listening on port ${port}.`, 'stop the running gonogo first (Ctrl+C), then run gonogo service start'];
}

function isActive(host: ServiceHost, manager: Manager): boolean {
  if (manager === 'systemd') return ranOk(host.run('systemctl', ['--user', 'is-active', `${SERVICE_NAME}.service`]));
  if (manager === 'launchd') return /state = running/.test(host.run('launchctl', ['print', `gui/${host.uid}/${LAUNCHD_LABEL}`]).stdout);
  return ranOk(host.run('rc-service', [SERVICE_NAME, 'status']));
}

function step(host: ServiceHost, lines: string[], file: string, args: string[]): Result | null {
  const r = host.run(file, args);
  return ranOk(r) ? null : { code: 1, lines: [...lines, describeFailure(`${file} ${args.join(' ')}`, r)] };
}

/** Lingering keeps a user's units running when nobody is logged in and starts them at boot. Asked for, never forced: where polkit refuses, the person is told to use sudo. */
function ensureLinger(host: ServiceHost, options: ServiceOptions): string[] {
  const shown = host.run('loginctl', ['show-user', host.user, '--property=Linger', '--value']);
  if (ranOk(shown) && shown.stdout.trim() === 'yes') return ['lingering is on: it also runs when you are logged out and starts at boot.'];
  if (!ranOk(shown) && shown.stderr.trim() === '' && shown.stdout.trim() === '') return ['could not read the lingering state (no logind?): to keep it running when you are logged out, run: loginctl enable-linger ' + host.user];
  if (ranOk(host.run('loginctl', ['enable-linger', host.user]))) return ['lingering turned on: it also runs when you are logged out and starts at boot.'];
  return ['it runs now, but lingering is off, so it stops when you log out and does not start at boot.', ...needsRoot(host, 'install', options)];
}

/** Root (sudo gonogo service install) on systemd: turn lingering on for the user, then run the same install as that user, with their HOME and PATH. */
function installForUser(host: ServiceHost, action: string, options: ServiceOptions): Result {
  const user = targetUser(host, options);
  const uid = host.run('id', ['-u', user]).stdout.trim();
  if (!/^\d+$/.test(uid)) return { code: 1, lines: [`there is no user "${user}"`] };
  const home = passwdHome(user);
  const lines: string[] = [];
  if (action === 'install') {
    const r = host.run('loginctl', ['enable-linger', user]);
    lines.push(ranOk(r) ? `lingering turned on for ${user}.` : describeFailure('loginctl enable-linger', r));
  }
  // the user's own PATH (their profile), not sudo's secure_path
  const login = host.run('runuser', ['-u', user, '--', 'sh', '-lc', 'printf %s "$PATH"']);
  const userPath = ranOk(login) && login.stdout.trim() !== '' ? login.stdout.trim() : host.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const childFlags = flagsText({ ...options, user: undefined }).split(' ').filter((x) => x !== '');
  const r = host.run('runuser', ['-u', user, '--', 'env', `HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`, `PATH=${userPath}`, `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, host.node, host.entry ?? 'gonogo', 'service', action, ...childFlags]);
  const text = [r.stdout.trim(), r.stderr.trim()].filter((x) => x !== '').join('\n');
  return { code: r.code ?? 1, lines: [...lines, ...(text === '' ? [] : text.split('\n'))] };
}

/* ---------------------------------------------------------------- install */

export function serviceInstall(host: ServiceHost, options: ServiceOptions): Result {
  const lines: string[] = [];
  const start = options.noStart !== true;
  const picked = resolveManager(host, options, start);
  if ('result' in picked) return picked.result;
  const { manager } = picked;
  const root = host.uid === 0;
  if (root && manager !== 'openrc') {
    if (manager === 'launchd') return { code: 1, lines: ['gonogo does not run as root, and launchd needs no root: run it without sudo, as the user that should own the agents.'] };
    return installForUser(host, 'install', options);
  }
  // OpenRC may run as root for another user: the default --home and the working folder are that user's
  const who = manager === 'openrc' ? (root ? { user: targetUser(host, options), group: targetUser(host, options) } : { user: host.user, group: host.group }) : { user: host.user, group: host.group };
  const spec = resolveSpec(manager === 'openrc' && root ? { ...host, userHome: passwdHome(who.user) } : host, options);
  const target = filePath(host, manager);
  const pty = options.ptyHost === true ? [] : ['tip: add --pty-host to the install so that a reload and an Update keep the agents running (gonogo service install --pty-host).'];
  const port = options.port ?? DEFAULT_PORT;
  const tryHost = options.host === undefined || options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;

  if (manager === 'systemd') {
    const replaced = write(target, renderSystemd(spec));
    lines.push(`${replaced ? 'replaced' : 'wrote'} ${target}`, `runs: ${spec.argv.join(' ')}`, `in: ${spec.cwd}`);
    if (!start) return { code: 0, lines: [...lines, 'not started (--no-start). To start it now and at every login:', `  systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_NAME}.service`, ...pty] };
    const reload = step(host, lines, 'systemctl', ['--user', 'daemon-reload']);
    if (reload !== null) return reload;
    const wasActive = isActive(host, manager);
    if (!wasActive && host.portInUse(tryHost, port)) return { code: 1, lines: [...lines, ...portRefusal(port)] };
    for (const args of [['--user', 'enable', `${SERVICE_NAME}.service`], ['--user', 'restart', `${SERVICE_NAME}.service`]]) {
      const failed = step(host, lines, 'systemctl', args);
      if (failed !== null) return failed;
    }
    lines.push(wasActive ? 'restarted.' : 'enabled and started.', ...ensureLinger(host, options), ...pty);
    return { code: 0, lines };
  }

  if (manager === 'launchd') {
    const log = join(host.userHome, 'Library', 'Logs', 'gonogo.log');
    mkdirSync(dirname(log), { recursive: true, mode: 0o755 });
    const replaced = write(target, renderLaunchd(spec, log));
    lines.push(`${replaced ? 'replaced' : 'wrote'} ${target}`, `runs: ${spec.argv.join(' ')}`, `in: ${spec.cwd}`, `log: ${log}`);
    const domain = `gui/${host.uid}`;
    if (!start) return { code: 0, lines: [...lines, 'not started (--no-start). To start it now and at every login:', `  launchctl bootstrap ${domain} ${target}`, ...pty] };
    const wasActive = isActive(host, manager);
    if (!wasActive && host.portInUse(tryHost, port)) return { code: 1, lines: [...lines, ...portRefusal(port)] };
    host.run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
    for (const args of [['bootstrap', domain, target], ['kickstart', `${domain}/${LAUNCHD_LABEL}`]]) {
      const failed = step(host, lines, 'launchctl', args);
      if (failed !== null) return failed;
    }
    lines.push(wasActive ? 'restarted (it starts again at every login).' : 'loaded and started (it starts again at every login).', ...pty);
    return { code: 0, lines };
  }

  // OpenRC: /etc/init.d needs root. As the invoking user the file is staged in the home and the commands are printed after the one line that says what to do.
  const { user, group } = who;
  for (const word of spec.argv) if (!PLAIN.test(word)) return { code: 1, lines: [`OpenRC cannot take "${word}" in a command line: use a path without spaces or special characters for node, gonogo and --home.`] };
  const text = renderOpenrc(spec, user, group);
  if (!root) {
    const staged = join(spec.home, 'service', 'gonogo.initd');
    write(staged, text, 0o755, 0o700);
    lines.push(...needsRoot(host, 'install', options), '', `meanwhile ${staged} holds the script (it runs gonogo as ${user}); by hand:`, `  sudo install -m 0755 ${staged} ${target}`, `  sudo rc-update add ${SERVICE_NAME} default`, `  sudo rc-service ${SERVICE_NAME} ${start ? 'restart' : 'start'}`, `runs: ${spec.argv.join(' ')}`, ...pty);
    return { code: 1, lines };
  }
  const replaced = write(target, text, 0o755);
  lines.push(`${replaced ? 'replaced' : 'wrote'} ${target} (it runs gonogo as ${user})`, `runs: ${spec.argv.join(' ')}`, `in: ${spec.cwd}`);
  if (!start) return { code: 0, lines: [...lines, 'not started (--no-start). To start it now and at boot:', `  rc-update add ${SERVICE_NAME} default`, `  rc-service ${SERVICE_NAME} start`, ...pty] };
  const wasActive = isActive(host, manager);
  if (!wasActive && host.portInUse(tryHost, port)) return { code: 1, lines: [...lines, ...portRefusal(port)] };
  for (const [file, args] of [['rc-update', ['add', SERVICE_NAME, 'default']], ['rc-service', [SERVICE_NAME, 'restart']]] as const) {
    const failed = step(host, lines, file, [...args]);
    if (failed !== null) return failed;
  }
  lines.push(wasActive ? 'restarted.' : 'added to the default runlevel and started.', ...pty);
  return { code: 0, lines };
}

/* ---------------------------------------------------------------- uninstall, start, stop, restart */

export function serviceUninstall(host: ServiceHost, options: ServiceOptions): Result {
  const picked = resolveManager(host, options);
  if ('result' in picked) return picked.result;
  const { manager } = picked;
  if (host.uid === 0 && manager === 'systemd') return installForUser(host, 'uninstall', options);
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
    lines.push(...needsRoot(host, 'uninstall', options), '', 'by hand:', `  sudo rc-service ${SERVICE_NAME} stop`, `  sudo rc-update del ${SERVICE_NAME} default`, `  sudo rm ${target}`);
    return { code: 1, lines };
  }
  host.run('rc-service', [SERVICE_NAME, 'stop']);
  host.run('rc-update', ['del', SERVICE_NAME, 'default']);
  const had = existsSync(target);
  rmSync(target, { force: true });
  lines.push(had ? `stopped and removed ${target}` : `no ${target}; nothing to remove`);
  return { code: 0, lines };
}

/** start, stop, restart: thin wrappers over the manager, for an installed service. */
export function serviceControl(host: ServiceHost, action: 'start' | 'stop' | 'restart', options: ServiceOptions): Result {
  const picked = resolveManager(host, options);
  if ('result' in picked) return picked.result;
  const { manager } = picked;
  if (host.uid === 0 && manager === 'systemd') return installForUser(host, action, options);
  const target = filePath(host, manager);
  if (!existsSync(target)) return { code: 4, lines: [`file: ${target} (not there)`, 'not installed: run gonogo service install'] };
  if (manager === 'openrc' && host.uid !== 0) return { code: 1, lines: [...needsRoot(host, action, options), '', 'by hand:', `  sudo rc-service ${SERVICE_NAME} ${action}`] };
  const tryHost = '127.0.0.1';
  if (action !== 'stop' && !isActive(host, manager) && host.portInUse(tryHost, pinnedPort(target))) return { code: 1, lines: portRefusal(pinnedPort(target)) };
  const domain = `gui/${host.uid}`;
  const calls: [string, string[]][] =
    manager === 'systemd'
      ? [['systemctl', ['--user', action, `${SERVICE_NAME}.service`]]]
      : manager === 'openrc'
        ? [['rc-service', [SERVICE_NAME, action]]]
        : action === 'stop'
          ? [['launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]]]
          : [['launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]], ['launchctl', ['bootstrap', domain, target]], ['launchctl', ['kickstart', `${domain}/${LAUNCHD_LABEL}`]]];
  for (const [file, args] of calls) {
    // booting out a service that is not loaded fails, and that is fine
    if (manager === 'launchd' && args[0] === 'bootout' && action !== 'stop') {
      host.run(file, args);
      continue;
    }
    const failed = step(host, [], file, args);
    if (failed !== null) return failed;
  }
  return { code: 0, lines: [`${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'} (${manager}).`] };
}

/* ---------------------------------------------------------------- status */

/** Exit code: 0 active, 3 installed but not active, 4 not installed, 1 no manager (the numbers systemctl uses). */
export function serviceStatus(host: ServiceHost, options: ServiceOptions): Result {
  const picked = resolveManager(host, options);
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
    systemdRunDir: '/run/systemd/system',
    portInUse(addr, port) {
      const probe = "const s=require('net').connect({host:process.argv[1],port:Number(process.argv[2])});s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)";
      return spawnSync(process.execPath, ['-e', probe, addr, String(port)], { timeout: 5000 }).status === 0;
    },
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
