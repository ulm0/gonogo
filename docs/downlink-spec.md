# Spec: Downlink

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): the Director's inbox, the
equivalent of Munder Difflin's Inbox.

## Intent

What the agents send to the Director, and what the server noticed that he should see, in one list that the server keeps.
Before, the comm loop showed the messages to "user" and the unread count was a time stored in the browser, so the phone and
the desk each counted for themselves. Now what is read or archived is on the server and every browser shows the same. Nothing
else is new: an agent still reaches the Director with `send_message` to `user`.

## Design

- **An item** is a message to `user` or an event. A message is `{ type: 'message', id, at, from, subject, body, truncated,
  inReplyTo, read, archived }` and an event is `{ type: 'event', id, at, kind, text, read, archived }`
  (`DownlinkItem` in `src/shared/protocol.ts`). The message id is the id of the message (`m12`), the event id is `e1`, `e2`,
  ... and is never used twice, also after a restart (the file keeps `seq`).
- **Events.** `kind` is `redline`, `tminus`, `launch-window`, `uplink` or `flight-plan`; `text` is one line of at most 300
  characters, with control characters turned into spaces. Each part of the server tells the inbox through one function,
  `Downlink.post(kind, text)` (`DownlinkNotify`):
  - a Redline trip, the hub, from `tripRt` through `HubIo.notify` (the automatic detectors and a Propellant limit both come
    here): `ana: loop: Bash: npm test 5 times in a row`. A trip of an agent that is tripped already says nothing.
  - a T-minus result, the hub, from `publishPoll`: `GO: all go`, `HOLD: no-go: simsup` or `ABORTED: aborted by the Director`.
    Once for each result of a poll; a later vote that leaves the status as it is says nothing, and neither does `open`.
  - a Launch Window failure, `schedules.ts`, in `fire`: the hub refused the message or it threw, as `lastResult` says:
    `Standup: undelivered m8: ana is stopped`. A message that was held is not a failure.
  - an Uplink refused for a bad signature, `uplinks.ts`: more than 3 requests in 10 minutes that did not prove themselves,
    for an uplink that exists and is on. At most one event for each uplink in each 10 minutes. The text names the uplink and
    never the secret.
  - a Flight Plan task moved to `blocked` or `review` by an agent, `tasks.ts`: `ana moved t1 to blocked: Write the spec`.
    What the Director moves himself is not news to him.
- **What the server keeps.** The inbox holds a copy of the newest 200 messages to the Director and the newest 1000 events.
  The copy of the messages is in memory: at start it is read again from `messages.jsonl` (its newest 1000 records, so
  as far back as that tail goes) and then every `activity` frame of the hub with `to: 'user'` joins it. `downlink.json` keeps
  `{ version: 1, seq, events: [{ id, at, kind, text }], flags: { "<id>": "read" | "archived" } }`, mode 0600, written whole
  through a temporary file and a rename after every change (the writer of `tasks.ts`). A message has no copy there:
  "referenced by id" means the flag is the only thing the file knows of it. A flag whose item is gone is dropped.
- **Read and archived.** An item has no flag (unread), `read` or `archived`. Archived is read too, so it leaves the unread
  count; reading an archived item changes nothing. There is no way back to unread or out of the archive. `unread` in the
  view is the number of items that are not read.
- **The first run.** With no `downlink.json` (or one that could not be read: it is kept as `downlink.json.bad`), the
  messages already in the log are marked read, so the badge does not start at 200 for mail the Director saw in the comm loop.
- **Routes** (`web.ts`, browser token only). `GET /api/downlink` answers the view, `{ unread, items }`, newest first.
  `POST /api/downlink/read` and `/archive` take `{ ids: [...] }` (1 to 200 ids of the form `m12` or `e3`; any other field or
  a bad id is a 400 with its name) and answer the view. An id the inbox does not hold is skipped, not an error: the item may
  have been dropped by a limit a moment ago, and both calls can be repeated. `POST /api/downlink/read-all` marks every item
  that has no flag read and answers the view. A call that changes nothing writes nothing and sends no frame.
- **Frame.** `downlink` carries the whole view and is sent at every change (an item came, a flag changed);
  `StateSnapshot.downlink` has it at connect. An older server sends none and the page shows an empty inbox.
- **The screen** is a view of its own, DOWNLINK (`Downlink.tsx`, `inbox.ts`, `downlink.css`; `store.view` is `downlink`), with
  a DOWNLINK key in the top bar and a DOWN key in the phone bar, each with the unread count. The count replaces the one of the
  LOOP key, and `userMailSeenAt` with its storage key `gonogo.mailSeenAt`, `userMailCount` and `markMailSeen` are gone from
  the client. The view has filters ALL, MESSAGES, EVENTS and ARCHIVED (the first three show what is not archived) with their
  counts, MARK ALL READ and ROOM. Unread rows come first, each group newest first, and an unread row is a key-coloured band
  with a lit light. A row read while the page is up keeps its place until the page is left, so an opened message does not
  jump down under the other unread ones; MARK READ leaves the keyboard on its row. A message row opens in place to show its text and the reply box of the comm loop (`Reply` of
  `Activity.tsx`, which now takes any item with an id, a sender and a subject and an `onSent`); an event row is one line.
  Every row has MARK READ (when it is unread) and ARCHIVE. The view draws the newest 100 rows of the filter and says how many
  there are. The screen reader name of a key says what it is for (`Archive: Build is green`), the unread count is in the name
  of the top-bar and phone-bar keys (`Downlink, 3 unread`), and the live region says when the count goes up.
- **Keys.** While the view has focus: `j` moves to the next row and `k` to the previous (at an end it stays; with no row
  yet, `j` takes the first and `k` the last), `e` archives the row that has the keyboard and puts the keyboard on the one that
  takes its place, `r` opens the message and puts the keyboard in its reply box. They do nothing with Ctrl, Cmd or Alt, or
  while the keyboard is in a text field, a select or an editable element. Rows are focusable (one tab stop, the others by
  `j` and `k`); the page puts the keyboard on its title when it opens.

## Decisions

- **The server keeps a copy of the messages.** The brief says messages are referenced by id. The hub only holds the newest
  200 messages of all kinds, and in a busy room that is an hour; an inbox that loses what the Director has not read yet is no
  inbox. So the inbox has its own 200 messages to the Director, found again in the log after a restart.
- **A state of one word per item, not two booleans.** `read` and `archived` are one thing that only grows: nothing is marked
  unread again and nothing leaves the archive, so one flag per id says it all. The view still has both booleans.
- **Events from the places they happen, not from the frames.** The hub, `schedules.ts`, `uplinks.ts` and `tasks.ts` call one
  function. Deriving them from `agent`, `poll` and `tasks` frames would need a copy of what was seen before and could not
  tell who moved a task. The functions are optional, so a test or a fake does not need them.
- **Opening a message reads it**, and so does answering it. A keyboard user who presses `r` has read it. A failed call leaves
  it unread and the MARK READ key is still there.
- **The T-minus result of the Director's own abort is an event.** The brief lists go, hold and aborted without exception,
  and the inbox is also the record of what happened while he was away.
- **`Mark all read` is the only bulk call.** It needs no ids. There is no archive-all: archive is a choice about one item.
- **No option and no environment variable.** The limits are constants (`constants.ts`).

## Rejected

- Mark as unread, un-archive, delete: not in the brief.
- A list of events by agent, or a link from an event to the console: the text names the agent.
- Push notifications or sound: the badge and the live region are the signal.
- Messages from the loop other than those to the Director (an agent's message to another, or an undelivered one that "went
  to the user"): the brief says every message to `user`. A message that failed to reach an agent is in the loop, marked
  UNDELIVERED, and a failed Launch Window fire is an event.

## Known limits

- shortcut: a message leaves the inbox when 200 newer messages to the Director came (it stays in `messages.jsonl`), and the
  whole inbox is in every frame and every snapshot, about 700 KB at the limits (200 messages of 2000 characters and 1000
  events), which is under the 4 MB socket buffer of `web.ts`. Send the changes only if a frame that size ever hurts.
- shortcut: the messages are found again in the newest 1000 records of the log (within `MESSAGES_TAIL_BYTES`), so after a
  restart in a room that talks a lot, older mail to the Director may be gone from the inbox.
- The flags of messages that are not in the log any more are dropped at the next start.
- An event is text. A Redline trip of an agent that is then resumed stays in the inbox as it was.
- The unread count of a browser that is offline is the one it last heard. It is right again at the next frame or reconnect.
- Tested with a fake clock (the store), a fake store behind the routes, the hooks in the hub, `schedules.ts`, `uplinks.ts` and
  `tasks.ts` with a fake `notify`, a real server with the stand-in agent (a message from an agent, a T-minus abort, a task an
  agent blocked, the routes, the frames, the file) and the page in Chrome (below). Never run with a real `claude`: that an
  agent writes to `user` when it should is the model's choice and was not tried.
- The page was opened in Chrome at 1280 px and in Chrome's 390 px phone emulation against a real server with the stand-in agent:
  no horizontal overflow, every key and field at least 44 px tall, the six keys of the phone bar fit, `j`, `k`, `e` and `r`
  with the keyboard following (and not acting in the reply box), a message opened and read, a reply sent from the row and
  the file written (mode 0600) and read back after a restart. Those keys were pressed by script (DOM events), not by hand or
  with a screen reader. Not tried: Firefox, Safari, a screen reader, and an inbox of hundreds of items.
