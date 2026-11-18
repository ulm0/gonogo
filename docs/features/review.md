# Post-Flight Review: notes on an agent's diff

The [Recorder](./recorder.md) has a section **Post-Flight Review** under its diff. It shows what an agent changed since its last commit, split into files and hunks with line numbers, and lets you comment on a line the way you would in a code review: the agent answers, resolves what is done, and another agent can look too. It is native to gonogo: no external program and no extra port. Design and limits: [`docs/review-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/review-spec.md).

## Using it

1. Open GIT for a console (Recorder). The review shows everything that differs from the last commit, staged or not. An untracked file has no diff until it is staged.
2. Press **+** on a line to add a note: one line of words, an optional reason, and a tone (note, warning, problem). A removed line is on the old side, any other on the new.
3. Notes appear under their line with a chip for the tone and the author, and in a list with **Jump**. **Reply** answers a note, **Resolve** closes it, **Reopen** brings it back, **Remove** deletes it and its replies.
4. Three keys send your words as mail, each one message from you:
   - **SEND NOTES**: your open notes that were not sent yet, to the author, as one message: `src/a.ts:12 (new) [warning] summary` with the reason under it. A note shows SENT afterwards; pressing the key again sends only newer notes.
   - **ASK WALKTHROUGH**: asks the author to annotate its own diff (what each change does and why) with `review_note`.
   - **PEER REVIEW**: pick another agent; it is asked to review the author's diff, and may read it and write notes on it from then on.

The page asks again every few seconds, so the agents' notes appear by themselves; a note you are writing is not replaced.

## Outdated notes

A note remembers the text of its line. When the diff changes and that line is gone or says something else, the note is marked **OUTDATED**, kept in the list and no longer drawn on a line; it is current again if the line comes back. After the agent commits, its diff empties and its notes go outdated.

## For agents

- `review_read { agent }`: the changed files as hunks of `[sign, old line, new line, text]`, the notes (with `outdated`) and the agents asked to review. Allowed for the agent itself and for an agent you asked with PEER REVIEW; others get `forbidden`.
- `review_note { agent, notes }`: up to 20 notes in one call, each with `file`, `side` (`old` or `new`), `line`, `summary` (one line), optional `rationale` and `tone` (`info`, `warning`, `error`), or `replyTo` (a note id) in place of the place. A note on a line that is not in the diff is refused with the reason and the others are kept. The author is always the agent of the token. A note's status and removal are yours.

The tools never change a file, and only agents that read mail (an engine with the gonogo tools) can be asked.

## API

Browser token. `<name>` is an agent.

- `GET /api/agents/<name>/review` → `{ repo, reason?, files, truncated, notes, reviewers }`.
- `POST /api/agents/<name>/review/notes` with `{ file, side, line, summary, rationale?, tone? }` or `{ replyTo, summary, ... }` → 201 with the note; 400 names the field (a line that is not in the diff is `line`).
- `PATCH /api/agents/<name>/review/notes/<id>` with `{ status: "open" | "resolved" }`; `DELETE` the same path (204).
- `POST .../review/send`, `.../review/walkthrough`, `.../review/peer` (`{ reviewer }`) → `{ sent, message }`.

Notes are in `<home>/agents/<name>/review.json` (mode 0600). The [Black Box](./black-box.md) records who did what by name, id and count, never a note's words or the path of a file.
