# Livery: themes

<LiveryMock class="doc-mock" />

LIVERY (the round key of the top bar) chooses the look of gonogo, and asks an agent to design another. Design and limits:
[`docs/livery-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/livery-spec.md).

- **A livery** is a value for each of the 28 colour tokens of `src/client/tokens.css` (`--body`, `--panel`, `--key`, `--text`,
  `--lcd`, the signals, and so on), each a plain CSS colour: `#rgb`, `#rrggbb`, `rgb()`, `hsl()` or `oklch()`, with no alpha, no
  names and no `var()`. Four ship: **Instrument** (the default, today's look), **Night Shift** (dark graphite with a mint screen),
  **Low Ink** (near-white paper, thin lines, pale tints) and **High Contrast** (black on white, every text at 7:1 or better).
- **The rule.** A livery is refused unless every text token reaches 4.5:1 (WCAG 2) on the surfaces it sits on (the list is in
  the spec and in `src/shared/livery.ts`), and `--lcd`, the screen of the terminal, is dark.
- **The page.** A row for each livery, with a swatch, APPLY and, for a custom one, DELETE (it asks first). What you apply is kept
  on the server, so every device that opens the room shows it; a browser also keeps a copy so that a dark look does not open light.
  The terminal follows `--lcd` and `--lcd-text`, and the colour of the browser's own bar (`theme-color`) follows `--body`.
- **Design one.** Write a line (at most 500 characters), choose who to ask (FLIGHT by default) and press ASK FOR A LIVERY. The agent
  gets a message from you with your line, the tokens with their roles, the contrast rule and the instruction to call
  `livery_submit`. Its livery is checked as above (a refusal tells it which pairs fail, so it can try again), saved under its
  name, and you get a `LIVERY` item in the Downlink. **It is not applied**: you pick it in the list. Any agent can call
  `livery_submit` (`name`, `description`, `tokens`) on its own; the worst it can do is add one of the 12 custom liveries, or
  replace a custom one that is not in use, and you can delete them.
- **The files.** `~/.gonogo/liveries/<slug>.json` for each custom livery (name, description, author, tokens) and
  `~/.gonogo/livery.json` for the one that is chosen. You can copy a livery file from one machine to another, or write one by hand
  (the same check applies when it is read, and a file that fails is skipped with a warning); it is read at start.
- **API.** `GET /api/liveries`, `PUT` and `DELETE` answer `{ "current": "night-shift", "liveries": [{ "slug", "name", "description",
  "builtin", "author", "tokens" }] }`. `PUT /api/livery` with `{ "slug": "night-shift" }`, `DELETE /api/liveries/:slug` (a custom
  one; 403 for one that ships), `POST /api/liveries/design` with `{ "to": "boss", "brief": "..." }` (201, the send result). The
  state snapshot has `livery` and the WebSocket a `livery` frame with the same view. There is no option for it.
