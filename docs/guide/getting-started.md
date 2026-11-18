---
pageClass: countdown
---

# Getting started

Run a mission-control room of Claude Code agents from a browser tab.

<RoomMock class="doc-mock" />

gonogo is one Node process. It runs each agent as a real `claude` process in a pseudo-terminal, shows the terminals in the browser, and gives the agents seven tools to message each other and share a task board. State is a few files in one directory. Closing the tab stops nothing.

The npm package is `@ulm0/gonogo`; see [What was not verified](../reference/not-verified.md).

<div class="t-step">

## Requirements

- Node 24 or newer.
- `claude` (Claude Code) on the `PATH`, signed in. Written against Claude Code 2.1.325.
- macOS, or Linux with glibc 2.28 or newer. Not Alpine (musl), not Windows: pnpm refuses to install elsewhere.
- Do not install with `--no-optional` (`--omit=optional`): the terminal library ships its binary as an optional platform package. Without one, `gonogo` prints the library's message as one line and exits with code 1.

</div>

<div class="t-step">

## Run it

From npm:

```
pnpm dlx @ulm0/gonogo                      # run it once
pnpm add -g @ulm0/gonogo && gonogo         # or install the gonogo command
```

Use the scoped name: the unscoped `gonogo` on npm is another project, and `pnpm dlx gonogo` runs it with your credentials. [Options](../reference/configuration.md#options) go after the command: `pnpm dlx @ulm0/gonogo --port 7780`.

From a clone (`corepack enable pnpm` installs the pinned pnpm):

```
pnpm install && pnpm build && pnpm start
```

Options go after `start`: `pnpm start --port 7780`.

When the server listens it prints one line on stdout (everything else goes to stderr):

```
gonogo ready: http://127.0.0.1:7777/#token=<64 hex characters>
```

Open that URL. The token after `#` is never sent to a server; the page stores it locally and clears it from the address bar. A copy is in `~/.gonogo/token` (mode 0600), so `echo "http://127.0.0.1:7777/#token=$(cat ~/.gonogo/token)"` rebuilds the URL. Treat the URL like a password: the server runs shells.

</div>

<div class="t-step">

## Staff your first console

`+ STAFF A CONSOLE` (or an open cell) asks for:

- **Engine:** Claude Code unless you pick another ([Engine Bay](../features/engine-bay.md)).
- **Name:** lowercase letters, digits and hyphens, at most 32.
- **Role:** free text, at most 4000 characters.
- **Working directory:** an existing absolute path on the gonogo machine; `~` is not expanded.
- **Permission mode:** `default` (asks before a tool runs), `acceptEdits` (edits files without asking), `auto` (Claude asks only about calls it judges unsafe; passed as `--permission-mode auto`, availability depends on your account and model) or `bypassPermissions` (runs every tool without asking; needs a ticked box).

The room holds at most 24 agents; a 25th hire is refused. Edits apply at the next restart. The PAYLOAD fold adds MCP servers and skills ([Payload](../features/payload.md)); the Clean Room box runs the agent in a container ([Clean Room](../features/clean-room.md)). The MODEL field and the CLEARANCE fold (API keys for this console only) are in [Engine Bay](../features/engine-bay.md#model); `gonogo doctor` lists the agent CLIs on your `PATH`, and [Rollout](../features/rollout.md) tells you when a newer gonogo is out.

</div>
