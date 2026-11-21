# Door: as built

PR 1 of `docs/knowledge-spec.md` (piece B, with RSO's M4 and M5). The user page is [features/door](features/door.md). This file holds what a builder or reviewer needs: the engine table with its sources, and what was decided.

## What it does

- `<home>/rules.md`, at most 8 KiB, edited only through `PUT /api/rules` (`GET` reads). A change needs a **step-up** (`stepup.ts`), is refused to a terminal's session (`stepUpRequired`, "do this in the browser") and to any API key below scope `full` (`keyMayDo`); a key that only reads or acts cannot read it either. An agent's token is refused on every `/api` route (401). The Black Box line carries the length, never the text.
- `door.ts` builds the text after the role: the room's rules under one heading, then the fixed pointer sentence "The project's rules are in the file AGENTS.md in your working directory: read it first." when the working directory has that file (`lstat`, regular file, a link or folder does not count; nothing is read) and the engine does not load it itself. With only `CLAUDE.md`, every engine but Claude Code gets the same sentence naming `CLAUDE.md`. Both go through the one channel each engine has; the pointer has **no word that comes from a repository** (two constants for the file name), and a test puts a sentinel in `AGENTS.md` and `CLAUDE.md` and checks that no argument of any engine contains it (RSO S1) and that the sentence is the same whatever the file holds.
- The room's rules are read when a console starts (not live).
- Not built, as the spec says: writing `CLAUDE.md` or symlinks in a repository, reading the repository's file. `gonogo doctor` prints the engine table (`doorTable()`).

## The engine table (2026-11-21)

`reads` is whether the engine loads `AGENTS.md` on its own; `role` is how gonogo passes a role (`providers.ts`): the preamble and the role (`preamble`), the role alone (`role`), or no checked way (`none`). Sources are the vendors' own pages or repositories, read through search results and the GitHub API; **no CLI but `claude` was run on this host**, and none of these was tried against a model.

| Engine | reads | role | Source and what it says |
|---|---|---|---|
| Claude Code | unknown | preamble | [Memory docs](https://code.claude.com/docs/en/memory): reads `CLAUDE.md`; one page says `AGENTS.md` is not read, another that it can be, and the documented way is a `CLAUDE.md` with `@AGENTS.md`. The pages disagree, so the pointer is sent. |
| Gemini CLI | no | preamble | [`docs/cli/gemini-md.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md): `GEMINI.md`; another name only through `context.fileName` (default unset). |
| Antigravity CLI | unknown | role | not found in `docs/facts/antigravity.md`. |
| Codex | yes | preamble | [OpenAI's guide](https://developers.openai.com/codex/guides/agents-md): per directory `AGENTS.override.md`, then `AGENTS.md`, from the project root down to the working directory; `docs/agents_md.md` in its repository points there. |
| opencode | yes | preamble | [Rules](https://opencode.ai/docs/rules/): `AGENTS.md`, else `CLAUDE.md`, from the working directory upward. |
| Qwen Code | yes | none | [README](https://github.com/QwenLM/qwen-code): "your `QWEN.md` and `AGENTS.md` briefings load automatically". |
| Grok CLI | yes | none | [README](https://github.com/superagent-ai/grok-cli): `AGENTS.md` merged from the git root down to the working directory. |
| Kimi CLI | unknown | none | [Agents docs](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/agents.md): the system prompt template can use `${KIMI_AGENTS_MD}` (the merged `AGENTS.md`); whether the default prompt does was not read. |
| Crush | unknown | none | [README](https://github.com/charmbracelet/crush): documents `~/.config/AGENTS.md` (global); the project file was not found in what I read. |
| pi | unknown | role | its repository's own `AGENTS.md` is for contributors; nothing on loading was found. |
| Copilot CLI | yes | none | [GitHub docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions): `AGENTS.md` (root primary, others additional), also `CLAUDE.md`/`GEMINI.md`; `--no-custom-instructions` turns it off. |
| Cursor Agent | yes | none | [CLI docs](https://cursor.com/docs/cli/using): reads `AGENTS.md` and `CLAUDE.md` at the project root as rules. |
| custom command | unknown | none | gonogo does not know the program. |

**Why `unknown` and `no` get the pointer (when the file exists):** one extra sentence costs a line; a missed `AGENTS.md` costs the project's rules. **Why `none` gets nothing:** those starts take no role (see the comment in `providers.ts`); the rules for them belong in their own files until a way to pass a role is checked.

## Decisions

- **404 vs 401:** the spec says an agent token gets 404 on `/api/rules`; every `/api` route answers an agent token with 401 (`e2e` scenario of the browser token), and the test pins that.
- **Order of the text:** role first (the preamble contains the tools and the Director-turn rule), then the room rules, then the pointer. The spec's section 0 sentence is used as written; the earlier "the project's file wins" clause was dropped.
- **Audit:** the line goes to the Black Box (kind `config`, byte count), as the other room settings do, not to the Downlink.
- **Cap in bytes, not characters**, so a text in another script cannot pass 8 KiB.
