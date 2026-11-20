# Comms: inbox, traffic and threads

<CommsMock class="doc-mock" />

COMMS (top bar, or COMMS on a phone) is the one place for what is said in the room: three tabs, each the view it was, with the same data and keys. Design: [`docs/comms-analysis.md`](https://github.com/ulm0/gonogo/blob/main/docs/comms-analysis.md).

| Tab | What it is | Was |
|---|---|---|
| **INBOX** (default) | Messages to you and what the server noticed; read and archived kept on the server; unread count; keys `j k e r`. [Details](./downlink.md) | the Downlink |
| **TRAFFIC** | Every message, newest first; filters ALL, TO YOU, HELD, UNDELIVERED; AGENT picker; BRIEF box to FLIGHT at the foot | the comm loop |
| **THREADS** | Messages grouped as conversations, with a reply box. [Details](./party-line.md) | Party Line |

- The count on COMMS and INBOX is the Downlink's unread count. A notification opens INBOX.
- COMMS opens the tab you used last (kept in this browser). Patch Panel lines `Comms: inbox`, `Comms: traffic`, `Comms: threads` open one; the old words (loop, downlink, party line) still find them.
- A console's "Comm loop" link opens TRAFFIC filtered to that agent; pick `everyone` to see all.
- On a phone the tabs are three large keys; COMMS replaces the LOOP and DOWN keys, and the freed top-bar key goes to MISSIONS.
- The terminal client is unchanged: its INBOX screen is the inbox.
