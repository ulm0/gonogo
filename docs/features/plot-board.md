# Plot Board: the one plan

<PlotBoardMock class="doc-mock" />

PLOT BOARD (Patch Panel, Cmd+K or Ctrl+K) is one page of text, the room's current plan. Every agent reads it; only FLIGHT (the boss) and you write it. Not the [Flight Plan](flight-plan.md) (tasks) or [Mission Log](mission-log.md) (learnings). Design and limits: [`docs/plot-board-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/plot-board-spec.md).

## The plan

- Plain text or markdown, at most 10000 characters, shown as typed. No NUL. Line ends kept as `\n`; trailing white space dropped. Empty allowed.
- **Revision**: 0 until the first write, then +1 per write that changes the text.
- A write names the revision it read; at another revision it is refused (`the Plot Board is at revision 5, not 4: read it again, then write`).

## The page

A Plan box; under it the author (`Written by hand` for a hand-made file), time, revision, characters used. SAVE; the second key is DISCARD TYPING, or LOAD THE LATEST when the board changed meanwhile. The page polls every 5 s while visible: an untouched box follows the board, a box with your typing keeps it.

## Agent tools

In each Claude agent's `--allowedTools`; its role text says to read the board at the start.

| Tool | Does |
|---|---|
| `board_read` | `{ ok, text, revision, author, updatedAt, canWrite }` (`canWrite` true for the boss) |
| `board_write` | `text`, `revision`; only the boss (others get `only the boss may write the Plot Board`); answers `{ ok, revision, updatedAt }` |

The boss is asked at each call. Agents read the plan like mail: keep secrets out.

## File

`~/.gonogo/board.md` (0600): front matter (`version`, `revision`, `author`, `updatedAt`, each value JSON on one line), `---`, the plan. Read at start: a hand edit shows after a restart, and a write before then replaces it. A file without front matter is the plan (`Written by hand`); a plan over 10000 characters is cut when read. A `version` above 1 stops the start ([Configuration](../reference/configuration.md#versions-of-the-saved-state)).

## API

- `GET /api/board` -> `{ "text": "...", "revision": 4, "author": "flight", "updatedAt": 1763474580000 }` (`author`, `updatedAt` null if never written).
- `PUT /api/board` `{"text": "# This week", "revision": 4}` -> the new view. 400 names the bad field; 409 stale revision.

Writes are in the [Black Box](black-box.md).
