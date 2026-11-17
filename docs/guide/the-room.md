# The room

## The screen

The look is a piece of hardware: modules on a warm grey body, keys, small status lights and dark screens. A console's light is indigo while it works, green when idle and grey when stopped; a dashed console is an open seat. Saffron means an agent needs you, sage is go, raspberry is no-go or danger. The fonts are bundled; the page asks no other host for anything.

- **The wall**, across the top: the mission (your last brief to FLIGHT) with a clock that counts up from it, a sequence chart (who worked when in the last 10 minutes, taller saffron where an agent waited for you), the T-minus poll as one giant word (STANDBY, POLLING, HOLD, NO-GO, GO; a finished poll tints its block) and Max Q.
- **The room**: a fixed matrix. The 15 positions always sit in the same cells; agents without a position, a second agent of a position and custom commands take spare cells after them. A console tile shows the call sign, the last tool call, why it waits, the state with its time, and its vote during a poll. An open cell staffs that position.
- **Your console**, under the room: a saffron block for every agent that needs you. For a permission prompt it has GO and NO-GO, which press Enter or Escape in that agent's terminal for you. Then the box to brief FLIGHT.
- **The selected console**, on the right: its state, Start or Restart, Stop, Edit and Remove, its live terminal, which you can type into, and its last messages.
, see [](../features/launch-window.md).
- **Uplink** (the UPLINK module under the schedules in the Launch Window view): webhooks that start work, see [Uplink](../features/uplink.md).
- **Docking** (the DOCKING module at the foot of the Launch Window view, under UPLINK and RELAY): stations connected to this one, see [Docking](../features/docking.md). A card of the Flight Plan has HAND OFF when a station is docked.
, see [](../features/flight-plan.md). A small count on the button is the number of tasks that are doing or blocked.
- **Downlink** (the DOWNLINK button; DOWN in the phone bar): your inbox, see [Downlink](../features/downlink.md). A small count on the button is what you have not read.
, see [](../features/mission-log.md).
- **Livery** (the half-filled round key of the top bar, named Livery for a screen reader; on a phone it sits in the top bar, not in the bottom bar): the look of gonogo, see [Livery](../features/livery.md).
- **The comm loop** (the LOOP button): every message, newest first, with filters (to you, held, undelivered); a message opens in place and one addressed to you can be answered there.
- **On a phone** (under 700 px): one column with the wall, the saffron blocks and the matrix in three columns, and a bottom bar ROOM, LOOP, BRIEF, DOWN, LAUNCH, PLAN, LOG. A console opens full screen with a row of keys (esc, tab, arrows, ^C, enter); a permission prompt opens as a full screen with big GO and NO-GO keys.

## Agents and messages

1. Each agent has its own settings, its own memory file and its own token. It talks to the others with ten tools of an MCP server named `gonogo`: `send_message`, `list_roster`, `read_messages`, `go_nogo` (the vote in a T-minus poll), `task_list`, `task_create` and `task_update` (the Flight Plan) and `log_write`, `log_search` and `log_read` (the [Mission Log](../features/mission-log.md)). Its own `memory.md` stays as it is. The server stamps the sender, so an agent cannot write as someone else.
2. A message body (at most 20000 characters) never goes through a terminal. When mail is waiting, the server types or hands over only a one-line pointer, for example `gonogo: 2 new messages from ana, user. Call read_messages.`, and the agent reads the bodies with `read_messages`.
3. State comes from Claude Code's hooks, the window title and the screen: starting, idle, working, needs you, stopped. The pointer is typed only into an idle agent that shows its input box, no dialog and no text you typed. A working agent gets it when its turn ends. An agent that needs you waits. A message to a stopped agent is not queued: it comes back to you as undelivered.
4. Hold rules. Text you typed into an agent's terminal and did not submit holds its mail (`held: text in ana's input`) until you press Enter or Ctrl-C there, the box has been empty for a second, or 30 minutes pass. A pointer that Claude Code does not confirm within 2 seconds is held and not typed again until you press Enter or Ctrl-C in that terminal.
5. Loop guard. The server counts hops: your message is 0, and a message an agent sends while it works on mail is one more than the highest hop of that mail (1 when it is not working on mail). Past the cap, 8 by default, the message goes to you instead of the agent.

Queues live in memory. After gonogo restarts every agent is stopped, except the boss, which is started again, and mail that was not read shows as undelivered.

## FLIGHT, the boss

The first start creates an agent named `flight` in the directory gonogo was started from and stores that directory in `agents.json`; every later start keeps it, wherever you start gonogo from. It cannot be removed, it can be edited, and the server starts it every time it starts, in `default` mode. If that directory is your home directory, Claude Code asks the folder trust question on every start (it never remembers trust for the home directory): answer it in the boss's terminal, or use Edit to give the boss a project folder and restart it. In seed mode (the Docker image) a boss in your home directory does not start at all (see [Security](../reference/security.md)).

On a host machine gonogo itself writes none of your Claude files (the `claude` processes it starts keep their own transcripts and settings as usual). A startup dialog that Claude Code shows for an agent (the trust question for a folder it has not seen, the bypass-permissions warning) is answered by you in that agent's terminal; until then the agent is "needs you" and receives no mail.

## Positions, T-minus, Max Q and custom agents

- **Positions.** The hire form offers 15 control-room positions (FLIGHT, FAO, FIDO, GUIDO, CONTROL, DPS, INCO, EECOM, BOOSTER, SURGEON, SIMSUP, RETRO, RSO, PAO, CAPCOM). A position fills the name and a default role text (both stay editable) and sets the console's accent colour. They are presets, not seats: two agents may share a position if their names differ. The list is `src/shared/positions.ts`.
- **T-minus, the pre-flight poll.** The Director starts a poll from the wall display (all running agents with the gonogo tools except FLIGHT; the REST route also takes a list of names). Each one gets the message `T-minus: go/no-go poll` and answers with the tool `go_nogo` (`go` or `no-go`, plus a one-sentence reason). The first no-go holds the poll and the wall display shows who and why; if that agent changes its vote to go and everybody else is go, the poll reads GO. When every polled agent said go, FLIGHT is told `T-minus: all go`. The Director can also hold a poll (a hold the Director calls stays until it is cleared), abort it (agents are told to stand by) and clear it when done. A stopped agent counts as no-go. Only one poll exists at a time, and it is not saved: a restart clears it.
- **Max Q, the load governor.** A limit on how many agents with hooks (Claude Code, Gemini CLI) may be `working` at once, set on the wall display (or `GONOGO_MAX_WORKING`). While the limit is reached, a message from one agent to an idle agent waits, with the note `waiting: load limit (N of M agents working)`, and goes when a working agent finishes. Your own messages and polls never wait, and an agent that is already working still gets its mail when its turn ends. Custom agents and engines without hooks take no slot.
- **Custom agents.** In the hire form, Provider "Custom" runs any command you give (words separated by spaces, or a JSON array of strings, up to 1000 characters; no shell, so quote with the array form) in the agent's directory, in a terminal like the others. It gets the same environment scrubbing but no token, no hooks and no `gonogo` tools: gonogo cannot read its mail (messages to it come back undelivered), and it shows `working` while it prints and `idle` when it is quiet. It never takes part in a poll. The form hides the position and the permission mode for it, and a command that cannot be read (bad JSON, empty, a NUL character) is refused at hire and edit.

The guard rails have pages of their own: [Redline](../features/redline.md) stops an agent that loops or storms, and [Propellant](../features/propellant.md) sets token budgets.
