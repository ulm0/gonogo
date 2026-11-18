import { describe, expect, it } from 'vitest';
import { blockIsOff, displayBlocks, mergeEdit, BLOCK_ROWS_MAX, GRID_COLUMNS, GRID_ROWS_MAX, DEFAULT_BLOCKS, DEFAULT_DESKS, checkLayout, clampBlock, compact, copyBlocks, describe as say, fits, hide, overlaps, phoneOrder, place, restore, shown, swapKeys } from '../src/shared/layout.js';
import type { Block, BlockId } from '../src/shared/layout.js';

const get = (blocks: readonly Block[], id: BlockId): Block => blocks.find((b) => b.id === id) as Block;
const rect = (b: Block): [number, number, number, number] => [b.x, b.y, b.w, b.h];
const noOverlap = (blocks: readonly Block[]): boolean => {
  const v = shown(blocks);
  return v.every((a, i) => v.every((b, j) => i >= j || !overlaps(a, b)));
};
const blocks = (): Block[] => copyBlocks(DEFAULT_BLOCKS);

describe('the default layout', () => {
  it('is today\'s page: five blocks in a row and the consoles under them, all in the grid and none on another', () => {
    expect(DEFAULT_BLOCKS.every(fits)).toBe(true);
    expect(noOverlap(DEFAULT_BLOCKS)).toBe(true);
    expect(DEFAULT_BLOCKS.slice(0, 5).map((b) => [b.id, b.y])).toEqual([['mission', 0], ['sequence', 0], ['tminus', 0], ['maxq', 0], ['propellant', 0]]);
    expect(DEFAULT_BLOCKS.slice(0, 5).reduce((n, b) => n + b.w, 0)).toBe(GRID_COLUMNS);
    expect(rect(get(DEFAULT_BLOCKS, 'operations'))).toEqual([0, 2, 12, 6]);
    expect(checkLayout({ blocks: DEFAULT_BLOCKS, desks: DEFAULT_DESKS })).toMatchObject({ ok: true });
    // compacting the default changes nothing
    expect(compact(blocks())).toEqual(blocks());
  });
});

describe('fits and clamp', () => {
  it('wants whole numbers in the grid, at least the minimum, and refuses the rest', () => {
    expect(fits({ id: 'maxq', x: 0, y: 0, w: 2, h: 2 })).toBe(true);
    expect(fits({ id: 'maxq', x: 11, y: 0, w: 2, h: 2 })).toBe(false);
    expect(fits({ id: 'maxq', x: 0, y: 0, w: 1, h: 2 })).toBe(false);
    expect(fits({ id: 'operations', x: 0, y: 0, w: 5, h: 3 })).toBe(false);
    expect(fits({ id: 'maxq', x: -1, y: 0, w: 2, h: 2 })).toBe(false);
    expect(fits({ id: 'maxq', x: 0.5, y: 0, w: 2, h: 2 })).toBe(false);
    expect(fits({ id: 'maxq', x: 0, y: GRID_ROWS_MAX, w: 2, h: 2 })).toBe(false);
    expect(fits({ id: 'maxq', x: 0, y: 0, w: 2, h: BLOCK_ROWS_MAX + 1 })).toBe(false);
    expect(fits({ id: 'nope' as BlockId, x: 0, y: 0, w: 2, h: 2 })).toBe(false);
  });

  it('brings a rectangle to the nearest one that fits', () => {
    expect(rect(clampBlock({ id: 'maxq', x: 20, y: -3, w: 1, h: 1 }))).toEqual([10, 0, 2, 2]);
    expect(rect(clampBlock({ id: 'operations', x: 2, y: 0, w: 30, h: 1 }))).toEqual([0, 0, 12, 3]);
    expect(clampBlock({ id: 'mission', x: 0, y: 0, w: 3, h: 99 }).h).toBe(BLOCK_ROWS_MAX);
    expect(rect(clampBlock({ id: 'mission', x: 1.6, y: 2.4, w: 2.6, h: 2 }))).toEqual([2, 2, 3, 2]);
  });
});

describe('place', () => {
  it('moves a block and pushes the one it lands on down, never leaving two blocks on a cell', () => {
    const out = place(blocks(), 'maxq', { x: 0, y: 0 });
    expect(rect(get(out, 'maxq'))).toEqual([0, 0, 2, 2]);
    expect(noOverlap(out)).toBe(true);
    // mission was where maxq landed: it goes below it
    expect(get(out, 'mission').y).toBeGreaterThanOrEqual(2);
    expect(out.every(fits)).toBe(true);
  });

  it('settles the rest upward around the block that was moved, and leaves the moved one where it was dropped', () => {
    const out = place(blocks(), 'operations', { x: 0, y: 0, w: 12, h: 6 });
    expect(rect(get(out, 'operations'))).toEqual([0, 0, 12, 6]);
    expect(out.filter((b) => b.id !== 'operations').every((b) => b.y === 6)).toBe(true);
    expect(noOverlap(out)).toBe(true);
    // dropped far down, with nothing under it: it stays there, the others rise
    const low = place(blocks(), 'mission', { y: 20 });
    expect(get(low, 'mission').y).toBe(20);
    // the wall blocks rise to the top and the consoles rest on them
    expect(get(low, 'operations').y).toBe(2);
    expect(get(low, 'sequence').y).toBe(0);
  });

  it('resizes down to the minimum and not below, and up to the width of the grid', () => {
    expect(rect(get(place(blocks(), 'sequence', { w: 1, h: 1 }), 'sequence'))).toEqual([3, 0, 3, 2]);
    const wide = place(blocks(), 'mission', { w: 12 });
    expect(rect(get(wide, 'mission'))).toEqual([0, 0, 12, 2]);
    expect(noOverlap(wide)).toBe(true);
    expect(wide.every(fits)).toBe(true);
  });

  it('keeps every block in the grid whatever the patch says', () => {
    for (const patch of [{ x: 99 }, { x: -9 }, { y: 999 }, { w: 99 }, { h: 99 }, { w: 0, h: 0 }, { x: 5.5, y: 1.2 }]) {
      const out = place(blocks(), 'tminus', patch);
      expect(out.every(fits), JSON.stringify(patch)).toBe(true);
      expect(noOverlap(out), JSON.stringify(patch)).toBe(true);
    }
  });

  it('does not change the list it is given, and ignores an unknown id', () => {
    const before = blocks();
    place(before, 'maxq', { x: 0, y: 0 });
    expect(before).toEqual(blocks());
    expect(place(before, 'nope' as BlockId, { x: 1 })).toEqual(before);
  });
});

describe('compact', () => {
  it('lets blocks fall up to the top or the block above them, in reading order', () => {
    const out = compact([
      { id: 'mission', x: 0, y: 5, w: 3, h: 2 },
      { id: 'sequence', x: 0, y: 9, w: 3, h: 2 },
      { id: 'tminus', x: 6, y: 7, w: 2, h: 2 },
      { id: 'maxq', x: 8, y: 0, w: 2, h: 2 },
      { id: 'propellant', x: 10, y: 3, w: 2, h: 2 },
      { id: 'operations', x: 0, y: 12, w: 12, h: 3 },
    ]);
    expect(rect(get(out, 'mission'))).toEqual([0, 0, 3, 2]);
    expect(rect(get(out, 'sequence'))).toEqual([0, 2, 3, 2]);
    expect(rect(get(out, 'tminus'))).toEqual([6, 0, 2, 2]);
    expect(rect(get(out, 'propellant'))).toEqual([10, 0, 2, 2]);
    expect(get(out, 'operations').y).toBe(4);
  });
});

describe('hide and restore', () => {
  it('hides a block, never the consoles, lets the others settle into the gap, and a hidden block takes no room', () => {
    const hidden = hide(blocks(), 'mission');
    expect(get(hidden, 'mission').hidden).toBe(true);
    expect(rect(get(hidden, 'mission'))).toEqual([0, 0, 3, 2]);
    const moved = place(hidden, 'sequence', { x: 0, y: 0 });
    expect(rect(get(moved, 'sequence'))).toEqual([0, 0, 3, 2]);
    expect(get(moved, 'mission').hidden).toBe(true);
    expect(hide(blocks(), 'operations')).toEqual(blocks());
  });

  it('shows a block again where it was and pushes what is there down', () => {
    const hidden = hide(blocks(), 'mission');
    const filled = place(hidden, 'sequence', { x: 0, y: 0 });
    const back = restore(filled, 'mission');
    expect(get(back, 'mission').hidden).toBeUndefined();
    expect(rect(get(back, 'mission'))).toEqual([0, 0, 3, 2]);
    expect(get(back, 'sequence').y).toBeGreaterThanOrEqual(2);
    expect(noOverlap(back)).toBe(true);
  });
});

describe('the phone and the words', () => {
  it('reads the blocks by rows, then columns, without the hidden ones', () => {
    const out = hide(place(blocks(), 'maxq', { x: 0, y: 0 }), 'tminus');
    expect(phoneOrder(out).map((b) => b.id)).toEqual(['maxq', 'sequence', 'propellant', 'mission', 'operations']);
  });

  it('says where a block is in one phrase for the live region', () => {
    expect(say({ id: 'maxq', x: 3, y: 1, w: 4, h: 2 })).toBe('MAX Q, column 4, row 2, 4 wide, 2 high');
  });
});

describe('swapKeys', () => {
  it('swaps two cells of an order, completing it with the cells it did not have', () => {
    const all = ['p:flight', 'p:fao', 'a:ana', 'a:ben'];
    expect(swapKeys([], all, 'p:flight', 'a:ben')).toEqual(['a:ben', 'p:fao', 'a:ana', 'p:flight']);
    expect(swapKeys(['a:ben', 'gone', 'p:flight'], all, 'a:ana', 'a:ben')).toEqual(['a:ana', 'p:flight', 'p:fao', 'a:ben']);
    expect(swapKeys([], all, 'a:ana', 'a:ana')).toEqual(all);
    expect(swapKeys([], all, 'a:ana', 'a:zed')).toEqual(all);
  });
});

describe('checkLayout', () => {
  const ok = { blocks: DEFAULT_BLOCKS, desks: { sort: 'manual', order: ['p:flight', 'a:ana'] } };
  it('takes a good layout, with or without desks', () => {
    expect(checkLayout(ok)).toMatchObject({ ok: true, desks: { sort: 'manual', order: ['p:flight', 'a:ana'] } });
    expect(checkLayout({ blocks: DEFAULT_BLOCKS })).toMatchObject({ ok: true, desks: DEFAULT_DESKS });
  });

  const refused = (patch: Record<string, unknown> | null, field: string, text?: RegExp): void => {
    const result = checkLayout(patch === null ? null : { ...ok, ...patch });
    expect(result).toMatchObject({ ok: false, field });
    if (text !== undefined) expect((result as { error: string }).error).toMatch(text);
  };

  it('refuses what is not a layout, naming the field', () => {
    refused(null, 'blocks');
    refused({ blocks: 'x' }, 'blocks');
    refused({ blocks: [...DEFAULT_BLOCKS, DEFAULT_BLOCKS[0]] }, 'blocks', /once/);
    refused({ blocks: [...DEFAULT_BLOCKS, { id: 'notes' }, 3] }, 'blocks', /object with an id/);
    refused({ blocks: [{ ...DEFAULT_BLOCKS[0], w: 1 }, ...DEFAULT_BLOCKS.slice(1)] }, 'blocks', /does not fit/);
    refused({ blocks: [{ ...DEFAULT_BLOCKS[0], x: 11 }, ...DEFAULT_BLOCKS.slice(1)] }, 'blocks', /does not fit/);
    refused({ blocks: [{ ...DEFAULT_BLOCKS[0], extra: 1 }, ...DEFAULT_BLOCKS.slice(1)] }, 'blocks', /no field "extra"/);
    refused({ blocks: [{ ...DEFAULT_BLOCKS[0], hidden: 'yes' }, ...DEFAULT_BLOCKS.slice(1)] }, 'blocks', /hidden/);
    refused({ blocks: [{ ...DEFAULT_BLOCKS[0], x: 3 }, ...DEFAULT_BLOCKS.slice(1)] }, 'blocks', /overlap/);
    refused({ blocks: [...DEFAULT_BLOCKS.slice(0, 5), { ...DEFAULT_BLOCKS[5], hidden: true }] }, 'blocks', /operations cannot be hidden/);
    refused({ desks: { sort: 'loud', order: [] } }, 'desks');
    refused({ desks: { sort: 'manual', order: ['p:flight', 'p:flight'] } }, 'desks');
    refused({ desks: { sort: 'manual', order: ['../x'] } }, 'desks');
    refused({ desks: { sort: 'manual', order: Array.from({ length: 65 }, (_, i) => `a:n${i}`) } }, 'desks');
    refused({ desks: 'x' }, 'desks');
  });

  it('does not refuse a layout for a block it does not know or lacks: it drops the first and adds the second', () => {
    const result = checkLayout({ blocks: [...DEFAULT_BLOCKS.slice(1), { id: 'notes', x: 0, y: 9, w: 3, h: 3 }] });
    expect(result).toMatchObject({ ok: true });
    const blocks = (result as { blocks: Block[] }).blocks;
    expect(blocks.map((b) => b.id)).not.toContain('notes');
    expect(blocks.find((b) => b.id === 'mission')).toEqual({ ...DEFAULT_BLOCKS[0], hidden: true });
    expect(blocks).toHaveLength(6);
  });

  it('lets hidden blocks overlap the shown ones: they take no room', () => {
    const list = [{ ...DEFAULT_BLOCKS[0], hidden: true }, { ...DEFAULT_BLOCKS[1], x: 0 }, ...DEFAULT_BLOCKS.slice(2)];
    expect(checkLayout({ blocks: list })).toMatchObject({ ok: true });
  });
});

describe('the blocks of a feature that is off', () => {
  it('knows which blocks belong to a feature, and draws the others settled around the gap, without changing the layout', () => {
    expect(blockIsOff(get(blocks(), 'maxq'), ['maxq'])).toBe(true);
    expect(blockIsOff(get(blocks(), 'propellant'), ['maxq'])).toBe(false);
    expect(blockIsOff(get(blocks(), 'maxq'), [])).toBe(false);
    const saved = blocks();
    const shownNow = displayBlocks(saved, ['maxq']);
    expect(shownNow.some((b) => b.id === 'maxq')).toBe(false);
    expect(noOverlap(shownNow)).toBe(true);
    expect(saved).toEqual(DEFAULT_BLOCKS);
    // nothing off: exactly the layout
    expect(displayBlocks(saved, [])).toEqual(DEFAULT_BLOCKS);
  });

  it('keeps the entry of an off block when the draft is edited, and hides it (rectangle kept) only when an edit lands on it', () => {
    const draft = blocks();
    const edited = place(displayBlocks(draft, ['maxq']), 'propellant', { x: 8, y: 0 });
    const merged = mergeEdit(draft, edited, ['maxq']);
    // the edit now lies on MAX Q's place: its entry stays, hidden, so the file is one the server accepts
    expect(get(merged, 'maxq')).toMatchObject({ x: 8, y: 0, w: 2, h: 2, hidden: true });
    expect(checkLayout({ blocks: merged })).toMatchObject({ ok: true });
    const clear = mergeEdit(draft, place(displayBlocks(draft, ['maxq']), 'mission', { x: 0, y: 0 }), ['maxq']);
    expect(get(clear, 'maxq')).toEqual(get(draft, 'maxq'));
  });

  it('puts the consoles back above the last row of the grid when a file lacks them', () => {
    const tall = [{ id: 'mission', x: 0, y: 0, w: 3, h: 2 }, { id: 'sequence', x: 0, y: 195, w: 3, h: 5 }];
    const result = checkLayout({ blocks: tall });
    expect(result.ok === false ? result.error : 'ok').toMatch(/overlap|fit/);
    const ok = checkLayout({ blocks: [{ id: 'sequence', x: 0, y: 150, w: 3, h: 2 }] });
    expect(ok.ok && get(ok.blocks, 'operations').y + get(ok.blocks, 'operations').h).toBeLessThanOrEqual(GRID_ROWS_MAX);
  });
});
