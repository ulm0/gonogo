# Room editor: where the blocks sit

<RoomEditorMock class="doc-mock" />

Rearrange the Room view: its six blocks (MISSION clock, SEQUENCE, T-MINUS, MAX Q, PROPELLANT, OPERATIONS) on a 12-column grid, hide unused ones, order the consoles. Without a saved layout the page is as it always was. Design and limits: [`docs/room-editor-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/room-editor-spec.md).

Open with **Edit room** (header of OPERATIONS) or the [Patch Panel](./patch-panel.md) (EDIT ROOM). Needs a pointer and a screen of 900 pixels or more. Nothing changes until SAVE.

## Blocks

- Drag by the title to move, by the corner to resize. Keyboard: focus a card, **M** to move or **R** to resize with arrows, **Enter** drops, **Escape** puts back (the page says `MAX Q, column 4, row 2, 4 wide, 2 high`).
- A block landing on another pushes it down; no two share a cell. Each has a smallest size.
- **Hide** (or **H**) moves a block to the tray with RESTORE, keeping its place. **OPERATIONS cannot be hidden.**
- While editing, live blocks are drawn as plain cards.

## Consoles

In the OPERATIONS card, consoles are chips. Drag one onto another, or focus, **M** and left/right arrows, to swap: the order is then yours. The select picks an automatic order: Positions (default), Needs you first (reflows), or Name. SPARE stays last. The roster is untouched.

## Save, cancel, reset

SAVE keeps the layout for every browser; if another window saved first it is refused (cancel, edit again). CANCEL drops the draft. RESET TO DEFAULT asks once, then restores all or only the console order.

## Hidden but live

A hidden block with activity shows a strip above the room with SHOW: `T-MINUS: poll open, 2 of 4 answered.` (still counts and ends), `MAX Q: 3 messages wait for a free slot.`, `PROPELLANT: near the budget (week).` (from 80 %). A console that needs you stays in the Needs strip. The Patch Panel has SHOW (a block) per hidden one.

A phone shows the layout read-only: blocks stacked by row order, hidden ones left out, tiles in your order.

## API

Browser token.

| Route | Does |
|---|---|
| `GET /api/room` | `{ rev, layout: { blocks, desks } \| null }` |
| `PUT /api/room` | `{ rev, blocks, desks? }`; `rev` is the revision the draft came from: 409 if not current; 400 with the field for a bad layout (block outside the grid or under its minimum, two shown blocks overlapping, OPERATIONS hidden) |
| `DELETE /api/room?rev=<n>` | reset (400 without `rev`, 409 if stale); `&part=desks` only the order |

A `room` frame carries the view. File `<home>/room.json` (0600); a damaged one is kept as `room.json.bad` and the default used; an unreadable one (permissions) is left. A block this version lacks comes in hidden at its default place; an unknown one is dropped, so a new block or downgrade never resets your layout.
