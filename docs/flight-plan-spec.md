# Spec: Flight Plan

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): a task board, the
equivalent of Munder Difflin's Tasks.

## Intent

The Director and the agents share one list of work: what is to do, who has it, what is stuck, what is done. An agent can
read the list and add to it, the Director can see it on one screen (also on a phone) and hand a card to an agent. Nothing
else is new: giving a task to an agent is a message, and the agent works as it always does.

## Design

- **A task** is `{ id, title, detail, status, assignee, createdBy, createdAt, updatedAt, notes }` (`Task` in
  `src/shared/protocol.ts`). `id` is `t1`, `t2`, ... and is never used twice, also
  after a restart (the file keeps `seq`, the number of the last id given). `status` is `todo`,
  `doing`, `review`, `done` or `blocked`; any status may follow any other. `assignee` is an agent name or null.
  `createdBy` is `user` (the Director) or the name of the agent that made it. `notes` is the history, oldest first, one
  line per change: `2026-11-17 14:03 UTC ana: status doing; started`. The server writes the time and who, so nobody can
  sign as someone else (the agent comes from its token, as for `send_message`).
- **The file** is `~/.gonogo/tasks.json`, `{ "version": 1, "seq": n, "tasks": [...] }`, mode 0600, written whole through a
  temporary file and a rename after every change (`src/server/tasks.ts`, the same writer as `schedules.ts`). A file that
  cannot be read is renamed `tasks.json.bad` and the server starts with none, so the next save cannot overwrite it; the
  log does not quote the parse error. One bad record is skipped with a warning and the rest load. A saved record is read
  back loosely (a bad `assignee` becomes null), because the agent it names may be gone.
- **Who changes it.** `Tasks.create`, `update` and `remove` (`createTasks`) take an actor: the Director (the browser
  routes) or an agent with the generation of its token (the MCP tools). The hub is not changed: tasks are not agent state.
- **Assigning is a message, through the normal path.** When a task gets an assignee different from the one it had (at
  create or in an update), that agent gets a message with the subject `Flight Plan: <id> assigned to you: <title>` (cut to
  the 200 characters of a subject) and the body `<detail, or "(no detail)">`, a blank line and `Assigned by <the Director or
  the name>. Set its status with task_update.` From the Director it is `Hub.sendFromUser`; from an agent it is
  `Hub.sendFromAgent` as that agent, so the send window, Redline's ping-pong detector, the hop limit and held mail apply to
  it as to `send_message`. An agent that gives a task to itself sends nothing. The message goes before the change is
  stored: if the hub refuses it (the acting agent's session ended, the recipient is being removed) the board stays as it
  was and the caller gets the hub's reason. A message that was made but not delivered (the agent is stopped, a rate limit)
  is a note on the task (`the message to ben was not delivered: ...`); the assignment stands.
- **The MCP tools** (`mcp.ts`, `MCP_DESCRIPTIONS`; in the allowed tools of a Claude agent, `ROLE_PREAMBLE` tells the agent
  in one line, the stand-in agent checks the list):
  - `task_list { mine?, status? }`: the tasks, most recently changed first, with `mine` for the caller's own and `status`
    for one status. The answer is cut like `read_messages` (`READ_MAX_CHARS`, the first task always goes) and then says
    how many are left.
  - `task_create { title, detail?, assignee? }`: a task that is `todo`. Answers `{ ok, task }`.
  - `task_update { id, status?, assignee?, note? }`: `assignee: null` takes the task from whoever has it. At least one
    field. A change that changes nothing answers with the task as it is and writes nothing. A refusal is an error result
    with the text (`{ ok: false, error }`), as for the other tools.
  An agent cannot change a title or a detail, and cannot remove a task: those are the Director's.
- **The checks.** Title 1 to 200 characters on one line, detail at most 4000, a note 1 to 200 characters (whitespace
  collapsed to one line), a status from the list, an assignee that is an agent in the room (`flight` is one; `boss` and
  `user` are not names) or null. Any other field is a 400 with its name. At most 500 open tasks (any status but `done`):
  the 501st is a 409, and so is moving a `done` task back when the board is full.
- **Done tasks are kept to 100.** After every change the oldest `done` tasks beyond the 100 most recently changed are
  dropped, so the file and every frame stop growing. The Director can also remove any task.
- **Routes** (`web.ts`, browser token only): `GET /api/tasks`, `POST /api/tasks` (201; `title`, `detail`, `assignee`),
  `PATCH /api/tasks/:id` (200; `status`, `assignee`, `note`) and `DELETE /api/tasks/:id` (204). A bad field is 400 with its
  name, an unknown id 404. The browser acts as the Director whatever the body says.
- **Frames.** `tasks` carries the whole list and is sent at every change; `StateSnapshot.tasks` has it at connect.
- **The screen** is a view of its own, FLIGHT PLAN (`FlightPlan.tsx`, `plan.ts`, `plan.css`; `store.view` is `plan`),
  with a FLIGHT PLAN key in the top bar and a PLAN key in the phone bar. Five columns, TODO, DOING, REVIEW, BLOCKED, DONE,
  each with its count; they wrap on a medium page and stack on a phone. A card has the id, the light and call sign of
  its assignee (the light is that of the assignee's console; UNASSIGNED has none), the title, a fold with the detail
  and the history, one key for each other column, a select that gives it to an agent, and Remove, which asks first. The
  form (NEW TASK) has title, detail and a select. A small count of the tasks that are doing or blocked sits on the
  top-bar key and the phone-bar key (saffron when one is blocked; the words are in its accessible name). After a card moves,
  the keyboard goes to it in its new column, and a status line says where it went.

## Decisions

- **A module of its own, not a change to the hub.** The store takes the send and the roster check as functions, so it is
  tested on a fake clock with a fake send, and `Hub` and its fakes stay as they are.
- **The assignment message comes from the agent that assigns.** The brief said "through the normal path". Sending every
  one as the Director would be simpler, but it would let an agent bypass the send window and the hop limit by assigning
  back and forth, and would hide who handed the work over.
- **The column order puts BLOCKED before DONE.** A stuck card is closer to the work than a finished one. The brief lists
  the statuses with `done` before `blocked`; that is the list, not a layout.
- **Move is a key per column, assign is a select.** There are up to 24 agents, so one key each is not an option on a
  phone. Both are real controls that the keyboard and a screen reader reach; there is no drag and drop.
- **Only status, assignee and note change.** The brief names them for the tools, and the Director has no edit of a title
  or a detail either: remove and add again. Add it if it is missed.
- **`tasks.json` is not rewritten for a change that changes nothing**, so an agent that repeats `task_update` with the
  status the task already has costs no write and no frame.
- **No open limit on `done`, only the 100 kept.** The brief's 500 is for open tasks; without a cap on `done` the file would
  grow for ever.
- **The board loads before the hub starts an agent.** A `task_create` that came before the file was read would take an
  id of the file, and that saved task would then be skipped as a duplicate and lost at the next save.
- **No option and no environment variable.** The limits are constants (`constants.ts` and `protocol.ts`).

## Rejected

- Subtasks, due dates, labels, comments by other agents than the history line: not in the brief.
- A task that wakes an agent that is not working on it again: the assignment message is the only push.
- Following a renamed console: see the limits.
- Fixed-order cards or a rank: cards stay in the order they were made (done: newest change first).

## Known limits

- shortcut: the whole list is in every frame and every snapshot. At the limits (500 open tasks with 4000-character
  details and 20 history lines each) that is several megabytes and nears the 4 MB socket buffer of `web.ts`, which closes a
  slow reader. Send the details on demand if a board ever gets that big (`tasks.ts`).
- shortcut: `assignee` is an agent name, so a renamed console leaves its tasks under the old name (they show the name in
  capitals and the select says `(not in the room)`), and a removed agent's tasks stay assigned to it. Key by record id if
  renames get common.
- A task given to an agent that cannot read mail (a custom command, an engine without the gonogo tools) is assigned and
  the message is `undelivered` (a note on the task and a line in the loop).
- The history keeps the newest 20 lines, so a long-lived task loses its `created` line.
- The agents only learn of a task when they are told (the assignment message) or ask (`task_list`). Nothing reminds an
  agent of a task it was given earlier.
- Tested with a fake clock and a fake send (the store), a fake store behind the routes and the tools, a real server with
  the stand-in agent (a Director's task, an agent moving and creating tasks, the tools' results, the file) and the page in
  Chrome (below). Never run with a real `claude`: whether the model reads the `ROLE_PREAMBLE` line, calls the tools and
  moves a task when it is assigned one is not known. Gemini and the other engines get the tools through the same MCP
  server and were not run.
- The page was opened in Chrome at 1280 px and in Chrome's 390 px phone emulation: no horizontal overflow, every key and
  select at least 44 px, a move followed by the keyboard, the form with its error, a task made from the form and the
  Remove question. Those clicks were made by script (DOM events), not by hand or with a screen reader. Not tried:
  Firefox, Safari, a screen reader, the `(not in the room)` option, and a board with hundreds of cards.
