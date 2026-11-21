# Registry: MCP servers and skills to pick from

<RegistryMock class="doc-mock" />

A short list of MCP servers and skills that were **checked against their repository and package**, so you can add one to a [Payload](payload.md) without writing its JSON from memory. Picking one only **fills the box**, which you can still edit: **gonogo never installs, downloads or runs anything from the list.** A server you pick is a command your agent's machine runs with that agent's rights, the same as one you typed.

## What an entry holds

| Field | Meaning |
|---|---|
| name, summary | what it is, in one sentence |
| licence | the licence its repository states (SPDX) |
| publisher | who publishes it, as its repository says |
| source | its repository, to read before you use it |
| checked | the day it was last checked |
| server (MCP) | the JSON that goes into the box: a `command` and `args`, or a remote `url` |
| transport, runs, sends to (MCP) | a program it starts or a server elsewhere; in plain words what executes; and where what the agent asks is sent besides this machine |
| needs (MCP) | the **names** of the keys it reads, never values |
| install, folder (skill) | the line you run in a terminal to get the folder, and the folder with the `SKILL.md` in it |

- **Pinned, and not the newest.** An `npx` or `uvx` server is pinned to a version at least **14 days old** (`@playwright/mcp@0.0.84`), because an unpinned one runs whatever was published last and a fresh publish is the shape of a hijack. A pin fixes the package, **not what it depends on**: `npx` and `uvx` keep no lockfile. Edit the version to move on.
- **Every card says:** it **downloads and runs code with your agent's rights when the agent starts** (or, for a remote server, that what the agent asks is sent to its host); that **its tool descriptions are read by your agent**, so a server you do not trust can instruct it; and how old the check is: **"checked N days ago", with a warning over 90.**
- **Keys stay out of the file.** A server that needs a key has `${NAME}` where the value would go; Claude Code reads it from the agent's environment, so you set the value once in **Clearance** (one agent) or the room's keys. The Payload then holds only the name. (Documented by Claude Code; not tried with a payload server, see [What was not verified](../reference/not-verified.md).)
- **Some entries need an edit:** a folder or a repository path (`/path/to/a/folder`) is yours to fill in. The entry says which.
- **Skills** are folders on your disk. The card shows the `git clone` line; you run it, then give the folder's absolute path to the Payload, as always.

## What is in it (2026-11-21)

MCP servers: Filesystem, Memory, Sequential thinking, Fetch, Git (the reference servers of the MCP project), GitHub (GitHub's own remote server), Playwright, Chrome DevTools, Context7, Notion and MongoDB. Skills: skill-creator, mcp-builder, webapp-testing and frontend-design, from Anthropic's `skills` repository (these four are Apache-2.0 by their own LICENSE file; others of that repository are not open source and are not listed).

Left out on purpose: `@modelcontextprotocol/server-github` and `@stripe/mcp` (both **deprecated** on npm), the archived reference servers, and anything whose licence the repository does not state.

## Keeping it true

The list ships inside gonogo and is **never fetched at runtime**. A maintainer runs `pnpm registry:check` before changing it: it asks GitHub, npm and PyPI whether each repository is there and not archived, each package and version exists and is not deprecated or yanked, each skill folder has its `SKILL.md`, and warns about a pinned version that is no longer the latest. It also checks that an npm package's `repository` is the entry's source (a name-alike package is how a bad one gets in), that it has no `preinstall`, `install` or `postinstall` script, and that the version is at least 14 days old. It installs and runs nothing, and no test or CI job runs it. An entry is only as current as its `checked` date.

**Changing an entry is reviewed.** The list ends up as commands that run on people's machines, so RSO reviews every change to an entry's command, package, version or address, as for code. (The repository has no CODEOWNERS file, so this is a rule of the room, not enforced by GitHub.)

## Where it is in the page

- **Hire and edit form, PAYLOAD fold.** "Add from the list" sits under the MCP servers box. "Add (the server) to the box" reads the box as JSON, adds the server under its id and writes the whole back, pretty-printed; a server of that name that is already there is **never overwritten** (you may have edited it): the key is off and says so. A box that is not a JSON object is left alone, with a message. The card shows the summary, the licence, a link to the repository ("Read it first"), the day it was checked (dimmed with a warning after about six months), the runtime it needs (Node or uv), what you edit in it, and the key names it reads ("Set these in Clearance or the room's keys: NAME"; the box holds only the names). An engine that takes servers only (Gemini CLI, Kimi CLI) is offered no skill, and one with no payload has no fold.
- **Flight Rules, PAYLOAD DEFAULTS.** The same picker for servers; it fills the name and the JSON of the form, which you still set with SET SERVER.
- **Flight Rules, SKILLS.** The room's skills (with who gets each: Claude Code agents that are not in a Clean Room, minus the ones that replaced or switched it off), ADD FOLDER and REMOVE (the same storage as PAYLOAD DEFAULTS), the skill part of the list, and the skills of each agent's own with a key that opens its Edit form. For a skill from the list the page shows the `git clone` line and a key that **copies** it; you run it yourself, then give the absolute path of the folder to ADD FOLDER. The page runs, downloads and installs nothing, and the link is shown only when the address is https.

Not seen in a browser.

## Limits

- Remote servers (GitHub, Context7) are run by someone else: what the agent asks goes to them. The check cannot open them without a key.
- The list is short on purpose. Anything not in it is written by hand in the same box.
- Which engines take a Payload is unchanged: Claude Code both; Gemini CLI and Kimi CLI servers only.
