/**
 * The manifest of the installed app (docs/features/mobile.md): what a phone shows on the Home Screen and in the app switcher. There is
 * ONE app for a gonogo, whichever room's page it is installed from: its scope and start address are the root (room main at `/`, the
 * list of rooms at `/rooms`, every other room under `/r/<id>/`), so its one service worker covers them all and the phone holds one
 * icon. The colours are the livery's body, as the room that served the manifest has it.
 */
import { DEFAULT_LIVERY, INSTRUMENT, toHex } from '../shared/livery.js';
import type { LiveryView } from '../shared/protocol.js';

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

export function manifestOf(livery: LiveryView | null): Manifest {
  const entry = livery?.liveries.find((e) => e.slug === livery.current);
  const tokens: Record<string, string> = entry !== undefined && entry.slug !== DEFAULT_LIVERY ? entry.tokens : INSTRUMENT.tokens;
  const body = toHex(tokens['--body'] ?? '') ?? INSTRUMENT.tokens['--body'];
  return {
    name: 'gonogo',
    short_name: 'gonogo',
    description: 'Run a team of AI coding agents from your phone: messages, approvals and a terminal.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: body,
    theme_color: body,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
