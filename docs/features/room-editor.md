# Room editor: where the blocks sit

The Room view is six blocks: the wall's five (MISSION clock, SEQUENCE, T-MINUS, MAX Q, PROPELLANT) and OPERATIONS, the matrix of consoles. EDIT ROOM moves and resizes them on a 12-column grid, hides the ones you do not use, and chooses the order of the consoles. Without a saved layout the page is exactly as it always was. Design and limits: [`docs/room-editor-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/room-editor-spec.md).

Open it with **Edit room** (a quiet key in the header of OPERATIONS) or from the [Patch Panel](./patch-panel.md) (EDIT ROOM). It needs a pointer and a screen of 900 pixels or more; on a phone it says so. Nothing changes until you press SAVE.

## Blocks

Each block is a card on the grid. Drag it by its title to move it, drag the corner to resize it. From the keyboard, focus a card and press **M** to move or **R** to resize with the arrows, **Enter** to drop it, **Escape** to put it back; the page says where it is (`MAX Q, column 4, row 2, 4 wide, 2 high`). A block that lands on another pushes it down, and the rest settle upward, so two blocks never share a cell. Each has a smallest size. **Hide** (or **H**) takes a block off the page; it waits in the tray with RESTORE and keeps its place. **OPERATIONS cannot be hidden**: the consoles are the room.

While you edit, the live blocks are drawn as plain cards, because their height is the height of what they show.

## Consoles

Inside the OPERATIONS card the consoles are chips in the order they appear. Drag a chip onto another, or focus one, press **M** and use the left and right arrows, to swap two: the order is then yours. The select chooses an automatic order instead: Positions (the default), Needs you first (it reflows as the consoles change), or Name. SPARE stays last. The roster is not touched: `desk` is the same.

## Save, cancel, reset

SAVE keeps the layout for every browser. If another window saved first, the save is refused and says so: cancel, and edit again from the newest. CANCEL drops the draft. RESET TO DEFAULT asks once and then goes back to today's page, all of it or only the order of the consoles.

## Hidden but live

A hidden block that has something going on says so in a strip above the room, with SHOW: `T-MINUS: poll open, 2 of 4 answered.` (the poll still counts and still ends), `MAX Q: 3 messages wait for a free slot.` A console that needs you is in the Needs strip, which is not a block. The Patch Panel has SHOW (a block) for each hidden one.

## On a phone

A phone shows the same layout, read-only: the wall's blocks one under the other in the order of their rows, hidden ones left out, the tiles in your order.

## API

Browser token. `GET /api/room` → `{ rev, layout: { blocks, desks } | null }`. `PUT /api/room` with `{ rev, blocks, desks? }`: `rev` is the revision the draft was made from (409 if it is not the current one; 400 with the field for a bad layout: a block outside the grid or smaller than its minimum, two shown blocks that overlap, OPERATIONS hidden). `DELETE /api/room` resets; `?part=desks` only the order. A `room` frame carries the view. The file is `<home>/room.json` (mode 0600); a damaged one is kept as `room.json.bad` and the default layout is used.
