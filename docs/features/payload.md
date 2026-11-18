# Payload: MCP servers and skills per agent

<PayloadMock class="doc-mock" />

The PAYLOAD fold of the hire and edit form gives one agent its own MCP servers and skills, on top of the gonogo tools.
Design and limits: [`docs/payload-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/payload-spec.md).

- **MCP servers:** one JSON object in the first box, name to config, in the shape of Claude Code's `mcp.json`.
  - Local: `command`, optional `args` (list of strings) and `env` (object of strings).
  - Remote: `"type": "http"` or `"sse"`, `url`, optional `headers`.
  - Example: `{"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]}}`.
  - Names: lowercase letters, digits, `-` and `_`, at most 32; `gonogo` is reserved.
  - At most 16 servers and 32 KiB of JSON. Anything else (a `cwd`, `oauth`, a url server without `type`) is refused
    with a message under the box.
- **Skills** (Claude Code only): absolute paths of folders that each hold a `SKILL.md`, one per line, at most 16, with
  distinct folder names. They must exist when you save. gonogo links them into `agents/<name>/payload-plugin/` and
  starts `claude` with `--plugin-dir`; nothing is copied or written to your project or `~/.claude`, so skill edits show
  at the next start. A missing folder or `SKILL.md` stops the start with its path.
- **Engines.** Claude Code takes both. Gemini CLI and Kimi CLI take servers only. Other engines and the custom command
  take no payload; the fold is hidden and the API refuses one.
- **Permissions.** Payload tools are not pre-allowed: the permission mode decides. In `default` and `acceptEdits` a use
  shows as needs you with GO and NO-GO (not checked with a real model).
- **Edit.** A saved payload replaces the old one; empty boxes remove it. Applies at the next start.
