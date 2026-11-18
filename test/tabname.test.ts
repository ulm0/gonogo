/** Tab name: the store, the routes, the Black Box line, the title and the Flight Rules block. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultView } from '../src/shared/livery.js';
import { TAB_NAME_MAX_CHARS, tabTitle } from '../src/shared/protocol.js';
import type { Hub, Logger, ServerInfo, StateSnapshot, TabNameView, TerminalHost } from '../src/shared/protocol.js';
import { audited, TABNAME_AUDIT } from '../src/server/audited.js';
import { nullLogger } from '../src/server/constants.js';
import { HubError } from '../src/server/hub.js';
import { cleanTabName, createTabName } from '../src/server/tabname.js';
import type { TabNameStore } from '../src/server/tabname.js';
import { createWebServer } from '../src/server/web.js';
import type { WebServer } from '../src/server/web.js';
import { titleWith } from '../src/client/notify.js';
import { applyServerFrame, emptyState, store } from '../src/client/store.js';
import { TabNameBlock } from '../src/client/TabName.js';

const TOKEN = 'ab'.repeat(32);
let dir: string;
let emitted: TabNameView[];
let logs: string[];
let web: WebServer | null = null;
const open: TabNameStore[] = [];

const quiet = (sink: string[]): Logger => {
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: (m) => void sink.push(m), error: (m, ...e) => void sink.push([m, ...e.map(String)].join(' ')), child: () => log };
  return log;
};
const make = (fallback: string | null = null): TabNameStore => {
  const s = createTabName({ dir, fallback, emit: (v) => void emitted.push(v), log: quiet(logs) });
  open.push(s);
  return s;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gonogo-tab-'));
  emitted = [];
  logs = [];
});
afterEach(async () => {
  await web?.close();
  web = null;
  store.setState(emptyState());
  for (const s of open.splice(0)) await s.close();
  await rm(dir, { recursive: true, force: true });
});

const fails = async (run: Promise<unknown>, field: string): Promise<void> => {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(HubError);
  expect(error).toMatchObject({ code: 'bad_request', field });
};

describe('the store', () => {
  it('has no name at first and the station as the fallback, and sets, clears and keeps a name over a restart', async () => {
    const s = make('lab');
    await s.load();
    expect(s.view()).toEqual({ name: null, fallback: 'lab' });
    expect(await s.set('  Review   room ')).toEqual({ name: 'Review room', fallback: 'lab' });
    expect(emitted).toHaveLength(1);
    const again = make('lab');
    await again.load();
    expect(again.view().name).toBe('Review room');
    expect((await again.set('')).name).toBeNull();
    expect((await again.set(null)).name).toBeNull();
    expect(emitted).toHaveLength(2);
    expect(JSON.parse(await readFile(join(dir, 'tabname.json'), 'utf8'))).toEqual({ version: 1, name: null });
    expect(await readdir(dir)).toEqual(['tabname.json']);
  });

  it('takes control and bidi characters out and refuses a name over 40 characters, or not text', async () => {
    expect(cleanTabName('a\x1b[2Jb‮c\n\td')).toBe('a [2Jb c d');
    const s = make();
    await s.load();
    expect((await s.set('x‮y\x07z')).name).toBe('x y z');
    expect((await s.set('y'.repeat(TAB_NAME_MAX_CHARS))).name).toHaveLength(TAB_NAME_MAX_CHARS);
    await fails(s.set('y'.repeat(TAB_NAME_MAX_CHARS + 1)), 'name');
    await fails(s.set(7), 'name');
    await fails(s.set({}), 'name');
    expect(s.view().name).toHaveLength(TAB_NAME_MAX_CHARS);
  });

  it('writes and tells nothing for a change that changes nothing', async () => {
    const s = make();
    await s.load();
    await s.set(null);
    await s.set('  ');
    expect(emitted).toEqual([]);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('keeps a damaged file aside, and leaves one it cannot read where it is', async () => {
    await writeFile(join(dir, 'tabname.json'), '{ nope');
    const s = make();
    await s.load();
    expect(s.view().name).toBeNull();
    expect(await readFile(join(dir, 'tabname.json.bad'), 'utf8')).toBe('{ nope');
    await rm(join(dir, 'tabname.json.bad'));
    await mkdir(join(dir, 'tabname.json'));
    const t = make();
    await t.load();
    expect(await readdir(dir)).toEqual(['tabname.json']);
    expect(logs.some((l) => l.includes('EISDIR'))).toBe(true);
  });

  it('cuts a name that a hand-edited file made too long', async () => {
    await writeFile(join(dir, 'tabname.json'), JSON.stringify({ version: 1, name: `ok‮${'z'.repeat(100)}` }));
    const s = make();
    await s.load();
    expect(s.view().name).toHaveLength(TAB_NAME_MAX_CHARS);
    expect(s.view().name).not.toContain('‮');
  });
});

describe('the Black Box', () => {
  it('says that the name was set or cleared, never the name', async () => {
    const told: Array<[string, string]> = [];
    const s = audited(make(), (k, t) => void told.push([k, t]), TABNAME_AUDIT);
    await s.load();
    await s.set('secret-room');
    await s.set(null);
    expect(told).toEqual([['config', 'Director set the tab name'], ['config', 'Director cleared the tab name']]);
    expect(JSON.stringify(told)).not.toContain('secret-room');
  });
});

describe('the routes', () => {
  async function start(withStore: boolean): Promise<number> {
    const s = make('lab');
    await s.load();
    web = createWebServer({ host: '127.0.0.1', port: 0, browserToken: TOKEN, allowedHosts: [], staticDir: null, hub: {} as Hub, terminals: {} as TerminalHost, resolveToken: () => null, info: () => ({}) as ServerInfo, isReady: () => true, ...(withStore ? { tabName: s } : {}), log: nullLogger });
    return (await web.listen()).port;
  }
  const call = async (port: number, method: string, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('answers the name, sets it, clears it, and says which field is wrong', async () => {
    const port = await start(true);
    expect(await call(port, 'GET', '/api/tab-name')).toEqual({ status: 200, json: { name: null, fallback: 'lab' } });
    expect((await call(port, 'PUT', '/api/tab-name', { name: 'Review' })).json).toEqual({ name: 'Review', fallback: 'lab' });
    expect((await call(port, 'PUT', '/api/tab-name', { name: null })).json).toMatchObject({ name: null });
    const bad = await call(port, 'PUT', '/api/tab-name', { name: 'x'.repeat(41) });
    expect([bad.status, bad.json.field]).toEqual([400, 'name']);
    expect((await call(port, 'PUT', '/api/tab-name', { name: 3 })).status).toBe(400);
  });

  it('wants the browser token, allows GET and PUT, and is 404 without a store', async () => {
    const port = await start(true);
    expect((await call(port, 'GET', '/api/tab-name', undefined, 'c3'.repeat(32))).status).toBe(401);
    expect((await call(port, 'DELETE', '/api/tab-name')).status).toBe(405);
    await web?.close();
    expect((await call(await start(false), 'GET', '/api/tab-name')).status).toBe(404);
  });
});

describe('the page', () => {
  it('titles the tab with the name, else the station, else gonogo, and keeps the unread count in front', () => {
    expect(tabTitle({ name: null, fallback: null })).toBe('gonogo');
    expect(tabTitle({ name: null, fallback: 'lab' })).toBe('lab · gonogo');
    expect(tabTitle({ name: 'Review', fallback: 'lab' })).toBe('Review · gonogo');
    expect(tabTitle({ name: '', fallback: null })).toBe('gonogo');
    expect(titleWith(tabTitle({ name: 'Review', fallback: null }), 3)).toBe('(3) Review · gonogo');
  });

  it('takes the name from the state and from every tabname frame, and none from an older server', () => {
    const snapshot = (tabName?: TabNameView): StateSnapshot => ({ info: { cwd: '/' }, agents: [], activity: [], poll: null, governor: { limit: null, working: 0, holding: 0 }, tasks: [], ...(tabName === undefined ? {} : { tabName }), downlink: { unread: 0, items: [] }, livery: defaultView() }) as unknown as StateSnapshot;
    const loaded = applyServerFrame(emptyState(), { t: 'state', state: snapshot({ name: 'A', fallback: null }) }, 1);
    expect(loaded.tabName).toEqual({ name: 'A', fallback: null });
    expect(applyServerFrame(loaded, { t: 'tabname', tabName: { name: 'B', fallback: null } }, 2).tabName.name).toBe('B');
    expect(applyServerFrame(emptyState(), { t: 'state', state: snapshot() }, 1).tabName).toEqual({ name: null, fallback: null });
  });

  it('shows the field in Flight Rules with the default as its hint and what the tab will say', () => {
    store.setState({ ...emptyState(), tabName: { name: 'Review', fallback: 'lab' } });
    const out = renderToString(createElement(TabNameBlock));
    expect(out).toContain('TAB NAME');
    expect(out).toContain('value="Review"');
    expect(out).toContain('placeholder="lab"');
    expect(out.replace(/<!-- -->/g, '')).toContain('The tab says: Review · gonogo');
    expect(out).toContain('maxLength="40"');
  });
});
