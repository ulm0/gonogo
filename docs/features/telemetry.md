# Telemetry: what an agent did

<TelemetryMock class="doc-mock" />

Open the **TELEMETRY** fold in a console's panel to see the tool calls that agent made, newest first: when each started, the tool, how long it took (or `running`, or `failed`), a bar scaled to the longest call in the list, and what it ran (the command, the file, the pattern). The list refreshes every 5 seconds while the fold is open. It comes from the hooks gonogo already gets: Claude Code reports every tool call and its failures; Gemini CLI reports its tool calls but not their failures; the other engines and custom commands report none, so their list stays empty.

gonogo keeps the newest 200 calls per agent, in memory and in `telemetry.jsonl` in its home (see [Configuration](../reference/configuration.md#state-on-disk)), so the list survives a restart of gonogo. A call that was still running when gonogo stopped is not kept. `GET /api/agents/:name/telemetry` returns the same list as JSON.
