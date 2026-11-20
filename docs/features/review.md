# Post-Flight Review: notes and a verdict on an agent's diff

<ReviewMock class="doc-mock" />

Review an agent's diff like a pull request, in the [Recorder](./recorder.md) under its diff: comment on lines, ask for changes, approve, have the agent explain its work or another agent review it. Native: no external program, no extra port. Design and limits: [`docs/review-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/review-spec.md).

## Using it

1. Open GIT for a console. It shows everything differing from the last commit, staged or not (an untracked file has no diff until staged).
2. Click a line, press **+** in its gutter, or **c** on a focused line: write a note with a tone (note, warning, problem). A removed line is on the old side, others the new.
3. **Reply** answers a note, **Resolve** closes, **Reopen** reopens, **Delete** removes it with its replies. A note is *open* until the agent answers (*addressed*) and you resolve it.
4. The note list filters (all, mine, agents, open) and has **Jump**. **n** and **p**: next, previous note.
5. Top keys:
   - **APPROVE**: tells the agent it is approved.
   - **REQUEST CHANGES**: sends your open notes as one message (`path:line [tone] text`, cut at 4000 characters). Needs one open note.
   - **ASK WALKTHROUGH**: the agent explains its diff line by line with `review_note`.
   - **PEER REVIEW**: pick another agent; it may read the diff and write notes until it sends them (or 24 hours).
   The verdict is kept with a hash of the diff it judged; when the diff changes the page says it was of an older diff.

The page polls every few seconds; a note you are writing is not replaced.

## When the diff changes

A note keeps its line's text. A moved line: the note follows and shows MOVED. A gone or changed line: the note goes to **Outdated** with its old place and text until you resolve or delete it. Nothing is stored for this. A diff cut at 256 KiB cannot show every line; a note it does not reach says NOT SHOWN.

## Committing

COMMIT in the Recorder asks "N notes are still open: commit anyway?" when a review has started and notes are open, or the last verdict was not an approval of this diff. A question, not a lock; only for commits from this page (an agent on the host commits by itself).

## For agents

| Tool | Does |
|---|---|
| `review_read { agent?, patch?, path? }` | your own diff by default: changed files with hunk ranges, notes (open first, line state `exact`, `moved`, `outdated`, `unknown`), verdict. `patch: true` adds patch text (of `path` if given; cut at 100 KiB) with noteable lines. Another agent's diff only while the Director's request to you is pending, else `forbidden` |
| `review_note { agent?, notes }` | up to 20 notes, all or none. Each: `path`, `side` (`old`/`new`), `line`, `body` (up to 2000 characters), `tone`; or `replyTo` (a note id) instead of the place. Author is you. A reply by the reviewed agent marks the note addressed; your notes on your own diff are your walkthrough |

No tool changes a file, verdict or note status: resolving and deleting are yours. Only agents that read mail can be asked.

## API

Browser token. `<name>` is an agent.

| Route | Body / answer |
|---|---|
| `GET /api/agents/<name>/review` | `{ repo, reason?, files, truncated, diffHash, notes, verdict, stale, asked }`; each note has `place: { state, line }` |
| `POST .../review/notes` | `{ path, side, line, body, tone? }` or `{ replyTo, body }` -> 201 with the note; a line not in the diff is 400 `line` |
| `PATCH .../review/notes/<id>` | `{ status?, body? }`; `DELETE` same path (204) |
| `POST .../review/verdict` | `{ verdict: "approved" \| "changes", summary? }` -> `{ message, notes, verdict }` |
| `POST .../review/ask` | `{ kind: "walkthrough" }` or `{ kind: "peer", reviewer }` -> `{ message, notes }` |

Notes live in `<home>/reviews.json` (0600), **not** in the agent's folder, so a Clean Room agent cannot forge them. The [Downlink](./downlink.md) gets an event when an agent adds notes. The [Black Box](./black-box.md) records who did what by name, id and count, never a note's words or a path.
