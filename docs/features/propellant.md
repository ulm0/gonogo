# Propellant: the token budget

<PropellantMock class="doc-mock" />

gonogo counts input, cache creation and output tokens from each Claude agent's transcript (under `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`), at the end of every turn and every 20 seconds during a long one. Cache reads are not counted. Only Claude Code is counted.

- The F · PROPELLANT module on the wall shows the room's use per window: rolling 5 hours, day (24 h), week (7 days), month (30 days), each with a limit. The PROPELLANT fold in a console's panel does the same for one agent.
- Limits are typed as `2000000`, `500k` or `2M`. The bar turns saffron at 80 %.
- At a limit, Redline stops that agent (agent limit) or every Claude agent (room limit) at the end of the current turn or tool call. Resume while still over allows one more turn.
- Dollars and budgets: see [Cost](cost.md).
- API: `PUT /api/propellant` with `{"room": {"day": 2000000}, "agents": {"ana": {"5h": 500000}}}`; `{}` for a scope clears its limits.
