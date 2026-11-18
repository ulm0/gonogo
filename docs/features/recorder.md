# Recorder: git of an agent

<RecorderMock class="doc-mock" />

OPEN GIT (next to OPEN FILES), or the GIT tab of [Hangar](./hangar.md), opens RECORDER: what changed in the folder of that agent (or its [Clean Room](./clean-room.md) worktree), the diff, the last 50 commits, and a commit with your message. Design and limits: [`docs/recorder-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/recorder-spec.md). Git does not run inside a Clean Room container, so this is how you commit its branch without a terminal.

## What it does

- **Changes.** The branch and one row per file, in words: `staged: modified`, `not staged: deleted`, `staged: renamed from a.txt`, `untracked`, `conflict`. At most 1000 files; untracked folders are one row. A row shows that file's diff.
- **Diff.** Read-only, on an LCD. NOT STAGED is the working tree against the index, STAGED the index against the last commit; ALL CHANGES or one file. At most 256 KiB, then it says it is cut. A new file has no diff until it is staged.
- **Log.** The last 50 commits: short hash, subject, author, time.
- **Commit.** Message (1 to 10000 characters), then ALL CHANGES (`git add -A`, then commit) or ONLY WHAT IS STAGED (the index as it is; stage with git yourself).
- **Author.** The one in your git config (`user.name`, `user.email`). With none, the page says so and the commit is refused; gonogo never makes one up.
- **No hooks.** No git hook runs, for any call: a hook is a program inside the repository, and the agent can write it. Your `pre-commit` hook does not run on a commit made here.
- **Not here.** Push, pull, checkout, reset, amend, branches, signing options. The server runs no other git command.

Works on the **top** of a repository only: an agent in a subfolder of one, or in none, sees why instead of the tab's content. So does a repository that holds gonogo's own folder.

## API

All need the browser token. `<name>` is an agent.

- `GET /api/agents/<name>/git` answers `{ "repo": true, "branch", "files": [{ "path", "index", "tree", "from"? }], "more", "author": { "name", "email" } | null }`, or `{ "repo": false, "reason" }`. `index` and `tree` are the two letters of `git status --porcelain`.
- `GET /api/agents/<name>/git/diff?path=&staged=1` answers `{ "diff", "truncated" }`.
- `GET /api/agents/<name>/git/log` answers up to 50 `{ "hash", "author", "at", "subject" }`.
- `POST /api/agents/<name>/git/commit` with `{ "message", "scope": "all" | "staged" }` answers `{ "commit": { "hash", "author", "at", "subject" } }`; 409 for no author, nothing to commit, nothing staged, or a refusal by git (its first line).

git runs with an argument list and no shell, no prompt, hooks off, 15 s for a read and 30 s for a write, and the environment limited to `PATH`, `HOME`, `USER`, `LOGNAME`, `XDG_CONFIG_HOME` and `TMPDIR`. No option, no file of its own, no frame.
