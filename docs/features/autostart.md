# Start again after a restart

After the server stops (Ctrl-C, a reboot, the container recreated, a crash) only the boss starts again, as it always has.
The Flight Rules block **Start again after a restart** can start more. Design and limits:
[`docs/autostart-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/autostart-spec.md). It was tried with the stand-in
agent only, never with a real `claude` ([What was not verified](../reference/not-verified.md)).

- **The policy.** *The boss only* (the default), *Every console that was running*, or *Nobody* (the boss too). No top-bar key.
- **What "was running" means.** gonogo keeps `~/.gonogo/run-state.json`: the consoles whose process is up and that are not on
  hold or tripped. A graceful stop and a crash both leave the set as it was. **Your STOP, a Remove, a Hold, a Redline trip and
  a console that exits by itself take the console out**, so those stay stopped after a restart. A file older than 7 days, or one
  that cannot be read, is ignored (then *running* is the same as *the boss only*).
- **Waves.** The boss first, then three consoles at a time (fewer when Max Q is lower). The next wave starts when the last one
  is out of *starting*, or after 60 seconds. Each console is tried once: one that cannot start (its folder is gone, no Docker)
  stays stopped with the reason, and the rest go on.
- **Opt out.** A console's form has *Start with gonogo* (shown when the policy is *running*): unticked, it stays stopped.
- **Carry on.** A console that was in the middle of a turn (working, or at a permission dialog) gets one message from you,
  "Server restarted: ... check your last step and carry on", through the usual door, so Max Q and Redline apply. An idle
  console gets nothing. A box in the block turns this off.
- **The report.** One inbox line: `Restarted 2 agents after the server start; not started: dee (opted out)`.
- **Mail** is as before: queues are in memory, and what was waiting shows as undelivered.

## `start_agent`

The boss has a tool, `start_agent` with `{ name }`, for a console that is stopped (FLIGHT could not start one before). It
does what your START key does, refuses a console that is running or on hold, and **one you stopped yourself** (it stays stopped until you start it; `stoppedBy` in its record), takes at most 6 starts a minute, and the
[Black Box](./black-box.md) records `flight started ana`. The Flight Rules box **FLIGHT may start agents** (on by default)
turns it off: the tool then answers that you did.

A stop that a [Propellant](./propellant.md) limit or budget made counts as your stop: FLIGHT cannot restart that console either, only you can.

## ALL STOP

Flight Rules (ALL STOP) and the Patch Panel have **ALL STOP**: it holds every console that can be held, with the machinery of
the Hold key ([Hold](./hold.md)): a working turn is interrupted with Escape and the mail waits. A console that is stopped,
at a dialog, already held or without hooks is left as it is (the answer names those at a dialog or without hooks). **ALL
RESUME** resumes the consoles that are on hold; a console that tripped the Redline is resumed by its own key. Both go to the
Black Box as `Director pressed ALL STOP: 3 held`, with the number only (`POST /api/hold-all`, `POST /api/resume-all`).

## Not verified

- A real `claude` with `--resume` after a cold start: the "Resume this conversation?" dialog is why the starts come in waves, and it
  was not seen here.
- A real reboot or container recreation: tested as a stop and a start of the server on the same home.
