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
- **pi and opencode read their input box from the screen** (`analyzeScreen(rows, cols, engine)`: pi's box is the rows between its lowest two rules, opencode's the bar of `┃` rows above the `╹▀▀` line, its placeholder `Ask anything…` counting as empty). The draft latch of a browser keystroke ends within a second of the box being empty, as it does for Claude Code, so text typed and erased in a console no longer holds the mail for the 30 minutes of DRAFT_EXPIRY_MS. Gemini CLI's screen is still not read.
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
  CLI has a flag for one (Gemini `--prompt-interactive`, Codex positional prompt, opencode `--prompt`); pi gets it in its
  system prompt (`--append-system-prompt`). The others get no role.
- **opencode (2.4, `@opencode/cli`) through a plugin.** opencode 1.x is no longer supported: opencode 2 has another plugin API, config and session store. Every start is `opencode --standalone`
  (a server of its own for the agent, never the shared background service) with `--session <id>` to resume. `src/server/opencodeplugin.ts` writes `opencode.json` (passed with `OPENCODE_CONFIG`:
  `plugin` the plugin directory `gonogo-opencode/` (a package.json and an index.js that default-exports `{ id, setup(ctx) }`), `instructions` `opencode-role.md`, `mcp` with gonogo's server and the Payload and global
  ones, `permission` `"*": "ask"` and each tool, `skills.paths`, the effort as `agent.build/plan.variant`, egress as
  `provider.anthropic.options.baseURL`) and `gonogo-opencode.json` (the hook URL, the server names and the tool gate's policy). The plugin
  posts `session.hook('prompt')` (UserPromptSubmit with the session id, kept as `engineSession`), `tool.hook('execute.before'/'execute.after')`,
  `permission.hook('evaluate')` (the tool gate: it sets `effect` to allow or deny with the rule's words; ask is left to opencode's own question, answered from the console,
  the page or the phone, and passed on as PermissionRequest; a folder outside the project is the agent's own when it is inside `agents/<name>/`),
  `session.hook('experimental.idle')` (Stop; a block is handed over with `session.synthetic` and the turn goes on), the events
  `session.execution.interrupted` (a NO-GO: the turn ends, Stop) and `session.execution.failed` (StopFailure), `session.usage.updated` (the session's running totals, reported as the
  difference), and the `subagent` tool as SubagentStart/Stop (child sessions, which `session.get` says have a `parentID`, kept apart). The database and sessions of an agent live in
  `agents/<name>/opencode-data` (`XDG_DATA_HOME`), the owner's `auth.json` linked in. A switch reads the old session with `opencode session export <id> --standalone` and finds one of an
  older gonogo with `opencode session list --format json`. Checked in real runs of opencode 2.4.1 with its free model (state from hooks, mail at idle and mid-turn, GO and NO-GO of a shell
  command, the agent's own folder).
- **The tool gate** (`src/server/toolgate.ts`): Claude Code's permission order and rule syntax, in one self-contained function copied
  into the extension and the plugin (`GATE_SOURCE`).
- **pi (1.6) through an extension.** `src/server/piextension.ts` writes `gonogo-pi.ts` and `gonogo-pi.json` (0600) into the
  agent's folder and starts pi with `--extension`. The extension registers the gonogo server and the Payload and global servers
  (`pi.registerMcpServer`, every tool `direct`, SSE left out), and posts `session_start` (Notification: the agent is up),
  `before_agent_start` (UserPromptSubmit), `tool_call` / `tool_result` (PreToolUse, PostToolUse(Failure), with Claude's tool names)
  and `agent_before_settle` (Stop, or StopFailure for an aborted or failed run) to the hook URLs with `GONOGO_TOKEN`. A Stop block
  becomes a `custom_message` entry with `continue: true`, pi's own continuation. Sessions: `--session-dir agents/<name>/pi-sessions
  --session-id <sessionId>` (made or resumed). Skills: `--skill <folder>`. Checked in real runs of pi 1.6.0.
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
- **Default permission mode** (`ModelDefaults.mode`, in `models.json`; absent means `default`; `PUT /api/models/mode`
  `{ mode, confirmBypass }`, null clears). It preselects a new hire's mode in the form (an engine without modes
  keeps `default`; Edit never changes an existing agent's mode), and is the mode of a Relief or `hire_agent` request
  that names none. `bypassPermissions` as the room default needs `confirmBypass: true` (400, field `confirmBypass`),
  and is never given to a hire that names no mode: Relief falls back to `default`, and the form still asks for its
  own confirmation. Old files without `mode` load as before. `auto` and `bypassPermissions` are set only from the
  Director's own login (a key or a terminal gets 403) and ask for the password again when the last check is old;
  clearing or a milder mode is free. A models.json that names `bypassPermissions` is read back only with the
  `bypassConfirmedAt` stamp that setting it writes. A Relief request that takes the room's mode shows it on its card
  and Downlink line as "auto (the room's default)"; Security findings list a room whose default is auto or bypass.
- **Propellant** reads Claude transcripts only (the shim does not forward `transcript_path`); a room limit trips
  Claude agents only. **Max Q** counts agents with hooks (Claude Code, Gemini CLI).
- **Antigravity CLI (`agy`)** replaces Gemini CLI for the individual Google tiers (Gemini CLI stays, marked legacy). Started with `--mode accept-edits|auto` or `--dangerously-skip-permissions`, `--model`, `-i <role>`. It reads `hooks.json` and `mcp_config.json` only from the project's `.agents/`, `~/.gemini/config/` and plugins, so until a per-agent location is verified it is an output-activity engine without hooks or tools (like pi). The hook shim and `hooks.json` builder exist and are tested; `docs/facts/antigravity.md` says what was and was not checked. `agy --mode auto` needs its terminal sandbox.
- **Seed mode** passes `--skip-trust` to Gemini (the folder is trusted for that run, nothing is written); nothing else.

## Checked how

| Engine | Program | State | Tools | Check |
|---|---|---|---|---|
| Claude Code | `claude` | hooks | yes | run (unchanged) |
| Gemini CLI (legacy) | `gemini` | hooks | yes | local: `--help` and the bundled source of 0.59.0, not signed in |
| Antigravity CLI | `agy` | output | no | local: `--help` of 1.5.11, not signed in; hooks and tools wait for a per-agent config location (`docs/facts/antigravity.md`) |
| Codex | `codex` | output | yes | docs |
| opencode | `opencode` | hooks | yes | run: 2.4.1 |
| Kimi CLI | `kimi` | output | yes | docs |
| Copilot CLI | `copilot` | output | yes | docs |
| pi | `pi` | hooks | yes | run: 1.6.0 |
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

## Model, Clearance and Pad Check (2026-11-18)

Backlog section 1, "Per-provider model picker, API keys and a CLI installer". The installer is not built: gonogo never runs
one (see Pad Check).

### Model

- `PROVIDER_INFO.model` is `null` (no field) or the names the form suggests (possibly none). Every engine that has a field
  takes `--model <name>`. The hire form's field is free text with a datalist: the names are hints and the CLI judges the
  name, so nothing goes stale.
- Stored as `AgentRecord.model` (absent means the CLI's default) and `AgentView.model`. `MODEL_PATTERN` (letters, digits and
  `. _ : / @ + -`, no leading `-`, at most 100) keeps the value one harmless argument; it is passed as two argv words, never
  through a shell. Claude Code: before `--allowedTools`. Gemini: before `--prompt-interactive`. Codex: before the prompt.
  Kimi, pi and Cursor Agent: in their short argument list. A change is `dirty` until the restart.
- Which engines, and how each was checked:

| Engine | Flag | Checked |
|---|---|---|
| Claude Code | `--model` | real runs (`--model haiku`, `docs/facts/claude-code-hooks-mcp.md`); of the hints only `haiku` was run |
| Gemini CLI (legacy) | `-m, --model` | `gemini --help` of 0.59.0; hints are its aliases from its CLI reference |
| Antigravity CLI | `--model` | `agy --help` of 1.5.11; no hints |
| pi | `--model` | `pi --help` of 1.5.2; hints from its examples |
| Codex | `--model`, `-m` | OpenAI's CLI reference, not installed |
| Kimi CLI | `--model`, `-m` | its command reference, not installed |
| Cursor Agent | `--model` | an example on its CLI page, not installed |

- Left out because no flag was found in what was read: opencode (its CLI page names none), Copilot CLI (the pages read name
  none), Qwen Code, Crush (picks the model inside its screen). Grok CLI names a `GROK_MODEL` variable and a settings file,
  not a flag: not built, because a second way to pass a model would be written from one README. A custom command has none.

### Clearance: keys per agent

- The Director sets environment variables for one agent in the hire and edit form (CLEARANCE fold) or through the API
  (`keys` in `POST /api/agents` and `PATCH /api/agents/:name`: name to value, and in an edit name to `null` to remove).
- **Where.** The values are in `<home>/keys.json` (`clearance.ts`; `{ "version": 1, "agents": { name: { NAME: value } } }`,
  mode 0600, written whole through a temporary file and a rename, one write after the other; a damaged file is kept as
  `keys.json.bad` and gonogo starts without keys). The roster keeps names and the time each was set (`AgentRecord.keys`),
  and `AgentView.keys` carries the same: the page shows SET and never a value. A value is in no frame, answer, log line,
  message, Downlink item or Relay post, and no error repeats one or a badly spelled name. There is no audit log yet (backlog
  section 2); the one to come keeps names only.
- **Rules.** Name: capital letters, digits and `_`, starting with a letter, at most 64. Refused: `PATH`, `HOME`, `SHELL`,
  `USER`, `LOGNAME`, `PWD`, `TMPDIR`, `TERM`, `COLORTERM`, `IS_DEMO`, `NODE_OPTIONS`, `NODE_PATH`, `CLAUDE_CONFIG_DIR`, the
  shell and interpreter start-up hooks (`BASH_ENV`, `SHELLOPTS`, `BASHOPTS`, `PROMPT_COMMAND`, `IFS`, `PYTHONSTARTUP`,
  `PYTHONPATH`, `PYTHONHOME`, `RUBYOPT`, `RUBYLIB`, `PERL5OPT`, `PERL5LIB`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`,
  `GIT_EXEC_PATH`; and, since 0.7.0, `ZDOTDIR`, `GIT_SSH`, `GIT_PROXY_COMMAND`, `GIT_EDITOR`, `GIT_PAGER`, `EDITOR`, `VISUAL` and `PAGER`), and every `GONOGO_`, `LD_`, `DYLD_`, `BASH_FUNC_`, `DOCKER_` and `GIT_CONFIG_` name: a key is data, not a
  way to change what runs (`DOCKER_` because a Clean Room's docker client runs with the keys in its environment). The list is
  the usual start-up hooks, not every variable some program reads as a command. Value: 1 to 4096 printable ASCII
  characters, no space. At most 16 keys per agent. Bad input is 400 with the field `keys`.
- **Order of writes.** Hire: the values first (from none, so a removed agent of the same name leaves nothing), then the
  roster; a roster that cannot be saved takes the values back. Edit: the values just before the roster; a roster that
  cannot be saved puts the values the edit touched back (shortcut: if that write fails too, the new values stay, and the log says so). Rename: `renameAgentFiles` moves the keys with the folder. Remove: they go.
- **Precedence.** The environment of an agent's process is built in this order, later wins: (1) gonogo's own environment
  minus the variables of the built-in scrub list and `GONOGO_SCRUB_ENV`; (2) the agent's keys, which `GONOGO_SCRUB_ENV` does not
  touch (the Director chose them for this agent); (3) the variables gonogo sets (`TERM`, `COLORTERM`, `GONOGO_TOKEN`, `NO_PROXY`
  with the loopback names added, and in seed mode `IS_DEMO`); (4) the variables of the engine's adapter (for example
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH`). In seed mode a key `ANTHROPIC_API_KEY` goes the way the host's does: out of
  `ANTHROPIC_API_KEY`, into `GONOGO_API_KEY` for the `apiKeyHelper`. A Clean Room container gets only named variables: `HOME`,
  `CLAUDE_CONFIG_DIR`, the gonogo ones, the Claude credentials, and the names of this agent's keys; `docker run` gets
  `-e NAME` without a value and docker reads the values from its own environment, so no value is on the command line, and the
  host's other variables never reach the container.
- **Applies at the next start**: the agent is `dirty`, and a key set again counts (its time changes).
- Limits: the file is plain text, so anyone who can read your home, and an agent that runs as you, can read it; an agent also
  sees its own keys in its environment. The Clean Room hides the other agents' keys and the host's variables from that agent,
  not its own.

### Pad Check: is the program there

- `findOnPath` (the PATH scan of `installedProviders`, now returning the path) and `checkEngines`: for each engine but the
  custom command, where it is, and the first line of `<program> --version` (`execFile`, no shell, 5 s, 64 KiB, an
  environment of `PATH`, `HOME`, `LANG` and `NO_COLOR` only, so no key reaches it; cut to 80 characters, control characters
  removed; remembered by path and modification time when it answered).
- `GET /api/engines` (browser token, like the other routes) answers that list; the hire form asks it once when it opens and
  falls back to `ServerInfo.installed` when it fails. `gonogo doctor` prints the same: `ok` lines with version and path, `--`
  lines for a missing program with its install command and page, then a note that nothing is run. Exit 1 only when Claude
  Code is missing and `GONOGO_AGENT_CMD` is not set (the refusal `gonogo` itself makes at start); otherwise 0.
- **No installer runs, from the page or from anywhere.** The install command is text in `PROVIDER_INFO.install`, copied from
  the vendor's own page named in `PROVIDER_INFO.docs`, shown copyable in the form and printed by `gonogo doctor`. Where the
  vendor lists several, the first listed is used. Read on 2026-11-18, not run:

| Engine | Command | Page |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code@latest` (its page also lists a native installer, `brew install --cask claude-code` and others; npm needs only the Node 24 gonogo already needs) | code.claude.com/docs/en/setup |
| Gemini CLI (legacy) | `npm install -g @google/gemini-cli` | its README |
| Antigravity CLI | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (read, not run) | antigravity.google/docs/getting-started |
| Codex | `npm install -g @openai/codex` | its README |
| opencode | `curl -fsSL https://opencode.ai/v2/install \| bash` | its README and docs page |
| Copilot CLI | `curl -fsSL https://gh.io/copilot-install \| bash` | its README |
| Qwen Code | the `install-qwen-standalone.sh` script of its README | its README |
| Grok CLI | `install.sh` of the superagent-ai/grok-cli repository | its README |
| Crush | `brew install charmbracelet/tap/crush` | its README |
| Cursor Agent | `curl https://cursor.com/install -fsS \| bash` | its CLI page |
| pi | `curl -fsSL https://pi.dev/install.sh \| sh` | its README |
| Kimi CLI | none: its README now speaks of another package name, and whether it installs a `kimi` program was not checked | its docs |

- Not checked: that the Grok CLI of that README is the one the adapter's `grok` means, that Cursor's installer puts
  `cursor-agent` on the PATH (its page uses `agent`), and any installer actually running. Commands change; the page link is the
  source of truth.

### Model lists: the names each engine offers (2026-11-24)

The Director's report: the model field only offered the few names in `PROVIDER_INFO.model` (none for opencode), so a model had to
be guessed. Now the server asks the installed program itself where it has a command for it.

- `src/server/enginemodels.ts`. pi: `pi --list-models` (a table; the names are `provider/model`, which pi's `--model` takes).
  opencode: `opencode models --standalone`, one `provider/model` per line; `--standalone` runs a private server that ends with
  the call (plain `opencode models` starts or joins opencode's background service, which outlives the call and writes
  `service.json` into its config folder: here that folder was root's, and the call failed with `PermissionDenied`). Claude Code
  and every other engine: no listing command was checked (Claude Code's `--help` names aliases and "a model's full name", no
  list), so their suggested names (`static`).
- Run like Pad Check: no shell, 20 s, 2 MiB of output and 1000 names at most, its own process group killed at the end (so a
  helper it started does not stay), cwd its `HOME`, and an environment of `PATH`, `HOME`, `LANG`, `NO_COLOR` and the
  `XDG_*` folders only, where both keep their sign-in. Every name must pass `MODEL_PATTERN`.
- Remembered per engine until the program changes (path, modification time, `--version`) or the page asks for a refresh; a
  failure is asked again after 30 s. Two readers at once share one run.
- `GET /api/engines/<engine>/models[?refresh=1]` (browser token) answers `EngineModels`: `source` `cli`, `static`, `missing`
  (not on the PATH) or `error` (with `error`, and the suggested names), the `command` run, the `version` and `at`. 404 for an
  engine without a model field. It is a GET of its own, asked by the page after it has loaded, so it never holds a page up.
- The page asks once per engine for the whole page (`useEngineModels` in `client/models.ts`): the hire and Edit form's MODEL
  field, the MODEL BY ENGINE lines and BY POSITION of DEFAULTS. The field stays free text with the list as its datalist (a
  browser filters it as you type); a line under it says where the names come from (`18 models from pi --list-models (1.6.0)`),
  that the engine is not installed, that it listed none ("is a provider signed in?"), or the error, with a Refresh key.
- Shortcut: a provider an engine knows only from an API key in gonogo's environment (or a room or agent key) is not listed,
  because the listing gets no keys; its model is typed. pi signed out of every provider lists nothing.
- opencode's list holds the providers the owner is signed in to, but an agent runs with its own `XDG_DATA_HOME` (its folder), where
  no sign-in is: a model of another provider than `opencode/` then falls back to opencode's free default without a word (seen in
  #296's run). So the opencode list carries a note, and the hire and Edit form warn (`opencodeKeyWarning`, client/models.ts) when the
  model the agent starts with (its own, else its position's or the room's) has a provider whose key is not among the agent's keys
  and the room's keys that reach it, the names from opencode's models.dev catalog (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...); a
  Clean Room with egress counts for Anthropic. A key in gonogo's own environment cannot be seen by the page: the text says so.
