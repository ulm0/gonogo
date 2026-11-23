# Decision note: automatic hire and fire (`relief: manual | auto`) (draft)

By FIDO, 2026-11-23, for FLIGHT, the Director and RSO. Read-only: **no code changed.** Read: `docs/relief-spec.md`, `src/server/relief.ts` (header, `limits`, `request`, `decide`), `RELIEF_*` in `src/server/constants.ts:503` and `src/shared/protocol.ts:1687`, the `start_agent`/`hire_agent` tools in `src/server/mcp.ts:509-540`, `Hub.remove` (`protocol.ts:2841`), `startup.ts` (`bossMayStart`). Nothing was run.

## 1. Short answer

- **Yes, as a room setting, default `manual`, changed only with step-up.** `auto` replaces the Director's GO with **limits that are enforced on the server and cannot be argued with**: a ceiling on agents, a budget for the whole auto-hired crew, an allow-list of positions, a mode ceiling, a floor for the sandbox, a rate limit, and a visible audit trail. **`bypassPermissions` is never automatic, and `auto` mode is a separate switch that defaults to off even when `relief: auto` is on.**
- **Auto belongs to the room, not to the boss.** The boss is the party an injected instruction would steer; the setting must not be something it can reach. The boss only **uses** what the room allows.
- **Fire means `stop`, never delete.** An auto-hired agent can be stopped (kept: record, memory, transcript, worktree) by the boss or by a rule; **removal stays the Director's**. Only agents that were auto-hired can be auto-fired; the boss and anything the Director hired never.
- **Smallest first PR (about 250 lines):** the `relief` setting with step-up, an auto path that runs the *existing* request validation and `Hub.hire` without the wait, under four hard limits (crew cap, mode ceiling, rate, a visible badge), **no auto-fire yet**. Fire comes second.

## 2. What the human gate does today, and what must replace it

Today `hire_agent` makes a **pending request** (`relief.ts`); only the Director's GO reaches `Hub.hire`. The GO is doing four jobs at once, and `auto` must replace **each**:

| What the GO does today | Replaced in `auto` by |
|---|---|
| **Reads the role text** the new agent will get (a prompt-injection catch: the Director sees the words) | the same cleaning and caps as today (hidden characters refused, length cap), the **position list as an allow-list**, and **free-text roles refused in auto** (see 3); the role is shown in the audit row |
| **Decides the spend** | a **crew budget** and the existing per-agent Propellant budget the room already supports (`budget.agents[name]`), set at hire |
| **Decides the privilege** (mode, folder, Clean Room, engine) | the **mode ceiling** and **floors**: the new agent's isolation is **at least the boss's and at least the room default**, never lower |
| **Rate-limits by being slow** | an explicit rate limit and a crew cap, counted server-side |

## 3. The setting and its limits

`<home>/relief.json` (0600, atomic, `version: 1`): `{ mode: 'manual'|'auto', auto: { maxCrew, crewBudgetUsd, positions[], maxMode, allowAutoMode, engines[], ratePerHour } }`. **Read and written only through `PUT /api/relief/settings` with step-up and scope `full`** (the Director's session; no agent route, no key below `full`). Flight Rules gets a **Relief** block under the existing requests list.

| Limit | Default | Why |
|---|---|---|
| `maxCrew` | 3 | agents hired by `auto` that exist at once; counts running and stopped alike until the Director removes them, so a loop cannot pile up silently. Hard ceiling `MAX_AGENTS` (24), and Max Q still applies when they run. |
| `crewBudgetUsd` | **required, no default**: `auto` cannot be switched on with an empty budget | one dollar ceiling for the whole auto-hired crew (the sum of each agent's Propellant spend); at the cap the **crew is held**, not the room (the lesson of M8 in the docking spec: a limit may only affect what it governs). Each hire also gets a per-agent budget (`crewBudgetUsd / maxCrew`). |
| `positions` | the Director picks from the roster; none by default | **auto hires only from this list**; `role` free text is **refused in auto** (an injected boss cannot write a new persona). Position texts are the Director's presets. |
| `maxMode` | `acceptEdits`; **`default` is the floor of the list** | `bypassPermissions` and `confirmBypass` are refused in auto, always. `auto` mode (Claude's classifier mode) is allowed only if `allowAutoMode` is on, default off, and is shown in the audit row. |
| `engines` | the room default engine only | no custom command, no payload, no `cleanRoom` change, as today |
| Sandbox floor | the boss's own: a Clean Room boss hires Clean Room agents inside its own folder only (today's rule); **the flavor and the egress rules are at least the room default** (`docs/cleanroom-microvm-decision.md`, `docs/cleanroom-egress-decision.md`) | an auto-hired agent can never be less isolated than its hirer |
| `dir` | the boss's folder or inside it (realpath), as for a Clean Room boss today, **for every boss in auto** | an injected boss cannot send a new agent to `~` or another project |
| `ratePerHour` | 3 (today's request cap is 5 per 10 minutes) | a hire loop stops by itself |

The **manual path stays exactly as it is** when `relief: manual`, and an auto request that breaks any limit **falls back to a normal pending request** (the Director gets the usual GO/NO-GO with the reason "auto declined: <limit>"), never a silent refusal and never a silent pass.

## 4. Auto fire

**What "fire" means:** `stop`, with record, `memory.md`, transcript and worktree kept, and the seat shown as `stopped (released by relief)`. **Not** `Hub.remove` (that deletes the record and its keys, `hub.ts:2442`) and not an archive feature that does not exist yet. The Director can restart or remove.

**Who may fire whom.** Only the **boss** (a new tool `release_agent { name, reason }`, rate limited like `start_agent`) and the **room's own rules**; **only an agent that `auto` hired** (the hire writes `AgentRecord.hiredBy: 'relief'` and the boss's name; the Director's hires and the boss itself are never eligible, and the check is on the server). The boss **cannot fire a Director-hired agent** even if told to, and a stopped agent can be restarted by the Director or by `start_agent` as today.

**Triggers (all optional, off by default, in the same block):** idle for N minutes (default 30) with no task assigned; the agent's task reaches `done` (and none other is assigned); the agent's own budget is hit (the existing hold already stops the work: fire releases the seat); the crew budget is hit. **Never fired while it holds an unanswered permission prompt, a T-minus vote or a message waiting for the Director.** Each fire is a Downlink line.

## 5. What the Director sees

- **Every auto hire and release is a Downlink event** (names the agent, position, mode, folder, budget, who asked), not only a log line, and appears in the **Black Box** by name and counts. The roster tile of an auto-hired agent carries a badge **"auto-hired by flight"** with the time, so a crew built while nobody watched is visible at a glance.
- A **Relief block** shows the crew (names, spend against the crew budget), the limits, and a **STOP CREW** key (stops every auto-hired agent, sets `relief: manual`) that needs no step-up (it only reduces power).
- The boss is told the outcome as a message (as it hears Relief answers today).

## 6. Threats (RSO reads this)

| Id | Threat | Must hold |
|---|---|---|
| **R1** | A prompt-injected boss hires a crew to do harm (the new agents obey whoever injected the boss). | The room's limits are the only authority: positions only (no free-text role), mode ceiling, sandbox floor, `dir` under the boss's, crew cap and budget. An injected boss can at most buy crew of the Director's own presets inside the cap. |
| **R2** | Mode escalation chain: an auto-hired agent hires another, or the boss asks for a higher mode each time. | **Only the boss may hire** (as today); auto-hired agents are never bosses and have no `hire_agent`; the mode ceiling is checked against the stored setting, not a request field; `bypassPermissions` never. Test: an auto-hired agent calling `hire_agent` is refused. |
| **R3** | A hire loop (hire, release, hire...) to burn spend or churn. | `ratePerHour` counts hires, not agents alive; the crew budget is **cumulative per day**, so releasing and rehiring does not reset it; a hit puts the crew on hold. |
| **R4** | Spend: many agents each within budget but together large. | The crew budget is the sum; `maxCrew`; Max Q caps agents working at once; the existing Redline per agent still trips. |
| **R5** | The setting is changed by the boss or by an agent. | `PUT /api/relief/settings` needs the Director's session with step-up; no MCP tool reads or writes it; the file is 0600 and, like every room file, readable by same-user agents outside a Clean Room (the known limit); a tamper (file changed outside gonogo) reverts the room to `manual` and raises the Downlink alarm (the login spec's tamper rule, reused). |
| **R6** | Fire used as an attack on the Director's work (an injected boss stops the Director's own agents). | Only `hiredBy: 'relief'` agents are eligible; checked server-side; the boss and Director-hired agents never. |
| **R7** | An auto-hired agent's text (role from a position preset) is the Director's, but its **name** and task messages come from the boss. | Names pass the existing `NAME_RE`/reserved-name checks and the same hidden-character filter; the audit shows the name as typed. |
| **R8** | Race: two auto hires at once pass the crew cap. | Count under the same lock as `hire` (reserve the name and the crew slot before the await, as `limits()` does for requests). |
| **R9** | `manual` silently becomes `auto` by a bad file or a restart. | The default and every failed parse are `manual`; auto needs a complete valid settings file including a budget. |

## 7. Phases

| PR | What | Size | Needs |
|---|---|---|---|
| **1. Auto hire, no fire** | `relief.json`, the step-up API, the auto path in `relief.ts` (reuse `request` validation, call `Hub.hire` with the checked parameters, `hiredBy`), the four hard limits (crew cap, positions only, mode ceiling `acceptEdits`, rate), the audit (Downlink + Black Box + badge), STOP CREW, fall back to a pending request when a limit refuses, docs | M, ~250 to 350 | RSO |
| **2. Crew budget and floors** | the cumulative crew budget with a crew hold, per-agent budgets at hire, the sandbox/egress floors and the `dir` rule, `allowAutoMode` | M, ~250 | RSO; the sandbox flavor and egress notes |
| **3. Auto fire** | `release_agent` and the rule triggers (idle, task done, budget), `hiredBy` eligibility, the guards (no release with a pending prompt or vote), Downlink lines | M, ~250 | RSO |
| **4. Polish** | the Relief block showing the crew and spend, a per-day history, the docs and the not-verified list | S, ~150 | |

**Tests (by PR).** 1: manual stays byte-identical; auto off by default and after a bad file; a hire inside the limits staffs without a request and with `hiredBy`; each limit refused falls back to a pending request with the reason; `bypassPermissions`, a free-text role, `confirmBypass`, a `dir` outside the boss's, a custom command and a payload are refused in auto; the settings API needs step-up and scope `full` and is 404 for an agent token; an auto-hired agent cannot call `hire_agent`; the rate counts hires. 2: releasing and rehiring does not reset the day's crew budget; a hit holds the crew only, other agents keep working; floors apply. 3: the boss cannot release a Director-hired agent or itself; an agent with a pending prompt or an open T-minus vote is not released; stopped agents keep record, memory and worktree. Not testable here: how a real injected boss behaves.

## 8. Open questions for the Director

1. Default crew limits: `maxCrew` 3, positions chosen by you, `acceptEdits` ceiling, `auto` mode off: right?
2. Is a **crew budget required** to switch auto on (my recommendation), or should it be optional?
3. **Auto fire as `stop` only**, with removal always yours: OK?
4. Should the boss's hire in auto skip the Director's notice entirely, or always raise a Downlink line (my recommendation: always)?
