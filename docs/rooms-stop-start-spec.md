# Stop and start a room from the rooms page: the routes

Status: proposal; GUIDO has answered the open decisions (below); RSO still has to review the security section. Order of work once the direction is approved: supervisor routes, step-up and tests (GUIDO), then the page keys (CONTROL). Nothing here is built. Written by CONTROL (task t106) for the rooms page in `docs/ui-semantic.md`, "The rooms page".

## What the page needs

Each room card shows a state (`starting`, `running`, `stopped`, `crashed`; already in `RoomView`). The Director wants a **Stop** and a **Start** on a card, and **Stop all** and **Start all** in the header. Today the supervisor has `halt(child)` and `launch(child)` inside (`src/server/supervisor.ts`), and `wanted` and the entry's `autostart` say whether a room is meant to run; there is no route that calls them.

## Routes

All of them are the supervisor's own (reserved, never proxied: `/api/rooms` is already in the reserved list of `roomproxy.ts`). Each is behind the Director's login, checks `originOk(req)` like the other write routes, and answers with the room's `RoomView`.

| Route | What it does | Answer |
|---|---|---|
| `POST /api/rooms/<id>/stop` | `halt(child)`: `wanted = false`, cancel a restart timer, SIGTERM then SIGKILL after `STOP_WAIT_MS`. The room's agents stop with it (the room's process owns them). Does not change `autostart`. | 200 `RoomView` once the process has exited (or 202 when it is still stopping after a few seconds, with `state: 'stopping'` shown as `running`). 409 if the room is already `stopped`. 404 for an unknown id. |
| `POST /api/rooms/<id>/start` | `wanted = true`, reset `failures`, `launch(child)`. | 200 `RoomView` (state `starting`). 409 if it is `starting` or `running`. 404 unknown. |
| `POST /api/rooms/stop-all` | `stop` for every room that is not `stopped`, **except** `main` while an update is running or a migration is pending (see below). | 200 `{ stopped: string[], skipped: { id, why }[] }`. |
| `POST /api/rooms/start-all` | `start` for every `stopped` or `crashed` room. | 200 `{ started: string[], skipped: { id, why }[] }`. |
| `PATCH /api/rooms/<id>` `{ autostart: boolean }` (extends the existing rename) | Whether the room starts when the server starts. | 200 `RoomView`. |

`RoomView` gains `autostart: boolean` (it is in `RoomEntry` already) so the card can show "starts at boot" and its tick.

## Decisions (GUIDO's answers, read and agreed)

1. **Persistence.** `stop` and `start` change `wanted` only; `autostart` stays the "starts at boot" flag (the PATCH). `wanted` lives in memory, so after a supervisor restart a stopped room comes back if and only if `autostart` is true. The page says so on a stopped card ("stopped until the next restart"). A "also do not start at boot" tick in the stop confirm is left out of the first version.
2. **Stopping `main`.** Allowed, with a confirm that says it also stops the Telegram poll, auto-update and the update hook. Refused with 409 while a migration is `moving` or `undoing` (`main-migration.json`) and while a Docker update is running or handed off (asked through the existing `gonogo-ask busy` pipe, which also answers the poll and static-fire rule).
3. **A `crashed` room.** `start` clears the restart timer, resets `failures`, launches at once; `lastError` stays until the new run is ready (it clears on ready already).
4. **The "all" routes** are not atomic; they answer `{ done, skipped: [{ id, why }] }`. `halt()` resolves when the process exits, so `stop` answers 202 after about 5 s when the room is still stopping (the grace is `STOP_WAIT_MS`, long).

## Security (for RSO)

- **Keys.** `roomsApi` is behind `authHttp.grant('api')` then `keyMayDo(scope, method, path)`. A `full` key may do any `/api` path except `/api/auth`, so it **can** call these routes (and `DELETE /api/rooms/<id>` today); `write` and `read` keys cannot. Open for RSO: keep full keys allowed (consistent with DELETE; GUIDO's lean) or refuse keys on `stop` and `stop-all`, since a route that stops every agent of every room is more than "full" of one room.
- **Step-up.** `DELETE /api/rooms/<id>`, rename and add are **not** in `stepup.ts` today. Proposed (GUIDO's preference): step-up for `stop`, `stop-all`, `start-all` **and** DELETE in the same change, none for `start`; sessions only (keys have no step-up). The supervisor's own routes call `authHttp.stepUpNeeded` themselves (see `migrateApi`): the new routes must do the same; the room proxy's check does not cover them. A `tui` grant is told to do it in the browser.
- **Origin.** The same `originOk` check; no CORS.
- **Agents.** On the supervisor port an agent's token is a 401 (it is not a grant), and a room's own token never reaches the supervisor.

## Tests the build must have

- Each route on a supervisor with two fake rooms (the existing fake child in the supervisor tests): state before and after, the 404 and 409 answers, `autostart` unchanged.
- `stop-all` skips `main` during a pending migration and says why.
- A session with an old password check gets 403 `stepUp` on `stop`, `stop-all`, `start-all` (and DELETE, if added), and 200 after the check.
- An agent's token gets 401; a `read` or `write` key is refused.
- The rooms page (`roomspage.ts`, inline script with CSP hashes): the new keys are named by what they do ("Stop Docs", "Start Docs", "Stop all rooms"), are 44 px on a phone, and the page does not offer Start on a `starting` or `running` room.

## Not in this spec

A stop timeout setting; stopping one agent of a room (the room's own page does that); the update strip on the rooms page.
