# Flight Plan: tasks

FLIGHT PLAN (top bar, or PLAN in the phone bar) is a task board that you and the agents share. Design and limits:
[`docs/flight-plan-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/flight-plan-spec.md).

- **A task** has a title (at most 200 characters, one line), a detail (at most 4000; what done means), a status, an
  assignee (an agent, or nobody), who made it (you, or an agent) and a history of one line per change, each with the
  time (UTC) and who did it. The status is `todo`, `doing`, `review`, `done` or `blocked`, and a task can go from any
  status to any other. Ids are `t1`, `t2`, ... At most 500 open tasks (any status but `done`); the 100 `done` tasks changed
  most recently are kept and older ones are dropped.
- **The page** has five columns, TODO, DOING, REVIEW, BLOCKED and DONE, which stack on a phone. A card shows its id, the
  light and call sign of its assignee, and the title; a fold opens the detail and the history. Each card has a key for
  every other column, a select that gives it to an agent (or to nobody), and Remove, which asks first. NEW TASK opens
  the form. There is no drag and drop. After a card moves, the keyboard goes to it in its new column.
- **Giving a task to an agent sends it a message**: subject `Flight Plan: t3 assigned to you: <title>`, body the detail and
  who gave it. From you it is a message from the Director; from an agent it is a message from that agent, so the send limit,
  Redline and the hop limit apply to it. It is sent when the assignee changes, not when you give it to the one who has it
  already, and an agent that gives a task to itself sends nothing. If the agent cannot get the message (it is stopped, or
  it runs a custom command) the task is still given and a note on it says so.
- **The agents' tools.** `task_list` takes `mine` (only the tasks given to the caller) and `status`, and answers with the
  tasks most recently changed first, cut like `read_messages` with a count of what is left. `task_create` takes `title`,
  `detail` and `assignee`. `task_update` takes `id` and `status`, `assignee` (`null` takes the task from its holder) and
  `note`. Any agent may create and update any task; the server stamps the agent. An agent cannot change a title or remove
  a task. The role text each Claude agent gets says one line about them, and they are in its `--allowedTools`.
- **API.** `GET /api/tasks`, `POST /api/tasks` with `{"title": "Write the spec", "detail": "one page", "assignee": "ana"}`
  (`detail` and `assignee` are optional), `PATCH /api/tasks/:id` with `status`, `assignee` or `note`, and
  `DELETE /api/tasks/:id`. The list is also in the state and in a `tasks` frame on the WebSocket. A task follows a name:
  after you rename a console, its tasks stay under the old name.
