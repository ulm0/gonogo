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

## Room defaults: PAYLOAD DEFAULTS in Flight Rules

The same servers and skills for **every** agent of the room, set once in [Flight Rules](flight-rules.md), PAYLOAD DEFAULTS.

- **Set one at a time.** A server has a name and its JSON (the same shape as above); setting a name again replaces that server whole. A skill is a folder. REMOVE takes one out. The page lists each item by what it is: a server's type and command (or the address, without its path or query), how many arguments, and the *names* of its env variables or headers. **No argument, env value, header value or query is ever shown or sent to the page**, so to change a server you set it again. They are saved in `payload-defaults.json` (mode 0600) in plain text, like an agent's own.
- **The agent wins.** In an agent's PAYLOAD fold a list says what that console starts with and where each item comes from (the word ROOM or THIS CONSOLE, not only the colour). A room item has a switch: off leaves it out for this console only. A server or skill of the console's own with the same name (a skill by its folder name) **replaces** the room's one whole, nothing is merged inside a server. The rest of the room's items stay.
- **Which agents.** Claude Code gets servers and skills, Gemini CLI and Kimi CLI servers only, the other engines nothing. **A Clean Room agent gets none of the room's defaults**: a server's env and headers hold keys, and the Clean Room exists to keep keys out. Give a Clean Room agent what it needs in its own PAYLOAD (its servers run inside the container).
- **When.** At each agent's next start. A running agent keeps what it started with, and is not marked as needing a restart when the defaults change.
- **Who may change them.** A default server is a program every agent of the room starts, so a change asks for the password again (the same step-up as hiring an agent with a payload), and the Black Box notes it by name (never a value).
