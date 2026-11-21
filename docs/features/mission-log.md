# Mission Log: shared memory

<MissionLogMock class="doc-mock" />

MISSION LOG (top bar; LOG on a phone) is one memory shared by all agents and you; each agent keeps its own `memory.md` too. Design and limits: [`docs/mission-log-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/mission-log-spec.md).

## Entries and search

- Title (at most 200 characters, one line), body (at most 20000), up to 8 tags (lowercase words, at most 30 characters), author, created and changed times. Ids `l1`, `l2`, ... never reused. At most 2000 entries.
- Search is BM25 over title, tags and body (title and tag words count three times). A word is two or more letters or digits. Light stemming for English and Spanish endings (`builds`, `building` and `build` find each other; `configuraciones` finds `configuración`), and a word of three letters or more also finds the longer words it begins (`anch` finds `anchor`), ranked below the whole word. It knows no irregular word (`built` does not find `build`) and keeps the ending of a word of three letters or fewer (`using` does not find `use`). No phrase search, no semantic search. Results show a snippet; an empty search lists the newest.

## The page

Search box with count, up to 20 results, entry beside (below on a phone). Text shows as typed, not HTML or markdown. NEW ENTRY, EDIT, DELETE (asks first). Agent writes appear live. CHART and LINKS beside ENTRIES: [Star Chart](./star-chart.md).

## Agent tools

In each Claude agent's `--allowedTools`; its role text says to search before work and write lasting findings.

| Tool | Does |
|---|---|
| `log_search` | `query`, `limit` (at most 20); returns id, title, author, tags, snippet |
| `log_read` | `id`; the whole entry |
| `log_write` | `title`, `body`, `tags`, and with [Knowledge anchors](./knowledge-anchors.md) on, `anchors`, to create; or `id` of the caller's own entry to change fields |

The server stamps the author. Agents cannot edit others' entries or delete; you can. Agents read entries like messages: keep secrets out.

## Files

`~/.gonogo/mission-log/<id>.md` per entry: front matter (`id`, `title`, `tags`, `author`, `createdAt`, `updatedAt`, and `anchors` when there are some, each value JSON on one line), `---`, body. The index is built at start: hand edits show after a restart, and a page edit before then overwrites the file. Non-entry files are skipped with a warning.

## API

- `GET /api/log?q=cache` -> `{ "total": 40, "hits": [{ "id", "title", "author", "tags", "updatedAt", "snippet" }] }`, best first, newest 20 when `q` is empty.
- `POST /api/log` `{"title": "Cache key", "body": "...", "tags": ["build"]}` (201).
- `POST /api/log/:id/recheck`: [Knowledge anchors](./knowledge-anchors.md), the Director's key.
- `GET /api/log/:id`, `PUT /api/log/:id` (fields to change), `DELETE /api/log/:id` (204).
- WebSocket frame `log`: `{ "t": "log", "changed": [{ "id", "title" }], "removed": [ids] }`, no text.
