/**
 * The project folder of a room (docs/features/rooms.md, "Folders"): where its boss starts and what the hire form offers as the working directory. Kept in
 * `<room home>/project-folder.json`; without it a room works in the folder gonogo was started from, as before. A folder is checked every time one is
 * set, and the value kept is its real path (a link is followed once, at the moment it is set).
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, accessSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, sep } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { nullLogger } from './constants.js';

export const PROJECT_FOLDER_FILE = 'project-folder.json';

export class FolderError extends Error {}

/**
 * The real path of `input` when it may be a project folder: text, absolute, no NUL, an existing directory the process can read, and neither one of
 * `forbidden` (gonogo's own folders: state, tokens, keys) nor inside one. A folder that CONTAINS gonogo's home (`~`, `/`) is allowed.
 */
export function checkFolder(input: unknown, forbidden: readonly string[]): string {
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
  /** The folder in force: the stored one when it is still a folder, else the one gonogo was started from. */
  get(): { dir: string; source: 'set' | 'default'; default: string };
  /** Checks and stores (null: back to the default). Throws a FolderError. */
  set(input: string | null): { before: string; after: string };
}

export function createProjectFolder(options: { roomHome: string; fallback: string; forbidden: readonly string[]; log?: Logger }): ProjectFolder {
  const log = options.log ?? nullLogger;
  let warned = '';
  const get: ProjectFolder['get'] = () => {
    const stored = readFolder(options.roomHome, log);
    if (stored !== null) {
      try {
        if (statSync(stored).isDirectory()) return { dir: stored, source: 'set', default: options.fallback };
      } catch {
        // gone: below
      }
      if (warned !== stored) {
        warned = stored;
        log.warn(`the project folder ${stored} is gone: using ${options.fallback} until it is set again`);
      }
    }
    return { dir: options.fallback, source: 'default', default: options.fallback };
  };
  return {
    get,
    set(input) {
      const before = get().dir;
      const dir = input === null ? null : checkFolder(input, options.forbidden);
      writeFolder(options.roomHome, dir);
      return { before, after: get().dir };
    },
  };
}
