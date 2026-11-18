# Spec: Post-Flight Review (interactive diff review in the Recorder)

Built 2026-11-18 for issue #37. Status: built; this file is the design and its limits.

## Intent

An agent finishes and its changes sit uncommitted in its folder. The Director wants to read them as a review, not as a wall of
text: comment on a line, have the agent answer, have the agent walk through its own changes first, or have another agent look.
The issue asked for an external diff viewer with a loopback broker. This is native instead: the Recorder already runs git for
one agent's folder, gonogo already has mail and tools, so a review needs one note store, one parser, two tools and one page. No
external program, no new listening port, no new top-bar key.

## Design

- **The diff.** `Recorder.reviewDiff(name)`: `git diff HEAD` (staged and unstaged against the last commit; with no commit yet,
  what is staged), read-only, through the Recorder's `git()` (argument list, no shell, hooks off, 15 s, 256 KiB cap). Untracked
  files have no diff until they are staged, as in the Recorder. `src/shared/diff.ts` (`parseDiff`, `textAt`) reads it into files,
  hunks and lines with their old and new numbers; the server and the page use the same code.
- **A note** is `{ id, file, side, line, summary, rationale?, author, tone, status, replyTo, at, sentAt, outdated }`
  (`ReviewNote`). `side` is `old` (a removed or unchanged line, by its old number) or `new`. `summary` is one line (200),
  `rationale` at most 1000 characters, `tone` is `info`, `warning` or `error`, `status` is `open` or `resolved`, `author` is
  `user` or an agent name. A reply (`replyTo`) sits on the line of its parent and takes no line of its own. At most 300 notes
  for one diff; ids `n1`, `n2`, ... are never reused.
- **Stored** in `<home>/agents/<name>/review.json` `{ version: 1, seq, reviewers, notes }` (mode 0600, a temporary file and a
  rename, one write at a time for each agent; a damaged file is kept as `.bad`). The agent's folder moves with a rename of the
  agent, so its notes do. Each note keeps `anchor`, the text of its line when it was made. A note is only made on a line the diff
  shows now (400 with the field `line` otherwise), so a note always names a real line.
- **Outdated.** At every read the note's line is looked up in the current diff: the same text means current; a different text,
  a line that is gone or a file that left the diff means `outdated: true`. The note is kept, shown in the list with an OUTDATED
  chip, and not drawn on a line; it is current again when the line comes back. A diff cut at the 256 KiB cap does not reach
  every line: a line that is not found in a cut diff is unknown, not outdated.
- **Who may do what.** The Director: everything, over the browser routes. An agent may read the diff and the notes of its own
  folder and add notes to it (its walkthrough, its answers). Another agent may do both only after the Director pressed PEER
  REVIEW for it on that diff (`reviewers` in the file, at most 8); before that the tool says `forbidden`. A message that cannot
  be delivered grants nothing. The author of a note is the caller's token, never a field. An agent cannot resolve or remove a
  note: closing a discussion is the Director's. Only agents that read mail (an engine with the gonogo tools) can be asked.
- **Tools** (`review_read`, `review_note`; in `MCP_TOOL_NAMES`). `review_read { agent }` answers the changed files as
  `{ path, status, hunks: [{ h, l: [[sign, old, new, text]] }] }` (cut at the size of `read_messages`, with `remaining` and
  a note), the notes with `outdated`, and `reviewers`. `review_note { agent, notes: [...] }` adds up to 20 notes: each good one
  is kept, each bad one is listed with its index and the reason (a line that is not in the diff, a bad tone, a summary that is
  too long). A note carries `file`, `side`, `line`, `summary`, optional `rationale` and `tone`, or `replyTo` instead of the three
  place fields; a field it does not have is refused by the schema. The tools never change a file.
- **The three actions** (browser token; each is one message from the Director through `Hub.sendFromUser`, so the send limit,
  Redline, held mail and the hop limit apply):
  - `POST /api/agents/<name>/review/send`: the open notes of the Director not sent yet, as one message to the author:
    `Review: N notes on your diff`, then one line per note `- n7 src/a.ts:12 (old) [warning] summary` with `  Why: ...` under
    it, and how to answer. They get `sentAt`, so a second press sends only newer ones (409 `no open note of yours is waiting to
    be sent` when there is none). A message that is refused leaves them unsent. A body over the limit is cut with "...and N
    more: read them with review_read".
  - `POST /api/agents/<name>/review/walkthrough`: asks the author to annotate its own diff with `review_note`.
  - `POST /api/agents/<name>/review/peer { reviewer }`: asks another agent to review the author's diff with `review_read` and
    `review_note`, and gives it the right to. An agent cannot review itself.
- **Routes** (browser token): `GET /api/agents/<name>/review` (`ReviewView`: `repo`, `reason?`, `files`, `truncated`, `notes`,
  `reviewers`), `POST .../review/notes` (201), `PATCH .../review/notes/<id>` (`{ status }`), `DELETE .../review/notes/<id>`
  (the replies go with it), and the three above. Without the `review` option the routes are 404 and the tools say it is not
  available. No frame: the page asks again every few seconds, like the Plot Board.
- **The page.** A section "Post-Flight Review" in the Recorder under the diff text: the files and hunks as rows of two numbers
  and the text, a `+` key on each line (a removed line is the old side, any other the new), the form (one line, a reason, a
  tone), the notes under their line with a tone chip and an edge mark, Reply, Resolve or Reopen, Remove, a list of all notes with
  Jump (which scrolls to the line and focuses the note), and the three actions. A form being written is never replaced when the
  page asks again. Every key is a button or a select that the keyboard and a screen reader reach.
- **Black Box.** `REVIEW_AUDIT` (kind `plan`): `Director added a review note on ana`, `ben added 2 review notes on ana`,
  `Director set review note n1 of ana to resolved`, `Director sent 3 review notes to ana`, `Director asked ana for a walkthrough
  of its diff`, `Director asked ben to review the diff of ana`. Names, ids and counts; never a summary, a reason, a path or a line.

## Options

1. **Native (pick).** The Recorder, the mail and the tools that exist; about 450 lines of server code and one page; no new
   process or port, so nothing for the Director to install or to keep running, and the same permissions model as the rest.
2. An external diff viewer driven over a loopback broker (the issue's proposal). A second program, a second port, and a
   protocol to keep in step with a tool gonogo does not ship. Rejected.

## Order of changes

1. `shared/diff.ts` and the types; `Recorder.reviewDiff`; `review.ts` (store, anchor, outdated, messages).
2. Routes, the two tools, the Black Box table, `cli.ts`.
3. The page: `review.ts`, `Review.tsx`, `review.css`, wired into `Recorder.tsx`.
4. Docs, changelog.

## Test plan

Parser (add, modify, delete, rename, binary, no-newline marker, two hunks, a diff cut short, a content line that looks like a
header); the store with a fake diff (anchor, refusals by field, reply, resolve, remove with replies, ids, `.bad`, the cap);
outdated (same, changed, gone, cut diff); permissions (author, stranger, peer after the ask, peer after a refused message);
the batch (good and bad in one call); the three messages (exact format, once only, refused message, over-long body, agents that
cannot read mail); the Recorder diff with real git (staged and unstaged, untracked left out, no commit, no repository); the
routes and the tools (compact read, the cut, the author from the token, a forbidden field, 401, 405, 404); the Black Box lines
with no text in them; the page's logic (threads, lines, counts, actions, form).

## Known limits

- Notes are on the diff against the last commit. When the agent commits, the diff empties and the notes go outdated; they stay
  in the list until removed. There is no history of earlier commits.
- Untracked files are not in the diff until they are staged.
- A diff over 256 KiB is cut; later files and lines cannot be noted until it is smaller.
- One review for each agent folder; a Clean Room or worktree agent is reviewed in its worktree.
- A reviewer's right lasts until the file is removed; there is no key to take it back (remove the notes and edit the file).
- Not seen in a browser at the time of writing (no browser on the build host): the logic, the server and the tools are tested,
  the page is not.
