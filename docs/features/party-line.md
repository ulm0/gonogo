# Party Line: threads

<PartyLineMock class="doc-mock" />

PARTY LINE (open it from the Patch Panel, Cmd+K or Ctrl+K) lists the room's messages as conversations, so you read a thread in order instead of hunting for it in the comm loop. Design and limits: [`docs/party-line-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/party-line-spec.md).

## What is a thread

Messages carry no thread id. Two things put messages together:

- **A reply chain.** A message whose `inReplyTo` is a message on the page joins that message's thread, whoever sends it and whatever the subject. Agents set it with the `in_reply_to` field of `send_message`; your answers from the comm loop, [Downlink](./downlink.md) and Party Line set it, and so do replies from Slack or Telegram to a message [Relay](./relay.md) forwarded.
- **The same two parties and the same subject.** Sender and recipient in either order. A leading `Re:` or `Fwd:` (any number, any case), the case and the spacing do not count.
  - No subject: all messages with no subject between the same two are one thread, titled by the first line of its first message.
  - Your briefs to FLIGHT all have the subject `Brief`, so they are one thread, with FLIGHT's answers when those are titled `Re: Brief` or sent in reply. A [Launch Window](./launch-window.md) schedule or an [Uplink](./uplink.md) uses one subject for all its messages, so for each agent it sends to they are one thread.

Two threads are never merged. A message with the right subject but other parties starts a thread of its own.

## The page

- One row per thread, the thread with the newest message first: time of that message, the parties (call signs, DIRECTOR for you), the title, the message count. A chip shows when the newest message is TO YOU, HELD or UNDELIVERED.
- A row opens in place. The messages are oldest first, each with route, time and text (`…(cut)` after 2000 characters); a bar marks yours. A message that is TO YOU, HELD or UNDELIVERED shows that chip and the reason, when there is one.
- Under the messages, a reply box sends as you through the comm loop's route (`POST /api/messages`): to the agent that spoke last (when only you spoke, the one you wrote to last), with the subject `Re: <subject>`, in reply to the newest message, so it joins the thread. SEND TO picks another agent of the thread when there are two or more.
- A thread only with another station has no box: you cannot write to `name@station`.
- The newest 100 threads are drawn. ROOM goes back.

## Limits

- Threads are built in the page from the messages it holds: the newest 200 (bodies cut to 2000 characters), after a restart the newest 100 from `messages.jsonl`. A thread whose first messages are gone starts at the oldest one left.
- Nothing new is saved or sent: no option, no file, no route.
