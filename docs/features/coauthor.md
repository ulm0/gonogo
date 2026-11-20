# Co-author line: the agent's name on its commits

<CoauthorMock class="doc-mock" />

Agent commits end with `Co-Authored-By: flight (gonogo) <flight@gonogo.invalid>`, so history says which console did the work. **On by default.** Turn it off for the room in Flight Rules (CO-AUTHOR LINE) or for one console in its form; applies at each console's next restart. Design: [`docs/coauthor-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/coauthor-spec.md). Tried with real git 2.39.5 in temporary repositories ([What was not verified](../reference/not-verified.md)).

- **How:** your repository and git config are never written. The console's environment makes git read hooks from a folder in the console's own folder (`GIT_CONFIG_COUNT`, git 2.31 or newer). Those hooks run **the repository's own hook of the same name first** (husky, `.git/hooks`, worktree hooks); a failing one still fails the commit. `prepare-commit-msg` then adds the line with `git interpret-trailers`; `--no-verify` does not skip it.
- **Its own commits only:** a commit being replayed (cherry-pick, revert with conflicts, rebase, `git am`) gets no line, nor does an amend of a commit whose author is not the console's git identity. **This works only when the console's git identity differs from yours**: with the same config, an agent amending your commit still gets the line. An amend is read from the `git commit` command line via `/proc` or `ps`; on a host with neither, an amend with `-m` of someone else's commit would get the line.
- **Both lines stay:** Claude's (the model) and gonogo's (which console). gonogo's is never added twice. Merges and squashes get none.
- **Address** ends in `.invalid`, so it can never be a real account; GitHub shows the name only.
- **Which commits:** every console that runs git on your machine (Claude Code, Codex, opencode, pi, Gemini, custom command, plain worktree console). Not Clean Room consoles (you commit from outside). **Not commits you make through Recorder.**
- `gonogo doctor` prints the git version and warns below 2.31 (no line, no harm).

## Footer of the pull requests

Every pull request a Claude Code agent writes ends with **Generated with [gonogo](https://gonogo.ulm0.com/)** (a robot emoji in front), instead of Claude Code's own line. On by default; second switch of the same Flight Rules block (CO-AUTHOR LINE AND PR FOOTER); applies at each console's next restart.

- gonogo writes `attribution: { "pr": "<the line>" }` into the agent's settings file (`includeCoAuthoredBy` is Claude Code's deprecated older way; the one with its hooks; never `~/.claude` or the repository's `.claude`). Name read in Claude Code 2.1.325's settings schema (`attribution: { commit?, pr?, sessionUrl? }`; empty string hides it). Only `pr` is set.
- Your own settings are kept: Claude Code merges layers key by key. In one short run (2.1.325, haiku) a project's `attribution.commit` and gonogo's `attribution.pr` were **both** in force.
- Clean Room agents get it too.
- Other engines get none (no known setting); a custom command writes what it writes.
- Rolling back to a build without this switch and forward again turns a footer you had switched off back on (the old build saves `coauthor.json` without the field).
- **Not tried on a real pull request**: written and read back in tests, name from the schema.

## Limits

- Not a proof of authorship: an agent can unset the environment, run `git -c core.hooksPath=...`, use `git commit-tree` or a library that skips hooks.
- A commit by a different git (inside a container) is not marked. A rebase of someone else's commits keeps their lines.
- Always chained: pre-commit, commit-msg, pre-merge-commit, pre-push, pre-rebase, post-commit, post-checkout, post-merge, post-rewrite (so hooks added later by `husky install` or `lefthook install` still run). Chained only if the repository has them when the console starts: rarer hooks, `reference-transaction`, `post-index-change`.
- Windows is not covered (the dispatcher is a `sh` script). Git older than 2.31 ignores the setting.
