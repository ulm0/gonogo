---
pageClass: countdown
---

# Getting started

Run a mission-control room of Claude Code agents from a browser tab.

<RoomMock class="doc-mock" />

gonogo is one Node process. It starts every agent as a real `claude` process in a pseudo-terminal, shows each terminal in the browser, draws the agents as consoles on an operations floor, and lets them message each other and share a task board through seven tools. All state is a few files in one directory. Closing the tab stops nothing. It is a fresh code base: no code, art or names were taken from another application.

Status: the npm package is `@ulm0/gonogo`; see [What was not verified](../reference/not-verified.md).

<div class="t-step">

## Requirements

- Node 24 or newer.
- `claude` (Claude Code) on the `PATH`, signed in. Written against Claude Code 2.1.325.
- macOS, or Linux with glibc 2.28 or newer. No Alpine (musl), no Windows (`package.json` lists only `darwin` and `linux`, so pnpm refuses to install it elsewhere).
- Do not install with `--no-optional` (npm calls it `--omit=optional`): the terminal library ships its binary as an optional platform package. On a platform without one, `gonogo` prints the library's message as a single line and exits with code 1.

</div>

<div class="t-step">

## Run it

From the npm registry, with pnpm:

```
pnpm dlx @ulm0/gonogo                      # run it once
pnpm add -g @ulm0/gonogo && gonogo         # or install the gonogo command
```

The package is `@ulm0/gonogo`. The unscoped name `gonogo` on npm belongs to another project: `pnpm dlx gonogo` runs that one, with your credentials. The command is `gonogo` either way, and the [options](../reference/configuration.md#options) go after it (`pnpm dlx @ulm0/gonogo --port 7780`).

From a clone of the repository, with pnpm (`corepack enable pnpm` installs the release that `packageManager` in `package.json` pins):

```
pnpm install && pnpm build && pnpm start
```

`start` is `node bin/gonogo.js`, so the [options](../reference/configuration.md#options) go after it: `pnpm start --port 7780`. `pnpm-lock.yaml` is the lock file.

When the server listens it prints one line on stdout (everything else goes to stderr):

```
gonogo ready: http://127.0.0.1:7777/#token=<64 hex characters>
```

Open that URL. The token sits after the `#`, the part of a URL that browsers never send to a server. The page keeps it in the browser's local storage and removes it from the address bar. A copy is in `~/.gonogo/token` (mode 0600), so `echo "http://127.0.0.1:7777/#token=$(cat ~/.gonogo/token)"` rebuilds the URL. Treat the URL like a password: the server runs shells.

</div>

<div class="t-step">

## Staff your first console

Staffing a console (`+ STAFF A CONSOLE`, or an open cell) asks for an engine (Claude Code unless you pick another, see [Engine Bay](../features/engine-bay.md)), a name (lowercase letters, digits and hyphens, at most 32), a role (free text, at most 4000 characters), a working directory (an absolute path on the machine where gonogo runs, `~` is not expanded; it must exist) and a permission mode: `default` (asks before a tool runs), `acceptEdits` (edits files without asking), `auto` (Claude decides which tool calls are safe to run without asking and asks about the rest) or `bypassPermissions`. The last runs every tool without asking and needs a ticked box. `auto` is passed to Claude Code as `--permission-mode auto` and nothing else; whether it is available depends on your account and model, which Claude Code decides. The operations room holds at most 24 agents; a 25th hire is refused. Changes made with Edit apply at the next restart. The PAYLOAD fold adds MCP servers and skill folders to one agent (see [Payload](../features/payload.md)), and the Clean Room box runs a Claude Code agent in a container (see [Clean Room](../features/clean-room.md)).

</div>
