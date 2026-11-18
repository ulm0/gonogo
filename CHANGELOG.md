# Changelog

All notable changes to gonogo. Versions follow [Semantic Versioning](https://semver.org/); before 1.0.0 a minor release may break things.

## Unreleased

- **Fix: colours that were never drawn.** The "older diff" line of a review verdict and the near-budget or over-budget spend line of a mission named custom properties that do not exist, so they showed no colour; they use the amber text token now. Two focus rings and the mono font of one field had the same flaw. A test now checks that every `var()` in the page's style sheets names a defined property.

- **Tab name.** Flight Rules has a TAB NAME field: the title of the browser tab becomes `<name> · gonogo` (the unread count stays in front), to tell several gonogo sessions apart. Kept on the server for every browser; default is the station name when `GONOGO_STATION` is set, else `gonogo`.
- **`gonogo tui`: a console cannot write your clipboard or title.** The OSC 52 (clipboard) and OSC 0, 1, 2 (title) sequences in a console's output are cut before they reach your terminal, across the pieces the output arrives in.

- **Plan quota.** For a claude.ai subscription the Propellant module shows the plan's own 5-hour and weekly use, as Claude Code's status line reports it, with an alert at 80 and 95 %. Your own status line is chained, not replaced. Without a source it says so and the meters stay an estimate. Seen once in a real run (the weekly window only); not tried in a Clean Room or with an API key. At most one report per agent every 10 s; an alert comes again only when a window's reset moves forward.
- **Link to the online docs.** <https://gonogo.ulm0.com/> is in the start-up log (a log line: stdout keeps its one `gonogo ready:` line), `gonogo --help`, `gonogo doctor`, a Docs line in the Patch Panel and the Commissioning checklist. One constant, `DOCS_URL`. The package `homepage` and the README already had it.

- **Amazon Bedrock.** Checked against the vendors' docs and gonogo's code, not run against AWS: Claude Code is expected to work with the AWS variables as Clearance keys or in the shell (a Clean Room needs keys; it has no `~/.aws`), Bedrock ids fit the model field and show as unpriced until you add a price row. The hire form suggests the Bedrock key names. A Bedrock section in the Engine Bay page and `docs/facts/bedrock.md`.
- **Tool permissions.** Choose what a Claude Code console's harness may do: allow, ask and deny rules (`Bash(git:*)`, `WebFetch(domain:...)`) in a console's form, with room-wide rules in Flight Rules. They go into the console's own settings file after gonogo's rules, which stay; the mode is unchanged. Other engines say "not supported".
- **Model per position.** Flight Rules has a BY POSITION list: a Claude Code console in a position starts with that position's model before its engine's room default; its own model still wins.
- **Cost per mission and task.** A reply is counted to the mission and task the agent has on `doing`; the Missions view shows the cost of each mission and each task.
- **Mission budget.** A dollar budget on a mission: one Downlink warning at 80 %, and Redline stops the agents working on it at 100 %.
- **Room editor.** EDIT ROOM puts the blocks of the Room view (the wall's five and OPERATIONS) on a 12-column grid: move and resize by pointer or keyboard, hide what you do not use (never OPERATIONS), choose the order of the consoles (drag, or Positions, Needs you first, Name). A saved layout is shared by every browser and read by the phone; a hidden block with something live shows a strip. Without one the page is as it was. Saves name the revision they were made from.
- **`gonogo tui`.** A terminal client of a running server, usable at the same time as the page: the roster, the Downlink with replies, GO and NO-GO for permission dialogs and Relief requests, hold and resume, messages to an agent, and a console you type into (Ctrl-] then q leaves it). Plain ANSI on the `ws` dependency; it reads the token from gonogo's home and never prints it. Texts written by agents are shown with control characters removed.

- **Version corner and Update.** The running version shows small in a corner and links to the changelog. Rollout tells how gonogo was installed (container, npm, pnpm, dlx, git checkout) and shows the right update path. With an npm or pnpm global install, or a container with an update hook (`GONOGO_UPDATE_HOOK`), an **Update** button installs the version the check found, then reloads when the agents survive it. Never without that click. The image sets `GONOGO_INSTALL=docker`.
- **Live reload (opt-in).** `gonogo --pty-host` keeps the agents in a small process of their own, so `gonogo reload` (or Reload in Flight Rules) starts a new gonogo without stopping them: the turn in progress, the screen, and a Hold all survive. Tokens are saved as hashes. Off by default for one release.

## Unreleased

- **Start again after a restart.** A Flight Rules setting (the boss only, the default; every console that was running; nobody) starts the consoles that were running when the server stopped, the boss first and then three at a time. A console you stopped, held or that tripped the Redline stays stopped; a console can opt out; one that was in the middle of a turn is told once to carry on. The boss gets a `start_agent` tool for a stopped console (a Flight Rules switch turns it off), recorded in the Black Box. ALL STOP and ALL RESUME (Flight Rules and the Patch Panel) hold and resume every console at once.

## 0.2.0 (2026-11-18)

Features and fixes since 0.1.2. Each was tried with the stand-in agent only: not verified with a real `claude`, `agy`, Telegram or remote control, and not in a browser.

- **Post-Flight Review** (issue #37). The Recorder shows an agent's changes against its last commit as files and hunks with line numbers. You add notes on lines (tone, replies, resolve), give a verdict (APPROVE, or REQUEST CHANGES, which mails the open notes to the agent), ask the agent for a WALKTHROUGH of its own diff, or ask another agent for a PEER REVIEW. Agents use two new tools, `review_read` and `review_note`; a peer may read and note a diff only while your request is pending. A note follows its line when it moves and goes to an Outdated group when the line is gone. COMMIT asks once more when notes are open. Native: no external viewer, no extra port, no top-bar key; the notes are in `reviews.json`, out of the reach of a Clean Room.

- **Antigravity CLI.** `agy` joins Engine Bay (issue #28) with its permission modes, `--model` and the role as the first prompt; Gemini CLI stays, marked legacy. For now it has no hooks and no gonogo tools: `agy` reads them only from the project or `~/.gemini`, which gonogo does not write. Checked against its help only, not run against a signed-in `agy` (`docs/facts/antigravity.md`).
- **Missions.** A named goal with a status (planned, active, paused, done, aborted), a lead, a history and the Flight Plan tasks that serve it (`missionId` on a task). A Missions view from the Patch Panel, the wall's mission block and the brief box; FLIGHT gets the goal when a mission starts, and the Director is told when its last task is done and decides whether to close it. Three tools for agents (`mission_list`; `mission_create` and `mission_update` for the boss). The wall shows the active mission and falls back to the old guess when there is none.
- **Cost.** Propellant can show dollars (an API-equivalent estimate at list prices) with a budget, a chart of the last 14 days and an editable price table (`~/.gonogo/prices.json`, no network). A budget trips Redline like a token limit and warns once at 80 %. New ledger lines keep the model and the token split; older ones show as unpriced.
- **Container.** The image has the `gh` CLI (2.103.3, checksum verified), and the config of `gh` and of `git config --global` lives in `/state/config`, so a login survives a restart. `POST /api/poll/hold` on a poll already on hold answers "the poll is already on hold".
- **Worktrees.** An `Own git worktree` box starts an agent in its own git worktree and branch (`~/.gonogo/worktrees/<name>`, `gonogo/<name>`), for every engine; the remove dialog can delete the worktree and branch, and git keeps unsaved or unmerged work.
- **Default models.** Flight Rules sets a room model for each engine; consoles with no model of their own use it at their next start. The model field says where its value comes from and that a `/model` typed in a console is not kept.
- **Notifications.** A switch in Flight Rules (off by default, per browser) shows a browser notification for a message to you, a T-minus poll that holds or comes out go, and a Relief request, while the tab is hidden or not focused. Clicking it opens the view. The tab title counts what waits, with or without permission.
- **Phone approvals.** A pending permission or hire request can go to your Telegram chat with signed GO and NO-GO buttons (a hire request: NO-GO and Open only), and an agent can start with `--remote-control` to be approved in the Claude app. Chosen in Flight Rules. Late presses do nothing (`needSeq`). Both are new inbox events too.

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
