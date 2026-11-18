/**
 * Room editor (docs/room-editor-spec.md): the blocks of the Room view on a 12-column grid, and the order of the desks. Pure and
 * shared: the page uses `place`, `compact` and `describe` to edit a draft, the server uses `checkLayout` to refuse a bad file.
 * Rows have a fixed height in the editor, so a block is a rectangle of whole cells and two blocks never share a cell.
 */
import { BLOCK_IDS, DESK_SORTS } from './protocol.js';
import type { Block, BlockId, DeskOrder, DeskSort } from './protocol.js';

export { BLOCK_IDS, DESK_SORTS };
export type { Block, BlockId, DeskOrder, DeskSort };

export const GRID_COLUMNS = 12;
/** The tallest a block or a layout may be, in rows: a bound for a file, not a limit anyone reaches. */
export const GRID_ROWS_MAX = 200;
/** The tallest one block may be, in rows. */
export const BLOCK_ROWS_MAX = 20;


export interface BlockSpec {
  id: BlockId;
  label: string;
  minW: number;
  minH: number;
  /** Cannot be hidden: the consoles are the room. */
  fixed: boolean;
}

/** The catalogue: a new block is one row here and one component. */
export const CATALOGUE: Readonly<Record<BlockId, BlockSpec>> = {
  mission: { id: 'mission', label: 'MISSION', minW: 2, minH: 2, fixed: false },
  sequence: { id: 'sequence', label: 'SEQUENCE', minW: 3, minH: 2, fixed: false },
  tminus: { id: 'tminus', label: 'T-MINUS', minW: 2, minH: 2, fixed: false },
  maxq: { id: 'maxq', label: 'MAX Q', minW: 2, minH: 2, fixed: false },
  propellant: { id: 'propellant', label: 'PROPELLANT', minW: 2, minH: 2, fixed: false },
  operations: { id: 'operations', label: 'OPERATIONS', minW: 6, minH: 3, fixed: true },
};

/** Today's page as a layout: the five blocks of the wall in a row, the consoles under them. */
export const DEFAULT_BLOCKS: readonly Block[] = [
  { id: 'mission', x: 0, y: 0, w: 3, h: 2 },
  { id: 'sequence', x: 3, y: 0, w: 3, h: 2 },
  { id: 'tminus', x: 6, y: 0, w: 2, h: 2 },
  { id: 'maxq', x: 8, y: 0, w: 2, h: 2 },
  { id: 'propellant', x: 10, y: 0, w: 2, h: 2 },
  { id: 'operations', x: 0, y: 2, w: 12, h: 6 },
];

export const copyBlocks = (blocks: readonly Block[]): Block[] => blocks.map((b) => ({ ...b }));
export const isHidden = (b: Block): boolean => b.hidden === true;
export const shown = (blocks: readonly Block[]): Block[] => blocks.filter((b) => !isHidden(b));

export function overlaps(a: Block, b: Block): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** Is the rectangle inside the grid and at least as big as the block's minimum? */
export function fits(b: Block): boolean {
  const spec = CATALOGUE[b.id];
  if (spec === undefined || ![b.x, b.y, b.w, b.h].every(whole)) return false;
  return b.x >= 0 && b.y >= 0 && b.w >= spec.minW && b.h >= spec.minH && b.h <= BLOCK_ROWS_MAX && b.x + b.w <= GRID_COLUMNS && b.y + b.h <= GRID_ROWS_MAX;
}

/** The rectangle brought into the grid and up to the minimum size: the nearest one that fits. */
export function clampBlock(b: Block): Block {
  const spec = CATALOGUE[b.id];
  const w = Math.min(GRID_COLUMNS, Math.max(spec.minW, Math.round(b.w)));
  const h = Math.min(BLOCK_ROWS_MAX, Math.max(spec.minH, Math.round(b.h)));
  const x = Math.min(GRID_COLUMNS - w, Math.max(0, Math.round(b.x)));
  const y = Math.min(GRID_ROWS_MAX - h, Math.max(0, Math.round(b.y)));
  return { ...b, x, y, w, h };
}

/** Blocks fall up until they rest on the top or on another block. `pinned` stays where it is and the others settle around it. */
export function compact(blocks: readonly Block[], pinned?: BlockId): Block[] {
  const out = copyBlocks(blocks);
  const settled: Block[] = [];
  const pin = out.find((b) => b.id === pinned && !isHidden(b));
  if (pin !== undefined) settled.push(pin);
  const rest = shown(out)
    .filter((b) => b !== pin)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const b of rest) {
    // first lift it as far as it goes, then push it down below whatever it still overlaps
    b.y = 0;
    let moved = true;
    while (moved) {
      moved = false;
      for (const other of settled) {
        if (overlaps(b, other)) {
          b.y = other.y + other.h;
          moved = true;
        }
      }
    }
    settled.push(b);
  }
  return out;
}

/** Moves or resizes one block. A block it lands on is pushed down, the rest settle upward: there is never one cell with two blocks. */
export function place(blocks: readonly Block[], id: BlockId, patch: Partial<Pick<Block, 'x' | 'y' | 'w' | 'h'>>): Block[] {
  const out = copyBlocks(blocks);
  const index = out.findIndex((b) => b.id === id);
  if (index < 0) return out;
  const placed = clampBlock({ ...(out[index] as Block), ...patch });
  // placing a block shows it
  delete placed.hidden;
  out[index] = placed;
  return compact(out, id);
}

/** Hides a block (never a fixed one) and lets the others settle into the gap. Its own rectangle is kept for RESTORE. */
export function hide(blocks: readonly Block[], id: BlockId): Block[] {
  if (CATALOGUE[id].fixed) return copyBlocks(blocks);
  const out = copyBlocks(blocks);
  const b = out.find((x) => x.id === id);
  if (b !== undefined) b.hidden = true;
  return compact(out);
}

/** Shows a hidden block again, where it was (pushing what is there down). */
export function restore(blocks: readonly Block[], id: BlockId): Block[] {
  const out = copyBlocks(blocks);
  const b = out.find((x) => x.id === id);
  if (b === undefined) return out;
  delete b.hidden;
  return place(out, id, { x: b.x, y: b.y, w: b.w, h: b.h });
}

/** The blocks in reading order (rows, then columns): what a phone shows, one under the other. Hidden ones are left out. */
export const phoneOrder = (blocks: readonly Block[]): Block[] => shown(blocks).sort((a, b) => a.y - b.y || a.x - b.x);

/** What the live region says of a block: `MAX Q, column 4, row 2, 4 wide, 2 high`. */
export const describe = (b: Block): string => `${CATALOGUE[b.id].label}, column ${b.x + 1}, row ${b.y + 1}, ${b.w} wide, ${b.h} high`;

/* ---- the order of the desks ---- */

export const DEFAULT_DESKS: Readonly<DeskOrder> = { sort: 'positions', order: [] };
export const DESK_ORDER_MAX = 64;
const CELL_KEY = /^(p|a):[a-z0-9][a-z0-9-]{0,31}$/;

/** The key of a cell in the order. */
export const cellKeyOf = (kind: 'position' | 'agent', id: string): string => `${kind === 'position' ? 'p' : 'a'}:${id}`;

/** Two keys swap places in a list; a key that is not there is added at the end first. */
export function swapKeys(order: readonly string[], all: readonly string[], a: string, b: string): string[] {
  const full = [...order.filter((k) => all.includes(k)), ...all.filter((k) => !order.includes(k))];
  const i = full.indexOf(a);
  const j = full.indexOf(b);
  if (i < 0 || j < 0 || i === j) return full;
  [full[i], full[j]] = [full[j] as string, full[i] as string];
  return full;
}

/* ---- the file ---- */

export interface RoomLayout {
  version: 1;
  /** A counter: a save made from an older one is a conflict. */
  rev: number;
  blocks: Block[];
  desks: DeskOrder;
}

export type LayoutCheck = { ok: true; blocks: Block[]; desks: DeskOrder } | { ok: false; error: string; field: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A layout from the wire or a file, checked: every block of the catalogue once, in the grid, big enough, not overlapping, the consoles shown. */
export function checkLayout(input: unknown): LayoutCheck {
  if (!isObject(input)) return { ok: false, error: 'the layout must be an object', field: 'blocks' };
  if (!Array.isArray(input.blocks)) return { ok: false, error: 'blocks must be a list', field: 'blocks' };
  const blocks: Block[] = [];
  for (const raw of input.blocks) {
    if (!isObject(raw) || typeof raw.id !== 'string') return { ok: false, error: 'a block must be an object with an id', field: 'blocks' };
    // a block this version does not know (a downgrade, a newer file) is dropped, not an error: the rest of the layout stays
    if (!(BLOCK_IDS as readonly string[]).includes(raw.id)) continue;
    for (const key of Object.keys(raw)) if (!['id', 'x', 'y', 'w', 'h', 'hidden'].includes(key)) return { ok: false, error: `a block has no field "${key}"`, field: 'blocks' };
    if (raw.hidden !== undefined && typeof raw.hidden !== 'boolean') return { ok: false, error: 'hidden must be true or false', field: 'blocks' };
    const block: Block = { id: raw.id as BlockId, x: raw.x as number, y: raw.y as number, w: raw.w as number, h: raw.h as number, ...(raw.hidden === true ? { hidden: true } : {}) };
    if (!fits(block)) return { ok: false, error: `${block.id} does not fit the grid: ${GRID_COLUMNS} columns, at least ${CATALOGUE[block.id].minW} by ${CATALOGUE[block.id].minH}`, field: 'blocks' };
    blocks.push(block);
  }
  for (const id of BLOCK_IDS) {
    const count = blocks.filter((b) => b.id === id).length;
    if (count > 1) return { ok: false, error: `${id} must be in the layout once`, field: 'blocks' };
    // a block this file lacks (a new one) comes in hidden, in its default rectangle: it waits in the tray and nothing else moves.
    // The consoles cannot be hidden: they go under everything.
    if (count === 0) {
      const spec = DEFAULT_BLOCKS.find((b) => b.id === id) as Block;
      blocks.push(CATALOGUE[id].fixed ? { ...spec, y: blocks.reduce((n, b) => (isHidden(b) ? n : Math.max(n, b.y + b.h)), 0) } : { ...spec, hidden: true });
    }
  }
  if (blocks.some((b) => CATALOGUE[b.id].fixed && isHidden(b))) return { ok: false, error: 'operations cannot be hidden', field: 'blocks' };
  const vis = shown(blocks);
  for (let i = 0; i < vis.length; i += 1) for (let j = i + 1; j < vis.length; j += 1) if (overlaps(vis[i] as Block, vis[j] as Block)) return { ok: false, error: `${(vis[i] as Block).id} and ${(vis[j] as Block).id} overlap`, field: 'blocks' };
  const desks = input.desks ?? DEFAULT_DESKS;
  if (!isObject(desks) || !(DESK_SORTS as readonly unknown[]).includes(desks.sort) || !Array.isArray(desks.order)) return { ok: false, error: `desks must be { sort: one of ${DESK_SORTS.join(', ')}, order: a list }`, field: 'desks' };
  const order = desks.order;
  if (order.length > DESK_ORDER_MAX || !order.every((k) => typeof k === 'string' && CELL_KEY.test(k)) || new Set(order).size !== order.length) return { ok: false, error: 'desks.order must be a list of at most 64 different cell keys (p:<position>, a:<name>)', field: 'desks' };
  return { ok: true, blocks, desks: { sort: desks.sort as DeskSort, order: order as string[] } };
}
