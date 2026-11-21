/**
 * Room editor (docs/room-editor-spec.md): the Room view as a layout. With none saved the page is as it always was. With one, the
 * blocks sit on a 12-column grid where the Director put them, and a hidden block that has something live says so in a strip. EDIT
 * ROOM turns the blocks into cards that move and resize by pointer or keyboard and the consoles into chips that swap places; the
 * changes are a draft until SAVE, and a save names the revision it was made from.
 */
import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { blockIsOff, CATALOGUE, DEFAULT_BLOCKS, displayBlocks, GRID_COLUMNS, copyBlocks, describe, hide, mergeEdit, restore, shown } from '../shared/layout.js';
import type { Block, BlockId, DeskOrder, DeskSort } from '../shared/layout.js';
import * as api from './api.js';
import { cellKey, seat } from './room.js';
import { autoArrange, cellAt, dragMove, dragResize, EDIT_GAP_PX, EDIT_ROW_PX, hiddenBlocks, keyStep, liveStrips, neighbour, pitchOf, SORT_LABELS, swapDesks } from './roomedit.js';
import type { EditMode } from './roomedit.js';
import { Commissioning } from './Rules.js';
import { RoomScreen } from './RoomScreen.js';
import { Operations, SelectedConsole, YourConsole, useAgentList } from './RoomView.js';
import { setEditingRoom, store, useStore } from './store.js';
import { useRun } from './WallView.js';
import { Wall, WALL_BLOCKS } from './WallView.js';
import './room.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const place = (b: Block): { gridColumn: string; gridRow: string } => ({ gridColumn: `${b.x + 1} / span ${b.w}`, gridRow: `${b.y + 1} / span ${b.h}` });

/** The Room view of a wide screen: today's page, a saved layout, or the editor. */
export function RoomDesktop(): ReactElement {
  const layout = useStore((s) => s.room.layout);
  const editing = useStore((s) => s.editingRoom);
  if (editing) return <RoomEditor />;
  if (layout === null) {
    return <RoomScreen phone={false} />;
  }
  return <RoomGrid blocks={layout.blocks} />;
}

/** A saved layout: each block where it was put, and a strip for a hidden block that has something going on. */
function RoomGrid({ blocks }: { blocks: readonly Block[] }): ReactElement {
  const poll = useStore((s) => s.poll);
  const governor = useStore((s) => s.governor);
  const rev = useStore((s) => s.room.rev);
  const propellant = useStore((s) => s.propellant);
  const off = useStore((s) => s.features);
  const strips = liveStrips(blocks, poll, governor, propellant).filter((strip) => !blockIsOff({ id: strip.block, x: 0, y: 0, w: 1, h: 1 }, off));
  const { busy, error, run } = useRun();
  return (
    <>
      {strips.length > 0 && (
        <div className="room-strips">
          {strips.map((strip) => (
            <p key={strip.block} className="flood room-strip" data-tone="amber" role="status">
              {strip.text}{' '}
              <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => run(() => api.saveRoom({ rev, blocks: restore([...blocks], strip.block), desks: currentDesks() }))}>
                SHOW
              </button>
            </p>
          ))}
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <section className="room-grid" aria-label="The room">
        {shown(displayBlocks(blocks, off)).map((b) => (
          <div key={b.id} className="room-cell" data-block={b.id} style={place(b)}>
            {b.id === 'operations' ? <Operations phone={false} /> : (() => {
              const Block = WALL_BLOCKS[b.id as keyof typeof WALL_BLOCKS];
              return <Block />;
            })()}
          </div>
        ))}
      </section>
      <main className="room">
        <div className="room-main">
          <Commissioning />
          <YourConsole />
        </div>
        <SelectedConsole />
      </main>
    </>
  );
}

/** The order of the desks as it is saved now: showing a block again leaves it as it is. */
const currentDesks = (): DeskOrder => store.getState().room.layout?.desks ?? { sort: 'positions', order: [] };

/* ---- the editor ---- */

interface Draft {
  blocks: Block[];
  desks: DeskOrder;
}

function RoomEditor(): ReactElement {
  const id = useId();
  const room = useStore((s) => s.room);
  const agents = useAgentList();
  const base = useRef(room.rev);
  const [draft, setDraft] = useState<Draft>(() => ({ blocks: copyBlocks(room.layout?.blocks ?? DEFAULTS()), desks: room.layout?.desks ?? { sort: 'positions', order: [] } }));
  const [mode, setMode] = useState<{ id: BlockId; kind: EditMode; before: Block[] } | null>(null);
  const [live, setLive] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const grid = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: BlockId; kind: EditMode; dx: number; dy: number } | null>(null);

  const off = useStore((s) => s.features);
  // the blocks of a feature that is off are not in the draft's page (the others settle around the gap); their entries are kept as they are
  const work = displayBlocks(draft.blocks, off);
  const setBlocks = (blocks: Block[]): void => setDraft((d) => ({ ...d, blocks: mergeEdit(d.blocks, blocks, off) }));
  const say = (blocks: Block[], blockId: BlockId): void => setLive(describe(blocks.find((b) => b.id === blockId) as Block));

  const move = (blockId: BlockId, kind: EditMode, key: string): void => {
    const next = keyStep(work, blockId, kind, key);
    if (next === null) return;
    setBlocks(next);
    say(next, blockId);
  };

  const onKey = (b: Block, e: ReactKeyboardEvent): void => {
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    if (mode?.id === b.id) {
      if (e.key === 'Enter') {
        e.preventDefault();
        setMode(null);
        setLive(`Dropped. ${describe(b)}`);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setBlocks(mode.before);
        setMode(null);
        setLive('Cancelled.');
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        move(b.id, mode.kind, e.key);
      }
      return;
    }
    if (e.key === 'm' || e.key === 'r') {
      e.preventDefault();
      setMode({ id: b.id, kind: e.key === 'm' ? 'move' : 'resize', before: copyBlocks(work) });
      setLive(`${e.key === 'm' ? 'Moving' : 'Resizing'} ${CATALOGUE[b.id].label}: arrows, Enter to drop, Escape to cancel. ${describe(b)}`);
    } else if ((e.key === 'Delete' || e.key === 'h') && !CATALOGUE[b.id].fixed) {
      e.preventDefault();
      hideBlock(b.id);
    }
  };

  const hideBlock = (blockId: BlockId): void => {
    setBlocks(hide(work, blockId));
    setLive(`${CATALOGUE[blockId].label} hidden. It is in the tray.`);
  };
  const restoreBlock = (blockId: BlockId): void => {
    const next = restore(work, blockId);
    setBlocks(next);
    say(next, blockId);
  };

  /* pointer: the handle moves, the grip resizes; the pointer is turned into cells of the grid */
  const cellOf = (e: ReactPointerEvent): { col: number; row: number } => {
    const rect = (grid.current as HTMLDivElement).getBoundingClientRect();
    return cellAt({ x: e.clientX, y: e.clientY }, { left: rect.left, top: rect.top }, pitchOf(rect.width));
  };
  const startDrag = (e: ReactPointerEvent, b: Block, kind: EditMode): void => {
    if (e.button !== 0 || grid.current === null) return;
    const cell = cellOf(e);
    drag.current = { id: b.id, kind, dx: cell.col - b.x, dy: cell.row - b.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onDrag = (e: ReactPointerEvent): void => {
    const d = drag.current;
    if (d === null) return;
    const cell = cellOf(e);
    const next = d.kind === 'move' ? dragMove(work, d.id, cell, { dx: d.dx, dy: d.dy }) : dragResize(work, d.id, cell);
    if (JSON.stringify(next) !== JSON.stringify(work)) {
      setBlocks(next);
      say(next, d.id);
    }
  };
  const endDrag = (): void => {
    drag.current = null;
  };

  /* desks */
  const shownCells = useMemo(() => seat(agents, draft.desks).filter((c) => c.type !== 'spare'), [agents, draft.desks]);
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const keys = frozen ?? shownCells.map(cellKey);
  const byKey = new Map(shownCells.map((c) => [cellKey(c), c]));
  const label = (key: string): string => {
    const c = byKey.get(key);
    if (c === undefined) return key;
    return c.type === 'agent' ? (c.seated && c.position !== null ? c.position.callSign : c.agent.name.toUpperCase()) : c.type === 'open' ? `${c.position.callSign} (open)` : 'SPARE';
  };
  const [chipMode, setChipMode] = useState<string | null>(null);
  const dragKey = useRef<string | null>(null);
  const swap = (a: string, b: string): void => {
    setDraft((d) => ({ ...d, desks: swapDesks(keys, a, b) }));
    setLive(`${label(a)} and ${label(b)} swapped. The order is now yours.`);
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify({ blocks: room.layout?.blocks ?? DEFAULTS(), desks: room.layout?.desks ?? { sort: 'positions', order: [] } });

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveRoom({ rev: base.current, blocks: draft.blocks, desks: draft.desks });
      setEditingRoom(false);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  const reset = async (part: 'all' | 'desks'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.resetRoom(part, base.current);
      setEditingRoom(false);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
      setConfirming(false);
    }
  };

  const tray = hiddenBlocks(draft.blocks);
  return (
    <section className="room-edit" aria-label="Edit the room">
      <div className="re-bar module">
        <h2 className="label">EDIT ROOM</h2>
        <p className="hint">
          Drag a block by its title, or focus it and press M to move and R to resize (arrows, Enter drops, Escape cancels). H hides it. Nothing changes until you SAVE.
        </p>
        <div className="re-bar-keys">
          <button type="button" className="btn" data-kind="primary" aria-disabled={busy || !dirty || undefined} onClick={() => void save()}>
            SAVE
          </button>
          <button type="button" className="btn" onClick={() => setEditingRoom(false)}>
            CANCEL
          </button>
          <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
            RESET TO DEFAULT
          </button>
        </div>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {confirming && (
          <section className="flood remove" data-tone="nogo" role="alertdialog" aria-label="Reset the room">
            <h3 className="disp">RESET THE ROOM?</h3>
            <p>Today&apos;s page comes back. The consoles, the notes and the settings are not touched.</p>
            <div className="remove-buttons">
              <button type="button" className="btn" data-size="big" autoFocus onClick={() => setConfirming(false)}>
                KEEP EDITING
              </button>
              <button type="button" className="btn" data-size="big" aria-disabled={busy || undefined} onClick={() => void reset('desks')}>
                ONLY THE ORDER OF THE DESKS
              </button>
              <button type="button" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined} onClick={() => void reset('all')}>
                RESET EVERYTHING
              </button>
            </div>
          </section>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      {tray.length > 0 && (
        <div className="re-tray module" role="group" aria-label="Hidden blocks">
          <span className="label">HIDDEN</span>
          {tray.map((b) =>
            blockIsOff(b, off) ? (
              <span key={b.id} className="hint re-off">{`${CATALOGUE[b.id].label}: off in Features`}</span>
            ) : (
              <button key={b.id} type="button" className="btn" onClick={() => restoreBlock(b.id)}>
                {`RESTORE ${CATALOGUE[b.id].label}`}
              </button>
            ),
          )}
        </div>
      )}
      <div className="re-grid" ref={grid} style={{ gridAutoRows: `${EDIT_ROW_PX}px`, gap: `${EDIT_GAP_PX}px`, gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}>
        {shown(work).map((b) => (
          <div
            key={b.id}
            className="re-block module"
            style={place(b)}
            tabIndex={0}
            role="group"
            aria-label={`${describe(b)}${mode?.id === b.id ? `, ${mode.kind === 'move' ? 'moving' : 'resizing'}` : ''}`}
            data-moving={mode?.id === b.id || undefined}
            onKeyDown={(e) => onKey(b, e)}
          >
            <div className="re-handle" onPointerDown={(e) => startDrag(e, b, 'move')} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
              <span className="re-title">{CATALOGUE[b.id].label}</span>
              <span className="hint">{`${b.w} × ${b.h}`}</span>
              {!CATALOGUE[b.id].fixed && (
                <button type="button" className="btn re-hide" data-kind="quiet" aria-label={`Hide ${CATALOGUE[b.id].label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => hideBlock(b.id)}>
                  Hide
                </button>
              )}
            </div>
            {b.id === 'operations' ? (
              <div className="re-desks" onPointerDown={(e) => e.stopPropagation()}>
                <div className="re-desks-bar">
                  <label htmlFor={`${id}-sort`}>Order of the consoles</label>
                  <select
                    id={`${id}-sort`}
                    className="input"
                    value={draft.desks.sort}
                    onChange={(e) => {
                      const sort = e.target.value as DeskSort;
                      setDraft((d) => ({ ...d, desks: sort === 'manual' ? { sort, order: keys } : autoArrange(sort) }));
                    }}
                  >
                    {(Object.keys(SORT_LABELS) as DeskSort[]).map((s) => (
                      <option key={s} value={s}>
                        {SORT_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
                {draft.desks.sort === 'state' && <p className="hint">This order follows the consoles: it reflows as they change.</p>}
                <ol className="re-chips" aria-label="Consoles in the order they are shown">
                  {keys.map((key) => (
                    <li key={key}>
                      <button
                        type="button"
                        className="re-chip"
                        draggable
                        data-moving={chipMode === key || undefined}
                        aria-label={`${label(key)}${chipMode === key ? ', moving: left and right arrows, Enter drops' : ''}`}
                        onDragStart={() => {
                          dragKey.current = key;
                          setFrozen(keys);
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragKey.current !== null && dragKey.current !== key) swap(dragKey.current, key);
                        }}
                        onDragEnd={() => {
                          dragKey.current = null;
                          setFrozen(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'm') {
                            e.preventDefault();
                            setChipMode(chipMode === key ? null : key);
                            setLive(`Moving ${label(key)}: left and right arrows, Enter to drop.`);
                          } else if (chipMode === key && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                            e.preventDefault();
                            const other = neighbour(keys, key, e.key === 'ArrowLeft' ? -1 : 1);
                            if (other !== null) swap(key, other);
                          } else if (chipMode === key && (e.key === 'Enter' || e.key === 'Escape')) {
                            e.preventDefault();
                            setChipMode(null);
                          }
                        }}
                      >
                        {label(key)}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <p className="hint re-note">{`${CATALOGUE[b.id].label} sits here.`}</p>
            )}
            <div className="re-grip" aria-hidden="true" onPointerDown={(e) => startDrag(e, b, 'resize')} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
          </div>
        ))}
      </div>
    </section>
  );
}

const DEFAULTS = (): Block[] => copyBlocks(DEFAULT_BLOCKS);
