# Spec: Party Line

Written and built 2026-11-18. Feature of the self-hosted roadmap (`docs/backlog.md` section 2, marked inferred): the
messages of the room grouped by conversation, the equivalent of Munder Difflin's Threads panel.

## Intent

The comm loop lists every message, newest first, so one conversation is spread over the list among the others. Party Line
groups the messages that belong together, lists the conversations by their last message, and opens one as a thread: its
messages in order and a box to answer in it. The message model is not changed: a conversation is worked out from what a
message already carries.

## Design

- **No thread id.** A `MessageRecord` has `from`, `to`, `subject` and `inReplyTo`. A thread id would be a second truth next
  to those two, would need a migration of `messages.jsonl` (written one line per record, last line per id wins) and could
  not be given to the old lines. So none is added, and nothing is saved, sent or migrated.
- **A conversation** (`groupThreads` in `src/client/threads.ts`), over the list in the store, oldest message first:
  1. a message whose `inReplyTo` is a message of the list joins that message's thread, when it comes from the Director or from
     one of the two ends of that message: an agent picks its own `inReplyTo` (the hub only checks its shape), so without this
     an agent could write itself into the conversation of two others and become the default recipient of the Director's answer;
  2. else it joins the thread that holds the key `{sender, recipient} + subject`: the two names in sorted order, so that
     either direction matches, and the subject without leading `Re:` and `Fwd:` (`stripReplyPrefix`, one anchored pass),
     with spaces folded and in lower case. The key is `JSON.stringify` of that list, so that no choice of names can make
     two keys equal;
  3. else it starts a thread.
  A thread takes the key of every message that joined it by rule 1 if no thread holds that key yet. Threads are never
  merged. A message with no subject has the key of its two parties alone.
- **Order.** The store keeps the newest message first (sorted by `at`); the function reads it from its end. A thread that
  gets a message moves to the end of a `Set`, so the result, reversed, has the thread with the newest message first.
- **A thread** is `{ id (its first message), subject (without Re:), title (the subject, else the first line of the first
  body), who (names in order of appearance), items (oldest first), last }`.
- **The answer** is an ordinary user message (`POST /api/messages`, `UserMessageRequest`) built by the comm loop's
  `Reply`: `to` an agent of the thread, `subject` `Re: <thread subject>` (empty when the thread has none), `body`,
  `inReplyTo` the newest message of the thread, so that it joins the thread by rule 1 once the hub shows it.
  `repliers(thread)` names the agents the Director can write to (not `user`, not `name@station`): the one that spoke last
  first (when only the Director spoke, the one he wrote to last). With two or more a select offers the rest; with none (a
  thread only with another station) there is no box.
- **The page** (`src/client/PartyLine.tsx`, `partyline.css`): view `party` of the store, `showParty`. No key of its own: the top
  bar (nine keys at 1280 px) and the phone bar (eight keys in 390 px) are full, so the Patch Panel opens it (the line "Party Line"). A row is a button
  (`aria-expanded`); it opens in place. The heading takes focus on arrival, as the Downlink's does. At most 100 threads are
  drawn.
- **Names.** "Party Line" is the shared voice circuit of the control room, one conversation on one line. It clashes with
  no call sign, Loop, Brief, Wall or other feature name.
- **The bars.** The eighth key needed room: below 1400 px the top bar hides the folder text and its keys take 12 px at the
  sides (they fit on one line at 1280 px), below 1600 px the long name of the unit gives way, and the phone bar has 3 px
  between its keys and 6 px at the sides so that eight keys are at least 44 px wide in 390 px (`shell.css`).

## Limits

- `shortcut: threads are built from the messages the page holds (the newest 200, bodies cut to 2000 characters; the newest
  100 right after a restart), when older conversations matter: a server route that groups the whole of messages.jsonl.`
- `shortcut: a conversation is the same two parties and subject, so a repeated subject (a schedule, a brief) is one
  thread however long, when that is too coarse: a time gap that starts a new thread.`
- A reply to a message that left the list starts a thread by rule 2; it is not tied back to the old one.
- Only the two ends of a message count as parties: a message from `ana` to `ben` with a reply from `cy` that does not use
  `in_reply_to` is two threads.

## Tests

`test/client-threads.test.ts`: the prefix strip (and a subject of 50000 prefixes), both rules and their order, an agent that names a message of a conversation it is not in, the Director answering in a thread of other parties, other
parties or subject, no subject, a reply to a message that is not in the list, a message that replies to itself, names that
look like object keys or hold the separator of a key, 200 messages, the order of the result, the list not changed,
`repliers` and the answer built for a thread. `test/client-store.test.ts`: `showParty`. Looked at in Chrome, with the
stand-in agent, at 1440 and 390 px in Instrument and Night Shift; the top bar measured at 1280 px.
