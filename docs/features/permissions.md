# Tool permissions: what an agent's harness may do

The `Tool permissions` fold of the hire and edit forms, and the block of the same name in Flight Rules, set the rules a
Claude Code agent runs under: tools it may use without asking (`allow`), must ask about (`ask`) or may never use (`deny`).
They are Claude Code's own `permissions` rules (`Bash`, `Read`, `Edit`, `Bash(git:*)`, `WebFetch(domain:example.com)`,
`Read(./.env)`, an MCP tool such as `mcp__files__read`). No top-bar key.

- **The form.** A select for each common tool (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch): Default, Allow,
  Ask or Deny. Below it a text with one rule on each line, `allow Bash(git:*)`, for everything else (the selects read and
  write the lines of a bare tool). A line that is not a rule is named under the field; the server checks again.
- **The room's rules.** Flight Rules, TOOL PERMISSIONS: the rules of every Claude Code console that has none of its own.
  **A console's own `allow` and `ask` replace the room's, but the room's `deny` always applies too**, so one console's edit
  cannot drop a room-wide deny; the form shows the inherited denies, read only. Both apply at the console's next start (the
  console is marked as needing a restart). The room's rules are in `~/.gonogo/permissions.json` (`GET` and `PUT
  /api/permissions`); a console's own are in its record (`permissions` on hire and edit, `null` goes back to the room's).
- **How they are applied.** gonogo writes them into the settings file it already makes for each console
  (`~/.gonogo/agents/<name>/settings.json`, passed with `--settings`), after its own rules. It never reads or writes your
  `~/.claude` or the repository's `.claude`. Claude Code merges that file with its own user and project settings, so a rule
  you set there still counts. gonogo's own rules stay whatever you write: `SendMessage` and `ListAgents` stay denied,
  and a console can always read and edit its own `memory.md`. The tools of gonogo itself (`mcp__gonogo__...`) are refused in
  every list, because a console that cannot use them cannot be reached.
- **A rule** is a tool name, then an optional pattern in parentheses on one line: letters, digits, `_`, `.`, `-`, at most
  100 characters for the name and 200 for the pattern, at most 50 rules in a list.

## How the lists combine with the mode

The mode (default, acceptEdits, auto, bypass) is unchanged and is set apart from the lists. Claude Code checks `deny` first,
then `ask`, then `allow`, and the first list with a matching rule decides, so **deny beats ask, and ask beats allow**.
What no rule matches is decided by the mode: `default` asks (a permission dialog, which you answer in the console, the page
or from the phone), `acceptEdits` accepts file edits too, `auto` and the rest as the CLI defines them. So `allow Bash` in
`default` mode means a Bash call no longer asks, and `deny Bash` means it can never run.

## Other engines

Only Claude Code has rules gonogo can set. For Gemini CLI, Antigravity, Codex, opencode, Qwen Code, Grok, Kimi, Crush,
pi, Copilot, Cursor and a custom command the form says "Not supported", and the server refuses `permissions` for them
(400, field `permissions`). Some of these CLIs have an allow flag of their own; none was checked against a real run, so
none is mapped here.

## Not verified

- A real `claude` run against a rule: the settings file is checked, and the rule syntax is Claude Code's documented one,
  but no agent was started with a real model to see a call allowed, asked or denied.
- Whether `deny` rules are still enforced in `bypassPermissions` mode. Do not rely on a deny list to confine a console
  that runs in bypass; use Clean Room for that.
