# Launch Window: schedules

<LaunchWindowMock class="doc-mock" />

LAUNCH WINDOW (top bar, or LAUNCH in the phone bar) lists schedules: messages gonogo sends on a rule, as if typed into
the Brief box. Design and limits: [`docs/launch-window-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/launch-window-spec.md).

- **A schedule** has a name (at most 60 characters), a recipient (FLIGHT, which follows the current boss, or a console
  that can read mail), an optional subject, the message (at most 20000 characters) and a rule. It arrives from the
  Director with the subject `Launch Window: <name>: <subject>`; Max Q, Redline and held mail apply. At most 50 schedules.
- **The rule** is cron's five fields, `minute hour day-of-month month day-of-week`, in the server's time zone (`TZ`).
  Fields take `*`, numbers, ranges (`9-17`), lists (`mon,wed`) and steps (`*/15`, `10-50/10`); months `jan` to `dec`,
  days `sun` to `sat` or 0 to 7 (both ends Sunday). If both day fields are limited, either fires: `0 0 13 * fri` is every
  13th and every Friday. Examples: `0 9 * * mon-fri` (weekdays 09:00), `30 8 1 * *` (the 1st at 08:30), `*/20 * * * *`
  (every 20 minutes). No `@daily`, no seconds. The form previews the next three fire times, or the error.
- **Each row** shows the next fire (`in 3 h, 09:00 Mon`, or `off`), the last run and the hub's answer (`sent m12: queued`,
  `sent m13: held (...)`, `undelivered m14: ...`, `not sent: unknown recipient "ana"...`), an Enabled switch, **RUN NOW**
  (sends at once, even when off), **EDIT** and **DELETE**.
- **Missed fires** are not replayed: if gonogo was down or the machine slept, nothing is sent late (up to a minute late
  still fires). The start logs the schedules that missed one. Schedules follow a console name: after a rename, edit the
  schedule or its runs end as `not sent`.
- **Time zones.** The page shows times in the browser's zone and says when it differs from the server's. A row's next fire
  is exact in any zone; the form's preview uses the browser's zone.
- **API.** `GET /api/schedules`, `POST /api/schedules` with `{"name": "Standup", "to": "boss", "subject": "status",
  "body": "Where are you?", "rule": "0 9 * * mon-fri"}` (`enabled` defaults to true), `PATCH /api/schedules/:id` with the
  fields to change, `DELETE /api/schedules/:id`, `POST /api/schedules/:id/run`. The list is also in the state and in a
  `schedules` frame on the WebSocket.

## History

The **History** tab at the top of this view lists every run of every schedule, and every webhook, polled Telegram message and Docking call, newest first, with filters: see [History of triggers](./triggers.md). A schedule's own row has a History link.
