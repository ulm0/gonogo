# Analysis: Loop, Downlink and Party Line, one view or two? (draft)

By FIDO, 2026-11-18, task t54. For discussion, not a build; later version. Read from `Activity.tsx`, `loop.ts`, `Downlink.tsx`, `inbox.ts`, `PartyLine.tsx`, `threads.ts`, `App.tsx`, `notify.ts`, `tui-render.ts` and the three feature pages on `origin/main`. Nothing run.

"All traffic" is not a view of its own: it is the **Loop** (the list is the whole room's mail, and its filter ALL is the whole room). The third view is **Party Line**.

## What each shows

| View | What it shows, for whom | Source | Open from |
|---|---|---|---|
| **Loop** | Every message in the room, newest first (agent to agent and to or from the Director), with a status chip (queued, held, delivered, read, undelivered, to you). Filters ALL, TO YOU, HELD, UNDELIVERED. Reply in place; the BRIEF box to FLIGHT sits at its foot. For the Director who wants to *watch the room talk*, and see why a message did not arrive. | `store.activity` (the hub's `ActivityItem`s, newest 200 in the page; bodies cut) | top bar LOOP, phone LOOP, a per-console "Comm loop" panel with a link |
| **Downlink** | The Director's **inbox**: messages sent to `user` **plus events** (Redline trips, T-minus results, failed schedules, refused uplinks, blocked tasks, Relief, permission asks). Unread first, **read and archived kept on the server**, so phone and desk agree. Filters ALL, MESSAGES, EVENTS, ARCHIVED. Keys `j k e r`. For the Director who wants *what needs me*. | `store.downlink` (the server's own list, with read state and `unread` count) | top bar DOWNLINK with the unread badge, phone DOWN |
| **Party Line** | The **same messages as the Loop**, grouped into conversations (reply chain, or same two parties and subject); a thread opens with its messages in order and a reply box. For the Director who wants to *read a conversation*. | the same `store.activity`, grouped in the page (`threads.ts`) | Patch Panel only |

## The overlap

- A message to the Director is in the Loop (filter TO YOU) **and** in the Downlink (MESSAGES), with two different notions of "new": the Loop has none, the Downlink has read and archive. Reply is in both, and in Party Line: **three reply boxes** for the same message.
- Party Line is the Loop with a different grouping; it adds nothing to the data.
- What is **only** in one: held and undelivered status and agent-to-agent mail (Loop, Party Line); events, read state, archive and the badge (Downlink).
- Notifications (`notify.ts`) and the TUI inbox read the **Downlink** list; a notification click opens the Downlink.

The confusion is real: two names (Loop, Downlink) for lists that both contain "my messages", and a third reached from somewhere else.

## Options

### A. One view, COMMS, with three tabs (pick)
One view `comms` replaces LOOP and DOWNLINK in the top bar and Party Line in the Patch Panel. Inside, a tab bar with a remembered choice:
- **INBOX** (default; the Downlink as is): messages to you and events, read/archive/badge. This answers "what needs me".
- **TRAFFIC** (the Loop as is): every message, with filters ALL, TO YOU, HELD, UNDELIVERED, and a new agent filter; the BRIEF box at the foot.
- **THREADS** (Party Line as is).
Same data, same server state, same keys inside each tab; **no data is merged**, only one door.

### B. Two views, renamed
**INBOX** (the Downlink: what needs the Director, with read state) and **TRAFFIC** (Loop and Party Line in one, with a LIST | THREADS switch). Party Line leaves the Patch Panel list.

### Compared
| | A: Comms, 3 tabs | B: Inbox + Traffic |
|---|---|---|
| Top bar | **frees one key** (LOOP and DOWNLINK become COMMS) | no key freed (LOOP renamed TRAFFIC, DOWNLINK renamed INBOX) |
| Phone bar | LOOP and DOWN become **COMMS** with the unread badge: **frees one slot** of eight | stays eight |
| Clarity | one place for everything said; the tab names carry the difference | two places, the names carry it |
| Cost | tab shell and re-pointing; the three bodies are reused | rename and a Party Line switch |
| Risk | the badge and the notification target must keep meaning "the inbox tab" | none new |
| Loses | one-click Loop and one-click inbox become one click plus a tab (mitigated: a remembered tab, and the badge opens INBOX) | nothing |

**Pick A.** It is what the Director asked (one place), it is the only option that frees a top-bar key and a phone slot, and it costs little because nothing is merged underneath: the confusion was about doors, not data. The inbox tab stays the default and carries the badge, so "what needs me" is still one click away.

## Details for A

- **Names.** The view is COMMS; tabs INBOX, TRAFFIC, THREADS, each with a one-line hint under the tab bar ("Messages to you and what the server noticed", "Everything the agents send each other and you", "The same messages as conversations"). Doc pages merge into `docs/features/comms.md` with the old pages kept as redirects.
- **Reply.** One reply box component (it already is one: `Reply` in `Activity.tsx`), still per message and per thread; no change to who gets the answer.
- **Phone.** One column, the tab bar as three large keys (44 px, as the other keys); the INBOX list is the default and keeps `j k e r` off (no keyboard). The per-console "Comm loop" panel keeps its link, which opens COMMS on TRAFFIC with that agent filtered.
- **Top bar and the Patch Panel.** Top bar: COMMS (with the unread badge) replaces LOOP and DOWNLINK. Patch Panel: "Comms: Inbox", "Comms: Traffic", "Comms: Threads" as three commands (so Party Line is still one keystroke away, and the old names still match by their `also` words).
- **Notifications.** The click target stays "the inbox", now `comms/inbox`. The tab title count and the badge are unchanged (they are the Downlink's `unread`). No new notification.
- **TUI.** Unchanged. Its INBOX screen is the Downlink list and stays; TRAFFIC and THREADS are not in the TUI's first scope and are not added.
- **Saved filters.** There are none to migrate: every filter is component state today, and the page stores no filter key (`readStored` keys are the selected console, the livery and the like). The new remembered tab is one `localStorage` key. Internally the view ids `loop`, `downlink` and `party` stay as **aliases** of `comms` with a tab, so `showLoop()`, `showDownlink()`, the Patch Panel actions and the notification code keep working without edits; a deep link or bookmark to `#loop` or `#downlink`, if one exists, lands on the right tab.
- **Server.** No change: no route, frame or file.

## Scope of one PR

`Comms.tsx` (tab shell and the remembered tab), the three bodies mounted unchanged inside it, the agent filter on TRAFFIC, the aliases in `store.ts`, the top bar and phone bar edits, the Patch Panel commands, the notification target, the per-console link, `docs/features/comms.md` (the three pages shortened to point to it), the existing component tests re-pointed plus tests for the tab memory, aliases, badge on the phone, and the agent filter. About 350 lines, mostly moves. **Left out:** merging the data or the read state of the Loop into the inbox, a single mixed list, saved server-side views, TUI traffic, search.

## Open questions for the Director

1. Is "COMMS" the right name, or keep one of the old words (LOOP, DOWNLINK)?
2. Should the default tab be INBOX (what needs you) or TRAFFIC (what is being said)?
