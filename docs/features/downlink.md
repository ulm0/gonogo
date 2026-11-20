# Downlink: the inbox

<DownlinkMock class="doc-mock" />

The INBOX tab of [COMMS](./comms.md) is your inbox. Design: [`docs/downlink-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/downlink-spec.md).

## What lands in it

- Every message an agent sends to `user`.
- One line each for: a Redline trip (agent and reason, Propellant trips included); a T-minus result (GO, HOLD or ABORTED with the note; a [Static fire](./static-fire.md) adds every answer); a failed Launch Window fire; Uplink refused for bad signature more than 3 times in 10 minutes (per uplink, never the secret); a task an agent moved to blocked or review (not your own moves); a hire request FLIGHT made and its end: hired, refused, expired or failed ([Relief](./relief.md)); a permission dialog (`ana asks: Bash: pnpm vitest run`), once per dialog, inbox only, not forwarded by Relay.

## The page

- State is server-side (all devices agree): unread, read, archived (archived is read). Opening or answering reads. No mark-unread.
- Filters ALL, MESSAGES, EVENTS (these hide archived), ARCHIVED; MARK ALL READ; ROOM. Unread first, then newest, with a lit light; a read item stays until you leave the page. Newest 100 per filter.
- A message opens in place with the reply box (goes to the sender, in its thread). Each item has MARK READ and ARCHIVE.
- Keys (page focused, not typing): `j`/`k` move, `e` archives, `r` opens a message at its reply box.
- Kept: newest 200 messages to you (restored from `messages.jsonl` after restart) and newest 1000 events. Older messages stay in the loop and log.

## API

- `GET /api/downlink` -> `{ "unread": 2, "items": [...] }`, newest first.
- `POST /api/downlink/read`, `POST /api/downlink/archive` take `{"ids": ["m12", "e3"]}` (1 to 200 ids; unknown skipped).
- `POST /api/downlink/read-all` takes nothing.

All answer the view, also in the state and in a `downlink` WebSocket frame.
