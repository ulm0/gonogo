/**
 * shadcn/ui takes its colours from the Livery (docs/ui-library-assessment.md §3): each --color-* of src/client/shadcn.css is a
 * var() of a livery token, and each foreground/background pair is one CONTRAST_PAIRS already checks, so a livery that passes
 * today passes with shadcn. The copied files under src/client/ui hold no colour of their own, no dark-mode class and no Pro icon.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRAST_PAIRS, LIVERY_TOKENS } from '../src/shared/livery.js';

const ROOT = join(import.meta.dirname, '..');
const css = readFileSync(join(ROOT, 'src', 'client', 'shadcn.css'), 'utf8');
const theme = /@theme inline\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const colours = new Map([...theme.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()]));
const tokens = new Set<string>(LIVERY_TOKENS.map((t) => t.name));
const checked = (fg: string, bg: string): boolean => CONTRAST_PAIRS.some(([text, surfaces]) => text === fg && surfaces.includes(bg));
const token = (value: string): string => /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1] ?? value;

const uiFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? uiFiles(join(dir, e.name)) : [join(dir, e.name)]));
const ui = uiFiles(join(ROOT, 'src', 'client', 'ui')).map((f) => [f, readFileSync(f, 'utf8')] as const);

describe('shadcn.css', () => {
  it('maps the shadcn colours (the scan is not looking at nothing)', () => {
    expect(colours.size).toBeGreaterThanOrEqual(19);
  });

  it('makes each --color-* a var() of a livery token', () => {
    for (const [name, value] of colours) expect(tokens.has(token(value)), `--color-${name}: ${value}`).toBe(true);
  });

  it('gives each foreground/background pair a contrast that CONTRAST_PAIRS checks', () => {
    const pairs = [...colours.keys()].filter((n) => n.endsWith('-foreground')).map((n) => [n, n.replace(/-foreground$/, '')] as const);
    pairs.push(['foreground', 'background']);
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    for (const [fg, bg] of pairs) {
      const [f, b] = [token(colours.get(fg) ?? ''), token(colours.get(bg) ?? '')];
      expect(checked(f, b), `${fg} (${f}) on ${bg} (${b})`).toBe(true);
    }
  });

  it('never declares the bare shadcn --muted, which is our text colour', () => {
    expect(css).not.toMatch(/^\s*--muted\s*:/m);
  });

  it('loads no Preflight', () => {
    expect(css).not.toMatch(/@import\s+['"]tailwindcss(?:\/preflight[^'"]*)?['"]/);
  });
});

describe('the shadcn files in src/client/ui', () => {
  it('are there', () => {
    expect(ui.length).toBeGreaterThan(0);
  });

  it('hold no colour literal, no dark-mode class and no Pro icon', () => {
    for (const [file, text] of ui) {
      expect(text, file).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:oklch|rgba?|hsla?)\(/i);
      expect(text, file).not.toMatch(/\bdark:|\.dark\b/);
      expect(text, file).not.toMatch(/@hugeicons-pro/);
    }
  });
});

it('package.json takes no Pro icon package', () => {
  expect(readFileSync(join(ROOT, 'package.json'), 'utf8')).not.toMatch(/@hugeicons-pro/);
});
