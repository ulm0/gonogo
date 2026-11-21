/**
 * git for the Knowledge store and its engine: the Recorder's safe arguments (a repository's own config cannot name a program to run:
 * no file system monitor, no hooks), `--literal-pathspecs`, a clean environment with no GIT_* variable of gonogo's own, a time limit
 * (SIGTERM, so git removes its own lock) and an output cap. A repository's content is data: this reads it, never writes it.
 */
import { execFile } from 'node:child_process';
import { GIT_BIN } from './constants.js';
import { BASE_ARGS, KEEP_ENV } from './recorder.js';

export interface GitRan {
  /** The exit code; null when git did not run or was stopped. */
  code: number | null;
  out: string;
  why?: 'timeout' | 'missing' | 'failed' | 'flood';
}
export type SafeGit = (cwd: string, args: string[], cap?: number) => Promise<GitRan>;

export interface SafeGitOptions {
  env?: Record<string, string | undefined>;
  gitBin?: string;
  /** Per call; default 5 s. */
  ms?: number;
}

export function createSafeGit(options: SafeGitOptions = {}): SafeGit {
  const gitBin = options.gitBin ?? GIT_BIN;
  const ms = options.ms ?? 5000;
  const gitEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const key of KEEP_ENV) {
    const value = (options.env ?? process.env)[key];
    if (value !== undefined) gitEnv[key] = value;
  }
  return (cwd, args, cap = 64 * 1024) =>
    new Promise((resolve) => {
      execFile(gitBin, [...BASE_ARGS, ...args], { cwd, env: gitEnv, timeout: ms, killSignal: 'SIGTERM', maxBuffer: cap, encoding: 'utf8' }, (error, stdout) => {
        if (error === null) return resolve({ code: 0, out: stdout });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: null, out: String(stdout), why: 'flood' });
        if (e.killed === true || e.signal != null) return resolve({ code: null, out: '', why: 'timeout' });
        if (e.code === 'ENOENT') return resolve({ code: null, out: '', why: 'missing' });
        resolve(typeof e.code === 'number' ? { code: e.code, out: String(stdout) } : { code: null, out: '', why: 'failed' });
      });
    });
}
