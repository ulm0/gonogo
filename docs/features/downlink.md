# Downlink: the inbox

<DownlinkMock class="doc-mock" />

DOWNLINK (top bar, or DOWN on a phone) is your inbox. Design and limits: [`docs/downlink-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/downlink-spec.md).

## What lands in it

- Every message an agent sends to `user`.
- One line for each:
  - Redline trip (agent and reason, including Propellant trips)
  - T-minus result (GO, HOLD or ABORTED, with the poll's note; a [Static fire](./static-fire.md) adds every answer)
  - failed Launch Window fire (hub refused it, or it could not be sent)
  - Uplink refused for bad signature more than 3 times in 10 minutes (one line per uplink per 10 minutes, never the secret)
  - task an agent moved to blocked or review (not your own moves)
  - hire request FLIGHT made, and its end: hired, refused, expired or failed ([Relief](./relief.md))

## Read state

Server-side, so all devices agree. Unread, read or archived (archived is read). Opening or answering reads. No mark-unread.

## The page

- Filters ALL, MESSAGES, EVENTS (these hide archived) and ARCHIVED; MARK ALL READ; ROOM.
- Unread first, newest first, with a lit light. A read item stays in place until you leave the page.
- A message opens in place with the comm loop reply box (answer goes to the sender, in its thread). An event is one line.
- Each item: MARK READ, ARCHIVE. Shows the newest 100 items per filter.
- Keys (page focused, not typing): `j`/`k` move, `e` archives, `r` opens a message at its reply box.

## Retention

Newest 200 messages to you (restored from `messages.jsonl` after a restart) and newest 1000 events. Older messages remain in the loop and the log.

## API

- `GET /api/downlink` answers `{ "unread": 2, "items": [...] }`, newest first.
- `POST /api/downlink/read`, `POST /api/downlink/archive` take `{"ids": ["m12", "e3"]}` (1 to 200 ids; unknown ids skipped).
- `POST /api/downlink/read-all` takes nothing.

All three answer the view, which is also in the state and in a `downlink` WebSocket frame. No option.
