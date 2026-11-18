# Downlink: the inbox

<DownlinkMock class="doc-mock" />

DOWNLINK (top bar, or DOWN in the phone bar) is your inbox. Design and limits: [`docs/downlink-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/downlink-spec.md).

- **What lands in it.** Every message an agent sends to `user`, and a line for each of these: a Redline trip (the agent and the
  reason, also when a Propellant limit tripped it), a T-minus result (GO, HOLD or ABORTED, with the note of the poll), a
  Launch Window fire that failed (the hub refused it or it could not be sent), an Uplink that was refused for a bad
  signature more than 3 times in 10 minutes (one line for each uplink in each 10 minutes, never with the secret), and a task
  an agent moved to blocked or review (a task you move yourself says nothing).
- **Read and archived are kept by the server**, so the phone and the desk show the same count. An item is unread, read or
  archived, and archived is read too. Opening a message reads it, and so does answering it. There is no way back to unread.
- **The page** has the filters ALL, MESSAGES, EVENTS and ARCHIVED (the first three hide what is archived), MARK ALL READ and
  ROOM. Unread items come first, newest first, with a lit light; one you read stays in its place until you leave the page. A message opens in place, with the reply box of the comm loop
  (the answer goes to the sender, in its thread); an event is one line. Each item has MARK READ and ARCHIVE. The page draws
  the newest 100 items of a filter. Keys, while the page has focus and you are not typing in a field: `j` and `k` move,
  `e` archives, `r` opens a message and goes to its reply box.
- **What it keeps.** The newest 200 messages to you (found again in `messages.jsonl` after a restart) and the newest 1000
  events. An older message is still in the loop and in the log.
- **API.** `GET /api/downlink` answers `{ "unread": 2, "items": [...] }`, newest first. `POST /api/downlink/read` and
  `POST /api/downlink/archive` take `{"ids": ["m12", "e3"]}` (1 to 200 ids; an id the inbox does not hold is skipped), and
  `POST /api/downlink/read-all` takes nothing. All three answer the same view. The view is also in the state and in a
  `downlink` frame on the WebSocket. There is no option for it.
