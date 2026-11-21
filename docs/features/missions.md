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

A mission can carry a short **checklist for its ending** ("the reviewer read it", "the changelog line is written", "the phone alert was tested"). It is **printed, never checked, and never a gate**: a mission closes with items open, and the Downlink line says how many were left ("Mission done: Ship it (4 of 5 tasks done; 2 of 5 closing items left)": a count, never the text of a line).

- **Where it comes from.** When a mission is made, gonogo **copies** a template into it: the mission's repo file `<repo>/.gonogo/ritual.md` when the mission has a repo and the file has lines, else the room's own `<home>/ritual.md`, else nothing. Editing the file later changes no mission that exists. One item a line; blank lines, headings (`#`) and comments (`<!-- -->`) are dropped, and a list marker or a box (`- [ ]`) is taken off. At most **20 items of 200 characters**; the page says how many lines were dropped (`ritualOmitted`).
- **The repo of a mission.** `repo` is the **git top level of the start folder of an agent hired in this room**, as a real path: the API refuses `/`, another repository, a subfolder, a link, a relative path or one with `..`, and anything no agent of the room works in. It is checked when it is set and **again at every read**: if that agent is removed or goes to another repository the mission shows no repo (the file keeps it, and it is back when an agent is again there). A mission made without one gets its **lead's** repo. It only chooses the template; gonogo never writes in a repo.
- **A repo is not the Director.** `.gonogo/ritual.md` is written by agents, so it is data: read through its real path (which must be inside the repo, a link out of it is not read), no link at the end, a regular file, at most 16 KiB, every line cleaned (control, escape, bidi and zero-width characters removed) and each item **labelled** `from: "repo"` so that the page can show "from the repo". It never reaches an agent's role text, a pointer or a message.
- **Only the Director ticks.** `PATCH /api/missions/<id>` with `{ "ritual": { "index": 0, "done": true } }` (the number of an item from 0), from the browser session, or a `full` key. An agent, the boss included, has no such field: the tool does not have it, and the server answers 403 if it is sent some other way. The item then says `by: "Director"` and when. `repo` is the Director's too.

## Tasks

The task form has a **Mission** select (when any mission exists); each card has a Mission select and a tag that opens it. API: `missionId` on task create and update (`null` unlinks; unknown id is 400). Removing a mission keeps its tasks, unlinked, and asks first if it has tasks.

## Who can do what

| Who | Can |
|---|---|
| You | everything: make, edit name, goal, lead, change status, remove |
| FLIGHT (boss) | `mission_create { name, goal?, lead? }` (planned), `mission_update { id, status?, note? }`; not name, goal, lead of an existing mission, nor removal |
| Every agent | `mission_list { status? }` (with progress); `missionId` on `task_create` and `task_update` |

## Cost

A mission's COST block shows its cost so far (API-equivalent estimate, [Cost](./cost.md#cost-per-mission-and-task-and-a-budget-per-mission)), a dollar budget, and each task's cost. At 80 % of budget the Downlink is told; at 100 % Redline stops agents with a task of the mission on `doing`.

## API

`GET /api/missions`, `POST /api/missions` (201), `PATCH /api/missions/<id>` (`name`, `goal`, `status`, `lead`, `note`, `repo`, and `ritual` to tick an item), `DELETE /api/missions/<id>` (`?unlink=1` required when it has tasks, else 409). The list is also in state and `missions` frames. File `missions.json` (0600). At most 50 unfinished missions; the 20 most recent finished are kept. The [Black Box](./black-box.md) records kinds of change, never a name or goal.

## Limits

Two active missions share one wall strip (latest wins). A task serves one mission. No due dates, per-task owners beyond the assignee, or mission dependencies.
