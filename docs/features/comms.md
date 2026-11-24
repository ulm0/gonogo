# Comms: inbox, traffic and threads

<CommsMock class="doc-mock" />

COMMS (top bar, or COMMS on a phone) is the one place for what is said in the room: three tabs, each the view it was, with the same data and keys. Design: [`docs/comms-analysis.md`](https://github.com/ulm0/gonogo/blob/main/docs/comms-analysis.md).

| Tab | What it is | Was |
|---|---|---|
| **INBOX** (default) | Messages to you and what the server noticed; read and archived kept on the server; unread count; keys `j k e r`. [Details](./downlink.md) | the Downlink |
| **TRAFFIC** | Every message, newest first; filters ALL, TO YOU, HELD, UNDELIVERED; AGENT picker; BRIEF box to FLIGHT at the foot | the comm loop |
| **THREADS** | Messages grouped as conversations, with a reply box. [Details](./party-line.md) | Party Line |

- **Needs you.** What waits on you is listed in one place, in the room under the BRIEF box (at the top of the room on a phone) and above the tabs of COMMS: a console that asks for a go or a permission (GO and NO-GO), a hire request (Relief), a handoff FLIGHT asks to send, and a message that asks you something. A go/no-go message has GO and NO-GO keys; a question has a reply box; **Mark handled** clears one that needs no answer. An answered one leaves the list. The same requests, answered in the room or in COMMS, clear in both.
- **How a message is known to ask:** it is unread and its subject or its first 400 characters say go/no-go or hold a question mark. There is no flag on the message for this yet, so a message with a question mark that is not a question can show up; Mark handled removes it.
- The count on the COMMS key is what needs you when something does (it says so in the key's name), else the Downlink's unread count. The count on INBOX is the Downlink's unread count. A notification opens INBOX.
- **Your own words reach the agent as your turn.** A message from the BRIEF box (or the page's message form) while you are signed in, and a message from your private Telegram chat, are also typed into the agent's console as `[Director via web]` or `[Director via Telegram]` and your words, so a "go" counts as yours in auto mode. [Details and the risk](./relay.md#your-words-as-a-user-turn).
- COMMS opens the tab you used last (kept in this browser). Patch Panel lines `Comms: inbox`, `Comms: traffic`, `Comms: threads` open one; the old words (loop, downlink, party line) still find them.
- A console's "Comm loop" link opens TRAFFIC filtered to that agent; pick `everyone` to see all.
- On a phone the tabs are three large keys; COMMS replaces the LOOP and DOWN keys, and the freed top-bar key goes to MISSIONS.
- The terminal client is unchanged: its INBOX screen is the inbox.
