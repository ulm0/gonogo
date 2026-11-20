/**
 * Moving room main of an old home into `rooms/main/` (and back). A home made before 0.8.2 keeps main's files at the root, next to the
 * supervisor's own; this makes it look like a new one. It runs at the supervisor's start, before any room, with the supervisor lock held.
 *
 * Only main's files move (the lists in rooms.ts, built from the code's own file names), by `rename` inside one filesystem: nothing is copied,
 * so no byte is ever in two places. A journal (`main-migration.json`) is written first, so a crash is finished at the next start. What moves is
 * decided by the files that are there, so a move is idempotent: a name that is already in the destination and gone from the source is done.
 * `rooms.json` `main.home` is written LAST: it is the marker that says the move is complete.
 *
 * Not moved, on purpose: the supervisor's files, a folder or file gonogo does not know (listed for the person), the sockets (made again at
 * the next start), and anything of an agent that works in a folder inside the home (a worktree or a Clean Room: the folder is the working
 * directory, and Claude's session history is keyed by it): that refuses the whole move, with the agent's name, and the home stays as it is.
 * The generated files of an agent (settings, MCP config, hooks) hold paths too, and are written again at every start, so nothing rewrites them.
 */
import type { Stats } from 'node:fs';
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { roomLockAlive } from './home.js';
import { GIT_BIN } from './constants.js';
import { mainRepoOf, removeWorktreeFolder, run as defaultRun } from './worktree.js';

/** How git is run (a test makes one command fail). */
export type GitRun = typeof defaultRun;
import { cleanRoomBranch } from '../shared/protocol.js';
import { MAIN_ROOM, NESTED_FILES, ROOM_STATE_FILES, ROOMS_DIR, RoomsError, SUPERVISOR_FILES, mainLayout, recordedMainHome, setMainHome } from './rooms.js';
import type { MainHome } from './rooms.js';

export const MIGRATION_FILE = 'main-migration.json';
/** Files inside `run/` that belong to main (its stable port, the result of a Docker update, the pty host's key and log). The sockets are not moved. */
export const RUN_FILES: readonly string[] = ['run/port', 'run/update.json', 'run/ptyhost.key', 'run/ptyhost.log'];
const SOCKETS: readonly string[] = ['run/room.sock', 'run/ptyhost.sock'];
const REASON_MAX = 12;

export type Direction = 'forward' | 'undo';

/** What `main-migration.json` says. `moving` and `undoing` are the journal; the others are what the rooms page shows. */
export type MigrationNote =
  | { state: 'requested'; at: number }
  | { state: 'undo-requested'; at: number }
  | { state: 'moving' | 'undoing'; at: number; entries: string[] }
  | { state: 'skipped'; at: number; reasons: string[] }
  | { state: 'done'; at: number; moved: number; undoReasons?: string[]; removedWorktrees?: string[] };

const STATES = ['requested', 'undo-requested', 'moving', 'undoing', 'skipped', 'done'];
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '');

/** The note, or null when there is none. A file that is there and cannot be read THROWS: a half move must never read as "nothing to do". */
export function readMigration(root: string): MigrationNote | null {
  let raw: string;
  try {
    raw = readFileSync(join(root, MIGRATION_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RoomsError(`cannot read ${MIGRATION_FILE}: ${(error as Error).message}`, 'conflict');
  }
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const state = saved.state;
    if (typeof state !== 'string' || !STATES.includes(state)) throw new Error('unknown state');
    const at = typeof saved.at === 'number' && Number.isFinite(saved.at) ? saved.at : 0;
    const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => text(x, 300)) : []);
    if (state === 'moving' || state === 'undoing') {
      const entries = names(saved.entries);
      // a name from a file is never a path to follow: only what the lists could have produced
      if (!entries.every(knownEntry)) throw new Error('an entry that is not one of main\'s files');
      return { state, at, entries };
    }
    if (state === 'skipped') return { state, at, reasons: names(saved.reasons).slice(0, REASON_MAX) };
    if (state === 'done') return { state, at, moved: typeof saved.moved === 'number' ? saved.moved : 0, ...(Array.isArray(saved.undoReasons) ? { undoReasons: names(saved.undoReasons).slice(0, REASON_MAX) } : {}), ...(Array.isArray(saved.removedWorktrees) ? { removedWorktrees: names(saved.removedWorktrees).slice(0, REASON_MAX) } : {}) };
    return { state: state as 'requested' | 'undo-requested', at };
  } catch (error) {
    throw new RoomsError(`${MIGRATION_FILE} is damaged (${(error as Error).message}): a move of room main may be half done. Fix or delete it only after looking at ${ROOMS_DIR}/${MAIN_ROOM}/ and the root. Nothing was started.`, 'conflict');
  }
}

/** Every name a journal may hold: one of the lists, or a file of `run/` that moves. */
function knownEntry(name: string): boolean {
  return ROOM_STATE_FILES.includes(name) || RUN_FILES.includes(name);
}

export function writeMigration(root: string, note: MigrationNote): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, MIGRATION_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, ...note }, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

export function clearMigration(root: string): void {
  rmSync(join(root, MIGRATION_FILE), { force: true });
}

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Whether `child` is `parent` or below it, by the folders they really are (a link into the home counts). */
const inside = (parent: string, child: string): boolean => {
  const rel = relative(real(parent), real(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export interface MigrationPlan {
  direction: Direction;
  /** Where main's files are now, and where they would go. */
  from: string;
  to: string;
  /** What would move, as names relative to `from`. */
  entries: string[];
  /** Things at `from` that gonogo does not know: they stay where they are. */
  stays: string[];
  /** Why it cannot be done now. Empty: it can. */
  problems: string[];
  /** Leftover worktrees of Clean Rooms or plain worktrees (clean, branch merged) that the move removes first with `git worktree remove` (the branch is kept). */
  removes: string[];
}

export interface PlanOptions {
  /** Look for a room that is running (a live `server.lock`, a pty host that answers). False for a dry run: what runs now stops before the move. */
  running: boolean;
  /** Remove the leftover worktrees that are safe to remove (a real move). False: only say which. */
  clean?: boolean;
  /** For tests: how git is run. */
  gitRun?: GitRun;
}

/** Whether something answers on a unix socket (a room or a pty host that is alive). Never throws. */
function answers(path: string): Promise<boolean> {
  return new Promise((done) => {
    if (lstatOrNull(path) === null) return done(false);
    const socket = net.connect({ path });
    const end = (up: boolean): void => {
      socket.destroy();
      done(up);
    };
    socket.setTimeout(500, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
}

/** The agents of a roster whose working folder is inside `home`, or that have a worktree or Clean Room (their folder is). Read the file as it is: no parse of what an agent may do. */
function agentsInside(from: string): { problems: string[]; names: { worktree: Set<string>; cleanRoom: Set<string> } } {
  const problems: string[] = [];
  const names = { worktree: new Set<string>(), cleanRoom: new Set<string>() };
  let roster: unknown;
  try {
    roster = JSON.parse(readFileSync(join(from, 'agents.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { problems, names };
    return { problems: [`agents.json cannot be read (${(error as Error).message.slice(0, 80)}): the agents' folders are not known`], names };
  }
  const list = typeof roster === 'object' && roster !== null && Array.isArray((roster as { agents?: unknown }).agents) ? ((roster as { agents: unknown[] }).agents) : null;
  if (list === null) return { problems: ['agents.json has no list of agents: the agents\' folders are not known'], names };
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const agent = item as { name?: unknown; dir?: unknown; worktree?: unknown; cleanRoom?: unknown };
    const name = text(agent.name, 40);
    if (agent.worktree !== undefined && agent.worktree !== null && agent.worktree !== false) names.worktree.add(name);
    if (agent.cleanRoom !== undefined && agent.cleanRoom !== null && agent.cleanRoom !== false) names.cleanRoom.add(name);
    if (typeof agent.dir === 'string' && inside(from, agent.dir)) problems.push(`agent ${name} works in ${text(agent.dir, 200)}, inside the folder that would move (its Claude session history is keyed by that folder)`);
    else if (agent.worktree !== undefined && agent.worktree !== null && agent.worktree !== false) problems.push(`agent ${name} has a worktree in ${join(from, 'worktrees', name)}: its working folder would move and its Claude session history is keyed by it`);
    else if (agent.cleanRoom !== undefined && agent.cleanRoom !== null && agent.cleanRoom !== false) problems.push(`agent ${name} has a Clean Room in ${join(from, 'cleanroom', name)}: its working folder would move and its Claude session history is keyed by it`);
  }
  return { problems, names };
}

/** A worktree or Clean Room folder that is still in the home but that no agent of the roster has any more. */
export interface Leftover {
  path: string;
  /** `git worktree remove` would do it: git knows it, it is clean, and its branch is in the repository's checked-out branch. */
  removable: boolean;
  /** The repository it belongs to, when git knows it. */
  repo: string | null;
  /** Why it is not removable, with the command to run by hand. */
  reason: string;
}

/**
 * Folders of worktrees or Clean Rooms that are still there and that no agent uses (an agent that was removed or changed): git knows them by their path.
 * One that is clean and whose branch is merged can be removed by the move itself; anything else is a reason, with the exact command.
 */
/** Ignored files that are build output: they are regenerated and may go with the worktree. Anything else ignored (.env, local config) may not. */
const BUILD_DIRS = new Set(['node_modules', 'dist', '.vite', 'build', 'coverage']);

async function leftoverFolders(from: string, used: { worktree: Set<string>; cleanRoom: Set<string> }, run: GitRun = defaultRun): Promise<Leftover[]> {
  const out: Leftover[] = [];
  const env = process.env;
  const git = (cwd: string, ...args: string[]): Promise<string> => run(GIT_BIN, ['-C', cwd, ...args], env);
  for (const [dir, owners] of [['worktrees', used.worktree], ['cleanroom', used.cleanRoom]] as const) {
    let names: string[];
    try {
      names = readdirSync(join(from, dir)).sort();
    } catch {
      continue; // not there
    }
    const base = real(join(from, dir));
    // the folder itself must be a real folder of this home too
    const top = lstatOrNull(join(from, dir));
    if (top === null || top.isSymbolicLink() || !real(join(from, dir)).startsWith(`${real(from)}${sep}`)) {
      out.push({ path: join(from, dir), removable: false, repo: null, reason: `${join(from, dir)} is a link, or not really inside the home: look at it by hand, or keep the old layout` });
      continue;
    }
    for (const name of names) {
      if (owners.has(name)) continue; // an agent has it: agentsInside says so
      const path = join(from, dir, name);
      const refuse = (reason: string, repo: string | null = null): void => void out.push({ path, removable: false, repo, reason });
      // a real folder of this home: a link (to a folder anywhere) is never followed or removed
      const info = lstatOrNull(path);
      if (info === null || info.isSymbolicLink() || !info.isDirectory() || !real(path).startsWith(`${base}${sep}`)) {
        refuse(`${path} is a link, or a folder that is not really inside ${join(from, dir)}: look at it, then move it away or delete it by hand, or keep the old layout`);
        continue;
      }
      const repo = await mainRepoOf(path, env);
      if (repo === null) {
        refuse(`${path} is not a git worktree: move it away or delete it, or keep the old layout`);
        continue;
      }
      const command = `git -C ${repo} worktree remove ${path}`;
      const branch = cleanRoomBranch(name);
      // what the WORKTREE has checked out decides, not the branch it is named after: a detached commit or another branch there is work that removing would lose
      const head = (await git(path, 'symbolic-ref', '-q', 'HEAD').catch(() => '')).trim();
      if (head !== `refs/heads/${branch}`) {
        refuse(`${path} has ${head === '' ? 'a detached HEAD' : `${head.replace('refs/heads/', '')} checked out`}, not ${branch}: look at what it holds, then run: ${command} (add --force to drop it)`, repo);
        continue;
      }
      if ((await git(path, 'status', '--porcelain').catch(() => 'x')).trim() !== '') {
        refuse(`${path} has changes that are not committed: look at them, then run: ${command} (add --force to drop them)`, repo);
        continue;
      }
      // fail closed, as the plain status above: a listing that cannot be made is not "nothing is ignored"
      const listing = await git(path, 'status', '--porcelain', '--ignored').catch(() => null);
      if (listing === null) {
        refuse(`${path}: git could not list its ignored files, so it is not known what removing would delete: look at it, then run: ${command} (add --force to drop it)`, repo);
        continue;
      }
      const ignored = listing.split('\n').filter((line) => line.startsWith('!! ') && !BUILD_DIRS.has(line.slice(3).split('/')[0] ?? ''));
      if (ignored.length > 0) {
        refuse(`${path} holds ignored files that removing would delete (${ignored.slice(0, 3).map((l) => l.slice(3)).join(', ')}${ignored.length > 3 ? ', ...' : ''}): keep what you need, then run: ${command} (add --force to drop them)`, repo);
        continue;
      }
      const tip = (await git(path, 'rev-parse', 'HEAD').catch(() => '')).trim();
      const merged = tip !== '' && (await git(repo, 'merge-base', '--is-ancestor', tip, 'HEAD').then(() => true, () => false));
      if (!merged) {
        refuse(`${path} is on ${branch}, which has commits that are not in the repository's checked-out branch: merge or push it, then run: ${command}`, repo);
        continue;
      }
      out.push({ path, removable: true, repo, reason: '' });
    }
  }
  return out;
}

/** What a move would do, and what stops it. Reads only. */
export async function planMigration(root: string, direction: Direction, options: PlanOptions): Promise<MigrationPlan> {
  const mainDir = join(root, ROOMS_DIR, MAIN_ROOM);
  const from = direction === 'forward' ? root : mainDir;
  const to = direction === 'forward' ? mainDir : root;
  const plan: MigrationPlan = { direction, from, to, entries: [], stays: [], problems: [], removes: [] };
  const problem = (reason: string): void => void plan.problems.push(reason);

  // what moves: the names of main's files that are there
  // `server.lock` stays out: a lock that no live process holds is a leftover, and the room at its new place makes its own
  for (const name of [...ROOM_STATE_FILES, ...RUN_FILES]) if (name !== 'server.lock' && lstatOrNull(join(from, name)) !== null) plan.entries.push(name);
  if (direction === 'forward') {
    const known = new Set<string>([...ROOM_STATE_FILES, ...SUPERVISOR_FILES, ...NESTED_FILES]);
    try {
      for (const name of readdirSync(root).sort()) if (!known.has(name) && !name.endsWith('.tmp')) plan.stays.push(name);
    } catch (error) {
      problem(`the home cannot be read: ${(error as Error).message.slice(0, 80)}`);
    }
  }
  if (plan.entries.length === 0) problem(`there is nothing of room main in ${from}`);

  // the destination: absent or empty, and nothing there under the names that would move
  const destination = direction === 'forward' ? lstatOrNull(mainDir) : null;
  if (direction === 'forward') {
    if (destination !== null && !destination.isDirectory()) problem(`${mainDir} exists and is not a folder`);
    else if (destination !== null && readdirSync(mainDir).length > 0) problem(`${mainDir} is not empty`);
  } else {
    for (const name of plan.entries) if (lstatOrNull(join(root, name)) !== null) problem(`${join(root, name)} is in the way: main's own ${name} would have to replace it`);
  }

  // the same filesystem (a rename, never a copy) and a folder we may write to
  try {
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
    const dev = statSync(root).dev;
    const rooms = lstatOrNull(join(root, ROOMS_DIR));
    if (rooms !== null && statSync(join(root, ROOMS_DIR)).dev !== dev) problem(`${join(root, ROOMS_DIR)} is on another filesystem than ${root}: a move is a rename and cannot cross it`);
    if (destination !== null && direction === 'forward' && destination.isDirectory() && statSync(mainDir).dev !== dev) problem(`${mainDir} is on another filesystem than ${root}: a move is a rename and cannot cross it`);
    for (const name of plan.entries) {
      const info = lstatOrNull(join(from, name));
      if (info !== null && info.dev !== dev) problem(`${join(from, name)} is on another filesystem (a mount?): a move is a rename and cannot cross it`);
    }
  } catch (error) {
    problem(`${root} cannot be changed by this user: ${(error as Error).message.slice(0, 80)}`);
  }

  // nothing of main may be in use
  if (options.running) {
    if (roomLockAlive(from)) problem(`room main is running (${join(from, 'server.lock')} names a live process)`);
    for (const socket of SOCKETS) if (await answers(join(from, socket))) problem(`${join(from, socket)} answers: room main, or its pty host with agents that are alive, is running`);
  }

  // an agent whose working folder would move, or an earlier half move
  // before anything is removed: a half-done journal refuses the whole thing
  const note = readMigration(root);
  if (note !== null && (note.state === 'moving' || note.state === 'undoing')) problem('an earlier move of room main is not finished');
  const agents = agentsInside(from);
  for (const reason of agents.problems) problem(reason);
  const leftovers = await leftoverFolders(from, agents.names, options.gitRun);
  for (const left of leftovers) {
    if (!left.removable) problem(left.reason);
    else plan.removes.push(left.path);
  }
  // a real move takes the safe ones away first, when nothing else stops it (a refused move changes nothing)
  if (options.clean === true && plan.problems.length === 0) {
    for (const left of leftovers) {
      const failed = left.repo === null ? 'not a worktree' : await removeWorktreeFolder(left.repo, left.path, process.env);
      if (failed !== null) problem(`${left.path} could not be removed (${failed.slice(0, 120)}): run: git -C ${left.repo ?? '<repository>'} worktree remove ${left.path}`);
    }
    for (const dir of ['worktrees', 'cleanroom']) {
      try {
        rmdirSync(join(from, dir)); // empty now, or not there
      } catch {
        // something is left in it
      }
    }
  }
  return plan;
}

/** Hooks for a test to stop a move half way (the crash) or to look at it. */
export interface MoveHooks {
  afterEach?(name: string): void;
}

/** One name from `from` to `to`: done when it is there and gone from here; an error when it is in both. */
function moveEntry(from: string, to: string, name: string): boolean {
  const source = join(from, name);
  const target = join(to, name);
  const here = lstatOrNull(source) !== null;
  const there = lstatOrNull(target) !== null;
  if (here && there) throw new RoomsError(`${name} is in ${from} and in ${to}: nothing was overwritten. Look at both and take one away`, 'conflict');
  if (!here) return false;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  renameSync(source, target);
  return true;
}

/** Runs the moves of a journal, then writes where main is, then leaves the note. Safe to call again after a crash. */
function perform(root: string, direction: Direction, entries: string[], hooks: MoveHooks, at: number, removed: string[] = []): number {
  const mainDir = join(root, ROOMS_DIR, MAIN_ROOM);
  const from = direction === 'forward' ? root : mainDir;
  const to = direction === 'forward' ? mainDir : root;
  mkdirSync(direction === 'forward' ? mainDir : root, { recursive: true, mode: 0o700 });
  let moved = 0;
  for (const name of entries) {
    if (moveEntry(from, to, name)) moved += 1;
    hooks.afterEach?.(name);
  }
  // the sockets of a room that is not running are leftovers (a live one stopped the plan): they would make the old place look in use
  for (const name of [...SOCKETS, 'run/room-token', 'server.lock']) rmSync(join(from, name), { force: true });
  if (direction === 'undo') {
    // the folders of main that are now empty go: an old home has no rooms/main
    for (const dir of [join(mainDir, 'run'), mainDir]) {
      try {
        rmdirSync(dir);
      } catch {
        // not empty, or not there
      }
    }
  }
  setMainHome(root, direction === 'forward' ? 'rooms/main' : '.'); // the marker, last
  if (direction === 'forward') writeMigration(root, { state: 'done', at, moved: entries.length, ...(removed.length === 0 ? {} : { removedWorktrees: removed }) });
  else clearMigration(root);
  return moved;
}

export type MigrationResult = { ok: true; moved: number; direction: Direction; removed?: string[] } | { ok: false; direction: Direction; problems: string[] };

/** Plans and, when nothing stops it, moves. The caller holds the supervisor lock. */
export async function migrate(root: string, direction: Direction, hooks: MoveHooks = {}, now: () => number = Date.now): Promise<MigrationResult> {
  const plan = await planMigration(root, direction, { running: true, clean: direction === 'forward' });
  if (plan.problems.length > 0) return { ok: false, direction, problems: plan.problems.slice(0, REASON_MAX) };
  writeMigration(root, { state: direction === 'forward' ? 'moving' : 'undoing', at: now(), entries: plan.entries });
  const moved = perform(root, direction, plan.entries, hooks, now(), plan.removes);
  return { ok: true, moved, direction, removed: plan.removes };
}

/** Finishes a move that a crash left half done (the journal is there). Returns null when there is none. */
export function resumeMigration(root: string, hooks: MoveHooks = {}, now: () => number = Date.now): MigrationResult | null {
  const note = readMigration(root);
  if (note === null || (note.state !== 'moving' && note.state !== 'undoing')) return null;
  const direction: Direction = note.state === 'moving' ? 'forward' : 'undo';
  const moved = perform(root, direction, note.entries, hooks, now());
  return { ok: true, moved, direction };
}

/** What the start of a supervisor does about the layout of an old home. */
export type StartupOutcome =
  | { did: 'nothing' }
  | { did: 'resumed'; direction: Direction; moved: number }
  | { did: 'migrated'; direction: Direction; moved: number; removed: string[] }
  | { did: 'skipped'; direction: Direction; problems: string[]; asked: boolean };

/**
 * At the start, before any room: finish a half move; do what the page asked (MIGRATE NOW, UNDO); and move an old home that has never been asked
 * about (no `main.home` on record). A move that is refused is NOT tried again by itself: the layout is recorded as it is, so the next start leaves
 * it alone, and the page shows why and offers MIGRATE NOW.
 */
export async function startupMigration(root: string, hooks: MoveHooks = {}, now: () => number = Date.now): Promise<StartupOutcome> {
  const resumed = resumeMigration(root, hooks, now);
  if (resumed !== null && resumed.ok) return { did: 'resumed', direction: resumed.direction, moved: resumed.moved };
  const note = readMigration(root);
  const recorded = recordedMainHome(root);
  let direction: Direction | null = null;
  if (note?.state === 'requested') direction = 'forward';
  else if (note?.state === 'undo-requested') direction = 'undo';
  else if (recorded === null && mainLayout(root) === '.' && note === null) direction = 'forward';
  if (direction === null) return { did: 'nothing' };
  const result = await migrate(root, direction, hooks, now);
  if (result.ok) return { did: 'migrated', direction, moved: result.moved, removed: result.removed ?? [] };
  if (direction === 'forward') {
    writeMigration(root, { state: 'skipped', at: now(), reasons: result.problems });
    setMainHome(root, '.');
  } else {
    writeMigration(root, { state: 'done', at: now(), moved: 0, undoReasons: result.problems });
  }
  return { did: 'skipped', direction, problems: result.problems, asked: note?.state === 'requested' || note?.state === 'undo-requested' };
}

export type { MainHome };
