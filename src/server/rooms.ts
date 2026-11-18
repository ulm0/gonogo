/**
 * Rooms (docs/rooms-spec.md): the list of rooms of one gonogo home, `<home>/rooms.json`.
 *
 * The root home is room `main` (nothing moves); every other room lives in `<home>/rooms/<id>/` and starts from zero. The file is
 * 0600, written atomically. `remove` only takes a room off the list: it never deletes a folder.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export class RoomsError extends Error {}

/** The id of a room as a path segment: lower case, starts with a letter, no dots and no slashes. */
export const validRoomId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

/** Where a room keeps its files: the root for `main`, a folder under it for the others. */
export const roomHome = (root: string, id: string): string => (id === MAIN_ROOM ? root : join(root, ROOMS_DIR, id));

// eslint-disable-next-line no-control-regex
const cleanName = (text: string): string => text.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();

/** The rooms of a home, `main` first. A missing or unreadable file is just `main`. */
export function loadRooms(root: string): RoomEntry[] {
  const list: RoomEntry[] = [{ id: MAIN_ROOM, name: 'Main', autostart: true }];
  try {
    const saved: unknown = JSON.parse(readFileSync(join(root, ROOMS_FILE), 'utf8'));
    const rooms = typeof saved === 'object' && saved !== null && Array.isArray((saved as { rooms?: unknown }).rooms) ? ((saved as { rooms: unknown[] }).rooms) : [];
    for (const item of rooms) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, name, autostart } = item as Record<string, unknown>;
      if (!validRoomId(id) || id === MAIN_ROOM || list.some((r) => r.id === id)) continue;
      list.push({ id, name: typeof name === 'string' && cleanName(name) !== '' ? cleanName(name).slice(0, NAME_MAX) : id, autostart: autostart !== false });
    }
  } catch {
    // no file yet, or one that is not ours: only main
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
  const rooms = loadRooms(root);
  if (rooms.some((r) => r.id === id)) throw new RoomsError(`there is already a room "${id}"`);
  if (rooms.length >= ROOMS_MAX) throw new RoomsError(`at most ${ROOMS_MAX} rooms: every room is a gonogo process of its own`);
  const entry: RoomEntry = { id, name: name === undefined || cleanName(name) === '' ? id : cleanName(name).slice(0, NAME_MAX), autostart: true };
  saveRooms(root, [...rooms.filter((r) => r.id !== MAIN_ROOM), entry]);
  return entry;
}

/** Takes a room off the list. Its folder stays. `main` cannot be removed: it is the home itself. */
export function removeRoom(root: string, id: unknown): void {
  if (id === MAIN_ROOM) throw new RoomsError('main is the home itself and cannot be removed');
  const rooms = loadRooms(root);
  if (!rooms.some((r) => r.id === id)) throw new RoomsError(`there is no room "${String(id)}"`);
  saveRooms(root, rooms.filter((r) => r.id !== id && r.id !== MAIN_ROOM));
}
