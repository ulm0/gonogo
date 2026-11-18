# Configuration

## Options

A flag beats its environment variable, which beats the default. `--port=7777` and `--port 7777` are the same.

| Flag | Environment variable | Meaning |
|---|---|---|
| `--port <n>` | `GONOGO_PORT` | Listen port. Default `7777`; `0` picks a free port. |
| `--host <addr>` | `GONOGO_HOST` | Bind address. Default `127.0.0.1`; `localhost` means `127.0.0.1`. A specific address that is not loopback (a LAN address, a Tailscale `100.x`) is also served on `127.0.0.1`, because agents always connect there. |
| `--home <dir>` | `GONOGO_HOME` | State directory. Default `~/.gonogo`. |
| `--seed-claude` | `GONOGO_SEED_CLAUDE` (`1` or `true`) | Seed mode (see [Docker](../guide/docker.md)). Off by default. |
| `--allow-host <name>`, repeatable | `GONOGO_ALLOWED_HOSTS`, comma separated | Extra `Host` names to accept, for a reverse proxy. Any `--allow-host` replaces the variable. The public name that Uplink webhooks arrive on goes here too, so do the names that GitHub, Linear, Slack and Telegram post to (Relay), and the name another station reaches this one on (Docking). |
| `-h`, `--help` | | Print the usage and exit 0. |
| `-v`, `--version` | | Print `gonogo <version>` and exit 0. |
| | `GONOGO_MAX_HOPS` | Cap on hops of messages between agents. Default `8`; a whole number from 1 to 100, anything else is ignored with a warning. |
| | `GONOGO_REDLINE` | `off` turns Redline's automatic detectors off (loop, error storm, ping-pong). Propellant limits still stop agents. Default: on. |
| | `GONOGO_MAX_WORKING` | Max Q at start: at most this many agents with hooks (Claude Code, Gemini CLI) work at once (a whole number from 1 to 24; anything else is ignored with a warning). Default: no limit. You can change it any time from the wall display. |
| | `GONOGO_AGENT_CMD` | A command that replaces `claude`: a JSON array of strings, or words separated by spaces. It gets the arguments `claude` would get. With it set, gonogo does not look for `claude` on the `PATH`. |
| | `GONOGO_CLEANROOM_IMAGE` | The Docker image a Clean Room console runs in. Default `ghcr.io/ulm0/gonogo`, the project's image (the `Dockerfile`; until it is published there, build it under that name with `docker build -t ghcr.io/ulm0/gonogo .`). A console's own image, set through the API, wins. |
| | `GONOGO_CLEANROOM_NETWORK` | Only for gonogo running in a container (see [Clean Room in the container](../guide/docker.md#clean-room-in-the-container)): `container:self` (gonogo's own container, by its host name) or `container:<name of gonogo's container>`. A Clean Room console then joins that container's network (and its hosts file, where `host.docker.internal` must name `127.0.0.1`), and each start checks that gonogo's home is mounted from the same path of the host and that the name resolves to loopback. Any other value is refused at hire and at start. `compose.yaml` sets it. |
| | `TZ` | The standard time zone variable. Launch Window rules run in it (the zone of the machine when it is not set). |
| | `GONOGO_STATION` | This station's name for Docking: the part after the `@` in `name@station`. Cut to lower case letters, digits and `-`, at most 31 characters. Default: the first part of the host name. |
| | `GONOGO_LOG_LEVEL` | `debug`, `info`, `warn` or `error`. Default `info`. |
| | `GONOGO_SCRUB_ENV` | Environment variables to remove from every agent, on top of the Claude Code session variables that are always removed. Comma separated; an entry ending in `_` is a prefix, any other entry an exact name. Example for a gonogo started in a terminal-multiplexer pane: `HERDR_,TMUX_PANE`. Without it each agent inherits the pane's variables, and a hook of your own can report the agent as that pane. Do not list `HOME`, `PATH` or the credential variables. |

An unknown flag prints the usage and exits with code 2. A start that fails (port in use, another gonogo on the same home, a damaged `agents.json`, no `claude` on the `PATH`) prints one line, `gonogo: <message>`, and exits with code 1. Ctrl-C, SIGTERM and SIGHUP stop every agent and exit; if gonogo stops, its agents stop with it.

## State on disk

Everything lives under the home directory (`~/.gonogo` by default).

| Path | What |
|---|---|
| `agents.json` | The roster: name, role, directory, permission mode, session id, desk, position, the provider of an agent that does not run Claude Code, for a custom agent its command, for an agent with a Payload its MCP servers and skill folders, and for a Clean Room agent its `cleanRoom` setting, all in plain text, env and header values of the servers included (keep secrets out, or write `${NAME}` and let the variable come from gonogo's environment). The file is mode 0600. It is never reset automatically; a damaged file stops the start and names the path. |
| `messages.jsonl` | Every message, one JSON line per change. A file over 32 MiB is renamed to `messages.jsonl.1` at the next start. |
| `fuel.jsonl` | Propellant's ledger: one line per agent and minute with the tokens counted. Lines older than 31 days are dropped at start. |
| `propellant.json` | The Propellant limits (room and per agent, by name) and how far each transcript was read, so a restart counts nothing twice. Has a `version` (a file from before it had one reads as version 1). |
| `schedules.json` | The Launch Window schedules, with the message text and the last result of each, in plain text. Mode 0600. A file that cannot be read is renamed `schedules.json.bad` and the server starts with none. |
| `uplinks.json` | The Uplink webhooks: name, recipient, kind, **the secret in plain text**, and the last 20 deliveries of each (time, status, note; not the body). Mode 0600. A file that cannot be read is renamed `uplinks.json.bad` and the server starts with none. |
| `tasks.json` | The Flight Plan tasks: title, detail, status, assignee, who made it and the history lines, in plain text. Mode 0600. A file that cannot be read is renamed `tasks.json.bad` and the server starts with none. |
| `station.json` | This station's id: `{ "version": 1, "id": "<32 hex characters>" }`. Mode 0600. Made once; delete it and the stations docked with this one no longer know it. |
| `docking.json` | The docked stations: the id, name and address of each and **the shared secret in plain text**. Mode 0600. Not the roster or the last answer: those are in memory. A file that cannot be read is renamed `docking.json.bad` and the server starts with no dock. |
| `relay.json` | The Relay targets: for Slack and for Telegram the bot token (**in plain text**) and the place (channel id, chat id), and the kinds that are forwarded. Mode 0600. Not the last result of a send, and not the map of forwarded messages: those are in memory. A file that cannot be read is renamed `relay.json.bad` and the server starts with no target. |
| `downlink.json` | The Downlink inbox: the events (kind, time, one line of text) and one flag, read or archived, for each item you marked, by item id. The messages are not in it: they are in `messages.jsonl`. Mode 0600. A file that cannot be read is renamed `downlink.json.bad` and the server starts with an empty inbox, the mail already in the log counted as read. |
| `livery.json` | Which livery is chosen: `{ "version": 1, "current": "<slug>" }`. Mode 0600. An unknown slug or a file that cannot be read means Instrument. |
| `liveries/<slug>.json` | The custom liveries, one file each: name, description, the agent that made it and the 28 tokens, in plain text. The folder is mode 0700 and the files 0600. A file that is not a whole livery that passes the contrast rule is skipped with a warning and kept. Read at start. |
| `mission-log/<id>.md` | The Mission Log entries, one file each, in plain text: a front matter (`version`, id, title, tags, author, times) and the body. An entry from before the version has none and reads as version 1; one of a newer version is skipped with a warning and kept. The folder is mode 0700 and the files 0600. `mission-log/.seq` holds the highest id given, so that the id of a removed entry is not used again. A file that is not an entry is skipped with a warning and kept. |
| `<file>.bak-v<n>` | The copy of a file that was upgraded from version `n` (for example `agents.json.bak-v1`), made before the first change. Mode 0600. Never read or removed by gonogo: delete it when you no longer need it. A copy of `uplinks.json`, `relay.json` or `docking.json` keeps the secrets it had in plain text, even after you rotate them. See [Versions of the saved state](#versions-of-the-saved-state). |
| `server.lock` | The pid of the running gonogo. A second gonogo on the same home refuses to start. A stale lock is replaced; if you are told another gonogo is running and none is, delete it. |
| `token` | The browser token, mode 0600. |
| `cleanroom/<name>/` | The git worktree of a Clean Room agent, on the branch `gonogo/<name>` of your repository (its `.git` file points into your repository). Made at the first start, never removed by gonogo. |
| `agents/<name>/` | `cleanroom-home/` (only for a Clean Room agent: the container's HOME and Claude config, with its folder trust and sessions, mode 0700), `memory.md` (the agent's notes, never overwritten), `settings.json` and `mcp.json` (written again at every start; `mcp.json` holds the Payload servers beside `gonogo`), `payload-plugin/` (only with Payload skills: a manifest and a symlink per skill folder, rebuilt at every start and removed when the agent has none), `token` (the agent's token while its process runs). Other engines (Engine Bay): `gemini-settings.json`, `opencode.json`, `kimi-mcp.json` or `copilot-mcp.json`, written again at every start; the Kimi and Copilot files hold that start's agent token. Mode 0700 directories, 0600 files. Removing an agent keeps this folder, so its notes survive: hiring an agent with the same name later starts with the old `memory.md`, and renaming another agent to that name is refused until you delete the leftover folder. |

### Versions of the saved state

Every JSON file above that has a format (`agents.json`, `schedules.json`, `uplinks.json`, `tasks.json`, `downlink.json`, `relay.json`, `docking.json`, `station.json`, `livery.json`, `liveries/<slug>.json`, `propellant.json`) holds `"version": <n>`; so does the front matter of a Mission Log entry. Everything is at version 1 today. Design and limits: [`docs/release-readiness-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/release-readiness-spec.md).

- **At start**, right after gonogo takes the lock on the home and before anything reads a file, a small runner looks at each of those files. A file of an older version is upgraded one version at a time, in order. Before the first change gonogo copies the file to `<file>.bak-v<old>` (mode 0600), writes the new file through a temporary file and a rename, and logs one line. If a step fails, the file is left as it was and the start stops with a message that names the file and the copy.
- **A file of a newer version stops the start**: `<path> was saved by a newer gonogo (format version 2; this one reads up to 1). Start the gonogo that saved it, or move the file away to start without it.` An older gonogo would read it wrongly and then overwrite it. To go back to an older gonogo, put the `.bak-v<n>` copy in the place of the file (you lose what changed after the upgrade).
- **A file that is missing, is not JSON or has no version** is left to the part of gonogo that owns it, which reports it as before (a damaged `agents.json` stops the start; the others are renamed `.bad`). The exception is `propellant.json`, which older gonogos wrote without a version: it counts as version 1.
- **A Mission Log entry** has a version in its front matter but is not upgraded by the runner: an entry of a newer version is skipped with a warning and kept.
- **Not versioned:** `messages.jsonl` and `fuel.jsonl` are logs, one JSON line per event; a line that cannot be read is skipped. `mission-log/.seq`, `token`, `server.lock` and the files under `agents/<name>/` that gonogo writes again at every start have no format to migrate.
