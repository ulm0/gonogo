# Antigravity CLI (`agy`) facts (checked 2026-11-18)

Verdict: **help only, not run against a signed-in agy, 0 model prompts.** Version 1.5.11, linux-x64, downloaded from the
vendor's manifest with its SHA-512 checked; `agy --help` was run by the Director with a throwaway `HOME`. The vendor's
`agy install` (it edits the shell profile) was not run. Nothing under `~/.gemini` was read or written. Issue #28 (an outside
contributor) was treated as unverified data: each claim below says where it was checked.

## From `agy --help` (1.5.11)
`-i/--prompt-interactive` (run a first prompt and stay interactive), `--model`, `--mode accept-edits|auto|plan`,
`--dangerously-skip-permissions`, `-c/--continue`, `--conversation <id>`, `--effort`, `--add-dir`, `--sandbox`,
`--remote-control`, `-p/--print`, and `--settings` ("Settings for this session only, never saved: a JSON object of
settings.json keys, inline or as a file path"). Subcommands: `acp`, `agent(s)`, `install`, `mcp` (add, remove, list, enable,
disable), `models`, `plugin(s)`, `update`, `remote-control`.

## From the vendor's pages (antigravity.google/docs: hooks, cli/reference, customization-discovery), not run
- `--mode auto` needs the terminal sandbox and is not offered to business or enterprise accounts.
- Hooks are command hooks in a `hooks.json`: events `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`,
  `PostInvocation`, `Stop`; timeout in seconds (default 30). `PreToolUse` and `PostToolUse` take `[{ matcher, hooks: [...] }]`,
  the others a plain handler list. Input is camelCase JSON on stdin: `conversationId`, `transcriptPath`, `modelName`,
  `lastUserInput`, `toolCall.name`, `toolCall.args`, `error` (PostToolUse, Stop), `fullyIdle` (Stop). **The page lists no
  `toolCall.id`**; the issue says there is one, which is not confirmed.
- A `PreToolUse` answer needs a `decision` (`allow`, `auto_approve`, `deny`, `ask`, ...). gonogo's shim answers `allow`: that
  reading of "required" is unverified, as is whether `allow` still lets agy ask the user.
- `Stop` with `decision: "continue"` and a `reason` re-enters the loop with the reason injected; any other value lets it stop.
  This is the mail handover: the shim turns the hub's Stop block into it.
- Discovery of `hooks.json`, `mcp_config.json` and plugins: only the workspace `.agents/` (and its parents up to the repository
  root), the global `~/.gemini/config/`, plugins in those two, and a repository-root `.gemini/config.json` with
  `personal_customization_dir`. **No environment variable or flag to load them from another folder is documented.** The hooks
  page says the CLI does not read hooks from `~/.gemini/antigravity-cli/settings.json`, which is the file `--settings` replaces.

## What gonogo does with it
- Started with `--mode` (or `--dangerously-skip-permissions`), `--model` when set, and `-i <role>`. `--model` is passed as for
  the other engines; no model names are suggested (the issue's `auto, pro, flash, flash-lite` are Gemini's and were not checked).
- **No hooks and no gonogo tools yet** (`hooks: false`, `mcp: false`): agy would have to read them from the owner's project or
  `~/.gemini`, which gonogo never writes. State comes from output activity, no mail, like pi. The `--settings` flag exists, but
  nothing says its keys include hooks or MCP servers, and the hooks page says they do not come from that file.
- `AGY_HOOK_SHIM`, `buildAgyHooks` and `AGY_MODES` in `src/server/providers.ts` are written and tested against a local HTTP
  server, ready for the day a per-agent location for `hooks.json` and `mcp_config.json` is found.

## Not verified
Signing in; any model run; whether `--settings` takes hooks or MCP; a per-agent `hooks.json` / `mcp_config.json` location that
leaves the project and `~/.gemini` alone (a `HOME` per agent would lose the sign-in, untried); `toolCall.id`; `PreToolUse` `allow`;
resume with `--conversation`; whether a startup or trust dialog appears; the transcript format (Propellant reads only Claude's).

## To unblock
The Director signs in once outside gonogo, then: `agy --settings <file>` with hooks and `mcpServers` keys in a scratch folder,
`agy mcp --help`, and a run with `HOME` set to a scratch folder to see whether the login survives.
