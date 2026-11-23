# Engine Bay: other agent CLIs

<EngineBayMock class="doc-mock" />

The hire form's Engine select picks the CLI an agent runs. CLIs on gonogo's `PATH` come first; the rest say `not installed`. Sign in to each CLI yourself. The engine cannot change after the hire. Design and limits: [`docs/engine-bay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/engine-bay-spec.md).

| Engine | Program | State from | Mail and votes | Role | Permission modes | How it was checked |
|---|---|---|---|---|---|---|
| Claude Code | `claude` | hooks, title, screen | yes | system prompt | yes | real runs |
| Gemini CLI (legacy) | `gemini` | hooks | yes | first prompt | `default`, `auto_edit`, `yolo` | `gemini --help` and source (0.59.0); not run with a model |
| Antigravity CLI | `agy` | output | no | first prompt | `accept-edits`, `auto`, `--dangerously-skip-permissions` | `agy --help` (1.5.11); not run signed in |
| Codex | `codex` | output | yes | first prompt | default, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox` | vendor docs only |
| opencode | `opencode` | output | yes | first prompt | no | vendor docs only |
| Kimi CLI | `kimi` | output | yes | no | no | vendor docs only |
| Copilot CLI | `copilot` | output | yes | no | no | vendor docs only |
| pi | `pi` | output | no | `--append-system-prompt` (role alone) | no | `pi --help` (1.5.2); not run with a model |
| Qwen Code, Grok CLI, Crush, Cursor Agent | `qwen`, `grok`, `crush`, `cursor-agent` | output | no | no | no | vendor docs only |

<AgyMock class="doc-mock" />

- **State from hooks:** as for Claude Code. Gemini hooks are `node -e` scripts that post to gonogo with the agent's token file. Mail arrives at the end of a turn. A tool confirmation shows as needs you with GO and NO-GO (Enter and Escape; NO-GO sets idle). Not checked with a signed-in Gemini. Escape or Ctrl-C typed in its terminal leaves `working` or `needs you` until the next prompt.
- **State from output:** `working` while it prints, `idle` after 2 seconds of quiet. Takes no Max Q slot; Redline never trips it.
- **Mail:** only engines with the gonogo tools. Without hooks the pointer is typed when the agent is quiet and counts as delivered at once. Others get no polls; a message to one comes back undelivered with `<name> runs <engine> without the gonogo tools and cannot receive messages`.
- **Config files** live under `agents/<name>/`, never in your project or the CLI's home; your own CLI settings still apply. Gemini: `gemini-settings.json` via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. Codex: `-c mcp_servers.gonogo.*`. opencode: `OPENCODE_CONFIG=agents/<name>/opencode.json`. Kimi: `--mcp-config-file agents/<name>/kimi-mcp.json`. Copilot: `--additional-mcp-config @agents/<name>/copilot-mcp.json`.
- **Sessions:** engines other than Claude Code start a new session every time; the role prompt costs a model turn.
- Propellant counts Claude Code only; the PROPELLANT fold shows only on a Claude console.

## Chips and defaults

Each console shows chips for **engine**, **model it starts with** and **effort**: console head (under the name on a phone), the CONSOLES list of Flight Rules, and the terminal client's room list. The model chip says where it comes from when it is not the console's own (`sonnet · room default`, `opus · position default`, `effort high · room default`). With no model set there is no chip (gonogo never guesses the CLI's default). A `/model` typed in a console is not shown or kept.

**Effort** is Claude Code's `--effort` (`low`, `medium`, `high`, `xhigh`, `max`, as `claude --help` lists them). Set the EFFORT field of the hire or edit form; empty uses the room's default effort, then the CLI's own. Applies at next start (`dirty` until then). A request with another level, or for an engine without effort, gets 400 with the field. Antigravity lists `--effort` but its levels were not read, so it is not offered. `CLAUDE_EFFORT` is still scrubbed from agents.

**Room defaults** (Flight Rules, DEFAULTS), kept in `<home>/models.json`:

| Default | Use | API (null clears) |
|---|---|---|
| Default engine | preselects the hire form; engine of a hire naming none (form, Relief, `hire_agent`); never a custom command; an engine in the request wins | `PUT /api/models/engine` `{ engine }` |
| Permission mode | preselects the mode of a new hire in the form; mode of a Relief or `hire_agent` request naming none (never bypass: that falls back to ask); bypass as the default needs the confirmation box; an engine without modes ignores it; Edit never changes an agent's mode | `PUT /api/models/mode` `{ mode, confirmBypass }` |
| Claude Code effort | `--effort` of a Claude console with none | `PUT /api/models/effort` `{ effort }` |
| Model by engine | model of a console with none | `PUT /api/models/<engine>` `{ "model": "sonnet" }` |
| Model by position (16 positions) | Claude Code consoles only | `PUT /api/models/positions/<id>` `{ "model": "sonnet" }` |

`GET /api/models` reads them. A custom command, an unknown engine or a bad level gets 400 with the field. Order for a model: the console's own, its position's, the engine's room default. Models and effort apply at each console's next start; a default engine at the next hire.

## Model

<ModelsMock class="doc-mock" />

The MODEL field of the hire and edit form is free text with suggestions; empty is the CLI's own default. Passed as `--model <name>`, applies at next start. Names: letters, digits and `. _ : / @ + -`, starting with a letter or digit, at most 100; anything else, and a model for an engine without the field, is refused. The CLI judges the name.

| Engine | Suggestions | Flag checked in |
|---|---|---|
| Claude Code | `sonnet`, `opus`, `haiku` | real runs (only `haiku`) |
| Gemini CLI (legacy) | `auto`, `pro`, `flash`, `flash-lite` | `--help` of 0.59.0 |
| Antigravity CLI | none | `--help` of 1.5.11 |
| pi | `sonnet`, `haiku` | `--help` of 1.5.2 |
| Codex, Kimi CLI, Cursor Agent | none | their docs, not installed |

opencode, Copilot CLI, Qwen Code, Grok CLI, Crush and the custom command have no model field (no flag found); set the model in the CLI.

## Amazon Bedrock

<BedrockMock class="doc-mock" />

No Bedrock switch: an engine uses Bedrock when its own settings say so, and gonogo passes the environment on. Set variables as [room keys](room-keys.md), as Clearance keys for one agent, or in the shell that starts gonogo. Nothing was run against a real AWS account; sources in `docs/facts/bedrock.md`.

| Engine | Bedrock | What to set |
|---|---|---|
| Claude Code | expected to work with keys (not run against AWS) | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, and `AWS_BEARER_TOKEN_BEDROCK` (Bedrock API key) or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`), or `AWS_PROFILE`. Model: the agent's model field with a Bedrock id, or key `ANTHROPIC_MODEL` |
| opencode | needs its own setup | the same AWS variables; pick the Bedrock model inside opencode |
| Codex | needs a config line | `model_provider = "amazon-bedrock"` in `~/.codex/config.toml`, plus `AWS_PROFILE` or keys |
| pi | needs setup in pi | the AWS variables; provider picked in pi (`--model amazon-bedrock/<id>` likely, not verified) |
| Crush | needs setup in Crush | the AWS variables; gonogo starts it with no arguments |
| Gemini, Antigravity | unsupported | Google models only |
| Qwen, Grok, Kimi, Copilot, Cursor | not found | no Bedrock provider found |

- **Clean Room:** the container gets only the agent's keys by name; `~/.aws` is not mounted, so profiles and SSO do not work. Use keys, best a short-term Bedrock API key.
- **Models:** Bedrock ids (`us.anthropic.claude-sonnet-4-6`) and application-inference-profile ARNs fit the model field; a longer ARN goes in as key `ANTHROPIC_MODEL`.
- **Cost:** tokens count as usual; dollars show unpriced until you add a price row for the Bedrock id (Propellant, DOLLARS, prices).

## Keys (Clearance)

The CLEARANCE fold sets environment variables for one agent (e.g. `OPENAI_API_KEY`, `GEMINI_API_KEY`), for every engine and custom commands.

- **Write only:** a saved key reads `SET`, never returned. A name typed again replaces it; REMOVE deletes. Applies at next start. Rename moves the keys with the agent; remove deletes them.
- **Stored** in `keys.json` in the home, mode 0600, plain text. `agents.json` and the page hold names and set times. A value is in no log, message, Downlink item, Relay post, answer or error.
- **Names:** capitals, digits, `_`, starting with a letter, at most 64; at most 16 per agent. Value: 1 to 4096 printable characters, no space.
- **Refused names:** `PATH`, `HOME`, `SHELL`, `TERM`, `NODE_OPTIONS`, `CLAUDE_CONFIG_DIR`, shell and interpreter start-up hooks (`BASH_ENV`, `ZDOTDIR`, `PYTHONPATH`), programs git or a tool opens (`GIT_SSH`, `GIT_PROXY_COMMAND`, `GIT_EDITOR`, `GIT_PAGER`, `EDITOR`, `VISUAL`, `PAGER`), and every `GONOGO_`, `LD_`, `DYLD_`, `DOCKER_`, `GIT_CONFIG_` name (full list in the spec).
- **Precedence**, later wins: gonogo's environment minus scrubbed variables (`GONOGO_SCRUB_ENV` and the built-in list); this agent's keys (not scrubbed); variables gonogo sets for all agents (`TERM`, `GONOGO_TOKEN`); the engine's own (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `OPENCODE_CONFIG`). In seed mode `ANTHROPIC_API_KEY` goes through `apiKeyHelper` like the host's.
- **Clean Room:** only named variables; `docker run -e NAME` reads the value from its own environment, so no value is on a command line.
- Only that agent's process gets them. The agent sees them (`env`); an agent in `bypassPermissions` runs as you and can read `keys.json`.
- **`ENV` only warns:** only an interactive `sh` reads it. Set it to a path only for a file you control.
- **A CA override warns, not refused** (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`): whoever holds that CA can read the agent's TLS traffic, Anthropic tokens included. Use only a CA you control.
- **A stored key whose name is reserved later** is not passed at next start. The name (never the value) is logged and the Downlink says which (up to 300 characters, then "and N more"). The entry is **moved, not deleted** to `keys.refused.json` (0600, merged if present). Set it under another name to use it again. The agent is kept.

## Pad Check

Under the Engine select the form shows whether the program is on gonogo's `PATH`, with path and version, and when missing the vendor's install command (COPY button, vendor page). `gonogo doctor` prints the same for every engine:

```
ok  Claude Code (claude)  2.1.325 (Claude Code)  /usr/local/bin/claude
--  Codex (codex)  not found
    install: npm install -g @openai/codex
    docs: https://github.com/openai/codex
```

- Version: first line of `<program> --version`, no shell, 5 seconds at most, environment of `PATH`, `HOME`, `LANG`, `NO_COLOR` only. No answer: listed without a version.
- Exit 1 when Claude Code is missing and `GONOGO_AGENT_CMD` is unset; otherwise 0.
- **gonogo never installs an agent CLI** (only its own update, after your click: [Update from the page](update.md)). Commands were copied from vendor pages (listed in the spec), read not run. Kimi CLI has none (not checked); the form links its page.
- The `not installed` marks and select order come from the `PATH` at start; the note below the select asks again each time the form opens.
