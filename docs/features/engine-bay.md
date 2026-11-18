# Engine Bay: other agent CLIs

<EngineBayMock class="doc-mock" />

The hire form's Engine select picks the CLI an agent runs. CLIs on gonogo's `PATH` come first; the rest say
`not installed`. Sign in to each CLI yourself. The engine cannot change after the hire. Design and limits: [`docs/engine-bay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/engine-bay-spec.md).

| Engine | Program | State from | Mail and votes | Role | Permission modes | Checked |
|---|---|---|---|---|---|---|
| Claude Code | `claude` | hooks, title, screen | yes | system prompt | yes | real runs |
| Gemini CLI | `gemini` | hooks | yes | first prompt | `default`, `auto_edit`, `yolo` | its help and source (0.59.0), not run with a model |
| Codex | `codex` | output | yes | first prompt | default, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox` | docs only |
| opencode | `opencode` | output | yes | first prompt | no | docs only |
| Kimi CLI | `kimi` | output | yes | no | no | docs only |
| Copilot CLI | `copilot` | output | yes | no | no | docs only |
| pi | `pi` | output | no | `--append-system-prompt` (the role alone) | no | its help (1.5.2), not run with a model |
| Qwen Code, Grok CLI, Crush, Cursor Agent | `qwen`, `grok`, `crush`, `cursor-agent` | output | no | no | no | docs only |

- **State from hooks** works as for Claude Code. Gemini CLI hooks are `node -e` scripts that post to gonogo with the
  agent's token file. Mail is handed over at the end of a turn. A tool confirmation shows as needs you with GO and NO-GO
  (Enter and Escape; NO-GO sets idle). Not checked with a signed-in Gemini. An Escape or Ctrl-C typed in its terminal
  leaves `working` or `needs you` until its next prompt.
- **State from output:** `working` while it prints, `idle` after 2 seconds of quiet. Such an engine takes no Max Q slot
  and is never tripped by Redline.
- **Mail** goes only to engines with the gonogo tools; without hooks the pointer is typed when the agent is quiet and counts as delivered at once. An
  engine without the tools gets no polls, and a message to it comes back undelivered with
  `<name> runs <engine> without the gonogo tools and cannot receive messages`.
- **Config** files live under `agents/<name>/`, never in your project or the CLI's home; your own CLI settings still
  apply. Gemini CLI: `gemini-settings.json` via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. Codex: `-c mcp_servers.gonogo.*`.
  opencode: `OPENCODE_CONFIG=agents/<name>/opencode.json`. Kimi: `--mcp-config-file agents/<name>/kimi-mcp.json`.
  Copilot: `--additional-mcp-config @agents/<name>/copilot-mcp.json`.
- **Sessions.** Engines other than Claude Code start a new session every time, and the role prompt costs a model turn.
- Propellant counts Claude Code only; the PROPELLANT fold shows only on a Claude console.

## Model

The MODEL field of the hire and edit form is free text with suggestions; empty means the CLI's own default. It is passed as `--model <name>` and applies at the next start. Names are letters, digits and `. _ : / @ + -`, starting with a letter or digit, at most 100; anything else, and a model for an engine without the field, is refused. The suggestions are hints: the CLI judges the name.

| Engine | Suggestions | Flag checked in |
|---|---|---|
| Claude Code | `sonnet`, `opus`, `haiku` | real runs (only `haiku`) |
| Gemini CLI | `auto`, `pro`, `flash`, `flash-lite` | `--help` of 0.59.0 |
| pi | `sonnet`, `haiku` | `--help` of 1.5.2 |
| Codex, Kimi CLI, Cursor Agent | none | their docs, not installed |

opencode, Copilot CLI, Qwen Code, Grok CLI, Crush and the custom command have no field: no model flag was found in what was read. Set the model in the CLI itself.

## Keys (Clearance)

The CLEARANCE fold sets environment variables for one agent, usually API keys such as `OPENAI_API_KEY` or `GEMINI_API_KEY`. It works for every engine and for a custom command.

- **Write only.** A value goes from the form to the server and never back: a saved key reads `SET`. A name typed again replaces its value; REMOVE takes a key away. Applies at the next start.
- **Where.** `keys.json` in the home, mode 0600, plain text. `agents.json` and the page hold the names and the time each was set. A value is in no log line, message, Downlink item, Relay post, answer or error.
- **Names.** Capital letters, digits and `_`, starting with a letter, at most 64; at most 16 per agent. A value is 1 to 4096 printable characters without a space. Names that change what runs are refused: `PATH`, `HOME`, `SHELL`, `TERM`, `NODE_OPTIONS`, `CLAUDE_CONFIG_DIR`, shell and interpreter start-up hooks such as `BASH_ENV` and `PYTHONPATH`, and every `GONOGO_`, `LD_`, `DYLD_`, `DOCKER_` and `GIT_CONFIG_` name (the full list is in the spec).
- **Precedence**, later wins: gonogo's environment without the scrubbed variables (`GONOGO_SCRUB_ENV` and the built-in list); this agent's keys, which the scrub list does not touch; the variables gonogo sets for every agent (`TERM`, `GONOGO_TOKEN`); the engine's own (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `OPENCODE_CONFIG`). In seed mode a key `ANTHROPIC_API_KEY` goes through `apiKeyHelper` like the host's.
- **Clean Room.** The container gets only named variables. `docker run` is given `-e NAME` and docker reads the value from its own environment, so no value is on a command line; the host's other variables never reach the container.
- **Only that agent.** The keys go into that agent's process alone. The agent sees them (`env`), and an agent in `bypassPermissions` runs as you and can read `keys.json`.
- Rename moves the keys with the agent, remove deletes them.

## Pad Check

Under the Engine select the form says whether the program is on the `PATH` of the machine gonogo runs on, with its path and version, and when it is missing the vendor's install command in a field to select, with a COPY button and the vendor's page. `gonogo doctor` prints the same for every engine:

```
ok  Claude Code (claude)  2.1.325 (Claude Code)  /usr/local/bin/claude
--  Codex (codex)  not found
    install: npm install -g @openai/codex
    docs: https://github.com/openai/codex
```

- The version is the first line of `<program> --version`, asked with no shell, 5 seconds at most, and an environment of `PATH`, `HOME`, `LANG` and `NO_COLOR` only, so no key of gonogo's environment reaches it. A program that does not answer is listed without a version.
- Exit 1 when Claude Code is missing and `GONOGO_AGENT_CMD` is not set (gonogo would not start); otherwise 0.
- **gonogo never runs an installer**, from the page or from `gonogo doctor`. The commands are copied from each vendor's page, listed in [`docs/engine-bay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/engine-bay-spec.md); Kimi CLI has none (not checked), and the form links its page. The commands were read, not run.
- The `not installed` marks and the order of the Engine select come from the `PATH` as it was when gonogo started. The note below it asks again each time the hire form opens, so a CLI installed later shows as found there.
