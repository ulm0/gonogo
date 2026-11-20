# Subagents: the helpers of a Claude Code agent

<SubagentsMock class="doc-mock" />

gonogo shows a Claude Code agent's helpers (subagents), counts their cost, and offers Claude Code's two limits. Design and limits: [`docs/subagents-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/subagents-spec.md). Tried with the stand-in agent and one short real `claude` (haiku) run recording a helper's transcript shape; the `SubagentStart` and `SubagentStop` payloads were read from documentation, not seen ([What was not verified](../reference/not-verified.md)).

- **Seen**: tile and console panel show a chip `3 SUBAGENTS` and kinds (`2 Explore, 1 general-purpose`), from the `SubagentStart` and `SubagentStop` hooks. A helper unheard for 30 minutes is dropped; all drop when the agent exits or restarts. Helpers do not change working/idle.
- **Loops**: Redline's loop and error-storm counters are kept per agent and per helper (`agent_id`), so two helpers making the same call are not a loop. A trip still interrupts the whole session.
- **Who asked**: a dialog a helper opened says so: `Bash: git push (subagent Explore)`. GO or NO-GO is still the parent's.
- **Counted**: Propellant reads helpers' transcripts (`<session>/subagents/agent-<id>.jsonl`) and adds them to the parent, so token limits, dollar budgets and the out-of-propellant trip include the fan-out. Each file has its own cursor; a file linking outside Claude's projects folder is refused.
- **Setting**: Flight Rules, SUBAGENTS, one per room, applied at each console's next start:

| Choice | Effect |
|---|---|
| Allowed | as Claude Code is |
| At most N at once | sets `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` for each Claude Code console (Clean Room too) |
| None | denies the Agent tool and its old name Task in the console's settings, beside your [tool permissions](./permissions.md) |

## What gonogo cannot control

- **A helper cannot be vetoed**: `SubagentStart` cannot block; Escape and NO-GO act on the whole session. The limit is Claude Code's and **does not apply while a session runs ultracode**.
- **A helper has its parent's gonogo tools** and sends mail, writes the board and votes **as its parent** (not verified; follows from the shared token). Tool permissions cannot deny gonogo's own tools.
- **Max Q does not count helpers**; their cost falls under the limits and budgets above.
- **A custom subagent** with its own `tools` or `permissionMode` can differ from the parent's rules; the exact merge of `allow` rules is not stated by Claude Code, so not promised.
- **Workflow agents and agent-team teammates** have their own limits; counted only if their files land in the same `subagents` folder (not verified).
- Not built: per-agent setting, a cost row per helper, killing one helper.
