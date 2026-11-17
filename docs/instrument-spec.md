# Build spec: the Instrument restyle

Written 2026-11-17. The owner found the Annunciator look (`docs/design/annunciator/`) too high in contrast and chose
"Instrument" instead: a piece of hardware in the spirit of small music devices (modules, keys, LEDs, tiny LCD screens),
with its own colours. This is a restyle of the client that already works: the components, the logic in `.ts` files, the
store, the API and every behaviour stay. What changes is the look, and the markup only where the look needs it.

Mockups (static HTML, inline values are exact): `docs/design/instrument/InstRoom.dc.html` (desktop room, wall, your
console, selected console), `InstPhone.dc.html` (phone room), `InstGo.dc.html` (phone go or no-go). Ignore the mock
tool's `<x-dc>`, `<sc-for>`, `<sc-if>` and `support.js`; `renderVals()` holds sample data, not an API. Views without an
Instrument mockup (staffing, edit, custom command, confirmations, comm loop, console states, system states, phone
console and terminal keys) keep their current layout and content and take the same language.

## The language

Already written by the lead, do not edit: `src/client/base.css` (tokens and primitives) and the fonts in `main.tsx`
(Geist for text, Geist Mono for labels and keys, Doto for LCD numbers; all bundled).

- **Body and modules.** The page is the device (`--body`). Every block is a module: `.module` (panel colour, 1px
  `--edge`, 12 px radius), labelled with `.label` and a letter or number like the print on a panel (`A · MISSION`,
  `B · SEQUENCE`, `C · T-MINUS`, `D · MAX Q`, `E · OPERATIONS`). Spacing between modules 12 to 16 px.
- **Keys.** Every button is `.btn`: a key with a 3 px bottom edge that presses down. `data-kind="primary"` is the dark
  key (one per block at most), `danger` keeps the key and turns the text raspberry, `data-size="big"` for the one action
  of a screen, `data-shape="round"` for the Max Q stepper.
- **LEDs.** State is a `.led` dot (`--led` from the tile kind or the tint; `data-on="true"` glows, `data-blink="true"`
  breathes for working and needs-you). Never a whole block in a signal colour, except the gentle tints below.
- **Tints.** The block that needs the Director, a GO and a NO-GO use `.flood[data-tone=amber|go|nogo]`: a pale tint
  with a matching edge and LED, text stays `--text`. A finished poll tints the T-MINUS module only, not the whole wall.
- **LCD screens.** `.lcd` (dark olive, sunk) holds the mission clock (`.lcd-num`, Doto), the poll count, the console's
  two lines on a working or needs-you tile, and the terminal. Text on it is `--lcd-text` or `--lcd-dim`. The xterm theme
  of `TerminalPane.tsx` follows: background `#2b2f2a`, foreground `#cfd8cb`, cursor `#cfe6c9`, selection a dimmer green.
- **Tiles.** `.tile[data-kind]` is a console module: LED, call sign in `.tile-legend`, a number `01` to `24` at the
  right (the cell number), an LCD strip with the two lines for working and needs-you (a light `--well` strip for idle),
  then the state line. Open seats are dashed and transparent; stopped is sunk (`--well`).
- **Words.** Big words become calm: the poll word is Geist 600 at about 28 to 34 px, not a 150 px slab; numbers that
  count (clock, `3/5`, `2/3`) use Doto on an LCD or on the key face. The Max Q block is a knob: a conic ring of
  `--work` over `--edge` with the `n/limit` in the middle (see `InstRoom`), plus round − and + keys.
- **Voice** stays: Director, FLIGHT, consoles, "asks for a go", GO / NO-GO.
- **Contrast.** Text on `--body` and `--panel` uses `--text`, `--text-2` or `--muted` only (all 4.5:1 or more). Never
  `--edge`, `--edge-2` or a signal colour as text, except `--nogo-text` on a key or tint and `--work` on a chip edge.

## Builders and files

- **R (shell):** `src/client/shell.css` (rewrite it against the new base), `App.tsx`, `RoomView.tsx`, `WallView.tsx`,
  `TerminalPane.tsx` (theme only), `room.ts` and `wall.ts` only if a helper needs a new field (for example the cell
  number), `test/client-room.test.ts`, its part of `test/client-store.test.ts`.
- **F (forms and loop):** `src/client/forms.css` and `src/client/loop.css` (rewrite them against the new base),
  `HireForm.tsx`, `Activity.tsx`, `Brief.tsx`, `form.ts` and `loop.ts` only if needed, `test/client-forms.test.ts`.

Class names from the old base that the markup uses stay valid (`.btn`, `.tile`, `.chip`, `.flood`, `.ink`, `.field`,
`.input`, `.textarea`, `.label`, `.legend`, `.disp`, `.hint`, `.error`, `.sr-only`) but their meaning is the new one;
remove markup and CSS that only made sense in the old look (giant slabs, hatch patterns, white-on-black rings, `--k`,
`--w`, `--amber`, `--font-disp`, `--font-legend` and the other old tokens: none of them exist any more). Grep your files
for `var(--` and fix every token that base.css no longer defines.

Rules from `docs/redesign-spec.md` "Rules for every builder" still hold (own files only, empty npm config, no git
writes, no npm install, no real claude, scratch folder, private builds, accessibility, 44 px targets, reduced motion).
