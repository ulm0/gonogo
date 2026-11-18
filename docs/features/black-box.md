# Black Box: the record of the room

<BlackBoxMock class="doc-mock" />

BLACK BOX (round key, top bar) lists the latest events of the room and shows the command that reads the whole record with git. The server writes it into a git repository of its own and is the only committer. Design and limits: [`docs/black-box-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/black-box-spec.md).

## What is recorded

Names, ids, statuses and counts. Never a message, a title, a note, a role, a command, a payload or a secret.

| Kind | Examples |
|---|---|
| `crew` | `Director hired ana`, `Director stopped ana`, `Director restarted ana`, `Director removed ana` |
| `config` | `Director edited ana: role, mode` (field names only), `Director set Max Q to 4 working`, `Director changed schedule s3`, `Director made an uplink u1`, `Director set up Relay target slack`, `Director chose a livery`, `Director paired a station d1` |
| `redline` | `guido tripped the Redline: loop`, `Director resumed guido` |
| `poll` | `Director started a T-minus poll`, `T-minus poll HOLD: no-go: simsup` |
| `answer` | `Director answered ana: go` (a permission prompt) |
| `plan` | `ana updated task t3: status doing`, `flight wrote the Plot Board: revision 4, 312 characters` |
| `uplink` | `Uplink u1 delivered message m41` |
| `audit` | `gonogo 0.1.1 started`, `gonogo stopped`, and `25 events were not recorded: more than 600 in a minute` |

Not recorded: messages, terminal input, tool calls, an agent that exits by itself, the boss created at the first start, refused requests, Launch Window fires, Mission Log writes.

## The repository

- `~/.gonogo/black-box/` (mode 0700), a git repository. One file for each UTC day, `2026-11-18.jsonl`, a line for each event: `{"at":"2026-11-18T14:03:55.120Z","kind":"redline","text":"..."}`.
- A line is written at once. Commits come in batches: 30 seconds after the first event of a batch, and at shutdown. Message `audit: N events` (`audit: 1 event` for one). Author and committer `gonogo <gonogo@localhost>`.
- At most 600 events a minute; the rest are dropped and counted.
- Read it: `git -C '<folder>' log -p` (the page has the line, with COPY).

## git

- Run without a shell, with a 10 second limit (a git killed for it leaves no `index.lock` behind). The identity is passed on the command line, so no git config of yours is read or changed. Hooks, signing and fsmonitor are off, also when the repository's own config asks for them.
- **Missing:** the page says `git was not found on the PATH`. The room works and events are still written to the files; the first batch after you install git and restart commits them.
- **Failing:** the page shows git's first line of error and the next batch tries again.
- The Docker image has git.

## The page

The state of git (amber when it is not `ok`), the command, and the newest 200 events: time in your zone, kind, text. It asks the server every 5 seconds while its tab is visible. Nothing on it writes.

## API

`GET /api/black-box` answers `{ "git": "ok", "note": "", "dir": "...", "command": "git -C '...' log -p", "events": [{ "at": 1763474635120, "kind": "redline", "text": "..." }] }`, newest first. `git` is `ok`, `missing` or `error`. No tool, no option.

The files are plain files in your home: an agent in `bypassPermissions` runs as you and could edit them. Git makes that visible; it does not prevent it.
