# Spec: the agent as co-author of its commits (draft)

Design by FIDO, 2026-11-18, task t55. Status: built (0.4.0). As built: the hook folder is written at each start for every engine on the host (a Clean Room agent has none); `gonogo doctor` prints `ok  co-author line  git version ...` or says it needs 2.31; the per-agent opt-out is `coauthor: false` on the record and the form. Git behaviour was **tried on this host with git 2.39.5** in a temporary repository (husky-style `core.hooksPath`, a linked worktree, a template, an amend, a merge, `--no-verify`) and read from the git docs (githooks, git-commit, git-hook).

## Intent

A commit an agent makes carries `Co-Authored-By: flight (gonogo) <flight@gonogo.invalid>`, as Claude's own trailer does. On by default; opt-out for the room (Flight Rules) and per agent. The repository's own config and the user's global git config are never written.

## What git gives (checked)

- **Env config.** `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>` set config for one process tree and win over the repository's. Needs git 2.31 or newer (2021).
- **`prepare-commit-msg`** edits the message file before the commit; its second argument is the source: `message`, `template`, `merge`, `squash` or `commit` (`-c`, `-C`, `--amend`). The githooks page says it **is not suppressed by `--no-verify`** (`--no-verify` skips only `pre-commit` and `commit-msg`); the trial agreed.
- **`git interpret-trailers --in-place --if-exists addIfDifferent --trailer ...`** puts the trailer in the message's trailer block, after existing ones, and adds nothing when the same trailer is already there (trial: an amend did not duplicate; Claude's own `Co-Authored-By: Claude` stayed and ours followed it). A comment-only template and a worktree commit both worked.
- **Config hooks** (`hook.<name>.event` / `.command`) exist in current git and run **in addition to** the hooks directory, which would be the clean way (nothing to chain). The docs do not say since which version, and the host has 2.39.5, which does not have them: **not usable now.** Upgrade path, in one line of the spec: when `git --version` reports a version known to support them (the builder confirms the number from the release notes), use the config hook and drop the shims.
- `git commit --trailer` exists, but only helps if gonogo controls the command line, which it does not.

## Options

### A. `core.hooksPath` by env, with a chaining dispatcher (pick)
`GIT_CONFIG_COUNT=1`, `KEY_0=core.hooksPath`, `VALUE_0=<home>/agents/<name>/githooks` in the agent's environment (appended after any `GIT_CONFIG_COUNT` already set by the shell). That directory holds one script `dispatch` and **a symlink for each hook name**; each symlink behaves as that hook:
1. Find the **real hooks directory** at run time: `env -u GIT_CONFIG_COUNT git rev-parse --git-path hooks` (so husky's `core.hooksPath=.husky/_`, a plain `.git/hooks`, and a linked worktree's shared hooks all resolve as git itself would without us).
2. If an executable hook of this name is there, **run it first with the same arguments and stdin** (`pre-push` and `post-rewrite` read stdin) and exit with its status if it fails. The repo's hooks keep working, in their own order, unchanged.
3. For `prepare-commit-msg` only, and not for source `merge` or `squash`: `git interpret-trailers --in-place --if-exists addIfDifferent --trailer "Co-Authored-By: <name> (gonogo) <<name>@gonogo.invalid>" "$1"`.
Trial result: husky-style pre-commit ran, trailer added after Claude's, `--no-verify` still added it, amend did not repeat it, worktree and template worked, a merge commit got none.

**Which hook names get a symlink.** The 28 in githooks(5) (applypatch-msg, pre-applypatch, post-applypatch, pre-commit, pre-merge-commit, prepare-commit-msg, commit-msg, post-commit, pre-rebase, post-checkout, post-merge, pre-push, pre-receive, update, proc-receive, post-receive, post-update, reference-transaction, push-to-checkout, pre-auto-gc, post-rewrite, sendemail-validate, fsmonitor-watchman, p4-changelist, p4-prepare-changelist, p4-post-changelist, p4-pre-submit, post-index-change) **plus every executable name found in the real hooks directory at start**. A hook name added by a newer git that is in neither list would be skipped: this is the known gap, and the reason the config-hook upgrade path is the end state.

### B. Tell the agent in its role text
One sentence ("end each commit message with ..."). Free, works with no git feature, **and is not a guarantee**: a model forgets, rewords, and `git commit --amend --no-edit` of an old commit does not get it. Kept as the fallback for engines whose agent runs git somewhere gonogo's env does not reach. Not the mechanism.

**Pick A**, because it is the only mechanism that marks commits the agent did not think about, and it chains instead of replacing.

## Design

- **Trailer.** `Co-Authored-By: <name> (gonogo) <<name>@gonogo.invalid>`; `<name>` is the agent's name (pattern already limited to characters that are safe in a name and a mailbox). `.invalid` is reserved (RFC 2606), so it can never be a real account; GitHub then shows the co-author by name only. If rooms arrive (`docs/rooms-spec.md`) the local part becomes `<name>.<room>`.
- **Settings.** Room: `<home>/coauthor.json` `{ version: 1, enabled: true }` (0600, atomic, damaged file means default on), `GET/PUT /api/coauthor`, a checkbox in Flight Rules ("Add a gonogo co-author line to commits agents make"). Agent: `AgentRecord.coauthor?: false` (absent follows the room), a box on the hire and edit form. Applies at the next start; the console shows as needing a restart.
- **Who gets it.** Every engine that runs git on the host and starts with gonogo's environment: Claude Code, Codex, opencode, pi, Gemini, agy, the custom command. A plain worktree agent too (the hooks dir is per agent, the repo's hooks are found through git). **Clean Room: not applicable**: git does not work inside the container and the Director commits from outside (`docs/clean-room-spec.md`). **Not the Director's commits**: Recorder runs git with a built environment and `core.hooksPath=/dev/null`, so neither the env nor the hook reaches it; a test pins that.
- **Duplicates.** Keep **both** trailers: Claude's (the model) and gonogo's (which agent of the room). They name different things. gonogo's own is never added twice (`addIfDifferent`; amend and rebase leave one). Nothing is done about a trailer another tool wrote.
- **Safety.** The dispatcher is a POSIX `sh` script written by gonogo into the agent's own folder, with fixed content (no value from the agent or a repository goes into it, the name is validated), run by git as the agent's user: it adds no privilege. It never writes the repository's config, hooks or `.git`, nor `~/.gitconfig`. If `git interpret-trailers` fails, the hook **exits 0** (a missing trailer must never block a commit). A repository hook that fails still fails the commit, as before.
- **What it does not do** (said in the docs): it marks commits made through git's normal hooks. It is not a proof of authorship: the agent can unset the environment, run `git -c core.hooksPath=...`, use `git commit-tree` or a library that skips hooks, and commits made by an agent with a different git (inside a container) are not marked. A pushed rebase of someone else's commits by an agent keeps the trailers as they are.
- **Git older than 2.31.** `GIT_CONFIG_COUNT` is ignored: no trailer and no harm. `gonogo doctor` prints the git version and "co-author: needs git 2.31 or newer".
- **Windows.** Out of scope (the sh dispatcher).

## Scope of the PR (GUIDO)

`src/server/coauthor.ts` (store, `dispatch` text, `ensureHooksDir(agentDir, extraNames)`, `coauthorEnv(...)`, trailer text); the launcher adds the three env variables for non-Clean-Room agents when enabled and writes the hooks dir at each start (idempotent, symlinks only); `AgentRecord.coauthor`, hire/edit validation, dirty flag; Flight Rules box; the form box; `gonogo doctor` line; `docs/features/coauthor.md` with the "does not do" list above; backlog line. About 300 lines with tests. **Left out:** config hooks (until the version is known), a per-engine variation, rewriting old commits, a different trailer text, trailers for the Director.

## Tests (real git in temp repositories, as `test/cleanroom.test.ts` does)

Trailer added with `-m`, with a template, with `--amend` (not twice), with `--no-verify`; Claude's trailer kept and ours after it; merge and squash get none; a husky-style relative `core.hooksPath` pre-commit runs and can **fail the commit**; `pre-push` style hook gets its stdin and arguments; a linked worktree; an extra hook name found at start is chained; a hook that is not executable is skipped, as git does; `interpret-trailers` failure exits 0; an existing `GIT_CONFIG_COUNT=2` is extended, not replaced; env absent for Clean Room, for an agent that opted out, and when the room is off; agent folder content is exactly the dispatcher and symlinks; Recorder's commit has no trailer; `.invalid` mailbox for every valid agent name; neither `~/.gitconfig` nor the repo's `.git/config` changes (compare before and after).
