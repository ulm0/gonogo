---
description: "Install gonogo with npm, Homebrew or Docker, make the account on the first run, and staff your first coding agent in a few minutes."
pageClass: countdown
---

# Getting started

Run coding agents (Claude Code, Codex, Gemini CLI and more) as real CLIs in terminals you watch from a browser tab; they message each other and share a task board. New words: [Glossary](./glossary.md).

<RoomMock class="doc-mock" />

<div class="t-step">

## Before you start

Run `claude` once in an ordinary terminal and finish its sign-in (theme, login). gonogo starts it for you, but one that never ran stops at its own first-run dialogs inside the web terminal. You also need Node 24+, `git`, and macOS or Linux (glibc 2.28+).

::: details Other engines, platforms, install problems
- Another agent CLI instead of `claude`: [Engine Bay](../features/engine-bay.md); how far each was checked: [What was not verified](../reference/not-verified.md). Telemetry and Max Q need hooks (Claude Code, Gemini CLI).
- Not Alpine (musl), not Windows. Do not install with `--no-optional`: the terminal library's binary is an optional package, and without it `gonogo` exits with code 1.
- `EACCES ... mkdir '/usr/local/lib/node_modules/@ulm0'` on `npm i -g`: use nvm or fnm, or `npm config set prefix ~/.npm-global` and add its `bin` to the `PATH`.
:::

</div>

<div class="t-step">

## Start it

**With npm**

```
npm i -g @ulm0/gonogo@latest
gonogo
```

It prints an address and a setup line (next step). Also: `brew install ulm0/tap/gonogo`, or from a clone `pnpm install && pnpm build && pnpm start`. [Options](../reference/configuration.md#options) follow the command (`--port 7780`).

::: details pnpm dlx
`pnpm --config.minimum-release-age-exclude=@ulm0/gonogo dlx @ulm0/gonogo@%VERSION%`. Use the scoped name (the unscoped `gonogo` on npm is another project and would run with your credentials) and the version: where `minimumReleaseAge` is set, pnpm refuses a young release or picks an older one for `@latest`.
:::

**With Docker**, credential first. On a machine where `claude` is signed in run `claude setup-token` and keep the token (or use `ANTHROPIC_API_KEY`; one of the two). Then, in an empty folder:

```
export CLAUDE_CODE_OAUTH_TOKEN=<the token>
curl -fsSLO https://raw.githubusercontent.com/ulm0/gonogo/v%VERSION%/compose.yaml
sudo install -d -o 1000 -g 1000 gonogo-data gonogo-data/projects gonogo-data/home
printf 'GONOGO_DATA=%s\nDOCKER_GID=%s\n' "$PWD/gonogo-data" "$(stat -L -c %g /var/run/docker.sock)" > .env
docker compose up -d && docker compose logs gonogo
```

The logs end with the same address and setup line. **The compose file mounts the host's Docker socket: root on the host for every agent in the container** ([Docker](./docker.md#clean-room-in-the-container); a plain `docker run` without the socket is on that page too).

::: details No credential in Docker
FLIGHT looks ready (green), its console says `Not logged in · Run /login`, and a brief gets no answer. Export the token and run `docker compose up -d` again, or open FLIGHT's console and type `/login`.
:::

</div>

<div class="t-step">

## First run

```
gonogo ready: http://127.0.0.1:7777/#token=<64 hex characters>
gonogo setup: open http://127.0.0.1:7777/setup and give this setup token (one use, one hour; it is also in ~/.gonogo/setup-token): <token>
```

Open `/setup`, give the setup token, a name and a password of 12+ characters: you are signed in ([Login](../features/login.md)). Once the account exists the `#token=` address stops working for good. **The address and the setup token are passwords: the server runs shells.**

::: details Browser on another machine (NAS, VPS)
gonogo listens on `127.0.0.1` only. On your own machine run `ssh -L 7777:127.0.0.1:7777 you@host`, then open the address there. Tailscale or a proxy: [Exposing gonogo safely](../https.md). Setup is answered on this machine and your local network only. Scripts and `gonogo tui` use the local socket, or a key (`gonogo auth key add <name> --remote`).
:::

</div>

<div class="t-step">

## Staff your first console

`+ STAFF A CONSOLE`: an engine (Claude Code by default), a name (lowercase letters, digits, hyphens), a role, a working directory (absolute, must exist; the form starts with the folder gonogo was started in) and a permission mode ([Permissions](../features/permissions.md)). Type your first brief in the box under the room: it goes to FLIGHT. The answer shows in FLIGHT's console; an agent that messages you shows in the Downlink (the unread count on COMMS).

::: details Hire form details
Name at most 32 characters; role at most 4000; `~` is not expanded in the directory; `bypassPermissions` needs a ticked box. At most 24 agents; edits apply at the next restart. Folds: [Payload](../features/payload.md), [Clean Room](../features/clean-room.md), MODEL and CLEARANCE ([Engine Bay](../features/engine-bay.md#model)). [Rollout](../features/rollout.md) tells you about a newer gonogo.
:::

`gonogo doctor` lists the agent CLIs found.

</div>
