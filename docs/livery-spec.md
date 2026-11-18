# Spec: Livery

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): visual themes, and an agent that
designs one; the equivalent of Munder Difflin's simulations. Nothing else in gonogo changes shape: a livery only changes the
values of the colour tokens.

## Intent

The look of gonogo is a set of colour tokens (`src/client/tokens.css`). A livery is a value for each of them. Four ship; the
Director can ask any agent to design another from a line of text, and the agent's answer is checked by a program, not by the
agent: a livery whose text cannot be read is refused. The choice is kept on the server, so the desk and the phone show the same.

## Design

### The tokens and the colours

`src/shared/livery.ts` (used by the server and the page) lists 28 tokens with the role of each: the surfaces (`--body`,
`--panel`, `--key`, `--well`), the lines (`--edge`, `--edge-2`), the text (`--text`, `--text-2`, `--muted`), the screen (`--lcd`
and its three text colours), the four signals with their tints, inks and keys, and two track colours. A test reads the blocks
of `tokens.css` (`:root` for Instrument, `[data-livery='<slug>']` for the other three) and fails if a colour token is missing
from the list, or if a livery that ships differs from the CSS.

A value is `#rgb`, `#rrggbb`, `rgb()`, `hsl()` or `oklch()`: no alpha, no names, no `var()`, at most 64 characters, commas or
spaces but not both. Each form is parsed with a strict pattern, so a value can never carry a `;`, a brace or a second property.
A livery must hold every token and no other: it is whole, so it can be checked and never depends on what was on before.

### The rule

WCAG 2 contrast (relative luminance of the sRGB colour, ratio `(L1 + 0.05) / (L2 + 0.05)`), at least 4.5:1, over one list of
pairs, `CONTRAST_PAIRS`, that is also what the brief to the agent quotes and what the tests walk:

| Text | On |
|---|---|
| `--text`, `--text-2` | `--body`, `--panel`, `--key`, `--well`, `--you-tint`, `--go-tint`, `--nogo-tint` |
| `--muted` | `--body`, `--panel`, `--key`, `--well` |
| `--work` | `--panel`, `--key` (chips) |
| `--nogo-text` | `--body`, `--panel`, `--key`, `--nogo-tint` |
| `--you-ink` / `--go-ink` | `--you-tint` / `--go-tint` |
| `--panel` | `--text` (the primary key) |
| `--lcd-text`, `--lcd-dim`, `--lcd-warm` | `--lcd` |

One more rule: `--lcd` must be dark (relative luminance under 0.2), because the terminal draws its own colours (Claude Code's
palette) for a dark screen. The ratio is not rounded up: 4.49 fails.

### The four that ship

| Slug | Look | Lowest pair |
|---|---|---|
| `instrument` | The default and today's look: warm grey, a green screen. Applied by no style at all: the CSS is the livery. | 4.86 |
| `night-shift` | Graphite with a mint screen and softer signals, for the night. The only dark one. | 5.47 |
| `low-ink` | Near-white paper, thin grey lines and pale tints, so that little toner is used when printed. | 6.66 |
| `high-contrast` | Black on white with black lines and strong signals. Every pair is at least 7:1 (a test asserts it). | 8.44 |

They are not copies of a brand: the palettes are made here. Every one of them passes `checkLivery`, in a test.

### Where it lives

- `~/.gonogo/liveries/<slug>.json`, one for each custom livery: `{ "version": 1, "name", "description", "author", "tokens" }`.
  The folder is mode 0700 and the files 0600; each is written whole through a temporary file and a rename, before the memory
  changes. A file that is not a livery (wrong version, a value that is not a colour, a pair under 4.5:1, a name that does not
  match the file) is skipped with a warning and left alone. At most 12 custom liveries.
- `~/.gonogo/livery.json`: `{ "version": 1, "current": "<slug>" }`, mode 0600. An unknown slug or an unreadable file means the
  default.
- The slug is the name in lowercase words joined by dashes. A submit under the slug of a livery that ships is refused (the name
  is taken); under the slug of a custom one it replaces it, unless that one is in use (409: a replace would change the look on
  every device without the Director).

### The agent

`livery_submit` (`name`, `description`, `tokens`) is in the allowed tools of every Claude agent. It is checked as above; a refusal
is an error whose text lists the faults (up to 12, then "and N more") so that the agent can fix them and call again. A good
livery is saved with the caller's name as author (never a field of the call), the browsers get a `livery` frame, and the Director
gets a Downlink event, `LIVERY`: `ana submitted the livery "Dusk". Pick it in the Livery view to try it.` Submitting never applies
it; the Director chooses. The event is not forwarded by Relay.

`POST /api/liveries/design` with `{ "to", "brief" }` (`to` is an agent name or `boss`, the default) sends that agent a message
from the Director, subject `Livery: design request`, through the normal path (Max Q, Redline and held mail apply). The message
holds the brief (at most 500 characters), the whole token list with the role of each, the contrast rule from the same list the
check uses, and the instruction to call `mcp__gonogo__livery_submit`. About 2.5 KB.

### The page

- **Routes.** `GET /api/liveries` (the view), `PUT /api/livery` with `{ "slug" }`, `DELETE /api/liveries/:slug` (a custom one;
  one that ships is 403; the chosen one falls back to the default), `POST /api/liveries/design` (it answers with the send result of the message). The others answer with the view,
  `{ "current", "liveries": [{ slug, name, description, builtin, author, tokens }] }`, which is also in the state snapshot and in
  a `livery` frame. The tokens of every livery are in it (it is what the swatches draw), about 1 KB each.
- **Applying.** `look.ts` sets each token as a property of `:root` (`style.setProperty`) and `data-livery` and `data-scheme`
  attributes; the default sets none. Properties through the CSSOM, not a `<style>` element, so that a Content-Security-Policy
  of a reverse proxy cannot block it. The values are filtered again on the page (`liveryProperties`), so a value that is not a
  colour never reaches it. `color-scheme` follows the body (dark when its luminance is under 0.18), so scrollbars and native
  controls match.
- **No flash.** The browser keeps a copy of the livery of the last visit in `localStorage` (`gonogo.livery`, checked as a submit
  is) and puts it on before the first render, so a dark look never opens light. The server is the truth: the next state frame
  replaces the copy.
- **The browser's bar.** `<meta name="theme-color">` is set to `--body` and `<meta name="color-scheme">` to light or dark.
- **The terminal.** The xterm theme is built from the livery that is on: the background and cursor accent from `--lcd`, the
  foreground and cursor from `--lcd-text`, the selection a third of the way from `--lcd` to `--lcd-text`. It repaints in place
  when the livery changes, on any device. xterm gets plain `#rrggbb` (`toHex`), whatever notation the livery used.
- **The logo** (`docs/brand/lockup.svg`) is a picture with colours of its own: on a dark livery it is turned with a CSS filter.
- **The view.** A round half-filled key in the top bar (named Livery for a screen reader; there is no room for a seventh word at
  1280 px, and the long name of the unit, `OPERATIONS UNIT`, now gives way below 1400 px) opens LIVERY: a row for each livery
  with a swatch of eight of its colours, the name, the description, where it comes from, APPLY (disabled and marked IN USE for
  the chosen one) and, for a custom one, DELETE, which asks first. Under the list, DESIGN ONE: a line of text, who to ask and
  ASK FOR A LIVERY. On a phone a row stacks and its keys take the width.

## Decisions made

- Whole liveries only (every token). A partial one would have to be merged with a base before it could be checked, and the
  result would depend on what was chosen before.
- Contrast is a pass or fail on one list of pairs. The pairs were taken from how the stylesheets use each token; a pair that
  Instrument itself fails (`--work` on `--body`, 4.34:1, where no chip sits) is not on the list.
- Colour forms without alpha: a contrast ratio of a translucent colour depends on what is behind it.
- Properties on `:root` through the CSSOM, not a style element (CSP), and the default sets nothing (the CSS stays the truth).
- The Director chooses; an agent only submits. A livery that arrives is a Downlink event, not a change of look.
- `--lcd` stays dark: Low Ink is therefore not a light screen, and its ink saving is in the page, where most of the area is.
- A round key and not a word in the top bar; the phone bar keeps its seven keys.
- `look.ts` and not `livery.ts` for the page helpers, because `Livery.tsx` and `livery.ts` differ only in case and a macOS
  checkout cannot hold both.
- Two small layout fixes the new key needed, both in `shell.css`: the unit name gives way below 1400 px, and the keys of the
  phone bar have 4 px of padding (seven keys with the unread count of DOWN were 14 px too wide at 390 px before this).

## Known limits

- The custom liveries are read at start: a file put in the folder by hand shows after a restart.
- An `oklch()` colour outside the sRGB gamut is clipped per channel for the contrast check; a browser maps it more gently, so
  the ratio can differ a little for a very vivid text colour.
- Claude Code draws its own colours in the terminal. A livery cannot change them, which is why `--lcd` must be dark. The
  ANSI palette of xterm is not part of a livery.
- `livery_submit` is added to the allowed tools of Claude Code, like the other gonogo tools. Other engines (Engine Bay) see it
  in the MCP server as they see the rest, and were not tried with it; the same check applies to whoever calls it.
- A submit under the name of a custom livery replaces it, whoever made it (never the one in use).
- The brief is one line of at most 500 characters; whether a real model designs a good livery from it is not known.
