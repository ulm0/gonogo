// Rooms (docs/rooms-spec.md): the list of rooms, the commands, and the supervisor with stand-in rooms (test/fake-room.mjs).
// The real thing (built gonogo as the rooms) was tried by hand: docs/features/rooms.md, "What was seen".
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/server/cli.js';
import { addRoom, loadRooms, MAIN_ROOM, removeRoom, ROOMS_FILE, RoomsError, roomHome } from '../src/server/rooms.js';
import { startSupervisor } from '../src/server/supervisor.js';
import type { Supervisor } from '../src/server/supervisor.js';

const FAKE = new URL('./fake-room.mjs', import.meta.url).pathname;
let home: string;
let sup: Supervisor | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gng-rooms-'));
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
    expect(parseArgs(['rooms'])).toEqual({ kind: 'rooms', action: 'serve', options: {} });
    expect(parseArgs(['rooms', '--port', '9000'])).toEqual({ kind: 'rooms', action: 'serve', options: { port: 9000 } });
    expect(parseArgs(['rooms', 'add', 'team', '--name', 'The team'])).toEqual({ kind: 'rooms', action: 'add', id: 'team', name: 'The team' });
    expect(parseArgs(['rooms', 'list', '--home', '/h'])).toEqual({ kind: 'rooms', action: 'list', home: '/h' });
    expect(parseArgs(['rooms', 'remove', 'team'])).toEqual({ kind: 'rooms', action: 'remove', id: 'team' });
    expect(parseArgs(['rooms', 'add'])).toMatchObject({ kind: 'error', message: 'rooms add needs a room id' });
    expect(parseArgs(['rooms', 'list', 'x'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['rooms', '--nope'])).toMatchObject({ kind: 'error' });
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

describe('the supervisor', () => {
  it('starts main (the root home) and every listed room, each in its own home with its own token, and lists them', async () => {
    addRoom(home, 'team', 'Team');
    const s = await supervise();
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    const rooms = await listed(s);
    expect(rooms.map((r) => r.id)).toEqual(['main', 'team']);
    expect(rooms[0]).toMatchObject({ agents: 2, needsYou: 1 });
    // the room's own settings, not the supervisor's
    const main = JSON.parse(readFileSync(join(home, 'started-with'), 'utf8')) as { args: string[]; home: string; port: string | null };
    expect(main.home).toBe(home);
    expect(main.port).toBeNull();
    expect(main.args).toEqual(expect.arrayContaining(['--home', home, '--port', '0', '--host', '127.0.0.1']));
    expect(main.args).not.toContain('--no-update-check');
    const team = JSON.parse(readFileSync(join(home, 'rooms', 'team', 'started-with'), 'utf8')) as { args: string[] };
    expect(team.args).toContain('--no-update-check');
    // two tokens, neither the Director's
    const tokens = [readFileSync(join(home, 'token'), 'utf8').trim(), readFileSync(join(home, 'rooms', 'team', 'token'), 'utf8').trim()];
    expect(new Set([...tokens, s.directorToken]).size).toBe(3);
    expect(statSync(join(home, 'rooms-token')).mode & 0o777).toBe(0o600);
  });

  it('the list needs the Director token; a room\'s own token is not enough', async () => {
    const s = await supervise();
    await until(async () => (await listed(s)).every((r) => r.state === 'running'));
    expect((await api(s, '/api/rooms', null)).status).toBe(401);
    expect((await api(s, '/api/rooms', readFileSync(join(home, 'token'), 'utf8').trim())).status).toBe(401);
    const page = await api(s, '/', null);
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
    // the token of main does not open team, and the Director token is never a room's
    const mainToken = readFileSync(join(home, 'token'), 'utf8').trim();
    expect((await api(s, '/r/team/api/state', mainToken)).status).toBe(401);
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
    expect(existsSync(join(folder, 'token'))).toBe(true);
    expect((await api(s, '/r/late/api/state')).status).toBe(404);
  }, 40_000);

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
