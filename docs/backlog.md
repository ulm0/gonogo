# Backlog

Sections 1 to 9 list what Munder Difflin has that gonogo does not. Section 10 is gonogo's own theme, which
the owner chose on 2026-11-16.

Written 2026-11-16. gonogo is a clean rewrite of the core of
[Munder Difflin](https://github.com/HarnessMD/munder-difflin): hiring, live terminals, the office floor with
states and envelopes, agent messaging, a boss, a plain `memory.md` per agent, and npm and Docker packaging.
Everything below is something the reference has and gonogo lacks.

Rules for whoever picks an item up:

- None of the reference's code, art or names may be copied (its tile art is licensed to its authors only). Read
  it for behaviour, then write the feature fresh.
- The list comes from a read of the reference repository plus its file and IPC names. Items marked *(inferred)*
  were not confirmed by running the reference app: find out what the feature really does first.
- Anything that changes how an agent CLI starts, reports its state or receives mail needs a real run of that CLI
  before it is trusted. `pnpm smoke:real --spend` is the pattern used for Claude Code.
- The time estimates are rough guesses made before any of this work started.

## 1. Other agent CLIs (asked about first)

gonogo ran Claude Code only until Engine Bay (section 11). The reference supports Codex, Gemini, Grok, Kimi, Antigravity, Qwen, OpenCode,
Crush, Pi, Copilot, Cursor and a custom command.

Claude Code is built into four places, and each new CLI needs its own version of all four:

1. **Launcher**: the command-line flags and the generated settings file (`src/server/launcher.ts`).
2. **State**: the hooks that say working, idle or needs you (`src/server/hooks.ts` and the hub's hook handling).
3. **Screen**: the ready rule, the title glyphs and the dialog patterns of the terminal UI
   (`src/server/terminal.ts`, `src/server/constants.ts`).
4. **Delivery**: the typed pointer and the Stop-hook block that hand mail to the agent (`src/server/hub.ts`).

Plan:

- [x] Refactor those four into a provider adapter, with Claude Code staying the default. Built as Engine Bay
      (2026-11-17, `docs/engine-bay-spec.md`).
- [x] Add Gemini first. Built from its help and bundled source (hooks through a `node -e` shim, MCP through its
      system settings path); not run against a model, because it is not signed in on the build machine.
- [x] Add a `custom` provider: any command in a terminal, with an avatar but no messaging. Built (2026-11-16); its
      state is working or idle from its output, and it takes no Max Q slot.
- [ ] Add further CLIs one at a time (about 1 to 2 hours each; each must be installed and signed in to be
      verified). Engine Bay added Codex, opencode, Kimi, Copilot, pi, Qwen, Grok, Crush and Cursor Agent from their
      docs (pi from its help); each still needs a real run. The reference gives the non-Claude CLIs live state through a hook shim per CLI. Qwen has no
      hooks, so the reference watches its model traffic through a loopback proxy instead.
- [x] Per-provider model picker, API keys and a CLI installer. Built 2026-11-18: a `--model` field per engine and write-only API keys
      (**Clearance**, `keys.json`), and **Pad Check** (`gonogo doctor`, the Engine Bay list): it finds each CLI and prints the vendor's
      install command, but gonogo never runs an installer. Tested with the stand-in agent only (`docs/engine-bay-spec.md`).

## 2. Shared room state

- [x] Blackboard: a shared plan (`board.md`) with the boss as its only writer. Built 2026-11-18 as the **Plot Board**.
- [x] Task ledger with a kanban board. Built 2026-11-17 as the Flight Plan.
- [ ] Missions *(inferred)*.
- [x] Threads panel: messages grouped by conversation *(inferred)*. Built 2026-11-18 as **Party Line**.
- [x] Git-committed audit log of the room, with the server as the only committer. Built 2026-11-18 as the **Black Box**.

## 3. Memory

- [ ] Semantic search over agent memory (the reference wraps the MemPalace CLI). Not built: it needs an embedding model that gonogo does not ship, and calling the Mission Log's word search "semantic" would be untrue.
- [x] Knowledge graph and its panel. Built 2026-11-18 as the **Star Chart** (the Mission Log as a graph).
- [x] Reflection: summarising `memory.md` so that it does not grow without bound. Built 2026-11-18 as **Mass Budget**: REFLECT asks the agent to condense it; gonogo keeps one copy and never writes the file.

## 4. Orchestration

- [x] A boss that hires agents by itself. Built 2026-11-18 as **Relief**: FLIGHT asks with `hire_agent`; only the Director's GO hires.
- [x] Waking idle workers that hold unread mail. Already covered: gonogo types a pointer into an idle agent and redelivers (contract 5.3 and 5.5). No code was added.
- [x] Hold button for an agent *(inferred)*. Built (2026-11-18) as **Hold**: a key in the console panel puts a Claude Code
      or Gemini CLI agent on hold through Redline's machinery (Escape if working, mail held) until RESUME
      (`docs/telemetry-spec.md`). Tested with the stand-in agent only.
- [x] Workers in git worktrees *(inferred)*. Built (2026-11-18): the `Own git worktree` box, `docs/features/worktrees.md`.
      Tested with real git and the stand-in agent only. Not built: a boss's `hire_agent` carrying the setting.
- [ ] Phone approvals through Claude Code's `/remote-control`.

## 5. Voice

Excluded by the owner (2026-11-18): none of these will be built.

- Excluded: realtime voice mode for the boss *(inferred)*.
- Excluded: dictation.
- Excluded: meeting transcription.

## 6. Integrations

Built as Relay, Uplink, Launch Window and Payload; section 11 has the names and dates and is where those features are
tracked. Only what is still missing stays open here.

- [x] Slack. Built 2026-11-17 in **Relay**: bot mentions and DMs come in through an uplink; messages to you, Redline
      trips, T-minus results and blocked tasks go out; thread replies reach the agent. Not tried against a real Slack.
- [x] GitHub. Built 2026-11-17 in **Relay**, inbound only: push, pull request, issue, comment and workflow-run events
      become messages. gonogo never writes to GitHub; an agent that must open a PR uses its own `git` or an MCP server.
      Not tried against a real GitHub.
- [x] Webhooks. Built 2026-11-17 as **Uplink**: a signed `POST /uplink/<id>` that reaches an agent as a message.
- [ ] A tunnel so that outside services can reach the machine *(inferred)*. Not built: gonogo ships none.
      `docs/https.md` and the Uplink page describe your own HTTPS reverse proxy that forwards only `/uplink/`.
- [x] Triggers. Built 2026-11-17: **Launch Window** (cron schedules) and **Uplink** (webhooks) start work by themselves.
- [ ] History of triggers. Only part is built: an uplink keeps its last 20 deliveries, but a schedule keeps only its
      last run and the hub's answer to it.
- [ ] Integrations registry, skills tab and MCP defaults. Only part is built: **Payload** sets MCP servers and skills
      per agent from text you write. Missing: a list of known servers and skills to pick from, defaults for new
      agents, and a skills tab apart from the hire form.

## 7. Cost and safety

- [ ] Cost and usage tracking with pricing.
- [x] Telemetry. Built 2026-11-18 (see the tool-call timeline below).
- [x] Circuit breaker. Built 2026-11-17 as Redline.
- [x] Tool-call waterfall: a timeline of what an agent did *(inferred)*. Built (2026-11-18) as **Telemetry**: a fold in
      the console panel with each tool call's start, duration, tool and one line, newest first, from the hooks (Claude Code;
      Gemini CLI without failures). 200 calls per agent in memory and in `telemetry.jsonl`. Tested with the stand-in agent only.

## 8. Workspace tools

- [x] File tree with a code editor. Built 2026-11-18 as the **Hangar**: a tree and a plain textarea (no highlighting: CodeMirror measured 90 KB gzipped and was left out); it can create and save files, not delete or rename.
- [x] Git tab. Built 2026-11-18 as the **Recorder**: status, diff, log and commit; no push, pull, checkout or reset.

## 9. App shell

- [x] Onboarding wizard and a settings screen. Built 2026-11-18 as Commissioning and Flight Rules (`docs/shell-spec.md`).
- [x] Command bar. Built 2026-11-18 as the Patch Panel (`docs/shell-spec.md`).
- [x] Office themes. Built 2026-11-17 as **Livery**: four built-in colour themes, custom ones, and an agent that designs one
      from a line of text. It changes colours only, not the floor art.
- Excluded by the owner (2026-11-18): avatars that walk around the floor.
- [x] Auto-update. Built 2026-11-18 as **Rollout**: a daily registry check and `gonogo update`, which prints the command. gonogo never updates itself.
- Excluded by the owner (2026-11-18): translations.
- Excluded by the owner (2026-11-18): Windows.

## 10. Theme: mission control (chosen by the owner)

gonogo gets a fiction of its own: a flight-control room instead of an office. Munder Difflin ships a predefined
cast, the 15 characters of the show it parodies, each an avatar with a one-line blurb. The equivalent here is a
roster of 15 real flight-control positions. Picking a position when hiring sets the call sign, a colour and a
default role text, and all three can still be edited. A custom position with a free-text role stays possible.

| Call sign | In a real control room | Here (default role) |
|---|---|---|
| FLIGHT | Flight director, makes the final call | The boss: takes the brief, hands out work |
| FAO | Keeps the flight plan and checklists | Planner: breaks the brief into tasks |
| FIDO | Plots the trajectory | Architect: picks the approach and the interfaces |
| GUIDO | Watches the guidance computer | Backend and core logic |
| CONTROL | Lunar module guidance and engines | Frontend: the controls people touch |
| DPS | Onboard computers and data | Data: schemas, queries, migrations |
| INCO | Instruments and communications | Integrations, APIs, logging |
| EECOM | Power, life support, consumables | Infrastructure: CI, environments, dependencies, token budget |
| BOOSTER | The launch vehicle | Build and release |
| SURGEON | Crew health | Tests and debugging |
| SIMSUP | Runs failure simulations | Adversarial tester: breaks things on purpose |
| RETRO | Abort and return plans | Code reviewer, plans the rollback |
| RSO | Range safety, can end the flight | Security reviewer, can call an abort |
| PAO | Public affairs | Docs, README, changelog |
| CAPCOM | The only voice to the crew | Reporter: one clear update for the human |

Decided with the owner:

- The human is the **Director**: they brief FLIGHT, and permission prompts read as go/no-go calls.
- The boss's default name is `flight` (`BOSS_DEFAULT_NAME`). The recipient alias `boss` still reaches whoever is the boss.
- The call signs are public job titles and nothing else is borrowed: no NASA logos, no mission names, no names
  of real people.

Known neighbours: other agent tools use "mission control" as a label for a console (`docs/themes.md` has the
survey). None was found with a drawn control room and a roster of console positions.

Work:

- [x] Roster data: the 15 positions with call sign, colour and a full default role text each, as one shared
      constant with tests. The "Here" column above is only the summary of each role text.
- [x] Hire form: a position picker that fills the name and the role (the position sets the accent colour); "custom" keeps today's free form.
- [x] Decide what a second agent in the same position is called. Decided (2026-11-18): positions are presets, not unique
      seats. Picking a position whose call sign is taken fills the name with the next free `<id>-2`, `-3`, ...
      (`suggestName` in `src/client/form.ts`); the server stays the judge of unique names.
- [x] Wording: office, desk, boss, mailbox and envelope get control-room nouns (to be chosen). The verbs on
      buttons stay plain.
- [x] Floor art: rows of consoles facing a wall display instead of desks, avatars with headsets, the five states
      drawn at the console and still readable by shape, the message in flight, and the Director's spot. All of
      it procedural, with no image files. Not designed yet.
- [x] Art quality and style. Done (2026-11-16) as route 1: inline SVG and CSS, `pixi.js` removed (client JS 628 KB raw, 177 KB gzipped). The owner wants the quality of Munder Difflin's art (professional, detailed,
      consistent) and, for mission control, leans away from pixel art (said as "maybe": confirm). Munder
      Difflin's look comes from a licensed pixel tile set that cannot be reused, so this needs another path:
      1. Richer vector drawing in Pixi: gradients, glow, soft shadows, an animated wall display, flat-illustration
         operators. No new dependency; keeps the grid and the tests.
      2. An isometric vector scene: more depth, more drawing code.
      3. Stylised 3D with three.js: lit consoles, emissive screens, bloom. The most impressive, a new dependency
         and a bigger rewrite of the floor.
      4. Illustrated assets supplied or bought: the licence decides whether they may sit in a public repository.
      Decided with the owner (2026-11-16): the lightest route that fits the web platform, which is route 1 done
      natively with SVG and CSS in the DOM instead of a WebGL engine. That would let `pixi.js` be dropped (the
      client bundle is about 1.1 MB raw and 330 KB gzipped today, and Pixi is roughly half of it: an estimate,
      not measured). It also gives crisp output at any pixel density, real text, native focus and
      reduced-motion handling, no WebGL context loss, and consoles that can be real buttons. Costs: no
      per-frame particle effects (CSS keyframes only), glows must be gradients rather than blur filters to
      stay cheap with 24 consoles, and the floor and its tests are rewritten (contract section 8.3).
      Next step: draw one row of consoles in SVG and CSS as a sample (about 30 to 45 minutes) before the full
      theme, and measure the bundle without Pixi.
- [x] Palette. Done as `--room-*` tokens in `src/client/styles.css`. The first sketch was dark navy with cyan and amber; the state colours must keep their contrast.
- [x] Product name: the owner chose `gonogo` (2026-11-16). The package, the command, the state folder, the
      environment variables and the Docker names all use it. Not checked: whether `gonogo` is free on npm.
- [x] Update the README and the contract (section 15 has the round's changes); checked in a browser by the builders and the integrator. Screenshots of the screen are not in the repository.

Ideas from the owner, not designed yet: two real mission-control moments as built-in workflows or rituals.

- [x] **T-minus: the pre-flight poll.** Built (2026-11-16): the Director starts a poll from the wall display; each running Claude agent answers with the `go_nogo` tool; the first no-go holds, all go tells FLIGHT. Run once with a real `claude` (haiku): the agent answered with `go_nogo`; a no-go, hold and abort were not run with a real `claude`. Before a batch of work starts, FLIGHT polls the positions that matter and
      each answers go or no-go with a reason, the same way permission prompts already read as go/no-go calls to
      the Director. All go: FLIGHT starts the work. Any no-go: a hold, shown on the wall display with the reason,
      until it is cleared or the Director aborts. The pieces are a poll message with a shared tally, a lamp per
      position in the UI, and hold and abort controls. The boss can already poll through the existing messaging;
      the new part is the tally and its display.
- [x] **Max Q: the peak-load moment.** Built as reading (a), the load governor (2026-11-16); reading (b), the stress ritual, is built as **Static fire** (2026-11-18, `docs/static-fire-spec.md`): a T-minus poll with a subject that briefs SIMSUP to break it and RETRO to write the rollback; not run with a real `claude`. In a launch, Max Q is the point of greatest stress, and the engines throttle
      down through it. Two readings, to choose between: (a) a load governor: a limit on how many agents work at
      once, and a throttle that holds new work while too many agents are busy or waiting for the Director;
      (b) a stress ritual: before work ships, SIMSUP tries to break it and RETRO writes the rollback.

## 11. Self-hosted roadmap (decided with the owner, 2026-11-17)

gonogo stays a personal tool: one person per installation, published as open source so that anyone can host
their own. Each person signs in to the agent CLIs with their own account, as today. There are no accounts,
invitations or roles inside one installation. The owner wants everything Munder Difflin offers
(https://munderdiffl.in) except what only makes sense in a desktop app (its floating Stapler assistant), each
feature with a name of its own from the control-room fiction. The names must not clash with a call sign
(CAPCOM, SIMSUP, RSO and BOOSTER are positions) or with T-minus, Max Q, LOS, Loop, Brief or Wall.

Order, one feature per design and commit:

| Name | What it is | Their equivalent |
|---|---|---|
| **Redline** (built 2026-11-17) | Circuit breaker: stops an agent caught in a loop, an error storm or runaway spend | circuit breaker |
| **Propellant** (built 2026-11-17) | Token budgets for the room or per agent, over 5 hours, a day, a week or a month | spend controls |
| **Launch Window** (built 2026-11-17) | Schedules that start work by themselves | 24x7 schedules |
| **Uplink** (built 2026-11-17) | Incoming webhooks that start work | 24x7 webhooks |
| **Flight Plan** (built 2026-11-17) | Task board | Tasks |
| **Downlink** (built 2026-11-17) | Inbox: what the agents send to the Director | Inbox |
| **Mission Log** (built 2026-11-17) | One memory shared by every agent, with search | shared memory |
| **Payload** (built 2026-11-17) | MCP servers and skills chosen per agent | Capabilities |
| **Engine Bay** (built 2026-11-17) | Provider adapter plus the other CLIs (Gemini first, then Codex and the rest) | 12 engines |
| **Relay** (built 2026-11-17) | Slack, GitHub, Linear and Telegram | integrations |
| **Clean Room** (built 2026-11-17) | Optional sandbox: agents work in their own container on a copy of the project | Sandbox Office |
| **Livery** (built 2026-11-17) | Visual themes, and an agent that designs one from a line of text | Simulations |
| **Docking** (built 2026-11-17) | Two installations connect so that their agents can message and hand off work | Team Network |
| **Static fire** (built 2026-11-18) | A T-minus poll with a subject: SIMSUP tries to break it, RETRO writes the rollback | Max Q, reading (b) |
| **Hold** (built 2026-11-18) | Put one agent on hold by hand | pause |
| **Telemetry** (built 2026-11-18) | The tool calls of an agent as a timeline | waterfall |
| **Patch Panel** (built 2026-11-18) | Command bar, Cmd+K or Ctrl+K | command bar |
| **Flight Rules** and **Commissioning** (built 2026-11-18) | Every setting on one screen, and the checklist of an empty room | settings, onboarding |
| **Party Line** (built 2026-11-18) | Messages as conversations | threads |
| **Plot Board** (built 2026-11-18) | The one plan, written by the boss | blackboard |
| **Black Box** (built 2026-11-18) | A git record of the room, committed by the server | audit log |
| **Relief** (built 2026-11-18) | The boss asks to hire; the Director says go | boss hires |
| **Mass Budget** (built 2026-11-18) | Condense an agent's notes | reflection |
| **Star Chart** (built 2026-11-18) | The Mission Log as a graph | knowledge graph |
| **Hangar** and **Recorder** (built 2026-11-18) | Files and git of one agent's folder | file tree, git tab |
| **Clearance**, **Pad Check** and **Rollout** (built 2026-11-18) | Model and keys per agent, the engines found on the machine, the update check | pickers, installer, auto-update |

Also needed for an open-source release, without a name (built 2026-11-17, `docs/release-readiness-spec.md`): a version and
migrations for the saved state, a guide for exposing gonogo behind HTTPS (`docs/https.md`), a short README and a
`CONTRIBUTING.md`. Still open, only when the owner says so: publishing the npm package and the image, and the `repository`,
`author`, `homepage` and `bugs` fields of `package.json`.
