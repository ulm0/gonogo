# Recorder: git of an agent

<RecorderMock class="doc-mock" />

OPEN GIT (next to OPEN FILES) or the GIT tab of [Hangar](./hangar.md) opens RECORDER: changes, diff, the last 50 commits and a commit with your message, for that agent's folder or [Clean Room](./clean-room.md) worktree. Git does not run inside a Clean Room container, so this commits its branch without a terminal. Under the diff: [Post-Flight Review](./review.md). Design and limits: [`docs/recorder-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/recorder-spec.md).

- **Changes**: branch and one row per file in words (`staged: modified`, `not staged: deleted`, `staged: renamed from a.txt`, `untracked`, `conflict`). At most 1000 files; an untracked folder is one row. A row shows that file's diff.
- **Diff**: read-only. NOT STAGED (tree vs index), STAGED (index vs last commit), ALL CHANGES or one file. At most 256 KiB, then marked cut. A new file has no diff until staged.
- **Log**: last 50 commits (short hash, subject, author, time).
- **Commit**: message (1 to 10000 characters), then ALL CHANGES (`git add -A`, commit) or ONLY WHAT IS STAGED (stage with git yourself).
- **Author**: from your git config (`user.name`, `user.email`). With none the commit is refused; gonogo never invents one.
- **No hooks run**, for any call (the agent can write them): your `pre-commit` does not run here.
- **Not here**: push, pull, checkout, reset, amend, branches, signing options.

Works on the **top** of a repository only: an agent in a subfolder, in none, or in a repository holding gonogo's own folder sees why instead.

## API

Browser token; `<name>` is an agent.

| Route | Answer |
|---|---|
| `GET /api/agents/<name>/git` | `{ "repo": true, "branch", "files": [{ "path", "index", "tree", "from"? }], "more", "author": { "name", "email" } \| null }` or `{ "repo": false, "reason" }`; `index`, `tree` are the two letters of `git status --porcelain` |
| `GET .../git/diff?path=&staged=1` | `{ "diff", "truncated" }` |
| `GET .../git/log` | up to 50 `{ "hash", "author", "at", "subject" }` |
| `POST .../git/commit` | `{ "message", "scope": "all" \| "staged" }` -> `{ "commit": { "hash", "author", "at", "subject" } }`; 409 for no author, nothing to commit, nothing staged, or a git refusal (its first line) |

git runs with an argument list, no shell, no prompt, hooks off, 15 s read and 30 s write, environment limited to `PATH`, `HOME`, `USER`, `LOGNAME`, `XDG_CONFIG_HOME`, `TMPDIR`.
