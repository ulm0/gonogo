---
description: "Install gonogo with npm, Homebrew or Docker, make the account on the first run, and staff your first coding agent in a few minutes."
pageClass: countdown
---

# Getting started

Run coding agents (Claude Code, Codex, Gemini CLI and more) as real CLIs in terminals you watch from a browser tab; they message each other and share a task board. One Node process; state is files in one directory; closing the tab stops nothing.

<RoomMock class="doc-mock" />

<div class="t-step">

## Requirements

1. **Run `claude` once in an ordinary terminal and finish its sign-in** (theme, login). gonogo starts it for you, but an installed `claude` that never ran stops at its own first-run dialogs inside the web terminal. (Another engine: [Engine Bay](../features/engine-bay.md). In Docker, see below.)
2. Node 24+, and `git` (Recorder, worktrees and the Black Box need it); macOS or Linux with glibc 2.28+ (not Alpine, not Windows). Do not install with `--no-optional`: the terminal library's binary is an optional package, and without it `gonogo` prints the library's message and exits with code 1.
3. The agent CLI is on the `PATH`: `claude` (written against 2.1.325) or another. Telemetry and Max Q need hooks (Claude Code, Gemini CLI); other engines show state from their output. How far each was checked: [What was not verified](../reference/not-verified.md).

</div>

<div class="t-step">

## Run it

```
npm i -g @ulm0/gonogo@latest && gonogo     # install the command
pnpm --config.minimum-release-age-exclude=@ulm0/gonogo dlx @ulm0/gonogo@%VERSION%   # or run once with pnpm
brew install ulm0/tap/gonogo               # or Homebrew; update: brew upgrade gonogo
pnpm install && pnpm build && pnpm start   # or from a clone (`corepack enable pnpm`)
```

Scoped name only: the unscoped `gonogo` on npm is another project, and `pnpm dlx gonogo` runs it with your credentials. With pnpm, name the version and exempt gonogo: where `minimumReleaseAge` is set, a young release is refused and `@latest` picks an older one (dependencies keep the check). `EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@ulm0'` on `npm i -g`: use nvm or fnm, or `npm config set prefix ~/.npm-global` and add its `bin` to the `PATH`. [Options](../reference/configuration.md#options) follow the command: `gonogo --port 7780`, `pnpm start --port 7780`.

### Or in Docker

Put the credential first: without it FLIGHT looks ready (green), its console says `Not logged in · Run /login`, and a brief gets no answer. On a machine where `claude` is signed in, run `claude setup-token` and keep the token (or use `ANTHROPIC_API_KEY`; one of the two, not both). Then, in an empty folder:

```
export CLAUDE_CODE_OAUTH_TOKEN=<the token>
curl -fsSLO https://raw.githubusercontent.com/ulm0/gonogo/v%VERSION%/compose.yaml
sudo install -d -o 1000 -g 1000 gonogo-data gonogo-data/projects gonogo-data/home
printf 'GONOGO_DATA=%s\nDOCKER_GID=%s\n' "$PWD/gonogo-data" "$(stat -L -c %g /var/run/docker.sock)" > .env
docker compose up -d && docker compose logs gonogo
```

The logs end with the two lines of [First run](#first-run) (the `gonogo ready:` address and the setup token): open the `/setup` address. Forgot the token? Export it and run `docker compose up -d` again, or open FLIGHT's console and type `/login`. **`compose.yaml` mounts the host's Docker socket, which is root on the host for every agent in the container** ([Docker](./docker.md#clean-room-in-the-container)); for a plain `docker run` without the socket see [Docker](./docker.md).

</div>

<div class="t-step">

## First run

It prints, on stdout (the rest is stderr):

```
gonogo ready: http://127.0.0.1:7777/#token=<64 hex characters>
gonogo setup: open http://127.0.0.1:7777/setup and give this setup token (one use, one hour; it is also in ~/.gonogo/setup-token): <token>
```

Open `/setup`, give the setup token, a name and a password of 12+ characters: you are signed in ([Login](../features/login.md)). Setup is answered on this machine and your local network only. Once the account exists the `#token=` address stops working (the file is deleted for good); scripts and `gonogo tui` use the local socket, or a key (`gonogo auth key add <name> --remote`). The token after `#` is never sent to a server: the page keeps it and clears the address bar. **The URL and the setup token are passwords: the server runs shells.**

**Browser on another machine** (a NAS, a VPS, a home server)? gonogo listens on `127.0.0.1` only. On your own machine run `ssh -L 7777:127.0.0.1:7777 you@host`, then open the address there. Other ways in (Tailscale, a proxy): [Exposing gonogo safely](../https.md).

</div>

<div class="t-step">

## Staff your first console

`+ STAFF A CONSOLE` (or an open cell): pick an engine (Claude Code by default), a name (lowercase letters, digits, hyphens, at most 32), a role, an absolute working directory that exists on the gonogo machine (`~` is not expanded; the form starts with the folder gonogo was started in) and a permission mode ([Permissions](../features/permissions.md); `bypassPermissions` needs a ticked box). At most 24 agents; edits apply at the next restart. Folds: [Payload](../features/payload.md), [Clean Room](../features/clean-room.md), MODEL and CLEARANCE ([Engine Bay](../features/engine-bay.md#model)). `gonogo doctor` lists the agent CLIs found; [Rollout](../features/rollout.md) tells you about a newer gonogo. Docs: <https://gonogo.ulm0.com/>.

**Your first brief.** Type it in the box under the room (it goes to FLIGHT). The answer shows in FLIGHT's console; an agent that messages you shows in the Downlink (the unread count on COMMS).

</div>

## Words you will meet

| Word | Meaning |
|---|---|
| **Room** | One gonogo with its own agents, mail, task board and settings. `main` is the first; the page at `/` lists them. |
| **Console** | One agent: its terminal, its tile in the room, its state. "Staff" a console means hire an agent. |
| **FLIGHT** | The boss agent, made at the first start. It takes your brief and hands out work. You are the **Director**. |
| **Brief** | A message you type in the box under the room; it goes to FLIGHT. |
| **Downlink** | Your inbox: what agents send you and what needs a go or no-go. **COMMS** (INBOX, TRAFFIC, THREADS) shows it and all other mail. |
| **Flight Rules** | The settings screen (round key with three sliders). **Patch Panel** (Cmd+K or Ctrl+K) jumps to any view or action. |
| **Propellant** | Token budgets that stop an agent or the room when used up; **Redline** stops loops and error storms. |

More: [The room](./the-room.md).
