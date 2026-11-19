/*
 * The service worker of the installed app (docs/features/mobile.md). Three jobs and nothing else:
 *  1. keep the SHELL (the built client: its index page, its hashed assets, its icons) so the app opens with no network. It never
 *     keeps an API answer, a WebSocket, a login, an uplink or a hook, and never a request that is not a GET of this address: the
 *     page says "not connected" until its own socket is up. There is no offline data.
 *  2. show a push. The payload is generic unless the device chose more (push.ts); a notification has no buttons, so nothing is
 *     approved from it: a tap opens the page at the ask.
 *  3. take a tap to the page of the room the push came from: an open window of that room is focused and told where to go, else one
 *     is opened (`/r/<id>/`, `/` for main).
 * Plain script, no build step: it is copied as it is next to index.html and served at /sw.js, so its scope is the whole address:
 * ONE worker and one installed app for every room (the supervisor sends the pushes, push.ts).
 */
const SHELL = 'gonogo-shell-1';
const SCOPE = new URL(self.registration.scope);

/** Paths below the scope that are never kept: the live parts, the other rooms and the list of rooms. */
const NEVER = /^(api|ws|hook|mcp|uplink|dock|r|rooms|login|setup|internal)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['./', 'favicon.svg', 'icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});

/** The id of a room, as the supervisor makes it: a letter, then up to 23 letters, digits or dashes. */
const roomOf = (value) => (typeof value === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(value) ? value : 'main');

/** Where the page of a room is: main at the root, the others under /r/<id>/. */
const pathOf = (room) => (room === 'main' ? '/' : `/r/${room}/`);

/** Whether a window shows a page of this room. */
function inRoom(url, room) {
  const u = new URL(url);
  if (u.origin !== SCOPE.origin) return false;
  if (room !== 'main') return u.pathname === `/r/${room}` || u.pathname.startsWith(`/r/${room}/`);
  return !/^\/(r|rooms)(\/|$)/.test(u.pathname);
}

/** The part of the address below the scope, or null for an address that is not ours. */
function below(url) {
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return null;
  return url.pathname.slice(SCOPE.pathname.length);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('authorization')) return;
  const rest = below(new URL(request.url));
  if (rest === null || NEVER.test(rest)) return;
  if (request.mode === 'navigate') {
    // the page comes from the network when there is one (a login or an update shows at once); the kept shell opens it when there is not
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(new URL('./', SCOPE).href)) ?? Response.error()),
    );
    return;
  }
  // a file of the built client: the hashed ones never change, the others are asked again each time and kept as the fallback
  if (rest.startsWith('assets/')) {
    event.respondWith(
      caches.match(request).then(
        (kept) =>
          kept ??
          fetch(request).then((answer) => {
            if (answer.ok && answer.type === 'basic') {
              const copy = answer.clone();
              void caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return answer;
          }),
      ),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data === null ? {} : event.data.json();
  } catch {
    // not JSON: still shown, because a push that shows nothing is refused by the browsers (userVisibleOnly)
  }
  const text = (value, max, fallback) => (typeof value === 'string' && value !== '' ? value.slice(0, max) : fallback);
  event.waitUntil(
    self.registration.showNotification(text(data.title, 100, 'gonogo'), {
      body: text(data.body, 200, ''),
      tag: text(data.tag, 80, 'gonogo'),
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { open: data.open === 'downlink' ? 'downlink' : 'room', room: roomOf(data.room) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const open = data.open === 'downlink' ? 'downlink' : 'room';
  const room = roomOf(data.room);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const mine = windows.find((w) => inRoom(w.url, room));
      if (mine !== undefined) {
        mine.postMessage({ t: 'open', open, room });
        return mine.focus();
      }
      return self.clients.openWindow(new URL(`${pathOf(room)}?open=${open}`, SCOPE.origin).href);
    }),
  );
});
