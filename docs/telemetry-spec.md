# Spec: Hold and Telemetry

Written 2026-11-18. Two backlog items (`docs/backlog.md` sections 4 and 7): a hold key for one agent, and a timeline of
the tool calls an agent made.

## Hold: one agent, by hand

Hold is a Redline trip that the Director asks for; there is no second mechanism.

- `POST /api/agents/:name/hold` (`Hub.hold`) trips the agent with the reason `on hold` (`HOLD_REASON`) instead of
  `redline: ...`. As with any trip: a working agent gets Escape, the state reads `needs_you` with `needsKind: 'redline'`,
  and its mail is held, with the note `held: <name> is on hold`. No Downlink event: the Director did it.
- It ends the way a trip ends: RESUME (`POST /api/agents/:name/resume`), STOP, a restart, an exit, or the Director typing
  into the terminal.
- Refused (`409 conflict`) unless the agent is `idle` or `working` with no stop, restart or remove running: one that needs
  you (answer it first), is already held or tripped, is starting or stopped. Refused too for an engine without hooks
  (custom commands, Codex and the other output-only engines), because without hooks the hub cannot keep it held.
- Client: a **Hold** key in the console panel's row of actions (on a phone, under **More**) while `holdable(agent)`. A held
  console's tile reads `on hold` and `ON HOLD` (or `<n> HELD`), its chip `· HOLD`, its flood and its foot `<LEGEND> IS ON
  HOLD` with STOP and RESUME. The matrix tile is a single button, so it has no menu to put a second key in.

Rejected: a hold that lets the current turn finish. While the hub holds an agent it reads `needs_you`, which a
working agent is not, so the turn is interrupted as Redline does.

## Telemetry: the tool calls of an agent

- The hub hands every `PreToolUse`, `PostToolUse` and `PostToolUseFailure` hook of an agent's current process to
  `HubIo.toolHook`; `src/server/telemetry.ts` records it. A failure of the recorder never touches the hub.
- A `PreToolUse` opens a call: start time, tool name, and the one-line summary that the tile shows as `doing`
  (`describeDoing`, at most 120 characters, no control characters). The Post hook with the same `tool_use_id` closes it
  with its duration and whether it failed. Gemini CLI's hook shim sends no id, so there the oldest open call of the same
  tool is closed, and Gemini has no failure hook. Engines without hooks have no telemetry.
- Bounds: `TELEMETRY_PER_AGENT` (200) calls per agent in memory, the oldest dropped first. `telemetry.jsonl` in the
  home gets one line per finished call; at start it is read back (a torn line is skipped) and rewritten with only the kept
  calls, and during a run it is rewritten the same way after every `TELEMETRY_FILE_SLACK` (2000) appended lines. So the
  file holds at most 200 calls per agent name plus 2000 lines, a few hundred kilobytes. It is a log: no `version`, no
  migration. A call that never got its Post hook (interrupted, or gonogo restarted) stays in memory as `running` and is not
  written.
- `GET /api/agents/:name/telemetry` answers `{ calls: ToolCall[] }`, newest first (`{ at, ms, tool, summary, failed }`,
  `ms` null while running). No frame: the panel asks when its TELEMETRY fold opens and every 5 s while it stays open.
- Client: the fold lists each call with its local start time, tool (gonogo's own MCP tools without their prefix),
  duration (`340 ms`, `4.2 s`, `3 m 05 s`, `running`, `· failed`), a bar scaled to the longest call in the list
  (decorative) and the rest of the summary.

## Known limits

- shortcut: calls are keyed by agent name; a renamed agent starts an empty list and a removed agent's calls stay in the
  file (bounded per name).
- Hook times are when gonogo received the hook, not when the tool ran, so a duration includes the hook's own trip.
- Not run with a real `claude` or Gemini CLI: the stand-in agent sends the same hooks with `tool_use_id`.
