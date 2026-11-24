# UI library assessment: shadcn/ui, motion-primitives, Hugeicons, Nexus UI

Task t149, FIDO, 2026-11-24. An assessment only: no app code changes.

**Verdict: do not adopt shadcn/ui as the base of the app. Borrow instead: take Hugeicons (free set) as the icon set, and
take one headless primitive library only where our own component is weak. Skip motion-primitives and Nexus UI.**

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
(`--background: var(--body)`, `--card: var(--panel)`, `--input: var(--key)`, `--border: var(--edge)`,
`--foreground: var(--text)`, `--destructive: var(--nogo)`, `--primary: var(--work)`...). One real clash: **`--muted`**. In
gonogo it is a text colour (51 uses); in shadcn it is a background and `--muted-foreground` is the text. Both can't hold
the same name, so either our token is renamed in every file, Livery and `src/shared/livery.ts` (and its contrast test), or
shadcn's files are edited. Our LCD, saffron "you", go/no-go tints have no shadcn slot and stay ours. Livery's contrast
checks keep working only if every shadcn variable is derived from our tokens, never set on its own.

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

## 3. Options

**(a) Adopt incrementally.** Add Tailwind v4 (no Preflight), `components.json`, `cn`, Radix (not Base UI: half the size);
map shadcn variables to our tokens per livery; rename our `--muted`. Pilot: replace `Pop.tsx` (the one primitive behind
menus, popovers and strip chips) with shadcn `popover` + `dropdown-menu` restyled to the Instrument. Then page by page.
Cost: pilot 2 PRs (setup + tokens/`--muted` rename; `Pop` swap). Full migration: about **14 to 18 PRs** (one per area:
shell/top bar, Comms, Flight Plan, Rules pages, Hangar, Docking, forms, design-system docs, removal of the last CSS file),
+110 KB gzip, two styling systems for the whole period, and every Livery screen re-checked for contrast.

**(b) Don't adopt; borrow.** 1 PR: add `@hugeicons/react` + `@hugeicons/core-free-icons` (MIT, free Stroke Rounded set,
about +0.3 KB per icon), an `<Icon>` wrapper for new glyphs and the 2 inline `<svg>` of `src/client` today, `currentColor` so Liveries colour
them. Optional later, 1 PR each, only where ours is weak: put a Radix primitive (`radix-ui` Popover / DropdownMenu) under
our own `Pop.tsx`, styled by our CSS, no Tailwind. Borrow ideas, not code, from shadcn (variant naming, `asChild`). Cost:
1 to 3 PRs, +3 to +25 KB gzip.

**Recommendation: (b).** The app's value is its own Instrument look and Livery theming; shadcn's value is a default look
and speed of starting, which we no longer need. (a) costs about 16 PRs and +50% JS to land where we are, with one gain
(menu keyboard and positioning) that (b) gets in one PR. Do not take Hugeicons Pro: the free set covers an app of this
size, and Pro needs a licence key in CI and a private registry for every contributor.

## First step

One PR on (b): Hugeicons free set behind a tiny `Icon` wrapper, used first in the top bar and status strip, shown in
docs/design-system.md under every Livery. Then decide on the Radix-under-`Pop` PR after an a11y check of `Pop` menus with
a screen reader.

## How the numbers were taken

Registry items read from `ui.shadcn.com/r/styles/{new-york-v4,base-nova}/*.json`, `nexus-ui.dev/r/*.json`,
`motion-primitives.com/c/*.json`; `shadcn@4.23.0` package source for presets and the `base-nova` default; sizes from a
scratch package (react 19.3.1, radix-ui 1.8.1, @base-ui/react 1.9.0, motion 14.14.0, @hugeicons/react 1.1.10,
core-free-icons 4.4.0) bundled with esbuild `--minify`, gzip -9. Not done: a Tailwind CSS size, a real Vite pilot in the app.
