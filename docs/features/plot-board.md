# Plot Board: the one plan

<PlotBoardMock class="doc-mock" />

The PLOT BOARD key (round, top bar) opens one page of text: the room's current plan. Every agent can read it; only FLIGHT, the boss, and you can write it. It is not the [Flight Plan](flight-plan.md) (tasks) or the [Mission Log](mission-log.md) (what agents learned). Design and limits: [`docs/plot-board-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/plot-board-spec.md).

## The plan

- Plain text or markdown, at most 10000 characters, shown as typed (never rendered). No NUL character.
- Line ends are kept as `\n`; white space at the end is dropped. An empty plan is allowed.
- **Revision:** 0 until the first write, then +1 for each write that changes the text. The same text again changes nothing.
- A write names the revision it read. If the board is at another, it is refused (`the Plot Board is at revision 5, not 4: read it again, then write`), so nobody replaces text they did not see.

## The page

A box labelled Plan; under it who wrote the plan (`Written by hand` for a file made by hand), when, the revision and the characters used. SAVE; the second key reads DISCARD TYPING, or LOAD THE LATEST when the board changed while you typed. The page asks the server every 5 seconds while its tab is visible: a box you did not type in follows the board, a box with your typing in it keeps it.

## Agent tools

In each Claude agent's `--allowedTools`, with one line in its role text (read the board when you start work).

- `board_read`: `{ ok, text, revision, author, updatedAt, canWrite }`. `canWrite` is true for the boss.
- `board_write`: `text`, `revision`. Only the boss: any other agent gets `only the boss may write the Plot Board`. The author is the caller's own name. Answers `{ ok, revision, updatedAt }`, not the text.

The boss is the agent the room treats as boss, asked at each call. An agent reads the plan like mail: keep secrets out.

## File

`~/.gonogo/board.md` (mode 0600): front matter (`version`, `revision`, `author`, `updatedAt`, each value JSON on one line), `---`, the plan. It is read at start: a hand edit shows after a restart, and a write before then replaces it. A file without that front matter is read as the plan (the page says `Written by hand`); a plan longer than 10000 characters is cut when read, and the next write keeps the cut text. A `version` above 1 stops the start (see [Configuration](../reference/configuration.md#versions-of-the-saved-state)).

## API

- `GET /api/board` answers `{ "text": "...", "revision": 4, "author": "flight", "updatedAt": 1763474580000 }` (`author` and `updatedAt` are null for a board never written).
- `PUT /api/board` with `{"text": "# This week", "revision": 4}` answers the new view. 400 names the bad field; 409 means the revision is stale.

No frame, no option. Writes are recorded in the [Black Box](black-box.md).
