---
description: "Dock two gonogo stations so their agents message each other, hand work over with a link that carries status, deliverables, cost and questions back, and share knowledge on request."
---

# Docking: work with another station

<DockingMock class="doc-mock" />

DOCKING (Flight Rules, Automation and connections, the row Docking) links two gonogo servers, called **stations**, so their agents can message each other and hand work across, and each side sees how the work is going. Each station has a name (`GONOGO_STATION`) and a random id in `station.json`. Design: [`docs/docking-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/docking-spec.md) and [`docs/docking-collab-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/docking-collab-spec.md). **Only tried between two servers on one machine** ([What was not verified](../reference/not-verified.md)).

**Dock only with people you trust.** The other station is not your owner: it is someone else's gonogo, and what it sends is data for your agents to read, never an instruction to them.

## What the other station can and can't do

| It can | It can't |
|---|---|
| Message your agents (`name@station`) | Write to your Director (`user`), or appear as `user`, `boss` or one of your agents |
| Hand you a task or a mission; you get a card in the Flight Plan (todo, unassigned, to your boss) | Change a task it does not own, or assign work to a name that is not an agent here |
| See your agents' names, roles and states | Approve or request a hire: only your Director approves one (Relief) |
| Send status, notes, questions, replies and links (never file bodies) for the tasks it handed you | Read your files, notes, Mission Log or claims, unless you marked an entry shareable for it |
| Ask for shared knowledge, if you turned that on for it | Spend your tokens or read your cost, unless you turned cost reporting on |
| Fill your boss's inbox with plausible tasks, up to the caps below | Get past `incoming: off`, the switch that stops it |

## Dock

1. Each station needs an address the other can reach: an HTTPS public name ([Reverse proxy](../reference/security.md#reverse-proxy)) or a private network such as Tailscale, allowed with `--allow-host`.
2. On A: MAKE A CODE, enter A's address, send the code to B's Director (shown once, single use, 15 minutes).
3. On B: PAIR, paste the code, enter B's address.

- **The code is read as people carry it:** with or without its first words (`gonogo-dock:`), with spaces, line breaks, quotes or a full stop around it. A cut one says so ("its token has 37 of 64 characters"): copy it again whole.
- **Addresses** must be ones the other computer can reach. On a page opened as `localhost` the Address box starts with a network address of this computer (192.168.x first, then 10.x; never a Docker bridge, virtual or link-local one) and says when it works only here. In a container it cannot tell, so use the host's network address. Only a login session is told the addresses (`GET /api/docking/addresses`). A station reached by an address it was not started for answers `forbidden host`: start it with `--allow-host <address>` (or `GONOGO_ALLOWED_HOSTS`; `--allow-host <address>:hooks` opens only docking and webhooks to that name).
- The secret never travels; both sides derive it into `docking.json`. Each dock row polls every 30 seconds and has an AGENTS fold (`name@station`, state, role). An unreachable station shows NO ANSWER with the reason and keeps the last view.
- **Undock:** UNDOCK tells the other station (3 seconds) and removes the dock here regardless; if it is unreachable, undock there too. Links keep their trail marked `undocked`. Docking the same station again (the station id is stable) needs a new code, and a link resumes at the first signed call.

## Messages

Agents write `name@station` (`name` is an agent or `boss`) with `send_message`; `list_roster` shows docked agents under `docked`. Status: `queued` ("sending to lab"), then `delivered` or `undelivered` with the reason. The receiver sees it from `ana@lab` with its hops; hop limit, held mail, Max Q and Redline apply. The Brief box cannot write to another station: ask an agent. A message about a linked task carries the link id and shows threaded in [Comms](./comms.md) on both sides (subject `[dl_...]`).

## The link: one task, two stations

A task is never shared. Handing one over makes a **link** both stations keep: each keeps its own task, and only **events** cross. The **receiver** owns the work (status, assignee, notes on its task); the **sender** owns the request (the title and detail it sent) and can **recall** it. Neither can write the other's task. Names show as `ana@lab`, checked on arrival: a station cannot pose as another.

| State | Meaning |
|---|---|
| `offered` | sent, not yet taken |
| `accepted` | the other station made its task |
| `delivered` | the receiver says done; waiting for the sender to accept |
| `returned` | the receiver gave it back |
| `recalled` | the sender withdrew it |
| `done` | the sender accepted |
| `detached` | the dock was removed; the trail is kept |
| `refused` | a cap or rule said no, with the reason |

The sender's card says it in words, never by colour alone: `at lab: doing · "waiting on a key"`. The card has a short timeline (the last 200 events; older ones fold into `lost: N older events`).

### Hand off

- **By you:** Flight Plan card, HAND OFF, pick a station and, if you like, an agent. Always allowed.
- **By FLIGHT:** the tool `task_handoff { task, station, assignee? }`. Per dock, `handoff: ask` (default) shows you the **full text that will leave** and waits for GO; the box "always for lab" sets `allow` and says: *FLIGHT can then send tasks, and what it writes in them, to lab without asking you.*
- **The offer** may carry `due` (`YYYY-MM-DD`), `priority` (`low`, `normal`, `high`), `onward` (see Chains) and a cost cap `budget` (see Cost). gonogo only shows `due` and `priority`.
- **On the receiving side** the task is created **always**, as a card marked "from lab": todo, **unassigned and given to your boss**. An `assignee` the sender names is only a hint: if it is an agent here the task goes to it, else to the boss, who assigns it or asks for a hire through Relief. Per dock, `incoming: auto` (default), `ask` or `off`. Each incoming task is one Downlink line; more than 3 from one dock in 10 minutes become one digest line; the Docking module shows the count.

### Report, return, recall, accept

- **Report:** when the receiver's agents change a linked task's status or add a note with `task_update`, docking sends it. Nobody reports by hand.
- **Return:** the receiver gives it back with a reason (200 characters). Its task becomes `done` marked `returned`, and **the sender's own task reopens as `todo`** with `returned by <agent>@<station>: <reason>` in its history. The sender can hand it to someone else. It is never silently done.
- **Recall:** the sender closes the receiver's task as `recalled`, **only if it is not done**. Neither return nor recall reaches another task, an assignee or a mission.
- **Accept:** when the receiver's task goes `done` the link is `delivered` and the sender's task moves to `review` ("delivered by lab"). The sender's Director or boss accepts (task `done`) or returns it. Per dock `autoAccept: on` closes it at once ("auto-accepted"); default off.
- The Downlink gets one line on return, refuse, done and recall, none on routine status.

### Deliverables

A status or done event can carry up to 5 **links, never file bodies**: `pr`, `url` (https, no credentials in them; shown with the host in punycode so a lookalike is visible), `branch`, `commit`, `file` (a relative path shown as text, never opened). They are shown, never fetched or opened by gonogo.

### Chains and splits

The receiver may hand a task on (A to B to C); each hop is its own link and status flows back hop by hop (`at lab → at ops: doing`). At most 3 hops, no station twice. **A task goes onward only if the offer says `onward: true`** (default off, per offer or per dock). That is a rule the receiving gonogo keeps: **lab's gonogo will not hand this on**. A modified gonogo, or its Director copying by hand, still could. Chain names are display text "reported by lab". A split is several links from one task (up to 10); the parent shows "2 of 3 delivered".

### Late work

Per dock `staleHours` (default 24, 0 is off): an accepted link with no event for that long makes a **local** notice to your own boss, once per period. It is worked out on each side; nothing crosses the dock.

### When the station is down

Events wait in a saved outbox (up to 200 per dock) and are retried every 30 seconds, doubling to 10 minutes; the card says `lab: not reachable, 3 events waiting`. When it returns both trails match. An event unsent for 7 days becomes one visible `lost` event: loss is never silent.

## Missions, cost, suggestions, knowledge

- **Missions.** A mission can be offered like a task (name, goal, `due`, `priority`, `onward: false`). The other station makes **its own mission, `planned`, with its boss as lead**, marked "from lab"; tasks handed over with the mission land inside it. It reports **counts only** (`total, done, blocked, review`, never titles); the sender's mission shows "at lab: 3 of 5". Neither closes the other's: finishing is `delivered`, the sender accepts. The closing ritual is never shared. At most 5 open incoming mission links per dock.
- **Cost back.** The receiver owns its spend. Per dock `reportCost: off` (default) or `on`: then a linked task reports **dollars to the cent and an estimate flag, nothing else** (at most once an hour and at delivery). The offer's `budget: { usd }` is a cap **enforced by the receiver's own Propellant** (a budget scope `links`), so the sender cannot spend or stop your money; it sees "lab: $3.10 of $5.00 (estimate)", and past the cap a notice and the recall key. Off: "cost not reported". Estimates at list prices, never a bill ([Cost](./cost.md)).
- **Suggestions.** FLIGHT's `station_suggest { task }` ranks local and docked agents by their names and role texts with the Mission Log's word search, returns the top 3 with the matching words, and **sends nothing**. A station can stuff words into a role; the effect is a name on a list you still decide on.
- **Knowledge on request.** Nothing is shared by default. Your **Director's session** marks a Mission Log entry or an accepted claim **shareable** for named docks (an agent cannot), and the dock needs `serve: on` (default off). A docked agent's `knowledge_ask { station, query }` (20 an hour per dock) gets **at most 5 results**: title, a snippet of at most 600 characters, date, "shared by lab". No body, id, tags, author, anchors or file paths leave. The asker gets it as data, not stored as an entry. See [Knowledge](./knowledge.md).

## The board

Launch Window, Docking section: **OUT** (what you sent) and **IN** (what you hold), with state, age, due, deliverables, cost, progress and a stale badge; filters by station and state; accept, return, recall, open the trail, open the task. On a phone it is a short list. `GET /api/links` and a `links` frame carry counts, states and cleaned titles only.

## Privacy: what leaves

- **Text that leaves is cleaned** (control, bidi and zero-width characters removed, length caps) **and passes the secret redactor** (tokens, `key=value` secrets, URL credentials show as `[redacted]`).
- **Once a task is accepted here, your agents' status notes, done notes and attachment labels leave for that station automatically.** The `ask` rule covers offers only. The switch is the task's **local notes** flag: with it set, status events leave **without their note text** (the status word only).
- **Outbound view** (Docking module, **your login session only**): the last 50 events sent to each dock, with the exact text, the time and the ack; also knowledge titles and snippets and `knowledge_ask` queries. The Black Box keeps kinds, ids and counts, never text.
- **Per-dock switches:**

| Rule | Values (default first) |
|---|---|
| `handoff` (FLIGHT sends tasks) | `ask`, `allow` |
| `incoming` (tasks from it) | `auto`, `ask`, `off` |
| `autoAccept` | `off`, `on` |
| `staleHours` | `24` (0 is off) |
| `reportCost` | `off`, `on` |
| `serve` (knowledge) | `off`, `on` |

## Limits

Per dock: 30 handoffs an hour in, 10 an hour out, 20 open incoming linked tasks, 5 open incoming missions, 200 events per link, 20 events per batch, 256 KiB a body, 60 calls a minute, one cost event an hour, 20 knowledge requests an hour. Past a cap the receiver answers `refuse` with the reason, shown on the sender's card. Event text is at most 200 characters; at most 3 hops, 10 outgoing links per task, 5 attachments per event. A call touches only its own dock's links.

## The wire

`/dock/*` is outside `/api` and the browser token. Each call carries `X-Gonogo-Station` (sender's id), `X-Gonogo-Timestamp` (ms epoch), `X-Gonogo-Nonce` (random hex) and `X-Gonogo-Signature`: HMAC-SHA256 keyed with the 32-byte secret over `STATION\nMETHOD\nPATH\nTIMESTAMP\nNONCE\n` and the body.

- 401: timestamp more than 5 minutes off, seen nonce, wrong signature, or undocked station. 429: more than 60 calls a minute from one dock. The host check applies; requests with an `Origin` are refused.
- Routes: `POST /dock/pair`, `GET /dock/roster`, `POST /dock/message`, `POST /dock/task`, `POST /dock/link` (batches of events, answered with what was acked), `GET /dock/link/<id>` (repair), `POST /dock/undock`, and `POST /dock/knowledge`. Events are applied once: a repeat is a no-op, a known `seq` with different text is refused and logged.
- Proxies must pass path and body unchanged; clocks must agree within 5 minutes.

## API (browser token required)

| Call | Body, answer |
|---|---|
| `GET /api/docking` | `{ "station": "alpha", "docks": [{ "id", "name", "url", "since", "status", "seenAt", "error", "agents": [{ "name", "role", "state", "boss" }] }] }`, no secret |
| `POST /api/docking/code` | `{"url": "https://alpha.example.com"}` -> `{ "code", "expiresAt" }` |
| `POST /api/docking/pair` | `{"code": "...", "url": "..."}` -> the dock |
| `DELETE /api/docking/<id>` | `{ "told": true }` |
| `POST /api/docking/<id>/handoff` | `{"task": "t4", "assignee": "bob"}` -> the task |
| `GET /api/links` | links with counts, states and cleaned titles |

<!-- Fill from the slices once GUIDO's API is fixed: the per-dock rules route, accept/return/recall, share marks, the Outbound view and the `links` frame. -->

A `docking` frame carries the whole view, also in the state.
