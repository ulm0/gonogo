# Configuration

<PrecedenceMock class="doc-mock" />

## Options

A flag beats its environment variable, which beats the default. `--port=7777` and `--port 7777` are the same.

| Flag | Environment variable | Meaning |
|---|---|---|
| `--port <n>` | `GONOGO_PORT` | Listen port. Default `7777`; `0` picks a free port. |
| `--host <addr>` | `GONOGO_HOST` | Bind address. Default `127.0.0.1`; `localhost` means `127.0.0.1`. A non-loopback address (LAN, Tailscale `100.x`) is also served on `127.0.0.1`, where agents connect. |
| `--home <dir>` | `GONOGO_HOME` | State directory. Default `~/.gonogo`. |
| `--seed-claude` | `GONOGO_SEED_CLAUDE` (`1` or `true`) | Seed mode (see [Docker](../guide/docker.md)). Off by default. |
| `--allow-host <name>`, repeatable | `GONOGO_ALLOWED_HOSTS`, comma separated | Extra `Host` names to accept: a reverse proxy's name, and the names Uplink, Relay (GitHub, Linear, Slack, Telegram) and Docking reach this station on. Any `--allow-host` replaces the variable. |
| `-h`, `--help` | | Print usage, exit 0. |
| `-v`, `--version` | | Print `gonogo <version>`, exit 0. |
| | `GONOGO_MAX_HOPS` | Hop cap for messages between agents. Default `8`; whole number 1 to 100, else ignored with a warning. |
| | `GONOGO_REDLINE` | `off` turns off Redline's detectors (loop, error storm, ping-pong). Propellant limits still stop agents. Default on. |
| | `GONOGO_MAX_WORKING` | Max Q at start: how many agents with hooks (Claude Code, Gemini CLI) may work at once. Whole number 1 to 24, else ignored with a warning. Default no limit; changeable from the wall. |
| | `GONOGO_AGENT_CMD` | Replaces `claude`: a JSON array of strings, or words separated by spaces. Gets the arguments `claude` would. When set, gonogo does not look for `claude` on the `PATH`. |
| | `GONOGO_CLEANROOM_IMAGE` | Image for Clean Room consoles. Default `ghcr.io/ulm0/gonogo` (build it locally with `docker build -t ghcr.io/ulm0/gonogo .` if not published yet). A console's own image, set through the API, wins. |
| | `GONOGO_CLEANROOM_NETWORK` | Only when gonogo runs in a container ([Clean Room in the container](../guide/docker.md#clean-room-in-the-container)): `container:self` or `container:<name of gonogo's container>`. Clean Rooms join that container's network and hosts file. Any other value is refused at hire and start. `compose.yaml` sets it. |
| | `TZ` | Time zone for Launch Window rules (machine's zone if unset). |
| | `GONOGO_STATION` | Station name for Docking (the part after `@` in `name@station`). Cut to lower case letters, digits and `-`, at most 31 characters. Default: first part of the host name. |
| | `GONOGO_LOG_LEVEL` | `debug`, `info`, `warn` or `error`. Default `info`. |
| | `GONOGO_SCRUB_ENV` | Extra variables to remove from every agent (Claude Code session variables are always removed). Comma separated; an entry ending in `_` is a prefix. Example for a terminal-multiplexer pane: `HERDR_,TMUX_PANE`. Do not list `HOME`, `PATH` or credential variables. |

Exit codes: an unknown flag prints usage and exits 2. A failed start (port in use, another gonogo on the same home, damaged `agents.json`, no `claude` on the `PATH`) prints `gonogo: <message>` and exits 1. Ctrl-C, SIGTERM and SIGHUP stop every agent and exit; agents stop with gonogo.

## State on disk

Everything lives under the home (`~/.gonogo` by default). Files are mode 0600 and folders 0700 unless noted. A JSON store that cannot be read (`schedules`, `uplinks`, `tasks`, `docking`, `relay`, `downlink`) is renamed `<file>.bad` and the server starts without it.

| Path | What |
|---|---|
| `agents.json` | The roster: name, role, directory, permission mode, session id, desk, position, provider, custom command, Payload servers and skill folders, `cleanRoom` setting. Plain text, including payload env and header values (keep secrets out or write `${NAME}`). A damaged file stops the start and names the path. |
| `messages.jsonl` | Every message, one JSON line per change. Over 32 MiB it is renamed `messages.jsonl.1` at the next start. |
| `fuel.jsonl` | Propellant's ledger: one line per agent and minute. Lines older than 31 days are dropped at start. |
| `telemetry.jsonl` | Telemetry: one line per finished tool call (agent, start, duration, tool, summary, failed). Newest 200 per agent kept, cut at start and every 2000 new lines. |
| `propellant.json` | Propellant limits (room and per agent) and how far each transcript was read. |
| `schedules.json` | Launch Window schedules, message text and last result, in plain text. |
| `uplinks.json` | Uplink webhooks: name, recipient, kind, **secret in plain text**, last 20 deliveries (no bodies). |
| `tasks.json` | Flight Plan tasks with history, in plain text. |
| `station.json` | This station's id: `{ "version": 1, "id": "<32 hex characters>" }`. Delete it and docked stations no longer know this one. |
| `docking.json` | Docked stations: id, name, address, **shared secret in plain text**. |
| `relay.json` | Relay targets: Slack and Telegram **bot token in plain text**, channel or chat id, forwarded kinds. |
| `downlink.json` | Downlink events and read/archived flags. If unreadable, the inbox starts empty with logged mail counted as read. |
| `livery.json` | Chosen livery: `{ "version": 1, "current": "<slug>" }`. Unknown or unreadable means Instrument. |
| `liveries/<slug>.json` | Custom liveries (name, description, author, 28 tokens). One that is incomplete or fails the contrast rule is skipped with a warning and kept. |
| `mission-log/<id>.md` | Mission Log entries: front matter (`version`, id, title, tags, author, times) and body. Unreadable or newer-version entries are skipped with a warning and kept. `mission-log/.seq` holds the highest id so ids are never reused. |
| `agents/<name>/memory.md.bak` | The one copy of `memory.md` that Mass Budget takes when you press REFLECT (mode 0600). Replaced by the next request. gonogo only looks at its size and time, and never restores or removes it. |
| `<file>.bak-v<n>` | Copy made before upgrading a file from version `n` (e.g. `agents.json.bak-v1`). Never read or removed by gonogo. Copies of `uplinks.json`, `relay.json` or `docking.json` keep their old secrets. |
| `server.lock` | The running gonogo's pid. A second gonogo on the same home refuses to start. Delete it if you are told one is running and none is. |
| `token` | The browser token. |
| `cleanroom/<name>/` | A Clean Room agent's git worktree, on branch `gonogo/<name>` of your repository. Never removed by gonogo. |
| `agents/<name>/` | `memory.md` (the agent's notes, never overwritten), `settings.json` and `mcp.json` (rewritten every start), `token` (while running), `cleanroom-home/` (Clean Room only: the container's HOME and Claude config), `payload-plugin/` (Payload skills only). Other engines: `gemini-settings.json`, `opencode.json`, `kimi-mcp.json` or `copilot-mcp.json`, rewritten every start (Kimi and Copilot files hold the agent token). Removing an agent keeps this folder: a new agent with the same name gets the old `memory.md`, and renaming another agent to that name is refused until you delete it. |

### Versions of the saved state

Every JSON file above with a format, and each Mission Log entry's front matter, holds `"version": <n>`. All are at version 1 today. Design: [`docs/release-readiness-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/release-readiness-spec.md).

- **Older file**: at start, before anything reads it, it is upgraded one version at a time. gonogo first copies it to `<file>.bak-v<old>`, writes the new file atomically and logs one line. If a step fails, the file is left as it was and the start stops, naming the file and the copy.
- **Newer file** stops the start: `<path> was saved by a newer gonogo (format version 2; this one reads up to 1). Start the gonogo that saved it, or move the file away to start without it.` To go back to an older gonogo, put the `.bak-v<n>` copy back (you lose later changes).
- **Missing, not JSON or no version**: handled as described in the table. `propellant.json` without a version counts as version 1.
- **Mission Log entries** are not upgraded; a newer one is skipped with a warning and kept.
- **Not versioned**: `messages.jsonl`, `fuel.jsonl` and `telemetry.jsonl` (an unreadable line is skipped), `mission-log/.seq`, `token`, `server.lock`, and files under `agents/<name>/` rewritten every start.
