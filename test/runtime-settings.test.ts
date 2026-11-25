/** Runtime settings (docs/runtime-settings-spec.md): the store, the route of a room, and what a change reaches. */
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPipeAnswers, startGonogo } from '../src/server/cli.js';
import type { Running } from '../src/server/cli.js';
import { createLogger, MAX_HOPS_LIMIT, nullLogger, setLogLevel } from '../src/server/constants.js';
import { commandProgram, createSettings, globalSetting, GLOBAL_SETTINGS_FILE, SETTING_NAMES, SETTINGS_FILE, SETTINGS_MAX_BYTES, SettingsError } from '../src/server/settings.js';

let dir: string;
let roomHome: string;
let globalPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gng-set-'));
  roomHome = join(dir, 'rooms', 'a');
  mkdirSync(roomHome, { recursive: true });
  globalPath = join(dir, GLOBAL_SETTINGS_FILE);
});
afterEach(() => {
  setLogLevel(null);
  rmSync(dir, { recursive: true, force: true });
});

const make = (env: Record<string, string | undefined> = {}, global: string | null = globalPath) => createSettings({ roomHome, globalPath: global, env });

describe('the store', () => {
  it('first value wins: room file, file of every room, environment, nothing', () => {
    const s = make({ GONOGO_MAX_HOPS: '5' });
    expect(s.row('maxHops')).toMatchObject({ value: '5', source: 'env', envValue: '5', room: null, global: null });
    s.set('maxHops', 'global', '6');
    expect(s.row('maxHops')).toMatchObject({ value: '6', source: 'global', envValue: '5', global: '6' });
    s.set('maxHops', 'room', '7');
    expect(s.row('maxHops')).toMatchObject({ value: '7', source: 'room', room: '7', global: '6' });
    s.set('maxHops', 'room', null);
    expect(s.get('maxHops')).toBe('6');
    s.set('maxHops', 'global', null);
    expect(s.get('maxHops')).toBe('5');
    expect(make().row('maxHops')).toMatchObject({ value: null, source: 'default', envValue: null });
    expect(s.view().map((r) => r.key)).toEqual(SETTING_NAMES);
  });

  it('refuses a bad value with the reason, for every key, and writes nothing', () => {
    const s = make();
    const bad: Array<[Parameters<typeof s.set>[0], string]> = [
      ['maxHops', '0'], ['maxHops', String(MAX_HOPS_LIMIT + 1)], ['maxHops', 'eight'], ['maxWorking', '99'], ['maxWorking', 'x'],
      ['agentCmd', ''], ['agentCmd', '[1]'], ['agentCmd', 'a\u0000b'], ['cleanRoomImage', 'no spaces'], ['cleanRoomImage', '-x'],
      ['scrubEnv', 'A=b'], ['scrubEnv', 'TOKEN value'], ['logLevel', 'loud'], ['station', '!'], ['updateCheck', 'maybe'],
    ];
    for (const [key, value] of bad) expect(() => s.set(key, 'global', value), `${key} ${JSON.stringify(value)}`).toThrow(SettingsError);
    expect(() => statSync(globalPath)).toThrow();
    // Max Q empty is allowed: off, on purpose
    expect(s.set('maxWorking', 'room', '').row.value).toBe('');
  });

  it('the scrub list only grows: the environment\'s names stay, the files add to them, Reset removes only the added ones', () => {
    const s = make({ GONOGO_SCRUB_ENV: 'SECRET_A, TOKEN_' });
    expect(s.row('scrubEnv')).toMatchObject({ value: 'SECRET_A,TOKEN_', source: 'env', envValue: 'SECRET_A,TOKEN_' });
    s.set('scrubEnv', 'global', 'SECRET_B');
    expect(s.row('scrubEnv')).toMatchObject({ value: 'SECRET_A,TOKEN_,SECRET_B', source: 'global', global: 'SECRET_B' });
    s.set('scrubEnv', 'room', 'SECRET_A,SECRET_C');
    expect(s.get('scrubEnv')).toBe('SECRET_A,TOKEN_,SECRET_B,SECRET_C');
    s.set('scrubEnv', 'room', null);
    s.set('scrubEnv', 'global', null);
    expect(s.get('scrubEnv')).toBe('SECRET_A,TOKEN_');
    expect(make().get('scrubEnv')).toBeNull();
    // one name the strict check would refuse does not drop the rest of the operator's list
    const odd = make({ GONOGO_SCRUB_ENV: 'API_KEY, my-secret ,,OTHER_' });
    expect(odd.row('scrubEnv')).toMatchObject({ value: 'API_KEY,my-secret,OTHER_', envValue: 'API_KEY,my-secret,OTHER_', source: 'env' });
    odd.set('scrubEnv', 'global', 'ADDED');
    expect(odd.get('scrubEnv')).toBe('API_KEY,my-secret,OTHER_,ADDED');
  });

  it('a global-only key refuses the room scope; no supervisor means no global scope', () => {
    const s = make();
    for (const key of ['logLevel', 'updateCheck'] as const) expect(() => s.set(key, 'room', key === 'logLevel' ? 'info' : 'off')).toThrow(/every room/);
    // the station name may differ per room (rooms of one machine dock with each other by name)
    expect(() => s.set('station', 'room', 'x')).not.toThrow();
    expect(() => make({}, null).set('maxHops', 'global', '3')).toThrow(/no supervisor/);
    expect(make({}, null).set('maxHops', 'room', '3').row.value).toBe('3');
  });

  it('leaves no temporary file behind and does not write through a planted name', () => {
    const s = make();
    s.set('maxHops', 'room', '4');
    s.set('maxHops', 'room', '5');
    expect(readdirSync(roomHome)).toEqual([SETTINGS_FILE]);
  });

  it('keeps the files 0600 and, read again, a hand-edited file cannot inject: unknown keys, non-strings, bad values, a room file with a global key, over 16 KiB', () => {
    make().set('maxHops', 'room', '4');
    expect(statSync(join(roomHome, SETTINGS_FILE)).mode & 0o777).toBe(0o600);
    writeFileSync(globalPath, JSON.stringify({ version: 1, values: { maxHops: '9', maxWorking: 3, agentCmd: '[1]', nope: 'x', scrubEnv: 'A=b', logLevel: 'debug' } }));
    writeFileSync(join(roomHome, SETTINGS_FILE), JSON.stringify({ version: 1, values: { logLevel: 'error', station: 'x', cleanRoomImage: 'img:1' } }));
    const s = make();
    expect(s.get('maxHops')).toBe('9');
    expect(s.get('maxWorking')).toBeNull();
    expect(s.get('agentCmd')).toBeNull();
    expect(s.get('scrubEnv')).toBeNull();
    expect(s.row('logLevel')).toMatchObject({ value: 'debug', source: 'global' }); // the room file's copy of a global key is not read
    expect(s.get('cleanRoomImage')).toBe('img:1');
    writeFileSync(globalPath, `{"values":{"maxHops":"2"},"pad":"${'x'.repeat(SETTINGS_MAX_BYTES)}"}`);
    s.reload();
    expect(s.row('maxHops').source).toBe('default');
    writeFileSync(globalPath, 'not json');
    s.reload();
    expect(s.get('maxHops')).toBeNull();
  });

  it('an environment value the parser refuses is no default; the file of every room is seen by another room after reload', () => {
    expect(make({ GONOGO_MAX_HOPS: '8000' }).row('maxHops')).toMatchObject({ value: null, source: 'default', envValue: null });
    const one = make();
    const two = createSettings({ roomHome: join(dir, 'rooms', 'b'), globalPath, env: {} });
    one.set('logLevel', 'global', 'debug');
    expect(two.get('logLevel')).toBeNull();
    two.reload();
    expect(two.get('logLevel')).toBe('debug');
    expect(globalSetting(globalPath, 'logLevel', {})).toBe('debug');
    expect(globalSetting(globalPath, 'station', { GONOGO_STATION: 'galley' })).toBe('galley');
    expect(globalSetting(null, 'station', {})).toBeNull();
  });

  it('shows an agent command as its program and nothing after it', () => {
    expect(commandProgram('/usr/bin/foo --token SECRET')).toBe('foo');
    expect(commandProgram('["/opt/x/bar","--key","SECRET"]')).toBe('bar');
    expect(commandProgram('[1]')).toBe('(unreadable)');
  });
});

describe('the pipe of the supervisor', () => {
  it('a gonogo-settings line makes the room read the settings again; other lines still go their way', () => {
    let calls = 0;
    const alerts: string[] = [];
    const pipe = createPipeAnswers(() => undefined, 5000, (t) => alerts.push(t), () => undefined, () => void (calls += 1));
    pipe.feed('gonogo-settings\ngonogo-alert "x"\ngonogo-settings\n');
    expect(calls).toBe(2);
    expect(alerts).toEqual(['x']);
  });
});

/* ---- a real room, asked over its own socket the way the supervisor's proxy asks ---- */

describe('the route of a room', () => {
  let run: Running;
  let home: string;
  beforeEach(async () => {
    home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    run = await startGonogo({
      port: 0,
      host: '127.0.0.1',
      home,
      cwd: dir,
      seed: false,
      allowedHosts: [],
      agentCmd: [process.execPath, '-e', ''],
      roomChild: true,
      env: { ...process.env, GONOGO_GLOBAL_SETTINGS: globalPath, GONOGO_MAX_HOPS: '6', GONOGO_ROOM: 'a' },
      log: nullLogger,
    });
  });
  afterEach(async () => {
    await run.stop();
  });

  const call = (method: string, path: string, body?: unknown, actor?: string): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath: join(home, 'run', 'room.sock'), method, path, headers: { host: '127.0.0.1', 'content-type': 'application/json', ...(actor === undefined ? {} : { 'x-gonogo-actor': actor }) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const blackBox = (): string =>
    readdirSync(join(home, 'black-box'))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(home, 'black-box', f), 'utf8'))
      .join('\n');

  it('the room default mode: auto and bypass are set by the Director\'s login, never by a key, a terminal or an unmarked caller; a milder mode or clearing is open', async () => {
    for (const actor of [undefined, 'key:abc123', 'tui', 'session; x']) {
      for (const body of [{ mode: 'auto' }, { mode: 'bypassPermissions', confirmBypass: true }]) expect((await call('PUT', '/api/models/mode', body, actor)).status, `${String(actor)} ${JSON.stringify(body)}`).toBe(403);
      expect((await call('PUT', '/api/models/mode', { mode: 'acceptEdits' }, actor)).status).toBe(200);
      expect((await call('PUT', '/api/models/mode', { mode: null }, actor)).status).toBe(200);
    }
    for (const actor of ['session', 'token', 'socket']) {
      expect((await call('PUT', '/api/models/mode', { mode: 'auto' }, actor)).json, actor).toMatchObject({ mode: 'auto' });
      expect((await call('PUT', '/api/models/mode', { mode: 'bypassPermissions' }, actor)).status).toBe(400);
      expect((await call('PUT', '/api/models/mode', { mode: 'bypassPermissions', confirmBypass: true }, actor)).json, actor).toMatchObject({ mode: 'bypassPermissions' });
    }
  });

  it('the room default sandbox: the flavors say which runtimes Docker lists; one that is not installed is refused (400, field sandbox), docker and null are kept', async () => {
    const flavors = await call('GET', '/api/cleanroom/flavors');
    expect(flavors.status).toBe(200);
    expect(flavors.json).toMatchObject({ available: { docker: true }, default: 'docker' }); // this machine has no gvisor or Kata runtime for the test
    expect((flavors.json.available as Record<string, boolean>).gvisor).toBe(false);
    for (const sandbox of ['gvisor', 'microvm']) expect(await call('PUT', '/api/models/sandbox', { sandbox }, 'session'), sandbox).toMatchObject({ status: 400, json: { field: 'sandbox' } });
    expect(await call('PUT', '/api/models/sandbox', { sandbox: 'warp' }, 'session')).toMatchObject({ status: 400, json: { field: 'sandbox' } });
    expect((await call('PUT', '/api/models/sandbox', { sandbox: 'docker' }, 'session')).status).toBe(200);
    expect((await call('PUT', '/api/models/sandbox', { sandbox: null }, 'session')).status).toBe(200);
    expect((await call('GET', '/api/models')).json).not.toHaveProperty('sandbox');
  });

  it('lists the eight keys with their source, takes a value from a session, and says where it came from after', async () => {
    const list = await call('GET', '/api/settings');
    expect(list.status).toBe(200);
    expect((list.json.keys as Array<{ key: string }>).map((k) => k.key)).toEqual(SETTING_NAMES);
    expect((list.json.keys as Array<Record<string, unknown>>).find((k) => k.key === 'maxHops')).toMatchObject({ value: '6', source: 'env', applies: 'live' });
    const put = await call('PUT', '/api/settings/maxHops', { scope: 'room', value: '3' }, 'session');
    expect(put.status).toBe(200);
    expect(put.json.row).toMatchObject({ key: 'maxHops', value: '3', source: 'room', envValue: '6' });
    await expect.poll(blackBox).toContain('setting maxHops (room) by session: \\"6\\" -> \\"3\\"');
    const back = await call('PUT', '/api/settings/maxHops', { scope: 'room', value: null }, 'key:abc123');
    expect(back.json.row).toMatchObject({ value: '6', source: 'env' });
    await expect.poll(blackBox).toContain('by key:abc123: \\"3\\" -> \\"6\\"');
  });

  it('refuses a bad value, a bad scope, a global key for a room, an unknown key, and a global write with no file', async () => {
    expect((await call('PUT', '/api/settings/maxHops', { scope: 'room', value: '0' }, 'session')).status).toBe(400);
    expect((await call('PUT', '/api/settings/maxHops', { scope: 'all', value: '3' }, 'session')).status).toBe(400);
    expect((await call('PUT', '/api/settings/maxHops', { scope: 'room', value: 3 }, 'session')).status).toBe(400);
    const global = await call('PUT', '/api/settings/logLevel', { scope: 'room', value: 'debug' }, 'session');
    expect(global.status).toBe(400);
    expect((await call('PUT', '/api/settings/nope', { scope: 'room', value: '1' }, 'session')).status).toBe(404);
    expect((await call('GET', '/api/settings/maxHops')).status).toBe(405);
  });

  it('the agent command and the scrub list are for the owner\'s session only: a key, a token, the socket, a terminal login and a request that says nothing get 403, and the log shows the program only', async () => {
    for (const key of ['agentCmd', 'scrubEnv'] as const) {
      for (const actor of [undefined, 'key:abc', 'token', 'socket', 'tui', 'session; x', 'SESSION']) {
        const res = await call('PUT', `/api/settings/${key}`, { scope: 'room', value: key === 'agentCmd' ? '/bin/true' : 'FOO' }, actor);
        expect(res.status, `${key} ${String(actor)}`).toBe(403);
      }
    }
    expect((await call('PUT', '/api/settings/agentCmd', { scope: 'room', value: '/usr/bin/foo --token SECRET-ARG' }, 'session')).status).toBe(200);
    await expect.poll(blackBox).toContain('setting agentCmd (room) by session: default -> foo');
    expect(blackBox()).not.toContain('SECRET-ARG'); // read after the line above showed up
    expect(readFileSync(join(home, SETTINGS_FILE), 'utf8')).toContain('SECRET-ARG'); // the file has it, 0600, for the launcher
    expect(statSync(join(home, SETTINGS_FILE)).mode & 0o777).toBe(0o600);
  });

  it('a global value goes to the file of every room', async () => {
    // the announcement is a line on stdout only for a room the supervisor started (--exit-with-stdin): the file is the proof here
    const put = await call('PUT', '/api/settings/logLevel', { scope: 'global', value: 'debug' }, 'session');
    expect(put.status).toBe(200);
    expect(put.json.row).toMatchObject({ value: 'debug', source: 'global', applies: 'live' });
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({ version: 1, values: { logLevel: 'debug' } });
    expect(statSync(globalPath).mode & 0o777).toBe(0o600);
  });

  it('the network addresses of the computer go to a login session or the local socket only; a key, a terminal and a request that says nothing get none, and the state never carries them', async () => {
    const mine = await call('GET', '/api/docking/addresses', undefined, 'session');
    expect(Array.isArray(mine.json.addresses)).toBe(true);
    expect(typeof mine.json.container).toBe('boolean');
    expect((await call('GET', '/api/docking/addresses', undefined, 'socket')).json.addresses).toEqual(mine.json.addresses);
    for (const actor of [undefined, 'key:abc', 'tui', 'token', 'session; x']) expect((await call('GET', '/api/docking/addresses', undefined, actor)).json.addresses, String(actor)).toEqual([]);
    const state = JSON.stringify((await call('GET', '/api/state')).json);
    for (const address of mine.json.addresses as string[]) expect(state).not.toContain(address);
  });

  it('what left for a station (the Outbound view) is for the Director\'s own login; the list of links is open to any grant', async () => {
    const dock = 'a'.repeat(32);
    for (const actor of [undefined, 'key:abc', 'tui', 'socket']) expect((await call('GET', `/api/docking/outbound?dock=${dock}`, undefined, actor)).status, String(actor)).toBe(403);
    expect((await call('GET', `/api/docking/outbound?dock=${dock}`, undefined, 'session')).json).toEqual({ dock, entries: [] });
    expect((await call('GET', '/api/docking/outbound?dock=nope', undefined, 'token')).json).toEqual({ dock: 'nope', entries: [] });
    expect((await call('GET', '/api/links')).json).toEqual({ links: [] });
    expect((await call('GET', '/api/links/dl_0123456789abcdef')).status).toBe(404);
  });

  it('applies what can be applied now: Max Q on the hub, the log level of the process; the Max Q control keeps its value in the room file', async () => {
    expect((await call('PUT', '/api/settings/maxWorking', { scope: 'room', value: '2' }, 'session')).status).toBe(200);
    expect((await call('GET', '/api/state')).json.governor).toMatchObject({ limit: 2 });
    expect((await call('PUT', '/api/settings/maxWorking', { scope: 'room', value: '' }, 'session')).status).toBe(200);
    expect((await call('GET', '/api/state')).json.governor).toMatchObject({ limit: null });
    // the Max Q control (its own route) writes the same key
    expect((await call('PUT', '/api/governor', { limit: 3 })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8')).values.maxWorking).toBe('3');
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    expect((await call('PUT', '/api/settings/logLevel', { scope: 'global', value: 'error' }, 'session')).status).toBe(200);
    logger.info('quiet now');
    logger.error('still said');
    expect(lines).toHaveLength(1);
    expect((await call('PUT', '/api/settings/logLevel', { scope: 'global', value: null }, 'session')).status).toBe(200);
    logger.info('said again');
    expect(lines).toHaveLength(2);
  });
});
