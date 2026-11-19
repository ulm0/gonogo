# Spec: Payload

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): capabilities chosen
per agent, the equivalent of Munder Difflin's Capabilities. A Payload is the MCP servers and the skills one agent
carries, on top of the gonogo tools every agent has.

## Intent

Today every agent gets the same tools: Claude Code's own and the four of the `gonogo` MCP server. The owner wants one
agent to have a GitHub server, another a filesystem server, a third a skill folder, without touching the project or
`~/.claude` and without the others getting them.

## Design

- **Shape.** `AgentRecord.payload?: { mcpServers?: Record<string, McpServer>, skills?: string[] }`, never an empty
  object. An `McpServer` is the shape of Claude Code's `mcp.json`: stdio is `command`, `args`, `env`; remote is
  `type: "http"` or `"sse"`, `url`, `headers`. A server with a `url` must say its `type` (Claude Code reads an entry
  without one as stdio and skips it). `skills` are absolute paths of skill folders; each folder holds a `SKILL.md`.
- **One reader.** `src/server/payload.ts` (`parsePayload`) checks the shape and nothing else. The hub uses it for hire
  and edit, `home.ts` for `agents.json`, so a hand-edited file is judged by the same rules as a request. It is strict:
  an unknown field, a bad name, a server named `gonogo` (reserved), a url that is not http or https, an env or header
  name that is not usable, a NUL character or a header value with a line break all refuse the payload. Server names
  match `^[a-z0-9][a-z0-9_-]{0,31}$`. Limits (`constants.ts`): 16 servers, 16 skills, 32 items in args, env or headers,
  2000 characters per text, and 32 KiB of JSON for the whole payload (every agent frame and snapshot carries it, so
  24 agents stay far below the WebSocket's 4 MiB buffer). An empty `mcpServers` or `skills`, or a payload left empty, is no payload.
- **Where the check happens.** `web.ts` only checks that `payload` is an object (or `null` on edit). The hub does the
  rest and answers 400 with the field: `payload`, `payload.mcpServers` or `payload.skills`. Whether the engine takes a
  payload is `PROVIDER_INFO[provider].payload` (`payloadRefusal`): Claude Code `all`; Gemini CLI and Kimi CLI
  `servers`; every other engine and the custom command `null`. Each skill folder must exist (the hub asks
  `HubIo.checkDirectory`, the same check as the working directory); the `SKILL.md` is looked for at every start.
- **Hire and edit.** `payload` on hire; on edit it replaces the whole payload, and `null` removes it. An edit that
  changes it makes the agent `dirty` (restart to apply), like role and directory. The rollback of a failed save puts the
  old payload back.
- **Claude Code, servers.** The launcher writes the servers into the agent's `mcp.json` beside `gonogo` (gonogo's own
  entry comes last, so nothing can replace it). The file is written again at every start, mode 0600. The
  `--allowedTools` list is unchanged: the tools of a payload server are not allowed in advance, the permission mode
  decides, as for any tool (in `default` mode each use is a permission prompt that shows as needs you with GO and
  NO-GO).
- **Claude Code, skills.** `claude --help` (2.1.325) lists `--plugin-dir <path>`: "Load a plugin from a directory or
  .zip for this session only". That is the way that writes nothing into the owner's project or `~/.claude`. At every
  start the launcher rebuilds `agents/<name>/payload-plugin/` with `.claude-plugin/plugin.json` (name `gonogo-payload`)
  and `skills/<folder name>` as a symlink to each skill folder, and adds `--plugin-dir <that folder>` before
  `--append-system-prompt`. With no skills the folder is removed and the flag is not passed. The symlinks mean an edit
  to a skill in its own folder shows at the next start with nothing copied.
- **Other engines.** Gemini CLI's per-agent settings file and Kimi CLI's `kimi-mcp.json` take the servers as they
  are, beside `gonogo`. Gemini's settings schema (read from its bundle, 0.59.0) has `command`, `args`, `env`, `url`,
  `headers` and `type` with `stdio`, `sse` and `http`, so the same entry fits; a payload server gets no `trust`, so
  Gemini asks before its tools run. Codex, opencode and Copilot are not wired (see known limits).
- **The form.** A `PAYLOAD` fold in the hire and edit form (a `<details>`, like PROPELLANT on a console): a JSON
  textarea for the servers (one object: name, then config) and a textarea for the skill folders, one per line (Claude
  Code only). The fold is not shown for an engine that takes no payload. A problem the server names opens the fold and
  shows on its textarea. The hint says the values are saved in plain text, keys and tokens included, and that the tools
  are not allowed in advance.
- **Security.** Env and header values are stored in `agents.json` in plain text (the file is mode 0600), and the
  agent view sends the payload to the browser so that the edit form can show it. Claude Code expands `${NAME}` in
  these values from the agent's environment, so a secret can stay in gonogo's own environment and out of the file
  (from its documentation; not tried with a payload server). `docs/reference/security.md` says so.

## Room defaults (0.7.0)

- **Shape.** `payload-defaults.json` in the room's home: `{ "version": 1, "payload": { "mcpServers", "skills" } }`, mode 0600, the same reader (`parsePayload`) as an agent's own, so the same rules and limits. It holds values in plain text. `off` in the file is refused (the file is kept as `.bad` and the room has no defaults).
- **Agent side.** `AgentRecord.payload.off?: { mcpServers?: string[], skills?: string[] }`: the names of room defaults this agent switches off. A payload may hold only `off`. Names are server names and skill folder names; an engine that takes no payload refuses any payload, `off` too.
- **Precedence: the agent wins.** `mergePayload(room, own, kind)`: the room's servers minus the agent's `off.mcpServers`, then the agent's servers on top (same name: the agent's, whole; no field is merged). Skills: the room's minus `off.skills` and minus any folder name the agent has itself, then the agent's. `kind` is the engine's `PROVIDER_INFO.payload`: `servers` drops the skills, `null` gives nothing. The launcher merges at every start (`launcher.ts`, `payloadOf`), for the servers of Claude, Gemini and Kimi and for the skills plugin.
- **Clean Room.** The merge gets no room for an agent with `cleanRoom`, so `mcp.json` and the plugin hold the agent's own items only. The room's servers carry env and headers (keys) that a Clean Room is meant to keep out of the container, and the room's skill folders are not mounted there. A default can therefore never widen what a Clean Room agent runs. Test: `test/cleanroom.test.ts`.
- **API.** `GET /api/payload-defaults` answers `{ mcpServers: [{ name, type, target, args, names }], skills: [{ name, path }] }`: `target` is the command or the origin of the url, `args` a count, `names` the env or header names. Never a value, an argument, a path or a query of a url. `PUT /api/payload-defaults/servers/<name>` (the server as the body) sets one, `DELETE` of it removes it, `POST /api/payload-defaults/skills` (`{ path }`, an existing folder) adds a folder, `DELETE /api/payload-defaults/skills/<name>` removes it. A refusal is a 400 with the field `server`, `name` or `path`, a missing item a 404. Every change is step-up (`stepup.ts`) and recorded in the Black Box by name.
- **Page.** Flight Rules, PAYLOAD DEFAULTS (`PayloadDefaults.tsx`); the Payload fold (`HireForm.tsx`, `payloadRows` in `form.ts`) lists the items with ROOM or THIS CONSOLE and the switches.
- **Not done (shortcuts).** A change of the defaults does not mark running agents as needing a restart (their frame does not carry the merge). The agent's `off` of an item the room no longer has stays until the agent is edited. No order among the room's items. The fold and the block were not seen in a browser.

## Decisions the first request left open

- Field names of the 400 answers are the dotted paths above, so the client can put the message under the right box.
- The form takes the servers object alone, not a whole `.mcp.json` with its `mcpServers` key.
- A server with a `url` and no `type` is refused with a message that says so, instead of guessing `http`.
- Not supported in a server: `cwd`, `oauth`, `headersHelper` and anything else outside the shape above.
- Skill names are the folder names, so two folders with one name are refused.
- Gemini and Kimi take servers; Codex (arguments), opencode (another shape) and Copilot (a `tools` list of its own) do
  not, and neither do the engines without the gonogo tools.

## Checked how

| What | How | Result |
|---|---|---|
| `--plugin-dir` exists and loads a plugin for one session only | `claude --help` (2.1.325) | yes, as quoted above |
| The plugin manifest and the skill folders are valid | `claude plugin validate` on a plugin built by the real launcher, and on a skills folder | passes; two warnings (no `version`, no `author`) |
| `--plugin-dir` follows symlinks | `claude plugin validate`, which says "A session started with --plugin-dir on this plugin follows a symlink here" | taken from that message, not seen loading |
| Claude Code accepts a stdio server with `command`, `args` and `env` | `claude mcp list` in a scratch folder and config folder with the entry in a `.mcp.json` (same `mcpServers` shape as `--mcp-config`); the probe server exits unless its argument and env arrive | `Connected` |
| Gemini accepts the same fields | its settings schema in the 0.59.0 bundle | read, not run (not signed in) |
| Kimi accepts the same fields in `--mcp-config-file` | docs | not tried |
| The launcher's files and argv, the validation, the roster round trip, the routes, the form, a hire and an edit end to end | tests with the stand-in agent (`test/payload.test.ts` and the others) | pass |

Not checked: a model using a payload tool or a skill, the permission prompt of a payload tool in a real session,
whether Claude Code shows the plugin's skills under the name `gonogo-payload:<folder>`, a remote (http or sse) payload
server connecting, `--mcp-config` with a payload entry (only the same entry in `.mcp.json`), and every Gemini and Kimi
run. The fold was not opened in a browser (form logic tested; the page type-checked and built), so the 390 px
layout, the 44 px touch targets and the screen reader names are by construction only.

## Known limits

- shortcut: Codex, opencode and Copilot take no payload. Codex would need the servers as `-c` arguments, which puts
  env values in the process list; opencode and Copilot use another file shape that was not checked. Upgrade when one
  of them is checked against a real run.
- shortcut: no shared library of servers; the same server for three agents is pasted three times. Upgrade when it hurts.
- shortcut: no "always allow" for a payload tool; a go or no-go per use in `default` mode.
- A skill folder that is moved or loses its `SKILL.md` makes the next start fail with its path; fix it in Edit.
- Gemini expands `$VAR` and `${VAR}` in its settings values, so a `$` in an env value may be read as a variable.
- Skills are Claude Code only; Gemini has its own skills that Payload does not touch.
- The payload applies at the next start. A running agent keeps what it started with.
