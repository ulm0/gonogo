# Registry: MCP servers and skills to pick from

<RegistryMock class="doc-mock" />

A short list of MCP servers and skills that were **checked against their repository and package**, so you can add one to a [Payload](payload.md) without writing its JSON from memory. Picking one only **fills the box**, which you can still edit: **gonogo never installs, downloads or runs anything from the list.** A server you pick is a command your agent's machine runs with that agent's rights, the same as one you typed.

## What an entry holds

| Field | Meaning |
|---|---|
| name, summary | what it is, in one sentence |
| licence | the licence its repository states (SPDX) |
| source | its repository, to read before you use it |
| checked | the day it was last checked |
| server (MCP) | the JSON that goes into the box: a `command` and `args`, or a remote `url` |
| needs (MCP) | the **names** of the keys it reads, never values |
| install, folder (skill) | the line you run in a terminal to get the folder, and the folder with the `SKILL.md` in it |

- **Pinned.** An `npx` or `uvx` server is pinned to the version that was checked (`@playwright/mcp@0.0.86`), because an unpinned one runs whatever was published last. Edit the version to move on.
- **Keys stay out of the file.** A server that needs a key has `${NAME}` where the value would go; Claude Code reads it from the agent's environment, so you set the value once in **Clearance** (one agent) or the room's keys. The Payload then holds only the name. (Documented by Claude Code; not tried with a payload server, see [What was not verified](../reference/not-verified.md).)
- **Some entries need an edit:** a folder or a repository path (`/path/to/a/folder`) is yours to fill in. The entry says which.
- **Skills** are folders on your disk. The card shows the `git clone` line; you run it, then give the folder's absolute path to the Payload, as always.

## What is in it (2026-11-21)

MCP servers: Filesystem, Memory, Sequential thinking, Fetch, Git (the reference servers of the MCP project), GitHub (GitHub's own remote server), Playwright, Chrome DevTools, Context7, Notion and MongoDB. Skills: skill-creator, mcp-builder, webapp-testing and frontend-design, from Anthropic's `skills` repository (these four are Apache-2.0 by their own LICENSE file; others of that repository are not open source and are not listed).

Left out on purpose: `@modelcontextprotocol/server-github` and `@stripe/mcp` (both **deprecated** on npm), the archived reference servers, and anything whose licence the repository does not state.

## Keeping it true

The list ships inside gonogo and is **never fetched at runtime**. A maintainer runs `pnpm registry:check` before changing it: it asks GitHub, npm and PyPI whether each repository is there and not archived, each package and version exists and is not deprecated or yanked, each skill folder has its `SKILL.md`, and warns about a pinned version that is no longer the latest. It installs and runs nothing, and no test or CI job runs it. An entry is only as current as its `checked` date.

## Limits

- Remote servers (GitHub, Context7) are run by someone else: what the agent asks goes to them. The check cannot open them without a key.
- The list is short on purpose. Anything not in it is written by hand in the same box.
- Which engines take a Payload is unchanged: Claude Code both; Gemini CLI and Kimi CLI servers only.
