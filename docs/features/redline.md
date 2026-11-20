# Redline: the circuit breaker

<RedlineMock class="doc-mock" />

Stops a runaway Claude agent by itself on:

| Trip | When |
|---|---|
| Loop | same tool, same input, 5 times in a row |
| Error storm | 8 failed tool calls in 2 min, or 3 API errors in 10 min |
| Ping-pong | over 15 messages to one recipient in 10 min |
| Propellant | a token limit reached |

A working agent gets an Escape (interrupts its turn), shows `needs you` with a reason starting `redline:`, and its mail is held (`held: redline on <name>`) until **RESUME** (or `POST /api/agents/:name/resume`) or **STOP**. Typing into its terminal, a restart or a stop also ends the trip.

Custom agents and engines without hooks never trip; Gemini CLI only on loop and ping-pong. `GONOGO_REDLINE=off` disables loop, error storm and ping-pong (Propellant limits still apply); default on ([Configuration](../reference/configuration.md#options)).
