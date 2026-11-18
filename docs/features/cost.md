# Cost: what the tokens would cost

gonogo prices the tokens that [Propellant](propellant.md) counts. The dollars are an **API-equivalent estimate at list prices**: on a Pro or Max subscription nothing is billed per token, and the page says so.

- **Switch.** The meter of Propellant (the wall module, Flight Rules, and each console's PROPELLANT fold) has a TOKENS | DOLLARS switch. In DOLLARS the same windows (5 h, day, week, month) show spend against a **budget**, typed as `10`, `$12.40` or `1.5k`.
- **Budget.** At 80 % the meter turns saffron and the Downlink gets one `redline` event ("ana is at 80 % of its day budget") until the window drops below 80 % again. At 100 % Redline stops the agent (agent budget) or every Claude agent (room budget), exactly as for a token limit: `out of propellant: ana spent $12.40 of $10.00 in 24 h`. Resume while still over allows one more turn.
- **Cost by day.** A chart of the last 14 local calendar days, one colour per agent, with a table of the same numbers.
- **Prices.** The PRICES fold lists dollars per million tokens for each model prefix (input, output, cache write, cache read). The built-in rows are Anthropic's list prices, each stamped with the day they were copied, and **go stale**: check the vendor's page. Your own rows win; RESET drops one. A built-in row matches only its own model id, with a date (`claude-sonnet-5-5-20260101`), `-latest` or `[1m]` after it, so a newer model that merely starts the same (`claude-sonnet-5-6`) is not guessed. **Your own rows are prefixes**: the longest one that starts the model id wins. A model with no row is **unpriced**: its tokens are shown apart, never costed at zero. Nothing is fetched from the web. Editing a price prices the whole history again.
- **Patch Panel.** "Propellant: prices" and "Propellant: budget" open Flight Rules at the fold or the budget field.

## Cost per mission and task, and a budget per mission

A reply is counted to the **mission and task the agent is working on**: the agent's own Flight Plan task with status `doing` and the mission that task serves. The ledger line keeps both ids (`mission`, `task`), so the Missions view shows what each mission and each of its tasks has cost (`$1.20 of $10.00`, and the tokens that have no price). An agent with no task on `doing` costs the room, not a mission, and an agent with several is counted to the first. Work is counted when its reply is read, so a task set to `doing` a minute late is only counted from then; nothing is attributed back.

A **mission budget** is dollars in all (not per window), set in the COST block of the mission's page (`25`, `$12.50`; CLEAR removes it). At 80 % the Downlink gets one `redline` event (`mission ms3 is at 80 % of its budget`); at 100 % Redline stops **every Claude agent that has a task of that mission on `doing`**, with `out of propellant: mission ms3 spent $10.00 of $10.00`. An agent on another mission or on none keeps going. To go on, raise the budget (it is checked at once), clear it, or move the task to another mission. The order of the checks is the agent's tokens, the agent's budget, the mission's budget, then the room's. The spend of a mission is the sum of its ledger lines of the last 31 days: older ones are pruned like all ledger lines.

## Limits

- Counted like tokens: Claude Code agents only, not Clean Room agents, not subagent (Task tool) transcripts.
- Cache writes use the 5-minute price; the 1-hour price, batch discounts, long-context surcharges and per-call fees are not modelled.
- Ledger lines written before this feature have no model: they count for tokens and show as unpriced (the fold says "priced since" and a date). They are not rewritten.
- The ledger and the budgets are keyed by agent name, so a rename starts from zero.

## Files and API

- `~/.gonogo/fuel.jsonl`: lines `{at, agent, model, i, cw, o, cr, tokens}` (input, cache write, output, cache read; `tokens` = i + cw + o, as before).
- `~/.gonogo/propellant.json`: gains `budget: { room, agents }`, dollars in whole cents from 0.01 to 1,000,000.
- `~/.gonogo/prices.json` (mode 0600): `{ "version": 1, "currency": "USD", "models": { "<prefix>": { input, output, cacheWrite, cacheRead } } }`, 0 to 10,000 dollars per million. `currency` is a label only.
- `PUT /api/propellant` takes `{"budget": {"room": {"day": 10}, "agents": {"ana": {"5h": 2.5}}, "missions": {"ms3": 25, "ms4": null}}}` next to the limits; `{}` for a scope clears it, `null` clears a mission's. The view has `cost.missions` and `cost.tasks`: `{ usd, unpriced, budget? }` by id.
- `fuel.jsonl` lines may also carry `mission` and `task` (ids); `propellant.json` `budget.missions` holds the mission budgets.
- `GET /api/prices`, `PUT /api/prices` (`{"models": {...}}`, replaces your rows; an unknown field is a 400), `DELETE /api/prices/<prefix>`.
