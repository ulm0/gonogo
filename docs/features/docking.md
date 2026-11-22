# Docking: two stations

<DockingMock class="doc-mock" />

DOCKING (under RELAY in the Launch Window view) links two gonogo servers so agents message across and tasks hand off. Each is a station with a name (`GONOGO_STATION`) and a random id in `station.json`. Design: [`docs/docking-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/docking-spec.md). **Only tried between two servers on one machine** ([What was not verified](../reference/not-verified.md)).

## Dock

1. Each station needs an address the other can reach: an HTTPS public name ([Reverse proxy](../reference/security.md#reverse-proxy)) or a private network such as Tailscale, allowed with `--allow-host`.
2. On A: MAKE A CODE, enter A's address, send the code to B's Director (shown once, single use, 15 minutes).
3. On B: PAIR, paste the code, enter B's address.

**The code is read as people carry it:** with or without its first words (`gonogo-dock:`), with spaces, line breaks, quotes or a full stop around it. One that is cut short says so ("its token has 37 of 64 characters"): copy it again whole.

**Addresses:** each address must be one the other computer can reach. When a page is opened as `localhost` the Address box starts with a network address of that computer (an IPv4 of its interfaces, with the page's port) and says when the address works only on this computer; the code made with such an address carries a warning. A station reached by an address it was not started for answers `forbidden host`; docking then says to start it with `--allow-host <address>` (or `GONOGO_ALLOWED_HOSTS`; `--allow-host <address>:hooks` opens only docking and webhooks to that name).

The secret never travels; both sides derive it into `docking.json`. Each dock row polls every 30 seconds and has an AGENTS fold (`name@station`, state, role). An unreachable station shows NO ANSWER with the reason and keeps the last view.

## Use

- **Messages:** agents write `name@station` (`name` is an agent or `boss`) with `send_message`; `list_roster` shows docked agents under `docked`. Status: `queued` ("sending to lab"), then `delivered` ("accepted by lab: queued") or `undelivered` with the reason. The receiver sees it from `ana@lab` with its hops; hop limit, held mail, Max Q and Redline apply. Replies go back the same way; `inReplyTo` does not cross.
- A station cannot write to your Director (`user`), and the Brief box cannot write to another station: ask an agent.
- **Hand off a task:** Flight Plan card -> HAND OFF, pick a remote agent (or nobody). The task is copied there with `Handed off from lab (its task t4).` first in its detail and assigned (usual message, from `director@lab`). Here it becomes DONE with chip `HANDED OFF · lab`.
- **Undock:** UNDOCK tells the other station (3 seconds) and removes the dock here regardless. If unreachable, the page says so: undock there too. Re-docking needs a new code.

## The wire

`/dock/*` is outside `/api` and the browser token. Each call carries `X-Gonogo-Station` (sender's id), `X-Gonogo-Timestamp` (ms epoch), `X-Gonogo-Nonce` (random hex) and `X-Gonogo-Signature`: HMAC-SHA256 keyed with the 32-byte secret over `STATION\nMETHOD\nPATH\nTIMESTAMP\nNONCE\n` and the body.

- 401: timestamp more than 5 minutes off, seen nonce, wrong signature, or undocked station. 429: more than 60 calls a minute from one dock.
- Host check applies; requests with an `Origin` are refused.
- Routes: `POST /dock/pair`, `GET /dock/roster`, `POST /dock/message`, `POST /dock/task`, `POST /dock/undock`.
- Proxies must pass path and body unchanged; clocks must agree within 5 minutes.

## API (browser token required)

| Call | Body, answer |
|---|---|
| `GET /api/docking` | `{ "station": "alpha", "docks": [{ "id", "name", "url", "since", "status", "seenAt", "error", "agents": [{ "name", "role", "state", "boss" }] }] }`, no secret |
| `POST /api/docking/code` | `{"url": "https://alpha.example.com"}` -> `{ "code", "expiresAt" }` |
| `POST /api/docking/pair` | `{"code": "...", "url": "..."}` -> the dock |
| `DELETE /api/docking/<id>` | `{ "told": true }` |
| `POST /api/docking/<id>/handoff` | `{"task": "t4", "assignee": "bob"}` -> the task |

A `docking` frame carries the whole view, also in the state.
