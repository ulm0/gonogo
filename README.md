<p><img src="docs/brand/lockup.svg" alt="gonogo" width="280"></p>

# gonogo

Self-hosted mission control for coding agents, in a browser tab. One Node process starts each agent as a real `claude` (or another CLI, see Engine Bay) in a terminal, shows the terminals and a room of consoles in the browser (it works on a phone), and lets the agents message each other. Closing the tab stops nothing. One person per installation.

Documentation: <https://gonogo.ulm0.com/>

- **Room:** consoles, a wall, a Brief box, go/no-go polls, FLIGHT the boss.
- **Guard rails:** Redline (stops loops and error storms), Propellant (token budgets), Clean Room (a container per agent).
- **Work in:** Launch Window (schedules), Uplink (webhooks), Relay (Slack, GitHub, Linear, Telegram), Flight Plan (tasks), Downlink (inbox).
- **Shared:** Mission Log (memory with search), Payload (MCP servers and skills), Engine Bay (Gemini, Codex and other CLIs, not yet tried against a model).
- **Look and links:** Livery (themes), Docking (two installations message each other and hand off tasks).

## Install

Needs Node 24+, macOS or Linux (glibc), and `claude` on your `PATH`, signed in. With [pnpm](https://pnpm.io/), from the npm registry (the package is `@ulm0/gonogo`; the unscoped `gonogo` there is another project), from a clone, or in Docker:

```
pnpm dlx @ulm0/gonogo                      # or: pnpm add -g @ulm0/gonogo && gonogo
pnpm install && pnpm build && pnpm start   # from a clone
docker build -t gonogo . && docker run -d --name gonogo --init -p 127.0.0.1:7777:7777 -e CLAUDE_CODE_OAUTH_TOKEN -v gonogo-state:/state -v gonogo-projects:/projects gonogo
```

It prints `gonogo ready: http://127.0.0.1:7777/#token=...` (Docker: `docker logs gonogo`). Open that URL. The token after the `#` is your password, and the server runs shells as you. State lives in `~/.gonogo` (`/state/gonogo` in Docker). Keep the port on `127.0.0.1`; to use it from another device or take webhooks, read [`docs/https.md`](docs/https.md).

Clean Room with gonogo itself in Docker: [`compose.yaml`](compose.yaml) mounts the host's Docker socket, **which gives the container and every agent in it root over the host**. Read [Clean Room in the container](docs/guide/docker.md#clean-room-in-the-container) first.

## More

The [documentation site](https://gonogo.ulm0.com/) (source in `docs/`) has the full usage, [`docs/https.md`](docs/https.md) exposing it safely, [`CONTRIBUTING.md`](CONTRIBUTING.md) how to work on it, [`docs/backlog.md`](docs/backlog.md) what is planned, [`CHANGELOG.md`](CHANGELOG.md) what each release changed. License: MIT, see [`LICENSE`](LICENSE) and `dist/client/THIRD-PARTY-NOTICES.md`.
