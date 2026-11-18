# Spec: Static fire

Written and built 2026-11-18. Max Q reading (b) of `docs/backlog.md` section 10, the stress ritual, under a name of its
own. A static fire is a rocket's engine test on the stand: lit, held down, watched for what breaks.

## Intent

Before work ships, the Director wants it attacked and a way back written down. SIMSUP tries to break it, RETRO writes the
rollback plan, and the Director sees both answers in one place. It is a T-minus poll with a subject and a fixed crew, so
it reuses the poll, the tally, the hold and the inbox line instead of new machinery.

## Design

- **Start.** `POST /api/poll` with `{ "subject": "<what to test>" }` (`PollRequest.subject`). The subject is one clean line
  (control and bidi characters become spaces, runs of space collapse) of 1 to 187 characters, so `Static fire: <subject>`
  fits the 200 of a message subject (400, field `subject`). `agents` with a subject is refused (400, field `agents`): the
  crew is fixed. The crew is every running agent with the gonogo tools in the position `simsup` or `retro`
  (`STATIC_FIRE_POSITIONS`), the boss never; none is `bad_request` `no SIMSUP or RETRO is running`.
- **The brief.** Each crew member gets a message from the Director with the subject `Static fire: <subject>`. SIMSUP:
  try to break it, then `go_nogo` go if it held or no-go with what broke (steps to reproduce to the Mission Log). RETRO:
  write the rollback plan to the Mission Log with `log_write`, then `go_nogo` go when it can be rolled back or no-go if it
  cannot. Like every Director message, it is never held by Max Q.
- **The tally** is the poll: `PollView.subject` is set, the entries, votes, reasons, hold, abort and clear work as for
  T-minus, and only one poll or static fire exists at a time. One difference: a static fire waits for every answer before
  it settles (the break report and the plan both matter), so the first no-go does not end it early. All go is `go`, any
  no-go then is `hold` (`no-go: <names>`). The boss is not told: the Director decides. Abort tells each entry that did
  not vote no-go `Static fire: aborted`.
- **The inbox.** The result goes to the Downlink as a `tminus` event, once per result like T-minus, with every answer:
  `Static fire on <subject>: HOLD: no-go: sim · sim: empty password accepted · ret: revert the merge` (cut to 300).
- **The wall.** In the T-MINUS block, under its keys while no poll is on the wall: a field `What to test` and the key
  STATIC FIRE. With no running SIMSUP or RETRO the key is disabled and the block says `Static fire needs a running SIMSUP or
  RETRO.` While a static fire runs, the heading reads STATIC FIRE and the note starts with the subject; the word, the
  vote keys and the hold, abort and clear keys are T-minus's. The live region says `Static fire started: <subject>` and
  `Static fire: GO`, `NO-GO`, `HOLD` or `aborted`.

## Rejected

- A separate ritual with its own state, route and frame: the poll already holds a tally, votes, hold and abort.
- A Downlink kind of its own: `tminus` and its Relay forwarding cover it; the text says which it was.
- Asking FLIGHT to run it: the Director starts it, as T-minus.

## Known limits

- shortcut: a static fire and a T-minus poll share the one poll slot; give each its own slot if both are wanted at once.
- The rollback plan itself is in the Mission Log, not on the wall: the wall and the inbox show the one-sentence reasons.
- Not run with a real `claude`: only the stand-in agent answered a static fire.
