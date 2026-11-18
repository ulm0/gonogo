# Flight Plan: tasks

<FlightPlanMock class="doc-mock" />

FLIGHT PLAN (top bar, or PLAN on a phone) is a task board shared by you and the agents. Design and limits:
[`docs/flight-plan-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/flight-plan-spec.md).

## Tasks

- Title (at most 200 characters, one line), detail (at most 4000; what done means), status, assignee (an agent or nobody), creator, and a history line per change (UTC time, who).
- Status: `todo`, `doing`, `review`, `done` or `blocked`; any status can move to any other.
- Ids: `t1`, `t2`, ...
- At most 500 open tasks (not `done`). The 100 most recently changed `done` tasks are kept; older ones are dropped.
- Tasks follow the name: after you rename a console, its tasks stay under the old name.

## The page

Columns TODO, DOING, REVIEW, BLOCKED, DONE (stacked on a phone). A card shows id, assignee light and call sign, and title; a fold opens detail and history. Each card has a key per other column, an assignee select, and Remove (asks first). NEW TASK opens the form. No drag and drop; after a move, keyboard focus follows the card.

## Assigning sends a message

Subject `Flight Plan: t3 assigned to you: <title>`, body the detail and assigner. Sent from the Director, or from the assigning agent (send limit, Redline and hop limit apply). Only on assignee change; self-assignment sends nothing. If the agent cannot receive it (stopped, or custom command), the task is still assigned with a note.

## Agent tools

In each Claude agent's `--allowedTools`, with one line in its role text.

- `task_list`: `mine` (only the caller's tasks), `status`. Most recently changed first, cut like `read_messages` with a count of the rest.
- `task_create`: `title`, `detail`, `assignee`.
- `task_update`: `id`, `status`, `assignee` (`null` unassigns), `note`.

Any agent may create and update any task; the server stamps the agent. Agents cannot change a title or remove a task.

## API

- `GET /api/tasks`
- `POST /api/tasks` with `{"title": "Write the spec", "detail": "one page", "assignee": "ana"}` (`detail`, `assignee` optional)
- `PATCH /api/tasks/:id` with `status`, `assignee` or `note`
- `DELETE /api/tasks/:id`

The list is also in the state and in a `tasks` WebSocket frame.
