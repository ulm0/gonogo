/**
 * The dense tile of the Room view (64 px high, one plain line) belongs to the matrix of that view. The list of rooms draws the same `.tile.room-tile`: a phone
 * rule for `.room-tile` that is not under `.matrix` cut every card of the list to 64 px, and its keys spilled over the next block (t80, seen at 390 px).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/client/shell.css', import.meta.url), 'utf8');

/** The text of the `@media (max-width: 699px)` blocks, braces matched. */
function phoneBlocks(): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@media \(max-width: 699px\) \{/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(start, i - 1));
  }
  return out;
}

describe('the phone rules of the tile', () => {
  it('reads some phone blocks: the scan is not looking at nothing', () => {
    expect(phoneBlocks().length).toBeGreaterThan(0);
    expect(phoneBlocks().join('\n')).toContain('.matrix .room-tile');
  });

  it('are under .matrix: no phone selector reaches a .room-tile, .tile-head, .tile-foot or .tile-lcd of the list of rooms', () => {
    const selectors = phoneBlocks()
      .join('\n')
      .split(/[{}]/)
      .flatMap((chunk) => chunk.split(',').map((s) => s.trim().split('\n').pop()?.trim() ?? ''))
      .filter((s) => /\.(room-tile|tile-head|tile-foot|tile-lcd|tile-num|tile-right|tile-state-vote)\b/.test(s));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector, 'a phone tile rule outside the matrix').toMatch(/^\.matrix\s/);
  });
});
