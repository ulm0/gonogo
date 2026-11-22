# Runtime settings: the GONOGO_* env from the UI, per room or global

Status: built (t112), server side; the page row is CONTROL's. Server side by GUIDO; the Flight Rules → System and update row is CONTROL's.

## What it is

Eight `GONOGO_*` variables the Director can set in the UI instead of the compose file. Precedence, first that has a value wins:

**room file > global file > environment > built-in default.**

The environment value is always shown as the default; **Reset** removes the stored value and falls back to it. Nothing is ever written to the environment of the server.

## Keys

| Key | Env | Scope | Applies | Parser (reused) |
|---|---|---|---|---|
| `maxHops` | `GONOGO_MAX_HOPS` | room or global | live | `resolveSettings`: 1 to `MAX_HOPS_LIMIT` |
| `maxWorking` | `GONOGO_MAX_WORKING` | room or global | live (Max Q; the existing Max Q control writes this key) | `resolveSettings`: 1 to `MAX_AGENTS`, empty = off |
| `agentCmd` | `GONOGO_AGENT_CMD` | room or global | next agent start | `parseAgentCmd` |
| `cleanRoomImage` | `GONOGO_CLEANROOM_IMAGE` | room or global | next Clean Room start | `IMAGE_RE` of `cleanroom.ts` |
| `scrubEnv` | `GONOGO_SCRUB_ENV` | room or global | next agent start | `operatorScrub` (names only) |
| `logLevel` | `GONOGO_LOG_LEVEL` | global | live in the rooms; the supervisor's own line level on its next start | `logLevel` |
| `station` | `GONOGO_STATION` | global | restart (Docking identity) | `stationName` |
| `updateCheck` | `GONOGO_UPDATE_CHECK` | global | restart (the supervisor and main read it) | `updateCheckOff` |

"Restart" and "next start" are said in the answer of the route (`applies: 'live' | 'next-start' | 'restart'`) so the page can print it.

## Files

- Global: `<root>/runtime-settings-global.json`, 0600, written by temp file and rename. Shape: `{ "version": 1, "values": { "<key>": "<text>" } }`. Values are the text the env would carry; unknown keys and bad values are dropped on read with a warning, never fatal.
- Room: `<room home>/runtime-settings.json`, same shape, only the room-or-global keys.
- The supervisor passes the global file's path in `GONOGO_GLOBAL_SETTINGS` to every room (like `GONOGO_KNOWLEDGE_DIR`). A room resolves each key itself: its file, else the global file, else its env. So a room started by hand (no supervisor) still works.

## Routes (on the room, behind its login)

- `GET /api/settings` → `{ keys: [{ key, scope: 'room'|'global'|'both', value, source: 'room'|'global'|'env'|'default', env, room, global, applies, sensitive }] }`. `value` is the effective one; `env` is the environment value (the default); `room` / `global` are what the two files hold (null = none). `agentCmd` is shown to a session in full.
- `PUT /api/settings/<key>` `{ scope: 'room'|'global', value: string | null }`; `null` is Reset of that scope. Answers the new row. 400 with the parser's reason for a bad value; 400 for a global-only key with scope `room`.
- A global write by a room is written to the root file by that room; it then tells the supervisor (one stdout line, like `gonogo-ask`), which writes `gonogo-settings` to every running room's stdin; each room re-reads and applies. Nothing is proxied.

- Who asked reaches the room as the header `x-gonogo-actor` (`session`, `key:<id>`, `token`, `socket`, `tui`), put by the supervisor's proxy on `/api/settings` requests only; a sender's own copy is dropped with every `x-gonogo-` header, and the room believes it only over its local socket.
- The supervisor takes only the fact from the room's line `gonogo-settings-changed` (it must be exactly that line); it never reads a value from it. Every running room is told `gonogo-settings` and reads the file itself, checking each value.

## Security (for RSO)

- **Step-up** for every `PUT` (`stepup.ts`: `/api/settings/...`), like ROOM KEYS; the reason says which key.
- **`agentCmd` and `scrubEnv` are sensitive**: owner **session** only. An API key (any scope), an agent token, the local socket and a `tui` grant get 403. The page shows a plain warning ("this command runs with the agents' rights" / "a name left out of the scrub reaches every agent").
- `agentCmd` goes through `parseAgentCmd` (array form or quoted words, no shell); the stored text is the one the parser accepted. A value that is a Docker or other launcher is the Director's call; nothing is checked beyond the parser.
- `scrubEnv` holds names and `_`-suffixed prefixes only, never values; it can only add to the built-in scrub list, never remove from it.
- The file is read as data: size cap 16 KiB, only the listed keys, only strings, each re-validated at read time (a hand-edited file cannot inject a value the parser refuses).
- **Black Box**: one line per write: who (session or key name), key, scope, old → new. `agentCmd` is shown as its binary name only (`/usr/bin/foo --token x` → `foo`); `scrubEnv`, `maxHops`, `maxWorking`, `logLevel`, `station`, `updateCheck`, `cleanRoomImage` are shown as they are.
- No secret is stored here by design: a value that looks like a token in `agentCmd` is the Director's own risk and is redacted in the log; the file is 0600.

## Known limits

- An agent that does not run in a Clean Room can reach the room's own socket (`run/room.sock`) and so the settings API without the proxy: the socket is the credential, as for every other route of the room (room keys, permissions, hire), and it can write `x-gonogo-actor: session` itself, so the "owner session only" rule and the step-up are walls against keys, terminals and browsers, not against an agent on the same host without a Clean Room. A Clean Room does not mount `run/`.
- The scrub list is the union of the environment's names and the files': a setting can only scrub more, never less. Reset removes the names the files added; the environment's stay.

## Applying

- `maxHops`: the hub reads it through a getter (today it is fixed at `createHub`), so a change is seen by the next message.
- `maxWorking`: the hub's existing live limit (`setLimit`); the Max Q control keeps its route and now also stores the value so a restart keeps it.
- `agentCmd`, `scrubEnv`, `cleanRoomImage`: read from the resolver on each agent (or Clean Room) start; running agents keep what they have.
- `logLevel`: `createLogger` gets a settable level; the rooms call it on `gonogo-settings`. The supervisor's own logger and the pty host take it at their next start.
- `station`, `updateCheck`: stored now, effective at the next start; the row says "restart".

## Tests the build must have

- Precedence for every key (room > global > env > default) and Reset of each scope; bad values refused with the parser's reason; a hand-edited file with a bad value, an unknown key, an oversize file or a non-string is ignored.
- Global-only keys refuse scope `room`.
- Step-up: a stale session gets 403 `stepUp` on every `PUT` (plain and encoded key names); fresh passes.
- `agentCmd` and `scrubEnv`: key (full), agent token, socket and tui are refused; session passes; the Black Box line redacts the command to its binary.
- Live: a global write reaches a running fake room (hops, Max Q, log level) through the pipe; a new agent start sees the new `agentCmd` / scrub / image.
- Supervisor passes `GONOGO_GLOBAL_SETTINGS`; a room started without it still resolves from env.

## Not in this spec

Per-agent overrides (Clearance and the hire form have them); editing any other `GONOGO_*` variable (port, host, home, allowed hosts: these decide who can reach the server and stay in the compose file); an API route for keys; a CLI.
