# Spec: Engine Bay

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): other agent CLIs next
to Claude Code. Claude Code stays the default and works exactly as before.

## Intent

Claude Code is built into four places: the launcher (argv, settings, `mcp.json`), the state (hooks), the screen (ready
rule, dialogs, title glyphs) and the delivery (typed pointer, Stop block). Engine Bay lets each CLI say what it has for
those four, and lets the owner pick the CLI in the hire form.

## Design

- **One table, one adapter file.** `PROVIDER_INFO` in `src/shared/protocol.ts` says per provider: label, program
  name, `hooks` (state from hooks), `mcp` (gets the gonogo tools), `modes` (the three permission modes map onto its
  own) and `check` (`run`, `local` or `docs`). `src/server/providers.ts` builds the argv, the extra environment and
  the files of each CLI other than Claude Code and the custom command. Claude Code's code in `launcher.ts` is unchanged;
  a flat file, not a folder, because the pack check allows only `dist/server/*.js`.
- **The hub asks the table, not the provider name.** `hooked` (hooks drive the state, a Max Q slot, the Redline
  detectors), `mailable` (mail, polls, the draft latch) and `isClaude` (the prompt-box, dialog and title rules,
  Propellant, the session id). A provider without hooks gets the custom command's rule: working while it prints,
  idle after 2 s of quiet.
- **Gemini CLI is hook driven through Claude's hook names.** Its per-agent settings file maps BeforeAgent to
  `UserPromptSubmit`, BeforeTool to `PreToolUse`, AfterTool to `PostToolUse`, Notification to `Notification` and
  AfterAgent to `Stop`, so the hub runs one set of rules. Gemini runs command hooks only: each hook runs
  `node -e <shim> <url> <token file>`, which posts a few fields of the hook input to the hub and prints its answer. An
  AfterAgent block with the pointer is Gemini's own way to go on with a new prompt, the same as Claude's Stop block. A
  `ToolPermission` notification sets needs you with Gemini's message. The settings file reaches Gemini through
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, so `~/.gemini` and the project stay untouched and the owner's login is used.
- **Delivery.** Hooked: typed pointer confirmed by `UserPromptSubmit` (Gemini's BeforeAgent), or the Stop block. Not
  hooked but with the tools (Codex, opencode, Kimi, Copilot): the pointer is typed when the output has been quiet and
  counts as delivered at once. No tools: no mail, like the custom command.
- **The role.** With the tools the agent gets the role text with the preamble about them, as its first prompt where the
  CLI has a flag for one (Gemini `--prompt-interactive`, Codex positional prompt, opencode `--prompt`). pi gets the bare
  role through `--append-system-prompt`. The others get no role.
- **MCP config only through a documented per-run way.** Gemini: the settings file. Codex: `-c mcp_servers.gonogo.*`
  overrides (rather than a per-agent `CODEX_HOME`, which would hide the owner's login). opencode: `OPENCODE_CONFIG`.
  Kimi: `--mcp-config-file`. Copilot: `--additional-mcp-config @file`. Kimi and Copilot files hold the token itself
  (mode 0600, written at every start, dead once the process exits), because their variable expansion is not known.
- **Hire form.** An Engine select (every provider but the custom command, which keeps its tile), installed ones first,
  each with `not installed`, `unverified` and `no mail` where they apply, and a hint about state, mail and how far it
  was checked. The server fills `ServerInfo.installed` from its `PATH` once, at start (GONOGO_AGENT_CMD counts for
  claude): a CLI installed later shows as not installed until gonogo restarts. A missing program can still be picked:
  the start then fails with the usual error.
- **Permission modes.** Gemini: default, `auto_edit`, `yolo`. Codex: none, `--full-auto`,
  `--dangerously-bypass-approvals-and-sandbox`. Bypass needs the ticked box for both. The others run in `default` and
  the form hides the modes.
- **Propellant** reads Claude transcripts only (the shim does not forward `transcript_path`); a room limit trips
  Claude agents only. **Max Q** counts agents with hooks (Claude Code, Gemini CLI).
- **Seed mode** passes `--skip-trust` to Gemini (the folder is trusted for that run, nothing is written); nothing else.

## Checked how

| Engine | Program | State | Tools | Check |
|---|---|---|---|---|
| Claude Code | `claude` | hooks | yes | run (unchanged) |
| Gemini CLI | `gemini` | hooks | yes | local: `--help` and the bundled source of 0.59.0, not signed in |
| Codex | `codex` | output | yes | docs |
| opencode | `opencode` | output | yes | docs |
| Kimi CLI | `kimi` | output | yes | docs |
| Copilot CLI | `copilot` | output | yes | docs |
| pi | `pi` | output | no | local: `--help` of 1.5.2 |
| Qwen Code, Grok CLI, Crush, Cursor Agent | `qwen`, `grok`, `crush`, `cursor-agent` | output | no | docs |

Tests use stand-ins: the hub with fake hooks and output counters, the launcher's files and argv, the shim against a
local HTTP server. No other CLI was run against a model. `docs/facts/gemini.md` and `docs/facts/pi.md` say what was
looked at.

## Known limits

- Every start of a non-Claude CLI is a new session (no resume); the role prompt of Gemini, Codex and opencode is a
  model turn at every start.
- Gemini's screen is not read: a startup dialog shows as needs you after 5 s (the Claude rule), and its first hook
  ends it. Whether Enter right after a bracketed paste submits in Gemini is not known; an unconfirmed pointer is held
  as for Claude.
- Gemini's state moves only by its hooks. A turn that ends without AfterAgent (an Escape or Ctrl-C typed in its
  terminal) leaves `working` or `needs you` until its next prompt, and its mail waits that long. NO-GO from the page
  sets `idle` itself, because that Escape ends Gemini's turn.
- A pointer typed into a CLI without hooks is never typed again if it is not read, and nothing confirms it.
- The memory file lies outside the working directory; a CLI may ask before it reads it.
- Gemini's system settings file replaces a system-wide `/Library/Application Support/GeminiCli/settings.json` (or
  `/etc/gemini-cli/settings.json`) for gonogo's agents; the owner's own `~/.gemini/settings.json` still applies,
  including its other MCP servers.
- Codex's `notify` hook is not used: it only reports the end of a turn and cannot hand over mail, and output activity
  already says idle.
