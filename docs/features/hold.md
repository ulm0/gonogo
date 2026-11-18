# Hold: stop one agent until you say so

<HoldMock class="doc-mock" />

Press **Hold** in a console's row of actions (on a phone, under **More**) to put that agent on hold. Hold is a [Redline](./redline.md) trip that you ask for: a working agent gets an Escape, which interrupts its turn, the console shows `needs you` with the reason `on hold`, and its mail waits (`held: <name> is on hold`) until you press **RESUME** (or `POST /api/agents/:name/resume`) or **STOP**. Typing into its terminal also ends the hold, as do a restart and a stop. A hold does not show in the [Downlink](./downlink.md), because you did it. `POST /api/agents/:name/hold` does the same as the key.

Hold is offered while the agent is idle or working. An agent that is asking you something must be answered first. Only engines with hooks can be held (Claude Code and Gemini CLI); custom commands and the other engines cannot.
