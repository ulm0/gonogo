# Post-Flight Review: notes and a verdict on an agent's diff

The [Recorder](./recorder.md) has a section **Post-Flight Review** under its diff. It shows what an agent changed since its last commit, split into files and hunks with line numbers, and lets you review it the way you would a pull request: comment on a line, ask for changes, approve, and have the agent explain its own work or another agent review it. It is native to gonogo: no external program and no extra port. Design and limits: [`docs/review-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/review-spec.md).

## Using it

1. Open GIT for a console. The review shows everything that differs from the last commit, staged or not (an untracked file has no diff until it is staged).
2. Click a line, or press **+** in its gutter (or **c** on a focused line), to write a note: words, and a tone (note, warning, problem). A removed line is on the old side, any other on the new.
3. Notes show under their line with the tone and the author. **Reply** answers one, **Resolve** closes it, **Reopen** opens it again, **Delete** removes it with its replies. A note is *open* until the agent answers (then *addressed*) and you resolve it.
4. The list of notes has a filter (all, mine, agents, open) and **Jump**. From the keyboard, **n** and **p** go to the next and the previous note.
5. At the top:
   - **APPROVE** tells the agent it is approved.
   - **REQUEST CHANGES** sends your open notes to the agent as one message (`path:line [tone] text`, cut at 4000 characters). It needs at least one open note.
   - **ASK WALKTHROUGH** asks the agent to explain its own diff, line by line, with `review_note`.
   - **PEER REVIEW**: pick another agent; it is asked to review this diff and may read it and write notes on it until it has sent them (or 24 hours pass).
   The verdict is kept with a hash of the diff it judged: when the diff changes, the page says it was of an older diff.

The page asks again every few seconds, so what the agents write appears by itself; a note you are writing is not replaced.

## When the diff changes

A note keeps the text of its line. If the line moved (more lines above it), the note follows it and shows MOVED. If the line is gone or says something else, the note goes to an **Outdated** group with its old place and text, and stays until you resolve or delete it. Nothing is stored for this: it is worked out each time. A diff cut at 256 KiB cannot show every line; a note it does not reach says NOT SHOWN, not outdated.

## Committing

COMMIT in the Recorder asks "N notes are still open: commit anyway?" when a review has started and notes are open, or the last verdict was not an approval of this diff. It is a question, not a lock: it only covers a commit made from this page, and an agent on the host commits by itself.

## For agents

- `review_read { agent?, patch?, path? }`: your own diff by default. The changed files and their hunk ranges, the notes (open first, with where each line is now: `exact`, `moved`, `outdated`, `unknown`) and the verdict. `patch: true` adds the patch text (of `path` when given; cut at 100 KiB) with the lines you can note. Another agent's diff only while the Director's request to you is pending, else `forbidden`.
- `review_note { agent?, notes }`: up to 20 notes, all or none. Each has `path`, `side` (`old` or `new`), `line`, `body` (up to 2000 characters) and `tone`, or `replyTo` (a note id) in place of the place. The author is you, never a field. A reply by the reviewed agent marks the note it answers as addressed; your own notes on your diff are your walkthrough.

No tool changes a file, a verdict or the status of a note: resolving and deleting are yours. Only agents that read mail can be asked.

## API

Browser token. `<name>` is an agent.

- `GET /api/agents/<name>/review` → `{ repo, reason?, files, truncated, diffHash, notes, verdict, stale, asked }`; each note has `place: { state, line }`.
- `POST .../review/notes` with `{ path, side, line, body, tone? }` or `{ replyTo, body }` → 201 with the note; a line that is not in the diff is 400 `line`.
- `PATCH .../review/notes/<id>` with `{ status?, body? }`; `DELETE` the same path (204).
- `POST .../review/verdict` with `{ verdict: "approved" | "changes", summary? }` → `{ message, notes, verdict }`.
- `POST .../review/ask` with `{ kind: "walkthrough" }` or `{ kind: "peer", reviewer }` → `{ message, notes }`.

Notes are in `<home>/reviews.json` (mode 0600), **not** in the agent's folder: a Clean Room can write there, and an agent must not be able to forge your notes. The [Downlink](./downlink.md) gets an event when an agent adds notes. The [Black Box](./black-box.md) records who did what by name, id and count, never a note's words or a path.
