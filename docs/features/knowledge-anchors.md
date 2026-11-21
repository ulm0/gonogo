# Knowledge anchors: say what an entry rests on

A Mission Log entry like "the limit is 5" goes stale when the code changes. An **anchor** ties an entry to a literal text in a file of a repository, and the page and the log tools say when it is **not confirmed**. It is a hint: nothing is blocked, and no model reads anything. Off until you turn it on: Flight Rules -> **FEATURES** -> Knowledge anchors (it needs [Mission Log](./mission-log.md)). Design: [`docs/knowledge-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/knowledge-spec.md).

## An anchor

An entry holds up to 5. Each is:

| Field | |
|---|---|
| `repo` | The absolute path of the top of a git repository that an agent hired in this room works in (the `git rev-parse --show-toplevel` of its folder). Any other path is refused |
| `file` | A path inside the repo: relative, no `..`, no `~`, no drive letter, at most 300 characters |
| `kind` | `present`: the file holds the text. `absent`: it does not |
| `text` | A **literal** string, one line, at most 200 characters. Not a pattern: `.` is a dot |

Agents set them with `log_write` (`anchors`), you with `POST` or `PUT /api/log`; `"anchors": []` removes them, and a change that does not name `anchors` keeps them. With the feature off, a request that carries `anchors` is refused (400).

## What a check says

| State | Means |
|---|---|
| **ok** | Every anchor holds |
| **not confirmed** (`stale`) | At least one does not: "not confirmed on main@abc1234". Never "false": the text may have moved, or the entry may be old |
| **unknown** | It could not be checked: git was not found or did not answer in time, or the repository is no longer one of an agent of this room |

`present` reads the first 1 MiB of a **regular tracked** file (its real path must lie under the repository's, and a link is not followed), so a text past 1 MiB, or in an untracked or linked file, is not confirmed. `absent` is `git grep -F` for the text in the file, as the [Recorder](./recorder.md) runs git: the repository's own git config cannot name a program to run, and the environment is clean. The check looks at the working tree of the folder `repo` names, so two worktrees of a repository can differ.

The state shows as a chip on the entry and on its row in a search, and in `log_read` and `log_search` (`anchorState`). A check runs when an entry is opened (`log_read`, the page) or turns up in a search, at most once per 30 s for the same anchors, and **one at a time for a repository**. A search shows the last answer and starts the check of its first five entries for the next look, so a first search can show none yet.

## What it does not do

- It does not say a sentence is true: `ok` means the text is where the anchor says.
- Nothing from a repository goes into a prompt, a message or a note: the states are written by gonogo from fixed words, a branch name and a short hash.
- It never blocks a task, a commit or an entry.
- Any agent can anchor an entry to the repository of another agent of the room, and learn from the state whether a text is in one of its tracked files (one bit per try, 30 s apart). Agents of a room already share the Mission Log and may read each other's folders' notes; if you do not want that between two agents, keep the feature off.
- Anchors that follow a mission's repository, or a pattern, are not there yet.
