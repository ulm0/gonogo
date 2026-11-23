# Global MCP servers: the ones you added with `claude mcp add --scope user`

<GlobalMcpMock class="doc-mock" />

gonogo starts every agent with `--strict-mcp-config` and its own `mcp.json`, so an agent sees only the servers gonogo writes there. **The servers you added to Claude Code yourself (`claude mcp add --scope user`, for example in a console of the room) were never in it.** Now they can be: at each start gonogo reads them from your Claude Code config and puts them **under** the room's Payload defaults and the agent's own Payload.

**The order, the later one wins by name, whole:** global servers, then the room's [Payload defaults](payload.md), then the agent's own Payload. An agent can switch a global server off in its Payload fold (a switch next to the name, marked GLOBAL). The `gonogo` server is always there, last, and a global server of that name is never used.

## What is read

- **Where:** the top-level `mcpServers` of `<CLAUDE_CONFIG_DIR>/.claude.json`, or `~/.claude.json` when that is not set: the same file Claude Code writes for `--scope user`, of the user gonogo runs agents as. Only read, never written, at each start (so a server you add now is in the next agent that starts).
- **Which servers:** the ones that a Payload server could be: `command` (with `args`, `env`) or `type` `http` or `sse` with `url` (and `headers`), nothing else in the entry (an `oauth` client setting, `headersHelper`, `cwd` are not supported: the server is **skipped** with a line in the log that names it and says why, never a value). At most 16. Names: letters, digits, `.`, `-` and `_`.
- **Bad JSON, a missing file, a folder, a file over 32 MiB:** nothing is added, one line in the log, and the start goes on. A start is never refused because of this.

## Who gets them

| Setting (Flight Rules, GLOBAL MCP SERVERS) | Default | Asks for the password to turn on |
|---|---|---|
| Include them for the agents of this room | **on** | yes (turning it off does not) |
| Include them for Clean Room agents too | **off** | yes |

A Clean Room is off by default because a global server can carry a header or a token into the container, and [the egress switch](egress.md) exists to keep secrets out of it. **An API key cannot turn either switch on** (a key carries no step-up); a browser session can. Only Claude Code agents get them: Gemini CLI and Kimi CLI take their own Payload servers only.

## OAuth servers (the ones you logged in to with `/mcp`)

Claude Code keeps the token of a remote server in its credential store (the config folder's `.credentials.json`, or the keychain), under a key made of the **name**, the **type**, the **address** and the **headers** of the server. gonogo copies a global server exactly, so an agent of the same user with the same config folder **finds the token and uses it**. Tried with Claude Code 2.1.325, a stored token and a fake server: started with `--strict-mcp-config --mcp-config <file>` that names the same server, it sent `Authorization: Bearer <the stored token>`. So the servers you already logged in to work in your agents, **on this machine**.

- **A stdio global server with a path of this machine** (a `command` or `args` that point into your home or a local folder) **will not run inside a Clean Room**: the container has neither the program nor the folder. Only an `http`/`sse` server or a command that the image has can work there.
- **A Clean Room has its own home**, with no credential store of yours: an OAuth server there is not logged in (and cannot be from inside it), another reason the switch is off for it.
- **Not tried:** a real login flow, a token that expires and is refreshed while several agents run (Claude Code writes the store itself), and the macOS keychain.
- If you **rename** a server in the config, or the address changes, the token is not found: log in again.

## A new server is told to you

The room remembers the names it saw at the last start of an agent. When a **new name** shows up, you get a Downlink notice ("A new user-scope MCP server `NAME` → `COMMAND or ORIGIN` was added; it now starts with every agent") and a finding in the insecure-setup banner with the same words. Names and targets only, never an argument, a header or a value. The finding is dismissed by an id that is a hash of the name and the target (so the same server at another address shows again) and goes away by itself when the server is removed from the config. The very first start only records what is there, with no notice. A change of address under the same name is not a new name and is not announced.

## What the page shows

Flight Rules, GLOBAL MCP SERVERS: the two switches and the servers that were read, each with its **name, type and address (origin only)** and, when a room default of the same name replaces it, a note. The source is shown as "global (claude mcp --scope user)". **Never an argument, a header, an env value or a query.** In an agent's form the Payload fold lists them with the room's items.

## Limits

- A global server with a capital letter or a dot in its name can be switched off by that name, but a room default or an agent's own server cannot have such a name (a Payload name is lowercase), so it cannot replace it by name: switch it off and add a lowercase one.
- The read is of the **host** user's config. A room that runs as another user, or with another `CLAUDE_CONFIG_DIR` for an agent (a key of the agent) does not see the servers of the one gonogo itself runs as.
- A global server is a program (or a remote address) your agents then use with the agent's rights, as one you typed in a Payload. Its tools are not allowed in advance: the permission mode decides.
