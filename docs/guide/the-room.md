# The room

The screen, the agents and how their messages travel.

<MailPointerMock class="doc-mock" />

## The screen

Lights: indigo working, green idle, grey stopped, dashed open seat; saffron needs you; sage go; raspberry no-go or danger. Nothing loads from another host.

| Part | Shows |
|---|---|
| Top bar | Logo, version (amber `0.5.5 out` when newer; Update is main's, other rooms say OPEN MAIN TO UPDATE: [Rollout](../features/rollout.md)), ROOMS key |
| Wall | Mission (your last brief to FLIGHT) and clock, 10-minute activity chart, T-minus poll, Max Q |
| Room | Matrix: the 16 positions keep their cells, others take spare ones. Click an open cell to staff it |
| Your console | A saffron block per agent that needs you and per hire request ([Relief](../features/relief.md)); GO and NO-GO press Enter or Escape in that terminal; the box to brief FLIGHT |
| Selected console | State, Start/Restart, Stop, Edit, Remove, REFLECT ([Mass Budget](../features/mass-budget.md)), [files](../features/hangar.md), [git](../features/recorder.md), live terminal you can type into, last messages |
| COMMS | INBOX, TRAFFIC, THREADS ([Comms](../features/comms.md)) |
| Phone (under 700 px) | One column, bottom bar ROOM, COMMS, BRIEF, LAUNCH, PLAN, LOG, PATCH; a console opens full screen with keys; prompts have big GO and NO-GO |

Views have their own pages: [Launch Window](../features/launch-window.md), [Flight Plan](../features/flight-plan.md), [Downlink](../features/downlink.md), [Mission Log](../features/mission-log.md), [Livery](../features/livery.md), [Patch Panel](../features/patch-panel.md) (Cmd+K or Ctrl+K), [Flight Rules](../features/flight-rules.md); from the Patch Panel also [Party Line](../features/party-line.md), [Plot Board](../features/plot-board.md), [Black Box](../features/black-box.md).

## Agents and messages

1. Each agent has its own settings, memory file and token, and uses the MCP server `gonogo`; the server stamps the sender. Tools: `send_message`, `list_roster`, `read_messages`, `go_nogo`, `task_list`, `task_create`, `task_update`, `mission_list`, `log_write`, `log_search`, `log_read`, `livery_submit`, `review_read`, `review_note`; boss only: `mission_create`, `mission_update`, `board_read`, `board_write`; FLIGHT only: `hire_agent`.
2. A message body (at most 20000 characters) never goes through a terminal; only a pointer: `gonogo: 2 new messages from ana, user. Call read_messages.`
3. The pointer is typed only into an idle agent showing its input box, with no dialog and none of your text. A working agent gets it when its turn ends; an agent that needs you waits. A message to a stopped agent is not queued: it comes back undelivered. State comes from Claude Code's hooks, the window title and the screen.
4. **Hold rules.** Text you typed in an agent's terminal holds its mail (`held: text in ana's input`) until you press Enter or Ctrl-C there, the box has been empty 1 s, or 30 minutes pass. A pointer not confirmed in 2 s is held until Enter or Ctrl-C in that terminal.
5. **Loop guard.** Your message is hop 0; a message sent while working on mail is its highest hop plus 1 (1 otherwise). Past the cap (8) it goes to you.

Queues are in memory: after a restart every agent is stopped but the boss, and unread mail shows undelivered ([Autostart](../features/autostart.md) restarts the rest).

## FLIGHT, the boss

The first start creates `flight` in the directory gonogo started from (`agents.json`). It cannot be removed, can be edited, starts with the server in `default` mode, and asks for hands with `hire_agent` (nothing is hired until you press GO).

- In your home directory Claude Code asks the folder trust question at every start: answer it in the boss's terminal, or Edit the boss to a project folder. In Docker seed mode such a boss does not start ([Security](../reference/security.md)).
- A startup dialog (folder trust, bypass warning) is yours to answer in the agent's terminal; until then it is "needs you" and gets no mail. gonogo writes none of your Claude files.

## Positions, T-minus, Max Q, custom agents

- **Positions.** FLIGHT, FAO, FIDO, GUIDO, CONTROL, DPS, INCO, EECOM, BOOSTER, SURGEON, SIMSUP, RETRO, JANITOR, RSO, PAO, CAPCOM (`src/shared/positions.ts`): presets for name, role text and colour, all editable. A taken one fills the next free name (`guido-2`). JANITOR keeps the workspace clean: removes without asking only regenerable output and merged local branches; a worktree only when its owner is idle and says it is free; asks the boss before anything remote or irreversible; never touches main, tags, releases, open pull requests, credentials or containers.
- **T-minus.** Started from the wall; polls every running agent with the gonogo tools except FLIGHT. Each answers `go_nogo` (go or no-go, one sentence). The first no-go holds the poll and shows who and why; if that agent turns to go and all others are go, it reads GO. All go tells FLIGHT `T-minus: all go`. You can hold (until cleared), abort (agents are told to stand by) and clear. A stopped agent is no-go. One poll at a time; a restart clears it.
- **Static fire.** Type what to test, press STATIC FIRE: SIMSUP agents try to break it, RETRO agents write the rollback ([Static fire](../features/static-fire.md)).
- **Max Q.** Caps agents with hooks (Claude Code, Gemini CLI) `working` at once: wall or `GONOGO_MAX_WORKING`. At the cap, agent-to-idle-agent mail waits (`waiting: load limit (N of M agents working)`); your messages and polls never wait. Custom agents and hookless engines take no slot.
- **Custom agents.** Provider "Custom" runs any command (spaces, or a JSON array of strings; up to 1000 characters; no shell) in the agent's directory. No token, hooks or tools: mail comes back undelivered; shows `working` while it prints, `idle` when quiet; never in a poll; the form hides position and mode. An unreadable command is refused.

Guard rails: [Redline](../features/redline.md), [Propellant](../features/propellant.md), [Cost](../features/cost.md).
