# Telemetry: what an agent did

<TelemetryMock class="doc-mock" />

The **TELEMETRY** fold in a console's panel lists that agent's tool calls, newest first: start time, tool, duration (or `running`, `failed`), a bar scaled to the longest call, and what it ran (command, file, pattern). Refreshes every 5 s while open.

- Source is the hooks: Claude Code reports every call and failure; Gemini CLI reports calls but not failures; other engines and custom commands report none (empty list).
- Newest 200 calls per agent, in memory and in `telemetry.jsonl` in the home ([Configuration](../reference/configuration.md#state-on-disk)); survives a restart. A call running when gonogo stopped is not kept.
- `GET /api/agents/:name/telemetry` returns the list as JSON.
