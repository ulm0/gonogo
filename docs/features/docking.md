# Docking: two stations

<DockingMock class="doc-mock" />

DOCKING (under RELAY in the Launch Window view) links two gonogo servers: agents message across and tasks hand off. Each is a station with a name (`GONOGO_STATION`) and a random id in `station.json`. Design and limits: [`docs/docking-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/docking-spec.md). **Only tried between two servers on one machine** (see [What was not verified](../reference/not-verified.md)).

## Dock

1. Each station needs an address the other can reach: HTTPS public name ([Reverse proxy](../reference/security.md#reverse-proxy)) or a private network such as Tailscale, allowed on its own station with `--allow-host`.
2. On A: MAKE A CODE, enter A's address, send the code to B's Director (shown once, single use, 15 minutes).
3. On B: PAIR, paste the code, enter B's address.

The secret never travels; both sides derive it into `docking.json`.

Each dock row polls every 30 seconds and has an AGENTS fold (`name@station`, state, role). An unreachable station shows NO ANSWER with the reason and keeps the last view.

## Messages

- Agents write to `name@station` (`name` is an agent or `boss`) with `send_message`. `list_roster` lists docked agents under `docked`.
- Status: `queued` ("sending to lab"), then `delivered` ("accepted by lab: queued") or `undelivered` with the reason.
- The receiver gets it from `ana@lab` with its hops; its hop limit, held mail, Max Q and Redline apply. Replies go back the same way. `inReplyTo` does not cross.
- A station cannot write to your Director (`user`), and the Brief box cannot write to another station: ask an agent.

## Hand off a task

Flight Plan cards get HAND OFF: pick a remote agent (or nobody). The task is copied there with `Handed off from lab (its task t4).` first in its detail and assigned (usual message, from `director@lab`). Here it becomes DONE with chip `HANDED OFF · lab`.

## Undock

UNDOCK tells the other station (3 seconds) and removes the dock here regardless. If unreachable, the page says so: undock there too. Re-docking needs a new code.

## The wire

`/dock/*` is outside `/api` and the browser token. Each call carries:

- `X-Gonogo-Station`: sender's id
- `X-Gonogo-Timestamp`: ms epoch
- `X-Gonogo-Nonce`: random hex
- `X-Gonogo-Signature`: HMAC-SHA256, keyed with the 32-byte secret, over `STATION\nMETHOD\nPATH\nTIMESTAMP\nNONCE\n` and the body (STATION is the sender's id, so a call cannot be sent back to its maker)

- 401: timestamp more than 5 minutes off, seen nonce, wrong signature, or undocked station. 429: more than 60 calls a minute from one dock.
- Host check applies; requests with an `Origin` are refused.
- Routes: `POST /dock/pair`, `GET /dock/roster`, `POST /dock/message`, `POST /dock/task`, `POST /dock/undock`.
- Proxies must pass path and body unchanged; clocks must agree within 5 minutes.

## API

Browser token required.

- `GET /api/docking` answers `{ "station": "alpha", "docks": [{ "id", "name", "url", "since", "status", "seenAt", "error", "agents": [{ "name", "role", "state", "boss" }] }] }`, without the secret.
- `POST /api/docking/code` takes `{"url": "https://alpha.example.com"}`, answers `{ "code", "expiresAt" }`.
- `POST /api/docking/pair` takes `{"code": "...", "url": "..."}`, answers the dock.
- `DELETE /api/docking/<id>` answers `{ "told": true }`.
- `POST /api/docking/<id>/handoff` takes `{"task": "t4", "assignee": "bob"}`, answers the task.

A `docking` frame carries the whole view, which is also in the state.
