/** Room editor: the store (a real temp folder), the routes (a real store behind the web server) and the audit lines. */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKS, DEFAULT_DESKS, place } from '../src/shared/layout.js';
import type { Hub, Logger, RoomView, ServerInfo, TerminalHost } from '../src/shared/protocol.js';
import { audited, ROOM_AUDIT } from '../src/server/audited.js';
import { nullLogger } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { createRoomLayout } from '../src/server/roomlayout.js';
import type { RoomLayoutStore } from '../src/server/roomlayout.js';
import { createWebServer } from '../src/server/web.js';
import type { WebServer } from '../src/server/web.js';

const TOKEN = 'ab'.repeat(32);
let dir: string;
let emitted: RoomView[];
let logs: string[];
let web: WebServer | null = null;
const open: RoomLayoutStore[] = [];

const quiet = (sink: string[]): Logger => {
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: (m) => void sink.push(m), error: (m, ...e) => void sink.push([m, ...e.map(String)].join(' ')), child: () => log };
  return log;
};
const make = (): RoomLayoutStore => {
  const store = createRoomLayout({ dir, emit: (v) => void emitted.push(v), log: quiet(logs) });
  open.push(store);
  return store;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-room-'));
  emitted = [];
  logs = [];
});
afterEach(async () => {
  await web?.close();
  web = null;
  for (const s of open.splice(0)) await s.close();
  await rm(dir, { recursive: true, force: true });
});

const fails = async (run: Promise<unknown>, code: string, field?: string): Promise<HubError> => {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HubError);
  expect(error).toMatchObject({ code, ...(field === undefined ? {} : { field }) });
  return error as HubError;
};
const moved = (): ReturnType<typeof place> => place([...DEFAULT_BLOCKS], 'maxq', { x: 0, y: 0 });

describe('the store', () => {
  it('has no layout at first: today\'s page', async () => {
    const store = make();
    await store.load();
    expect(store.view()).toEqual({ rev: 0, layout: null });
  });

  it('saves a layout from the revision it was made from, writes the file whole, and tells the browsers', async () => {
    const store = make();
    await store.load();
    const view = await store.save({ rev: 0, blocks: moved(), desks: { sort: 'name', order: [] } });
    expect(view.rev).toBe(1);
    expect(view.layout?.desks).toEqual({ sort: 'name', order: [] });
    expect(emitted).toEqual([view]);
    expect(JSON.parse(await readFile(join(dir, 'room.json'), 'utf8'))).toMatchObject({ version: 1, rev: 1, blocks: moved(), desks: { sort: 'name' } });
    expect((await stat(join(dir, 'room.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['room.json']);
  });

  it('refuses a save from an older revision, and a bad layout, naming the field, and changes nothing', async () => {
    const store = make();
    await store.load();
    await store.save({ rev: 0, blocks: moved() });
    const stale = await fails(store.save({ rev: 0, blocks: DEFAULT_BLOCKS }), 'conflict', 'rev');
    expect(stale.message).toContain('revision 1');
    await fails(store.save({ rev: 1, blocks: [] }), 'bad_request', 'blocks');
    await fails(store.save({ rev: 1, blocks: [...DEFAULT_BLOCKS.slice(0, 5), { ...DEFAULT_BLOCKS[5], hidden: true }] }), 'bad_request', 'blocks');
    await fails(store.save({ rev: 1, blocks: DEFAULT_BLOCKS, desks: { sort: 'x', order: [] } }), 'bad_request', 'desks');
    await fails(store.save({ blocks: DEFAULT_BLOCKS }), 'bad_request', 'rev');
    await fails(store.save({ rev: 1.5, blocks: DEFAULT_BLOCKS }), 'bad_request', 'rev');
    await fails(store.save({ rev: 1, blocks: DEFAULT_BLOCKS, layout: 1 }), 'bad_request', 'layout');
    await fails(store.save('x'), 'bad_request');
    expect(store.view().rev).toBe(1);
    expect(emitted).toHaveLength(1);
  });

  it('keeps the layout over a restart, and the revision with it', async () => {
    const first = make();
    await first.load();
    await first.save({ rev: 0, blocks: moved(), desks: { sort: 'manual', order: ['p:flight', 'a:ana'] } });
    const again = make();
    await again.load();
    expect(again.view()).toEqual(first.view());
    expect((await again.save({ rev: 1, blocks: DEFAULT_BLOCKS })).rev).toBe(2);
  });

  it('resets: the file goes and the page is today\'s, or only the order of the desks goes', async () => {
    const store = make();
    await store.load();
    expect(await store.reset('all')).toEqual({ rev: 0, layout: null });
    expect(emitted).toEqual([]);
    await store.save({ rev: 0, blocks: moved(), desks: { sort: 'manual', order: ['p:flight'] } });
    const desks = await store.reset('desks');
    expect(desks.layout).toMatchObject({ blocks: moved(), desks: DEFAULT_DESKS });
    expect(desks.rev).toBe(2);
    const all = await store.reset('all');
    expect(all).toEqual({ rev: 3, layout: null });
    await expect(stat(join(dir, 'room.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(emitted.at(-1)).toEqual(all);
    // a window that still has the revision from before the reset is told so
    await fails(store.save({ rev: 2, blocks: DEFAULT_BLOCKS }), 'conflict', 'rev');
  });

  it('keeps a damaged file aside and uses the default layout, and does the same for a file that is not a layout', async () => {
    await writeFile(join(dir, 'room.json'), '{ nope');
    const store = make();
    await store.load();
    expect(store.view()).toEqual({ rev: 0, layout: null });
    expect(await readFile(join(dir, 'room.json.bad'), 'utf8')).toBe('{ nope');
    expect(logs.some((l) => l.includes('room.json could not be read'))).toBe(true);
    await rm(join(dir, 'room.json.bad'));
    await writeFile(join(dir, 'room.json'), JSON.stringify({ version: 1, rev: 4, blocks: DEFAULT_BLOCKS.slice(1) }));
    const other = make();
    await other.load();
    expect(other.view()).toEqual({ rev: 0, layout: null });
    expect((await readdir(dir)).sort()).toEqual(['room.json.bad']);
  });

  it('puts the view back when the file cannot be written', async () => {
    const store = make();
    await store.load();
    await store.save({ rev: 0, blocks: DEFAULT_BLOCKS });
    await rm(dir, { recursive: true, force: true });
    await fails(store.save({ rev: 1, blocks: moved() }), 'internal');
    expect(store.view().rev).toBe(1);
  });
});

describe('the Black Box', () => {
  it('says that the layout was saved or reset, and which part, never a number of it', async () => {
    const told: Array<[string, string]> = [];
    const store = audited(make(), (kind, text) => void told.push([kind, text]), ROOM_AUDIT);
    await store.load();
    await store.save({ rev: 0, blocks: moved(), desks: { sort: 'manual', order: ['a:secret-name'] } });
    await store.reset('desks');
    await store.reset('all');
    expect(told).toEqual([['config', 'Director saved the room layout'], ['config', 'Director reset the order of the desks'], ['config', 'Director reset the room layout']]);
    expect(JSON.stringify(told)).not.toContain('secret-name');
  });
});

describe('the routes', () => {
  async function start(withStore: boolean): Promise<number> {
    const store = make();
    await store.load();
    web = createWebServer({
      host: '127.0.0.1',
      port: 0,
      browserToken: TOKEN,
      allowedHosts: [],
      staticDir: null,
      hub: {} as Hub,
      terminals: {} as TerminalHost,
      resolveToken: () => null,
      info: () => ({}) as ServerInfo,
      isReady: () => true,
      ...(withStore ? { room: store } : {}),
      log: nullLogger,
    });
    return (await web.listen()).port;
  }
  const call = async (port: number, method: string, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('answers the layout, saves from a revision, answers a conflict and a bad field, and resets', async () => {
    const port = await start(true);
    expect(await call(port, 'GET', '/api/room')).toEqual({ status: 200, json: { rev: 0, layout: null } });
    const saved = await call(port, 'PUT', '/api/room', { rev: 0, blocks: moved() });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ rev: 1, layout: { blocks: moved(), desks: DEFAULT_DESKS } });
    const stale = await call(port, 'PUT', '/api/room', { rev: 0, blocks: moved() });
    expect([stale.status, stale.json.code, stale.json.field]).toEqual([409, 'conflict', 'rev']);
    const bad = await call(port, 'PUT', '/api/room', { rev: 1, blocks: [] });
    expect([bad.status, bad.json.field]).toEqual([400, 'blocks']);
    expect((await call(port, 'DELETE', '/api/room?part=desks')).json).toMatchObject({ rev: 2, layout: { desks: DEFAULT_DESKS } });
    expect((await call(port, 'DELETE', '/api/room?part=nope')).status).toBe(400);
    expect((await call(port, 'DELETE', '/api/room')).json).toEqual({ rev: 3, layout: null });
  });

  it('wants the browser token, allows only GET, PUT and DELETE, and is 404 without a store', async () => {
    const port = await start(true);
    expect((await call(port, 'GET', '/api/room', undefined, 'c3'.repeat(32))).status).toBe(401);
    expect((await call(port, 'POST', '/api/room', {})).status).toBe(405);
    expect((await call(port, 'GET', '/api/room/x')).status).toBe(404);
    await web?.close();
    const none = await start(false);
    expect((await call(none, 'GET', '/api/room')).status).toBe(404);
  });
});
