import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/server/cli.js';
import { detectManager, flagsArgv, flagsText, renderLaunchd, renderOpenrc, renderSystemd, resolveSpec, serviceControl, serviceInstall, serviceStatus, serviceUninstall, systemdWord, xmlText, type Ran, type ServiceHost } from '../src/server/service.js';

type Call = [string, string[]];

interface Fake {
  host: ServiceHost;
  calls: Call[];
  root: string;
  /** Ports something listens on. */
  busy: Set<number>;
}

/** A machine in a temp folder: `answers` maps "file arg arg" to what that command prints; anything else exits 1. */
function fake(over: Partial<ServiceHost> = {}, answers: Record<string, Partial<Ran>> = {}): Fake {
  const root = mkdtempSync(join(tmpdir(), 'gonogo-service-'));
  const calls: Call[] = [];
  const busy = new Set<number>();
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
    systemdRunDir: join(root, 'run-systemd'),
    portInUse: (_host, port) => busy.has(port),
    ...over,
  };
  mkdirSync(host.userHome, { recursive: true });
  return { host, calls, root, busy };
}
const cmds = (calls: Call[]): string[] => calls.map(([f, a]) => `${f} ${a.join(' ')}`);
const SYSTEMD_OK = { 'systemctl --user show-environment': { code: 0 } };
/** systemd answers, the install commands succeed, lingering is already on. */
const SYSTEMD_UP = {
  ...SYSTEMD_OK,
  'systemctl --user daemon-reload': { code: 0 },
  'systemctl --user enable gonogo.service': { code: 0 },
  'systemctl --user restart gonogo.service': { code: 0 },
  'loginctl show-user ana --property=Linger --value': { code: 0, stdout: 'yes\n' },
};
const text = (r: { lines: string[] }): string => r.lines.join('\n');

describe('gonogo service: the arguments', () => {
  it('takes an action and the few flags of the unit', () => {
    expect(parseArgs(['service', 'install', '--no-start', '--port', '7000', '--host', '0.0.0.0', '--home', '/h', '--pty-host'])).toEqual({ kind: 'service', action: 'install', options: { noStart: true, port: 7000, host: '0.0.0.0', home: '/h', ptyHost: true } });
    expect(parseArgs(['service', 'status'])).toEqual({ kind: 'service', action: 'status', options: {} });
    expect(parseArgs(['service', 'uninstall', '--manager', 'openrc'])).toEqual({ kind: 'service', action: 'uninstall', options: { manager: 'openrc' } });
    for (const action of ['start', 'stop', 'restart']) expect(parseArgs(['service', action])).toEqual({ kind: 'service', action, options: {} });
  });

  it('refuses what it does not know, and says what replaced --now', () => {
    for (const argv of [['service'], ['service', 'enable'], ['service', 'install', '--port'], ['service', 'install', '--port', 'x'], ['service', 'install', '--manager', 'runit'], ['service', 'install', '--bogus'], ['service', 'status', '--no-start'], ['service', 'uninstall', '--port', '1'], ['service', 'start', '--pty-host']]) {
      expect(parseArgs(argv).kind, argv.join(' ')).toBe('error');
    }
    expect(parseArgs(['service', 'install', '--now'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/--no-start/) });
  });

  it('prints the flags back as they were given, quoted when needed', () => {
    expect(flagsText({ home: '/h/with space', port: 7000, ptyHost: true, noStart: true, user: 'ana' })).toBe("--home '/h/with space' --port 7000 --pty-host --no-start --user ana");
    expect(flagsText({})).toBe('');
  });
});

describe('gonogo service: the network flags (--allow-host, --trusted-proxy, --public-url, --client-ip-header)', () => {
  const NET = ['service', 'install', '--host', '0.0.0.0', '--allow-host', '192.168.86.173,shitmini,shitmini.local', '--allow-host', 'dock.example.com:hooks', '--trusted-proxy', '10.0.0.2, ::1', '--public-url', 'https://gonogo.example.com', '--client-ip-header', 'CF-Connecting-IP'];

  it('takes a comma list as typed and a repeated flag, validated as the server validates them', () => {
    expect(parseArgs(NET)).toEqual({ kind: 'service', action: 'install', options: { host: '0.0.0.0', allowedHosts: ['192.168.86.173', 'shitmini', 'shitmini.local', 'dock.example.com:hooks'], trustedProxies: ['10.0.0.2', '::1'], publicUrl: 'https://gonogo.example.com', clientIpHeader: 'cf-connecting-ip' } });
  });

  it('refuses a bad host, proxy, address or header, and the flags on any action but install; nothing is written', () => {
    const msg = (argv: string[]): string => {
      const parsed = parseArgs(argv);
      return parsed.kind === 'error' ? parsed.message : parsed.kind;
    };
    expect(msg(['service', 'install', '--allow-host', 'a b'])).toMatch(/--allow-host: "a b" is not a host name/);
    expect(msg(['service', 'install', '--allow-host', 'ok.example.com,bad/host'])).toMatch(/not a host name/);
    expect(msg(['service', 'install', '--trusted-proxy', 'proxy.local'])).toMatch(/--trusted-proxy "proxy.local" is not an IP address/);
    expect(msg(['service', 'install', '--public-url', 'gonogo.example.com'])).toMatch(/--public-url/);
    expect(msg(['service', 'install', '--public-url', 'https://x.example.com/path'])).toMatch(/address only/);
    expect(msg(['service', 'install', '--client-ip-header', 'x-real-ip'])).toMatch(/--client-ip-header is x-forwarded-for or cf-connecting-ip/);
    expect(msg(['service', 'install', '--allow-host'])).toMatch(/needs a value/);
    expect(msg(['service', 'status', '--allow-host', 'a.example.com'])).toMatch(/service status takes only/);
    expect(msg(['service', 'uninstall', '--public-url', 'https://a.example.com'])).toMatch(/service uninstall takes only/);
  });

  it('the server takes the same comma list on its own flag', () => {
    expect(parseArgs(['--allow-host', 'a.example.com, b.example.com', '--trusted-proxy', '10.0.0.2,10.0.0.3'])).toMatchObject({ kind: 'run', options: { allowedHosts: ['a.example.com', 'b.example.com'], trustedProxies: ['10.0.0.2', '10.0.0.3'] } });
  });

  it('are written as arguments of the program, one flag one value each, and printed in the sudo command', () => {
    const { host } = fake();
    const parsed = parseArgs(NET);
    if (parsed.kind !== 'service') throw new Error('not a service');
    const spec = resolveSpec(host, parsed.options);
    expect(spec.argv.slice(2)).toEqual(['--home', join(host.userHome, '.gonogo'), '--host', '0.0.0.0', '--allow-host', '192.168.86.173', '--allow-host', 'shitmini', '--allow-host', 'shitmini.local', '--allow-host', 'dock.example.com:hooks', '--trusted-proxy', '10.0.0.2', '--trusted-proxy', '::1', '--public-url', 'https://gonogo.example.com', '--client-ip-header', 'cf-connecting-ip']);
    expect(flagsText(parsed.options)).toBe('--host 0.0.0.0 --allow-host 192.168.86.173 --allow-host shitmini --allow-host shitmini.local --allow-host dock.example.com:hooks --trusted-proxy 10.0.0.2 --trusted-proxy ::1 --public-url https://gonogo.example.com --client-ip-header cf-connecting-ip');
  });

  it('the generated systemd unit, launchd plist and OpenRC script each carry them; a value that would end a line is refused', () => {
    const { host } = fake();
    const options = { allowedHosts: ['shitmini.local', '192.168.86.173'], trustedProxies: ['10.0.0.2'], publicUrl: 'https://g.example.com', clientIpHeader: 'x-forwarded-for' };
    const spec = resolveSpec(host, options);
    expect(renderSystemd(spec)).toContain('--allow-host shitmini.local --allow-host 192.168.86.173 --trusted-proxy 10.0.0.2 --public-url https://g.example.com --client-ip-header x-forwarded-for\n');
    const plist = renderLaunchd(spec, '/log');
    for (const word of ['--allow-host', 'shitmini.local', '192.168.86.173', '--trusted-proxy', '10.0.0.2', '--public-url', 'https://g.example.com', '--client-ip-header', 'x-forwarded-for']) expect(plist).toContain(`<string>${word}</string>`);
    expect(renderOpenrc(spec, 'ana', 'users')).toContain('--allow-host shitmini.local --allow-host 192.168.86.173 --trusted-proxy 10.0.0.2 --public-url https://g.example.com --client-ip-header x-forwarded-for');
    expect(() => resolveSpec(host, { allowedHosts: ['a.example.com\n--host\n0.0.0.0'] })).toThrow(/control character/);
  });

  it('a reinstall replaces them: the file is written again from the flags given now', () => {
    const { host } = fake({}, { ...SYSTEMD_UP, 'systemctl --user is-active gonogo.service': { code: 3 } });
    const unit = join(host.userHome, '.config/systemd/user/gonogo.service');
    serviceInstall(host, { allowedHosts: ['old.example.com'] });
    expect(readFileSync(unit, 'utf8')).toContain('--allow-host old.example.com');
    serviceInstall(host, { allowedHosts: ['new.example.com'] });
    const now = readFileSync(unit, 'utf8');
    expect(now).toContain('--allow-host new.example.com');
    expect(now).not.toContain('old.example.com');
  });
});

describe('gonogo service: the files', () => {
  const spec = { argv: ['/opt/node/bin/node', '/usr/local/bin/gonogo', '--home', '/home/ana/.gonogo', '--pty-host'], path: '/opt/node/bin:/usr/bin', home: '/home/ana/.gonogo', cwd: '/home/ana' };

  it('a systemd unit restarts on any exit, keeps the pty host alive, runs in the home, and pins node, the entry and PATH', () => {
    const unit = renderSystemd(spec);
    expect(unit).toContain('ExecStart=/opt/node/bin/node /usr/local/bin/gonogo --home /home/ana/.gonogo --pty-host\n');
    expect(unit).toContain('WorkingDirectory=/home/ana\n');
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

  it('a launchd plist keeps the process group, restarts, logs, runs in the home, and escapes XML', () => {
    const plist = renderLaunchd({ ...spec, argv: [...spec.argv, '--host', 'a&b<c>'] }, '/home/ana/Library/Logs/gonogo.log');
    expect(plist).toContain('<key>Label</key>\n  <string>com.ulm0.gonogo</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/home/ana</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;</string>');
    expect(plist).toContain('<string>/home/ana/Library/Logs/gonogo.log</string>');
    expect(xmlText(`"'`)).toBe('&quot;&apos;');
  });

  it('an OpenRC script runs as the user in their home under supervise-daemon, never as root', () => {
    const rc = renderOpenrc(spec, 'ana', 'users');
    expect(rc).toMatch(/^#!\/sbin\/openrc-run$/m);
    expect(rc).toContain("command='/opt/node/bin/node'");
    expect(rc).toContain("command_args='/usr/local/bin/gonogo --home /home/ana/.gonogo --pty-host'");
    expect(rc).toContain("command_user='ana:users'");
    expect(rc).toContain("directory='/home/ana'");
    expect(rc).toContain('supervisor="supervise-daemon"');
    expect(rc).toContain("export HOME='/home/ana'");
    expect(rc).toContain("export PATH=\"$PATH:\"'/opt/node/bin:/usr/bin'");
    expect(rc).toContain('export GONOGO_SERVICE=openrc');
  });
});

describe('gonogo service: what the unit runs', () => {
  it('defaults the home to ~/.gonogo as an absolute path, runs in the user home, and pins only the flags given', () => {
    const { host } = fake();
    const spec = resolveSpec(host, {});
    expect(spec.argv).toEqual(['/opt/node/bin/node', '/usr/local/bin/gonogo', '--home', join(host.userHome, '.gonogo')]);
    expect(spec.cwd).toBe(host.userHome);
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

  it('root has no user manager: systemd is the one that runs the machine', () => {
    const f = fake({ uid: 0, user: 'root' });
    expect(detectManager(f.host)).toBeNull();
    mkdirSync(f.host.systemdRunDir);
    expect(detectManager(f.host)).toBe('systemd');
  });

  it('says so, and writes nothing, when there is none', () => {
    const { host, calls } = fake();
    const r = serviceInstall(host, {});
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/no service manager found/);
    expect(calls.every(([f]) => f === 'systemctl')).toBe(true);
  });
});

describe('gonogo service install, uninstall, start, stop, restart, status: systemd', () => {
  const unitPath = (host: ServiceHost): string => join(host.userHome, '.config/systemd/user/gonogo.service');

  it('install writes the unit, reloads, enables and starts it, with no reboot', () => {
    const { host, calls } = fake({}, { ...SYSTEMD_UP, 'systemctl --user is-active gonogo.service': { code: 3 } });
    const r = serviceInstall(host, { port: 7777, ptyHost: true });
    expect(r.code).toBe(0);
    expect(readFileSync(unitPath(host), 'utf8')).toContain('--port 7777 --pty-host');
    expect(statSync(unitPath(host)).mode & 0o777).toBe(0o644);
    expect(cmds(calls)).toEqual(['systemctl --user show-environment', 'systemctl --user daemon-reload', 'systemctl --user is-active gonogo.service', 'systemctl --user enable gonogo.service', 'systemctl --user restart gonogo.service', 'loginctl show-user ana --property=Linger --value']);
    expect(text(r)).toContain('enabled and started.');
    expect(text(r)).toContain('lingering is on');
    expect(text(r)).not.toContain('tip:');
  });

  it('install --no-start only writes the file and says how to start it', () => {
    const { host, calls } = fake({}, SYSTEMD_UP);
    const r = serviceInstall(host, { noStart: true });
    expect(text(r)).toContain('systemctl --user daemon-reload && systemctl --user enable --now gonogo.service');
    expect(cmds(calls)).toEqual(['systemctl --user show-environment']);
    expect(existsSync(unitPath(host))).toBe(true);
  });

  it('a second install rewrites the unit and restarts the running service', () => {
    const { host } = fake({}, { ...SYSTEMD_UP, 'systemctl --user is-active gonogo.service': { code: 0, stdout: 'active\n' } });
    serviceInstall(host, {});
    const again = serviceInstall(host, { port: 7001 });
    expect(again.lines[0]).toMatch(/^replaced /);
    expect(text(again)).toContain('restarted.');
    expect(readFileSync(unitPath(host), 'utf8')).toContain('--port 7001');
  });

  it('refuses to start beside a gonogo that holds the port, but keeps the file for service start', () => {
    const { host, calls, busy } = fake({}, { ...SYSTEMD_UP, 'systemctl --user is-active gonogo.service': { code: 3 } });
    busy.add(7777);
    const r = serviceInstall(host, {});
    expect(r.code).toBe(1);
    expect(text(r)).toContain('already listening on port 7777');
    expect(text(r)).toContain('stop the running gonogo first (Ctrl+C), then run gonogo service start');
    expect(existsSync(unitPath(host))).toBe(true);
    expect(cmds(calls).some((c) => c.includes('restart') || c.includes('enable'))).toBe(false);
    // and service start refuses the same way
    expect(serviceControl(host, 'start', {}).code).toBe(1);
  });

  it('a running service holding its own port is not a foreground gonogo', () => {
    const { host, busy } = fake({}, { ...SYSTEMD_UP, 'systemctl --user is-active gonogo.service': { code: 0 } });
    busy.add(7777);
    expect(serviceInstall(host, {}).code).toBe(0);
  });

  it('a failing command is reported with its first error line', () => {
    const bad = fake({}, { ...SYSTEMD_UP, 'systemctl --user restart gonogo.service': { code: 5, stderr: 'Failed to connect to bus\nmore' } });
    const r = serviceInstall(bad.host, {});
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe('systemctl --user restart gonogo.service failed (exit 5): Failed to connect to bus');
  });

  it('where polkit refuses lingering it says: This needs root: run sudo gonogo service install with the flags', () => {
    const { host } = fake({}, { ...SYSTEMD_UP, 'loginctl show-user ana --property=Linger --value': { code: 0, stdout: 'no\n' }, 'loginctl enable-linger ana': { code: 1, stderr: 'Interactive authentication required.' } });
    const r = serviceInstall(host, { port: 7000, ptyHost: true });
    expect(r.code).toBe(0);
    expect(text(r)).toContain('This needs root: run `sudo gonogo service install --port 7000 --pty-host`');
    expect(text(r)).toContain('never as root');
    const ok = fake({}, { ...SYSTEMD_UP, 'loginctl show-user ana --property=Linger --value': { code: 0, stdout: 'no\n' }, 'loginctl enable-linger ana': { code: 0 } });
    expect(text(serviceInstall(ok.host, {}))).toContain('lingering turned on');
  });

  it('as root through sudo it turns lingering on for SUDO_USER and runs the install as that user with their HOME and PATH', () => {
    const { host, calls } = fake({ uid: 0, user: 'root', group: 'root' }, { 'id -u ana': { code: 0, stdout: '1000\n' }, 'loginctl enable-linger ana': { code: 0 }, 'runuser -u ana -- sh -lc printf %s "$PATH"': { code: 0, stdout: '/home/ana/.local/bin:/usr/bin' }, 'runuser -u ana -- env HOME=/home/ana USER=ana LOGNAME=ana PATH=/home/ana/.local/bin:/usr/bin XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /opt/node/bin/node /usr/local/bin/gonogo service install --port 7000': { code: 0, stdout: 'enabled and started.\n' } });
    mkdirSync(host.systemdRunDir);
    host.env.SUDO_USER = 'ana';
    const r = serviceInstall(host, { port: 7000 });
    expect(r.code).toBe(0);
    expect(text(r)).toContain('lingering turned on for ana');
    expect(text(r)).toContain('enabled and started.');
    expect(cmds(calls).some((c) => c.startsWith('runuser -u ana -- env HOME=/home/ana'))).toBe(true);
    expect(existsSync(join(host.userHome, '.config'))).toBe(false);
  });

  it('as root with nobody to run as it refuses', () => {
    const { host } = fake({ uid: 0, user: 'root' });
    mkdirSync(host.systemdRunDir);
    expect(() => serviceInstall(host, {})).toThrow(/--user/);
  });

  it('suggests --pty-host when it was not given', () => {
    expect(text(serviceInstall(fake({}, SYSTEMD_UP).host, {}))).toContain('tip: add --pty-host');
  });

  it('start, stop and restart are thin wrappers; not installed says so', () => {
    const f = fake({}, { ...SYSTEMD_UP, 'systemctl --user is-active gonogo.service': { code: 3 }, 'systemctl --user start gonogo.service': { code: 0 }, 'systemctl --user stop gonogo.service': { code: 0 }, 'systemctl --user restart gonogo.service': { code: 0 } });
    expect(serviceControl(f.host, 'start', {}).code).toBe(4);
    serviceInstall(f.host, { noStart: true });
    f.calls.length = 0;
    expect(serviceControl(f.host, 'start', {}).lines).toEqual(['started (systemd).']);
    expect(serviceControl(f.host, 'stop', {}).lines).toEqual(['stopped (systemd).']);
    expect(serviceControl(f.host, 'restart', {}).lines).toEqual(['restarted (systemd).']);
    expect(cmds(f.calls).filter((c) => /start|stop|restart/.test(c) && c.includes('gonogo.service')).slice(-3)).toEqual(['systemctl --user start gonogo.service', 'systemctl --user stop gonogo.service', 'systemctl --user restart gonogo.service']);
  });

  it('uninstall stops it, removes the file and reloads; a second one says there is nothing', () => {
    const { host, calls } = fake({}, SYSTEMD_UP);
    serviceInstall(host, {});
    calls.length = 0;
    expect(serviceUninstall(host, {}).lines[0]).toBe(`stopped and removed ${unitPath(host)}`);
    expect(existsSync(unitPath(host))).toBe(false);
    expect(cmds(calls)).toEqual(['systemctl --user show-environment', 'systemctl --user disable --now gonogo.service', 'systemctl --user daemon-reload']);
    expect(serviceUninstall(host, {}).lines[0]).toMatch(/nothing to remove/);
  });

  it('status: 4 not installed, 3 installed but not active, 0 active', () => {
    const { host } = fake({}, { ...SYSTEMD_UP, 'systemctl --user is-active gonogo.service': { code: 3, stdout: 'inactive\n' }, 'systemctl --user is-enabled gonogo.service': { code: 0, stdout: 'enabled\n' } });
    expect(serviceStatus(host, {}).code).toBe(4);
    serviceInstall(host, { noStart: true });
    const idle = serviceStatus(host, {});
    expect(idle.code).toBe(3);
    expect(idle.lines).toContain('enabled: enabled');
    expect(idle.lines.at(-1)).toBe('active: no (inactive)');
    const up = fake({}, { ...SYSTEMD_UP, 'systemctl --user is-active gonogo.service': { code: 0, stdout: 'active\n' } });
    serviceInstall(up.host, {});
    expect(serviceStatus(up.host, {}).code).toBe(0);
  });
});

describe('gonogo service: launchd', () => {
  const launchd = (answers: Record<string, Partial<Ran>> = {}): Fake => {
    const f = fake({ platform: 'darwin' }, answers);
    f.host.run = (file, args) => {
      f.calls.push([file, args]);
      const a = answers[`${file} ${args.join(' ')}`];
      return { code: a === undefined && file === 'launchctl' && args[0] === 'print' ? 1 : 0, stdout: '', stderr: '', ...a };
    };
    return f;
  };

  it('install writes the plist and the log folder, then boots out, bootstraps and kickstarts it', () => {
    const f = launchd();
    const path = join(f.host.userHome, 'Library/LaunchAgents/com.ulm0.gonogo.plist');
    const r = serviceInstall(f.host, {});
    expect(readFileSync(path, 'utf8')).toContain(join(f.host.userHome, 'Library/Logs/gonogo.log'));
    expect(cmds(f.calls).filter((c) => !c.includes(' print '))).toEqual(['launchctl bootout gui/1000/com.ulm0.gonogo', `launchctl bootstrap gui/1000 ${path}`, 'launchctl kickstart gui/1000/com.ulm0.gonogo']);
    expect(text(r)).toContain('loaded and started');
  });

  it('--no-start only writes it; launchd never needs root', () => {
    const f = launchd();
    expect(text(serviceInstall(f.host, { noStart: true }))).toMatch(/launchctl bootstrap gui\/1000 /);
    expect(f.calls.some(([, a]) => a[0] === 'bootstrap')).toBe(false);
    const root = launchd();
    root.host.uid = 0;
    expect(text(serviceInstall(root.host, {}))).toMatch(/needs no root/);
  });

  it('status reads the state from launchctl print; uninstall boots out and removes the file; stop boots out', () => {
    const f = launchd({ 'launchctl print gui/1000/com.ulm0.gonogo': { code: 0, stdout: '\tstate = running\n' } });
    serviceInstall(f.host, {});
    expect(serviceStatus(f.host, {})).toMatchObject({ code: 0 });
    expect(serviceControl(f.host, 'stop', {}).lines).toEqual(['stopped (launchd).']);
    expect(serviceUninstall(f.host, {}).lines[0]).toMatch(/^stopped and removed /);
    expect(serviceStatus(f.host, {}).code).toBe(4);
  });
});

describe('gonogo service: OpenRC', () => {
  const withOpenrc = (over: Partial<ServiceHost> = {}, answers: Record<string, Partial<Ran>> = {}): Fake => {
    const f = fake(over, answers);
    writeFileSync(f.host.openrcRun, '#!/bin/sh\n');
    return f;
  };

  it('as an ordinary user the first line is the sudo line with the flags; the script is staged and nothing else runs', () => {
    const { host, calls } = withOpenrc();
    const r = serviceInstall(host, { ptyHost: true, port: 7788 });
    const staged = join(host.userHome, '.gonogo/service/gonogo.initd');
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe('This needs root: run `sudo gonogo service install --port 7788 --pty-host`');
    expect(readFileSync(staged, 'utf8')).toContain("command_user='ana:ana'");
    expect(statSync(join(host.userHome, '.gonogo/service')).mode & 0o777).toBe(0o700);
    expect(text(r)).toContain(`sudo install -m 0755 ${staged} ${host.initDir}/gonogo`);
    expect(text(r)).toContain('sudo rc-service gonogo restart');
    expect(calls.some(([f]) => f === 'sudo' || f === 'rc-update' || f === 'rc-service')).toBe(false);
    expect(existsSync(join(host.initDir, 'gonogo'))).toBe(false);
  });

  it('as root through sudo it writes /etc/init.d for SUDO_USER (never root), adds and starts it', () => {
    const { host, calls } = withOpenrc({ uid: 0, user: 'root', group: 'root' }, { 'rc-update add gonogo default': { code: 0 }, 'rc-service gonogo restart': { code: 0 } });
    host.env.SUDO_USER = 'ana';
    const r = serviceInstall(host, { home: '/home/ana/.gonogo' });
    const file = readFileSync(join(host.initDir, 'gonogo'), 'utf8');
    expect(file).toContain("command_user='ana:ana'");
    expect(file).not.toContain("command_user='root");
    expect(statSync(join(host.initDir, 'gonogo')).mode & 0o777).toBe(0o755);
    expect(text(r)).toContain('added to the default runlevel and started.');
    expect(cmds(calls)).toContain('rc-service gonogo restart');
  });

  it('the group is the user\'s primary group from id -gn, not a group named like the user', () => {
    const { host } = withOpenrc({ uid: 0, user: 'root', group: 'root' }, { 'id -gn ana': { code: 0, stdout: 'users\n' } });
    host.env.SUDO_USER = 'ana';
    serviceInstall(host, { noStart: true });
    expect(readFileSync(join(host.initDir, 'gonogo'), 'utf8')).toContain("command_user='ana:users'");
  });

  it('--no-start as root only writes the script', () => {
    const { host, calls } = withOpenrc({ uid: 0, user: 'root', group: 'root' });
    host.env.SUDO_USER = 'ana';
    const r = serviceInstall(host, { noStart: true });
    expect(text(r)).toContain('not started (--no-start)');
    expect(calls.some(([f]) => f === 'rc-update')).toBe(false);
  });

  it('as root with nobody to run as it refuses; a path with a space or a quote is refused', () => {
    const root = withOpenrc({ uid: 0, user: 'root', group: 'root' });
    expect(() => serviceInstall(root.host, {})).toThrow(/--user/);
    expect(() => serviceInstall(withOpenrc({ uid: 0, user: 'root', group: 'root' }).host, { user: 'root' })).toThrow(/--user/);
    expect(() => serviceInstall(withOpenrc({ uid: 0, user: 'root', group: 'root' }).host, { user: 'a b' })).toThrow(/not a user name/);
  });

  it('uninstall and start without root say This needs root first; as root they run', () => {
    const user = withOpenrc();
    expect(serviceUninstall(user.host, {}).lines[0]).toBe('This needs root: run `sudo gonogo service uninstall`');
    const { host, calls } = withOpenrc({ uid: 0, user: 'root', group: 'root' }, { 'rc-service gonogo status': { code: 0, stdout: ' * status: started\n' }, 'rc-service gonogo start': { code: 0 }, 'rc-update add gonogo default': { code: 0 }, 'rc-service gonogo restart': { code: 0 } });
    host.env.SUDO_USER = 'ana';
    serviceInstall(host, {});
    expect(serviceStatus(host, {})).toMatchObject({ code: 0, lines: expect.arrayContaining(['active: yes (started)']) });
    expect(serviceControl(host, 'start', {}).code).toBe(0);
    expect(serviceUninstall(host, {}).lines[0]).toMatch(/^stopped and removed /);
    expect(cmds(calls)).toContain('rc-update del gonogo default');
    expect(existsSync(join(host.initDir, 'gonogo'))).toBe(false);
    const staged = withOpenrc();
    mkdirSync(staged.host.initDir, { recursive: true });
    writeFileSync(join(staged.host.initDir, 'gonogo'), '');
    expect(serviceControl(staged.host, 'restart', { port: undefined }).lines[0]).toBe('This needs root: run `sudo gonogo service restart`');
  });
});

describe('gonogo service: a space in a path', () => {
  const sp = { argv: ['/opt/my node/bin/node', '/usr/local/bin/gonogo', '--home', "/srv/my agents/it's", '--pty-host'], path: '/opt/my node/bin:/usr/bin', home: "/srv/my agents/it's", cwd: '/home/my user' };

  it('systemd quotes each word of ExecStart and the working folder', () => {
    const unit = renderSystemd(sp);
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" /usr/local/bin/gonogo --home "/srv/my agents/it\'s" --pty-host\n');
    expect(unit).toContain('WorkingDirectory="/home/my user"\n');
  });

  it('launchd holds each argument in its own <string>, spaces and all', () => {
    const plist = renderLaunchd(sp, '/home/my user/Library/Logs/gonogo.log');
    expect(plist).toContain("<string>/opt/my node/bin/node</string>");
    expect(plist).toContain("<string>/srv/my agents/it&apos;s</string>");
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/home/my user</string>');
  });

  it('OpenRC: what openrc-run does with the values (an eval of them, unquoted) gives back the same words', () => {
    const rc = renderOpenrc(sp, 'ana', 'ana');
    const assignments = rc.split('\n').filter((l) => /^(command|command_args|directory)=/.test(l)).join('\n');
    // the same expansion as supervise-daemon.sh: eval printf '%s\n' $command -- $command_args $directory
    const out = spawnSync('sh', ['-c', assignments + "\neval printf '%s\\\\n' $command -- $command_args -- $directory"], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout.split('\n').slice(0, -1)).toEqual(['/opt/my node/bin/node', '--', '/usr/local/bin/gonogo', '--home', "/srv/my agents/it's", '--pty-host', '--', '/home/my user']);
  });

  it('the child of a root install gets the flags as an array: a space in --home arrives whole', () => {
    expect(flagsArgv({ home: '/srv/my agents', port: 7000, user: 'ana' })).toEqual(['--home', '/srv/my agents', '--port', '7000', '--user', 'ana']);
    const { host, calls } = fake({ uid: 0, user: 'root', group: 'root' }, { 'id -u ana': { code: 0, stdout: '1000\n' }, 'loginctl enable-linger ana': { code: 0 } });
    mkdirSync(host.systemdRunDir);
    host.env.SUDO_USER = 'ana';
    serviceInstall(host, { home: '/srv/my agents', ptyHost: true });
    const child = calls.find(([f, a]) => f === 'runuser' && a.includes('service'));
    const args = child?.[1] ?? [];
    expect(args.slice(args.indexOf('service'))).toEqual(['service', 'install', '--home', '/srv/my agents', '--pty-host']);
  });

  it('install writes a unit that holds a spaced --home as one word', () => {
    const { host } = fake({}, SYSTEMD_UP);
    serviceInstall(host, { home: '/srv/my agents', noStart: true });
    expect(readFileSync(join(host.userHome, '.config/systemd/user/gonogo.service'), 'utf8')).toContain('--home "/srv/my agents"');
  });
});

describe('gonogo service: an explicit --manager', () => {
  it('writes the file for a manager this machine does not run, but starting needs it', () => {
    const { host, calls } = fake({ platform: 'linux' });
    const r = serviceInstall(host, { manager: 'launchd', noStart: true });
    expect(r.code).toBe(0);
    expect(existsSync(join(host.userHome, 'Library/LaunchAgents/com.ulm0.gonogo.plist'))).toBe(true);
    expect(serviceInstall(host, { manager: 'launchd' }).code).toBe(1);
    expect(calls.some(([f]) => f === 'launchctl')).toBe(false);
  });
});
