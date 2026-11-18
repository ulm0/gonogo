# Live reload: a new gonogo without stopping the agents

Updating gonogo used to end the process, and every agent's terminal with it: the turn in progress, the screen and the
tools it was running were gone (Claude agents came back with `--resume`). With **`--pty-host`** the agents' terminals live in
a small process of their own, `gonogo ptyhost`, and `gonogo reload` starts the new version without touching it. Design:
[`docs/live-reload-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/live-reload-spec.md). It is **opt-in for one
release** (`--pty-host` or `GONOGO_PTY_HOST=1`), because it moves every agent's terminal through a socket. Off is today's
behaviour, exactly.

## Use it

1. Start gonogo with `gonogo --pty-host` (the host starts by itself on the first agent).
2. Update gonogo the way you installed it (`gonogo update` prints the command).
3. Run `gonogo reload`, or press **Reload gonogo** in Flight Rules. The old server lets go of the port and the home, the
   new one starts with the same arguments and takes the running agents over. The page reconnects within a second or two.

Without `--pty-host`, reload still hands over, but there is nothing to keep: the agents stop and start again (Claude agents
resume their session). `gonogo reload [--home <dir>]` signals the server of that home (SIGUSR2); it starts the same file
that the old one ran from, or `gonogo` on the PATH when that file is gone.

## What survives a reload

| | Survives | How |
|---|---|---|
| Agent processes, the turn in progress, tools, background jobs | yes | the pty host owns the ptys |
| Screen, scrollback | yes | the host's mirrors; an open terminal repaints from them |
| Hook and MCP calls of running agents | yes | the hash of each token is saved in `run/tokens.json` (never the token) and the port stays the same |
| A Hold or a Redline trip | **yes** | saved in `run/hub-state.json` after every change; a reload never releases a held agent, and mail waits behind it |
| Roster, mail, tasks, ledgers | yes | files |
| Browser WebSockets | no | the page reconnects |
| An open T-minus poll, Relief requests, a Static fire in progress, held-mail counters | **no** | in memory; short-lived |

How the new server reads each agent it adopts: a saved hold or trip stays `needs_you`; a dialog on the screen reads
`needs_you`; otherwise the window title says idle or working (the input box is drawn during a turn too, so it says nothing).
An agent in the host that is not in the roster is stopped.

## The host

- `<home>/run/` is `0700`; the socket, the key (`ptyhost.key`), the tokens and the saved holds are `0600`. The first frame of a
  connection must carry the key, compared in constant time; a wrong key or any other first frame is dropped without an answer.
- One server at a time: a new connection replaces the old one, and the old one is told, so it does not take the host back.
- A socket file left by a crash is removed at the next start; a live host is never replaced. A path above 100 bytes is refused
  with the path in the message (unix sockets are short: keep `--home` short).
- It exits after 60 s with no agent and no server. Ctrl-C or SIGTERM on gonogo stops the agents and the host; `gonogo reload`
  and a crash of the server leave them running, and the next start says it took them over.
- If the host's protocol version differs from the new gonogo's, its agents are stopped (they resume) and a new host starts.
- If the host itself dies, its agents die with it: after about 3 s each one gets an exit event like a crash, and the next start
  begins a new host.

## What was seen (the stand-in agent, a real host process, 2026-11-18)

- `gonogo --pty-host`, one agent mid-turn (`@fake sleep 90000`) and the boss on hold. `gonogo reload`: the new server was
  listening 0.4 s after the signal, the host and the agent processes kept their pids, and the log said `took over 2 running
  agents`. The boss stayed `needs_you` (redline), mail to it stayed `held`, and the agent's turn ended under the new server
  (its Stop hook was accepted with the saved token), so it went idle.
- `kill -9` of the host: the agents showed `stopped` after about 3 s; a restart of one started a new host (the stale socket
  file was removed) and the agent ran again.
- SIGTERM of gonogo: agents stopped, host exited, socket removed; the files in `run/` were `0600`.

## Not built, not tried

- **The listening socket is not passed** to the new process: the old server closes first and the new one waits for the port
  and the home (up to 10 s). Agents' hook calls in that gap (about half a second here) fail; hooks do not block Claude.
- A real `claude` through a reload (its hooks failing for a moment), reload inside Docker, Windows, and reloading the host's own
  code (a host protocol change means the stop-and-resume path above).
- Output is not flow-controlled on the socket; an exit that happens while no server is connected is not replayed (the next
  server sees the agent as not running).
- The whole `terminal.test.ts` suite was not run against the remote host: `spawn` there is asynchronous (the server calls
  `spawnAsync`). The socket, the client, adoption, tokens and holds have their own tests (`test/ptyhost.test.ts`,
  `test/hub.test.ts`, `test/launcher.test.ts`, e2e 38).
