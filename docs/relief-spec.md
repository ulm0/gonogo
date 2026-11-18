# Spec: Relief

Written and built 2026-11-18. Backlog section 4, "A boss that hires agents by itself". The name is from the control room:
a relief shift is the extra people who come in when the floor needs more hands.

## Intent

FLIGHT breaks a brief into tasks and finds that no position fits, or that one position is overloaded. Until now it could
only tell the Director to hire. Now it can ask with `hire_agent`; the Director sees what it asks and says GO or NO-GO. The
boss never staffs the room by itself: the request is data, and only the Director's answer reaches the call of the hire form.

## Design

- **The tool.** `hire_agent { name, position?, role?, dir?, engine?, mode? }` (`mcp.ts`, a strict schema: a seventh field is
  refused by the SDK before gonogo's code runs). The requester is the agent of the token. It answers
  `{ ok: true, id: "h1", status: "pending", note }` or an error result `{ ok: false, error }` that says what to change.
- **Who may ask.** The boss only (`AgentView.boss`), in its current session (`generation`, no `transition`). Another agent
  gets `forbidden`, a stale session `conflict: this session has ended`.
- **What may be asked** (`relief.ts`, `request`). `name` follows the hire form's rule and `RESERVED_NAMES`, and no agent and
  no waiting request has it. `position` is one of `POSITION_IDS`; `role` is 1 to `ROLE_MAX_CHARS` characters after a trim and
  wins over the position's text; one of the two is needed. `engine` is a provider except `custom` (a custom command is a command
  line: only the Director types one). `mode` is `default` or `acceptEdits` (`RELIEF_MODES`): `auto` and `bypassPermissions` are
  refused with their own words, and an engine without permission modes (`providerInfo(...).modes`) is shown as `default`, which
  is what it will get. There is no field for `confirmBypass`, `command`, `payload` or `cleanRoom`.
- **The folder.** `HubIo.checkDirectory`, the function the hire form's `Hub.hire` uses: absolute, there, a directory, resolved.
  It is checked when asked, and `Hub.hire` checks it again at the GO.
- **Clean Room.** A Clean Room boss's request is a Clean Room request: the new agent gets the boss's `cleanRoom` setting
  (same image), Claude Code only, and `dir` must be the boss's own `dir` or inside it, by `realpath` on both sides, so a
  `..` or a symbolic link that leaves is refused (`forbidden`, field `dir`). It may leave `dir` out and gets the boss's. The
  check runs again at the GO against the boss's current record, so a folder swapped for a link in between is refused.
- **Limits** (`constants.ts`): `RELIEF_PENDING_MAX` 3 waiting at once (`conflict`), `RELIEF_RATE_MAX` 5 requests in
  `RELIEF_RATE_WINDOW_MS` 10 minutes (`rate_limited`; a refused request does not count), `RELIEF_TTL_MS` 30 minutes until a
  request expires, and the room cap `MAX_AGENTS` (24), checked when asked and by `Hub.hire` at the GO. The same limits are
  checked again after the folder check, because two calls can overlap while the disk answers.
- **The request waits** in memory: `ReliefRequest { id, by, at, expiresAt, name, position, role, dir, provider, mode,
  cleanRoom }`. `ReliefView { requests }` is in `StateSnapshot.relief?`, in the `relief` frame and at `GET /api/relief`.
- **The Director.** `POST /api/relief/:id/go` and `/no-go` (browser token; an agent token is 401 like on every `/api` route).
  `Relief.decide(id, verdict, by)` also refuses any `by` that is not `{ kind: 'user' }`, so no code path lets an agent answer,
  the requester included. The request leaves the list before anything waits, so two GOs hire once.
- **GO.** `Hub.hire({ name, role, dir, mode, provider, position?, cleanRoom? })`: the same call as `POST /api/agents`, with no
  `confirmBypass`, no `command`, no `payload`. A failure (name taken meanwhile, room full, folder gone, no Docker) is the
  HubError of the form, sent to the Director and to the boss; nothing is retried.
- **FLIGHT hears the answer** as a message from the Director's side (`Hub.sendFromUser`, as T-minus does): `Relief: guido-1 is
  staffed`, `Relief: request for guido-1 refused`, `... expired`, `Relief: guido-1 could not be hired` (with the reason).
- **The Downlink** gets a `relief` event (chip RELIEF) when a request is made and when it ends. Relay does not forward it.
- **The page.** A saffron block in the same list as the consoles that need you (`Needs`, on the wide page docked at the foot, on
  the phone above the matrix; the dock scrolls past 55% of the viewport height): the title `FLIGHT ASKS TO HIRE guido-1`, rows for name, position, engine, mode, folder, Clean
  Room and time left, the whole role text in a scrolling box that takes the keyboard, and NO-GO and GO (48 px high; on the
  phone they share the width). The live region says `N hire requests wait for your go` when the count grows.
- **FLIGHT's role text** (`positions.ts`) names the tool in place of "tell the Director which kind to hire".

## Decisions

- **A request, not a permission.** The first idea was a flag that lets the boss hire inside a budget. A hire starts a process
  as the owner with a role text the boss wrote, so the Director sees all of it each time.
- **No second tool for the status.** The answer comes as a message, the way T-minus tells FLIGHT; a tool to poll would add a
  fourth way to learn what a message already says.
- **In memory.** A request is short-lived (30 minutes) and a restart ends the boss's session anyway. Saving it would need a
  file, a version and a migration for a list that is nearly always empty.
- **`mode` is a string in the schema.** An enum would make the SDK answer for `bypassPermissions`; Relief answers instead, and
  the answer says why and what is allowed.
- **Strict schema.** An unknown field is an error, not dropped: a boss that adds `confirmBypass: true` learns it does not exist.
- **Clean Room hires inherit the box.** A Clean Room agent that could hire a host agent would leave its box through the
  Director's own GO.

## Rejected

- A budget or standing approval; a tool to cancel a request; an `edit_agent` or `remove_agent` tool; a payload, a command or a
  Clean Room that the boss chooses; saving requests; an approval from the phone bar without opening the block.

## Known limits

- shortcut: requests are not saved. A restart drops them and the boss is not told; the Downlink line stays.
- shortcut: the Clean Room check follows links when it is made. A swap between the check at the GO and the worktree that
  `Hub.hire` makes is not closed (the worktree is made from the repository's `HEAD` in the folder `Hub.hire` checks again).
- A boss saved before Relief keeps the role text it was hired with, which says it cannot hire. `hire_agent` is in its tool list
  all the same, with its own description.
- A GO waits for the hire like the form does (the call returns when the agent has started or failed to).

## Checked how

| What | How | Result |
|---|---|---|
| Every limit and the abuse cases: a mode above acceptEdits, an extra field, `custom`, bad and taken names (also two calls at once), the room cap (at the request and at the GO), the pending cap, the rate window, expiry (timer and clock), an agent answering, two GOs, a Clean Room boss with `..`, links, a prefix twin and a swap | `test/relief.test.ts` (38 tests, a fake hub and clock, real folders and links in a temporary directory) | pass |
| The routes, the token rule, the state, the tool's schema and its refusals | `test/edge.test.ts` (`relief`) | pass |
| The real server with the stand-in agent: ask, wait, refuse by tool, an agent token on the route, GO hires `guido-1` with the mode and position through `agents.json`, NO-GO, the boss's messages, the Downlink | `test/e2e.test.ts` scenario 31 | pass |
| The words of the block, the store, the live region | `test/client-relief.test.ts` | pass |
| The block in Chrome (a tab of its own, viewport by emulation) at 1440 px and 390 px, in Instrument and Night Shift, against a real server with the stand-in agent: three requests at once, GO and NO-GO pressed, no horizontal scroll at 390 px, keys 48 px high, the agent hired and the Downlink lines | by script and by eye, 2026-11-18 | pass |
| A real `claude` asking, and a Clean Room GO on real Docker | not run (`docs/reference/not-verified.md`) | n/a |
