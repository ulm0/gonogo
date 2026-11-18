# Mass Budget: memory notes

<MassBudgetMock class="doc-mock" />

MASS BUDGET, in the selected console (on a phone under MORE), shows how big an agent's `memory.md` is and has REFLECT, which asks the agent to condense it. Design and limits: [`docs/mass-budget-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/mass-budget-spec.md).

## The line

- `memory.md`, its lines and its size, for example `233 lines · 18.6 KB`.
- **Soft limit:** over 200 lines or 16 KB shows a saffron warning. Nothing is stopped; the role text already tells each agent to keep its file under 200 lines.
- Read when you open the console and again each time the agent's state changes. A file over 1 MiB is not read: only its size shows.
- Not shown for a custom command (it has no memory file) or an engine without the gonogo tools.

## Reflect

- Sends one message from you to the agent, subject `Mass Budget: condense your memory file`. It names the file and its size and asks the agent to:
  - rewrite it in at most 100 lines, keeping decisions and their reasons, rules, paths, commands, names, ids and open problems, and dropping what is done, repeated or replaced;
  - move what every agent should know to the [Mission Log](./mission-log.md) with `log_write`;
  - replace the file in one write and keep its first line (`# Memory of <name>`);
  - answer you with `send_message`: the lines before and after.
- It travels like any message: it waits until the agent is idle, and Max Q, Redline and held mail apply.
- A stopped agent is not asked: the message comes back undelivered and no copy is kept.
- **gonogo never writes `memory.md`**, because the agent may be writing it. The agent rewrites its own file.

## The copy

When the request is sent, gonogo saves the file as it was to `memory.md.bak` (mode 0600, next to it). There is one copy: the next request replaces it, and gonogo only looks at its size and time, and never restores or removes it. To go back: `cp memory.md.bak memory.md` in `~/.gonogo/agents/<name>/`.

The line says what is known: `Asked at 14:03. The notes changed since: 18.6 KB then, 3.0 KB now.` or `... have not changed since.` It comes from the times of the two files, so a note the agent only appended counts as a change.

## API

- `GET /api/agents/:name/memory` answers `{ "exists": true, "bytes": 19043, "lines": 233, "softLines": 200, "softBytes": 16384, "over": true, "changedAt": 1763476200000, "backup": { "bytes": 19043, "at": 1763476140000 } }` (`backup` is null without a copy, `lines` null over 1 MiB).
- `POST /api/agents/:name/reflect` (201) answers `{ "send": { "ok": true, ... }, "memory": { ... } }`. `send.ok` is false when the hub did not deliver. 404 for an unknown agent or a custom command; 409 for no memory file yet, a symbolic link or other non-regular file in its place, a file over 1 MiB, or a request already going out.

No frame, no option and no saved state besides the copy.
