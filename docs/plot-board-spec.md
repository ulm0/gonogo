# Spec: Plot Board

Written and built 2026-11-18. Backlog section 2, "Blackboard: a shared plan (`board.md`) with the boss as its only writer". The name is
gonogo's own: the plot boards of a control room show the course in plain sight.

## Intent

The Flight Plan is a list of tasks, and the Mission Log is what the agents learned. Neither says what the room is doing this week
and why. The Plot Board is that: one page of free text, the one current plan. Every agent can read it, FLIGHT (the boss) is the only
agent that can write it, and the Director can edit it from a view. It replaces nothing: no task is made from it and no entry is
kept in it.

## Design

- **The file.** `~/.gonogo/board.md`, mode 0600. A front matter and then the plan:

  ```
  ---
  version: 1
  revision: 4
  author: "flight"
  updatedAt: "2026-11-18T14:03:00.000Z"
  ---
  # This week
  ...
  ```

  Each front matter value is JSON on one line. It is written whole to a temporary file and renamed, so a crash leaves the old text
  or the new. A file that starts with anything else (a plan written by hand) is read as the plan itself, at revision 0, with no
  author and the file's time; the next write replaces it. A `version` above 1 stops the start, as for the JSON files
  (`<path> was saved by a newer gonogo (format version 2; this one reads up to 1). ...`), and the file is not touched. Text
  longer than the limit that was put there by hand is cut when read.
- **The text** is at most `BOARD_MAX_CHARS` (10,000) characters, plain text or markdown, shown as typed (never rendered). A NUL
  character is refused. Line ends are stored as `\n` and white space at the end is dropped. An empty text is allowed (it clears the
  board). The same text again changes nothing: no new revision, no file written.
- **The revision** counts the writes (0 for a board never written). A write names the revision it read; if the board is at another,
  the write is a 409 `conflict` (field `revision`) that names the current one. So a boss that read the board, waited, and wrote
  cannot replace what the Director typed in between, and the other way round. Two writes of the same revision at once: one wins,
  the other is told (the store writes one at a time).
- **Who writes.** The Director through the page (`PUT /api/board`, author `user`) and the boss through the tool `board_write`
  (author: the agent's own name, taken from its token, never a field of the call). The boss is whoever the hub says it is at the
  moment of the call (`rosterFor(...).boss`, the agent with the boss flag), so a renamed or replaced boss is followed at once. Any
  other agent gets `only the boss may write the Plot Board` and nothing changes.
- **The tools** (`mcp.ts`, `MCP_DESCRIPTIONS`; both are in the allowed tools of a Claude agent and the stand-in agent checks the
  list):
  - `board_read {}`: `{ ok: true, text, revision, author, updatedAt, canWrite }`. `canWrite` is true for the boss.
  - `board_write { text, revision }`: `text` at most 10,000 characters, `revision` a whole number. Answers
    `{ ok: true, revision, updatedAt }`, never the text. A refusal is an error result `{ ok: false, error }`.
- **The role text.** One line of `ROLE_PREAMBLE` tells every Claude agent that the Plot Board is the one current plan, to read it
  when it starts work, and that only the boss writes it, as a whole text with the revision it read.
- **Routes** (`web.ts`, browser token only). `GET /api/board` answers `{ text, revision, author, updatedAt }` (author and time
  null while it was never written). `PUT /api/board` with `{ text, revision }` answers the new view; a bad field is 400 with its
  name (an unknown field too), a stale revision 409. Without a `board` option the route is 404 and the tools say the board is not
  available. No frame and no part of the state snapshot: the page asks.
- **The screen** is a view of its own, PLOT BOARD (`PlotBoard.tsx`, `board.ts`, `records.css`; `store.view` is `board`), reached by a
  the Patch Panel (the same on a phone). A labelled box (`Plan`), a line under it (who wrote it, when, the revision, the
  characters used), SAVE and DISCARD TYPING. The page asks the server every 5 seconds while the tab is visible, and when it becomes
  visible. A box nobody typed in follows the board. A box with typing in it keeps the typing; when the board moved on under it the
  page says who wrote which revision, SAVE stays off, and the second key reads LOAD THE LATEST. A refused save (409) shows the same
  and keeps the typing.
- **No key.** The top bar (nine keys at 1280 px) and the phone bar (eight keys in 390 px) are full, so the Patch Panel opens this page (the line "Plot Board"), as it does the Black Box and Party Line.
- **The record.** Each write that changes the board tells the Black Box: `<who> wrote the Plot Board: revision N, M characters`
  (see `docs/black-box-spec.md`). The text is not recorded.

## Decisions

- **A revision, not a lock.** A lock needs a timeout and a way to break it. A revision costs one number, needs no state in the
  page, and gives the boss a clear message to act on.
- **The boss's check is in the tool, not in the store.** The store takes any author, as the Mission Log does; the one place that
  knows who the boss is (the hub, through `rosterFor`) is asked by the one caller that needs it.
- **Every Claude agent gets both tools in its allowed list**, and the server refuses the write. A list per agent would make the
  launcher depend on who the boss is at each start; the refusal is one line and cannot be got around by an edited list.
- **No frame.** A frame would add a state field, a snapshot field and a client rule in files that every feature touches. The board
  changes by the hour, not by the second: the page asks every 5 seconds, and nothing else needs it live.
- **Front matter in the file.** The author and the revision must outlive a restart (the page and the tool show them), and the
  Mission Log already stores its entries this way. A file with no front matter is still read, so a plan can be started by hand.
- **Plain text, not rendered markdown.** As for the Mission Log: nothing in the plan can be read as HTML or a link by the page.
- **10,000 characters.** One page, and a tool result of a few thousand tokens at most.

## Rejected

- Writing by other agents with the boss's approval, sections with owners, history of revisions: not in the brief. The history of
  who wrote which revision is in the Black Box.
- A task or a Mission Log entry made from a line of the plan: the three stay apart on purpose.
- Sending the plan to an agent when it changes: an agent reads it when its role text says to.

## Known limits

- shortcut: the file is read at start only. A hand edit made while gonogo runs is not seen until the next start, and the next write
  replaces it (`board.ts`).
- The plan is read by every agent as mail is: it is text that another agent's model may follow, and it is plain text on disk. It
  is not a place for secrets.
- The boss is one agent. A room where the boss is stopped has a board that only the Director can write.
- Two browsers: the second one to save is told the board moved on, and keeps its typing. Nothing tells the first one that the
  second is typing.
- Docked stations (Docking) neither read nor write the board: only agents with a token of this station have the tools.
- Tested with a temporary folder and a fake clock (the store: revisions, limits, hand-written and newer files, a link in place of
  the file), the routes and the tools with a fake board (who may write), a real server with the stand-in agent (an agent refused,
  the boss writing, a stale write told to read again, the Director's edit, the file), and the page's logic. The page was looked at
  in Chrome (next paragraph). Never run with a real `claude`: whether a model reads the board at the start and keeps to it was not tried,
  and Gemini and the other engines get the tools through the same MCP server and were not run.
- The page was opened in Chrome at 1440 px (Instrument and Night Shift), at 1280 px (the top bar on one line) and in the 390 px phone
  emulation (Instrument), against a real server with the stand-in agent: the board written by the boss, typing kept while the boss wrote
  (the amber line and LOAD THE LATEST), a save that ends as the Director, no sideways scroll at 390 px, every key and field at least
  44 px tall. The text of the page was measured at 4.5:1 or more in all four liveries by script (the least was 4.86:1, the hint line
  in Instrument). Not tried: Firefox, Safari, a screen reader, a real phone, two browsers at once, a plan of 10,000 characters,
  `prefers-reduced-motion` (the page has no motion).
