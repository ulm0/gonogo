# Changelog

All notable changes to gonogo. Versions follow [Semantic Versioning](https://semver.org/); before 1.0.0 a minor release may break things.

## Unreleased

- **Cost.** Propellant can show dollars (an API-equivalent estimate at list prices) with a budget, a chart of the last 14 days and an editable price table (`~/.gonogo/prices.json`, no network). A budget trips Redline like a token limit and warns once at 80 %. New ledger lines keep the model and the token split; older ones show as unpriced.
- **Container.** The image has the `gh` CLI (2.103.3, checksum verified), and the config of `gh` and of `git config --global` lives in `/state/config`, so a login survives a restart. `POST /api/poll/hold` on a poll already on hold answers "the poll is already on hold".

## 0.1.2 (2026-11-18)

Features from the backlog. Each was tried with the stand-in agent and in Chrome, none yet with a real `claude` or another real CLI.

- **Releases.** npm publishing uses trusted publishing (OIDC); the repository holds no npm token.
- **Static fire.** A T-minus poll with a subject: running SIMSUP agents try to break it, RETRO agents write the rollback. A second agent in a position takes the next free name (`guido-2`).
- **Hold and Telemetry.** A Hold key per agent (Claude Code and Gemini CLI) and a timeline of its tool calls (`telemetry.jsonl`, 200 calls per agent).
- **Patch Panel, Flight Rules and Commissioning.** A command bar (Cmd+K or Ctrl+K) that opens any console, view or action, one screen with every setting, and a checklist for an empty room. The views without a key of their own (Party Line, Plot Board, Black Box, Hangar, Recorder) open from the Patch Panel.
- **Party Line.** Messages grouped into conversations, with a reply box.
- **Relief.** FLIGHT can ask to hire an agent with `hire_agent`; only your GO hires it. Limits: `default` or `acceptEdits` only, at most 24 agents, 3 requests waiting, 5 in 10 minutes, 30 minutes to answer.
- **Mass Budget and Star Chart.** REFLECT asks an agent to condense its `memory.md` (gonogo keeps one copy and never writes the file); the Mission Log as a graph. Semantic search is not built: it needs a model gonogo does not ship.
- **Hangar and Recorder.** The files and the git of one agent's folder: a tree with a plain editor (create and save, no delete or rename), and status, diff, log and commit (no push, pull, checkout or reset).
- **Clearance, Pad Check and Rollout.** A model and API keys per agent (`keys.json`, written once, never shown); `gonogo doctor` lists the agent CLIs found and prints the vendor's install command, never runs it; once a day gonogo asks the npm registry for a newer version (turn it off with `GONOGO_UPDATE_CHECK=0` or `--no-update-check`) and `gonogo update` prints the command.
- **Plot Board.** One shared plan (`board.md`): every agent reads it, FLIGHT and you write it, and a write must name the revision it read.
- **Black Box.** An append-only record of the room (hires, stops, polls, Redline trips, plan changes, uplink deliveries, configuration changes) in a git repository in `~/.gonogo/black-box/`, committed by the server in batches. Names and ids only. Without git the room works and the page says so.
- **MCP tools.** `board_read`, `board_write` (boss only) and `hire_agent` (boss only) join the others.
- **Files.** New in the home: `board.md`, `black-box/`, `telemetry.jsonl`, `keys.json`, `rollout.json`. `agents.json` keeps version 1 with new optional fields (`model`, the names of keys): a gonogo older than this one drops them on its next save, while the values stay in `keys.json`.
- **Docs.** Every page opens with its piece of the room, in the room's style, and the pages are shorter. The home page says what go / no-go means.
- **Fix.** The image and CI build with pnpm 12.

## 0.1.1 (2026-11-18)

- **npm.** The package is published as `@ulm0/gonogo` (the unscoped `gonogo` on npm is another project); the command stays `gonogo`. `.github/workflows/release.yml` publishes it with provenance for each `v*` tag and creates or updates its GitHub Release from this changelog.
- **Docker Compose.** `compose.yaml` pulls `ghcr.io/ulm0/gonogo:latest` instead of building, restarts always, sets no `container_name` and publishes `GONOGO_PORT` (default 7777), so several instances can run side by side (`docker compose -p <name>`).
- **Clean Room.** `GONOGO_CLEANROOM_NETWORK=container:self` finds gonogo's own container by its host name.
- **Fix.** `gonogo --help` named the old default Clean Room image `gonogo`; it is `ghcr.io/ulm0/gonogo`.

## 0.1.0 (2026-11-17)

The first release, as the image `ghcr.io/ulm0/gonogo:0.1.0`. Its tag still names the package `gonogo`, so 0.1.0 was not published to npm.

- **Server and room.** One Node process starts each agent as a real `claude` in a pseudo-terminal and shows the terminals, a room of consoles, a wall, the Brief box and go/no-go polls in the browser, on a phone too. FLIGHT is the boss agent. Agents message each other and the Director through MCP tools. A token in the URL guards the page; state lives in `~/.gonogo`. At most 24 agents.
- **Engine Bay.** Gemini CLI, Codex and other CLIs as engines besides Claude Code (not yet tried against a model).
- **Payload.** MCP servers and skill folders per agent.
- **Clean Room.** A Claude Code agent in a Docker container with a copy of its project.
- **Redline.** Stops an agent that loops, hits an error storm or ping-pongs messages.
- **Propellant.** Token budgets per agent and for the room, over 5 hours, a day, a week or a month.
- **Launch Window.** Schedules that send a message on a rule.
- **Uplink.** Webhooks, signed or with a bearer token, delivered to an agent.
- **Relay.** Slack, GitHub, Linear and Telegram in, Slack and Telegram out (never run against the real services).
- **Flight Plan.** A task board shared by you and the agents.
- **Downlink.** An inbox for what agents send to you and for alerts.
- **Mission Log.** A shared memory with search.
- **Livery.** Four themes, and themes an agent designs, checked for contrast.
- **Docking.** Two installations pair, message each other and hand off tasks.
- **Packaging.** The `gonogo` command from a clone or a packed tarball (Node 24 or newer, macOS or Linux with glibc), a Docker image for linux/amd64 and linux/arm64, and the documentation site <https://gonogo.ulm0.com/>.

What was not verified is listed in [What was not verified](https://gonogo.ulm0.com/reference/not-verified.html).
