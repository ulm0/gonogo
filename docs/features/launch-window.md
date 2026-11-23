# Launch Window: schedules

<LaunchWindowMock class="doc-mock" />

LAUNCH WINDOW (top bar, or LAUNCH in the phone bar) lists schedules: messages gonogo sends on a rule, as if typed into the Brief box, and the History of what fired by itself or came in. The same schedules are a row of Flight Rules (Automation and connections), where [Uplink](./uplink.md), [Relay](./relay.md) and [Docking](./docking.md) are too. Design: [`docs/launch-window-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/launch-window-spec.md).

## A schedule

| Field | Limit |
|---|---|
| Name | up to 60 characters |
| Recipient | FLIGHT (follows the current boss) or a console that can read mail |
| Subject | optional; arrives as `Launch Window: <name>: <subject>` from the Director |
| Message | up to 20000 characters |
| Rule | cron, below |

At most 50 schedules. Max Q, Redline and held mail apply.

**Rule:** five cron fields `minute hour day-of-month month day-of-week`, in the server's time zone (`TZ`). Fields take `*`, numbers, ranges (`9-17`), lists (`mon,wed`), steps (`*/15`, `10-50/10`); months `jan` to `dec`; days `sun` to `sat` or 0 to 7 (both Sunday). If both day fields are limited, either fires (`0 0 13 * fri` = every 13th and every Friday). Examples: `0 9 * * mon-fri` (weekdays 09:00), `30 8 1 * *` (the 1st at 08:30), `*/20 * * * *` (every 20 minutes). No `@daily`, no seconds. The form previews the next three fires (in the browser's zone) or the error.

**Rows** show the next fire (`in 3 h, 09:00 Mon`, or `off`), the last run and the hub's answer (`sent m12: queued`, `sent m13: held (...)`, `undelivered m14: ...`, `not sent: unknown recipient "ana"...`), an Enabled switch, **RUN NOW** (sends at once, even when off), **EDIT**, **DELETE**, and a History link.

## Limits

- **Missed fires are not replayed** (gonogo down, machine asleep); up to a minute late still fires. The start logs the schedules that missed one.
- Schedules follow a console name: after a rename, edit the schedule or its runs end as `not sent`.
- Row times show in the browser's zone (the page says when it differs from the server's); a row's next fire is exact in any zone.

## API

- `GET /api/schedules`
- `POST /api/schedules` `{"name": "Standup", "to": "boss", "subject": "status", "body": "Where are you?", "rule": "0 9 * * mon-fri"}` (`enabled` defaults to true)
- `PATCH /api/schedules/:id` with the fields to change
- `DELETE /api/schedules/:id`
- `POST /api/schedules/:id/run`

The list is also in the state and in a `schedules` WebSocket frame.

## History

The **History** tab lists every run of every schedule, and every webhook, polled Telegram message and Docking call: [History of triggers](./triggers.md).
