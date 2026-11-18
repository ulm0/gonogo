# Docking: two stations

<DockingMock class="doc-mock" />

DOCKING (a module under RELAY in the Launch Window view) connects this gonogo to another one, so that their agents can message each
other and a task can be handed to the other board. Each side is a station with a name (`GONOGO_STATION`) and a random id kept in
`station.json`. Design and limits: [`docs/docking-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/docking-spec.md). **Only tried between two servers on one machine** (see [What was not verified](../reference/not-verified.md)).

- **Dock.** Both Directors need an address the other machine can reach: a public name behind HTTPS (see [Reverse proxy](../reference/security.md#reverse-proxy)) or a private
  network such as Tailscale. Each name has to be allowed on its own station (`--allow-host`). On one station press MAKE A CODE, type
  the address of that station, and give the code to the other Director (it is shown once, works once, for 15 minutes). The other
  Director presses PAIR, pastes the code and types the address of his own station. Both rows then show the other station. The code
  and the proofs that follow never carry the secret: both sides work it out, and it is stored in `docking.json`.
- **The room of the other station.** Each row shows the last answer (every 30 seconds, and the first time right away), and an
  AGENTS fold with `name@station`, the state and the role of each agent there. A station that stops answering shows NO ANSWER with the
  reason and keeps what was last seen.
- **Messages.** An agent writes to `name@station` (`name` is an agent name or `boss`) with `send_message`; `list_roster` lists the
  docked agents under `docked`. The message is `queued` ("sending to lab") and then `delivered` ("accepted by lab: queued") or
  `undelivered` with the reason. On the other side it is a message from `ana@lab` with the hops it had, so that station's hop limit,
  held mail and Max Q apply, and its Redline sees the replies. A reply goes to `ana@lab` the same way. `inReplyTo` does not cross. A
  station cannot write to your Director (`user`), and you cannot write to another station from the Brief box: ask an agent.
- **Hand off a task.** A card of the Flight Plan has HAND OFF when a station is docked: pick one of its agents (or nobody yet). The
  task is copied to the other board, with the line `Handed off from lab (its task t4).` first in its detail, and assigned there
  (the agent gets the usual assignment message, from `director@lab`). Here it is DONE with the chip `HANDED OFF · lab`.
- **Undock.** UNDOCK tells the other station (3 seconds) and removes the dock here either way. When the other side could not be
  reached the page says so; undock it there too. Dock again with a new code.
- **The wire.** `/dock/*` is outside `/api` and the browser token. A call carries `X-Gonogo-Station` (the sender's id),
  `X-Gonogo-Timestamp` (ms epoch), `X-Gonogo-Nonce` (random hex) and `X-Gonogo-Signature`: the HMAC-SHA256, keyed with the 32 bytes
  of the secret, over `STATION\nMETHOD\nPATH\nTIMESTAMP\nNONCE\n` and the body (STATION is the sender's id, so a call cannot be sent
  back to the station that made it). A timestamp more than 5 minutes from the clock of the receiver,
  a nonce it has seen, a wrong signature and a station that is not docked are 401; more than 60 calls a minute from one dock is
  429. The Host check applies as for every route, and a request with an `Origin` is refused. The routes: `POST /dock/pair`,
  `GET /dock/roster`, `POST /dock/message`, `POST /dock/task` and `POST /dock/undock`. A proxy has to pass the path and the body
  unchanged, and the two clocks have to agree to 5 minutes.
- **API** (browser token). `GET /api/docking` answers `{ "station": "alpha", "docks": [{ "id", "name", "url", "since", "status",
  "seenAt", "error", "agents": [{ "name", "role", "state", "boss" }] }] }`, with no secret. `POST /api/docking/code` takes
  `{"url": "https://alpha.example.com"}` and answers `{ "code", "expiresAt" }`; `POST /api/docking/pair` takes
  `{"code": "...", "url": "..."}` and answers the dock; `DELETE /api/docking/<id>` answers `{ "told": true }`; `POST
  /api/docking/<id>/handoff` takes `{"task": "t4", "assignee": "bob"}` and answers the task. A `docking` frame carries the whole view and
  it is in the state.
