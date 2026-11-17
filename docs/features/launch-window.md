# Launch Window: schedules

LAUNCH WINDOW (top bar, or LAUNCH in the phone bar) lists schedules: a message that gonogo sends by itself on a rule, as
if you typed it into the Brief box. Design and limits: [`docs/launch-window-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/launch-window-spec.md).

- **A schedule** has a name (at most 60 characters), a recipient (FLIGHT, which follows whoever is the boss, or one of
  the consoles that can read mail), an optional subject, the message (at most 20000 characters) and a rule. The
  message arrives from the Director with the subject `Launch Window: <name>: <subject>`, through the same path as the
  Brief box: Max Q, Redline and held mail apply to it. At most 50 schedules.
- **The rule** is five fields, `minute hour day-of-month month day-of-week`, in the time zone of the machine that runs
  gonogo (`TZ`). Each field takes `*`, numbers, ranges (`9-17`), lists (`mon,wed`) and steps (`*/15`, `10-50/10`). Months
  can be `jan` to `dec`, days of week `sun` to `sat` (or 0 to 7, both ends are Sunday). When both day fields are
  limited, either one fires: `0 0 13 * fri` is every 13th and every Friday. Examples: `0 9 * * mon-fri` (weekdays at
  09:00), `30 8 1 * *` (the first of the month at 08:30), `*/20 * * * *` (every 20 minutes). The form shows the next
  three fire times as you type, or why the rule is not one. No `@daily`, no seconds.
- **Each row** shows the next fire in words (`in 3 h, 09:00 Mon`, or `off`), the last run with what the hub answered
  (`sent m12: queued`, `sent m13: held (...)`, `undelivered m14: ...`, `not sent: unknown recipient "ana"...`), an
  Enabled switch, **RUN NOW** (sends at once, also when it is off), **EDIT** and **DELETE** (which asks first).
- **Missed fires** are not replayed. If gonogo was down, or the machine slept, at a fire time, nothing is sent late
  (while gonogo runs, a fire up to a minute late still goes); the start logs one line naming the schedules that missed
  one. A schedule follows a name: after you rename a console, edit the schedule, or its runs end as `not sent`.
- **Time zones.** Rules run in the server's zone. This page shows times in the browser's zone and says so when the two
  differ; the next fire in a row is the server's instant, so it is right in any zone, but the preview of a rule in the
  form is worked out in the browser's zone.
- **API.** `GET /api/schedules`, `POST /api/schedules` with `{"name": "Standup", "to": "boss", "subject": "status",
  "body": "Where are you?", "rule": "0 9 * * mon-fri"}` (`enabled` defaults to true), `PATCH /api/schedules/:id` with the
  fields to change, `DELETE /api/schedules/:id`, `POST /api/schedules/:id/run`. The list is also in the state and in a
  `schedules` frame on the WebSocket.
