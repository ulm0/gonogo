# Spec: FLIGHT hires and fires on demand, within rules (draft)

By FIDO, 2026-11-24, task t131. Status: PR1 built (rules file and API with step-up, the check in `hire_agent`, `hiredBy`, badge, audit lines, `auto` up to `maxMode`, STOP CREW); PR2 built (`fire_agent`, `protected`, the Relief block in Flight Rules); PR3 built (crew budget hold, `models`); PR4 built (`remove`, `mayRemove`, `bypassInCleanRoom`); PR5 built (§9.3 autoscale, `Task.position`). Builds on `docs/relief-spec.md` (the pending-GO path stays) and my earlier note on the archived branch `fido/relief-auto-decision` (the `archive/` tag keeps it); read: `relief.ts`, `RELIEF_MODES` (`protocol.ts:1687`), `Hub.remove`, `mcp.ts` (`hire_agent`, `start_agent`). Nothing run.

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
| `crewBudgetUsd` | optional (the Director, t148: empty = no daily ceiling; room budgets and Redline still apply) | one dollar ceiling for the whole boss-hired crew per day (Propellant already counts per agent); at the cap the **crew** is held, not the room |
| `positions` | none until the Director picks | auto-approval is only for these roster positions; **a free-text `role` is never auto-approved** (an injected boss cannot write a persona), it asks the Director |
| `engines` | the room default engine | custom commands and payloads are never auto-approved |
| `models` | the room default | an allow-list of model names per engine; anything else asks |
| `maxMode` | `acceptEdits` | the highest mode the boss may grant by rule: `default`, `acceptEdits` or **`auto`** (Claude's classifier mode; the Director's request). **`auto` applies to Clean Room hires only (RSO F1):** on the host it needs the separate switch `autoOnHost` below. **`bypassPermissions` is not a choice** (see below) |
| `autoOnHost` | **off** | the only way a rule hire may run in `auto` **outside a Clean Room**; step-up to turn on, with the warning "agents the boss hires can change anything your user can, without asking". One explicit click, not a side effect of `maxMode`. |
| `bypassInCleanRoom` | off | the only way the boss may grant `bypassPermissions`: it needs this **and** a Clean Room hire (the agent runs in a container on its own worktree) **and** step-up to turn on. Without it, a request for bypass asks the Director as today. **A hire in `bypassPermissions` or in `auto` by rule must also get (RSO F2): egress ON at or above the sandbox floor (the Anthropic key stays out of the container), no global MCP servers, and no room keys except the ones marked for the Clean Room**, because such an agent calls every tool it holds without a check. |
| `sandboxFloor` | the boss's own and the room default | the hire's Clean Room, flavor and (when it exists) egress rules are at least those; never weaker |
| `folder` | the boss's folder or inside it (realpath) | as a Clean Room boss's rule today, for everyone |
| `ratePerHour` | 3 | counts hires, not live agents |
| `autoFireIdleMinutes` | **off** | if set (for example 60): a boss-hired agent with no task and no activity for that long is **stopped** (see 4) |
| `protected` | the boss and every agent the Director hired | a per-agent flag the Director can also set; protected agents are never fired by the boss or by a rule |

**Why `bypassPermissions` is special.** It runs every tool with no check. By rule, the only place that is defensible is inside a Clean Room, and even then it must be an explicit Director setting. Anything else the boss asks for in bypass **still goes to the Director as a request**; nothing is refused silently.

**What a rule hire may carry (RSO F3).** `keys` (Clearance), `payload`, a `payloadOff` that turns OFF a room default (a deny-type MCP server or skill), `permissions`, `remoteControl`, `command`, and any `cleanRoom` field weaker than the floor all mean **ASK, never auto**. This is the same list as the hire rule in `stepup.ts` (to be confirmed by the builder), **judged by one shared function**, so the two cannot drift. **The boss cannot reassign who the boss is**: the role move stays the Director's.

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
- **Tamper (H5):** the server keeps, **in memory, the record written by the last API change** and compares the file with that on every read and on a timer, as the login tamper alarm does; **never against a hash kept beside the file** (an agent that can rewrite the file could rewrite that too). A mismatch gives `autoApprove: off`, a Downlink alarm and the file renamed `.bad`.
- **Counters survive a restart:** the crew (`hiredBy`), the day's crew spend and the hour's hire times are stored with the agents and the ledger, so a restart is not a free reset (RSO).

## 6. Threats (for RSO)

| Id | Threat | Must hold |
|---|---|---|
| **H1** | A prompt-injected boss hires a crew to do harm. | Only the Director's presets (positions), the mode ceiling, the sandbox floor, a folder under the boss's, `maxCrew`, the daily crew budget; free text, custom commands and payloads always ask. |
| **H2** | Mode escalation chain. | Only the boss hires; boss-hired agents cannot call `hire_agent`; the ceiling is read from the stored setting, never from the request; `auto` only in a Clean Room (or with `autoOnHost`); `bypassPermissions` only with `bypassInCleanRoom`, a Clean Room hire, egress on, no global MCP, no non-Clean-Room keys (F2); a rule hire never carries keys, payload, `payloadOff`, permissions, remote control or a command (F3). |
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

**Tests.** **F1-F4:** `auto` by rule on the host is refused (asks) unless `autoOnHost` is on; in a Clean Room it is granted up to `maxMode`; a bypass or `auto` rule hire without egress on, or with a global MCP or a non-Clean-Room key, asks; each of `keys`, `payload`, `payloadOff`, `permissions`, `remoteControl`, `command` and a weak `cleanRoom` field in a request asks; the shared function is the one `stepup.ts` uses; editing `relief.json` by hand reverts to off, renames it `.bad` and raises the alarm, and a hash file beside it does not fool the check; a restart keeps the crew, the day's spend and the hire rate; the boss cannot reassign the boss role. Defaults leave today's behavior byte-identical; an in-rules hire staffs at once with `hiredBy`, an out-of-rules one becomes a pending request that names the rule; `auto` mode is granted only up to `maxMode` and never `bypassPermissions` without the Clean Room setting; a free-text role, a custom command, a payload, a folder outside the boss's all ask; a boss-hired agent cannot hire; settings need step-up and 404 for an agent token; rate and crew cap hold under parallel calls; fire stops (record, memory, session and worktree kept), releases its tasks, refuses the boss, a protected agent and one with a pending prompt; the Black Box row has no role text.

## 8. Open questions for the Director

1. Default `autoApprove: off` (one switch and a few limits to turn on) or on with the defaults above? I recommend off, since the first click is the one that changes who decides.
2. May the boss ever grant `bypassPermissions`? My proposal: only inside a Clean Room and only with its own switch.
3. Is the boss's fire **stop only** enough, with removal yours?

## 9. Addendum (Director, 2026-11-24, m4017): autoscale; only FLIGHT is fixed

By guido, for RSO. The Director's words: only FLIGHT is fixed; every other agent may appear and disappear by demand under rules, and FLIGHT stops and/or removes them as it sees fit. This changes three things above; the rest (§3 rules, F1-F4, step-up, tamper, audit) stands.

### 9.1 `protected` default is the boss only (changes §3 `protected`, §4 "Not allowed", H4)

`fire_agent` may stop **any** agent except: the boss, an agent the Director marked `protected`, one at a permission prompt or dialog, one with an open T-minus vote, one with mail waiting. The "hired by flight" check of PR2 goes away for a **manual** `fire_agent`. New room rule `mayStop` (default **on**, as the Director asked; turning it off needs no step-up). **Autoscale never touches an agent the Director hired** (9.3), only boss-hired ones: the rule-driven loop cannot reach the Director's agents, only FLIGHT's own judgement can.

H4 becomes: a prompt-injected boss can stop the Director's agents (no data is lost: record, memory, transcript, worktree stay, and the Director starts them again); the Director marks the ones that matter `protected`.

### 9.2 `fire_agent { name, reason, remove?: true }` (adds remove for the boss)

`remove: true` removes the agent. New room rule `mayRemove` (default **off**; turning it on needs the step-up). Guards, all server-side, from the stored record:

| Guard | Why |
|---|---|
| the agent is **already stopped** (fire it first; one call does stop then remove only when every other guard holds) | nothing running is removed |
| not the boss, not `protected`, nothing waits for the Director | as for stop |
| **no keys of its own** (`record.keys` empty) | Clearance values are secrets the Director typed: a removal would delete them for good; an agent with keys is refused and the answer says so |
| a **clean worktree**: a worktree or Clean Room agent is removed with `git worktree remove` **without `--force`** (git itself refuses a dirty folder); the branch stays | no uncommitted work is lost |
| `agents/<name>/` is **renamed** to `agents/<name>.removed-<unix ms>`, not deleted; its egress token and hook token are revoked | memory and transcripts are kept for the Director |
| its open tasks go back to `todo`, unassigned (as for stop) | |
| rate: the same few a minute as stop; the crew count drops, the hourly **hire** rate does not (H3) | fire then rehire does not reset the budget |

Downlink line (always) and a Black Box `crew` row with the name and counts only. The Director can still remove anyone by hand with his own click.

### 9.3 Autoscale (new PR5, rules in `relief.json`, off by default)

| Rule | Default | Meaning |
|---|---|---|
| `autoscale` | `off` | `off`, `dry-run` (only writes what it would do to the Downlink) or `on`; going to `on` needs the step-up and `autoApprove` on |
| `scaleUpTodo` | 3 | hire one agent of position P when at least this many **unassigned** `todo` tasks name P and no boss-hired agent of P is running |
| `idleStopMinutes` | off | stop a **boss-hired** agent with no open task assigned and no activity for this long (this is the old `autoFireIdleMinutes`) |
| `removeStoppedHours` | off | remove a **boss-hired** agent stopped for this long (needs `mayRemove`) |

How a task names a position (today a task has none): a new optional `position` on the Flight Plan task, set by the boss or the Director with `task_create` and `task_update` (validated against the roster positions, shown on the board). Unassigned tasks with no position never trigger a hire.

The loop runs on the server every 60 s, **one hire or one stop per tick**, and uses the **same code** as `hire_agent` by rule: the same shared judge (`hireStepUpReason`), the same `maxCrew`, `ratePerHour`, positions, engines, `maxMode`, folder (the boss's), Clean Room and sandbox floor, and the crew budget hold. A hire is named `<position>-<n>` (lowest free). A hire it makes counts like one FLIGHT made (`hiredBy: boss`). Scale-down never stops an agent within 10 minutes of its start (no hire/stop flapping), and uses the same exclusions as `fire_agent`. STOP CREW also sets `autoscale` to `off`. The tamper check covers the new fields. Dry run writes e.g. "autoscale (dry run): would hire guido-3 for 4 unassigned tasks" and does nothing else; the Director can leave it on for a week to see what it would do before `on`.

### 9.3b Changes required by RSO (m4041, all accepted)

- **R1 (A3, data loss on remove):** `git worktree remove` without `--force` still deletes IGNORED files (.env, databases, build output) and loses commits on a detached HEAD. So: only a worktree **gonogo created** is touched (never a shared project folder); it is **refused** unless `git status --porcelain --ignored` is empty **and** its HEAD is a branch or is an ancestor of one (`merge-base --is-ancestor`); otherwise the folder is **moved** next to the `.removed` folder (`git worktree move`), never deleted. A Clean Room's per-agent state (cleanroom-home) is renamed with it, not deleted. Default: **move, don't delete** (the Director cleans up by hand). **As built in PR4: the worktree and branch are left exactly where they are** (nothing is touched), only `agents/<name>/` is renamed.
- **R2 (A1, who sets `Task.position`):** only the boss or the Director, **checked by actor** in the tasks store; never taken from a docking handoff, an Uplink, Telegram or an auto-review job, and stripped when a task comes in from a station. Test: a non-boss agent's `task_create` or `task_update` with a `position` is refused; a handed-off task has none.
- **R3 (mode of an autoscale hire):** the position's default mode, or the room default, **capped by `maxMode`**; never `maxMode` itself; `auto` only under the same Clean Room / `autoOnHost` and F2 conditions as `hire_agent`. Autoscale re-checks `autoApprove` **every tick**: switched off, it stops at once even if `autoscale` says `on`.
- **R4 (name reuse):** never reuse a removed name: `<position>-<n>` skips every number that has an `agents/<name>.removed-*` folder, and a hire (any hire) refuses a name that matches the removed pattern. Names cannot hold a "." today, so the `.removed-<ms>` suffix cannot collide with a live name (a test pins that). Mail, votes, task assignments, the subagent limit, protected marks and per-agent settings therefore never carry over.
- **One action per tick of any kind** (a hire and a removal in the same tick are impossible); dry-run counts hires as zero spend and its Downlink lines are rate limited (one per position per hour); idle stop uses the hub's **busy** state (a long tool call is not idle), not only the last message time; the S1 startup line also names `mayRemove` ON and `autoscale` on; the tamper check covers `autoscale`, `mayRemove` and `mayStop`.
- **Removal keeps a record** (role, mode, permissions, payload; **no keys**) as JSON in `agents/<name>.removed-<ms>/`, so the Director can rebuild the agent; an agent with keys of its own is refused, not archived.
- **Reviewers (RSO a):** every boss stop is its own Downlink line naming who and why (not batched), and the Flight Rules block and the Edit form suggest marking the gating roles (a reviewer) protected: a hint, not a default.

### 9.4 New threats and tests (for RSO)

| Id | Threat | Must hold |
|---|---|---|
| **A1** | A boss writes tasks for a position to make the loop hire a crew. | Same caps as `hire_agent`: `maxCrew`, rate, budget, positions allow-list; one hire per tick; the Director sees every hire in the Downlink; STOP CREW. |
| **A2** | The loop (or the boss) stops or removes the Director's agents. | The loop touches only `hiredBy: boss`; the boss's own `fire_agent` skips `protected`, the boss, and anything waiting; `mayRemove` is off until the Director turns it on. |
| **A3** | Removal destroys secrets or work. | No keys of its own, clean worktree (no `--force`), folder renamed and kept. |
| **A4** | A flapping hire/stop loop burns spend. | One action per tick, 10 minutes of grace, hires counted by the hourly rate and the daily crew budget whatever is fired. |

Tests: a manual fire of a Director-hired agent works and a protected one is refused; `remove` refuses a running agent, one with keys, one with a dirty worktree (real git), and keeps `agents/<name>.removed-*`; `mayRemove` off refuses; dry-run changes nothing and writes the Downlink line; `on` hires once per tick up to `maxCrew`; scale-up never names a position outside `positions`; the loop never stops a Director-hired agent; a task's `position` is validated.

### 9.5 Phases now

PR3 (budget hold, which lifts the M2 guard, sandbox floor, models) -> PR4 (`remove` for the boss, `mayStop`/`mayRemove`, `protected` default, `bypassInCleanRoom`) -> PR5 (task `position`, autoscale loop with dry run, idle stop, stopped-removal, docs).
