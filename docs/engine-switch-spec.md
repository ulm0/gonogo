# Spec: Engine switch

Written and built 2026-11-24. Engine Bay (`docs/engine-bay-spec.md`) picked the engine at hire time only. When one
vendor's quota runs out, the agents on it had to be removed and hired again on another engine. An engine switch moves
an agent, flight included, to another engine and keeps its name, role, folder, worktree, keys and position.

## Design

- **One field of the edit.** `EditRequest.provider` (PATCH `/api/agents/<name>`) is the new engine. Any engine except
  `custom`, for any agent (the boss too), with any model the new engine takes. `custom` is never one end of a switch: a
  custom command has no engine to keep, and the other way round needs a command.
- **The request is checked against the new engine.** A model or an effort in the same request is for the new engine
  (400 with the field if it takes none). A setting the request did not name and the new engine does not take is dropped:
  the model (a name of the old engine's), effort, Payload items it does not take, Clean Room, Remote Control and tool
  rules. A CLI without permission modes runs `default`. The Downlink names what was dropped (`startup` event).
  `bypassPermissions` carried to an engine with modes needs `confirmBypass: true` again.
- **A new session.** The record gets a new session id: a Claude Code conversation cannot go on in another CLI. A switch
  back to Claude Code starts a fresh conversation too.
- **Handoff** (`src/server/handoff.ts`). After the switch is saved and before the new engine starts, the hub calls
  `HubIo.writeHandoff(old record, new record)`. The launcher reads the old session's transcript (Claude Code:
  `<config>/projects/*/<id>.jsonl`; pi: `agents/<name>/pi-sessions/*_<id>.jsonl`, the path from the last entry to the root),
  keeps user and assistant text only (no tools, thinking, meta or subagent lines), the newest 30 turns within 24,000
  characters (4,000 per turn), and writes `agents/<name>/handoff.md` (0600). Its first line names the new session id; a
  start whose session id matches gets a line in its role text that tells it to read the file first. Read only, never
  fails a switch; an engine whose transcript is not read gets a handoff that says so.
- **When it applies:**
  - stopped: the edit is saved, nothing starts;
  - idle, needs you (not a Redline trip or a Hold), starting: saved, and the agent restarts at once on the new engine;
  - working: the **whole** edit waits in memory (`AgentView.pendingEngine`) until the turn ends, so the running Claude Code
    keeps its record (its hooks, its screen rules) to the end. The end of a turn (Stop, StopFailure, or the agent
    stopping or crashing) queues the edit on the agent's operation queue, where it is checked again and applied. A
    stopped agent is not started for it.
  - `switchNow: true` with the request applies it at once, in the middle of a turn. `switchNow: true` alone applies the
    pending one. The engine the agent runs on cancels a pending switch. A new switch replaces a pending one.
- **Mail waits for the switch.** While a switch is pending, the Stop hook hands nothing over (no block) and the
  delivery check types no pointer: the note reads `waiting: <name> is switching to <engine>`. After the switch the
  mail goes to the new engine. One without the gonogo tools (pi and the others with `mcp: false`) can never read it: what
  waited is `undelivered` with `<name> now runs <engine> without the gonogo tools; the message went to the user`.
- **A switch that fails when it applies** (a folder that is gone by then, a save that fails) is dropped; the Downlink
  says why and the agent goes on on its engine.
- **Form.** The edit form shows the Engine select (not for a custom command). Picking another engine clears the model
  and effort and hides what it does not take, as on a hire; picking the one it runs on again brings the form's own
  values back. On a running console, SAVE keeps the switch for the end of the turn and SAVE AND RESTART sends
  `switchNow`. A pending switch shows in the form with SWITCH NOW and CANCEL SWITCH.

## Known limits

- shortcut: the pending edit lives in memory only; a gonogo restart forgets it (the agent stays on its engine). Upgrade
  if switches are often pending across restarts.
- shortcut: an edit without `provider` made while a switch is pending applies at once, and the pending one then applies
  its own fields over it. Upgrade if both are used together.
- A turn that never ends (a Claude Code that hangs without a Stop or StopFailure hook) keeps the switch pending: SWITCH
  NOW is the way out. Whether Claude Code fires StopFailure when the plan's quota is used up was not checked.
- A boss on an engine without the gonogo tools gets no mail and cannot hire, poll or plan; the room says so only through
  the engine's `no mail` note.
- Tested with the hub's fakes and the form's renderer, not with real CLIs.
