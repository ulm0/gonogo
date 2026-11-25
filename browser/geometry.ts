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

/** The kinds of problem `overlaps` reports; a screens run fails on any of them (the Director: "you still overlap components"). */
export const OVERLAP_KINDS = ['text on text', 'off screen', 'under the bar'] as const;

/**
 * What covers what, measured in the page as drawn (the keys among themselves are in `geometry`):
 * - text on text: two runs of text of the page drawn over each other (a chip or a badge on a word, a long name under its neighbour);
 * - off screen: a popover, menu, tooltip or open dialog that does not fit the screen (cut at an edge, with no scroll to reach the rest);
 * - under the bar: at the end of the page a bar fixed or sticky at the bottom still covers a key or text (the content has no room left below
 *   it), or at the top of the page a bar at the top covers one.
 * A box clipped by a scrolling parent counts only where it shows. Text a screen reader alone reads (1 px boxes) does not count.
 */
export async function overlaps(page: Page, scope = 'body'): Promise<string[]> {
  return page.evaluate(async ({ scope }) => {
    const problems: string[] = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inScope = (el: Element): boolean => scope === 'body' || el.closest(scope) !== null;
    const label = (el: Element): string => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)}"`;
    const POP = '.lay-pop, [role=dialog], [role=menu], [role=listbox], [role=tooltip], [data-radix-popper-content-wrapper], dialog[open]';
    const pinned = (el: Element): HTMLElement | null => {
      for (let e: Element | null = el; e !== null; e = e.parentElement) if (['fixed', 'sticky'].includes(getComputedStyle(e).position)) return e as HTMLElement;
      return null;
    };
    const shown = (el: Element): boolean => {
      // checkVisibility also sees the content of a closed <details> (laid out under content-visibility: hidden, all at one spot)
      if (!el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
      for (let e: Element | null = el; e !== null; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
      }
      return true;
    };
    type Box = { left: number; top: number; right: number; bottom: number };
    const meet = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const area = (b: Box): [number, number] => [b.right - b.left, b.bottom - b.top];
    /** The part of a box its clipping parents let show (each parent that hides or scrolls its overflow cuts it). */
    const visible = (el: Element, box: Box): Box => {
      let out = box;
      for (let e: HTMLElement | null = el as HTMLElement; e !== null && e !== document.body; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') out = meet(out, e.getBoundingClientRect());
      }
      return out;
    };

    // off screen: every popover, menu, tooltip or dialog that is open fits the screen
    for (const pop of document.querySelectorAll<HTMLElement>(POP)) {
      if (!inScope(pop) || !shown(pop) || pop.parentElement?.closest(POP) != null) continue;
      const r = pop.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) problems.push(`off screen: ${label(pop)} at ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} on ${vw}x${vh}`);
    }

    // text on text: the drawn lines of every text node, two nodes never on each other
    const lines: { el: HTMLElement; box: Box; pin: HTMLElement | null; pop: Element | null }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const el = n.parentElement;
      if (el === null || (n.textContent ?? '').trim() === '' || !inScope(el) || el.closest('.xterm, script, style, [aria-hidden=true] svg') !== null) continue;
      if (el.clientHeight === 1 || el.closest('.sr-only') !== null || !shown(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 2 || r.height < 2) continue;
        const box = visible(el, r);
        const [w, h] = area(box);
        if (w > 2 && h > 2) lines.push({ el, box, pin: pinned(el), pop: el.closest(POP) });
      }
    }
    lines.sort((a, b) => a.box.top - b.box.top);
    const said = new Set<string>();
    for (let i = 0; i < lines.length; i += 1) {
      const a = lines[i];
      for (let j = i + 1; j < lines.length && lines[j].box.top < a.box.bottom; j += 1) {
        const b = lines[j];
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // a popover is over the page by design, and a pinned bar over what scrolls under it (the end of the page is checked below)
        if (a.pop !== b.pop || a.pin !== b.pin) continue;
        const [w, h] = area(meet(a.box, b.box));
        if (w <= 3 || h <= 3) continue; // two line boxes may touch by a pixel or two; glyphs on glyphs are more
        const text = `text on text: ${label(a.el)} and ${label(b.el)} (${Math.round(w)}x${Math.round(h)})`;
        if (!said.has(text)) problems.push(text);
        said.add(text);
      }
    }

    // under the bar: at the top of the page a top bar, at the end of the page a bottom bar, covers nothing
    const bars = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => {
      const s = getComputedStyle(el);
      if (!['fixed', 'sticky'].includes(s.position) || el.closest(POP) !== null || !shown(el)) return false;
      const r = el.getBoundingClientRect();
      // a full-screen layer (a dialog's backdrop, a drawer) is not a bar
      return r.width > 40 && r.height > 8 && r.height < vh * 0.5 && pinned(el.parentElement ?? document.body) === null;
    });
    const things = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [role=button], p, h1, h2, h3, li, label, .chip')].filter(
      (el) => inScope(el) && pinned(el) === null && el.closest(POP) === null && shown(el) && el.clientHeight !== 1,
    );
    const start = window.scrollY;
    // the page and every box that scrolls inside it go to their top, then to their end
    const scrollers = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1);
    const was = scrollers.map((el) => el.scrollTop);
    for (const [where, y] of [['top', 0], ['end', document.documentElement.scrollHeight]] as const) {
      window.scrollTo(0, y);
      for (const el of scrollers) el.scrollTop = where === 'top' ? 0 : el.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const bar of bars) {
        const b = bar.getBoundingClientRect();
        if (where === 'top' ? b.top > vh / 2 : b.bottom < vh / 2) continue;
        for (const el of things) {
          const box = visible(el, el.getBoundingClientRect());
          const [w, h] = area(meet(box, b));
          if (w > 2 && h > 2) problems.push(`under the bar: at the ${where} of the page ${label(bar)} covers ${label(el)} (${Math.round(w)}x${Math.round(h)})`);
        }
      }
    }
    window.scrollTo(0, start);
    scrollers.forEach((el, i) => (el.scrollTop = was[i] ?? 0));
    return problems;
  }, { scope });
}

/**
 * No control or label appears twice for the same thing on a view (the Director's "botones duplicados" on Flight Rules): among what is visible inside `scope`, two keys with the
 * same name, a heading with the name of a row, two headings with one name, and a value line that a row already shows. A 1 px label for a screen reader is not drawn, so it does not count.
 */
export async function duplicates(page: Page, scope: string, sentences = false): Promise<string[]> {
  return page.evaluate(({ scope, sentences }) => {
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
      const key = kind === 'a link of the index' ? 'nav:' + text : text;
      const before = seen.get(key);
      // a key and a heading with one word are two roles (a group's key "Room" and the Features block's heading "ROOM"): heard apart
      if (before !== undefined && before !== kind + ' ' + where && ![before, kind].every((k) => /a key|a heading/.test(k))) problems.push(`"${text}" is both ${before} and ${kind} ${where}`.replace('  ', ' '));
      else if (before === kind + ' ' + where) problems.push(`"${text}" appears twice as ${kind} ${where}`);
      else seen.set(key, kind + ' ' + where);
    };
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], .lay-row-name, h1, h2, h3, .lay-group-title')) {
      if (!inside(el) || !drawn(el)) continue;
      if (el.closest('.lay-row > summary') !== null && !el.classList.contains('lay-row-name')) continue; // the Edit mark of a row is not a key of its own
      // the index of the groups at the top and the heading of each group below are one pair, not a duplicate: the links are looked at among themselves
      const inNav = el.closest('.lay-group-nav') !== null;
      const kind = inNav ? 'a link of the index' : el.matches('button, a[href]') ? 'a key' : el.classList.contains('lay-row-name') ? 'a row' : 'a heading';
      const text = norm(el.getAttribute('aria-label') ?? el.textContent ?? '');
      // the key of a group is the heading of the group: it is one thing
      if (el.matches('.lay-group-title')) continue;
      note(kind, text, '');
    }
    // the same sentence twice on a view (the update note printed in two places): any two drawn blocks of text of 40 characters or more that say the same
    const said = new Map<string, number>();
    // (only where asked: two settings may say "applies at once" each)
    for (const el of sentences ? document.querySelectorAll<HTMLElement>('p, span, div') : []) {
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
  }, { scope, sentences });
}
