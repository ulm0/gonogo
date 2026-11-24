# Engine switch

Move a console to another engine without removing it: open its edit form, pick the **Engine**, save. Every console can switch, **flight** too, to any engine (not a custom command), with any model the new engine takes. Name, role, folder, worktree, keys and position stay. Design and limits: [`docs/engine-switch-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/engine-switch-spec.md).

- **Stopped:** saved; it starts on the new engine next time.
- **Idle or waiting for you:** saved, and it restarts on the new engine at once.
- **Working:** the switch waits for the end of its turn, then the console restarts on the new engine. The form shows it with **SWITCH NOW** (restart in the middle of the turn) and **CANCEL SWITCH**. **SAVE AND RESTART** switches at once.
- **A new session, with a handoff:** the conversation cannot move to another CLI, so gonogo writes the last turns of the old one (at most 30 turns, 24,000 characters) and the path of its whole transcript to `agents/<name>/handoff.md`, and the first session on the new engine is told to read it. Claude Code and pi transcripts are read; for another engine the handoff says it could not be read.
- **What does not fit is dropped** (between Claude Code, pi and opencode only the model, whose names do not carry, and Remote Control): the model (unless you type one for the new engine), effort, Clean Room, Remote Control, tool rules and the Payload items the new engine does not take. A CLI without permission modes runs in its default mode. The inbox names what was dropped. A bypass mode carried to another engine must be confirmed again.
- **Mail:** while a switch waits, mail to the console waits too and goes to the new engine. An engine without the gonogo tools (Crush, for one) gets no mail: what waited goes back to you as undelivered.
- **API:** `PATCH /api/agents/<name>` with `{ "provider": "pi" }`; add `"switchNow": true` to restart at once; `{ "switchNow": true }` alone applies a pending switch; the engine it runs on cancels one.

Sign in to the new CLI (or set its API key as a Clearance key of the console) before you switch. The container image ships `claude`, `pi` and `opencode`.
