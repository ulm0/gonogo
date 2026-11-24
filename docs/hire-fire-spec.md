# Spec: FLIGHT hires and fires on demand, within rules (draft)

By FIDO, 2026-11-24, task t131. Status: draft, not built. Builds on `docs/relief-spec.md` (the pending-GO path stays) and my earlier note on the archived branch `fido/relief-auto-decision` (the `archive/` tag keeps it); read: `relief.ts`, `RELIEF_MODES` (`protocol.ts:1687`), `Hub.remove`, `mcp.ts` (`hire_agent`, `start_agent`). Nothing run.

## 1. The two things the Director asked for

1. **`hire_agent` today refuses any mode above `acceptEdits`** (`RELIEF_MODES`), and every hire waits for a click. So the boss cannot hire in `auto` mode, and an automatic hire would be stuck at `acceptEdits`.
2. **The boss should hire and fire on demand, within configurable limits, with sane defaults.**

## 2. Options weighed

| | **A. Rules checked per hire (pick)** | B. A standing crew allowance |
|---|---|---|
| Idea | each `hire_agent` is approved at once if it fits the room's rules, else it becomes a normal request for the Director | the Director grants "FLIGHT may have up to N agents and $X", and every hire inside is free |
| For | one mechanism for everything (mode, engine, folder, count, spend); a refused hire degrades to today's behavior; easy to explain | fewer settings |
| Against | more fields | spend and privilege are mixed in one number; harder to say why a hire was refused |
| **Fire** options | **stop (pick)**: the agent ends, its record, memory, transcript and worktree stay; it can be started again | remove: record and keys deleted; kept for the Director |

## 3. Room settings (Flight Rules, a "Relief" block; `<home>/relief.json`, 0600, `version: 1`)

| Setting | Default | Notes |
|---|---|---|
| `autoApprove` | **off** (as today: every hire waits for a GO) | turning it on is the one step that changes who decides; needs step-up; a bad or missing file reads as off |
| `maxCrew` | 3 | agents the boss hired by rule that exist now (running or stopped); hard ceiling `MAX_AGENTS` (24) |
| `crewBudgetUsd` | **required when `autoApprove` is on** | one dollar ceiling for the whole boss-hired crew per day (Propellant already counts per agent); at the cap the **crew** is held, not the room |
| `positions` | none until the Director picks | auto-approval is only for these roster positions; **a free-text `role` is never auto-approved** (an injected boss cannot write a persona), it asks the Director |
| `engines` | the room default engine | custom commands and payloads are never auto-approved |
| `models` | the room default | an allow-list of model names per engine; anything else asks |
| `maxMode` | `acceptEdits` | the highest mode the boss may grant by rule: `default`, `acceptEdits` or **`auto`** (Claude's classifier mode; the Director's request). **`bypassPermissions` is not a choice** (see below) |
| `bypassInCleanRoom` | off | the only way the boss may grant `bypassPermissions`: it needs this **and** a Clean Room hire (the agent runs in a container on its own worktree) **and** step-up to turn on. Without it, a request for bypass asks the Director as today. |
| `sandboxFloor` | the boss's own and the room default | the hire's Clean Room, flavor and (when it exists) egress rules are at least those; never weaker |
| `folder` | the boss's folder or inside it (realpath) | as a Clean Room boss's rule today, for everyone |
| `ratePerHour` | 3 | counts hires, not live agents |
| `autoFireIdleMinutes` | **off** | if set (for example 60): a boss-hired agent with no task and no activity for that long is **stopped** (see 4) |
| `protected` | the boss and every agent the Director hired | a per-agent flag the Director can also set; protected agents are never fired by the boss or by a rule |

**Why `bypassPermissions` is special.** It runs every tool with no check. By rule, the only place that is defensible is inside a Clean Room, and even then it must be an explicit Director setting. Anything else the boss asks for in bypass **still goes to the Director as a request**; nothing is refused silently.

**How `hire_agent` uses the settings.** Unchanged signature (plus `model?`). The server runs today's validation, then the rules: if **every** rule passes it staffs the agent immediately (through `Hub.hire`, with `hiredBy: 'boss'`) and answers `{ status: 'hired' }`; if **any** rule fails it makes a normal pending request and the note says which rule ("mode auto needs your GO: maxMode is acceptEdits"). The boss hears every outcome. Counting and the crew slot are reserved under the same lock as the request limits so two parallel hires cannot both pass the cap.

## 4. `fire_agent`

`fire_agent { name, reason }` (boss only, rate limited like `start_agent`):
- **What it does: stop.** The pty ends; the record, `memory.md`, transcript and Claude session id stay (a restart resumes); a worktree or Clean Room worktree stays untouched.
- **Its tasks:** open tasks assigned to it (`todo`, `doing`, `blocked`, `review`) are set to `todo` and unassigned with the history line `released: <name> was stopped by flight` (the Flight Plan otherwise keeps the name of a removed or stopped agent, `tasks.ts` header), and the boss is told how many.
- **Not allowed:** a protected agent, the boss itself, an agent with an unanswered permission prompt, an open T-minus vote or a waiting Director message. The answer says which.
- **Remove stays the Director's.** `Hub.remove` deletes the record and its keys; the boss cannot call it. (If the Director later wants the boss to remove, the rule would be: only a boss-hired agent, stopped, with a clean worktree: git's own `worktree remove` without `--force` already refuses a dirty folder; its `agents/<name>/` folder renamed, not deleted.)
- **Auto-fire by idleness** (setting `autoFireIdleMinutes`) uses the same stop, the same exclusions and a Downlink line.

## 5. Step-up, audit, and what each change needs

- **Step-up (the Director's session, scope `full`, no agent route reads or writes it):** turning `autoApprove` on; raising `maxCrew`, `crewBudgetUsd`, `maxMode`, the allow-lists; turning `bypassInCleanRoom` on; clearing `protected`. **No step-up** to lower any of these or to set `protected`, and a **STOP CREW** key (stops every boss-hired agent and sets `autoApprove` off) needs none because it only removes power.
- **Audit:** every hire, refusal-to-request, fire and rule change is a **Downlink line** (always, never silent) and a **Black Box** event with names, ids, which rule decided and counts, **never the role text**. The roster tile of a boss-hired agent carries a badge "hired by flight".
- A file changed outside gonogo reverts the room to `autoApprove: off` with an alarm (the login spec's tamper rule).

## 6. Threats (for RSO)

| Id | Threat | Must hold |
|---|---|---|
| **H1** | A prompt-injected boss hires a crew to do harm. | Only the Director's presets (positions), the mode ceiling, the sandbox floor, a folder under the boss's, `maxCrew`, the daily crew budget; free text, custom commands and payloads always ask. |
| **H2** | Mode escalation chain. | Only the boss hires; boss-hired agents cannot call `hire_agent`; the ceiling is read from the stored setting, never from the request; `bypassPermissions` only with `bypassInCleanRoom` and a Clean Room hire. |
| **H3** | A hire/fire loop to burn spend. | The rate counts hires; the crew budget is cumulative per day (fire then rehire does not reset it). |
| **H4** | Fire used against the Director's agents or the boss. | Server-side `hiredBy` check; protected agents and the boss refused; stop only. |
| **H5** | The settings changed by an agent. | Director session and step-up only; no MCP tool for it; the file is 0600 (same-user agents outside a Clean Room can still edit it: the known limit, answered by the tamper revert). |
| **H6** | Races and restarts. | Slot and name reserved under one lock; `hiredBy` stored in the record so a restart keeps the crew counted; defaults on any parse error: off. |

## 7. Phases (smallest first)

| PR | What | Size |
|---|---|---|
| **1** | `relief.json` and the API with step-up, the rules check in `hire_agent` (instant hire or pending with the reason), `hiredBy`, the badge, Downlink and Black Box lines, `maxMode` up to `auto`, STOP CREW; `bypassInCleanRoom` **not** in this PR | ~300 |
| **2** | `fire_agent` (stop, tasks released, exclusions), `protected`, the Relief block in Flight Rules | ~250 |
| **3** | `crewBudgetUsd` enforcement and the crew hold, the sandbox/egress floor, `models` | ~250 |
| **4** | `autoFireIdleMinutes`, `bypassInCleanRoom` (after RSO is satisfied), docs | ~200 |

**Tests.** Defaults leave today's behavior byte-identical; an in-rules hire staffs at once with `hiredBy`, an out-of-rules one becomes a pending request that names the rule; `auto` mode is granted only up to `maxMode` and never `bypassPermissions` without the Clean Room setting; a free-text role, a custom command, a payload, a folder outside the boss's all ask; a boss-hired agent cannot hire; settings need step-up and 404 for an agent token; rate and crew cap hold under parallel calls; fire stops (record, memory, session and worktree kept), releases its tasks, refuses the boss, a protected agent and one with a pending prompt; the Black Box row has no role text.

## 8. Open questions for the Director

1. Default `autoApprove: off` (one switch and a few limits to turn on) or on with the defaults above? I recommend off, since the first click is the one that changes who decides.
2. May the boss ever grant `bypassPermissions`? My proposal: only inside a Clean Room and only with its own switch.
3. Is the boss's fire **stop only** enough, with removal yours?
