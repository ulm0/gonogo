// The service worker (public/sw.js) run against a stand-in for its scope: what it keeps, what it never touches, what it shows for a
// push and where a tap goes. No browser exists on this host; a real worker, a real push service and a phone are not covered.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Handler = (event: Record<string, unknown>) => void;

function worker(scope: string, windows: Array<{ url: string; focus(): unknown; postMessage(m: unknown): void }> = [], page = new Response('x')) {
  const handlers: Record<string, Handler> = {};
  const shown: Array<[string, Record<string, unknown>]> = [];
  const opened: string[] = [];
  const kept = new Map<string, unknown>();
  const put: string[] = [];
  const keptAssets = new Set<string>();
  const deleted: string[] = [];
  const self = {
    registration: { scope, showNotification: (title: string, options: Record<string, unknown>) => (shown.push([title, options]), Promise.resolve()) },
    addEventListener: (type: string, fn: Handler) => (handlers[type] = fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve(windows), openWindow: (url: string) => (opened.push(url), Promise.resolve()) },
  };
  const caches = {
    open: () => Promise.resolve({ addAll: () => Promise.resolve(), put: (r: { url: string }) => (put.push(r.url), Promise.resolve()), keys: () => Promise.resolve([...keptAssets].map((url) => ({ url }))), delete: (r: { url: string }) => (deleted.push(r.url), keptAssets.delete(r.url), Promise.resolve(true)) }),
    keys: () => Promise.resolve([]),
    match: (r: string | { url: string }) => Promise.resolve(kept.get(typeof r === 'string' ? r : r.url)),
  };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, caches, URL, Response, fetch: () => Promise.resolve(page) });
  const waits: Array<Promise<unknown>> = [];
  const fire = (type: string, event: Record<string, unknown>): Promise<unknown> => {
    handlers[type]?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<unknown>) => waits.push(Promise.resolve(p).then(() => 'responded')) });
    return Promise.all(waits);
  };
  return { fire, shown, opened, kept, put, waits, keptAssets, deleted };
}

const request = (url: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ request: { url, method: 'GET', mode: 'cors', headers: { has: () => false }, ...extra } });

describe('the service worker', () => {
  it('keeps hashed assets and falls back to the kept page offline, but never touches the live parts, the login, the rooms or a non-GET or authorized request', async () => {
    const w = worker('https://x.test/');
    const touched: string[] = [];
    for (const [url, extra] of [
      ['https://x.test/api/state', {}],
      ['https://x.test/api/push', {}],
      ['https://x.test/ws', {}],
      ['https://x.test/hook/x/Stop', {}],
      ['https://x.test/mcp', {}],
      ['https://x.test/uplink/u1', {}],
      ['https://x.test/dock/hello', {}],
      ['https://x.test/login', {}],
      ['https://x.test/setup', {}],
      ['https://x.test/internal/busy', {}],
      ['https://x.test/', { mode: 'navigate' }],
      ['https://x.test/assets/app.js', {}],
      ['https://x.test/rooms', {}],
      ['https://x.test/rooms/assets/x.css', {}],
      ['https://x.test/r/team/', { mode: 'navigate' }],
      ['https://x.test/r/team/assets/app.js', {}],
      ['https://x.test/r/main/assets/app.js', { method: 'POST' }],
      ['https://x.test/r/main/assets/app.js', { headers: { has: (h: string) => h === 'authorization' } }],
      ['https://other.test/r/main/assets/app.js', {}],
      ['https://x.test/r/main/api/state', {}],
      ['https://x.test/r/main/ws', {}],
    ] as const) {
      const before = w.waits.length;
      await w.fire('fetch', request(url, extra));
      if (w.waits.length !== before) touched.push(url);
    }
    expect(touched).toEqual([]);
    // a file of the built client is answered by the worker, and so is the page of room main (the list at the root is not)
    await w.fire('fetch', request('https://x.test/r/main/assets/app-1a2b.js'));
    expect(w.waits).toHaveLength(1);
    await w.fire('fetch', request('https://x.test/r/main/', { mode: 'navigate' }));
    expect(w.waits).toHaveLength(2);
  });

  it('forgets the kept assets that the page it just got does not name, and none when the page names none', async () => {
    // a same-origin answer from the network is of type basic
    const html = (body: string): Response => Object.defineProperty(new Response(body, { headers: { 'content-type': 'text/html' } }), 'type', { value: 'basic' });
    const old = 'https://x.test/r/main/assets/index-old.js';
    const fresh = 'https://x.test/r/main/assets/index-new.js';
    const w = worker('https://x.test/', [], html('<script src="./assets/index-new.js"></script><link href="./assets/index-new.css">'));
    w.keptAssets.add(old).add(fresh).add('https://x.test/r/main/assets/index-new.css');
    await w.fire('fetch', request('https://x.test/r/main/', { mode: 'navigate' }));
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all(w.waits);
    expect(w.deleted).toEqual([old]);
    // a login page or an error names no file of the build: nothing is forgotten
    const login = worker('https://x.test/', [], html('<form>login</form>'));
    login.keptAssets.add(old);
    await login.fire('fetch', request('https://x.test/r/main/', { mode: 'navigate' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(login.deleted).toEqual([]);
  });

  it('shows what the push says, cut, with the room it is from, the room\'s own icon and no buttons, and shows something even for a body it cannot read', async () => {
    const w = worker('https://x.test/');
    await w.fire('push', { data: { json: () => ({ title: 'gonogo, Team B', body: '1 new message', tag: 'gonogo-team-message-ana', open: 'downlink', room: 'team' }) } });
    expect(w.shown[0]).toEqual(['gonogo, Team B', { body: '1 new message', tag: 'gonogo-team-message-ana', icon: 'icon-192.png', badge: 'icon-192.png', data: { open: 'downlink', room: 'team' } }]);
    const long = worker('https://x.test/');
    await long.fire('push', { data: { json: () => ({ title: 'T'.repeat(300), body: 'b'.repeat(500), open: 'evil', room: '../evil' }) } });
    expect(long.shown[0]?.[0]).toHaveLength(100);
    expect((long.shown[0]?.[1].body as string).length).toBe(200);
    expect(long.shown[0]?.[1].data).toEqual({ open: 'room', room: 'main' });
    const bad = worker('https://x.test/');
    await bad.fire('push', { data: { json: () => { throw new Error('not json'); } } });
    expect(bad.shown[0]?.[0]).toBe('gonogo');
    const empty = worker('https://x.test/');
    await empty.fire('push', { data: null });
    expect(empty.shown).toHaveLength(1);
  });

  it('a tap goes to the room the push came from: its open window is focused and told, else a window of that room is opened with ?open=', async () => {
    const told: unknown[] = [];
    let focused = 0;
    const window = (url: string) => ({ url, focus: () => void focused++, postMessage: (m: unknown) => void told.push(m) });
    const mainWin = window('https://x.test/r/main/');
    const teamWin = window('https://x.test/r/team/');
    const listWin = window('https://x.test/');
    const click = (open: string, room: string) => ({ notification: { close: () => undefined, data: { open, room } } });
    const w = worker('https://x.test/', [listWin, mainWin, teamWin]);
    await w.fire('notificationclick', click('downlink', 'team'));
    expect(told).toEqual([{ t: 'open', open: 'downlink', room: 'team' }]);
    expect(focused).toBe(1);
    expect(w.opened).toEqual([]);
    // main's page is /r/main/, not the list of rooms at the root and not another room
    const main = worker('https://x.test/', [listWin, teamWin]);
    await main.fire('notificationclick', click('room', 'main'));
    expect(main.opened).toEqual(['https://x.test/r/main/?open=room']);
    // a room with no window open gets one, at its own address
    const none = worker('https://x.test/', [mainWin]);
    await none.fire('notificationclick', click('room', 'team'));
    expect(none.opened).toEqual(['https://x.test/r/team/?open=room']);
    // a room id that is not one is main
    const odd = worker('https://x.test/', []);
    await odd.fire('notificationclick', click('room', '../x'));
    expect(odd.opened).toEqual(['https://x.test/r/main/?open=room']);
  });
});
