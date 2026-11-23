/**
 * The project folder of a room (docs/features/rooms.md, "Folders"): where its boss starts and what the hire form offers as the working directory. Kept in
 * `<room home>/project-folder.json`; without it a room works in the folder gonogo was started from, as before. Only the SHAPE of a folder is checked, every
 * time one is set or read (the Director decides which folder is his project: nothing is refused by where it is); a folder that is broad or holds gonogo's
 * own files comes with a warning for the page to show next to it. The value kept is the real path (a link is followed once, at the moment it is set).
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

const realOf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * What the Director should know about a folder he picked, or null: it is, holds or lies inside gonogo's own folders (agents there can change gonogo's settings and
 * keys without asking), or it is so broad (the root, a home directory, the folder of Claude Code's configuration) that agents can read everything under it.
 * `own` are gonogo's folders (its home, the root home of the supervisor). Nothing here refuses anything.
 */
export function folderWarning(real: string, own: readonly string[], env: Record<string, string | undefined> = process.env): string | null {
  for (const path of own) {
    const there = realOf(path);
    if (holds(there, real) || holds(real, there)) return "Agents can read and change gonogo's own settings and keys in this folder without asking.";
  }
  const sensitive = [homedir(), env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')];
  if (real === parse(real).root || sensitive.some((path) => holds(real, realOf(path)))) return 'Broad folder: agents can read everything under it.';
  return null;
}

/** The real path of `input` when it has the shape of a project folder: text, absolute, no NUL, an existing directory the process can read. Nothing else is refused. */
export function checkFolder(input: unknown): string {
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
  writeFileSync(temp, `${JSON.stringify(dir === null ? { version: 1 } : { version: 1, dir })}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

/** The dry run of a PUT or of a new room: the shape check and the warning, nothing written. */
export function checkWithWarning(input: unknown, own: readonly string[], env: Record<string, string | undefined> = process.env): { ok: true; dir: string; warning: string | null } | { ok: false; reason: string; warning: null } {
  try {
    const dir = checkFolder(input);
    return { ok: true, dir, warning: folderWarning(dir, own, env) };
  } catch (error) {
    if (error instanceof FolderError) return { ok: false, reason: error.message, warning: null };
    throw error;
  }
}

export interface ProjectFolder {
  /**
   * The folder in force: the stored one when it still has the shape of a folder (a file somebody planted, or a folder that is gone, does not), else the one
   * gonogo was started in. `warning`: what the Director should know about that folder, or null.
   */
  get(): { dir: string; source: 'set' | 'default'; default: string; warning: string | null };
  /** What a PUT of `input` would find, writing nothing: the real path and the warning, or why not. */
  check(input: unknown): { ok: true; dir: string; warning: string | null } | { ok: false; reason: string; warning: null };
  /** Checks the shape and stores (null: back to the default). Throws a FolderError. */
  set(input: string | null): { before: string; after: string; warning: string | null };
}

export function createProjectFolder(options: { roomHome: string; fallback: string; own: readonly string[]; env?: Record<string, string | undefined>; log?: Logger }): ProjectFolder {
  const log = options.log ?? nullLogger;
  const env = options.env ?? process.env;
  let warned = '';
  const get: ProjectFolder['get'] = () => {
    const stored = readFolder(options.roomHome, log);
    if (stored !== null) {
      try {
        const dir = checkFolder(stored);
        return { dir, source: 'set', default: options.fallback, warning: folderWarning(dir, options.own, env) };
      } catch (error) {
        if (warned !== stored) {
          warned = stored;
          log.warn(`the project folder ${stored} is not used: ${error instanceof Error ? error.message : 'it cannot be used'}; using ${options.fallback} until it is set again`);
        }
      }
    }
    return { dir: options.fallback, source: 'default', default: options.fallback, warning: folderWarning(options.fallback, options.own, env) };
  };
  return {
    get,
    check(input) {
      return checkWithWarning(input, options.own, env);
    },
    set(input) {
      const before = get().dir;
      writeFolder(options.roomHome, input === null ? null : checkFolder(input));
      const now = get();
      return { before, after: now.dir, warning: now.warning };
    },
  };
}
