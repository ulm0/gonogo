/**
 * Live reload, the parts around the hub (docs/live-reload-spec.md): starting the pty host process, the saved holds, `gonogo reload`
 * and the start of the next gonogo.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { startPtyHost, runDir } from './ptyhost.js';
import { HOLDS_FILE, HOST_LOG_FILE } from './ptyhostproto.js';

/** Starts `gonogo ptyhost --home <dir>` detached, with its output in `<home>/run/ptyhost.log`. `command` is [node, entry] or a test's own. */
export function spawnHostProcess(homeDir: string, command: string[]): void {
  mkdirSync(runDir(homeDir), { recursive: true, mode: 0o700 });
  const fd = openSync(join(runDir(homeDir), HOST_LOG_FILE), 'a', 0o600);
  try {
    const [file, ...args] = command;
    if (file === undefined) throw new Error('no command to start the pty host');
    const child = spawn(file, [...args, 'ptyhost', '--home', homeDir], { detached: true, stdio: ['ignore', fd, fd], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GONOGO_LOG_LEVEL: process.env.GONOGO_LOG_LEVEL ?? 'info' } });
    child.on('error', () => undefined);
    child.unref();
  } finally {
    closeSync(fd);
  }
}

/** `gonogo ptyhost`: runs until told to quit, idle for a minute with no agent and no hub, or SIGTERM (which stops the agents too). */
export async function runPtyHost(homeDir: string, log: Logger): Promise<void> {
  const host = await startPtyHost({ homeDir, log, onExit: () => process.exit(0) });
  const stop = (): void => {
    void host.close(true).finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', () => undefined);
}

/** The redline or hold text of each agent, saved after every change in `<home>/run/hub-state.json` (0600). */
export function createHoldStore(homeDir: string, log: Logger): { load(): Record<string, string>; save(holds: Record<string, string>): void } {
  const path = join(runDir(homeDir), HOLDS_FILE);
  return {
    load() {
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8')) as { holds?: Record<string, unknown> };
        const out: Record<string, string> = {};
        for (const [name, reason] of Object.entries(saved.holds ?? {})) if (typeof reason === 'string' && reason !== '') out[name] = reason;
        return out;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      }
    },
    save(holds) {
      mkdirSync(runDir(homeDir), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, holds }), { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}

/** True when pid is a gonogo supervisor of this very gonogo: its command line holds this entry file and no `__room` (a reused pid of another program is never signalled, S3). */
export function isSupervisorProcess(pid: number, entry: string | undefined = process.argv[1]): boolean {
  try {
    const args = process.platform === 'linux' ? readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a !== '') : execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    if (args.length < 2 || entry === undefined) return false;
    const same = (x: string, y: string): boolean => {
      try {
        return realpathSync(x) === realpathSync(y);
      } catch {
        return x === y;
      }
    };
    return args.slice(1).some((a) => same(a, entry)) && !args.includes('__room');
  } catch {
    return false;
  }
}

/** `gonogo reload`: asks the supervisor of this home to hand over (SIGUSR2). Returns a line to print, or throws. */
export function requestReload(homeDir: string, docker: boolean): string {
  if (docker) throw new Error('in Docker the supervisor is the container\'s only process, and re-executing it would end the container: update with the Update key (self-update) or "docker compose pull && docker compose up -d"');
  const lock = join(homeDir, 'run', 'supervisor.lock');
  if (!existsSync(lock)) throw new Error(`no gonogo is running with the home ${homeDir}`);
  const pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${lock} does not hold a process number`);
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`no gonogo is running with the home ${homeDir} (pid ${pid} is gone; the lock is stale)`);
  }
  if (!isSupervisorProcess(pid)) throw new Error(`${lock} names pid ${pid}, which is not a gonogo supervisor (a stale lock whose number another program took): nothing was signalled`);
  process.kill(pid, 'SIGUSR2');
  return `asked gonogo (pid ${pid}) to reload. Its rooms keep their agents when they run with --pty-host; the new supervisor takes them over.`;
}

/**
 * `gonogo token rotate`: makes a new Director token in `<home>/token` (0600, written to a temporary file and renamed). The old one stops working.
 * A running supervisor looks at the file on every request and takes the new value at once; nothing needs a restart. The token is not printed.
 */
export function rotateDirectorToken(homeDir: string): string {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const path = join(homeDir, 'token');
  const temp = `${path}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  return `a new Director token is in ${path} (mode 0600); the old one no longer works. A running gonogo uses the new one at once. Read it with: cat ${path}\nRoom tokens are separate and were not touched. Old links, bookmarks and browsers that stored the token need the new one.`;
}

/**
 * Starts the next gonogo with the same arguments, after this one has let go of the home and the port. Attached to the same
 * terminal, so Ctrl-C reaches it. GONOGO_RELOADED makes it wait for the lock and the port instead of failing at once.
 */
export function relaunch(argv: string[], entry: string | undefined): void {
  const command = entry !== undefined && existsSync(entry) ? [process.execPath, entry] : ['gonogo'];
  const [file, ...head] = command;
  const child = spawn(file as string, [...head, ...argv], { stdio: 'inherit', env: { ...process.env, GONOGO_RELOADED: '1' } });
  child.on('error', () => undefined);
  child.unref();
}
