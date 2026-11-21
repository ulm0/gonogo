# Market scan: tools like multivac

Date 2026-11-21. Asked by FLIGHT for the Director: does anything resemble [multivac](https://github.com/ulm0/multivac) (MIT, 1 star, pushed 2026-11-05, "released, and early"), and which of its ideas should gonogo build in?

**Method.** Stars, last push, licence and archived flag come from the GitHub API on 2026-11-21 (a repo's licence field says `NOASSERTION` when it is not a plain SPDX file; those I read by hand). Closed products have no repository: their facts come from their own documentation pages, found by web search, and I did not read their licence terms (marked *closed*). Pricing is not given. Where two pages of one vendor disagree I say so. Nothing here was run.

## Multivac's three ideas, as the yardstick

| # | Idea | What is distinctive |
|---|---|---|
| A | **Verified claims.** A brain of claims, each anchored to code by content (`present`, `absent`, `unique`, `count`, `each`), re-verified by CI. | Deterministic (no model, no API key); an anchor grammar measured at 95.1% of 82 real invariants; claims are the project's rules, not notes. |
| B | **One door.** One canonical `AGENTS.md`, projected to every harness. | A projection step, kept pinned and fresh. |
| C | **Change lifecycle with a closing ritual.** Closing a change prints the team's ritual (who reviews, who is told, what ships before what) as a checklist across repos, never a gate. | Cross-repo, declared landing order; optional gate through spec-kit or OpenSpec. |

## Summary table

"A/B/C" = overlap with multivac's idea. ● = does it, ◐ = partly, ○ = no.

| Tool | Kind | A | B | C | Stars / last push | Licence |
|---|---|---|---|---|---|---|
| [stalebrain](https://github.com/stalebrainlabs/stalebrain) | audits agent memory files against the repo | ◐ | ◐ | ○ | 5 / 2026-07-31 | MIT |
| [or1can/claims](https://github.com/or1can/claims) | checks doc and agent-instruction claims against code | ● | ○ | ○ | 0 / 2026-11-20 | Apache-2.0 |
| [staleproof](https://github.com/rajkaria/staleproof) | docs and agent files vs repo | ◐ | ○ | ○ | 0 / 2026-10-18 | MIT |
| [ctxlint](https://github.com/YawLabs/ctxlint) | lints agent context files | ◐ | ○ | ○ | 12 / 2026-11-16 | MIT |
| [agents.md](https://github.com/agentsmd/agents.md) | the AGENTS.md format | ○ | ● | ○ | 25,624 / 2026-09-10 | MIT |
| Claude Code `CLAUDE.md` + auto memory | engine memory | ○ | ◐ | ○ | [claude-code](https://github.com/anthropics/claude-code) 156,465 / 2026-11-20 | repo shows no licence; *closed* terms |
| Cursor rules (`.cursor/rules`) | IDE rules | ○ | ◐ | ○ | no repo | *closed* |
| GitHub Copilot instructions | repo instructions | ○ | ◐ | ○ | no repo | *closed* |
| Windsurf / Devin rules and AGENTS.md | IDE rules | ○ | ◐ | ○ | no repo | *closed* |
| Kiro steering and specs | IDE | ○ | ◐ | ◐ | no repo | *closed* |
| Cline Memory Bank | a prompt pattern on [cline](https://github.com/cline/cline) | ○ | ○ | ○ | 71,793 / 2026-11-20 | Apache-2.0 |
| Aider conventions | read-only file | ○ | ○ | ○ | [aider](https://github.com/Aider-AI/aider) 50,201 / 2026-05-22 | Apache-2.0 |
| [spec-kit](https://github.com/github/spec-kit) | spec-driven development | ○ | ○ | ◐ | 150,825 / 2026-11-20 | MIT |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | spec-driven, specs as living truth | ◐ | ○ | ◐ | 75,350 / 2026-11-20 | MIT |
| [Agent OS](https://github.com/buildermethods/agent-os) | standards extracted and injected | ◐ | ◐ | ○ | 5,629 / 2026-10-07 | MIT |
| [Swimm](https://swimm.io) | docs coupled to code | ● (docs, not rules) | ○ | ○ | no repo | *closed* |
| [Danger JS](https://github.com/danger/danger-js) | PR rules in code | ○ | ○ | ◐ | 5,519 / 2026-10-26 | MIT |
| CODEOWNERS, PR templates | GitHub features | ○ | ○ | ◐ | n/a | *closed* platform |
| [mem0](https://github.com/mem0ai/mem0) | memory layer for agents | ○ | ○ | ○ | 69,284 / 2026-11-18 | Apache-2.0 |
| [Letta](https://github.com/letta-ai/letta) | stateful agents with memory | ○ | ○ | ○ | 25,505 / 2026-10-18 | Apache-2.0 |
| [claude-mem](https://github.com/thedotmack/claude-mem) | session capture and recall | ○ | ○ | ○ | 118,641 / 2026-11-20 | Apache-2.0 |
| Devin Knowledge and playbooks | product memory | ○ | ◐ | ○ | no repo | *closed* |

None of the 22 does A and C together; only multivac's own design joins A, B and C.

## 1. Closest to A: verifying claims against code

This is the crowded corner, and all of it is new (every repo below was created in 2026, most this year).

- **stalebrain** ([repo](https://github.com/stalebrainlabs/stalebrain), MIT, 5 stars, last push 2026-07-31, created the same day: one release, unmaintained since). Audits `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `GEMINI.md`, Copilot instructions (18+ locations, 13 agents) against the repo, in a model-run protocol ("a pure markdown skill"): prose becomes typed claims with a half-life, cited commits, approve-only fixes. Verification is "glob, grep, and read-only git". **Better than multivac:** reads other agents' existing files with zero setup; confidence decay. **Worse:** a model extracts the claims, so the result is not deterministic; claims are inferred, not authored with anchors.
- **claims** ([repo](https://github.com/or1can/claims), Apache-2.0, 0 stars, pushed 2026-11-20, created 2026-09-14). A Claude Code plugin and standalone CLI. Gate checks (executable claims, citations, links, file references) block the commit; the others (config defaults, env vars, CLI flags, stale claims) are advisory. It argues drift tools miss prose "wrong on arrival". **Closest in spirit:** executes, resolves symbols, walks history; hook-based, advisory vs gate split like multivac's "checklist, never a gate". **Worse:** a judgment agent for part of it; no authoring grammar; no door, no lifecycle.
- **staleproof** ([repo](https://github.com/rajkaria/staleproof), MIT, 0 stars, last push 2026-10-18): checks links, commands, env vars and code examples; its README also describes a FalkorDB graph and example runs. Not read beyond the README summary.
- **ctxlint** ([repo](https://github.com/YawLabs/ctxlint), MIT, 12 stars, pushed 2026-11-16) and **agents-lint** ([repo](https://github.com/giacomo/agents-lint), 16 stars, no licence file, pushed 2026-09-25), **context-drift** ([repo](https://github.com/geekiyer/context-drift), 4 stars, no licence file, pushed 2026-04-01): linters of agent context files, per stalebrain's own comparison table (stalebrain's claims about its competitors; I did not test them).
- **Swimm** ([docs](https://docs.swimm.io/new-to-swimm/benefits-of-code-coupled-documentation), *closed*). The oldest product here: "Smart tokens" are live references to code in documents; Auto-sync updates snippets when code changes and marks a doc possibly out of date when the change is significant. Docs for people (onboarding, walk-throughs), not invariants for agents; a token follows code, it does not assert a rule about it. Pricing: sources I found conflict; not stated.
- **Doc-drift CLIs** ([DocPulse](https://github.com/YoniRaviv/DocPulse), 0 stars, last push 2026-06-14; [doc-sentinel-ai](https://github.com/reem-sab/doc-sentinel-ai), 24 stars, no licence file; [doc-detective](https://github.com/doc-detective/doc-detective), AGPL-3.0, 139 stars, which *runs* the documented steps) and link checkers ([lychee](https://github.com/lycheeverse/lychee), Apache-2.0, 4,150 stars). Check docs, not agent rules; none has an anchor grammar.

**Reading.** The idea "agent instructions rot, so check them against the code" is real and has at least five small implementations, none with users yet (≤16 stars; the biggest comparison table is the vendor's own). Multivac's difference is that the check is **deterministic and anchored by the author**, not model-inferred. Nobody else offers `count` and `each` over code with a measured grammar.

## 2. Closest to B: one door for every harness

This is the mature corner: the standard exists.

- **AGENTS.md** ([site repo](https://github.com/agentsmd/agents.md), MIT, 25,624 stars, pushed 2026-09-10): "a simple, open format for guiding coding agents". Plain markdown.
- **Who reads it** (each from the vendor's docs found by search; behaviour on a real install not tested): GitHub Copilot reads `AGENTS.md` anywhere in the tree, nearest wins, and also `CLAUDE.md`/`GEMINI.md` at the root ([docs](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)). Windsurf discovers `AGENTS.md` (root as always-on, subfolders scoped) ([docs](https://docs.windsurf.com/windsurf/cascade/agents-md)). Devin reads `CLAUDE.md` and `AGENTS.md` ([docs](https://docs.devin.ai/onboard-devin/knowledge-onboarding)). Cursor: its current docs say `CLAUDE.md` and `AGENTS.md` are both always applied ([help](https://cursor.com/help/customization/rules)); an older page says AGENTS.md is root-only (the two disagree). Aider does not load anything by default: you pass `--read CONVENTIONS.md` or set `read:` in `.aider.conf.yml` ([docs](https://aider.chat/docs/usage/conventions.html)).
- **Claude Code** is the exception: its documentation pages conflict. One says it reads `CLAUDE.md`, not `AGENTS.md`; another says it can read `AGENTS.md` in place of `CLAUDE.md`. The documented workaround is a `CLAUDE.md` that contains `@AGENTS.md` ([docs](https://code.claude.com/docs/en/memory)). I could not confirm which page is current.
- **Engine-specific formats**: Cursor `.cursor/rules/*.mdc` (frontmatter `alwaysApply`, `globs`, `description`; Cursor recommends under 500 lines per rule) ([docs](https://cursor.com/docs/rules)); Copilot `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md`; Windsurf `.windsurf/rules/` (and `.devin/rules/`, `global_rules.md`); Kiro `.kiro/steering/` ([docs](https://kiro.dev/docs/steering/)); Cline `.clinerules` and the Memory Bank pattern, six markdown files (`projectbrief.md`, `activeContext.md`, `progress.md`, ...) the model rewrites itself ([docs](https://docs.cline.bot/features/memory-bank.md)).
- **Projection tools**: searching GitHub for "one source, many agent files" returned no single dominant repo that I could verify; stalebrain *reads* 18+ locations, which is the inverse. I will not name a projector I could not confirm.

**Reading.** The door is solved for most engines by AGENTS.md alone; the remaining gaps are Claude Code (needs the `@AGENTS.md` import) and the engine-specific files that carry scoping (globs). Multivac's projection is useful exactly there, and nowhere else.

## 3. Closest to C: change lifecycle and the closing ritual

- **spec-kit** ([repo](https://github.com/github/spec-kit), MIT, 150,825 stars, pushed 2026-11-20): "structured processes, reusable templates, and documented outcomes": spec-driven development in core, bug fixing and idea assessment as bundled extensions, plus presets, workflows with gates, catalogs. Multivac can declare it and gates on its artifacts. It owns the spec, not the closing checklist across repos.
- **OpenSpec** ([repo](https://github.com/Fission-AI/OpenSpec), MIT, 75,350 stars, pushed 2026-11-20): a change folder (`proposal.md`, `specs/`, `design.md`, `tasks.md`), then *archive*, which updates the living specs. "Fluid not rigid". The nearest to multivac's change lifecycle; the archive step is the equivalent of a close. No cross-repo ritual.
- **Kiro specs** (*closed*, [docs](https://kiro.dev/docs/specs/)): `requirements.md` (EARS), `design.md`, `tasks.md` under `.kiro/specs/<feature>/`, tasks with live status. Single-repo.
- **Danger JS** ([repo](https://github.com/danger/danger-js), MIT, 5,519 stars, pushed 2026-10-26): rules in code that comment on or fail a PR ("you forgot to …"). It *is* a closing checklist per PR, programmable; but per PR, not per change across repos, and it can fail a build.
- **CODEOWNERS** ([docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)) says who reviews each path, enforced by branch protection (a gate); **PR templates** give a checklist in the PR text (I did not find a page to cite for templates). Release checklists are just that: documents.
- **Backlog.md** ([repo](https://github.com/MrLesk/Backlog.md), MIT, 7,453 stars, pushed 2026-11-21) keeps tasks as markdown in the repo with a kanban; **claude-task-master** ([repo](https://github.com/eyaltoledano/claude-task-master), 28,501 stars, last push 2026-04-28; licence is MIT with an added Task Master clause, read by hand: check it before reuse); **BMAD-METHOD** ([repo](https://github.com/bmad-code-org/BMAD-METHOD), 55,581 stars, pushed 2026-11-20, MIT text) is an agile agent method. Task and method tools, no verified claims.

**Reading.** A *post-change checklist that names who must be told and what must ship first, across several repos, advisory only* is not offered by any tool above. Danger JS and PR templates are the nearest and are per-PR.

## 4. Agent memory products (a different idea)

They remember what happened; multivac states what must be true.

- **mem0** ([repo](https://github.com/mem0ai/mem0); Apache-2.0, 69,284 stars): a memory layer for assistants and agents (user preferences).
- **Letta** ([repo](https://github.com/letta-ai/letta), Apache-2.0, 25,505 stars): stateful agents whose memory "can learn and self-improve".
- **claude-mem** ([repo](https://github.com/thedotmack/claude-mem), Apache-2.0, 118,641 stars, pushed 2026-11-20): captures what the agent does and re-injects it next session.
- **Devin Knowledge** (*closed*, [docs](https://docs.devin.ai/onboard-devin/knowledge)): tips and instructions recalled by trigger, can be built from READMEs; the docs now recommend Skills for new instructions.
- **Claude Code auto memory** ([docs](https://code.claude.com/docs/en/memory)): notes Claude writes itself, loaded at the start of every conversation, local to the machine. **Windsurf's own docs** say generated memories stay on the machine and advise writing durable team knowledge into a rule or `AGENTS.md` instead.
- Also seen: **graphiti** ([repo](https://github.com/getzep/graphiti), Apache-2.0, 32,966 stars) temporal knowledge graphs; **basic-memory** ([repo](https://github.com/basicmachines-co/basic-memory), AGPL-3.0, 4,647 stars) markdown notes shared with an AI; **serena** ([repo](https://github.com/oraios/serena), licence per component: SolidLSP MIT, application GPL-3.0-or-later, 31,556 stars) semantic code tools over MCP.

None checks its memory against the code. The consequence for gonogo: its Mission Log and `memory.md` are in this family, and so are exposed to the same rot.

## 5. Multi-agent orchestrators and where they keep knowledge

| Tool | Stars / push | Licence | Knowledge per project? |
|---|---|---|---|
| [OpenHands](https://github.com/OpenHands/OpenHands) | 93,927 / 2026-11-21 | MIT | Agent Canvas control centre, runs several agent backends; I did not find a per-repo knowledge file in its README |
| [ruflo](https://github.com/ruvnet/ruflo) (was claude-flow) | 82,166 / 2026-11-20 | MIT | agents, hooks, vector memory added to the project by `init` |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28,757 / 2026-11-15 | Apache-2.0 | kanban plus workspaces; README says **"Vibe Kanban is sunsetting"** |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | 24,237 / 2026-05-15 | Apache-2.0 | **archived** |
| [goose](https://github.com/aaif-goose/goose) | 56,834 / 2026-11-20 | Apache-2.0 | not checked |
| [codex](https://github.com/openai/codex) | 135,995 / 2026-11-21 | Apache-2.0 | not checked |

I found no orchestrator that keeps *verified* knowledge per project. Most keep orchestration state (tasks, workspaces) and leave knowledge to the engines' own files.

## What gonogo should build in

Constraint from FLIGHT's t86: rooms work on N projects, so knowledge is project-scoped and lives in the repo; the room keeps only how-we-work rules. Fido's design note is `docs/knowledge-spec.md` on `fido/knowledge-spec`; this section only adds the market view.

1. **The door (B): build it, small.** The standard exists and gonogo's Engine Bay runs many CLIs. A project-level `AGENTS.md` plus the one known gap (Claude Code: a `CLAUDE.md` containing `@AGENTS.md`) covers Copilot, Windsurf, Devin, Cursor and Codex without a projector. Cost: S. Do not invent a new format.
2. **Verified claims (A): do not write our own verifier; reuse or detect.** Five small tools plus multivac already cover it, none mature. The honest options: detect an existing `.multivac/` and show its state (the Director's own tool, MIT, deterministic), or call `claims` or stalebrain as the user's choice. Building a third grammar is the largest cost and the least differentiated. If gonogo wants one thing here, it is for its **own** memory (Mission Log, `memory.md`): flag entries that name a path, a file or a command that no longer exists, by plain `exists` checks, no grammar. Cost: S for that, L for a grammar.
3. **The closing ritual on a Mission (C): this is the gap, and it fits gonogo.** No market tool offers an advisory checklist that outlives a single PR; gonogo already has Missions, a Flight Plan and a team that reviews (RSO, RETRO). A per-Mission checklist (who reviews, who is told, what ships first), shown, never a gate, is cheap and unique. Cost: M. It matches Danger JS and PR templates in spirit but at the unit gonogo owns.
4. **Do not copy:** multivac's brain-repo as the entry point and refusing code outside a change (spec-kit and OpenSpec already own that, with far more users); automatic cross-repo landing order.

## What is unclear or not checked

- Star counts of days-old repos mean little; ranking by stars says nothing of quality. The closest tools to A (stalebrain, claims, staleproof) were not installed or run, only their READMEs read.
- stalebrain's comparison table is its author's; I repeated it only as "per its table".
- Closed products: licence and pricing not read; behaviour is from the vendors' docs as found by search, several of which disagree with each other (Claude Code and AGENTS.md; Cursor `.md` vs `.mdc`; Swimm pricing).
- I found no repository for a multi-harness *projector* and no tool that does multivac's cross-repo ritual; absence in a search is not proof of absence.
- mem0 and Letta details are from their READMEs, not tried.
