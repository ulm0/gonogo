# Room rules and the project's AGENTS.md

<DoorMock class="doc-mock" />

One text of **rules for every agent of the room**, and a pointer to the repository's own `AGENTS.md`, reach each agent through its role text, on every engine that takes one. You write the room rules once in Flight Rules (RULES) instead of in five engines' files. Design: [`docs/knowledge-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/knowledge-spec.md), the engine table with its sources in [`docs/door-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/door-spec.md). Not run against a real engine ([What was not verified](../reference/not-verified.md)).

## Room rules

- **Where:** Flight Rules, block RULES; the file is `rules.md` in the room's home (0600). At most **8 KiB** of plain text (control and text-direction characters are refused). An empty text removes the rules.
- **Who can write them:** only you, in the page, **with a fresh password check** (step-up), or an API key of scope `full`. A key that only reads or acts cannot read or write them; a terminal's session is told to do it in the browser. No agent route reads or writes the file. The Black Box says "Director changed the room rules (N bytes)", never the text.
- **Why so careful:** the text reaches every agent as part of its role text. Whoever can change it instructs all of them.
- **How it arrives:** Claude Code and pi get it in the **system prompt** (`--append-system-prompt`); Gemini CLI, Codex, opencode and Antigravity get the role text as their **first user prompt**, so it carries less authority there: an engine may weigh it like any message. Do not rely on it for what must never happen; use the engine's own permissions for that.
- **When:** at the next start of each agent (it is read when the console starts). Running consoles keep what they have.

## The project's AGENTS.md

gonogo never writes in your repository and **never puts text of a repository into a role text**: an agent can write that file, and the role text is read as a system prompt. Instead, when the agent's working directory has an `AGENTS.md` (a regular file; a link does not count) and the engine does not load it on its own, it gets one fixed sentence: "The project's rules are in the file AGENTS.md in your working directory: read it first." With only a `CLAUDE.md`, every engine but Claude Code gets the same sentence naming that file. gonogo checks that the file is there and reads nothing of it.

| Engine | Loads `AGENTS.md` itself | Gets the rules and the pointer |
|---|---|---|
| Codex, opencode | yes | rules only |
| Claude Code, Gemini CLI, Antigravity, pi | no, or not known | rules and pointer |
| Qwen Code, Grok CLI, Kimi, Crush, Copilot CLI, Cursor Agent, custom command | (see the spec) | **nothing**: gonogo has no checked way to pass them a role |

For Claude Code, `CLAUDE.md` can contain `@AGENTS.md` to share one file; you add that line yourself. The pointer is only added when the file exists in the agent's directory (its own worktree or Clean Room checkout when it has one).

## Limits

- Engines in the last row get no rules (a terminal with a lamp). Put the rules in their own files.
- The room rules and the project's file can disagree; nothing says which wins and nothing checks it.
- `gonogo doctor` prints this table (which engine loads `AGENTS.md`, which takes a role from gonogo).
- "Not known" means the engine's documentation was not clear; the pointer is then sent, and an engine that reads the file anyway sees one extra sentence.
