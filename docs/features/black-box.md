# Black Box: the record of the room

<BlackBoxMock class="doc-mock" />

BLACK BOX (Patch Panel, Cmd+K or Ctrl+K) lists the room's latest events and the command that reads the whole record with git. The server writes a git repository of its own and is the only committer. Design: [`docs/black-box-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/black-box-spec.md).

## What is recorded

Names, ids, statuses and counts. Never a message, title, note, role, command, payload or secret.

| Kind | Examples |
|---|---|
| `crew` | `Director hired ana`, `Director stopped ana`, `Director restarted ana`, `Director removed ana` |
| `config` | `Director edited ana: role, mode` (field names only), `Director set Max Q to 4 working`, `Director changed schedule s3`, `Director made an uplink u1`, `Director set up Relay target slack`, `Director chose a livery`, `Director paired a station d1` |
| `redline` | `guido tripped the Redline: loop`, `Director put guido on hold`, `Director resumed guido` |
| `poll` | `Director started a T-minus poll`, `T-minus poll HOLD: no-go: simsup` |
| `answer` | `Director answered ana: go`, `Director answered hire request h1: no-go` (Relief) |
| `plan` | `ana updated task t3: status doing`, `flight wrote the Plot Board: revision 4, 312 characters` |
| `uplink` | `Uplink u1 delivered message m41` |
| `audit` | `gonogo 0.1.1 started`, `gonogo stopped`, `25 events were not recorded: more than 600 in a minute` |

Not recorded: messages, terminal input, tool calls, an agent that exits by itself, the boss created at first start, refused requests, Launch Window fires, Mission Log writes.

## The repository

- `~/.gonogo/black-box/` (0700), a git repository. One file per UTC day, `2026-11-18.jsonl`, one line per event: `{"at":"2026-11-18T14:03:55.120Z","kind":"redline","text":"..."}`.
- Lines are written at once. Commits are batched: 30 seconds after a batch's first event, and at shutdown; message `audit: N events`; author and committer `gonogo <gonogo@localhost>`.
- At most 600 events a minute; the rest are dropped and counted.
- Read it: `git -C '<folder>' log -p` (the page has the line, with COPY).
- git runs without a shell, 10 second limit (a git killed for it leaves no `index.lock` behind), identity on the command line (your git config is not read or changed), hooks, signing and fsmonitor off. The Docker image has git.
- **git missing:** the page says `git was not found on the PATH`; events still go to the files, and the first batch after you install git and restart commits them. **git failing:** the page shows git's first error line; the next batch retries.

## The page and API

The page shows git's state (amber when not `ok`), the command and the newest 200 events (time in your zone, kind, text), refreshed every 5 seconds while the tab is visible. It writes nothing.

`GET /api/black-box` returns `{ "git": "ok", "note": "", "dir": "...", "command": "git -C '...' log -p", "events": [{ "at": 1763474635120, "kind": "redline", "text": "..." }] }`, newest first. `git` is `ok`, `missing` or `error`. No tool, no option.

**Limit:** the files are plain files in your home. An agent in `bypassPermissions` runs as you and can edit them; git makes that visible, not impossible.
