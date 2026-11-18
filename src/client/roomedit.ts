/**
 * Room editor (docs/room-editor-spec.md): what the editor decides, with no React: the keys that move and resize a block, where a
 * pointer is on the grid, the order of the desks, and the strips that say a hidden block has something live. Pure, so the tests
 * can run it without a DOM.
 */
import { CATALOGUE, GRID_COLUMNS, place, swapKeys } from '../shared/layout.js';
import type { Block, BlockId, DeskOrder, DeskSort } from '../shared/layout.js';
import { FUEL_WINDOWS } from '../shared/protocol.js';
import type { GovernorView, PollView, PropellantView } from '../shared/protocol.js';
import { budgetLevel, fuelLevel } from './wall.js';

/** The row height of the editor's grid and the gap between cells, in pixels: the pointer is turned into cells with them. */
export const EDIT_ROW_PX = 64;
export const EDIT_GAP_PX = 12;

export type EditMode = 'move' | 'resize';

const ARROWS: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** One arrow key on a block that is being moved (it goes a cell) or resized (it grows or shrinks a cell). Other keys: null. */
export function keyStep(blocks: readonly Block[], id: BlockId, mode: EditMode, key: string): Block[] | null {
  const arrow = ARROWS[key];
  const b = blocks.find((x) => x.id === id);
  if (arrow === undefined || b === undefined) return null;
  return mode === 'move' ? place(blocks, id, { x: b.x + arrow[0], y: b.y + arrow[1] }) : place(blocks, id, { w: b.w + arrow[0], h: b.h + arrow[1] });
}

export interface Pitch {
  /** Distance from one column to the next, row to the next. */
  col: number;
  row: number;
}

/** The pitch of the editor's grid for the width it is drawn at. */
export const pitchOf = (width: number): Pitch => ({ col: (width + EDIT_GAP_PX) / GRID_COLUMNS, row: EDIT_ROW_PX + EDIT_GAP_PX });

/** The cell under a point of the page, given the top left corner of the grid. Outside the grid it is the nearest cell. */
export function cellAt(point: { x: number; y: number }, origin: { left: number; top: number }, pitch: Pitch): { col: number; row: number } {
  return {
    col: Math.min(GRID_COLUMNS - 1, Math.max(0, Math.floor((point.x - origin.left) / pitch.col))),
    row: Math.max(0, Math.floor((point.y - origin.top) / pitch.row)),
  };
}

/** A block dragged by a point inside it: it keeps the offset it was grabbed with. */
export function dragMove(blocks: readonly Block[], id: BlockId, cell: { col: number; row: number }, grab: { dx: number; dy: number }): Block[] {
  return place(blocks, id, { x: cell.col - grab.dx, y: cell.row - grab.dy });
}

/** A block resized by its grip: the corner follows the cell under the pointer. */
export function dragResize(blocks: readonly Block[], id: BlockId, cell: { col: number; row: number }): Block[] {
  const b = blocks.find((x) => x.id === id);
  return b === undefined ? [...blocks] : place(blocks, id, { w: cell.col - b.x + 1, h: cell.row - b.y + 1 });
}

/** The blocks the tray offers back: hidden ones, in the order of the catalogue. */
export const hiddenBlocks = (blocks: readonly Block[]): Block[] => blocks.filter((b) => b.hidden === true).sort((a, b) => Object.keys(CATALOGUE).indexOf(a.id) - Object.keys(CATALOGUE).indexOf(b.id));

/* ---- the desks ---- */

export const SORT_LABELS: Readonly<Record<DeskSort, string>> = { positions: 'Positions', state: 'Needs you first', name: 'Name', manual: 'My order' };

/** The sort chosen with AUTO-ARRANGE: a sort of the page, with no order of its own. */
export const autoArrange = (sort: Exclude<DeskSort, 'manual'>): DeskOrder => ({ sort, order: [] });

/** Two cells swap places, whatever the sort was: what the Director sees becomes his own order. `shown` is the keys in the order on the screen now. */
export function swapDesks(shown: readonly string[], a: string, b: string): DeskOrder {
  return { sort: 'manual', order: swapKeys(shown, shown, a, b) };
}

/** The cell next to `key` in the shown order, in a direction, or null at the end. */
export function neighbour(shown: readonly string[], key: string, direction: -1 | 1): string | null {
  const i = shown.indexOf(key);
  return i < 0 ? null : (shown[i + direction] ?? null);
}

/* ---- what a hidden block still has live ---- */

export interface Strip {
  block: BlockId;
  text: string;
}

/** A hidden block with something going on says so: a poll that is open or held, mail that waits for a free slot. */
export function liveStrips(blocks: readonly Block[], poll: PollView | null, governor: GovernorView, fuel?: PropellantView): Strip[] {
  const hidden = (id: BlockId): boolean => blocks.some((b) => b.id === id && b.hidden === true);
  const out: Strip[] = [];
  if (hidden('tminus') && poll !== null) {
    const answered = poll.entries.filter((e) => e.vote !== null).length;
    const what = poll.subject === undefined ? 'poll' : 'static fire';
    out.push({ block: 'tminus', text: `T-MINUS: ${what} ${poll.status === 'open' ? 'open' : poll.status}, ${answered} of ${poll.entries.length} answered.` });
  }
  if (hidden('maxq') && governor.holding > 0) {
    out.push({ block: 'maxq', text: `MAX Q: ${governor.holding} ${governor.holding === 1 ? 'message waits' : 'messages wait'} for a free slot.` });
  }
  if (hidden('propellant') && fuel !== undefined) {
    // at 80 % of a limit or a budget the light turns amber on the page; a hidden block must not hide that
    let worst: { level: 'warn' | 'over'; window: string; money: boolean } | null = null;
    for (const w of FUEL_WINDOWS) {
      for (const [level, money] of [[fuelLevel(fuel.room, w), false], [budgetLevel(fuel.cost.room, w), true]] as const) {
        if ((level === 'warn' || level === 'over') && (worst === null || (level === 'over' && worst.level === 'warn'))) worst = { level, window: w, money };
      }
    }
    if (worst !== null) out.push({ block: 'propellant', text: `PROPELLANT: ${worst.level === 'over' ? 'over' : 'near'} the ${worst.money ? 'budget' : 'limit'} (${worst.window}).` });
  }
  return out;
}

/** Can the room be edited at this width? The editor is for a pointer and a wide screen. */
export const EDIT_MIN_WIDTH = 900;
export const EDIT_TOO_NARROW = 'Edit the room on a wider screen: 900 pixels or more.';
