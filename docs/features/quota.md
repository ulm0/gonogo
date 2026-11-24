# Plan quota: your plan's own number

<PlanQuotaMock class="doc-mock" />

For a **claude.ai subscription**, shows how much of the plan's **5-hour** and **weekly** windows is used, as the PLAN block of the Propellant module ("from Claude Code: your plan's own number").

- **Source.** Each Claude Code agent's status-line script sends gonogo only the `rate_limits` part of the status-line JSON, plus the session id and the session's total cost (`cost.total_cost_usd`, shown by [Cost](cost.md) as "reported"). No folder, name or transcript path leaves it. The newest report wins (one plan pool). Claude Code reports only after a session's first reply and only for Pro, Max and Ultra logins; a window may be missing.
- **Display.** A bar per open window with percent and "resets in 2 h 10 min". A report older than 15 minutes is dimmed ("last seen N min ago"); a running agent refreshes every 5 minutes and on each reply. The last value is in `quota.json`, stale after a restart.
- **Alerts.** One Downlink item (`redline`) at 80 % and one at 95 % of a window ("Plan week is at 82 %, resets in 28 h 0 min"), again only for a new window. Nothing is stopped (at 100 % Claude Code says so). Thresholds are fixed.
- **Your status line.** gonogo's is the agent's only one, so it **chains yours**: `statusLine.command` from your user settings (read only) gets the same JSON and its output is shown. A project's status line is not chained. Without one the agent shows `plan 41% wk`.
- **pi**: its extension reads Anthropic's subscription headers (`anthropic-ratelimit-unified-5h-*`, `-7d-*`) and sends the same report, at most every 30 s. Not checked against a subscription: with an API key those headers are not sent and nothing is reported. opencode's plugin cannot see responses, so an opencode console reports none.
- **No source.** API-key or Bedrock rooms, Clean Room or seed-mode agents (not verified), or a subscriber before the first reply: "No plan quota reported". The token and dollar meters below are gonogo's own ledger: an **estimate, not your plan's number** (only gonogo's agents, no cache reads; Anthropic publishes no token allowance). Set a token limit by your own guess; watch DOLLARS in [Cost](./cost.md) for a pay-per-token room.
- **Limits.** A reset time further off than the window (5 h, 7 d, plus 5 min) is refused. At most one report per agent per 10 s; a chained command is cut after 4 s with everything it started.
- **Not read**: a gateway room's spend limit, per-model windows, history.

## Files and API

- `~/.gonogo/quota.json` (0600): `{ version: 1, windows: { fiveHour?, sevenDay? }, at, source }`.
- `POST /hook/<agent>/StatusLine` with the agent's token; the Propellant view and frames carry `plan`.
- Spec and real-run observations: `docs/quota-spec.md`.
