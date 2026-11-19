/**
 * Push to the installed app: the part that touches the browser (the service worker, the Push API, the install state). The rules are in
 * push.ts. Permission is asked only from `enablePush`, which the key in Flight Rules calls: never on page load, and on iOS only from
 * the app on the Home Screen. The worker is registered once the page is up, in a secure context, for the shell and for a tap on a push.
 */
import { useSyncExternalStore } from 'react';
import { pushSubscribe, pushUnsubscribe, pushView } from './api.js';
import { deviceId, deviceName, emptyPush, keyBytes, openTarget, pushStatus, subscriptionBody } from './push.js';
import type { PushStatus } from './push.js';
import { BASE } from './base.js';
import { showDownlink, showRoom } from './store.js';
import type { PushView } from '../shared/protocol.js';

const secure = (): boolean => typeof window !== 'undefined' && window.isSecureContext === true;
const supported = (): boolean => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined';
const ios = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = (): boolean => window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as { standalone?: boolean }).standalone === true;

let current: PushStatus = 'off';
let view: PushView = emptyPush;
let mine: string | null = null;
const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((l) => l());
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const registration = async (): Promise<ServiceWorkerRegistration | null> => {
  if (!secure() || !('serviceWorker' in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
};

/** Looks at the browser and the server and says where this device stands. */
export async function refreshPush(): Promise<void> {
  let subscribed = false;
  mine = null;
  try {
    view = await pushView();
    const sub = await (await registration())?.pushManager.getSubscription();
    if (sub !== null && sub !== undefined) {
      // the server holds it when a device has the id of this endpoint
      const id = await deviceId(sub.endpoint);
      subscribed = view.devices.some((d) => d.id === id);
      mine = subscribed ? id : null;
    }
  } catch {
    // not signed in, or the server is not there: the status below says what the browser alone knows
  }
  current = pushStatus({ supported: supported(), secure: secure(), standalone: standalone(), ios: ios(), permission: typeof Notification === 'undefined' ? 'denied' : Notification.permission, subscribed });
  changed();
}

export function usePushStatus(): { status: PushStatus; view: PushView; mine: string | null } {
  useSyncExternalStore(subscribe, () => current, () => 'off' as PushStatus);
  return { status: current, view, mine };
}

/** Turns push on for this device: called from a click, the only place the browser lets the permission be asked. */
export async function enablePush(snippet: boolean): Promise<string | null> {
  const reg = await registration();
  if (reg === null) return 'The service worker is not running here yet. Reload the page and try again.';
  try {
    if (Notification.permission === 'default' && (await Notification.requestPermission()) !== 'granted') {
      await refreshPush();
      return null;
    }
    const key = (await pushView()).publicKey;
    const existing = await reg.pushManager.getSubscription();
    // a key changed on the server (a new push.json) makes the old subscription useless: it is replaced
    const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
    const body = subscriptionBody(sub.toJSON() as { endpoint?: string; keys?: Record<string, string> }, deviceName(navigator.userAgent, standalone()), snippet);
    if (body === null) return 'The browser gave no keys for this subscription.';
    await pushSubscribe(body);
    await refreshPush();
    return null;
  } catch (error) {
    await refreshPush();
    return error instanceof Error ? error.message : 'Push could not be turned on.';
  }
}

/** Turns push off for this device: the browser's subscription and the server's device go. */
export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (mine !== null) await pushUnsubscribe(mine).catch(() => undefined);
  await sub?.unsubscribe().catch(() => undefined);
  await refreshPush();
}

export const removeDevice = async (id: string): Promise<void> => {
  await pushUnsubscribe(id);
  await refreshPush();
};

/** The id of the room this page is, from its address: `main` at `/`, else the one under `/r/<id>/`. */
const thisRoom = (): string => BASE.slice('/r/'.length) || 'main';

/** Registers the worker, and takes a tap on a notification to the ask. Once, at start; it does nothing where a worker is refused. */
export function startWorker(): () => void {
  if (!secure() || !('serviceWorker' in navigator)) return () => undefined;
  const go = (value: unknown): void => {
    const target = openTarget(value);
    if (target === 'downlink') showDownlink();
    else if (target === 'room') showRoom();
  };
  // a window opened by a tap: ?open= names the ask; it is taken off the address
  const url = new URL(window.location.href);
  if (url.searchParams.has('open')) {
    go(url.searchParams.get('open'));
    url.searchParams.delete('open');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const onMessage = (event: MessageEvent): void => {
    // the worker focuses a window of the room the push came from; a window of another room leaves it alone
    const data: unknown = event.data;
    if (data !== null && typeof data === 'object' && (data as { t?: unknown }).t === 'open' && ((data as { room?: unknown }).room ?? 'main') === thisRoom()) go((data as { open?: unknown }).open);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  void navigator.serviceWorker
    // one worker for every room: at the root, so its scope is the whole address (the installed app is one app)
    .register('/sw.js', { scope: '/' })
    .then(() => refreshPush())
    .catch(() => undefined);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}
