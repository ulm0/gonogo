/** The project folder of a room (docs/features/rooms.md, "Folders"): the checks, the file, the route of a room, and what it reaches. */
import http from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGonogo } from '../src/server/cli.js';
import type { Running } from '../src/server/cli.js';
import { nullLogger } from '../src/server/constants.js';
import { checkFolder, createProjectFolder, FolderError, PROJECT_FOLDER_FILE, readFolder, writeFolder } from '../src/server/projectfolder.js';
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
  it('gives the real path of a folder, and says why for everything else', () => {
    expect(checkFolder(project, [state])).toBe(project); // tmpdir is already a real path here
    expect(checkFolder(` ${project} `, [state])).toBe(project);
    const link = join(dir, 'link');
    symlinkSync(project, link);
    expect(checkFolder(link, [state])).toBe(project); // a link is followed once, here
    const file = join(dir, 'a-file');
    writeFileSync(file, '');
    const refuse = (value: unknown, text: RegExp): void => expect(() => checkFolder(value, [state]), String(value)).toThrow(text);
    refuse(undefined, /as text/);
    refuse('', /as text/);
    refuse(42, /as text/);
    refuse('relative/dir', /whole path/);
    refuse('./project', /whole path/);
    refuse(join(dir, 'nope'), /does not exist/);
    refuse(file, /is not a folder/);
    refuse(`${project}\u0000/x`, /NUL/);
  });

  it('refuses gonogo\'s own folder and anything inside it, through a link too, but not a folder that holds it', () => {
    const inside = join(state, 'rooms', 'a');
    mkdirSync(inside, { recursive: true });
    for (const own of [state, inside, `${state}/`, `${state}/../state`]) expect(() => checkFolder(own, [state]), own).toThrow(/gonogo's own folder/);
    const link = join(dir, 'to-state');
    symlinkSync(state, link);
    expect(() => checkFolder(link, [state])).toThrow(/gonogo's own folder/);
    expect(checkFolder(dir, [state])).toBe(dir); // the folder that holds gonogo's home is allowed
    expect(checkFolder(project, [join(dir, 'not-made-yet')])).toBe(project);
    expect(checkFolder(project, [])).toBe(project); // no folder of gonogo's named: nothing to refuse
  });

  it('refuses a folder gonogo cannot read', () => {
    if (process.getuid?.() === 0) return; // root reads everything
    const closed = join(dir, 'closed');
    mkdirSync(closed);
    chmodSync(closed, 0o000);
    try {
      expect(() => checkFolder(closed, [state])).toThrow(/cannot be read/);
    } finally {
      chmodSync(closed, 0o700);
    }
  });
});

describe('the file and the store', () => {
  it('is 0600, atomic, and holds only the folder; no file is the default; a folder that is gone falls back and says so once', () => {
    const warnings: string[] = [];
    const log = { ...nullLogger, warn: (m: string) => void warnings.push(m), child: () => log };
    const store = createProjectFolder({ roomHome: state, fallback: dir, forbidden: [state], log });
    expect(store.get()).toEqual({ dir, source: 'default', default: dir });
    expect(store.set(project)).toEqual({ before: dir, after: project });
    expect(store.get()).toEqual({ dir: project, source: 'set', default: dir });
    expect(statSync(join(state, PROJECT_FOLDER_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(state, PROJECT_FOLDER_FILE), 'utf8'))).toEqual({ version: 1, dir: project });
    expect(readdirSync(state)).toEqual([PROJECT_FOLDER_FILE]);
    expect(() => store.set(state)).toThrow(FolderError);
    expect(store.get().dir).toBe(project); // a refusal changes nothing
    rmSync(project, { recursive: true });
    expect(store.get()).toEqual({ dir, source: 'default', default: dir });
    store.get();
    expect(warnings).toHaveLength(1);
    expect(store.set(null)).toEqual({ before: dir, after: dir });
    expect(readFolder(state)).toBeNull();
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

  it('only the Director\'s own session may change it: a key, a terminal, a token, the socket and a request that says nothing get 403, and nothing changes', async () => {
    for (const actor of [undefined, 'key:abc', 'tui', 'token', 'socket', 'session; x']) expect((await call('PUT', '/api/project-folder', { dir: project }, actor)).status, String(actor)).toBe(403);
    expect((await call('GET', '/api/project-folder')).json).toMatchObject({ source: 'default' });
  });

  it('refuses a bad folder with the reason, and the folder of gonogo itself', async () => {
    const put = (body: unknown) => call('PUT', '/api/project-folder', body, 'session');
    expect(await put({ dir: 'relative' })).toMatchObject({ status: 400, json: { field: 'dir' } });
    expect((await put({ dir: join(dir, 'missing') })).status).toBe(400);
    expect((await put({ dir: home })).json.error).toMatch(/gonogo's own folder/);
    expect((await put({ dir: join(home, 'agents') })).status).toBe(400);
    expect((await put({ dir: 5 })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await call('GET', '/api/project-folder')).json).toMatchObject({ source: 'default' });
  });
});
