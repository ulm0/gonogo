/**
 * Push to the installed app (docs/features/mobile.md): the logic with no browser in it. What the settings screen says about this
 * device, the key a browser subscribes with, and the body the server is sent. `push-browser.ts` joins it to the page.
 */
import type { PushView } from '../shared/protocol.js';

/**
 * What can be said about push on this device. `install-first` is iOS in a browser tab: Safari gives push only to a web app added to the
 * Home Screen, so the way forward is Share, Add to Home Screen, not a permission prompt.
 */
export type PushStatus = 'unsupported' | 'insecure' | 'install-first' | 'denied' | 'off' | 'on';

export interface PushFacts {
  /** serviceWorker, PushManager and Notification are all there. */
  supported: boolean;
  /** https or localhost: a service worker needs it. */
  secure: boolean;
  /** The page runs as the installed app (display-mode standalone, or navigator.standalone on iOS). */
  standalone: boolean;
  /** iPhone or iPad. */
  ios: boolean;
  permission: 'default' | 'granted' | 'denied';
  /** This browser holds a subscription that the server knows. */
  subscribed: boolean;
}

export function pushStatus(f: PushFacts): PushStatus {
  // iOS in a tab has no PushManager at all: the install advice must come before "unsupported"
  if (f.ios && !f.standalone && f.secure) return 'install-first';
  if (!f.secure) return 'insecure';
  if (!f.supported) return 'unsupported';
  if (f.permission === 'denied') return 'denied';
  return f.subscribed && f.permission === 'granted' ? 'on' : 'off';
}

export const PUSH_TEXT: Record<PushStatus, string> = {
  unsupported: 'This browser cannot receive push. The notifications of an open tab still work.',
  insecure: 'Push needs https or localhost, and this address is plain http: a service worker is refused. Expose gonogo over https (see the docs) or use a private tunnel such as Tailscale Serve.',
  'install-first': 'On an iPhone or iPad, push works only for the app on the Home Screen. In Safari press Share, then Add to Home Screen, and open gonogo from its icon.',
  denied: 'The browser blocks notifications for this address. Allow them in its site settings, then come back.',
  off: 'Off for this device. Turn it on to get a push when an agent needs you, a message arrives, a T-minus poll wants a call, a hire request waits or a limit trips, even with no tab open.',
  on: 'On for this device. A tap opens gonogo at the ask; nothing is approved from the notification itself.',
};

/** A browser's `applicationServerKey`: the base64url public key as bytes. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const text = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** What a device is called in the list: the platform, as far as the browser says it. */
export function deviceName(userAgent: string, standalone: boolean): string {
  const os = /iPhone|iPad/.test(userAgent) ? 'iPhone or iPad' : /Android/.test(userAgent) ? 'Android' : /Mac OS X/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'browser';
  return `${os}, ${browser}${standalone ? ' (app)' : ''}`;
}

/** The body of PUT /api/push/subscription, from a PushSubscription's JSON. null when the browser gave no keys. */
export function subscriptionBody(json: { endpoint?: string; keys?: Record<string, string> }, device: string, snippet: boolean): { endpoint: string; keys: { p256dh: string; auth: string }; device: string; snippet: boolean } | null {
  const { endpoint, keys } = json;
  if (typeof endpoint !== 'string' || typeof keys?.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, device, snippet };
}

/** Where a tap on a notification goes: the value of `?open=` or of the message of the service worker. */
export const openTarget = (value: unknown): 'downlink' | 'room' | null => (value === 'downlink' || value === 'room' ? value : null);

/** The id the server gives a device: the first 16 hex digits of the SHA-256 of the endpoint as a URL (push.ts `idOf`). */
export async function deviceId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(new URL(endpoint).href));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const emptyPush: PushView = { publicKey: '', devices: [] };
