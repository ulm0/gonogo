# Payload: MCP servers and skills per agent

The PAYLOAD fold of the hire and edit form gives one agent MCP servers and skills of its own, on top of the gonogo
tools. It sets no flag or environment variable. Design and limits: [`docs/payload-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/payload-spec.md).

- **MCP servers** are one JSON object in the form's first box: a name, then the config in the shape of Claude Code's
  `mcp.json`. A local server has `command`, optional `args` (a list of texts) and `env` (an object of texts); a remote
  one has `"type": "http"` or `"sse"`, `url` and optional `headers`. Example:
  `{"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]}}`. A name is lowercase
  letters, digits, `-` and `_` (at most 32), and `gonogo` is reserved. At most 16 servers and 32 KiB of JSON for the whole payload; anything outside this shape
  (a `cwd`, `oauth`, a url server without `type`) is refused, and the form shows the server's message under the box.
  gonogo writes them into the agent's `mcp.json` beside its own server at every start.
- **Skills** (Claude Code only) are absolute paths of folders that each hold a `SKILL.md`, one per line, at most 16,
  each with its own folder name. The folders must exist when you save. At every start gonogo builds a small plugin in
  `agents/<name>/payload-plugin/` with a symlink to each folder and starts `claude` with `--plugin-dir` on it, which
  loads it for that session only: nothing is written into your project or `~/.claude`, and nothing is copied, so an
  edit to a skill shows at the next start. A folder that is gone or has no `SKILL.md` stops that start with its path.
- **Engines.** Claude Code takes both. Gemini CLI and Kimi CLI take the servers (in their per-agent file, beside
  gonogo). Codex, opencode, Copilot, the engines without the gonogo tools and the custom command take no payload; the
  fold is not shown for them and the server refuses one.
- **Permissions.** The tools of a payload server are not allowed in advance: the agent's permission mode decides, as for
  any tool. In `default` and `acceptEdits` mode a use asks first, which shows as needs you with GO and NO-GO (not seen
  with a real model).
- **Edit.** A saved payload replaces the old one whole; empty boxes remove it. It applies at the next start (the console
  shows that a restart is needed).
