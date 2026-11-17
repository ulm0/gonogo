# Build spec: mission-control theme, T-minus, Max Q, custom provider

Written 2026-11-16 for the builders of this round. It is the build brief of a finished round: after the reviews the shipped behaviour is described by the last subsection of `docs/contract.md` ("Mission-control round"), which wins over this file where they differ. Short on purpose: read this file, `src/shared/protocol.ts` (already
updated), `src/shared/positions.ts` (the roster, already written) and the source files you own. Do not read
`docs/contract.md` in full (270 KB); grep it for the section you need (4 = state machine, 5 = messages and delivery,
3 = HTTP and WebSocket, 7 = launcher, 8 = client). While building, where this spec and the contract disagreed, this spec won.

## Rules for every builder

- You own only the files in your assignment. Others are being edited at the same time by other builders. If you need
  a change elsewhere, put it under `requests` in your report.
- `src/shared/protocol.ts`, `src/shared/positions.ts` and `src/server/constants.ts` are done and are not edited by
  builders (the types for everything below are already in them). If something is missing or wrong, report it.
- Run only your own test files (`npx vitest run test/<file>`), and typecheck with `npx tsc -p <config> --noEmit`, reading
  only the lines for your own paths (other builders' unfinished files will show errors). Never run `npm run build`,
  `vite build` without a private `--outDir`, `npm pack`, `npm install` or `npm ci`. Add no dependency.
- Never: git commands, npm publish, docker, a real `claude` session, reading `~/.claude*`, `~/.npmrc`, any `.env`.
  Scratch files go under the scratch folder named in your task, never `/tmp`. Set
  `NPM_CONFIG_USERCONFIG=<scratch>/empty-npmrc` if you run npm.
- Quota matters: read only what you need, do not re-read big files, keep screenshots to the few that decide something.
- Conventions as before: TypeScript strict, ESM, relative imports end in `.js`, no `any`, named exports, comments say why,
  no `console.*` in `src/`, plain closures, no new dependency. The product is called gonogo; the MCP server key is
  `gonogo` (tools are `mcp__gonogo__*`).
- Write the tests listed for your part; they must pass and must fail on the old behaviour. Do not weaken a test.
- Return the structured report: files changed, what you did, exact checks you ran, deviations, requests, not checked,
  `contract_notes` (behaviour that docs/contract.md states and you changed, one line each).

## The theme, in words (all builders)

The product is a flight-control room. The human is the **Director**. The boss agent is **FLIGHT** (default name `flight`).
Agents are positions at consoles; the 15 positions are in `positions.ts`. Words that change in the UI: office becomes
operations room, desk becomes console, empty desk becomes open console, mailbox becomes the Gallery (the Director's
viewing gallery behind glass), envelope becomes packet, `you` and `user` are shown as Director. The wire still says
`user` and `boss`. Button verbs stay plain (Hire, Stop, Restart, Edit).

## Server: hire, edit, positions, providers (builder S1 for hub.ts, S2 for launcher.ts)

- `position` (optional): must be an id in `POSITION_IDS`, else `HubError('bad_request', 'unknown position', field 'position')`.
  Stored in `AgentRecord.position`, shown in `AgentView.position` (null when absent). `EditRequest.position` null clears it.
  The boss created on first run gets `position: 'flight'`. Existing agents have none.
- `provider` (optional, default claude): must be in `PROVIDERS` (field 'provider'). Stored only when `custom` (omit the field
  for claude so old files stay unchanged); `AgentView.provider` is always set. It cannot change by edit.
- `command`: required for a custom agent (trimmed, non-empty, at most `COMMAND_MAX_CHARS`; field 'command'), refused for claude
  ("only a custom agent has a command"). Edit may change it; like role, dir and mode it makes the record `dirty` until restart.
- A custom agent: `mode` is stored as `default`, `confirmBypass` is ignored, the role is still required (a short label).
- `list_roster` entries and `RosterEntry` carry `position`.

## Server: the custom provider

- Launcher (S2): `prepareStart` for a custom agent writes no settings, no MCP file, no token, no memory file. The spec is the
  command parsed like `GONOGO_AGENT_CMD` (`parseAgentCmd`: JSON array of strings, or words separated by spaces), `cwd` the agent's
  dir, the usual scrubbed child environment (the Claude Code session variables and `GONOGO_SCRUB_ENV` still removed; no
  `GONOGO_TOKEN`). A command that cannot be parsed, or whose first word is empty, rejects with a one-line reason.
- Hub (S1): no hooks, no pointer, no draft latch, no title or screen reconciliation, no startup dialog logic for custom agents.
  State: `starting` after spawn; the periodic sweep that already exists compares `io.outputBytes(name)` with the last sample:
  more output within the last `CUSTOM_ACTIVE_MS` means `working`; output seen and quiet for `CUSTOM_ACTIVE_MS` means `idle`; no
  output at all for `CUSTOM_START_MS` means `idle`. An exit is handled by the existing exit path (state `stopped`).
- Messages to a custom agent are `undelivered` at once with the note `<name> runs a custom command and cannot receive messages`.
  A custom agent has no token, so it cannot send. It is never in a default poll.

## Server: T-minus (hub.ts S1; mcp.ts and web.ts S2)

State machine, in memory only (cleared at shutdown), one poll at a time (`PollView`, `PollEntry` in protocol.ts):

- `startPoll({agents?})`: entries are the named agents, or every running claude agent except the boss. An agent must exist, be
  running (state not stopped, no transition) and be a claude agent, else `bad_request` field `agents`; no entries is
  `bad_request` ("nobody to poll"). `conflict` ("clear the poll first") while a poll exists in any status. Status `open`.
  Each entry gets a message from `user`: subject `T-minus: go/no-go poll`, body `The Director is polling for go or no-go.
  Call go_nogo with your vote and a one-sentence reason.` The note is `waiting for <names>`.
- `vote(agent, generation, vote, reason)` (from the MCP tool): `ok:false` with a plain note when there is no open poll
  (`no poll is open`), the caller is not in it (`you are not in this poll`), the generation is stale (`this session has ended`).
  Otherwise record vote, trimmed reason (cut to `POLL_REASON_MAX_CHARS`) and time; a second vote while open replaces the first.
  The first `no-go` sets status `hold` (note `no-go: <names>`). When every entry has voted and none is no-go the status is
  `go`, the note `all go`, and the boss gets a message from `user`: subject `T-minus: all go`, body `Every polled position is
  go. Proceed.` Votes are always recorded. While the hold came from a no-go vote, every vote re-evaluates the poll: a standing no-go keeps `hold`; no no-go left and everybody voted go gives `go` (the boss is told once); no no-go left but a vote missing gives `open` again. A hold the Director called with `holdPoll` never changes by votes: the Director clears or aborts it. A vote shares the per-agent send window of `send_message` (refused with `too many requests: wait a moment`), and the reason is stored as one clean line (control and bidi characters removed, whitespace collapsed).
- `holdPoll()`: open becomes hold (note `held by the Director`). `abortPoll()`: any poll becomes `aborted` and every entry that
  has not voted no-go gets a message from `user`: subject `T-minus: aborted`, body `The Director aborted the poll. Stand by.`
  `clearPoll()`: removes the poll (emits `poll: null`). `conflict` for hold or abort with no poll.
- An entry whose agent stops or restarts while the poll is open or on hold becomes `no-go` with reason `stopped`
  (that can turn the poll to hold). An entry whose agent is removed is deleted (a poll with no entry left is cleared, and an empty poll never sends `T-minus: all go`); a rename renames the entry.
- Every change emits a `PollFrame`; `StateSnapshot.poll` carries the current one.
- MCP (S2): tool `go_nogo` with zod shape `{ vote: enum go | no-go, reason: optional string max POLL_REASON_MAX_CHARS }`, description from
  `MCP_DESCRIPTIONS.go_nogo`, calling `hub.vote(agent, generation, vote, reason)` and returning the `VoteResult` the way the other
  tools return theirs. `ALLOWED_TOOLS` already lists it, so the launcher's `--allowedTools` and the settings pick it up.
- REST (S2), same auth and error conventions as the other routes: `POST /api/poll` body `PollRequest` answers 201 with the
  `PollView`; `POST /api/poll/hold` and `POST /api/poll/abort` answer 200 with it; `DELETE /api/poll` clears and answers like
  the existing delete routes. Unknown extra body fields are ignored, as on every other route (contract 3.3).

## Server: Max Q (hub.ts S1; web.ts and cli.ts S2)

- `GovernorView { limit, working, holding }`. `limit` null is off; otherwise 1 to `MAX_AGENTS`. `setGovernor({limit})` validates
  (`bad_request` field `limit`) and emits a `GovernorFrame`; `governor()` returns the current view. The initial limit comes from
  `HubOptions.maxWorking`; cli.ts reads `GONOGO_MAX_WORKING` (a whole number 1 to `MAX_AGENTS`, anything else ignored with a
  warning) and lists it in `--help`.
- Effect: in the delivery check, a pointer is not typed to an idle recipient while the limit is on, the number of agents in state
  `working` is at or above it, and none of the messages queued for that recipient is from `user`. The messages stay queued with
  the note `waiting: load limit (<working> of <limit> agents working)`; the sweep re-checks as it already does, so they go as
  soon as an agent finishes. Messages from the Director, poll messages, the Stop-hook hand-over to an agent that is already
  working, and custom agents are not gated.
- `working` counts claude agents in state working plus claude agents whose pointer is typed and not yet confirmed (so two deliveries in one tick cannot both pass a limit of 2); custom agents take no slot; `holding` counts queued messages that wait only for the limit. Emit a `GovernorFrame`
  whenever limit, working or holding changes (compare a signature, as the hub does for agent views). Memory only.
- REST (S2): `PUT /api/governor` body `GovernorRequest` answers 200 with the `GovernorView`. `GET /api/state` includes
  `poll` and `governor`.

## Server: the rest (S2)

- `launcher.ts`: nothing else changes for claude agents except that the allowed tools now include `go_nogo`.
- `fake-claude.mjs` (the stand-in): accepts the four tool names; new directive `@fake vote go|no-go [reason]` calls `go_nogo`.
- Boss rename: tests and docs already use `flight`.
- e2e scenarios to add (S2): a custom agent (hire with `provider: 'custom'` and a command that prints and keeps running):
  states, `undelivered` note, no token files; a poll with two stand-in agents (all go; a no-go gives hold; abort; clear); the
  governor holding an agent-to-agent message until a working agent finishes.

## Client: shell, hire form, wall display (builder U)

Owns `App.tsx`, `HireForm.tsx`, `Brief.tsx`, `Activity.tsx`, `TerminalPane.tsx`, `store.ts`, `api.ts`, `wording.ts`, `main.tsx`,
`WallDisplay.tsx` (new), `styles.css`, `index.html` and `test/client-store.test.ts`.

- Wording: top bar title `gonogo`; the floor panel is `OPERATIONS`; the human is `Director` everywhere it is shown (the Gallery,
  the activity strip, `Brief` labels: "Brief the boss (<name>)" stays, the sender `user` is displayed as `Director`); empty console
  text; "mailbox" becomes "Gallery". The wire names do not change.
- Hire form: a Provider choice (Claude Code, Custom command). For Claude Code a Position select with the 15 positions (call sign,
  title) plus "Custom role". Choosing a position fills the name (its id, or `<id>-2`, `-3` while taken), the role textarea (the
  position's default role, editable) and shows the one-line summary. Custom command shows a command input (placeholder
  `htop` or `["node","server.js"]`), hides the permission mode, and says the agent cannot send or receive messages. Edit mode
  can change position and, for custom agents, the command. Errors from the server are shown as today.
- `WallDisplay`: a glass panel above the floor, full pane width. Left: T-MINUS, a status chip (none, `POLLING 2 of 5`, `GO`, `HOLD`,
  `ABORTED`), one lamp per entry (a small circle in the position colour with the call sign, hollow = no vote, filled with a
  check = go, filled with a cross = no-go; the reason as a tooltip and in the note line), and the buttons Poll (starts a poll
  of every running claude agent except the boss; disabled when there is nobody), Hold and Abort (while open or on hold) and
  Clear (when finished). Middle: five counters, one per state, each with its shape icon and number. Right: MAX Q, a segmented gauge
  of working against the limit, a stepper (minus, plus, off) and the line `holding N` when N is above zero. Every control is a real
  button with an accessible name; changes are announced in a `role="status"` region.
- Store and api: `StateSnapshot.poll` and `.governor`, `PollFrame`, `GovernorFrame`; functions `startPoll`, `holdPoll`,
  `abortPoll`, `clearPoll`, `setGovernor`; `hire` and `edit` send `position`, `provider`, `command`.
- Palette: define CSS custom properties in `styles.css` for the room (names below). The floor builder uses them with fallbacks.
  `--room-bg #0b1220`, `--room-panel #121a2b`, `--room-glass #1a2640`, `--room-line #2a3858`, `--room-text #e6e8ee`,
  `--room-muted #9aa6bf`, `--room-accent #5fd4e6`, `--room-gold #f5c451`. State colours stay `STATE_COLORS` from protocol.ts.
  Text contrast at least 4.5:1, shapes at least 3:1.
- Tests (`test/client-store.test.ts`): frame handling, the position-to-name suggestion, the form's request body for each provider.

## Client: the floor (builder F)

Owns `Floor.tsx`, `art.ts`, a new `floor.css` (or a `<style>` inside Floor), and `test/client-floor.test.ts`. The props stay as
today (`agents`, `selected`, `envelopes`, `userMail`, `reducedMotion`, `onSelect`, `onEmptyDesk`, `onMailbox`), so App.tsx does not change
for you. `Floor.tsx` and `art.ts` must not import `pixi.js`: **the floor is drawn as inline SVG in the DOM with CSS animation, no
canvas, no WebGL, no image files, no new dependency.** The integrator then removes `pixi.js` from `package.json`.

Look: a modern, refined control-room scene, not pixel art: dark glass, soft gradients, edge lighting, glow made of radial
gradients (no blur filters), flat-illustration operators. Think of the SpaceX and NASA control rooms seen from the back, cleaned
up. Quality bar: it should look designed, with consistent light, depth and spacing. Look at your screenshots critically and refine.

- Layout: one `<svg>` with `viewBox="0 0 720 H"` scaled to the pane width. Keep the grid: 4 columns, cells 168 x 150, margin 24,
  header strip 40 high with the title `OPERATIONS` at the left and the Gallery at the right. At least 8 consoles drawn (whole rows),
  always one open console. Console 0 is FLIGHT's: wider trim in gold, a third screen, a brass plate. Below 480 px the SVG is not
  drawn (the agent list remains). Keep the accessible `ul.agent-list` of buttons and the live region from the current Floor.
- Console (per cell): the operator behind it (head, neck, shoulders; four hair styles, six skin tones, a headset arc with a mic
  boom, shirt in the position colour from `positions.ts` or a seeded hue when the agent has no position; seed from the name as
  today), a desk with a bevelled edge and a lit front panel with three lamps, two angled screens with a glow behind them, a name
  plate with the name and the state label in the state colour, the call sign small above it when there is a position. A selected
  console has a 2 px rounded outline `#8da2ff` with a faint glow.
- States, each readable by shape as well as colour: **starting**: screens show a sweeping scan line and three dots, operator
  dimmed. **idle**: calm trace on the screens, a check mark in a circle above the operator, lamp steady. **working**: scrolling
  bars on the screens, a rotating arc above the operator, lamp amber. **needs_you**: red `!` on the screens, a triangle beacon
  above the operator, a pulsing ring around the console. **stopped**: screens off, operator desaturated and faded, a power symbol.
- Queue badge: a small packet icon with the count (`9+` above nine) at the console's top right; held: a `HOLD` tag next to it.
- Packets (messages in flight): a small glowing packet with a three-step trail travels a curved path from the sender's console to
  the recipient's (or to the Gallery for `user`) over `ENVELOPE_MS`, eased, fading in the last 150 ms. Drive it with
  `requestAnimationFrame` while any packet exists, updating a `transform`. With `reducedMotion` there is no travel: the recipient's
  console outline flashes for 700 ms. A name without a console skips the animation.
- Gallery: a glass viewing booth at the header's right: a window with a dark silhouette and a small lamp, the label `Director`,
  a red count badge when `userMail` is above zero; it is a real `<button>` overlay that calls `onMailbox`.
- Animation rules: only `transform` and `opacity` animate; everything stops under `reducedMotion` and under the OS setting; at most
  about 2,500 SVG nodes for 24 consoles.
- Tests: the pure helpers (seeded colours, layout, path maths, badge text) in `art.ts`, importable without a DOM.
- Check your work in a browser: build only into a private `--outDir`, start a snapshot server with the stand-in agent as in the
  earlier verification notes, and take at most six screenshots (1440 x 900, 1024 x 768, 390 x 844; states, a message in flight,
  twelve agents). Refine at least twice.

## Order of work and merge

S1 (hub.ts and its tests), S2 (mcp.ts, web.ts, launcher.ts, cli.ts, home.ts if needed, the stand-in and the edge, launcher and e2e
tests), F (floor), U (shell) work at the same time. The integrator then builds, typechecks, runs the suite, fixes the seams,
removes `pixi.js`, and looks at the real UI.
