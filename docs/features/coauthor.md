# Co-author line: the agent's name on its commits

<CoauthorMock class="doc-mock" />

A commit an agent makes ends with `Co-Authored-By: flight (gonogo) <flight@gonogo.invalid>`, the way Claude's own line does:
the history then says which console of the room did the work. It is **on by default**; turn it off for the room in Flight Rules
(CO-AUTHOR LINE; it applies at each console's next restart) or for one console in its form. Design and limits:
[`docs/coauthor-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/coauthor-spec.md). Tried with real git 2.39.5 in
temporary repositories ([What was not verified](../reference/not-verified.md)).

- **How.** Your repository and your git config are never written. A console's environment tells git, for that console alone,
  to read its hooks from a folder gonogo keeps in the console's own folder (`GIT_CONFIG_COUNT`, git 2.31 or newer). The
  folder's hooks run **the repository's own hook of the same name first** (husky, `.git/hooks`, a worktree's shared hooks:
  found as git itself finds them), and a failing one still fails the commit. For `prepare-commit-msg` they then add the
  line with `git interpret-trailers`; `--no-verify` does not skip it.
- **Only its own commits.** A commit that is being replayed (a cherry-pick, a revert with conflicts, a rebase, `git am`) is somebody
  else's work and gets no line, and neither does an amend of a commit whose author is not the console's own git identity. **That
  tells them apart only when the console's git identity differs from yours**: with the same git config, an agent that amends your
  commit still gets the line. (An
  amend is recognised from the command line of `git commit`, read from `/proc` or `ps`: on a host with neither, an amend with
  `-m` of someone else's commit would get the line.)
- **Both lines stay.** Claude's line (the model) and gonogo's (which console) name different things. gonogo's is never added
  twice: an amend or a reword leaves one. Merges and squashes get none.
- **The address** ends in `.invalid`, a name reserved so that it can never be a real account: GitHub shows the co-author by
  name only.
- **Which commits.** Every console that runs git on your machine: Claude Code, Codex, opencode, pi, Gemini, a custom command,
  a plain worktree console. A Clean Room console has none (git does not work inside the container, and you commit from
  outside). **The commits you make through Recorder get none.**
- **Doctor.** `gonogo doctor` prints the git version and says when it is older than 2.31 (then there is no line, and no harm).

## The footer of the pull requests

Every pull request a Claude Code agent writes ends with the line **Generated with [gonogo](https://gonogo.ulm0.com/)** (a robot emoji in front of it, as Claude Code's own line has) instead of Claude Code's own line. It is on by default, and it is the second switch of the same Flight Rules block (CO-AUTHOR LINE AND PR FOOTER); it applies at each console's next restart.

- **How.** gonogo writes `attribution: { "pr": "<the line>" }` into the settings file of the agent (the same file as its hooks; never `~/.claude`, never the repository's `.claude`). The name and shape were read in the settings schema of Claude Code 2.1.325, which has `attribution: { commit?, pr?, sessionUrl? }` (text for commits and for pull request descriptions; an empty string hides it; `includeCoAuthoredBy` is the deprecated older way). Only `pr` is set: the commit attribution is Claude Code's own plus gonogo's co-author line above, as before.
- **Your own settings.** Claude Code merges the settings of its layers key by key, `attribution` included: seen in one short run (Claude Code 2.1.325, haiku), an `attribution.commit` in a project's `.claude/settings.json` and an `attribution.pr` in the file gonogo passes with `--settings` were **both** in force. So a commit text you set yourself is not lost, and gonogo copies nothing of it.
- **Rolling back** to a build without this switch and forward again turns a footer you had switched off back on (the old build saves `coauthor.json` without the field).
- **Clean Room** agents get it too (their settings file is the same one).
- **Other engines.** None. gonogo does not know of a setting that the other engines (Gemini CLI, Antigravity, and the others of Engine Bay) have for the text of a pull request, so they write their own, and a custom command writes what it writes.
- **Not tried on a real pull request**: the setting is written and read back in tests, and the name is the one in the schema, but no agent opened a pull request with it here.

## What it does not do

- It marks commits made through git's hooks. It is **not a proof of authorship**: an agent can unset the environment, run
  `git -c core.hooksPath=...`, use `git commit-tree` or a library that skips hooks.
- A commit made by a different git (inside a container) is not marked. A rebase of someone else's commits keeps their lines.
- The commit and push hooks (pre-commit, commit-msg, pre-merge-commit, pre-push, pre-rebase, post-commit, post-checkout,
  post-merge, post-rewrite) are always chained, so a hook that `husky install` or `lefthook install` adds later still runs. A rarer
  hook, and `reference-transaction` and `post-index-change` (which cost a process at every ref update), are chained only when the
  repository has them as the console starts: one added later waits for its restart.
  Newer git has config hooks, which would make this folder unnecessary; this host's git does not have them.
- The switch and a console's opt-out apply at its next restart.
- Windows is not covered (the dispatcher is a `sh` script). Older git than 2.31 ignores the setting.
