# Spec: Feature toggles (draft)

Design by FIDO, 2026-11-18, task t41a. Status: draft, not built. The dependency list below is read from the feature pages, `web.ts`, `mcp.ts` and the client's views; the builder must re-check each row against the code
when the table is written (a wrong row is a bug in the table, one line to fix).

## Intent

gonogo has grown to about 30 features. A Director who runs two agents does not want Max Q, Static fire, Docking and Relay on the screen, in the Patch Panel, in the agents' tool lists, or answering on the server. Turning a feature off must be **true**: the
page hides it, the server refuses it, the agents' tools disappear, background work stops. Nothing is ever deleted: the files stay, and turning it on again brings the data back.

## Design

- **A registry, not scattered ifs** (`src/shared/features.ts`, pure data, tested): one row per feature `{ id, label, group, core, requires: id[], enhances: id[], impact: string[], surfaces: { views, commands, mcp, routes, background } }`.
  `requires` is a hard dependency (cannot be on without it). `enhances` is soft: the other feature works but loses something, said in `impact`. Both the server and the client read this one table, so the page cannot disagree with the server.
- **The saved state** is `<home>/features.json` `{ version: 1, off: ['static-fire', ...] }`, mode 0600, same atomic writer; **only the off ids are stored**, so every new feature is on after an upgrade and an unknown id is ignored. A damaged file is kept as `.bad` and everything is on.
- **Changing it is a plan first.** `PUT /api/features` `{ off: [...], confirm?: true }`. Without `confirm` the server answers a **plan** `{ turnOff: [...asked], forced: [...also off because they need one of them], turnOn: [...needed by something you turn on], degraded: [{ id, lines }], blocked: [{ id, why }] }` and changes nothing. With `confirm` it applies
  that same plan (recomputed, so a stale page cannot apply an old one). The impact the Director reads in the page is the server's own plan, never a copy.
- **Enforcement, one gate per surface, all driven by the table:**
  1. **Routes.** A prefix-to-feature table in `web.ts`; a request for an off feature answers `404 { error: "<label> is off", code: "feature_off" }` before the handler runs. The uplink endpoint `/uplink/:id` answers 404 like an unknown id. Dock routes likewise.
  2. **MCP tools.** The server is stateless (a server object per request), so `tools/list` is built from the on features, and a call to an off tool still answers `{ ok: false, error: "<label> is off" }` (an agent that cached the list). `--allowedTools` and the role text at the next start list only the on tools. Hidden at once for new sessions, refused at once for running ones.
  3. **Hub and background work.** Max Q off: the limit is ignored and no mail waits for load. T-minus off: no poll, `go_nogo` gone. Relief off: `hire_agent` gone, pending requests dropped with a Downlink note. Telemetry off: the tool-hook recorder is not called. Black Box off: the audit writer does nothing (the git record stays as it is).
     Launch Window off: timers stop and **a missed schedule does not catch up** on re-enable (said in the impact). Uplink and Relay off: the endpoint and the forwarding stop. Propellant off: the transcript meter stops and its limits are not enforced (the cursor is kept, so the gap is counted when it is turned on again: said in the impact).
  4. **The page.** `features` is in the snapshot and in a `features` frame. One hook `useFeature(id)` gates the top-bar keys, the phone bar, the Patch Panel lines (`commands()` takes the list), the wall modules, console folds (Telemetry, Mass Budget, Recorder, Hangar) and views. A view whose feature went off while open falls back to the Room. The Flight Rules block itself is core.
- **Core: cannot be turned off, and why.** Roster, hire, edit, start, stop, mail (`send_message`, `list_roster`, `read_messages`): nothing works without them. **Downlink**: the inbox where mail to the Director lands. **Redline and Hold**: the only automatic brake, and Hold is a Redline trip the Director asks for;
  Propellant limits, Cost budgets and Static fire's safety ride on it; the existing `GONOGO_REDLINE=off` stays an operator's override for the first three detectors only (loop, error storm, ping-pong), not a page switch. **Flight Rules, Patch Panel, Clearance (keys), Engine Bay**: the controls for everything else. **Mission clock on the wall**: shows without Missions (the brief guess).
  **Notifications** are per browser and have their own switch in Flight Rules; they are listed in the block as "this browser", not saved in `features.json`. Per-agent opt-in features (Clean Room, worktrees, Payload, permissions, default models, remote control) are off until chosen for an agent and need no room switch.

## The table (rows to verify when written)

| Feature | Needs (hard) | Also affects when off |
|---|---|---|
| Max Q | none | no load governor; the wall block goes; mail is never held for load |
| T-minus poll | none | `go_nogo` gone; **Static fire** forced off; the wall block goes; the Downlink loses T-minus events |
| Static fire | T-minus poll | the SIMSUP/RETRO ritual is gone, the poll remains |
| Relief | none | `hire_agent` gone: FLIGHT can only tell the Director to hire; the page asks nothing |
| Flight Plan | none | task tools gone; **Missions** forced off; Docking loses task hand-off |
| Missions | Flight Plan | mission tools gone; the wall falls back to the brief guess; Mission key hidden |
| Mission Log | none | `log_*` tools gone; Star Chart forced off |
| Star Chart | Mission Log | the chart and links views |
| Plot Board | none | `board_*` tools gone; the board view |
| Party Line | none | the threads view |
| Telemetry | none | the tool-call fold; nothing else reads it |
| Black Box | none | no audit record; the git record stays |
| Propellant | none | no tokens meter, **no spend brake**: token limits and budgets do not trip Redline; **Cost** forced off |
| Cost | Propellant | dollars, prices, budgets |
| Mass Budget | none | the memory-size fold |
| Hangar | none | the file view; **Recorder** forced off |
| Recorder | Hangar | git view, commit; **Review** forced off |
| Review | Recorder | `review_*` tools, notes, verdicts |
| Launch Window | none | schedules stop; no catch-up |
| Uplink | none | webhooks answer 404; **Relay** forced off |
| Relay | Uplink | Slack/Telegram/GitHub/Linear in and out stop; **Phone approvals (Telegram path)** degraded |
| Phone approvals | none | the Telegram buttons and the Remote Control choice (degraded when Relay is off, not forced) |
| Docking | none | no link to another station |
| Livery | none | the theme editor and `livery_submit`; the current theme stays |

## The block in Flight Rules

FEATURES lists the rows by group (Room, Records, Spend, Work, Outside, Look) with a switch, one line of what it is, and `needs X` / `used by Y` chips. Pressing a switch opens an inline panel with the server's plan: "Turning off T-minus poll also turns off Static fire. These lose something: Phone approvals (no go/no-go events)." and CANCEL / TURN OFF.
A row for a core feature has a lock and the reason on one line. The block is keyboard-complete and says the result in a live region. No top-bar key.

## Options

1. **A server-enforced registry (pick).** Off is true on every surface, tested from one table.
2. Hide it in the page only. Cheap, and wrong: the tools still answer, the schedules still fire, the budget still trips, so "off" would be a picture. Rejected.

## Scope of one PR (GUIDO or CONTROL)

`features.ts` (table, `plan()`, `isOn`) with the whole graph tested (no cycles, every `requires` exists, forced and degraded sets); `features.json` store; `GET/PUT /api/features`; the route gate; the MCP list filter and the call refusal; the hub and background switches for the rows above (each a one-line check at its seam);
snapshot and frame; `useFeature` and the gates in the top bar, phone bar, Patch Panel and wall; the Flight Rules block; `docs/features/features.md`. If the row count is too many for one PR, ship the table with the first 12 rows wired (Max Q, T-minus, Static fire, Relief, Missions, Telemetry, Black Box, Launch Window, Uplink, Relay, Docking, Cost) and the others marked "not switchable yet" in the table; the registry is the same.
**Left out:** per-agent feature sets, schedules for features, deleting data, a switch for Redline.

## Tests

The graph (cycles, unknown ids, forced and degraded sets, core refused); `plan` without `confirm` changes nothing; the same plan applied with `confirm`; a stale plan is recomputed; a route of an off feature is 404 `feature_off` and the same route works when on; `tools/list` omits off tools and a call is refused; a stand-in agent started after the change has no off tool in its allowed tools;
Max Q off: no mail held for load; Black Box off: no commit; Launch Window off: no catch-up; the page hides each gated key, view and Patch Panel line, and a view that goes off falls back to the Room; the file survives a restart; an unknown id and a damaged file are ignored.
