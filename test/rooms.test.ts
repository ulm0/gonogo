// Rooms (docs/rooms-spec.md): the list of rooms, the commands, and the supervisor with stand-in rooms (test/fake-room.mjs).
// The real thing (built gonogo as the rooms) was tried by hand: docs/features/rooms.md, "What was seen".
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/server/cli.js';
import { addRoom, loadRooms, MAIN_ROOM, removeRoom, ROOMS_FILE, RoomsError, roomHome, SUPERVISOR_FILE, supervisorRunning } from '../src/server/rooms.js';
import { startGonogo } from '../src/server/cli.js';
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
    expect(rooms[0]).toMatchObject({ agents: 2, needsYou: 1, working: 1, lastActivity: 1_700_000_900_000, tabName: 'Fake tab' });
    // the room's own settings, not the supervisor's
    const main = JSON.parse(readFileSync(join(home, 'started-with'), 'utf8')) as { args: string[]; home: string; port: string | null; supervisor: string | null; env: string[] };
    expect(main.home).toBe(home);
    expect(main.port).toBeNull();
    expect(main.args).toEqual(expect.arrayContaining(['--home', home, '--port', '0', '--host', '127.0.0.1']));
    expect(main.args).not.toContain('--no-update-check');
    const team = JSON.parse(readFileSync(join(home, 'rooms', 'team', 'started-with'), 'utf8')) as { args: string[] };
    expect(team.args).toContain('--no-update-check');
    // three tokens: the Director's (<home>/token) and one per room (run/room-token), all different, and no room has a token file of its own besides
    const tokens = [readFileSync(join(home, 'run', 'room-token'), 'utf8').trim(), readFileSync(join(home, 'rooms', 'team', 'run', 'room-token'), 'utf8').trim()];
    expect(new Set([...tokens, s.directorToken]).size).toBe(3);
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
    expect((await api(s, '/api/rooms', readFileSync(join(home, 'run', 'room-token'), 'utf8').trim())).status).toBe(401);
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
    // the token of main does not open team, and the Director token is never a room's
    const mainToken = readFileSync(join(home, 'run', 'room-token'), 'utf8').trim();
    expect((await api(s, '/r/team/api/state', mainToken)).status).toBe(401);
    // the Director token is main's token file; main's room never accepted it
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
    expect(existsSync(join(folder, 'run', 'room-token'))).toBe(true);
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
      const roomToken = readFileSync(join(home, 'run', 'room-token'), 'utf8').trim();
      for (const token of [null, roomToken, 'f'.repeat(64)]) {
        for (const [method, path, body] of [['GET', '/api/rooms'], ['POST', '/api/rooms', { id: 'x' }], ['PATCH', '/api/rooms/x', { name: 'n' }], ['DELETE', '/api/rooms/x']] as const) {
          expect((await send(s, method, path, body, token)).status, `${method} ${path} ${String(token).slice(0, 4)}`).toBe(401);
        }
      }
      expect(existsSync(join(home, ROOMS_FILE))).toBe(false);
    });

    it('adds a room: it starts, shows in the list, and rooms.json is 0600; the same id again is 409', async () => {
      const s = await supervise();
      await until(() => running(s, 'main'));
      const made = await send(s, 'POST', '/api/rooms', { id: 'team-a', name: ' Team\tA ' });
      expect(made.status).toBe(201);
      expect(await made.json()).toMatchObject({ id: 'team-a', name: 'Team A' });
      await until(() => running(s, 'team-a'), 15_000, 'the new room');
      expect(statSync(join(home, ROOMS_FILE)).mode & 0o777).toBe(0o600);
      expect(existsSync(join(home, 'rooms', 'team-a', 'run', 'room-token'))).toBe(true);
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
      expect(existsSync(join(home, ROOMS_FILE))).toBe(false);
    });

    it('refuses a browser page of another address (Origin), and a path id that is not an id', async () => {
      const s = await supervise();
      await until(() => running(s, 'main'));
      expect((await send(s, 'POST', '/api/rooms', { id: 'evil' }, s.directorToken, { ...json, origin: 'http://evil.example' })).status).toBe(403);
      for (const id of ['A', 'a%2fb']) expect([400, 404], id).toContain((await send(s, 'DELETE', `/api/rooms/${id}`)).status);
      expect(existsSync(join(home, ROOMS_FILE))).toBe(false);
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
      expect(existsSync(join(folder, 'run', 'room-token'))).toBe(true);
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
      const html = await (await api(sup, '/', null)).text();
      expect(html).toContain('gonogo 9.8.7&#34;&#60;b&#62;');
      expect(html).not.toContain('<b>');
      const logo = await api(sup, '/lockup.svg', null);
      expect([logo.status, logo.headers.get('content-type')]).toEqual([200, 'image/svg+xml']);
      expect(logo.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
      expect((await api(sup, '/lockup.png', null)).status).toBe(404);
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
