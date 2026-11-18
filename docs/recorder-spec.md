# Spec: Recorder

Written and built 2026-11-18. Section 8 of `docs/backlog.md` ("Git tab"), for one agent at a time. The files are the other half
of that section: `docs/hangar-spec.md`.

## Intent

Git does not work inside a Clean Room container, so the Director commits an agent's work from outside; with an agent on the host
he reads what it changed before he lets it go on. Recorder shows what changed in an agent's folder (or its Clean Room
worktree), the diff, the last 50 commits, and makes a commit with a message the Director writes. Nothing else of git: no push,
pull, checkout, reset, branch, stash or merge, and no way to run any other command.

## Design

- **Which folder** is Hangar's (`createRoots`). It must be the **top** of a git repository (`git rev-parse --show-toplevel`
  equals the folder's `realpath`). A folder inside a repository, or in none, is an answer with `repo: false` and the reason,
  not an error. So is a repository that holds gonogo's own home folder: the Recorder will not commit `agents.json` or the
  tokens. shortcut: an agent in a subfolder of a repository gets no Git tab; scope the commands with a pathspec when that
  matters.
- **How git runs** (`createRecorder` in `src/server/recorder.ts`). `execFile('git', args)` with an argument list, never a
  shell, in the folder, with these arguments first: `--literal-pathspecs -c core.hooksPath=/dev/null -c core.fsmonitor=false -c
  core.quotepath=false`. The environment is built, not inherited: `PATH`, `HOME`, `USER`, `LOGNAME`, `XDG_CONFIG_HOME`, `TMPDIR`,
  plus `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` and `LC_ALL=C`. A `GIT_DIR`, `GIT_WORK_TREE` or `GIT_EXTERNAL_DIFF` of
  gonogo's own never reaches git. Time limits: 15 s for a read, 30 s for a write (then SIGTERM, so that git removes its own `index.lock`, answered 503). Output caps: 1 MiB
  for status and log, 256 KiB for a diff, cut with `truncated`. A diff runs with `--no-ext-diff --no-textconv`. A path is a
  pathspec only as a literal name, after the checks of Hangar (no `..`, no absolute path, no `.git`).
- **Hooks are off for every call, the commit too.** A hook is a program in the repository, and the agent can write it. The
  price is that a `pre-commit` hook of yours does not run; the page says so.
- **Status.** `GET /api/agents/<name>/git` answers `{ repo: true, branch, files, more, author }`. `branch` is the first line of
  `git status --branch` (`main...origin/main [ahead 1]`, `No commits yet on main`). A file is `{ path, index, tree, from? }`
  with the two letters of `git status --porcelain=v1`; at most 1000 files, `more` counts the rest; untracked folders are one
  entry. `author` is `{ name, email }` from `git config user.name` and `user.email` (any file git reads), or `null`.
- **Diff.** `GET /api/agents/<name>/git/diff?path=&staged=` answers `{ diff, truncated }`: the working tree against the
  index, or with `staged=1` the index against the last commit; one path, or all when `path` is empty. A new file has no diff
  until it is staged. Read-only: nothing in the page changes the index.
- **Log.** `GET /api/agents/<name>/git/log`: the last 50 commits, newest first, each `{ hash, author, at, subject }` (`at` in
  ms). A repository with no commit answers `[]`.
- **Commit.** `POST /api/agents/<name>/git/commit` with `{ message, scope }`. `message` is 1 to 10000 characters, not
  blank, no NUL; `scope` is `all` (`git add -A`, then commit) or `staged` (commit the index as it is). `git commit -m <message>` runs
  with `-c user.useConfigOnly=true`. **The author is the git config's, never made up:** when `user.name` or `user.email` is not
  set, the answer is 409 (`conflict`, field `author`) with how to set them, before `add` runs. Nothing to commit (`all`) or
  nothing staged (`staged`) is 409 (field `scope`). A failure of git is 409 `git refused: <first line git printed on stderr>`.
  The answer is `{ commit }` read back from the log. There is no `--amend`, `--no-verify`, signing option or author field.
- **Authentication and routes** are Hangar's: the browser token and the Host and Origin checks; the git routes keep the
  256 KiB body limit. No frame goes out; the page asks again (after a commit, and on REFRESH).
- **What this does not stop.** An agent that is not in a Clean Room runs as you and can write the repository's `.git/config`,
  which git reads. Hooks, the file system monitor, the external diff and text conversion are off, but a `filter` driver in that
  config would still run on `git add`, and the `gpg.program` of a repository that signs its commits on `git commit`. Read the status before you commit.

## The page

RECORDER (`Recorder.tsx`, `changes.ts`, `recorder.css`; `store.view` is `recorder`), reached with OPEN GIT next to OPEN FILES, or
with the GIT tab of Hangar. Left: the branch, the author (an amber chip when there is none), every changed file as a button
(its words: `staged: modified`, `not staged: deleted`, `untracked`, `conflict`) that shows its diff, and the commit form (message,
ALL CHANGES or ONLY WHAT IS STAGED with their counts, COMMIT, which says why it cannot when it cannot). Right: the diff on an LCD
(added lines in the LCD's text colour, removed in its warm colour, the sign stays in the text), NOT STAGED and STAGED, and the log.
Under 900 px the columns stack. The page asks again after a commit and on REFRESH; it does not watch the folder.

## Tests

`test/recorder.test.ts` (real git in a temporary repository: status letters, renames, no commit, no author, GIT_DIR in the
environment, a file system monitor and hooks that must not run with a control that shows plain git would run them, the diff cap,
pathspec magic taken as a name, 55 commits cut at 50, a commit of all and of staged, a message with a leading dash, an index lock,
gonogo's home inside the repository), `test/hangar-routes.test.ts` (routes), `test/client-hangar.test.ts` (`changes.ts`). Not run:
a Clean Room worktree from real Docker, a repository with a signing key, submodules, a huge repository, Windows.
