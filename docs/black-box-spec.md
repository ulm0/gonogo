# Spec: Black Box

Written and built 2026-11-18. Backlog section 2, "Git-committed audit log of the room, with the server as the only committer". The
name is gonogo's own: the flight recorder that is kept for whoever has to ask afterwards what happened.

## Intent

The room's state is in memory and in a few files that are rewritten. Nothing says afterwards who stopped an agent at 14:03, which
poll was held, or when the plan changed. The Black Box is an append-only record of those events, kept as the commits of a git
repository inside the gonogo home, so that the Director can read it, search it and compare it with the tools he already has. Only
the server writes to it, and when git is missing the room works and the page says so.

## Design

- **The repository.** `~/.gonogo/black-box/` (mode 0700), a git repository of its own, made at start when it is not there. In it
  one file for each UTC day, `YYYY-MM-DD.jsonl` (mode 0600), a line for each event: `{"at":"2026-11-18T14:03:55.120Z","kind":"redline","text":"guido tripped the Redline: loop"}`.
  A line is appended as soon as the event happens; only the commit waits. The folder must be a plain folder: when it is a link the
  Black Box refuses it (`black-box is not a plain folder`), writes nothing, and the room goes on. A link where the file of a day goes is not followed either (`O_NOFOLLOW`): the line is shown and
  not written, and the log says so.
- **What an event is.** `kind` is one of `crew`, `redline`, `poll`, `answer`, `plan`, `uplink`, `config`, `audit` (`AUDIT_KINDS`).
  `text` is one clean line of at most 200 characters: controls, bidi marks and runs of white space become one space. It is made of
  fixed words, names, ids, statuses and counts. It is never a message, a title, a detail, a note, a role, a schedule's text, a
  command, a payload, a secret, a path or anything an agent or the Director typed: `src/server/audited.ts` lists every text, and
  `test/audited.test.ts` gives them requests that hold a secret and checks that it does not come out.
- **What is recorded** (the only things that are):

  | Kind | Words | From |
  |---|---|---|
  | `crew` | `Director hired ana`, `restarted`, `stopped`, `removed` | the hub, through the browser's routes |
  | `config` | `Director edited ana: role, mode` (field names only), `Director set Max Q to 4 working` or `no limit`, `Director changed the Propellant limits`, `made a schedule s3`, `changed schedule s3`, `removed`, `ran`, `made an uplink u1`, `changed`, `removed`, `rotated the secret of`, `set up Relay target slack`, `removed Relay target`, `changed what Relay forwards`, `chose a livery`, `removed livery <slug>`, `made a docking code`, `paired a station d1`, `undocked d1` | the routes |
  | `redline` | `guido tripped the Redline: loop` (`loop`, `error storm`, `ping-pong`, `out of propellant`, `room out of propellant`, else `another rule`), `Director resumed guido` | the hub's trip (the reason, which can hold a command line, is cut to its rule) |
  | `poll` | `Director started a T-minus poll`, `held`, `aborted`, `cleared`, and each result `T-minus poll HOLD: no-go: simsup` / `GO: all go` / `ABORTED: aborted by the Director` | the routes and the hub's result (names, never a vote's reason) |
  | `answer` | `Director answered ana: go` or `no-go` (a permission prompt) | the route |
  | `plan` | `ana created task t3`, `ana updated task t3: status doing assignee ben note` (the words `note` and the values of status and assignee only), `Director removed task t3`, `Director handed off task t3 to lab`, `flight wrote the Plot Board: revision 4, 312 characters` | Flight Plan (the Director, an agent, a docked station's Director) and the Plot Board |
  | `uplink` | `Uplink u1 delivered message m41` | a signed delivery that made a message (not a ping, not a refusal) |
  | `audit` | `gonogo 0.1.1 started`, `gonogo stopped`, `25 events were not recorded: more than 600 in a minute` | the server |

  Not recorded: any message (its sender, recipient, subject or body), what is typed in a terminal, tool calls, an agent that exits
  or crashes by itself, the boss that the first start creates, a restart of the boss when gonogo starts, a request that was
  refused (a bad uplink signature, a 400), Launch Window fires, Mission Log writes and Downlink reads.
- **The commit.** The first event of a batch arms one timer (`BLACKBOX_COMMIT_MS`, 30 s); when it fires, and at shutdown, the server
  runs `git add -A -- .`, `git diff --cached --quiet` and, when something is staged, `git commit -q -m "audit: N events"`. The
  runs are one at a time and after the appends they follow. At start the same batch is armed once, so what a crash left uncommitted
  is committed (the message is `audit: earlier events` when no event of this run is in the batch).
- **git, safely.** Every call is `execFile('git', [...])` with an argument array (no shell), the repository as its working
  directory, a timeout of 10 s (`BLACKBOX_GIT_TIMEOUT_MS`, then SIGKILL; the `index.lock` that a killed git leaves is removed, since only the server runs git there) and an output cap of 1 MiB. The environment is made from
  nothing: `PATH` of the server's own environment, `GIT_DIR` and `GIT_WORK_TREE` set to the repository (so that no other
  repository above it is found), `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`.
  Nothing of the process's `GIT_*` variables passes (`GIT_CONFIG_GLOBAL` is read by git 2.32 and newer; the `-c` switches below hold for any version). The identity is passed with `-c user.name=gonogo -c user.email=gonogo@localhost`,
  and `-c commit.gpgsign=false -c core.hooksPath=/dev/null -c core.fsmonitor=false` switch off signing, hooks and fsmonitor, which a
  command-line `-c` beats even when the repository's own config names them. No git config of the user is read or written.
- **Without git, or when git fails.** `git --version` is run at start. A program that is not found is `missing`; the page says
  `git was not found on the PATH`. The events are still written to the files and shown, and nothing is committed until the next
  start with git on the `PATH`. A repository that cannot be made (`init` fails) is `error` with git's first line of text. A commit
  that fails or is killed for taking too long is `error` too (`git took more than 10 seconds`); the Black Box tries again 30 s
  later, and the state goes back to `ok` at the first batch that works. The log gets one line at each change of state.
- **A burst.** At most `BLACKBOX_RATE_MAX` (600) events a minute are recorded; the rest are counted, and the next minute's first
  event is preceded by an `audit` event that says how many were not recorded.
- **The view.** `GET /api/black-box` (browser token only) answers `{ git, note, dir, command, events }`: `git` is `ok`, `missing`
  or `error`, `dir` the repository, `command` a line to paste in a terminal (`git -C '<dir>' log -p`, the path quoted as one word
  for a POSIX shell, a quote in it included) and `events` the newest 200, newest first. At start the events are read from the end of
  the newest day files only (64 KiB of each, up to 7 files), so a big day costs no more than a small one; a line that is not an
  event is skipped. Without a `blackBox` option the route is 404. There is no tool: no agent can read or write the record through
  gonogo, and no route writes to it.
- **The screen** is a view of its own, BLACK BOX (`BlackBox.tsx`, `audit.ts`, `records.css`; `store.view` is `blackbox`), reached from the Patch Panel (a line "Black Box"). The line on the state of git (amber when it is not `ok`), the command in a read-only
  field that selects itself whole, COPY (the page says `Copied.` or that the browser would not, in words and not only for a screen reader), and the events: time in the
  browser's zone, a chip for the kind, the text. The page asks every 5 seconds while the tab is visible.
- **No key.** The top bar and the phone bar are full; see `docs/plot-board-spec.md`.
- **No option and no environment variable.** The limits are constants (`constants.ts`).

## Decisions

- **Files plus git, not git only.** The line is written at once, so a crash or a missing git loses nothing; git adds the history, the
  hashes and the tools. A repository that only git can write would lose the events of a minute without git.
- **One file for each UTC day.** A day's file is small, a commit touches one file, and `git log -p` reads as a day-by-day diary.
- **Told by the places that do the thing, not found by diffing frames.** `audited(store, record, table)` wraps a store's methods
  after they succeed, in one table per store, in `audited.ts`; `cli.ts` hands the wrapped stores to the web server. No store and no
  part of the hub changed. A frame diff would have had to tell a hire from a start at boot, and would see the texts of tasks.
- **The Director's actions are told by the hub's copy that the browser's routes use.** An agent's own calls to the hub (a
  message, a vote) are not in it.
- **A batch of 30 s.** A commit for each event would be a process for each event; 30 s is short enough that a crash loses nothing
  that is not in the files, and long enough to join a burst. A commit at shutdown covers the rest.
- **Names and ids only.** The record is kept for ever and read by whoever reads the folder; what is not written cannot leak.

## Rejected

- Signing commits, remotes and pushes, hash chains in the lines: not in the brief, and a signing key would be a secret to keep.
- An event for each message, tool call or hook: that is the Mission Log's and the activity strip's kind of record, and it would hold
  bodies.
- Rotation or deletion: the files and the repository are the Director's to prune with git.
- A tool for agents to read the record: the Director reads it; an agent that wants a fact asks for it in the Mission Log.

## Known limits

- shortcut: the cap of 600 events a minute drops the rest of a burst. Raise it, or batch the burst into one event, if a real room
  ever hits it (`blackbox.ts`).
- The record is plain files in the Director's home. An agent in `bypassPermissions` runs as the Director and can edit them or run
  git there. Git makes an edit visible (a rewritten day file, a rewritten history) and does not prevent it: it is a record, not a
  signed log.
- Only the server's own code commits. Nothing stops a person from committing by hand in that folder.
- An agent that exits by itself, the boss that is created at the first start and a restart at boot are not events (listed above).
- The texts are English and fixed; the page does not translate them.
- Tested with a temporary folder, a fake clock and a scripted git (batching, retries, a git that is missing, killed or failing, the
  rate cap, a link in place of the folder, reading the newest events), the real git of the machine (the identity, a clean status,
  the committed lines, an earlier crash, a user config with another identity, hooks and signing, a `GIT_DIR` and author in the
  environment, a repository that names hooks and an fsmonitor, a broken repository), each text of `audited.ts` with a secret
  in the request, the route, and a real server with the stand-in agent (the events of a hire, an edit, a task, a plan, a poll, an
  uplink delivery and a stop, no secret in them, the commits, a second start on the same home, a start with no git on the `PATH`).
  Not run: git older than the one used here (2.56; from git's documentation, an older git than 2.32 ignores `GIT_CONFIG_GLOBAL` and
  reads `~/.gitconfig`, while the `-c` switches still apply: not tried), a git that is slow or blocked on a lock for the 10 seconds, Windows, a
  repository on a network drive.
- The page was opened in Chrome at 1440 px and in the 390 px phone emulation, in Instrument and Night Shift, against a real server
  with the stand-in agent: the events of a hire, a plan, a poll, a Max Q change, an edit, an uplink and a stop listed newest first,
  the command in its field, no sideways scroll at 390 px, every key and field at least 44 px tall. The text of the page was measured
  at 4.5:1 or more in all four liveries by script (the least was 4.86:1). After a stop of that server the repository held the
  commits of gonogo, the last one with `gonogo stopped`. Not tried: the COPY key in a browser that refuses the clipboard, Firefox,
  Safari, a screen reader, `prefers-reduced-motion` (the page has no motion), a log of hundreds of events.
