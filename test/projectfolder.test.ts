/** The project folder of a room (docs/features/rooms.md, "Folders"): the checks, the file, the route of a room, and what it reaches. */
import http from 'node:http';
import { WebSocket } from 'ws';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGonogo } from '../src/server/cli.js';
import type { Running } from '../src/server/cli.js';
import { nullLogger } from '../src/server/constants.js';
import { checkFolder, createProjectFolder, FolderError, folderWarning, PROJECT_FOLDER_FILE, readFolder, writeFolder } from '../src/server/projectfolder.js';
import { stepUpReason } from '../src/server/stepup.js';

let dir: string;
let project: string;
let state: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gng-pf-'));
  project = join(dir, 'project');
  state = join(dir, 'state');
  mkdirSync(project);
  mkdirSync(state);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('checkFolder', () => {
  it('gives the real path of a folder, and says why for everything that has not the shape of one', () => {
    expect(checkFolder(project)).toBe(project);
    expect(checkFolder(` ${project} `)).toBe(project);
    const link = join(dir, 'link');
    symlinkSync(project, link);
    expect(checkFolder(link)).toBe(project); // a link is followed once, here
    const file = join(dir, 'a-file');
    writeFileSync(file, '');
    const refuse = (value: unknown, text: RegExp): void => expect(() => checkFolder(value), String(value)).toThrow(text);
    refuse(undefined, /as text/);
    refuse('', /as text/);
    refuse(42, /as text/);
    refuse('relative/dir', /whole path/);
    refuse('./project', /whole path/);
    refuse(join(dir, 'nope'), /does not exist/);
    refuse(file, /is not a folder/);
    refuse(`${project}\u0000/x`, /NUL/);
  });

  it('refuses nothing for where a folder is: gonogo\'s own folders, the home directory and the root pass, with a warning', () => {
    const inside = join(state, 'rooms', 'a');
    mkdirSync(inside, { recursive: true });
    for (const where of [state, inside, `${state}/`, dir, '/', homedir()]) expect(checkFolder(where), where).toBeTruthy();
  });

  it('refuses a folder gonogo cannot read', () => {
    if (process.getuid?.() === 0) return; // root reads everything
    const closed = join(dir, 'closed');
    mkdirSync(closed);
    chmodSync(closed, 0o000);
    try {
      expect(() => checkFolder(closed)).toThrow(/cannot be read/);
    } finally {
      chmodSync(closed, 0o700);
    }
  });
});

describe('folderWarning', () => {
  it('says so when a folder is, holds or lies in gonogo\'s own, with the words of RSO; and when it is broad', () => {
    const inside = join(state, 'rooms', 'a');
    mkdirSync(inside, { recursive: true });
    const own = 'Agents can read and change gonogo\'s own settings and keys in this folder without asking.';
    const broad = 'Broad folder: agents can read everything under it.';
    for (const where of [state, inside, dir]) expect(folderWarning(where, [state]), where).toBe(own);
    expect(folderWarning(project, [state])).toBeNull();
    const fakeHome = join(dir, 'fake-home');
    mkdirSync(join(fakeHome, 'work'), { recursive: true });
    const before = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(folderWarning('/', [])).toBe(broad);
      expect(folderWarning('/', [state])).toBe(own); // the root holds gonogo's home too: the first words win
      expect(folderWarning(fakeHome, [state])).toBe(broad);
      expect(folderWarning(dir, [])).toBe(broad); // holds the home directory
      expect(folderWarning(join(fakeHome, 'work'), [state])).toBeNull(); // a folder inside the home directory is what a project is
      expect(folderWarning(project, [state], { CLAUDE_CONFIG_DIR: project })).toBe(broad);
    } finally {
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
    }
  });
});

describe('the file and the store', () => {
  it('is 0600, atomic, and holds only the folder; no file is the default; a folder that is gone falls back and says so once', () => {
    const started = join(dir, 'started');
    mkdirSync(started);
    const warnings: string[] = [];
    const log = { ...nullLogger, warn: (m: string) => void warnings.push(m), child: () => log };
    const store = createProjectFolder({ roomHome: state, fallback: started, own: [state], log });
    expect(store.get()).toEqual({ dir: started, source: 'default', default: started, warning: null });
    expect(store.set(project)).toEqual({ before: started, after: project, warning: null });
    expect(store.get()).toEqual({ dir: project, source: 'set', default: started, warning: null });
    expect(statSync(join(state, PROJECT_FOLDER_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(state, PROJECT_FOLDER_FILE), 'utf8'))).toEqual({ version: 1, dir: project });
    expect(readdirSync(state)).toEqual([PROJECT_FOLDER_FILE]);
    expect(() => store.set(join(dir, 'missing'))).toThrow(FolderError);
    expect(store.get().dir).toBe(project); // a refusal changes nothing
    rmSync(project, { recursive: true });
    expect(store.get()).toEqual({ dir: started, source: 'default', default: started, warning: null });
    store.get();
    expect(warnings).toHaveLength(1);
    expect(store.set(null)).toEqual({ before: started, after: started, warning: null });
    expect(readFolder(state)).toBeNull();
  });

  it('a folder of gonogo\'s or a broad one is kept, with its warning, for the room and for the default', () => {
    const started = join(dir, 'started');
    mkdirSync(started);
    const store = createProjectFolder({ roomHome: state, fallback: dir, own: [state] });
    expect(store.get()).toMatchObject({ dir, source: 'default', warning: expect.stringMatching(/gonogo's own settings and keys/) as string });
    expect(store.set(state)).toMatchObject({ after: state, warning: expect.stringMatching(/change gonogo's own settings and keys/) as string });
    expect(store.set(started)).toMatchObject({ after: started, warning: null });
  });

  it('does not trust the shape of a stored folder: a planted file with a relative path, a missing folder, a file or a NUL gives the default, with one warning each', () => {
    const started = join(dir, 'started');
    mkdirSync(started);
    const file = join(dir, 'a-file');
    writeFileSync(file, '');
    const warnings: string[] = [];
    const log = { ...nullLogger, warn: (m: string) => void warnings.push(m), child: () => log };
    const store = createProjectFolder({ roomHome: state, fallback: started, own: [state], log });
    for (const planted of ['relative', join(dir, 'gone'), file, 42]) {
      writeFileSync(join(state, PROJECT_FOLDER_FILE), JSON.stringify({ version: 1, dir: planted }));
      expect(store.get(), String(planted)).toEqual({ dir: started, source: 'default', default: started, warning: null });
    }
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('reads a damaged or hostile file as no folder', () => {
    for (const text of ['not json', '{"dir":42}', '{"dir":"relative"}', '{"dir":"/a\\u0000b"}', '[]', '']) {
      writeFileSync(join(state, PROJECT_FOLDER_FILE), text);
      expect(readFolder(state), text).toBeNull();
    }
    writeFolder(state, project);
    expect(readFolder(state)).toBe(project);
  });
});

describe('the dry run', () => {
  it('says what a PUT would find and writes nothing: the real path and the warning, or why not', () => {
    const store = createProjectFolder({ roomHome: state, fallback: project, own: [state] });
    const link = join(dir, 'link');
    symlinkSync(project, link);
    expect(store.check(link)).toEqual({ ok: true, dir: project, warning: null });
    expect(store.check(state)).toMatchObject({ ok: true, dir: state, warning: expect.stringMatching(/gonogo's own settings and keys/) as string });
    expect(store.check(join(dir, 'missing'))).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) as string, warning: null });
    expect(store.check('relative')).toMatchObject({ ok: false, reason: expect.stringMatching(/whole path/) as string });
    expect(store.check('')).toMatchObject({ ok: false });
    expect(store.check(undefined)).toMatchObject({ ok: false });
    expect(readdirSync(state)).toEqual([]); // nothing written
  });
});

describe('the step-up', () => {
  it('asks for the password to change the folder of a room, and to add a room that has one; a plain room does not', () => {
    expect(stepUpReason('PUT', '/api/project-folder', null)).toMatch(/project folder/);
    expect(stepUpReason('POST', '/api/rooms', { id: 'docs', dir: '/srv/x' })).toMatch(/project folder/);
    expect(stepUpReason('POST', '/api/rooms', { id: 'docs' })).toBeNull();
    expect(stepUpReason('POST', '/api/rooms', { id: 'docs', dir: null })).toBeNull();
    expect(stepUpReason('GET', '/api/project-folder', null)).toBeNull();
  });
});

/* ---- a real room, asked over its own socket the way the supervisor's proxy asks ---- */

describe('the route of a room', () => {
  let run: Running;
  let home: string;
  let started: string;
  beforeEach(async () => {
    home = join(dir, 'home');
    started = join(dir, 'started-in');
    mkdirSync(started);
    mkdirSync(home, { recursive: true });
    run = await startGonogo({ port: 0, host: '127.0.0.1', home, cwd: started, seed: false, allowedHosts: [], agentCmd: [process.execPath, '-e', ''], roomChild: true, env: { ...process.env }, log: nullLogger });
  });
  afterEach(async () => {
    await run.stop();
  });

  const call = (method: string, path: string, body?: unknown, actor?: string): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath: join(home, 'run', 'room.sock'), method, path, headers: { host: '127.0.0.1', 'content-type': 'application/json', ...(actor === undefined ? {} : { 'x-gonogo-actor': actor }) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const blackBox = (): string =>
    readdirSync(join(home, 'black-box'))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(home, 'black-box', f), 'utf8'))
      .join('\n');

  it('starts with the folder gonogo was started in, and the boss is there; a set folder wins at once for the hire form (info.cwd) and for the next boss', async () => {
    const first = await call('GET', '/api/project-folder');
    expect(first.json).toMatchObject({ dir: started, source: 'default', default: started });
    expect((first.json.boss as { dir: string }).dir).toBe(started);
    expect(((await call('GET', '/api/state')).json.info as { cwd: string }).cwd).toBe(started);
    const put = await call('PUT', '/api/project-folder', { dir: project }, 'session');
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ dir: project, source: 'set', note: expect.stringMatching(/that run keep their folder/) as string });
    // the running boss keeps what it has; the answer says so by showing both
    expect((put.json.boss as { dir: string }).dir).toBe(started);
    expect(((await call('GET', '/api/state')).json.info as { cwd: string }).cwd).toBe(project);
    await expect.poll(blackBox).toContain('project folder by session:');
    expect(blackBox()).toContain(JSON.stringify(project).replace(/"/g, '\\"'));
    const back = await call('PUT', '/api/project-folder', { dir: null }, 'session');
    expect(back.json).toMatchObject({ dir: started, source: 'default' });
  });

  it('only the Director may change it (his login session, or the browser token of an install with no account): a key, a terminal, the socket and a request that says nothing get 403, and nothing changes', async () => {
    for (const actor of [undefined, 'key:abc', 'tui', 'socket', 'session; x']) expect((await call('PUT', '/api/project-folder', { dir: project }, actor)).status, String(actor)).toBe(403);
    expect((await call('GET', '/api/project-folder')).json).toMatchObject({ source: 'default' });
    expect((await call('PUT', '/api/project-folder', { dir: project }, 'token')).status).toBe(200);
  });

  it('answers the dry run to the Director (session or browser token) only, before anything is saved, and writes nothing', async () => {
    for (const actor of [undefined, 'key:abc', 'tui', 'socket', 'session; x']) expect((await call('GET', `/api/project-folder/check?dir=${encodeURIComponent(project)}`, undefined, actor)).status, String(actor)).toBe(403);
    expect((await call('GET', `/api/project-folder/check?dir=${encodeURIComponent(project)}`, undefined, 'token')).json).toMatchObject({ ok: true });
    const ask = (value: string) => call('GET', `/api/project-folder/check?dir=${encodeURIComponent(value)}`, undefined, 'session');
    expect((await ask(project)).json).toEqual({ ok: true, dir: project, warning: null });
    expect((await ask(home)).json).toMatchObject({ ok: true, warning: expect.stringMatching(/gonogo's own settings and keys/) as string });
    expect((await ask(join(dir, 'missing'))).json).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) as string });
    expect((await call('GET', '/api/project-folder/check', undefined, 'session')).json).toMatchObject({ ok: false });
    expect((await call('GET', '/api/project-folder')).json).toMatchObject({ source: 'default' });
    expect(existsSync(join(home, 'project-folder.json'))).toBe(false);
  });

  it('tells an open page when the folder changes (the hire form\'s default), with the whole info', async () => {
    const ws = new WebSocket(`ws+unix://${join(home, 'run', 'room.sock')}:/ws`, ['gonogo.v1'], { headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' } });
    const frames: Array<{ t?: string; info?: { cwd?: string } }> = [];
    ws.on('message', (data, binary) => {
      if (!binary) frames.push(JSON.parse(String(data)) as { t?: string; info?: { cwd?: string } });
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    try {
      expect((await call('PUT', '/api/project-folder', { dir: project }, 'session')).status).toBe(200);
      await expect.poll(() => frames.find((f) => f.t === 'info')?.info?.cwd).toBe(project);
    } finally {
      ws.close();
    }
  });

  it('refuses a folder that has not the shape of one, and takes gonogo\'s own with a warning', async () => {
    const put = (body: unknown) => call('PUT', '/api/project-folder', body, 'session');
    expect(await put({ dir: 'relative' })).toMatchObject({ status: 400, json: { field: 'dir' } });
    expect((await put({ dir: join(dir, 'missing') })).status).toBe(400);
    expect((await put({ dir: 5 })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await call('GET', '/api/project-folder')).json).toMatchObject({ source: 'default' });
    // the Director's call: where a folder is decides nothing, he is told
    const own = await put({ dir: home });
    expect(own.status).toBe(200);
    expect(own.json).toMatchObject({ dir: home, source: 'set', warning: expect.stringMatching(/gonogo's own settings and keys/) as string });
    await expect.poll(blackBox).toContain('gonogo');
    expect((await put({ dir: project })).json.warning).toBeNull();
  });
});

describe('a room started in a broad folder (the home directory of a service)', () => {
  it('uses it, as before, and says so in the warning; the hire form still has it', async () => {
    const home = join(dir, 'home2');
    mkdirSync(home, { recursive: true });
    const broad = homedir();
    const run = await startGonogo({ port: 0, host: '127.0.0.1', home, cwd: broad, seed: false, allowedHosts: [], agentCmd: [process.execPath, '-e', ''], roomChild: true, env: { ...process.env }, log: nullLogger });
    try {
      const get = (path: string): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const req = http.request({ socketPath: join(home, 'run', 'room.sock'), method: 'GET', path, headers: { host: '127.0.0.1' } }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>));
          });
          req.on('error', reject);
          req.end();
        });
      expect(await get('/api/project-folder')).toMatchObject({ dir: broad, source: 'default', warning: 'Broad folder: agents can read everything under it.' });
      expect(((await get('/api/state')).info as { cwd: string }).cwd).toBe(broad);
    } finally {
      await run.stop();
    }
  });
});
