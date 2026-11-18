# Spec: Star Chart

Written and built 2026-11-18. Feature of backlog section 3 (Memory), "Knowledge graph and its panel", on top of the Mission Log
(`docs/mission-log-spec.md`).

## Intent

The Mission Log is a list of entries found by words. Star Chart shows how the entries hang together: who wrote what, which tags
meet, which entries point at which. It is worked out from the entries alone, with no model, and drawn with SVG and CSS, with no
graph library. The same chart is a set of lists that a keyboard, a screen reader and a phone can use.

## Design

- **The graph** (`src/server/logchart.ts`, `MissionLog.chart()`, `GET /api/log/chart`): `{ total, shown, nodes, edges }`
  (`LogChart`). A node is `{ id, kind, ref, label, weight }`: an `entry` (`entry:l12`, the label is its title; weight 1 plus the
  entries that name it), a `tag` (`tag:build`, weight the entries that have it) or an `author` (`author:ana`, weight the entries
  they wrote). An edge is `{ from, to, kind, weight }`:
  - `tag`: entry to tag. `author`: entry to author.
  - `mention`: from an entry whose title or body holds the id of another entry (`l12`) to that entry, once for each pair.
    An id counts as a word: not inside a longer one (`cl12`, `l12x`, `l12_b`, `l12-b`, `x-l12`), never the entry's own, and only an
    entry that is drawn. `l0`, `l012` and ids of more than six digits are not ids.
  - `cooccur`: between two tags that are together in at least two drawn entries (`COOCCUR_MIN`), weight the count. One shared entry
    is already shown by the two tag edges.
- **What is drawn:** the newest `CHART_ENTRIES_MAX` (150) entries by change time, the `CHART_TAGS_MAX` (40) tags those use most (ties
  by name; the others and their edges are left out), and every author of those entries. At most about 250 nodes, so the layout
  costs a few milliseconds. `total` is every entry the log holds and `shown` how many are drawn; the page says so. The order of the
  nodes is fixed (entries newest first, tags by use, authors by count), so the same log gives the same answer.
- **The layout** (`src/client/chart.ts`): a force layout, 150 rounds, in the page: nodes push each other away, edges pull their
  ends together (a `cooccur` edge less), a small pull to the middle keeps lone nodes and islands on the page. It starts from a spiral
  in node order and uses no random number, so the same chart gives the same picture and nothing moves on a redraw. The pulls leave a
  dense log as a ball in the middle, so the finished picture is stretched about its middle to fill the frame, at most twice (`MAX_GROW`).
- **The drawing** (`StarChart.tsx`, `chart.css`): one SVG that scales to its column. A circle is an entry, a diamond a tag and a
  square an author (the shape says it as well as the fill); each has a dark outline. A tag and an author show their name (an
  author as its call sign, as elsewhere); an entry shows its id when there are 40 nodes or fewer, and otherwise under the pointer, with
  the keyboard or when open. A `mention` is an arrow, a `cooccur` is dashed. A name that would run past the right edge (counted at about 6.6 units a character) is
  written to the left of its node. The colours are tokens, so the four liveries hold; nothing moves.
- **Choosing a node:** an entry opens in the Mission Log's reader (the same one as a row of the list: edit, delete, close). A tag or
  an author lights what it is joined to and dims the rest; choosing it again clears. The line under the drawing says what is chosen.
- **The keyboard:** the drawing is one tab stop (roving tabindex); the arrow keys, Home and End walk the nodes, Enter or Space
  chooses. Each node is a `role="button"` with a name ("Entry l12: Cache key", "Tag build: 5 entries"). An entry's key, in the drawing and in LINKS, has the id of the Mission Log's rows, so CLOSE in the reader puts the focus back on it.
- **The list alternative** (LINKS, `links()`): the same nodes and edges as lists. Each entry is a row (id, author, title, tags) that
  opens it, with the ids it names and the ids that name it as buttons. Each tag lists its entries as buttons and the tags it shares
  entries with, each author its entries. Real buttons of 44 px, no scrolling sideways.
- **Where it lives:** the Mission Log page has a switch of three keys, ENTRIES (the search, as before), CHART and LINKS. The entry
  that is open, the forms and the notices are the page's own, so they work in all three. The chart is asked when CHART or LINKS is
  shown and again when a `log` frame says something changed. No top-bar key, no frame, no option, no saved state.

## Decisions

- **The chart is worked out on the server, the layout in the page.** Only the server has every body (for the mentions), the page has
  the screen. The graph is small and the layout is deterministic, so it is easy to test on either side.
- **A cap, not paging:** 150 entries and 40 tags keep the layout and the SVG cheap, and a picture of more would be unreadable.
- **No `mention` from a title or body inside a longer word:** `l3` is also a cache level and a part number; the rule is the same as
  for a word in the search.
- **No graph library, no canvas:** the brief says SVG and CSS; the chart is real DOM, so each node can be a button.
- **The switch is in the Mission Log page, not in the top bar:** the bar has no room for another word (the Mission Log spec).

## Rejected

- Semantic or embedding-based links between entries: no model ships with gonogo (see the backlog item, not built).
- Moving nodes by hand, zoom and pan, a saved layout: not asked for; the picture is a function of the log.
- Edges from words that two entries share: that is what the search is for, and with no stemming it would be noise.

## Known limits

- shortcut: only the newest 150 entries and their 40 most used tags are drawn; page by date or tag if a log needs more (`logchart.ts`).
- shortcut: the layout runs in the page, on the main thread, and costs the square of the node count; move it to a worker if the cap is
  ever raised a lot (`chart.ts`).
- A mention is the text `l12` where an entry `l12` exists: an unrelated `l3` in a note is read as one, and a mention of an id that is
  not drawn (an old entry beyond the cap) is left out.
- On a phone the drawing is small (its names are about 5 px) and its nodes are not 44 px targets; LINKS is the page for a phone, and
  the drawing is still there to look at.
- The drawing is not a replacement for the lists for a screen reader: it has names for its nodes but no description of the edges. LINKS
  has them.
- Tested: the graph on its own (mentions, co-occurrence, the caps, order, the edges that name only nodes that exist), the layout and
  the lists on their own (bounds, same input same output, 150 entries under a second, strange edges), the route with a fake and with a
  real server and the stand-in agent (scenario 34), and the page in Chrome at 1440 and 390 px in Instrument and Night Shift (the clicks
  by script). Contrast of every colour it uses was computed for the four liveries (text 4.5:1; the outline of each shape and the lines 3:1 or better against the panel; the pale fill of a tag or an author is about 1.2:1, so the outline and the shape carry it, not the fill). Not
  tried: Firefox, Safari, a screen reader, a log of hundreds of entries, a layout that someone judges to be good.
