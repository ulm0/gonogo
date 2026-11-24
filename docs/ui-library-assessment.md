# UI library assessment: shadcn/ui, motion-primitives, Hugeicons, Nexus UI

Task t149, FIDO, 2026-11-24. An assessment and a migration plan; no app code changes.

**Decision: the Director said GO to adopt all four (m4274), Hugeicons free icons only. Section 3 is the plan. The pilot
page is Party Line (the THREADS tab of COMMS), built in 2 PRs, with a Director go/no-go before the rest (about 15 PRs).**

## 1. What each one really is

Facts from npm and GitHub on 2026-11-24 (`npm view`, `api.github.com`, the registry JSON of each site).

| | shadcn/ui | motion-primitives | Hugeicons | Nexus UI |
|---|---|---|---|---|
| URL | ui.shadcn.com, github.com/shadcn-ui/ui | motion-primitives.com, github.com/ibelick/motion-primitives | hugeicons.com, github.com/hugeicons/hugeicons | nexus-ui.dev, github.com/victorcodess/nexus-ui |
| What | Copy-in component source (Tailwind classes on headless primitives) plus a CLI and a registry format | Copy-in animated components (text shimmer, morphing dialog, carousel...) | Icon set with framework packages | Copy-in chat components for AI apps (PromptInput, Message, Thread, Tool, Reasoning...) |
| Install | `npx shadcn add <item>` copies `.tsx` into the repo | the shadcn CLI with a URL (`motion-primitives.com/c/<name>.json`) | npm: `@hugeicons/react` + `@hugeicons/core-free-icons` | the shadcn CLI (`@nexus-ui/<name>`, in the shadcn registry) or `nexus-ui-cli` |
| Pulls in | Tailwind v4, `cn` (clsx + tailwind-merge), class-variance-authority, and **Radix (`radix-ui`) or Base UI (`@base-ui/react`)**. `init` defaults to the preset `base-nova` (Base UI); the `new-york-v4` style uses Radix. Icons: lucide by default; the presets Maia and Mira use Hugeicons, one uses Phosphor | `motion` (14.14.0, which wraps framer-motion) + Tailwind; some items use lucide-react | nothing but React (peer `react >=16`) | shadcn base items (button, tooltip, kbd, avatar...), `radix-ui`, Hugeicons, and per item heavy extras: `streamdown` (+ mermaid, math, cjk), `shiki`, `@react-symbols/icons`, Sonner |
| Licence | MIT | MIT | Code MIT; **6,000+ free icons (Stroke Rounded) for personal and commercial use**; the other 54,000+ icons and 9 styles are Pro, $99/year per seat, served from a private npm registry with a licence key | MIT |
| Last release / activity | CLI `shadcn@4.23.0`, 2026-10-27; repo pushed 2026-11-23 | no releases; last push 2026-09-28; the README says "beta, expect significant updates" | `@hugeicons/react@1.1.10` (2026-08-21), `core-free-icons@4.4.0` (2026-10-28); repo pushed 2026-11-16 | no releases; last commit 2026-06-16 (5 months idle) |
| Stars | 128,981 | 7,026 | 1,241 (monorepo; the old per-package repos are archived) | 131 |
| React 19 / Vite | yes (Radix and Base UI peers allow React 19; `@tailwindcss/vite@4.3.5` peers `vite ^5..^8`, so Vite 8 is fine) | yes (`motion` peers React 18 or 19) | yes | yes in principle; built and documented for Next.js + the Vercel AI SDK |
| "Built on / compatible with shadcn" | (is shadcn) | **True**: shadcn registry format, Tailwind, `@/lib/utils` `cn` | **Partly**: a plain icon package, not built on shadcn; shadcn's CLI offers it as an icon library | **True**: needs `shadcn init` first, items depend on shadcn base items |

## 2. Fit with gonogo

Today: React 19.3 + Vite 8, 78 own `.tsx` files in `src/client`, 29 CSS files (8,820 lines; `shell.css` alone 2,225),
`tokens.css` with the Livery variables, 688 `aria-*` attributes, native `<dialog>` with `showModal()` for modals
(`StepUpDialog.tsx`), one popover primitive `Pop.tsx` (Escape, outside press, focus back to the key). Client bundle today:
`index-*.js` 822 KB raw, **226 KB gzip** (xterm is most of it); `index-*.css` 85 KB raw, 20 KB gzip.

**Tailwind next to our CSS.** Tailwind v4 is one `@import "tailwindcss"` plus `@tailwindcss/vite`. Its Preflight reset
would change every existing element (margins, headings, buttons, `border-style`), so a side-by-side pilot must import only
`tailwindcss/theme` and `tailwindcss/utilities` (no Preflight), or use `prefix(tw)`. Two styling systems then live side by
side until the last of the 29 files is gone. Replacing our CSS outright is the full migration below.

**Livery / tokens to shadcn variables.** shadcn reads `--background --foreground --card --popover --primary --secondary
--muted --accent --destructive --border --input --ring` (each with a `-foreground`). Most map in one block
(`--background: var(--body)`, `--card: var(--panel)`, `--input: var(--edge)` (the input's border), `--border: var(--edge)`,
`--foreground: var(--text)`, `--destructive: var(--nogo-tint)`, `--primary: var(--text)`...; the full table is in section 3). One apparent clash: **`--muted`**. In gonogo it is a text colour (51 uses); in shadcn it is a background and
`--muted-foreground` is the text. Tailwind utilities read `--color-muted`, not `--muted`, so mapping `--color-*` straight
to our tokens (section 3) avoids it with no rename. Our LCD, saffron "you" and go/no-go tints have no shadcn slot and stay
ours. Livery's contrast checks keep working only if every shadcn variable is derived from our tokens, never set on its own.

**Dark mode.** shadcn uses a `.dark` class. Liveries already switch colour by `[data-livery]`, Night Shift included, so we
map variables per livery and never use `.dark`. No gain here.

**Bundle delta (measured).** A scratch bundle with esbuild, minified, gzip -9, minus a React-only baseline (69 KB gz):

| Added | gzip delta |
|---|---|
| Radix (`radix-ui`): Dialog, Popover, DropdownMenu, Tooltip, Tabs, Select | +46 KB |
| Base UI (`@base-ui/react`): the same six | +96 KB |
| `motion/react` (`motion.div` with layout + `AnimatePresence`) | +53 KB |
| `cva` + `tailwind-merge` + `clsx` (every shadcn file needs `cn`) | +9 KB |
| Hugeicons, 10 icons | +2.7 KB |
| lucide-react, the same 10 icons | +2.8 KB |

So shadcn with Radix and motion adds about **+110 KB gzip (about +50% on our 226 KB)**; with Base UI about +160 KB. Tailwind's
CSS output was not measured (it emits only used classes, but it comes on top of our 20 KB until our CSS is removed). The
phone over a mobile link is a target of the app, so this matters.

**Accessibility gain.** Real but narrow. Native `<dialog>` already gives us a focus trap, Escape and inert background
for free. Radix/Base UI would add, over our code: roving focus and arrow keys in menus and tabs, typeahead in menus and
selects, collision-aware positioning of popovers, tooltip delay groups. Where we use the native `<select>` we already get
those. The gain is in `Pop.tsx` (no arrow keys or positioning), the tab strips and menus.

**Look.** The app is an "Instrument" (device body, keys, LCD, Doto); docs/design-system.md is the rule (l11: every doc
section shows the real element). shadcn's look is neutral SaaS; to keep ours, each copied file would be restyled, which
leaves us with its structure and none of its look. Nexus UI is a chat UI for the Vercel AI SDK; gonogo shows real
terminals, not a chat stream, so none of its 15 items has a place (and `message`/`tool` pull mermaid, shiki and streamdown).
motion-primitives is decorative motion; our CSS transitions do the same work at 0 KB.

## 3. Decision and migration plan

FIDO first advised against adoption, because of the +50% JS and the restyling it needs. The Director said GO to all four
(m4274), so this section is the plan for doing it. Hugeicons: **free icons only**, no Pro licence.

### Design choices

1. **Radix, not Base UI.** Use `components.json` style `new-york-v4` (Radix), not the `init` default `base-nova` (Base UI).
   Radix costs half the bytes (+46 KB against +96 KB for the same six primitives), and Nexus UI items already depend on
   `radix-ui`, so we would otherwise ship both. Set `iconLibrary: "hugeicons"` so `shadcn add` writes Hugeicons, not lucide.
   motion-primitives items that import `lucide-react` get their icon swapped to Hugeicons when they are copied.
2. **Tailwind v4 next to our CSS, without Preflight.** Add `@tailwindcss/vite`, and load only the theme and utility layers:
   `@import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities);`. Our CSS stays
   unlayered, so it wins wherever both style the same element, and no existing screen changes until its own PR. The few
   resets shadcn files need (border-style, box-sizing) go in one small rule scoped to `[data-slot]`, which every shadcn v4
   component sets.
3. **Livery stays the one source of colour.** shadcn's variables are aliases of our tokens, declared once in
   `src/client/shadcn.css` with `@theme inline`. They never hold their own colour values, so every livery (shipped, custom,
   Night Shift) recolours shadcn components with no new code. Tailwind utilities read `--color-*`, so we write
   `--color-muted: var(--well)` directly and never declare shadcn's bare `--muted`. **That removes the `--muted` clash
   noted in section 2: no rename of our token.**

   | shadcn colour (bg / fg) | our tokens | already a checked pair? |
   |---|---|---|
   | background / foreground | `--body` / `--text` | yes |
   | card, popover / -foreground | `--panel` / `--text` | yes |
   | primary / -foreground | `--text` / `--panel` (the dark key) | yes (`--panel` on `--text`) |
   | secondary / -foreground | `--key` / `--text` | yes |
   | muted / -foreground | `--well` / `--muted` | yes |
   | accent / -foreground | `--you-tint` / `--you-ink` | yes |
   | destructive / -foreground | `--nogo-tint` / `--nogo-text` | yes |
   | border, input | `--edge` | not text |
   | ring | `--work` | not text |
   | chart-1..5 | `--work --go --you --nogo --muted` | not text |
   | radius | `--radius` | not a colour |

   Every foreground/background pair is already in `CONTRAST_PAIRS` (`src/shared/livery.ts`), so the contrast check needs no
   change: a livery that passes today passes with shadcn. A new test enforces this: it parses `shadcn.css`, checks that each
   `--color-*` is a `var()` of a livery token, and checks that each fg/bg pair is in `CONTRAST_PAIRS`.
4. **Dark mode by livery only.** No `.dark` class and no `dark:` variants. Delete the `dark` block that motion-primitives and
   shadcn items carry when they are copied.
5. **Files.** shadcn base items go in `src/client/ui/`, Nexus UI items in `src/client/ui/nexus/`, motion-primitives items in
   `src/client/ui/motion/`, and `cn` in `src/client/lib/utils.ts`. The `@/` alias points at `src/client` (in tsconfig and
   vite.config). Copied files are ours: lint and typecheck them like the rest, and add a header line with their source URL.
6. **Weight goes to where it is used.** Load the pilot tab with `React.lazy`, so the main chunk only grows by Tailwind's CSS
   and `cn`. Nexus `message`: drop streamdown, mermaid, math and cjk, and render bodies as plain text as today. Agent text is
   untrusted, and markdown would bring links and HTML into the room. `tool`/shiki are not taken.
7. **Budget, checked in every PR:** main JS chunk at most +15 KB gzip, CSS at most +10 KB gzip, each lazy chunk reported. The
   PR body gives the `vite build` numbers before and after.

### Pilot page: Party Line (the THREADS tab of COMMS)

Why this page: it is the one place where all four libraries do real work. Nexus `Thread` (stick-to-bottom scroll) and
`Message` show the conversation, Nexus `PromptInput` is the Director's reply box, shadcn `ScrollArea`/`Tooltip`/`Button`
fill in, Hugeicons supply the icons, and motion-primitives `TextShimmer` shows "sending". It is small (`PartyLine.tsx`,
154 lines), sits behind one tab (easy to lazy-load and to roll back), and its data comes from the existing routes
(`threads.ts`, the comm loop's reply route), so it needs no server change. Settings pages would test only forms, and
`Pop.tsx` would test only primitives.

### PR slices (about 15)

| # | PR | Size | Notes |
|---|---|---|---|
| 1 | Foundation: Tailwind v4 without Preflight, `components.json` (new-york-v4, hugeicons), `@/` alias, `lib/utils.ts`, `shadcn.css` alias block, the alias/contrast test, docs site imports `shadcn.css` | S | no visible change; check:pack, typecheck, docs:build |
| 2 | **Pilot:** Party Line on Nexus Thread/Message/PromptInput + shadcn + Hugeicons + TextShimmer, lazy tab, delete its CSS | M | real screenshots under every shipped livery and on a phone (l80); bundle numbers; **Director go/no-go before PR 3** |
| 3 | `Pop.tsx` on shadcn Popover/DropdownMenu (5 callers: TopBar, StatusStrip, TerminalBar, RoomView, LayoutPop) | M | keep the props of `Pop`, so the callers don't change |
| 4 | Dialogs: `StepUpDialog`, PatchPanel/TerminalBar dialogs on shadcn Dialog/AlertDialog | S | keyboard and Escape tests stay green |
| 5 | Form controls (`forms.css`, 824 lines): Input, Select, Switch, Checkbox, Label | M | `CONTROL_PAIRS` (`--go-ink` on `--key`) is the check mark's colour |
| 6 | Icons: Hugeicons in place of text glyphs and the 2 inline SVGs | S | `currentColor` |
| 7–13 | One per area: top bar + status strip; rest of COMMS (Inbox, Traffic); Flight Plan; Mission Log + Knowledge; Rules pages; Hangar + Docking; Settings + Livery page | M each | each deletes the CSS it replaced |
| 14 | `shell.css` (2,225 lines): layout to utilities; remove dead CSS files | M | |
| 15 | `docs/design-system.md`: every element shown again from the new components (l11) | S | |

The terminal (xterm), the LCD and the Doto type stay ours. They are the Instrument look, and shadcn has nothing in their
place.

### Guards for every PR

- No colour literal (hex, `oklch`, `rgb`) in `src/client/ui/**`; enforced by a grep in the PR 1 test.
- No `@hugeicons-pro` package and no `.npmrc` registry entry for it.
- No `dark:` class and no `.dark` selector.
- The livery tests (`test/livery.test.ts`, `test/client-look.test.ts`) stay green and unchanged.
- Each PR deletes the CSS it replaces, so we never keep two styles of the same element.
- Third-party notices: Vite's `license` output already collects the notices; check:pack confirms the new packages appear.

### Cost

About 15 PRs; the pilot is 2 (PR 1 and 2). JS: about +110 KB gzip in total if everything is eventually used, less on the
first screen thanks to lazy tabs. Two styling systems live side by side until PR 14.

### First step

CONTROL builds PR 1 and PR 2. The Director sees the pilot screenshots and gives a go/no-go before PR 3.

## How the numbers were taken

Registry items read from `ui.shadcn.com/r/styles/{new-york-v4,base-nova}/*.json`, `nexus-ui.dev/r/*.json`,
`motion-primitives.com/c/*.json`; `shadcn@4.23.0` package source for presets and the `base-nova` default; sizes from a
scratch package (react 19.3.1, radix-ui 1.8.1, @base-ui/react 1.9.0, motion 14.14.0, @hugeicons/react 1.1.10,
core-free-icons 4.4.0) bundled with esbuild `--minify`, gzip -9. Not done: a Tailwind CSS size, a real Vite pilot in the app.
