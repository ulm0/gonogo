# Spec: Start agents again after a server restart (draft)

Design by FIDO, 2026-11-18, task t37a. Status: built (2026-11-18), with the changes under "As built" below. Read from `hub.ts` (`doStart`, `shutdown`), `docs/guide/the-room.md` and the Redline, Hold and Max Q code.

## What happens today

`Hub.shutdown()` stops every process (`terminateOp`). At the next start `doStart()` reads the roster, finds every agent `stopped`, marks the mail that was
waiting `undelivered` ("server restarted"), and starts **only the boss** (`restartOp`, `--resume` because its transcript exists). Every other agent waits for the
Director to press START. A crash is the same. `docs/guide/the-room.md` says so.

## Design

- **A Flight Rules setting, `startup`**: `boss` (default, exactly today), `running`, `off`. `running` starts again the agents that were running when the
  server stopped, the boss first. `off` starts nobody (the boss too). It is a room setting in `<home>/startup.json` `{ version: 1, policy }` (0600, atomic write, damaged file kept as `.bad`, the default then). No top-bar key.
- **Per-agent opt-out**: `AgentRecord.autostart?: false` (absent means follows the room), a "Start with gonogo" box on the hire and edit form, shown when the policy is
  `running`. It never applies to a stopped agent the Director stopped himself (that one is not in the set below anyway).
- **What "was running" means** (`src/server/runstate.ts`): `<home>/run-state.json` `{ version: 1, at, running: [{ name, working }] }`, written atomically
  whenever an agent's process starts or stops **except during `shutdown`** (the hub has a `closing` flag), so a graceful stop leaves the set as it was, and a crash does too.
  The Director's STOP, a Remove, a Hold, a Redline trip and the agent exiting by itself take the name out of the set; RESUME and a start put it back. So
  **Held and tripped agents stay stopped** after a cold restart, by construction. `working` is the state at the last write (from hooks: a working agent was in a turn).
  A file older than 7 days, or from another gonogo home, is ignored.
- **Waves** (a start burst of 15 Claude CLIs is a CPU, memory and API spike, and a long `--resume` can open the "Resume this conversation?" dialog): the boss first;
  then `STARTUP_WAVE` (3) at a time. The next wave begins when the previous one's agents are all out of `starting` (idle, working, or `needs_you` for a dialog) or after
  `STARTUP_WAVE_TIMEOUT_MS` (60 s). One attempt each: a start that fails (folder gone, no Docker) leaves the agent `stopped` with the reason, never a retry loop.
- **Max Q.** Max Q limits agents that are *working*, and a resumed agent is idle, so a restart does not fill it. What the cold start must respect is the next step: the note below goes
  through `Hub.sendFromUser` like any message, so Max Q holds it when the limit is reached and Redline's held mail applies. The wave size also never exceeds the Max Q limit when one is set.
- **Carry on.** `--resume` restores the history, not the turn that was cut. For an agent whose saved `working` was true, gonogo sends one message from the Director: `Server restarted: gonogo
  was restarted while you were working. Check your last step and carry on.` Only for those; an idle agent gets nothing. A Flight Rules box turns it off (default on).
- **Mail.** Unchanged: queues are memory, the waiting messages become `undelivered` (the code that does it stays). Re-delivery is out of scope.
- **Downlink.** One event: `Restarted 4 agents after the server start; not started: ben (opted out), cy (on hold)`. Failures are named.
- **Clean Room and worktree agents** start the same way (the launcher already makes the worktree and container).

## How it fits live reload (`docs/live-reload-spec.md`)

They do not overlap. `gonogo reload` leaves the ptys alive and the new hub **adopts** them, so those agents are not started again (adopt marks them running before autostart looks).
Autostart covers what reload cannot: a **cold** start (reboot, the container recreated, `docker compose up -d`, Ctrl-C then start) and a **crash** that took the pty host with it. Both write
and read the same `run-state.json`; a reload or a crash with a live host leaves it untouched. Order at start: adopt, then autostart for the roster agents that are not running.

## Options

1. **A saved "running" set, one policy (pick).** Small, works for graceful stops and crashes, and held and tripped agents fall out by construction.
2. A per-agent `autostart` flag only ("always start this one"). Simpler, but it restarts an agent the Director stopped on purpose, and a held one, which is what the Director said must not happen.

## Scope of one small PR (GUIDO)

`runstate.ts` (write on start/stop with the `closing` guard, read, age check) and tests; `startup.json` store and `GET/PUT /api/startup`; `Hub.doStart` calls an `autostart()` that does the waves (clock and start function
injected, so tests use fake time); `AgentRecord.autostart`, the form box, the Flight Rules block (three choices and the carry-on box); Downlink event; docs page and the line in `the-room.md`. About 400 lines with tests.
**Left out:** re-delivering mail, restoring Redline counters, a per-agent wave order, retrying a failed start, restarting an agent that crashed on its own while the server stays up (a separate "supervisor" idea).

## Tests

Set written at start and stop and not during shutdown; a crash (no shutdown) keeps it; STOP, hold, trip and remove take a name out and RESUME puts it back; policy `boss` equals today's behaviour (boss only); `running` starts the set in waves of
3 with fake time and the boss first; the wave timeout; one failed start does not stop the rest and says why; opted-out and held ones stay stopped; carry-on message only for `working`, through Max Q; a stale or foreign
file is ignored; adopted agents are not started twice; the damaged `startup.json` falls back to `boss`.

## As built

- **Live reload is not in this build** (`docs/live-reload-spec.md` is not on `main`), so there is no adopt step: every start of the server is a cold start.
- **The boss under `running`** follows the saved set like the others: a boss that was stopped when the server stopped stays stopped. With no usable saved set (no file, too old, damaged) `running` starts the boss only, as `boss` does. `off` starts nobody.
- **The set forgets what a start leaves stopped.** Under `boss` and `off`, and for an opted-out or removed agent, the start takes the name out of the set, so that a later change to `running` does not bring back an agent from a week ago. A crash in the middle of the waves keeps the agents that were not reached yet.
- **`working`** is true while the agent works and while it waits at a permission dialog.
- **The waves** poll every 500 ms through the hub's own timer; the wave is smaller than three when Max Q is lower.
- **The Downlink event** is of kind `startup` (chip STARTUP): `Restarted 2 agents after the server start; not started: dee (opted out)`. A start that failed is named with its reason. It is not forwarded by Relay.
- **`start_agent`** (the boss-only MCP tool, `Hub.startAgent`) starts a stopped agent through the same path as the START key. It refuses a running agent and one on hold, takes at most 6 starts a minute from the boss, and the Black Box records `flight started ana`.
- **ALL STOP and the switch** (the Director's later request): `Hub.holdAll`/`resumeAll` call `hold` and `resume` one agent at a time, so the machinery is Hold's; the Black Box line has the count only. `startup.json` also keeps `bossMayStart` (default true), which `Hub.startAgent` reads.
- **Not done:** the `hire_agent`-style request for the Director's consent (the boss starts without asking, as the Director's START does without a second key); re-delivery of mail; a restart of an agent that crashed on its own.
