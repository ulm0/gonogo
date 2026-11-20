# Engine Bay: other agent CLIs

<EngineBayMock class="doc-mock" />

The hire form's Engine select picks the CLI an agent runs. CLIs on gonogo's `PATH` come first; the rest say
`not installed`. Sign in to each CLI yourself. The engine cannot change after the hire. Design and limits: [`docs/engine-bay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/engine-bay-spec.md).

| Engine | Program | State from | Mail and votes | Role | Permission modes | Checked |
|---|---|---|---|---|---|---|
| Claude Code | `claude` | hooks, title, screen | yes | system prompt | yes | real runs |
| Gemini CLI (legacy) | `gemini` | hooks | yes | first prompt | `default`, `auto_edit`, `yolo` | its help and source (0.59.0), not run with a model |
| Antigravity CLI | `agy` | output | no | first prompt | `accept-edits`, `auto`, `--dangerously-skip-permissions` | its help (1.5.11), not run against a signed-in agy |
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
<AgyMock class="doc-mock" />


## Engine, model and effort chips

Every console shows three quiet chips: its **engine**, the **model it starts with** and its **effort**. They are in the head of the console panel (and under the name on a phone), in the CONSOLES list of Flight Rules, and in the terminal client's room list. The model is the one the console will start with: its own, else its position's default (Claude Code), else the room's for its engine, and the chip says so when it is not the console's own (`sonnet · room default`). With none set there is no model chip: the CLI's own default is not something gonogo knows, and it never shows a guess. A model changed with `/model` inside a console does not show: gonogo shows what it will start with.

**Effort** is Claude Code's `--effort` (`low`, `medium`, `high`, `xhigh`, `max`, as `claude --help` lists them). The EFFORT field of the hire and edit form sets it for a Claude Code console; empty uses the room's default effort, then the CLI's own, and the chip shows only a value gonogo will pass. It applies at the next start and is `dirty` until then. `effort` is a field of the hire and edit requests (400 with the field for another level, or for an engine without one). Antigravity lists `--effort` in its help but the levels it takes were not read, so the field is not offered for it; the other engines have no such flag in what was read. `CLAUDE_EFFORT`, which a running `claude` sets for its children, is still scrubbed from agents.

## Defaults of the room

The DEFAULTS block of Flight Rules holds what a console starts with when it has none of its own. **Default engine** preselects the hire form and is the engine of a hire that names none: the hire form, Relief and `hire_agent`. It is never a custom command, and an engine named in the request wins. **Claude Code effort** is the `--effort` of a Claude Code console without one of its own. **Model by engine** and **by position** are the default models below. The chip of a console says which level a model or effort comes from (`opus · position default`, `effort high · room default`). A model or effort applies at each console's next start; a default engine applies to the next hire. The API: `PUT /api/models/engine` with `{ engine }` and `PUT /api/models/effort` with `{ effort }`, each null to clear; 400 with the field for a custom command, an unknown engine or a level that is not one. They live in `models.json` next to the models.

## Model

The MODEL field of the hire and edit form is free text with suggestions; empty means the CLI's own default. It is passed as `--model <name>` and applies at the next start. Names are letters, digits and `. _ : / @ + -`, starting with a letter or digit, at most 100; anything else, and a model for an engine without the field, is refused. The suggestions are hints: the CLI judges the name.

<ModelsMock class="doc-mock" />

**Default models.** FLIGHT RULES has a DEFAULT MODELS block with one line for each engine that takes a model, and a BY POSITION list with one line for each of the 15 positions. A console with no model of its own starts with, in this order: its **position's** model (Claude Code consoles only: a model name does not carry from one engine to another), then its engine's room default; a console's own model always wins. So a reviewer can run on a stronger model than a builder. The defaults are in `<home>/models.json` (names only; `positions` next to `models`), `GET /api/models`, `PUT /api/models/<engine>` and `PUT /api/models/positions/<id>` with `{ "model": "sonnet" }` (`null` clears), and a change applies at each console's next start. The form shows where the value comes from. A `/model` typed inside a console only changes that session: gonogo does not read it, so set the model in the Edit form or here to keep it.

| Engine | Suggestions | Flag checked in |
|---|---|---|
| Claude Code | `sonnet`, `opus`, `haiku` | real runs (only `haiku`) |
| Gemini CLI (legacy) | `auto`, `pro`, `flash`, `flash-lite` | `--help` of 0.59.0 |
| Antigravity CLI | none | `--help` of 1.5.11 |
| pi | `sonnet`, `haiku` | `--help` of 1.5.2 |
| Codex, Kimi CLI, Cursor Agent | none | their docs, not installed |

opencode, Copilot CLI, Qwen Code, Grok CLI, Crush and the custom command have no field: no model flag was found in what was read. Set the model in the CLI itself.

## Amazon Bedrock

<BedrockMock class="doc-mock" />

gonogo has no Bedrock switch: an engine uses Bedrock when its own settings say so, and gonogo passes the environment on. Set the variables as [room keys](room-keys.md) for every agent, or as Clearance keys for one agent (the form suggests the names) or in the shell that starts gonogo. Nothing was run against a real AWS account; see `docs/facts/bedrock.md` for sources and for what a real check needs.

| Engine | Bedrock | What to set |
|---|---|---|
| Claude Code | expected to work with keys (not run against AWS) | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, and `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key) or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`), or `AWS_PROFILE`. Model: the agent's model field with a Bedrock id, or the key `ANTHROPIC_MODEL` |
| opencode | needs its own setup | the same AWS variables (`AWS_PROFILE`, the key pair or `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`); pick the Bedrock model inside opencode (gonogo has no model field for it) |
| Codex | needs a config line | `model_provider = "amazon-bedrock"` in `~/.codex/config.toml` (optional profile and region there), plus `AWS_PROFILE` or keys |
| pi | needs setup in pi | the AWS variables; the provider is picked in pi (`--model amazon-bedrock/<id>` is likely, not verified) |
| Crush | needs setup in Crush | the AWS variables; gonogo starts it with no arguments |
| Gemini, Antigravity | unsupported | Google models only |
| Qwen, Grok, Kimi, Copilot, Cursor | not found | no Bedrock provider found in what was read |

- **Clean Room.** The container gets only the agent's keys by name, never your shell's AWS variables, and `~/.aws` is not mounted, so a profile or SSO login does not work there: use keys, best a short-term Bedrock API key.
- **Models.** Bedrock ids (`us.anthropic.claude-sonnet-4-6`) and application-inference-profile ARNs fit the model field; a longer ARN goes in as the key `ANTHROPIC_MODEL`.
- **Cost.** Tokens count as usual; dollars show as unpriced until you add a price row for the Bedrock id (Propellant, DOLLARS, prices), because Bedrock prices can differ from the list.

## Keys (Clearance)

The CLEARANCE fold sets environment variables for one agent, usually API keys such as `OPENAI_API_KEY` or `GEMINI_API_KEY`. It works for every engine and for a custom command.

- **Write only.** A value goes from the form to the server and never back: a saved key reads `SET`. A name typed again replaces its value; REMOVE takes a key away. Applies at the next start.
- **Where.** `keys.json` in the home, mode 0600, plain text. `agents.json` and the page hold the names and the time each was set. A value is in no log line, message, Downlink item, Relay post, answer or error.
- **Names.** Capital letters, digits and `_`, starting with a letter, at most 64; at most 16 per agent. A value is 1 to 4096 printable characters without a space. Names that change what runs are refused: `PATH`, `HOME`, `SHELL`, `TERM`, `NODE_OPTIONS`, `CLAUDE_CONFIG_DIR`, shell and interpreter start-up hooks such as `BASH_ENV`, `ENV`, `ZDOTDIR` and `PYTHONPATH`, the programs git or a tool opens (`GIT_SSH`, `GIT_PROXY_COMMAND`, `GIT_EDITOR`, `GIT_PAGER`, `EDITOR`, `VISUAL`, `PAGER`), and every `GONOGO_`, `LD_`, `DYLD_`, `DOCKER_` and `GIT_CONFIG_` name (the full list is in the spec).
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
- **gonogo never installs an agent CLI**, from the page or from `gonogo doctor` (the one install it can run is its own update, after your click: [Update from the page](update.md)). The commands are copied from each vendor's page, listed in [`docs/engine-bay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/engine-bay-spec.md); Kimi CLI has none (not checked), and the form links its page. The commands were read, not run.
- The `not installed` marks and the order of the Engine select come from the `PATH` as it was when gonogo started. The note below it asks again each time the hire form opens, so a CLI installed later shows as found there.

- **A CA override warns, and is not refused.** The form says so under `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`: with a proxy in the way, whoever holds that certificate authority can read the agent's TLS traffic, Anthropic tokens included. Set it only for a CA you control.
- **A stored key whose name is reserved later** is not given to the agent at the next start. Its name (never its value) is logged and the Downlink says which; set it under another name or remove it. The agent is not lost: the roster drops that name and keeps the rest.