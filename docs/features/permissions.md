# Tool permissions: what an agent's harness may do

<PermissionsMock class="doc-mock" />

Set which tools a Claude Code agent may use without asking (`allow`), must ask about (`ask`) or never use (`deny`). They are Claude Code's own `permissions` rules (`Bash`, `Read`, `Edit`, `Bash(git:*)`, `WebFetch(domain:example.com)`, `Read(./.env)`, `mcp__files__read`). Set them in the `Tool permissions` fold of the hire and edit forms, or room-wide in Flight Rules, TOOL PERMISSIONS. No top-bar key.

- **The form.** A select per common tool (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch): Default, Allow, Ask, Deny. Below, one rule per line for the rest, e.g. `allow Bash(git:*)`. A bad line is named under the field; the server checks again.
- **Room rules** apply to every Claude Code console with none of its own. A console with its own rules (any list) uses its own `allow` and `ask` and none of the room's, even if it only wrote a `deny`. **The room's `deny` always applies too**; the form shows inherited denies read only. Both apply at the console's next start (marked as needing a restart).
- **Where**: room rules in `~/.gonogo/permissions.json` (`GET`, `PUT /api/permissions`); a console's own in its record (`permissions` on hire and edit; `null` returns to the room's).
- **How applied.** Written into `~/.gonogo/agents/<name>/settings.json` (passed with `--settings`) after gonogo's own rules. Your `~/.claude` and the repo's `.claude` are never read or written; Claude Code merges them, so rules there still count.
- **Fixed by gonogo**: `SendMessage` and `ListAgents` stay denied. A console may read and edit its own `memory.md`; that is an `allow`, so a `deny` or `ask` of `Read`, `Edit` or `Write` takes it away or makes it ask. Scope such rules (`Edit(./src/**)`) if the console must keep its notes. gonogo's own tools (`mcp__gonogo__...`) are refused in every list (a console that cannot use them cannot be reached).
- **A rule** is a tool name, optionally a pattern in parentheses, on one line: letters, digits, `_`, `.`, `-`; name at most 100 characters, pattern 200, at most 50 rules per list.

## With the mode

The mode (default, acceptEdits, auto, bypass) is set apart. Claude Code checks `deny`, then `ask`, then `allow`; the first list with a match decides: **deny beats ask, ask beats allow**. No match: the mode decides (`default` asks via a permission dialog in the console, page or phone; `acceptEdits` accepts file edits too; `auto` and others as the CLI defines). So `allow Bash` in `default` means no more asking; `deny Bash` means never.

## Other engines

Claude Code takes the rules in its settings; pi and opencode through gonogo's tool gate, in the extension and the plugin gonogo starts them with (Engine Bay, "pi and opencode"): the same rules, the same order, the same modes. For Gemini CLI, Antigravity, Codex, Qwen Code, Grok, Kimi, Crush, Copilot, Cursor and a custom command the form says "Not supported" and the server refuses `permissions` (400, field `permissions`). Some have an allow flag of their own; none was checked against a real run, so none is mapped.

## Not verified

- No agent was started with a real model to see a call allowed, asked or denied; the settings file is checked and the syntax is Claude Code's documented one.
- Whether `deny` rules hold in `bypassPermissions` mode is unknown. Do not rely on a deny list to confine a console in bypass; use Clean Room.
