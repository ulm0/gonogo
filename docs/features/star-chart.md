# Star Chart: the log as a graph

<StarChartMock class="doc-mock" />

CHART and LINKS in the [Mission Log](./mission-log.md) page show its entries, tags and authors as a graph and as lists, computed from the entries alone (no model). Design and limits: [`docs/star-chart-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/star-chart-spec.md).

| Shape | Node | Line | Edge |
|---|---|---|---|
| Circle | entry (labelled with its id) | thin | entry with its tag or author |
| Diamond | tag | arrow | entry whose title or text holds another's id (`l12`), pointing at it |
| Square | author (call sign) | dashed | two tags together in at least two entries |

- An id counts only as a word of its own (not `cl12`, `l12x`, `l12-b`), never the entry's own, only for a drawn entry.
- Drawn: the newest 150 entries, the 40 most used tags they use, their authors; a line under the chart gives the total.
- Deterministic force layout: the same log gives the same picture. Over 40 nodes an entry shows its id only under the pointer, with the keyboard, or when open.

## Using it

- Click or tap an entry: opens in the reader on the right (edit, delete, close).
- Click a tag or author: what it joins lights, the rest dims; click again to clear.
- Keyboard: one Tab stop; arrows, Home, End walk nodes; Enter or Space chooses.
- **LINKS** is the same graph as lists (for screen readers and phones): per entry id, author, title, tags, and buttons for ids it names and ids naming it; per tag its entries and the tags it shares entries with; per author its entries.

## API

`GET /api/log/chart` -> `{ "total": 6, "shown": 6, "nodes": [...], "edges": [...] }`.

- Node: `{ "id": "entry:l2", "kind": "entry", "ref": "l2", "label": "Cache misses on CI", "weight": 2 }`; `kind` is `entry`, `tag` or `author`. Entry `weight` is 1 plus entries naming it; tag or author, entries having it.
- Edge: `{ "from": "entry:l2", "to": "entry:l1", "kind": "mention", "weight": 1 }`; `kind` is `tag`, `author`, `mention` or `cooccur`.

No frame (the page refetches on a `log` frame), no option, no saved state.
