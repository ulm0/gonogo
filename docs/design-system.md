---
outline: [2, 3]
---

<script setup>
import { ref } from 'vue';
import { BUILTIN_LIVERIES, CONTRAST_PAIRS, LIVERY_TOKENS, contrast } from '../src/shared/livery';

// Everything below is drawn by the app's own CSS (src/client/tokens.css and primitives.css, loaded by .vitepress/theme).
const look = ref('instrument');
const tiles = [
  { kind: 'idle', name: 'FLIGHT', n: '01', lines: ['The boss: takes the brief', 'and runs the room'], state: 'Idle 9 m' },
  { kind: 'working', name: 'FIDO', n: '03', lines: ['Architect: picks the', 'shape of the change'], state: 'Working 2 m' },
  { kind: 'needs', name: 'GUIDO', n: '04', lines: ['Permission: Bash', 'git push origin'], state: 'Needs you' },
  { kind: 'starting', name: 'DPS', n: '06', lines: ['Data: schemas', 'and queries'], state: 'Starting' },
  { kind: 'stopped', name: 'RETRO', n: '12', lines: ['Code reviewer', ''], state: 'Stopped' },
  { kind: 'open', name: 'PAO', n: '14', lines: ['Docs, README', 'changelog'], state: 'Open' },
];
const lowest = (tokens) => Math.min(...CONTRAST_PAIRS.flatMap(([text, on]) => on.map((s) => contrast(tokens[text], tokens[s])))).toFixed(2);
</script>

# Design system

gonogo looks like a piece of hardware: a warm grey body, lighter modules with thin edges, keys with a thick bottom edge, and small
dark LCD screens for numbers and terminals. Colour is a small light, or a tint on the one module that needs you; it never floods the
page. This page is drawn with the app's own stylesheets, so what you see here is what the app draws.

<HardwareMock class="doc-mock" />

## Where it lives

| File | What it holds |
|---|---|
| [`src/client/tokens.css`](https://github.com/ulm0/gonogo/blob/main/src/client/tokens.css) | Every colour, font and radius. `:root` is the default livery (Instrument); each other livery is a block on `[data-livery='<slug>']`. |
| [`src/client/primitives.css`](https://github.com/ulm0/gonogo/blob/main/src/client/primitives.css) | The classes everything is built from: type, LCD, module, LED, lamp, flood, key, field, chip, tile, console tile, the motion. Plain CSS and data attributes, no script. |
| [`src/client/base.css`](https://github.com/ulm0/gonogo/blob/main/src/client/base.css) | The app page only: box sizing, the 13 px body, no margins on headings, the focus ring, reduced motion. |
| `src/client/shell.css`, `forms.css`, `loop.css`, ... | The layout of one view each (top bar, wall, room, staffing, comm loop, ...), built from the two files above. They declare no colour of their own. |
| [`src/shared/livery.ts`](https://github.com/ulm0/gonogo/blob/main/src/shared/livery.ts) | The 28 colour tokens with the role of each, the contrast rule and the values of the four liveries. A test keeps it equal to `tokens.css`. |
| `src/client/look.ts` | Puts a livery on the page: `data-livery` and `data-scheme` on `<html>`, and the values as properties of `:root` (how a livery an agent designed arrives). |
| `.vitepress/theme/index.ts` | Loads `tokens.css` and `primitives.css` into this site. |
| `docs/brand/` | The logo, as SVG. |
| `docs/design/instrument/*.dc.html` | The mockups the sizes come from. |

The livery attribute is `data-livery`. In the app it is on `<html>`; here it can go on any element, and everything inside takes that
livery: `<div data-livery="night-shift">`.

## Liveries

Four ship ([Livery](./features/livery.md) has the feature). A livery changes colour only: shapes, sizes and fonts are the same in
every one. Each swatch below is painted with `var(--token)` inside a `data-livery` box; the value under it is the one in
`livery.ts`.

<div class="ds-liveries">
<section v-for="l in BUILTIN_LIVERIES" :key="l.slug" class="ds-frame" :data-livery="l.slug">
<div class="ds-livery-head"><span class="legend">{{ l.name }}</span><code class="ds-code">data-livery="{{ l.slug }}"</code><span class="chip" data-tone="quiet">lowest pair {{ lowest(l.tokens) }}:1</span></div>
<span class="ds-livery-desc">{{ l.description }}</span>
<div class="ds-swatches">
<div v-for="t in LIVERY_TOKENS" :key="t.name" class="ds-swatch" :title="t.role"><span class="ds-chip" :style="{ background: `var(${t.name})` }"></span><span class="ds-swatch-name">{{ t.name }}</span><span class="ds-swatch-value">{{ l.tokens[t.name] }}</span></div>
</div>
</section>
</div>

Hover a swatch for its role. The roles, in short:

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--body`, `--panel`, `--key`, `--well` | the page; a module; a key, console or input (the most raised); a sunk, stopped or read-only surface |
| Lines | `--edge`, `--edge-2` | the thin line round a module or a key; the dashed line of an open seat or a disabled key |
| Text | `--text`, `--text-2`, `--muted` | main text (and the fill of the primary key); second text, also on tints; small quiet text |
| Screen | `--lcd`, `--lcd-text`, `--lcd-dim`, `--lcd-warm` | the dark screen of the terminal, clocks and counts; its text; its quiet text; its text on a console that needs you |
| Signals | `--work`, `--you*`, `--go*`, `--nogo*` | the four signals, each with a tint, an edge or an ink where it needs one |
| Tracks | `--track`, `--seq-base` | an empty ring or bar; the empty line of a sequence track |

The rule every livery passes (the app refuses one that does not): each text token reaches **4.5:1** (WCAG 2) on every surface it
sits on, and `--lcd` stays dark, because the terminal draws its own colours for a dark screen. High Contrast reaches 7:1 everywhere.

## Signals

One colour per meaning, the same in every view.

| Meaning | Light | Tint | Where |
|---|---|---|---|
| Working | `--work` (indigo) | none: the console's small LCD lights | console LED and screen, a chip outline, the sequence track |
| Needs you | `--you` (saffron) | `--you-tint`, `--you-edge`, `--you-ink`, `--lcd-warm`; a key on it has `--you-key` | the console, the dock that asks you, the wait lamp |
| Go, idle, under the limit | `--go` (sage), `--go-lit` on a dark key | `--go-tint`, `--go-ink` | idle LED, a go vote, LINK UP, the chosen livery |
| No-go, danger, over the limit, Redline | `--nogo` (raspberry) | `--nogo-tint`, `--nogo-text` | a no-go vote, an error, a danger key, LINK DOWN, the REDLINE chip |
| Starting | `--work` | none, dashed edge | a console coming up |
| Stopped | `--edge-2` | `--well` | a stopped console |
| Open | none | none, dashed `--edge-2` | an empty seat |

Fuel (Propellant and its limits) uses the same three: under the warning share it is go, past it needs-you, over the limit no-go
(and its light blinks). Its bar runs on `--track`.

## Live components

Pick a livery for the previews:

<div class="ds-row ds-picker" role="group" aria-label="Livery of the previews">
<button v-for="l in BUILTIN_LIVERIES" :key="l.slug" type="button" class="btn" data-kind="quiet" :aria-pressed="look === l.slug" @click="look = l.slug">{{ l.name }}</button>
</div>

### Type

<div class="ds-frame" :data-livery="look">
<div class="ds-stack">
<div class="ds-spec"><span class="disp" style="font-size: 28px">Staff a console</span><code class="ds-code">.disp · Geist 600, −0.02em, line-height 1.05</code></div>
<div class="ds-spec"><span>Brief FLIGHT to start the clock. Body text is Geist 400 at 13 px, line-height 1.4.</span><code class="ds-code">body · Geist 400 13/1.4</code></div>
<div class="ds-spec"><span class="legend">FLIGHT · Flight director</span><code class="ds-code">.legend · Geist Mono 600 11.5 px, 0.04em, capitals</code></div>
<div class="ds-spec"><span class="label">A · Mission</span><code class="ds-code">.label · Geist Mono 400 10.5 px, 0.08em, capitals, --muted</code></div>
<div class="ds-spec"><span class="lcd" style="padding: 8px 12px; display: inline-block"><span class="lcd-num" style="font-size: 40px">00:04:12</span></span><code class="ds-code">.lcd-num · Doto 900, tabular figures: numbers that count, only on an LCD</code></div>
<div class="ds-spec"><span class="muted">Lowercase letters, digits and hyphens.</span><code class="ds-code">.muted / .hint · --muted, 12 px under a field</code></div>
</div>
</div>

Three families, all bundled from `@fontsource` (the app loads nothing from another host): **Geist** for reading, **Geist Mono** for
every name printed on the hardware (labels, legends, keys, chips, states), and **Doto**, a dot-matrix face, for the numbers on an
LCD. The logo's lettering is the same dot matrix, drawn as dots in the SVG. Small text on the hardware is in capitals with open
letter-spacing (0.04em to 0.08em); reading text is in sentence case.

### Keys

<div class="ds-frame" :data-livery="look">
<div class="ds-row">
<button type="button" class="btn">Loop</button>
<button type="button" class="btn" data-kind="primary">+ Staff a console</button>
<button type="button" class="btn" data-kind="quiet">Cancel</button>
<button type="button" class="btn" data-kind="danger">Stop</button>
<button type="button" class="btn" disabled>Send</button>
<button type="button" class="btn" data-shape="round" aria-label="Add">+</button>
</div>
<div class="ds-row" style="margin-top: 10px">
<button type="button" class="btn" data-size="big" data-kind="primary" style="flex: 1">Staff FIDO</button>
</div>
</div>

`.btn` is a key: 44 px tall at least, a 1 px edge with a 3 px bottom edge, Geist Mono capitals. Pressed, the bottom edge drops to
1 px and the key moves down 2 px. `data-kind` is `primary` (dark face, one per view), `quiet` or `danger`; `data-size="big"` is the
56 px key of a form; `data-shape="round"` is a 44 px disc. A disabled key (`disabled`, or `aria-disabled="true"` for one that is
busy and keeps focus) is dashed and flat.

### Lights

<div class="ds-frame" :data-livery="look">
<div class="ds-row">
<span class="ds-led"><span class="led" data-kind="working" data-on="true"></span>working</span>
<span class="ds-led"><span class="led" data-kind="needs" data-on="true" data-blink="true"></span>needs you (blinks)</span>
<span class="ds-led"><span class="led" data-kind="idle"></span>idle</span>
<span class="ds-led"><span class="led" data-kind="stopped"></span>stopped</span>
<span class="ds-led"><span class="led" style="--led: var(--nogo)" data-on="true"></span>no-go</span>
</div>
<div class="ds-row" style="margin-top: 12px">
<span class="lamp" data-link="up"><span class="led" data-on="true"></span>LINK UP</span>
<span class="lamp" data-link="wait"><span class="led" data-on="true" data-blink="true"></span>LINK WAIT</span>
<span class="lamp" data-link="down"><span class="led" data-on="true"></span>LINK DOWN</span>
</div>
</div>

`.led` is an 8 px light in `--led`. `data-kind` sets the colour from the state of a console; anything else sets `--led` itself.
`data-on="true"` adds a soft ring (`0 0 0 3px`, the light at 22%); `data-blink="true"` breathes (1.5 s), and stops when the reader
asks for reduced motion. `.lamp` is a light with a word, as in the top bar.

### Chips

<div class="ds-frame" :data-livery="look">
<div class="ds-row">
<span class="chip" data-tone="lit">Working</span>
<span class="chip" data-tone="amber">Permission</span>
<span class="chip" data-tone="go">Go</span>
<span class="chip" data-tone="nogo">Redline</span>
<span class="chip" data-tone="quiet">Idle 9 m</span>
<span class="chip" data-tone="ink">3</span>
</div>
</div>

A status in a few letters: Geist Mono 500, 10 px, capitals, a pill. `data-tone` is `lit`, `amber`, `go`, `nogo`, `quiet` or `ink`.

### Modules, floods and the LCD

<div class="ds-frame" :data-livery="look">
<div class="ds-grid">
<section class="module ds-pad"><span class="label">A · Mission</span><div class="lcd ds-lcd"><span class="ds-lcd-line">Brief FLIGHT to start the clock.</span><span class="lcd-num ds-clock">00:00:00</span></div><span class="label">No mission yet</span></section>
<section class="flood ds-pad" data-tone="amber"><span class="label"><span class="led" data-on="true" data-blink="true"></span> FIDO asks for a go</span><span>Push the branch and open the pull request?</span></section>
<section class="flood ds-pad" data-tone="go"><span class="label"><span class="led" data-on="true"></span> Go</span><span>Every console voted go.</span></section>
<section class="flood ds-pad" data-tone="nogo"><span class="label"><span class="led" data-on="true"></span> No-go</span><span>RETRO voted no-go: tests fail.</span></section>
</div>
</div>

`.module` is a panel: `--panel`, a 1 px `--edge`, 12 px corners; its name is a `.label` ("A · MISSION": a letter, a middle dot,
the name). `.flood` is the same frame tinted by `data-tone` (`amber`, `go`, `nogo`, or `lit` for a raised one); a label on a tint
turns `--text-2`. `.lcd` is a sunk dark screen (`--lcd`, `inset 0 2px 6px` shadow, 8 px corners) for clocks, counts and the
terminal; its text is `--lcd-text`, `--lcd-dim` when quiet. A wall module is a `.module` with a `.label` and, often, an `.lcd`.

### Tiles and consoles

<div class="ds-frame" :data-livery="look">
<div class="ds-tiles">
<button v-for="t in tiles" :key="t.name" type="button" class="tile room-tile" :data-kind="t.kind">
<span class="tile-head"><span class="led" :data-kind="t.kind" :data-on="t.kind === 'working' || t.kind === 'needs'" :data-blink="t.kind === 'needs'"></span><span class="tile-legend">{{ t.name }}</span><span class="tile-num">{{ t.n }}</span></span>
<span class="tile-lcd"><span class="tile-sub">{{ t.lines[0] }}</span><span class="tile-sub">{{ t.lines[1] }}</span></span>
<span class="tile-foot"><span class="tile-state">{{ t.state }}</span></span>
</button>
</div>
</div>

`.tile` is a key that holds a console, a position or an option; `data-kind` (`working`, `needs`, `starting`, `stopped`, `open`, or
none for idle) sets its light and its surface, and `aria-pressed="true"` rings the chosen one. `.room-tile` is the console of the
room: a head (`.tile-head`: light, `.tile-legend`, `.tile-num`), a small screen of two lines (`.tile-lcd`) that lights while it
works and turns warm when it needs you, and a foot (`.tile-foot`, `.tile-state`).

### Fields

<div class="ds-frame" :data-livery="look">
<div class="ds-stack" style="max-width: 420px">
<div class="field"><label for="ds-name">Name</label><input id="ds-name" class="input" value="fido" /><span class="hint">Lowercase letters, digits and hyphens.</span></div>
<div class="field"><label for="ds-bad">Working directory</label><input id="ds-bad" class="input" aria-invalid="true" value="~/no/such/folder" /></div>
<span class="error" role="note">That folder does not exist.</span>
<div class="field"><label for="ds-role">Role</label><textarea id="ds-role" class="textarea" rows="2">Architect: picks the shape of the change.</textarea></div>
</div>
</div>

`.field` stacks a mono capital label, the control and a `.hint`. `.input` is 46 px tall on `--key`; read-only turns `--well`;
`aria-invalid="true"` draws a 2 px `--nogo` edge, and the reason goes in an `.error` under it. `.textarea` is mono.

## Shape, depth and motion

| | Value | Where |
|---|---|---|
| Radius | `--radius-key` 8 px, `--radius` 10 px, `--radius-module` 12 px, 999 px | keys, inputs, LCDs; tiles and big keys; modules and floods; chips |
| Edges | 1 px `--edge`; keys and tiles 3 px at the bottom (4 px on a big key) | everything that is raised |
| Dashed | 1 px `--edge-2` | an open seat, a disabled key, a console that is starting |
| Depth | LCD: `inset 0 2px 6px rgb(0 0 0 / 35%)`; LED ring: `0 0 0 3px` at 22% | no drop shadows anywhere |
| Focus | `outline: 2px solid var(--text)`, offset 2 px | every focusable thing (`:focus-visible`), and the chosen tile |
| Touch | 44 px at least | every key, on a phone too |
| Spacing | 4, 6, 8, 10, 12, 14, 16 px; the page has 24 px sides, 12 px under 700 px | gaps inside and between modules |
| Motion | a key press (2 px down, no transition); `ins-led` breathing 1.5 s; `ins-step` and `ins-blink` | nothing moves under `prefers-reduced-motion: reduce` |

The phone layout starts under 700 px: the wall folds into one module, the room into three columns, and a bar of seven keys sits at
the foot of the screen.

## This site

The docs site is built on the same two files. `.vitepress/theme/custom.css` points every VitePress colour variable (`--vp-c-*`)
at a token and declares no colour of its own; the livery key in the top bar (`LiverySwitch.vue`) puts one of the four on
`<html>`, keeps it in the browser, and follows the system's light or dark until you pick one. The top bar is a row of keys, each
sidebar group a lettered module, a code block an LCD in a console's frame, and the containers are the status lights:

::: info
A plain module with the indigo light: something to know.
:::

::: tip
GO, sage: the way that works.
:::

::: warning
Needs you, saffron: read this before you go on.
:::

::: danger
NO-GO, raspberry: this breaks something or loses data.
:::

::: details A folded module
Open it for the rest.
:::

```sh
GONOGO_REDLINE=off gonogo --port 7890
```

## The logo

<div class="ds-logos">
<figure class="ds-frame" data-livery="instrument"><img src="/lockup.svg" alt="gonogo" width="240" /><figcaption class="label">lockup.svg</figcaption></figure>
<figure class="ds-frame" data-livery="night-shift"><img src="/lockup-dark.svg" alt="gonogo" width="240" /><figcaption class="label">lockup-dark.svg</figcaption></figure>
<figure class="ds-frame" data-livery="instrument"><img src="/lockup-stacked.svg" alt="gonogo" width="150" /><figcaption class="label">lockup-stacked.svg</figcaption></figure>
<figure class="ds-frame" data-livery="instrument"><img src="/mark.svg" alt="gonogo mark" width="64" /><figcaption class="label">mark.svg</figcaption></figure>
</div>

One key twice: GO pressed down (dark face, sage light) and NO-GO standing up (light face, raspberry light), then the word in dots,
the voice of the LCD. The files are in `docs/brand/`, every shape a circle, rect or path, with no font. On a dark livery the app
turns the light lockup (`filter: invert(1) hue-rotate(180deg)`), so the hues stay.

## Rules

**Do**

- Take every colour from a token: `var(--panel)`, `var(--go)`. A new view declares layout only.
- Keep colour small: a light, a chip, or the tint of the one module that needs the Director.
- Put numbers that count on an `.lcd` in `.lcd-num`; put names of things in Geist Mono capitals (`.label`, `.legend`).
- Make every key at least 44 px tall, and say a state in words too (a chip, a state line), never only in colour.
- Check a new pair of text and surface against 4.5:1 in all four liveries, and add it to `CONTRAST_PAIRS` in `livery.ts`.

**Don't**

- Don't write a hex value outside `tokens.css` (a test fails if a stylesheet declares a colour token; a shadow's black is the
  one exception).
- Don't flood a page or a module with a signal colour, and don't use a signal colour for decoration: indigo always means working.
- Don't add a drop shadow, a gradient or a second radius scale; depth is the edge, the bottom edge and the sunk LCD.
- Don't use Doto for words or a sentence; it is for numbers on a screen (and the logo).
- Don't animate anything that is not a state, and nothing at all under reduced motion.
- Don't make `--lcd` light in a livery: the terminal draws for a dark screen.
