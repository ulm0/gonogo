/**
 * Browser notifications: the part that touches the browser (Notification, document, localStorage). The rules are in notify.ts.
 * Permission is asked only from `enableNotifications`, which the key in Flight Rules calls: never on page load.
 */
import { useSyncExternalStore } from 'react';
import { isAway, noticesFor, notifyStatus, seenIn, tabTitle, titleWith, waitingFor } from './notify.js';
import type { Notice, NotifyStatus, Seen } from './notify.js';
import { readStored, showDownlink, showRoom, store, writeStored } from './store.js';

export const NOTIFY_STORAGE_KEY = 'gonogo.notify';

const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((l) => l());
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const enabled = (): boolean => readStored(NOTIFY_STORAGE_KEY) === 'on';
const supported = (): boolean => typeof Notification !== 'undefined';
const secure = (): boolean => typeof window !== 'undefined' && window.isSecureContext === true;
const permission = (): 'default' | 'granted' | 'denied' => (supported() ? Notification.permission : 'denied');
const status = (): NotifyStatus => notifyStatus({ supported: supported(), secure: secure(), permission: permission(), enabled: enabled() });

let cached: NotifyStatus = 'off';
const snapshot = (): NotifyStatus => {
  cached = status();
  return cached;
};

/** The state of the switch for the settings screen; it changes when the key is pressed, not when the browser's own setting changes (reload to see that). */
export function useNotifyStatus(): NotifyStatus {
  return useSyncExternalStore(subscribe, snapshot, () => 'off');
}

/** Turns the switch on and asks for permission: called from a click, the only place the browser lets it be asked. */
export async function enableNotifications(): Promise<void> {
  writeStored(NOTIFY_STORAGE_KEY, 'on');
  if (supported() && secure() && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      // an older browser takes a callback; the status below says what the browser decided
    }
  }
  changed();
}

export function disableNotifications(): void {
  writeStored(NOTIFY_STORAGE_KEY, null);
  changed();
}

function show(notice: Notice): void {
  try {
    const n = new Notification(notice.title, { body: notice.body, tag: notice.tag, silent: false });
    n.onclick = () => {
      window.focus();
      n.close();
      if (notice.open === 'downlink') showDownlink();
      else showRoom();
    };
  } catch {
    // a browser that refuses (a phone that wants a service worker) is the tab title's job
  }
}

/** Joins the logic to the page: once, at start. It does nothing before the first state (the inbox then is history). */
export function startNotifications(): () => void {
  const original = document.title;
  let seen: Seen | null = null;
  let last: { downlink: unknown; poll: unknown; relief: unknown } | null = null;
  const apply = (): void => {
    const s = store.getState();
    if (s.info === null) return;
    const base = tabTitle(s.tabName);
    const away = isAway(document);
    // the title counts what waits while the tab is not in front, and goes back when the Director is there
    document.title = away ? titleWith(base, waitingFor(s)) : base;
    if (seen === null) {
      seen = seenIn(s);
      return;
    }
    // the inbox, the poll and Relief are replaced whole when they change: the same objects mean nothing new
    if (last !== null && last.downlink === s.downlink && last.poll === s.poll && last.relief === s.relief) return;
    last = { downlink: s.downlink, poll: s.poll, relief: s.relief };
    const next = noticesFor(seen, s);
    seen = next.seen;
    if (away && status() === 'on') next.notices.forEach(show);
  };
  const off = store.subscribe(apply);
  document.addEventListener('visibilitychange', apply);
  window.addEventListener('focus', apply);
  window.addEventListener('blur', apply);
  return () => {
    off();
    document.removeEventListener('visibilitychange', apply);
    window.removeEventListener('focus', apply);
    window.removeEventListener('blur', apply);
    document.title = original;
  };
}
