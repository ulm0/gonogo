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

gonogo looks like hardware: a warm grey body, lighter modules with thin edges, keys with a thick bottom edge, and small dark LCD
screens. Colour is a small light, or a tint on the one module that needs you. This page uses the app's own stylesheets.

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

In the app `data-livery` is on `<html>`; on any element it applies to everything inside: `<div data-livery="night-shift">`.

## Liveries

Four ship (see [Livery](./features/livery.md)). A livery changes colour only. Each swatch is `var(--token)` in a `data-livery` box,
with its `livery.ts` value.

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

Every livery must pass (the app refuses one that does not): each text token reaches **4.5:1** (WCAG 2) on every surface it sits
on, and `--lcd` stays dark (the terminal draws for a dark screen). High Contrast reaches 7:1 everywhere.

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

Fuel (Propellant): go under the warning share, needs-you past it, no-go (blinking) over the limit. Its bar runs on `--track`.

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

Three families, bundled from `@fontsource`: **Geist** for reading, **Geist Mono** for names on the hardware (labels, legends,
keys, chips, states), **Doto** (dot matrix) for numbers on an LCD and the logo. Hardware text is capitals with 0.04em to 0.08em
spacing; reading text is sentence case.

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

`.btn`: at least 44 px tall, 1 px edge with a 3 px bottom edge, Geist Mono capitals; pressed, it moves down 2 px. `data-kind`:
`primary` (dark face, one per view), `quiet`, `danger`. `data-size="big"`: 56 px form key. `data-shape="round"`: 44 px disc.
Disabled (`disabled`, or `aria-disabled="true"` to keep focus while busy) is dashed and flat.

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

`.led`: an 8 px light in `--led`, coloured by `data-kind` (console state) or by setting `--led`. `data-on="true"` adds a ring
(`0 0 0 3px`, 22%); `data-blink="true"` breathes (1.5 s, off under reduced motion). `.lamp`: a light with a word.

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

Geist Mono 500, 10 px, capitals, a pill. `data-tone`: `lit`, `amber`, `go`, `nogo`, `quiet`, `ink`.

### Modules, floods and the LCD

<div class="ds-frame" :data-livery="look">
<div class="ds-grid">
<section class="module ds-pad"><span class="label">A · Mission</span><div class="lcd ds-lcd"><span class="ds-lcd-line">Brief FLIGHT to start the clock.</span><span class="lcd-num ds-clock">00:00:00</span></div><span class="label">No mission yet</span></section>
<section class="flood ds-pad" data-tone="amber"><span class="label"><span class="led" data-on="true" data-blink="true"></span> FIDO asks for a go</span><span>Push the branch and open the pull request?</span></section>
<section class="flood ds-pad" data-tone="go"><span class="label"><span class="led" data-on="true"></span> Go</span><span>Every console voted go.</span></section>
<section class="flood ds-pad" data-tone="nogo"><span class="label"><span class="led" data-on="true"></span> No-go</span><span>RETRO voted no-go: tests fail.</span></section>
</div>
</div>

`.module`: `--panel`, 1 px `--edge`, 12 px corners, named by a `.label` ("A · MISSION"). `.flood`: the same, tinted by
`data-tone` (`amber`, `go`, `nogo`, `lit`); its label turns `--text-2`. `.lcd`: a sunk dark screen (`--lcd`, `inset 0 2px 6px`,
8 px corners), text `--lcd-text` or `--lcd-dim`.

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

`.tile`: a key holding a console, position or option. `data-kind` (`working`, `needs`, `starting`, `stopped`, `open`, none for
idle) sets light and surface; `aria-pressed="true"` rings the chosen one. `.room-tile`: `.tile-head` (light, `.tile-legend`,
`.tile-num`), a two-line `.tile-lcd` (lit while working, warm when it needs you), `.tile-foot` with `.tile-state`.

### Fields

<div class="ds-frame" :data-livery="look">
<div class="ds-stack" style="max-width: 420px">
<div class="field"><label for="ds-name">Name</label><input id="ds-name" class="input" value="fido" /><span class="hint">Lowercase letters, digits and hyphens.</span></div>
<div class="field"><label for="ds-bad">Working directory</label><input id="ds-bad" class="input" aria-invalid="true" value="~/no/such/folder" /></div>
<span class="error" role="note">That folder does not exist.</span>
<div class="field"><label for="ds-role">Role</label><textarea id="ds-role" class="textarea" rows="2">Architect: picks the shape of the change.</textarea></div>
</div>
</div>

`.field`: label, control, `.hint`. `.input`: 46 px on `--key`, `--well` when read-only; `aria-invalid="true"` draws a 2 px
`--nogo` edge, reason in an `.error` below. `.textarea` is mono.

### Elements of the feature pages

Each is built from the keys, chips, lights, modules and fields above, so it follows the livery. The feature pages show them in use.

<div class="ds-frame" :data-livery="look">
<div class="ds-stack" style="max-width: 460px">
<span class="label">Engine, model and effort chips</span>
<span style="display: flex; flex-wrap: wrap; gap: 4px 6px"><span class="chip" data-tone="quiet">Claude Code</span><span class="chip" data-tone="quiet">opus · position default</span><span class="chip" data-tone="quiet">effort xhigh</span></span>
<span class="label">Verdict line and review note</span>
<span style="font-weight: 600">Approved 2 minutes ago.</span>
<span style="font-weight: 600; color: var(--you-ink)">Approved 2 minutes ago: an older diff (the changes have moved on since).</span>
<div style="display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--edge); border-left: 4px solid var(--you-edge); border-radius: 4px; background: var(--well)"><span style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center"><span class="chip" data-tone="amber">WARNING</span><span style="font-weight: 600">GUIDO</span></span><span>Does urgent mail skip Hold?</span><span style="display: flex; gap: 8px"><span class="btn" data-kind="quiet">Resolve</span><span class="btn" data-kind="quiet">Delete</span></span></div>
<span class="label">Mission: tasks and cost</span>
<div style="display: grid; gap: 4px"><span class="label">Tasks</span><span class="lcd-num">3 / 7</span></div>
<div style="display: grid; gap: 6px"><span class="label">Cost</span><span>$1.20 of $10.00</span><span style="display: flex; gap: 8px; align-items: center"><span class="hint">Budget in dollars</span><span class="input" style="flex: 1; padding: 6px 8px">$10.00</span><span class="btn">Set</span></span></div>
<span class="label">Plan quota block</span>
<div style="display: grid; gap: 6px"><span style="display: grid; grid-template-columns: 64px 1fr; gap: 8px; align-items: center"><span class="legend">WEEK</span><span style="height: 8px; border-radius: 4px; background: var(--key); overflow: hidden"><i style="display: block; width: 82%; height: 100%; background: var(--you)"></i></span></span><span class="lcd-num">82 %, resets in 28 h 0 min</span><span class="hint">from Claude Code: your plan's own number.</span></div>
<span class="label">Worktree line</span>
<span style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap"><span class="chip" data-tone="quiet">WORKTREE</span><span class="hint">Branch <code>gonogo/ana</code>, clean, merged into main.</span></span>
<span class="label">Room editor: card, grip and tray</span>
<div style="display: grid; gap: 8px"><div class="module" style="position: relative; display: grid; gap: 4px; min-height: 64px; padding: 8px 10px 14px"><span style="display: flex; gap: 8px; align-items: center"><span style="font-family: var(--font-mono); font-weight: 700; letter-spacing: 0.06em">MAX Q</span><span class="hint">2 × 2</span><span class="btn" data-kind="quiet" style="margin-left: auto">Hide</span></span><span aria-hidden="true" style="position: absolute; right: 2px; bottom: 2px; width: 22px; height: 22px; border-right: 3px solid var(--text-2); border-bottom: 3px solid var(--text-2); border-radius: 0 0 4px 0"></span></div><div class="module" style="display: flex; gap: 8px; align-items: center; padding: 8px 10px"><span class="label">Hidden</span><span class="btn">RESTORE SEQUENCE</span></div></div>
<span class="label">Notifications switch</span>
<div style="display: flex; gap: 8px; justify-content: space-between; align-items: center"><span class="hint">On in this browser.</span><button type="button" class="btn" aria-pressed="true">Turn notifications off</button></div>
<span class="label">Terminal frame</span>
<pre class="lcd" style="margin: 0; font-size: 12px; overflow-x: auto">gonogo   1 ROOM  2 INBOX 1  3 NEEDS 1  4 POLL  connected
NEEDS 1: ana: permission request: Bash: git push (press 3)
ROOM
> * flight      working   flight
  ! ana         needs you fido      permission request: Bash: git push
  . guido       idle      guido
  - retro       stopped</pre>
<span class="label">Update strip</span>
<span style="display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding: 2px 8px 2px 14px; border: 1px solid var(--edge); border-radius: var(--radius-key); background: var(--well); color: var(--text-2); font-size: 12px">gonogo 0.3.0 is out (this is 0.2.0). To update, run: <code style="color: var(--text)">npm install -g @ulm0/gonogo</code><span class="btn" data-kind="quiet">Copy</span></span>
</div>
</div>

These are drawn from the app's own rules (the console chips of Engine Bay, Review, Missions, Worktrees, Room editor, Notifications, the terminal client and Rollout): the verdict line is bold text, amber with the tone token when it was of an older diff; a note has a `--edge` border and a left edge in the tone (word on a chip, never colour alone); the room editor's card is a `.module` with a handle row and a corner grip of `--text-2`, and its tray a `.module` with RESTORE keys; the terminal frame is `.lcd` text with a glyph and a word for each state. Only the tokens above colour them, so text keeps 4.5:1 (7:1 in High Contrast). Not drawn here because it is not in the app yet: the version corner, and the feature toggle row of the features PR.

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

Under 700 px the wall folds into one module, the room into three columns, and a seven-key bar sits at the foot.

## This site

The docs use the same two files. `.vitepress/theme/custom.css` maps every `--vp-c-*` variable to a token; `LiverySwitch.vue` in
the top bar sets a livery on `<html>`, remembers it, and follows system light or dark until you pick one. Containers are the
status lights:

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

GO pressed (dark face, sage light), NO-GO up (light face, raspberry light), then the word in dots. Files in `docs/brand/`, shapes
only, no font. On a dark livery the app inverts the light lockup (`filter: invert(1) hue-rotate(180deg)`), keeping the hues.

## Rules

**Do**

- Take every colour from a token (`var(--panel)`); a new view declares layout only.
- Keep colour small: a light, a chip, or the tint of the one module that needs you.
- Counting numbers go in `.lcd-num` on an `.lcd`; names in Geist Mono capitals (`.label`, `.legend`).
- Keys at least 44 px tall; every state also in words, never colour alone.
- Check a new text/surface pair at 4.5:1 in all four liveries and add it to `CONTRAST_PAIRS` in `livery.ts`.

**Don't**

- No hex values outside `tokens.css` (a test fails if a stylesheet declares a colour token; a shadow's black is the exception).
- No signal-colour floods or decoration: indigo always means working.
- No drop shadows, gradients or second radius scale.
- No Doto for words.
- Animate only states, and nothing under reduced motion.
- Never a light `--lcd`.
