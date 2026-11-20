---
pageClass: countdown
---

# Getting started

Run coding agents (Claude Code, Codex, Gemini CLI and more) as real CLIs in terminals you watch from a browser tab; they message each other and share a task board. One Node process; state is files in one directory; closing the tab stops nothing.

<RoomMock class="doc-mock" />

<div class="t-step">

## Requirements

- Node 24+; macOS or Linux with glibc 2.28+ (not Alpine, not Windows). Do not install with `--no-optional`: the terminal library's binary is an optional package, and without it `gonogo` prints the library's message and exits with code 1.
- One agent CLI on the `PATH`, signed in: `claude` (written against 2.1.325) or another ([Engine Bay](../features/engine-bay.md)). Telemetry and Max Q need hooks (Claude Code, Gemini CLI); other engines show state from their output. How far each was checked: [What was not verified](../reference/not-verified.md).

</div>

<div class="t-step">

## Run it

```
npm i -g @ulm0/gonogo@latest && gonogo     # install the command
pnpm --config.minimum-release-age-exclude=@ulm0/gonogo dlx @ulm0/gonogo@%VERSION%   # or run once with pnpm
brew install ulm0/tap/gonogo               # or Homebrew; update: brew upgrade gonogo
pnpm install && pnpm build && pnpm start   # or from a clone (`corepack enable pnpm`)
```

Scoped name only: the unscoped `gonogo` on npm is another project, and `pnpm dlx gonogo` runs it with your credentials. With pnpm, name the version and exempt gonogo: where `minimumReleaseAge` is set, a young release is refused and `@latest` picks an older one (dependencies keep the check). [Options](../reference/configuration.md#options) follow the command: `gonogo --port 7780`, `pnpm start --port 7780`.

</div>

<div class="t-step">

## First run

It prints, on stdout (the rest is stderr):

```
gonogo ready: http://127.0.0.1:7777/#token=<64 hex characters>
gonogo setup: open http://127.0.0.1:7777/setup and give this setup token (one use, one hour; it is also in ~/.gonogo/setup-token): <token>
```

Open `/setup`, give the setup token, a name and a password of 12+ characters: you are signed in ([Login](../features/login.md)). Setup is answered on this machine and your local network only. Once the account exists the `#token=` address stops working (the file is deleted for good); scripts and `gonogo tui` use the local socket, or a key (`gonogo auth key add <name> --remote`). The token after `#` is never sent to a server: the page keeps it and clears the address bar. **The URL and the setup token are passwords: the server runs shells.**

</div>

<div class="t-step">

## Staff your first console

`+ STAFF A CONSOLE` (or an open cell): pick an engine (Claude Code by default), a name (lowercase letters, digits, hyphens, at most 32), a role, an absolute working directory that exists on the gonogo machine (`~` is not expanded) and a permission mode ([Permissions](../features/permissions.md); `bypassPermissions` needs a ticked box). At most 24 agents; edits apply at the next restart. Folds: [Payload](../features/payload.md), [Clean Room](../features/clean-room.md), MODEL and CLEARANCE ([Engine Bay](../features/engine-bay.md#model)). `gonogo doctor` lists the agent CLIs found; [Rollout](../features/rollout.md) tells you about a newer gonogo. Docs: <https://gonogo.ulm0.com/>.

</div>
