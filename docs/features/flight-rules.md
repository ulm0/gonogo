# Flight Rules: settings and Commissioning

<FlightRulesMock class="doc-mock" />

FLIGHT RULES (the ⋯ menu of the top bar, or the [Patch Panel](./patch-panel.md)) holds the room's settings in seven groups, one open at a time: **Room**, **Agents**, **Budget and limits**, **Automation and connections**, **Knowledge**, **Security** and **System and update**. Each setting is a row with its name, what it is now, and EDIT, which opens the setting in place (the table below names the block each row holds). COMMISSIONING is the checklist of an empty room. Design: [`docs/shell-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/shell-spec.md). Each setting is the same call as in its own place, kept on the server, so every device shows the same.

| Block (its row) | What |
|---|---|
| MAX Q, PROPELLANT | the wall's own modules, so a limit here is the wall's ([load governor](../guide/the-room.md#positions-t-minus-max-q-and-custom-agents), [Propellant](./propellant.md)). A phone has no Propellant module: set it here |
| DEFAULT MODELS | model per engine and per position when a console has none ([Engine Bay](./engine-bay.md#model)) |
| TAB NAME | name in the browser tab title (`<name> · gonogo`, `(3) <name> · gonogo` with unread items). Server-side, up to 40 characters, control characters removed; empty restores the default (`GONOGO_STATION`, else `gonogo`). `GET` and `PUT /api/tab-name` `{ "name": "..." \| null }`, file `<home>/tabname.json` |
| LIVERY | name in use, key to [Livery](./livery.md) |
| KNOWLEDGE (row "Switch and repositories"), SEMANTIC SEARCH | the Knowledge switch and its repositories ([Knowledge](./knowledge.md)); [semantic search](./semantic-search.md) of the Mission Log |
| ALL STOP (row "Hold all agents") | the key that holds every console that can be held ([Autostart](./autostart.md)) |
| LAUNCH WINDOW | key to schedules, [Uplink](./uplink.md), [Relay](./relay.md), [Docking](./docking.md) |
| CONSOLES | every console with EDIT (directory, role, engine, permission mode, payload). A console's own Propellant limit stays in its panel |
| THIS BROWSER | [notifications](./notifications.md) switch, PUSH TO THIS DEVICE ([phone app](./mobile.md)), SHOW COMMISSIONING AGAIN |
| PAYLOAD DEFAULTS | MCP servers and skill folders every agent gets; an agent's own Payload wins and can switch one off ([Payload](payload.md)). No value shown after saving |
| ROOM KEYS | environment variables (a Bedrock login, say) every agent gets; an agent's own Clearance key wins; a Clean Room agent gets only keys switched on for it ([Room keys](room-keys.md)). No value shown after saving |

## Commissioning

A module above the room while FLIGHT is the only console (an empty room). Four steps, each with a light and a key:

1. **Staff FLIGHT:** ticked when FLIGHT is idle or working (past its startup questions). OPEN FLIGHT opens its terminal.
2. **Set a Propellant limit:** ticked when any window has a limit. FLIGHT RULES opens the screen.
3. **Pick a livery:** ticked when the livery is not Instrument, or once you opened the Livery view from this key.
4. **Read the security note:** SHOW THE NOTE opens two short paragraphs (the token is a password, the server runs shells as you, an agent in `bypassPermissions` runs as your user, dock only with people you trust) and ticks the step. Full story: [Security](../reference/security.md).

PUT AWAY hides it; it also goes when a second console is staffed. The marks are kept in this browser only (`localStorage` key `gonogo.commissioning`): another device shows the checklist again, and a private window shows it every visit.

**ROOM RULES** is your text for every agent of the room, sent in each agent's role text at the start of a session ([Room rules](./door.md)); changing it asks for the password again, and it shows its size in bytes against the 8 KiB cap. **CLOSING CHECKLIST TEMPLATE** is the list every new mission copies ([Missions](./missions.md#the-closing-checklist)), with the same cap and the same password.

**SKILLS** lists the skill folders of the room and of each agent, who gets which, and adds or removes the room's; **Add from the list** in it and in PAYLOAD DEFAULTS picks a checked entry ([Registry](registry.md)).
