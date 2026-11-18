// Rooms as the only mode (docs/single-mode-spec.md, PR 1): the Director token, the supervisor lock, the health path, the room's own
// token and port, reload through the supervisor, and `gonogo token rotate`. Stand-in rooms (test/fake-room.mjs) except where a real room
// (startGonogo with roomChild) is the point.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startGonogo } from '../src/server/cli.js';
import { acquireSupervisorLock } from '../src/server/home.js';
import { addRoom, loadRooms, ROOMS_FILE, RoomsError, RESERVED_ROOT_NAMES } from '../src/server/rooms.js';
import { isSupervisorProcess, requestReload, rotateDirectorToken } from '../src/server/reload.js';
import { startSupervisor } from '../src/server/supervisor.js';
import type { Supervisor } from '../src/server/supervisor.js';

const FAKE = new URL('./fake-room.mjs', import.meta.url).pathname;
const FAKE_CLAUDE = new URL('./fake-claude.mjs', import.meta.url).pathname;
let home: string;
let sup: Supervisor | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gng-single-'));
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
const supervise = async (env: Record<string, string> = {}, over: Record<string, unknown> = {}): Promise<Supervisor> => {
  sup = await startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: { PATH: process.env.PATH ?? '', ...env }, ...over });
  return sup;
};
const get = (s: Supervisor, path: string, token: string | null = null): Promise<Response> => fetch(`http://127.0.0.1:${s.port}${path}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
const roomsOf = async (s: Supervisor): Promise<Array<{ id: string; state: string }>> => ((await (await get(s, '/api/rooms', s.directorToken)).json()) as { rooms: Array<{ id: string; state: string }> }).rooms;

describe('the Director token is <home>/token', () => {
  it('keeps the value an existing home already has, so every old link works, and removes the leftovers of 0.4', async () => {
    const old = 'a1'.repeat(32);
    writeFileSync(join(home, 'token'), `${old}\n`, { mode: 0o600 });
    writeFileSync(join(home, 'rooms-token'), `${'b2'.repeat(32)}\n`);
    addRoom(home, 'team');
    mkdirSync(join(home, 'rooms', 'team'), { recursive: true });
    writeFileSync(join(home, 'rooms', 'team', 'token'), `${'c3'.repeat(32)}\n`);
    const s = await supervise();
    expect(s.directorToken).toBe(old);
    expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(old);
    expect(existsSync(join(home, 'rooms-token'))).toBe(false);
    expect(existsSync(join(home, 'rooms', 'team', 'token'))).toBe(false);
    await until(async () => (await roomsOf(s)).every((r) => r.state === 'running'));
    expect((await get(s, '/api/rooms', old)).status).toBe(200);
  });

  it('makes one (0600) in a home that has none, and never gives it to a room: not in its environment, its arguments or its own token', async () => {
    const s = await supervise();
    await until(async () => (await roomsOf(s)).every((r) => r.state === 'running'));
    expect(statSync(join(home, 'token')).mode & 0o777).toBe(0o600);
    const dump = readFileSync(join(home, 'dump.json'), 'utf8');
    expect(dump).not.toContain(s.directorToken);
    expect(readFileSync(join(home, 'run', 'room-token'), 'utf8').trim()).not.toBe(s.directorToken);
    // the room's own token, as the supervisor learned it, is not the one that opens the front
    expect((await get(s, '/api/rooms', readFileSync(join(home, 'run', 'room-token'), 'utf8').trim())).status).toBe(401);
  });

  it('gonogo token rotate: a new token, 0600, the old one stops at once in a running supervisor, the new one opens it; nothing is printed that is a token', async () => {
    const s = await supervise();
    await until(async () => (await roomsOf(s)).every((r) => r.state === 'running'));
    const before = readFileSync(join(home, 'token'), 'utf8').trim();
    const said = rotateDirectorToken(home);
    const after = readFileSync(join(home, 'token'), 'utf8').trim();
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    expect(statSync(join(home, 'token')).mode & 0o777).toBe(0o600);
    expect(said).not.toContain(before);
    expect(said).not.toContain(after);
    expect(said).toMatch(/old one no longer works/);
    expect((await get(s, '/api/rooms', before)).status).toBe(401);
    expect((await get(s, '/api/rooms', after)).status).toBe(200);
    // through the proxy too, to the room, with the room's own token swapped in
    expect((await get(s, '/api/state', before)).status).toBe(401);
    expect((await get(s, '/api/state', after)).status).toBe(200);
    // a planted symlink in the place of the temporary file is not followed
    rmSync(join(home, 'token'));
    const victim = join(home, 'victim');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(home, `token.${process.pid}.tmp`));
    rotateDirectorToken(home);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });
});

describe('one supervisor per home', () => {
  it('refuses a second one and says who holds it; the lock goes with stop(); a stale pid is taken over', async () => {
    const s = await supervise();
    await expect(startSupervisor({ home, host: '127.0.0.1', port: 0, allowedHosts: [], command: [process.execPath, FAKE], env: {} })).rejects.toThrow(/another gonogo supervisor is using .*supervisor\.lock/s);
    await s.stop();
    sup = null;
    expect(existsSync(join(home, 'run', 'supervisor.lock'))).toBe(false);
    // a leftover naming a process that is gone
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', 'supervisor.lock'), `${2 ** 22 - 3}\n`);
    const release = acquireSupervisorLock(home);
    expect(readFileSync(join(home, 'run', 'supervisor.lock'), 'utf8').trim()).toBe(String(process.pid));
    release();
    expect(existsSync(join(home, 'run', 'supervisor.lock'))).toBe(false);
  });
});

describe('/rooms/health', () => {
  it('is 503 until main has been ready once, then 200, also while main is down and restarting; never proxied, no token', async () => {
    const s = await supervise({ FAKE_ROOM_DELAY_MS: '1500' });
    const early = await get(s, '/rooms/health');
    expect(early.status).toBe(503);
    await until(async () => (await get(s, '/rooms/health')).status === 200, 15_000, 'main to be ready');
    // main leaves (killed): the container must not flap, so it stays 200 while main starts again
    const starts = (): string[] => readFileSync(join(home, 'starts'), 'utf8').trim().split('\n');
    const pid = Number(starts().at(-1)?.split(' ')[0]);
    process.kill(pid, 'SIGKILL');
    await until(async () => (await roomsOf(s))[0]?.state !== 'running', 10_000, 'main to be seen down');
    expect((await get(s, '/rooms/health')).status).toBe(200);
    await until(async () => (await roomsOf(s))[0]?.state === 'running', 20_000, 'main to be back');
    expect(starts().length).toBeGreaterThanOrEqual(2);
    // not a path of main: main's own /rooms/health would be 404 there
    expect((await get(s, '/rooms/health', s.directorToken)).status).toBe(200);
  }, 60_000);

  it('stays 503 when main never gets ready', async () => {
    const s = await supervise({ FAKE_ROOM_FAIL: 'cannot start' });
    await new Promise((r) => setTimeout(r, 2500));
    expect((await get(s, '/rooms/health')).status).toBe(503);
  }, 20_000);
});

describe('reload through the supervisor', () => {
  it('reload() sends SIGUSR2 to every room, which leaves with 75; none is started again; the supervisor can then stop', async () => {
    addRoom(home, 'team');
    const s = await supervise();
    await until(async () => (await roomsOf(s)).every((r) => r.state === 'running'));
    await s.reload();
    expect(readFileSync(join(home, 'reloaded'), 'utf8')).toBe('yes');
    expect(readFileSync(join(home, 'rooms', 'team', 'reloaded'), 'utf8')).toBe('yes');
    await new Promise((r) => setTimeout(r, 2500));
    expect((await roomsOf(s)).map((r) => r.state)).toEqual(['stopped', 'stopped']);
    expect(readFileSync(join(home, 'starts'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 40_000);

  it('S6: a room that leaves with 75 on its own is a crash: it is started again only after the backoff', async () => {
    const s = await supervise({ FAKE_ROOM_EXIT75: '1' });
    await until(() => existsSync(join(home, 'starts')) && readFileSync(join(home, 'starts'), 'utf8').trim().split('\n').length >= 1);
    await new Promise((r) => setTimeout(r, 600));
    // 200 ms after it started it left; an immediate restart would show two starts by now, the backoff of 1 s shows one
    expect(readFileSync(join(home, 'starts'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect((await roomsOf(s))[0]?.state).toBe('crashed');
    await until(() => readFileSync(join(home, 'starts'), 'utf8').trim().split('\n').length >= 2, 10_000, 'the restart after the backoff');
  }, 30_000);

  it('a room started by a reloaded supervisor is told so (GONOGO_RELOADED passes through), and knows its supervisor', async () => {
    await supervise({ GONOGO_RELOADED: '1' });
    await until(() => existsSync(join(home, 'started-with')));
    expect(JSON.parse(readFileSync(join(home, 'started-with'), 'utf8'))).toMatchObject({ reloaded: '1', supervisor: String(process.pid) });
  });
});

describe('gonogo reload (S3)', () => {
  const lock = (pid: number): void => {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', 'supervisor.lock'), `${pid}\n`);
  };

  it('never signals a pid that is not a gonogo supervisor of this gonogo: a stale lock whose pid another program took', async () => {
    const sleeper = spawn(process.execPath, ['-e', 'process.on("SIGUSR2", () => { require("fs").writeFileSync(process.argv[1], "signalled"); }); setInterval(() => {}, 1000)', join(home, 'signalled')], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      lock(sleeper.pid as number);
      expect(() => requestReload(home, false)).toThrow(/not a gonogo supervisor/);
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(join(home, 'signalled'))).toBe(false);
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  it('recognises a supervisor by its entry file and refuses a room (__room) or a stranger', async () => {
    const entry = join(home, 'entry.js');
    writeFileSync(entry, 'setInterval(() => {}, 1000);');
    const supervisor = spawn(process.execPath, [entry, '--port', '0'], { stdio: 'ignore' });
    const room = spawn(process.execPath, [entry, '__room', '--home', home], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(isSupervisorProcess(supervisor.pid as number, entry)).toBe(true);
      expect(isSupervisorProcess(room.pid as number, entry)).toBe(false);
      expect(isSupervisorProcess(supervisor.pid as number, join(home, 'other.js'))).toBe(false);
      expect(isSupervisorProcess(2 ** 22 - 5, entry)).toBe(false);
    } finally {
      supervisor.kill('SIGKILL');
      room.kill('SIGKILL');
    }
  });

  it('says what is wrong: no gonogo here, a lock without a number, a dead pid, and Docker', () => {
    expect(() => requestReload(home, false)).toThrow(/no gonogo is running/);
    lock(0);
    writeFileSync(join(home, 'run', 'supervisor.lock'), 'nope');
    expect(() => requestReload(home, false)).toThrow(/does not hold a process number/);
    lock(2 ** 22 - 7);
    expect(() => requestReload(home, false)).toThrow(/stale/);
    expect(() => requestReload(home, true)).toThrow(/in Docker.*Update key.*docker compose pull/s);
  });
});

describe('a real room (roomChild)', () => {
  const start = (over: Record<string, unknown> = {}) =>
    startGonogo({ port: 0, host: '127.0.0.1', home, cwd: home, seed: false, allowedHosts: [], agentCmd: [process.execPath, FAKE_CLAUDE], staticDir: null, checkClaude: false, env: { PATH: process.env.PATH ?? '', FAKE_CLAUDE_LOG_DIR: home }, roomChild: true, ...over });

  it('has its own token in run/room-token, new at every start, and never reads or accepts <home>/token', async () => {
    const director = 'd4'.repeat(32);
    writeFileSync(join(home, 'token'), `${director}\n`, { mode: 0o600 });
    const first = await start();
    const firstToken = first.browserToken;
    expect(firstToken).not.toBe(director);
    expect(readFileSync(join(home, 'run', 'room-token'), 'utf8').trim()).toBe(firstToken);
    expect(statSync(join(home, 'run', 'room-token')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(director);
    const open = (token: string): Promise<number> => fetch(`http://127.0.0.1:${first.port}/api/state`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
    expect(await open(director)).toBe(401);
    expect(await open(firstToken)).toBe(200);
    await first.stop();
    const second = await start();
    expect(second.browserToken).not.toBe(firstToken);
    await second.stop();
  }, 60_000);

  it('asks for the port it had, writes it to run/port, and takes another when it is taken', async () => {
    const first = await start();
    const port = first.port;
    expect(readFileSync(join(home, 'run', 'port'), 'utf8').trim()).toBe(String(port));
    await first.stop();
    const again = await start();
    expect(again.port).toBe(port);
    // taken now: a free port is used, and it is the one written down
    const other = await start({ home: mkdtempSync(join(tmpdir(), 'gng-single-b-')), cwd: home });
    expect(other.port).not.toBe(again.port);
    await other.stop();
    await again.stop();
    // a room that is not under the supervisor does not do any of this
    const plain = await start({ roomChild: false });
    expect(existsSync(join(home, 'run', 'room-token'))).toBe(true); // left by the earlier starts
    expect(plain.browserToken).toBe(readFileSync(join(home, 'token'), 'utf8').trim());
    await plain.stop();
  }, 90_000);
});

describe('reserved names', () => {
  it('rooms add refuses the names the front port answers itself, rooms already so named keep working', () => {
    for (const name of RESERVED_ROOT_NAMES) expect(() => addRoom(home, name), name).toThrow(RoomsError);
    writeFileSync(join(home, ROOMS_FILE), JSON.stringify({ version: 1, rooms: [{ id: 'api', name: 'Old' }, { id: 'rooms' }] }));
    expect(loadRooms(home).map((r) => r.id)).toEqual(['main', 'api', 'rooms']);
  });
});

describe('after review of #85', () => {
  it('a Director token that changes on disk ends the sockets opened with the old one, and the new one opens a socket', async () => {
    const s = await supervise();
    await until(async () => (await roomsOf(s)).every((r) => r.state === 'running'));
    const connect = (token: string): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, ['gonogo.v1', `token.${token}`]);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      });
    const old = s.directorToken;
    const socket = await connect(old);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    rotateDirectorToken(home);
    // the supervisor looks at the file when something asks: the next request does
    expect((await get(s, '/api/rooms', old)).status).toBe(401);
    await closed;
    await expect(connect(old)).rejects.toThrow(/401/);
    const fresh = await connect(readFileSync(join(home, 'token'), 'utf8').trim());
    fresh.close();
  }, 30_000);
});
