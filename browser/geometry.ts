import type { Page } from '@playwright/test';

/**
 * The geometry rules of the prototype layout, measured in the page as it is drawn: no two visible interactive elements overlap, nothing makes the page scroll sideways,
 * no label is clipped, and every key is at least 24 px (44 px on a phone) high and wide. "Visible" = the element is what the browser draws at its centre (not covered, not hidden).
 */
export async function geometry(page: Page, phone: boolean): Promise<string[]> {
  return page.evaluate((min) => {
    const problems: string[] = [];
    const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
    if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && e.getBoundingClientRect().width > 0 && e.closest('.next-group-nav') === null).slice(0, 6);
      for (const e of wide) problems.push(`  wider than the screen: ${name(e)} right=${Math.round(e.getBoundingClientRect().right)}`);
    }
    const keys = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, summary, [role=button]')].filter((el) => {
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
        const b = keys[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) problems.push(`overlap: ${name(keys[i])} and ${name(keys[j])} (${Math.round(w)}x${Math.round(h)})`);
      }
      const inText = keys[i].closest('p, li') !== null && keys[i].tagName === 'A';
      if (!inText && (a.height < min - 0.5 || a.width < min - 0.5) && !keys[i].matches('input[type=checkbox], input[type=radio]')) problems.push(`small key (${Math.round(a.width)}x${Math.round(a.height)}, need ${min}): ${name(keys[i])}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>('.btn, .chip, .label, .hint, .lamp-text, h1, h2')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.clientWidth <= 1) continue; // visually hidden on purpose (a screen-reader label)
      const style = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 1 && style.display !== 'inline' && style.textOverflow !== 'ellipsis') problems.push(`text clipped: ${name(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    }
    // text cut at the bottom: a box that hides its overflow and holds more than it shows (a card whose second line is cut in the middle of a glyph)
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('.xterm, .term-wrap, .next-select, .next-strip-row') !== null || (el.textContent ?? '').trim() === '') continue;
      const style = getComputedStyle(el);
      if (style.overflowY !== 'hidden' && style.overflowY !== 'clip') continue;
      if (style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '') continue; // cut on purpose, with an ellipsis
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || el.clientHeight <= 1) continue; // 1 px high on purpose: a label for a screen reader
      if (el.scrollHeight > el.clientHeight + 1) problems.push(`text cut at the bottom: ${name(el)} (${el.scrollHeight} > ${el.clientHeight})`);
    }
    return problems;
  }, phone ? 44 : 24);
}
