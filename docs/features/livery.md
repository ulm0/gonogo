# Livery: themes

<LiveryMock class="doc-mock" />

LIVERY (round key in the top bar) picks gonogo's look and can ask an agent to design a new one. Design: [`docs/livery-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/livery-spec.md).

## Liveries

A livery sets the 28 colour tokens of `src/client/tokens.css` (`--body`, `--panel`, `--key`, `--text`, `--lcd`, the signals, ...). Each is a plain CSS colour: `#rgb`, `#rrggbb`, `rgb()`, `hsl()` or `oklch()`; no alpha, names or `var()`.

Built in: **Instrument** (default), **Night Shift** (dark graphite, mint screen), **Low Ink** (near-white paper, thin lines, pale tints), **Low Ink Dark** (dim graphite, pale text, thin quiet lines), **High Contrast** (black on white, all text 7:1 or better) and **High Contrast Dark** (white on black, all text 7:1 or better).

**Refused unless:** every text token reaches 4.5:1 (WCAG 2) on its surfaces (pairs in the spec and `src/shared/livery.ts`), and `--lcd` (terminal screen) is dark.

The page lists rows with swatch, APPLY, and DELETE for custom ones (asks first). The choice is stored on the server for every device. Terminal follows `--lcd` and `--lcd-text`; browser bar (`theme-color`) follows `--body`.

## Design one

Write a line (up to 500 characters), pick an agent (FLIGHT by default), press ASK FOR A LIVERY. The agent calls `livery_submit` (`name`, `description`, `tokens`); the result is checked (refusals list failing pairs), saved, and announced as a `LIVERY` item in the Downlink. **It is not applied**: pick it in the list. Any agent can call `livery_submit`; at worst it adds one of 12 custom liveries or replaces an unused custom one.

## Files

`~/.gonogo/liveries/<slug>.json` per custom livery (name, description, author, tokens); `~/.gonogo/livery.json` for the chosen one. Read at start. Copy between machines or write by hand: the same check applies and failing files are skipped with a warning.

## API

- `GET /api/liveries` (also what `PUT` and `DELETE` answer): `{ "current": "night-shift", "liveries": [{ "slug", "name", "description", "builtin", "author", "tokens" }] }`
- `PUT /api/livery` `{ "slug": "night-shift" }`
- `DELETE /api/liveries/:slug` (custom only; 403 for built-in)
- `POST /api/liveries/design` `{ "to": "boss", "brief": "..." }` (201, the send result)

The state snapshot has `livery`; the WebSocket has a `livery` frame.
