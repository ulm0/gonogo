# Spec: Cost in Propellant (draft)

Design by FIDO, 2026-11-18. Extends `docs/redline-propellant-spec.md`. Status: built.

## Intent

Propellant counts tokens (input + cache creation + output; cache reads left out). Tokens of different models cost very
differently, so a token limit says little about money. Add prices, so the Director sees dollars per agent, per room and per
day, and gets a budget warning that works like the token limit and goes through Redline. **The number is an estimate at API
list prices.** On a Pro or Max subscription nothing is billed per token; the page says "API-equivalent".

## Design

- **What the ledger must keep.** Today a `fuel.jsonl` line is `{ at, agent, tokens }`, which cannot be priced. A new line is
  `{ at, agent, model, i, cw, o, cr }`: input, cache-write, output and cache-read tokens, per agent, per minute, **per
  model** (`message.model` of the transcript line, which `lineUsage` already parses around). `tokens` is still written
  (= `i + cw + o`), so the token limits and old readers work unchanged and cache reads stay out of them. Old lines have no
  `model`: they count for tokens and show as **unpriced** in the cost. Reading the 5-hour window of a ledger from before the
  change therefore shows partial cost; the page says "priced since <date>" once. No migration pass, no rewrite of old lines.
- **The price table** (`src/shared/prices.ts`, pure): `ModelPrice = { input, output, cacheWrite, cacheRead }` in dollars per
  million tokens. Built-in defaults for the Claude model families, each stamped with `asOf: 'YYYY-MM-DD'`; the builder copies
  the numbers from Anthropic's pricing page at build time (this design states none, to avoid a wrong guess). A model id is
  matched by the **longest prefix** in the table (`claude-sonnet-5-5-20260101` finds `claude-sonnet-5-5`). A model with no
  match is **unpriced**: its tokens are shown and summed apart ("12k tokens unpriced"), never costed at zero or at a guess.
- **Local and editable, no network.** `~/.gonogo/prices.json` (mode 0600, same writer as `schedules.ts`):
  `{ "version": 1, "currency": "USD", "models": { "<prefix>": { input, output, cacheWrite, cacheRead } } }`. Entries in the
  file win over the defaults. `GET /api/prices` returns the merged table with the source of each row (`default` or `file`),
  `PUT /api/prices` replaces the file's part (strict: unknown field 400, numbers 0 to 10000), `DELETE /api/prices/<prefix>`
  returns to the default. Nothing is fetched; "check the vendor's page" is a link in the panel, not a call. `currency` is a
  label only (no conversion).
- **The cost view.** `PropellantView` gets `cost`: `{ room: CostGauge, agents: Record<string, CostGauge>, days: DayCost[] }`.
  `CostGauge = { usd: Record<FuelWindow, number>, unpriced: Record<FuelWindow, number>, budget: Budget }`. `days` is the
  last 14 **local calendar days**, `{ date, usd, unpriced, byAgent }` (the window "day" stays a rolling 24 h for the limits;
  the chart wants calendar days). Computed from the in-memory ledger that Propellant already holds; no new file read.
- **The budget.** `propellant.json` gets `budget: { room: Budget, agents: Record<string, Budget> }`, `Budget` = `{ [window]:
  usd }` with the same windows and the same validation shape as `parseLimits` (whole cents, 0.01 to 1,000,000, or null).
  `over(agent)` checks the budget after the token limit with the same agent-then-room order, and the trip reason is
  `redline: out of propellant: ana spent $12.40 of $10.00 in 24 h` (the existing prefix, so Redline, the Downlink and Relay
  need no change). 80 % turns the meter saffron and posts **one** Downlink event `redline` per agent and window
  ("ana is at 80 % of its day budget") until the window drops below 80 % again; this is the "budget warning". 100 % trips
  exactly like a token limit; a Resume while over allows one more turn (the known limit, unchanged).
- **A warn-only budget** is not a mode: the Director who wants no trip leaves the limit empty and watches the warning at the
  room level, or sets a high one. One behaviour, one place to test.
- **The top bar.** No new key. The numbers live in the existing PROPELLANT panel: a TOKENS | DOLLARS switch on the meters, a
  day chart (the `dataviz` rules, one series per agent, the 14 days), and a PRICES fold with the editable table. The Patch
  Panel gets two lines: "Propellant: prices" and "Propellant: budget" (they open that panel and the fold). The tile's fuel
  ring keeps showing the nearest of token limit or budget (whichever is higher in percent), with the unit in its accessible
  name.
- **Not counted** (unchanged, now also for money): Clean Room agents and subagent (Task tool) transcripts. The cost line says
  so in the same words as the token one.

## Options

1. **Price at read time from a stored token split (pick).** The ledger keeps raw tokens per model; prices are applied when
   the view is built. Editing a price or adding a missing model **re-prices the whole history** at once, which is what an
   owner who corrects a wrong number expects, and the ledger stays a record of facts, not of opinions.
2. Price at write time and store dollars in the ledger. Simpler view code, but a wrong price is baked in for 31 days and an
   unpriced model can never be priced later. Rejected.

## Interfaces

`src/shared/prices.ts` (`ModelPrice`, `DEFAULT_PRICES`, `priceFor(table, model)`, `costOf(entry, price)`, pure and tested);
`src/server/propellant.ts` (`FuelEntry` gains `model, i, cw, o, cr`; `lineUsage` returns the split and the model; `view()`
adds `cost`; `setBudget`; `over()` checks budgets); `src/server/prices.ts` (file reader/writer, `parsePrices`); routes
`GET/PUT /api/prices`, `DELETE /api/prices/:prefix`, and `PropellantRequest` gains `budget`. Client: `Propellant.tsx` switch,
chart and prices fold; `fuel.ts` gets `moneyText(usd)` (`$0.42`, `$12.40`, `$1.2k`).

## Order of changes

1. `prices.ts` (pure) with tests; `lineUsage` returns model and the split; ledger lines written in the new shape (old lines
   still read).
2. `view().cost` and the days; `prices.json` and its routes.
3. Budget in `propellant.json`, `over()`, the 80 % event; Redline reason text.
4. Page: switch, chart, prices fold, budget fields, Patch Panel lines. Feature page `docs/features/cost.md`; the old
   propellant page and spec get one line each that point here.

## Test plan

- `priceFor`: longest prefix, no match is unpriced, file beats default. `costOf`: each of the four kinds, rounding to a cent
  only at display.
- Transcript fixtures with two models and cache reads: tokens limit unchanged (cache reads out), cost includes them at the
  cache-read price; an old ledger line is unpriced and not zero.
- Ledger: old and new lines in one file; the 31-day keep; a restart reads the same totals.
- Budget: 79 %, 80 % (one event, not two), 100 % trips agent then room, Resume, window rolls below 80 % re-arms the event,
  invalid budgets refused with the field name, a renamed agent (the known name-key limit) still starts from zero.
- Prices routes: unknown field, negative number, huge number, a prefix with odd characters (`^[A-Za-z0-9._-]{1,80}$`).
- Client: the switch, the unpriced note, 390 px, the chart's accessible table.

## Missions and tasks (added with PR M)

A ledger line may carry `mission` and `task`: the `doing` task of the agent (assignee = agent, status doing, the first when there are several) and its `missionId`, read at the moment the transcript is counted (`createPropellant({ attribute })`; cli.ts supplies it from the Flight Plan). No new file: the view derives `cost.missions` and `cost.tasks` from the ledger. A budget on a mission is dollars in all (`propellant.json` `budget.missions`), warned once at 80 % like the others (`mission ms3 is at 80 % of its budget`) and checked in `over()` after the agent's budget: the reason is `out of propellant: mission ms3 spent $10.00 of $10.00`, scope `mission`, and cli.ts trips every Claude agent whose current mission is that one. Idea from docs/kimchi-review.md; no code was taken from Kimchi.
Tests: test/mission-cost.test.ts.

## Known limits

- The estimate ignores batch discounts, long-context surcharges, and web-search or other per-call fees.
- Prices go stale: each default row shows its `asOf`, and the panel says "prices as of" with the oldest one.
- A name-keyed ledger (existing shortcut).
