# Missions: a named goal and the tasks that serve it

<MissionsMock class="doc-mock" />

A mission is a goal you (or FLIGHT) name, with a status, a lead and a history; its tasks are the [Flight Plan](./flight-plan.md) tasks carrying its id (a task is in one mission at most). Open MISSIONS from the [Patch Panel](./patch-panel.md) (Cmd+K or Ctrl+K: "Missions" or "New mission"), the wall's mission block, or **Make this a mission** beside the brief box. No top-bar key. Design and limits: [`docs/missions-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/missions-spec.md).

A mission has a name (one line, 80 characters), goal (2000), status, lead, history.

## Status

`planned`, `active`, `paused`, `done`, `aborted`: any to any, with keys START or RESUME, PAUSE, DONE, ABORT, REOPEN (finished ones). `done` and `aborted` set the end time; others clear it. Each change is a history line (who, when). Progress `3 / 7` (done of linked tasks) is derived.

A room can run two active missions; the wall shows the one that became active last (pause it and the other shows). A room with no mission still shows the guess from the last brief to FLIGHT.

## Starting and ending

On `active`, FLIGHT gets one message from the Director (or from itself, which sends nothing): `Mission: <name>` with the goal and open tasks. Pausing or ending sends nothing. The [Downlink](./downlink.md) gets an event on start or end, and once when the last open task is done: `All 7 tasks of Ship 0.2 are done: close it?`. **Nothing closes a mission by itself.**

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

`GET /api/missions`, `POST /api/missions` (201), `PATCH /api/missions/<id>` (`name`, `goal`, `status`, `lead`, `note`), `DELETE /api/missions/<id>` (`?unlink=1` required when it has tasks, else 409). The list is also in state and `missions` frames. File `missions.json` (0600). At most 50 unfinished missions; the 20 most recent finished are kept. The [Black Box](./black-box.md) records kinds of change, never a name or goal.

## Limits

Two active missions share one wall strip (latest wins). A task serves one mission. No due dates, per-task owners beyond the assignee, or mission dependencies.
