/**
 * Rooms (docs/rooms-spec.md): the list of rooms of one gonogo home, `<home>/rooms.json`.
 *
 * Every room lives in `<home>/rooms/<id>/` and starts from zero, `main` too on a home made by this version. A home made before it
 * keeps room `main` AT the root (its files next to the supervisor's own): `main.home` of this file says which, so the layout never changes
 * by accident (no file or no `main` key: the root when the root holds a room's files, else `rooms/main`). The file is 0600, written
 * atomically. `remove` only takes a room off the list: it never deletes a folder.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

export const MAIN_ROOM = 'main';
/** Names the front port answers itself at its root: not offered as ids for new rooms (rooms already so named keep working under /r/<id>/). */
export const RESERVED_ROOT_NAMES = ['r', 'ws', 'internal', 'api', 'assets', 'rooms'] as const;
/** The last parts of `/api/rooms/<x>` that are actions on all the rooms: not room ids. */
export const ROOM_ACTION_NAMES = ['stop-all', 'start-all', 'check-folder'] as const;
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

/** Where room `main` keeps its files: the root itself (a home made before 0.8.2) or `rooms/main` (a new one). */
export type MainHome = '.' | 'rooms/main';
const MAIN_HOMES: readonly unknown[] = ['.', 'rooms/main'];
/**
 * What a room (not the supervisor) keeps in its home: any of them at the root means room main lives there. Wider is safer, since a miss would hide an
 * old home's agents. test/rooms.test.ts reads every `*_FILE` and `*_DIR` name in src/ and fails for one that is in none of these three lists, so a
 * new file of a room cannot be forgotten here.
 */
export const ROOM_STATE_FILES: readonly string[] = [
  'agents.json', 'agents', 'autoupdate.json', 'black-box', 'board.md', 'cleanroom', 'cleanroom-home', 'coauthor.json', 'dock-outbox.json', 'links.json', 'shares.json', 'docking.json', 'downlink.json', 'egress.json', 'features.json', 'fuel.jsonl',
  'gh', 'hub-state.json', 'keys.json', 'keys.refused.json', 'knowledge-proposals', 'semantic', 'liveries', 'livery.json', 'messages.jsonl', 'messages.jsonl.1', 'mission-log', 'missions.json', 'models.json', 'ritual.md',
  'payload-defaults.json', 'payload-plugin', 'permissions.json', 'prices.json', 'propellant.json', 'quota.json', 'relay.json', 'reported.jsonl', 'reviews.json', 'rollout.json',
  'project-folder.json', 'room-keys.json', 'room-keys.refused.json', 'room.json', 'rules.md', 'run-state.json', 'runtime-settings.json', 'schedules.json', 'server.lock', 'startup.json', 'station.json', 'subagents.json', 'tabname.json',
  'tasks.json', 'telegram-poll.json', 'telemetry.jsonl', 'triggers.1.jsonl', 'triggers.jsonl', 'uplinks.json', 'worktrees',
];
/** The supervisor's own files and folders: they stay at the root whatever the layout, and never say where main is. */
export const SUPERVISOR_FILES: readonly string[] = ['auth.json', 'exposure-dismissed.json', 'runtime-settings-global.json', 'push.json', 'rooms.json', 'rooms-supervisor.json', 'setup-token', 'token', 'supervisor.lock', 'rooms', 'run', 'main-migration.json', 'knowledge'];
/** Names that only exist inside another folder (an agent's, or `run/`): never at a home's root, so they say nothing about the layout. */
export const NESTED_FILES: readonly string[] = ['.seq', 'agy-hooks.json', 'gemini-settings.json', 'inbox-files', 'mcp.json', 'memory.md', 'ptyhost.key', 'ptyhost.log', 'ptyhost.sock', 'settings.json', 'tokens.json', 'update.json'];
/** Where a room that is running has put something besides those: its socket and token. */
const ROOM_STATE_AT_ROOT: readonly string[] = [...ROOM_STATE_FILES, join('run', 'room.sock'), join('run', 'room-token')];

/** What `rooms.json` says about main: null when it says nothing (no file, or a file of an older version). Throws a plain Error for a value it does not know. */
function recordedMain(saved: unknown): MainHome | null {
  const main = typeof saved === 'object' && saved !== null ? (saved as { main?: unknown }).main : undefined;
  if (main === undefined) return null;
  const home = typeof main === 'object' && main !== null ? (main as { home?: unknown }).home : undefined;
  if (!MAIN_HOMES.includes(home)) throw new Error(`main.home must be one of ${MAIN_HOMES.map((h) => JSON.stringify(h)).join(', ')}`);
  return home as MainHome;
}

function readRoomsFile(root: string): unknown {
  let text: string;
  try {
    text = readFileSync(join(root, ROOMS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RoomsError(`cannot read ${ROOMS_FILE}: ${(error as Error).message}`, 'conflict');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RoomsError(`${ROOMS_FILE} is damaged (${(error as Error).message}): fix or delete it. Nothing was stopped.`, 'conflict');
  }
}

/** The layout of this home: the recorded one, else decided by what is there. Never writes (see recordMainHome). */
export function mainLayout(root: string): MainHome {
  let recorded: MainHome | null;
  try {
    recorded = recordedMain(readRoomsFile(root));
  } catch (error) {
    if (error instanceof RoomsError) throw error;
    throw new RoomsError(`${ROOMS_FILE} is damaged (${(error as Error).message}): fix or delete it. Nothing was stopped.`, 'conflict');
  }
  if (recorded !== null) return recorded;
  // no record: rooms/main first. An older build that edited rooms.json after a rollback dropped the record and started an empty main at the root, but the real one is still in rooms/main
  const holds = (dir: string): boolean => ROOM_STATE_AT_ROOT.some((name) => existsSync(join(dir, name)));
  if (holds(join(root, ROOMS_DIR, MAIN_ROOM))) return 'rooms/main';
  // a move that finished (main-migration.json says done) and a rooms.json an older build saved without the record: main is where the move put it, even when its files are few
  try {
    if ((JSON.parse(readFileSync(join(root, 'main-migration.json'), 'utf8')) as { state?: unknown }).state === 'done' && existsSync(join(root, ROOMS_DIR, MAIN_ROOM))) return 'rooms/main';
  } catch {
    // no note, or one that is not read here (the migration reads it strictly)
  }
  return holds(root) ? '.' : 'rooms/main';
}

/** Where a room keeps its files: `main` where the home's layout says, a folder under `rooms/` for the others. */
export const roomHome = (root: string, id: string): string => (id !== MAIN_ROOM ? join(root, ROOMS_DIR, id) : mainLayout(root) === '.' ? root : join(root, ROOMS_DIR, MAIN_ROOM));

/**
 * Writes the layout into `rooms.json` of a fresh home (nothing is on record and the root holds no room's files), so it stays whatever appears later.
 * A home made before 0.8.2 is NOT written to: its files at the root already say where main is, and nothing of an old home is touched.
 */
export function recordMainHome(root: string): void {
  if (recordedMain(readRoomsFile(root)) !== null || mainLayout(root) === '.') return;
  saveRooms(root, loadRooms(root).filter((r) => r.id !== MAIN_ROOM));
}

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
    recordedMain(saved);
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

/** What `rooms.json` says about main, or null when it says nothing (no file, or no `main` key). Throws RoomsError for a damaged file. */
export function recordedMainHome(root: string): MainHome | null {
  try {
    return recordedMain(readRoomsFile(root));
  } catch (error) {
    if (error instanceof RoomsError) throw error;
    throw new RoomsError(`${ROOMS_FILE} is damaged (${(error as Error).message}): fix or delete it. Nothing was stopped.`, 'conflict');
  }
}

/** Writes where main lives into `rooms.json` (the migration's last step, and its undo's): the list of rooms is kept as it is. */
export function setMainHome(root: string, home: MainHome): void {
  saveRooms(root, loadRooms(root).filter((r) => r.id !== MAIN_ROOM), home);
}

function saveRooms(root: string, rooms: RoomEntry[], layout?: MainHome): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, ROOMS_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, main: { home: layout ?? mainLayout(root) }, rooms }, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

/** Adds a room (its folder is made when the room first starts). Throws RoomsError with the reason. */
export function addRoom(root: string, id: unknown, name?: string, autostart = true): RoomEntry {
  if (!validRoomId(id)) throw new RoomsError('a room id is a lower-case letter, then up to 23 lower-case letters, digits or dashes');
  if (id === MAIN_ROOM) throw new RoomsError('main is the home itself: pick another id');
  if ((ROOM_ACTION_NAMES as readonly string[]).includes(id)) throw new RoomsError(`"${id}" is an action on all the rooms: pick another id`);
  if ((RESERVED_ROOT_NAMES as readonly string[]).includes(id)) throw new RoomsError(`"${id}" is a name of the front port (${RESERVED_ROOT_NAMES.join(', ')}): pick another id`);
  const rooms = loadRooms(root);
  if (rooms.some((r) => r.id === id)) throw new RoomsError(`there is already a room "${id}"`, 'conflict');
  if (rooms.length >= ROOMS_MAX) throw new RoomsError(`at most ${ROOMS_MAX} rooms: every room is a gonogo process of its own`, 'conflict');
  const entry: RoomEntry = { id, name: name === undefined || cleanName(name) === '' ? id : cleanName(name).slice(0, NAME_MAX), autostart };
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

/**
 * Changes a room's name and/or whether it starts with gonogo (`autostart`); its id and folder stay. `main` has no entry in the file: its name is fixed and it always
 * starts, so asking to change either is refused. At least one field must be given.
 */
export function updateRoom(root: string, id: unknown, patch: { name?: unknown; autostart?: unknown }): RoomEntry {
  if (patch.name === undefined && patch.autostart === undefined) throw new RoomsError('nothing to change: give a name or autostart');
  if (id === MAIN_ROOM) throw new RoomsError(patch.autostart !== undefined ? 'main always starts with gonogo: its autostart cannot be changed' : 'the name of main is fixed');
  if (patch.autostart !== undefined && typeof patch.autostart !== 'boolean') throw new RoomsError('autostart is true or false');
  if (patch.name !== undefined && (typeof patch.name !== 'string' || cleanName(patch.name) === '')) throw new RoomsError(`a name is 1 to ${NAME_MAX} characters of text`);
  const rooms = loadRooms(root);
  const found = rooms.find((r) => r.id === id);
  if (found === undefined) throw new RoomsError(`there is no room "${String(id)}"`, 'not_found');
  const next: RoomEntry = { ...found, ...(typeof patch.name === 'string' ? { name: cleanName(patch.name).slice(0, NAME_MAX) } : {}), ...(typeof patch.autostart === 'boolean' ? { autostart: patch.autostart } : {}) };
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
export const NO_SUPERVISOR_HINT = 'saved in rooms.json; no gonogo is running for this home, so the room will not start or stop. Start gonogo (Docker: the image\'s default command is the supervisor).';
