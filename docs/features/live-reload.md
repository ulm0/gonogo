# Live reload: a new gonogo without stopping the agents

<LiveReloadMock class="doc-mock" />

With **`--pty-host`** (or `GONOGO_PTY_HOST=1`) agents' terminals live in a small process, `gonogo ptyhost`, and `gonogo reload` starts a new gonogo without touching them. **Opt-in for one release**; off is the old behaviour. Design: [`docs/live-reload-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/live-reload-spec.md).

## Use it

1. Start with `gonogo --pty-host` (the host starts on the first agent).
2. Update gonogo the way you installed it (`gonogo update` prints the command).
3. Run `gonogo reload [--home <dir>]`, or press **Reload gonogo** in Flight Rules. It signals the server of that home (SIGUSR2). The old server lets go of the port and home; the new one starts with the same arguments (same file as the old, or `gonogo` on the PATH if gone) and takes over the agents. The page reconnects in a second or two.

Without `--pty-host`, reload still hands over, but the agents stop and start again (Claude agents resume).

## What survives

| | Survives | How |
|---|---|---|
| Agent processes, turn in progress, tools, background jobs | yes | the host owns the ptys |
| Screen, scrollback | yes | host mirrors; an open terminal repaints |
| Hook and MCP calls of running agents | yes | token hashes in `run/tokens.json` (never the token); port stays the same |
| A Hold or Redline trip | **yes** | `run/hub-state.json`; a reload never releases a held agent, mail waits behind it |
| Roster, mail, tasks, ledgers | yes | files |
| Browser WebSockets | no | the page reconnects |
| Open T-minus poll, Relief requests, Static fire in progress, held-mail counters | **no** | in memory |

An agent in the host that is not in the roster is stopped.

## The host

- `<home>/run/` is `0700`; socket, key (`ptyhost.key`), tokens and saved holds are `0600`. The first frame must carry the key (constant-time compare); anything else is dropped silently.
- One server at a time: a new connection replaces the old one.
- A socket file left by a crash is removed at next start; a live host is never replaced. A path above 100 bytes is refused with the path in the message: keep `--home` short.
- It exits after 60 s with no agent and no server. Ctrl-C or SIGTERM on gonogo stops agents and host; `gonogo reload` and a server crash leave them running (the next start says it took them over).
- If the host's protocol version differs from the new gonogo's, its agents are stopped (they resume) and a new host starts.
- If the host dies, its agents die: after about 3 s each gets an exit event like a crash; the next start begins a new host.

## Limits

- **The listening socket is not passed:** the old server closes first and the new one waits for the port and home (up to 10 s). Hook calls in that gap (about half a second) fail; hooks do not block Claude.
- Output is not flow-controlled on the socket. An exit while no server is connected is not replayed (the next server sees the agent as not running).
- **Tried only with the stand-in agent and a real host process** (2026-11-18). Not tried: a real `claude` through a reload, reload inside Docker, Windows, reloading the host's own code (a host protocol change takes the stop-and-resume path above).
