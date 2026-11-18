# Changelog

All notable changes to gonogo. Versions follow [Semantic Versioning](https://semver.org/); before 1.0.0 a minor release may break things.

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
