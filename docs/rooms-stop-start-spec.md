# Stop and start a room from the rooms page: the routes

Status: proposal for GUIDO to design and RSO to review. Nothing here is built. Written by CONTROL (task t106) for the rooms page in `docs/ui-semantic.md`, "The rooms page".

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

## Decisions for GUIDO

1. **Is `stop` persistent?** Proposed: `stop` and `start` change `wanted` only, so a restart of the server starts the room again if `autostart` is true. "Starts at boot" is the PATCH above. Say if a stop should also clear `autostart`.
2. **Stopping `main`.** It runs the auto-update and carries the Director's login for the supervisor's pages. Proposed: allowed, with the page warning "this also stops updates" in the confirm; refused (409) while `gonogo-ask busy` says a poll or static fire is open elsewhere, and while a main migration is `moving` or `undoing`.
3. **Starting a room whose last start failed.** `crashed` rooms have a restart timer (`failures` backoff). `start` should clear it and launch at once; it should not hide the last error (`lastError`).
4. **The "all" routes are not atomic.** They answer with what was done and what was skipped; the page shows both.

## Security (for RSO)

- These routes stop and start processes that run agents with the user's rights, and `stop` kills work in progress. They are as sensitive as `DELETE /api/rooms/<id>`, which has no step-up today; **proposed: a step-up** (the Director's password again, `src/server/stepup.ts`, the same table the migrate route is in) for `stop`, `stop-all` and `start-all`, none for `start`, because starting is what the server does at boot anyway. State this in `stepup.ts` so the page's existing step-up dialog handles the 403 `stepUp` answer.
- API keys: `stop`, `start`, `stop-all`, `start-all` should be **refused for a key with scope below `admin`** (they are write routes of the supervisor, as `POST /api/rooms`). Say which scope that is in `src/server/clearance.ts`.
- Origin: the same `originOk` check; no CORS.
- No agent can call these: the room's own routes and tools do not reach the supervisor's `/api/rooms`. A test should show that an agent's token gets 403.

## Tests the build must have

- Each route on a supervisor with two fake rooms (the existing fake child in the supervisor tests): state before and after, the 404 and 409 answers, `autostart` unchanged.
- `stop-all` skips `main` during a pending migration and says why.
- A session with an old password check gets 403 `stepUp` on `stop`, `stop-all` and `start-all`, and 200 after the check.
- A key without the scope gets 403; an agent's token gets 403.
- The rooms page (`roomspage.ts`, inline script with CSP hashes): the new keys are named by what they do ("Stop Docs", "Start Docs", "Stop all rooms"), are 44 px on a phone, and the page does not offer Start on a `starting` or `running` room.

## Not in this spec

A stop timeout setting; stopping one agent of a room (the room's own page does that); the update strip on the rooms page.
