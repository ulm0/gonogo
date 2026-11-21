// Rooms (docs/rooms-spec.md): the list of rooms, the commands, and the supervisor with stand-in rooms (test/fake-room.mjs).
// The real thing (built gonogo as the rooms) was tried by hand: docs/features/rooms.md, "What was seen".
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, mkdtempSync, symlinkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/server/cli.js';
import { recordedMainHome, NESTED_FILES, ROOM_STATE_FILES, SUPERVISOR_FILES, setMainHome, addRoom, loadRooms, mainLayout, MAIN_ROOM, recordMainHome, removeRoom, ROOMS_FILE, RoomsError, roomHome, SUPERVISOR_FILE, supervisorRunning } from '../src/server/rooms.js';
import { startGonogo } from '../src/server/cli.js';
import { PUSH_FILE } from '../src/server/push.js';
import { startSupervisor } from '../src/server/supervisor.js';
import { phone } from './push-phone.js';
import type { Supervisor } from '../src/server/supervisor.js';

const FAKE = new URL('./fake-room.mjs', import.meta.url).pathname;
let home: string;
let sup: Supervisor | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gng-rooms-'));
  // the tests below are of a home made before 0.9: room main's files are at the root (a room's own mission-log folder says so). A fresh home is in "the layout of room main".
  mkdirSync(join(home, 'mission-log'));
  setMainHome(home, '.'); // and it has been asked: it stays (a home that was never asked is moved at the start, see test/mainmigrate.test.ts)
});
afterEach(async () => {
  await sup?.stop();
  sup = null;
  rmSync(home, { recursive: true, force: true });
});

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000, what = 'a condition'): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('rooms.json', () => {
  it('has main, which is the root home, and nothing else in a home that never had rooms', () => {
    expect(loadRooms(home)).toEqual([{ id: MAIN_ROOM, name: 'Main', autostart: true }]);
    expect(roomHome(home, MAIN_ROOM)).toBe(home);
    expect(roomHome(home, 'team')).toBe(join(home, 'rooms', 'team'));
  });

  it('adds a room (0600, atomic), lists it after main, and refuses a bad, duplicate or reserved id', () => {
    const room = addRoom(home, 'team-a', '  Team\tA  ');
    expect(room).toEqual({ id: 'team-a', name: 'Team A', autostart: true });
    expect(statSync(join(home, ROOMS_FILE)).mode & 0o777).toBe(0o600);
    expect(loadRooms(home).map((r) => r.id)).toEqual(['main', 'team-a']);
    for (const bad of ['Team', '1a', 'a/b', '..', 'main', 'team-a', '', undefined]) expect(() => addRoom(home, bad), String(bad)).toThrow(RoomsError);
  });

  it('removes a room from the list only: its folder and files stay, and main cannot be removed', () => {
    addRoom(home, 'gone');
    const folder = roomHome(home, 'gone');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'agents.json'), '{}');
    removeRoom(home, 'gone');
    expect(loadRooms(home).map((r) => r.id)).toEqual(['main']);
    expect(readFileSync(join(folder, 'agents.json'), 'utf8')).toBe('{}');
    expect(() => removeRoom(home, 'main')).toThrow(/home itself/);
    expect(() => removeRoom(home, 'nope')).toThrow(/no room/);
  });

  it('a damaged file THROWS (it is not "no rooms"); a missing file is just main; odd entries and names are cleaned', () => {
    for (const bad of ['{nope', '', '[]', '{"rooms": 5}', 'null']) {
      writeFileSync(join(home, ROOMS_FILE), bad);
      expect(() => loadRooms(home), bad).toThrow(RoomsError);
      expect(() => addRoom(home, 'x'), bad).toThrow(/damaged/);
    }
    rmSync(join(home, ROOMS_FILE));
    expect(loadRooms(home).map((r) => r.id)).toEqual(['main']);
    writeFileSync(join(home, ROOMS_FILE), JSON.stringify({ version: 1, rooms: [null, 5, { id: '../x' }, { id: 'ok', name: 'a‮b\nc' }, { id: 'ok' }, { id: 'main' }] }));
    expect(loadRooms(home)).toEqual([
      { id: 'main', name: 'Main', autostart: true },
      { id: 'ok', name: 'a b c', autostart: true },
    ]);
  });
});

describe('gonogo rooms (the command line)', () => {
  it('parses serve, add, list and remove', () => {
    // plain gonogo is the supervisor; `gonogo rooms` alone is the same, for one release
    expect(parseArgs([])).toEqual({ kind: 'run', options: {} });
    expect(parseArgs(['rooms'])).toEqual({ kind: 'run', options: {} });
    expect(parseArgs(['rooms', '--port', '9000'])).toEqual({ kind: 'run', options: { port: 9000 } });
    expect(parseArgs(['--port', '9000', '--pty-host', '--no-update-check', '--seed-claude'])).toEqual({ kind: 'run', options: { port: 9000, ptyHost: true, updateCheck: false, seed: true } });
    // the hidden entry of a room
    expect(parseArgs(['__room', '--home', '/h', '--port', '0', '--exit-with-stdin'])).toEqual({ kind: 'room', options: { home: '/h', port: 0, exitWithStdin: true, roomChild: true } });
    expect(parseArgs(['token', 'rotate'])).toEqual({ kind: 'token' });
    expect(parseArgs(['token', 'rotate', '--home', '/h'])).toEqual({ kind: 'token', home: '/h' });
    expect(parseArgs(['token'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['token', 'show'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['rooms', 'add', 'team', '--name', 'The team'])).toEqual({ kind: 'rooms', action: 'add', id: 'team', name: 'The team' });
    expect(parseArgs(['rooms', 'list', '--home', '/h'])).toEqual({ kind: 'rooms', action: 'list', home: '/h' });
    expect(parseArgs(['rooms', 'remove', 'team'])).toEqual({ kind: 'rooms', action: 'remove', id: 'team' });
    expect(parseArgs(['rooms', 'add'])).toMatchObject({ kind: 'error', message: 'rooms add needs a room id' });
    expect(parseArgs(['rooms', 'list', 'x'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['rooms', '--nope'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['rooms', 'migrate-main'])).toEqual({ kind: 'migrate-main', mode: 'move' });
    expect(parseArgs(['rooms', 'migrate-main', '--dry-run', '--home', '/h'])).toEqual({ kind: 'migrate-main', mode: 'dry-run', home: '/h' });
    expect(parseArgs(['rooms', 'migrate-main', '--undo'])).toEqual({ kind: 'migrate-main', mode: 'undo' });
    for (const bad of [['--undo', '--dry-run'], ['--dry-run', '--undo'], ['--nope'], ['x'], ['--home']]) expect(parseArgs(['rooms', 'migrate-main', ...bad]), bad.join(' ')).toMatchObject({ kind: 'error' });
    // plain gonogo stays one room
    expect(parseArgs([])).toEqual({ kind: 'run', options: {} });
    // the flag a room is started with
    expect(parseArgs(['--exit-with-stdin'])).toEqual({ kind: 'run', options: { exitWithStdin: true } });
  });
});

async function supervise(): Promise<Supervisor> {
  sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '', GONOGO_PORT: '1', GONOGO_ALLOWED_HOSTS: 'x' } });
  return sup;
}
const api = (s: Supervisor, path: string, token: string | null = s.directorToken, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${s.port}${path}`, { ...init, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...init.headers } });
const listed = async (s: Supervisor): Promise<Array<{ id: string; state: string; agents: number | null; needsYou: number | null; note: string | null }>> =>
  ((await (await api(s, '/api/rooms')).json()) as { rooms: Array<{ id: string; state: string; agents: number | null; needsYou: number | null; note: string | null }> }).rooms;

describe('the layout of room main', () => {
  let fresh: string;
  beforeEach(() => {
    fresh = mkdtempSync(join(tmpdir(), 'gng-fresh-'));
  });
  afterEach(async () => {
    await sup?.stop();
    sup = null;
    rmSync(fresh, { recursive: true, force: true });
  });
  const startFresh = async (dir: string): Promise<Supervisor> => {
    sup = await startSupervisor({ home: dir, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '', GONOGO_PORT: '1', GONOGO_ALLOWED_HOSTS: 'x' } });
    return sup;
  };

  it('a fresh home puts main in rooms/main like any other room; the supervisor\'s own files stay at the root', () => {
    expect(mainLayout(fresh)).toBe('rooms/main');
    expect(roomHome(fresh, MAIN_ROOM)).toBe(join(fresh, 'rooms', 'main'));
    expect(roomHome(fresh, 'team')).toBe(join(fresh, 'rooms', 'team'));
    expect(existsSync(join(fresh, ROOMS_FILE))).toBe(false); // deciding writes nothing
    recordMainHome(fresh);
    expect(JSON.parse(readFileSync(join(fresh, ROOMS_FILE), 'utf8'))).toEqual({ version: 1, main: { home: 'rooms/main' }, rooms: [] });
    expect(statSync(join(fresh, ROOMS_FILE)).mode & 0o777).toBe(0o600);
    expect(loadRooms(fresh).map((r) => r.id)).toEqual(['main']);
  });

  it('the layout is on record: files at the root later do not move main, and every save keeps it', () => {
    recordMainHome(fresh);
    writeFileSync(join(fresh, 'agents.json'), '{}');
    mkdirSync(join(fresh, 'mission-log'));
    expect(mainLayout(fresh)).toBe('rooms/main');
    addRoom(fresh, 'team');
    removeRoom(fresh, 'team');
    expect(JSON.parse(readFileSync(join(fresh, ROOMS_FILE), 'utf8'))).toMatchObject({ main: { home: 'rooms/main' } });
    expect(roomHome(fresh, MAIN_ROOM)).toBe(join(fresh, 'rooms', 'main'));
  });

  it('a home that has a room\'s files at the root keeps main there, and nothing is written to it', () => {
    for (const name of ['agents.json', 'messages.jsonl', 'run-state.json', 'server.lock']) {
      const old = mkdtempSync(join(tmpdir(), 'gng-old-'));
      try {
        writeFileSync(join(old, name), '');
        expect(mainLayout(old), name).toBe('.');
        expect(roomHome(old, MAIN_ROOM), name).toBe(old);
        recordMainHome(old);
        expect(existsSync(join(old, ROOMS_FILE)), name).toBe(false);
      } finally {
        rmSync(old, { recursive: true, force: true });
      }
    }
    // the supervisor's own files are not a room's: they do not make a fresh home an old one
    for (const name of ['auth.json', 'token', 'setup-token', 'push.json', 'rooms-supervisor.json']) writeFileSync(join(fresh, name), '');
    mkdirSync(join(fresh, 'run'));
    writeFileSync(join(fresh, 'run', 'api.sock'), '');
    writeFileSync(join(fresh, 'run', 'supervisor.lock'), '');
    expect(mainLayout(fresh)).toBe('rooms/main');
  });

  it('after a rollback and a room edit by an older build (no record, an empty main at the root), the real main in rooms/main is still found', () => {
    recordMainHome(fresh);
    mkdirSync(join(fresh, 'rooms', 'main'), { recursive: true });
    writeFileSync(join(fresh, 'rooms', 'main', 'agents.json'), '{}');
    // the older build: a new main at the root, and a rooms.json it saved without the record
    writeFileSync(join(fresh, 'agents.json'), '{}');
    mkdirSync(join(fresh, 'mission-log'));
    writeFileSync(join(fresh, ROOMS_FILE), JSON.stringify({ version: 1, rooms: [{ id: 'team', name: 'Team', autostart: true }] }));
    expect(mainLayout(fresh)).toBe('rooms/main');
    expect(roomHome(fresh, MAIN_ROOM)).toBe(join(fresh, 'rooms', 'main'));
    // an empty rooms/main (nothing in it) does not take an old home's place
    const old = mkdtempSync(join(tmpdir(), 'gng-old-'));
    try {
      mkdirSync(join(old, 'rooms', 'main'), { recursive: true });
      writeFileSync(join(old, 'agents.json'), '{}');
      expect(mainLayout(old)).toBe('.');
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });

  it('with no record, a finished move (the note says done) keeps main in rooms/main even when the older build that dropped the record made files at the root and rooms/main holds little', () => {
    mkdirSync(join(fresh, 'rooms', 'main'), { recursive: true });
    writeFileSync(join(fresh, 'main-migration.json'), JSON.stringify({ version: 1, state: 'done', at: 1, moved: 3 }));
    writeFileSync(join(fresh, 'agents.json'), '{}'); // the older build's empty main
    writeFileSync(join(fresh, ROOMS_FILE), JSON.stringify({ version: 1, rooms: [] }));
    expect(mainLayout(fresh)).toBe('rooms/main');
    // no note and nothing in rooms/main: the root's files are main's
    rmSync(join(fresh, 'main-migration.json'));
    expect(mainLayout(fresh)).toBe('.');
  });

  it('what agents proposed is a room\'s: it makes a home old, so a move keeps it; the Knowledge store is the supervisor\'s and says nothing', () => {
    const old = mkdtempSync(join(tmpdir(), 'gng-old-'));
    try {
      mkdirSync(join(old, 'knowledge'));
      mkdirSync(join(old, 'knowledge-proposals'));
      expect(ROOM_STATE_FILES).toContain('knowledge-proposals');
      expect(SUPERVISOR_FILES).toContain('knowledge');
      expect(ROOM_STATE_FILES).not.toContain('knowledge');
      rmSync(join(old, 'knowledge-proposals'), { recursive: true });
      // the store alone is not a room's file: no layout is read from it
      expect(mainLayout(old)).toBe('rooms/main');
      mkdirSync(join(old, 'knowledge-proposals'));
      expect(mainLayout(old)).toBe('.');
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });

  it('every file a room can hold alone makes a home old (keys.json, room-keys.json, payload-defaults.json, autoupdate.json, triggers.jsonl ...)', () => {
    for (const name of ['keys.json', 'room-keys.json', 'payload-defaults.json', 'autoupdate.json', 'triggers.jsonl', ...ROOM_STATE_FILES]) {
      const old = mkdtempSync(join(tmpdir(), 'gng-old-'));
      try {
        writeFileSync(join(old, name), '');
        expect(mainLayout(old), name).toBe('.');
      } finally {
        rmSync(old, { recursive: true, force: true });
      }
    }
  });

  it('cannot drift: every *_FILE and *_DIR name in src/ is a room\'s, the supervisor\'s, or lives in a folder', () => {
    const known = new Set([...ROOM_STATE_FILES, ...SUPERVISOR_FILES, ...NESTED_FILES]);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const seen = new Set<string>();
    for (const file of [...walk(new URL('../src/server', import.meta.url).pathname), ...walk(new URL('../src/shared', import.meta.url).pathname)]) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bconst [A-Z][A-Z0-9_]*_(?:FILE|DIR)(?::\s*string)? = '([^']+)'/g)) seen.add(m[1] as string);
    }
    expect(seen.size).toBeGreaterThan(40);
    expect([...seen].filter((name) => !known.has(name))).toEqual([]);
    expect([...ROOM_STATE_FILES].filter((n) => SUPERVISOR_FILES.includes(n) || NESTED_FILES.includes(n))).toEqual([]);
  });

  it('an old home with rooms.json and no layout on record stays at the root, and saving the list records it', () => {
    writeFileSync(join(fresh, 'agents.json'), '{}');
    writeFileSync(join(fresh, ROOMS_FILE), JSON.stringify({ version: 1, rooms: [{ id: 'team', name: 'Team', autostart: true }] }));
    expect(mainLayout(fresh)).toBe('.');
    addRoom(fresh, 'more');
    expect(JSON.parse(readFileSync(join(fresh, ROOMS_FILE), 'utf8'))).toMatchObject({ main: { home: '.' } });
    expect(roomHome(fresh, MAIN_ROOM)).toBe(fresh);
  });

  it('a layout that is not one of the two is a damaged file, never a path to follow', () => {
    for (const bad of ['../x', '/etc', 'rooms/team', '', 5, null, {}]) {
      writeFileSync(join(fresh, ROOMS_FILE), JSON.stringify({ version: 1, main: { home: bad }, rooms: [] }));
      expect(() => mainLayout(fresh), String(JSON.stringify(bad))).toThrow(RoomsError);
      expect(() => roomHome(fresh, MAIN_ROOM)).toThrow(/damaged/);
      expect(() => loadRooms(fresh)).toThrow(RoomsError);
    }
    writeFileSync(join(fresh, ROOMS_FILE), JSON.stringify({ version: 1, main: 'rooms/main', rooms: [] }));
    expect(() => mainLayout(fresh)).toThrow(RoomsError);
  });

  it('the supervisor starts main in rooms/main on a fresh home, records it, and serves /r/main/ from there', async () => {
    addRoom(fresh, 'team', 'Team'); // `gonogo rooms add` on a fresh home already records the layout
    expect(JSON.parse(readFileSync(join(fresh, ROOMS_FILE), 'utf8'))).toMatchObject({ main: { home: 'rooms/main' } });
    rmSync(join(fresh, ROOMS_FILE));
    addRoom(fresh, 'team', 'Team');
    rmSync(join(fresh, ROOMS_FILE), { force: true });
    writeFileSync(join(fresh, ROOMS_FILE), JSON.stringify({ version: 1, rooms: [{ id: 'team', name: 'Team', autostart: true }] })); // a rooms.json of an older build: no layout on record
    const s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const mainDir = join(fresh, 'rooms', 'main');
    expect(JSON.parse(readFileSync(join(mainDir, 'started-with'), 'utf8'))).toMatchObject({ home: mainDir });
    expect(lstatSync(join(mainDir, 'run', 'room.sock')).isSocket()).toBe(true);
    expect(lstatSync(join(fresh, 'rooms', 'team', 'run', 'room.sock')).isSocket()).toBe(true);
    // nothing of a room at the root; the supervisor's own files are there
    for (const name of ['started-with', 'dump.json', 'starts', 'agents.json']) expect(existsSync(join(fresh, name)), name).toBe(false);
    expect(existsSync(join(fresh, 'run', 'room.sock'))).toBe(false);
    expect(lstatSync(join(fresh, 'run', 'api.sock')).isSocket()).toBe(true);
    expect(readFileSync(join(fresh, 'token'), 'utf8').trim()).toBe(s.directorToken);
    expect(existsSync(join(mainDir, 'token'))).toBe(false);
    expect(JSON.parse(readFileSync(join(fresh, ROOMS_FILE), 'utf8'))).toMatchObject({ main: { home: 'rooms/main' } });
    expect((await listed(s)).map((r) => r.id)).toEqual(['main', 'team']);
    for (const id of ['main', 'team']) {
      const res = await api(s, `/r/${id}/api/state`);
      expect(res.status, id).toBe(200);
      expect(await (await api(s, `/r/${id}/`, null)).text()).toContain(roomHome(fresh, id));
    }
  });

  it('a fresh home with no rooms.json at all gets main in rooms/main too', async () => {
    const s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    expect(existsSync(join(fresh, 'rooms', 'main', 'run', 'room.sock'))).toBe(true);
    expect((await api(s, '/r/main/api/state')).status).toBe(200);
  });

  it('an old home that was never asked is moved into rooms/main at the start, before any room: the room starts there, /r/main/ answers, the layout is on the list', async () => {
    writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
    writeFileSync(join(fresh, 'messages.jsonl'), '{}\n');
    const s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const mainDir = join(fresh, 'rooms', 'main');
    expect(existsSync(join(fresh, 'agents.json'))).toBe(false);
    expect(existsSync(join(mainDir, 'agents.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(mainDir, 'started-with'), 'utf8'))).toMatchObject({ home: mainDir });
    expect(existsSync(join(fresh, 'started-with'))).toBe(false);
    expect((await api(s, '/r/main/api/state')).status).toBe(200);
    expect(await (await api(s, '/r/main/', null)).text()).toContain(mainDir);
    const body = (await (await api(s, '/api/rooms')).json()) as { layout: { main: string; path: string; migration: { state: string; moved: number } | null } };
    expect(body.layout).toMatchObject({ main: 'rooms/main', path: mainDir, migration: { state: 'done', moved: 2 } });
    expect(JSON.parse(readFileSync(join(fresh, ROOMS_FILE), 'utf8'))).toMatchObject({ main: { home: 'rooms/main' } });
  });

  it('a move that is refused leaves the home as it is, starts main at the root, and the list says why; the next start leaves it alone', async () => {
    writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [{ name: 'wt', dir: '/p', worktree: {} }] }));
    let s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    expect(existsSync(join(fresh, 'agents.json'))).toBe(true);
    expect(existsSync(join(fresh, 'rooms', 'main'))).toBe(false);
    expect(existsSync(join(fresh, 'started-with'))).toBe(true);
    const view = async (): Promise<{ layout: { main: string; migration: { state: string; reasons: string[] } | null } }> => (await (await api(s, '/api/rooms')).json()) as never;
    let got = await view();
    expect(got.layout).toMatchObject({ main: '.', migration: { state: 'skipped' } });
    expect(got.layout.migration?.reasons.join('\n')).toContain('agent wt ');
    await s.stop();
    sup = null;
    writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
    s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    expect(existsSync(join(fresh, 'agents.json'))).toBe(true);
    got = await view();
    expect(got.layout.main).toBe('.');
  });

  it('MIGRATE NOW and UNDO from the list are acted on at the next start, with the same checks; CANCEL and DISMISS only do less', async () => {
    writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [{ name: 'wt', dir: '/p', worktree: {} }] }));
    let s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const post = (action: unknown): Promise<Response> => api(s, '/api/rooms/main/migrate', s.directorToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
    const layout = async (): Promise<{ main: string; migration: { state: string } | null }> => ((await (await api(s, '/api/rooms')).json()) as { layout: never }).layout;
    // the dry run: what would move now, written nowhere
    const dry = (await (await api(s, '/api/rooms/main/migrate')).json()) as { direction: string; entries: string[]; problems: string[] };
    expect(dry).toMatchObject({ direction: 'forward', entries: expect.arrayContaining(['agents.json']) });
    expect(dry.problems.join()).toContain('agent wt ');
    expect((await post('nope')).status).toBe(400);
    expect((await post('undo')).status).toBe(409); // main is at the root: nothing to undo
    expect((await post('cancel')).status).toBe(409);
    expect((await post('request')).status).toBe(200);
    expect(await layout()).toMatchObject({ main: '.', migration: { state: 'requested' } });
    expect((await post('cancel')).status).toBe(200);
    expect((await layout()).migration).toBeNull();
    // asked, with the reason gone: done at the next start
    writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
    expect((await post('request')).status).toBe(200);
    await s.stop();
    sup = null;
    s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    expect(await layout()).toMatchObject({ main: 'rooms/main', migration: { state: 'done' } });
    expect(existsSync(join(fresh, 'rooms', 'main', 'agents.json'))).toBe(true);
    expect((await post('request')).status).toBe(409); // already there
    expect((await post('dismiss')).status).toBe(200);
    expect((await layout()).migration).toBeNull();
    // and back
    expect((await post('undo')).status).toBe(200);
    await s.stop();
    sup = null;
    s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    expect((await layout()).main).toBe('.');
    expect(existsSync(join(fresh, 'agents.json'))).toBe(true);
    expect(existsSync(join(fresh, 'rooms', 'main', 'agents.json'))).toBe(false); // (the stand-in room's own scratch files may stay in rooms/main: they are nobody's)
    // the route is the Director's: no token, no answer
    expect((await api(s, '/api/rooms/main/migrate', null)).status).toBe(401);
    expect((await api(s, '/api/rooms/team/migrate')).status).toBe(404);
  });

  it('DISMISS only clears a skipped or done note: never a journal, nor a request that waits', async () => {
    const s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const post = (action: string): Promise<Response> => api(s, '/api/rooms/main/migrate', s.directorToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
    const file = join(fresh, 'main-migration.json');
    for (const note of [
      { state: 'moving', at: 1, entries: ['agents.json'] },
      { state: 'undoing', at: 1, entries: ['agents.json'] },
      { state: 'requested', at: 1 },
      { state: 'undo-requested', at: 1 },
    ]) {
      writeFileSync(file, JSON.stringify({ version: 1, ...note }));
      expect((await post('dismiss')).status, note.state).toBe(409);
      expect(JSON.parse(readFileSync(file, 'utf8')), note.state).toMatchObject({ state: note.state });
    }
    for (const note of [{ state: 'skipped', at: 1, reasons: ['x'] }, { state: 'done', at: 1, moved: 1 }]) {
      writeFileSync(file, JSON.stringify({ version: 1, ...note }));
      expect((await post('dismiss')).status, note.state).toBe(200);
      expect(existsSync(file), note.state).toBe(false);
    }
    expect((await post('dismiss')).status).toBe(409); // no note
  });

  it('a move that was refused tells main: a notice when nobody asked, an ALERT (inbox and phone) when the Director pressed MIGRATE NOW', async () => {
    const roster = JSON.stringify({ version: 1, agents: [{ name: 'wt', dir: '/p', worktree: {} }] });
    writeFileSync(join(fresh, 'agents.json'), roster);
    let s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    await until(() => existsSync(join(fresh, 'notices')));
    expect(readFileSync(join(fresh, 'notices'), 'utf8')).toContain('stays at the root');
    expect(existsSync(join(fresh, 'alerts'))).toBe(false);
    await s.stop();
    sup = null;
    rmSync(join(fresh, 'notices'));
    writeFileSync(join(fresh, 'main-migration.json'), JSON.stringify({ version: 1, state: 'requested', at: 1 }));
    s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    await until(() => existsSync(join(fresh, 'alerts')));
    expect(readFileSync(join(fresh, 'alerts'), 'utf8')).toContain('stays at the root');
    expect(existsSync(join(fresh, 'notices'))).toBe(false);
  });

  it('a start after a crash in the middle of a move finishes it before any room starts', async () => {
    writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
    writeFileSync(join(fresh, 'messages.jsonl'), '{}\n');
    mkdirSync(join(fresh, 'rooms', 'main'), { recursive: true });
    renameSync(join(fresh, 'messages.jsonl'), join(fresh, 'rooms', 'main', 'messages.jsonl')); // the first file had moved
    writeFileSync(join(fresh, 'main-migration.json'), JSON.stringify({ version: 1, state: 'moving', at: 1, entries: ['agents.json', 'messages.jsonl'] }));
    const s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    expect(existsSync(join(fresh, 'agents.json'))).toBe(false);
    expect(existsSync(join(fresh, 'rooms', 'main', 'agents.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(fresh, ROOMS_FILE), 'utf8'))).toMatchObject({ main: { home: 'rooms/main' } });
  });

  describe('gonogo rooms migrate-main', () => {
    const cli = async (...args: string[]): Promise<{ out: string; err: string; code: number | undefined }> => {
      const { main } = await import('../src/server/cli.js');
      let out = '';
      let err = '';
      let code: number | undefined;
      const w = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => ((out += String(chunk)), true));
      const e = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => ((err += String(chunk)), true));
      const x = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void (code ??= c)) as never);
      try {
        await main(['rooms', 'migrate-main', ...args, '--home', fresh], { PATH: process.env.PATH });
      } finally {
        w.mockRestore();
        e.mockRestore();
        x.mockRestore();
      }
      return { out, err, code };
    };

    it('--dry-run says what would move and what stays, and writes nothing; it says what stops it', async () => {
      writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
      mkdirSync(join(fresh, 'img'));
      const before = readdirSync(fresh).sort();
      const ok = await cli('--dry-run');
      expect(ok.code).toBe(0);
      expect(ok.out).toContain('would move 1 of room main');
      expect(ok.out).toContain('  agents.json');
      expect(ok.out).toContain('stay where they are');
      expect(ok.out).toContain('img');
      expect(ok.out).toContain('nothing stops it');
      expect(readdirSync(fresh).sort()).toEqual(before);
      writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [{ name: 'wt', dir: '/p', worktree: {} }] }));
      const refused = await cli('--dry-run');
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('would NOT be done now');
      expect(refused.out).toContain('agent wt ');
    });

    it('moves, and --undo moves back; each says what it did, and the wrong one says there is nothing to do', async () => {
      writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
      expect((await cli('--undo')).err).toContain('nothing to undo');
      const moved = await cli();
      expect(moved.code).toBe(0);
      expect(moved.out).toContain('moved 1 of room main');
      expect(existsSync(join(fresh, 'rooms', 'main', 'agents.json'))).toBe(true);
      const again = await cli();
      expect(again.code).toBe(1);
      expect(again.err).toContain('already lives in rooms/main');
      const back = await cli('--undo');
      expect(back.code).toBe(0);
      expect(existsSync(join(fresh, 'agents.json'))).toBe(true);
      expect(existsSync(join(fresh, 'rooms', 'main'))).toBe(false);
      expect(recordedMainHome(fresh)).toBe('.');
    });

    it('refuses while gonogo runs for the home (the supervisor lock), and names the page\'s keys', async () => {
      writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
      const s = await startFresh(fresh); // an old home: the start moved it; ask for the move back while it runs
      await until(async () => (await listed(s)).every((r) => r.state === 'running'));
      const busy = await cli('--undo');
      expect(busy.code).toBe(1);
      expect(busy.err).toContain('gonogo is running for this home');
      expect(busy.err).toContain('UNDO');
      expect(existsSync(join(fresh, 'rooms', 'main', 'agents.json'))).toBe(true);
    });
  });

  it('a damaged journal stops the start with the reason, and nothing is moved', async () => {
    writeFileSync(join(fresh, 'agents.json'), JSON.stringify({ version: 1, agents: [] }));
    writeFileSync(join(fresh, 'main-migration.json'), '{nope');
    await expect(startFresh(fresh)).rejects.toThrow(/main-migration.json is damaged/);
    expect(existsSync(join(fresh, 'agents.json'))).toBe(true);
    sup = null;
  });

  it('a damaged rooms.json later does not move main under a running supervisor', async () => {
    const s = await startFresh(fresh);
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    writeFileSync(join(fresh, ROOMS_FILE), '{nope');
    await new Promise((r) => setTimeout(r, 2500));
    expect((await listed(s)).map((r) => [r.id, r.state])).toEqual([['main', 'running']]);
    expect((await api(s, '/r/main/api/state')).status).toBe(200);
  }, 30_000);
});

describe('the supervisor', () => {
  it('starts main (the root home) and every listed room, each in its own home with its own token, and lists them', async () => {
    addRoom(home, 'team', 'Team');
    const s = await supervise();
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const rooms = await listed(s);
    expect(rooms.map((r) => r.id)).toEqual(['main', 'team']);
    expect(rooms[0]).toMatchObject({ agents: 2, needsYou: 1, working: 1, lastActivity: 1_700_000_900_000, tabName: 'Fake tab', costToday: 1.5 });
    // the room's own settings, not the supervisor's
    const main = JSON.parse(readFileSync(join(home, 'started-with'), 'utf8')) as { args: string[]; home: string; port: string | null; supervisor: string | null; env: string[] };
    expect(main.home).toBe(home);
    expect(main.port).toBeNull();
    expect(main.args).toEqual(expect.arrayContaining(['--home', home, '--port', '0', '--host', '127.0.0.1']));
    expect(main.args).not.toContain('--no-update-check');
    const team = JSON.parse(readFileSync(join(home, 'rooms', 'team', 'started-with'), 'utf8')) as { args: string[] };
    expect(team.args).toContain('--no-update-check');
    // one browser token (a fresh install with no account), the Director's <home>/token; a room has none, only its own socket (docs/login-spec.md R8)
    for (const folder of [home, join(home, 'rooms', 'team')]) expect(lstatSync(join(folder, 'run', 'room.sock')).isSocket()).toBe(true);
    expect(existsSync(join(home, 'run', 'room-token'))).toBe(false);
    expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(s.directorToken);
    expect(statSync(join(home, 'token')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, 'rooms', 'team', 'token'))).toBe(false);
    // what the supervisor tells a room: who it is, and nothing of the Director token
    expect(main).toMatchObject({ supervisor: String(process.pid), env: [] });
    expect(main.args[0]).toBe('__room');
  });

  it('the list needs the Director token; a room\'s own token is not enough', async () => {
    const s = await supervise();
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    expect((await api(s, '/api/rooms', null)).status).toBe(401);
    expect((await api(s, '/api/rooms', 'f'.repeat(64))).status).toBe(401);
    const page = await api(s, '/rooms', null);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain(s.directorToken);
    expect(page.headers.get('content-security-policy')).toMatch(/default-src 'none'; script-src 'sha256-/);
  });

  it('reaches each room only through its own prefix, with the room\'s token swapped in, and two rooms do not mix', async () => {
    addRoom(home, 'team');
    const s = await supervise();
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    for (const id of ['main', 'team']) {
      const res = await api(s, `/r/${id}/api/state`);
      expect(res.status, id).toBe(200);
      expect((await res.json()) as { agents: unknown[] }).toMatchObject({ agents: [{ name: 'ana' }, { name: 'ben' }] });
      expect(await (await api(s, `/r/${id}/`, null)).text()).toContain(roomHome(home, id));
    }
    // a token that is not the Director's opens nothing
    expect((await api(s, '/r/team/api/state', 'e'.repeat(64))).status).toBe(401);
    expect((await api(s, '/api/state', readFileSync(join(home, 'token'), 'utf8').trim())).status).toBe(200);
    expect((await api(s, '/r/main/api/state', null)).status).toBe(401);
  });

  it('a room that crashes is started again, and the others go on', async () => {
    addRoom(home, 'flaky');
    const marker = join(home, 'crash-marker');
    sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '', FAKE_ROOM_CRASH_ONCE: marker } });
    const s = sup;
    // main also sees the variable: the first room to start takes the marker and crashes once
    await until(() => existsSync(marker), 10_000, 'the crash');
    await until(async () => (await listed(s)).every((r) => r.state === 'running'), 20_000, 'both rooms running again');
    expect((await api(s, '/r/main/api/state')).status).toBe(200);
    expect((await api(s, '/r/flaky/api/state')).status).toBe(200);
  }, 40_000);

  it('notices a room added or removed in rooms.json, and a removed room is stopped but keeps its files', async () => {
    const s = await supervise();
    await until(async () => (await listed(s)).length === 1 && (await listed(s))[0]?.state === 'running');
    addRoom(home, 'late');
    await until(async () => (await listed(s)).some((r) => r.id === 'late' && r.state === 'running'), 15_000, 'the new room');
    const folder = roomHome(home, 'late');
    removeRoom(home, 'late');
    await until(async () => !(await listed(s)).some((r) => r.id === 'late'), 15_000, 'the room to leave the list');
    await until(() => existsSync(join(folder, 'stopped')), 15_000, 'its graceful stop');
    expect(existsSync(join(folder, 'starts'))).toBe(true);
    expect((await api(s, '/r/late/api/state')).status).toBe(404);
  }, 40_000);

  it('the list page wears the stylesheet of the built client, served from /rooms/assets/ for css and fonts only', async () => {
    const client = join(home, 'client');
    mkdirSync(join(client, 'assets'), { recursive: true });
    writeFileSync(join(client, 'index.html'), '<html><head><link rel="stylesheet" crossorigin href="./assets/index-abc123.css"></head></html>');
    writeFileSync(join(client, 'assets', 'index-abc123.css'), '.tile{color:red}');
    writeFileSync(join(client, 'assets', 'secret.txt'), 'no');
    // a symlink named like a stylesheet that points at the Director token must not be followed
    symlinkSync(join(home, 'token'), join(client, 'assets', 'linked.css'));
    symlinkSync(client, join(client, 'assets', 'dir.css'));
    sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '' }, staticDir: client });
    const s = sup;
    const token = s.directorToken;
    const html = await (await api(s, '/rooms', null)).text();
    expect(html).toContain('<link rel="stylesheet" href="/rooms/assets/index-abc123.css">');
    expect(html).toMatch(/class="topbar"/);
    expect(html).toContain('src="/rooms/lockup.svg"');
    const css = await api(s, '/rooms/assets/index-abc123.css', null);
    expect([css.status, css.headers.get('content-type')]).toEqual([200, 'text/css']);
    expect(await css.text()).toBe('.tile{color:red}');
    for (const path of ['/rooms/assets/linked.css', '/rooms/assets/dir.css', '/rooms/assets/secret.txt', '/rooms/assets/nope.css', '/rooms/assets/..%2findex.html', '/rooms/assets/../index.html', '/rooms/assets/']) expect([400, 404], path).toContain((await api(s, path, null)).status);
    expect((await api(s, '/rooms', null)).headers.get('content-security-policy')).toMatch(/style-src 'self' 'sha256-/);
    expect(await (await api(s, '/rooms/assets/linked.css', null)).text()).not.toContain(token);
  });

  it('without a built client the list page still works, with plain styles', async () => {
    const s = await supervise();
    const html = await (await api(s, '/rooms', null)).text();
    expect(html).not.toContain('rel="stylesheet"');
    expect((await api(s, '/rooms/assets/x.css', null)).status).toBe(404);
  });

  it('a damaged rooms.json stops nothing: every room keeps running, and the list is read again when the file is fixed', async () => {
    addRoom(home, 'team');
    const s = await supervise();
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const good = readFileSync(join(home, 'rooms.json'), 'utf8');
    writeFileSync(join(home, 'rooms.json'), '{"rooms": [{');
    await new Promise((r) => setTimeout(r, 5000));
    expect((await listed(s)).map((r) => [r.id, r.state])).toEqual([['main', 'running'], ['team', 'running']]);
    expect(existsSync(join(home, 'rooms', 'team', 'stopped'))).toBe(false);
    writeFileSync(join(home, 'rooms.json'), JSON.stringify({ version: 1, rooms: [...(JSON.parse(good) as { rooms: unknown[] }).rooms, { id: 'more' }] }));
    await until(async () => (await listed(s)).some((r) => r.id === 'more' && r.state === 'running'), 15_000, 'the fixed file to be read');
  }, 60_000);

  it('starting with a damaged rooms.json is refused with the reason', async () => {
    writeFileSync(join(home, 'rooms.json'), '{nope');
    await expect(supervise()).rejects.toThrow(/damaged/);
  });

  it('a room that cannot start shows its last error in its row, without a token', async () => {
    sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '', FAKE_ROOM_FAIL: 'another gonogo is using /h (pid 7)' } });
    await until(async () => (await listed(sup as Supervisor)).some((r) => r.note !== null), 10_000, 'the note');
    const rows = (await (await api(sup, '/api/rooms')).json()) as { rooms: Array<{ state: string; note: string | null }> };
    expect(rows.rooms[0]?.note).toBe('another gonogo is using /h (pid 7) #token=<hidden>');
    expect(['crashed', 'starting']).toContain(rows.rooms[0]?.state);
  }, 30_000);

  it('a room started by the supervisor ends gracefully when the supervisor dies (stdin closes)', async () => {
    const { spawn } = await import('node:child_process');
    const roomHome = join(home, 'orphan');
    const child = spawn(process.execPath, [FAKE, '--home', roomHome, '--exit-with-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await until(() => existsSync(join(roomHome, 'started-with')), 10_000, 'the room');
    const gone = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdin.end(); // what the death of the supervisor does to the pipe
    expect(await gone).toBe(0);
    expect(readFileSync(join(roomHome, 'stopped'), 'utf8')).toBe('graceful');
  }, 30_000);

  it('starts its rooms with a pipe on stdin and the flag that makes them follow the supervisor', async () => {
    const s = await supervise();
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const main = JSON.parse(readFileSync(join(home, 'started-with'), 'utf8')) as { args: string[] };
    expect(main.args).toContain('--exit-with-stdin');
  });

  describe('create, rename and remove through the supervisor', () => {
    const json = { 'content-type': 'application/json' };
    const send = (s: Supervisor, method: string, path: string, body?: unknown, token: string | null = s.directorToken, headers: Record<string, string> = json): Promise<Response> =>
      api(s, path, token, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const running = (s: Supervisor, id: string): Promise<boolean> => listed(s).then((rooms) => rooms.some((r) => r.id === id && r.state === 'running'));

    it('needs the Director token for every method: none, a room\'s own, and a wrong one are 401, and nothing is written', async () => {
      const s = await supervise();
      await until(() => running(s, 'main'));
      const roomToken = 'f'.repeat(64);
      for (const token of [null, roomToken, 'f'.repeat(64)]) {
        for (const [method, path, body] of [['GET', '/api/rooms'], ['POST', '/api/rooms', { id: 'x' }], ['PATCH', '/api/rooms/x', { name: 'n' }], ['DELETE', '/api/rooms/x']] as const) {
          expect((await send(s, method, path, body, token)).status, `${method} ${path} ${String(token).slice(0, 4)}`).toBe(401);
        }
      }
      expect(loadRooms(home).map((r) => r.id)).toEqual(['main']); // no room was added
    });

    it('adds a room: it starts, shows in the list, and rooms.json is 0600; the same id again is 409', async () => {
      const s = await supervise();
      await until(() => running(s, 'main'));
      const made = await send(s, 'POST', '/api/rooms', { id: 'team-a', name: ' Team\tA ' });
      expect(made.status).toBe(201);
      expect(await made.json()).toMatchObject({ id: 'team-a', name: 'Team A' });
      await until(() => running(s, 'team-a'), 15_000, 'the new room');
      expect(statSync(join(home, ROOMS_FILE)).mode & 0o777).toBe(0o600);
      expect(existsSync(join(home, 'rooms', 'team-a', 'run', 'room.sock'))).toBe(true);
      const again = await send(s, 'POST', '/api/rooms', { id: 'team-a' });
      expect(again.status).toBe(409);
      expect(await (await send(s, 'GET', '/api/rooms')).json()).toMatchObject({ rooms: [{ id: 'main' }, { id: 'team-a', name: 'Team A' }] });
    }, 40_000);

    it('refuses a bad id, main, a bad body and a body that is not JSON, with the reason', async () => {
      const s = await supervise();
      await until(() => running(s, 'main'));
      for (const id of ['Team', '1a', 'a/b', '..', 'x'.repeat(25), '', 5, null, undefined]) expect((await send(s, 'POST', '/api/rooms', { id })).status, String(id)).toBe(400);
      const main = await send(s, 'POST', '/api/rooms', { id: 'main' });
      expect(main.status).toBe(400);
      expect(((await main.json()) as { error: string }).error).toMatch(/home itself/);
      expect((await send(s, 'POST', '/api/rooms', [1])).status).toBe(400);
      expect((await send(s, 'POST', '/api/rooms', { id: 'ok' }, s.directorToken, { 'content-type': 'text/plain' })).status).toBe(400);
      expect((await api(s, '/api/rooms', s.directorToken, { method: 'POST', headers: json, body: '{nope' })).status).toBe(400);
      expect((await api(s, '/api/rooms', s.directorToken, { method: 'POST', headers: json, body: JSON.stringify({ id: 'ok', name: 'x'.repeat(6000) }) })).status).toBe(400);
      expect((await send(s, 'PUT', '/api/rooms', { id: 'ok' })).status).toBe(405);
      expect((await send(s, 'POST', '/api/rooms/ok', { id: 'ok' })).status).toBe(405);
      expect(loadRooms(home).map((r) => r.id)).toEqual(['main']); // no room was added
    });

    it('refuses a browser page of another address (Origin), and a path id that is not an id', async () => {
      const s = await supervise();
      await until(() => running(s, 'main'));
      expect((await send(s, 'POST', '/api/rooms', { id: 'evil' }, s.directorToken, { ...json, origin: 'http://evil.example' })).status).toBe(403);
      for (const id of ['A', 'a%2fb']) expect([400, 404], id).toContain((await send(s, 'DELETE', `/api/rooms/${id}`)).status);
      expect(loadRooms(home).map((r) => r.id)).toEqual(['main']); // no room was added
    });

    it('renames a room (its id and folder stay) and refuses main, an empty name and an unknown room', async () => {
      addRoom(home, 'team');
      const s = await supervise();
      await until(() => running(s, 'team'));
      const renamed = await send(s, 'PATCH', '/api/rooms/team', { name: 'The Team' });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: 'team', name: 'The Team', state: 'running' });
      expect(loadRooms(home).find((r) => r.id === 'team')?.name).toBe('The Team');
      expect((await send(s, 'PATCH', '/api/rooms/main', { name: 'Home' })).status).toBe(400);
      for (const name of ['', '   ', 5, undefined]) expect((await send(s, 'PATCH', '/api/rooms/team', { name })).status, String(name)).toBe(400);
      expect((await send(s, 'PATCH', '/api/rooms/ghost', { name: 'x' })).status).toBe(404);
    }, 40_000);

    it('removes a room: it stops gracefully, its folder and files stay, main cannot be removed, an unknown room is 404', async () => {
      addRoom(home, 'gone');
      const s = await supervise();
      await until(() => running(s, 'gone'));
      const folder = roomHome(home, 'gone');
      expect((await send(s, 'DELETE', '/api/rooms/main')).status).toBe(400);
      expect((await send(s, 'DELETE', '/api/rooms/ghost')).status).toBe(404);
      const gone = await send(s, 'DELETE', '/api/rooms/gone');
      expect(gone.status).toBe(200);
      expect(((await gone.json()) as { note: string }).note).toMatch(/folder stays/);
      await until(() => existsSync(join(folder, 'stopped')), 15_000, 'its graceful stop');
      expect(readFileSync(join(folder, 'stopped'), 'utf8')).toBe('graceful');
      expect(existsSync(join(folder, 'starts'))).toBe(true);
      expect((await listed(s)).map((r) => r.id)).toEqual(['main']);
      expect((await api(s, '/r/gone/api/state')).status).toBe(404);
    }, 40_000);

    it('a damaged rooms.json refuses every write and is left as it is; the rooms keep running', async () => {
      addRoom(home, 'team');
      const s = await supervise();
      await until(() => running(s, 'team'));
      writeFileSync(join(home, ROOMS_FILE), '{"rooms": [{');
      for (const [method, path, body] of [['POST', '/api/rooms', { id: 'more' }], ['PATCH', '/api/rooms/team', { name: 'n' }], ['DELETE', '/api/rooms/team']] as const) {
        const res = await send(s, method, path, body);
        expect(res.status, method).toBe(409);
        expect(((await res.json()) as { error: string }).error).toMatch(/damaged/);
      }
      expect(readFileSync(join(home, ROOMS_FILE), 'utf8')).toBe('{"rooms": [{');
      expect(await running(s, 'team')).toBe(true);
    }, 40_000);

    it('the list page has the forms, and each of its scripts is valid JavaScript that the CSP hash covers', async () => {
      const s = await supervise();
      const res = await api(s, '/rooms', null);
      const html = await res.text();
      expect(html).toContain('NEW ROOM');
      expect(html).toMatch(/<input class="input" name="id"/);
      const scripts = [...html.matchAll(/<script>([^]*?)<\/script>/g)].map((m) => m[1] ?? '');
      expect(scripts).toHaveLength(2);
      for (const script of scripts) {
        expect(() => new vm.Script(script)).not.toThrow();
        const hash = `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
        expect(res.headers.get('content-security-policy')).toContain(hash);
      }
      expect(res.headers.get('content-security-policy')).toContain("img-src 'self'");
    });

    it('the list page shows the version and serves the logo of the built client', async () => {
      const client = join(home, 'client2');
      mkdirSync(client, { recursive: true });
      writeFileSync(join(client, 'index.html'), '<html></html>');
      writeFileSync(join(client, 'lockup.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      mkdirSync(join(client, 'assets'));
      sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '' }, staticDir: client, version: '9.8.7"<b>' });
      const html = await (await api(sup, '/rooms', null)).text();
      expect(html).toContain('gonogo 9.8.7&#34;&#60;b&#62;');
      expect(html).not.toContain('<b>');
      const logo = await api(sup, '/rooms/lockup.svg', null);
      expect([logo.status, logo.headers.get('content-type')]).toEqual([200, 'image/svg+xml']);
      expect(logo.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
      expect((await api(sup, '/rooms/lockup.png', null)).status).toBe(404);
    });

    it('the list says what the update check of main saw, only when it is newer and the check is on', async () => {
      const base = { home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], version: '1.0.0' };
      const update = async (s: Supervisor): Promise<unknown> => ((await (await api(s, '/api/rooms')).json()) as { update: unknown }).update;
      const saved = (latest: string): void => writeFileSync(join(home, 'rollout.json'), JSON.stringify({ version: 1, latest, checkedAt: 1 }));
      saved('1.0.1');
      sup = await startSupervisor({ ...base, env: { PATH: process.env.PATH ?? '' } });
      expect(await update(sup)).toEqual({ latest: '1.0.1' });
      saved('1.0.0');
      expect(await update(sup)).toBeNull();
      await sup.stop();
      saved('1.0.1');
      sup = await startSupervisor({ ...base, env: { PATH: process.env.PATH ?? '', GONOGO_UPDATE_CHECK: '0' } });
      expect(await update(sup)).toBeNull();
      await sup.stop();
      sup = await startSupervisor({ ...base, env: { PATH: process.env.PATH ?? '' }, roomArgs: ['--no-update-check'] });
      expect(await update(sup)).toBeNull();
    });

    it('the tab name a room reports is cleaned and cut like a room name', async () => {
      sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '', FAKE_TAB: `a\u202eb\nc${'x'.repeat(60)}` } });
      const s = sup;
      await until(async () => (await listed(s)).every((r) => r.state === 'running'));
      const tab = ((await (await api(s, '/api/rooms')).json()) as { rooms: Array<{ tabName: string }> }).rooms[0]?.tabName ?? '';
      expect(tab).toBe(`a b c${'x'.repeat(60)}`.slice(0, 40));
    });

    it('the logo shipped to the page is the one of the brand folder', () => {
      expect(readFileSync(new URL('../public/lockup.svg', import.meta.url), 'utf8')).toBe(readFileSync(new URL('../docs/brand/lockup.svg', import.meta.url), 'utf8'));
    });
  });

  describe('is a supervisor running?', () => {
    it('is no without a file, with a dead pid, with a port nobody listens on, and yes while the supervisor runs; the file goes with it', async () => {
      expect(await supervisorRunning(home)).toBe(false);
      writeFileSync(join(home, SUPERVISOR_FILE), JSON.stringify({ pid: 2 ** 22 - 1, host: '127.0.0.1', port: 9 }));
      expect(await supervisorRunning(home)).toBe(false);
      writeFileSync(join(home, SUPERVISOR_FILE), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 1 }));
      expect(await supervisorRunning(home)).toBe(false);
      writeFileSync(join(home, SUPERVISOR_FILE), 'nope');
      expect(await supervisorRunning(home)).toBe(false);
      rmSync(join(home, SUPERVISOR_FILE));
      const s = await supervise();
      expect(await supervisorRunning(home)).toBe(true);
      expect(statSync(join(home, SUPERVISOR_FILE)).mode & 0o777).toBe(0o600);
      await s.stop();
      sup = null;
      expect(existsSync(join(home, SUPERVISOR_FILE))).toBe(false);
      expect(await supervisorRunning(home)).toBe(false);
    }, 40_000);

    it('writes the file through a rename (a planted symlink is not followed) and removes only its own', async () => {
      const target = join(home, 'victim.txt');
      writeFileSync(target, 'keep');
      symlinkSync(target, join(home, SUPERVISOR_FILE));
      const s = await supervise();
      expect(readFileSync(target, 'utf8')).toBe('keep');
      expect(lstatSync(join(home, SUPERVISOR_FILE)).isSymbolicLink()).toBe(false);
      // another supervisor took the file over: this one's stop must leave it
      writeFileSync(join(home, SUPERVISOR_FILE), JSON.stringify({ pid: process.pid + 1, host: '127.0.0.1', port: 1 }));
      await s.stop();
      sup = null;
      expect(existsSync(join(home, SUPERVISOR_FILE))).toBe(true);
      expect(JSON.parse(readFileSync(join(home, SUPERVISOR_FILE), 'utf8'))).toMatchObject({ pid: process.pid + 1 });
    }, 40_000);

    const run = async (...args: string[]): Promise<string> => {
      const { main } = await import('../src/server/cli.js');
      let out = '';
      const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => ((out += String(chunk)), true));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      try {
        await main(args, { PATH: process.env.PATH });
      } finally {
        write.mockRestore();
        exit.mockRestore();
      }
      return out;
    };

    it('rooms add and remove say when no supervisor will act on the change, and stay quiet when one runs; list never says it', async () => {
      const without = await run('rooms', 'add', 'ninah', '--home', home);
      expect(without).toContain('added room ninah');
      expect(without).toContain('no gonogo is running for this home');
      expect(await run('rooms', 'remove', 'ninah', '--home', home)).toContain('no gonogo is running for this home');
      expect(await run('rooms', 'list', '--home', home)).not.toContain('supervisor');
      await supervise();
      expect(await run('rooms', 'add', 'ninah', '--home', home)).not.toContain('no gonogo is running');
      expect(await run('rooms', 'remove', 'ninah', '--home', home)).not.toContain('no gonogo is running');
    }, 40_000);
  });

  describe('push to the installed app', () => {
    const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dev';

    it('keeps its devices in the supervisor\'s home, and answers its routes with the login, not through a room', async () => {
      const s = await supervise();
      await until(async () => (await listed(s)).every((r) => r.state === 'running'));
      expect(statSync(join(home, PUSH_FILE)).mode & 0o777).toBe(0o600);
      // no credential at all is 401, as for the other routes; a room's own address is not these routes
      expect((await api(s, '/api/push', null)).status).toBe(401);
      expect((await api(s, '/api/push/subscription', null, { method: 'PUT' })).status).toBe(401);
      const viaToken = await api(s, '/api/push');
      // the old token is a credential but owns no device: reading is fine, subscribing is not
      if (viaToken.status === 200) {
        const key = ((await viaToken.json()) as { publicKey: string }).publicKey;
        expect(Buffer.from(key, 'base64url')).toHaveLength(65);
        const p = phone();
        const put = await api(s, '/api/push/subscription', s.directorToken, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: p.p256dh, auth: p.auth } }) });
        expect(put.status).toBe(403);
      }
    }, 40_000);
  });

  it('stops every room gracefully (SIGTERM) and closes the port', async () => {
    addRoom(home, 'team');
    const s = await supervise();
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const port = s.port;
    await s.stop();
    sup = null;
    expect(readFileSync(join(home, 'stopped'), 'utf8')).toBe('graceful');
    expect(readFileSync(join(home, 'rooms', 'team', 'stopped'), 'utf8')).toBe('graceful');
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  }, 40_000);
});

describe('stop and start rooms through the supervisor (t107)', () => {
  const json = { 'content-type': 'application/json' };
  const post = (s: Supervisor, path: string, token: string | null = s.directorToken, method = 'POST', body?: unknown): Promise<Response> =>
    api(s, path, token, { method, headers: json, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const state = async (s: Supervisor, id: string): Promise<string | undefined> => s.rooms().find((r) => r.id === id)?.state;
  const boot = async (extraEnv: Record<string, string> = {}): Promise<Supervisor> => {
    addRoom(home, 'b');
    addRoom(home, 'c');
    const s = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '', GONOGO_PORT: '1', GONOGO_ALLOWED_HOSTS: 'x', ...extraEnv }, authCosts: { argon2: { memory: 16, passes: 1, parallelism: 1 }, scrypt: { N: 16, r: 1, p: 1 } }, tamperEveryMs: 0 });
    sup = s;
    await until(async () => (await state(s, 'main')) === 'running' && (await state(s, 'c')) === 'running', 20_000, 'main and c');
    return s;
  };
  /** Makes the account, so that API keys exist (a key is refused on an install with no account). */
  const account = async (s: Supervisor): Promise<void> => {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/auth/setup`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${s.port}` }, body: new URLSearchParams({ token: s.setupToken ?? '', user: 'director', password: 'correct horse battery staple' }).toString() });
    expect(res.status).toBe(303);
  };

  it('stops and starts one room: the answers, the states, autostart unchanged; 404 and 409', async () => {
    const s = await boot();
    const stopped = await post(s, '/api/rooms/c/stop');
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ id: 'c', state: 'stopped', autostart: true });
    expect(readFileSync(join(home, 'rooms', 'c', 'stopped'), 'utf8')).toBe('graceful');
    expect((await post(s, '/api/rooms/c/stop')).status).toBe(409);
    expect(await state(s, 'main')).toBe('running');
    expect((await post(s, '/api/rooms/nope/stop')).status).toBe(404);
    expect((await post(s, '/api/rooms/nope/start')).status).toBe(404);
    const started = await post(s, '/api/rooms/c/start');
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ id: 'c', state: 'starting' });
    expect((await post(s, '/api/rooms/c/start')).status).toBe(409);
    await until(async () => (await state(s, 'c')) === 'running');
    expect(loadRooms(home).find((r) => r.id === 'c')?.autostart).toBe(true);
    expect((await post(s, '/api/rooms/c/stop', s.directorToken, 'GET')).status).toBe(405);
  }, 60_000);

  it('answers 401 to no token, a wrong one and an agent-looking one, and does nothing', async () => {
    const s = await boot();
    for (const token of [null, 'f'.repeat(64)]) for (const path of ['/api/rooms/c/stop', '/api/rooms/stop-all', '/api/rooms/start-all']) expect((await post(s, path, token)).status).toBe(401);
    expect(await state(s, 'c')).toBe('running');
  }, 60_000);

  it('PATCH autostart: kept in rooms.json, refused for main and for a non-boolean; the id stop-all is not a room', async () => {
    const s = await boot();
    const off = await post(s, '/api/rooms/c', s.directorToken, 'PATCH', { autostart: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ id: 'c', autostart: false });
    expect(loadRooms(home).find((r) => r.id === 'c')?.autostart).toBe(false);
    expect(await state(s, 'c')).toBe('running');
    expect((await post(s, '/api/rooms/main', s.directorToken, 'PATCH', { autostart: false })).status).toBe(400);
    expect((await post(s, '/api/rooms/c', s.directorToken, 'PATCH', { autostart: 'no' })).status).toBe(400);
    expect((await post(s, '/api/rooms/c', s.directorToken, 'PATCH', {})).status).toBe(400);
    expect((await post(s, '/api/rooms', s.directorToken, 'POST', { id: 'stop-all' })).status).toBe(400);
  }, 60_000);

  it('stop-all and start-all say what was done and what was skipped; a Relief request or an open poll keeps a room running', async () => {
    const s = await boot({ FAKE_ROOM_RELIEF: '1' });
    const stopAll = (await (await post(s, '/api/rooms/stop-all')).json()) as { stopped: string[]; skipped: Array<{ id: string; why: string }> };
    expect(stopAll.stopped).toEqual(['main']); // the stand-in rooms other than main each hold a Relief request
    expect(stopAll.skipped.map((k) => k.id)).toEqual(['b', 'c']);
    expect(stopAll.skipped.every((k) => /Relief request waits/.test(k.why))).toBe(true);
    expect(await state(s, 'b')).toBe('running');
    const again = (await (await post(s, '/api/rooms/stop-all')).json()) as { stopped: string[]; skipped: unknown[] };
    expect(again.stopped).toEqual([]);
    const startAll = (await (await post(s, '/api/rooms/start-all')).json()) as { started: string[] };
    expect(startAll.started).toEqual(['main']);
    await until(async () => (await state(s, 'main')) === 'running');
    const refused = await post(s, '/api/rooms/b/stop');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toMatch(/Relief request waits/);
  }, 90_000);

  it('refuses to stop main while it is being moved or an update runs; says so', async () => {
    const s = await boot({ FAKE_ROOM_UPDATE: 'running' });
    const blocked = await post(s, '/api/rooms/main/stop');
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(await blocked.json())).toMatch(/update is running/);
    expect(await state(s, 'main')).toBe('running');
  }, 60_000);

  it('an API key: read and write are refused, full may stop one room but not main and not all; the refusals are audited', async () => {
    const s = await boot();
    await account(s);
    const full = s.auth.addKey('ops', 'full', null, false).secret;
    const write = s.auth.addKey('w', 'write', null, false).secret;
    const read = s.auth.addKey('r', 'read', null, false).secret;
    for (const key of [write, read]) expect((await post(s, '/api/rooms/c/stop', key)).status).toBe(403);
    expect((await post(s, '/api/rooms/stop-all', full)).status).toBe(403);
    expect((await post(s, '/api/rooms/main/stop', full)).status).toBe(403);
    expect(await state(s, 'main')).toBe('running');
    expect((await post(s, '/api/rooms/c/stop', full)).status).toBe(200);
    expect(await state(s, 'c')).toBe('stopped');
    const notices = readFileSync(join(home, 'notices'), 'utf8');
    expect(notices).toMatch(/key \\"ops\\": stop room c: done/);
    expect(notices).toMatch(/refused: an API key may not stop every room/);
  }, 60_000);

  it('a room that does not answer /api/state is refused with 409 until the stop is forced; the audit says so', async () => {
    const s = await boot({ FAKE_ROOM_NOSTATE: '1' });
    const refused = await post(s, '/api/rooms/c/stop');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toMatch(/did not answer/);
    expect(await state(s, 'c')).toBe('running');
    const all = (await (await post(s, '/api/rooms/stop-all')).json()) as { stopped: string[]; skipped: Array<{ id: string }> };
    expect(all.skipped.map((k) => k.id)).toEqual(['b', 'c']);
    expect(all.stopped).toEqual(['main']); // main answers, so it was stopped: the audit is held until it runs again
    expect((await post(s, '/api/rooms/main/start')).status).toBe(200);
    await until(async () => (await state(s, 'main')) === 'running');
    const forced = await post(s, '/api/rooms/c/stop', s.directorToken, 'POST', { force: true });
    expect(forced.status).toBe(200);
    expect(await state(s, 'c')).toBe('stopped');
    await until(() => existsSync(join(home, 'notices')) && /stop room c: done \(the room did not answer.*by force/.test(readFileSync(join(home, 'notices'), 'utf8')));
  }, 60_000);

  it('one request at a time per room: two stops at once, one answers 409', async () => {
    const s = await boot();
    const both = await Promise.all([post(s, '/api/rooms/c/stop'), post(s, '/api/rooms/c/stop')]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
  }, 60_000);

  it('holds the audit and alerts while main is stopped, and says them once when it is ready; a queued mail is not the supervisor\'s', async () => {
    const s = await boot();
    expect((await post(s, '/api/rooms/main/stop')).status).toBe(200);
    expect(await state(s, 'main')).toBe('stopped');
    expect((await post(s, '/api/rooms/c/stop')).status).toBe(200); // audited while main is down: held
    expect((await post(s, '/api/rooms/main/start')).status).toBe(200);
    await until(async () => (await state(s, 'main')) === 'running');
    await until(() => existsSync(join(home, 'notices')) && /stop room c: done/.test(readFileSync(join(home, 'notices'), 'utf8')));
    const lines = readFileSync(join(home, 'notices'), 'utf8').split('\n').filter((l) => /stop room (c|main): done/.test(l));
    expect(lines.filter((l) => /stop room c: done/.test(l)).length).toBe(1);
    expect(lines.filter((l) => /stop room main: done/.test(l)).length).toBe(1);
  }, 60_000);
});
