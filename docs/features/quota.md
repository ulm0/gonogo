# Plan quota: your plan's own number

Propellant counts what gonogo's agents spend. For a **claude.ai subscription** Claude Code also knows how much of the plan's **5-hour** and **weekly** windows is used, and gonogo shows that number as the PLAN block of the Propellant module, labelled "from Claude Code: your plan's own number".

- **Where it comes from.** Each Claude Code agent runs a small status-line script that sends gonogo only the `rate_limits` part of Claude Code's status-line JSON (the percentages and reset times; no folder, session id, cost or transcript path). The newest report wins, because the plan is one pool for every agent. Claude Code reports it only after the first reply of a session and only for Pro, Max and Ultra logins; a window may be missing.
- **What shows.** A bar per open window with the percent and "resets in 2 h 10 min". A report older than 15 minutes is dimmed and says "last seen N min ago": with no agent running, nothing refreshes it (a running agent refreshes it every 5 minutes and on each reply). The last value is kept in `quota.json` and shown as stale after a restart.
- **Alerts.** One Downlink item (`redline`) when a window reaches 80 % and one at 95 % ("Plan week is at 82 %, resets in 1 d 4 h"), again after the window resets. Nothing is stopped: at 100 % Claude Code itself says the limit is hit. The thresholds are fixed.
- **Your own status line.** gonogo's status line is the agent's only one, so it **chains yours**: your `statusLine.command` from your user settings (read only, never written) gets the same JSON and its output is what the agent shows. A status line in a project's settings is not chained. Without one the agent shows `plan 41% wk`.
- **No source.** An API-key or Bedrock room, a Clean Room or seed-mode agent (not verified), or a subscriber before the first reply: the block says "No plan quota reported". The token and dollar meters below it are gonogo's own ledger: an **estimate, not your plan's number**. They count only what gonogo's agents did, leave out cache reads, and Anthropic publishes the allowance in no token figure. Set a token limit that matches what you think your plan allows, and watch DOLLARS in [Cost](./cost.md) for a pay-per-token room.
- **Not read:** the spend limit of a gateway room, per-model windows, any history.

## Files and API

- `~/.gonogo/quota.json` (mode 0600): `{ version: 1, windows: { fiveHour?, sevenDay? }, at, source }`.
- `POST /hook/<agent>/StatusLine` with the agent's token (the route of the hooks); the Propellant view and frames carry `plan`.
- Spec and what was seen in a real run: `docs/quota-spec.md`.
