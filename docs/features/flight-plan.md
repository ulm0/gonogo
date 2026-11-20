# Flight Plan: tasks

<FlightPlanMock class="doc-mock" />

FLIGHT PLAN (top bar, or PLAN on a phone) is a task board shared by you and the agents. Design: [`docs/flight-plan-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/flight-plan-spec.md).

## Tasks

- Fields: title (up to 200 characters, one line), detail (up to 4000; what done means), status, assignee (an agent or nobody), creator, history line per change (UTC time, who). Ids `t1`, `t2`, ...
- Status: `todo`, `doing`, `review`, `done`, `blocked`; any can move to any other.
- At most 500 open tasks (not `done`). The 100 most recently changed `done` tasks are kept.
- Tasks follow the name: after a rename, its tasks stay under the old name.

## The page

Columns TODO, DOING, REVIEW, BLOCKED, DONE (stacked on a phone). A card shows id, assignee light and call sign, title; a fold opens detail and history. Each card has a key per other column, an assignee select, a Mission select and Remove (asks first). NEW TASK opens the form. No drag and drop; after a move, keyboard focus follows the card.

**Assigning sends a message** (only on assignee change; self-assignment sends nothing): subject `Flight Plan: t3 assigned to you: <title>`, body the detail and assigner, from the Director or the assigning agent (send limit, Redline and hop limit apply). If the agent cannot receive it (stopped, custom command), the task is still assigned with a note.

## Agent tools

In each Claude agent's `--allowedTools`, with one line in its role text.

| Tool | Arguments |
|---|---|
| `task_list` | `mine` (only the caller's), `status`. Most recently changed first, cut like `read_messages` with a count of the rest |
| `task_create` | `title`, `detail`, `assignee`, `missionId` |
| `task_update` | `id`, `status`, `assignee` (`null` unassigns), `note`, `missionId` (`null` unlinks) |

A task can serve one [mission](./missions.md). Any agent may create and update any task (the server stamps the agent); agents cannot change a title or remove a task.

## API

- `GET /api/tasks`
- `POST /api/tasks` `{"title": "Write the spec", "detail": "one page", "assignee": "ana"}` (`detail`, `assignee` optional)
- `PATCH /api/tasks/:id` with `status`, `assignee` or `note`
- `DELETE /api/tasks/:id`

The list is also in the state and in a `tasks` WebSocket frame.
