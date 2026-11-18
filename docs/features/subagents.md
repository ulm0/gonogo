# Subagents: the helpers of a Claude Code agent

<SubagentsMock class="doc-mock" />

A Claude Code agent can start helpers of its own (subagents) to search, read or work on part of a task. gonogo now **sees**
them, **counts what they cost**, and offers the two limits Claude Code itself has. Design and limits:
[`docs/subagents-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/subagents-spec.md). It was tried with the stand-in
agent and one short real run of `claude` (haiku) that recorded the shape of a helper's transcript; the hook payloads of
`SubagentStart` and `SubagentStop` were read from the documentation and not seen
([What was not verified](../reference/not-verified.md)).

- **Seen.** The tile and the console panel show a chip `3 SUBAGENTS` and what kinds are running (`2 Explore, 1 general-purpose`).
  The set comes from the `SubagentStart` and `SubagentStop` hooks. A helper nobody has heard of for 30 minutes is dropped, and
  all are dropped when the agent exits or restarts. A helper does not change what the agent shows (working, idle).
- **A loop is the same call by the same agent.** Redline's loop and error-storm counters are kept for the agent itself and for
  each helper by its `agent_id`, so two helpers doing the same call do not add up to a loop, and one helper cannot hide another's.
  A trip still interrupts the whole session: it is the only lever there is.
- **Who asked.** A permission dialog that a helper opened says so: `Bash: git push (subagent Explore)`. The dialog is still the
  parent's, and so is its GO or NO-GO.
- **Counted.** Propellant reads the helpers' own transcript files (`<session>/subagents/agent-<id>.jsonl`), which the main file does
  not repeat, and adds them to the agent they belong to. Token limits, dollar budgets and the out-of-propellant trip therefore
  include the fan-out. Each file has its own cursor, and a file that links outside Claude's projects folder is refused.
- **The setting.** Flight Rules, SUBAGENTS: *Allowed* (as Claude Code is), *At most N at once* (sets
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` for each Claude Code console; a Clean Room container gets it too) or *None* (denies
  the Agent tool and its old name Task in the console's settings, next to your [tool permissions](./permissions.md)). It
  applies at each console's next start. One setting for the room.

## What gonogo cannot control

- **A helper cannot be vetoed.** `SubagentStart` cannot block, and nothing in Claude Code stops one helper: Escape and NO-GO act on
  the whole session. A limit is Claude Code's, and it **does not apply while a session runs ultracode**.
- **A helper has its parent's gonogo tools.** It sends mail, writes the board and votes **as its parent**; gonogo cannot tell the
  calls apart (not verified, it follows from the shared token). Tool permissions cannot deny gonogo's own tools.
- **Max Q does not count helpers.** It limits agents that are working; one agent's own fan-out is its decision, and its cost is
  what the limits and budgets above govern.
- **A custom subagent** with its own `tools` or `permissionMode` can differ from the parent's rules. Claude Code's page says how
  they inherit; the exact merge of `allow` rules is not stated, so it is not promised here.
- **Workflow agents and agent-team teammates** have limits of their own, and their files are counted only if they land in the
  same `subagents` folder (not verified).
- Not built: a per-agent setting (the room's one applies to all), a cost row for each helper, killing one helper.
