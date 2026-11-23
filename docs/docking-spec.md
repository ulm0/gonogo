# Spec: Docking

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): two installations connect so
that their agents can message each other and hand off work, the equivalent of Munder Difflin's Team Network.

## Intent

Two people each run their own gonogo. They dock the two. From then on an agent of one writes to an agent of the other with
`name@station`, each Director sees who is in the other room, and a task of the Flight Plan can be handed to the other board.
Nothing else changes: each side keeps its own agents, accounts, files and Director. There is no shared state, no account and no
server in the middle.

## Design

- **A station** has a name and an id. The name is `GONOGO_STATION`, else the first label of the host name, cut to the shape of
  an agent name (lower case, digits and `-`, at most 31 characters, `station` when nothing is left). The id is 16 random bytes in
  hex, made once and kept in `~/.gonogo/station.json` (`{ "version": 1, "id": "..." }`, mode 0600). The name is what people
  type (`ana@lab`), the id is what a dock is keyed by, so a station that renames itself stays docked.
- **A dock** is `{ id, name, url, secret, since }`: the other station's id, name and address (an origin, no path) and the shared
  secret (32 bytes, 64 hex characters). They are in `~/.gonogo/docking.json` (`{ "version": 1, "docks": [...] }`, mode 0600,
  written whole through a temporary file and a rename). Browsers get `DockView`, which has no secret and adds what the last
  pull saw: `status` (`new`, `ok`, `down`), `seenAt`, `error` and `agents`. At most 8 docks.
- **Pairing.** The Director of A types the address of A as the other side will reach it and gets a docking code
  (`gonogo-dock:` and base64url of `{ u: address, t: token }`). The token is 32 random bytes, valid 15 minutes, good for one
  pairing, at most 5 codes waiting (the oldest is dropped). The Director of B pastes the code and gives the address of B. B
  calls `POST <A>/dock/pair` with its id, name, address, a nonce and a proof, the HMAC-SHA256 keyed with the token over
  `pair`, the nonce, id, name and address. A checks the proof against every waiting token, checks the rest (not itself, not docked
  already, no name clash, room left), spends the token, makes a nonce of its own and answers with its id, name, nonce and an
  `ack`, the same kind of proof. B checks the ack. Both then compute the secret as the HMAC keyed with the token over
  `secret`, A's nonce, B's nonce, A's id and B's id. **The token and the secret never cross the wire**: a listener on the line
  sees proofs, and only whoever holds the token can make or check them. (The brief said B calls with the token; a proof of
  holding it is the same step and leaks nothing.) A failed proof does not spend the token. When B refuses after A accepted
  (B still lists A, or knows another station by A's name), B calls `/dock/undock` with the new secret, so A does not keep a
  dock that B never made. A does not pull at once (B has not saved the dock before it reads A's answer); B pulls right after it saves, and a
  call from a dock that is not `ok` makes the receiver pull it. `/dock/pair` takes 60 calls a minute
  in all.
- **Signed calls.** Every later call is made by the station that holds the secret, to `/dock/<route>`, outside `/api` and the
  browser token. Headers: `X-Gonogo-Station` (the sender's id), `X-Gonogo-Timestamp` (ms epoch), `X-Gonogo-Nonce` (16 or more
  random bytes in hex) and `X-Gonogo-Signature` (hex). The signature is HMAC-SHA256, keyed with the 32 bytes of the secret,
  over `STATION\nMETHOD\nPATH\nTIMESTAMP\nNONCE\n` and then the body, as sent. STATION is the sender's id: both sides hold
  the same secret, so without it a call of A's could be sent back to A as one from B. PATH is the request target as it arrived, so a proxy
  must pass it unchanged. The receiver checks in this order: the headers have the right shape and the station is docked; the
  signature (constant time); the timestamp is at most 5 minutes from its clock, either way; the nonce was not seen before (a
  nonce is remembered until its timestamp is too old to be accepted anyway); at most 60 calls a minute from that dock. A call
  that fails any of them is `401 unauthorized` with the reason (`429` with `Retry-After: 60` for the rate); the same 401 text
  covers an unknown station and a wrong signature, so neither is told apart. Only a call that passed the signature counts
  against the limit and the nonces, so a stranger cannot use up the limit of the real station.
- **Routes** (`DOCK_ROUTES` in `docking.ts`, one method each, 405 with `Allow` otherwise, 404 for any other path, 413 past 256
  KiB, 503 until the server is ready): `POST /dock/pair`, `GET /dock/roster`, `POST /dock/message`, `POST /dock/task`,
  `POST /dock/undock`.
- **The roster.** `GET /dock/roster` answers `{ station: { id, name }, agents: [{ name, role, state, boss }] }`, the role cut to
  300 characters. Each station pulls the roster of each dock once when the server is ready and every 30 seconds; after a pairing
  B pulls at once and A when B's pull reaches it. The answer is read defensively (agent names that are not names are dropped, at most 24 agents, an
  unknown state is `stopped`), the id in it must be the id of the dock, and a new name is taken when it is a valid name that no
  other dock or this station uses. A failed pull is `status: down` with the reason and keeps the agents last seen on the page; the
  agents of a dock that is `down` are left out of `list_roster`.
- **Messages.** `send_message` takes `name@station` (`name` is an agent name or `boss`) from an agent. The hub checks it (a
  docked station, a name that can be an agent), applies the sender's send limit and the hop limit, counts it for Redline's
  ping-pong like any message to one recipient, makes a record `from: ana, to: bob@lab` with the status `queued` and the note
  `sending to lab`, and hands it to Docking, which sends it with the hops it has. The record becomes `delivered`
  (`accepted by lab: queued, <note of its hub>`) when the other station took it, or `undelivered` with the reason (`lab refused:
  unknown recipient "bob". Known: ...`, `could not reach lab: ECONNREFUSED`, `lab did not deliver it: undelivered, bob is
  stopped; ...`). The other hub makes a record `from: ana@lab, to: bob` through `Hub.sendFromStation`, with the same hops, and
  routes it as any message: its hop limit, held mail, Max Q, mailbox limits all apply. Bob reads `from: ana@lab`, and replies
  with `to: ana@lab`, which goes back the same way with hops that continue. A message that crossed is not read here by anyone,
  so a `delivered` record to a station stays `delivered`; the hub's restart sweep and its memory trim treat it as finished.
  A record still `queued` when the server stopped is `undelivered` at the next start, as any waiting message.
- **What a station may not do.** It cannot write to `user`, to a name with an `@` (a message is not passed on to a third
  station), or from a name that is not an agent name. The Director cannot write to another station from the Brief box or the
  API (`only an agent writes to another station: ask one to`).
- **`list_roster`** gains `docked: [{ station, agents }]` for the docks that answer. The role preamble and the tool
  descriptions say how to address a docked agent and that the other station is not the owner.
- **Hand off a task.** `POST /api/docking/<id>/handoff { task, assignee? }`: the Director picks one of the docked station's
  agents (or nobody) on a card of the Flight Plan. Docking sends `POST /dock/task` with the id, title, detail and assignee. The
  other station makes the task through its own Flight Plan (so its limits and checks apply, and an assignee that is not an agent
  there is a 400 whose field and text come back), with the detail starting `Handed off from lab (its task t4).`, the history line
  `Director of lab: created; assigned to bob` and an assignment message to the agent from `director@lab`. Only when that
  succeeded, the task here is set `done` with `handedOff: "lab"` and the history line `handed off to bob@lab`. A task that is
  done or was handed off cannot be handed off; the check is here and again by the Flight Plan.
- **Undock.** `DELETE /api/docking/<id>` calls `POST /dock/undock` on the other side (3 seconds), then removes the dock here
  whatever happened. The other side removes its dock on a call it can verify. `told` in the answer says whether it was
  reached. A station that was not told keeps a dock that every call to is refused with 401, and shows it `down`; its Director
  undocks it by hand. To dock again, make a new code (the secret is new).
- **REST** (browser token): `GET /api/docking` (`{ station, docks }`), `POST /api/docking/code { url }` (201 `{ code,
  expiresAt }`), `POST /api/docking/pair { code, url }` (201 with the `DockView`), `DELETE /api/docking/<id>` (200 `{ told }`)
  and `POST /api/docking/<id>/handoff` (200 with the task). A bad field is 400 with its name. What the other station refuses with
  is passed on with its own words, and its 401, 403 and 404 are 409 here (the browser reads a 401 as a lost key). A station that
  cannot be reached is 503 `could not reach lab: <cause>`.
- **Frame and snapshot.** A `docking` frame carries the whole view (`{ station, docks }`) after every change a browser would
  show: a dock made or removed, a pull that changed the status, the time of the answer or the agents. It is also
  `StateSnapshot.docking`, absent from a server without Docking.
- **Host and Origin.** `/dock/*` is a route kind of its own beside `uplink`. The Host check is the one every route has: the
  name has to be loopback, the bind address or on the allow-list (`--allow-host`), so the public name of a station goes there.
  An `Origin` header is refused with 403 (a station is a server, a web page has no reason to post here), and the Clean Room
  name `host.docker.internal` still reaches only hooks and tools.
- **The screen.** A DOCKING module in the Launch Window view, under RELAY (`DockingPanel.tsx`, `docking.ts`, `docking.css`):
  this station's name and the trust warning, MAKE A CODE and PAIR, and a row for each dock with its status chip (the word says it,
  not only the colour), the time of the last answer, an Agents fold (`name@station`, state, role) and Undock with an inline
  question. The code is on screen once, selected, with Copy code. The address field starts as the address of the page and
  says so when that works only on this computer. On a card of the Flight Plan, Hand off opens a small form (station when more
  than one, agent) and a handed-off card has the chip `HANDED OFF · lab` and sits in DONE.

## Decisions

- **A module of Launch Window, not a view of its own and not a top bar key.** The brief says "DOCKING view". The top bar is full
  (a seventh key and the round Livery key already fill 1280 px), the phone bar has seven keys at 390 px, and Uplink and Relay
  were put in Launch Window for the same reason: all three are ways for work to arrive that the Director did not type. The module has its own
  name and files, so it can be lifted into a view later.
- **B gives its own address when it pairs.** The brief had B paste a code only. A must call B back (messages, the roster), so it
  needs B's address, and only the Director of B knows it. The field starts with the address of the page.
- **A proof instead of the token on the wire** (see Pairing).
- **`inReplyTo` does not cross.** An id is the id of one station's log; at the other it would name another message. A reply is
  routed by `to: name@station`, and the subject says what it is about.
- **The Director's task handoff sends no message of its own.** The assignment is the one that Flight Plan always sends, as
  `director@lab`, so the agent sees where it came from and cannot answer it as if it were its own Director (`to: user` and a name
  with an `@` are refused from a station).
- **A dock is keyed by the other station's id; the name is the address.** Two docks cannot have one name, and a station cannot
  take the name of this one, so `name@station` is unambiguous. Two stations with the same name must change one (`GONOGO_STATION`).
- **A station never writes to the Director.** A docked agent can reach agents (that is the trust the Director gave) but not the
  Director's inbox or Relay. Agents can write to their own Director as before.
- **No new MCP tool.** `send_message` and `list_roster` carry it, so the allowed list and `mcp.json` did not change.
- **A dock that is down is not dropped.** The page keeps the last agents, dimmed, so that a restart of the other side is a gap
  and not a loss.

## Rejected

- A relay server, discovery, or more than a pair at a time (there is no group; each pair is its own dock).
- Sharing the Mission Log, the Flight Plan or Propellant across stations: a task is copied, never shared.
- Encrypting the body: use HTTPS, which the proxy recipe gives. The signature stops tampering and replay, not reading.
- A configurable rate limit, timeout or window.
- A queue for a message to a station that is down: the record says `undelivered` at once, as for a stopped agent.

## Known limits

- shortcut: the secret is stored in plain text in a 0600 file. Encrypt it if the home folder is ever shared.
- shortcut: the answer of another station is read whole before it is looked at. Cap it if a station you do not trust is docked.
- shortcut: an address is an origin; a station behind a path prefix cannot be docked.
- shortcut: codes and nonces are in memory. A restart makes a waiting code useless, and forgets the nonces of the last 5 minutes.
- Without HTTPS the messages and the roster cross as plain text, signed. Dock over HTTPS or a private network (Tailscale).
- **Dock only with people you trust.** Their agents can write to yours, and a message from `name@station` is text that your agent
  reads and may act on, with the permissions you gave it. The preamble tells agents to share only what the task needs, which a
  prompt cannot enforce. A paired station can also make tasks on your board (assigned to your agents) and see the names, roles
  and states of your agents.
- A code that someone else pastes first pairs with them. Give it to the person on the other side, and undock if it was used by
  someone else (the Director sees the new dock at once).
- The Director of B pastes a code with an address in it, and B's server posts to that address (`/dock/pair`, a small JSON body
  of proofs). A code from someone you do not trust can point your server at any address. The path is fixed and nothing secret is
  sent, but this is a request from your machine.
- `/dock/pair` takes no proof before its rate limit (60 calls a minute in all), so a stranger who can reach it can use that up and delay a pairing by a minute. Put a rate limit on the reverse proxy if the station is on the internet.
- A task handoff that the other station accepted and whose answer was lost is made again if the Director tries again. Two
  hand-offs of one task at the same time are not: the second is refused while the first is on its way.
- Text that another station sends back (an error, the status of a message) is cut to 300 characters before it lands in a note.
- The clocks of the two stations must agree to 5 minutes. A station whose clock is off is refused with a message that says so.
- A station that is behind a proxy that rewrites the path or the body (compression, a path prefix) fails the signature.
- The rate limit and the nonces are in memory: a restart gives every dock its 60 calls back.
- Tested with two copies of the module wired together through a fake `fetch` (the signatures, the pairing, replay, expiry, the rate
  limit, the roster, messages both ways, undock, handoff), the routes with a fake module (Host, Origin, methods, 413, status
  codes), the hub with a fake link, and two real servers with the stand-in agent on loopback (scenario 30 of `e2e.test.ts`: pair,
  a message each way with the hops, a task handed off, refused calls by hand, undock). The page was opened in Chrome (a 500 px
  window) against two real servers: the module, Pair, a hand-off that moved the card to DONE with its chip. Never run between two
  machines, behind a real reverse proxy or over HTTPS, with a real `claude` reading a message from another station, in Firefox or
  Safari, with a screen reader, or with the Copy keys (the field is selected so that copying by hand works).

User page, from Docking 2 on: [docs/features/docking.md](features/docking.md): what a link is, what the other station can and cannot do, what leaves and every per-dock rule. The design is in [docking-collab-spec.md](docking-collab-spec.md).
