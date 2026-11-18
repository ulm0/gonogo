/** The design system: no emoji in the page or the docs mocks, and every native control wears the instrument's primitives. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, ext) : ext.test(name) ? [path] : [];
  });

const page = walk('src/client', /\.(tsx?|css)$/);
const docs = walk('.vitepress/theme', /\.(vue|css|ts)$/);
const primitives = readFileSync('src/client/primitives.css', 'utf8');

// A symbol that is a key label of the terminal keypad (arrows, enter), not a picture.
const ALLOWED = new Set(['⏎']);
const emoji = (text: string): string[] => [...text.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]).filter((c) => !ALLOWED.has(c));

describe('no emoji', () => {
  it.each([...page, ...docs])('%s', (file) => {
    expect(emoji(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('the docs pages show none either', () => {
    for (const file of [...walk('docs/features', /\.md$/), ...walk('docs/guide', /\.md$/), 'docs/design-system.md']) expect(emoji(readFileSync(file, 'utf8')), file).toEqual([]);
  });
});

describe('the primitives', () => {
  it.each(['select.input', '.tabs', '.tab', '.check', '.radio', '.switch', ".icon[data-icon='lock']", ".icon[data-icon='chevron-right']", ".icon[data-icon='chevron-down']", ".icon[data-icon='half']"])('defines %s', (selector) => {
    expect(primitives).toContain(selector);
  });
});

describe('the controls of the page', () => {
  /** The opening tags of one element name; a `>` inside braces (an arrow function in an attribute) does not end a tag. */
  const tags = (text: string, tag: string): string[] =>
    [...text.matchAll(new RegExp(`<${tag}(?=[\\s/>])`, 'g'))].map((m) => {
      let depth = 0;
      let end = m.index;
      for (; end < text.length; end += 1) {
        const c = text[end];
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        else if (c === '>' && depth === 0) break;
      }
      return text.slice(m.index, end + 1);
    });

  it.each(page.filter((f) => f.endsWith('.tsx')))('%s: every control wears a primitive', (file) => {
    const text = readFileSync(file, 'utf8');
    for (const input of tags(text, 'input')) {
      if (/type="checkbox"/.test(input)) expect(input, file).toMatch(/className="(check|switch)"/);
      else if (/type="radio"/.test(input)) expect(input, file).toMatch(/className="radio"/);
      else expect(input, file).toMatch(/className=(\{[^}]*\binput\b|"[^"]*\b(input|lcd)\b)/);
    }
    for (const select of tags(text, 'select')) expect(select, file).toMatch(/className="[^"]*\binput\b/);
    // the Hangar's editor is a code surface of its own (hg-text), not a form field
    for (const area of tags(text, 'textarea').filter((a) => !/\bhg-text\b/.test(a))) expect(area, file).toMatch(/className=(\{[^}]*\btextarea\b|"[^"]*\btextarea\b)/);
  });
});
