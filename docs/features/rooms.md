# Rooms: gonogo is a supervisor and one process per room

<RoomsMock class="doc-mock" />

**Rooms are not file-isolated.** Every room is a gonogo process of its own, so rooms do not share memory, mail, tokens, tools or
crashes. But they all run as **your operating-system user**, and an agent that does not run in a Clean Room can read every file of
every room (and of your home folder). The isolation is at gonogo's API, not at the file system. The same holds inside a container:
one room's agent can reach the Docker socket, if you mounted it, as it can today. The files that run the rooms (`rooms.json`, `rooms/<id>/` and `token` (the Director token)) are in main's home, so main's agents can read them, the Director token included. Use a Clean Room for an agent that must not see
the other rooms. Design: [`docs/rooms-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/rooms-spec.md).

## What it is

**`gonogo` always starts the supervisor** (0.5.0: there is no second mode). It serves one port and runs **one ordinary gonogo per room**, each with its own
home and a loopback port of its own (the hidden `gonogo __room`, not for you to start). With one room, you see the same address, the same token
and the same page as before; there is just one more process in front.

- **Main** is today's home: nothing moves. It answers at `/`, **and** at `/r/main/` (the same room). Your old webhook addresses
  (`/uplink/<id>`), docking links and scripts that call `/api` keep working. Other rooms are at `/r/<id>/` and live in `<home>/rooms/<id>/`, starting from
  zero (roster, mail, Flight Plan, Plot Board, Mission Log, Black Box, missions and every setting are per room). Main's home is the root folder,
  which also holds `token`, `rooms.json` and `rooms/<id>/` for the others.
- **The list of rooms** is at `/rooms` (and **Rooms** in the Patch Panel, Cmd+K). The names the front port keeps for itself, never a room's:
  `/r/`, `/rooms` (the list, `/rooms/health`, `/rooms/assets/`), `/api/rooms` and `/internal/`. `rooms add` refuses the ids `r`, `ws`, `internal`,
  `api`, `assets`, `rooms` and `main`.
- **Shared by inheritance**: the binary and its update, and the environment of the supervisor (`CLAUDE_CONFIG_DIR`, the agent CLIs' logins, `gh`'s
  config, `GONOGO_*` flags). **Not shared**: the price table, Clearance keys, Max Q (each room counts its own working agents) and Propellant.
- `--port`, `--host` and `--allow-host` are the **front port**'s; `--pty-host` and `--no-update-check` are passed on to the rooms. A room listens on
  `127.0.0.1`, on the same port again after a restart (`run/port`), so agents that survive a reload keep the address they were started with.
- The word on the printed line is plain: `gonogo ready: http://127.0.0.1:7777/#token=...`. `gonogo rooms` alone is the same as `gonogo`, kept for one release.

## Use it

```
gonogo                                    # the supervisor: the front port and every room
gonogo rooms add team --name "Team B"     # a room id is a-z, 0-9 and dashes, at most 24 characters
gonogo rooms list
gonogo rooms remove team                  # takes it off the list; its folder stays
gonogo token rotate                       # a new Director token; the old one stops working
```

`add` and `remove` edit `<home>/rooms.json`; the running gonogo notices within 2 seconds, starts the new room or stops the removed one (a graceful
stop: SIGTERM, then SIGKILL after 17 s). A room that crashes is started again after 1, 2, 5, 15, then 30 seconds; a room that cannot start shows
the last error gonogo printed in its row (for example that another gonogo holds its home: **a plain gonogo of 0.4 left running on the same home holds
its lock**, stop it first). At most 12 rooms: each is a Node process (and a pty host with `--pty-host`), so count tens of megabytes each. If `rooms add` or `remove` finds no gonogo
running for the home it says so: nothing acts on `rooms.json` unless gonogo runs.

**A damaged `rooms.json`** is not read as "no rooms": gonogo logs it, keeps every room as it is, and reads the file again once it is fixed.
**One supervisor per home** (`run/supervisor.lock`). **If the supervisor is killed**, each room sees the pipe it was started with close and shuts down
gracefully, so no room is left on a port nobody knows.

### Reload

`gonogo reload` (and the Reload key) signals the supervisor, which tells every room to hand its agents to its pty host and leave, then lets go of the port
and starts the installed gonogo again, with the same arguments: the front port is down for a few seconds, the pages reconnect, and with `--pty-host` the
agents keep running. It only signals a process that really is this gonogo's supervisor (a stale lock whose number another program took is reported, never
signalled). **In Docker it is refused** (the supervisor is the container's only child, and starting it again would end the container): update with the
Update key or `docker compose pull && docker compose up -d`. Reload per room is not built.

## The list page

Open the printed address and go to `/rooms`. The list page is dressed like the app: the top bar with the logo, the version corner in the bottom right and the livery you chose (it reads the one the room pages keep in this browser; a browser that never opened a room shows the default). It takes its styles from the built client, so without a build it falls back to plain ones. Each room is a card like a console tile of the Room view: a light (green running, amber blinking when something needs you, red when it crashed, dim when stopped), its name, a state word (the light is never the only sign), the agents running of all, how many need you and how many are working, the last activity, the tab name when one is set, and `r/<id>`. A crashed room shows its reason. OPEN goes to `/r/<id>/` (a key that cannot be pressed while the room is not running). The room's name is the one you gave it, else its id; main is called Main. With only main, the page offers a new room. In a room,
**Rooms** in the Patch Panel (Cmd+K) goes back to the list.

### Clean Room

A room listens on loopback only. A Clean Room container reaches it through gonogo's own network when gonogo runs in Docker, and through
`host.docker.internal` on Docker Desktop (macOS, Windows: **not tried**). **On Linux with gonogo outside a container a Clean Room start is refused**
with a message: it only worked before by running `--host 0.0.0.0`, which is no longer the room's address. A bridge listener is the follow-up if people
need it.

## Add, rename and remove from the page

The list page has a **NEW ROOM** key (top bar) that opens a form with an id and, if you want one, a name; and, on every room but main, **RENAME** (the name becomes a field in the card; Enter saves, Escape cancels) and **REMOVE**. REMOVE
asks first, in the card (focus lands on KEEP), and says that the room's folder stays: it only takes the room off the list and stops it (its agents stop gracefully, as in
`gonogo rooms remove`). The same calls are on the supervisor's own port, for scripts: `GET /api/rooms`, `POST /api/rooms` `{ "id", "name"? }`,
`PATCH /api/rooms/<id>` `{ "name" }` and `DELETE /api/rooms/<id>`, with a session (and this page's Origin), a `full` API key, the local socket, or on a fresh install the Director token, a JSON
body of at most 4 KB, and an Origin that is this server's own when there is one. A bad id or name is 400, main is refused (400), a
room that exists or too many rooms is 409, an unknown room is 404, and a damaged `rooms.json` is 409 and is left untouched. The file is
written the way the command line writes it (0600, atomically), and the supervisor starts or stops the room at once.

## Tokens

Who may reach the front port is decided by the [login](./login.md): a session cookie, an API key, or the local unix socket `<home>/run/api.sock`. On an install that has never had an account the old **Director token** (`<home>/token`, 0600, the value your home already has) still does it, and opens **every** room; the account's creation deletes it for good (`gonogo token rotate` is for that fresh install only). The proxy asks the login who the request is and reaches the room over **its own unix socket**, `<room home>/run/room.sock`: **a room has no TCP credential for its page** (no token, no `run/room-token`), so a connection aimed at a room's port gets nothing, and agent tokens never leave their room. The supervisor strips every `Set-Cookie` from a room's answer and puts its own CSP on a room's pages. `gonogo tui` opens main through the socket, and another room with `--room <id>`.

What the proxy lets through under `/r/<id>/` and, for main, at the root (any path that is not reserved):

| Path | Without the Director token | With it |
|---|---|---|
| the page and its assets (GET, HEAD) | passes, with no Authorization | passes |
| `/api`, `/ws` | 401 | passes (the room sees no credential) |
| `/uplink/`, `/dock/` (webhooks, other stations) | passes, no Authorization added; the room checks the signature | same |
| `/hook/`, `/mcp` | 404 | 404: agents use the loopback port of their own room |
| a path with `..`, an encoded slash or dot, a backslash or a NUL | 400 | 400 |
| a room that does not exist or has a bad id | 404 | 404 |
| a room that is not running | 503 | 503 |

The path is decoded once and the reserved-name check and the path check run on that same text, case exact (`/%72ooms`, `//internal/busy`, `/r%2Fmain/x` never reach main). Host and Origin are checked as a room checks them, then rewritten to the room's loopback address. Cookies and `X-Forwarded-*` headers are dropped from the request, and **`Set-Cookie` from every answer**: a room can never set a cookie on the address all the rooms share. A redirect of a room under `/r/<id>/` stays under that prefix; main at `/` gets none.

## Webhooks, phone approvals, notifications

Each room has its own Uplinks, so its own address: main's is `https://<host>/uplink/<id>` as before, the others' `https://<host>/r/<room>/uplink/<id>`. The Relay and Uplink pages show that address.
**One Telegram bot has one webhook**, so each room that uses Telegram needs its own bot. The signed approval buttons are per room (the
tag uses the room's own Uplink secret), so a button of one room cannot approve a request of another. The browser keeps one stored
token and one set of look settings per address, so these are shared by the rooms of one server.

## What was seen

**With 0.4 (`gonogo rooms`, 2026-11-18).**

Two rooms (`main`, `team`) behind one port, `ana` hired in both: each room listed its own `ana`, with its own home in the state; the same
API call through `/r/team/` and `/r/main/` returned different homes; a WebSocket to `/r/team/ws` opened with the Director token and its
first frame was team's state; the page and its icon loaded under `/r/team/`; without a token the API was 401 and `/hook/` was 404.
`kill -9` of the team's process: the room list showed it running again on a new port after 1 s, and `main` never stopped. SIGTERM of
the supervisor stopped both rooms and released both home locks.

`kill -9` of the supervisor: both rooms and their agents were gone 6 s later, no lock left, and a new `gonogo rooms` started both clean.

**With the single mode (2026-11-18, a built gonogo with the stand-in agent):** `gonogo --home <dir>` started the supervisor and main; `/`, `/api/state`, `/r/main/api/state`
answered alike, `/rooms` and `/rooms/health` were the supervisor's, `/hook/x` and `/internal/busy` were 404, `//internal/busy` 400, the room's token was not accepted on the
front and the Director token was not accepted by the room; `gonogo token rotate` made the old token 401 at once in the running gonogo. `gonogo reload` was refused here because this
machine's shell is itself in a container; the hand-over is covered by tests with stand-in rooms.

## Not built, not tried

Host-name routing (`a.localhost`), a room switch key inside `gonogo tui` (`--room` picks it at start), per-room reload, a machine-wide Max Q, shared
price tables or keys, a start/stop key per room in the page, moving an agent between rooms, deleting a room's folder, and a warning
when two rooms hire the same working folder. Rooms in Docker with the Docker socket, a real Telegram bot and a browser were not tried
(there was no browser here; the list page and the base-path code are tested, not seen).
