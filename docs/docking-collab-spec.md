# Spec: Docking 2, real collaboration between stations (draft)

Design by FIDO, 2026-11-23, task t120. Status: draft, not built. Read: `docs/docking-spec.md`, `src/server/docking.ts` (`handOff` at `:662`, `acceptTask` at `:485`, `handle` at `:683`), `src/server/tasks.ts` (`handOff` at `:283`), the `Task` type (`src/shared/protocol.ts:1033`). The comparisons with Linear, Jira and GitHub below are from general knowledge; I did not re-read their docs for this.

## 1. The model: a task is never shared, a **link** is

Each station keeps its own Flight Plan. Docking 1 copies a task once and forgets it. Docking 2 adds one object, the **Link**, held by both stations, and nothing else is shared.

- **Link** `{ id, role: 'sender'|'receiver', peer: <dock id>, peerName, mine: <task id>, theirs: <task id|null>, state, trail[], outSeq, inSeq }`, in `<home>/links.json` (0600, atomic, `version: 1`). `id` is `dl_` plus 16 random hex, made by the sender at the first handoff; both sides keep it. A task has at most one Link (`Task.link?: <link id>`; `handedOff` stays for old tasks).
- **Who owns what (one writer per field).** The **receiver owns execution**: status, assignee, notes on its own task. The **sender owns intent**: the title and detail it sent (a revision is a new event, the receiver's copy keeps its own text), and **recall**. Neither side can write the other's task: the other side only gets **events**. This is the part worth copying from GitHub (each repo owns its issue; a cross-reference shows as a backlink event) and from Jira (a remote link shows the remote issue's status read-only). Linear and Jira "synced status" workflows are **not** copied: they need shared workflow definitions, which stations do not have.
- **Link states:** `offered` (sent, not yet taken), `accepted`, `returned` (receiver gave it back), `recalled` (sender withdrew it), `done`, `detached` (dock removed), `refused`. The sender's card shows `at lab: doing · "waiting on a key"`, plain words, never colour only.

## 2. The trail: events, replicated both ways

Every change is an **event** `{ link, author: <station id>, seq, at, kind, by, text }`: `kind` is `offer`, `accept`, `status` (todo, doing, blocked, review, done), `note`, `ask`, `reply`, `return`, `recall`, `refuse`, `lost`. `seq` counts per author per link, so `(link, author, seq)` is a unique key and **applying an event twice does nothing**. `by` is `ana`, `director` or `boss` plus the station name when shown (`ana@lab`). `text` at most 200 characters, cleaned like any text from another station (control, bidi and zero-width characters removed; shown as text only).
- Each side stores the whole trail of the link (most recent 200 events; older ones are folded into one `lost: N older events` line, never dropped silently) and shows it on the card as a short timeline.
- **Black Box** records every event by name, kind, ids and counts, never text (as it does today). The Director's Downlink gets one line on `return`, `refuse`, `done` and `recall`, nothing on routine status. No Mission Log entry is written for you; an agent may write one like any lesson.
- **Automatic reporting:** when a linked task changes status or gets a note through the receiver's normal `task_update`, Docking turns it into an event. Nobody has to remember to report. The receiver's agents see no new tool for this.

## 3. Sending events: an outbox, never silent loss

Events travel in **batches** on one new signed route, `POST /dock/link` (`{ events: [...up to 20] }`), inside the existing 60 calls a minute per dock; the answer is `{ acked: { <link>: <highest seq applied> } }`.
- Each station keeps a persisted **outbox** per dock (`<home>/dock-outbox.json`, 0600, at most 200 events per dock). An event leaves it only when the peer **acks** it. Retry every 30 s doubling to 10 min while the dock is `down`; flush at once when it comes back. The receiver applies events in `seq` order and holds a gap for up to 50 events.
- **Station down:** the sender's card says `lab: not reachable, 3 events waiting`. Eventual consistency: when it returns, the trail on both sides is the same.
- **Event too old or outbox full:** an event unsent for 7 days or past the cap is replaced by one `lost` event both sides can see ("3 status events were not delivered"). Loss is visible, never silent.
- **Repair:** `GET /dock/link/<id>` returns the peer's state and highest `seq` it holds from each author; used once after a restart that lost a file, to resend what the peer lacks.
- **Undock:** both sides mark their links `detached` and keep the trail (last known state shown with "undocked"). Docking the same station again (the station id is stable) lets a detached link resume: the first signed call re-attaches links whose peer id matches.

## 4. The three approved directions, as one flow

1. **Hand off** (`offer`). Sender: the Director's card key (as today) or FLIGHT's new tool **`task_handoff { task, station, assignee? }`**. The receiver creates its task **always**: if `assignee` is a valid agent there it is assigned; if unknown, absent or missing, the task is created **unassigned and given to that station's boss** with a message "task from lab (not your Director): ..."; the assignee is only a **hint**, never a 400. The boss assigns it, or asks for a hire through **Relief; only that station's Director approves a hire**. The remote station can never create, approve or trigger a hire (no route does it). The answer carries `theirs` (the receiver's task id) and the event `accept` says who holds it.
2. **Standing rule per dock** (the whole ceremony): `handoff: ask | allow`, default **ask**. `ask`: `task_handoff` makes a Relief-style request the Director answers once with GO (with an "always for lab" box that sets `allow`). The Director's own card handoff is always allowed. **Receiving needs no click**: a linked task is only a card (todo, unassigned, to the boss); the dock already was the trust decision. `incoming: auto | ask | off` per dock exists for the Director who wants it, default `auto`.
3. **Return** (`return`, reason up to 200 chars): the receiver gives it back; its task becomes `done` with a `returned` mark and **the sender's task reopens** (`todo`, the link `returned`); the sender may hand it to another agent here or to another station (a new event on the same link keeps the history). **Recall** (`recall`) by the sender closes the receiver's task as `recalled` if not done.
4. **Questions and replies** (`ask`, `reply`) are the existing dock messages with a **`link` field**: threaded by link id in Comms on both sides, subject prefixed `[dl_...]`, hop limits, held mail and the "other station is not your owner" label unchanged. They are also trail events (kind and counts only in the Black Box).

## 5. Limits (spam and abuse)

Per dock: at most **30 handoffs an hour**, **20 open incoming linked tasks**, 200 events per link, 20 events per batch, the existing 256 KiB body and 60 calls a minute. Past a cap the receiver answers `refuse` with the reason; the sender sees it on the card and in the trail. Outgoing: a sender cannot exceed 10 handoffs an hour per dock. A link event is accepted only if `link.peer == dock.id` and the link's role fits the kind (a receiver cannot send `offer`; a sender cannot send `status`), so a docked station can touch only its own links.

## 6. Trust model (RSO reads this)

What stays: a dock is trust in a person; calls are signed, replay-protected and rate limited (`docking-spec.md`). What is new: **text from another station becomes task text and a message to the boss**. It is cleaned like S6, labelled "from lab" in the card, the history line and the message, and **never** appears as a system prompt, a pointer, a start notice or a role line. It cannot say `to: user`. It cannot change a task it does not own. It cannot assign work to a name that is not an agent here. It cannot approve or request a hire. The receiver's boss reads it as data and may ignore it. The sender's Director sees every outgoing handoff (the card, the trail, the `ask` rule). Known limit, stated: a docked station can still fill your boss's inbox with plausible tasks up to the caps; `incoming: off` is the switch.

## 7. Phases (GUIDO builds after the Director's go; RSO reviews 1 and 3)

| PR | What | Size |
|---|---|---|
| **1. Link and status back** | `Link` store, events, outbox with ack, `POST /dock/link`, the idempotent `task` route (resends return the same link), automatic status events from `task_update`, the sender's `at lab: doing` card chip, caps, Black Box lines | L, ~600 |
| **2. Unknown assignee, return, recall** | assignee as hint, unassigned to the boss with the labelled message, `return`/`recall` events and their task effects, trail on the card, Downlink lines | M, ~300 |
| **3. `task_handoff` and the rule** | MCP tool for the boss, per-dock `handoff` and `incoming` settings, the Relief-style GO with "always for this station", docs | M, ~250 |
| **4. Threads and repair** | `link` on dock messages, Comms thread by link, `GET /dock/link/<id>` repair, `lost` events, undock/redock resume, docs | M, ~300 |

**Tests.** Event idempotence (replay a batch twice), ordering with a gap, outbox survives a restart and flushes after the dock returns, ack removes events, a 7-day-old event becomes `lost`, caps and `refuse`, a receiver cannot send `offer` and a sender cannot send `status`, a link id from another dock is refused, text cleaned (bidi, control) in every place it appears, unassigned goes to the boss and no hire route is reachable from `/dock/*`, return reopens the sender's task, undock then redock resumes, `ask` rule needs one GO and `allow` none, old `handedOff` tasks still read. Not testable here: two real machines and a real proxy between them.

## 8. Open questions for the Director

1. Default `handoff: ask` and `incoming: auto`: right for "little ceremony"?
2. Should a receiving Director see a one-line notice per incoming task (Downlink `info`), or only a count on the Docking module?
3. Is "returned reopens the sender's task" what you want, or should it stay `done` with a mark?
