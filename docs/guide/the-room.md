# The room

<MailPointerMock class="doc-mock" />

## The screen

Lights: indigo working, green idle, grey stopped, dashed open seat. Saffron: needs you. Sage: go. Raspberry: no-go or danger. The page loads nothing from another host.

- **The top bar**: the logo, the running version beside it (small, mono; it links to the changelog) and the ROOMS key, which goes to the list of every room, in every room and on a phone. When a newer gonogo is out the version gets an amber `0.5.5 out` next to it, in every room: the update note shows under the bar in every room; its Update key is main's, so in another room the note has OPEN MAIN TO UPDATE, which opens main with its note shown ([Rollout](../features/rollout.md)).
- **The wall** (top): the mission (your last brief to FLIGHT) and its clock, a 10-minute activity chart (saffron where an agent waited for you), the T-minus poll (STANDBY, POLLING, HOLD, NO-GO, GO) and Max Q.
- **The room**: a fixed matrix. The 15 positions keep their cells; agents without a position, a second agent of a position and custom commands take spare cells after them. A tile shows call sign, last tool call, why it waits, state and poll vote. Click an open cell to staff it.
- **Your console** (under the room): a saffron block per agent that needs you, and one per hire request from FLIGHT ([Relief](../features/relief.md)). For a permission prompt, GO and NO-GO press Enter or Escape in that agent's terminal. Then the box to brief FLIGHT.
- **The selected console** (right): state, Start or Restart, Stop, Edit, Remove, the size of its notes with REFLECT ([Mass Budget](../features/mass-budget.md)), [Open files](../features/hangar.md) and [Open git](../features/recorder.md), its live terminal (you can type into it) and its last messages.
- **Top-bar views** (each has a page): [Launch Window](../features/launch-window.md) (schedules, with the [Uplink](../features/uplink.md) and [Docking](../features/docking.md) modules), [Flight Plan](../features/flight-plan.md) (task board; its count is tasks doing or blocked; a card has HAND OFF when a station is docked), [Party Line](../features/party-line.md) (messages grouped into threads, with a reply box; open it from the Patch Panel), [Plot Board](../features/plot-board.md) (the one plan of the room; the boss writes it) and [Black Box](../features/black-box.md) (a git record of what happened; both open from the Patch Panel), [Downlink](../features/downlink.md) (inbox; its count is unread), [Mission Log](../features/mission-log.md) (shared memory, also as a [Star Chart](../features/star-chart.md)), [Livery](../features/livery.md) (the half-filled round key: the look), [Patch Panel](../features/patch-panel.md) (Cmd+K or Ctrl+K, the round key of nine dots: jump to any console, view or action by typing) and [Flight Rules](../features/flight-rules.md) (the round key of three sliders: every setting on one screen, plus Commissioning, the checklist of an empty room).
- **Comms** (COMMS button): the INBOX tab is what needs you, the TRAFFIC tab is every message, newest first, with filters (to you, held, undelivered) and an agent picker, and the THREADS tab is the same messages as conversations. Answer messages to you in place. See [Comms](../features/comms.md).
- **On a phone** (under 700 px): one column with the wall, the saffron blocks and a three-column matrix, and a bottom bar ROOM, COMMS, BRIEF, LAUNCH, PLAN, LOG, PATCH. A console opens full screen with keys (esc, tab, arrows, ^C, enter); a permission prompt opens full screen with big GO and NO-GO keys.

## Agents and messages

1. Each agent has its own settings, memory file and token, and talks through the tools of an MCP server named `gonogo`: `send_message`, `list_roster`, `read_messages`, `go_nogo` (T-minus vote), `task_list`, `task_create`, `task_update` (Flight Plan), `mission_list`, `mission_create` and `mission_update` (the last two boss only, [Missions](../features/missions.md)), `log_write`, `log_search`, `log_read` ([Mission Log](../features/mission-log.md)), `board_read` and `board_write` (boss only, [Plot Board](../features/plot-board.md)), `livery_submit` ([Livery](../features/livery.md)), `review_read` and `review_note` ([Post-Flight Review](../features/review.md)), `hire_agent` (FLIGHT only, [Relief](../features/relief.md)). The server stamps the sender; an agent cannot impersonate another.
2. A message body (at most 20000 characters) never goes through a terminal. Only a one-line pointer is typed or handed over, e.g. `gonogo: 2 new messages from ana, user. Call read_messages.`, and the agent reads the bodies with `read_messages`.
3. State (starting, idle, working, needs you, stopped) comes from Claude Code's hooks, the window title and the screen. The pointer is typed only into an idle agent showing its input box, with no dialog and no text you typed. A working agent gets it when its turn ends; an agent that needs you waits. A message to a stopped agent is not queued: it comes back to you as undelivered.
4. Hold rules. Unsubmitted text you typed in an agent's terminal holds its mail (`held: text in ana's input`) until you press Enter or Ctrl-C there, the box has been empty for a second, or 30 minutes pass. A pointer Claude Code does not confirm within 2 seconds is held, and not typed again until you press Enter or Ctrl-C in that terminal.
5. Loop guard. Your message is hop 0; a message an agent sends while working on mail is one more than that mail's highest hop (1 otherwise). Past the cap, 8 by default, it goes to you instead.

Queues are in memory: after a restart every agent is stopped except the boss, which is started again, and unread mail shows as undelivered. A Flight Rules setting can start the consoles that were running again too ([Start again after a restart](../features/autostart.md)).

## FLIGHT, the boss

The first start creates an agent named `flight` in the directory gonogo was started from and saves it in `agents.json`; later starts keep it wherever you start from. It cannot be removed, can be edited, and starts with the server every time, in `default` mode.

- If that directory is your home directory, Claude Code asks the folder trust question on every start: answer it in the boss's terminal, or Edit the boss to a project folder and restart it. In seed mode (the Docker image) a boss in your home directory does not start at all (see [Security](../reference/security.md)).
- It can ask you for more hands with `hire_agent`; nothing is hired until you press GO ([Relief](../features/relief.md)).
- On a host machine gonogo writes none of your Claude files. A startup dialog (folder trust, the bypass-permissions warning) is yours to answer in the agent's terminal; until then the agent is "needs you" and gets no mail.

## Positions, T-minus, Max Q and custom agents

- **Positions.** The hire form offers 15 positions (FLIGHT, FAO, FIDO, GUIDO, CONTROL, DPS, INCO, EECOM, BOOSTER, SURGEON, SIMSUP, RETRO, RSO, PAO, CAPCOM). A position fills the name and a role text (both editable) and sets the accent colour. They are presets, not seats: a position that is taken fills the next free name (`guido-2`, `guido-3`), and two agents may share one if their names differ. List: `src/shared/positions.ts`.
- **T-minus poll.** Start it from the wall: it polls all running agents with the gonogo tools except FLIGHT (the REST route also takes a list of names). Each gets `T-minus: go/no-go poll` and answers with `go_nogo` (`go` or `no-go` plus a one-sentence reason).
  - The first no-go holds the poll; the wall shows who and why. If that agent changes to go and everyone else is go, it reads GO.
  - All go: FLIGHT is told `T-minus: all go`.
  - You can hold (stays until cleared), abort (agents are told to stand by) and clear.
  - A stopped agent counts as no-go. One poll at a time; not saved, a restart clears it.
- **Static fire.** Under the T-minus keys, type what to test and press STATIC FIRE: running SIMSUP agents try to break it, running RETRO agents write the rollback plan, and their answers come back as the tally and in the Downlink. See [Static fire](../features/static-fire.md).
- **Max Q.** Limits how many agents with hooks (Claude Code, Gemini CLI) may be `working` at once. Set it on the wall or with `GONOGO_MAX_WORKING`. At the limit, a message from one agent to an idle agent waits (`waiting: load limit (N of M agents working)`) until a working agent finishes. Your messages and polls never wait; a working agent still gets mail when its turn ends. Custom agents and engines without hooks take no slot.
- **Custom agents.** Provider "Custom" runs any command (words separated by spaces, or a JSON array of strings, up to 1000 characters; no shell, so quote with the array form) in the agent's directory and terminal. Same environment scrubbing, but no token, no hooks, no `gonogo` tools: messages to it come back undelivered, it shows `working` while it prints and `idle` when quiet, and it never takes part in a poll. The form hides position and permission mode. A command that cannot be read (bad JSON, empty, a NUL character) is refused at hire and edit.

Guard rails: [Redline](../features/redline.md) stops an agent that loops or storms; [Propellant](../features/propellant.md) sets token budgets, and [Cost](../features/cost.md) prices them.
