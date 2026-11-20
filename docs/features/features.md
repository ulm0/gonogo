# Feature toggles: switch off what you do not use

<FeaturesMock class="doc-mock" />

Flight Rules has a block **FEATURES**: every feature of the room with a switch. Off is **true**: the key leaves the top
bar and the Patch Panel, the server refuses its routes, the agents lose its tools, and its background work stops. Nothing is
deleted: the files stay, and turning a feature on again brings its data back. Design and limits:
[`docs/features-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/features-spec.md). It was tried with the stand-in
agent only ([What was not verified](../reference/not-verified.md)).

- **A switch asks first.** Pressing it shows the server's own plan: what else goes off because it needs this one ("Turning
  off T-minus poll also turns off Static fire"), what is turned on because something you turn on needs it, and what stays on
  and loses something. Nothing changes until you press TURN OFF or TURN ON, and the server works the plan out again when you
  do (`PUT /api/features` with `{ off: [...] }`, then the same with `confirm: true`).
- **Needs and used by.** A feature that needs another goes off with it (Static fire needs T-minus, Missions needs Flight Plan,
  Star Chart needs Mission Log, Recorder needs Hangar, Review needs Recorder, Relay needs Uplink). The chips on each row say so.
- **Core features have a lock.** Roster and mail, Downlink, Black Box (an audit trail that can be switched off is not one: it records the switches themselves), Redline and Hold (so ALL STOP and ALL RESUME, which are Hold of every console, stay too), and the controls (Flight Rules, Patch Panel,
  Clearance, Engine Bay) cannot be switched off, and the row says why. Redline's automatic detectors keep their own
  operator switch, `GONOGO_REDLINE=off`.
- **What is saved.** `~/.gonogo/features.json` holds only the ids that are off, so a feature added by an upgrade is on, and an id
  this version does not know is ignored. A file that cannot be read is kept as `.bad` and everything is on.

## What off does, by surface

| Surface | What happens |
|---|---|
| The page | The wall blocks T-MINUS and MAX Q of the [room editor](../guide/the-room.md) are not drawn while their feature is off (the others settle around the gap, and the saved layout keeps their place, so turning the feature on puts them back); the editor's tray shows them as "off in Features" with no RESTORE. Its top-bar and phone-bar keys, Patch Panel lines, wall blocks and console buttons are not shown; a view that is open falls back to the Room. |
| The server | A request for an off feature answers `404` with code `feature_off` and `"… is off"`, before its handler runs. The webhook endpoint of Uplink and the calls of Docking answer as an id that is not there. |
| The agents | The tools of an off feature are not listed (`tools/list` is made for each request) and a call of one is refused. An agent started after the change has them left out of `--allowedTools` too; one that is running keeps the list it started with, and its calls are refused. |
| Background work | Max Q off: the limit is ignored and no mail waits for load. Director messages as user turns off: a message of yours reaches an agent as the pointer only, and the agent reads your words as data. Telemetry off: tool hooks are not recorded. Launch Window off: schedules do not fire, and **a schedule that came due is not caught up** when you turn it on again. Relay off: nothing is forwarded. Static fire off: a poll with a subject is refused. |

- **A poll that is open** blocks turning off T-minus poll and Static fire: abort or clear it first.
- **Turning a feature on** reaches a running agent only at its next start (its tool list is fixed when it starts); the plan names the agents to restart. Turning Max Q off lets the mail it held go at once.
- **The server checks the plan you read.** Applying sends the `off` list of the plan that was shown (`expect`); if the plan is not that any more, it answers 409 and changes nothing.

- **`start_agent`** (the boss's tool for a stopped console) is not part of a feature: it has its own switch, *FLIGHT may start agents*, in Start again after a restart.

## What can be switched

**Switchable now:** Director messages as user turns, Max Q, T-minus poll, Static fire, Relief, Flight Plan, Missions, Mission Log, Star Chart, Plot Board,
Telemetry, Post-Flight Review, Mass Budget, Hangar, Recorder, Launch Window, Uplink, Relay, Docking, Livery.

**Listed, not switchable yet** (the row says so, and the server refuses): Party Line (a view of the messages, with no server
side), Propellant and Cost (the spend brake would have to be reworked so that "off" is not a way to lose the limit),
Phone approvals.

## Limits

- Turning Relief off leaves the requests that already wait until they expire.
- Docking off stops its routes and calls; a link that is already open is not closed.
- A call of an off tool is refused by the MCP library, with its own words, not "… is off".
