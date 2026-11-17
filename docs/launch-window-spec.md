# Spec: Launch Window

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): schedules that start
work by themselves, the equivalent of Munder Difflin's 24x7 schedules.

## Intent

The Director wants the same brief sent every weekday at 09:00, or a report asked for on the first of the month, without
opening the tab. A schedule is a message written once and sent by gonogo on a cron rule, as if the Director typed it into
the Brief box. Nothing else is new: the agent that gets it works as it always does.

## Design

- **A schedule** is `{ id, name, to, subject, body, rule, enabled, createdAt, lastRunAt, lastResult }` (`Schedule` in
  `src/shared/protocol.ts`). `id` is `s1`, `s2`, ... and is not used twice in one run of the server. `to` is an agent
  name or `boss` (which follows whoever is the boss). Browsers get `ScheduleView`, the same plus `nextAt`, the next fire in
  ms (null when it is off or never comes). `createdAt` is not in the brief but is needed: it is the starting point for
  finding fires missed by a schedule that never ran.
- **The file** is `~/.gonogo/schedules.json`, `{ "version": 1, "schedules": [...] }`, mode 0600, written whole through a
  temporary file and a rename after every change (`src/server/schedules.ts`). Message bodies are stored in plain text.
  A file that cannot be read (bad JSON, not version 1) is renamed `schedules.json.bad` and the server starts with none, so
  the next save cannot overwrite it. One bad record is skipped with a warning and the rest load.
- **The rule** is five fields, minute hour day-of-month month day-of-week, in `src/shared/cron.ts`, a module with no
  imports that the server and the client both compile, so the form and the server agree on every rule. Each field takes
  `*`, numbers, ranges `a-b`, lists with commas and steps (`*/n`, `a-b/n`); months take `jan` to `dec` and days of week
  `sun` to `sat` in any case; day of week 7 is Sunday. When both day fields are limited a day matches when either does;
  when one starts with `*`, both must (Vixie cron). A rule that can never fire (31 February) is refused at the parser.
  It is evaluated in the local time zone of the process (`TZ`): `nextFire` walks months, days, hours and minutes, so a
  rule that is years away (29 February) costs a few hundred steps.
- **Firing** is `Hub.sendFromUser`, the path of the Brief box, so Max Q, Redline and held mail apply as to any message
  of the Director. The subject is `Launch Window: <name>: <subject>`, or `Launch Window: <name>` when the subject is
  empty (`scheduleSubject`). `lastRunAt` is the time of the try and `lastResult` one line: `sent m12: queued`, `sent m13:
  held (<note>)`, `undelivered m14: <note>` or `not sent: <message>` when the hub refused (an agent that no longer
  exists). A refused or held fire is not retried; the next fire is the next one of the rule.
- **The clock** is injected like the hub's (`now`, `setTimer`, `clearTimer`), so tests use a fake one. One timer runs on
  the minute (`60000 - now % 60000`) and starts again; it fires what is due. A timer that fires a millisecond early finds
  nothing due and waits out the millisecond. A fire more than 60 s late (the machine slept, the event loop stalled) is
  skipped and logged, never replayed.
- **Missed fires.** At start, a schedule that is on and has a fire between its last run (or its creation) and now is
  named in one warning (also a fire a few seconds before the start: the grace of 60 s is for a running timer only): `launch window: fires were missed while gonogo was down (a, b); missed fires are
  not replayed`. Nothing is sent for them.
- **Routes** (`web.ts`, browser token only): `GET /api/schedules`, `POST /api/schedules` (201), `PATCH /api/schedules/:id`
  (200, only the fields given change), `DELETE /api/schedules/:id` (204), `POST /api/schedules/:id/run` (200 with the
  view; a refusal of the hub is in `lastResult`, not in the status, because the schedule itself is fine). A bad field is
  400 with its name, an unknown id 404, the 51st schedule 409. Limits: 50 schedules, a name of 60 characters on one line,
  a rule of 100, a body of 20000, and name plus subject at most 183 characters, so the whole subject fits the hub's 200.
  Unknown fields are refused. `to` is checked for its shape (`boss` or an agent name, never `user`), not for existing:
  the form offers only consoles that can read mail, and the hub says at the fire if one is gone.
- **Frames.** `schedules` carries the whole list and is sent at every change, fire and Run now; `StateSnapshot.schedules`
  has it at connect. `ServerInfo.timeZone` is the server's IANA zone name.
- **The screen.** A LAUNCH WINDOW key in the top bar (wide screens) and a LAUNCH key in the phone bottom bar (four keys
  of 87 px at 390 px; the key's accessible name is `Launch Window`) open the view (`store.view === 'window'`,
  `LaunchWindow.tsx`, `launch.ts` for what can be tested without a DOM, `launch.css`). Each row has the name, the
  recipient, the rule, the next fire on an LCD in words (`in 3 h, 09:00 Mon`; `off`; `never`), the last run, an
  Enabled switch (a checkbox with role `switch`), Run now, Edit and Delete (which asks inline, with focus on Keep). The
  form has name, recipient, subject, message, rule and an On box; under the rule it shows the next three fire times as
  you type, or why the rule is not one, and the form shows what the subject will read like.
- **Zones.** The preview and the times in the list are in the browser's clock; the rules run in the server's. When the
  two zones differ the page says so in one line. The list's `nextAt` is the server's instant, so it is right in any zone;
  only the preview of a rule is computed in the browser's.

## Rejected

- `@daily` and the other aliases, a seconds field, `L` and `W` day markers, `?`: five plain fields were asked for and
  cover what a person types.
- Replaying missed fires, or a "run once on start if missed" option: a message sent late is often a wrong message (the
  brief of 09:00 at 14:00), and the Director can press Run now.
- A zone per schedule: one installation, one person, one zone; `TZ` sets it.
- Checking `to` against the roster at creation: agents come and go, and the answer at the fire is the one that counts.

## Known limits

- shortcut: a time that does not exist (the hour a clock skips in spring) does not fire that day, and one that happens
  twice (autumn) fires once; Vixie cron runs the first late. Add that if it ever matters.
- shortcut: a schedule that was off for a while and is on again reports "missed" at the next start if its rule would
  have fired meanwhile; track when it was turned off if the log line confuses.
- The wall's MISSION shows the subject of the latest message to FLIGHT, so a scheduled message to the boss becomes the
  mission and restarts its clock.
- shortcut: `to` is a name, so a schedule does not follow a renamed console; its fires end as `not sent: unknown
  recipient` until it is edited. Key by record id if renames get common. A schedule to a removed console stays too.
- Ids are not used twice in one run, but after a restart the highest one removed before it can come back.
- Two schedules on the same minute send two messages; nothing merges them.
- A rule that fires every minute is accepted. Max Q and Redline limit what agents do with the mail, not how much of it
  there is.
- Tested with a fake clock, the stand-in agent and a real server: the timer was never watched across a real minute
  boundary, nor across a real sleep of the machine or a clock change. A schedule to an agent was seen reaching the
  stand-in and being read. Not run with a real `claude`.
- The page was opened in Chrome only, at 1280 px, in a 500 px window and in Chrome's 390 px phone emulation (no
  horizontal overflow, keys of at least 44 px); not in Firefox or Safari, and not with a screen reader.
