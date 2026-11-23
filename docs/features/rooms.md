---
description: "Run several separate rooms, each with its own agents, mail and settings, behind one address: the list of rooms, adding and removing them."
---

# Rooms: gonogo is a supervisor and one process per room

<RoomsMock class="doc-mock" />

Run several separate gonogos (own agents, mail, settings) behind one port.

**Rooms are not file-isolated.** Each room is its own process (no shared memory, mail, tokens, tools or crashes), but all run as your OS user. An agent outside a Clean Room can read every file of every room and your home folder, and in a container reach the Docker socket if mounted. `rooms.json`, `rooms/<id>/` and `token` (the Director token) sit in main's home, so main's agents can read them. Use a Clean Room for an agent that must not see other rooms. Design: [`docs/rooms-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/rooms-spec.md).

## What it is

`gonogo` always starts the supervisor: one front port, one ordinary gonogo per room (hidden `gonogo __room`, not for you to start), each with its own home and loopback port. `gonogo rooms` alone equals `gonogo`. The ready line is `gonogo ready: http://127.0.0.1:7777/#token=...`.

- **Main** is a room at `/r/main/`. Kept working at the root: `/api/...`, `/ws`, `/uplink/<id>`, `/dock/...`, `/sw.js`, `/manifest.webmanifest`, icons. A GET or HEAD of any other old main path answers **308 to `/r/main/...`** (query kept). Agent hooks use the room's loopback port.
- Other rooms: `/r/<id>/`, home `<home>/rooms/<id>/`, starting from zero (roster, mail, Flight Plan, Plot Board, Mission Log, Black Box, missions, every setting are per room).
- Main's home: `<home>/rooms/main/` on a new install (root holds `auth.json`, `token`, `rooms.json`, `push.json`, `run/api.sock`). A home made before 0.8.2 keeps main's files at the root: gonogo moves it at the next start unless a check says no (see "Moving main of an older install" below); `gonogo rooms list` prints where each lives. `rooms.json` says `"main": { "home": "rooms/main" }` (new homes); no key means old home. Any other value is a damaged file.
- Rolling back to an older build on a new home starts a new empty main at the root and leaves `rooms/main/` intact (nothing lost). Stop it, go forward, delete the root's room files to get the old main back.
- Room list: `/` (and **Rooms** in the Patch Panel, Cmd+K); `/rooms` is 308 to `/`. Reserved front-port names: `/`, `/r/`, `/rooms` (`/rooms/health`, `/rooms/assets/`), `/api/rooms`, `/internal/`. `rooms add` refuses ids `r`, `ws`, `internal`, `api`, `assets`, `rooms`, `main`.
- Inherited, not per room: the binary and its update, the supervisor's environment (`CLAUDE_CONFIG_DIR`, agent CLI logins, `gh` config, `GONOGO_*`). Not shared: price table, Clearance keys, Max Q (each room counts its own working agents), Propellant.
- `--port`, `--host`, `--allow-host` are the front port's; `--pty-host` and `--no-update-check` pass to the rooms. A room listens on `127.0.0.1`, on the same port after restart (`run/port`).

## Use it

```
gonogo                                    # the supervisor: the front port and every room
gonogo rooms add team --name "Team B"     # id: a-z, 0-9, dashes, at most 24 characters
gonogo rooms list
gonogo rooms remove team                  # off the list; its folder stays
gonogo rooms migrate-main --dry-run       # an older install: what would move into rooms/main (--undo moves it back; stop gonogo first)
gonogo token rotate                       # new Director token; the old one stops working
```

- `add` and `remove` edit `<home>/rooms.json`; the running gonogo notices within 2 s and starts or stops the room (SIGTERM, then SIGKILL after 17 s). With no gonogo running for the home they say so.
- A crashed room restarts after 1, 2, 5, 15, then 30 s. A room that cannot start shows the last error in its row (e.g. another gonogo holds its home: a plain gonogo 0.4 left running on the same home holds its lock; stop it).
- At most 12 rooms (each a Node process, plus a pty host with `--pty-host`; tens of MB each).
- A damaged `rooms.json` is not read as "no rooms": rooms stay as they are and it is re-read once fixed.
- One supervisor per home (`run/supervisor.lock`). If it is killed, rooms see their pipe close and shut down gracefully.

### Reload

`gonogo reload` (and the Reload key) makes every room hand its agents to its pty host, frees the port and restarts the installed gonogo with the same arguments. The front port is down a few seconds; with `--pty-host` agents keep running. It only signals a real supervisor of this gonogo (a stale lock reused by another program is reported, not signalled). **Refused in Docker**: use the Update key or `docker compose pull && docker compose up -d`. No per-room reload.

## Stop and start a room

The supervisor has routes for it (the page keys come later). All are the Director's: a login session, or a `full` API key where said; the old Director token and the local socket work too. A `read` or `write` key, an agent and a room get 401 or 403.

| Route | What it does |
|---|---|
| `POST /api/rooms/<id>/stop` | SIGTERM, then SIGKILL after the room's shutdown time. The room's agents, its pty host and their tokens end with it; mail that is queued is on disk and is delivered after the next start. 200 when it has exited, 202 when it is still stopping after 5 s. Asks for the password again. |
| `POST /api/rooms/<id>/start` | Clears a restart wait and the failure count, starts the room at once (200, state `starting`). Does not ask for the password. |
| `POST /api/rooms/stop-all`, `start-all` | The same for every room that can be, answering `{ stopped | started, skipped: [{ id, why }] }`. They are not atomic. Both ask for the password again. |
| `PATCH /api/rooms/<id>` `{ autostart }` | Whether the room starts when gonogo starts. `main` always does. A stop does not change it: a stopped room with autostart on starts again at the next start of gonogo. |

`DELETE /api/rooms/<id>` asks for the password again too.

A stop does not survive a restart of gonogo: a stopped room with autostart on starts again with the next start. To keep a room down, turn its autostart off. The ids `stop-all` and `start-all` are reserved (no new room may have them); a room that already has one of them cannot be renamed or removed through these routes.

A room that does not answer the question whether it is busy (it may be hung) is not stopped: 409 "did not answer". Send `{ "force": true }` in the body of the stop to stop it anyway; the audit line says it was forced. Main is never stopped without an answer. `stop-all` stops the other rooms together, then main last, and does not force.

A stop is refused with 409 while a T-minus poll or Static fire is open in that room, a Relief request waits there, room main is being moved, or (for main) an update runs. One stop or start per room at a time: a second one answers 409 "room x is stopping". An API key may not stop `main` or every room (403): do it in the browser.

Every stop and start is written to the supervisor's log and to the Downlink of room `main`, with who did it and the result. While main is stopped, login alerts and these lines are held (20 of each) and said when it is running again, with a count of what was dropped. Stopping main also stops the Telegram poll, phone approvals, the update hook and auto-update until it starts.

## Folders

Everything gonogo keeps lives in its home (`~/.gonogo`, or the folder you gave with `--home`): one folder per room, `rooms/<id>/`, and room `main` at the root of an older home. Start gonogo from anywhere: where your agents WORK is the room's **project folder**, set apart from that.

- **Default:** the folder gonogo was started in, as always. A room with no project folder behaves exactly as before. Under `gonogo service` that is the user's home directory, and the page shows the broad-folder warning until a folder is set.
- **Set one:** Flight Rules → Room → Project folder, `gonogo rooms add <id> --dir <folder>`, or the folder field of the new-room form. It is the folder the boss starts in and the one the hire form offers as the Working directory (each agent can still choose another).
- **What is accepted:** the whole path of a folder that exists and that gonogo can read; the path kept is the real one (a link is followed when it is set). Nothing is refused by WHERE it is: your project is yours to choose. A folder that is or holds gonogo's own folders comes with the warning "Agents can read and change gonogo's own settings and keys in this folder without asking."; the root, your home directory or a folder that holds it, with "Broad folder: agents can read everything under it." The page shows the warning next to the folder (`warning` in `GET /api/project-folder`). Claude Code still asks its own trust question in such a folder: gonogo records no trust for the home directory, gonogo's home or Claude's configuration folder.
- **Who may:** only the Director's own login session, and it asks for the password again. A key, a terminal login or an agent cannot: agents start in this folder. A change is in the Black Box (who, old → new).
- **When it applies:** to agents that are hired or restarted after the change, and to a boss made after it. A running agent keeps its folder. `GET /api/project-folder` names the boss and the folder it runs in, so the page can offer to restart it (`PATCH /api/agents/<boss>` with the new `dir`, then restart).
- **If it goes away:** a room whose stored folder is deleted, or that no longer has the shape of one (somebody wrote the file by hand), uses the folder gonogo was started in again, and the log says so once. The stored value is checked every time it is read.

State: `<room home>/project-folder.json` (0600).

## The list page

Open the printed address. Each room is a card: a light (green running, amber blinking needs you, red crashed, dim stopped), name (else id; main is "Main"), a state word, agents running of all, how many need you or work, last activity, tab name, `r/<id>`, and the reason if crashed. OPEN goes to `/r/<id>/` (disabled while not running). With only main, the page offers a new room. The ROOMS key in every room's top bar goes back. The page uses the livery of this browser and plain styles without a build.

**NEW ROOM** (top bar) opens a form: id, optional name. On every room but main: **RENAME** (Enter saves, Escape cancels) and **REMOVE** (asks first, focus on KEEP; the folder stays; agents stop gracefully).

Same calls on the supervisor's port, for scripts:

| Route | Body |
|---|---|
| `GET /api/rooms` | |
| `POST /api/rooms` | `{ "id", "name"? }` |
| `PATCH /api/rooms/<id>` | `{ "name" }` |
| `DELETE /api/rooms/<id>` | |

Needs a session (with this page's Origin), a `full` API key, the local socket, or on a fresh install the Director token. JSON body at most 4 KB; an Origin, when present, must be this server's. Errors: bad id or name 400, main 400, room exists or too many 409, unknown 404, damaged `rooms.json` 409 (left untouched). The file is written 0600, atomically; the room starts or stops at once.

### Clean Room

A room listens on loopback only. A Clean Room container reaches it through gonogo's own network when gonogo runs in Docker, and via `host.docker.internal` on Docker Desktop (macOS, Windows: **not tried**). **On Linux with gonogo outside a container, a Clean Room start is refused** with a message (it needed `--host 0.0.0.0`, no longer the room's address).

## Moving main of an older install

An install made before 0.8.2 keeps room main's files at the root of the home, mixed with the supervisor's. At the **start** of a release after 0.8.2, before any room starts, gonogo moves them into `rooms/main/`, once, so the home looks like a new one. It is a `rename` inside one filesystem (nothing is copied, nothing is deleted), and it **only moves main's files**: `agents.json`, `agents/`, `messages.jsonl`, `mission-log/`, `black-box/`, `gh/`, `keys.json`, the settings of the room and the rest of the list in `src/server/rooms.ts` (`ROOM_STATE_FILES`), and `run/port`, `run/update.json` and the pty host's key and log. The supervisor's own files (`auth.json`, `token`, `push.json`, `rooms.json`, `run/api.sock`...) stay, and so does anything gonogo does not know (a folder you made in the home: the dry run lists it). Sockets are made again at the next start. The generated files of an agent (settings, MCP config, hooks) are written again at every start, so nothing rewrites paths inside them.

**Checks first.** The move is refused, and the home stays as it is, when: a room of main is running (a live `server.lock`, or `run/room.sock` or the pty host's socket answers, which also means agents are alive under a pty host); `rooms/main/` exists and is not empty; any file of main is on another filesystem (a mount); the home is not writable; `agents.json` cannot be read; an earlier move is not finished; or **an agent works in a folder inside the home**: an agent with a worktree or a Clean Room (its folder is `worktrees/<name>` or `cleanroom/<name>`, and Claude's session history is keyed by that folder), or a leftover `worktrees/` or `cleanroom/` folder that is **not** safe to remove. A leftover that no agent has any more is removed by the move itself, first, when **all** of these hold: it is a real folder of the home (not a link, and its real path is inside it); the worktree has **`gonogo/<name>` checked out** (what the worktree has decides, not the branch it is named after: a detached commit or another branch there is refused, because removing would lose it); it is **clean**; it holds no **ignored files** that are not build output (`.env` and local config refuse; `node_modules`, `dist`, `.vite`, `build` and `coverage` may go); and its commit is **in the repository's checked-out branch**. Then it is removed with `git worktree remove` (no `--force`; the branch is kept; the folder names are in the journal note and on the card). A dirty one, one with commits that are not merged, or a folder that is not a git worktree refuses, and the reason is the exact command to run (`git -C <repository> worktree remove <folder>`). **UNDO does not restore removed leftover worktrees**; recreate one with `git worktree add <path> gonogo/<name>` (the branch is kept). The reasons are short sentences with the agent's name. A refusal is **not tried again by itself**: the layout is written as the root (`main.home` is `"."`), the reasons are shown in a box **above the room cards** on the rooms page (the list at `/`, which is the page you reach from the Patch Panel, also on a phone), and the next start leaves it alone. In Downlink it is a notice; when you had pressed **MIGRATE NOW** or **UNDO** and it was refused, it is an **alert**: your inbox and your phone (Relay), so that a restart that "did nothing" says why.

**The journal.** `main-migration.json` is written before the first move and names what moves. A crash (power, kill) leaves it: the next start **finishes** the move before anything else, name by name, and refuses (with the reason) if a name is in both places, rather than overwrite one. `main.home` in `rooms.json` is written **last**; it says the move is complete. A damaged journal stops the start with a message: look at `rooms/main/` and the root, then fix or delete it.

**On the rooms page**, main's card shows where its files are, and: after a refusal, the reasons with **MIGRATE NOW** (done at the next start, with the same checks; asks for your password if the last check is old, like other changes of what the room may do), **DRY RUN** (what would move and what would stop it) and **DISMISS**; after a move, a note with **UNDO** (also at the next start) and **DISMISS**; while a request waits, **CANCEL**. `GET /api/rooms` carries `layout`: `{ main: "." | "rooms/main", path, migration: null | { state, at, reasons?, moved? } }`; `GET /api/rooms/main/migrate` is the dry run and `POST` takes `{ "action": "request" | "undo" | "cancel" | "dismiss" }`.

**Command line.** With gonogo stopped: `gonogo rooms migrate-main --dry-run` (what would move; exit 1 if something stops it), `gonogo rooms migrate-main` (moves now) and `gonogo rooms migrate-main --undo` (back to the root: the files are put back, the empty `rooms/main/` goes, and the root is written as the layout so the next start does not move them again). While gonogo runs they refuse and say to use the page.

**Before going back to a build older than 0.8.2, run `gonogo rooms migrate-main --undo`** (or UNDO on the page and restart once): an older build knows only the root, and on a moved home it would start an empty main there. Nothing is lost if you forget (main is still in `rooms/main/`), and going forward again finds it, even when an older build saved `rooms.json` without the record. In Docker, the update strip's own **UNDO refuses** for such a build until main is back at the root: "UNDO on the rooms page first, then UNDO the update".

## Tokens

Access to the front port is decided by [login](./login.md): session cookie, API key, or the unix socket `<home>/run/api.sock`. On an install that never had an account, the **Director token** (`<home>/token`, 0600) still works and opens **every** room; creating an account deletes it (`gonogo token rotate` is for that fresh install only). The proxy reaches a room over its own unix socket `<room home>/run/room.sock`: a room has no TCP credential for its page (no token, no `run/room-token`), so a connection aimed at a room's port gets nothing, and agent tokens never leave their room. The supervisor strips every `Set-Cookie` from a room's answer and sets its own CSP. `gonogo tui` opens main through the socket, another room with `--room <id>`.

Under `/r/<id>/` and, for main, at the root (non-reserved paths):

| Path | Without Director token | With it |
|---|---|---|
| page and assets (GET, HEAD) | passes | passes |
| `/api`, `/ws` | 401 | passes |
| `/uplink/`, `/dock/` | passes; the room checks the signature | same |
| `/hook/`, `/mcp` | 404 | 404 (agents use their room's loopback port) |
| path with `..`, encoded slash or dot, backslash or NUL | 400 | 400 |
| room missing or bad id | 404 | 404 |
| room not running | 503 | 503 |

The path is decoded once; reserved-name and path checks use that text, case exact (`/%72ooms`, `//internal/busy`, `/r%2Fmain/x` never reach main). Cookies and `X-Forwarded-*` are dropped from requests. Redirects stay under `/r/<id>/`. Only `/` is the list: a bookmark of `/` opens the list, not main.

## Webhooks, phone approvals, notifications

Each room has its own Uplinks: main `https://<host>/uplink/<id>`, others `https://<host>/r/<room>/uplink/<id>` (Relay and Uplink pages show it). **One Telegram bot has one webhook**: each room using Telegram needs its own bot. Signed approval buttons are per room (the room's Uplink secret), so one room's button cannot approve another's request. The browser keeps one stored token and one set of look settings per address, shared by the rooms of one server.

## What was seen

With `gonogo rooms` (0.4, 2026-11-18): two rooms behind one port, same API call through `/r/team/` and `/r/main/` returned different homes; WebSocket opened with the Director token; without a token API 401 and `/hook/` 404. `kill -9` of a room: running again on a new port after 1 s, main never stopped. SIGTERM of the supervisor stopped both and released locks; `kill -9` of the supervisor took rooms and agents down within 6 s, no lock left.

Single mode (2026-11-18, built gonogo, stand-in agent): `/`, `/api/state`, `/r/main/api/state` answered alike; `/hook/x` and `/internal/busy` 404, `//internal/busy` 400; room token not accepted on the front and vice versa; `gonogo token rotate` made the old token 401 at once. `gonogo reload` was refused (this shell is in a container); the hand-over is tested with stand-in rooms only.

## Not built, not tried

Not built: host-name routing (`a.localhost`), room switch in `gonogo tui` (`--room` at start), per-room reload, machine-wide Max Q, shared price tables or keys, start/stop key per room, moving an agent between rooms, deleting a room's folder, a warning when two rooms hire the same folder. Not tried: rooms in Docker with the socket, a real Telegram bot, a browser (list page and base-path code tested, not seen).
