# Spec: Several rooms on one gonogo server (draft)

Design by FIDO, 2026-11-18, task t49. Status: draft, **not for 0.3.0**, not built. Read from `cli.ts` (`startGonogo`), `home.ts`, `launcher.ts`, `web.ts`, `compose.yaml` and `docs/docking-spec.md`; nothing run.

## Intent

Today a second room is a second deployment: `GONOGO_PORT=7778 GONOGO_DATA=... docker compose -p gonogo-2 up -d` (the comment in `compose.yaml`). The Director wants several rooms behind one server and one compose: each room starts from zero (roster, mail,
Flight Plan, Plot Board, Mission Log, Black Box, missions, settings) and shares what belongs to the machine (the agent CLIs' logins and `CLAUDE_CONFIG_DIR`, the `gh` login, the binary, the update).

## What assumes one room today

- `startGonogo()` (`cli.ts`, ~900 lines) builds **one** of everything from one `home`: one `Hub`, one `TerminalHost`, one `Launcher` with an in-memory token map, one `WebServer`, one set of stores (tasks, missions, tokens, Black Box...), and prints one URL with one browser token.
- Hook and MCP URLs are `hubUrl + /hook/<name>/<event>` and `hubUrl + /mcp`, where `hubUrl` is an injected function (a good seam: a prefix would fit).
- Agent tokens are random, per process, in memory (and the live-reload file): a token of room A means nothing to another process.
- The page uses absolute paths (`/api`, `/ws`, assets) and one browser token in the URL fragment.
- Module-level state is small and harmless for two homes in one process (`heldDirs` is keyed by directory; `versionCache`, the key-name sets); I found no singleton that would mix rooms.
- Agents run as the owner's OS user. **No option below isolates the file system between rooms**: an agent of room A that is not in a Clean Room can read room B's files, as it can read the whole home today. The isolation gonogo can give is at its API (mail, tools, board, hooks, MCP, the browser API); the file boundary is Clean Room, as today.

## Options

### A. Rooms inside one process
`<home>/rooms/<id>/`, one `Hub` and one set of stores per room, one HTTP listener, routes under `/r/<id>/...`, one pty host.
- For: one port natively, one pty host, a machine-wide Max Q and a shared plan quota are one counter, least memory, live reload is one operation.
- Against: `startGonogo` must be split into a shared part and a per-room `createRoom(home)` (about 2000 lines touched: the web server's routes, WebSocket frames, broadcast, hook and MCP auth, the uplink and dock endpoints all become room-keyed). Isolation then **depends on every lookup carrying the room id**: one missed key is a cross-room leak, in a codebase that never had to think about it.
  One crash, one stuck event loop or one bad `await` takes every room down. A test matrix doubles.

### B. A thin supervisor with one process per room (pick)
`gonogo` (no room flags) becomes a supervisor that starts one ordinary gonogo child per room, each with its own `GONOGO_HOME` and an internal loopback port, and serves **one** port: a room list page and a proxy.
- For: **isolation by the operating system**: separate memory, separate token maps (an agent token of room A is simply unknown to room B's process), separate pty hosts, separate crashes. A room is exactly today's gonogo, so every feature, test and doc keeps working unchanged, and a room can be run alone (`gonogo --home <dir>`), also today's layout.
  The first PR is small and the rooms code is mostly new, not a rewrite.
- Against: more processes (a Node server and a pty host per room, a few tens of MB each); machine-wide limits need a small coordinator; one proxy to write (HTTP and WebSocket).

**Pick B.** The thing the Director fears is a room seeing another's mail or tools; with B that cannot happen through a bug in routing because nothing is shared in memory. A's advantages (shared counters, one pty host) matter for a handful of rooms far less than that guarantee, and B reaches them later through a small coordinator.

## Design (B)

- **Layout.** The root home keeps today's files and **is room `main`** (migration: nothing moves; a user with one room sees no change). More rooms live in `<home>/rooms/<id>/` (an `id` is `[a-z][a-z0-9-]{0,23}`, `main` reserved for the root). `<home>/rooms.json` `{ version: 1, rooms: [{ id, name, autostart }] }` (0600, atomic) lists them; the supervisor creates the folder on `rooms add`. Rooms start from zero because the folder is empty.
- **Supervisor** (`src/server/supervisor.ts`, `gonogo rooms ...`; plain `gonogo` is unchanged and runs one room, so nothing breaks): starts each listed room as `node gonogo --home <dir> --port 0 --host 127.0.0.1 --internal` (the child prints its port on a pipe, no browser URL), restarts a crashed child with backoff, stops them with the existing graceful shutdown on SIGTERM, and serves the front port.
- **Front port.** `/` is the room list page (name, state, agents running and needing you, OPEN); `/r/<id>/...` proxies HTTP and WebSocket to the child's port with the prefix stripped. The page and server learn a **base path** (`GONOGO_BASE`, set by the supervisor on the child): the client builds `/api`, `/ws`, assets and the hash route from one `BASE` constant (about 30 call sites in `api.ts`, `main.tsx`, `TerminalPane`), the server serves the same bundle. Hook and MCP URLs do **not** need it: agents talk to the child's loopback port directly.
  Alternative to the path: a Host name per room (`a.localhost`), which needs no base path but needs wildcard DNS for a real server. Path first; Host later if wanted.
- **Tokens.** One **Director token** for the supervisor (`<home>/token`, today's file). The proxy checks it, then **swaps in the room's own browser token** on the way (the `Authorization` header and the WebSocket subprotocol entry), so the browser holds one secret and never a room's. Each child keeps its own token file as now, so `gonogo tui --home <room>` and a direct `--port` run still work. Agent tokens never leave the child.
- **Shared and per room.** Shared (per machine, by inheritance): the binary and its update, the **environment of the supervisor** (so `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `gh`'s config dir and `GONOGO_*` flags reach every room, and the agent CLIs' logins are the machine's), the Docker socket, the image. Per room: everything in the home (roster, mail, Flight Plan, board, Mission Log, missions, Black Box, schedules, uplinks, relay, Clearance **keys**, `prices.json`, `models.json`, `permissions.json`, `features.json`, `room.json`, the ledger).
  Two things the Director may want shared are **opt-in later**: price table and Clearance keys, as `GONOGO_SHARED_DIR` read as a fallback when the room has none (a read, never a write across rooms). The first PR shares neither, stated in the docs.
- **Isolation, restated.** API level: separate processes and token maps; the router never forwards an agent's request, since agents use the loopback port of their own room; a hook or MCP request to another room's internal port fails with 401 (unknown token). File level: same OS user, so **not isolated** unless the agent runs in a Clean Room; the docs must say so in the first lines. Names of agents repeat across rooms freely. Two rooms must not share a working directory for agents (a second room's hire of a folder already used by another room gets a **warning**, not a refusal: the owner may want it).
- **Max Q and Propellant across rooms.** Per room by default (each child counts its own `working` agents against its own limit; its own ledger, budgets and Redline). A **machine-wide Max Q** is a small file lock directory `<home>/run/slots/` that children take a slot in while `working`; later, not in the first PR. The **plan quota** (`docs/quota-spec.md`) is per account: each child reports its own, and the room list takes the newest. No cross-room budget in v1.
- **Live reload and update.** The supervisor changes rarely and does not touch agents. `gonogo reload` (see `docs/live-reload-spec.md`) is per room: the supervisor reloads the children one after another (a child's pty host keeps its agents); the supervisor re-execs itself last, and its children are detached so they survive it. `gonogo update` prints one command for the machine, as today. A room whose new hub fails to adopt stays on the old process and the others go on.
- **Docker.** One container, one volume (`GONOGO_HOME` the root), one published port. Clean Room containers join the container's network (`container:self`) as now; each room's agents get their own `host.docker.internal` URLs pointing at **their room's internal port**, so the Host rule of the server applies per child. The compose comment about a second instance becomes "add a room".
- **Autostart.** `docs/autostart-spec.md` applies per room (each child decides for its own agents); the supervisor starts rooms marked `autostart` (default on) and the child then follows its own `startup` setting.
- **The TUI.** `gonogo tui` gets `--room <id>` (default `main`): it reads the root's rooms file and connects through the front port with the Director token, or straight to a local room with `--home`. A room switch key in the TUI is a later addition.
- **Phone approvals and webhooks.** Each room has its own uplinks, so each has its own webhook address: `https://host/r/<id>/uplink/<uplink id>` (the proxy passes `/uplink/` through under the prefix). **One Telegram bot has one webhook**, so each room needs its own bot (or a bot per room's target); the room's Relay page says so. The signed buttons are per room (the callback tag uses the room's uplink secret, so a button of room A cannot approve a request in room B). Notifications (browser) are per origin and path: the page title and notification text carry the room name.
- **The room switcher.** In the page: ROOMS is a command in the Patch Panel (no top-bar key) that opens the list; the room's name shows in the header mark and the tab title. The list page itself needs no login beyond the Director token.
- **Docking.** Two rooms of one server can dock with each other over the loopback proxy: a free, explicit, signed link for cross-room messages and task hand-off, with nothing added.

## Smallest useful first PR

`supervisor.ts` + `gonogo rooms` (`add <id> [--name]`, `list`, `remove <id>` which only unlists and never deletes the folder, and a default that runs the supervisor); `rooms.json`; the child mode (`--internal`, port on a pipe, `GONOGO_BASE`); the front port with the list page and the **HTTP + WebSocket proxy with the token swap**; the base path in the client and server; a compose and docs change; `docs/features/rooms.md` that opens with the isolation statement above. About 800 lines with tests, half of it the proxy and the base path.
**Not in it:** shared prices or keys, a machine-wide Max Q, a room switch inside the TUI, Host-name routing, per-room themes, moving an agent between rooms, deleting a room's folder, and any change to what one room does. Plain `gonogo` stays single-room.

## Order of changes

1. Base path in client and server (a no-op at `/`), with tests. 2. Child mode and the supervisor with restart and graceful stop. 3. The proxy (HTTP, then WebSocket) with the token swap; then the list page. 4. `rooms` commands and `rooms.json`. 5. Docs and compose.

## Test plan

Base path: every client request and the WebSocket use `BASE`; at `/` nothing changes. Proxy: strips the prefix, passes status, headers and bodies, streams the WebSocket both ways (binary frames kept), swaps the token and **never** forwards the Director token to a child, refuses a request without the Director token (401), a room id that does not exist (404), `..` or encoded slashes in the id. Isolation: two rooms with agents of the same name; a hook call and an MCP call with room A's agent token sent to room B's internal port are 401; room B's mail, tasks and board are not readable with room A's agent token; the router has no path to an agent endpoint of a room except through that room's own prefix. Supervisor: a crashing child restarts with backoff and does not stop the others; SIGTERM stops all children gracefully; two rooms get two ports and two homes; `rooms remove` never deletes files; `main` is the root and nothing moves for an existing home. Uplink under `/r/<id>/uplink/..` verifies its signature. Not tested: a real Telegram, Docker with two rooms (by hand in a VM, like the other Docker paths).

## Risks

- The base-path change touches every URL of the page: a missed one works at `/` and breaks under `/r/<id>/`; the test lists every `fetch`/`WebSocket` call site.
- Token swapping puts the proxy on the security path: it must be small, strip any `Authorization` it did not set, and be reviewed by a second agent.
- Memory: N rooms are N Node processes and N pty hosts; the page says how many rooms a small machine should have.
- Rooms in one container share the Docker socket: one room's agent has root on the host as today, and so can reach another room's data. Said plainly in the docs.
