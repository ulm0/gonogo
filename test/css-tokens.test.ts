/**
 * Every var(--name) in the page's style sheets names something that exists. A custom property that nobody defines makes a rule
 * fall back silently (to `inherit` or a fallback colour): the rule then looks written and does nothing, and no test of logic
 * sees it. Two such rules (a stale verdict and an over-budget spend that were meant to be amber) shipped that way.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_LIVERIES, LIVERY_TOKENS } from '../src/shared/livery.js';

const DIR = join(import.meta.dirname, '..', 'src', 'client');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');
const css = readdirSync(DIR).filter((f) => f.endsWith('.css'));
const code = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f)).map(read).join('\n');

/** Names declared by a rule of any style sheet (`--x: ...`), or set by a component through a style prop (`'--x': value`). */
const declared = new Set<string>();
for (const f of css) for (const m of read(f).matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1] as string);
for (const m of code.matchAll(/'(--[a-z0-9-]+)'\s*:/g)) declared.add(m[1] as string);

const used = new Map<string, Set<string>>();
for (const f of css) {
  for (const m of read(f).matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
    const name = m[1] as string;
    used.set(name, (used.get(name) ?? new Set()).add(f));
  }
}

describe('the custom properties of the style sheets', () => {
  it('reads some: the scan is not looking at nothing', () => {
    expect(css.length).toBeGreaterThan(10);
    expect(used.size).toBeGreaterThan(30);
    expect(declared.has('--text')).toBe(true);
  });

  it('defines every var() it uses, with a fallback or without one', () => {
    const missing = [...used.entries()].filter(([name]) => !declared.has(name)).map(([name, files]) => `${name} (${[...files].join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('gives every colour token a livery sets a value in every livery that ships, and in the default block', () => {
    const tokens = LIVERY_TOKENS.map((t) => t.name);
    const root = read('tokens.css');
    for (const name of tokens) {
      expect(root, `${name} in :root`).toMatch(new RegExp(`${name}\\s*:`));
      for (const livery of BUILTIN_LIVERIES) expect(livery.tokens[name as keyof typeof livery.tokens], `${name} in ${livery.slug}`).toBeTruthy();
    }
  });

  it('uses, for a colour token, one that every livery sets: a rule never depends on a token only some looks have', () => {
    const tokens = new Set<string>(LIVERY_TOKENS.map((t) => t.name));
    for (const [name] of used) {
      if (!tokens.has(name)) continue;
      for (const livery of BUILTIN_LIVERIES) expect(Object.keys(livery.tokens), `${name} in ${livery.slug}`).toContain(name);
    }
  });
});

// A lost `}` (a merge kept one side of a rule) makes the bundler nest every later file's rules under that selector: the page
// loads with no error and the whole layout falls apart (0.5.1, `.stepup-row`).
describe('style sheets', () => {
  it.each(css)('%s closes every brace it opens', (f) => {
    let depth = 0;
    for (const ch of read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '')) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
