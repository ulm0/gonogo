# Spec: Mission Log

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): one memory shared by every
agent, with search, the equivalent of Munder Difflin's shared memory.

## Intent

Each agent keeps its own `memory.md`, and that stays as it is. What one agent learns today is not seen by the others, and
is not seen by the same agent in another project. The Mission Log is one list of short entries that every agent can write
to, search and read, and that the Director can read, write, edit and delete on one screen (also on a phone). Nothing else
is new: the agents use three more tools of the MCP server they already have.

## Design

- **An entry** is `{ id, title, body, tags, author, createdAt, updatedAt }` (`LogEntry` in `src/shared/protocol.ts`). `id` is
  `l1`, `l2`, ... and is not given twice, also after a restart. The title is 1 to 200 characters on one line, the body 1 to
  20000 characters of text (markdown or not, it is never rendered), the tags up to 8 words of 1 to 30 lowercase letters,
  digits, dots, dashes or underscores. `author` is `user` (the Director) or the name of the agent, stamped by the server from
  the token, as for `send_message`. At most 2000 entries: the 2001st is a 409 (`conflict`, field `log`).
- **The files.** `~/.gonogo/mission-log/<id>.md`, one for each entry, in a folder of mode 0700 with files of mode 0600. A file is
  a small front matter and then the body:

  ```
  ---
  id: "l1"
  title: "Cache key"
  tags: ["build","cache"]
  author: "ana"
  createdAt: "2026-11-17T14:03:00.000Z"
  updatedAt: "2026-11-17T14:03:00.000Z"
  ---
  The cache key has the node version.
  ```

  Each front matter value is JSON on one line (a title with a colon or a quote needs no care), the times are ISO. A file is
  written whole to a temporary file and renamed. The write goes to the file first and to memory after it, so a refusal of the
  disk reaches the caller and nothing changes; writes go one at a time, so the limit and the ids hold. A file that is not an
  entry (no front matter, a value that is not valid, an `id` that is not the name of the file) is skipped with a warning
  and left as it is; its id is still never given to a new entry. `mission-log/.seq` holds the highest id ever given. It is
  written when an entry is removed, so that the id of a removed entry is not given again after a restart.
- **Search** (`src/server/logsearch.ts`) is BM25 (k1 1.2, b 0.75, idf `ln(1 + (N - n + 0.5) / (n + 0.5))`), built in memory at
  start from the files and updated at every write. A word is a run of Unicode letters or digits of two characters or more,
  lowercased. The title and the tags count three times, the body once, as one text (the usual way to weight a field in
  BM25). The query is split into words the same way; an entry that holds at least one of them is a result, a word that is
  twice in the query counts once, and the score is the sum over the words. A tie goes to the entry changed last. An empty
  query is not a search: it lists the newest entries.
- **Snippets.** A result has `snippet`, not the body: about 200 characters of the body around the place where the most
  different words of the query come close together (the first such place on a tie), starting about 40 characters before the
  match and at a word, on one line, with `…` where it was cut. A match near the end gets the room that is left before it. When
  only the title or the tags matched, the snippet is the start of the body.
- **Who may do what.** Every agent may search and read every entry and write new ones. An agent may change only what it
  wrote (`forbidden`, with the author's name, otherwise). The Director may change or delete any entry; his change keeps the
  author. An agent cannot delete.
- **The tools** (`mcp.ts`, `MCP_DESCRIPTIONS`; all three are in the allowed tools of a Claude agent and the stand-in agent
  checks the list):
  - `log_write { title?, body?, tags?, id? }`: without `id` it makes an entry (title and body required); with `id` it changes
    an entry the caller wrote, and the fields given change (at least one). Answers `{ ok, id, title, tags }`, not the body.
    A change that changes nothing writes nothing and sends no frame.
  - `log_search { query, limit? }`: query 1 to 200 characters, `limit` 1 to 20 (20 when it is not given). Answers
    `{ count, results }`, each `{ id, title, author, tags, updatedAt, snippet }`, best first.
  - `log_read { id }`: answers `{ ok, entry }` with the whole entry. A refusal is an error result `{ ok: false, error }`.
- **The role text.** One line of `ROLE_PREAMBLE` tells a Claude agent to search the Mission Log before it starts work and to
  write lasting findings to it. The agent's own `memory.md` line is unchanged.
- **Routes** (`web.ts`, browser token only; the browser is the Director). `GET /api/log?q=` answers `{ total, hits }`: the
  ranked results of the query, or the newest 20 entries when `q` is empty or missing (`total` is every entry the log holds).
  `POST /api/log` (201; `title`, `body`, `tags`), `GET /api/log/:id` (the entry), `PUT /api/log/:id` (200; the fields it
  carries change, at least one) and `DELETE /api/log/:id` (204). A bad field is 400 with its name (any other field too, and
  `author` among them), an unknown id 404. Without a `missionLog` option the routes are 404 and the tools say the log is not
  available.
- **Frame.** `log` is `{ changed: [{ id, title }], removed: [id] }`: ids and titles of what a write changed, never a body. It
  is not in `StateSnapshot`. The page asks again when it gets one, and when it gets a `state` (a connect or a reconnect, when
  frames may have been missed).
- **The screen** is a view of its own, MISSION LOG (`MissionLog.tsx`, `log.ts`, `log.css`; `store.view` is `log`), with a MISSION
  LOG key in the top bar and a LOG key in the phone bar. A search box with the count under it, the results as keys (id, author,
  time, title, tags, snippet), and beside them the open entry: the title, who and when, the tags and the body in a preformatted
  block (`white-space: pre-wrap`, wrapped; the text is React text, so nothing in it is read as HTML or markdown). EDIT, DELETE
  (which asks first) and CLOSE are the Director's; NEW ENTRY and the form (title, tags, entry) are his too. Under 900 px the
  entry replaces the list while it is open. An entry that is removed while it is open closes with a status line, a `log` frame
  that names what changed is said in the live region, and after a close or a delete the keyboard goes to the row or to the title.

## Decisions

- **The index is in `src/server`, not `src/shared`.** Only the server searches; a new shared module would have to be added to
  the two package lists.
- **Tags are searched like a word of the title.** The brief says title (weighted) and body; tags that search could not find
  would be labels for nothing.
- **No stemming, no stop words, one-character words dropped.** BM25 already gives a word that is everywhere little weight; a
  stemmer is a language. See the limits.
- **`log_write` with an `id` changes only the fields given**, like `task_update`, so an agent that fixes a title does not send
  the body again. `PUT /api/log/:id` does the same, although PUT usually replaces: the page sends all three fields, and a
  caller that sends some changes those. It is named PUT because the brief names it so.
- **The Director's edit keeps the author.** The entry is still the finding of the agent that wrote it; `updatedAt` says
  when it was touched last, not by whom.
- **No delete for agents, as for tasks.** A wrong entry is changed by its author or removed by the Director.
- **The id of a removed entry is not given again**, the rule Flight Plan arrived at after its review, by a file of its own
  (`.seq`) written only at a remove, so that a create costs one file write.
- **Everything is in memory.** Search needs the bodies for the snippets and 2000 entries is small; reading files for each
  search would be slower and no simpler.
- **The page asks, the frame does not carry.** The brief says the frame has ids and titles only. So the page keeps no entries in
  its state: it asks `GET /api/log` for the list and `GET /api/log/:id` for the open entry when a frame comes.
- **The list shows the newest 20, and search finds the others.** One cap (20) for the tool and the page, so the cap has one
  place. Paging is not in the brief.
- **A plain `<pre>`, not a markdown renderer.** The brief allows it, it is as safe as a renderer can be, and agents write
  short notes whose line breaks are what matters.
- **The top bar gap went from 14 to 10 px**: the seventh key (`MISSION LOG`, 117 px) made `+ STAFF A CONSOLE` wrap at 1280 px.
  The phone bar has seven keys at 390 px (44 to 58 px wide, 48 px tall).
- **No option and no environment variable.** The limits are constants (`constants.ts` and `protocol.ts`).

## Rejected

- Versions or a history of an entry: not in the brief. An edit replaces the text.
- Folders, links between entries, pinning, import of an agent's `memory.md`: not in the brief.
- Embeddings or a database: the brief says BM25 in plain JS. Semantic search (the backlog's later item) was left out, not built under another name: it needs a trained model, and gonogo ships none, downloads none and calls no outside service. What can be computed from the log alone (co-occurrence, shared words) is lexical, which BM25 already is; Star Chart (`docs/star-chart-spec.md`) shows the links that are there.
- Sending an agent the entries that match its task: the agent searches when its role text tells it to.
- Highlighting the match in a snippet: the snippet is plain text and the page shows it as it is.

## Known limits

- shortcut: every entry is held in memory (at the limits, 2000 entries of 20000 characters is about 40 MB) and the page lists the
  newest 20 without paging. Read the files on demand and page the list if a log ever gets that big (`missionlog.ts`).
- shortcut: no stemming, no phrase or prefix search, and a word is a run of Unicode letters or digits, so text in Chinese or
  Japanese is one long word. Add a tokenizer for the language if the log is not mostly in a language that spaces separate
  (`logsearch.ts`).
- shortcut: `author` is an agent name, so after a rename the agent can no longer change what it wrote (the Director still
  can), and a new agent hired under the name of a removed one may change what the old one wrote (`missionlog.ts`).
- The index is built at start. A file edited or added by hand while gonogo runs is not seen until the next start, and an
  edit made in the page afterwards writes the whole file again, so the hand edit is lost.
- Two writers at once (the Director's form and an agent) are not told of each other: the last write wins. The page shows the
  new text of an open entry after a change but does not warn a form that is open on it.
- Every agent reads what every agent wrote, as with messages: an entry is text that another agent's model may follow. It is
  not a place for secrets (the files are plain text) and not a safe channel from an untrusted agent.
- The BM25 constants and the title weight were chosen, not tuned on a real log.
- Tested with a temporary folder and a fake clock (the store), the index on its own (ranking, ties, replacing and removing,
  snippets), the routes and the tools with a fake store, a real server with the stand-in agent (two agents writing, searching,
  reading and being refused, the Director's routes, the frame, the files) and the page in Chrome (below). Never run with a
  real `claude`: whether a model searches the log before it starts and writes findings worth keeping is its choice, and
  was not tried. Gemini and the other engines get the tools through the same MCP server and were not run.
- The page was opened in Chrome at 1280 px and in Chrome's 390 px phone emulation against a real server with the stand-in
  agent: no horizontal overflow, every key and field at least 44 px tall, the seven keys of the phone bar fit, the top bar
  is one line at 1280 px, a search, an entry opened (a `<script>` in its text shown as text), an edit with its errors, a new
  entry, a delete with its question and the focus after it, an entry written from outside showing up in the open list, and an
  entry removed from outside closing the reader. Those clicks were made by script (DOM events), not by hand or with a screen
  reader. Not tried: Firefox, Safari, a screen reader, a log of hundreds of entries, and the edit form open while an agent
  rewrites the entry.
