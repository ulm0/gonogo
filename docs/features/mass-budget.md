# Mass Budget: memory notes

<MassBudgetMock class="doc-mock" />

MASS BUDGET (selected console; MORE on a phone) shows the size of an agent's `memory.md` and REFLECT asks the agent to condense it. Design and limits: [`docs/mass-budget-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/mass-budget-spec.md).

## The line

- Lines and size, e.g. `233 lines · 18.6 KB`. Over 200 lines or 16 KB shows a saffron warning; nothing stops.
- Read when you open the console and on each state change. A file over 1 MiB is not read (size only).
- Not shown for a custom command or an engine without the gonogo tools.

## Reflect

Sends one message from you, subject `Mass Budget: condense your memory file`, asking the agent to:

- rewrite it in at most 100 lines, keeping decisions with reasons, rules, paths, commands, names, ids, open problems;
- move what every agent should know to the [Mission Log](./mission-log.md) with `log_write`;
- replace the file in one write, keeping its first line (`# Memory of <name>`);
- answer with `send_message`: lines before and after.

It waits until the agent is idle; Max Q, Redline and held mail apply. A stopped agent is not asked (undelivered, no copy). **gonogo never writes `memory.md`**; the agent does.

## The copy

On sending, gonogo saves the old file as `memory.md.bak` (0600, next to it). One copy: the next request replaces it; gonogo never restores or removes it. Go back: `cp memory.md.bak memory.md` in `~/.gonogo/agents/<name>/`. The line says `Asked at 14:03. The notes changed since: 18.6 KB then, 3.0 KB now.` (or `... have not changed since.`), from file times, so an append counts as a change.

## API

- `GET /api/agents/:name/memory` -> `{ "exists": true, "bytes": 19043, "lines": 233, "softLines": 200, "softBytes": 16384, "over": true, "changedAt": 1763476200000, "backup": { "bytes": 19043, "at": 1763476140000 } }` (`backup` null without a copy; `lines` null over 1 MiB).
- `POST /api/agents/:name/reflect` (201) -> `{ "send": { "ok": true, ... }, "memory": { ... } }`; `send.ok` false if the hub did not deliver. 404 unknown agent or custom command; 409 no memory file yet, a symlink or non-regular file, over 1 MiB, or a request already going out.
