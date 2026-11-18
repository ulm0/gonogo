# Spec: Post-Flight Review (draft)

Design by FIDO, 2026-11-18, for issue #37 and task t29. Extends Recorder (`docs/recorder-spec.md`). Status: draft, not built.

## 1. How Hunk works (read from its source and docs; never run or installed)

Hunk (`modem-dev/hunk`, **MIT**, Modem Labs) is a terminal diff viewer with a browser twin. We take ideas and behaviour only and copy no code
(MIT would allow it with the notice; we do not need it).

- **Session model.** Each open review registers with a local loopback daemon (a "session broker"). An agent runs `hunk session ...`,
  which finds the live window by repo path, so the agent steers the human's viewer: `review` (file and hunk structure as JSON, the
  raw patch only on request), `navigate` (to a file and hunk, a line on the old or new side, a comment, or next/prev comment),
  `reload`, `comment add|apply|list|rm|clear`, and `highlight` (a colored character range on one line, tones match/info/warning/
  error/dim). The caller needs an owner-private credential; responses are signed.
- **Note model.** A live comment is `{ id, parentId?, author?, createdAt, filePath, hunkIndex, side: old|new, line, summary,
  rationale? }`. The anchor is the file path plus one line on one side of the diff; the hunk index is derived from the line. A reply
  names `replyTo` and inherits the parent's anchor. A batch (`comment apply`) is validated whole before anything changes. User notes
  (typed with `c`) and agent notes are separate kinds: an agent can list and remove the user's notes but never create or edit them.
  Agent notes start hidden (`a` shows them) so they do not crowd the reader.
- **Survival.** Notes live in the review's in-memory store, keyed by file identity, so they survive a reload that leaves the file's
  content alone; a stored note can carry `resolution: stale`. Highlights are dropped when the file's content changes. **Nothing is
  saved across runs** (viewed state across runs is listed as deferred in its own plan).
- **Agent skill.** `hunk-review` (a `SKILL.md`): inspect structure first, patch only if needed, navigate before you comment, batch
  notes, comment on intent, risks and follow-ups, not every hunk. The agent narrates; the human reads.
- **Not in scope for us:** extensions, VCS back ends other than git, GitHub PR loading, STML rich notes, themes, the OpenTUI
  component, update/feedback commands.

## 2. What to take

| Hunk idea | In gonogo |
|---|---|
| Anchor = file + side (old/new) + line | Same. Hunk number is derived, never stored. |
| Replies inherit the parent's anchor | Same (`replyTo`). |
| Validate a whole batch first | Same: `review_note` takes an array, all or nothing. |
| Agent reads structure first, patch only on request | `review_read` returns files, hunk ranges and notes; the patch only with `patch: true`. |
| Author kept on each note; agents cannot forge the Director | The author comes from the token (as for tasks), never from the body. |
| Agents narrate their own diff; peers add notes | `review_note` on your own diff (walkthrough) and, when asked, on a peer's. |
| Next/previous note, jump to a note | A notes list in the page with jump-to and `n` / `p` keys. |
| Notes hidden by default for agents | Not taken: the Director asked for them, so they show, with a filter (all / mine / agents / open). |

## 3. Where gonogo does better

- **Notes reach the author as mail.** Hunk's notes are only for the human reading. Here REQUEST CHANGES sends the open notes to the agent
  as one message (`file:line` plus text), through the normal path, so Max Q, Redline and held mail apply.
- **A verdict.** APPROVE or REQUEST CHANGES per agent, stored with a hash of the diff it judged. If the diff changes after, the page says
  "approved an older diff".
- **A soft gate.** COMMIT in Recorder asks "N notes are still open: commit anyway?" when notes are open or the last verdict was not an
  approval of this diff. A hard block would only cover commits made from the page; an agent on the host commits by itself, so a block
  would suggest a safety that is not there. Said so in the page text.
- **Survives restart** (saved in gonogo's home) and a changed diff (re-anchoring below).
- **Rooms.** Peer review is a message from the Director to another agent; the notes are authored by whoever wrote them (token). The
  Black Box records the actions by ids and names only, never note text. The Downlink gets an event when an agent adds a note or replies.
- **Worktrees and Clean Room.** The reviewed agent's diff is Recorder's own (the worktree or the Clean Room checkout), so a worktree
  agent's branch is reviewed before the Director merges it.
- **Left out on purpose (later):** a link from a note to a Flight Plan task or a Mission (the verdict mail is the hand-off today);
  moving the agent's `review` task back to `doing` on REQUEST CHANGES.

## 4. Scope of the one PR

### Data
`~/.gonogo/reviews.json` (mode 0600, same atomic writer as `tasks.json`; unreadable file renamed `.bad`; **outside `agents/<name>/`**, because a Clean
Room mounts that folder writable and could forge the Director's notes). `{ version: 1, seq, notes: Note[], verdicts: Record<agent, Verdict> }`.

```ts
Note    = { id: 'rn1'..; agent; path; side: 'old'|'new'; line; text /* the anchored line, ≤ 300 chars */;
            body /* 1-2000 */; tone: 'info'|'warning'|'error'; author: 'user'|agentName; replyTo?: id;
            status: 'open'|'addressed'|'resolved'; createdAt; updatedAt }
Verdict = { verdict: 'approved'|'changes'; at; diffHash; by: 'user' }
```
`agent` is the reviewed console (by name, as fuel and tasks are). Caps: 200 notes per agent (resolved ones trimmed first), 2000 chars,
tone and status from the lists. A note's `path` is relative to Recorder's root and follows Hangar's path rules (no `..`, no `.git`).
A reply has no anchor of its own (it uses its parent's) and no tone.

### Anchoring and "outdated" (pure, `src/shared/diff.ts`, tested)
`parseDiff(text)` gives files, hunks and lines `{ kind: add|del|ctx, oldNo?, newNo?, text }`; the client and the server use the same
function. A note can only be made on a line that is in the current diff (400 `line is not in the diff`); the server copies `text` from
there (the client never sends it). On every load `locate(note, lines)` answers: **exact** (same side and number, same text);
**moved** (that text appears once on that side: use its number; several: the nearest); **outdated** (not found). Outdated notes stay,
are shown in their own group with the old `path:line` and text, and can be resolved or deleted. Nothing is stored for this: it is
computed at read time, so it needs no migration and cannot go stale itself.

### Routes (browser token; Director only)
`GET /api/agents/:name/review` (notes + verdict, diff hash), `POST .../review/notes` `{ path, side, line, body, tone?, replyTo? }`,
`PATCH .../review/notes/:id` `{ status?, body? }`, `DELETE .../review/notes/:id`, `POST .../review/verdict` `{ verdict, summary? }`
(approve, or changes: sends the mail), `POST .../review/ask` `{ kind: 'walkthrough' }` or `{ kind: 'peer', reviewer }`
(a message from the Director). The diff itself is Recorder's existing route. No frame; the page asks again after each action and
every 10 s while open.

### MCP tools (`mcp.ts`, strict schemas, author from the token)
- `review_read { agent?, patch?, path? }`: files, hunk line ranges, notes (open first), verdict. `agent` defaults to the caller; another
  agent's diff only when a **peer request** to the caller is pending (set by ASK / PEER REVIEW, cleared after 24 h or when the caller
  sends a note), else `forbidden`. The patch is cut at 100 KiB.
- `review_note { agent?, notes: [{ path, side, line, body, tone?, replyTo? }] }`: up to 20, all or nothing. Same permission as above.
  A reply by the reviewed agent sets the parent `addressed`; only the Director resolves, reopens or deletes.
- No tool changes a verdict, resolves or deletes. An agent cannot read or write notes of a diff it was not asked to look at.

### Mail and events
- REQUEST CHANGES: `Review: changes requested (N open notes)` from the Director to the author: each open note as
  `path:line [tone] text`, cut at 4000 characters with "and K more: call review_read". APPROVE: `Review: approved`.
- ASK WALKTHROUGH: asks the author to explain its own diff with `review_note`. PEER REVIEW: asks the reviewer to do the same on the
  author's diff. Both are plain messages; the permission above is set by them.
- Downlink event kind `review`: an agent added notes or replied (`ana added 3 review notes on ben`). Black Box: verdict, note made
  / resolved / deleted, ask: ids and names only.

### Page (inside Recorder, no new top-bar key)
The diff gets line numbers and a `+` on each line's gutter (and a click on the line) that opens a note form under it (tone, text);
notes show under their line (author chip, tone, replies, RESOLVE / REOPEN, DELETE); a left list of notes with filter and jump-to;
an OUTDATED group; at the top APPROVE, REQUEST CHANGES, ASK WALKTHROUGH, PEER REVIEW (pick an agent), and the verdict line. The
page keeps working from the keyboard (`n`, `p`, `c` to note). COMMIT shows the soft gate. A phone shows the list and notes, and
adds a note with a line picker; no line-range selection.

### Order of changes
1. `shared/diff.ts` (`parseDiff`, `locate`) with tests. 2. `reviews.ts` store, routes, audit, Black Box, limits. 3. MCP tools, the
peer-request permission, mail and events. 4. The page. 5. `docs/features/review.md`, backlog line, changelog.

### Tests
`parseDiff` (renames, new/deleted files, binary, `\ No newline`, CRLF); `locate` (exact, moved once, moved twice, outdated, whitespace
only change); store (damaged file, atomic write, id never reused, caps, trim order); routes (400 for a line not in the diff, a bad
tone, an unknown `replyTo`, another agent's id); tools (forbidden without a request, batch all-or-nothing, author from the token, a body
that claims `author: user`, reply sets `addressed`); mail text and cut; the soft gate; Black Box lines hold no note text; Clean Room
agent cannot reach `reviews.json`.

### Deliberately left out
Highlights of character ranges, steering the Director's viewer from an agent, a broker or daemon, line-range notes, side-by-side
layout, saved "viewed" state, GitHub PRs and other VCS, rich note markup, a hard commit or merge block, task and Mission links,
notes on commits other than the working diff.

### Open questions for the Director
(1) Is the soft gate enough, or should REQUEST CHANGES also move the agent's `review` tasks to `doing`? (2) Is the peer-request
permission acceptable, or should any agent be allowed to read any diff? (3) Keep `addressed` as a status, or only open/resolved?

## 5. As built (2026-11-18)

Built from section 4 with the Director's answers (soft gate only, a peer reads only on request, `addressed` kept). Where the build chose or differs:

- **File.** `<home>/reviews.json` `{ version: 1, seq, notes, verdicts, requests }`; a test checks that nothing is written under `agents/`. `requests` holds the pending peer requests (`{ agent, reviewer, at }`).
- **Walkthrough notes.** A note the reviewed agent writes on its own diff (not a reply) is stored `addressed`: it waits for nobody, so it is not in the mail of REQUEST CHANGES.
- **A reply** is flattened to the root of its thread (a reply to a reply has the root as `replyTo`). A reply has no tone: a tone on a reply is 400.
- **`locate`** compares the text with all whitespace squeezed, so a re-indented line stays `exact` (or `moved`); a diff cut at the cap says `unknown` for a line it does not reach, not `outdated`. `place` comes with every note.
- **Peer right.** Pending until the peer sends a `review_note` call, or 24 hours; a peer whose message was refused gets none. Another agent's diff without a request is `forbidden` with the reason.
- **REQUEST CHANGES** with no open note is a 409 (`no note is open`): there is nothing to carry. APPROVE and REQUEST CHANGES both mail the author; the verdict is stored only when the mail was accepted.
- **Soft gate.** COMMIT in the Recorder reads the review first; it asks when a root note is open or the last verdict is not an approval of this diff. A review that never started asks nothing. The text says it is a question, not a lock.
- **Page.** Click a line or `+`; `c` on a focused line; `n` and `p` walk through the notes; filter all, mine, agents, open; an OUTDATED group with the old place and text; the verdict line with "an older diff". On a phone the `+` key of each line is the line picker; there is no range selection. The API takes `body` in a PATCH; the page has no edit key.
- **Downlink** event `review` for any agent that adds notes (`ben added 2 review notes on ana`, `ana added 1 review note on its own diff`). Black Box lines: ids, names and counts only (tested).
- **Not seen in a browser** at the time of writing; the parser, the store, the routes, the tools and the page's logic are tested.
