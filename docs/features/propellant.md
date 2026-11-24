# Propellant: the token budget

<PropellantMock class="doc-mock" />

Limit how many tokens agents spend. gonogo counts input, cache-creation and output tokens (not cache reads) from each Claude agent's transcript (`~/.claude/projects` or `$CLAUDE_CONFIG_DIR/projects`) after every turn and every 20 s in a long one. pi and opencode report each reply's usage with their hooks (gonogo's extension and plugin), counted the same way, once per reply.

- The F · PROPELLANT wall module shows room use per window: 5 hours (rolling), day (24 h), week (7 days), month (30 days). A console's PROPELLANT fold shows one agent.
- Type limits as `2000000`, `500k` or `2M`. The bar turns saffron at 80 %.
- At a limit Redline stops that agent (agent limit) or every Claude agent (room limit) at the end of the turn or tool call. Resume while over allows one more turn.
- `PUT /api/propellant` `{"room": {"day": 2000000}, "agents": {"ana": {"5h": 500000}}}`; `{}` for a scope clears its limits.
- Dollars: [Cost](cost.md).
