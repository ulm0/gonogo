/**
 * Live reload, the parts around the hub (docs/live-reload-spec.md): starting the pty host process, the saved holds, `gonogo reload`
 * and the start of the next gonogo.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { LOCK_FILE } from './constants.js';
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

/** `gonogo reload`: asks the running gonogo of this home to hand over (SIGUSR2). Returns a line to print, or throws. */
export function requestReload(homeDir: string): string {
  const lock = join(homeDir, LOCK_FILE);
  if (!existsSync(lock)) throw new Error(`no gonogo is running with the home ${homeDir}`);
  const pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${lock} does not hold a process number`);
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`no gonogo is running with the home ${homeDir} (pid ${pid} is gone; the lock is stale)`);
  }
  process.kill(pid, 'SIGUSR2');
  return `asked gonogo (pid ${pid}) to reload. Its agents keep running; the new process takes them over.`;
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
