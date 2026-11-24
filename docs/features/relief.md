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

Off by default: every hire waits for your GO, byte for byte as above. You can turn on `autoApprove` in `<home>/relief.json` through `PUT /api/relief/rules` (a browser session with the password again; no agent route reads or writes it). **Turning it on is refused in this version** ("the crew budget is not enforced yet"): the dollar ceiling arrives with the next step, and until then every hire waits for your GO. A GO on a request in a mode that works without asking (`auto`) asks for the password again, as the hire form does. Then a request that fits **every** rule is staffed at once: the answer is `status: hired`, the agent carries `hiredBy: boss` (its tile shows *hired by flight*), and the Downlink and the Black Box say who, which name and the crew count, never the role text. A request that breaks a rule becomes the request above, and its note and card name the rule ("mode auto is above maxMode (acceptEdits)").

| Rule | Default | Meaning |
|---|---|---|
| `autoApprove` | off | needs `crewBudgetUsd` |
| `maxCrew` | 3 | boss-hired agents that exist now (running or stopped) |
| `ratePerHour` | 3 | hires in the last hour |
| `positions` | none | only these roster positions; a role the boss writes is always a request |
| `engines` | the room's default engine | never a custom command |
| `maxMode` | `acceptEdits` | `default`, `acceptEdits` or `auto`; `bypassPermissions` is not a choice |
| `autoOnHost` | off | without it `auto` by rule runs in a Clean Room only; a Clean Room hire in `auto` also needs egress on and no global MCP server |
| `crewBudgetUsd` | none | dollars per day for the crew (stored now; enforced in a later step) |

Always a request, never by rule: a folder outside the boss's own, a Clean Room wall below the room's, a Clean Room that holds its own API key, and anything with keys, a payload, permissions, remote control or a command (the request cannot carry them; the same function that asks you for the password on the hire form judges it). Boss-hired agents cannot hire. Raising a rule needs the step-up; lowering never does. **STOP CREW** (`POST /api/relief/stop-crew`, no step-up: it only removes power) stops every boss-hired agent and turns `autoApprove` off. A hand edit of `relief.json` turns `autoApprove` off, renames the file `relief.json.bad` and raises a Downlink alarm. Design: docs/hire-fire-spec.md in the repository.

## API

`GET /api/relief` -> `{ "requests": [...], "rules": {...}, "crew": [...] }` (also in state and a `relief` frame). `PUT /api/relief/rules` takes the rules that change (a bad one is 400 with the field `rules.<name>`). `POST /api/relief/:id/go` and `/no-go` take nothing, answer the list; gone id is 404.
