/**
 * Recorder (docs/recorder-spec.md): git for one agent's folder, or its Clean Room worktree, for the Director's browser.
 * Status, a diff (read-only), the last 50 commits, and a commit of all changes or of what is staged, with a message the
 * Director wrote and the author from his own git config. No push, pull, checkout, reset or any other command. Git runs
 * through execFile with an argument list, hooks off, no prompt, a time limit and an output cap.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { RECORDER_LOG_MAX, RECORDER_MESSAGE_MAX_CHARS, RECORDER_SCOPES } from '../shared/protocol.js';
import type { RecorderAuthor, RecorderCommit, RecorderDiff, RecorderFile, RecorderStatus } from '../shared/protocol.js';
import { GIT_BIN } from './constants.js';
import { HubError } from './hub.js';
import { inside, pathParts } from './hangar.js';
import type { Root, Roots } from './hangar.js';

type Env = Record<string, string | undefined>;

export const RECORDER_READ_MS = 15_000;
export const RECORDER_WRITE_MS = 30_000;
/** Output of a read: status and log are cut at 1 MiB, a diff at 256 KiB. */
export const RECORDER_LIST_CAP = 1024 * 1024;
export const RECORDER_DIFF_CAP = 256 * 1024;
export const RECORDER_FILES_MAX = 1000;

export interface Recorder {
  status(name: string): Promise<RecorderStatus>;
  diff(name: string, path: unknown, staged: boolean): Promise<RecorderDiff>;
  /** Post-Flight Review: everything that differs from the last commit, staged or not (`git diff HEAD`), read-only. A folder with no commit yet gives what is staged. A conflict (HubError) when it is not a repository. */
  reviewDiff(name: string): Promise<RecorderDiff>;
  log(name: string): Promise<RecorderCommit[]>;
  commit(name: string, input: unknown): Promise<{ commit: RecorderCommit }>;
}

/** Hooks off, and the programs a repository's own config could name for a read (the file system monitor, an external diff) off. */
export const BASE_ARGS = ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];
/** What git may see of the environment: no GIT_DIR or GIT_WORK_TREE or GIT_EXTERNAL_DIFF from gonogo's own, no credential. */
export const KEEP_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'TMPDIR'];

class GitFailure extends Error {
  constructor(readonly status: number | string | null, message: string) {
    super(message);
  }
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);

export function createRecorder(roots: Roots, env: Env): Recorder {
  const gitEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const key of KEEP_ENV) {
    const value = env[key];
    if (value !== undefined) gitEnv[key] = value;
  }

  /** Runs git in the root. A call over its time is stopped with SIGTERM, not SIGKILL: git then removes its own index.lock, which a kill would leave to block every later add and commit. Output over `cap` is cut and `truncated` says so; a failure is a GitFailure with the first line git printed on stderr. */
  function git(at: Root, args: string[], cap: number, timeout: number): Promise<{ out: string; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      execFile(GIT_BIN, [...BASE_ARGS, ...args], { cwd: at.root, env: gitEnv, timeout, killSignal: 'SIGTERM', maxBuffer: cap + 1, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error === null) return resolve({ out: stdout.slice(0, cap), truncated: stdout.length > cap });
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ out: String(stdout).slice(0, cap), truncated: true });
        if (code === 'ENOENT') return reject(new HubError('unavailable', 'git was not found on PATH'));
        if ((error as { killed?: boolean }).killed) return reject(new HubError('unavailable', 'git did not answer in time'));
        const line = stderr.split('\n').find((l) => l.trim() !== '')?.trim() ?? `git exited with ${String(code)}`;
        reject(new GitFailure(typeof code === 'number' || typeof code === 'string' ? code : null, line.slice(0, 300)));
      });
    });
  }

  /** The repository at the root, or why not. It must be the top of a repository, and gonogo's own folder must not be inside it. */
  async function repoProblem(at: Root): Promise<string | null> {
    let top: string;
    try {
      top = (await git(at, ['rev-parse', '--show-toplevel'], 4096, RECORDER_READ_MS)).out.trim();
    } catch (e) {
      if (e instanceof GitFailure) return /not a git repository/i.test(e.message) ? 'this folder is not in a git repository' : `git said: ${e.message}`;
      throw e;
    }
    if ((await realpath(top).catch(() => top)) !== at.root) return `this folder is inside the repository at ${top}: the Recorder works at the top of a repository`;
    if (inside(at.root, at.home)) return 'gonogo\'s own folder is inside this repository, and the Recorder will not commit it';
    return null;
  }

  async function author(at: Root): Promise<RecorderAuthor | null> {
    const get = (key: string): Promise<string> =>
      git(at, ['config', '--get', key], 1024, RECORDER_READ_MS).then((r) => r.out.trim(), (e: unknown) => {
        if (e instanceof GitFailure) return ''; // exit 1: the key is not set
        throw e;
      });
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    return name === '' || email === '' ? null : { name, email };
  }

  async function ready(name: string): Promise<Root> {
    const at = await roots(name);
    const problem = await repoProblem(at);
    if (problem !== null) throw new HubError('conflict', problem);
    return at;
  }

  async function lastCommits(at: Root, count: number): Promise<RecorderCommit[]> {
    let out: string;
    try {
      out = (await git(at, ['log', '-n', String(count), '--no-color', '--no-decorate', '-z', '--format=%H%x1f%an%x1f%at%x1f%s'], RECORDER_LIST_CAP, RECORDER_READ_MS)).out;
    } catch (e) {
      if (e instanceof GitFailure && /does not have any commits yet/.test(e.message)) return [];
      throw e;
    }
    return out.split('\0').filter((r) => r !== '').map((record) => {
      const [hash = '', who = '', at2 = '0', ...subject] = record.split('\x1f');
      return { hash, author: who.slice(0, 200), at: Number(at2) * 1000, subject: subject.join('\x1f').slice(0, 300) };
    });
  }

  return {
    async status(name) {
      const at = await roots(name);
      const problem = await repoProblem(at);
      if (problem !== null) return { repo: false, reason: problem };
      const { out } = await git(at, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal'], RECORDER_LIST_CAP, RECORDER_READ_MS);
      const records = out.split('\0');
      const files: RecorderFile[] = [];
      let branch = '';
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i] ?? '';
        if (record.startsWith('## ')) branch = record.slice(3, 203);
        else if (record.length > 3) {
          const file: RecorderFile = { path: record.slice(3), index: record[0] ?? ' ', tree: record[1] ?? ' ' };
          if (file.index === 'R' || file.index === 'C') file.from = records[(i += 1)];
          files.push(file);
        }
      }
      return { repo: true, branch, files: files.slice(0, RECORDER_FILES_MAX), more: Math.max(0, files.length - RECORDER_FILES_MAX), author: await author(at) };
    },

    async diff(name, raw, staged) {
      const parts = pathParts(raw ?? '');
      const at = await ready(name);
      const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(staged ? ['--cached'] : []), '--', ...(parts.length === 0 ? [] : [parts.join('/')])];
      const { out, truncated } = await git(at, args, RECORDER_DIFF_CAP, RECORDER_READ_MS);
      return { diff: out, truncated };
    },

    async reviewDiff(name) {
      const at = await ready(name);
      const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
      try {
        const { out, truncated } = await git(at, [...base, 'HEAD', '--'], RECORDER_DIFF_CAP, RECORDER_READ_MS);
        return { diff: out, truncated };
      } catch (e) {
        // no commit yet: HEAD names nothing, and what is staged is all there is to review
        if (e instanceof GitFailure && /ambiguous argument 'HEAD'|bad revision|unknown revision/i.test(e.message)) {
          const { out, truncated } = await git(at, [...base, '--cached', '--'], RECORDER_DIFF_CAP, RECORDER_READ_MS);
          return { diff: out, truncated };
        }
        throw e;
      }
    },

    async log(name) {
      return lastCommits(await ready(name), RECORDER_LOG_MAX);
    },

    async commit(name, input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw bad('the body must be an object');
      const { message, scope } = input as Record<string, unknown>;
      if (typeof message !== 'string' || message.trim() === '') throw bad('write a message for the commit', 'message');
      if (message.length > RECORDER_MESSAGE_MAX_CHARS) throw bad(`the message is longer than ${RECORDER_MESSAGE_MAX_CHARS} characters`, 'message');
      if (message.includes('\0')) throw bad('the message has a NUL character', 'message');
      if (scope !== 'all' && scope !== 'staged') throw bad(`scope must be one of ${RECORDER_SCOPES.join(', ')}`, 'scope');
      const at = await ready(name);
      if ((await author(at)) === null) {
        throw new HubError('conflict', 'git has no author: set user.name and user.email (git config --global user.name "Your Name"), then commit again', 'author');
      }
      try {
        if (scope === 'all') await git(at, ['add', '-A'], 4096, RECORDER_WRITE_MS);
        const staged = await git(at, ['diff', '--cached', '--quiet', '--no-ext-diff'], 4096, RECORDER_READ_MS).then(() => false, (e: unknown) => {
          if (e instanceof GitFailure && e.status === 1) return true; // exit 1: the index differs from HEAD
          throw e;
        });
        if (!staged) throw new HubError('conflict', scope === 'all' ? 'nothing to commit: the folder has no changes' : 'nothing is staged', 'scope');
        await git(at, ['-c', 'user.useConfigOnly=true', 'commit', '-m', message], 4096, RECORDER_WRITE_MS);
      } catch (e) {
        if (e instanceof GitFailure) throw new HubError('conflict', `git refused: ${e.message}`);
        throw e;
      }
      const [commit] = await lastCommits(at, 1);
      if (commit === undefined) throw new HubError('internal', 'the commit was made but git does not list it');
      return { commit };
    },
  };
}
