/**
 * Worktrees (docs/worktrees-spec.md): one git worktree and branch for an agent, shared by Clean Room (which puts a container on it)
 * and by a plain worktree (the agent starts in it on the host). This file reads the setting, runs git, makes the worktree once
 * and finds it again, and works out where the agent starts below it. gonogo never uses --force, -D or prune --expire.
 */
import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { cleanRoomBranch, WORKTREE_DIR } from '../shared/protocol.js';
import type { AgentRecord, Worktree, WorktreeStatus } from '../shared/protocol.js';
import { CLEAN_ROOM_COMMAND_MS, DIR_MODE, GIT_BIN } from './constants.js';

export type { WorktreeStatus };
export type Env = Record<string, string | undefined>;
export type WorktreeCheck = { ok: true; worktree: Worktree } | { ok: false; error: string };

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The one reader of a worktree setting: the hub uses it for hire and edit, home.ts for the roster file. `{}` is the only value for now. */
export function parseWorktree(value: unknown): WorktreeCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'worktree must be an object' };
  const unknown = Object.keys(value).find((key) => (value as Record<string, unknown>)[key] !== undefined);
  if (unknown !== undefined) return { ok: false, error: `worktree has no field "${unknown}"` };
  return { ok: true, worktree: {} };
}

/** The branch of an agent's worktree: the same for a plain worktree and a Clean Room, so an agent switched from one to the other keeps its work. */
export const worktreeBranch = cleanRoomBranch;
/** Where a plain worktree is: <home>/worktrees/<name>. */
export const worktreePath = (home: string, name: string): string => join(home, WORKTREE_DIR, name);

/** Runs a program without a shell and answers its output. A failure is an Error whose text is the first line the program printed on stderr. */
export function run(file: string, args: string[], env: Env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: env as NodeJS.ProcessEnv, timeout: CLEAN_ROOM_COMMAND_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve(stdout);
      const code = (error as NodeJS.ErrnoException).code;
      const line = stderr.split('\n').find((l) => l.trim() !== '')?.trim() ?? error.message.split('\n')[0] ?? '';
      reject(new Error(code === 'ENOENT' ? `${file} was not found on PATH` : line.slice(0, 300)));
    });
  });
}

/** The top folder of the git repository that holds `dir`; `why` starts the error text ("Clean Room needs", "a worktree needs"). */
export async function topOf(dir: string, env: Env, why: string): Promise<string> {
  try {
    return (await run(GIT_BIN, ['-C', dir, 'rev-parse', '--show-toplevel'], env)).trim();
  } catch (error) {
    throw new Error(`${why} the directory to be inside a git repository: ${messageOf(error)}`);
  }
}

/** What the hub asks at hire and edit for a plain worktree: null when `dir` is in a git repository, else why not. */
export async function checkWorktree(dir: string, env: Env): Promise<string | null> {
  try {
    await topOf(dir, env, 'a worktree needs');
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/** Makes the worktree on its branch the first time and finds it again after that. A folder in its place that git does not know is an error, never reused. */
export async function ensureWorktree(repo: string, path: string, branch: string, env: Env): Promise<void> {
  const git = (...args: string[]): Promise<string> => run(GIT_BIN, ['-C', repo, ...args], env);
  const real = await realpath(path).catch(() => null);
  if (real !== null) {
    const listed = (await git('worktree', 'list', '--porcelain')).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    if (!(await Promise.all(listed.map((p) => realpath(p).catch(() => p)))).includes(real)) {
      throw new Error(`${path} exists but is not a worktree of ${repo}; move it away or give the agent a folder of the repository it was made for`);
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  try {
    await git('worktree', 'prune'); // a worktree whose folder was deleted still holds its branch
    const known = await git('show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);
    await git('worktree', 'add', ...(known ? [path, branch] : ['-b', branch, path]));
  } catch (error) {
    throw new Error(`could not make the worktree ${path} on ${branch}: ${messageOf(error)}`);
  }
}

/** Where an agent starts: the same folder below the worktree as `dir` has below the repository's top. Throws when that folder is not committed. */
export async function cwdInWorktree(top: string, worktree: string, dir: string): Promise<string> {
  const inside = relative(top, await realpath(dir));
  const cwd = join(worktree, inside);
  if (!(await stat(cwd).then((info) => info.isDirectory(), () => false))) {
    throw new Error(`${inside} is not in the worktree ${worktree}: the worktree is a copy of the last commit, and that folder is not committed`);
  }
  return cwd;
}

export interface WorktreePlace {
  worktree: string;
  branch: string;
  cwd: string;
}

/** A plain worktree for a start: made or found, and the folder to start in. */
export async function prepareWorktree(agent: Pick<AgentRecord, 'name' | 'dir'>, homeDir: string, env: Env): Promise<WorktreePlace> {
  const top = await realpath(await topOf(agent.dir, env, 'a worktree needs'));
  const worktree = worktreePath(homeDir, agent.name);
  const branch = worktreeBranch(agent.name);
  await ensureWorktree(top, worktree, branch, env);
  return { worktree, branch, cwd: await cwdInWorktree(top, worktree, agent.dir) };
}

/** The folder of the repository that a worktree belongs to (the one that holds its `.git`), or null when there is none. */
async function mainRepoOf(path: string, env: Env): Promise<string | null> {
  try {
    const common = (await run(GIT_BIN, ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], env)).trim();
    return dirname(common);
  } catch {
    return null;
  }
}

/** What the Director wants to know before he deletes a worktree. Never throws for a missing folder. */
export async function worktreeStatus(path: string, branch: string, env: Env): Promise<WorktreeStatus> {
  const empty: WorktreeStatus = { path, branch, exists: false, dirty: false, ahead: 0, merged: false };
  if (!(await stat(path).then((info) => info.isDirectory(), () => false))) return empty;
  const repo = await mainRepoOf(path, env);
  if (repo === null) return { ...empty, exists: true };
  const git = (...args: string[]): Promise<string> => run(GIT_BIN, ['-C', repo, ...args], env);
  const dirty = (await run(GIT_BIN, ['-C', path, 'status', '--porcelain'], env).catch(() => '')).trim() !== '';
  const ahead = Number((await git('rev-list', '--count', `HEAD..${branch}`).catch(() => '0')).trim()) || 0;
  const merged = (await git('branch', '--merged', 'HEAD', '--list', branch).catch(() => '')).trim() !== '';
  return { path, branch, exists: true, dirty, ahead, merged };
}

export interface WorktreeRemoval {
  removed: boolean;
  branchDeleted: boolean;
  /** Why something stayed: git's own refusal. */
  reason?: string;
}

/** `git worktree remove` without --force, then `git branch -d`: git refuses a dirty folder and an unmerged branch, and so does gonogo. */
export async function removeWorktree(path: string, branch: string, env: Env): Promise<WorktreeRemoval> {
  const repo = await mainRepoOf(path, env);
  if (repo === null) return { removed: false, branchDeleted: false, reason: `${path} is not a worktree of a repository` };
  const git = (...args: string[]): Promise<string> => run(GIT_BIN, ['-C', repo, ...args], env);
  try {
    await git('worktree', 'remove', path);
  } catch (error) {
    return { removed: false, branchDeleted: false, reason: messageOf(error) };
  }
  try {
    await git('branch', '-d', branch);
  } catch (error) {
    return { removed: true, branchDeleted: false, reason: messageOf(error) };
  }
  return { removed: true, branchDeleted: true };
}
