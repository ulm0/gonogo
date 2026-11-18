# Spec: Plan quota in Propellant (draft)

Design by FIDO, 2026-11-18, task t46. Status: draft, not built. Sources: Claude Code docs `code.claude.com/docs/en/statusline` and `/costs`, read 2026-11-18 (both pages are long; I searched them for the quota fields and read those parts). Nothing was run.

## What exists, from the docs

| Source | Carries plan quota? |
|---|---|
| **statusLine JSON** (the script gets it on stdin) | **Yes.** `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage` (0 to 100) and `resets_at` (epoch seconds) for each. Present **only for claude.ai Pro, Max and Ultra subscribers** (or behind a Claude apps gateway that sets a spend limit, which adds `rate_limits.spend_limit`), only **after the first API response** of a session, and each window may be absent. The script re-runs on each assistant message, after `/compact`, on a mode change, on a `refreshInterval` timer and when a window passes its `resets_at`. |
| `/usage` and `/status` | The same numbers as bars, for a person at the prompt. When its request fails it shows last-known bars and says "rate limited until ...". No documented way to read it from a program. |
| Hook payloads | Not stated to carry rate limits (the hook pages list none). Not used. |
| Transcript lines | Token usage only; no plan percentage. |
| A documented API for plan usage | **None for a subscriber.** Teams and Enterprise have an analytics API and a spend report (admin keys, per-seat, daily), and API/Console users have the Console cost pages: none is the 5 h / weekly window of one person. |
| `/usage`'s own endpoint | Not documented. **NO**: gonogo will not call an undocumented endpoint with the user's OAuth token, whatever it would give. |

So there **is** a real, documented source: the statusLine input. Its limits: only subscribers, only after a first reply, account-wide (one number for all agents, because the plan is one pool).

## Design

**(1) The real quota, from the statusLine.**

- gonogo already writes a settings file per Claude Code agent (`agents/<name>/settings.json`, `--settings`). Add a `statusLine` entry: `{ type: 'command', command: <node -e shim> <url> <tokenfile>, refreshInterval: 300 }`.
  The shim reads the JSON on stdin, keeps only `rate_limits` (and the session's `model.id`, to label nothing else), POSTs it to `/hook/<name>/StatusLine` with the agent's token (the route and auth of the hooks; a new event name beside `HOOK_EVENTS`), and **prints one short line** to stdout, `quota 41% wk`, so the agent's own status line is not blank. Nothing else of the JSON (cwd, session ids, cost, transcript path) is sent or stored.
- **The hub keeps one record** `quota: { fiveHour?: { pct, resetsAt }, sevenDay?: { pct, resetsAt }, spend?: { pct, resetsAt, usedUsd?, limitUsd?, period? }, at, source: <agent> }`: the report with the newest `at` wins across agents (any agent's number is the account's), a window whose `resetsAt` is past is dropped (as Claude Code does), and a report older than 15 minutes is shown as "last seen N min ago". In memory plus `<home>/quota.json` (0600), so a restart shows the last known value marked stale. No ledger, no history in v1.
- **Where it shows.** The Propellant panel gets a PLAN block above the token meters: two bars, 5-HOUR and WEEK, with the percent, the reset time ("resets in 2 h 10 min") and the age, labelled **"from Claude Code: your plan's own number"**. It also shows in the wall's Propellant module as a second line. No new top-bar key; the Patch Panel gets "Propellant: plan quota".
- **Alerts.** Two thresholds in Flight Rules (default 80 and 95 %, per window): one Downlink event `redline` per window and crossing ("Plan week is at 82 %, resets in 1 d 4 h"), re-armed when the window resets or drops under. **No automatic trip** in v1: crossing 100 % is when Claude Code itself says "You've hit your session limit"; an optional "hold new work at X %" is a later switch, and it must go through Redline, not around it.
- **Refresh.** With `refreshInterval: 300` the value is at most five minutes old while an agent runs, and it also updates on every reply. With no agent running nothing refreshes (stated in the page). gonogo itself never asks Anthropic for it.
- **Who it is for.** A room whose agents sign in with a claude.ai subscription. Seed mode and `CLAUDE_CODE_OAUTH_TOKEN` rooms (Clean Room): the field may not appear; **not verified** (the docs say `claude setup-token` tokens can only make model requests; whether `rate_limits` is sent for them is not stated). The page then says "no plan quota reported yet".
- **The Director's own status line.** `--settings` is merged with the user's settings, but a status line is a single value; **which one wins is not stated** [not verified]. If gonogo's wins, the Director's own status line script stops showing inside gonogo agents. Mitigation: a Flight Rules switch **"Read the plan quota from the status line"** (default **on** for subscriber rooms, off after the first start if the Director turns it off), and the shim can **chain**: when `GONOGO_STATUSLINE_NEXT` names the Director's own command (set at start from `~/.claude/settings.json`'s `statusLine.command`, read only, never written), the shim pipes the same JSON to it and prints its output. Builder: decide after one real run of the precedence; if the user's wins, nothing is needed.

**(2) No source: the honest proxy.** For API-key rooms, Bedrock, Console/API, and subscribers before a first reply:

- Propellant's ledger already has tokens per agent, per minute, per window (5 h, day, **week**). The Director types a **plan token budget** per window in Flight Rules ("my 5-hour allowance is about 3 M tokens"), and the existing token limits (Redline's out-of-propellant trip) already take exactly that. So the proxy is not new code: it is a new label and a hint.
- The page labels it **"estimate from gonogo's ledger: not your plan's number"**: it counts only what gonogo's agents did (not claude.ai, not agents run outside gonogo, not the plan's weighting by model and cache), excludes cache reads, and Anthropic does not publish the allowance in tokens. If a real quota is present the PLAN block shows it and the estimate is secondary; if not, the estimate carries the block with the label.
- **API-key and Bedrock rooms** have no plan quota at all: the block reads "No plan quota: this room pays per token (see COST)", and DOLLARS is the number to watch. Gateway rooms with a spend limit show `rate_limits.spend_limit` the same way (percent, reset, and dollars when the gateway sends them).

## Options

1. **Statusline shim into the hub (pick).** The only documented, programmatic source; account-wide; no credentials touched; a few kilobytes of code.
2. Scrape `/usage` from a terminal, or call its endpoint with the OAuth token. Scraping a TUI breaks with every release and costs a pty; the endpoint is undocumented. Rejected, and the endpoint is a NO on principle.

## Scope of one PR (INCO or GUIDO)

The shim and its settings entry (only for Claude Code agents; `refreshInterval` 300); `/hook/<name>/StatusLine` route with the strict reader (numbers 0 to 1000, epoch seconds, drops anything else); the hub record, staleness and `quota.json`; the PLAN block in the Propellant panel and the wall, labels and ages; two thresholds, the Downlink event and re-arming; the Flight Rules switch and thresholds; the estimate label; `docs/features/quota.md` (what is real, what is estimate, who gets nothing); a stand-in agent that emits a status line payload. About 450 lines with tests.
**Left out:** history or a chart of the percentage, automatic trips and "hold at X %", Teams/Enterprise analytics, per-model limits (Opus/Sonnet windows are not in the documented fields), the Claude apps gateway extras beyond the spend-limit bar.

## Tests

Strict parse (missing windows, a window past its reset, strings, negative, over 1000 ignored); newest report wins across agents; stale after 15 min; restart shows `quota.json` as stale; the shim posts only `rate_limits` (a payload with cwd and cost: none of it reaches the hub or the file); the shim prints a line and exits 0 when the hub is down; thresholds fire once per window and re-arm after a reset; no-source rooms show the estimate label; API-key room shows "no plan quota"; the settings file has `statusLine` for Claude agents only and not for another engine; Clean Room: no plan quota claimed.
