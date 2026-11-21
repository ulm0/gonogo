# Knowledge anchors: say what an entry rests on

A Mission Log entry like "the limit is 5" goes stale when the code changes. An **anchor** ties an entry to a literal text in a repository, and the page and the log tools say when it is **not confirmed**. It is a hint: nothing is blocked, and no model reads anything. Off until you turn it on: Flight Rules -> **FEATURES** -> Knowledge anchors (it needs [Mission Log](./mission-log.md)). Design: [`docs/knowledge-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/knowledge-spec.md) section 0.3.

## An anchor

An entry holds up to 5. Each is:

| Field | |
|---|---|
| `root` | The absolute path of the top of a git repository (`git rev-parse --show-toplevel`). An **agent** names the top of **its own** folder (for a Clean Room or worktree agent, its own worktree, never the host checkout). **You** may name the top of any agent's folder, on an entry of your own. Any other path is refused |
| `file` | A path inside the root: relative, no empty part, no `..`, no `~`, no backslash, no drive letter, at most 300 characters. Required for `present`; for `absent` it may be left out, meaning "any tracked file" |
| `text` | A **literal** string, one line, 1 to 200 characters, not starting with `-`. Not a pattern: `.` is a dot |
| `mode` | `present`: the file holds the text. `absent`: the file (or, with no file, no tracked file) does not |

Agents set them with `log_write` (`anchors`), you with `POST` or `PUT /api/log`; `"anchors": []` removes them, and a change that does not name `anchors` keeps them. On an entry an agent wrote, an anchor you add names that agent's own repository, as the entry's author decides what may be named. With the feature off, a request that carries `anchors` is refused (400); anchors already stored are kept and not checked. The server adds the `branch` the root was on when the anchor was written.

## What a check says

| State | Means |
|---|---|
| **ok** | Every anchor holds: "confirmed on main@abc1234" |
| **stale** | At least one does not: "not confirmed on main@abc1234", or "file not found here", and for a search with no file "(3 files)": the **count**, never the names. Never "false": the text may have moved, or the entry may be old |
| **vacuous** | An `absent` anchor's file is not there: "check the path" |
| **unchecked** | It could not be checked, and why: not tracked, too large, the file changed during the check, git did not answer in time, too slow, no agent works at that root now, or the root is not the author's own |

If the root is on another branch than the one the anchor was written on, the note adds "not the branch it was written on". The state shows as a chip on the entry and on its row in a search, and in `log_read` and `log_search` (`anchorState`).

- **A file** is read only when git lists it as tracked, so a `.env` that is not tracked is `unchecked: not tracked`, and is never opened. gonogo reads the real path of the file, which must lie under the root's real path, with no link followed, a regular file, the very file it looked at, up to 1 MiB.
- **A search** is `git grep -F -l -z --no-textconv --no-recurse-submodules -e <text> --` through the same safe git as the [Recorder](./recorder.md): the repository's own git config cannot name a program to run, the environment is clean, tracked files only, 5 s, output capped.
- **When:** when an entry is opened (`log_read`, the page) or turns up in a search, the same anchors at most once per 30 s, a whole check at most 5 s, and **one check at a time for a root**. A search shows the last answer and starts the checks of its first five entries for the next look, so a first search can show none yet. The check looks at the working tree of the root, not at a branch.

## What it does not do

- It does not say a sentence is true: `ok` means the text is where the anchor says.
- Nothing from a repository goes into a prompt, a message or a note: the notes are written by gonogo from fixed words, a branch name, a short hash and a count.
- It never blocks a task, a commit or an entry.
- Not built yet: a count on an agent's tile and in its start notice, a RECHECK key, patterns and globs.

## The full grammar and the engine (phase 2, K2)

The anchors of a Mission Log entry (above) are two modes over one file and a fixed text. The **claims** of the Knowledge store use the full grammar of [multivac](https://github.com/ulm0/multivac) (MIT, (c) 2026 Pierre Ugaz, whose code the parser, the dialect gate and the leg semantics are ported from; each ported file says so). One anchor is one line:

```
<!-- @anchor K-3 brain:src/**/*.ts !**/*.test.ts /export const VERSION/ unique -->
<!-- @anchor K-3 brain:docs/*.md "a fixed string" absent -->
```

- **`brain:<glob>`** is the files the leg looks at (the repo key is always `brain`: a store has one repo; any other key, and `*:`, is *malformed: this store has one repo*). Globs are [picomatch](https://github.com/micromatch/picomatch) (`**`, `{a,b}`, dotfiles match) over **tracked** paths. `!<glob>` subtracts files (`!brain:<glob>` is the same). A glob is refused when it is empty, over 200 characters, absolute, `~`, has a `..`, an empty part (`a//b`), a backslash, a NUL or a control character, or a drive letter.
- **`/regex/`** is POSIX ERE with `[[:class:]]`, and the flag `i` only. `\s \d \w \b`, backreferences, `(?...)` and lazy quantifiers are refused with the fix in the message. gonogo also refuses what multivac lets through: a pattern over **200 characters**, and a **repeated group that holds a quantifier** (`(a+)+`, `(a*)*`, `(.*a){20}`), the shape that takes exponential time. An alternation in a repeated group is allowed only when every alternative is plain text of the same length (`(foo|bar)+`); `(a|aa)+` and `(a|b+)*` are refused. What the gate cannot see (`(.*)(.*)(.*)(.*)x`) is left to the time limit below.
- **`"literal"`** instead of a regex is gonogo's own: a fixed string of at most 200 characters (`\"` and `\\` are the only escapes), compared as text, no regex engine.
- **Modes:** `present` (the default: some line matches), `absent`, `unique` (exactly one match), `count=N`, `each` (every file of the glob has a match) and `each!` (no file has one). The legs of one claim are ANDed. A line that carries a whole anchor comment never matches, so a claim's own pattern cannot satisfy another. A CRLF line is a line.
- **Results:** per leg `ok`, `stale`, `vacuous` (the glob matches no tracked file after the exclusions: check the path) or `unevaluated` (and why); per claim the worst leg, plus `unanchored` (no legs) and `malformed` (the line and the defect, never skipped). `stale` says *may have moved* for `present` and `unique`, *likely real* for `absent`, `count`, `each` and `each!`: **a hint, never a gate**. A `present` leg that found nothing names the one other file of the same kind that holds the pattern, when there is exactly one (the Director's page only). Every result carries the branch and the short commit it ran on.
- **Fenced and indented code** in a claims file is documentation, not law.

**The engine.** A regex runs inside gonogo's own process, so one run of one checkout is a `worker_threads` worker with `resourceLimits` (128 MiB old generation, 16 MiB young, 4 MiB stack) that a timer ends at **5 s in all** (the listing of files included): what was finished is kept, the rest is `unevaluated: too slow`, and the room goes on answering. At most **2 workers at once** in a room's process and **10 waiting**; past that a run is `unevaluated: busy` and queues nothing. **One run per checkout at a time** (a second trigger gets that run) and **at most one every 30 s** (inside it, the last answer; claims not in it say *not checked yet*). A proposal's trial run takes a worker slot and a queue place like any other and is not merged or kept. Files are listed with `git ls-files -z` (the Recorder's arguments: no fsmonitor, no hooks, no `GIT_*`, a clean environment) and read in the worker: only tracked files, through their real path under the root, `O_NOFOLLOW`, the opened file must be the one `lstat` saw, regular files only; **20,000 files, 1 MiB a file, 64 MiB a run, 200 claims, 500 legs**. A literal `absent` leg over `**` with no exclusion is answered by `git grep -F -l -z --no-textconv --no-recurse-submodules -e <text> --` (a text that starts with `-` is never given to git). Notes are written by gonogo from fixed words and counts; nothing read from a repository goes into one, apart from the one file name above. The engine writes nothing in a repository.

Not ported from multivac: the rewriting of moved anchors, the SQL statement normalization (a `*.sql` file is matched per line), git helpers, anything that writes a repository. **Not verified:** the phase 1 log anchors still run on their own checker (`src/server/anchors.ts`); moving them onto this engine is a separate change.

