# Relief: the boss asks for more hands

<ReliefMock class="doc-mock" />

FLIGHT calls `hire_agent`, which only makes a request: a saffron block in your console with every parameter. The agent is hired when you press **GO**, by the hire form's call. Design and limits: [`docs/relief-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/relief-spec.md).

## The request

| Field | Rule |
|---|---|
| `name` | Required. 1 to 32 lowercase letters, digits, hyphens; not `user` or `boss`; unused by any agent or waiting request |
| `position` | One of the 15 call signs; gives the role text |
| `role` | 1 to 4000 characters, no control, invisible or direction-changing character; replaces the position's text. Give `position`, `role` or both |
| `dir` | Existing absolute folder (hire form's check). Required, except for a Clean Room boss |
| `engine` | `claude` (default) or any engine except `custom` |
| `mode` | `default` (default), `acceptEdits` or `auto` (a request for `auto` always waits for your GO unless a rule below allows it); `bypassPermissions` refused |
| `worktree` | `true`: the new agent starts in its own git worktree and branch of the repository of `dir`, like the *Own git worktree* box of the hire form ([worktrees](./worktrees.md)). `false` or left out: its own folder. Only a real boolean. The folder must be in a git repository (checked when the request is made, so that you are not asked for a hire that cannot be made, and again at GO), and a Clean Room boss cannot ask for it: its agents have a worktree already. The block shows a *Worktree* row |

Any other field (`confirmBypass`, `command`, `payload`, `cleanRoom`) is refused. `worktree` does not widen what the agent may do: it only chooses where it works. An engine without gonogo permission modes (opencode, Kimi, pi, others) is hired in `default` and runs on its own rules; the block says it has none.

## What you see

**FLIGHT ASKS TO HIRE guido-1**: name, position, engine, mode, folder, minutes left, the whole role text in a scrolling box (length in the label). Keys **NO-GO**, **GO**. The Downlink gets a `RELIEF` line when asked and when answered or expired. FLIGHT hears each answer as a Director message: `Relief: guido-1 is staffed`, `request for guido-1 refused`, `request for guido-1 expired`, or `guido-1 could not be hired` with the reason.

## Limits

Enforced on the server.

- Only the boss may ask. Only you answer (browser token; an agent's token, the boss's included, gets 401).
- 3 requests wait at once; 5 in 10 minutes; a request expires after 30 minutes.
- Room holds 24 agents, checked at asking and at GO.
- A Clean Room boss hires Clean Room agents (Claude Code, same image) inside its own project folder (symlinks followed, rechecked at GO); leave `dir` out to use it.
- A GO the hire form would refuse (name taken, room full, folder gone, no Docker for a Clean Room) fails with the form's message: a red dock notice `GO on guido-1 failed: ...` until dismissed, and FLIGHT is told. The request is gone; FLIGHT must ask again.
- Requests live in memory: a restart drops them and FLIGHT is not told. A boss saved before Relief keeps its old role text (says it cannot hire) though its tool list has `hire_agent`.

## Hires by rule (automatic hires)

Off by default: every hire waits for your GO, byte for byte as above. You can turn on `autoApprove` in `<home>/relief.json` through `PUT /api/relief/rules` (a browser session with the password again; no agent route reads or writes it). A GO on a request in a mode that works without asking (`auto`) asks for the password again, as the hire form does. Then a request that fits **every** rule is staffed at once: the answer is `status: hired`, the agent carries `hiredBy: boss` (its tile shows *hired by flight*), and the Downlink and the Black Box say who, which name and the crew count, never the role text. A request that breaks a rule becomes the request above, and its note and card name the rule ("mode auto is above maxMode (acceptEdits)").

| Rule | Default | Meaning |
|---|---|---|
| `autoApprove` | off | the password again to turn on |
| `maxCrew` | 3 | boss-hired agents that exist now (running or stopped) |
| `ratePerHour` | 3 | hires in the last hour |
| `positions` | none | only these roster positions; a role the boss writes is always a request |
| `engines` | the room's default engine | never a custom command |
| `maxMode` | `acceptEdits` | `default`, `acceptEdits` or `auto`; `bypassPermissions` is not a choice (see `bypassInCleanRoom`) |
| `bypassInCleanRoom` | off | the only way a rule hire may run in `bypassPermissions`: it also needs a Clean Room hire with egress on and no global MCP server. In the Docker setup (`GONOGO_CLEANROOM_NETWORK=container:*`) a Clean Room shares gonogo's network and reaches every loopback service there (the managed Ollama, if you acknowledged it). A request for `bypassPermissions` without it waits for your GO, and the GO asks for the password. Turning it on asks for the password |
| `autoOnHost` | off | without it `auto` by rule runs in a Clean Room only; a Clean Room hire in `auto` also needs egress on and no global MCP server |
| `crewBudgetUsd` | none | optional: empty is no daily ceiling for the boss-hired crew (the room's budgets and Redline apply only if you set them: with none set, automatic hires are bounded by `maxCrew` and `ratePerHour` alone). Set, it is the dollars per **local day** for the whole boss-hired crew together (a stopped member still counts, so fire and rehire does not reset it). At the ceiling Propellant **holds the crew** (not the room, not your own agents) with a Downlink line, and no hire by rule is made: the request waits for your GO and says so. Any change of the rules except turning automatic approval or `autoOnHost` off asks for the password |
| `models` | none | per engine, the model names a rule hire may name; a hire with no model follows the default, one naming another model asks you. `hire_agent` takes a `model` for an engine that has one |

Always a request, never by rule: a folder outside the boss's own, a Clean Room wall below the room's, a Clean Room that holds its own API key, and anything with keys, a payload, permissions, remote control or a command (the request cannot carry them; the same function that asks you for the password on the hire form judges it). Boss-hired agents cannot hire. Every change of the rules asks for the password again, except turning automatic approval or `autoOnHost` off. **STOP CREW** (`POST /api/relief/stop-crew`, no step-up: it only removes power) stops every boss-hired agent and turns `autoApprove` off. A hand edit of `relief.json` turns `autoApprove` off, renames the file `relief.json.bad` and raises a Downlink alarm. Design: docs/hire-fire-spec.md in the repository.

## Firing: `fire_agent`

Only FLIGHT is fixed: the boss can stop **any** agent but itself with `fire_agent {name, reason}`, yours included, unless you protected it (Flight Rules: *FLIGHT may stop agents*, on by default; turning it back on needs the password). It **stops** only: the process ends, the record, memory, transcript and worktree stay, the agent is not marked as stopped by you (the boss, or you, can start it again), and its open tasks go back to *todo*, unassigned, with the history line `released: <name> was stopped by flight`. Refused: the boss, a **protected** agent (mark the consoles that gate your work, a reviewer for one), one at a permission prompt or dialog, one with an open T-minus vote to cast, one with mail waiting. A few a minute at most. Every stop is its own Downlink line, never batched: who was fired, how many tasks were released and the boss's reason; the Black Box row has the name and the count only. Removing an agent stays yours.

**Removing.** `fire_agent` with `remove: true` removes the agent, and only when you turned on *FLIGHT may also remove agents* (`mayRemove`, off by default; turning it on asks for the password). The same refusals as a stop apply, and also **an agent with keys of its own** (a removal would delete secrets: only you remove it). A running agent is stopped first. Its record leaves the roster; its folder in `agents/` is **renamed** to `agents/<name>.removed-<time>` with `removed-record.json` (role, mode, permissions, payload; never the keys) so you can hire it again; nothing is deleted, and its git worktree and branch are left where they are (you clean them up by hand). The boss does not hire that name again (a hire of it is refused for 24 hours after a rule hire, and always when an `agents/<name>.removed-*` folder exists); the boss's **hires, their hourly rate and the crew's dollars of the day are counted from `crew-ledger.json`** (the last 24 hours of rule hires, removed ones included), so removing and re-hiring does not reset the rate or the ceiling.

**Protected:** tick *Protect it from FLIGHT's fire_agent* in the Edit form of any agent but FLIGHT (no password); unticking asks for the password. *Flight Rules > Security > Hire on demand* has the rules, SAVE RULES and STOP CREW.

## Autoscale

Off by default; it needs automatic approval on and it acts only through the same rule hire (same positions, engines, mode ceiling, folder, crew size, hourly rate and budget). In *Flight Rules > Hire on demand*: **off**, **dry run** (it only writes to the Downlink what it would do, at most one line an hour per position or agent, and changes nothing) or **on** (the password again). A task can name a **position** (`task_create`/`task_update` `position`, and the Flight Plan): only the boss and you may set it; another agent's attempt is refused and a task that comes from a docked station loses it.

Every 60 seconds it does **at most one thing**, and reads the rules again first (turn automatic approval off and it stops at once):

1. **Scale up:** when at least *N* unassigned `todo` tasks name a position (`scaleUpTodo`, default 3) and no boss-hired agent of that position is running, hire one `<position>-<n>` (the lowest number never used by a live agent, a waiting request or a removed agent). Its mode is the room's default mode, never above `maxMode`. A rule that says no leaves a line, not a request.
2. **Scale down:** a boss-hired agent that has been idle (the console's own state: a long build is working, not idle) with no open task for `idleStopMinutes` is stopped, never within 10 minutes of its hire, never a protected one.
3. **Remove:** a boss-hired agent stopped for `removeStoppedHours` is removed (needs *FLIGHT may also remove agents*).

Autoscale never touches an agent you hired. STOP CREW turns it off.

## API

`GET /api/relief` -> `{ "requests": [...], "rules": {...}, "crew": [...] }` (also in state and a `relief` frame). `PUT /api/relief/rules` takes the rules that change (a bad one is 400 with the field `rules.<name>`). `POST /api/relief/:id/go` and `/no-go` take nothing, answer the list; gone id is 404.
