/**
 * Hangar (docs/hangar-spec.md): the files of one agent's folder, or of its Clean Room worktree, for the Director's browser.
 * List a folder, read a text file, save one the Director opened (refused when it changed on disk since), make a new one. No
 * delete, no rename. Every path is a relative one that is resolved with realpath and kept inside the root; `.git` and gonogo's
 * own folder are never reachable. The agent runs as the same user, so this guards the browser's requests, not the agent.
 * shortcut: a folder swapped for a link between the realpath and the open escapes the check (only the last name is opened with
 * O_NOFOLLOW); whoever can swap it can write the file itself. Close it with openat if the agent is ever not the owner's user.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { access, lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { CLEAN_ROOM_DIR, HANGAR_FILE_MAX_BYTES } from '../shared/protocol.js';
import type { HangarEntry, HangarFile, HangarListing, HangarSaved } from '../shared/protocol.js';
import { HubError } from './hub.js';

/** A save body: the text, in the worst case a `\u0000` escape for each byte, plus the path and the etag. */
export const HANGAR_BODY_MAX_BYTES = 6 * HANGAR_FILE_MAX_BYTES + 8192;
/** A folder shows this many entries and says there are more. */
export const HANGAR_LIST_MAX = 2000;
const PATH_MAX_CHARS = 1024;
const ETAG_MAX_CHARS = 64;
/** git's own test for a binary file: a NUL in the first 8000 bytes. */
const SNIFF_BYTES = 8000;

export interface Place {
  dir: string;
  /** The agent runs in a Clean Room: its files are the worktree under gonogo's home. */
  cleanRoom: boolean;
}

export interface HangarDeps {
  /** gonogo's home folder. */
  home: string;
  /** The agent's folder and whether it is a Clean Room, or null for a name that is no agent. */
  agent(name: string): Place | null;
}

/** Where an agent's files are, both resolved with realpath. */
export interface Root {
  root: string;
  home: string;
}

export type Roots = (name: string) => Promise<Root>;

export interface Hangar {
  list(name: string, path: unknown): Promise<HangarListing>;
  read(name: string, path: unknown): Promise<HangarFile>;
  save(name: string, input: unknown): Promise<HangarSaved>;
  create(name: string, input: unknown): Promise<HangarSaved>;
}

const bad = (message: string, field?: string): HubError => new HubError('bad_request', message, field);
const forbidden = (message: string): HubError => new HubError('forbidden', message, 'path');

/** `child` is `parent` or below it. */
export function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** A name that a file system may take for `.git`: other case, a zero-width or ignorable character in it (HFS+ ignores those). */
export function isGitName(segment: string): boolean {
  return segment.normalize('NFKC').replace(/[­​-‏‪-‮⁠-⁯﻿]/g, '').toLowerCase() === '.git';
}

/** The segments of a relative path from the browser. Anything that could leave the root, or reach `.git`, is refused here. */
export function pathParts(raw: unknown, field = 'path'): string[] {
  if (typeof raw !== 'string') throw bad(`${field} must be a string`, field);
  if (raw.length > PATH_MAX_CHARS) throw bad(`${field} is longer than ${PATH_MAX_CHARS} characters`, field);
  if (raw.includes('\0')) throw bad(`${field} has a NUL character`, field);
  if (raw.startsWith('/')) throw forbidden('the path must be relative to the agent\'s folder');
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw forbidden('a path cannot go up with ..');
  if (parts.some(isGitName)) throw forbidden('.git is not reachable');
  return parts;
}

/** Turns what a file system call said into an answer; anything else is the server's own fault and goes up as it is. */
function fsError(e: unknown): unknown {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return new HubError('not_found', 'no such file or folder', 'path');
  if (code === 'ENOTDIR') return bad('a part of the path is not a folder', 'path');
  if (code === 'EISDIR') return bad('that is a folder', 'path');
  if (code === 'EEXIST') return new HubError('conflict', 'a file with that name exists', 'path');
  if (code === 'EACCES' || code === 'EPERM') return forbidden('permission denied');
  if (code === 'ELOOP') return forbidden('a symbolic link is not followed there');
  if (code === 'ENAMETOOLONG') return bad('a name in the path is too long', 'path');
  return e;
}

const etagOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex').slice(0, 32);

/** At most `max` bytes from the start; a file that grows while it is read cannot make this large. */
async function readUpTo(handle: FileHandle, max: number): Promise<Buffer> {
  const buffer = Buffer.alloc(max);
  let size = 0;
  while (size < max) {
    const { bytesRead } = await handle.read(buffer, size, max - size, size);
    if (bytesRead === 0) break;
    size += bytesRead;
  }
  return buffer.subarray(0, size);
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let at = 0;
  while (at < bytes.length) at += (await handle.write(bytes, at, bytes.length - at, at)).bytesWritten;
}

/** Text the editor may hold: valid UTF-8 without a NUL. A byte order mark stays in the text, so a save writes it back. */
function decode(bytes: Buffer): string {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) throw new HubError('unsupported', 'a binary file: the editor opens text only', 'path');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new HubError('unsupported', 'not valid UTF-8: the editor opens text only', 'path');
  }
}

function textOf(input: Record<string, unknown>, required: boolean): Buffer {
  const { text } = input;
  if (text === undefined && !required) return Buffer.alloc(0);
  if (typeof text !== 'string') throw bad('text must be a string', 'text');
  if (text.includes('\0')) throw bad('text has a NUL character: the editor holds text only', 'text');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > HANGAR_FILE_MAX_BYTES) throw new HubError('too_large', `the file would be ${bytes.length} bytes; the limit is ${HANGAR_FILE_MAX_BYTES}`, 'text');
  return bytes;
}

const isInput = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Where an agent's files are: its Clean Room's worktree, else its folder. The home folder is resolved too, to keep gonogo's own state out of reach. */
export function createRoots(deps: HangarDeps): Roots {
  return async (name) => {
    const place = deps.agent(name);
    if (place === null) throw new HubError('not_found', 'unknown agent');
    const wanted = place.cleanRoom ? join(deps.home, CLEAN_ROOM_DIR, name) : place.dir;
    try {
      return { root: await realpath(wanted), home: await realpath(deps.home) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HubError('not_found', place.cleanRoom ? 'the Clean Room has no worktree yet: start the agent once' : 'the agent\'s folder is gone');
      }
      throw e;
    }
  };
}

export function createHangar(roots: Roots): Hangar {
  /** gonogo's home is out of reach, except the Clean Room worktrees below it (an agent's own files). */
  const ownState = (at: Root, real: string): boolean => inside(at.home, real) && !inside(join(at.home, CLEAN_ROOM_DIR), real);
  const guard = (at: Root, real: string): void => {
    if (!inside(at.root, real)) throw forbidden('that path leads outside the agent\'s folder');
    if (relative(at.root, real).split(sep).some(isGitName)) throw forbidden('.git is not reachable');
    if (ownState(at, real)) throw forbidden('that is gonogo\'s own folder');
  };

  async function resolveIn(at: Root, parts: string[]): Promise<string> {
    let real: string;
    try {
      real = await realpath(join(at.root, ...parts));
    } catch (e) {
      throw fsError(e);
    }
    guard(at, real);
    return real;
  }

  /** Opens without following a link in the last name and without waiting on a pipe; what is opened must be a regular file. */
  async function openFile(real: string, flags: number): Promise<{ handle: FileHandle; info: Stats }> {
    let handle: FileHandle;
    try {
      handle = await open(real, flags | fs.O_NOFOLLOW | fs.O_NONBLOCK);
    } catch (e) {
      throw fsError(e);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new HubError('unsupported', 'not a regular file', 'path');
      return { handle, info };
    } catch (e) {
      await handle.close();
      throw e;
    }
  }

  const filePath = (raw: unknown): string[] => {
    const parts = pathParts(raw);
    if (parts.length === 0) throw bad('path must name a file', 'path');
    return parts;
  };

  return {
    async list(name, raw) {
      const parts = pathParts(raw ?? '');
      const at = await roots(name);
      const dir = await resolveIn(at, parts);
      const entries: HangarEntry[] = [];
      let truncated = false;
      try {
        // shortcut: past the limit the entries are the first the disk gave, not the first by name; sort a whole folder when one needs it
        for await (const item of await opendir(dir)) {
          if (isGitName(item.name) || ownState(at, join(dir, item.name))) continue;
          if (entries.length >= HANGAR_LIST_MAX) {
            truncated = true;
            break;
          }
          const kind = item.isDirectory() ? 'dir' : item.isSymbolicLink() ? 'link' : item.isFile() ? 'file' : null;
          if (kind !== null) entries.push({ name: item.name, kind, size: kind === 'file' ? (await lstat(join(dir, item.name)).catch(() => null))?.size ?? 0 : 0 });
        }
      } catch (e) {
        throw fsError(e);
      }
      entries.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { path: parts.join('/'), entries, truncated };
    },

    async read(name, raw) {
      const parts = filePath(raw);
      const real = await resolveIn(await roots(name), parts);
      const { handle, info } = await openFile(real, fs.O_RDONLY);
      try {
        if (info.size > HANGAR_FILE_MAX_BYTES) throw new HubError('too_large', `the file has ${info.size} bytes; the editor opens at most ${HANGAR_FILE_MAX_BYTES}`, 'path');
        const bytes = await readUpTo(handle, HANGAR_FILE_MAX_BYTES + 1);
        if (bytes.length > HANGAR_FILE_MAX_BYTES) throw new HubError('too_large', `the file is larger than ${HANGAR_FILE_MAX_BYTES} bytes`, 'path');
        return { path: parts.join('/'), text: decode(bytes), size: bytes.length, etag: etagOf(bytes) };
      } finally {
        await handle.close();
      }
    },

    async save(name, input) {
      if (!isInput(input)) throw bad('the body must be an object');
      const parts = filePath(input.path);
      const { etag } = input;
      if (typeof etag !== 'string' || etag === '' || etag.length > ETAG_MAX_CHARS) throw bad('etag must be the one the file was read with', 'etag');
      const bytes = textOf(input, true);
      const real = await resolveIn(await roots(name), parts);
      const { handle, info } = await openFile(real, fs.O_RDONLY);
      let temp: string | null = null;
      try {
        // the file is replaced by a new one, which a read-only file must not allow
        await access(real, fs.W_OK).catch((e: unknown) => {
          throw fsError(e);
        });
        const now = info.size > HANGAR_FILE_MAX_BYTES ? null : await readUpTo(handle, HANGAR_FILE_MAX_BYTES + 1);
        if (now === null || etagOf(now) !== etag) throw new HubError('conflict', 'the file changed on disk since you opened it: nothing was saved', 'etag');
        // Written whole beside the file and renamed over it, so that a full disk or a crash leaves the old file.
        temp = join(real, '..', `.${parts[parts.length - 1] ?? 'file'}.gonogo-${randomBytes(4).toString('hex')}.tmp`);
        const out = await open(temp, 'wx', 0o600).catch((e: unknown) => {
          temp = null;
          throw fsError(e);
        });
        try {
          await writeAll(out, bytes);
          await out.chmod(info.mode & 0o7777);
        } finally {
          await out.close();
        }
        // shortcut: a write by another process between this check and the rename is lost; take a lock file when two writers matter
        const after = await lstat(real);
        if (after.mtimeMs !== info.mtimeMs || after.size !== info.size) throw new HubError('conflict', 'the file changed on disk while it was saved: nothing was saved', 'etag');
        await rename(temp, real);
        temp = null;
        return { path: parts.join('/'), size: bytes.length, etag: etagOf(bytes) };
      } finally {
        await handle.close();
        if (temp !== null) await unlink(temp).catch(() => undefined);
      }
    },

    async create(name, input) {
      if (!isInput(input)) throw bad('the body must be an object');
      const parts = filePath(input.path);
      const bytes = textOf(input, false);
      const at = await roots(name);
      const folder = await resolveIn(at, parts.slice(0, -1));
      const leaf = parts[parts.length - 1] ?? '';
      let handle: FileHandle;
      try {
        // O_EXCL: the name must be new, and a link by that name is never followed.
        handle = await open(join(folder, leaf), 'wx', 0o644);
      } catch (e) {
        throw fsError(e);
      }
      try {
        await writeAll(handle, bytes);
      } finally {
        await handle.close();
      }
      return { path: parts.join('/'), size: bytes.length, etag: etagOf(bytes) };
    },
  };
}
