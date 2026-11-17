import { builtinEntries, checkLivery, DEFAULT_LIVERY, INSTRUMENT, LIVERY_BRIEF_MAX_CHARS, LIVERY_NAMES, LIVERY_SLUG_PATTERN, liveryProperties, schemeOf, toHex } from '../shared/livery.js';
import type { LiveryTokens } from '../shared/livery.js';
import type { LiveryEntry, LiveryView } from '../shared/protocol.js';
import { readStored, store, writeStored } from './store.js';

// What Livery shows and does to the page, kept out of Livery.tsx so that it can be tested without a DOM. The DOM part is at the end.

export const LIVERY_STORAGE_KEY = 'gonogo.livery';

/** The livery every device shows now; the default when the view does not name one it holds. */
export function currentEntry(view: LiveryView): LiveryEntry {
  return view.liveries.find((e) => e.slug === view.current) ?? (builtinEntries().find((e) => e.slug === DEFAULT_LIVERY) as LiveryEntry);
}

/** The colours of a swatch, in the order they are drawn: the page, a module, the text, the screen, then the four signals. */
export const SWATCH_TOKENS = ['--body', '--panel', '--text', '--lcd', '--work', '--you', '--go', '--nogo'] as const;

/** What a livery row says besides its name. */
export const sourceText = (e: LiveryEntry, agentLegend: (name: string) => string): string => (e.builtin ? 'Ships with gonogo' : e.author === null ? 'Custom' : `Designed by ${agentLegend(e.author)}`);

/** The words under the brief field, or '' when it can be sent. */
export function briefProblem(brief: string): string {
  const text = brief.trim();
  if (text === '') return 'Say what you want it to look like.';
  return text.length > LIVERY_BRIEF_MAX_CHARS ? `At most ${LIVERY_BRIEF_MAX_CHARS} characters.` : '';
}

/** What the page says after a request for a livery went out. */
export const askedText = (to: string, ok: boolean, note: string | null): string => (ok ? `Asked ${to}. The livery appears in the list when it submits one.` : `Not sent: ${note ?? 'the message was not delivered'}`);

const part = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);
const blend = (a: string, b: string, t: number): string => `#${[1, 3, 5].map((i) => Math.round(part(a, i) * (1 - t) + part(b, i) * t).toString(16).padStart(2, '0')).join('')}`;

export interface TerminalColours {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

/** What xterm is given: the screen tokens as plain #rrggbb. The selection is the text colour a third of the way into the screen. */
export function xtermTheme(tokens: LiveryTokens): TerminalColours {
  const hex = (name: string): string => toHex(tokens[name] ?? '') ?? (toHex(INSTRUMENT.tokens[name as keyof typeof INSTRUMENT.tokens]) as string);
  const lcd = hex('--lcd');
  const text = hex('--lcd-text');
  return { background: lcd, foreground: text, cursor: text, cursorAccent: lcd, selectionBackground: blend(lcd, text, 0.3) };
}

/** A livery kept in the browser from the last visit, or null when the text is not one the page may trust (it is checked as a submit is). */
export function storedEntry(text: string | null): Pick<LiveryEntry, 'slug' | 'tokens'> | null {
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    const { slug, tokens } = (value ?? {}) as { slug?: unknown; tokens?: unknown };
    return typeof slug === 'string' && new RegExp(LIVERY_SLUG_PATTERN).test(slug) && checkLivery(tokens).length === 0 ? { slug, tokens: tokens as Record<string, string> } : null;
  } catch {
    return null;
  }
}

/* ---- the DOM ---- */

/** Puts a livery on the page: the data-livery and data-scheme attributes and the tokens as properties of :root (none for the default, which is plain CSS), and the two meta tags of the browser's own bar. */
export function applyLivery(entry: Pick<LiveryEntry, 'slug' | 'tokens'>): void {
  const root = document.documentElement;
  const properties = entry.slug === DEFAULT_LIVERY ? [] : liveryProperties(entry.tokens);
  for (const name of [...LIVERY_NAMES, 'color-scheme']) root.style.removeProperty(name);
  for (const [name, value] of properties) root.style.setProperty(name, value);
  if (properties.length === 0) {
    root.removeAttribute('data-livery');
    root.removeAttribute('data-scheme');
  } else {
    root.setAttribute('data-livery', entry.slug);
    root.setAttribute('data-scheme', schemeOf(entry.tokens));
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', toHex(entry.tokens['--body'] ?? '') ?? INSTRUMENT.tokens['--body']);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', schemeOf(entry.tokens));
}

/**
 * Called once before the page renders: shows the livery of the last visit at once (no flash of the wrong look), then follows what
 * the server says. The browser keeps only a copy of the choice (a convenience); the server is the truth.
 */
export function startLivery(): void {
  const kept = storedEntry(readStored(LIVERY_STORAGE_KEY));
  if (kept !== null) applyLivery(kept);
  let shown = kept === null ? '' : JSON.stringify(kept);
  let seen = store.getState().livery;
  store.subscribe(() => {
    const { livery } = store.getState();
    if (livery === seen) return;
    seen = livery;
    const { slug, tokens } = currentEntry(livery);
    const text = JSON.stringify({ slug, tokens });
    if (text === shown) return;
    shown = text;
    applyLivery({ slug, tokens });
    writeStored(LIVERY_STORAGE_KEY, text);
  });
}
