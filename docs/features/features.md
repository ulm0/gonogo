# Feature toggles: switch off what you do not use

<FeaturesMock class="doc-mock" />

Flight Rules -> **FEATURES** gives each feature of the room a switch. Off is **true**: the key leaves the top bar and Patch Panel, the server refuses its routes, agents lose its tools, background work stops. Nothing is deleted; turning it on brings the data back. Design: [`docs/features-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/features-spec.md). Tried with the stand-in agent only ([What was not verified](../reference/not-verified.md)).

## Switch one

- Press the switch. The server's plan shows what else goes off ("Turning off T-minus poll also turns off Static fire"), what turns on because it is needed, and what stays on but loses something. Nothing changes until you press TURN OFF or TURN ON.
- API: `PUT /api/features` with `{ off: [...] }`, then again with `confirm: true`. Apply sends the `expect` list of the plan shown; if the plan changed, 409 and nothing changes.
- **Needs:** a feature that needs another goes off with it. Static fire needs T-minus; Missions needs Flight Plan; Star Chart and Knowledge anchors need Mission Log; Recorder needs Hangar; Review needs Recorder; Relay needs Uplink.
- **Core, locked:** roster and mail, Downlink, Black Box, Redline and Hold (so ALL STOP and ALL RESUME stay), and the controls (Flight Rules, Patch Panel, Clearance, Engine Bay). Redline's detectors have their own switch, `GONOGO_REDLINE=off`.
- **A poll that is open** blocks turning off T-minus poll and Static fire: abort or clear it first.
- **Turning on** reaches a running agent at its next start (the plan names the agents to restart). Turning Max Q off releases held mail at once.
- **Saved** in `~/.gonogo/features.json`: the ids that are off, and `on`, the off-by-default features you switched on (new features are on, except Knowledge anchors, which is off until you turn it on; unknown ids ignored). An unreadable file is kept as `.bad` and everything is on.
- `start_agent` (the boss's tool for a stopped console) is not a feature: its switch is *FLIGHT may start agents*, in Start again after a restart.

## What off does

| Surface | Effect |
|---|---|
| Page | Top-bar and phone-bar keys, Patch Panel lines, wall blocks and console buttons are hidden; an open view falls back to the Room. Wall blocks T-MINUS and MAX Q of the [room editor](../guide/the-room.md) are not drawn (the layout keeps their place); the tray shows them "off in Features" with no RESTORE |
| Server | `404` with code `feature_off` and `"... is off"`, before the handler. Uplink's webhook endpoint and Docking calls answer as an id that is not there |
| Agents | Tools are not listed and a call is refused (by the MCP library, in its own words). A new agent also gets them left out of `--allowedTools`; a running one keeps its list but its calls are refused |
| Background | Max Q off: limit ignored, no mail waits for load. Director messages as user turns off: your messages reach an agent as the pointer only, and it reads your words as data. Telemetry off: tool hooks not recorded. Launch Window off: schedules do not fire, and **one that came due is not caught up**. Relay off: nothing forwarded. Static fire off: a poll with a subject is refused |

## What can be switched

- **Switchable:** Director messages as user turns, Max Q, T-minus poll, Static fire, Relief, Flight Plan, Missions, Mission Log, Knowledge anchors (off until you turn it on), Star Chart, Plot Board, Telemetry, Post-Flight Review, Mass Budget, Hangar, Recorder, Launch Window, Uplink, Relay, Docking, Livery.
- **Listed, not switchable** (the server refuses): Party Line, Propellant and Cost, Phone approvals.

## Limits

- Relief off leaves requests that already wait until they expire.
- Docking off stops its routes and calls; an open link is not closed.
