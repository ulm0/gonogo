# Engine Bay: other agent CLIs

The Engine select of the hire form picks the CLI an agent runs. Installed ones (found on gonogo's `PATH`) come first;
the others say `not installed`. You sign in to each CLI yourself, outside gonogo, as with Claude Code. The engine
cannot change after the hire. Design and limits: [`docs/engine-bay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/engine-bay-spec.md).

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

- **State from hooks** works as for Claude Code. Gemini CLI runs only command hooks, so each hook runs a short
  `node -e` script that posts to gonogo with the agent's token file. Its AfterAgent hook hands over mail at the end of
  a turn; a typed pointer is confirmed by its BeforeAgent hook. A tool confirmation shows as needs you with GO and
  NO-GO (Enter and Escape; NO-GO sets idle, because Escape ends Gemini's turn without a hook). Not checked with a
  signed-in Gemini. An Escape or Ctrl-C typed in its terminal leaves `working` or `needs you` until its next prompt.
- **State from output** is the custom command's rule: `working` while it prints, `idle` after 2 seconds of quiet.
  Such an engine takes no Max Q slot and is never tripped by Redline.
- **Mail** goes only to an engine with the gonogo tools. Without hooks the pointer is typed when the agent is quiet and
  counts as delivered at once. An engine without the tools gets no mail (a message to it comes back undelivered with
  `<name> runs <engine> without the gonogo tools and cannot receive messages`) and no polls.
- **Config.** Gemini CLI reads `agents/<name>/gemini-settings.json` through `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, Codex
  gets `-c mcp_servers.gonogo.*` overrides, opencode `OPENCODE_CONFIG=agents/<name>/opencode.json`, Kimi
  `--mcp-config-file agents/<name>/kimi-mcp.json`, Copilot `--additional-mcp-config @agents/<name>/copilot-mcp.json`.
  Nothing is written into your project or the CLI's own home folder. Your own settings of that CLI still apply.
- **Sessions.** Every start of an engine other than Claude Code is a new session, and its first prompt (the role) is
  a model turn.
- Propellant counts Claude Code only; the PROPELLANT fold shows only on a Claude console.
