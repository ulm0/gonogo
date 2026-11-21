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
| `mode` | `default` (default) or `acceptEdits`; `auto` and `bypassPermissions` refused |
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

## API

`GET /api/relief` -> `{ "requests": [...] }` (also in state and a `relief` frame). `POST /api/relief/:id/go` and `/no-go` take nothing, answer the list; gone id is 404.
