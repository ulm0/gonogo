/** Room editor, the client's parts: the order of the desks in `seat`, the keys and the pointer, the strips, the Patch Panel and the store. */
import { describe, expect, it } from 'vitest';
import { defaultView } from '../src/shared/livery.js';
import { DEFAULT_BLOCKS, DEFAULT_DESKS, hide, place } from '../src/shared/layout.js';
import type { Block } from '../src/shared/layout.js';
import { POSITIONS } from '../src/shared/positions.js';
import type { AgentView, GovernorView, PollView, RoomView, StateSnapshot } from '../src/shared/protocol.js';
import { cellKey, seat } from '../src/client/room.js';
import { autoArrange, cellAt, dragMove, dragResize, EDIT_GAP_PX, EDIT_ROW_PX, hiddenBlocks, keyStep, liveStrips, neighbour, pitchOf, swapDesks } from '../src/client/roomedit.js';
import { commands } from '../src/client/shell.js';
import { applyServerFrame, emptyState, NO_ROOM, setEditingRoom, store } from '../src/client/store.js';

const agent = (name: string, desk: number, patch: Partial<AgentView> = {}): AgentView =>
  ({ name, desk, boss: false, state: 'idle', position: null, provider: 'claude', ...patch }) as AgentView;
const names = (cells: ReturnType<typeof seat>): string[] => cells.map((c) => (c.type === 'agent' ? c.agent.name : c.type === 'open' ? `open:${c.position.id}` : 'spare'));

const roster = [
  agent('flight', 0, { position: 'flight', state: 'working' }),
  agent('zed', 1, { state: 'stopped' }),
  agent('ana', 2, { state: 'needs_you' }),
  agent('cat', 3, { state: 'idle' }),
  agent('dan', 4, { state: 'starting' }),
];
const rect = (b: Block | undefined): [number, number, number, number] => [b?.x ?? -1, b?.y ?? -1, b?.w ?? -1, b?.h ?? -1];

describe('seat with an order', () => {
  it('is the page as it was without one, and with the sort `positions`', () => {
    const base = names(seat(roster));
    expect(names(seat(roster, DEFAULT_DESKS))).toEqual(base);
    expect(base[0]).toBe('flight');
    expect(base.at(-1)).toBe('spare');
    expect(seat(roster).map((c) => c.n)).toEqual(seat(roster, DEFAULT_DESKS).map((c) => c.n));
  });

  it('puts what needs the Director first, then what works, starts, idles and stops, and the open cells of positions after the agents', () => {
    const cells = seat(roster, { sort: 'state', order: [] });
    expect(names(cells).slice(0, 5)).toEqual(['ana', 'flight', 'dan', 'cat', 'zed']);
    expect(names(cells)[5]).toMatch(/^open:/);
    expect(cells.at(-1)?.type).toBe('spare');
    expect(cells.map((c) => c.n)).toEqual(cells.map((_, i) => i + 1));
  });

  it('sorts by name, ties and the open cells in their usual order', () => {
    expect(names(seat(roster, { sort: 'name', order: [] })).slice(0, 5)).toEqual(['ana', 'cat', 'dan', 'flight', 'zed']);
  });

  it('follows a manual order, drops a key that has no cell, and puts a cell with no key at the end in the usual order, SPARE last', () => {
    const cells = seat(roster, { sort: 'manual', order: ['a:cat', 'gone', 'p:flight', 'a:ana', 'p:fao'] });
    expect(names(cells).slice(0, 4)).toEqual(['cat', 'flight', 'ana', 'open:fao']);
    expect(names(cells).slice(4)).not.toContain('cat');
    expect(cells.at(-1)?.type).toBe('spare');
    expect(cells.filter((c) => c.type === 'agent')).toHaveLength(5);
    // a new agent that is not in the order goes after the ones that are
    const more = seat([...roster, agent('eve', 5)], { sort: 'manual', order: ['a:cat'] });
    expect(names(more)[0]).toBe('cat');
    expect(names(more)).toContain('eve');
  });

  it('keeps an agent whose position changed: its old key is dropped and it takes the end of the order', () => {
    const moved = [agent('flight', 0, { position: 'fao' })];
    const cells = seat(moved, { sort: 'manual', order: ['p:flight', 'a:flight'] });
    expect(names(cells).filter((n) => n === 'flight')).toHaveLength(1);
  });

  it('gives each cell a key: the position for a position\'s cell, the name for an agent without one', () => {
    const cells = seat([agent('flight', 0, { position: 'flight' }), agent('solo', 1)]);
    expect(cells.filter((c) => c.type !== 'spare').map(cellKey).slice(0, 1)).toEqual([`p:${POSITIONS[0]?.id}`]);
    expect(cellKey(cells.find((c) => c.type === 'agent' && c.agent.name === 'solo')!)).toBe('a:solo');
    expect(cellKey(cells.at(-1)!)).toBe('spare');
  });
});

describe('the keys of the editor', () => {
  const blocks = (): Block[] => DEFAULT_BLOCKS.map((b) => ({ ...b }));
  it('moves a block a cell with an arrow, and resizes it a cell with an arrow', () => {
    const moved = keyStep(blocks(), 'maxq', 'move', 'ArrowDown');
    expect(rect(moved?.find((b) => b.id === 'maxq'))).toEqual([8, 1, 2, 2]);
    const left = keyStep(blocks(), 'propellant', 'move', 'ArrowLeft');
    expect(left?.find((b) => b.id === 'propellant')?.x).toBe(9);
    const wide = keyStep(blocks(), 'mission', 'resize', 'ArrowRight');
    expect(wide?.find((b) => b.id === 'mission')?.w).toBe(4);
    const small = keyStep(blocks(), 'mission', 'resize', 'ArrowLeft');
    expect(rect(small?.find((b) => b.id === 'mission'))).toEqual([0, 0, 2, 2]);
    // at the minimum a smaller one is not made
    expect(keyStep(small ?? [], 'mission', 'resize', 'ArrowLeft')?.find((b) => b.id === 'mission')?.w).toBe(2);
    expect(keyStep(blocks(), 'maxq', 'move', 'x')).toBeNull();
    expect(keyStep(blocks(), 'nope' as never, 'move', 'ArrowUp')).toBeNull();
  });

  it('never leaves the grid or lets two blocks share a cell, whatever the arrows do', () => {
    let list: Block[] = blocks();
    for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowDown', 'ArrowDown', 'ArrowRight']) list = keyStep(list, 'tminus', 'move', key) ?? list;
    const v = list.filter((b) => b.hidden !== true);
    expect(v.every((b) => b.x >= 0 && b.x + b.w <= 12)).toBe(true);
    expect(v.every((a, i) => v.every((b, j) => i >= j || a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h))).toBe(true);
  });
});

describe('the pointer', () => {
  const pitch = pitchOf(1212);
  it('has the pitch of the grid it is drawn at', () => {
    expect(pitch).toEqual({ col: (1212 + EDIT_GAP_PX) / 12, row: EDIT_ROW_PX + EDIT_GAP_PX });
  });

  it('finds the cell under a point, the nearest one outside the grid', () => {
    const origin = { left: 100, top: 50 };
    expect(cellAt({ x: 100, y: 50 }, origin, pitch)).toEqual({ col: 0, row: 0 });
    expect(cellAt({ x: 100 + pitch.col * 4 + 1, y: 50 + pitch.row * 2 + 1 }, origin, pitch)).toEqual({ col: 4, row: 2 });
    expect(cellAt({ x: 5000, y: -400 }, origin, pitch)).toEqual({ col: 11, row: 0 });
    expect(cellAt({ x: -5000, y: 90000 }, origin, pitch).col).toBe(0);
  });

  it('drags a block by the cell it was grabbed in, and resizes it with the corner under the pointer', () => {
    const start = DEFAULT_BLOCKS.map((b) => ({ ...b }));
    // grabbed one cell right of its left edge and moved to column 5
    expect(rect(dragMove(start, 'maxq', { col: 5, row: 0 }, { dx: 1, dy: 0 }).find((b) => b.id === 'maxq'))).toEqual([4, 0, 2, 2]);
    expect(rect(dragResize(start, 'sequence', { col: 7, row: 3 }).find((b) => b.id === 'sequence'))).toEqual([3, 0, 5, 4]);
    expect(rect(dragResize(start, 'sequence', { col: 3, row: 0 }).find((b) => b.id === 'sequence'))).toEqual([3, 0, 3, 2]);
  });
});

describe('the desks', () => {
  it('swaps two cells and makes the order the Director\'s own, from what he sees', () => {
    expect(swapDesks(['p:flight', 'a:ana', 'a:ben'], 'p:flight', 'a:ben')).toEqual({ sort: 'manual', order: ['a:ben', 'a:ana', 'p:flight'] });
    expect(autoArrange('state')).toEqual({ sort: 'state', order: [] });
    expect(neighbour(['a', 'b', 'c'], 'b', -1)).toBe('a');
    expect(neighbour(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(neighbour(['a'], 'zz', 1)).toBeNull();
  });

  it('lists the hidden blocks for the tray, in the order of the catalogue', () => {
    const list = hide(hide(DEFAULT_BLOCKS.map((b) => ({ ...b })), 'propellant'), 'mission');
    expect(hiddenBlocks(list).map((b) => b.id)).toEqual(['mission', 'propellant']);
    expect(hiddenBlocks(DEFAULT_BLOCKS.map((b) => ({ ...b })))).toEqual([]);
  });
});

describe('the strips for a hidden block with something live', () => {
  const poll = { id: 1, status: 'open', entries: [{ agent: 'a', vote: 'go' }, { agent: 'b', vote: null }, { agent: 'c', vote: 'no-go' }, { agent: 'd', vote: null }], note: '' } as unknown as PollView;
  const quiet: GovernorView = { limit: null, working: 0, holding: 0 };
  const hiddenAll = DEFAULT_BLOCKS.map((b) => (b.id === 'tminus' || b.id === 'maxq' ? { ...b, hidden: true } : { ...b }));

  it('says that a poll is open and how many answered, and that mail waits for a slot', () => {
    expect(liveStrips(hiddenAll, poll, { limit: 2, working: 2, holding: 3 })).toEqual([
      { block: 'tminus', text: 'T-MINUS: poll open, 2 of 4 answered.' },
      { block: 'maxq', text: 'MAX Q: 3 messages wait for a free slot.' },
    ]);
    expect(liveStrips(hiddenAll, null, { ...quiet, holding: 1 })[0]?.text).toBe('MAX Q: 1 message waits for a free slot.');
    expect(liveStrips(hiddenAll, { ...poll, subject: 'the login form' } as PollView, quiet)[0]?.text).toBe('T-MINUS: static fire open, 2 of 4 answered.');
    expect(liveStrips(hiddenAll, { ...poll, status: 'hold' } as PollView, quiet)[0]?.text).toContain('hold');
  });

  it('says nothing when the block is shown, or when nothing is going on', () => {
    expect(liveStrips(DEFAULT_BLOCKS.map((b) => ({ ...b })), poll, { limit: 1, working: 1, holding: 4 })).toEqual([]);
    expect(liveStrips(hiddenAll, null, quiet)).toEqual([]);
  });
});

describe('the Patch Panel', () => {
  const input = { agents: [], legends: {}, poll: null, unread: 0, livery: defaultView() };
  const ids = (room?: RoomView): string[] => commands({ ...input, ...(room === undefined ? {} : { room }) }).map((c) => c.id);

  it('always has EDIT ROOM, and RESET and SHOW only once a layout is saved', () => {
    expect(ids()).toContain('edit-room');
    expect(ids(NO_ROOM)).not.toContain('reset-room');
    const saved: RoomView = { rev: 2, layout: { blocks: hide(DEFAULT_BLOCKS.map((b) => ({ ...b })), 'maxq'), desks: DEFAULT_DESKS } };
    expect(ids(saved)).toEqual(expect.arrayContaining(['edit-room', 'reset-room', 'show-block:maxq']));
    expect(ids(saved).filter((i) => i.startsWith('show-block'))).toEqual(['show-block:maxq']);
    expect(commands({ ...input, room: saved }).find((c) => c.id === 'show-block:maxq')).toMatchObject({ label: 'Show max q', act: { kind: 'show-block', block: 'maxq' } });
  });
});

describe('the store', () => {
  const snapshot = (room?: RoomView): StateSnapshot =>
    ({ info: { cwd: '/' }, agents: [], activity: [], poll: null, governor: { limit: null, working: 0, holding: 0 }, tasks: [], ...(room === undefined ? {} : { room }), downlink: { unread: 0, items: [] }, livery: defaultView() }) as unknown as StateSnapshot;

  it('takes the layout from the state and every room frame, and none from an older server', () => {
    const saved: RoomView = { rev: 3, layout: { blocks: place(DEFAULT_BLOCKS.map((b) => ({ ...b })), 'maxq', { x: 0 }), desks: DEFAULT_DESKS } };
    const loaded = applyServerFrame(emptyState(), { t: 'state', state: snapshot(saved) }, 1);
    expect(loaded.room).toEqual(saved);
    expect(applyServerFrame(loaded, { t: 'room', room: NO_ROOM }, 2).room).toEqual(NO_ROOM);
    expect(applyServerFrame(emptyState(), { t: 'state', state: snapshot() }, 1).room).toEqual(NO_ROOM);
  });

  it('starts and ends editing, and the editor opens on the Room view', () => {
    store.setState((s) => ({ ...s, view: 'loop', editingRoom: false }));
    setEditingRoom(true);
    expect(store.getState()).toMatchObject({ editingRoom: true, view: 'room' });
    setEditingRoom(false);
    expect(store.getState().editingRoom).toBe(false);
  });
});
