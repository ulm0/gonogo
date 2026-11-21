# Spec: project knowledge, one door, and the closing ritual (draft 2)

Design by FIDO, 2026-11-21, task t86 (scope widened by FLIGHT: a thorough analysis, not one page). Status: draft, not built. **No code in this branch.**

How it was made. multivac was read in full where it matters (`DESIGN.md`, `package.json`, the file list of `ulm0/multivac` at v0.15.0, `src/anchor/{parse,evaluate,match}.ts`, `src/lib/ritual.ts`, `src/doors/{link,block}.ts`, `src/types.ts`, `.multivac/*`, the commands reference) **and run**: `multivac@0.15.0` from npm, installed with `--ignore-scripts` in my scratchpad and used on a throwaway git repository there (never on the gonogo repo or `main`). gonogo was read on `origin/main` (file and line cited). Not read: multivac's `src/lib/{config,regex,git}.ts`, `src/commands/*` (except through running them) and its tests. Not tried: multivac with several repos (`repos sync`, `change apply/land`), `seed`, and the SDD adapters.

## 1. Summary and recommendation

- **Build three small things, scoped to the repo, and detect a fourth.** (A) verified claims in the repo, which gonogo flags stale; (B) one door: the room's rules plus the repo's own `AGENTS.md` reach every engine; (C) a closing checklist on a Mission, never a gate; (D) if a repo has `.multivac/`, show its verify state, read-only.
- **One rule runs through all of it: gonogo reads the repo and never writes it.** Agents already edit the repo; they write claims like any file. gonogo verifies and shows. (Engine Bay already says the same of the CLIs' own files: `docs/features/engine-bay.md:24`, "never in your project or the CLI's home".)
- **Do not import multivac.** It has no library entry point and no types, and its evaluator, when run the default way, rewrites the user's files. gonogo reimplements the anchor grammar subset it needs (about 250 lines) so a table can move to multivac unchanged, and for a repo that already uses multivac it only runs `multivac verify --check --quiet`.
- **The one real danger is regexes from repo files.** I ran multivac's own verifier on a 40-character line against `/(a+)+$/`: it did not finish in 20 s (killed). gonogo must evaluate in a worker with a time limit, or one claim file freezes the server.
- **Order:** Door and Ritual first (small, no new store), Claims last (the big one, cuttable), the `.multivac` row with it. Four PRs, about 1,350 lines in all. Open questions for the Director are in section 9.

## 2. What multivac is (read, and run)

**Purpose.** "Brain-driven development": one *brain* repo of claims, law and ritual, from which several code repos are developed; "deterministic verification, no model in the path" (`package.json`, `DESIGN.md`). Node 24+, MIT, dependencies `citty`, `picomatch`, `yaml`; npm package `multivac`, bins `multivac` and `mvac`; v0.15.0, still 0.x (I did not read its changelog; treat every minor as possibly breaking). It can be its own brain (`brain==code`: `repos: { brain: . }`), which is the shape gonogo would use for one project.

**Four commands matter here.** `init` (scaffold), `verify` (check claims against code), `doors` (project the agent door into harness files and install git hooks), `change new|plan|apply|land|close` (a change file crossing repos). The commands list also has `seed`, `count`, `doctor`, `repos`, `roadmap`, `help`.

| Job | Data and format | What I saw when I ran it |
|---|---|---|
| **Claims** | A table in `.multivac/invariants.md`: `\| ID \| statement \| authority \| state \| date \| source \|` (six columns, counted from the end because statements quote `\|`; `parseClaimRows`), and under each row **anchor comments**: `<!-- @anchor <ID> <repo>:<glob> [!<glob>] /<regex>/[i] [present\|absent\|unique\|count=N\|each\|each!] -->`. A claim may have several legs (AND). Globs are picomatch over `git ls-files`; regexes are one POSIX-ERE-like dialect, and `\s`, `\b` are refused with a hint. | 3 claims, 3 anchored, exit 0. After I moved a file: `moved` (present leg), `vacuous` (the glob matches nothing, blocking for `absent`/`count`), **exit 1**. `\s` in a regex: `parse ... \s is not POSIX ERE — use [[:space:]]`. 0.17 s for a tiny repo. |
| **Verify states** | ok, moved, broken, vacuous, pending (claim of an open change), plus a `drift` row state. Exit matrix: blocking modes (`absent`, `count`, `each`) exit 1; `present`/`unique` broken exit 0 unless `--strict`. | **`verify` without `--check` rewrote `.multivac/invariants.md`** (a moved glob healed in place; `git status` showed ` M`). With `--check` it wrote nothing and said "rerun without --check to rewrite". |
| **Doors** | `AGENTS.md` is the one canonical door; `CLAUDE.md` is a symlink to it; harnesses that read `AGENTS.md` natively (opencode, codex, windsurf, cursor) get nothing; copilot a stub. Generated text lives between `<!-- multivac:begin -->` and `<!-- multivac:end -->`; the rest of the file is the user's. | `init --provider claude,codex` wrote `AGENTS.md`, `CLAUDE.md -> AGENTS.md`, `.claude/settings.json` and `.claude/skills/...`, `.multivac/*`. **It set the repository's `core.hooksPath` to `.multivac/hooks`** (git config of the user's repo) and installed pre-commit, pre-push and pre-merge-commit hooks that run `verify`. The generated `.claude/settings.json` runs `mvac verify` on SessionStart and after every Edit/Write (exit 2 feeds the failure back to the agent). |
| **Change lifecycle** | `.multivac/changes/<slug>.md`: front matter (`repos`, `landing_order`, `invariants`, `claims`) plus per-repo status (planned, branched, committed, mr, landed); `change close` re-verifies the declared claims and archives. | **`change new "points expire"` made a git commit by itself** ("committed: change open"), reserved a claim id and created the file. `apply` makes a git worktree per repo, `land` opens merge requests. |
| **Ritual** | `.multivac/ritual.md`: free lines; `change close` prints them. "Printed, not verified. Nothing gates on it" (`DESIGN.md`, "The ritual"). `ritualChecklist` strips comments, headings and blank lines. | `init` writes it all commented out, "a commented line never prints". |

**Importable as a library: no.**
- `package.json` has `bin`, `files: ["dist","skills"]`, and **no `main`, no `exports`, no `types`**. The published tarball (816 kB unpacked) has **no `.d.ts` files at all** (I counted: 0).
- The modules do export names: `parseAnchors`, `collectBrainAnchors`, `parseClaimRows`, `readClaimRows` (`anchor/parse`), `evaluateAnchors`, `RepoHandle`, `EvaluateOptions` (`anchor/evaluate`), `RepoScanner`, `scanLeg`, `scanWholeRepo`, `matchesInFile` (`anchor/match`), `ritualChecklist`, `ritualSeed` (`lib/ritual`), `linkDoor`, `CANONICAL_DOOR` (`doors/link`), `applyManagedBlock`, `renderBlock`, `stripManagedBlock` (`doors/block`). Node would resolve `multivac/dist/anchor/evaluate.js` (no `exports` map to forbid it), but it is not a supported surface.
- They are coupled to multivac's model: `evaluateAnchors` needs a `brainDir`, resolved repo handles and a `write` flag (**`write: true` edits the brain files**); `parseAnchors` reads `CHANGES_DIR` and `LAW_PATH` from `lib/config`; `collectBrainAnchors` walks the brain's `.multivac/` layout.
- **CLI-only:** `init`, `doors`, `change`, `seed`, `repos`, `doctor`, `roadmap`, and the report text of `verify` (no `--json` in the commands reference; the summary line `N blocking broken · exit N` at a line start is documented as stable).

**Surprises worth knowing before gonogo touches it.** (1) `init`, `doors` and `change` **write the user's repo and its git config and make commits**; gonogo must never run them. (2) Default `verify` writes; only `--check` is read-only. (3) The regex engine has no time limit (probe above). (4) In a multivac repo, every commit an agent makes runs `.multivac/hooks/pre-commit` (verify) because of `core.hooksPath`; gonogo's co-author dispatcher already chains the repository's real hooks first (`src/server/coauthor.ts:44`, `git rev-parse --git-path hooks`), so a blocking claim can **fail an agent's commit**: that is the repo's policy, but the room should say so when it happens (open question 5). (5) `.claude/settings.json` in the repo adds Claude Code hooks; whether they merge with the settings gonogo passes to its agents was **not verified**.

## 3. What gonogo already has (overlap)

| gonogo today | Where | Overlap with |
|---|---|---|
| **Mission Log**: shared memory of the room; one file per entry `<home>/mission-log/<id>.md`, tags (at most 8), author, BM25 search; tools `log_search/log_read/log_write` | `src/server/missionlog.ts:4`, `src/shared/protocol.ts:1097` (`LogEntry`), `docs/features/mission-log.md:3` | "lessons learned". It is **room-wide, not project-scoped**, and nothing checks an entry against code. Claims fill exactly that gap; the Mission Log stays for decisions. |
| **Per-agent `memory.md`**, with REFLECT (Mass Budget) | `src/server/launcher.ts:644`, `src/server/massbudget.ts:21`; the role text says "add a short note to it" (`src/server/constants.ts:288-300`) | agent-private, unverified, per agent |
| **Role text and preamble**: injected at start; `--append-system-prompt` for Claude, first prompt for Gemini and others | `src/server/constants.ts:288` (`ROLE_PREAMBLE`), `src/server/launcher.ts:99` (`buildRoleText`), `:603`, `:704`; `src/server/providers.ts:181-232` (per engine) | the door: the one place that reaches every engine |
| **Missions, tasks, T-minus** | `src/shared/protocol.ts:1008` (`Task`), `:1031` (`Mission`), `src/server/missions.ts:148`, `:165` (`version: 1`) | a Mission has name, goal, lead, status, history, **no repo and no checklist**; a Task has no repo |
| **Flight Rules** (room settings page; blocks such as Coauthor, Room keys) | `src/client/Rules.tsx:153`, `:200-212` | where room rules would be edited |
| **Worktrees and Clean Room**: an agent on its own branch and checkout | `src/shared/protocol.ts:401-405` (`CleanRoom`, `Worktree`), `src/server/worktree.ts:30` | how the project is picked |
| **Engine Bay**: one table of CLIs, each started its own way | `src/server/providers.ts:181` (gemini), `:192` (codex), `:207` (opencode), `:222` (copilot), `:224` (pi), `docs/features/engine-bay.md` | the door per engine |
| **Safe git** | `src/server/recorder.ts:35` (`BASE_ARGS`: hooks and fsmonitor off, literal pathspecs), `RECORDER_READ_MS` at `:18` | how to run git on a repo an agent can write |
| **Hangar** (the Director edits files, realpath-checked, no `.git`) | `src/server/hangar.ts:4` | how the Director fixes a claim from the page |
| **Post-Flight Review** (notes on an agent's diff) | `src/server/review.ts:2` | a natural place to show "claims that this diff made stale" |
| **Feature switches** | `src/server/features.ts:37`, `src/shared/features.ts` | a new feature can ship behind a switch |

**What gonogo lacks:** any notion of a *project* (the repo) other than the agent's start directory; any check that a statement is still true; any checklist on a Mission.

## 4. The pieces

A **project** below means the git repository (top level, by `git rev-parse --show-toplevel`) of a directory. The same picking rules apply to every piece, so they are stated once.

**How the project is picked in a generalist room.**
1. **An agent:** the repo of its start directory `AgentRecord.dir` (`src/shared/protocol.ts:491`). A worktree or Clean Room agent has its own checkout, so it sees *its branch's* claims, which is right (claims travel with the code).
2. **An agent with no worktree:** the same, in the shared checkout; two agents in one checkout share the answer.
3. **A Mission:** an optional `repo` (absolute path) that defaults to the lead's repo at creation. It only chooses the ritual template and the Knowledge block's grouping.
4. **A Task:** has no repo; it inherits its mission's, else its assignee's.
5. **An agent that works across two repos** (`dir` is the parent folder, not a repo; or it `cd`s elsewhere): **not followed**, said in the docs. `dir` outside any repo shows no knowledge. If that is too weak, add `AgentRecord.projects?: string[]` (extra repo directories); open question 3.
6. **Two projects in one task:** one task, two agents, two repos: each agent's tile shows its own repo's state; the Knowledge block lists each repo once (deduplicated by realpath).

### A. Verified claims (lessons anchored to code)

- **User value.** The thing agents most often get wrong is acting on stale knowledge ("we don't use X", "the limit is 5"). A claim with an anchor says which files must contain or not contain what; when code changes and the claim stops being true, the room says so at the moment work starts. No model in the loop; plain matching.
- **Data model.** `<repo>/.gonogo/claims.md`, **multivac's own table and anchor grammar** (six columns, `<!-- @anchor ... -->` legs, repo key `brain`), so the file can move under `.multivac/invariants.md` unchanged and back. gonogo supports modes `present`, `absent`, `unique`, `count=N`, `each`, `each!`; states ok, **stale** (a leg fails), **vacuous** (the glob, after exclusions, matches no tracked file), **unanchored**, **malformed** (file:line and the defect, never skipped). Row states: `active`, `proposed` (shown, never flagged), `retired` (ignored). `authority` is free text (multivac's values are `published|specified|open`; the builder reads `lib/config` to confirm). Not supported in v1: `moved` self-heal, `pending` (changes), `drift`.
- **Where files live.** In the repo, versioned and reviewed with the code. Nothing in the room's home.
- **When it runs (cost).** Triggers: agent start; an agent's Stop hook, **debounced to once per 60 s per repo** and only when `.gonogo/claims.md` exists; Review open; a RECHECK key; never on a timer. A repo with no claims file costs one `stat`. Work: `git ls-files` (tens of ms for thousands of files), read each *matched* file once up to 1 MiB, one regex pass per leg. Caps: 20,000 files, 64 MiB total per run, 200 rows. multivac's own run was 0.17 s on a tiny repo; I did not measure a large one.
- **Staleness.** The result is a function of the working tree (that is what multivac reads too), so it can be stale between triggers; the page shows "checked 40 s ago on `feature/x` @ abc1234". A claim edited by an agent in the same turn is re-read at the next trigger.
- **Failure modes.** A weak anchor (a word that appears everywhere) stays ok forever: gonogo shows the anchored count and the vacuous legs, and says in the docs it cannot judge meaning. A claim file with a typo is `malformed`, shown, never silently skipped. A repo in the middle of a rebase or an unreadable file: the check ends with "could not check: <reason>", never stale. Huge or binary files are skipped with a count.
- **Role and surfaces.** The role text gets **one pointer line**, not the claims: "Verified claims for this project are in `.gonogo/claims.md`; read it before you start; when you learn a fact that stays true of this code, add a row with an anchor". The start notice for an agent says only `knowledge: 2 stale, 1 vacuous` (counts). The agent tile shows a badge; the **Knowledge** block (new, in the room view) lists claims per repo with state and a link to the file in Hangar.
- **Cost: L** (about 600 lines): parser (about 120), evaluator and worker (about 200), cache and triggers, Knowledge block, tile badge, tests.

### B. One door for every engine

- **User value.** The same rules ("how we branch, how we report, never touch X") reach Claude Code, Codex, Gemini, opencode and the rest, without the user maintaining five files, and the room-wide ones do not have to be copied into every repo.
- **Data model.** Two sources, joined at agent start: **room rules** `<home>/rules.md` (text, 0600; edited in a Flight Rules block, in the room's home, so it is not in any repo) and **project rules**, the repo's own `AGENTS.md` (or `CLAUDE.md` when that is all there is), which gonogo reads but never edits.
- **How gonogo delivers it.** Not by writing files. The room rules are added to the role text through the channel each engine already has (`providers.ts:181-232`). For the project rules: **a pointer**, "The project's rules are in `AGENTS.md` at `<repo root>`: read it first", added only for engines that do not load that file themselves; for engines that do, nothing (no duplicate). Whether each engine auto-loads `AGENTS.md` or `CLAUDE.md` is **not verified here**: from general knowledge Claude Code reads `CLAUDE.md`, Codex and opencode read `AGENTS.md`, Gemini reads `GEMINI.md` unless configured; the builder checks each CLI's current docs and `gonogo doctor` prints a table "reads AGENTS.md: yes / no / unknown".
- **Where it breaks.** An engine that takes no role text (a custom command has none; one engine has "no checked way to pass a role", see the comment at `providers.ts:232`): no door, said in the table. A huge `AGENTS.md`: only the pointer is injected, so nothing is cut. Two rules disagreeing (room says "squash", repo says "rebase"): the repo's wins by order in the text ("the project's rules win over the room's"); said once in the docs.
- **What multivac's `doors` do that gonogo will not:** write symlinks and managed blocks into the repo, install git hooks, add skills. The user can run `ln -s AGENTS.md CLAUDE.md` themselves; a print-only `gonogo doors` that prints the commands is a later option (like `gonogo expose`), not in this work.
- **Cost: S** (about 150 lines): rules store and block, the delivery, the doctor table.

### C. The closing ritual on a Mission

- **User value.** Missions end with "done" and nothing says what a good ending is. A short checklist ("the reviewer read it", "the changelog line is written", "the phone alert was tested") shown when the mission is closed is exactly multivac's "printed, not verified" idea, and it needs no checking logic.
- **Data model.** `Mission.ritual?: { text: string; done: boolean; by?: string; at?: number }[]` in `missions.json` (optional field; the file stays `version: 1`, as `keys` did for `agents.json`). At most 20 items of 200 characters, one line, control and bidi characters stripped. **The template is copied, not linked**, at creation: `<home>/ritual.md` (room default) first, then the repo's `.gonogo/ritual.md` or `.multivac/ritual.md` (same extraction as multivac's `ritualChecklist`: comments, headings and blank lines dropped). Editing the template later never changes an open mission.
- **Behavior.** The Director ticks items on the mission page; the lead may tick through `mission_update` (boss only today, per `docs/guide/the-room.md`). **Never a gate:** the mission can become `done` with items open; the page says "2 of 5 closing items left" and the Downlink line for `done` lists them. The ritual is shown at the moment of closing, which is when it matters.
- **Project picking.** The repo of the mission's `repo`, else the lead's. If neither has a ritual file, the room default; if that is empty, no checklist at all.
- **Failure modes.** A template with 200 lines: first 20 taken, the rest dropped with a visible "20 of 200". An unreadable file: the room default.
- **Cost: S to M** (about 250 lines): field and validation, template read, page, Downlink line, tests.

### D. Detecting `.multivac/` and showing its state

- **Value.** A user who already uses multivac sees its verdict in the room, without gonogo re-implementing it.
- **How.** If `<repo>/.multivac/config.yml` exists **and `multivac` is on the `PATH`** (gonogo has `onPath` for doctor): run `multivac verify --check --quiet` in the repo, **never without `--check`** (default `verify` writes), never any other subcommand (`init`, `doors`, `change` write and commit). No shell, 20 s limit, a small environment (`PATH`, `HOME`, and `GIT_CONFIG_COUNT` settings turning off `core.hooksPath` and `core.fsmonitor`; environment config wins over the repo's, `docs/coauthor-spec.md`). Parse the one summary line; show `multivac: 0 blocking broken · 12 claims` and the raw first lines on demand. Same triggers and caps as A. If the binary is missing, show "multivac not found" and nothing else. Do not create `.gonogo/claims.md` in such a repo: its claims live in multivac.
- **Cost: S** (about 150 lines).
- **Failure modes.** The report text changes in a later multivac (it is 0.x): the parser falls back to "could not read the report", never a false green. The user's multivac version is not ours: the table of known summary lines is pinned to the version tested (0.15.0) and logged.

## 5. Options per piece: import, reimplement, integrate

| | **Import multivac's core** | **Reimplement a subset (pick for A)** | **Integrate only (pick for D)** |
|---|---|---|---|
| What | `import { evaluateAnchors } from 'multivac/dist/...'` | gonogo's own parser and evaluator, same grammar and table | run the user's `multivac verify --check --quiet`, read its output |
| Coupling | high: its brain/config model, its git helpers, its `write` flag | none at runtime; **a shared file format** is the only contract | the CLI contract only |
| Versioning | multivac is 0.x with breaking minors; gonogo would pin and track it; no types, so a `.d.ts` shim | the grammar is small and stable; gonogo versions its own subset; a conformance test file of anchor lines (copied from multivac's public docs) catches drift | follows whatever the user installed; summary line parsed defensively |
| Licence | MIT on both sides, the Director's own: no issue; a vendored copy needs the notice | n/a | n/a |
| Dependency cost | `citty`, `picomatch`, `yaml` come along (gonogo today avoids new dependencies) | none: `node:fs`/`git` and a small matcher; the builder checks `fs.glob` in Node 24 | none |
| Risk | evaluator can rewrite files; no time limit on regex | gonogo owns the time limit and read-only rule | multivac can write if run wrong: only `--check` ever |
| **Verdict** | no | **A: yes** | **D: yes** |

If the Director later adds an `exports` map for `anchor/*`, types, and a `verify --json`, gonogo can swap the evaluator behind one function (`verifyClaims(repoDir)`); that is his call in his repo. For B and C there is nothing to import: `ritualChecklist` is six lines, and `linkDoor` writes into the repo.

## 6. Security (RSO reads this section)

The new surface is **repo content an agent can write, read by gonogo and shown or acted on**. An agent in a repo, or anything that can make an agent write there (a prompt injection in a README, a dependency), controls: `.gonogo/claims.md`, `.gonogo/ritual.md`, `AGENTS.md`, `.multivac/*`, and the worktree's `.git/config` and symlinks.

| Threat | Why it is real | Must hold |
|---|---|---|
| **S1 Prompt-injection into other agents' door** | If gonogo pasted claims or `AGENTS.md` into the role text it would put agent-written text at **system-prompt authority** (`--append-system-prompt`, `providers.ts:226`) for every other agent on that repo. | gonogo **never pastes repo content into the role text**: only fixed text, the room's own rules (the Director's file), a pointer path and counts. Agents read repo files as ordinary file reads, as they do today. A test checks the role text contains no byte of `AGENTS.md` or `claims.md`. |
| **S2 Symlink leak** | A Clean Room agent (or any agent) can make `.gonogo/claims.md` a symlink to `<home>/auth.json` or `~/.ssh/...`; gonogo reads it and shows statements in the page. | Read only **regular files, opened without following links** (as Hangar does, `hangar.ts:4`), after an `lstat` of every path component inside the repo; claims, ritual and matched files alike. Files come from `git ls-files` and symlinks are skipped. Test: a link to a file outside the repo is not read and not shown. |
| **S3 ReDoS** | Repo regexes run in gonogo. **Proven**: multivac's verifier did not finish `/(a+)+$/` on a 40-character line in 20 s. A hung evaluation freezes the Node event loop: every agent, hook and page of the room. | Evaluate in a **worker thread killed after 5 s** (the claim becomes `unevaluated: too slow`); pattern at most 200 characters; line length cap 4 KiB; no backreferences or lookbehind (refused at parse, in the spirit of multivac's dialect check). A test runs `/(a+)+$/` and expects the worker killed and the server answering. |
| **S4 Git config executes programs** | A repo's `.git/config` (an agent can write it) can set `core.fsmonitor`, `core.hooksPath`, `diff.external`, `filter.*`; plain `git` commands in gonogo would run them. | Reuse the Recorder's approach (`recorder.ts:35`): `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, `--literal-pathspecs`, no pager; only `ls-files`, `rev-parse`, `cat-file`; **no `git grep` with textconv, no `diff`**. For D, the same through `GIT_CONFIG_COUNT`. |
| **S5 Running the user's `multivac`** | It is a program found on the `PATH` and it reads the repo. | Only with `--check`, only for repos the Director hired an agent into (the folder is already trusted), no shell, 20 s, a small environment, never from the repo (never `./node_modules/.bin` or a path in a config file). Never `init`, `doors`, `change`, `seed`, `repos sync` (they write, commit or clone). A test fails if the argument list lacks `--check`. |
| **S6 Display of untrusted text** | Claim statements, ritual items and file names appear in the page, the start notice and the Downlink; one could carry bidi marks, markup or a long social-engineering line ("run this command to fix"). | `textContent` only; strip control, bidi and zero-width characters (U+202A to U+202E, U+2066 to U+2069, U+200B to U+200F); cut to 200 characters; ritual items are plain text with no links; the notice carries **counts, not text**. |
| **S7 Writes into the repo** | Any write by gonogo into a repo changes the user's tree and could be steered by an agent. | **gonogo writes nothing in the repo**. The only paths that change files are the ones that already exist (Hangar and Recorder at the Director's click). A test compares the tree before and after a check. |
| **S8 Resource use** | A repo with a million files or 10 GB. | The caps of section 4A; `git ls-files` through a stream with a byte cap; one evaluation per repo at a time; the debounce. |
| **S9 Stale trust** | A green "ok" next to a weak anchor is false comfort. | The page shows anchored count and vacuous legs; the docs say "ok means the pattern still matches, not that the sentence is true". |
| **S10 Hooks changing behavior** | In a repo with `.multivac/hooks`, an agent's commit can fail because of a blocking claim; multivac's `.claude/settings.json` hooks may feed failures to the agent. | Not gonogo's policy; but the room shows the failing hook's first line in the agent's tile when a commit is refused (existing hold/notice path), and the docs warn. |

RSO should also check: that `rules.md` (a room file, the Director's) is not world-writable and not readable through any agent route; and that the Knowledge block never renders a path outside the repo.

## 7. What NOT to build

- **The brain repo as the entry point, the change gate ("no code outside a change"), spec-kit/OpenSpec adapters, forced landing order, `change apply/land` (worktrees per repo and merge requests).** They solve cross-repo coordination for a team that works *from* a brain; gonogo's rooms already have Missions, worktrees and Review, and the Director's constraint is N independent projects, not one ecosystem. A gate would also make `gonogo` refuse work, which it never does.
- **Importing multivac as a dependency.** Section 5.
- **Writing doors into repos** (`AGENTS.md` blocks, symlinks, `.claude/` hooks and skills, `core.hooksPath`). It changes the user's tree and git config; the pointer in the role text gets the same effect without a file.
- **Self-healing of moved anchors.** It writes files; in gonogo a `moved` leg is just reported (and only if cheap to detect; v1 says "stale").
- **A claim database in the room.** Claims are repo content; copying them into `<home>` makes two sources of truth.
- **Auto-written claims** (an agent that "learns" and files claims alone). A claim without a human-reviewed anchor is noise; the Director or an agent *in a reviewed commit* adds rows.
- **Per-engine door formats and skill installers.** Out of scope; the pointer works for all.
- **Blocking commits or tasks on stale claims.** Informational only.
- **A semantic or LLM judge of claims.** multivac's whole point is "no model in the path"; so is ours.

## 8. Phased plan (four PRs, about 1,350 lines)

| PR | What | Size | Needs |
|---|---|---|---|
| **1. Door** | `<home>/rules.md` and its Flight Rules block, delivery in the role text per engine, the pointer to the repo's `AGENTS.md`, `gonogo doctor` table, `docs/features/door.md` | S, ~150 | the engine table filled from each CLI's docs |
| **2. Ritual** | `Mission.ritual`, template reading, ticking, the page, the Downlink line, `docs/features/missions.md` update | S to M, ~250 | independent of 1 (run in parallel) |
| **3. Claims** | parser, worker evaluator, triggers and debounce, Knowledge block, tile badge, start notice, role pointer, `docs/features/knowledge.md` | L, ~600 | RSO review **before** merge (section 6); a feature switch, default off for one release |
| **4. `.multivac` row** | detection, `verify --check --quiet` run, summary-line parser, row in the Knowledge block | S, ~150 | after 3 (shares the block) |

Each PR: spec section, page in `docs/features/`, a builder and an independent reviewer. PR 3 can be cut without losing 1, 2 or 4's door and ritual halves.

**Tests (by PR).** 1: rules reach each engine's launch (a fake provider per table row); no rules file, no added text; pointer only for non-auto-loading engines; no repo content in the role text (S1). 2: template order (room, then repo), comment and heading stripping, caps, done-with-open-items works and says so, old `missions.json` reads, edits of the template do not touch open missions. 3: each mode on a temp repo; stale, vacuous, unanchored, malformed rows; untracked and symlinked files ignored; the S2, S3, S4, S7 tests above; debounce; two worktrees of one repo with different claims; multivac's own anchor lines (copied from its public docs) parse identically (conformance). 4: a fake `multivac` on the `PATH` for ok, broken, missing and an unknown summary format; `--check` always in the arguments; hooks and fsmonitor off in the environment. Not testable here: a real multivac across several repos, and each engine's actual use of `AGENTS.md`.

## 9. Open questions for the Director

1. **Scope:** all four, or Door and Ritual only (about 400 lines, no repo reading at all) and Claims later?
2. **Own folder `.gonogo/` or `.multivac/`:** my pick is `.gonogo/` for writing (so gonogo never collides with multivac's governance) and read-only use of `.multivac/`. Is a second dot-folder in user repos acceptable, or do you want the claims in a file the user names (for example in `docs/`)?
3. **Several repos per agent:** is "the repo of the start directory only" enough, or should an agent (and a mission) carry a list of extra repo directories?
4. **Will you add `exports`, types and `verify --json` to multivac?** If yes, PR 3 could call it instead of its own evaluator; if not, gonogo's subset is final. (Your repo, your call; the grammar stays compatible either way.)
5. **Commits blocked by multivac hooks:** when an agent's commit fails because of `.multivac/hooks`, should the room say so plainly in the tile and the Downlink, or leave it to the terminal?
6. **Role text authority:** are you comfortable with room rules in `rules.md` reaching every agent at system-prompt level (they are yours), while repo content never does?
7. **Feature switch:** ship Claims behind a Feature switch, default off for one release?
8. **Unverified engine facts:** who confirms which CLI reads `AGENTS.md` (me by reading each CLI's docs at build time, or you)?
