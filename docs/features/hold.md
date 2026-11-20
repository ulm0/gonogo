# Hold: stop one agent until you say so

<HoldMock class="doc-mock" />

**Hold** (console actions; **More** on a phone) is a [Redline](./redline.md) trip you ask for: a working agent gets an Escape that interrupts its turn, the console shows `needs you` with reason `on hold`, and its mail waits (`held: <name> is on hold`).

- **End it:** **RESUME** (`POST /api/agents/:name/resume`), **STOP**, typing into its terminal, or a restart.
- **API:** `POST /api/agents/:name/hold`.
- Not shown in the [Downlink](./downlink.md) (you did it).
- **Limits:** offered while the agent is idle or working; an agent asking you something must be answered first. Only engines with hooks can be held (Claude Code and Gemini CLI); custom commands and other engines cannot.
