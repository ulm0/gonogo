# Spec: Live reload (draft)

Design by FIDO, 2026-11-18, task t33a. Status: draft, not built. Nothing here was run: it is read from `terminal.ts`, `cli.ts`, `web.ts` and `launcher.ts`.

## Intent

Updating gonogo today ends the process, and `terminalHost.stopAll()` kills every agent's pty (`cli.ts` shutdown). Claude agents come back with
`--resume`, but the turn in progress, the screen and scrollback, running tools and background processes are gone. The Director wants a new
version to take over **without** killing the agents.

## What lives where today

| Thing | Where | Survives a hub restart now? |
|---|---|---|
| Agent processes, pty, screen mirror and scrollback | `TerminalHost` in the hub process | no |
| Roster, messages, tasks, schedules, ledgers | files in the home | yes |
| Agent tokens, hook generation, hub per-agent state, held-mail counters, Relief requests, an open poll | hub and launcher memory | no |
| MCP | stateless (`sessionIdGenerator: undefined`) | n/a: any process can answer |
| Browser WebSockets | web server | no, but the page reconnects and gets a snapshot |

## Options

1. **A pty host process (pick).** A small detached process `gonogo ptyhost` owns the ptys and their headless mirrors. The hub talks to it over a
   unix socket with a `RemoteTerminalHost` that implements the existing `TerminalHost` interface (`src/shared/protocol.ts`, the seam is already
   there). A new hub connects, asks which agents run, **adopts** them, and carries on.
2. **Restart and resume.** `gonogo restart` stops agents gracefully, re-execs, and Claude agents `--resume`. Cheap (about 60 lines), keeps
   transcripts, loses everything in the table above's first row. Kept as the **fallback** (also what runs when the pty host's protocol changed).

Pick A. B alone does not meet the ask. B is not thrown away: it is the answer for an engine that cannot resume and for a host upgrade.

## Design (option A)

- **The host** (`src/server/ptyhost.ts`, started by the hub on the first spawn, `detached`, `unref`, its stdio on a log file in the home).
  It runs the existing `createTerminalHost()` unchanged and serves it. Socket `<home>/run/ptyhost.sock` (dir 0700, socket 0600). The first
  frame carries a secret from `<home>/run/ptyhost.key` (0600), so a stray local connection does nothing. One hub connection at a time; a new
  one replaces the old one (the old hub is going away). Protocol: length-prefixed JSON control frames, binary frames for output (the same
  `[kind, seq, bytes]` shape as the WebSocket output). A `version` number in the hello.
- **The client** (`remoteterminal.ts`): `createRemoteTerminalHost()` implements `TerminalHost`: `spawn`, `stop`, `write`, `submit`,
  `resize`, `rename`, `attach`, `screen`, `title`, `info`, `onEvent`, `forget`. `attach` keeps its meaning (snapshot from the host's
  serializer, then live output); `screen` and `title` are asked of the host (they are cheap and cached with a short TTL, since
  `analyzeScreen` runs on timers). Request/response by id; a call on a dead socket returns the same `false` the interface already allows.
- **Adopt** (new `Hub.adopt(list)`, called once after `load()` when the host answers `list`): for each running `{ name, generation, pid }`
  whose name is in the roster, set the runtime to `running`, restore `generation`, then take the **state from the screen probe**
  (`analyzeScreen`: idle, working, needs you) instead of waiting for a hook. An agent that is not in the roster is stopped. A roster
  agent that was not running is untouched.
- **Tokens.** Hook and MCP tokens are checked in memory today. Persist them: `<home>/run/tokens.json` (0600) holds `name`, `generation`,
  and the SHA-256 of the token (never the token); the launcher loads it, so the agents' existing hook and MCP URLs keep working. A
  revoked token is removed from the file in the same write.
- **Hand-over of the port.** The old hub `fork`s the new version with `child.send(msg, server)`, which passes the **listening socket**
  over IPC, so there is no moment without a listener (not tried here; Node documents it for `net.Server`). The new process starts
  serving, tells the old one `ready`, and the old one closes its sockets and exits. Fallback if the pass fails: the old one closes first and the
  new one binds with a 5 s retry (a gap of about a second, in which an agent's hook call fails; hooks do not block Claude).
- **Triggers.** `gonogo reload` (new): checks the installed version differs and the host protocol matches, then does the hand-over.
  `gonogo update` stays print-only (Rollout's rule: it never runs an installer); after the owner updates, he runs `gonogo reload`. The page
  gets a RELOAD key in Flight Rules next to the version line (no top-bar key) once Rollout knows a newer version is installed.
- **Exit policy.** Ctrl-C / SIGTERM on gonogo still stops everything (host told `stopAll`, then exits). `gonogo reload` and a **crash** of
  the hub leave the host and the agents running; the next `gonogo` start adopts them, and says so. The host exits itself when it has no
  agent and no hub for 60 s. In Docker the container's end ends it all.
- **Opt-in at first.** `--pty-host` / `GONOGO_PTY_HOST=1`, default off for one release, because it moves every agent's terminal through
  a socket. Off means today's behaviour exactly.

## What survives, what does not

| | Survives `gonogo reload` | Note |
|---|---|---|
| Agent processes, turn in progress, tools, background jobs | yes | the host owns the ptys |
| Screen, scrollback, terminal modes | yes | the host's mirrors |
| Hook and MCP calls from running agents | yes | persisted tokens, same port |
| Roster, mail, tasks, ledgers | yes | files |
| Browser WebSockets | no | the page reconnects, resnapshots; an attached terminal repaints from the host |
| Held-mail queues, Redline counters, an open poll, Relief requests, Static fire in progress | **no** | in hub memory; a hold or a trip is **lost** unless saved |
| The pty host's own code | no | a protocol change means B for that reload |

The row that matters: **Hold and Redline trips are hub memory**. A reload must not quietly release a held agent. So the PR also saves
`{ redline reason, held }` per agent in `<home>/run/hub-state.json` and restores it in `adopt`. Open polls and Relief requests are
dropped with a note to the Director in the Downlink (short-lived, 30 min at most); this is stated in the docs.

## Risks

- A bug in the host takes all agents with it: it is small and has no gonogo logic, and the protocol is the existing interface.
- Adopting from the screen probe can misread a state (a dialog open at reload time): a Hold/Redline restore and the probe both err toward
  `needs_you`, never toward `idle`.
- Two hubs on one home (a reload that did not finish): the new hub refuses to adopt while the old pid in `<home>/run/hub.pid` lives.
- Output between the old hub's last read and the new `attach` is in the host's mirror, so nothing is lost for the screen; the raw stream a
  browser sees repaints from a snapshot.
- Not verifiable here: passing the listening socket on this Node build, `claude` surviving a hub restart with its hooks failing for a second.

## Scope of the one PR

`ptyhost.ts`, `remoteterminal.ts`, the socket protocol and its version, persisted tokens, `Hub.adopt`, saved hold state, `gonogo reload`, the flag,
the Flight Rules key, `docs/features/live-reload.md`. **Left out:** reload of the host itself, Windows, hot-swapping the web UI bundle,
moving WebSockets across, reload inside Docker.

## Order of changes

1. `remoteterminal.ts` + `ptyhost.ts` behind the flag, with the existing terminal tests run against the remote host. 2. Persisted tokens and
`Hub.adopt`. 3. Hold/Redline state file. 4. `gonogo reload` and the port hand-over. 5. Flight Rules key and docs.

## Test plan

The whole `terminal.test.ts` suite against `RemoteTerminalHost` through a socketpair; kill the hub, start another, adopt (stand-in agent keeps
counting its output); a revoked token stays revoked after reload; a held agent stays held; an agent missing from the roster is stopped; a
protocol-version mismatch falls back to B with a clear message; the socket refuses a wrong key; the old hub exits only after `ready`; host
exits with no hub and no agent. Not tested: a real `claude` through a reload (state it in the page).
