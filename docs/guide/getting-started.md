---
pageClass: countdown
---

# Getting started

Run coding agents (Claude Code, Codex, Gemini CLI and more) as real CLIs in terminals you watch from a browser tab; they message each other and share a task board. One Node process; state is files in one directory; closing the tab stops nothing.

<RoomMock class="doc-mock" />

<div class="t-step">

## Requirements

- Node 24+; macOS or Linux with glibc 2.28+ (not Alpine, not Windows). No `--no-optional` install: the terminal binary is an optional package.
- One agent CLI on the `PATH`, signed in: `claude` (written against 2.1.325) or another ([Engine Bay](../features/engine-bay.md)). Telemetry and Max Q need hooks (Claude Code, Gemini CLI).

</div>

<div class="t-step">

## Run it

```
npm i -g @ulm0/gonogo@latest && gonogo     # install the command
pnpm --config.minimum-release-age-exclude=@ulm0/gonogo dlx @ulm0/gonogo@%VERSION%   # or run once with pnpm
brew install ulm0/tap/gonogo               # or Homebrew; update: brew upgrade gonogo
pnpm install && pnpm build && pnpm start   # or from a clone (`corepack enable pnpm`)
```

Scoped name only: the unscoped `gonogo` on npm is another project, and `pnpm dlx gonogo` runs it with your credentials. With pnpm, name the version and exempt gonogo: where `minimumReleaseAge` is set, a young release is refused and `@latest` picks an older one (dependencies keep the check). [Options](../reference/configuration.md#options) follow the command (`--port 7780`).

It prints one line on stdout (the rest is stderr): `gonogo ready: http://127.0.0.1:7777/#token=<64 hex characters>`. Open it; the page keeps the token and clears the address bar. A copy is in `~/.gonogo/token` (0600): `echo "http://127.0.0.1:7777/#token=$(cat ~/.gonogo/token)"`. **The URL is a password: the server runs shells.**

</div>

<div class="t-step">

## Staff your first console

`+ STAFF A CONSOLE` (or an open cell):

| Field | Value |
|---|---|
| Engine | Claude Code by default |
| Name | lowercase letters, digits, hyphens; at most 32 |
| Role | free text; at most 4000 characters |
| Working directory | an existing absolute path on the gonogo machine (`~` is not expanded) |
| Permission mode | `default` asks before a tool runs; `acceptEdits` edits without asking; `auto` asks only about calls judged unsafe (depends on account and model); `bypassPermissions` runs everything (tick the box) |

At most 24 agents. Edits apply at the next restart. Folds: [Payload](../features/payload.md), [Clean Room](../features/clean-room.md), MODEL and CLEARANCE ([Engine Bay](../features/engine-bay.md#model)). `gonogo doctor` lists the agent CLIs found; [Rollout](../features/rollout.md) tells you about a newer gonogo. Docs: <https://gonogo.ulm0.com/>.

</div>
