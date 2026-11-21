# The web UI, read for what each part is for

Written 2026-11-21 by CONTROL for the Director (task t104). It replaces the first audit (`ux-audit.md`, never merged), which listed findings; this one ends in layouts. Every picture in it is a real browser screenshot (§ 5): the app as it is, and a prototype of the proposal behind `?layout=next`. The proposal is a prototype, not built for good.

**How it was made, and what it cannot say.** From the screenshots of `screens.yml` run 44866758846 (0.11, unpacked by SURGEON; the room view measures the same as in the 0.8.2 run before it) and the code (`main` at 0.11). **Not in that run: the edit-room editor and the update strip**, so those two sections are from the code only. The rest is measured in pixels at 1280 and 390 wide. **Frequencies of use are my estimates from what each part does**: gonogo has no usage telemetry, so please correct them where you know better. I have no browser on this host, so the pictures come from `screens.yml` runs and I read them as images. A window of 1280 × 800 and a phone of 390 × 844 are the two sizes used throughout.

## 1. The finding that explains most of it

**At 1280 × 800 the first screen shows the top bar and the wall, and nothing you work with.**

| Measured at 1280 × 800 (0.11) | Size | Share |
|---|---|---|
| Top bar (wraps to two rows: nine keys, then “+ STAFF A CONSOLE”) | 116 px | 14.5 % of the height |
| The wall, boxes A to F (Mission, Sequence, T-minus, Max Q, Propellant) | 520 px | **65 %** |
| Operations (the consoles) starts at y = 668: **132 px of it** is above the fold | | |
| The selected console's terminal | 410 × 360 px, wholly **below** the fold (y 925 to 1285) | 0 % of the first screen |
| Tiles of the 24 seats that are empty seats | 21 of 24 | 87 % |
| Flight Rules (24 blocks, more with every release) | 8 696 px (10.9 screens) | |

On a phone (390 × 844): top bar 52 px, the wall 353 px (42 %), the bottom bar 68 px; of the first 12 tiles only 1 is staffed; the terminal is two taps away and then 255 px tall (30 %) with the comm loop and telemetry under it; Flight Rules is 12 166 px (14.4 screens).

So “boxes A, B, C, D, F take too much space” is measured: they take two thirds of the window to show a clock that says *no mission yet*, an empty chart, STANDBY, a dial that says OFF and a paragraph. Each of the five holds about 150 px of content in a 520-px box.

## 2. Screen by screen

*Use* is my estimate (D = every day, W = weekly, S = set up once and rare). *Space* is the share of the 1280 × 800 window, then of the 390 × 844 phone.

### The top bar

| | |
|---|---|
| **For** | Jump between the views of a room and reach its settings. |
| **Use** | Comms D; Missions, Flight Plan, Mission Log W; Launch Window S; the three round keys (Patch Panel, Flight Rules, Livery) W, W, S. |
| **Space** | 14.5 % of the height (two rows) / 6 % (one row). |
| **Problems** | Nine keys at one weight, three of them unlabelled icons; four of the six words are four different kinds of work (Missions, Flight Plan, Mission Log, Launch Window); “+ STAFF A CONSOLE” wraps to its own row at 1280; the version is a link to the changelog. |
| **Proposal** | One row: logo and **version as a button** (§ 2.12), link lamp, ROOMS, COMMS, **WORK ▾** (Missions · Flight Plan · Mission Log · Schedules), a visible **Jump to… ⌘K** field, **⋯** (Flight Rules, Livery, Docs, All stop). 56 px. Phone: four keys, Room, Comms, Work, More. |

### The wall (A Mission, B Sequence, C T-minus, D Max Q, F Propellant)

| Box | For | Use | Says what it does? | Proposal |
|---|---|---|---|---|
| A Mission | The mission's clock and the way to Missions. | glance D | “A · MISSION” and a clock; with no mission it says only NO MISSION YET. | Chip: clock + name; the box on demand. |
| B Sequence | Who worked, and when, in the last ten minutes. | glance D | The word is jargon; the chart is mostly empty with 3 agents. | An inline sparkline (150 × 20) in the strip: “Activity”. |
| C T-minus | A go/no-go **poll** of the room, and Static fire. | W | “T-MINUS … STANDBY” says nothing about asking the agents a question. | “Poll” button in the strip, the poll's state beside it; the panel opens when a poll runs. |
| D Max Q | A cap on how many agents work at once. | S | A dial that says OFF and “NO LIMIT. 0 WORKING.” | Chip “Max Q off”; set in Flight Rules › Budget and limits (it is already there, **twice**). |
| F Propellant | Token and dollar ledger, limits, plan quota. | glance D, set S | Opens with a 9-line paragraph on quota sources before any number. | Chip “fuel: 4.2 M / 5 h”; the explanation moves behind “?”. Also duplicated in Flight Rules. |

**Proposal: one status strip of 60 px** that holds the five as chips (see); each chip opens its box as a popover. That is 460 px back (58 % of the window). The old wall is one of the three layout densities (§ 2.5).

### Operations (the consoles)

| | |
|---|---|
| **For** | The 15 seats and extra agents: who is working, who needs you, open one. The thing you look at all day. |
| **Space** | 512 px tall, 61 % wide; 87 % of the tiles are empty seats; the first fold shows one row. |
| **Problems** | “E · OPERATIONS” does not say “your agents”; empty seats are as big as working agents; “lacks love”: it is the most used block and the most generic. |
| **Proposal** | **Staffed agents first**, bigger, each with the state that matters (needs you / working / idle and for how long) and its last line; **open seats are one row** (“21 open seats: FAO FIDO GUIDO … Staff…”). Header: “Consoles · 3 staffed”, “+ Staff a console” moved here from the top bar. |

### The console panel and its terminal

| | |
|---|---|
| **For** | Watch and type to one agent; hold, restart, stop, edit. |
| **Space** | The panel is 440 px wide; the terminal 410 × 360 (about 50 columns, 13-px text), below the fold; on a phone 255 px of 844. |
| **Problems (from the code)** | No size control, no expand, no full screen (`shell.css` `.term-wrap` is `min-height: 360px`, the page decides the rest); scrollback 2 000 lines, scrolled mainly by the wheel; nothing says you have scrolled up or that new output arrived; **no copy key**: you select with the mouse and the program in it may take the mouse; on a phone a terminal canvas cannot be selected at all. |
| **Proposal** | A toolbar: **A− A+**, **Copy ▾** (selection, last answer, the screen, all scrollback), **Expand** (the console takes the main area, Operations folds to a rail), **Full screen**, **Find**, **↓ Latest** and “following”. Scrollback 10 000 (a setting). The terminal is in the first screen at 1280 × 800: 496 × 450, about 60 columns. **Phone: the terminal is the screen (75 %)**, the comm loop and telemetry behind “Messages”, and **Select** shows the last 300 lines as ordinary text the system can select and copy. |

### Comms, Missions, Flight Plan (brief)

Used every day (Comms) or weekly. They are views, not settings; each fills its page and is fine. The two things to fix are the names (§ 3) and that they are four top-bar keys; they go under **Work ▾**, with Comms staying on the bar because of its badge.

### Launch Window

| | |
|---|---|
| **For (what it really holds)** | Four different things: **Schedules** (rules that brief an agent at a time), **Uplink** (an address a service posts to; each post reaches an agent), **Relay** (chat bridges out: Slack, Telegram, GitHub, Linear) and **Docking** (other gonogo stations). |
| **Use** | Schedules W; Uplink, Relay, Docking S. |
| **Space** | A 1 700-px page; 3 of the 4 sections are empty states or set-up forms. |
| **Problem** | The name belongs to the first (a launch window is a time); the other three are connections. The Director's instinct that it belongs in Flight Rules is **right for three of the four**. And Flight Rules has a block, “LAUNCH WINDOW”, that is only a button to this page. |
| **Proposal** | **Schedules** (with History and RUN NOW) stay a working view under Work ▾. **Uplink, Relay, Docking and Phone approvals move to Flight Rules › Automation and connections**, with the plain names “receive (Uplink)”, “send (Relay)”, “other stations (Docking)”. The empty “LAUNCH WINDOW” block is removed. |

### Flight Rules

| | |
|---|---|
| **For** | Every setting of the room. |
| **Use** | S: most visits are once, at set-up; ALL STOP is the exception (emergency) and it is block 21 of 24, about 5 900 px down. |
| **Space** | 24 blocks, 8 696 px (1280) / 12 166 px (390); no index, no search, no anchors. |
| **Problems** | No order: a model default sits between the budget and the rules; Login (security) and Room keys (credentials) are 2 200 px apart; **Max Q and Propellant appear on the wall and again here**; “FEATURES” is a block of 25 switches; “CONSOLES” repeats the consoles list. Each block's first line is a paragraph, not what it is now. |
| **Proposal** | Seven groups with an index (a list on a phone) and **rows**: the setting's name, **what it is now**, and a key that opens it in place. **Find a setting** filters the rows. A badge on a group says something needs you. |

| Group | One line | Holds |
|---|---|---|
| Room | How this room looks and which features it has. | Tab name · Livery · Features · Commissioning |
| Agents | What every agent starts with and may do. | Engine and model · Room rules · Tool permissions · Servers and skills · Keys · Subagents · Co-author line · After a restart · Each console |
| Budget and limits | How much may be spent and how many may work at once. | Max Q · Propellant (limits, plan quota, cost, prices) |
| Automation and connections | What runs by itself and what reaches in or out. | Schedules (settings) · Uplink · Relay · Docking · Phone approvals |
| Knowledge | What you want to stay true, and how a mission closes. | Claims and proposals · Closing checklist template |
| Security | Who may get in, and the emergency stop. | Login · All stop · Step-up |
| System and update | This install. | Version and CHECK NOW · Auto-update · Live reload · This browser |

### Edit room

| | |
|---|---|
| **For** | Arrange the five panels of the wall. |
| **Problem** | A 12-column grid you drag and resize by cells: it answers “where does each box go” and the Director's question is “how much room should they take”. A box is full size or gone. It is a screen of its own, and changes the room for everyone. |
| **Proposal** | **Layout**, a popover: three densities (**Focus**, **Standard**, **Full wall**), **Strip / Panel / Hidden** for each of the five, the order of seats (staffed first, by position, by state) and whether open seats are one row. The grid editor stays as “Arrange by hand…”. The presets write the layout the app already stores (blocks with x, y, w, h and hidden), so nothing is migrated. |

### Patch Panel

**Feature or UI?** The feature is right and rare among tools like this: a command palette, “type a console, a view or an action” (31 entries today). The **UI fails to say it**: the key is nine dots with no word, the name says nothing, and it only opens with ⌘K or that icon. **Proposal:** a visible field in the top bar, “⌕ Jump to…  ⌘K” (a ⌕ key on a phone); “Patch Panel” stays as the name in the docs.

### Mission Log

**Feature or UI?** The feature is the room's long-term memory: agents have tools to search and write it (`log_search`, `log_write`, `log_read`), and several positions are told to write an entry after each round. The **page** shows it as a list and an empty pane that says “Pick an entry to read it.”; nothing says what it is for, and the one overview, the chart, is the second tab. **Proposal:** a one-line purpose under the title (“What your agents learned and wrote down for each other. They can search it before they start.”); the reader pane, when nothing is open, shows the three newest titles and who wrote them; the **chart is the first tab once there are about six entries**; “Log: 2 new today” as a chip in the strip.

### The rooms page

| | |
|---|---|
| **For** | List the rooms; open, rename, remove one; make a new one. |
| **Problem** | **A room cannot be stopped or started from the page.** The supervisor already tracks it (a room is wanted or not, running or stopped; “starts at boot” is stored), but there is no route and no key. |
| **Proposal** | **Stop / Start** on each card, **Stop all / Start all** in the header (each asks once and says how many agents it stops; Start does not ask), a “starts at boot” note and tick. Stopping MAIN warns that it also runs the update. Needs `POST /api/rooms/<id>/stop` and `/start` and the two “all” forms, behind the Director's login and step-up, with tests and RSO's review. |

### The update entry point

**Problem (measured):** the version is a link to the changelog; the strip appears only when a newer version is already cached, and only in room main; CHECK NOW is in the VERSION CHECK block, block 16 of 24 in Flight Rules. A Director who wants to know “am I current?” has nothing to press. **Proposal:** **the version is a button.** Its popover says “gonogo 0.11.0 · up to date · checked 3 h ago” with **Check now**, **What's new** and Settings; when newer, “0.12.0 is out” with **Update to 0.12.0** (the existing flow and its confirmation). The same button is on the rooms page and in every room (another room links to main). The strip stays for the moments that matter. No server change.

## 3. Does the UI say what it does?

| Today | What it is | Say instead (title + one line) |
|---|---|---|
| Operations | Your agents' consoles | **Consoles** · “Your agents: who is working, who needs you” |
| Sequence | Activity of each agent over ten minutes | **Activity** |
| T-minus | A go/no-go poll of the agents | **Poll** · “Ask every agent for go or no-go” |
| Max Q | A cap on agents working at once | **Max Q** · “Most agents that may work at once” |
| Propellant | Token and dollar ledger and limits | **Fuel** · “What the room has spent, and the limits” |
| Launch Window | Schedules | **Schedules** · “Brief an agent at a time you choose” |
| Uplink / Relay | Receive from / send to services | **Receive (Uplink)** / **Send (Relay)** |
| Docking | Link to another gonogo | **Other stations (Docking)** |
| Mission Log | The room's shared notebook | **Mission Log** · “What your agents learned, for each other” |
| Patch Panel | A command palette | **Jump to… ⌘K** |
| Flight Rules | Every setting | **Flight Rules** · “Settings of this room”, in seven groups |
| Livery, Redline, Hold, Relief, Hangar, Recorder | Look; spending guard; pause; extra hires; files; git | Keep the names (they are the product's voice), and put a one-line plain subtitle under the title on first use, from a single table, not retyped per page. |

The product's mission-control vocabulary is a strength once a person has learned it; the problem is that nothing teaches it where it is used. A **plain subtitle under each title** (one table in one file, also used by the docs and the glossary) fixes that without renaming anything.

## 4. Information architecture

| Place | Holds | Why |
|---|---|---|
| **Room view** (every day) | The status strip; the consoles (staffed first); the selected console and its terminal; the brief box; the comm loop. | What you look at and type to all day. |
| **Top bar** | Logo and version button · link lamp · Rooms · Comms (badge) · Work ▾ · Jump to… · ⋯ | Five things, each a different job. |
| **Work ▾** (weekly) | Missions · Flight Plan · Mission Log · Schedules | The places where work is planned and read back. |
| **⋯ menu** | Flight Rules · Livery · Docs · All stop · the update popover | Rare or global. All stop is **one tap** here and in the strip. |
| **Flight Rules** (set up) | Seven groups (§ 2) | Everything that is a setting. |
| **Per console** (Edit) | Directory, role, engine, mode, payload, keys, limits | Unchanged. |

## 5. The pictures (all real)

Every image is a browser screenshot of the app built from this branch (`screens.yml`, run 44876689489, commit ac63552), at 1280 × 800 and 390 × 844, light and dark. **Before** is the default layout, which the prototype does not touch; **after** is the same build with `?layout=next`, a prototype made of the app's own components and CSS (`src/client/Next*.tsx`, `StatusStrip.tsx`, `next.css`; off unless the address has `?layout=next`, remembered for the tab, `?layout=old` turns it off). Pairs are in the folder `ui-v2/` (an `index.html` shows them side by side).

`browser/geometry.ts` measures every prototype screen in the real page: no two visible keys overlap, nothing scrolls sideways, no label is clipped, keys are at least 24 px (44 px on a phone). The last run says "no geometry problems". That check found real faults on the way (see below), and one that was in the app already: the FEATURES block of Flight Rules was 415 px wide on a 390 px phone because a long chip does not wrap (fixed in `rules.css`, it is in the old layout too).

### What I saw wrong, and what is left

Found by reading the PNGs, not by the check:

- **Poll chip said “[OBJECT OBJECT]”** (the chip printed the poll word object). Fixed.
- **Layout popover** ran past the bottom of the screen, sat over keys it did not cover, and the description of the selected density was unreadable on the dark key. Fixed (scroll, scrim, colour).
- **Phone top bar:** the “Jump to…” key wrapped on two lines and a second “⋯” duplicated the bottom bar's More. Fixed.
- **Phone Flight Rules:** the group index wrapped to three rows and covered the first block; Budget keys were under 44 px. Fixed.
- **Full wall (all five panels as boxes):** the boxes stretched to the height of the tallest (Propellant) and left empty areas. Fixed (they keep their own height).
- **Chip popovers on a phone** covered the chip that opened them. Fixed: on a phone every popover is a sheet above the bottom bar.
- **Flight Rules grouped** was one page of about 14 000 px on a phone. Fixed: the groups are an accordion with one open (the page is 2 700 px with Room open), and Agents and System and update are rows (name, what it is now, Edit ▾ opening the existing block in place). All seven groups are rows now; the value of some is a placeholder ("see Edit": Semantic search, Login/sessions/keys, Phone approvals).
- **Terminal toolbar** (was only Expand): A−, A+, Copy ▾ (selection, last answer, the screen, all scrollback), Find with ↑ ↓, ↓ Latest, Full screen, Expand; Select on a phone. Built on xterm's own buffer; no new dependency. **Not checked in a browser run:** what Copy puts on the clipboard, Full screen, and Find's match (the shots show the menu and the open Find field only). “Last answer” is a guess: the text after the last line that starts with `>` or `❯`, so it fits Claude Code and nothing else.
- **Phone room** had no terminal and a screen two thirds empty. Now the selected console's terminal is under the list with the same toolbar (53 columns wide, small but usable).
- **Counts** said "3 staffed · 21 open" over "16 open seats". Both now say 16 (the positions that are free).
- **Strip on every view:** the strip showed one chip in the console shots because the browser remembered the Focus layout from the shot before. The spec now goes back to Standard; every shot has the same strip.
- **Expanded console:** a line of the stand-in agent's output is cut at the right edge ("[Directo"). The terminal is wide again (114 columns, it reflows), so this looks like the stand-in drawing its line at the old width, not a refit fault; **I could not confirm that without a real agent**.
- **Still open, seen in the shots:** the toolbar wraps to two rows in the 410 px console panel; the group headings of the accordion repeat the index above them (one of the two can go); some rows' values are placeholders.
- **Phone Expand** is built: the terminal fills the screen (Copy, Select, Back, ⋯). The header row with Open console stays above it.
- **Toolbar** is one row at 1280 now: Copy ▾, Find, Expand and a ⋯ menu (A−, A+, Latest, Full screen).
- **Version popover:** shows CHECK NOW and Update to… in the update state, captured with a **stub** (`?layout=next&update=1` makes the page say 9.9.9 is out; the registry cannot be reached from a test). With the stub on, the real update strip under the top bar also offers CHECK NOW, so there are two.
- **Rooms page start/stop:** not prototyped. The supervisor has no stop or start route, so there is nothing to draw it from; the "before" (rooms list with two rooms) is in the pairs. The route spec is in `docs/rooms-stop-start-spec.md` (GUIDO has answered; RSO has not reviewed).

## 6. Build plan: six PRs, in order of gain over effort

| # | PR | What changes for you | Effort | Depends on |
|---|---|---|---|---|
| 1 | **Status strip and a room that fits the first screen** | The wall becomes the 60-px strip with five popovers; staffed consoles first, open seats one row; the top bar on one row; the terminal and the agents are above the fold at 1280 × 800 and the first phone screen. Layout densities (Focus / Standard / Full wall) in the stored layout. | M to L: `RoomLayout`, `WallView`, `RoomView`, `shell.css`; the layout model is kept | none |
| 2 | **The terminal** | Toolbar, sizes, Expand, Full screen, Find, Latest, four Copy modes, 10 000-line scrollback; on a phone the terminal fills the screen and Select works. | M: `TerminalPane`, `PhoneConsole`; xterm's own selection and buffer, no new dependency except xterm's search addon (MIT, same project) | 1 (the panel's width) |
| 3 | **The rooms page: Stop, Start, Stop all, Start all** | A room can be stopped and started; “starts at boot” is a tick. | M: supervisor routes (new write routes: **RSO reviews**), `roomspage.ts`, tests | none |
| 4 | **Top bar, Work menu, Jump to…, the version button** | Nine keys become five; a visible search; “am I current?” has an answer and CHECK NOW is one click away, in every room and on the rooms page. | S to M: `App.tsx`, `PatchPanel`, `CheckNow`; no server change | none (can go with 1) |
| 5 | **Flight Rules in seven groups** | An index, rows that show what each setting is now, Find a setting, Uplink/Relay/Docking/Phone approvals moved in from Launch Window (which becomes Schedules), All stop reachable in one tap. | L: `Rules.tsx` and the blocks (they keep their code; the page around them changes) | 4 (the menu) |
| 6 | **Words, Edit room, Mission Log** | The plain subtitle table; the Layout popover replaces the grid as the first thing Edit room opens; Mission Log's purpose line, chart-first and a “new today” chip. | M | 1 (the strip) |

PRs 1 and 2 answer the sentences you wrote first (the boxes, the terminal); 3 and 4 are the two small, clear missing buttons; 5 is the biggest piece and the least urgent. Each PR has a test that renders the new layout and keeps the existing ones green; none of it can be *seen* here, so each PR needs a person with a screen (or the next `screens.yml` run) before merge.

## 7. What I did not decide

- **The strip's chips are my guess** of what each box should say in one line; the Director may want the T-minus poll button bigger, or Max Q out of the strip.
- **Stopping MAIN** is allowed in the mock with a warning; it may be better to refuse it while an update runs.
- **“Work”** is a placeholder name for the menu of Missions, Flight Plan, Mission Log and Schedules; “Plan” or “Work” or “Missions” could do.
- **Frequencies** are estimates (see the top).
