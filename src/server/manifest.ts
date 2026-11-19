/**
 * The manifest of the installed app (docs/features/mobile.md): what a phone shows on the Home Screen and in the app switcher. The
 * name is the tab name of the room (so two rooms installed side by side can be told apart) and the colours are the room's livery:
 * the page behind the splash and the bar of the app are the livery's body. Every address in it is relative, so a room under /r/<id>/
 * is an app of its own (its own scope, its own service worker, its own push key).
 */
import { DEFAULT_LIVERY, INSTRUMENT, toHex } from '../shared/livery.js';
import { tabTitle } from '../shared/protocol.js';
import type { LiveryView, TabNameView } from '../shared/protocol.js';

export interface Manifest {
  name: string;
  short_name: string;
  description: string;
  id: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: 'image/png'; purpose: 'any' | 'maskable' }>;
}

export function manifestOf(tabName: TabNameView | null, livery: LiveryView | null): Manifest {
  const entry = livery?.liveries.find((e) => e.slug === livery.current);
  const tokens: Record<string, string> = entry !== undefined && entry.slug !== DEFAULT_LIVERY ? entry.tokens : INSTRUMENT.tokens;
  const body = toHex(tokens['--body'] ?? '') ?? INSTRUMENT.tokens['--body'];
  const name = tabName === null ? 'gonogo' : tabTitle(tabName);
  return {
    name,
    short_name: (tabName?.name ?? tabName?.fallback ?? 'gonogo').slice(0, 12),
    description: 'Run a team of AI coding agents from your phone: messages, approvals and a terminal.',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: body,
    theme_color: body,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
