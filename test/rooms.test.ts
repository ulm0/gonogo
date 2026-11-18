// Rooms (docs/rooms-spec.md): the list of rooms, the commands, and the supervisor with stand-in rooms (test/fake-room.mjs).
// The real thing (built gonogo as the rooms) was tried by hand: docs/features/rooms.md, "What was seen".
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  it('the list page wears the stylesheet of the built client, served from /assets/ for css and fonts only', async () => {
    const client = join(home, 'client');
    mkdirSync(join(client, 'assets'), { recursive: true });
    writeFileSync(join(client, 'index.html'), '<html><head><link rel="stylesheet" crossorigin href="./assets/index-abc123.css"></head></html>');
    writeFileSync(join(client, 'assets', 'index-abc123.css'), '.tile{color:red}');
    writeFileSync(join(client, 'assets', 'secret.txt'), 'no');
    // a symlink named like a stylesheet that points at the Director token must not be followed
    symlinkSync(join(home, 'rooms-token'), join(client, 'assets', 'linked.css'));
    symlinkSync(client, join(client, 'assets', 'dir.css'));
    sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '' }, staticDir: client });
    const s = sup;
    const token = s.directorToken;
    const html = await (await api(s, '/', null)).text();
    expect(html).toContain('<link rel="stylesheet" href="/assets/index-abc123.css">');
    expect(html).toMatch(/class="module"/);
    const css = await api(s, '/assets/index-abc123.css', null);
    expect([css.status, css.headers.get('content-type')]).toEqual([200, 'text/css']);
    expect(await css.text()).toBe('.tile{color:red}');
    for (const path of ['/assets/linked.css', '/assets/dir.css', '/assets/secret.txt', '/assets/nope.css', '/assets/..%2findex.html', '/assets/../index.html', '/assets/']) expect((await api(s, path, null)).status, path).toBe(404);
    expect((await api(s, '/', null)).headers.get('content-security-policy')).toMatch(/style-src 'self' 'sha256-/);
    expect(await (await api(s, '/assets/linked.css', null)).text()).not.toContain(token);
  });

  it('without a built client the list page still works, with plain styles', async () => {
    const s = await supervise();
    const html = await (await api(s, '/', null)).text();
    expect(html).not.toContain('rel="stylesheet"');
    expect((await api(s, '/assets/x.css', null)).status).toBe(404);
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
      const roomToken = readFileSync(join(home, 'token'), 'utf8').trim();
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
      expect(existsSync(join(home, 'rooms', 'team-a', 'token'))).toBe(true);
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
      for (const id of ['..', 'A', 'a%2fb', '%2e%2e']) expect([400, 404], id).toContain((await send(s, 'DELETE', `/api/rooms/${id}`)).status);
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
      expect(existsSync(join(folder, 'token'))).toBe(true);
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

    it('the list page has the forms, and its script is valid JavaScript that the CSP hash covers', async () => {
      const s = await supervise();
      const res = await api(s, '/', null);
      const html = await res.text();
      expect(html).toContain('NEW ROOM');
      expect(html).toMatch(/<input class="input" name="id"/);
      const script = /<script>([^]*)<\/script>/.exec(html)?.[1] ?? '';
      expect(() => new vm.Script(script)).not.toThrow();
      const hash = `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
      expect(res.headers.get('content-security-policy')).toContain(`script-src ${hash}`);
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
      expect(without).toContain('no `gonogo rooms` supervisor is running');
      expect(without).toContain('"rooms", "--host", "0.0.0.0"');
      expect(await run('rooms', 'remove', 'ninah', '--home', home)).toContain('no `gonogo rooms` supervisor is running');
      expect(await run('rooms', 'list', '--home', home)).not.toContain('supervisor');
      await supervise();
      expect(await run('rooms', 'add', 'ninah', '--home', home)).not.toContain('supervisor is running');
      expect(await run('rooms', 'remove', 'ninah', '--home', home)).not.toContain('supervisor is running');
    }, 40_000);

    it('plain gonogo logs one line at start when rooms.json lists rooms, none when it lists none, and none for a room of a supervisor', async () => {
      const lines: string[] = [];
      const log = { debug() {}, info() {}, warn: (m: string) => void lines.push(m), error() {}, child: () => log };
      const start = async (extra: Record<string, unknown> = {}): Promise<void> => {
        const running = await startGonogo({ port: 0, host: '127.0.0.1', home, cwd: home, seed: false, allowedHosts: [], agentCmd: [process.execPath, new URL('./fake-claude.mjs', import.meta.url).pathname], staticDir: null, checkClaude: false, env: { PATH: process.env.PATH ?? '', FAKE_CLAUDE_LOG_DIR: home }, log, ...extra });
        await running.stop();
      };
      await start();
      expect(lines.filter((l) => l.includes('rooms.json'))).toEqual([]);
      addRoom(home, 'ninah');
      addRoom(home, 'team');
      await start();
      const found = lines.filter((l) => l.includes('rooms.json'));
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('2 other rooms (ninah, team)');
      expect(found[0]).toContain('plain gonogo, one room');
      lines.length = 0;
      await start({ exitWithStdin: true });
      expect(lines.filter((l) => l.includes('rooms.json'))).toEqual([]);
      writeFileSync(join(home, ROOMS_FILE), '{nope');
      await start();
      expect(lines.filter((l) => l.includes('rooms.json'))).toEqual([]);
    }, 60_000);
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
