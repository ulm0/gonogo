# Static fire: break it before it ships

<StaticFireMock class="doc-mock" />

Before work ships, type what to test (`the login form`) under the T-MINUS keys and press **STATIC FIRE**. Every running SIMSUP agent tries to break it, every running RETRO writes the rollback plan to the [Mission Log](./mission-log.md); each answers with `go_nogo` (SIMSUP: go if it held, no-go with what broke; RETRO: go if it can be rolled back). Design and limits: [`docs/static-fire-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/static-fire-spec.md).

- **Asked**: running SIMSUP or RETRO agents, never FLIGHT. With neither the key is off and the wall says so; hire one (a second is `simsup-2`).
- **Tally**: the T-minus block reads STATIC FIRE: subject, a key per answer, each reason. It waits for every answer, then GO (all go) or NO-GO. Hold, abort and clear work as for T-minus; one poll or static fire at a time.
- **Result**: once in the [Downlink](./downlink.md): `Static fire on the login form: HOLD: no-go: simsup · simsup: empty password accepted · retro: revert the merge`. FLIGHT is not told; you decide.
- **API**: `POST /api/poll` `{"subject": "the login form"}` (1 to 187 characters). None running: 400 `no SIMSUP or RETRO is running`. Hold, abort, clear are the poll's routes. No option.
