# Rooms: several rooms behind one port

<RoomsMock class="doc-mock" />

**Rooms are not file-isolated.** Every room is a gonogo process of its own, so rooms do not share memory, mail, tokens, tools or
crashes. But they all run as **your operating-system user**, and an agent that does not run in a Clean Room can read every file of
every room (and of your home folder). The isolation is at gonogo's API, not at the file system. The same holds inside a container:
one room's agent can reach the Docker socket, if you mounted it, as it can today. Use a Clean Room for an agent that must not see
the other rooms. Design: [`docs/rooms-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/rooms-spec.md).

## What it is

Until now a second room meant a second deployment. `gonogo rooms` runs **one gonogo per room** behind **one port**: a small
supervisor starts each room on a loopback port of its own, lists them at `/`, and proxies `/r/<id>/` to the room. Plain `gonogo`
does not change: it is one room, as before.

- **Main** is today's home: nothing moves. Other rooms live in `<home>/rooms/<id>/` and start from zero (roster, mail, Flight Plan,
  Plot Board, Mission Log, Black Box, missions and every setting are per room).
- **Shared by inheritance**: the binary and its update, and the environment of the supervisor (`CLAUDE_CONFIG_DIR`, the
  agent CLIs' logins, `gh`'s config, `GONOGO_*` flags). **Not shared** in this version: the price table, Clearance keys, Max Q
  (each room counts its own working agents) and Propellant (each room keeps its own ledger and budgets).

## Use it

```
gonogo rooms add team --name "Team B"     # a room id is a-z, 0-9 and dashes, at most 24 characters
gonogo rooms list
gonogo rooms                              # runs the supervisor; prints gonogo rooms ready: http://127.0.0.1:7777/#token=...
gonogo rooms remove team                  # takes it off the list; its folder stays
```

`add` and `remove` edit `<home>/rooms.json`; a running supervisor notices within 2 seconds, starts the new room or stops the removed
one (a graceful stop: SIGTERM, then SIGKILL after 12 s). `gonogo rooms` takes `--port`, `--host`, `--home` and `--allow-host` like
`gonogo`. A room that crashes is started again after 1, 2, 5, 15, then 30 seconds. At most 12 rooms: each is a Node process (and a
pty host with `--pty-host`), so count tens of megabytes each.

Open the printed address: the list shows each room with its agents and how many need you, and OPEN goes to `/r/<id>/`. In a room,
**Rooms** in the Patch Panel (Cmd+K) goes back to the list.

## Tokens

The browser holds **one** secret, the Director token (`<home>/rooms-token`, its own file, 0600). The proxy checks it and **swaps in
the room's own browser token** on the way, in the `Authorization` header and in the WebSocket subprotocol. The Director token never
reaches a room, a room's token never leaves the supervisor, and agent tokens never leave their room. A room still works alone with
its own token file (`gonogo --home <room>`, `gonogo tui --home <room>`).

What the proxy lets through under `/r/<id>/`:

| Path | Without the Director token | With it |
|---|---|---|
| the page and its assets (GET, HEAD) | passes, with no Authorization | passes |
| `/api`, `/ws` | 401 | passes with the room's token |
| `/uplink/`, `/dock/` (webhooks, other stations) | passes, no Authorization added; the room checks the signature | same |
| `/hook/`, `/mcp` | 404 | 404: agents use the loopback port of their own room |
| a path with `..`, an encoded slash or dot, a backslash or a NUL | 400 | 400 |
| a room that does not exist or has a bad id | 404 | 404 |
| a room that is not running | 503 | 503 |

Host and Origin are checked as a room checks them, then rewritten to the room's loopback address. Cookies and `X-Forwarded-*` headers
are dropped.

## Webhooks, phone approvals, notifications

Each room has its own Uplinks, so its own address: `https://<host>/r/<room>/uplink/<id>`. The Relay and Uplink pages show that address.
**One Telegram bot has one webhook**, so each room that uses Telegram needs its own bot. The signed approval buttons are per room (the
tag uses the room's own Uplink secret), so a button of one room cannot approve a request of another. The browser keeps one stored
token and one set of look settings per address, so these are shared by the rooms of one server.

## What was seen (2026-11-18, a built gonogo with the stand-in agent)

Two rooms (`main`, `team`) behind one port, `ana` hired in both: each room listed its own `ana`, with its own home in the state; the same
API call through `/r/team/` and `/r/main/` returned different homes; a WebSocket to `/r/team/ws` opened with the Director token and its
first frame was team's state; the page and its icon loaded under `/r/team/`; without a token the API was 401 and `/hook/` was 404.
`kill -9` of the team's process: the room list showed it running again on a new port after 1 s, and `main` never stopped. SIGTERM of
the supervisor stopped both rooms and released both home locks.

## Not built, not tried

Host-name routing (`a.localhost`), a room switch inside `gonogo tui` (`gonogo tui --home <room>` works), a machine-wide Max Q, shared
price tables or keys, a start/stop key per room in the page, moving an agent between rooms, deleting a room's folder, and a warning
when two rooms hire the same working folder. Rooms in Docker with the Docker socket, a real Telegram bot and a browser were not tried
(there was no browser here; the list page and the base-path code are tested, not seen).
