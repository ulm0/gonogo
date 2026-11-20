# Party Line: threads

<PartyLineMock class="doc-mock" />

The THREADS tab of [COMMS](./comms.md) (top bar, or `Comms: threads` in the Patch Panel, Cmd+K or Ctrl+K) shows the room's messages as conversations. Design and limits: [`docs/party-line-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/party-line-spec.md).

## What is a thread

Messages carry no thread id. Two things group them:

- **A reply chain.** A message whose `inReplyTo` is a message on the page joins that message's thread when you send it or the sender is one of that message's two ends. An agent naming a message of a conversation it is not in is not added. Agents set `in_reply_to` in `send_message`; your answers from the comm loop, [Downlink](./downlink.md) and Party Line set it, as do Slack or Telegram replies to a message [Relay](./relay.md) forwarded.
- **Same two parties and same subject** (either order). A leading `Re:` or `Fwd:` (any number, any case), case and spacing do not count. No subject: all subjectless messages between the two are one thread, titled by the first line of the first. Your briefs to FLIGHT (subject `Brief`) are one thread; a [Launch Window](./launch-window.md) schedule or an [Uplink](./uplink.md) is one thread per agent it sends to.

Threads are never merged; the right subject with other parties starts its own.

## The page

- One row per thread, newest message first: time, parties (call signs, DIRECTOR for you), title, count, and a chip when the newest is TO YOU, HELD or UNDELIVERED.
- A row opens in place: messages oldest first with route, time, text (`...(cut)` after 2000 characters), a bar on yours, chip and reason.
- The reply box sends as you via `POST /api/messages` to the agent that spoke last (if only you spoke, the one you wrote to last), subject `Re: <subject>`, in reply to the newest message. SEND TO picks another agent when there are two or more.
- A thread only with another station has no box (you cannot write to `name@station`).
- The newest 100 threads are drawn. ROOM goes back.

## Limits

Built in the page from the newest 200 messages (bodies cut to 2000 characters); after a restart the newest 100 from `messages.jsonl`. A thread whose first messages are gone starts at the oldest left. No option, file or route.
