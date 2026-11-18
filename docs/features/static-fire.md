# Static fire: break it before it ships

<StaticFireMock class="doc-mock" />

Before work ships, start a static fire from the wall: type what to test (`the login form`, `the release script`) under the T-MINUS keys and press **STATIC FIRE**. gonogo briefs every running agent in the SIMSUP position to try to break it and every running RETRO to write the rollback plan to the [Mission Log](./mission-log.md). Each one answers with `go_nogo`: SIMSUP says go when it held and no-go with what broke, RETRO go when it can be rolled back. Design and limits: [`docs/static-fire-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/static-fire-spec.md).

- **Who is asked.** Running agents in the SIMSUP or RETRO position, never FLIGHT. With neither on the floor the key is off and the wall says so; hire one from the hire form (a second one is named `simsup-2`).
- **The tally.** The T-minus block reads STATIC FIRE: the subject, a key per answer and each reason. It waits for every answer, then reads GO (everyone go) or NO-GO. Hold, abort and clear work as for T-minus, and only one poll or static fire runs at a time.
- **The result** lands in the [Downlink](./downlink.md) once, with every answer: `Static fire on the login form: HOLD: no-go: simsup · simsup: empty password accepted · retro: revert the merge`. FLIGHT is not told: you decide whether it ships.
- **API.** `POST /api/poll` with `{"subject": "the login form"}` (1 to 187 characters). No SIMSUP or RETRO running is 400 `no SIMSUP or RETRO is running`. Hold, abort and clear are the poll's routes. There is no option for it.
