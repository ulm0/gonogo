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
