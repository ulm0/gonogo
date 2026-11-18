# Mission Log: shared memory

<MissionLogMock class="doc-mock" />

MISSION LOG (top bar, or LOG on a phone) is one memory shared by all agents and you. Each agent still keeps its own `memory.md`. Design and limits: [`docs/mission-log-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/mission-log-spec.md).

## Entries

- Title (at most 200 characters, one line), body (at most 20000 characters), up to 8 tags (lowercase words, at most 30 characters), author (you or an agent), created and changed times.
- Ids `l1`, `l2`, ..., never reused. At most 2000 entries.

## Search

BM25 over title, tags and body; title and tag words count three times a body word. A word is two or more letters or digits. No stemming (`builds` does not find `build`), no phrase search. There is no semantic search (finding `car` for `automobile`): it needs a trained model, and gonogo ships none and calls no outside service. Results show a snippet around the best match. An empty search lists the newest.

## The page

Search box with count, up to 20 results, open entry beside (below on a phone). Text shows as typed, never as HTML or markdown. NEW ENTRY, EDIT, DELETE (asks first). Agent writes appear live. CHART and LINKS beside ENTRIES show the log as a graph and as lists: [Star Chart](./star-chart.md).

## Agent tools

In each Claude agent's `--allowedTools`, with one line in its role text (search before work, write lasting findings).

- `log_search`: `query`, `limit` (at most 20). Returns id, title, author, tags, snippet.
- `log_read`: `id`. Returns the whole entry.
- `log_write`: `title`, `body`, `tags` to create; or `id` of the caller's own entry to change the given fields.

The server stamps the author. Agents cannot edit others' entries or delete; you can. Entries are read by agents like messages: keep secrets out.

## Files

One `~/.gonogo/mission-log/<id>.md` per entry: front matter (`id`, `title`, `tags`, `author`, `createdAt`, `updatedAt`, each value JSON on one line), `---`, body. The index is built at start: hand edits show after a restart, and a page edit before then overwrites the file. Non-entry files are skipped with a warning and left alone.

## API

- `GET /api/log?q=cache` answers `{ "total": 40, "hits": [{ "id", "title", "author", "tags", "updatedAt", "snippet" }] }`, best first, or the newest 20 when `q` is empty.
- `POST /api/log` with `{"title": "Cache key", "body": "...", "tags": ["build"]}` (201).
- `GET /api/log/:id`, `PUT /api/log/:id` with the fields to change, `DELETE /api/log/:id` (204).

WebSocket frame `log`: `{ "t": "log", "changed": [{ "id", "title" }], "removed": [ids] }`, no text. No option.
