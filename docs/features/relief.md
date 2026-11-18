# Relief: the boss asks for more hands

<ReliefMock class="doc-mock" />

FLIGHT can call `hire_agent`. It only makes a request: a saffron block in your console with every parameter. The agent is hired when you press **GO**, by the same call as the hire form. Design and limits: [`docs/relief-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/relief-spec.md).

## The request

| Field | Rule |
|---|---|
| `name` | Required. 1 to 32 lowercase letters, digits or hyphens; not `user` or `boss`; no agent or waiting request has it. |
| `position` | One of the 15 call signs. Gives the role text. |
| `role` | 1 to 4000 characters, with no control, invisible or direction-changing character (you could not read it). Replaces the position's text. Give `position`, `role` or both. |
| `dir` | An absolute folder that exists (the hire form's check). Required, except for a Clean Room boss. |
| `engine` | `claude` (default) or any other engine except `custom`. |
| `mode` | `default` (default) or `acceptEdits`. `auto` and `bypassPermissions` are refused. |

Any other field (`confirmBypass`, `command`, `payload`, `cleanRoom`) is refused. An engine without permission modes in gonogo (opencode, Kimi, pi and the others) is hired in `default` and runs on its own rules; the block says it has none, not that it asks.

## What you see

**FLIGHT ASKS TO HIRE guido-1**: name, position, engine, mode, folder, minutes left, and the whole role text in a box that scrolls, with its length in the label. Keys: **NO-GO**, **GO**. The Downlink gets a `RELIEF` line when it is asked and when it is answered or expires, and the live region says how many wait.

FLIGHT hears every answer as a message from the Director: `Relief: guido-1 is staffed`, `request for guido-1 refused`, `request for guido-1 expired`, or `guido-1 could not be hired` with the reason.

## Limits

Enforced on the server, not by the tool's text.

- Only the boss may ask.
- 3 requests wait at once. 5 requests in 10 minutes. A request expires after 30 minutes.
- The room holds 24 agents: checked when it is asked and again at your GO.
- Only you answer: the routes take the browser token, so an agent's token (the boss's included) gets 401.
- A Clean Room boss hires Clean Room agents (Claude Code, same image) inside its own project folder, symbolic links followed, checked again at your GO. It leaves `dir` out to use that folder.
- A GO that the hire form would refuse (name taken meanwhile, room full, folder gone, no Docker for a Clean Room) fails with the form's message, and FLIGHT is told.

Requests live in memory: a restart drops them and FLIGHT is not told. A boss saved before Relief keeps its old role text, which says it cannot hire; its tool list still has `hire_agent`.

## API

`GET /api/relief` answers `{ "requests": [...] }`, also in the state and in a `relief` frame. `POST /api/relief/:id/go` and `/no-go` take nothing and answer the list. A gone id is 404.

No option.
