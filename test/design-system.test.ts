/** The design system: no emoji in the page or the docs mocks, and every control of the page is a ui component (native elements in the Instrument's look). */
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
  it.each(['.tabs', '.tab', ".icon[data-icon='lock']", ".icon[data-icon='chevron-right']", ".icon[data-icon='chevron-down']", ".icon[data-icon='half']"])('defines %s', (selector) => {
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

  // the shadcn files (src/client/ui) wear shadcn's utilities over the Livery tokens instead (shadcn.css, test/shadcn-css.test.ts)
  // the controls are the native-element components of src/client/ui (Input, NativeSelect, Textarea, Checkbox, Radio, Switch); a raw element is left only for a surface of its own: the LCD field (lcd) and the Hangar's editor (hg-text)
  it.each(page.filter((f) => f.endsWith('.tsx') && !f.startsWith(join('src', 'client', 'ui'))))('%s: every control is a ui component', (file) => {
    const text = readFileSync(file, 'utf8');
    for (const input of tags(text, 'input')) expect(input, file).toMatch(/className="[^"]*\blcd\b/);
    expect(tags(text, 'select'), file).toEqual([]);
    for (const area of tags(text, 'textarea')) expect(area, file).toMatch(/\bhg-text\b/);
    for (const area of tags(text, 'Textarea')) expect(area, file).toMatch(/variant="field"/);
  });
});
