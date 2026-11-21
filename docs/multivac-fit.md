# multivac: what it is, and how well it fits gonogo (analysis, draft 1)

By FIDO, 2026-11-21, task t86 phase 2, for the Director. Companion to `docs/knowledge-spec.md` (the design if gonogo builds something from it). INCO's market scan is separate.

## 0. Verdict in ten lines

1. multivac's one big idea is **a citation that can age loudly**: a statement about a codebase with an ID, plus a machine-checkable *anchor* (a pattern that must, or must not, appear in named files). Its other parts (the cross-repo change lifecycle, the SDD gate, the brain repo, git-hook enforcement) exist to make teams *work from* that brain. That second half does not fit gonogo.
2. gonogo's users are not the multivac user. multivac is built for one decision-maker who curates a **brain repo** and works across several repos from it ("you enter only the brain"). gonogo rooms are generalist: many unrelated projects, many engines, agents that write notes on their own, and a person who will not tend a knowledge base.
3. The anchor engine is small and portable (about 1,100 lines of TypeScript in `src/anchor`, `lib/regex`, `lib/glob`); the rest of its 16,000 lines is lifecycle, adapters and CLI.
4. **Evidence is thin:** one validated ecosystem, the author's; "released, and early" (its own README). The one measurement says 95.1% of 82 real rules were anchorable **by capable agents**, with process rules at 0% and published copy at 14% clean. In gonogo's own Mission Log, 9 of 66 entries are rules or lessons; I judge 2 or 3 anchorable (section 5).
5. **Fit by mechanism:** take as is the anchor grammar idea, the tombstone (`absent`) habit and the "printed, never gated" ritual; adapt the door (as a pointer, never a file written into the repo) and verification (read-only, bounded); leave the brain repo, the change lifecycle, the SDD gate, hooks, doors-as-files, seed/interview and the roadmap.
6. **Run it and you learn what not to do:** default `verify` rewrites the user's files, `init` changes git config and installs hooks, `change` makes commits at every step, and its regex engine hangs on `(a+)+`. gonogo takes the ideas, not the tool.
7. **The lean option (literal anchors on Mission Log entries, plus door, plus ritual) beats the fuller port for now.** It removes the regex (no ReDoS), the new storage and most of the review surface, reuses a habit gonogo agents already have (writing log entries), and costs about a third. The fuller port waits for evidence that anyone writes anchors.
8. The lean option must fix three things first: a log entry has no repo (so it needs a validated root), claims in the room do not travel with a branch, and a literal string is brittle. The first is solved by the same rule as `Mission.repo` (a hired agent's top-level directory).
9. The go signal for phase 2 is a number, not a feeling (section 6): after a few weeks, how many anchored entries exist and how many were fixed, retired or ignored when flagged.
10. Everything in this document was read or run by me unless marked *not verified*; section 1 lists what I did not read.

## 1. What I read, ran and did not

**Read.** `ulm0/multivac` at `main` (v0.15.0) as a tarball: all of `README.md`, the front of `CHANGELOG.md` and its version list; `DESIGN.md` (95 KB) sections 1 to 275 (origin, thesis, ritual, change), 445 to 760 (claim model, modes, severity, healing), 991 to 1062 (door), 1454 to 1700 (scope, risks, positioning, decisions, Measurement 1); `skills/multivac/SKILL.md`; site pages `concepts/philosophy` and `concepts/adoption`; in `src/`, in full: `anchor/{parse,evaluate,match}`, `lib/{ritual,regex,git}`, `doors/{link,block}`, `types`; plus the header comment and exports of every other module (`hooks/install`, `lib/code-in-change`, `lib/dropped`, `lib/repo-state`, `seed/inventory`, `commands/{roadmap,repos,doctor}`, `adapters/{sdd,tracker,detect}`, `change/{reserve,carry}`), and the key names of `lib/config`.

**Not read.** The rest of `DESIGN.md` (sections on the registry, session zero, CLI, dependencies, automation, stack, the second measurement), the bodies of the large command files (`commands/change.ts` is 76 KB, `adapters/registry.ts` 58 KB, `commands/verify.ts` 82 KB), the 88 test files (21,489 lines, 825 cases; I counted them, I did not read them), the changelog body, the other site pages and `skills/*/references`. I did not use the live site `multivac.ulm0.com`.

**Run (scratch repositories in my scratchpad only; never gonogo or `main`).** `multivac@0.15.0` from npm, installed with `--ignore-scripts`: `init --provider claude,codex`, `verify`, `verify --check`, `doctor`, `seed`, `count`, `roadmap`, `change new`, `change plan`, `change apply`, `change close` (refused, correctly, before landing), a deliberately nasty regex, and `verify --check` on a copy of multivac's own repository (945 tracked files, 157 claims). Not run: `repos sync`, `change land` (needs a remote and opens merge requests), the SDD adapters, `doors` on several repos, anything with a network.

## 2. (a) What multivac is, mechanism by mechanism

multivac ("brain-driven development"; bins `multivac` and `mvac`) is a Node 24 CLI, MIT, v0.15.0, 17 releases in 47 days (0.1.0 on 2026-08-16, 0.15.0 on 2026-10-02). Size: 16,173 lines of source (commands 6,741; adapters 2,811; lib 2,552; change 1,385; anchor 904; doors 776; hooks 473; seed 202) and 21,489 lines of tests. It develops itself with itself: 157 claims, 1,419 anchor lines (about nine legs per claim), 136 archived changes.

| # | Mechanism | What it does (read and run) | Size and state |
|---|---|---|---|
| M1 | **Claim table** | `.multivac/invariants.md`, rows `ID \| statement \| authority \| state \| date \| source`. Authority says where a claim comes from (`published`, `specified`, `open`). State: `proposed` (never blocks), `active`, `retired`, `drift` (a real finding that does not gate). IDs are reserved by writing a proposed row under a lock. | `parseClaimRows` 60 lines; `change/reserve` 389 |
| M2 | **Anchors** | `<!-- @anchor ID repo:glob [!glob] /regex/[i] mode -->` under a row; modes `present`, `absent` (tombstone), `unique`, `count=N` (ratchet), `each`/`each!` (universal). A claim may have several legs, ANDed. Regex is one POSIX-ERE-like dialect, compiled to a JS RegExp; `\s \d \w \b` and backreferences are rejected with a hint; SQL and config files are matched per statement. | `anchor/` 904 lines + `lib/regex` + `lib/glob`, about 1,100 |
| M3 | **Verify** | Reads each declared repo's tracked files (`git ls-files`), judges each leg: ok, moved (self-healed by rewriting the glob), broken, vacuous (the glob matches nothing: blocking for `absent`/`count`), pending (claim of an open change). Asymmetric severity: tombstones block, presence checks inform. Exit matrix, `--strict`, `--check` (never writes), `--range base..head` for CI. Brain, consumer and claim-scoped runs. | `commands/verify.ts` 82 KB; 0.17 s on a tiny repo, **1.27 s on 945 files and 1,419 legs** |
| M4 | **Doors** | `AGENTS.md` is the one canonical door; `CLAUDE.md` is a symlink; harnesses that read `AGENTS.md` natively get nothing; a managed block (`<!-- multivac:begin/end -->`) keeps the user's own text. Two kinds: brain door (how to work on the ecosystem) and consumer door (what binds here, where the brain is, "the change may cross repos"). A skill (operating manual) is mirrored for Claude Code. Targets are data in a registry. | `doors/` 776 + `adapters/registry` 58 KB |
| M5 | **Git hooks** | `init` sets the repo's `core.hooksPath` to `.multivac/hooks` and installs `pre-commit`, `pre-push`, `pre-merge-commit` that run `verify`; it chains an existing husky/pre-commit setup. A harness hook (`.claude/settings.json`) runs `verify` at SessionStart and after every Edit/Write. | `hooks/install` 473 |
| M6 | **Enactment** | "You propose, a human enacts": an agent writes `proposed` rows; only a human edit makes one `active`; a pre-commit check (MV-81) reads the index against `HEAD`. | in `verify` |
| M7 | **Change lifecycle** | `change new/plan/apply/land/close`: a change file in the brain (repos, landing order as a graph, invariants touched, claims made true), a git worktree per repo, merge requests respecting the order, `close` re-verifies the declared claims and archives. **Each step commits.** | `change/` 1,385 + `commands/change` 76 KB |
| M8 | **Code-in-change gate** | With a spec-driven tool declared (spec-kit or OpenSpec) and automation on, a commit of code outside an open change is refused (pre-commit, merge, CI range). | `lib/code-in-change` 235; `adapters/sdd` 1,024 |
| M9 | **Ritual** | `.multivac/ritual.md`: free lines, printed by `change close` as a checklist. "Printed, not verified. Nothing gates on it." | `lib/ritual` about 70 lines |
| M10 | **Seed, discovery, interview** | `seed` is a deterministic inventory of where architecture lives (`.multivac/seed-report.md`, 202 lines of pattern data, no model). Discovery and interview are **protocols in a skill** that the user's own agent runs; the human answers the open questions; the output is `proposed` rows. | `seed/` 202; skill references |
| M11 | **Repos registry** | `config.yml` declares repos (`path`, `url`, `channel`, `sdd`, `managed`); `repos sync` clones and fetches (the only network use besides `change`); consumer repos mount the brain (a submodule by default) and are pinned. | `commands/repos` 385; `lib/config` |
| M12 | **Roadmap and tracker** | Planned changes are change files one state earlier; a tracker adapter projects them to issues (the file stays the source). | `commands/roadmap` 382; `adapters/tracker` 155 |
| M13 | **Doctor** | Read-only: what is declared, found, degraded, how to fix it. It said, on my scratch repo: "hooks ... INACTIVE — no runnable multivac, the shims verify nothing". | `commands/doctor` 888 |

**What running it showed (all on a throwaway repo).** Default `verify` **rewrote `.multivac/invariants.md`** (a moved anchor healed in place); `--check` wrote nothing and said so. `init` wrote `AGENTS.md`, `CLAUDE.md -> AGENTS.md`, `.claude/settings.json`, `.claude/skills/...`, `.multivac/*` and **set `core.hooksPath` in the repo's git config**. `change new` and `change apply` **each made a git commit** ("change open: points-expire", "change apply: points-expire"), and `apply` made a worktree and a branch. `change close` before landing refused with the next command. A regex `/(a+)+$/` against a 40-character line **did not finish in 20 s** (I killed it): its dialect gate accepts nested quantifiers. A `\s` in a regex was refused with a hint (good). On its own repository, `verify --check` took 1.27 s for 157 claims; its one red line was `vacuous` because my copy had no `site/static` directory (my artifact, not a defect).

**Evidence behind it (its own `DESIGN.md`).** Built from one real ecosystem (five repos, a 5,400-line brain, operated for months) and validated by one measurement: of 82 real invariants, 24 anchored cleanly and 54 partially (95.1%), 4 did not; the anchors found six live doc-versus-code drifts during the study. By subject: database and ledger, identity and billing claims anchor best (42 to 45% clean); client surfaces 29%; **published copy 14%; operations and process 0%** (all four unanchorable were process rules). The author states the risk himself: "n=1. Exactly one validated example, written by the author", and the README: "What it has not yet met is an ecosystem other than its author's."

## 3. (b) Fit with gonogo's users, mechanism by mechanism

Four traits of a gonogo room, used as the test. **Multi-agent:** several agents at once, often on one repo, sharing notes through the Mission Log. **Multi-engine:** Claude Code, Codex, Gemini, opencode and others, each launched its own way (`src/server/providers.ts:181-232`). **Generalist:** one room works on N unrelated projects; the only project notion is the agent's start directory (`src/shared/protocol.ts:491`). **Will not curate:** one person per installation, who runs the room and does not tend a knowledge base; the agents, not the person, write the notes.

| # | Mechanism | Fit | Evidence and reasoning |
|---|---|---|---|
| M1 | Claim table | **Adapt** | A shared, ID'd statement is useful for several agents. But the six-column table with authority and date assumes a human who curates. For gonogo the table is optional: a Mission Log entry already is a statement with an ID (`l17`), tags and an author (`src/shared/protocol.ts:1097`). |
| M2 | Anchors | **Take the idea; port a subset** | It is the one mechanism that is new to gonogo and fits agents well (agents are the readers who get hurt by stale text). Its modes cost little to implement. Fit limit: "boundaries anchor, behavior partially, process not at all" (its own measurement); gonogo's lessons are often process. Regex is the risky half (S3 of the spec). |
| M3 | Verify | **Adapt: read-only, bounded, informational** | Fits as a flag, never as a gate: gonogo never refuses work. multivac's asymmetric severity (tombstones block, presence informs) is wise, but in gonogo everything informs. Self-heal and the exit matrix are CI features; leave them. The run is cheap (1.27 s at 945 files). |
| M4 | Doors | **Adapt as a pointer, leave as files** | One door for many engines is exactly gonogo's multi-engine problem, and gonogo already has a channel every engine accepts (the role text). Writing symlinks, stubs and managed blocks into the user's repo contradicts gonogo's rule (Engine Bay keeps its config "never in your project", `docs/features/engine-bay.md:24`) and adds files agents then commit. Which CLI reads which file is *not verified*. |
| M5 | Git hooks | **Leave** | Hooks make a verification failure refuse a commit: gonogo's agents commit through a dispatcher that already chains the repo's hooks (`src/server/coauthor.ts:44`), so a multivac-style hook would make agent commits fail for a policy the Director may never have chosen. `core.hooksPath` in the repo's config is the user's tree. |
| M6 | Enactment | **Leave (maybe later)** | "Agent proposes, human enacts" is right where claims bind. For informational flags it only adds a step the non-curator skips, and the claim then never goes live. Relief and approvals already cover the dangerous routes. |
| M7 | Change lifecycle | **Leave** | It exists to coordinate one change across several repos for a team working from a brain. gonogo has Missions, Tasks, worktrees, Review and the Flight Plan; it does not need a second lifecycle, and `change` commits to the user's repo at each step. |
| M8 | Code-in-change gate | **Leave** | A refusal of work. gonogo never gates. It also depends on an SDD tool being installed. |
| M9 | Ritual | **Take as is** (adapt storage) | The best fit in the whole tool: a checklist printed at the moment of closing, never a gate, nothing parsed. Missions have no ending ceremony today (`src/shared/protocol.ts:1031`). about 70 lines of code, no regex, no repo reading beyond one text file. |
| M10 | Seed, discovery, interview | **Leave the commands; keep one idea** | The interview exists because law is "not derivable from code"; a room whose owner does not curate cannot run it. The idea worth keeping is that **the agent proposes and writes**, in a skill-like role line, which gonogo already does for the Mission Log. |
| M11 | Repos registry and mounts | **Leave** | It builds the "ecosystem" (a brain mounted in N repos, pinned). gonogo rooms do not have a declared set of repos; they have agents with directories. |
| M12 | Roadmap and tracker | **Leave** | Missions and the Flight Plan are that list already. |
| M13 | Doctor | **Adapt** | `gonogo doctor` exists; a line per engine ("reads AGENTS.md: yes/no/unknown") is the useful piece. |

**Against the four traits, summarized.** *Multi-agent:* claims and a ritual help (shared, checked context); hooks and gates hurt (agents get blocked by repo policy they cannot change). *Multi-engine:* only a channel that every engine already takes (role text, first prompt) works; per-harness file projection multiplies files. *Generalist rooms:* everything must be scoped to a repo and nothing global; multivac's brain is the opposite (one brain over many repos), which is why only a project-scoped subset fits. *Will not curate:* multivac's law is human-validated by design ("the interview is the product"); gonogo's version has to be written by agents as a side effect of work and judged by cheap checks, or it will not exist.

## 4. (c) Take as is, adapt, leave

**Take as is (ideas and small code).**
- The **claim-plus-anchor** shape and the **grammar** (`<!-- @anchor ID repo:glob "text" mode -->`), as a stable, documented format (MIT; keep a header naming the source).
- The **tombstone**: an `absent` anchor on a dead term, so a retired mechanism cannot come back unnoticed. It is the highest-value, lowest-noise mode (false positives "near impossible", its own table).
- **Vacuity detection**: a glob that matches no tracked file is reported, not green. This failure (a rename silently greening every tombstone) was measured in the author's own study.
- **"Printed, not verified" ritual.**
- **Cite by ID, never paraphrase** (a rule for agents' role text: refer to `l17`, do not retype it).

**Adapt.**
- Verification: **read-only**, bounded (time, bytes, files), run in a worker or a child process, never self-healing, only informing.
- Doors: a **pointer** and the room's own rules through the role text; no file written.
- Anchors' regex: **literal first**; regex only later, with the dialect gate plus the missing nested-quantifier refusal and a worker kill.
- Storage: not a brain repo. Either the room's Mission Log (lean) or a store scoped to one repo (full); see section 5 and `knowledge-spec.md` 4A.
- Doctor: a per-engine line.

**Leave.** The brain repo as entry point; the change lifecycle and landing order; the code-in-change gate and SDD adapters; git-hook enforcement and `core.hooksPath` changes; enactment as a gate; `init`/`seed`/discovery/interview commands; the repos registry, mounts and pins; the roadmap and tracker adapter; doors written into repos; the skill installer. None of these is wrong; each solves a problem a gonogo room does not have, and several write the user's repo.

## 5. (d) The lean option against the fuller port

**Lean (FLIGHT's proposal).** Door (pointer plus room rules) + ritual on Missions + **literal anchors on Mission Log entries**: an entry may carry `@anchor <root> <file> present|absent "fixed string"`; gonogo checks the string in that file and flags the entry **stale** in the Log and on the tiles of agents working there. No regex, no glob, no new storage.

**Fuller port.** The same door and ritual, plus the anchor grammar with globs, regexes, six modes and legs, a worker evaluator, a per-project claim store (in the repo or gonogo-owned) and a Knowledge block (`knowledge-spec.md`).

| | **Lean** | **Fuller port** |
|---|---|---|
| New storage | none (Mission Log files) | a claims store: repo or `<GONOGO_DATA>` (undecided) |
| Regex, ReDoS | none: literal text only; `git grep -F` or a bounded read; a child-process timeout is enough | needs the dialect gate, nested-quantifier refusal, a worker with limits and a 5 s kill |
| Attack surface (see `knowledge-spec.md` s6) | smaller: no regex (S3), claims files not agent-written in the repo (S2 partly), but **agents write log entries**, so paths still need the root rule (M3) | all of S1 to S10 |
| Modes | `present`, `absent` (with a repo-wide `git grep -F` for tombstones) | `present absent unique count each each!` |
| Where claims live | the room: **not versioned with code, lost with the room, blind to the branch** | in the repo (travels) or gonogo-owned (survives the room, not the branch) |
| Reuses an existing habit | **yes**: agents already log findings (`lesson` 5, `rules` 4 of 66 entries here); the anchor is one more line | no: a new file agents must learn |
| Cost | about 200 to 250 lines on top of door and ritual | about 700 lines |
| Risk of building something nobody uses | low (cheap, optional, reversible) | higher (curation burden; n=1 evidence) |

**Evidence from this room.** The Mission Log of this installation has 66 entries: 28 are RSO review records, 11 are janitor rounds, 8 FLIGHT, 8 EECOM, 4 RETRO, 4 INCO, 3 others; by tag, `review` 28, `cleanup` 10, `security` 9, `docker` 9, `login` 8, `lesson` 5, `rules` 4. Only 9 entries (the `lesson` and `rules` ones) are even candidates for "a fact that stays true of this code", and by title my judgment is that **2 or 3 are anchorable** ("decode once, decide on the decoded path (proxy)", "a lost CSS brace nests the whole bundle silently", maybe the Referrer-Policy one); the rest are process ("never edit CHANGELOG.md in a PR", "GitHub actions only through the wrapper"). That matches multivac's own measurement (boundaries anchor, process does not) and says the population of anchorable lessons in a working room is **small**, which favours the cheap option. It is one room and my reading of titles, not a study.

**Recommendation: lean now, fuller port only on evidence.**
1. Build **door** and **ritual** first (they need nothing from phase 1's anchor design, `knowledge-spec.md` PR 1 and 2).
2. Build **literal anchors on Log entries** as phase 1 of knowledge. Minimum data: an optional `anchors` list on a log entry (`{ root, file, text, mode }`), written through the existing `log_write` tool; `root` must be the git top level of a hired agent's start directory in this room (the M3 rule), file path relative, no `..`, regular files only, read with `O_NOFOLLOW`; `present` checks one file for the literal, `absent` runs `git grep -F -l -- <text>` with the Recorder's safe flags and a child-process timeout. Checked at agent start, on Review open, on RECHECK, debounced. Stale entries show a badge in the Log and a count on the tile. Informational only.
3. **Fix the three weaknesses at design time.** (i) *No repo on an entry:* the validated root above. (ii) *Not versioned with the code:* the check names the branch and commit it ran on ("checked on `feature/x` @ abc1234"), and a claim is judged against the agent's own checkout; an entry made on one branch can be stale on another without being wrong, so the badge says "not confirmed here", not "false". (iii) *Literal strings are brittle:* a reformat flags a true claim stale; accepted, and the flag is cheap to clear (edit or retire the entry); say so in the docs.
4. **Go to the fuller port only if** after about four weeks of use (a) a meaningful number of entries carry anchors, (b) flagged entries were acted on (fixed or retired, not ignored), and (c) people ask for globs or regex. Otherwise stop at lean: that is the result of the experiment, not a failure.

## 6. What would change my mind, and what INCO's scan should check

- If a few real users adopt multivac outside its author's ecosystem, and **retention after the first week** looks good, the curation worry in section 3 weakens and the fuller port gets more attractive. The README says it has not met such users yet.
- If the Director's own projects keep claims (his multivac repos), the `.gonogo` versus gonogo-owned storage choice should follow that: the Director already versions claims with code.
- If agents will write anchors unprompted (a role-text line, no more), the lean option's habit assumption holds; test it on this room first.
- Open: whether engines read `AGENTS.md` themselves (affects only the door); whether Claude Code merges a repo's `.claude/settings.json` hooks with the settings gonogo passes (*not verified*; matters only if a repo carries multivac-style hooks).

**Numbers to quote:** 16,173 source lines, 21,489 test lines, 825 test cases, 17 releases in 47 days, 157 claims and 1,419 anchor lines in its own repo, verify 1.27 s at 945 files, 95.1% of 82 rules anchorable (n=1), process rules 0%, published copy 14% clean; here: 66 log entries, 9 lessons or rules, about 2 or 3 anchorable.
