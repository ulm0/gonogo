# Build spec: the Annunciator redesign

Written 2026-11-17 for three builders working at the same time: S (server), R (room and shell), F (forms and comm loop).
The owner approved the look from mockups. Read this file, the mockups you are told to read, and the source files you own.

## Rules for every builder

- You own only the files in your assignment. Two other builders are editing the rest right now. If you need something
  from a file you do not own, use the seam described here; if the seam is missing, say so in your report.
- Already done by the lead, do not change: `src/shared/protocol.ts` (new: `StateChange`, `AgentView.history`,
  `AgentView.doing`, `AnswerRequest`, `Hub.answer`, `HubIo.press`, `HISTORY_WINDOW_MS`, `HISTORY_MAX`, `DOING_MAX_CHARS`),
  `src/client/base.css` (tokens and primitives), `src/client/store.ts` lines for `form` and `view` (R may add more
  fields), the font packages in package.json.
- Code style: TypeScript strict, ESM, relative imports end in `.js`, comments explain why in one line, no new
  dependencies. Client tests cannot import `.tsx`: keep logic in `.ts` files and test that.
- Run with an empty npm config: `NPM_CONFIG_USERCONFIG=<your scratch>/empty-npmrc` (create the empty file) before `npx`.
  Tests: only your own files (`npx vitest run test/<file>`). Typecheck: `npx tsc -p tsconfig.json --noEmit` (client),
  `tsconfig.server.json`, `tsconfig.test.json`; only errors in your files matter while the others are mid-edit.
- Never: git add/commit/stash/checkout/reset, npm install, network other than 127.0.0.1, a real `claude` or `gemini`,
  reading `agent-fleet/.env`, writing to `/tmp` (use the scratch folder you were given), rebuilding `dist/` in the
  project (build to your scratch folder with `--outDir`).
- No text contrast under 4.5:1 (3:1 for the giant words). Real `<button>`, `<a>`, `<input>` with `<label>`. Touch
  targets 44 px. Motion only through the keyframes in base.css; nothing moves under reduced motion.

## The look

Mockups: `docs/design/*.dc.html` (12 files). They are static HTML with inline styles; the inline values are the exact
sizes and colours. Translate them to classes on top of `src/client/base.css`: use its tokens (`var(--k)`, `--w`,
`--amber`, `--go`, `--nogo`, `--muted`, `--line`, `--line-2`, `--hatch`) and primitives (`.label`, `.legend`, `.disp`,
`.btn` with `data-kind` and `data-size="big"`, `.field`, `.input`, `.textarea`, `.hint`, `.error`, `.chip` with
`data-tone`, `.tile` with `data-kind`, `.flood` with `data-tone`, `.ink`). Do not redefine those; add what is missing in
your own stylesheet. Ignore the mockups' `<x-dc>`, `<sc-for>`, `<sc-if>` wrappers and `support.js`: they are the mock
tool's syntax; the data in each file's `renderVals()` is sample data, not an API.

Principles: light means activity (a working console is a lit white tile, idle is dark, stopped is hatched, an open seat
is dashed); amber means it needs the Director, green go, orange no-go or danger, each used as a whole-block flood with
ink text; giant condensed words (`.disp`) for the one fact of a block; square corners; monospace for everything else.

Words: the human is the Director; the boss agent is FLIGHT in visible text (the wire name stays `boss`); agents sit at
consoles; hiring is "staff a console"; the activity list is the comm loop; a permission prompt "asks for a go".
State labels: STARTING, IDLE, WORKING, NEEDS YOU, STOPPED; a custom agent that prints is PRINTING.

## Server (builder S)

Owns: `src/server/hub.ts`, `src/server/web.ts`, `src/server/cli.ts`, `test/hub.test.ts`, `test/edge.test.ts`,
`test/e2e.test.ts`, `test/fake-claude.mjs` (only if a test needs it), the hub fake inside the tests.

1. `AgentView.history`: at the single place the state changes (hub.ts, "The one way a state changes"), push
   `{ state, at }`. Keep every change of the last `HISTORY_WINDOW_MS` plus the one before them, at most `HISTORY_MAX`;
   prune when pushing and when building the view. A new agent starts with one entry (its first state). Memory only: after a
   restart every agent has one entry. A rename keeps it. The view carries a copy.
2. `AgentView.doing`: on a `PreToolUse` hook set it to the tool summary: reuse the text `describePermission` builds, minus
   the `permission request: ` prefix, cut to `DOING_MAX_CHARS` and to one line without control characters. Reset to null
   at spawn. Custom agents: always null. It is part of the view, so it goes out with the agent frame of that hook; do not
   emit a frame when the text did not change.
3. `Hub.answer(name, { go })`: `not_found` for an unknown agent; `conflict` (`<name> is not asking for a go`) unless its
   state is `needs_you` with `needsKind === 'permission'` and no transition is running; then `io.press(name, generation,
   go ? '\r' : '\x1b')` and `conflict` (`could not reach the terminal of <name>`) when press is missing or returns false.
   Do not change the state here: the hooks do. Returns the view.
   `cli.ts` wires `press` to `terminalHost.write` for that generation (check how `typePointer` is wired; if the host's
   `write` takes no generation, compare the generation in the glue).
4. `web.ts`: `POST /api/agents/:name/answer` with body `{ "go": true | false }` (anything else is 400 with field `go`),
   answers 200 with the `AgentView`; the usual auth, Host, Origin, content-type and body rules apply.
5. Tests for all of it, including an e2e scenario with the stand-in agent (`@fake permission` raises a permission
   prompt; read `test/fake-claude.mjs` for what Enter and Escape do in its dialog) where answer go ends needs_you and
   answer no-go ends it too. Update every test that builds an `AgentView` by hand (`history`, `doing`).

## Shared seams between R and F

- `store.form`: `null | { mode: 'hire'; position?: string | null; custom?: boolean } | { mode: 'edit'; name }`. When it is
  not null, `App` shows only the top bar and `<HireForm />` (F), a full-page screen, not a dialog. F closes it by setting
  `form: null`.
- `store.view`: `'room' | 'loop'`. `App` shows `<Loop onClose={...} />` (F) when it is `'loop'` and no form is open.
- F exports from `src/client/Activity.tsx`:
  `Loop({ items, agents, boss, onSelect, onClose }: { items: readonly ActivityItem[]; agents: Readonly<Record<string, AgentView>>; boss: AgentView | null; onSelect(name: string): void; onClose(): void })`
  (the full comm-loop screen, with the brief box at its foot) and
  `ConsoleTraffic({ items, name, onOpenLoop }: { items: readonly ActivityItem[]; name: string; onOpenLoop(): void })`
  (the last three messages to or from one agent, for the console panel). `Brief({ boss })` keeps its export in
  `src/client/Brief.tsx`. R imports these three; F does not import from R's files.
- CSS: R owns `src/client/shell.css` (imported by `App.tsx`); F owns `src/client/forms.css` (imported by
  `HireForm.tsx`) and `src/client/loop.css` (imported by `Activity.tsx` and `Brief.tsx`). `src/client/base.css` is
  imported once, first, in `main.tsx` (R). The old `styles.css`, `floor.css`, `Floor.tsx`, `art.ts`, `WallDisplay.tsx`
  and `Shapes.tsx` are deleted by R at the end; F must not rely on any class from `styles.css`.
- `test/client-store.test.ts` holds tests for both: F edits only the `describe` blocks about `form.ts` and
  `wording.ts` activity or brief helpers; R edits the rest. Re-read the file before each edit. New tests of F go to
  `test/client-forms.test.ts`; R replaces `test/client-floor.test.ts` with `test/client-room.test.ts`.

## Room and shell (builder R)

Owns: `src/client/App.tsx`, `main.tsx`, `store.ts`, `api.ts`, `wall.ts`, `wording.ts` (shared with F: only add),
`TerminalPane.tsx`, new `Wall.tsx`, `Room.tsx`, `room.ts`, `shell.css`, `index.html`, `test/client-room.test.ts`,
`test/client-store.test.ts` (its part). Mockups: `Room`, `Wall`, `Console`, `System`, `PhoneRoom`, `PhoneTerminal`,
`PhoneGo`.

- Fonts: self-hosted. In `main.tsx` import `@fontsource/big-shoulders/latin-700.css`, `latin-900.css`,
  `@fontsource/ibm-plex-mono/latin-400.css`, `latin-500.css`, `latin-600.css`, `@fontsource/michroma/latin-400.css`,
  then `./base.css`. No request to any outside host. `index.html`: theme-color `#060606`.
- Top bar: the GO / NO GO mark (two tiles), the working directory of FLIGHT, LINK UP / LINK DOWN lamp, `+ STAFF A CONSOLE`.
- The wall (`Wall.tsx`, logic in `wall.ts`), four blocks as in `Room.dc.html`:
  - MISSION: the latest message from `user` to the boss whose subject does not start with `T-minus:` is the mission (its
    subject, or the first line of its body); the clock counts up from its `at` (server time: correct with the offset
    between `info` time and the browser if the store has one, else plain difference), ticking each second, `HH:MM:SS`.
    No such message: label `NO MISSION`, the line `Brief FLIGHT to start the clock.`, the clock `00:00:00` in `--ghost`.
  - SEQUENCE: one track per agent in room order from `AgentView.history` over the last `HISTORY_WINDOW_MS`: working
    spans lit, needs-you spans amber and taller, custom agents' working spans in `#8e8c86`, everything else the base
    `#1d1e22`. Pure function in `wall.ts` returning spans in percent; render as a CSS gradient or flex spans. An
    `aria-label` that says who is working and who needs the Director now. Re-render with the clock tick.
  - T-MINUS: the giant word per poll state (no poll `STANDBY` in `--ghost`, `POLLING` with `n/m`, `HOLD`, `NO-GO`, `GO`)
    with the server's note and the reasons; buttons by state as today (`pollButtons`). When the status is `go`, `hold`
    by a no-go, or aborted, the whole wall section is a flood (`Wall.dc.html`: go green, no-go orange, a hold the
    Director called lit white; aborted: orange with the word `ABORTED`). Keep the keyboard-focus behaviour the current
    `WallDisplay.tsx` has (aria-disabled while busy, focus stays in the group).
  - MAX Q: giant `n/limit` (or `OFF`), the segment gauge, minus, plus, off, `holding N` when above zero.
- The room (`Room.tsx`, logic in `room.ts`): a fixed matrix. Cells 1 to 15 are the positions of
  `src/shared/positions.ts` in their order. An agent with a position sits in that cell; if several share a position, the
  oldest (`desk` ascending) takes the cell. Every other agent (no position, a duplicate, custom) goes to the spare cells
  after the 15, in desk order, followed by one `SPARE` open cell while the room has fewer than `MAX_AGENTS` agents.
  5 columns on a wide pane, 3 on a phone. A staffed tile: legend (the call sign for a seated agent, else the name in
  capitals), two lines (`doing`, then the first of: needs reason, held text, exit text, `n waiting`, the role summary of
  the position), the state with the time in state (`WORKING 38 S`, ticking with the clock), a vote chip during a poll
  (`GO`, `NO-GO`, `WAIT`), `CUSTOM` for a custom agent. Tile kinds map to `.tile[data-kind]`: working (and a printing
  custom agent) lit, needs amber, idle unlit, starting dashed white, stopped hatched, open dashed dim. The selected
  agent has `data-selected`. An open position cell shows the call sign and the position's short summary and opens the
  staffing screen with that position (`form: { mode: 'hire', position }`); the spare cell opens it with no position.
  Each tile is a real button with a full accessible name (name, position title, state, what it needs).
- Your console (under the room): one amber flood per agent in `needs_you`: for kind `permission`,
  `<CALL> ASKS FOR A GO`, the reason without its prefix, NO-GO and GO buttons calling `api.answer` (add it:
  `POST /api/agents/:name/answer`), an error line if it fails; for the other kinds, `<CALL> NEEDS YOU`, the reason and
  one button `OPEN THE TERMINAL` that selects the agent. Then `<Brief boss={boss} />`.
- Selected console panel (right column on a wide page): header with the legend in 26 px, a state chip, name, position
  title and directory, buttons START or RESTART, STOP, EDIT, REMOVE (not for the boss); the states of `Console.dc.html`
  (needs you: amber header and the go/no-go foot; stopped: hatched header, the exit text, a big START; starting: dashed;
  custom: lit header, the command, the note that it has no hooks and no mail). REMOVE asks in an orange flood inside the
  panel (`Edit.dc.html`, "REMOVE PAO?") instead of `window.confirm`. Then `TerminalPane`, then
  `<ConsoleTraffic ... />`. No tab bar: the room is the navigation.
- System states (`System.dc.html`): not signed in (orange flood, `NO-GO`), server gone after
  `RECONNECT_SERVER_GONE_AFTER` failed attempts (`LOS`, hatched, RETRY NOW if `api` can reconnect on demand, else no
  button), loading (`STANDBY`), and the room is never drawn before the first state frame.
- Phone (viewport under 700 px; `PhoneRoom`, `PhoneTerminal`, `PhoneGo`): one column: top bar, the wall reduced to
  mission, clock, the poll word with its buttons and a one-line Max Q; the needs-you floods; the matrix in 3 columns;
  a bottom bar ROOM, LOOP (with the count of unseen mail for the Director), BRIEF (opens the loop and focuses the brief
  box). Tapping a console opens it full screen with `‹ ROOM`, the terminal, a key row (esc, tab, up, down, ^C, enter;
  each sends the key through `api.input`) and a line input with TYPE (sends the text, no Enter). When the open console
  asks for a go, show the full amber screen of `PhoneGo.dc.html` first, with `Open the terminal` to see the terminal
  instead. Add what you need to the store (for example `consoleOpen`).
- Tests: `room.ts` (seating, spare cells, tile kind and lines, vote chip), `wall.ts` (mission pick, clock text, sequence
  spans, the poll word and flood tone), `store.ts`/`api.ts` changes.

## Forms and comm loop (builder F)

Owns: `src/client/HireForm.tsx`, `form.ts`, `Activity.tsx`, `Brief.tsx`, new `forms.css`, `loop.css`,
`test/client-forms.test.ts`, the form and wording parts of `test/client-store.test.ts`. Mockups: `Hire`, `Edit`, `Loop`,
`PhoneHire`, `PhoneLoop`.

- Staff a console (`Hire.dc.html`, `PhoneHire.dc.html`): a full page inside `.app` (not a `<dialog>`): the giant title,
  `n of 24 consoles staffed`, CANCEL. Step 1, the position matrix: 15 `.tile` buttons (call sign, short summary, a tag:
  `OPEN`, `STAFFED · ADD ANOTHER`, `PICKED`; FLIGHT is hatched and disabled with `THE BOSS HOLDS IT`), then two wide
  tiles `NO POSITION` and `CUSTOM COMMAND`; under them a lit block with the picked position's call sign, title and
  summary. Step 2: NAME, ROLE, WORKING DIRECTORY. Step 3: PERMISSIONS as three tiles (ASK, ACCEPT EDITS, BYPASS in
  orange); picking BYPASS shows the confirmation of `Edit.dc.html` ("BYPASS PERMISSIONS?") with the checkbox before the
  big button works. The big button reads `STAFF <CALL OR NAME>`. It opens preselected from `store.form.position` or
  `store.form.custom`. All the rules of today's form stay (`form.ts`: `validate`, `choosePosition`, `suggestName`,
  `hireRequest`, `editRequest`, server errors shown at their field, focus on the first invalid field).
- Custom command (`Edit.dc.html`, middle column): NAME, COMMAND (error block in orange under the field), WORKING
  DIRECTORY, the note that the command is saved in plain text; no position, no permissions. The big button says what to
  fix while the form is invalid (`FIX THE COMMAND TO STAFF LOGS`).
- Edit (`Edit.dc.html`, left column): `EDIT <CALL>`; a lit notice when the agent is running (`... Changes apply at its
  next start.`); NAME read-only with `Stop the console to rename it.` unless it is stopped; SAVE and SAVE AND RESTART
  (the second only when it runs). The provider cannot change. A room that is full shows the `ROOM FULL` block instead
  of the hire form.
- Comm loop (`Loop.dc.html`, `PhoneLoop.dc.html`): the giant title, filter buttons with counts (ALL, TO YOU, HELD,
  UNDELIVERED), a ROOM button (`onClose`). Rows newest first: time, `FROM › TO` in the legend face with the Director
  shown as DIRECTOR, subject, a plain note under it (reuse `plainActivityNote`), a status chip: TO YOU lit, HELD amber,
  UNDELIVERED orange, QUEUED and DELIVERED and READ quiet. A row whose recipient is the Director is a lit row on a
  phone. Clicking a row opens it in place: the body and, for a message to the Director, a reply box that sends to its
  sender (`api.sendMessage` with `inReplyTo`). The pinned lines for agents that need the Director are gone (R shows
  them). Opening the loop marks the Director's mail seen, as the Gallery button did (`markMailSeen`).
  `ConsoleTraffic`: three compact rows and an `All traffic` link.
- Brief: `BRIEF FLIGHT` label, input, SEND, the confirmation line under it (`briefSentText`).
- Tests: every new pure helper (filters and counts, chip per status, row route text), and the form rules you touch.
