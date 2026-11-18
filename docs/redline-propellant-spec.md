# Spec: Redline and Propellant

Prices and dollar budgets for Propellant: see `docs/cost-spec.md`.

Written 2026-11-17 and approved by the owner the same day. The first two features of the self-hosted roadmap
(`docs/backlog.md` section 11). Both exist to stop spend that nobody asked for.

## Redline: the circuit breaker

gonogo already gets every Claude agent's hooks. Redline trips on:

| Trigger | Rule |
|---|---|
| Loop | The same tool with the same input 5 times in a row (`PreToolUse`) |
| Error storm | 8 failed tool calls (`PostToolUseFailure`) within 2 min, or 3 API errors (`StopFailure`) within 10 min |
| Ping-pong | More than 15 messages from one agent to the same recipient within 10 min |
| Out of propellant | A Propellant limit of the agent or of the room is reached |

On a trip the hub presses Escape if the agent is working (the same key path as NO-GO), sets `needs_you` with
`needsKind: 'redline'` and a reason starting `redline:`, and holds its mail. It stays tripped whatever the hooks and the
screen say. Resume (`POST /api/agents/:name/resume`) clears it and resets the counters; a stop, restart or exit
clears it; so does the Director typing into the terminal. `GONOGO_REDLINE=off` turns off the first three triggers only.
Thresholds are constants in `src/server/constants.ts`.

Rejected: killing the process (loses the turn's context); denying the tool from `PreToolUse` (the model tries a
variant).

## Propellant: the token budget

Every hook carries `transcript_path`. The hub asks for a read at every `Stop` and `StopFailure`, and on a tool hook at
most every 20 s. `src/server/propellant.ts` reads only what the file gained (the offset is saved), refuses a path
outside Claude's projects folder (after resolving symlinks), counts one line per `message.id` (a reply is written as one
line per content block, each with the same usage) and sums `input_tokens + cache_creation_input_tokens + output_tokens`.
Cache reads are not counted.

Windows are rolling: 5 h, day (24 h), week (7 days), month (30 days). Limits exist for the room and per agent (by
name). At 80 % the meter turns saffron; at 100 % the agent's own limit trips that agent and the room's limit trips every
Claude agent. The ledger is `fuel.jsonl` (one line per agent and minute, 31 days kept); limits and read offsets are
`propellant.json`.

Rejected: the statusline JSON (a script per agent) and Claude Code's OpenTelemetry export (needs an OTLP receiver).

## Known limits

- shortcut: tokens of subagents (the Task tool) live in other transcript files and are not counted.
- shortcut: limits and the ledger are keyed by agent name, so a renamed agent starts from zero and loses its limit.
- A trip at a `Stop` lets that turn finish; a trip during a turn interrupts it with Escape (not run with a real
  `claude`). A Resume while still over the limit allows one more turn.
