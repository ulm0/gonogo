/**
 * The project folder of a room (docs/features/rooms.md, "Folders"): where its boss starts and what the hire form offers as the working directory. Kept in
 * `<room home>/project-folder.json`; without it a room works in the folder gonogo was started from, as before. A folder is checked every time one is
 * set, and the value kept is its real path (a link is followed once, at the moment it is set).
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, accessSync, statSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { nullLogger } from './constants.js';

export const PROJECT_FOLDER_FILE = 'project-folder.json';

export class FolderError extends Error {}

/** `outer` is `inner` or holds it. */
const holds = (outer: string, inner: string): boolean => {
  const way = relative(outer, inner);
  return way === '' || (way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way));
};

/**
 * Claude Code trusts every non-git folder below a trusted one, so a project folder that is the root, the home directory or a folder above gonogo's or Claude's own
 * files would switch the trust dialog and the hook gate off far beyond the project the owner meant. Why `dirs` (the folder and its real path) is too broad, or null.
 * The one rule of the launcher (it refuses to record trust for such a folder) and of the place where a folder is chosen: the Director learns it when he sets it.
 */
export function broadReason(dirs: readonly string[], guards: readonly { path: string; what: string }[]): string | null {
  for (const dir of dirs) {
    if (dir === parse(dir).root) return 'it is the root of the file system';
    for (const guard of guards) {
      let real = guard.path;
      try {
        real = realpathSync(guard.path);
      } catch {
        // not made yet: as spelled
      }
      for (const path of new Set([guard.path, real])) {
        if (!holds(dir, path)) continue;
        return relative(dir, path) === '' ? `it is ${guard.what}` : `it holds ${guard.what} (${guard.path})`;
      }
    }
  }
  return null;
}

/** The folders a project folder may not be, or hold: the owner's home directory, gonogo's own folders, Claude Code's configuration folder. */
export const folderGuards = (own: readonly string[], env: Record<string, string | undefined>): Array<{ path: string; what: string }> => [
  { path: homedir(), what: 'your home directory' },
  ...own.map((path) => ({ path, what: "gonogo's home directory" })),
  { path: env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), what: "Claude Code's configuration folder" },
];

/**
 * The real path of `input` when it may be a project folder: text, absolute, no NUL, an existing directory the process can read, and neither one of
 * `forbidden` (gonogo's own folders: state, tokens, keys) nor inside one, nor so broad that Claude's trust would reach gonogo's or Claude's own files (`~`, `/`, a folder that holds them).
 */
export function checkFolder(input: unknown, forbidden: readonly string[], env: Record<string, string | undefined> = process.env): string {
  if (typeof input !== 'string' || input.trim() === '') throw new FolderError('give the folder as text');
  const text = input.trim();
  if (text.includes('\u0000')) throw new FolderError('a folder cannot contain a NUL character');
  if (!isAbsolute(text)) throw new FolderError('give the whole path of the folder: it starts with /');
  let real: string;
  try {
    real = realpathSync(text);
  } catch {
    throw new FolderError(`${text} does not exist on this computer`);
  }
  let directory = false;
  try {
    directory = statSync(real).isDirectory();
    accessSync(real, constants.R_OK | constants.X_OK);
  } catch {
    throw new FolderError(directory ? `${real} cannot be read by gonogo` : `${text} is not a folder`);
  }
  if (!directory) throw new FolderError(`${text} is not a folder`);
  for (const own of forbidden) {
    let there: string;
    try {
      there = realpathSync(own);
    } catch {
      continue; // a folder of gonogo's that is not made yet cannot be chosen by accident
    }
    if (real === there || real.startsWith(there.endsWith(sep) ? there : there + sep)) throw new FolderError(`${real} is gonogo's own folder (its state, tokens and keys): choose your project's folder`);
  }
  const broad = broadReason([...new Set([text, real])], folderGuards(forbidden, env));
  if (broad !== null) throw new FolderError(`${real} is too broad: ${broad}, and Claude's trust of a folder covers every folder below it. Choose your project's folder`);
  return real;
}

/** What the file holds, or null: unreadable, not JSON and anything but one string are "no folder", never an error at start. */
export function readFolder(roomHome: string, log: Logger = nullLogger): string | null {
  const path = join(roomHome, PROJECT_FOLDER_FILE);
  try {
    const dir = (JSON.parse(readFileSync(path, 'utf8')) as { dir?: unknown }).dir;
    return typeof dir === 'string' && isAbsolute(dir) && !dir.includes('\u0000') ? dir : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not read ${path}: ignored`);
    return null;
  }
}

/** Stores `dir` (already checked), or with null forgets it. Atomic, 0600. */
export function writeFolder(roomHome: string, dir: string | null): void {
  const path = join(roomHome, PROJECT_FOLDER_FILE);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  if (dir === null) {
    writeFileSync(temp, `${JSON.stringify({ version: 1 })}\n`, { mode: 0o600, flag: 'wx' });
  } else {
    writeFileSync(temp, `${JSON.stringify({ version: 1, dir })}\n`, { mode: 0o600, flag: 'wx' });
  }
  renameSync(temp, path);
}

export interface ProjectFolder {
  /**
   * The folder in force: the stored one when it still passes the checks (a file somebody planted, or a folder that is gone, is not trusted), else the one gonogo
   * was started in. `needsFolder`: that default is itself too broad to start agents in, so the Director is asked to set one.
   */
  get(): { dir: string; source: 'set' | 'default'; default: string; needsFolder: boolean };
  /** Checks and stores (null: back to the default). Throws a FolderError. */
  set(input: string | null): { before: string; after: string };
}

export function createProjectFolder(options: { roomHome: string; fallback: string; forbidden: readonly string[]; env?: Record<string, string | undefined>; log?: Logger }): ProjectFolder {
  const log = options.log ?? nullLogger;
  const env = options.env ?? process.env;
  let warned = '';
  const needsFolder = ((): boolean => {
    try {
      checkFolder(options.fallback, options.forbidden, env);
      return false;
    } catch {
      return true;
    }
  })();
  const get: ProjectFolder['get'] = () => {
    const stored = readFolder(options.roomHome, log);
    if (stored !== null) {
      try {
        return { dir: checkFolder(stored, options.forbidden, env), source: 'set', default: options.fallback, needsFolder: false };
      } catch (error) {
        if (warned !== stored) {
          warned = stored;
          log.warn(`the project folder ${stored} is not used: ${error instanceof Error ? error.message : 'it cannot be used'}; using ${options.fallback} until it is set again`);
        }
      }
    }
    return { dir: options.fallback, source: 'default', default: options.fallback, needsFolder };
  };
  return {
    get,
    set(input) {
      const before = get().dir;
      const dir = input === null ? null : checkFolder(input, options.forbidden, env);
      writeFolder(options.roomHome, dir);
      return { before, after: get().dir };
    },
  };
}
