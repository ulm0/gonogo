# Missions: a named goal and the tasks that serve it

<MissionsMock class="doc-mock" />

A mission is a goal you (or FLIGHT) name, with a status, a lead and a history; its tasks are the [Flight Plan](./flight-plan.md) tasks carrying its id (a task is in one mission at most). Open MISSIONS from the [Patch Panel](./patch-panel.md) (Cmd+K or Ctrl+K: "Missions" or "New mission"), the wall's mission block, or **Make this a mission** beside the brief box. No top-bar key. Design and limits: [`docs/missions-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/missions-spec.md).

A mission has a name (one line, 80 characters), goal (2000), status, lead, history.

## Status

`planned`, `active`, `paused`, `done`, `aborted`: any to any, with keys START or RESUME, PAUSE, DONE, ABORT, REOPEN (finished ones). `done` and `aborted` set the end time; others clear it. Each change is a history line (who, when). Progress `3 / 7` (done of linked tasks) is derived.

A room can run two active missions; the wall shows the one that became active last (pause it and the other shows). A room with no mission still shows the guess from the last brief to FLIGHT.

## Starting and ending

On `active`, FLIGHT gets one message from the Director (or from itself, which sends nothing): `Mission: <name>` with the goal and open tasks. Pausing or ending sends nothing. The [Downlink](./downlink.md) gets an event on start or end, and once when the last open task is done: `All 7 tasks of Ship 0.2 are done: close it?`. **Nothing closes a mission by itself.**

## The closing ritual

A mission can carry a short **checklist for its ending** ("the reviewer read it", "the changelog line is written", "the phone alert was tested"). It is **printed, never checked, and never a gate**: a mission closes with items open, the page says "2 of 5 closing items left", and the Downlink line for the status change lists them ("Mission done: Ship it (4 of 5 tasks done; 2 of 5 closing items left: "the reviewer read it", ..."), each cut to 60 characters, and `(by flight)` after a line an agent wrote, as the page says it).

- **The template.** `<home>/ritual.md` (0600, at most 8 KiB), edited in FLIGHT RULES (CLOSING CHECKLIST TEMPLATE; writing it asks for the password again and leaves a line in the audit that says how big it is, never what it says). One item a line; blank lines, headings (`#`) and comments (`<!-- -->`) are dropped and a list marker or box (`- [ ]`) is taken off. A `ritual.md` that is a link is not read. When a mission is **made**, its lines are **copied** into it (`from: "room"`, at most 20, 200 characters each; `ritualOmitted` counts the lines that did not fit). Editing the file later changes no mission that exists. The template can also come from the mission's **repo** (below).
- **From the repo.** A mission can name a **repo**, and then its template is the room's `ritual.md` **followed by** the lines of `<repo>/.gonogo/ritual.md` (a repo file adds lines after yours and never replaces them; together at most 20). Those lines are **written by agents**, so they are data: read through the real path of the file (which must lie inside the repo; a link in its place, or a `.gonogo` folder that is a link, is not read), a regular file of at most 16 KiB, cleaned like any line (control, escape, bidi and zero-width characters removed, 200 characters, 20 items), and each item is `from: "repo"`, which the page shows as "from the repo". `repo` is the **git top level of the start folder of an agent hired in this room**, as a real path: the API refuses `/`, another repository, a subfolder, a link, a relative path or one with `..`, and any folder no agent of the room works in. It is checked when it is set and **again at every read**: when that agent is removed or goes to another repository the mission shows no repo (the file keeps it; it is back with an agent). A mission made without one gets its **lead's** repo (none when the lead works in no repository); a mission made by an **agent** (the boss) can only have the repository of that agent's **own** folder, given or by default, and the server answers 403 for another. Setting it (`POST` or `PATCH /api/missions` with `repo`, or `null` to remove) is the Director's; an agent gets 403, and the tool has no such field. It only chooses the template when the mission is made: setting it later changes no item. gonogo never writes in a repo.
- **Who writes.** The Director adds, edits and removes items on the mission page; an item he writes or edits is `from: "director"`. The boss may pass `ritual` (up to 20 short lines) to `mission_create`; they come after the template, `from: "agent"` with its name, and the page shows "set by flight". A line the boss or the Director writes is **refused** (400, field `text` or `ritual`) when it has a control, escape, direction or zero-width character or a line break, or is longer than 200 characters; a line from the template file is **cleaned** instead.
- **Only the Director ticks.** An agent, the boss included, can read the items (`mission_list`: `text`, `done`, `from`) and never tick, edit, add or remove: the tool has no such field, and the server answers 403 if it is sent some other way. A tick records `by: "user"` and the time.
- **API** (the Director's session, or a `full` key; an agent token is refused; each answers the whole mission): `POST /api/missions/<id>/ritual` `{ "text" }` adds one (400 over 20 items); `PATCH /api/missions/<id>/ritual/<index>` `{ "done"?, "text"? }` ticks or edits (the index is the position in the stored list, from 0; 404 field `index` when there is none); `DELETE /api/missions/<id>/ritual/<index>`. `GET /api/ritual-template` and `PUT /api/ritual-template` `{ "text" }` answer `{ text, bytes, max, updatedAt }`; the PUT needs a fresh password check.

## Tasks

The task form has a **Mission** select (when any mission exists); each card has a Mission select and a tag that opens it. API: `missionId` on task create and update (`null` unlinks; unknown id is 400). Removing a mission keeps its tasks, unlinked, and asks first if it has tasks.

## Who can do what

| Who | Can |
|---|---|
| You | everything: make, edit name, goal, lead, change status, remove |
| FLIGHT (boss) | `mission_create { name, goal?, lead? }` (planned), `mission_update { id, status?, note? }`; not name, goal, lead of an existing mission, nor removal |
| Every agent | `mission_list { status? }` (with progress); `missionId` on `task_create` and `task_update` |

## The closing checklist

A mission page has a CLOSING CHECKLIST: the lines you want checked before the mission is called done. A new mission copies the **template** of the room (CLOSING CHECKLIST TEMPLATE in [Flight Rules](./flight-rules.md): one line each, up to 20 lines of 200 characters; a line starting with `#` and a blank line are left out). On the mission page you tick a line, reword it, remove it or add one of your own.

- **Only you tick.** An agent can read the list and cannot tick, change or add to it from a mission it already has.
- **Where a line came from is said.** A line an agent set when it made the mission reads "set by flight"; one from the template reads "room template"; your own says nothing. A line is plain text: it is never a link and never an instruction to an agent.
- **It is never a gate.** DONE and ABORT work with lines open. The page says "2 of 5 closing items left" and the Downlink names the ones left.

Not seen in a browser.

## Cost

A mission's COST block shows its cost so far (API-equivalent estimate, [Cost](./cost.md#cost-per-mission-and-task-and-a-budget-per-mission)), a dollar budget, and each task's cost. At 80 % of budget the Downlink is told; at 100 % Redline stops agents with a task of the mission on `doing`.

## API

`GET /api/missions`, `POST /api/missions` (201), `PATCH /api/missions/<id>` (`name`, `goal`, `status`, `lead`, `note`), `DELETE /api/missions/<id>` (`?unlink=1` required when it has tasks, else 409). The list is also in state and `missions` frames. File `missions.json` (0600). At most 50 unfinished missions; the 20 most recent finished are kept. The [Black Box](./black-box.md) records kinds of change, never a name or goal.

## Limits

Two active missions share one wall strip (latest wins). A task serves one mission. No due dates, per-task owners beyond the assignee, or mission dependencies.
