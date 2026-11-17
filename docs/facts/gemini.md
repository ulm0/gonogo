# Gemini CLI facts (checked 2026-11-16)

Verdict: not feasible on this machine now. Stopped at step 1. 0 model prompts ran.

## Commands run
- `which gemini` -> `<node bin dir>/gemini`
- `gemini --version` -> `0.59.0`
- In an empty scratch folder: `gemini -p "reply with the single word ok"` (90 s watchdog; macOS has no `timeout`).
  Exited after 2 s, printed:
  `Please set an Auth method in your ~/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA`

## Meaning
- Installed, not signed in: no auth method configured, none of the three env vars set.
- Per task rules: no login attempted, nothing under ~/.gemini read, no env printed.

## Not verified (all of steps 2a-2f)
Settings path override, MCP over HTTP with env header, hooks, approval modes, role text, resume, TUI behaviour.

## To unblock
Owner signs in (or exports GEMINI_API_KEY) outside gonogo, then rerun this probe.
Note for the builder: the error shows an auth env var could be passed per run, so a per-run key via env may avoid touching ~/.gemini/settings.json; unverified.

# Engine Bay check (2026-11-17)

Still not signed in, so still 0 model prompts. What changed: the adapter was built from what the installed program
says about itself. Read-only: `gemini --help`, `gemini --version` (0.59.0) and the bundled JavaScript under
`<node lib>/node_modules/@google/gemini-cli/bundle/`. Nothing under `~/.gemini` was read or written.

## Found in the bundle
- `GEMINI_CLI_SYSTEM_SETTINGS_PATH` replaces the path of the system settings file (`getSystemSettingsPath`). System
  settings win over user and workspace settings. gonogo points it at `agents/<name>/gemini-settings.json`.
- `GEMINI_CLI_HOME` moves the whole home (and with it the login). Not used for that reason.
- Settings values expand `$VAR` and `${VAR}` from the environment (`resolveEnvVarsInString`), so the MCP header can be
  `Bearer ${GONOGO_TOKEN}`.
- MCP over HTTP: `mcpServers.<name>.httpUrl`, `headers`, `trust` (trust skips the confirmation of its tools).
- Hooks: `hooks.<Event>[].hooks[]` with `type: "command"` only (no HTTP hooks); `hooksConfig.enabled` defaults to true.
  Events: BeforeTool, AfterTool, BeforeAgent, Notification, AfterAgent, SessionStart, SessionEnd, PreCompress,
  BeforeModel, AfterModel, BeforeToolSelection.
- A command hook gets the input as JSON on stdin and runs through the shell with the process environment (redacted
  only when `enableEnvironmentVariableRedaction` is on) plus `GEMINI_PROJECT_DIR`, `GEMINI_SESSION_ID` and a few more.
  Its stdout is parsed as JSON. Default timeout 60 s; `timeout` is in milliseconds.
- Inputs: BeforeTool and AfterTool have `tool_name` and `tool_input`; BeforeAgent has `prompt`; AfterAgent has `prompt`,
  `prompt_response` and `stop_hook_active`; Notification has `notification_type` (`ToolPermission`), `message` and
  `details`. Every input has `session_id`, `transcript_path`, `cwd` and `hook_event_name`.
- AfterAgent with `decision: "block"` (or `deny`) and a `reason` makes Gemini send the reason as a new prompt and go on
  (`agent_execution_blocked`); BeforeAgent fires again for it. This is the same shape as Claude Code's Stop block.
- `ui.showStatusInTitle` puts ◇ (ready), ✋ (action required) or ✦ (working) in the window title. Off by default; not used.

## From `gemini --help`
`--approval-mode default|auto_edit|yolo|plan`, `-i/--prompt-interactive <prompt>` (run a prompt, stay interactive),
`--skip-trust` (trust the workspace for this session), `--session-id`, `--resume latest|<index>`,
`--allowed-mcp-server-names`.

## Still not verified
Everything that needs a model turn: that the hooks reach gonogo through the shim, that the AfterAgent block hands over
mail, that BeforeAgent confirms a typed pointer (and that Enter right after a bracketed paste submits), the permission
dialog keys (Enter for go, Escape for no-go), the auth and trust dialogs at start, and the MCP tools over HTTP.
