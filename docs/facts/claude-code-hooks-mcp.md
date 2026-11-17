# Claude Code hooks, MCP tools, sessions and flags: facts for gonogo

Written 2026-11-16 for the gonogo builders. Job name: hooks-mcp. Everything below comes from running the installed
`claude` or from its official documentation, not from memory. Each statement is marked VERIFIED, DOCS or UNVERIFIED (next section).

## How to read this file

- **VERIFIED (how)** means I ran it. The "how" names the run (R1 to R10, listed in Appendix A) or the command.
- **DOCS** means it comes from the official documentation (URLs in Appendix C) and I did not reproduce it.
- **UNVERIFIED** means neither. The reason is given.
- `$S` is my scratch directory, `<scratch>/facts-hooks-mcp`.
  Its name contains a space on purpose, so every path and quoting result below was tested with a space in the path.
  Logs, settings files, the test server and the raw outputs of every run are still there.

## Test environment

| Item | Value |
|---|---|
| `command claude --version` | `2.1.325 (Claude Code)` (Homebrew cask `claude-code@latest`, Mach-O arm64) |
| OS | macOS (Darwin 27, arm64). `/bin/sh` there is bash 3.2 in POSIX mode |
| Node | v24.18.0. curl 8.7.1 |
| MCP SDK | `@modelcontextprotocol/sdk` 1.32.2 (`npm view` `latest` on the day), zod 4.6.7 |
| Model | `--model haiku`, which resolved to `claude-haiku-5-5` (field `model` of the `system/init` message) |
| Mode | Every run was `claude -p` (non-interactive). No interactive run was made. |

How the test claudes were started. This shell has a wrapper function named `claude`, and the harness itself runs inside
Claude Code, so each run used `env -u ... command claude ...` with these variables removed:
`CLAUDECODE`, every `CLAUDE_CODE_*` (including `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`), `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`, and the owner's
`HERDR_*` variables (so the owner's own SessionStart hook could not report my test sessions to their other tool).
The list is built by `$S/bin/runc.sh`, which ends in `env "${unsets[@]}" command claude "$@"`.

Nothing under `~/.claude` or `~/.claude-work` was edited by hand. The test runs did leave their own transcripts in
`~/.claude/projects/` (directories ending `...facts-hooks-mcp-proj-a`, `...-proj-b`, `...-proj-bad`, `...-val-*`) and
project entries in `~/.claude.json`; I did not delete them.

---

## 0. The launcher cheat sheet (all of it follows from the facts below)

First start of an agent (the session id is new):

```
command claude \
  --session-id <uuid> \
  --permission-mode <default|acceptEdits|bypassPermissions> \
  --settings <home>/agents/<name>/settings.json \
  --strict-mcp-config --mcp-config <home>/agents/<name>/mcp.json \
  --append-system-prompt "<role text>" --system-prompt-snapshot off \
  --allowedTools mcp__gonogo__send_message mcp__gonogo__list_roster
```

Every later start: the same line with `--resume <uuid>` in place of `--session-id <uuid>`. Flags are not restored by
`--resume`, so all of them are passed again. `--session-id` on an existing session and `--resume` on a missing one both
fail at once with exit code 1 (section 7).

Environment of the claude process: `GONOGO_TOKEN=<per-agent token>` (read by hooks and by the MCP config, section 5 and 6),
inherited `CLAUDECODE` and session-identity `CLAUDE_CODE_*` variables removed (section 3).

Per-agent settings file, native HTTP hooks (section 5 has the evidence). `SessionStart` is the only event of the seven that
cannot use `type: "http"`:

```json
{
  "hooks": {
    "UserPromptSubmit": [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:PORT/hook/AGENT/UserPromptSubmit", "timeout": 10,
        "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] } ] } ],
    "PreToolUse":   [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:PORT/hook/AGENT/PreToolUse",  "timeout": 10, "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] } ] } ],
    "PostToolUse":  [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:PORT/hook/AGENT/PostToolUse", "timeout": 10, "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] } ] } ],
    "PermissionRequest": [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:PORT/hook/AGENT/PermissionRequest", "timeout": 10, "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] } ] } ],
    "Notification": [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:PORT/hook/AGENT/Notification", "timeout": 10, "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] } ] } ],
    "Stop":         [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:PORT/hook/AGENT/Stop", "timeout": 10, "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] } ] } ]
  }
}
```

Of the six entries above, UserPromptSubmit, PreToolUse, PostToolUse and Stop were exercised as http hooks by real events (R2). `PermissionRequest` was exercised only as a command hook (R1) and `Notification` never fired in `-p`, so those two entries rely on http hooks being accepted for every event except SessionStart and Setup (section 1.1).

Stop reply from the server (HTTP 200, `Content-Type: application/json`): `{}` to let the agent go idle, or
`{"decision":"block","reason":"<message text>"}` to make it carry on with the text as its next instruction.

Per-agent MCP file (`mcp.json`), the token comes from the environment (a literal token also works, section 6):

```json
{ "mcpServers": { "gonogo": { "type": "http", "url": "http://127.0.0.1:PORT/mcp",
    "headers": { "Authorization": "Bearer ${GONOGO_TOKEN}" } } } }
```

---

## 1. Hook configuration through `--settings`

### 1.1 The JSON shape that registers the seven events

VERIFIED (R1: `--settings $S/settings-r1.json`, command hooks on all seven events; R2: `--settings $S/settings-r2.json`,
http, curl and node hooks). The file is an ordinary settings file. `hooks` maps an event name to an array of matcher groups.
Each group has an optional `matcher` and an array of handlers. This is the exact shape that ran (paths shortened to `$S`;
in the real file `$S` was the absolute path and the quotes were JSON-escaped):

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "command": "\"$S/bin/hook-log.sh\" r1 cli-SessionStart" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "\"$S/bin/hook-log.sh\" r1 cli-UserPromptSubmit" } ] } ],
    "PreToolUse":       [ { "hooks": [ { "type": "command", "command": "\"$S/bin/hook-log.sh\" r1 cli-PreToolUse" } ] } ],
    "PostToolUse":      [ { "hooks": [ { "type": "command", "command": "\"$S/bin/hook-log.sh\" r1 cli-PostToolUse" } ] },
                          { "matcher": "Bash", "hooks": [ { "type": "command", "command": "\"$S/bin/sleep-hook.sh\" 6 post-t2", "timeout": 2 } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "\"$S/bin/hook-log.sh\" r1 cli-Stop" } ] } ],
    "Notification":     [ { "hooks": [ { "type": "command", "command": "\"$S/bin/hook-log.sh\" r1 cli-Notification" } ] } ],
    "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "\"$S/bin/hook-log.sh\" r1 cli-SessionEnd" } ] } ]
  }
}
```

`$S/bin/hook-log.sh` appends the epoch time, a label and its stdin to a file and exits 0 with no output. `timeout` is in
seconds. `matcher` is optional; for tool events it matches the tool name (VERIFIED: the debug log names the hooks
`PreToolUse:Bash` and `PreToolUse:mcp__gonogo__list_roster`).

Handler types in this version: `command`, `http`, `prompt`, `agent`, `mcp_tool` (DOCS: hooks page, handler fields). I ran `command` and
`http`. A `command` handler has two forms (both VERIFIED in R2):

- shell form: `"command": "\"/path with space/x.sh\" arg"` is run through `/bin/sh -c` (section 5);
- exec form: `"command": "<absolute executable>", "args": ["<arg1>", "<arg2>"]` is spawned directly, no shell, so a path
  with a space needs no quoting (R2: `node` with `$S/bin/hook-fwd.mjs` in `args` worked).

`type: "http"` hooks do not run for `SessionStart` (VERIFIED, R2 debug log: `Skipping HTTP hook http://127.0.0.1:47831/hook/http/SessionStart — HTTP hooks are not supported for SessionStart`). The binary has the same rule for `Setup` (string in
the binary, not run). All other events I registered accepted http hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd` ran; R2).

### 1.2 Events this version supports

VERIFIED by `command claude doctor` run in a directory whose `.claude/settings.json` contained an unknown event name. It
printed `Unknown hook event "NotAnEvent" was ignored. Valid events:` followed by 33 names:

PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion,
SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch,
PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation,
ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged,
DirectoryAdded, MessageDisplay.

Which of them fired in `-p` runs R1 and R2 (I registered logging hooks on all of these except the ones marked "not registered"):

| Event | Fired in -p? | Why it matters for working / idle / needs you |
|---|---|---|
| SessionStart | yes, `source: "startup"` (`"resume"` on `--resume`) | agent process is up (command hook only) |
| InstructionsLoaded | yes, once per instruction file (R1: two, `memory_type` `Project` and `User`) | none |
| UserPromptSubmit | yes | **working** begins. Also fired for a turn that an async-rewake hook started by itself (R10). Not fired for Stop-hook continuations (R2) |
| PreToolUse, PostToolUse | yes (`mcp_server` field for MCP tools) | **working** heartbeat |
| PostToolBatch | yes, after each batch of tool calls | **working** heartbeat |
| PermissionRequest | **yes, in -p**, right after PreToolUse when a tool needs approval and nothing approved it | **needs you** candidate. Fires before the permission is decided |
| MessageDisplay | yes, once per assistant message, `final: true` on the last chunk | working (assistant text) |
| Stop | yes | **idle**. DOCS: does not run when the user interrupts, and API errors fire StopFailure instead |
| SessionEnd | yes, `reason: "other"` at exit | not needed: the pty exit already says "stopped" (1.5 s budget, section 4) |
| Notification | **no. Could not be triggered in `claude -p`** (R1 had a logging hook; two permission denials produced PermissionRequest but no Notification) | DOCS: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog` and others. The interactive researcher covers it |
| PostToolUseFailure | no (a permission denial does not fire it) | not registered in R2 |
| StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, TaskCreated, TaskCompleted, Elicitation, CwdChanged | no | DOCS only. StopFailure replaces Stop when the turn ends on an API error, so an idle detector should listen to it too |
| PermissionDenied | not registered | DOCS: fires only when auto mode denies a call |

### 1.3 Does a `--settings` hook run next to the user's hooks, or instead of them?

**In addition to them.** VERIFIED in R1 (debug file `--debug-file`, lines `Hooks: <event> [<command>] finished with status 0`).
In one session these ran together for the same event:

- hooks from my `--settings` file (`.../bin/hook-log.sh r1 cli-SessionStart`),
- the owner's global hooks from `~/.claude/settings.json` (a SessionStart hook and a PreToolUse hook on `Bash|Grep`; both
  appear in the log, for example `Hooks: PreToolUse:Bash [<the owner's guard command>] finished with status 0 (67ms)`),
- hooks of four installed plugins (their SessionStart and UserPromptSubmit hooks printed context text that was added to the conversation),
- hooks from the project's `.claude/settings.json` and `.claude/settings.local.json`.

The count of SessionStart hooks in the R1 stream was 9 and of `PreToolUse:Bash` hooks 4, which matches that list. Matching hooks
for one event run in parallel (VERIFIED: R1 log lines of two hooks for one Stop event were interleaved in one file, and the
R2 server saw the http, curl and node hooks of one event within about 100 ms of each other). Give each hook its own output
file or write one line per `write()` if you log from several hooks.

### 1.4 Does the project's own `.claude/settings.json` still apply?

**Yes**, and so does `.claude/settings.local.json`. VERIFIED in R1: with `--settings` and a probe project that had both files,
`proj-UserPromptSubmit`, `local-UserPromptSubmit`, `proj-PreToolUse` (matcher `Bash`) and the `cli-*` hooks all fired for the same prompt.
Project settings are the ones of the **current** directory: R9 resumed a session started in `proj-b` from `proj-a`, and the
`proj-a` hooks ran (`Hooks: SessionStart:resume ["$S/bin/hook-log.sh" r1 proj-SessionStart]`).

### 1.5 `--settings` details

- Accepts a file path or an inline JSON string. VERIFIED: path with a space (R1, R2); inline string of 1330 bytes (R9: `--settings "$SETJSON"`).
- DOCS (sessions page, "Flags to pass again when you resume"): `--settings` and `--mcp-config` are not restored by `--resume`. Pass them every time.
  I always passed them, so I did not test what happens when they are left out.
- In `-p` mode a settings file that fails validation is ignored silently (`--help` text for `-p`). VERIFIED with `claude doctor` that a bad entry is dropped on its own,
  not the whole file (message `... entry ignored.`). To validate a generated file, copy it to `<probe dir>/.claude/settings.json`
  and run `command claude doctor` in that directory (`doctor` has no `--settings` argument, hence the copy). It checks the nested handler fields too:
  in `$S/proj-bad2`, `{"type":"http"}` without `url`, `"timeout":"abc"`, `"args":"notarray"` and `"allowedEnvVars":"X"` were each reported as
  `Invalid ... hook (...); entry ignored.` All my settings files passed with no "Invalid settings" block.
- Removing the owner's other settings sources. VERIFIED in R3 with `--setting-sources project,local --settings <file>`: the `system/init` message listed only the
  five built-in `cc-plugin-*` plugins (none of the owner's), `mcp_servers: []` and 25 tools, and only my four hooks started
  (no owner hook, no plugin hook). The `--settings` hooks still ran. So `--setting-sources project,local` drops user hooks, user plugins, user-scope MCP servers and the claude.ai connectors in one flag.
  By construction it also ignores the user's permission rules and env block (they live in the user settings file). DOCS: using `--setting-sources` without `user` can bring back the one-time bypassPermissions warning in interactive mode (UNVERIFIED, interactive).
- `--bare` and `--safe-mode` switch hooks off, including `--settings` hooks (`claude --help` text; DOCS headless page). Never use them for an agent.

---

## 2. What claude sends to each hook on stdin

All samples are real, from R1 and R2 (the async-rewake prompt text is from R10). Long values are shortened with `...`. Command hooks get the JSON on stdin; http hooks
get the **same bytes** as the POST body with `Content-Type: application/json` (VERIFIED in R2: for UserPromptSubmit, PreToolUse,
PostToolUse, Stop and SessionEnd the command-hook stdin and the http body were identical after parsing). The http request
`User-Agent` is `axios/1.15.2`.

Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Most events also carry `prompt_id` (one id per prompt;
the Stop-hook continuations of R2 kept the prompt's id, the turn that R10 woke got a new one), `permission_mode`, and on tool/Stop events `effort: {"level": ...}`.

**SessionStart** (command hooks only; R1)
```json
{"session_id":"71e3f484-5fff-4b90-9390-2b9dd055a899","transcript_path":"/Users/<user>/.claude/projects/<cwd-with-dashes>/71e3f484-5fff-4b90-9390-2b9dd055a899.jsonl","cwd":"<S>/proj-a","hook_event_name":"SessionStart","source":"startup"}
```
`source` was `"resume"` on every `--resume` run (R4, R5, R6, R9). DOCS: also `clear`, `compact`, `fork`.

**UserPromptSubmit** (R2). `prompt` is the full prompt text.
```json
{"session_id":"f4ff7b1a-...","transcript_path":"...","cwd":"<S>/proj-b","prompt_id":"a213de1a-d466-4f96-9d82-ae7cd02fcab5","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"Call the list_roster tool of the gonogo MCP server. Then ..."}
```

**PreToolUse** for a built-in tool (R1) and for an MCP tool (R2, field `mcp_server`):
```json
{"session_id":"71e3f484-...","transcript_path":"...","cwd":"<S>/proj-a","prompt_id":"caff3710-...","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi","description":"Print hi"},"tool_use_id":"toolu_01TDsSruP3cyi7jJEde7a5Ff"}
{"session_id":"f4ff7b1a-...","transcript_path":"...","cwd":"<S>/proj-b","prompt_id":"a213de1a-...","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"mcp__gonogo__list_roster","tool_input":{},"tool_use_id":"toolu_01XKzhXiWSLLLMTWC8NGCfjg","mcp_server":{"name":"gonogo","source":"dynamic"}}
```

**PostToolUse** (R2, MCP tool; a Bash call has `tool_response` as an object with `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`)
```json
{"session_id":"f4ff7b1a-...","transcript_path":"...","cwd":"<S>/proj-b","prompt_id":"a213de1a-...","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PostToolUse","tool_name":"mcp__gonogo__send_message","tool_input":{"to":"ana","subject":"hello","body":"world"},"tool_response":[{"type":"text","text":"{\"ok\":true,\"id\":\"m-1\",\"from\":\"ana\"}"}],"tool_use_id":"toolu_015pbd4tRF9cfrhkuMvpBPXj","duration_ms":3,"mcp_server":{"name":"gonogo","source":"dynamic"}}
```

**PostToolBatch** (R1)
```json
{"session_id":"71e3f484-...","transcript_path":"...","cwd":"<S>/proj-a","prompt_id":"caff3710-...","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PostToolBatch","tool_calls":[{"tool_name":"Bash","tool_input":{"command":"echo hi","description":"Print hi"},"tool_use_id":"toolu_01TDs...","tool_response":"hi"}]}
```

**PermissionRequest** (R1, in `-p`; sent when a tool needs approval, `mcp_server` added for MCP tools)
```json
{"session_id":"71e3f484-...","transcript_path":"...","cwd":"<S>/proj-a","prompt_id":"caff3710-...","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"touch '<S>/logs/r1-denied.txt'","description":"Create r1-denied.txt marker file in logs dir"},"permission_suggestions":[{"type":"addDirectories","directories":["<S>/logs"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}
```

**MessageDisplay** (R1)
```json
{"session_id":"71e3f484-...","transcript_path":"...","cwd":"<S>/proj-a","prompt_id":"caff3710-...","hook_event_name":"MessageDisplay","turn_id":"61f21a13-...","message_id":"1de5e30a-...","index":0,"final":true,"delta":"Step 2 and step 4 were blocked by permissions, ..."}
```

**Stop** (R2, http body; the first and the following one differ only in `stop_hook_active` and `last_assistant_message`)
```json
{"session_id":"f4ff7b1a-...","transcript_path":"...","cwd":"<S>/proj-b","prompt_id":"a213de1a-...","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"ok","background_tasks":[],"session_crons":[]}
{"session_id":"f4ff7b1a-...","transcript_path":"...","cwd":"<S>/proj-b","prompt_id":"a213de1a-...","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"Stop","stop_hook_active":true,"last_assistant_message":"ALPHA","background_tasks":[],"session_crons":[]}
```

**SessionEnd** (R2)
```json
{"session_id":"f4ff7b1a-...","transcript_path":"...","cwd":"<S>/proj-b","prompt_id":"a213de1a-...","hook_event_name":"SessionEnd","reason":"other"}
```

**InstructionsLoaded** (R1, extra): `..."hook_event_name":"InstructionsLoaded","file_path":"<S>/proj-a/CLAUDE.md","memory_type":"Project","load_reason":"session_start"}`.

**Notification**: no real sample, it could not be triggered in `-p`. DOCS sample (hooks page):
```json
{"session_id":"abc123","transcript_path":"/Users/.../.claude/projects/.../00893aaf-....jsonl","cwd":"/Users/...","hook_event_name":"Notification","message":"Claude needs your permission","title":"Permission needed","notification_type":"permission_prompt"}
```
`notification_type` is the field that separates a permission request from an idle notification. DOCS values: `permission_prompt`, `idle_prompt`, `auth_success`, `auth_storage_failure`,
`elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_*`, `plugin_notification`.
A `matcher` on Notification filters by that value (for example `"matcher": "permission_prompt|idle_prompt"`, UNVERIFIED).

The fields you asked about, all VERIFIED: `session_id` (equals the `--session-id` you passed and stays the same on `--resume`, R3 and R4), `cwd`
(the directory the session was started or resumed in, R9), the prompt text in `prompt` on UserPromptSubmit, `tool_name` on PreToolUse,
`stop_hook_active` on Stop (false on the first Stop of a turn, true on every Stop that follows a blocked one). The docs
list a `scratchpad_dir` common field; it was not present in any real payload here.

---

## 3. Environment

**Variables set only on the claude process are visible inside hook commands.** VERIFIED (R1): I started claude with
`GONOGO_TEST_VAR=from-claude-process GONOGO_TOKEN=tok-test-7f3a9c`; `$S/bin/env-probe.sh`, run as a hook, wrote
`GONOGO_TEST_VAR=from-claude-process` and `GONOGO_TOKEN=tok-test-7f3a9c` for SessionStart and for every PreToolUse call.
The same variable is expanded in http hook headers (needs `allowedEnvVars`) and in MCP `headers` (sections 5 and 6).

What else a hook command sees (R1 `env-probe.sh`, values only for a fixed non-secret list):

- `pwd` is the session's working directory (the directory claude started in).
- `CLAUDE_PROJECT_DIR` is that same directory. `CLAUDE_ENV_FILE` is set only for SessionStart (DOCS: also Setup, CwdChanged, FileChanged). `CLAUDE_EFFORT` is set for tool events, not for SessionStart.
- claude also sets, for its children: `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT` (`sdk-cli` under `-p`), `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_PID`. They are in the environment of hook commands (and, by inheritance, of anything a hook starts).
- stdin and stdout of the hook are not a tty, `TERM=xterm-256color` was inherited, `uid` is the user's.
- `PATH` is the claude process's PATH: `node` and `curl` resolved as in my shell. The `env` block of the owner's user settings is applied to the claude process and so reaches hooks (R1: `CLAUDE_CODE_ENABLE_AUTO_MODE` and `CLAUDE_CODE_TMPDIR`, which I had removed from the parent environment, were back in the hook's environment).

Practical consequence for gonogo: put the per-agent token in the claude process environment, not in argv. Argv is visible to every local process through `ps` (R1: the
`ps -o args= -p $PPID` probe printed the whole claude command line, prompt included, and the 4 KB role text of R3 would show the same way).

---

## 4. The Stop hook reply

### 4.1 `{"decision":"block","reason":"<text>"}`

VERIFIED (R2). Each Stop round, the server answered one of the hooks with
`{"decision":"block","reason":"Reply with the single word ALPHA and nothing else."}` and everything else with `{}`. Claude continued the same turn and the
reason arrived as a **user message** with this exact text (transcript and `--output-format stream-json`):

```
Stop hook feedback:
Reply with the single word ALPHA and nothing else.
```

The model obeyed it every time: replies in order were `ALPHA`, `BRAVO`, `CHARLIE`, `DELTA`, `ECHO`, `FOXTROT6`, `FOXTROT7`, `FOXTROT8`. The blocks
came through four different transports (curl command, node exec-form command, http hook, exit-2 script), so the transport does not matter, only the JSON or exit code does.

`stop_hook_active` on the following Stop: **`true`**. In R2 every Stop after the first had `stop_hook_active: true`
(rounds 2 to 9 in `$S/logs/server.jsonl`; the first Stop of the turn had `false`).

### 4.2 The 8-continuation cap

VERIFIED (R2). The server blocked on nine Stop events in a row (rounds 1 to 9). Claude continued after rounds 1 to 8 and **ended the turn after the ninth block**
(`terminal_reason: completed`, `num_turns: 11` = 3 turns before the first Stop + 8 continuations; the text `Reply with the single word FOXTROT9` was added as feedback but no model call followed).
This matches DOCS (hooks page, Stop input): "after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block and ends the turn. The count of consecutive continuations resets each time Claude calls a tool"; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it (UNVERIFIED, not run).
Consequence: a server that answers `block` must not assume a continuation follows. After eight blocks without a tool call in between, the ninth is ignored and no further hook event arrives for that turn.

### 4.3 Exit code 2 compared with JSON

VERIFIED (R2, `$S/bin/stop-exit2.sh` exits 2 on its 4th call with `Reply with the single word DELTA and nothing else.` on stderr and a decoy JSON on stdout).
Exit code 2 **also blocks** and continues the turn; stderr is the reason and the stdout JSON is ignored. The feedback text differs from the JSON form, it contains the hook command:

```
Stop hook feedback:
["<S>/bin/stop-exit2.sh"]: Reply with the single word DELTA and nothing else.
```

The hook shows as `outcome: error`, `exit_code: 2` in the hook events. Other non-zero exits are **non-blocking errors**: in R2 a curl hook that exited 7
(connection refused) and http hooks that got a 401, a 500 or a refused connection were reported as errors and the run went on normally (hook events `outcome: error`, messages
`HTTP 401 from <url>`, `HTTP 500 from <url>`, `connect ECONNREFUSED 127.0.0.1:9`, `curl: (7) Failed to connect to 127.0.0.1 port 9 ...`).
Prefer the JSON reply: the model sees only your text, not the command line.

A third reply form also continues the turn (VERIFIED, R2 round 5): `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"<text>"}}`. It reaches the model as
`<system-reminder>\nStop hook additional context: <text>\n</system-reminder>`, counts against the same cap, and Stop hook feedback is not shown as an error. `{}`, an empty body and exit 0 with no output all mean "let it stop".

### 4.4 How long a hook may take

| Fact | Status |
|---|---|
| Default timeout for `command`, `http` and `mcp_tool` hooks is 600 s | DOCS. R1 consistent: a hook with no `timeout` ran 65 s on PostToolUse (`finished with status 0 (65039ms)`) and blocked the next step the whole time |
| On `UserPromptSubmit` the default is **30 s** | VERIFIED R1: `Hooks: UserPromptSubmit [sleep-hook.sh 35 ups-default] timed out after 30000ms (30046ms)`. The hook was killed (no "end" line), the prompt went on |
| `timeout` is per handler, in seconds | VERIFIED R1: `"timeout": 2` gave `timed out after 2000ms (2041ms)`; the hook was killed, claude continued, hook event `outcome: cancelled` |
| `SessionEnd` hooks share a 1.5 s budget; a handler with a larger `timeout` raises it | VERIFIED R1: a 3 s hook with no timeout was `cancelled` (stderr line `SessionEnd hook [...] failed: Hook cancelled`); a 3 s hook with `"timeout": 5` finished and claude waited for it before exiting |
| A hook blocks claude until it returns (unless `async`) | VERIFIED R1 (65 s hook), R10 for the async form |
| `async: true` / `asyncRewake: true` hooks | see section 10.1 |

Hook durations in the debug log: a curl hook 14 to 15 ms, a node hook 41 to 43 ms, the owner's bash hook 19 to 29 ms (R1, R2). Use `--debug-file <path>` to get lines such as
`Hooks: PostToolUse:Bash [<command>] timed out after 2000ms (2041ms)` (VERIFIED).

---

## 5. Forwarding hooks to a server

### 5.1 The test server

`$S/server/server.mjs`, plain `node:http`, listening on `127.0.0.1:47831`. Hook route `POST /hook/<transport>/<event>`: checks
`Authorization: Bearer <token>` (401 otherwise), logs the JSON body, replies `{}` or a Stop block. MCP route `POST /mcp` (section 6). All of it logged to `$S/logs/server.jsonl`
(this file holds the R2 and R9 requests; the R1 server log is `server-r1.jsonl`).

### 5.2 curl hook with a Bearer header from an environment variable

VERIFIED (R2, Stop round 1 and every UserPromptSubmit). The settings entry:

```json
{ "type": "command", "timeout": 15,
  "command": "curl -sS --max-time 8 -X POST -H \"Authorization: Bearer $GONOGO_TOKEN\" -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:47831/hook/curl/Stop" }
```

claude was started with `GONOGO_TOKEN=tok-test-7f3a9c` in its environment. The server logged `auth=ok`. Whatever curl prints on stdout is the hook's stdout, so the server's
`{"decision":"block","reason":"Reply with the single word ALPHA and nothing else."}` was **honoured as the Stop reply**: claude continued and the model answered `ALPHA`.

### 5.3 Is the command run through a shell, and how is quoting done

VERIFIED (R1). Shell-form commands run as `/bin/sh -c "<command string>"`. The probe command printed `SH0=/bin/sh BASH_VERSION=3.2.57(1)-release` and
`ps` showed `/bin/sh -c echo "SH0=$0 ..."` with the claude process as its parent. Consequences, all VERIFIED by the commands above:

- `$VAR` and `${VAR:-default}` inside `command` are expanded by sh, not by claude (`${RUNLABEL:-x}` in the command strings of `settings-sess.json` and `settings-rewake.json` became `r3`, `r4`, ... in R3 to R6, R9 and R10).
- A path with a space must be double-quoted inside the command string, so in JSON it is `"command": "\"/path with space/x.sh\" arg"`. Generate settings with `JSON.stringify`, never by hand.
- On Debian-like Linux `/bin/sh` is dash: write POSIX sh only (UNVERIFIED, I ran macOS only).
- The exec form (`command` plus `args`) never goes through a shell and needs no quoting (R2: absolute node path in `command`, a path with a space in `args[0]`, worked, 41 ms).

### 5.4 Node forwarder (one file) and native http hook

The one-file forwarder that worked in R2, as a shell-form command (`"\"<node>\" \"$S/bin/hook-fwd.mjs\" http://127.0.0.1:47831/hook/nodeshell/UserPromptSubmit"`) and as an
exec-form command (`"command": "<node>", "args": ["$S/bin/hook-fwd.mjs", "http://127.0.0.1:47831/hook/node/Stop"]`). The Stop round 2 block (`BRAVO`) came through the exec form:

```js
// $S/bin/hook-fwd.mjs  (prints the response body only on HTTP 200; exits 0 on any failure so it never blocks)
import http from 'node:http';
const url = new URL(process.argv[2]);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request(url, { method: 'POST', timeout: 5000, headers: { 'content-type': 'application/json',
      'content-length': body.length, authorization: `Bearer ${process.env.GONOGO_TOKEN ?? ''}` } }, (res) => {
    const out = [];
    res.on('data', (c) => out.push(c));
    res.on('end', () => { if (res.statusCode === 200) process.stdout.write(Buffer.concat(out)); process.exit(0); });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => process.exit(0));
  req.end(body);
});
```

Native http hook, VERIFIED (R2, Stop round 3 `CHARLIE` and every PreToolUse/PostToolUse/SessionEnd):

```json
{ "type": "http", "url": "http://127.0.0.1:47831/hook/http/Stop", "timeout": 10,
  "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] }
```

- The 2xx JSON body is the hook output, same schema as a command hook's stdout. A Stop block returned this way continued the turn.
- `$GONOGO_TOKEN` is replaced from the claude process environment **only if listed in `allowedEnvVars`**. VERIFIED: without that list the same header went out as `Bearer ` and the server saw `auth=bad("Bearer")` and answered 401, and claude reported `HTTP 401 from <url>` as a non-blocking error.
- Failures never block: 401, 500 and a refused connection were all non-blocking errors (section 4.3).
- Not supported for `SessionStart` (section 1.1). The reply to an http hook should be `{}` or an empty body; DOCS: a 2xx body that is not a JSON object is an error.
- DOCS and binary strings, not run: http hooks refuse addresses that are not public or loopback ("Loopback (127.0.0.1, ::1) is allowed for local dev", message `HTTP hook blocked`), and
  they go through `HTTPS_PROXY`/`HTTP_PROXY` unless the host is in `NO_PROXY`. Use the literal `127.0.0.1` (not `localhost` and not a LAN address) and add `NO_PROXY=127.0.0.1` to the agent's environment. UNVERIFIED because no proxy or LAN address was tried.

### 5.5 Recommendation

**Use the native `http` hook for every event except `SessionStart`.** It starts no process, needs no shell, no quoting and no dependency, and its failures never block. For `SessionStart`
(only if the builder wants "process is up") and as a fallback, use the **one-file Node forwarder in exec form with the absolute node path** (`process.execPath` of the gonogo server), not curl:

- curl has to be installed (I did not check slim Node Docker images; the image is yours to control, the `npx` path is not) and it needs shell quoting around the Bearer header and the URL.
- A curl failure other than exit 2 is a harmless non-blocking error (VERIFIED: exit 7), but curl's exit code 2 means "failed init" (curl man page, not run) and 2 is the blocking code on Stop, so curl should be wrapped in `|| true` to fail open. The Node script exits 0 on every failure by construction.
- curl was faster (about 15 ms against about 42 ms for node) but the difference is irrelevant next to a model call.

---

## 6. MCP over HTTP

### 6.1 The server

`$S/server/server.mjs`, `@modelcontextprotocol/sdk` 1.32.2, **stateless streamable HTTP**: a new `McpServer` and a new `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per POST.
Tested offline first with the SDK client, then by claude (R1, R2, R9). The core:

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function buildMcp() {
  const s = new McpServer({ name: 'gonogo', version: '0.0.1' });
  s.registerTool('send_message', { description: 'Send a message to another agent, the boss, or the user.',
    inputSchema: { to: z.string(), subject: z.string(), body: z.string() } },
    async (args, extra) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, from: extra.authInfo?.clientId }) }] }));
  s.registerTool('list_roster', { description: 'List every agent in the office with name, role and state.' },   // no inputSchema: handler gets (extra)
    async (extra) => ({ content: [{ type: 'text', text: JSON.stringify([{ name: 'ana', role: 'dev', state: 'idle' }]) }] }));
  return s;
}
// in the HTTP handler, for POST /mcp after checking `Authorization: Bearer <token>`:
const mcp = buildMcp();
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
res.on('close', () => { transport.close(); mcp.close(); });
req.auth = { token: 'redacted', clientId: '<agent resolved from the token>', scopes: [] };   // shows up as extra.authInfo
await mcp.connect(transport);
await transport.handleRequest(req, res, parsedJsonBody);
// GET and DELETE /mcp -> 405 JSON-RPC error (stateless). Missing/wrong token -> 401.
```

VERIFIED facts about it: `tools/list` returns `list_roster` with `inputSchema {"type":"object","properties":{}}` (no fields) and `send_message` with required `to`, `subject`, `body`;
a request without a session and without `initialize` works in stateless mode; the handler sees the caller through `extra.authInfo.clientId` (set from the token) and the raw header
through `extra.requestInfo.headers.authorization`, so the server can stamp `from` itself (R2 log: `from=ana`).

What claude sent to it (R2 server log, `User-Agent: claude-code/2.1.325 (sdk-cli)`, `Accept: application/json, text/event-stream`), in order: `POST server/discover`, `POST initialize`,
`POST notifications/initialized`, `GET /mcp` (an SSE stream attempt, my server answered 405 and claude carried on), `POST tools/list`, then one `POST tools/call` per tool call. The debug
file says `Successfully connected (transport: http) in 20ms` and `negotiatedProtocolVersion: 2025-11-25`.

### 6.2 The config JSON and the flags

Exact `--mcp-config` file used in R2 (the header is expanded from the claude process environment; R2 was started with `GONOGO_TOKEN=tok-test-7f3a9c`):

```json
{ "mcpServers": { "gonogo": { "type": "http", "url": "http://127.0.0.1:47831/mcp", "headers": { "Authorization": "Bearer ${GONOGO_TOKEN}" } } } }
```

VERIFIED: the server logged `auth=ok` for every request, so `${GONOGO_TOKEN}` was expanded. A literal token (`"Bearer tok-test-7f3a9c"`) also worked (R1, and as an inline JSON string in `--mcp-config` in R9).
`type` must be present (`http`; `streamable-http` is an accepted alias, DOCS). DOCS: `url` with no `type` is read as stdio and skipped; skipped entries appear in `system/init` under `mcp_server_errors`. Names such as `ANTHROPIC_API_KEY`
or `NPM_TOKEN` are not expanded in remote `url`/`headers` (DOCS), so use a name like `GONOGO_TOKEN`.

Command line (R2):

```
command claude -p "<prompt>" --model haiku --permission-mode manual --settings "$S/settings-r2.json" \
  --strict-mcp-config --mcp-config "$S/mcp-r2.json" \
  --allowedTools "mcp__gonogo__send_message" "mcp__gonogo__list_roster" \
  --output-format stream-json --verbose --include-hook-events --debug-file "$S/logs/r2-debug.log" --max-budget-usd 1
```

`--mcp-config` and `--allowedTools` take several values, so the prompt goes first (or they are followed by another `--flag`).

### 6.3 Tool names and approval

The `system/init` message of R2 listed exactly `mcp__gonogo__list_roster` and `mcp__gonogo__send_message` (form `mcp__<server>__<tool>`, where `<server>` is the key under `mcpServers`; my server also reports itself as `gonogo`, so a mismatch between key and reported name was not tested).
`mcp_servers` showed `{"name":"gonogo","status":"connected","source":"dynamic"}`.

Pre-approval, VERIFIED in `-p`:

- R2, `--permission-mode manual` (alias of `default`), `--allowedTools mcp__gonogo__send_message mcp__gonogo__list_roster`: both tools ran, `permission_denials: []`, nothing asked.
- R1 as the control, `--permission-mode default`, `--allowedTools "Bash(echo hi)" mcp__gonogo__list_roster` only: `list_roster` ran; `send_message` was **denied** with
  `Claude requested permissions to use mcp__gonogo__send_message, but you haven't granted it yet.` and `PermissionRequest` fired for it. So the exact name is what approves a tool, and an unapproved one is denied, not run.

In an interactive session an unapproved tool would prompt instead of being denied; the approval rule is the same rule set (DOCS), but I did not run it interactively (UNVERIFIED).
In `bypassPermissions` mode allow rules have no effect (DOCS) and everything runs.
One more behaviour seen in R9: after `--resume`, the model called `ToolSearch` first and then the MCP tool; `ToolSearch` needed no approval.

### 6.4 `--strict-mcp-config`

**Needed.** VERIFIED by comparing the `system/init` message of two runs from the same user account:

- R1, `--mcp-config` without `--strict-mcp-config`: **600 tools** and 20 MCP servers (every server of the owner's `~/.claude.json`, four servers from plugins, four claude.ai connectors, plus `gonogo`).
- R2, with `--strict-mcp-config`: **28 tools** (26 built-in and the two `gonogo` tools) and one MCP server, `gonogo`.

Without the flag every agent would also start the owner's servers (some failed or needed auth in R1) and carry their tool lists. I found no harm in using it. It also removes plugin-provided and connector servers;
the plugins themselves (their hooks and skills) still load. DOCS: with a project `.mcp.json`, the flag also avoids the per-server approval prompt in interactive sessions (needs v2.1.246 or later).
`--setting-sources project,local` had a similar effect on user-scope servers (R3: `mcp_servers: []`), but a project's `.mcp.json` is a project-scope source, so I expect it still loads (not tested). It is not a substitute for `--strict-mcp-config`.

---

## 7. Sessions

All VERIFIED unless marked.

- **First start**: `--session-id <uuid>` (R3). The `system/init` message and every hook payload carried that id. The id must be a valid UUID (`Invalid session ID. Must be a valid UUID.` string in the binary, not run).
- **Later starts**: `--resume <same uuid>` in the same directory (R4, R5, R6): same `session_id`, hook `SessionStart.source` = `"resume"`, and the conversation was restored (a hidden fact stated only in the first run's system prompt was still known, section 9).
- **`--session-id` reused for an existing session** (R7): fails immediately with exit code 1, nothing on stdout, and on stderr:
  `Error: Session ID 4d5c7c1e-98e7-4880-ba17-77fcfeae2deb is already in use.` The transcript was not touched. The session was not running, it simply existed on disk, so `--session-id` works only once per id.
- **`--resume` with an id that does not exist** (R8): exit code 1, nothing on stdout, stderr: `No conversation found with session ID: 86cc7f8c-059d-48b6-866b-2cd486990c7b`. No transcript file was created.
- **Where the transcript is stored**: `~/.claude/projects/<project>/<session-id>.jsonl`, file mode 0600, where `<project>` is the working directory path with every character that is not a letter or digit replaced by `-`.
  Example from R3 (names changed): cwd `/tmp/.build-7/-x/proj-b` became `-tmp--build-7--x-proj-b`. The same path is in the hook field `transcript_path`.
  DOCS: `CLAUDE_CONFIG_DIR` moves the whole tree (the Docker state volume), `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234 or later, needs `CLAUDE_CONFIG_DIR`) sets the directory name, names over 200 characters are truncated and hashed, default retention 30 days (`cleanupPeriodDays`).
- **`--resume` from a different directory** (R9, resumed from `proj-a` a session started in `proj-b`): it worked. `init.cwd` and the hook `cwd` were the new directory, the model remembered the conversation, and the
  transcript stayed in the **original** project directory (appended to; no copy in the new one). DOCS: the id is looked up in the current project and then in every other project, and it resolves only if exactly one other project holds it. So "Edit working directory, then restart" works with `--resume`.
- Resume restores model and history. It does **not** restore `--settings`, `--mcp-config`, `--add-dir` (DOCS). I passed `--permission-mode` explicitly on every resume and it was applied each time (R4 `acceptEdits`, R5 `dontAsk`, R6 `plan`, R9 `acceptEdits`);
  whether it is restored when omitted was not run. DOCS: an interactive resume restores the previous mode, `-p` does not.
- UNVERIFIED: an interactive agent that was started and then stopped before any prompt may have no transcript yet, and then `--resume` would fail with "No conversation found" while `--session-id` would still be correct. Decide first-start versus resume from the existence of `<id>.jsonl`, or retry with the other flag when the process exits with code 1 within seconds.
- DOCS (inferred): `/clear` saves the previous session and starts a new one (hook `SessionStart.source: "clear"`, `SessionEnd.reason: "clear"`), so the session id in hook payloads should change after it. If gonogo keys agents by `session_id`, update the stored id from hook payloads, or key by the per-agent URL/token. UNVERIFIED (interactive).
- DOCS: when a long conversation is resumed after a long break an interactive "Resume this conversation?" dialog can appear. A pty-driven launcher cannot see it coming. UNVERIFIED (interactive).

---

## 8. Permission modes

- Accepted values of `--permission-mode` in this version. `command claude --help` prints `(choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")`. It lists `manual` where older versions listed `default`; **`default` is still accepted**
  and `manual` is its alias (DOCS cli-reference, and VERIFIED below). `claude doctor` accepts these values for `permissions.defaultMode`: `acceptEdits, auto, bypassPermissions, default, dontAsk, plan` (no `manual` in settings files).
- Ran with each value (hook field `permission_mode` and `system/init` `permissionMode` confirm what claude used):

| Value passed | Run | `permission_mode` seen in hooks |
|---|---|---|
| `default` | R1 | `default` |
| `manual` | R2 | `default` (alias) |
| `bypassPermissions` | R3 | `bypassPermissions` |
| `acceptEdits` | R4, R9 | `acceptEdits` |
| `dontAsk` | R5 | `dontAsk` |
| `plan` | R6 | `plan` |
| `auto` | not run | UNVERIFIED. Listed by `--help` and accepted by `claude doctor`, but no run was left for it, and it depends on account and model eligibility (DOCS) |

- **`bypassPermissions` in `-p`: no extra step.** VERIFIED (R3): `--permission-mode bypassPermissions` alone, no `--allow-dangerously-skip-permissions`, no confirmation, and a `touch` outside the working directory ran (the file exists).
  `--dangerously-skip-permissions` is the equivalent flag (DOCS).
- **Interactive one-time confirmation**: DOCS (permission-modes page): the first interactive start with the mode shows a warning dialog; accepting it writes `"skipDangerousModePermissionPrompt": true` to `~/.claude/settings.json`, declining exits, and using `--setting-sources` without `user` can make the dialog appear again.
  In Docker with a fresh volume the dialog will appear in the agent's terminal until that key exists. UNVERIFIED: no interactive run, and whether the key is honoured from a `--settings` file is unknown.
- **Root**: DOCS: on Linux and macOS claude refuses to start in `bypassPermissions` mode as root or under `sudo` (message `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`;
  the string is in the binary), except inside a recognised sandbox. Not run (I did not run as root); the process of R3 ran as uid 501.
- The mode a **new interactive session** starts in when no flag is given is `auto` on v2.1.283 or later when the account is eligible, otherwise the setting `permissions.defaultMode` (DOCS). A `-p` run with nothing set starts in manual/default from v2.1.302. So **always pass `--permission-mode`**, including for the hire form's "default" choice.

---

## 9. Role text: `--append-system-prompt`

**A 4 KB role text is accepted and works.** VERIFIED (R3): `--append-system-prompt "$(cat role-a.txt)"`, 4321 bytes, no error. The two facts hidden in it were codeword B in the middle and codeword A in the last paragraph. The model answered `ZEBRA-42` (codeword A) when asked, so the text was processed to its last line.

**It is recorded once and reused on resume; it is not needed on later starts, and a changed text is ignored unless snapshots are turned off.** This is new behaviour (flag `--system-prompt-snapshot`, DOCS: v2.1.257 or later, default `on`). VERIFIED with three resumes of the R3 session, each asking for a codeword that exists only in one role text:

| Run | Flags on the resume | Question | Answer | Meaning |
|---|---|---|---|---|
| R4 | none for the system prompt | codeword B (only in the first role text, never revealed in the conversation) | `OTTER-17` | the first role text is still in effect without any flag |
| R5 | `--append-system-prompt "<text that defines codeword C>"` | codeword C | `none` | the new text was ignored |
| R6 | `--append-system-prompt "<text that defines codeword D>" --system-prompt-snapshot off` | codeword D | `LYNX-58` | with snapshots off the new text takes effect |

Where it is kept: the transcript holds an attachment of type `prompt_snapshot` with the whole rendered system prompt, including the role text (VERIFIED: two entries, each 15277 characters, each containing `OTTER-17` and neither containing the later texts). So a role text is readable from the transcript file.

Consequences:

- **The design's "Edit ... changes apply at the next restart" is false for the role text with default flags.** Pass `--system-prompt-snapshot off` together with `--append-system-prompt` on every start, or start a new session when the role changes.
  Cost seen in R6: the changed prompt invalidated the prompt cache for that first request (`cache_creation_input_tokens` 13649 against 154 in R5; client-side cost estimate $0.060 against $0.004). Whether `off` with an **unchanged** text keeps hitting the cache across restarts was not tested (UNVERIFIED).
- DOCS: the record is used "until the conversation is compacted"; after compaction the prompt is rebuilt from the flags of the current launch. A launcher that omits `--append-system-prompt` on resume would lose the role after the first compaction. Pass it every time.
- `--append-system-prompt-file <path>` exists (DOCS cli-reference); I did not run it. It would keep the role text out of `ps` output, which the inline flag does not (section 3).

---

## 10. Everything else a launcher author would regret not knowing

1. **An async-rewake hook can start a turn on an idle session. This could replace typing into the terminal.** VERIFIED in R10, in `claude -p --input-format stream-json` with stdin kept open (the session is idle between messages):
   a Stop hook with `"asyncRewake": true` (`{"type":"command","command":"\"$S/bin/rewake.sh\"","asyncRewake":true,"timeout":60}`) started in the background when the first turn ended (the first `result` message arrived at once, +1.9 s).
   Six seconds later the script exited with code 2 and `Reply with the single word WOKEN and nothing else.` on stderr. With no input on stdin, claude **started a new turn at +8.2 s** and answered `WOKEN` (second `result` at +10.1 s).
   The new turn fired `UserPromptSubmit` whose `prompt` field was
   `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": Reply with the single word WOKEN and nothing else.\n\n</system-reminder>`,
   had a new `prompt_id`, and its Stop had `stop_hook_active: true`. The timeline is in `$S/logs/r10.timeline.txt`.
   Design relevance: a gonogo Stop hook can start a long-poll (for example a Node script that waits on the server) and exit 2 with the message when mail arrives; claude wakes by itself, with no pty typing and no multi-line paste problem.
   UNVERIFIED in the interactive TUI, which may queue it differently. DOCS say the same thing for idle sessions ("an asyncRewake hook that exits with code 2 wakes Claude immediately even when the session is idle"), and that `timeout` is still enforced on such hooks, so the waiter has to be restarted (for example from the next Stop).
2. **The server must not rely on a `block` reply continuing the turn** (the 8-continuation cap, section 4.2), and it will not get a `UserPromptSubmit` for the continuation (R2: one UserPromptSubmit for nine Stops). Set the agent to working yourself when you answer `block`; the next event is PreToolUse, PostToolUse, MessageDisplay or Stop.
3. **Hooks of the owner's other settings run in every agent.** In the owner's setup that means two global hooks, four plugins' hooks (R1: they injected extra context into the conversation), project hooks of the agent's working directory, and 600 tools without `--strict-mcp-config`. `--setting-sources project,local` is the one-flag isolation (section 1.5); it also removes the owner's permission rules and env block. Make it an option.
4. **Hooks are held back until the folder is trusted in an interactive session; `-p` skips the trust dialog.** DOCS (hooks page, Workspace trust). This is why my `-p` runs could not show the first-run behaviour the design lists as a risk. UNVERIFIED.
5. **`Stop` does not fire when the user interrupts with Esc** (DOCS). A floor that marks an agent "working" on UserPromptSubmit and "idle" on Stop can stay "working" after an interrupt. UNVERIFIED (no interactive run, and `-p` has no Esc).
6. **`SessionEnd` is not usable as "stopped"**: 1.5 s budget, `reason: "other"` at exit, and the hook was `cancelled` when it took 3 s (R1). Use the pty exit.
7. **Non-blocking hook failures do not stop the run, and nothing tells the user in `-p` except logs.** They show in the `--debug-file` output, in the stream-json hook events, and (R1) as a stderr line for a cancelled SessionEnd hook. Debug with `--debug-file <path>` and, under `-p`, `--output-format stream-json --verbose --include-hook-events` (events `hook_started`, `hook_response` with `outcome`, `exit_code`, `stdout`, `stderr`; for http hooks `exit_code` carries the HTTP status).
8. **`command claude doctor`** validates `.claude/settings.json` and `.claude/settings.local.json` of the current directory and lists the valid hook event names. It costs no model call, so it is a cheap check for a generated settings file (copy it to a probe project, section 1.5).
9. **Variables claude sets for its children** (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, ...) will be inherited by an agent if the gonogo server itself was started from a Claude Code terminal. I found no "nested session" refusal (the strings are not in the binary and I did not run an inherited-variable test, because the job told me to remove them first), but remove `CLAUDECODE` and the session-identity variables from the child environment.
   Do not blanket-remove `CLAUDE_CODE_*`: the Docker design signs in with `CLAUDE_CODE_OAUTH_TOKEN`, which must stay. My runs removed all of them and still authenticated (the owner's login is in the keychain, `apiKeySource: none`), so this was no test of the token path.
10. **`--allowedTools`, `--mcp-config` and `--setting-sources` are variadic or comma lists.** In `-p` put the prompt first. For the interactive launcher the prompt is not on the command line, so the order only matters between flags.
11. **A claude started in a directory with a `CLAUDE.md` fires `InstructionsLoaded` and loads it** (R1). Agent memory files are yours; the project's own `CLAUDE.md` is also read.
12. **Runs are cheap**: ten haiku runs cost about $0.16 by claude's own client-side estimate (`total_cost_usd`; two of them were error paths that made no model call).

---

## 11. Left to the builder: what these facts settle, and what they force

The design's list reads: "Exact Claude Code flags and hook formats ... (settings file, hook events and replies, tool server config, session id and resume, permission mode, extra system prompt, pre-approved tools)", then the pty library, WebSocket format, tool server library, client state store, buffer sizes, default port, multi-line typing, desks and avatars, repository layout.

**Settled (VERIFIED, `claude` 2.1.325, `-p`):**

| Item | Where |
|---|---|
| settings file for hooks, per-agent, passed with `--settings` | 1.1, 1.5 |
| hook events, their stdin, and their replies (Stop block, exit 2, additionalContext) | 1.2, 2, 4 |
| tool server config (`--mcp-config`, HTTP, Bearer, env expansion), tool names, `--allowedTools`, `--strict-mcp-config` | 6 |
| session id and resume, errors, transcript location, resume from another directory | 7 |
| permission mode values, bypass in `-p` | 8 |
| extra system prompt, 4 KB, resume behaviour | 9 |
| tool server library: `@modelcontextprotocol/sdk` 1.32.2 in stateless mode works with claude | 6.1 |

**Not settled:** pty library, WebSocket format, client state store, buffer sizes, default port, desks and avatars, repository layout and build. **How a multi-line message is typed into the terminal** is not settled either; section 10.1 gives a route that avoids typing for idle agents (not yet checked interactively).

**Design changes these facts force or strongly suggest**

Forced:

1. **Role edits do not apply on restart by default.** The design says Edit changes apply at the next restart. For the role text that is only true with `--system-prompt-snapshot off` on every start (section 9), or with a new session id. Decide which; the cost of `off` is a prompt-cache miss when the text changed.
2. **Session id bookkeeping.** `--session-id` works once and fails for an existing session, `--resume` fails for a missing one (section 7). The launcher needs a "has started" flag or a transcript check per agent, and should fall back to the other flag on an immediate exit code 1.
3. **Every start passes every flag again**: `--settings`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--permission-mode`, `--append-system-prompt`. `--strict-mcp-config` is mandatory, not optional (600 tools against 28).
4. **The Stop-hook delivery rule must handle claude's 8-continuation cap** (section 4.2): after eight blocks with no tool call between them, a ninth block is ignored and the agent really goes idle with messages still queued. The design's own hop cap of 8 is a different counter; the two should not be confused. The server also gets no UserPromptSubmit for a continuation.
5. **Hook transport**: the design's "hooks (HTTP POST)" is supported natively (`type: "http"`), except for SessionStart. No curl or helper script is needed for the six other events. Use `127.0.0.1` in the URLs.

Suggested:

6. **Delivery to idle agents through an async-rewake Stop hook instead of typing** (section 10.1). If an interactive check confirms it, it removes the "typed into a terminal showing a permission prompt" anti-goal for idle recipients and makes the multi-line typing question moot. The hook has to be re-armed after its `timeout` and after each wake.
7. **State signals**: add `PermissionRequest` (verified to fire when a tool needs approval, before the decision) and `Notification` (not triggerable in `-p`, so unverified) to "needs you", `StopFailure` to the idle path, and treat `PostToolBatch` and `MessageDisplay` as working heartbeats. SessionEnd is not a "stopped" signal.
8. **Identify the agent from the per-agent hook URL or token, not from `session_id`**, because `/clear` changes the session id (DOCS).
9. **Isolation option**: `--setting-sources project,local` gives a clean agent but drops the owner's permission rules and env; keep it off by default and expose it as an option.
10. **Docker**: first interactive start with `bypassPermissions` shows a one-time warning unless `skipDangerousModePermissionPrompt` is already true in the container's settings (DOCS). Seed it in the image or document it. Root is refused (DOCS), so the non-root user in the design is required.

---

## Appendix A: the runs

All `claude -p`, `--model haiku`, `--max-budget-usd 1`, started through `$S/bin/runc.sh <cwd> <outprefix> <claude args>` (variables removed with `env -u`, then `command claude`; stdin from `/dev/null`) except R10. Ten runs, the budget.
Total client-side cost estimate $0.1553. `$S/logs/<run>.out|.err|.exit|.time|.unset` hold the raw results. Non-model claude invocations (not counted): `command claude --version`, `command claude --help`, and eight `command claude doctor` runs.

| Run | Directory | What | Key flags | Result |
|---|---|---|---|---|
| R1 | `proj-a` (has `.claude/settings.json`, `settings.local.json`, `CLAUDE.md`) | all seven events plus extras, env, shell, timeouts, project and user hooks, MCP without strict, negative approval | `--permission-mode default --settings settings-r1.json --mcp-config mcp-r1.json --allowedTools "Bash(echo hi)" mcp__gonogo__list_roster --output-format stream-json --verbose --include-hook-events --debug-file`, env `GONOGO_TEST_VAR` and `GONOGO_TOKEN` | exit 0, 112 s, $0.0108 |
| R2 | `proj-b` | transports (http, curl, node shell, node exec, exit-2 script), Stop block rounds 1 to 9, cap, MCP strict with env-expanded header | `--permission-mode manual --settings settings-r2.json --strict-mcp-config --mcp-config mcp-r2.json --allowedTools mcp__gonogo__send_message mcp__gonogo__list_roster --output-format stream-json --verbose --include-hook-events --debug-file`, env `GONOGO_TOKEN` | exit 0, 13 s, $0.0087, 11 turns |
| R3 | `proj-b` | first start with `--session-id`, 4321-byte role text, bypass | `--session-id <U1> --append-system-prompt "$(cat role-a.txt)" --permission-mode bypassPermissions --setting-sources project,local --settings settings-sess.json` | `ZEBRA-42`, file created, $0.0033 |
| R4 | `proj-b` | `--resume U1`, no role flag, ask hidden codeword B | `--permission-mode acceptEdits --setting-sources project,local --settings settings-sess.json` | `OTTER-17`, $0.0038 |
| R5 | `proj-b` | `--resume U1` plus new role text C | `--append-system-prompt "$(cat role-c.txt)" --permission-mode dontAsk` | `none`, $0.0041 |
| R6 | `proj-b` | `--resume U1` plus role text D and snapshots off | `--append-system-prompt "$(cat role-d.txt)" --system-prompt-snapshot off --permission-mode plan` | `LYNX-58`, $0.0599 |
| R7 | `proj-b` | `--session-id U1` reused | `--session-id <U1> --output-format json` | exit 1, `Error: Session ID ... is already in use.`, no model call |
| R8 | `proj-b` | `--resume <random uuid>` | `--resume <missing> --output-format json` | exit 1, `No conversation found with session ID: ...`, no model call |
| R9 | `proj-a` | `--resume U1` from another directory, inline `--settings` and `--mcp-config` strings, strict MCP | `--permission-mode acceptEdits --setting-sources project,local --settings "$SETJSON" --strict-mcp-config --mcp-config "$MCPJSON" --allowedTools mcp__gonogo__send_message mcp__gonogo__list_roster` | `bypass-ok.txt` (history known), `list_roster` ran, $0.0615 |
| R10 | `proj-b` | async-rewake Stop hook waking an idle `--input-format stream-json` session | `-p --input-format stream-json --output-format stream-json --verbose --include-hook-events --permission-mode acceptEdits --setting-sources project,local --settings settings-rewake.json`, driver `$S/drive-rewake.mjs` | woken turn answered `WOKEN`, $0.0033 |

## Appendix B: UNVERIFIED list (and why)

- Notification payload and triggers: not triggerable in `-p`; DOCS only.
- Anything interactive: the workspace-trust gate on hooks, the bypassPermissions warning dialog, Esc interrupts and Stop, the "Resume this conversation?" dialog, whether an async-rewake wake works in the TUI, whether a never-prompted interactive session has a transcript.
- `--permission-mode auto` (not run).
- Root refusal for bypassPermissions (read in docs and as a string in the binary; not run as root, as instructed).
- HTTP hooks and proxies or private addresses (binary strings only); `localhost` instead of `127.0.0.1`.
- `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, `--append-system-prompt-file`, `skipDangerousModePermissionPrompt` from `--settings`, `Notification` matchers.
- `--system-prompt-snapshot off` with an unchanged text keeping the prompt cache, and `off` on the **first** start (R6 used it only on a resume).
- http hooks for `PermissionRequest` and `Notification` as real events (only the command form of PermissionRequest ran).
- Linux and Windows: `/bin/sh` flavour, curl availability in slim images.
- Long or multi-line Stop `reason` values (only one-line reasons were sent).
- What `--resume` does to the permission mode when `--permission-mode` is omitted.

## Appendix C: sources

Documentation read on 2026-11-16: https://code.claude.com/docs/en/hooks, /cli-reference, /sessions, /mcp, /permission-modes, /headless.
Commands: `command claude --version`, `command claude --help`, `command claude doctor` (settings validation), the ten runs above, and read-only inspection of the installed binary's strings for the event list, the HTTP hook rules and the root-refusal message.
