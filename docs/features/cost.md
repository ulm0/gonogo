# Cost: what the tokens would cost

<CostMock class="doc-mock" />

Prices the tokens that [Propellant](propellant.md) counts, with budgets. Dollars are an **API-equivalent estimate at list prices**: on a Pro or Max subscription nothing is billed per token.

- **Switch.** The Propellant meter (wall module, Flight Rules, each console's PROPELLANT fold) has TOKENS | DOLLARS. DOLLARS shows the windows (5 h, day, week, month) against a **budget** typed as `10`, `$12.40` or `1.5k`.
- **Budget.** At 80 % the meter turns saffron and the Downlink gets one `redline` event ("ana is at 80 % of its day budget") until the window drops below 80 %. At 100 % Redline stops the agent (agent budget) or every Claude agent (room budget), as for a token limit: `out of propellant: ana spent $12.40 of $10.00 in 24 h`. Resume while still over allows one more turn.
- **Cost by day.** Chart of the last 14 local calendar days, one colour per agent, plus a table by agent and kind of token (Total, Input, Output, Cache write and read), from `GET /api/cost`. All are estimates: counted tokens times list price. This is the one basis of the meter, budgets and Redline.
- **Room list.** Each room's card shows "about $x today (estimate)" when above zero.
- **Patch Panel.** "Propellant: prices" and "Propellant: budget" open Flight Rules at the fold or field.

## Prices

The PRICES fold lists dollars per million tokens per model prefix (input, output, cache write, cache read).

- Built-in rows are Anthropic's list prices, stamped with the day copied; they **go stale**, so check the vendor's page. Nothing is fetched from the web.
- A built-in row matches only its own model id, with a date (`claude-sonnet-5-5-20260101`), `-latest` or `[1m]` after it; `claude-sonnet-5-6` is not guessed.
- **Your own rows are prefixes**: the longest match wins and beats built-ins. RESET drops one. Editing a price prices the whole history again.
- A model with no row is **unpriced**: its tokens show apart, never costed at zero.

## By engine, provider and model

The same model can come through different engines (Opus in Claude Code and in pi), and some models are free (opencode's `big-pickle`). Each new ledger line therefore carries the **engine** that ran the reply (`claude`, `pi`, `opencode`: the console's engine) and the **provider** as the engine reports it (`anthropic` for Claude Code; pi and opencode say their own, such as `anthropic`, `opencode`, `openai`). The wall's **BY ENGINE AND MODEL** fold (window buttons 5 h, day, week, month) and the Cost table of Flight Rules list one row per engine, provider and model with its tokens, the estimate, and which agents used it (hover the model). The last row is the room total: the sum of the rows, the same number as the meter.

- **Free is not unpriced.** A price row of four zeros means the model costs nothing: it shows as **free** and adds $0. A model with no row at all shows **no price** with its tokens, and never counts as zero. Built-in free row: `big-pickle`. Opencode's other free models change often: add a row of your own.
- **A price per provider.** A row named `<provider>/<model prefix>` (for example `bedrock/claude-opus-5-5`) is used for that provider's use first; without one the plain model row applies. So the same model id can cost different things through different providers.
- **Counts against.** A row says **Claude plan** when it is Claude Code and the room has a [plan quota](quota.md) (a claude.ai login), and **API or other** otherwise: pi, opencode and API-key use never count against the plan. The quota itself stays Claude plan only.
- **Old lines** (before this table) have no engine or provider and show **unknown**; they are not rewritten.
- **Budgets** stay per room, agent, mission and link, in dollars of the sum. A budget per engine or provider was not built: it needs a rule for what a hold does to a mixed room (stopping only the pi agents, say), which is a decision for the Director.

## Reported cost (Claude Code)

Claude Code's status line carries the session's dollars so far. gonogo keeps that **beside** the estimate, per agent and for the room, and **never adds it to the estimate or lets it move a budget**. The room figure sums the agents that have one ("1 of 2 agents") and says "at least" (the last seconds of a session can be lost). Other engines show the estimate only. On a claude.ai subscription it is what the use would cost at API prices, not a charge.

## Cost per mission and task, and a budget per mission

A reply is counted to the **mission and task the agent works on**: its Flight Plan task with status `doing` and that task's mission. The Missions view shows each mission's and task's cost (`$1.20 of $10.00`, plus unpriced tokens).

- An agent with no `doing` task costs the room, not a mission; with several, the first counts. Counted when the reply is read: nothing is attributed back.
- **Mission budget:** dollars in all (not per window). Set in the COST block of the mission page (`25`, `$12.50`; CLEAR removes it). At 80 % one `redline` event (`mission ms3 is at 80 % of its budget`). At 100 % Redline stops **every Claude agent with a `doing` task of that mission**: `out of propellant: mission ms3 spent $10.00 of $10.00`. Others keep going.
- To go on: raise the budget (checked at once), clear it, or move the task to another mission.
- Check order: agent tokens, agent budget, mission budget, room.
- Mission spend is its ledger lines of the last 31 days; a longer mission loses its oldest spend against its "in all" budget.

## Limits

- Counted like tokens: Claude Code agents from their transcripts, pi and opencode agents from the usage their extension reports with each reply (opencode's subagents included); not Clean Room agents, not Claude Code subagent (Task tool) transcripts.
- An unpriced model adds to unpriced tokens, not dollars, so it does not move a budget. Old ledger lines have no model: tokens only, shown unpriced ("priced since" date). Not rewritten.
- Cache writes use the 5-minute price. The 1-hour price, batch discounts, long-context surcharges and per-call fees are not modelled.
- The ledger and budgets are keyed by agent name: a rename starts from zero.
- **Reported figures** come from Claude Code's status line only, while an agent runs: a figure is "at least" what was spent. **Seen in one short run** (Claude Code 2.1.325, haiku, claude.ai subscription): the JSON has `session_id` and `cost.total_cost_usd` from its first refresh; `/clear` made a new session id with a total back at 0. **Not seen:** whether a subagent's spend is in the total, what `--resume` does to the id and total, a run with an API key.

## Files and API

| Item | Shape |
|---|---|
| `~/.gonogo/fuel.jsonl` | `{at, agent, model, i, cw, o, cr, tokens}` (input, cache write, output, cache read; `tokens` = i + cw + o); may carry `engine`, `provider`, `mission`, `task` |
| `~/.gonogo/propellant.json` | `budget: { room, agents, missions }`, dollars in whole cents, 0.01 to 1,000,000 |
| `~/.gonogo/prices.json` (0600) | `{ "version": 1, "currency": "USD", "models": { "<prefix>": { input, output, cacheWrite, cacheRead } } }`, 0 to 10,000 per million; `currency` is a label |
| `~/.gonogo/reported.jsonl` | reported session totals; format in [`docs/cost-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/cost-spec.md); kept 31 days, 5,000 sessions per agent, 20,000 in all |
| `PUT /api/propellant` | `{"budget": {"room": {"day": 10}, "agents": {"ana": {"5h": 2.5}}, "missions": {"ms3": 25, "ms4": null}}}`; `{}` clears a scope, `null` a mission's. View has `cost.missions`, `cost.tasks`: `{ usd, unpriced, budget? }` by id |
| `GET /api/prices`, `PUT /api/prices`, `DELETE /api/prices/<prefix>` | PUT `{"models": {...}}` replaces your rows; unknown field is 400 |
| `GET /api/cost?days=N` | N 1 to 31, default 14, else 400 |

`GET /api/cost` returns `{ currency, estimate: true, dayBoundary: "local", from, to, room, agents, days, unpricedModels, partial, sessions, pricedSince, priceAsOf, breakdown }`. `breakdown` is a list of `{ engine, provider, model, tokens, cacheRead, usd, unpriced, free, claudePlan, agents: { <name>: { tokens, usd, unpriced } } }` for the days asked; the live view (`cost.breakdown`) has the same rows per window `{ "5h", day, week, month }`.

- **A day is the server's local calendar day.**
- `room` and each agent: `usd`, `usdSplit` `{input, output, cacheWrite, cacheRead}`, `tokens` (same kinds), `unpriced` (tokens of an old line or unpriced model; `unpricedModels` names them).
- Reported: `room.reported`, `reportedAgents` `{have, of}`, per agent `reported`, `basis` (`reported`, `estimated`, `none`), `sessions`. `days` repeats the numbers per day with `byAgent` and `reported`.
- `partial` is true when the 31-day ledger was cut inside the window. `priceAsOf` is the day default prices were copied.
- A room under `/r/<id>/` has its own `/api/cost`.
