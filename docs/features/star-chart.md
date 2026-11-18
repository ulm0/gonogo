# Star Chart: the log as a graph

<StarChartMock class="doc-mock" />

CHART and LINKS, in the [Mission Log](./mission-log.md) page, show its entries with their tags and authors as a graph, and the same graph as lists. It is worked out from the entries alone: no model. Design and limits: [`docs/star-chart-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/star-chart-spec.md).

## What is drawn

| Shape | Node |
|---|---|
| Circle | An entry, labelled with its id |
| Diamond | A tag |
| Square | An author, by call sign |

| Line | Edge |
|---|---|
| Thin | An entry with its tag, or with its author |
| Arrow | An entry whose title or text holds the id of another (`l12`), pointing at it |
| Dashed | Two tags that are together in at least two entries |

- An id counts only as a word of its own (not `cl12`, `l12x` or `l12-b`), never the entry's own, and only for an entry that is drawn.
- Only the newest 150 entries are drawn, with the 40 tags they use most and their authors. The line under the chart says how many of the whole log.
- The page places the nodes (a force layout, no random numbers): the same log gives the same picture.
- With more than 40 nodes an entry shows its id only under the pointer, with the keyboard, or when open.

## Using it

- Click or tap an entry: it opens in the reader on the right, as from a row of the list (edit, delete, close).
- Click a tag or an author: what it is joined to lights and the rest dims. Click it again to clear.
- Keyboard: the chart is one Tab stop; the arrow keys, Home and End walk the nodes; Enter or Space chooses.
- **LINKS** is the same graph as lists, for a screen reader and a phone (the drawing is small at 390 px):
  - each entry: id, author, title, tags, and as buttons the ids it names and the ids that name it;
  - each tag: its entries as buttons and the tags it shares entries with;
  - each author: its entries.

## API

`GET /api/log/chart` answers `{ "total": 6, "shown": 6, "nodes": [...], "edges": [...] }`.

- A node is `{ "id": "entry:l2", "kind": "entry", "ref": "l2", "label": "Cache misses on CI", "weight": 2 }`; `kind` is `entry`, `tag` or `author`. For an entry, `weight` is 1 plus the entries that name it; for a tag or author, how many entries have it.
- An edge is `{ "from": "entry:l2", "to": "entry:l1", "kind": "mention", "weight": 1 }`; `kind` is `tag`, `author`, `mention` or `cooccur`.

No frame (the page asks again when a `log` frame says something changed), no option and no saved state.
