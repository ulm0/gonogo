# Spec: Missions (draft)

Design by FIDO, 2026-11-18. Backlog section 2, "Missions *(inferred)*". Status: draft, not built.

The backlog line is only "inferred", and what the reference does was not confirmed by running it. This design starts from
the need and from what gonogo has; nothing of the reference's code, names or art is used. (A look at its behaviour can still
change the field list; step 1 is cheap to adjust.)

## Intent

Today the "mission" on the wall is a guess: `missionOf` in `src/client/wall.ts` takes the latest message from the Director to
the boss that is not a T-minus or Relief answer, and shows its subject or first line. It forgets when the Director sends a
side question, it has no end, and nothing links it to the work. A mission should be a thing the Director (or FLIGHT) names:
a goal, the tasks that serve it, a status, and a history.

## Design

- **A mission** is `{ id, name, goal, status, lead, createdBy, createdAt, updatedAt, startedAt, endedAt, history }`
  (`Mission` in `src/shared/protocol.ts`). `id` is `ms1`, `ms2`, ... never reused (the file keeps `seq`; `m`, `t`, `u`, `h`
  are taken by messages, tasks, uplinks and Relief). `name` 1 to 80 characters on one line; `goal` at most 2000. `status`:
  `planned`, `active`, `paused`, `done`, `aborted` (any to any, like task status; `done` and `aborted` set `endedAt`, any
  other clears it). `lead` is an agent name or null (default: the boss at creation, kept as a name so the record outlives
  a change of boss). `history` is one line per change, oldest first, written by the server with the real actor, as task
  notes are: `2026-11-18 14:03 UTC user: status active; kicked off`.
- **Tasks link to a mission by one field**, `Task.missionId?: string`. The list of a mission's tasks is derived, never
  stored twice, so a task cannot be in two places or lose its link when a mission is edited. A task has at most one mission;
  `task_create` and `task_update` accept `missionId` (`null` unlinks); an unknown id is a 400. Removing a mission unlinks its
  tasks (they stay on the board) and asks first when it has open tasks. **Progress** is derived: tasks `done` out of all
  linked tasks, shown as `3 / 7`. No percentage is stored.
- **The file** `~/.gonogo/missions.json` `{ version: 1, seq, missions }`, mode 0600, same writer as `tasks.json`
  (`src/server/missions.ts`, `createMissions`); unreadable file renamed `.bad`, one bad record skipped, as for tasks. At most
  50 missions not `done` or `aborted`, and the 20 most recent finished ones are kept.
- **Who changes it.** The Director (browser routes, browser token) can do everything. Agents get three MCP tools in the
  shape of the task tools: `mission_list { status? }`, `mission_create { name, goal?, lead? }` (status `planned`) and
  `mission_update { id, status?, note? }`. **Only the boss** may call the two writing tools (the FLIGHT role), because
  "which mission are we in" is a room-level decision; others read. An agent cannot edit a name or goal or remove a mission:
  the Director's, as for tasks.
- **The current mission.** At most one mission is *current*: the active one with the latest `startedAt`. Setting a mission
  `active` does **not** pause the others (a room can run two); the wall and the briefing use the latest one. `missionOf`
  becomes `currentMission(missions)` and falls back to the old message guess only when there is no mission at all, so a room
  that never makes one looks exactly as it does today.
- **Briefing the boss.** When a mission becomes `active` the hub sends FLIGHT, from the Director, `Mission: <name>` with the
  goal and the open task list, once (the way Flight Plan sends an assignment). From an agent it goes through
  `Hub.sendFromAgent` like any message, so Redline's ping-pong detector applies. Pausing or ending sends nothing (the boss
  sees the status on its next `mission_list`).
- **Events.** One Downlink event kind `mission` for: a mission started, ended, or "all N tasks done: close it?" (when the
  last open task of an active mission becomes `done`, once). **Never closes by itself**: closing is a decision.
- **Routes** (browser token only): `GET /api/missions`, `POST /api/missions` (201), `PATCH /api/missions/:id`
  (`name`, `goal`, `status`, `lead`, `note`), `DELETE /api/missions/:id` (`?unlink=1` required when it has tasks, else 409).
  A `missions` frame carries the whole list; `StateSnapshot.missions` has it at connect.
- **The screen: MISSIONS, a view opened from the Patch Panel**, no top-bar key and no phone-bar key (both are full). The
  Patch Panel gets "Missions" and "New mission"; `store.view` gets `missions`; the wall's mission strip links to it. A list
  of missions (status chip, name, lead, `3 / 7`), a detail with the goal, the linked tasks (opening the card in Flight Plan),
  the history and status keys (START, PAUSE, DONE, ABORT). A Flight Plan card shows its mission as a small tag, and the task
  form has a Mission select. The brief box gets a link "Make this a mission", which fills New mission from the brief.
- **Mission Log.** `done` writes nothing automatically; FLIGHT's role text says to log what was learned. Out of scope here.
- **Black Box and Recorder.** Mission changes go through the audited writer like tasks (`audited.ts`) so the Black Box
  commit history has them.

## Options

1. **Missions file plus `missionId` on tasks (pick).** One source of truth for each side, and no change to the shape of tasks
   other than one optional field, so the board and its tests stay.
2. A mission is a task with children (a `parentId`). Reuses the board and the screen with no new file, but it mixes a goal
   with a card, and a mission needs a status of its own, a lead and a history that cards would have to learn. Rejected.

## Order of changes

1. Types, `missions.ts` with its file and tests (pure store, no hub).
2. `Task.missionId` in create, update, the tools, the board filter; routes and frames.
3. Boss tools and the briefing message; the Downlink events.
4. The view, the Patch Panel lines, Flight Plan tag and select, `currentMission` replacing `missionOf` on the wall.
5. `docs/features/missions.md`, backlog tick, changelog.

## Test plan

- Store: create/update/remove, ids never reused after a restart, a bad file renamed `.bad`, one bad record skipped, the cap
  and the finished-mission trim, history written with the real actor.
- Links: `missionId` accepted, unknown 400, `null` unlinks, mission removal unlinks and demands `unlink=1`, derived progress.
- Roles: a non-boss agent's `mission_create` is `forbidden`; the Director's routes ignore any `createdBy` in the body.
- `currentMission`: none, one, two active (latest wins), pause the current one (the other takes over), no missions falls back
  to the old guess (the existing `wall` tests stay and prove it).
- Hub: the briefing message once on `active`; a held or stopped boss makes a note, not a failure; the "all done" event once.
- Client at 390 px, the keyboard path to START/PAUSE/DONE/ABORT, and the Patch Panel entries (no top-bar key added: a test
  that the key list is unchanged).

## Known limits

- Two active missions share one wall strip (the latest wins).
- A task cannot serve two missions.
- No due dates, owners per task beyond the assignee, or dependencies between missions.
