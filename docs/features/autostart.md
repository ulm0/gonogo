# Start again after a restart

After the server stops (Ctrl-C, reboot, container recreated, crash) only the boss starts again. Flight Rules -> **Start again after a restart** can start more. Design: [`docs/autostart-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/autostart-spec.md). Tried with the stand-in agent; the room that builds gonogo changed its policy once with real Claude Code agents running ([What was not verified](../reference/not-verified.md)).

## Policy

*The boss only* (default), *Every console that was running*, or *Nobody* (the boss too).

- **"Was running":** `~/.gonogo/run-state.json` keeps consoles whose process is up and not on hold or tripped. A graceful stop and a crash leave the set as it was. **Your STOP, a Remove, a Hold, a Redline trip, and a console that exits by itself take the console out.** A file older than 7 days or unreadable is ignored (same as *the boss only*).
- **Waves:** the boss first, then three consoles at a time (fewer when Max Q is lower). The next wave starts when the last is out of *starting*, or after 60 seconds. Each console is tried once; one that cannot start (folder gone, no Docker) stays stopped with the reason.
- **Opt out:** a console's form has *Start with gonogo* (shown when the policy is *running*).
- **Carry on:** a console mid-turn (working, or at a permission dialog) gets one message, "Server restarted: ... check your last step and carry on", through the usual door (Max Q and Redline apply). Idle consoles get nothing. A box in the block turns this off.
- **Report:** one inbox line, `Restarted 2 agents after the server start; not started: dee (opted out)`.
- Mail queues are in memory; what was waiting shows as undelivered.

## `start_agent`

The boss's tool `start_agent` with `{ name }` starts a stopped console, as your START key does.

- Refused for a console that is running, on hold, or **stopped by you** (`stoppedBy` in its record; it stays stopped until you start it). A stop made by a [Propellant](./propellant.md) limit or budget counts as yours.
- A console whose Hold was lost with its process (a stalled pty host) stays on hold; only your start or resume starts it.
- At most 6 starts a minute. The [Black Box](./black-box.md) records `flight started ana`.
- The Flight Rules box **FLIGHT may start agents** (on by default) turns it off; the tool then says you did.

## ALL STOP

Flight Rules and the Patch Panel have **ALL STOP**: it holds every console that can be held, like [Hold](./hold.md) (a working turn is interrupted with Escape, mail waits). Consoles stopped, at a dialog, already held or without hooks are left as they are (the answer names those at a dialog or without hooks). **ALL RESUME** resumes consoles on hold; a console that tripped Redline is resumed by its own key. Both go to the Black Box as `Director pressed ALL STOP: 3 held` (count only). API: `POST /api/hold-all`, `POST /api/resume-all`.

## Not verified

- A real `claude` with `--resume` after a cold start: the "Resume this conversation?" dialog is why starts come in waves; it was not seen here.
- A real reboot or container recreation: tested as a stop and start of the server on the same home.
