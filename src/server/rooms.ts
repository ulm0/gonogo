/**
 * Rooms (docs/rooms-spec.md): the list of rooms of one gonogo home, `<home>/rooms.json`.
 *
 * The root home is room `main` (nothing moves); every other room lives in `<home>/rooms/<id>/` and starts from zero. The file is
 * 0600, written atomically. `remove` only takes a room off the list: it never deletes a folder.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

export const MAIN_ROOM = 'main';
export const ROOMS_FILE = 'rooms.json';
export const ROOMS_DIR = 'rooms';
export const ROOMS_MAX = 12;
const ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
const NAME_MAX = 40;

export interface RoomEntry {
  id: string;
  name: string;
  /** The supervisor starts it with itself (default true). */
  autostart: boolean;
}

/** `kind` tells the supervisor's routes which answer it is: bad input, a conflict with what exists, or no such room. */
export class RoomsError extends Error {
  constructor(
    message: string,
    readonly kind: 'bad_request' | 'conflict' | 'not_found' = 'bad_request',
  ) {
    super(message);
  }
}

/** The id of a room as a path segment: lower case, starts with a letter, no dots and no slashes. */
export const validRoomId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

/** Where a room keeps its files: the root for `main`, a folder under it for the others. */
export const roomHome = (root: string, id: string): string => (id === MAIN_ROOM ? root : join(root, ROOMS_DIR, id));

// eslint-disable-next-line no-control-regex
/** A name that came from a room's own state (its tab name): cleaned and cut like a room's name, so a room cannot show the Director bidi or control characters. */
export const roomText = (text: string): string => cleanName(text).slice(0, NAME_MAX);
const cleanName = (text: string): string => text.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The rooms of a home, `main` first. No file is just `main`. A file that is there but cannot be read, is not JSON or has no list of rooms
 * (a hand edit with a syntax error, a torn save) THROWS: it must never read as "no rooms", or the supervisor would stop every room.
 */
export function loadRooms(root: string): RoomEntry[] {
  const list: RoomEntry[] = [{ id: MAIN_ROOM, name: 'Main', autostart: true }];
  let text: string;
  try {
    text = readFileSync(join(root, ROOMS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return list;
    throw new RoomsError(`cannot read ${ROOMS_FILE}: ${(error as Error).message}`, 'conflict');
  }
  try {
    const saved: unknown = JSON.parse(text);
    const rooms = typeof saved === 'object' && saved !== null && Array.isArray((saved as { rooms?: unknown }).rooms) ? (saved as { rooms: unknown[] }).rooms : null;
    if (rooms === null) throw new Error('no list of rooms');
    for (const item of rooms) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, name, autostart } = item as Record<string, unknown>;
      if (!validRoomId(id) || id === MAIN_ROOM || list.some((r) => r.id === id)) continue;
      list.push({ id, name: typeof name === 'string' && cleanName(name) !== '' ? cleanName(name).slice(0, NAME_MAX) : id, autostart: autostart !== false });
    }
  } catch (error) {
    throw new RoomsError(`${ROOMS_FILE} is damaged (${(error as Error).message}): fix or delete it. Nothing was stopped.`, 'conflict');
  }
  return list;
}

function saveRooms(root: string, rooms: RoomEntry[]): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, ROOMS_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, rooms }, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

/** Adds a room (its folder is made when the room first starts). Throws RoomsError with the reason. */
export function addRoom(root: string, id: unknown, name?: string): RoomEntry {
  if (!validRoomId(id)) throw new RoomsError('a room id is a lower-case letter, then up to 23 lower-case letters, digits or dashes');
  if (id === MAIN_ROOM) throw new RoomsError('main is the home itself: pick another id');
  const rooms = loadRooms(root);
  if (rooms.some((r) => r.id === id)) throw new RoomsError(`there is already a room "${id}"`, 'conflict');
  if (rooms.length >= ROOMS_MAX) throw new RoomsError(`at most ${ROOMS_MAX} rooms: every room is a gonogo process of its own`, 'conflict');
  const entry: RoomEntry = { id, name: name === undefined || cleanName(name) === '' ? id : cleanName(name).slice(0, NAME_MAX), autostart: true };
  saveRooms(root, [...rooms.filter((r) => r.id !== MAIN_ROOM), entry]);
  return entry;
}

/** Takes a room off the list. Its folder stays. `main` cannot be removed: it is the home itself. */
export function removeRoom(root: string, id: unknown): void {
  if (id === MAIN_ROOM) throw new RoomsError('main is the home itself and cannot be removed');
  const rooms = loadRooms(root);
  if (!rooms.some((r) => r.id === id)) throw new RoomsError(`there is no room "${String(id)}"`, 'not_found');
  saveRooms(root, rooms.filter((r) => r.id !== id && r.id !== MAIN_ROOM));
}

/** Gives a room another name (its id and folder stay). `main` has no entry in the file, so its name is fixed. */
export function renameRoom(root: string, id: unknown, name: unknown): RoomEntry {
  if (id === MAIN_ROOM) throw new RoomsError('the name of main is fixed');
  if (typeof name !== 'string' || cleanName(name) === '') throw new RoomsError(`a name is 1 to ${NAME_MAX} characters of text`);
  const rooms = loadRooms(root);
  const found = rooms.find((r) => r.id === id);
  if (found === undefined) throw new RoomsError(`there is no room "${String(id)}"`, 'not_found');
  const next: RoomEntry = { ...found, name: cleanName(name).slice(0, NAME_MAX) };
  saveRooms(root, rooms.filter((r) => r.id !== MAIN_ROOM).map((r) => (r.id === id ? next : r)));
  return next;
}

/* ---- is a supervisor running on this home? ---- */

export const SUPERVISOR_FILE = 'rooms-supervisor.json';

/** The supervisor says it runs: its pid and the port it listens on (0600). */
export function writeSupervisorFile(root: string, host: string, port: number): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // a temporary file and a rename, as saveRooms does: a symlink planted under the final name is replaced, never written through
  const path = join(root, SUPERVISOR_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    unlinkSync(temp); // a stale or planted name is removed itself (a symlink is not followed), then created fresh
  } catch {
    // none
  }
  writeFileSync(temp, JSON.stringify({ pid: process.pid, host: ['0.0.0.0', '::', ''].includes(host) ? '127.0.0.1' : host, port }), { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

/** Removes the file only when it names this process: a supervisor that started later owns the file it wrote. */
export function removeSupervisorFile(root: string): void {
  const path = join(root, SUPERVISOR_FILE);
  try {
    if ((JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid !== process.pid) return;
    unlinkSync(path);
  } catch {
    // already gone, or not ours to read
  }
}

/**
 * Whether a `gonogo rooms` supervisor holds this home: the file names a live pid AND something answers on its port (a pid alone can be a
 * stranger's after a restart of a container, where pids repeat). Never throws.
 */
export function supervisorRunning(root: string): Promise<boolean> {
  let saved: { pid?: unknown; host?: unknown; port?: unknown };
  try {
    saved = JSON.parse(readFileSync(join(root, SUPERVISOR_FILE), 'utf8')) as typeof saved;
  } catch {
    return Promise.resolve(false);
  }
  const { pid, port, host } = saved;
  if (typeof host !== 'string' || typeof pid !== 'number' || typeof port !== 'number' || !Number.isInteger(pid) || pid <= 0 || port < 1 || port > 65535) return Promise.resolve(false);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(700, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** What `gonogo rooms add|remove` adds when nothing would act on the change. */
export const NO_SUPERVISOR_HINT =
  'saved in rooms.json; no `gonogo rooms` supervisor is running, so the room will not start or stop. Run gonogo as `gonogo rooms ...` (Docker: command: ["rooms", "--host", "0.0.0.0", "--port", "7777"]).';
