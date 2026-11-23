import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/server/cli.js';
import { detectManager, renderLaunchd, renderOpenrc, renderSystemd, resolveSpec, serviceInstall, serviceStatus, serviceUninstall, systemdWord, xmlText, type Ran, type ServiceHost } from '../src/server/service.js';

type Call = [string, string[]];

/** A machine in a temp folder: `answers` maps "file arg arg" to what that command prints; anything else exits 1. */
function fake(over: Partial<ServiceHost> = {}, answers: Record<string, Partial<Ran>> = {}): { host: ServiceHost; calls: Call[]; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'gonogo-service-'));
  const calls: Call[] = [];
  const host: ServiceHost = {
    platform: 'linux',
    uid: 1000,
    user: 'ana',
    group: 'ana',
    userHome: join(root, 'home', 'ana'),
    env: { PATH: '/usr/local/bin:/usr/bin', HOME: join(root, 'home', 'ana') },
    node: '/opt/node/bin/node',
    entry: '/usr/local/bin/gonogo',
    kind: 'npm',
    run(file, args) {
      calls.push([file, args]);
      const a = answers[`${file} ${args.join(' ')}`];
      return { code: 1, stdout: '', stderr: '', ...a };
    },
    openrcRun: join(root, 'openrc-run'),
    initDir: join(root, 'etc-init.d'),
    ...over,
  };
  mkdirSync(host.userHome, { recursive: true });
  return { host, calls, root };
}
const cmds = (calls: Call[]): string[] => calls.map(([f, a]) => `${f} ${a.join(' ')}`);
const SYSTEMD_OK = { 'systemctl --user show-environment': { code: 0 } };

describe('gonogo service: the arguments', () => {
  it('takes an action and the few flags of the unit', () => {
    expect(parseArgs(['service', 'install', '--now', '--port', '7000', '--host', '0.0.0.0', '--home', '/h', '--pty-host'])).toEqual({ kind: 'service', action: 'install', options: { now: true, port: 7000, host: '0.0.0.0', home: '/h', ptyHost: true } });
    expect(parseArgs(['service', 'status'])).toEqual({ kind: 'service', action: 'status', options: {} });
    expect(parseArgs(['service', 'uninstall', '--manager', 'openrc'])).toEqual({ kind: 'service', action: 'uninstall', options: { manager: 'openrc' } });
  });

  it('refuses what it does not know', () => {
    for (const argv of [['service'], ['service', 'start'], ['service', 'install', '--port'], ['service', 'install', '--port', 'x'], ['service', 'install', '--manager', 'runit'], ['service', 'install', '--bogus'], ['service', 'status', '--now'], ['service', 'uninstall', '--port', '1']]) {
      expect(parseArgs(argv).kind, argv.join(' ')).toBe('error');
    }
  });
});

describe('gonogo service: the files', () => {
  const spec = { argv: ['/opt/node/bin/node', '/usr/local/bin/gonogo', '--home', '/home/ana/.gonogo', '--pty-host'], path: '/opt/node/bin:/usr/bin', home: '/home/ana/.gonogo' };

  it('a systemd unit restarts on any exit, keeps the pty host alive, and pins node, the entry and PATH', () => {
    const unit = renderSystemd(spec);
    expect(unit).toContain('ExecStart=/opt/node/bin/node /usr/local/bin/gonogo --home /home/ana/.gonogo --pty-host\n');
    expect(unit).toContain('Environment="PATH=/opt/node/bin:/usr/bin"');
    expect(unit).toContain('Environment=GONOGO_SERVICE=systemd');
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).toMatch(/^KillMode=process$/m);
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/^User=/m);
  });

  it('quotes a word for systemd: % and $ are doubled, a space or quote puts it in quotes', () => {
    expect(systemdWord('/a/b-c_1.js')).toBe('/a/b-c_1.js');
    expect(systemdWord('/a b/%h/$x')).toBe('"/a b/%%h/$$x"');
    expect(systemdWord('/a"b')).toBe('"/a\\"b"');
    expect(systemdWord('/p%h')).toBe('"/p%%h"');
  });

  it('a launchd plist keeps the process group, restarts, logs, and escapes XML', () => {
    const plist = renderLaunchd({ ...spec, argv: [...spec.argv, '--host', 'a&b<c>'] }, '/home/ana/Library/Logs/gonogo.log');
    expect(plist).toContain('<key>Label</key>\n  <string>com.ulm0.gonogo</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;</string>');
    expect(plist).toContain('<string>/home/ana/Library/Logs/gonogo.log</string>');
    expect(xmlText(`"'`)).toBe('&quot;&apos;');
  });

  it('an OpenRC script runs as the user under supervise-daemon, never as root', () => {
    const rc = renderOpenrc(spec, 'ana', 'users', '/home/ana');
    expect(rc).toMatch(/^#!\/sbin\/openrc-run$/m);
    expect(rc).toContain("command='/opt/node/bin/node'");
    expect(rc).toContain("command_args='/usr/local/bin/gonogo --home /home/ana/.gonogo --pty-host'");
    expect(rc).toContain("command_user='ana:users'");
    expect(rc).toContain('supervisor="supervise-daemon"');
    expect(rc).toContain("export HOME='/home/ana'");
    expect(rc).toContain("export PATH=\"$PATH:\"'/opt/node/bin:/usr/bin'");
    expect(rc).toContain('export GONOGO_SERVICE=openrc');
  });
});

describe('gonogo service: what the unit runs', () => {
  it('defaults the home to ~/.gonogo as an absolute path, and pins only the flags given', () => {
    const { host } = fake();
    expect(resolveSpec(host, {}).argv).toEqual(['/opt/node/bin/node', '/usr/local/bin/gonogo', '--home', join(host.userHome, '.gonogo')]);
    expect(resolveSpec(host, { home: 'rel/h', host: '0.0.0.0', port: 8080, ptyHost: true }).argv.slice(2)).toEqual(['--home', join(process.cwd(), 'rel/h'), '--host', '0.0.0.0', '--port', '8080', '--pty-host']);
  });

  it('captures PATH with the folder of node first and no repeats', () => {
    const { host } = fake({ env: { PATH: '/usr/bin:/opt/node/bin:/usr/bin' } });
    expect(resolveSpec(host, {}).path).toBe('/opt/node/bin:/usr/bin');
  });

  it('refuses a container, a dlx run, an entry it cannot place and a control character', () => {
    expect(() => resolveSpec(fake({ kind: 'docker' }).host, {})).toThrow(/container/);
    expect(() => resolveSpec(fake({ kind: 'dlx' }).host, {})).toThrow(/dlx/);
    expect(() => resolveSpec(fake({ entry: undefined }).host, {})).toThrow(/where the gonogo command is/);
    expect(() => resolveSpec(fake().host, { host: 'a\nExecStartPre=/bin/evil' })).toThrow(/control character/);
    expect(() => resolveSpec(fake({ env: { PATH: '/a\n/b' } }).host, {})).toThrow(/control character/);
  });

  it("pnpm's versioned folder is replaced by an update: it needs the pnpm shim, which is then the program", () => {
    const { host, root } = fake({ entry: '/home/ana/.local/share/pnpm/global/5/.pnpm/@ulm0+gonogo@0.12.0/node_modules/@ulm0/gonogo/bin/gonogo.js', kind: 'pnpm' });
    expect(() => resolveSpec(host, {})).toThrow(/pnpm shim/);
    const shim = join(root, 'pnpm-home', 'gonogo');
    mkdirSync(join(root, 'pnpm-home'));
    writeFileSync(shim, '#!/bin/sh\n');
    expect(resolveSpec({ ...host, env: { ...host.env, PNPM_HOME: join(root, 'pnpm-home') } }, {}).argv[0]).toBe(shim);
  });
});

describe('gonogo service: choosing the manager', () => {
  it('launchd on macOS; systemd when the user manager answers; OpenRC when only openrc-run exists; else none', () => {
    expect(detectManager(fake({ platform: 'darwin' }).host)).toBe('launchd');
    expect(detectManager(fake({}, SYSTEMD_OK).host)).toBe('systemd');
    const rc = fake();
    writeFileSync(rc.host.openrcRun, '#!/bin/sh\n');
    expect(detectManager(rc.host)).toBe('openrc');
    expect(detectManager(fake().host)).toBeNull();
    expect(detectManager(fake({ platform: 'win32' }).host)).toBeNull();
  });

  it('says so, and writes nothing, when there is none', () => {
    const { host, calls } = fake();
    const r = serviceInstall(host, {});
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toMatch(/no service manager found/);
    expect(calls.every(([f]) => f === 'systemctl')).toBe(true);
  });
});

describe('gonogo service install, uninstall, status: systemd', () => {
  it('install writes the unit and prints the commands, and runs none of them', () => {
    const { host, calls } = fake({}, SYSTEMD_OK);
    const r = serviceInstall(host, { port: 7777, ptyHost: true });
    const path = join(host.userHome, '.config/systemd/user/gonogo.service');
    expect(r.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('--port 7777 --pty-host');
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const out = r.lines.join('\n');
    expect(out).toContain('systemctl --user daemon-reload && systemctl --user enable --now gonogo.service');
    expect(out).toContain('loginctl enable-linger ana');
    expect(out).not.toContain('tip:');
    expect(cmds(calls)).toEqual(['systemctl --user show-environment']);
  });

  it('install --now reloads, enables and starts; a failing command is reported', () => {
    const ok = fake({}, { ...SYSTEMD_OK, 'systemctl --user daemon-reload': { code: 0 }, 'systemctl --user enable --now gonogo.service': { code: 0 } });
    expect(serviceInstall(ok.host, { now: true }).lines.join('\n')).toContain('enabled and started');
    expect(cmds(ok.calls)).toEqual(['systemctl --user show-environment', 'systemctl --user daemon-reload', 'systemctl --user enable --now gonogo.service']);
    const bad = fake({}, { ...SYSTEMD_OK, 'systemctl --user daemon-reload': { code: 0 }, 'systemctl --user enable --now gonogo.service': { code: 5, stderr: 'Failed to connect to bus\nmore' } });
    const r = serviceInstall(bad.host, { now: true });
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe('systemctl --user enable --now gonogo.service failed (exit 5): Failed to connect to bus');
  });

  it('install again replaces the file; XDG_CONFIG_HOME is honoured; root is refused', () => {
    const { host } = fake({}, SYSTEMD_OK);
    serviceInstall(host, {});
    expect(serviceInstall(host, {}).lines[0]).toMatch(/^replaced /);
    const xdg = fake({}, SYSTEMD_OK);
    xdg.host.env.XDG_CONFIG_HOME = join(xdg.root, 'cfg');
    serviceInstall(xdg.host, {});
    expect(existsSync(join(xdg.root, 'cfg/systemd/user/gonogo.service'))).toBe(true);
    const root = fake({ uid: 0, user: 'root' }, SYSTEMD_OK);
    expect(serviceInstall(root.host, {}).lines[0]).toMatch(/does not run as root/);
    expect(existsSync(join(root.host.userHome, '.config'))).toBe(false);
  });

  it('suggests --pty-host when it was not given', () => {
    expect(serviceInstall(fake({}, SYSTEMD_OK).host, {}).lines.join('\n')).toContain('tip: add --pty-host');
  });

  it('uninstall stops it, removes the file and reloads; a second one says there is nothing', () => {
    const { host, calls } = fake({}, SYSTEMD_OK);
    serviceInstall(host, {});
    const path = join(host.userHome, '.config/systemd/user/gonogo.service');
    calls.length = 0;
    expect(serviceUninstall(host, {}).lines[0]).toBe(`stopped and removed ${path}`);
    expect(existsSync(path)).toBe(false);
    expect(cmds(calls)).toEqual(['systemctl --user show-environment', 'systemctl --user disable --now gonogo.service', 'systemctl --user daemon-reload']);
    expect(serviceUninstall(host, {}).lines[0]).toMatch(/nothing to remove/);
  });

  it('status: 4 not installed, 3 installed but not active, 0 active', () => {
    const { host } = fake({}, { ...SYSTEMD_OK, 'systemctl --user is-active gonogo.service': { code: 3, stdout: 'inactive\n' }, 'systemctl --user is-enabled gonogo.service': { code: 0, stdout: 'enabled\n' } });
    expect(serviceStatus(host, {}).code).toBe(4);
    serviceInstall(host, {});
    const idle = serviceStatus(host, {});
    expect(idle.code).toBe(3);
    expect(idle.lines).toContain('enabled: enabled');
    expect(idle.lines.at(-1)).toBe('active: no (inactive)');
    const up = fake({}, { ...SYSTEMD_OK, 'systemctl --user is-active gonogo.service': { code: 0, stdout: 'active\n' } });
    serviceInstall(up.host, {});
    expect(serviceStatus(up.host, {}).code).toBe(0);
  });
});

describe('gonogo service install, uninstall, status: launchd', () => {
  it('install writes the plist and the log folder; --now boots out then bootstraps', () => {
    const { host, calls } = fake({ platform: 'darwin' }, { 'launchctl bootstrap gui/1000 /nope': { code: 0 } });
    const path = join(host.userHome, 'Library/LaunchAgents/com.ulm0.gonogo.plist');
    const r = serviceInstall(host, {});
    expect(readFileSync(path, 'utf8')).toContain(join(host.userHome, 'Library/Logs/gonogo.log'));
    expect(r.lines.join('\n')).toContain(`launchctl bootstrap gui/1000 ${path}`);
    expect(calls).toEqual([]);
    const now = fake({ platform: 'darwin' });
    now.host.run = (file, args) => {
      now.calls.push([file, args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    expect(serviceInstall(now.host, { now: true }).lines.join('\n')).toMatch(/loaded and started/);
    expect(cmds(now.calls).map((c) => c.split(' ').slice(0, 3).join(' '))).toEqual(['launchctl bootout gui/1000/com.ulm0.gonogo', 'launchctl bootstrap gui/1000']);
  });

  it('status reads the state from launchctl print; uninstall boots out and removes the file', () => {
    const answer = { 'launchctl print gui/1000/com.ulm0.gonogo': { code: 0, stdout: '\tstate = running\n' } };
    const { host } = fake({ platform: 'darwin' }, answer);
    serviceInstall(host, {});
    expect(serviceStatus(host, {})).toMatchObject({ code: 0 });
    expect(serviceUninstall(host, {}).lines[0]).toMatch(/^stopped and removed /);
    expect(serviceStatus(host, {}).code).toBe(4);
  });
});

describe('gonogo service install, uninstall, status: OpenRC', () => {
  const withOpenrc = (over: Partial<ServiceHost> = {}, answers: Record<string, Partial<Ran>> = {}) => {
    const f = fake(over, answers);
    writeFileSync(f.host.openrcRun, '#!/bin/sh\n');
    return f;
  };

  it('as an ordinary user it stages the script in the home and prints the sudo commands; it never runs sudo', () => {
    const { host, calls } = withOpenrc();
    const r = serviceInstall(host, { now: true });
    const staged = join(host.userHome, '.gonogo/service/gonogo.initd');
    expect(readFileSync(staged, 'utf8')).toContain("command_user='ana:ana'");
    expect(statSync(join(host.userHome, '.gonogo/service')).mode & 0o777).toBe(0o700);
    const out = r.lines.join('\n');
    expect(out).toContain(`sudo install -m 0755 ${staged} ${host.initDir}/gonogo`);
    expect(out).toContain('sudo rc-update add gonogo default');
    expect(out).toContain('--now was not applied');
    expect(calls.some(([f]) => f === 'sudo' || f === 'rc-update')).toBe(false);
    expect(existsSync(join(host.initDir, 'gonogo'))).toBe(false);
  });

  it('as root through sudo it writes /etc/init.d for SUDO_USER, and --now adds and starts it', () => {
    const { host, calls } = withOpenrc({ uid: 0, user: 'root', group: 'root' }, { 'rc-update add gonogo default': { code: 0 }, 'rc-service gonogo restart': { code: 0 } });
    host.env.SUDO_USER = 'ana';
    const r = serviceInstall(host, { now: true, home: '/home/ana/.gonogo' });
    const text = readFileSync(join(host.initDir, 'gonogo'), 'utf8');
    expect(text).toContain("command_user='ana:ana'");
    expect(text).not.toContain("command_user='root");
    expect(statSync(join(host.initDir, 'gonogo')).mode & 0o777).toBe(0o755);
    expect(r.lines.join('\n')).toMatch(/added to the default runlevel and started/);
    expect(cmds(calls)).toContain('rc-service gonogo restart');
  });

  it('as root with nobody to run as it refuses; a path with a space or a quote is refused', () => {
    const root = withOpenrc({ uid: 0, user: 'root', group: 'root' });
    expect(() => serviceInstall(root.host, {})).toThrow(/--user/);
    expect(() => serviceInstall(withOpenrc({ uid: 0, user: 'root', group: 'root' }).host, { user: 'root' })).toThrow(/--user/);
    expect(() => serviceInstall(withOpenrc({ uid: 0, user: 'root', group: 'root' }).host, { user: 'a b' })).toThrow(/not a user name/);
    const spaced = withOpenrc();
    expect(serviceInstall(spaced.host, { home: '/h/with space' }).lines[0]).toMatch(/cannot take "\/h\/with space"/);
  });

  it('uninstall prints the sudo commands, or as root does them; status asks rc-service', () => {
    const user = withOpenrc();
    expect(serviceUninstall(user.host, {}).lines.join('\n')).toContain('sudo rm ');
    const { host, calls } = withOpenrc({ uid: 0, user: 'root', group: 'root' }, { 'rc-service gonogo status': { code: 0, stdout: ' * status: started\n' } });
    host.env.SUDO_USER = 'ana';
    serviceInstall(host, {});
    expect(serviceStatus(host, {})).toMatchObject({ code: 0, lines: expect.arrayContaining(['active: yes (started)']) });
    expect(serviceUninstall(host, {}).lines[0]).toMatch(/^stopped and removed /);
    expect(cmds(calls)).toContain('rc-update del gonogo default');
    expect(existsSync(join(host.initDir, 'gonogo'))).toBe(false);
  });
});

describe('gonogo service: an explicit --manager', () => {
  it('writes the file for a manager this machine does not run, but --now needs it', () => {
    const { host, calls } = fake({ platform: 'linux' });
    const r = serviceInstall(host, { manager: 'launchd' });
    expect(r.code).toBe(0);
    expect(existsSync(join(host.userHome, 'Library/LaunchAgents/com.ulm0.gonogo.plist'))).toBe(true);
    expect(serviceInstall(host, { manager: 'launchd', now: true }).code).toBe(1);
    expect(calls.some(([f]) => f === 'launchctl')).toBe(false);
  });
});
