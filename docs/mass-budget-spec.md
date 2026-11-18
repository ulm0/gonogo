# Spec: Mass Budget

Written and built 2026-11-18. Feature of backlog section 3 (Memory), "Reflection: summarising `memory.md` so that it does not
grow without bound". Reflection is the backlog's word; the feature is named Mass Budget: what an agent carries into every
session is the size of its notes.

## Intent

Each agent keeps notes in `agents/<name>/memory.md`, and its role text says to keep the file under 200 lines. Nothing checks it, so
the file grows. The Director sees the size in the console panel and, with one key, asks the agent to condense its own file.

## Design

- **gonogo never writes `memory.md`.** The agent may be writing it, and two writers would lose one of the two edits. gonogo reads
  its size and sends a message; the agent rewrites the file. The only file gonogo writes is the copy below.
- **The size** (`GET /api/agents/:name/memory`, `src/server/massbudget.ts`): `{ exists, bytes, lines, softLines, softBytes, over,
  changedAt, backup }` (`MemoryView`). `lines` counts newlines, plus one for a last line without one. `over` is true above 200 lines
  or 16 KiB (`MEMORY_SOFT_LINES`, `MEMORY_SOFT_BYTES`: what 200 lines of notes come to), never at the limit. A file over 1 MiB
  (`MEMORY_READ_MAX`) is not read: its `lines` is null and it is over. `exists` is false before the agent's first start (the
  launcher makes the file then). The soft limit warns; it blocks nothing.
- **The request** (`POST /api/agents/:name/reflect`, 201, `{ send, memory }`): one message from the Director through
  `Hub.sendFromUser`, subject `Mass Budget: condense your memory file`, so Max Q, Redline, held mail and the draft latch apply as to
  any message. The body (`reflectBody`) names the file, its size, the copy, and asks the agent to: read all of it; write at most 100
  lines (`MEMORY_TARGET_LINES`) keeping decisions and their reasons, rules, paths, commands, names, ids and open problems, and
  dropping what is done, repeated, replaced or a step-by-step log, adding nothing that is not in the file; move what every agent should
  know to the Mission Log with `log_write`; replace the file in one write, keep the first line `# Memory of <name>`, touch no other
  file; then `send_message` to `user` with the subject `Memory condensed` and the lines before and after, or say why nothing changed.
- **The copy.** The bytes gonogo read are written to a temporary file in the agent's folder (mode 0600, `wx`), the message is sent,
  and when the hub took it (`send.ok`) the file is renamed to `memory.md.bak`, replacing the one before. When the hub did not
  deliver (a stopped agent, an engine without the gonogo tools: `ok` false, or a thrown `HubError`) the temporary file is removed
  and the older copy stays. When the hub took the message but the rename failed (a folder an agent left at `memory.md.bak`), the
  message stays sent, the failure is logged, the temporary file is removed, `backup` is null and the page says no copy was kept. There is one copy, of the file as it was when the last request was sent. gonogo only looks at its
  size and time, and never restores or removes it.
- **What happened since** is worked out from the two files, with no state of its own: `backup.at` (the copy's time, when it was
  asked) against `changedAt` (the time of `memory.md`). The panel says "Asked at 14:03. The notes changed since: 18.6 KB then, 3.0 KB
  now" or "The notes have not changed since". An agent that only appended a line also counts as a change.
- **The panel** (`MassBudget.tsx`, `mass.ts`, `mass.css`): under the console's header (on a phone, under MORE): the name, `memory.md`
  and its size, REFLECT, the warning in the saffron tint, and what is known of the last request. Asked when the console opens and when
  the agent's state changes (it may have just written). REFLECT is inactive while the agent is stopped or changing state, while the
  file does not exist, and while a request is going out. Shown for agents that have the gonogo tools (`providerInfo(...).mcp`); a
  custom command has no memory file.
- **Security** (`docs/reference/security.md`). Both routes are the browser's (token, Host and Origin checks). The name must match
  the agent name pattern and be an agent, so no path comes from the request. The file is opened with `O_NOFOLLOW | O_NONBLOCK`: a
  symbolic link is refused (`conflict`), so is anything that is not a regular file (a named pipe does not make the open wait), and
  at most 1 MiB is read. The copy goes through a temporary file and a rename, which replaces a link standing at `memory.md.bak` instead
  of writing through it. One request per agent at a time (`conflict`). The text of the notes is not logged or put in an error.

## Decisions

- **No `Reflect` message of its own for agents:** it is an ordinary message, so an agent needs no new tool and the Mission Log
  hand-off in the body is the agent's choice to follow.
- **The copy is made after the hub takes the message, from the bytes read before it.** A request the hub refuses must not replace a
  good older copy with the file as it is now; and the copy must not be taken later than the message, because the agent may rewrite
  at once.
- **No frame, no saved state, no option.** The size is read when the panel asks, the history of a request is in two file times.
- **Soft limits are constants** (the role text's 200 lines, and the bytes that come to). See the limits.

## Rejected

- gonogo summarising the file itself (a model call from the server, or text rules): it would write a file the agent may be writing.
- Restoring the copy from the page, or several copies with dates: not asked for; `cp memory.md.bak memory.md` does it.
- A count in the room's tiles, or a Downlink item when a file goes over: the brief says the panel.

## Known limits

- shortcut: the soft limits are constants; make them options if agents are meant to keep more notes (`massbudget.ts`).
- shortcut: a file over 1 MiB cannot be copied or asked about from the page; trim it by hand.
- Whether a real model condenses well, keeps what matters and answers is not known: the stand-in agent only reads the message.
- An agent in a Clean Room keeps its notes in the same file under `agents/<name>/`, which the container mounts at the same path
  (`cleanroom.ts`), so the same request applies; not tried with real Docker.
- The size on screen is as of the last ask: an agent that writes while the page is open shows the new size at its next state change.
- Tested with a temporary folder (the module: sizes, limits, links, pipes, folders, copies kept and replaced, a refused request, a
  double ask), the client words, the edge routes with a fake, and a real server with the stand-in agent (scenario 34). The page was
  opened in Chrome at 1440 and 390 px in Instrument and Night Shift against a real server with the stand-in agent; the click was made by
  script, not by hand or with a screen reader.
