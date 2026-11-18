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
