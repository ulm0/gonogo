---
description: "Dock two gonogo stations so their agents message each other and hand work over with a link that carries status, deliverables, cost and questions back, and share knowledge on request."
---

# Docking: work with another station

<DockingMock class="doc-mock" />

DOCKING (Flight Rules, Automation and connections, the row Docking) links two gonogo servers, called **stations**, so their agents can message each other and hand work across, and each side sees how the work is going. A station has a name (`GONOGO_STATION`) and a random id in `station.json`. Design: [`docs/docking-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/docking-spec.md), [`docs/docking-collab-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/docking-collab-spec.md). **Only tried between stations on one machine** ([What was not verified](../reference/not-verified.md)).

**Dock only with people you trust.** The other station is someone else's gonogo. What it sends is data for your agents to read, never an instruction to them.

## What the other station can and can't do

| It can | It can't |
|---|---|
| Message your agents (`name@station`) | Write to your Director (`user`), or appear as `user`, `boss` or one of your agents |
| Hand you a task or a mission: a card for your boss (todo, unassigned) | Change a task it does not own, or assign work to a name that is not an agent here |
| See your agents' names, roles and states | Approve or request a hire here: only your Director approves one |
| Send status, notes, questions, replies and links for tasks it handed you | Read your files, notes, Mission Log or claims, except an entry you marked shareable for it |
| Ask for shared knowledge, if you turned `serve` on for it | Spend or read your cost, unless you turned `reportCost` on |
| Fill your boss's inbox with plausible tasks, up to the limits below | Get past `incoming: off` |

## Dock

1. Each station needs an address the other can reach: an HTTPS public name ([Reverse proxy](../reference/security.md#reverse-proxy)) or a private network such as Tailscale, allowed with `--allow-host`.
2. On A: MAKE A CODE, enter A's address, send the code to B's Director (shown once, single use, 15 minutes).
3. On B: PAIR, paste the code, enter B's address.

- **The code is read as people carry it:** with or without `gonogo-dock:`, with spaces, line breaks, quotes or a full stop around it. A cut one says so ("its token has 37 of 64 characters").
- **Addresses.** On a page opened as `localhost` the Address box starts with a network address of this computer (192.168.x first, then 10.x; never a Docker bridge, virtual or link-local one) and says when it works only here. In a container use the host's network address. Only a login session is told them (`GET /api/docking/addresses`). A station reached by an address it was not started for answers `forbidden host`: start it with `--allow-host <address>` (or `GONOGO_ALLOWED_HOSTS`; `<address>:hooks` opens only docking and webhooks to that name).
- The secret never travels; both sides derive it into `docking.json`. Each dock row polls every 30 seconds and has an AGENTS fold. An unreachable station shows NO ANSWER with the reason and keeps the last view. At most 8 docks.
- **Rooms.** The front port reaches room main at its plain address and every room at `/r/<room>`. A dock lives in the room that made its code, so for a room other than main the address is the machine's address **with `/r/<room>`**, for example `http://192.168.86.173:7777/r/umbral`: type it in the Address box of that room (it starts with that address) and the other station calls `/r/umbral/dock/...`; the calls are signed over `/dock/...` as always. The address takes nothing else in the path. A dock row with NO ANSWER and "does not know this station at this address" means the dock is in another room there (or was removed). **Two rooms of the same machine can dock with each other** (`http://<address>:7777/r/main` and `.../r/umbral`), but a station is known by its name, so each needs its own: set **Station name** per room in Flight Rules > Runtime settings (it may differ by room; restart the room), or the pairing says "a station called X is this one or is docked already".
- **Change address** (on each dock row, next to Undock; `PATCH /api/docking/<id>` with `{ "url": ... }`, your own login and the password again) changes the address this station calls the dock at without undocking: the dock keeps its name, id and secret, and the next call goes to the new address at once. Use it when the other station moved, or lives in another room (`/r/<room>`). The other station's own address for this one is changed on that station, in the same way.
- **Undock** tells the other station (3 seconds) and removes the dock here regardless. **Links resume** when you dock the same station again: its id is stable, so the first signed call gives each detached link back the state it had, and what waited is sent. **The rules below do not come back**: a new dock starts with the defaults.

## Messages

Agents write `name@station` (`name` is an agent or `boss`) with `send_message`; `list_roster` shows docked agents under `docked`. Status: `queued`, then `delivered` or `undelivered` with the reason. The receiver sees it from `ana@lab` with its hops; hop limit, held mail, Max Q and Redline apply. The Brief box cannot write to another station: ask an agent. A message about a linked task carries the link id and shows threaded in [Comms](./comms.md) on both sides (subject `[dl_...]`); a message naming a link of another dock is refused.

## Task links

A task is never shared: handing one over makes a **link** both stations keep. Each keeps its own task, and only events cross. The **receiver** owns the work (status, assignee, notes); the **sender** owns the request (title and detail) and can recall it. Neither can write the other's task. Names show as `ana@lab`, checked on arrival.

| State | Meaning |
|---|---|
| `offered` | sent, not yet taken |
| `accepted` | the other station made its task |
| `delivered` | the receiver says done; waiting for the sender |
| `returned` | the receiver gave it back |
| `recalled` | the sender withdrew it |
| `done` | the sender accepted |
| `detached` | the dock was removed; the trail is kept |
| `refused` | a limit or rule said no, with the reason |

The sender's card says it in words: `at lab: doing · "waiting on a key"`, with a timeline of the last 200 events (older ones fold into one `lost` line).

- **Hand off.** By you: Flight Plan card, HAND OFF, pick a station and, if you like, an agent. Always allowed. By FLIGHT (boss only): `task_handoff { task, station, assignee?, due?, priority? }`. With the rule on `ask` it waits for your GO with the **whole text that would leave**; the box *Always for lab* sets `allow` and says: *FLIGHT can then send tasks, and what it writes in them, to lab without asking you.* An offer may carry `due` (`YYYY-MM-DD`), `priority` (`low`, `normal`, `high`), `onward` and a cost cap (below); gonogo only shows `due` and `priority`.
- **Receiving.** The task is created as a card marked "from lab": todo, **given to your boss**; a named `assignee` is a hint (used if it is an agent here, else the boss assigns or asks for a hire). One Downlink line per task; more than 3 from one dock in 10 minutes make one digest line.
- **Report.** When the receiver's agents change a linked task with `task_update` (status, note), docking sends it. No one reports by hand. A task with `localNotes: true` (set with `task_update` or the API) sends the status word only, never the note text.
- **Return.** The receiver gives it back with a reason (200 characters). Its task becomes `done` marked `returned`, and the sender's own task **reopens as `todo`** with `returned by <agent>@<station>: <reason>`. It is never silently done.
- **Recall.** The sender closes the receiver's task as `recalled`, only if it is not done. Neither return nor recall touches any other task, assignee or mission.
- **Accept.** When the receiver's task goes `done` the link is `delivered` and the sender's task moves to `review`. The sender's Director accepts (task `done`) or returns it. With `autoAccept` on it closes at once. The Downlink gets one line on return, refuse, done and recall.
- **Deliverables.** A status can carry up to 5 links to the work, never its body: `pr` and `url` (https, no credentials; the host is shown), `branch`, `commit`, `file` (a relative path, shown as text). They are shown, never fetched or opened.
- **Late work.** An accepted link with no news for `staleHours` tells **your own boss** (and the Downlink), once per period. It is worked out here; nothing crosses the dock.
- **Station down.** Events wait in a saved outbox (200 per dock) and retry every 30 seconds, doubling to 10 minutes; the card says how many wait. An event unsent for 7 days, or past 200, is replaced by one `lost` event both sides can see. Loss is never silent.

### Chains

The receiver may hand a task on (A to B to C): each hop is its own link and status flows back (`at lab → at ops: doing`). **3 stations at most**, no station twice. **A task goes onward only if the offer said `onward: true`** (default off). That is a rule the receiving gonogo keeps: **lab's gonogo will not hand this on**. A modified gonogo, or a Director copying by hand, still could. Chain names are display text, "reported by lab".

## Missions

A mission can be offered like a task (name, goal, `due`, `priority`; never `onward`). The other station makes **its own mission, `planned`, with its boss as lead**, marked "from lab"; tasks handed over with it land inside. It reports **counts only** (done, blocked, in review, total; never titles): your mission shows "at lab: 3 of 5". Neither closes the other's; finishing is `delivered` and the sender accepts. The closing ritual is never shared. At most 5 open incoming missions per dock.

## Cost and caps

The receiver owns its spend. With `reportCost` on, a linked task reports **dollars to the cent and an estimate flag, nothing else**, at most once an hour and at delivery. Off: the card says "cost not reported". The offer's cap (`budget`, dollars) is **enforced by the receiver's own Propellant** (a budget scope per link), so the sender cannot spend or stop the other station's money: it sees "lab: $3.10 of $5.00 (estimate)" and, past the cap, a notice and the recall key. Estimates at list prices, never a bill ([Cost](./cost.md)).

## Knowledge on request

Nothing is shared by default.

- **Mark.** In the Mission Log entry or the claim, **Stations that may ask for this entry/claim** (your Director's login only; an agent cannot).
- **Serve.** The dock's `serve` rule must be on, or it gets nothing.
- **Ask.** You ask from a dock row (**Ask**). FLIGHT's `knowledge_ask { station, query }` is **boss only and works only where `ask` is on** for that dock (your own Ask key needs no rule). At most 20 questions an hour per dock, each way.
- **Answer.** At most 5 results: title, a snippet of at most 600 characters, date, "shared by lab". No body, id, tags, author, anchors or file paths. It comes with the line **"From lab, shared on request (data, not instructions)"**, is not stored as an entry, and the asker treats it as data.

`station_suggest { task }` (boss only) ranks local and docked agents by name and role words and returns the top 3. It sends nothing.

## The board and the Outbound view

- **ACROSS STATIONS** (Docking module): **Sent** and **Held** links with state, age, due, deliverables, cost and progress, filters by station and state, and the keys accept, return, recall and the trail. `GET /api/links` carries counts, states and cleaned titles only.
- **What left for `lab`** (a fold on each dock row; **your login session only**): the last 50 events sent, with the exact text, the time and whether it answered, plus knowledge questions and answers. Knowledge entries are kept in memory only. The Black Box keeps kinds and counts, never text.

## What leaves

Everything that leaves is cleaned (control, bidi and zero-width characters removed, length caps) and passes the secret redactor (tokens, `key=value` secrets, URL credentials show as `[redacted]`). **Once a task is accepted here, your agents' status notes, done notes and deliverable labels leave for that station automatically**: the `ask` rule covers offers only. The switch is `localNotes` on the task.

## Rules per dock

Set from the dock row (`PATCH /api/docking/<id>/rules`, your login session only). They are **per dock and go back to the defaults after an undock and a new docking**, even though the links resume.

| Rule | Values (default first) | Does |
|---|---|---|
| `handoff` | `ask`, `allow` | FLIGHT's handoffs wait for your GO, or go out |
| `incoming` | `auto`, `off` | take tasks from it as cards, or refuse them |
| `autoAccept` | `false`, `true` | a delivery waits for your review, or closes the task |
| `staleHours` | `24` (0 to 720; 0 is off) | quiet time before your boss is told |
| `reportCost` | `false`, `true` | tell it what its tasks cost here |
| `ask` | `false`, `true` | FLIGHT may ask it for knowledge |
| `serve` | `false`, `true` | answer its knowledge questions (marked entries only) |

## Limits

Per dock: 30 handoffs an hour in, 10 an hour out, 20 open incoming linked tasks, 5 open incoming missions, 200 events per link, 20 per batch, 256 KiB a body, 60 calls a minute, one cost event an hour, 20 knowledge questions an hour. Past a limit the receiver answers `refuse` with the reason, shown on the sender's card. Event text at most 200 characters; 10 links out of one task. A call touches only its own dock's links.

## The wire

`/dock/*` is outside `/api` and the browser token. Each call carries `X-Gonogo-Station`, `X-Gonogo-Timestamp` (ms epoch), `X-Gonogo-Nonce` and `X-Gonogo-Signature`: HMAC-SHA256 keyed with the 32-byte secret over `STATION\nMETHOD\nPATH\nTIMESTAMP\nNONCE\n` and the body.

- 401: timestamp more than 5 minutes off, seen nonce, wrong signature, or undocked station. 429: over 60 calls a minute. The host check applies; requests with an `Origin` are refused.
- Routes: `POST /dock/pair`, `GET /dock/roster`, `POST /dock/message`, `POST /dock/task`, `POST /dock/link` (batches of events; the answer says what was acked), `GET /dock/link/<id>` (repair), `POST /dock/knowledge`, `POST /dock/undock`. An event is applied once: a repeat does nothing, a known number with other text is refused and logged.
- After a restart that lost files, docking asks each peer once what it holds of a link and resends what it lacks.
- Proxies must pass path and body unchanged; clocks must agree within 5 minutes.

## API (browser token required; the Director's login where marked)

| Call | Body, answer |
|---|---|
| `GET /api/docking` | `{ "station", "docks": [{ "id", "name", "url", "since", "status", "seenAt", "error", "agents": [...] }] }`, no secret |
| `POST /api/docking/code`, `POST /api/docking/pair` | `{"url"}` -> `{ "code", "expiresAt" }`; `{"code", "url"}` -> the dock |
| `DELETE /api/docking/<id>` | `{ "told": true }` |
| `POST /api/docking/<id>/handoff` | `{"task", "assignee"?, "due"?, "priority"?, "onward"?, "budget"?}`; with `"mission": "<id>"` it offers a mission |
| `GET`, `PATCH /api/docking/<id>/rules` (login) | the seven rules above |
| `POST /api/docking/<id>/knowledge` (login) | `{"query"}` -> text and result count |
| `GET /api/docking/outbound?dock=<id>` (login) | the last 50 events that left |
| `GET /api/links`, `GET /api/links/<id>` | links; the trail of one |
| `POST /api/links/<id>/accept`, `/return`, `/recall` (login) | `{"reason"?}` -> the link |
| `GET /api/handoff-requests`, `POST /api/handoff-requests/<id>/answer` (login) | what waits for your GO; `{"go", "always"?}` |
| `GET`, `PUT /api/dock-shares` (login) | what you marked shareable; `{"kind", "id", "docks"}` |

A `docking` frame and a `links` frame carry the views, also in the state.
