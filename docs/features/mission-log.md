# Mission Log: shared memory

<MissionLogMock class="doc-mock" />

MISSION LOG (top bar, or LOG in the phone bar) is one memory that every agent shares, and that you can read and write. Each
agent keeps its own `memory.md` as before. Design and limits: [`docs/mission-log-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/mission-log-spec.md).

- **An entry** has a title (at most 200 characters, one line), a body (at most 20000 characters of text), up to 8 tags
  (lowercase words of at most 30 characters), who wrote it (you, or an agent) and the times it was made and last changed. Ids
  are `l1`, `l2`, ... and are not given twice. At most 2000 entries.
- **Search** ranks the entries by BM25 over the title, the tags and the body; a word of the title or a tag counts three times a
  word of the body. A word is a run of letters or digits of two characters or more; there is no stemming (`builds` does not find
  `build`) and no phrase search. Each result shows a piece of the body around the best match. An empty search lists the newest.
- **The page** has a search box with the count under it, the results (at most 20) and the open entry beside them (below them on a
  phone, in place of the list). The text of an entry is shown as it was typed, never as HTML or markdown. NEW ENTRY, EDIT and
  DELETE (which asks first) are yours. An entry an agent writes while the page is up shows in the list at once.
- **The agents' tools.** `log_search` takes `query` and `limit` (at most 20) and answers the best entries, each with its id,
  title, author, tags and snippet. `log_read` takes `id` and answers the whole entry. `log_write` takes `title`, `body` and
  `tags` to make an entry, or an `id` of an entry the caller wrote to change the fields given. The server stamps the author. An
  agent cannot change an entry another agent wrote, and cannot delete; you can do both. The role text each Claude agent gets
  says one line about them (search before work, write lasting findings), and they are in its `--allowedTools`. An agent reads
  what other agents wrote: treat an entry like a message, as text a model may follow, and keep secrets out of it.
- **The files.** One `~/.gonogo/mission-log/<id>.md` for each entry: a front matter with `id`, `title`, `tags`, `author`,
  `createdAt` and `updatedAt` (each value is JSON on one line), `---`, and the body. You can read them, and copy them. The
  index is built when gonogo starts: an entry you edit or add by hand is seen after a restart, and an edit made in the page
  before that writes the whole file again. A file that is not an entry is skipped with a warning and left alone.
- **API.** `GET /api/log?q=cache` answers `{ "total": 40, "hits": [{ "id", "title", "author", "tags", "updatedAt", "snippet" }] }`,
  best first, or the newest 20 when `q` is empty. `POST /api/log` with `{"title": "Cache key", "body": "...", "tags": ["build"]}`
  (201), `GET /api/log/:id`, `PUT /api/log/:id` with the fields to change, and `DELETE /api/log/:id` (204). The WebSocket
  has a `log` frame, `{ "t": "log", "changed": [{ "id", "title" }], "removed": [ids] }`, with no text in it. There is no option
  for it.
