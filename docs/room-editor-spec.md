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
| Block of a feature that is **off** | Not drawn, not in the tray's restore list as an action: the tray shows it greyed with "off in Features" and a link to the block. Its place in the layout is **kept**, so turning the feature on again puts it back where it was. The grid compacts around the gap for display only, without changing the saved layout. |
| Feature turned off while a draft is open | The block leaves the draft's page at once; SAVE keeps its entry. |
| Feature turned on that has a block hidden by the Director | Shown in the tray, not placed (the Director removed it on purpose). |
| Operations | Cannot be hidden; the Needs strip and the floods are not blocks and stay where they are. |

## Options

1. **Blocks on a grid, desks as an order (pick).** Blocks are few and big, so a 12-column grid with compaction is simple and predictable; tiles must reflow with the width and on a phone, which a free x/y cannot do.
2. A free canvas: every tile and block with its own x/y. Looks like an office floor, and breaks at every width, on a phone, and with 24 agents; the editor would have to store a layout for each size. Rejected.

## Scope of one PR (CONTROL)

`room.json` store and `GET/PUT/DELETE /api/room`, `room` frame and snapshot field, the audit line (`config`, no layout text); `layout.ts` (pure, tested) and `seat(agents, order?)`; the Room view reads the layout (default layout reproduces today's DOM and CSS classes, so existing tests pass); the editor (pointer, keyboard, tray, bar, strip for live hidden blocks);
the Patch Panel commands (EDIT ROOM, RESET, SHOW <block>); `useFeature` hookup for blocks; `docs/features/room-editor.md`. About 700 lines with tests. **Left out:** custom blocks and notes, a separate phone layout, per-browser layouts, themes per block, tile colours, undo history beyond CANCEL, a free canvas.

## Order of changes

1. `layout.ts` and `seat(order)` with tests. 2. Store, routes, frame, default layout, the view reading it (no editor yet: the page is unchanged). 3. The editor and the keyboard path. 4. The strip, the Patch Panel lines, the feature hookup (after `features-spec`). 5. Docs.

## Tests

`place`/`compact`/`fits` (overlap, push down, minimum size, out of the grid, a hidden block does not take room); a default layout renders today's DOM; a saved layout renders by its grid; `seat` with an order (removed agent, new agent, position change, SPARE last); `sort` values; `rev` 409 on a stale save; a damaged file falls back to the default; a block of an off feature is not drawn and keeps its place;
a hidden live block shows the strip and the poll still works; keyboard move and resize give the right cells and the live-region text; a drag does not reorder under `sort: state` until dropped; phone order; reset removes the file; a Black Box line names no layout.
