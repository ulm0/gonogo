# Spec: Subagents of a Claude Code agent (draft)

Design by FIDO, 2026-11-18, task t37b. Status: draft, not built. Facts marked **[docs]** were read on 2026-11-18 from `code.claude.com/docs/en/hooks` and `/sub-agents` (the hooks page is 294k characters and I read
parts of it: the SubagentStart/SubagentStop sections and the PermissionRequest note). Marked **[code]**: read from gonogo's source. Marked **[not verified]**: nobody ran it.

## What Claude Code says

- **Hooks [docs].** `SubagentStart` (fires on spawn, on resume of a subagent and on each message to an in-process teammate) carries `agent_id` and `agent_type`; it **cannot block**. `SubagentStop` carries `agent_id`,
  `agent_type`, `last_assistant_message`, `stop_hook_active` and **`agent_transcript_path`** (`<project>/<sessionId>/subagents/agent-<id>.jsonl`; `transcript_path` stays the main session's). It also fires for Claude Code's own internal agents (prompt
  suggestions, `/btw`), so a stop without a start is normal. Tool events inside a subagent run the same configured hooks and **carry `agent_id` and `agent_type`**. The page does not say that `Stop` fires for a subagent (`SubagentStop` is its own event)
  and does not say that `PermissionRequest` does (it only says background subagents of a non-interactive session run these hooks and are denied if none decides).
- **Limits [docs].** At most 20 running subagents by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), **not enforced while ultracode is active**; nesting up to 3 layers (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `1` turns nesting off); no limit on the total
  spawned. Workflow agents and agent-team teammates have limits of their own that I did not find in the docs [not verified; one third-party page says 16 at a time and 1000 a run].
- **Permissions [docs].** Built-in subagents "inherit the parent conversation's permission rules"; a Bash deny rule "applies to the main conversation and to subagents". A subagent takes the parent's permission mode when the parent is in `bypassPermissions`,
  `acceptEdits` or auto. A subagent definition can have its own `tools`, `disallowedTools`, `permissionMode`; with `tools` omitted it **inherits every tool, so the MCP tools too**. Background subagents surface their prompts in the main session. `deny: ["Agent"]` (alias `Task`) forbids all
  subagents, `Agent(name)` one kind.
- **Cost [docs].** A subagent's requests count against the same usage limits; nothing says its tokens are added to the parent's transcript.

## What gonogo does today [code]

- Registers eight hook events (`HOOK_EVENTS`); the two subagent events are not among them. The tool hooks of subagents **do** arrive (settings hooks run inside subagents) and are treated as the parent's: a heartbeat, Redline's *loop* (same tool and input 5 times in a
  row) and *error storm* (8 failures in 2 minutes) counters, and a `PermissionRequest` from a subagent turns the **parent** `needs_you` with no hint of who asked. Interleaved calls of parallel subagents can mask a loop or add up to a false storm.
- Propellant reads only `transcript_path` (the main file); the `subagents/` files are not counted (shortcut in `propellant.ts`, `redline-propellant-spec.md`). A fan-out is invisible to the meter and to the Cost budgets.
- Max Q counts one slot for an agent that is `working`, whatever it runs inside.
- PR J (`permissions`) writes `allow/ask/deny` into the settings file passed with `--settings`; that file also holds the hooks, so what it says reaches subagents by the documented inheritance.

## What gonogo cannot control

A subagent cannot be vetoed: `SubagentStart` has no decision, and `SubagentStop` can only keep one running. There is no API to stop one subagent (Escape and NO-GO act on the whole session; what Escape does to running background subagents is [not verified]). An MCP call has
no `agent_id` that I know of, so a subagent that inherits `mcp__gonogo__*` sends mail, writes the board and votes **as its parent** [not verified, but follows from the shared token]. PR J refuses to deny gonogo's own tools. Under **ultracode** the concurrency cap does not apply, and workflow agents
may not write the same files or send the same hooks [not verified].

## Design

Observe everything, cap what Claude Code lets us cap, count the cost, and say the rest.

1. **Visibility.** Add `SubagentStart` and `SubagentStop` to the hooks gonogo registers (HTTP hooks work for them; only `SessionStart` is excluded). The hub keeps, per agent, a set of live `agent_id`s with `agent_type` and start time: Start adds (idempotent), Stop removes, a stop with no start is ignored,
   any tool hook carrying that `agent_id` refreshes it, and an id silent for 30 minutes (or the agent's exit or restart) is dropped. The view gets `subagents: { running, started, types }`; the tile and the console panel show a chip `3 SUBAGENTS` (under the Clean Room/worktree chips; a text name for readers of the page). The
   Downlink gets nothing (too chatty); Black Box nothing. The `PermissionRequest` reason names `agent_type` when the payload has one (`Explore asks: Bash: ...`).
2. **Redline per agent id.** The loop and error counters are keyed by `agent_id ?? 'main'`, so a loop inside one subagent trips (as it should) and interleaving no longer hides or invents one. A trip still interrupts the whole session (the only lever there is). The thresholds stay.
3. **Cost.** Propellant also reads the subagent transcripts of the session: on `SubagentStop` the file named by `agent_transcript_path`, and on every `Stop` the `subagents/*.jsonl` of the session (the directory is `transcript_path` without `.jsonl`), each with its own cursor (cursors are per path already). The read keeps
   Propellant's guard (resolved path under Claude's projects folder), counts lines by message id, and writes the same ledger lines under the **parent's name**. So token limits, dollar budgets and Redline's out-of-propellant trip include the fan-out. Needs a **real fixture**: one short run of `claude` with a trivial subagent to record the
   file's shape (`isSidechain`, usage, model) and whether the parent file repeats the usage; I will not guess that. Workflow agents' files are counted only if they land in that folder [not verified].
4. **Governance, one honest setting.** Flight Rules (and the agent form, like PR J) get `Subagents: allow (default) | limit N | none`. `limit N` sets `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=N` in the agent's environment (and, optionally, depth); `none` adds `Agent` to the agent's deny list through PR J's merge. The page says: "a limit does not apply to ultracode sessions;
   a subagent still uses the agent's gonogo tools". gonogo does **not** try to count a subagent against Max Q: Max Q protects the API from concurrent *turns of agents*, and one agent's own fan-out is its decision and its cost, which the budget and the cap above govern.
5. **Permissions.** Nothing new: PR J's rules are in the settings file and subagents inherit them per the docs; the docs page for J gets a sentence saying that custom subagents with their own `tools` or `permissionMode` can differ [docs say so; the exact merge for `allow` rules is not stated, so not promised].

## Options

1. **Observe, count, cap with Claude's own switches (pick).** Everything in 1 to 5 uses documented hooks and variables; nothing needs a thing Claude Code does not offer.
2. **Enforce in gonogo**: block spawns from a hook. Not possible: `SubagentStart` cannot block, and `SubagentStop` only prolongs. Rejected.

## Scope of one PR

Hook registration and the hub set; chip and view field; per-id Redline counters; `reason` text; Propellant subagent reads with the fixture; the `Subagents` setting (env var and the deny rule); `docs/features/subagents.md` (what is seen, counted and capped, and the list above of what is not); backlog line.
About 450 lines with tests. **Left out:** per-subagent cost rows in the UI, killing one subagent, MCP attribution to a subagent, a workflow/ultracode-specific view, Max Q weighting, agent-team teammates (a different feature).

## Tests

A stand-in that emits `SubagentStart`/`SubagentStop` with and without `agent_id` on tool events; set add/remove/idempotent/stale/exit; a stop with no start; loop detection per id (two subagents alternating the same call do not trip, one repeating does); a failure storm of one subagent trips; permission reason with a type; Propellant reads a `subagents/` fixture once (restart does not recount),
refuses a path outside the projects folder and a symlink, and prices by model; the env var and the deny rule are in the start (argv/env/settings); the setting is refused for engines other than Claude; chip text.
