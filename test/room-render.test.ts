/** Room editor: the page drawn to a string, as a smoke test of what a browser would build: no browser here, so no pointer, no focus, no layout. */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKS, DEFAULT_DESKS, hide, place } from '../src/shared/layout.js';
import type { AgentView } from '../src/shared/protocol.js';
import { RoomDesktop } from '../src/client/RoomLayout.js';
import { applyServerFrame, emptyState, NO_PROPELLANT, store } from '../src/client/store.js';
import type { ClientState } from '../src/client/store.js';
import { defaultView } from '../src/shared/livery.js';

const agent = (name: string, desk: number, patch: Partial<AgentView> = {}): AgentView =>
  ({ name, desk, boss: desk === 0, role: 'r', dir: '/w', mode: 'default', state: 'idle', stateSince: 1, needsKind: null, needsReason: null, needSeq: null, transition: null, draft: false, held: null, queued: 0, dirty: false, generation: 1, exit: null, position: null, provider: 'claude', command: null, payload: null, cleanRoom: null, worktree: null, model: null, keys: {}, doing: null, history: [], ...patch }) as AgentView;

function load(patch: Partial<ClientState>): void {
  const state = applyServerFrame(emptyState(), { t: 'state', state: { agents: [agent('flight', 0, { position: 'flight' }), agent('ana', 1)], activity: [], info: { cwd: '/', home: '/h' } as never, poll: null, governor: { limit: null, working: 0, holding: 0 }, propellant: NO_PROPELLANT, schedules: [], uplinks: [], tasks: [], downlink: { unread: 0, items: [] }, livery: defaultView() } } as never, 1);
  store.setState({ ...state, ...patch });
}
const html = (): string => renderToString(createElement(RoomDesktop));

afterEach(() => store.setState(emptyState()));

describe('the room drawn to a string', () => {
  it('is the page as it was with no layout: the wall, then the consoles, and a quiet key to edit', () => {
    load({});
    const out = html();
    expect(out).toContain('aria-label="The wall"');
    expect(out).toContain('aria-label="Operations"');
    expect(out).not.toContain('room-grid');
    expect(out).toContain('Edit room');
  });

  it('puts each block of a saved layout on the grid where it was put, and leaves out a hidden one', () => {
    const blocks = hide(place(DEFAULT_BLOCKS.map((b) => ({ ...b })), 'maxq', { x: 0, y: 0 }), 'propellant');
    load({ room: { rev: 1, layout: { blocks, desks: DEFAULT_DESKS } } });
    const out = html();
    expect(out).toContain('class="room-grid"');
    expect(out).toContain('data-block="maxq"');
    expect(out).toMatch(/data-block="maxq" style="[^"]*grid-column:1 \/ span 2/);
    expect(out).toContain('data-block="operations"');
    expect(out).not.toContain('data-block="propellant"');
    expect(out).not.toContain('aria-label="The wall"');
  });

  it('shows a strip with SHOW for a hidden T-minus that has a poll open', () => {
    const blocks = hide(DEFAULT_BLOCKS.map((b) => ({ ...b })), 'tminus');
    load({ room: { rev: 1, layout: { blocks, desks: DEFAULT_DESKS } }, poll: { id: 1, status: 'open', startedAt: 1, note: '', entries: [{ agent: 'ana', vote: 'go', reason: '', at: 1 }, { agent: 'ben', vote: null, reason: '', at: null }] } });
    const out = html();
    expect(out).toContain('T-MINUS: poll open, 1 of 2 answered.');
    expect(out).toContain('SHOW');
  });

  it('draws the editor: the bar, a card for each block with a grip, the tray, the chips of the consoles in order', () => {
    const blocks = hide(DEFAULT_BLOCKS.map((b) => ({ ...b })), 'mission');
    load({ editingRoom: true, room: { rev: 2, layout: { blocks, desks: { sort: 'manual', order: ['a:ana', 'p:flight'] } } } });
    const out = html();
    for (const word of ['EDIT ROOM', 'SAVE', 'CANCEL', 'RESET TO DEFAULT', 'RESTORE MISSION', 'Hidden blocks']) expect(out.replace(/<!-- -->/g, '')).toContain(word);
    expect(out).toContain('aria-label="SEQUENCE, column 4, row 1, 3 wide, 2 high"');
    expect(out).toContain('aria-label="OPERATIONS, column 1, row 3, 12 wide, 6 high"');
    expect(out.match(/class="re-grip"/g)).toHaveLength(5);
    // operations cannot be hidden: it has no Hide key, the others have
    expect(out).not.toContain('aria-label="Hide OPERATIONS"');
    expect(out).toContain('aria-label="Hide MAX Q"');
    // the chips follow the manual order: ana before flight
    expect(out.indexOf('aria-label="ANA"')).toBeGreaterThan(-1);
    expect(out.indexOf('aria-label="ANA"')).toBeLessThan(out.indexOf('aria-label="FLIGHT"'));
    expect(out).toContain('value="manual"');
  });

  it('opens the editor from today\'s page with the default blocks', () => {
    load({ editingRoom: true });
    const out = html();
    expect(out.match(/class="re-block module"/g)).toHaveLength(6);
    expect(out).not.toContain('RESTORE');
  });

  it('leaves out the block of a feature that is off, settles the others around the gap, and keeps its entry in the saved layout', () => {
    load({ features: ['maxq'], room: { rev: 1, layout: { blocks: DEFAULT_BLOCKS.map((b) => ({ ...b })), desks: DEFAULT_DESKS } } });
    const out = html();
    expect(out).not.toContain('data-block="maxq"');
    // PROPELLANT was at column 11: with MAX Q gone it settles up and stays where it was in the row, the saved file is untouched
    expect(out).toContain('data-block="propellant"');
    expect(store.getState().room.layout?.blocks.find((b) => b.id === 'maxq')).toMatchObject({ x: 8, y: 0, w: 2, h: 2 });
  });

  it('draws the editor without the block of an off feature, and the tray says so with no RESTORE for it', () => {
    const blocks = hide(DEFAULT_BLOCKS.map((b) => ({ ...b })), 'maxq');
    load({ features: ['maxq'], editingRoom: true, room: { rev: 2, layout: { blocks, desks: DEFAULT_DESKS } } });
    const out = html().replace(/<!-- -->/g, '');
    expect(out).toContain('MAX Q: off in Features');
    expect(out).not.toContain('RESTORE MAX Q');
    expect(out).not.toContain('Hide MAX Q');
  });

  it('draws the editor of a layout whose T-minus is on and shown, and leaves T-minus out when that feature goes off', () => {
    const blocks = DEFAULT_BLOCKS.map((b) => ({ ...b }));
    load({ editingRoom: true, room: { rev: 2, layout: { blocks, desks: DEFAULT_DESKS } } });
    expect(html()).toContain('T-MINUS, column');
    load({ features: ['tminus'], editingRoom: true, room: { rev: 2, layout: { blocks, desks: DEFAULT_DESKS } } });
    expect(html()).not.toContain('T-MINUS, column');
  });
});
