# UX audit of the app and the docs (step 2, code and docs pass)

Written 2026-11-20 by CONTROL for the Director. **Status: a first pass from the code and the docs. No screenshot was used** (t76's run was not
available when this was written, and this host has no browser). Every "evidence" below is a file and line or a computed number, and the findings that
need a look at the real screen are in the last section, marked **to check on the screenshots**. Nothing here was seen in a browser.

Scope: `src/client` (46 components, 26 style sheets), the docs site (`.vitepress/config.mts`, `docs/`), the four built-in liveries.
Method: Nielsen's 10 heuristics, WCAG 2.2 AA (the contrast ratios were computed with `contrast()` of `src/shared/livery.ts` over `BUILTIN_LIVERIES`),
and the six top tasks of the docs (install, set up the login, expose, add a room, hire an agent, update).

## What already holds (so it is not re-opened)

- **Text contrast**: every text pair gonogo uses is at least 4.5:1 in all four liveries (the pairs are a test: `CONTRAST_PAIRS`); `--you-ink` and `--go-ink` also pass on the body and the panel (6.2 to 16:1).
- **Focus**: one global `:focus-visible` ring, 2 px of `--text` (`base.css:37`); only headings that take focus on open turn it off.
- **Motion**: `prefers-reduced-motion` stops every animation and transition (`base.css:52`).
- **Names**: icon-only keys carry `aria-label` and `title`; there is no clickable `div` or `span` but the Patch Panel's `role="option"`.
- **State not by colour alone**: lights come with a state word; chips carry words.

## Findings, ranked

Severity: **blocker** (a task cannot be done), **major** (a task is hard or a WCAG AA criterion fails), **minor**. Effort: S under half a day, M a day, L several days.

| Id | Screen | Evidence | Sev | Fix | Effort |
|---|---|---|---|---|---|
| UX-01 | Every form: inputs, textareas, selects, checks, switches, key borders | The border is `--edge`. Computed `--edge` against `--panel` / `--key`: Instrument (default) 1.50 / 1.62, Night Shift 1.41 / 1.24, Low Ink 1.88 / 1.96; only High Contrast reaches 3:1. `primitives.css:205-216`. `CONTRAST_PAIRS` holds text pairs only, so nothing tests it. **WCAG 1.4.11 (non-text contrast, 3:1) fails** for the boundary of a field in three of four liveries. | major | A new token `--control-edge` (3:1 against `--panel` and `--key` in every livery) for `.input`, `.textarea`, `.check`, `.radio`, `.switch`; its pairs added to `CONTRAST_PAIRS` (a new rule for a livery the Director made earlier goes to `CONTROL_PAIRS`, as the code says). Keep `--edge` for module lines. | M |
| UX-02 | Docs: Getting started | `docs/guide/getting-started.md:28-60` tells the reader to open `http://127.0.0.1:7777/#token=...`. Since 0.5.0 the first run is the **setup page** (an account, a setup token; `docs/features/login.md:17`), the page at `/` is the **list of rooms**, and the token is "for a fresh install only". Getting started names none of login, rooms, exposing or the phone. | major | Rewrite "Run it" as the real first run: start, open the printed address, create the account (setup token), land on the room list, open Main, staff the first console; then a "Next" list (add a room, expose it, update, the phone). | M |
| UX-03 | Docs: sidebar | `.vitepress/config.mts:68-135`: **Features is one flat list of 47 pages** in no order a reader could guess (Engine Bay first; Login 8th, Update 25th, Rooms 26th). Six "Expose: ..." pages sit under *Guide* beside "Exposing it safely". Findability of the six top tasks from the nav: install (Guide, 1st: good), login (Features 8th), expose (Guide 4th to 10th, six pages), add a room (Features 26th), hire an agent (inside "The room"), update (Features 25th). | major | Regroup by what the reader is doing: Start (getting started, the room, Docker) / Set up (login, rooms, expose and its five pages folded into one with tabs or a short list) / Run agents (Engine Bay, Payload, Room keys, Clean Room, Worktrees, Permissions, Subagents...) / Watch and control (Redline, Propellant, Cost, Hold, Comms, Flight Plan...) / Phone and remote / Reference. Collapse each group; keep one page per feature. Add a "Do this" page: six task cards linking straight to the right section. | M |
| UX-04 | Docs and app: vocabulary | There is **no glossary** (no page mentions one). The product speaks in mission-control words (Redline, Propellant, Relief, Hangar, Recorder, Hold, T-minus, Max Q, Static fire, Uplink/Downlink/Relay, Livery, Payload, Clearance, Rollout, Black Box...). Some are explained where they first appear, most are not; the top bar keys say COMMS, MISSIONS, LAUNCH WINDOW, FLIGHT PLAN, MISSION LOG. | major (heuristic 2: match to the user's words) | A one-page glossary: the word, what it means in plain terms, where it is in the app. Link it from the sidebar, from Getting started and from the Patch Panel's Docs line. In the app, a plain subtitle under each block title in Flight Rules. | S to M |
| UX-05 | Flight Rules | `Rules.tsx` renders about 21 blocks (14 components plus 7 inline sections) one after another, 362 lines, and has no in-page index, no anchors (`href="#"` appears nowhere) and no search. A setting is found by scrolling or by remembering where it is. | major (heuristic 6: recognition over recall; 7: efficiency) | An index at the top (links to each block's heading, which are real headings) and `id`s on the headings, so a link such as `/#rules-room-keys` can be used in the docs; group the blocks (Agents, Safety, Account and exposure, Cost and limits). The Patch Panel could jump to a block. | M |
| UX-06 | Flight Rules: Room keys, Payload defaults | `RoomKeys.tsx` and `PayloadDefaults.tsx`: REMOVE deletes at once. A removed key or server **cannot be read back** (its value is never shown), so a misclick loses a secret the Director may not have a copy of. Other removals ask (a room removal confirms in its card). | major (heuristic 5: error prevention, 3: control and freedom) | The same two-step as the rooms page: REMOVE becomes "Remove X? KEEP / REMOVE" in the row; or move the entry aside for 30 s with an UNDO (the refused-keys file already shows the pattern). | S |
| UX-07 | Flight Rules blocks that fetch (Model defaults, Payload defaults, Room keys, Permissions) | The block shows its title and hint and **nothing else** until the answer arrives (`defaults !== null && ...`), and on a failure only the error text, with no retry. There is no loading text. "Loading" appears in 9 places in the whole client (App, Mission Log, Hangar, Plot Board, Telemetry). | minor (heuristic 1: visibility of state) | One shared `<BlockState>` (loading line with `role="status"`, error with a RETRY key); used by every block that fetches. | S |
| UX-08 | Top bar | Nine keys at 1280 px; three of them (Patch Panel, Flight Rules, Livery) are **round, icon-only** keys with no visible word (`shell.css` comment: "another word in the bar would not fit"). Their names are in `aria-label` and `title`, so a mouse user has to hover to learn them. | minor (heuristic 6) | Show the words at 1400 px and wider (there is room: the unit name is hidden below 1400 px for the same reason); keep icons below. Or a first-run hint on the three keys (the Commissioning checklist is the place). | S |
| UX-09 | Top bar: version and Rooms (own work, #114) | `.version-mark` and `.version-new` are 11 px text links, about 16 px tall: **below the 24 px minimum of WCAG 2.5.8** and the app's own 44 px rule. | minor | Pad the two links to 24 px high (the text stays 11 px); on the phone, give the version a 44 px line or leave it to the About line of Flight Rules. | S |
| UX-10 | Several keys | Keys under 44 px that are real controls: the Propellant window and unit keys (`.fuel-window`, 32 px, `shell.css:605`), the add key of Post-Flight Review (`.rv-add`, `review.css:168`, 24 px). They pass WCAG 2.5.8 (24 px) but not the design system's own 44 px rule. | minor (consistency) | Raise to 44 px on the phone layout only (the density is intentional on a desk), and state the rule in the design-system page ("44 px on a touch screen, 24 px minimum on a desk"). | S |
| UX-11 | Docs: pages and mocks | Some pages (Rooms, Engine Bay) are long and dense, and the mock sits at the top, before the text that explains it. Mocks such as Bedrock and Room keys are drawn from shared tokens, not from the real components, so a change of the real block is not seen in the docs. | minor | A rule for the docs: the first screen of a page says what it is for and the top task in two lines, then the mock. A test that renders a few mocks next to the real component's markup (class names) so they cannot drift. | M |
| UX-12 | Docs: search and edit | The local search is on, and "Edit this page" points at GitHub (fine for contributors, noise for users). No "last updated" (off on purpose). Few pages say which version a feature came in. | minor | A version badge on the pages of features shipped after 0.5 ("since 0.8"); hide "Edit this page" on the first-run pages. | S |

## To check on the screenshots (not judged from code)

These are what code cannot tell. Each one needs the screenshot named (t76's names, when the run exists); I will add the verdict as an addendum.

1. **Density and hierarchy at 1280 and 390**: the room view's wall, the three-column matrix on the phone, the bottom bar (seven keys: is any label cut?).
2. **The top bar at 1280 px with the version, the update note and the Rooms key**: does it stay on one line? (estimated by key widths in #114, never seen).
3. **Empty states** (no agents, no messages, no tasks, no missions, a room with only the boss): wording and what the next action is.
4. **Contrast in practice** where the computed pairs hide the problem: text on a tinted tile that needs you, the `--lcd` clock, chips on `--well`, the amber `.version-new` on the body, the focus ring on a dark key.
5. **Flight Rules at 390 px**: the key rows (`.rules-model`) and the JSON textareas; whether a long block pushes the keys under the fold.
6. **Error states**: a refused hire, a lost connection ("not connected"), a failed update, the step-up dialog.
7. **Docs on a phone**: the sidebar, the landing page and the mocks' width.
8. **Keyboard only**: focus order in the hire form, the Patch Panel (Cmd+K) and the console; tab traps; Escape.
9. **Screen-reader names** of the Patch Panel options, the room tiles and the rollout strip (labels exist; their order and wording are not judged).

## Proposed batch plan

1. **Controls and contrast (UX-01, UX-09, UX-10).** The `--control-edge` token, its livery pairs and tests, the two small-target fixes, the design-system page. Needs a look at all four liveries on screenshots before merge. Effort M.
2. **Docs: the first run and the navigation (UX-02, UX-03, UX-12).** Getting started rewritten for setup and rooms, the sidebar regrouped, the "Do this" page. No code. Effort M.
3. **Words (UX-04, UX-08).** The glossary, the plain subtitles in Flight Rules, the labels on the three round keys at 1400 px and wider. Effort S to M.
4. **Flight Rules: find and recover (UX-05, UX-06, UX-07).** The index and anchors, the confirm on removing a secret-bearing item, the shared loading and error state. Effort M.
5. **Screenshot-driven fixes.** Whatever the "to check" list finds, as one or two PRs, after the Director has read this.

Batches 1 and 2 are independent and can go in parallel; 3 follows 2 (the glossary is linked from Getting started); 4 touches only `Rules.tsx` and the blocks.
