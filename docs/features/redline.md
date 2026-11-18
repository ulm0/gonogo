# Redline: the circuit breaker

<RedlineMock class="doc-mock" />

gonogo stops a Claude agent by itself on:

- **Loop:** the same tool with the same input 5 times in a row.
- **Error storm:** 8 failed tool calls within 2 minutes, or 3 API errors within 10 minutes.
- **Ping-pong:** more than 15 messages to the same recipient within 10 minutes.
- **Propellant:** a token limit reached.

A working agent gets an Escape, which interrupts its turn. It then shows `needs you` with a reason starting `redline:`, and its mail is held (`held: redline on <name>`) until you press **RESUME** (or `POST /api/agents/:name/resume`) or **STOP**. Typing into its terminal, a restart or a stop also ends the trip.

Custom agents and engines without hooks are never tripped. Gemini CLI agents trip on loop and ping-pong only.

**Option.** `GONOGO_REDLINE=off` turns off loop, error storm and ping-pong; Propellant limits still apply. Default: on. See [Configuration](../reference/configuration.md#options).
