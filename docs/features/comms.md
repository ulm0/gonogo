# Comms: inbox, traffic and threads

<CommsMock class="doc-mock" />

COMMS (top bar, or COMMS on a phone) is the one place for what is said in the room. It has three tabs over three views that used to be separate. Nothing is merged underneath: each tab is the view it was, with the same data and the same keys. Design and why: [`docs/comms-analysis.md`](https://github.com/ulm0/gonogo/blob/main/docs/comms-analysis.md).

| Tab | What it is | Was |
|---|---|---|
| **INBOX** (the default) | Messages to you and what the server noticed, with read and archived kept on the server, the unread count and the keys `j k e r`. [Details](./downlink.md). | the Downlink |
| **TRAFFIC** | Every message in the room, newest first, with filters ALL, TO YOU, HELD and UNDELIVERED, an AGENT picker, and the BRIEF box to FLIGHT at the foot. | the comm loop |
| **THREADS** | The same messages grouped as conversations, with a reply box. [Details](./party-line.md). | Party Line |

- **The count** on COMMS (and on the INBOX tab) is the Downlink's unread count. A notification opens the INBOX tab.
- **Your own words reach the agent as your turn.** A message from the BRIEF box (or the page's message form) while you are signed in, and a message from your private Telegram chat, are also typed into the agent's console as `[Director via web]` or `[Director via Telegram]` and your words, so a "go" counts as yours in auto mode. [Details and the risk](./relay.md#your-words-as-a-user-turn).
- **The tab is remembered** in this browser. COMMS opens the one you used last; the Patch Panel lines `Comms: inbox`, `Comms: traffic` and `Comms: threads` open a given one. The old words (loop, downlink, party line) still find them.
- **A console's "Comm loop" link** opens TRAFFIC filtered to that agent. Pick `everyone` in the AGENT picker to see the whole room again.
- **On a phone** the tabs are three large keys; COMMS replaces the LOOP and DOWN keys of the bottom bar, which leaves one key free.
- **The top bar** key this frees is given to MISSIONS.
- **The terminal client** is unchanged: its INBOX screen is the inbox.
