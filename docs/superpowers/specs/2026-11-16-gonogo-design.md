# gonogo: design

Date: 2026-11-16. Status: approved by the owner ("proceed") on 2026-11-16, then revised the same day
after the fact-finding runs (`docs/facts/`). Revision 2 replaces revision 1 in full. The calls I made
without the owner are listed at the end.

`gonogo` is the owner's choice of name (2026-11-16). Its availability on npm has not been checked.

## Intent

Run an office of Claude Code agents from a browser tab. It is inspired by
[Munder Difflin](https://github.com/HarnessMD/munder-difflin), an Electron desktop app, but this is a
fresh, small, web-first codebase with no Electron and none of their code or art.

The owner wants it small. The reference app is about 60,000 lines; this one keeps only the core.

## What the owner decided

- Web native. No Electron in any form.
- Each agent is the real `claude` CLI running underneath, as in the desktop app.
- Fresh rewrite with only the core, not a fork of the reference code.
- Distributed two ways: an npm package and a Docker container.
- Built in one uninterrupted run, then tested.

Everything else in this document is my proposal.

## Approaches considered

1. **Fork the reference and strip Electron out.** Fake `ipcRenderer` and `ipcMain` over a WebSocket so
   their 218 bridge calls and 165 handlers run unedited. Nearly all features, but their 60,000 lines
   come along. Rejected by the owner: too big.
2. **Fresh web-first rewrite of the core (picked).** Small codebase, only the features below.
3. **No terminal at all: drive Claude through the Agent SDK and render a chat UI.** Smaller still, but
   the owner wants the real CLI in a terminal, so it does not fit.

## Goals

1. **Hire agents.** Each agent is a `claude` process in a pseudo-terminal with a name, a role, a working
   directory and a permission mode.
2. **Live terminals.** The browser shows each agent's real terminal and the user can type into it.
3. **Office floor.** A canvas shows every agent as an avatar at a desk. Its state (starting, working,
   idle, needs you, stopped) is visible at a glance, and an envelope flies desk to desk when agents
   message each other.
4. **Agents message each other.** Any agent can send a message to another agent, to the boss, or to the
   user.
5. **A boss agent.** One always-present agent the user briefs. It knows the roster and hands work to the
   others.
6. **Agents outlive the tab.** Closing or refreshing the browser does not stop anything. Reopening shows
   the current state and the current terminal screen.
7. **Two ways to run it.** `npx gonogo` on a machine that has `claude`, and a Docker image.

## Non-goals (first version)

Other agent CLIs, semantic memory index, memory graph, kanban, triggers, Slack, webhooks, dictation,
meeting transcription, cost telemetry and circuit breaker, file browser, git view, themes,
translations, auto-update, user accounts, built-in TLS, avatars walking around the floor, the boss
hiring agents by itself, Claude Code's own cross-session messaging, Windows.

## Anti-goals

- A shell reachable by anyone who can reach the port.
- Typing a delivered message into a terminal that shows a dialog, a permission prompt, or a prompt the
  user has half typed.
- Answering a Claude Code startup dialog on the user's behalf on a host machine. Every such dialog
  defaults to "No", and pressing Enter blindly exits Claude or rejects the key.
- Shipping art or names that belong to someone else. The reference's tilesets are licensed to its
  authors only, and its cast and brand parody a TV show.

## What the user sees

```
┌──────────────────────────────────────────────┬───────────────────────────────┐
│ OFFICE FLOOR (canvas)                        │ [Flight] [ana] [ben]     + Hire│
│                                              ├───────────────────────────────┤
│   ┌────┐      ┌────┐      ┌────┐             │                               │
│   │ana │ ✉ →  │ben │      │    │             │   terminal of selected agent  │
│   └────┘      └────┘      └────┘             │   (real claude TUI)           │
│  working       idle        empty desk        │                               │
│                                              │                               │
│        ┌─────────┐                           │                               │
│        │ Flight ! │  needs you                │                               │
│        └─────────┘                           ├───────────────────────────────┤
│                                              │ Brief the boss: [__________]  │
├──────────────────────────────────────────────┴───────────────────────────────┤
│ ACTIVITY  12:01 ana → ben  "API contract is in docs/api.md"                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Clicking an avatar or a tab selects that agent's terminal.
- **Hire** opens a form: name (lowercase letters, digits and hyphens, at most 32 characters, unique),
  role (free text), working directory (a path on the server, typed in and checked to exist), permission
  mode (`default`, `acceptEdits`, `bypassPermissions`). Choosing `bypassPermissions` shows a warning
  that the agent will run every tool without asking, and needs a tick in a box.
- Each agent has stop, restart, edit and remove. Edit is the hire form pre-filled; changes apply at the
  next restart.
- "Brief the boss" sends a message from the user to the boss.
- The activity strip lists messages, newest first. Messages addressed to the user, and messages that
  could not be delivered, are marked.
- When an agent is in "needs you", the strip says why when the server knows (permission request, or
  "startup dialog: answer it in the terminal").

## How it works

One Node process is the server. It serves the built client, holds every terminal, and is the only thing
that writes state.

```
browser ── HTTP (client files, REST) ──┐
browser ── WebSocket (terminals, events)┤
                                       │   ┌──────────── server (Node) ────────────┐
claude ── hooks (HTTP POST) ───────────┼──►│ terminals · roster · message queue    │
claude ── MCP tools (HTTP) ────────────┘   │ state on disk in the home directory   │
                                           └───────────────┬───────────────────────┘
                                                           │ pseudo-terminal
                                                       claude processes
```

The exact Claude Code flags, hook formats and terminal behaviour are recorded, with the experiments
that proved them, in `docs/facts/`. Where this document and the facts disagree about a Claude Code
behaviour, the facts win; where they disagree about what gonogo should do, this document wins.

### Terminals

- Pseudo-terminal library: `@lydell/node-pty` pinned at `1.2.0-beta.18`. The official `node-pty` 1.1.0
  cannot spawn on macOS (its helper binary is not executable) and has no Linux prebuilds. A start-up
  guard sets the executable bit on the helper if it is missing, whatever the library.
- Each agent has, next to its pty, a server-side headless terminal emulator (`@xterm/headless` with
  `@xterm/addon-serialize`) that receives every byte of output and every resize. A browser that
  connects gets `serialize()` of that emulator, then the live bytes. The server also remembers the
  last `CSI ? 1006 h|l`, `CSI ? 25 h|l` and `CSI ? 2031 h|l` it saw and writes the matching sequences
  into the joining browser after the serialized screen, because `serialize()` does not restore them.
  Replies the server-side emulator generates to terminal queries are not forwarded to the pty; the
  browser's terminal answers.
- The pty has one size. The browser that most recently resized or typed wins.
- The Claude Code renderer is pinned to fullscreen by `"tui": "fullscreen"` in the per-agent settings
  file, so the byte stream has one known format.
- Browser input and resizes go to the pty. The server notes the time and content class of the browser's
  keystrokes for the draft latch (see Messages).
- **Starts.** Every start passes every flag again; `--resume` does not restore them. The exact command
  line is in the cheat sheet at the top of `docs/facts/claude-code-hooks-mcp.md`. `--session-id <uuid>`
  is used while no transcript file for that id exists, `--resume <uuid>` once it does. If the process
  exits with code 1 within 3 seconds of a start, the server flips the flag once and retries.
- **Role text** is passed with `--append-system-prompt` and `--system-prompt-snapshot off` on every
  start, so an edited role applies at the next restart (otherwise a resumed session keeps the role it
  was first given).
- **Environment.** The claude process gets the server's environment minus `CLAUDECODE` and the
  session-identity `CLAUDE_CODE_*` variables (not `CLAUDE_CODE_OAUTH_TOKEN`), plus
  `GONOGO_TOKEN=<this agent's token>` and `TERM=xterm-256color`.
- **Stops.** The server sends SIGTERM to the agent's process group, and SIGKILL after 5 seconds. It
  waits for the exit before any restart, so two processes never write one transcript.
- If the server stops, the agents stop. On the next start they appear as stopped and the user restarts
  them. Automatic restart is left out, except for the boss, which the server starts every time it
  starts.

### Starting, dialogs and readiness

- A started agent is **starting**. It is ready when the server has seen the bracketed-paste enable
  sequence (`ESC[?2004h`) and the boxed prompt row is on screen. SessionStart is not a readiness
  signal. Nothing is delivered to an agent that is not ready.
- If an agent is not ready 5 seconds after spawn while its pty is producing output, it is shown as
  **needs you** with the reason "startup dialog: answer it in the terminal" (for example the folder
  trust question, whose hooks are held back until it is answered, or the bypass-permissions warning).
- On a host machine (`npx`), gonogo changes nothing in the user's Claude files. The user answers
  startup dialogs in the terminal pane.
- **Seed mode** is on by default in the Docker image and with `--seed-claude` elsewhere. A fresh
  container home has no onboarding state, so each agent's process also gets `IS_DEMO=1` (skips the
  theme, login, trust, bypass and key-approval dialogs), and before every start the server records
  trust for the agent's directory (`projects["<dir>"].hasTrustDialogAccepted = true`) in
  `$CLAUDE_CONFIG_DIR/.claude.json` (merge, write atomically; hooks stay silent without it). If
  `ANTHROPIC_API_KEY` is set, it is removed from the child's environment and passed through an
  `apiKeyHelper` command in the per-agent settings file instead (a plain environment key triggers a
  dialog that defaults to "No"). The user sets one credential, never both.
- The per-agent settings file also carries `promptSuggestionEnabled: false`, and
  `skipDangerousModePermissionPrompt: true` only for `bypassPermissions` agents.

### Agent state

| Signal | State |
|---|---|
| process spawned, not yet ready | starting |
| UserPromptSubmit, PreToolUse, PostToolUse | working |
| Stop, StopFailure | idle |
| PermissionRequest | needs you |
| not ready 5 seconds after spawn | needs you (startup dialog) |
| process exit | stopped |

Hooks are native `type: "http"` hooks posting to `http://127.0.0.1:<port>/hook/<agent>/<event>` with the
agent's token in an `Authorization` header taken from the process environment (`allowedEnvVars`). A
hook failure does not stop the agent, so a missing hook shows as a state that does not change.

Hooks alone cannot be trusted: Stop does not fire after Esc, a denied permission or an interrupt, and
slash and `!` commands fire no UserPromptSubmit. The terminal's window title is a second source: the
working glyphs show the agent is busy, and the idle glyph while the state is working, for more than 2
seconds, moves it to idle. The title glyph is also checked before delivery.

### Messages

- Each agent is started with three tools served by the server over MCP: `send_message`, `list_roster`
  and `read_messages`. All three are pre-approved, so using them never asks for permission.
  `--strict-mcp-config` is mandatory (otherwise the owner's other MCP servers load into every agent).
- A message has: id, from, to, subject, body, the message it replies to, a hop count, a time. `to` is an
  agent name, the boss, or `user`. The server stamps `from` from the agent's token.
- **Delivery by pointer.** The body of a message never goes through the terminal. When a message is
  waiting, the server delivers only a fixed one-line pointer (`gonogo: <n> new message(s) from
  <name>. Call read_messages.`, where the name was validated at hire time), and the agent reads the
  bodies with `read_messages`. This avoids terminal escape characters, text that starts with `/` or `!`,
  and long pasted text that Claude Code collapses.
- **Delivery rule.** If the recipient is idle, ready, shows no dialog, and has no draft, the server types
  the pointer as bracketed paste plus carriage return in one write, and expects the UserPromptSubmit hook
  within 2 seconds; if it does not come, the message stays queued, the activity strip shows it as held,
  and the server does not retry blindly. If the recipient is working, the pending pointer is handed over
  when its Stop hook fires, as `{"decision":"block","reason":"<pointer>"}`, which makes the agent carry
  on. Claude Code ignores the ninth consecutive block in a turn; the agent then goes idle with the
  message still queued and the idle rule delivers it. If the recipient needs the user, the message waits.
  The server never types into a terminal that is not idle.
- **Draft latch.** If the user types printable characters into an agent's terminal, the agent has a
  draft: delivery to it is held until the user presses Enter, Escape or Ctrl-C there, or 30 minutes pass.
  The floor and the activity strip show "held: text in <name>'s input".
- **Stopped or removed recipient.** The message is not delivered. It goes to the user, shown in the
  activity strip as undelivered with the reason, and is kept in the log only. Queues live in memory and
  do not survive a server restart, so an old instruction never fires into an agent days later. The send
  tool tells the sender at once.
- **Loop guard.** The server, not the agent, stamps the hop count. Each agent has a current trigger: the
  messages returned by its last `read_messages` call, cleared when its Stop hook fires. A message the
  agent sends while a trigger is set gets the highest hop count of the trigger plus one; otherwise it
  gets 1. A brief typed by the user is hop 0. Past a cap (8, `GONOGO_MAX_HOPS` to change it) the
  message goes to the user and is not delivered to the agent.
- Messages to `user` appear in the activity strip and mark the floor.
- Claude Code's own cross-session messaging tools are turned off in every generated settings file
  (`permissions.deny` for `SendMessage` and `ListAgents`, and `crossSessionInbound: "refuse"`), so
  agents use gonogo's tools.

### The boss

An ordinary agent created on first run, default name "Flight", renameable, not removable. Its role text
tells it to take briefs from the user, split work, send it to the right agent, and send anything risky
(spend, deletion, scope change) to the user. Its working directory is the directory gonogo was started
from (in Docker, the projects volume) and its permission mode is `default`; both can be changed with
Edit. The server starts it on every server start, so a brief never meets a stopped boss. If gonogo is
started from the home directory, Claude Code asks the trust question on every start; the README says
so.

### Memory

Each agent has one markdown file in the home directory. Its role text tells it to read the file at
start and add to it. There is no index and no search.

### State on disk

One home directory, `~/.gonogo` by default, overridable:

```
agents.json            roster: name, role, directory, permission mode, session id, desk
messages.jsonl         every message, append only
agents/<name>/         memory.md, settings.json and mcp.json generated at each start
token                  the browser token (mode 0600)
```

No database and no git repository.

## Security

The server runs shells, so access is closed by default.

- It listens on `127.0.0.1` unless told otherwise. It prints a URL that works from the host (never
  `0.0.0.0`).
- A browser token is created on first run and printed as part of the URL. Every HTTP request and
  WebSocket from the browser must carry it. This also stops other websites from connecting to the local
  port from the user's browser.
- Agents never receive the browser token. Each agent start gets its own token, passed in the process
  environment (never on the command line) to its hooks and MCP config. It allows only hook posts and the
  three tools, and the server stamps `from` from it, so an agent cannot open terminals, hire agents or
  send as `user`. Limit: an agent in `bypassPermissions` mode runs as the same OS user and can still
  read the token files on disk, so these tokens stop mistakes and misuse of the API, not a hostile
  agent.
- No TLS. For use from another machine, the user puts it behind something that provides it (a reverse
  proxy or a private network). The README says so.
- The working directory typed in the hire form is checked to exist and to be a directory. Agent names
  are validated, because they appear in the typed pointer and in file paths.
- Credentials in the container's environment are readable by the agents' shells. The README says so.

## Distribution

### npm

- `npx gonogo` starts the server and prints the URL. Options: port (default 7777), host, home
  directory, `--seed-claude`.
- The package ships the client already built. Client libraries are build-time dependencies; the runtime
  dependencies are `ws`, `@modelcontextprotocol/sdk`, `zod`, `@xterm/headless`,
  `@xterm/addon-serialize` and `@lydell/node-pty`. The exact working versions are in
  `docs/facts/toolchain-docker.md`.
- It needs Node 24 or newer and `claude` on the PATH. If either is missing it says so and exits.
- `@xterm/headless` is imported as a default import and destructured, because the named import fails in
  plain Node ESM (tests under vitest do not show it).

### Docker

- The image is Debian based (`node:24-bookworm-slim`; the Linux pty binaries need glibc), contains git,
  the `claude` CLI (pinned) and gonogo installed from the same tarball `npx` would use, and runs as a
  non-root user (`bypassPermissions` refuses to run as root). A starting point is
  `docs/facts/Dockerfile.probe`.
- Sign-in comes from the environment: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or
  `ANTHROPIC_API_KEY`, one of them. Seed mode is on.
- Two volumes: `/state` (gonogo home and Claude's own config and sessions through
  `CLAUDE_CONFIG_DIR`) and `/projects` (the projects the agents work on).
- Inside the container the server listens on all interfaces. The documented run command publishes the
  port on the host's loopback only and uses `--init`.
- Building and running the image happens locally. Nothing is pushed to a registry or published to npm.

## Constraints

- No Electron. No code, tilesets, maps, cast or brand names from the reference. The floor and avatars
  are drawn in code.
- Client: React with Vite and TypeScript, Pixi.js for the floor, xterm.js for terminals.
- Server: Node and TypeScript, one process.
- Few dependencies. Nothing is added for a few lines of code.
- One user. No accounts.

## Testing

- Unit tests for the message rules: delivery by state, the draft latch, messages to a stopped agent,
  server-stamped hops and the cap, messages to the user, the nine-block Stop cap, and the agent token's
  limits.
- Unit tests for the launcher (command line and settings file for first start and later starts, seed
  mode) and for the reconnect fix-ups (`serialize()` plus the remembered modes reproduces the live
  screen on a recorded stream).
- One end-to-end test that starts the server with a stand-in agent command in place of `claude`,
  connects over WebSocket, and checks that terminal output arrives, input goes back, a message is
  delivered by pointer and read with the tool, and state follows the hooks. The stand-in command is set
  through `GONOGO_AGENT_CMD`, which also lets a user point gonogo at a different command.
- A browser test of the built client against that same server.
- A manual smoke script that starts one real `claude` agent (model `haiku`, one short prompt) and walks
  through hire, brief, message and stop. It spends subscription tokens, so it is not part of
  `npm test`.
- A Docker build and a run of the image up to the point where credentials are needed.

## Left to the builder

- The WebSocket message format, the client state store, buffer and queue sizes, the visual design of
  desks and avatars (simple pixel style, drawn in code), and the repository layout (given as a starting
  point in the contract).
- Whatever the fact files leave open, decided against the real behaviour and recorded.

## Calls made without the owner

Settled by me. The owner can change any of them.

1. A message to a stopped or removed agent goes to the user and is not queued. The boss starts with the
   server, so a brief is never undeliverable.
2. The boss works in the directory gonogo was started from, in `default` permission mode. Any agent
   can be changed with Edit.
3. The server computes hop counts, not the agent.
4. Delivery waits while the user has a draft in that terminal (typed characters since the last Enter,
   Escape or Ctrl-C, expiring after 30 minutes).
5. Agents get their own scoped tokens, never the browser token.
6. Message bodies never go through the terminal; a fixed one-line pointer does, and a third tool
   (`read_messages`) returns the bodies. This replaces typing the message, which the fact-finding
   showed to be fragile (collapsed pastes, escape characters, leading `/` and `!`).
7. On a host, gonogo never edits the user's Claude files and never answers a startup dialog; seed mode
   (Docker default) does both, inside the container's own config volume.
8. The pty library is `@lydell/node-pty` 1.2.0-beta.18, a prebuilt-binary fork and a beta.
9. Fullscreen renderer pinned, default port 7777, Node 24 minimum, package license MIT as a
   placeholder.

## Risks

- **Claude Code changes its hooks, flags, dialogs or terminal output.** Everything that depends on them
  is kept in one place (`launcher` and `terminal`), and `docs/facts/` records the version tested
  (2.1.325).
- **Readiness and dialog detection read the terminal screen and its title.** If the prompt box or title
  glyphs change, agents stay "starting" or "needs you" until the user acts; delivery then waits rather
  than typing blindly.
- **Linux, the container's real sign-in and a real `claude` inside the container are not proven by the
  fact-finding.** The build tests what it can and the README says what was not run.
- **A draft the user leaves for up to 30 minutes holds that agent's mail.** The floor says why.
- **`IS_DEMO=1` in seed mode hides the account name in Claude's header.** Accepted for containers.
- **The pty library is a beta from a third-party fork.** If it fails, the official 1.2.0-beta.18 is the
  documented alternative.
