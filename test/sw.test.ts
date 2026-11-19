// The service worker (public/sw.js) run against a stand-in for its scope: what it keeps, what it never touches, what it shows for a
// push and where a tap goes. No browser exists on this host; a real worker, a real push service and a phone are not covered.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Handler = (event: Record<string, unknown>) => void;

function worker(scope: string, windows: Array<{ url: string; focus(): unknown; postMessage(m: unknown): void }> = []) {
  const handlers: Record<string, Handler> = {};
  const shown: Array<[string, Record<string, unknown>]> = [];
  const opened: string[] = [];
  const kept = new Map<string, unknown>();
  const put: string[] = [];
  const self = {
    registration: { scope, showNotification: (title: string, options: Record<string, unknown>) => (shown.push([title, options]), Promise.resolve()) },
    addEventListener: (type: string, fn: Handler) => (handlers[type] = fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve(windows), openWindow: (url: string) => (opened.push(url), Promise.resolve()) },
  };
  const caches = {
    open: () => Promise.resolve({ addAll: () => Promise.resolve(), put: (r: { url: string }) => (put.push(r.url), Promise.resolve()) }),
    keys: () => Promise.resolve([]),
    match: (r: string | { url: string }) => Promise.resolve(kept.get(typeof r === 'string' ? r : r.url)),
  };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, caches, URL, Response, fetch: () => Promise.resolve(new Response('x')) });
  const waits: Array<Promise<unknown>> = [];
  const fire = (type: string, event: Record<string, unknown>): Promise<unknown> => {
    handlers[type]?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<unknown>) => waits.push(Promise.resolve(p).then(() => 'responded')) });
    return Promise.all(waits);
  };
  return { fire, shown, opened, kept, put, waits };
}

const request = (url: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ request: { url, method: 'GET', mode: 'cors', headers: { has: () => false }, ...extra } });

describe('the service worker', () => {
  it('keeps hashed assets and falls back to the kept page offline, but never touches the live parts, other rooms, a non-GET or an authorized request', async () => {
    const w = worker('https://x.test/r/a/');
    const touched: string[] = [];
    for (const [url, extra] of [
      ['https://x.test/r/a/api/state', {}],
      ['https://x.test/r/a/ws', {}],
      ['https://x.test/r/a/hook/x/Stop', {}],
      ['https://x.test/r/a/mcp', {}],
      ['https://x.test/r/a/uplink/u1', {}],
      ['https://x.test/r/a/dock/hello', {}],
      ['https://x.test/r/a/assets/app.js', { method: 'POST' }],
      ['https://x.test/r/a/assets/app.js', { headers: { has: (h: string) => h === 'authorization' } }],
      ['https://other.test/r/a/assets/app.js', {}],
      ['https://x.test/r/b/assets/app.js', {}],
    ] as const) {
      const before = w.waits.length;
      await w.fire('fetch', request(url, extra));
      if (w.waits.length !== before) touched.push(url);
    }
    expect(touched).toEqual([]);
    // an asset of this room is answered by the worker
    await w.fire('fetch', request('https://x.test/r/a/assets/app-1a2b.js'));
    expect(w.waits).toHaveLength(1);
    // a navigation is answered, from the network or else from the kept page
    await w.fire('fetch', request('https://x.test/r/a/', { mode: 'navigate' }));
    expect(w.waits).toHaveLength(2);
  });

  it('the main room, at the root, leaves /r/ and /rooms to the rooms and the supervisor', async () => {
    const w = worker('https://x.test/');
    for (const url of ['https://x.test/r/a/assets/app.js', 'https://x.test/rooms', 'https://x.test/rooms/assets/x.css', 'https://x.test/api/state']) await w.fire('fetch', request(url));
    expect(w.waits).toHaveLength(0);
    await w.fire('fetch', request('https://x.test/assets/app-1.js'));
    expect(w.waits).toHaveLength(1);
  });

  it('shows what the push says, cut, with the room\'s own icon and no buttons, and shows something even for a body it cannot read', async () => {
    const w = worker('https://x.test/');
    await w.fire('push', { data: { json: () => ({ title: 'gonogo', body: '1 new message', tag: 'gonogo-message-ana', open: 'downlink' }) } });
    const long = worker('https://x.test/');
    await long.fire('push', { data: { json: () => ({ title: 'T'.repeat(300), body: 'b'.repeat(500), open: 'evil' }) } });
    expect(w.shown[0]).toEqual(['gonogo', { body: '1 new message', tag: 'gonogo-message-ana', icon: 'icon-192.png', badge: 'icon-192.png', data: { open: 'downlink' } }]);
    expect(long.shown[0]?.[0]).toHaveLength(100);
    expect((long.shown[0]?.[1].body as string).length).toBe(200);
    expect((long.shown[0]?.[1].data as { open: string }).open).toBe('room');
    const bad = worker('https://x.test/');
    await bad.fire('push', { data: { json: () => { throw new Error('not json'); } } });
    expect(bad.shown[0]?.[0]).toBe('gonogo');
    const empty = worker('https://x.test/');
    await empty.fire('push', { data: null });
    expect(empty.shown).toHaveLength(1);
  });

  it('a tap focuses a window of this room and tells it where to go, else opens one with ?open=', async () => {
    const told: unknown[] = [];
    let focused = 0;
    const here = { url: 'https://x.test/r/a/', focus: () => void focused++, postMessage: (m: unknown) => void told.push(m) };
    const other = { url: 'https://x.test/r/b/', focus: () => void focused++, postMessage: (m: unknown) => void told.push(m) };
    const closed: string[] = [];
    const click = (open: string) => ({ notification: { close: () => void closed.push(open), data: { open } } });
    const w = worker('https://x.test/r/a/', [other, here]);
    await w.fire('notificationclick', click('downlink'));
    expect(told).toEqual([{ t: 'open', open: 'downlink' }]);
    expect(focused).toBe(1);
    expect(w.opened).toEqual([]);
    // only a window of another room: a new window of this one
    const lone = worker('https://x.test/r/a/', [other]);
    await lone.fire('notificationclick', click('room'));
    expect(lone.opened).toEqual(['https://x.test/r/a/?open=room']);
    // the main room does not take a window of a room as its own
    const main = worker('https://x.test/', [other]);
    await main.fire('notificationclick', click('room'));
    expect(main.opened).toEqual(['https://x.test/?open=room']);
    expect(closed).toEqual(['downlink', 'room', 'room']);
  });
});
