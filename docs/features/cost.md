# Cost: what the tokens would cost

gonogo prices the tokens that [Propellant](propellant.md) counts. The dollars are an **API-equivalent estimate at list prices**: on a Pro or Max subscription nothing is billed per token, and the page says so.

- **Switch.** The meter of Propellant (the wall module, Flight Rules, and each console's PROPELLANT fold) has a TOKENS | DOLLARS switch. In DOLLARS the same windows (5 h, day, week, month) show spend against a **budget**, typed as `10`, `$12.40` or `1.5k`.
- **Budget.** At 80 % the meter turns saffron and the Downlink gets one `redline` event ("ana is at 80 % of its day budget") until the window drops below 80 % again. At 100 % Redline stops the agent (agent budget) or every Claude agent (room budget), exactly as for a token limit: `out of propellant: ana spent $12.40 of $10.00 in 24 h`. Resume while still over allows one more turn.
- **Cost by day.** A chart of the last 14 local calendar days, one colour per agent, with a table of the same numbers.
- **Prices.** The PRICES fold lists dollars per million tokens for each model prefix (input, output, cache write, cache read). The built-in rows are Anthropic's list prices, each stamped with the day they were copied, and **go stale**: check the vendor's page. Your own rows win; RESET drops one. A model id is matched by its longest prefix (`claude-sonnet-5-5-20260101` finds `claude-sonnet-5-5`). A model with no row is **unpriced**: its tokens are shown apart, never costed at zero. Nothing is fetched from the web. Editing a price prices the whole history again.
- **Patch Panel.** "Propellant: prices" and "Propellant: budget" open Flight Rules at the fold or the budget field.

## Limits

- Counted like tokens: Claude Code agents only, not Clean Room agents, not subagent (Task tool) transcripts.
- Cache writes use the 5-minute price; the 1-hour price, batch discounts, long-context surcharges and per-call fees are not modelled.
- Ledger lines written before this feature have no model: they count for tokens and show as unpriced (the fold says "priced since" and a date). They are not rewritten.
- The ledger and the budgets are keyed by agent name, so a rename starts from zero.

## Files and API

- `~/.gonogo/fuel.jsonl`: lines `{at, agent, model, i, cw, o, cr, tokens}` (input, cache write, output, cache read; `tokens` = i + cw + o, as before).
- `~/.gonogo/propellant.json`: gains `budget: { room, agents }`, dollars in whole cents from 0.01 to 1,000,000.
- `~/.gonogo/prices.json` (mode 0600): `{ "version": 1, "currency": "USD", "models": { "<prefix>": { input, output, cacheWrite, cacheRead } } }`, 0 to 10,000 dollars per million. `currency` is a label only.
- `PUT /api/propellant` takes `{"budget": {"room": {"day": 10}, "agents": {"ana": {"5h": 2.5}}}}` next to the limits; `{}` for a scope clears it.
- `GET /api/prices`, `PUT /api/prices` (`{"models": {...}}`, replaces your rows; an unknown field is a 400), `DELETE /api/prices/<prefix>`.
