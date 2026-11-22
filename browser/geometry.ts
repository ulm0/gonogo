import type { Page } from '@playwright/test';

/**
 * The geometry rules of the prototype layout, measured in the page as it is drawn: no two visible interactive elements overlap, nothing makes the page scroll sideways,
 * no label is clipped (`scope`: only what is inside that selector, so a view is measured for what it changed), and every key is at least 24 px (44 px on a phone) high and wide. "Visible" = the element is what the browser draws at its centre (not covered, not hidden).
 */
export async function geometry(page: Page, phone: boolean, scope = 'body'): Promise<string[]> {
  return page.evaluate(({ min, scope }) => {
    const inScope = (el: Element): boolean => scope === 'body' || el.closest(scope) !== null;
    const problems: string[] = [];
    const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
    if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && e.getBoundingClientRect().width > 0 && e.closest('.next-group-nav') === null).slice(0, 6);
      for (const e of wide) problems.push(`  wider than the screen: ${name(e)} right=${Math.round(e.getBoundingClientRect().right)}`);
    }
    const fixed = (el: Element): boolean => {
      for (let e: Element | null = el; e !== null; e = e.parentElement) if (['fixed', 'sticky'].includes(getComputedStyle(e).position)) return true;
      return false;
    };
    const keys = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, summary, [role=button]')].filter((el) => {
      if (!inScope(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') return false;
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
      const top = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1));
      return top !== null && (top === el || el.contains(top));
    });
    for (let i = 0; i < keys.length; i += 1) {
      const a = keys[i].getBoundingClientRect();
      for (let j = i + 1; j < keys.length; j += 1) {
        if (keys[i].contains(keys[j]) || keys[j].contains(keys[i])) continue;
        // a bar fixed or sticky to the screen (the bottom bar of a phone) is over whatever scrolls under it, by design
        if (fixed(keys[i]) !== fixed(keys[j])) continue;
        const b = keys[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) problems.push(`overlap: ${name(keys[i])} and ${name(keys[j])} (${Math.round(w)}x${Math.round(h)})`);
      }
      const inText = keys[i].closest('p, li') !== null && keys[i].tagName === 'A';
      if (!inText && (a.height < min - 0.5 || a.width < min - 0.5) && !keys[i].matches('input[type=checkbox], input[type=radio]')) problems.push(`small key (${Math.round(a.width)}x${Math.round(a.height)}, need ${min}): ${name(keys[i])}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>('.btn, .chip, .label, .hint, .lamp-text, h1, h2')) {
      if (!inScope(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.clientWidth <= 1) continue; // visually hidden on purpose (a screen-reader label)
      const style = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 1 && style.display !== 'inline' && style.textOverflow !== 'ellipsis') problems.push(`text clipped: ${name(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    }
    // text cut at the bottom: a box that hides its overflow and holds more than it shows (a card whose second line is cut in the middle of a glyph)
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!inScope(el)) continue;
      if (el.closest('.xterm, .term-wrap, .next-select, .next-strip-row') !== null || (el.textContent ?? '').trim() === '') continue;
      const style = getComputedStyle(el);
      if (style.overflowY !== 'hidden' && style.overflowY !== 'clip') continue;
      if (style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '') continue; // cut on purpose, with an ellipsis
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || el.clientHeight <= 1) continue; // 1 px high on purpose: a label for a screen reader
      if (el.scrollHeight > el.clientHeight + 1) problems.push(`text cut at the bottom: ${name(el)} (${el.scrollHeight} > ${el.clientHeight})`);
    }
    return problems;
  }, { min: phone ? 44 : 24, scope });
}

/**
 * No control or label appears twice for the same thing on a view (the Director's "botones duplicados" on Flight Rules): among what is visible inside `scope`, two keys with the
 * same name, a heading with the name of a row, two headings with one name, and a value line that a row already shows. A 1 px label for a screen reader is not drawn, so it does not count.
 */
export async function duplicates(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const norm = (s: string): string => s.toLowerCase().replace(/[▾▸←→↓↑⌕⋯≡✓]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const drawn = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width > 3 && r.height > 3 && getComputedStyle(el).visibility !== 'hidden' && el.closest('[hidden]') === null;
    };
    const root = [...document.querySelectorAll(scope)];
    const inside = (el: Element): boolean => root.some((r) => r.contains(el));
    const problems: string[] = [];
    const seen = new Map<string, string>();
    const note = (kind: string, text: string, where: string): void => {
      if (text === '') return;
      const key = text;
      const before = seen.get(key);
      // a key and a heading with one word are two roles (a group's key "Room" and the Features block's heading "ROOM"): heard apart
      if (before !== undefined && before !== kind + ' ' + where && ![before, kind].every((k) => /a key|a heading/.test(k))) problems.push(`"${text}" is both ${before} and ${kind} ${where}`.replace('  ', ' '));
      else if (before === kind + ' ' + where) problems.push(`"${text}" appears twice as ${kind} ${where}`);
      else seen.set(key, kind + ' ' + where);
    };
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], .lay-row-name, h1, h2, h3, .lay-group-title')) {
      if (!inside(el) || !drawn(el)) continue;
      if (el.closest('.lay-row > summary') !== null && !el.classList.contains('lay-row-name')) continue; // the Edit mark of a row is not a key of its own
      const kind = el.matches('button, a[href]') ? 'a key' : el.classList.contains('lay-row-name') ? 'a row' : 'a heading';
      const text = norm(el.getAttribute('aria-label') ?? el.textContent ?? '');
      // the key of a group is the heading of the group: it is one thing
      if (el.matches('.lay-group-title')) continue;
      note(kind, text, '');
    }
    // the same sentence twice on a view (the update note printed in two places): any two drawn blocks of text of 40 characters or more that say the same
    const said = new Map<string, number>();
    for (const el of document.querySelectorAll<HTMLElement>('p, span, div')) {
      if (!inside(el) || !drawn(el) || el.querySelector('p, div') !== null) continue;
      const words = norm(el.textContent ?? '');
      if (words.length < 40) continue;
      said.set(words, (said.get(words) ?? 0) + 1);
    }
    for (const [words, n] of said) if (n > 1) problems.push(`the same sentence is drawn ${n} times: "${words.slice(0, 60)}…"`);
    // a line that says its value and, in a chip beside it, the same words ("built-in default" twice)
    for (const line of document.querySelectorAll<HTMLElement>('.rt-now')) {
      if (!inside(line) || !drawn(line)) continue;
      const parts = [...line.children].filter((c) => drawn(c)).map((c) => norm(c.textContent ?? ''));
      if (new Set(parts).size !== parts.length) problems.push(`a setting says the same words twice in one line: "${parts.join('" and "')}"`);
    }
    // a value that the summary of a row shows and the opened row shows again
    for (const row of document.querySelectorAll<HTMLElement>('details.lay-row')) {
      if (!inside(row) || !drawn(row)) continue;
      const now = norm(row.querySelector('.lay-row-now')?.textContent ?? '');
      if (now === '' || now === 'see edit') continue;
      for (const v of row.querySelectorAll<HTMLElement>('.rules-value')) if (drawn(v) && norm(v.textContent ?? '') === now) problems.push(`"${now}" is shown by the row and again in its block`);
    }
    return problems;
  }, scope);
}
