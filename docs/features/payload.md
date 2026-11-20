# Payload: MCP servers and skills per agent

<PayloadMock class="doc-mock" />

The PAYLOAD fold of the hire and edit form gives one agent its own MCP servers and skills on top of the gonogo tools. Design and limits: [`docs/payload-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/payload-spec.md).

- **MCP servers**: one JSON object in the first box, name to config, in Claude Code's `mcp.json` shape.
  - Local: `command`, optional `args` (strings), `env` (object of strings).
  - Remote: `"type": "http"` or `"sse"`, `url`, optional `headers`.
  - Example: `{"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]}}`.
  - Names: lowercase letters, digits, `-`, `_`, at most 32; `gonogo` reserved. At most 16 servers, 32 KiB of JSON. Anything else (`cwd`, `oauth`, a url server without `type`) is refused with a message under the box.
- **Skills** (Claude Code only): absolute paths of folders each holding a `SKILL.md`, one per line, at most 16, distinct folder names, existing at save. gonogo links them into `agents/<name>/payload-plugin/` and starts `claude` with `--plugin-dir`; nothing is copied to your project or `~/.claude`, so skill edits show at the next start. A missing folder or `SKILL.md` stops the start with its path.
- **Engines**: Claude Code takes both; Gemini CLI and Kimi CLI servers only; others and the custom command none (fold hidden, API refuses).
- **Permissions**: payload tools are not pre-allowed; the permission mode decides. In `default` and `acceptEdits` a use shows as needs you with GO and NO-GO (not checked with a real model).
- **Edit**: a saved payload replaces the old; empty boxes remove it. Applies at the next start.

## Room defaults: PAYLOAD DEFAULTS in Flight Rules

The same servers and skills for **every** agent, set in [Flight Rules](flight-rules.md), PAYLOAD DEFAULTS.

- Set one at a time: a server has a name and its JSON; setting a name again replaces it whole. A skill is a folder. REMOVE removes one. The page lists type and command (or address without path or query), argument count, and the *names* of env variables or headers. **No argument, env value, header value or query is ever shown or sent to the page**: to change a server, set it again. Stored in `payload-defaults.json` (0600), plain text.
- **The agent wins.** An agent's PAYLOAD fold lists what it starts with and the origin (ROOM or THIS CONSOLE). A room item has a switch: off leaves it out for this console only. A console's own server or skill with the same name (skill: folder name) **replaces** the room's whole; nothing merges inside a server.
- **Engines**: Claude Code servers and skills; Gemini CLI and Kimi CLI servers only; others nothing. **A Clean Room agent gets no room defaults** (env and headers hold keys); give it what it needs in its own PAYLOAD (servers run inside the container).
- **When**: at each agent's next start. A running agent keeps its set and is not marked as needing a restart.
- **Who**: changing defaults asks for the password again (step-up, as hiring with a payload), because a default server is a program every agent starts. The Black Box notes it by name, never a value.
