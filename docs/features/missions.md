# Missions: a named goal and the tasks that serve it

<MissionsMock class="doc-mock" />

MISSIONS is a view you open from the [Patch Panel](./patch-panel.md) (Cmd+K or Ctrl+K: "Missions" or "New mission"), from the MISSIONS key of the wall's mission block, or from the **Make this a mission** key that appears beside the brief box once you have typed a brief. It has no top-bar key. Design and limits: [`docs/missions-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/missions-spec.md).

A mission is a goal the Director (or FLIGHT) names: a name of one line (80 characters), a goal (2000), a status, a lead and a history. Its tasks are the tasks of the [Flight Plan](./flight-plan.md) that carry its id, so a task is in one mission at most and a mission's list is never stored twice.

## Status

`planned`, `active`, `paused`, `done`, `aborted`: any to any, with keys on the mission (START or RESUME, PAUSE, DONE, ABORT; REOPEN on a finished one). `done` and `aborted` set the end time; the other statuses clear it. Every change is a line of the history with who made it and when. Progress is derived, `3 / 7`: tasks done out of all tasks linked; nothing is stored.

A room can run two active missions. The wall shows the one that became active last; pause it and the other takes over. A room that never makes a mission still shows the old guess from the last brief to FLIGHT, as before.

## What happens when it starts

When a mission becomes `active`, FLIGHT gets one message from the Director (or from itself, which sends nothing): `Mission: <name>` with the goal and the open tasks. Pausing or ending sends nothing. The [Downlink](./downlink.md) gets an event when a mission starts or ends, and once when the last open task of an active mission is done: `All 7 tasks of Ship 0.2 are done: close it?`. **Nothing closes a mission by itself**: closing it is your decision.

## Tasks

The task form has a **Mission** select (when any mission exists), and each card has a Mission select and a tag that opens the mission. Over the API a task takes `missionId` on create and update (`null` unlinks; an unknown id is 400). Removing a mission keeps its tasks on the board, unlinked, and asks first when it has tasks.

## Who can do what

- **You** (the browser): everything: make, edit the name, goal and lead, change the status, remove.
- **FLIGHT, the boss**: `mission_create { name, goal?, lead? }` (a planned mission) and `mission_update { id, status?, note? }`. A name, a goal or a lead of an existing mission, and removal, are yours only.
- **Every agent**: `mission_list { status? }`, with the progress of each mission; and `missionId` on `task_create` and `task_update`.

## Cost

Each mission's page has a COST block: what it has cost so far (an API-equivalent estimate, see [Cost](./cost.md#cost-per-mission-and-task-and-a-budget-per-mission)), a budget in dollars, and the cost beside each of its tasks. At 80 % of the budget the Downlink is told; at 100 % Redline stops the agents that have a task of the mission on `doing`.

## API

`GET /api/missions`, `POST /api/missions` (201), `PATCH /api/missions/<id>` (`name`, `goal`, `status`, `lead`, `note`), `DELETE /api/missions/<id>` (`?unlink=1` is required when it has tasks, else 409). The list is also in the state and in `missions` frames. File: `missions.json` in gonogo's home (mode 0600). At most 50 missions that are not finished; the 20 most recent finished ones are kept. Mission changes are in the [Black Box](./black-box.md) as kinds of change, never a name or a goal.

## Limits

Two active missions share the one strip of the wall (the latest wins). A task serves one mission. There are no due dates, owners per task beyond the assignee, or dependencies between missions.
