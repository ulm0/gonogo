# Spec: Room editor (draft)

Design by FIDO, 2026-11-18, task t41b. Status: draft, not built. Read from `WallView.tsx` (`Wall`), `RoomView.tsx` (`Operations`, the matrix), `room.ts` (`seat`) and `shell.ts` (`commands`). It works with `docs/features-spec.md`.

## What the room is today

The Room view is **six blocks**: the wall's five (A MISSION clock, B SEQUENCE, the T-MINUS poll, MAX Q, PROPELLANT) and E OPERATIONS, the matrix of consoles. The matrix is a fixed grid: cells 1 to 15 are the positions in their order, an agent sits in its position's cell,
the rest follow in `desk` order, then one SPARE cell (`seat()` in `room.ts`). `AgentRecord.desk` only orders the agents who have no position cell. Nothing is movable and nothing can be hidden.

## Design

- **Two things are editable, kept apart:** the **blocks** (which, where, how big) and the **desk order** (which console sits in which cell). The first is a layout on a grid, the second a list. They share one file.
- **`<home>/room.json`** `{ version: 1, rev, blocks: [{ id, x, y, w, h, hidden? }], desks: { sort: 'positions' | 'state' | 'name' | 'manual', order: string[] } }`, mode 0600, atomic write, damaged file kept as `.bad` (the default layout then). `rev` is a counter; a save with a stale `rev` is a 409, so two browsers do not overwrite each other.
  Absent file or `null` is the **default layout** (today's page, exactly). Browsers get it in the snapshot and a `room` frame; saving is the Director's (browser token).
- **Blocks.** A 12-column grid, rows of a fixed height; `id` from a built-in catalogue (`mission`, `sequence`, `tminus`, `maxq`, `propellant`, `operations`), each with a minimum size and a default. v1 has **no custom items**: "add" restores a block that was removed, "remove" hides it. The catalogue is a table, so a new block (a Flight Plan summary, a Downlink strip)
  is one row plus its component. **OPERATIONS cannot be removed** (it is the consoles; a room with no consoles is not a room), only moved and resized.
- **Editing.** EDIT ROOM is a command in the Patch Panel and a quiet key in the Room view's header (no top-bar key). Edit mode draws a handle and a size grip on each block, a tray of hidden blocks (RESTORE), and a bar: SAVE, CANCEL, RESET TO DEFAULT. Changes are a **draft in the client** until SAVE. Moving and resizing by **pointer** (pointer events, no library) and by **keyboard**
  (focus a block, `M` moves with arrows, `R` resizes with arrows, Enter drops, Esc cancels), with the position said in a live region ("MAX Q, column 4, row 2, 4 wide"). A drop that overlaps pushes the blocks below it down (vertical compaction, a pure `layout.ts`: `place`, `compact`, `fits`), so there is never a state with two blocks on one cell.
- **Desks.** The matrix columns follow the width (CSS grid), so a desk has no x/y: it has a **place in the order**. `desks.order` is a list of cell keys (`p:<position id>` for a position's cell, `a:<name>` for an agent without one) and `seat()` takes it as an optional second argument. Manual: drag a tile onto another cell, or a keyboard move (`M`, arrows), and the two swap
  places; `sort` becomes `manual`. **AUTO-ARRANGE** sets `sort` to `positions` (the default), `state` (needs you first, then working, then idle, then stopped) or `name`, and clears the manual order. `state` is a live sort: the order follows the agents, so it reflows as they change; the page says so, and a tile never jumps under the pointer while a drag is on.
  A cell key whose agent was removed or whose position changed is dropped when the order is read; an agent not in the order goes to the end; SPARE stays last. Editing the matrix of an agent does not change its `desk`, so nothing in the roster moves.
- **Reset.** RESET TO DEFAULT asks once, then `DELETE /api/room`: the file is removed and everything is today's page. Reset of only the desks is a choice in the same dialog.
- **Phone.** The editor is for a pointer and a wide screen (900 px and over): on a phone EDIT ROOM says "edit the room on a wider screen". The phone **reads** the same file: blocks in the order of their rows (y, then x), full width, sizes ignored, hidden ones hidden; the tile order follows `desks`.
  The phone layout has no layout of its own in v1 (it is already one column).

## Features and the room

The rules for a block and its feature (`docs/features-spec.md`):

| Case | What the page does |
|---|---|
| Block hidden, feature **on** | The feature stays reachable from the Patch Panel ("Show T-minus") and from the tray. **Nothing live is hidden silently:** a hidden T-minus with an open poll or a Static fire, a hidden Max Q that is holding mail, and any console that needs the Director show a one-line strip at the top of the room (`T-MINUS: poll open, 2 of 4 answered. SHOW`). The poll still counts and still ends. |
| Block of a feature that is **off** | Not drawn, not in the tray's restore list as an action: the tray shows it greyed with "off in Features" and a link to the block. Its place in the layout is **kept**, so turning the feature on again puts it back where it was, unless the layout was saved while it was off: then it comes back in the tray. The grid compacts around the gap for display only, without changing the saved layout. |
| Feature turned off while a draft is open | The block leaves the draft's page at once; SAVE keeps its entry. |
| Feature turned on that has a block hidden by the Director | Shown in the tray, not placed (the Director removed it on purpose). |
| Operations | Cannot be hidden; the Needs strip and the floods are not blocks and stay where they are. |

## Options

1. **Blocks on a grid, desks as an order (pick).** Blocks are few and big, so a 12-column grid with compaction is simple and predictable; tiles must reflow with the width and on a phone, which a free x/y cannot do.
2. A free canvas: every tile and block with its own x/y. Looks like an office floor, and breaks at every width, on a phone, and with 24 agents; the editor would have to store a layout for each size. Rejected.

## Scope of one PR (CONTROL)

`room.json` store and `GET/PUT/DELETE /api/room`, `room` frame and snapshot field, the audit line (`config`, no layout text); `layout.ts` (pure, tested) and `seat(agents, order?)`; the Room view reads the layout (default layout reproduces today's DOM and CSS classes, so existing tests pass); the editor (pointer, keyboard, tray, bar, strip for live hidden blocks);
the Patch Panel commands (EDIT ROOM, RESET, SHOW (a block)); `useFeature` hookup for blocks; `docs/features/room-editor.md`. About 700 lines with tests. **Left out:** custom blocks and notes, a separate phone layout, per-browser layouts, themes per block, tile colours, undo history beyond CANCEL, a free canvas.

## Order of changes

1. `layout.ts` and `seat(order)` with tests. 2. Store, routes, frame, default layout, the view reading it (no editor yet: the page is unchanged). 3. The editor and the keyboard path. 4. The strip, the Patch Panel lines, the feature hookup (after `features-spec`). 5. Docs.

## Tests

`place`/`compact`/`fits` (overlap, push down, minimum size, out of the grid, a hidden block does not take room); a default layout renders today's DOM; a saved layout renders by its grid; `seat` with an order (removed agent, new agent, position change, SPARE last); `sort` values; `rev` 409 on a stale save; a damaged file falls back to the default; a block of an off feature is not drawn and keeps its place;
a hidden live block shows the strip and the poll still works; keyboard move and resize give the right cells and the live-region text; a drag does not reorder under `sort: state` until dropped; phone order; reset removes the file; a Black Box line names no layout.

## As built (2026-11-18)

Steps 1 to 3, the strip and the Patch Panel lines of step 4, and the docs are built. **Not built: the hookup to feature toggles** (the table "Features and the room"), which waits for `docs/features-spec.md` to be built; the rules for a hidden block with a live state are in, those for a block of a feature that is off are not.

- **Files.** `src/shared/layout.ts` (the catalogue, `place`, `compact`, `hide`, `restore`, `fits`, `checkLayout`; the types of the blocks and the desks are in `protocol.ts` with the rest of the wire), `src/server/roomlayout.ts` (the store), `src/client/roomedit.ts` (pure: keys, pointer, desks, strips), `RoomLayout.tsx` (the saved layout and the editor), `EditRoomKey.tsx`, `room.css`. The new shared file is in the pack allow-lists.
- **The default layout** is five blocks in a row (mission 3 wide, sequence 3, T-minus 2, Max Q 2, Propellant 2 on 12 columns, 2 rows high) and Operations under them (12 by 6). With no saved layout the page is **exactly** today's markup (a test checks that no grid is drawn and that the wall and Operations are where they were); the editor starts from the default in grid terms.
- **A saved layout** puts each shown block on a `grid-template-columns: repeat(12, 1fr)` grid, `grid-auto-rows: minmax(64px, auto)`: a block spans its rows and grows when its content is taller. Commissioning, Your console and the selected console's panel are not blocks and stay under the grid. A block is at most 20 rows high; the grid at most 200 rows.
- **Editing** shows the blocks as cards of a fixed row height (64 px), each with a handle (drag to move, a title and its size), a grip (drag to resize) and Hide; the live blocks are not drawn while editing, because their height is the height of their content and the pointer needs cells. Keyboard: focus a card, `M` moves and `R` resizes with the arrows, Enter drops, Escape puts it back, `H` or Delete hides it; the live region says `MAX Q, column 4, row 2, 4 wide, 2 high`. A hidden block is in the tray with RESTORE and keeps its rectangle. Operations has no Hide.
- **Desks** are edited inside the OPERATIONS card as chips in the order the consoles are shown, not on the live tiles (same reason): drag a chip onto another, or focus one and press `M`, then the left and right arrows, to swap; either makes the order the Director's own (`manual`). A select picks Positions, Needs you first, Name or My order; the first three clear the manual order and, for `state`, the page says it reflows. While a chip is dragged the order shown is frozen. `seat(agents, desks)` applies it: `state` and `name` put the agents before the open cells of positions; cells are numbered again from 1; SPARE stays last.
- **Save and reset.** SAVE sends the revision the draft was made from (`rev`), the server answers 409 for a stale one and 400 with the field for a bad layout. RESET TO DEFAULT asks once: everything (`DELETE /api/room`) or only the order of the desks (`DELETE /api/room?part=desks`). The Black Box says that the layout was saved or reset (`config`), never a number of it.
- **Strips.** A hidden T-minus with a poll or a Static fire, and a hidden Max Q that holds mail, say so above the grid with SHOW (it saves the layout with that block shown again); a console that needs the Director is the Needs strip and is not a block.
- **Patch Panel.** EDIT ROOM, RESET THE ROOM LAYOUT (only once a layout is saved) and SHOW (a block) for each hidden one. Under 900 px EDIT ROOM and the quiet key in the Operations header answer "Edit the room on a wider screen: 900 pixels or more."
- **Phone.** It reads the saved layout: the wall's blocks in the order of their rows (y, then x), full width, sizes ignored, hidden ones left out; the tile order follows the desks. Operations stays after the Needs strip as before.
- **Tests.** The pure model (`test/layout.test.ts`), the store and routes with the real server code (`test/roomlayout.test.ts`), the client's parts (`test/room-editor.test.ts`: seat orders, keys, pointer cells, strips, Patch Panel, store), and the page drawn to a string with react-dom/server (`test/room-render.test.ts`). **Not tested: a real browser.** Pointer capture, drag and drop of chips, focus, the live region, and how the grid looks were not seen.
- **Left out, as the spec says:** custom blocks, a separate phone layout, per-browser layouts, undo beyond CANCEL, a free canvas. Also not built: the desks edited on the live tiles, and the wall's `Sequence` chart following the order of the desks (it keeps the usual order).
