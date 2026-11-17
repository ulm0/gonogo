# Theme options

Written 2026-11-16. gonogo looks like a generic office today, and the project that inspired it is a parody of a TV office. This file records a research pass on a theme of its own: which fictions other agent tools already use, five finalists, and five runners-up. Nothing here is built.

**Outcome:** the owner liked none of the five finalists below and chose mission control instead, one of the three earlier proposals, with a roster of 15 flight-control positions. That plan is section 10 of `docs/backlog.md`. This file stays as the record of what else was considered and of which themes other tools already use.

How it was made: one researcher searched the web for the themes of existing tools, four brainstormers produced 24 concepts through different lenses (places of work, living systems and science, play and fiction, sound and machines), and one judge scored them and checked the finalists for collisions. Three earlier proposals had already been passed over and were excluded: a bee colony, a restaurant kitchen and mission control.

What a theme may change: the floor art, the avatar, a handful of nouns, the palette and perhaps the product name. The mechanics stay: one boss, up to 24 agents at fixed spots, five states readable by shape, messages that travel visibly, one spot for the human, procedural drawing only.

The hour figures are the judge's estimates for a human developer and were not checked against a real build.

## Themes already in use

| Tool | Theme | Draws a world | Source |
|---|---|---|---|
| Munder Difflin | Parody of a TV paper-company office | Yes | https://cdn.jsdelivr.net/gh/chaitanyagiri/munder-difflin@main/README.md |
| Pixel Agents | Generic pixel office | Yes | https://github.com/pablodelucca/pixel-agents |
| pixtuoid | Cozy pixel office in the terminal | Yes | https://cdn.jsdelivr.net/gh/ivanwng97/pixtuoid@main/README.md |
| Claude Office Visualizer | Pixel office with a boss and employees | Yes | https://cdn.jsdelivr.net/gh/paulrobello/claude-office@main/README.md |
| Star Office UI | Pixel office where state picks the room | Yes | https://raw.githubusercontent.com/ringhyacinth/Star-Office-UI/master/README.en.md |
| codemap | Pixel hotel = the codebase | Yes | https://blog.brightcoding.dev/2026/10/11/jamsusmaximuscodemap-real-time-pixel-art-agent-visualization |
| Claude Town | Old-western frontier town | Yes | https://github.com/yazinsai/town |
| Agentis | Archipelago world = the repos | Yes | https://github.com/gpu-cli/agentis |
| AI Town (and the Stanford generative-agents 'Smallville' it derives from) | Small RPG town where characters live and chat | Yes | https://github.com/a16z-infra/ai-town |
| Claude Dungeon | Fantasy dungeon | Yes | https://dev.to/thousandsky2024/claude-dungeon-a-visual-interface-for-your-claude-code-agents-kl0 |
| muninn-party | JRPG party at a campsite | Partly | https://ai-muninn.com/en/blog/claude-code-mods-jrpg-party |
| AgentCraft | Real-time strategy game | Yes | https://www.ai.engineer/talks/kR64LOqBBCU-agentcraft-putting-orc-in-agent-orchestration |
| Tide Commander | RTS battlefield / command centre | Yes | https://dev.to/deivid11/command-center-for-ai-coding-agents-claude-code-codex-3d5g |
| Vibecraft | 3D workshop with tool stations | Yes | https://starlog.pages.dev/articles/developer-tools/nearcyan-vibecraft |
| Gas Town | A rough frontier 'town' of roles (mayor, convoys, refinery) | No | https://github.com/gastownhall/gastown |
| Ruflo (formerly claude-flow) | Collective mind / swarm, plus 'nervous system' and control-room wording | No world | https://github.com/ruvnet/claude-flow |
| Paperclip | A company with an org chart | No | https://github.com/paperclipai/paperclip |
| MetaGPT (ChatDev 1.0 uses the same fiction) | Virtual software company | No drawn world on the pages read (ChatDev 2 | https://github.com/geekan/MetaGPT |
| herdr | A herd of agents; fiction comes from user-made layouts | Core app: no | https://herdr.dev/layouts |
| Agent Standup | Live video-call team standup | Partly | https://www.everydev.ai/tools/agent-standup/llms.txt |

**Crowded:**

- Office / company: pixel office floors with desks and a boss (Munder Difflin, Pixel Agents, pixtuoid, Claude Office Visualizer, Star Office UI, OpenCode Visualizer, pixelagents) and company fictions with CEO, employees, hiring (Paperclip, MetaGPT, ChatDev). The single most used theme.
- Town / settlement / map of buildings: Gas Town, Claude Town (western), AI Town and Smallville, Moltcraft (isometric town), Agentis (islands, districts), codemap (hotel).
- Fantasy and strategy games: dungeon with knights (Claude Dungeon), JRPG party (muninn-party), RTS units, quests and campaigns (AgentCraft, Tide Commander).
- Command centre / sci-fi console: 'Command Center' (Munder Difflin, Tide Commander), 'Mission control' and 'cockpit' (Ruflo), 'developer control center' (OpenHands), and herdr layouts LCARS, Expanse Flight Deck, Evangelion, Fallout. Mission control was already passed over; this confirms it is crowded.
- Animal collectives: swarm and queen (Ruflo), herd and zoo (herdr). A bee colony was already passed over.
- Orchestra as a product name only: Conductor (verified, no fiction behind the name); Maestro and Symphony appeared in search results but their pages were not opened.

**Open (nobody found using them):**

- Music as a drawn place: recording studio, mixing desk with channel strips, live stage or rehearsal room. One search found no coding-agent tool using it. Nearest neighbours are orchestra-flavoured product names and one herdr layout ('Daft': robots with an equalizer).
- Post or sorting office, telegraph or telephone exchange: fits the mail mechanic directly. Search for 'post office' found nothing; exchanges were not searched.
- Railway: signal box, yard, station platforms. Search found nothing confirmed (one tool, 'The Agents', uses the word 'stations' but its page returned 403, so unconfirmed).
- Sea and coast: harbour, lighthouse, ship crew, submarine. Searches found nothing.
- Observatory / astronomy as a place (domes, telescopes), as opposed to a control-room console. Search found nothing; only a herdr layout named 'Orrery' (name only).
- Growing things: garden, greenhouse, farm, aquarium. Searches found nothing. (Overstory's sibling tools are named canopy, mulch, seeds, sapling, but no fiction or art is built on them.)
- Craft workshop at trade scale: forge, print shop, loom. Search for forge found nothing; Vibecraft's generic 3D 'workshop' is the only neighbour.
- Space station or ship as a lived-in place with a crew, rather than a console skin. Search found only console layouts.

## The five finalists

### 1. Night branch line (railway halts and a signal box)

A small railway at night: one halt per agent with a keeper and a semaphore signal, a signal box that runs the line, and a lamp-lit mail trolley rolling along the track between them. It is the one world where every mechanic already exists in the real thing: fixed stops, one controller, shape-coded signals, wagons that queue on a siding and can be held.

- **Floor:** Keep the 4-column grid of 168 x 150 cells. Each row is one track across the bottom third of its cells (two 1 px rails, sleeper ticks every 8 px); a trunk line runs down the 24 px left margin and joins the rows through simple points. Each cell is a halt: platform slab (about 120 x 12), small shelter with one window at the left, nameboard with the agent name, a signal post at the right edge, and a short siding stub under the platform. Empty cell: bare track, dashed platform outline and a plus, label 'empty halt'. The header strip carries the main line to the terminus at the right. Faint seeded stars; nothing else moves.
- **Boss:** The signalman in the signal box, in cell 0 at the junction of trunk and row one (same cell size, no double width, so the cell mapping is untouched): a two-storey cabin whose lit upper window shows five lever lines and the boss avatar. Always lit. 'Brief the box'.
- **Agents:** Halt keepers: the existing 12 x 14 figure with a cap row added and the lower rows redrawn as coat and boots (the desk no longer hides rows 10 to 13). Skin, hair and coat colour come from the same seed as today; the shelter roof repeats the coat colour so a halt is recognisable even with no keeper. The signal beside the keeper is the main state carrier.
- **The human:** The terminus, in the header at top right where the mailbox is today: a buffer stop, a small station front with a clock circle and a round sign showing the unread count. Trolleys for the human stop at the buffers; the human's messages depart from there.
- **Messages:** A mail trolley: 10 x 6 rectangle, two wheel circles, one lamp pixel at the front. It follows the track: sender's row, trunk, recipient's row (same row: straight along). Duration scales with distance, capped near 2 s. Unread mail is wagons parked on the halt's siding (draw up to 3, then the count on a round sign). Held mail: a stop board (red bar on a post) across the siding exit, plus today's pause bars. Reduced motion keeps today's cell flash.
- **States:**
  - Starting: Signal arm sweeps slowly between level and raised with a blinking amber lamp; the shelter window lights and the keeper walks out.
  - Working: Arm raised 45 degrees, steady lamp, two or three smoke puffs from the shelter chimney, keeper working a lever in two frames.
  - Idle: Arm lowered 45 degrees, dim lamp, keeper sitting on a bench (shorter silhouette), no smoke.
  - Needs you: Arm dead level, two alternating crossing lamps beside the post, keeper swinging a lantern overhead. A level arm is the real 'stop' aspect, and it is the only state with a raised hand and paired lamps.
  - Stopped: An X across the arm (how out-of-use signals are marked), lamp off, shelter dark, no keeper, cell at reduced brightness.
- **Palette:** Night ground #12161C, rail and steel #8A94A3, lamp amber #FFB000, signal green #3DDC84, signal red #FF4D4D, window light #FFD9A0, parcel cream #E6DCC3.
- **Name ideas:** Ramal, Branchline, Apeadero
- **Why it made the list:** Highest mechanics fit of all 24: boss, fixed spots, shape-coded states, routed mail, queue and hold are real railway things, not inventions, and it strengthens the mail mechanic that the landscape shows is this app's own ground. 'Branch' is already a developer word and 'ramal' is a familiar word in Chile without quoting any real line.
- **Risks:** Most expensive finalist: trolleys need waypoint routing instead of today's arc, so flights are longer and need speed scaling. The semaphore arm is small; draw it at least 22 x 6 with an outline and back it with the whole halt's lighting, or it will not read across the room. Keepers standing on platforms are less lively than people at work. Model-railway nostalgia is a narrower taste, and enthusiasts will notice wrong aspects, so the legend must state the meanings. Red/green lamps must never be the only cue.
- **Collisions found:** No drawn railway floor for coding agents found. Neighbours by metaphor only: a hackathon project named Signalbox coordinates parallel coding subagents with 'railway interlocking' (blocks, signals), no visual floor; AgentRail is a control-plane name; Railway is a well-known hosting company, so avoid 'rail' in the name. Names: 'Ramal' returned no developer tool (near-homograph of the RAML API language and its 'raml' npm package); 'Branchline' returned only a removed browser extension for AI code review plus unrelated branch linters; 'Signalbox' is taken (see above), dropped. 'Apeadero' (Spanish for halt) was not searched. Registries (npm, GitHub org, domains) not checked directly.
- **Effort:** 24 to 34 hours. Driven by replacing the Bezier flight with track routing (pure path helper plus its tests), new halt, semaphore, siding and signal-box drawing with five state renders, the avatar change (cap, legs), then strings, CSS tokens, contract section 8.3 and rewriting the geometry parts of the 571-line floor test. Grid, hit testing, accessible list and announcer stay.

### 2. Prompt corner (theatre in technical rehearsal)

A dark stage seen from the stalls: each agent holds a taped mark under its own lantern, the stage manager calls the show from a lamp-lit desk in the wings, and paper notes fly between them. The dark UI is already a dark stage, the stage manager's real post is the prompt corner with the prompt book, and a stuck player really does call 'Line!'.

- **Floor:** Keep the grid. Plank lines every 10 px replace the 24 px grid lines; narrow curtain strips stand in the left and right margins; a row of footlight dots runs along the bottom edge. Each cell is a mark: a taped cross on the boards, a lantern rectangle at the top of the cell and a pool of light under it, a small callboard at the foot with the name card. Empty cell: the taped cross and a plus, label 'open mark'.
- **Boss:** The stage manager at the prompt corner, cell 0, half behind the wing curtain: today's wider boss desk becomes the prompt desk with a blue-shaded lamp, an open prompt book (two pale rectangles) and a headset arc on the avatar. Always lit. 'Brief the stage manager'.
- **Agents:** Players: the existing avatar and seed colours, with the lower rows redrawn as legs since no desk hides them; one small prop cluster per agent from the seed (hat, apron line, tool). The role text reads naturally as the part they play.
- **The human:** 'The house': the director's production table with one small lamp, kept in the header at top right where the mailbox is (a bottom-centre stalls row would need a new layout). Notes for the human land on the table with the count; the human's notes fly up from it.
- **Messages:** A folded note (8 x 6 pale slip, one fold line) flying today's arc unchanged. Unread notes are slips pinned to the mark's callboard (up to 3, then the count). Held: a clip bar across the top of the callboard plus today's pause bars.
- **States:**
  - Starting: Player half hidden behind a curtain strip at the cell edge while the pool grows from a dot to full size.
  - Working: Lantern on, two cone lines down to a full bright pool, player gesturing in a two-frame loop.
  - Idle: Lantern off, only a thin ring outline of the pool, player still in a cooler dimmer tint.
  - Needs you: A tight amber spot pulsing slowly, one arm raised, and a small sign above the head reading 'Line!' on the triangle badge. Only state with a raised arm and a sign.
  - Stopped: A closed curtain (striped rectangle) across the cell with a ghost light in front (a stand line and one bare bulb circle); no player.
- **Palette:** Stage black #14121A, plank line #201C28, spotlight warm #FFD27A, curtain red #B3273A (thin strips only), prompt-desk blue #5BA8FF, paper #EDE6D6.
- **Name ideas:** Tramoya, Prompt Corner, Callboard
- **Why it made the list:** Best ratio of identity to cost: the arc flight, the avatars, the boss desk and the grid all survive, and state is carried by the largest shape on the floor (cone, ring, tight spot, curtain across the whole cell). The fiction also gives the cleanest human role: a director outside the action who gives notes through the stage manager.
- **Risks:** Mail is only a re-dressed envelope, so it adds nothing to the app's signature mechanic. Up to 24 players frozen on a grid is not how a stage looks; framing it as a technical rehearsal helps but does not remove it. 'Stage' and 'staging' already mean something to developers, so no label may use them. Curtains and spotlights tip into kitsch quickly: thin curtains, no masks, slow low-contrast pulses. 'Prompt Corner' may read as a prompt-engineering tool; 'tramoya' also means a scheme or trick in colloquial Spanish.
- **Collisions found:** No theatre-themed agent floor found. One write-up uses theatre as a metaphor for an agent setup (script, actors) with no visual; the landscape's 'claude-theater' is an office view despite its name (unverified). Names: 'Callboard' is used by stage-management products (Callboard and Co, VirtualCallboard) and by an agent inside a task-app template, none are developer tools; 'Prompt Corner' and 'Tramoya' returned nothing relevant. Registries not checked directly.
- **Effort:** 14 to 20 hours. Driven by five new cell drawings (mark, lantern, pool, curtain, callboard), the state renders, the avatar legs and prop, the header spot, then strings, tokens, contract 8.3 and test updates. No flight or layout change.

### 3. Night camp (expedition bivouac)

A mountain clearing at night with one tent and one fire per agent; the size of each fire tells you what that agent is doing, and a small lantern-light carries notes from fire to fire. One physical variable, fire size, plus posture covers all five states, and warm light on a dark ground is easy to leave open all day.

- **Floor:** Keep the grid. Near-black blue ground, a ridge silhouette and a few seeded stars in the header. Each cell is a campsite: tent at the back (stacked rectangles, 48 px wide, striped in the agent's colour), a ring of six stones with the fire in front, the figure beside it, the name on a stake sign. A low-alpha light circle under each site, radius by state. Empty cell: a bare stone ring and a plus, label 'empty site'. Trodden paths are static decoration only.
- **Boss:** The lead, cell 0 (single width): a larger tent with a pennant on a pole, and today's wider boss desk redrawn as a map table with a few route lines. 'Brief the lead'.
- **Agents:** Climbers: the existing figure in a hooded parka with boots (lower rows redrawn), differing by parka colour, hood trim and one piece of kit on the back (pack, rope coil, axe, lantern) from the seed.
- **The human:** The trailhead: a signpost with a hanging lantern in the header at top right. Notes for the human arrive there, the lantern lights and the count sits on the sign.
- **Messages:** A glowing dot carrying a folded cream note, travelling a straight low arc from fire to fire (today's Bezier with the lift cut from 40 px to about 12, so no path routing). Unread notes are cream tags tied to the stake sign with the count. Held: a pin bar through the tag plus today's pause bars.
- **States:**
  - Starting: Figure kneeling at the stone ring, two or three sparks jumping, no flame yet, tent flap opening.
  - Working: Tall flame (three flickering rectangles, about 14 px), a thin smoke column, figure standing and moving its arms, light circle at full radius.
  - Idle: Low embers that pulse slowly, no smoke, figure sitting on a log (shorter silhouette), small light circle.
  - Needs you: Figure facing the viewer with a lantern raised, a triangle signal flag up on the tent pole and a 2 px beam of light rising about 30 px from the site: the only state with anything above the tent line.
  - Stopped: Fire out (grey ash ring), no light circle, tent flap closed with a small square tag on it, no figure. Zipped up for the night, not abandoned.
- **Palette:** Ground #0F1420, ridge and tent shadow #1B2333, fire #FF9A3C, ember #B5532A, beam and flag #FFE27A, note cream #E8DCC0, ash #4A5060.
- **Name ideas:** Cordada, Vivac, Fogata
- **Why it made the list:** The most glanceable finalist and the calmest for hours: fire size and the light circle read from across a room without colour, and nothing in it needs routing or a new layout. 'Cordada' (a roped team) is an unusually apt name for agents tied to one lead.
- **Risks:** Lowest identity of the five: a camp is a familiar cosy-game picture and one existing tool already shows a single pixel campsite. Fire orange (working) and beam yellow (needs you) are close in hue, so the beam, flag and raised arm must carry it. Flicker on many fires needs a low frame rate, and idle and stopped sites must not animate. A climbing team implies a shared summit the product does not track. The names are opaque to English speakers.
- **Collisions found:** muninn-party (in the landscape) draws one pixel campsite behind a JRPG party with levels and XP: same picture, different fiction and no floor of sites. No other camp-themed agent tool found. 'Basecamp' and 'Campfire' are well-known products and must be avoided. 'Vivac', 'Cordada' and 'Fogata' returned no developer tool in one search; registries not checked directly.
- **Effort:** 14 to 20 hours. Driven by the site drawing (tent, stones, fire, light circle), five state renders with flame and smoke animation under the existing 30 fps ticker, the avatar redraw (hood, boots, kit, kneel and sit poses), the header spot, then strings, tokens, contract 8.3 and tests. The flight changes by one constant.

### 4. Modular rack (patch cables and scopes)

A rack of synth-style modules, one per agent, each with a tiny scope screen, a lamp and jacks; a message is a patch cable that appears between two modules with a pulse of light running down it. A scope is an instrument built to show state by shape, and a rack is something its user may already enjoy staring at for hours.

- **Floor:** Keep the grid, read as rack rows: a thin rail with screw circles above and below each row. Each cell is a 150 x 126 panel: scope screen at the top (about 64 x 28), a pale tape-style label strip with the name, one state lamp, two or three knobs, and a bottom row with IN jack left, OUT jack right and a six-step LED strip. Empty cell: a blank plate with four corner screws and a plus, label 'empty slot'.
- **Boss:** The master module, cell 0 (kept single width, not the brainstormer's double width, so the cell mapping is untouched): a larger scope, a row of eight step lamps that chase while it works, and a ringed BRIEF jack on its left edge. 'Brief the master'.
- **Agents:** No figures: the module is the agent. They differ by a 4 px colour stripe (the hue the avatar torso uses today), by knob layout (three layouts) and by their own waveform on the scope (sine, triangle, square, saw) from the seed. The scope and lamp take the place of the avatar as the focal point.
- **The human:** 'The output', in the header at top right: a jack, a small speaker grille (3 x 3 circles) and a five-segment level meter that lights one segment per unread message, with the count.
- **Messages:** A patch cable drawn from the sender's OUT to the receiver's IN in the sender's stripe colour, sagging (today's quadratic Bezier with the control point pushed down instead of up), with a bright 6 px dot travelling along it once; the cable fades after about 2 s. Unread: one LED step per waiting message, a number past six. Held: a square MUTE button lights and the lit steps dim.
- **States:**
  - Starting: Scope shows a rising ramp that resets; the lamp is a hollow ring filling clockwise.
  - Working: Scope scrolls the module's own waveform at a low frame rate; one knob pointer rocks slowly; lamp half filled.
  - Idle: Scope shows a flat line with one slow blip every few seconds; steady filled lamp; nothing else moves.
  - Needs you: Scope shows a tall square pulse flashing slowly, the lamp becomes a blinking triangle and a large round button on the panel glows: the obvious thing to press.
  - Stopped: Scope dark, lamp a small empty square, power toggle drawn down, stripe desaturated.
- **Palette:** Background #12151B, panel #262B36, label strip #CFD3DA, scope trace #5FE0A0, cable and working amber #F0B33C, needs-you red #EF5350, eight stripe hues at equal lightness.
- **Name ideas:** Rackhand, Patchbay, Signal Path
- **Why it made the list:** The most distinctive picture of the five and all rectangles, circles and lines by nature; the patch cable is a stronger message image than a re-dressed envelope and reuses the existing curve math. This is the one place a music background makes a concept better rather than decorated.
- **Risks:** No people on the floor: agents are told apart by stripe, waveform and label only, which is weaker at a glance than avatars and colder than the office. A first-time visitor may take it for music software. 'Needs you' has no real modular equivalent, so the big button is invented. Many scopes animating is noisy: only working modules may move, at about 10 fps. Panels must not resemble any real maker's module layout. It leans on a hobby the brief said not to force.
- **Collisions found:** No coding-agent tool with a rack or patch-cable floor found. Neighbours: an open-source project where LLM agents are wired to synth modules to make music (the reverse relation), one community layout with robots and an equalizer (in the landscape), and a 'modular-patchbay' studio app on npm whose purpose I could not confirm. Names: 'Patchwork' is taken by a known agentic workflow CLI and is dropped; 'Patchbay' has that neighbour and is a common audio term; 'Rackhand' returned nothing; 'Signal Path' was not searched. Registries not checked directly.
- **Effort:** 18 to 26 hours. Driven by replacing the avatar with a module panel (new pure helpers and tests in place of the avatar-parts ones), scope rendering for five states, the cable-plus-pulse flight with fade, LED queue and mute, then strings, tokens, contract 8.3 and tests. Grid and layout stay.

### 5. Antenna array on a high desert plateau

A night plateau under a slow starfield with one small dish antenna per agent, all reporting to a correlator hut; each dish's posture tells you its state. Many dishes acting as one instrument is literally what an agent team is, and it is the theme with the cleanest five silhouettes.

- **Floor:** Keep the grid. Dark ground, a mountain polyline and about forty seeded stars in the header (three twinkle). Each cell is a concrete pad with a stencilled pad number and one dish; name and state text below as today. Empty cell: a dashed pad outline and a plus, label 'empty pad'.
- **Boss:** The correlator, cell 0: a low hut with a row of five small lights and a slightly larger dish on its roof, star by its name. 'Brief the core'.
- **Agents:** A dish per agent, drawn as vector shapes rather than on the pixel grid: pedestal, base, half-circle bowl, feed strut and receiver dot. They differ by bowl rim colour (eight hues), pedestal style (solid, lattice, twin legs), a two-letter stencil on the pad and a beacon colour, all from the seed.
- **The human:** 'The lodge' (taken from the observatory concept): a low hut with one warm window and a short mast, in the header at top right. Its mast light turns on and shows the count when messages arrive.
- **Messages:** A signal blip: a bright 4 px dot with a three-step fading tail, arcing through the sky from dish to dish on today's Bezier (replacing the brainstormer's buried-cable routing, which costs more and is no more truthful). Unread: stacked buffer bars beside the pedestal plus the count. Held: the bars in outline with a pause mark.
- **States:**
  - Starting: Dish slewing from stowed to pointing in three discrete steps, base beacon blinking.
  - Working: Bowl tilted about 45 degrees at the sky, three small arcs animating into it, receiver dot lit.
  - Idle: Bowl stowed pointing straight up (a symmetric cup), steady beacon, no arcs.
  - Needs you: Dish turned to face the viewer: the bowl becomes a full circle with a centre dot, a triangle beacon flashes on the pedestal and the pad outline lights. The only state with a full circle.
  - Stopped: Bowl tipped face down in maintenance stow, no lights, half alpha, a small square on the pad.
- **Palette:** Night ground #12161F, pad and structure #8B93A7, signal cyan #5FD4E6, amber #F2B84B, alert red #FF6B6B, idle green #6FD39A, lodge window #FFD9A0.
- **Name ideas:** Dishfield, Plateau, Baseline
- **Why it made the list:** Five states by silhouette alone (tilted, cup, full circle, face down, stepping) is the best shape set of any concept, and the setting is local without naming a real site. It is a place with weather and stars, not a console.
- **Risks:** Nearest of the five to the mission-control idea the owner already passed over: instruments and telemetry, even without consoles or a flight director. No people, so it can read cold and sparse. Real dishes do not message each other and never 'face the viewer', so peer mail and needs-you are liberties. Half-circle rotation is jagged at pixel scale, which is why the dish must be vector. It must not echo the look or name of any real observatory.
- **Collisions found:** No agent tool with an array or observatory floor found; the search returned only news of AI agents steering a real radio array, and the landscape lists one community layout named 'Orrery' (name only). Names: 'Dishfield' returned nothing; 'Baseline' and 'Plateau' are common words already used by well-known products and were not searched individually, so treat both as weak; an npm package '@mneme-ai/correlator' exists, so avoid 'Correlator' as a name. Registries not checked directly.
- **Effort:** 18 to 26 hours. Driven by replacing the avatar with a vector dish in five poses (new pure helpers and tests), the hut, pad and starfield drawing, the arc animation for working, then strings, tokens, contract 8.3 and tests. Grid and arc flight stay.

## Runners-up

- **Pneumatic tube exchange (merged with the press room):** Clerks at tube stations with capsules shooting through pipes: the best mail fiction of all 24, but it is still people at counters indoors (the least distance from the office), the tubes say nothing about working versus idle, and it needs the same routing work as the railway.
- **Night quay (harbour berths):** Boats at berths, a harbour master's tower and a launch crossing open water in a straight line: cheap to route and local to Chile, but nautical names are a worn developer cliche and a boat that works while moored is odd.
- **Telephone exchange:** Phones on lines to a central switchboard: it owns the words hold, waiting and ringing, but 'off the hook' means talking not working, every message would appear to pass through the boss, and the radial layout abandons the grid.
- **Mycelium under a forest floor:** Glowing mushrooms joined by threads to one old tree: the most honest peer-to-peer network and a charming 'hire', but working and idle differ only by motion, needs-you is a bolted-on overlay and the look is close to fantasy games.
- **Machine room (mainframe era):** Cabinets with tape reels, an operator's console and card decks on a conveyor: developers read spinning reels as busy at once, but it is a retro-computing costume next door to the command-centre crowd and has nobody to like on the floor.

## The judge's recommendation

I would build the night branch line, under the name Ramal: it is the only world where the boss, fixed spots, shape-coded states, routed mail, the queue and the hold are all real things rather than inventions, and it deepens the visible-mail mechanic that no other tool has. Its cost is real (24 to 34 hours against 14 to 20, almost all of it track routing and a semaphore that must be drawn large enough to read), and its charm depends on keeping it sparse and nocturnal rather than quaint. If that budget is too much, build the prompt corner instead: it keeps the avatars, the arc flight and the grid, and gets most of the identity for about half the work.
