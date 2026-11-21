# Worktrees: a git worktree per agent

<WorktreesMock class="doc-mock" />

The `Own git worktree` box of the hire and edit form starts an agent in its own git worktree and branch of the project, so two agents never edit the same checkout. Every engine. Design and limits: [`docs/worktrees-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/worktrees-spec.md). Tried with the stand-in agent and real `git`; no real `claude` has run in one ([What was not verified](../reference/not-verified.md)).

- **Needs** a working directory inside a git repository (form and each start refuse with the reason). The box is hidden with Clean Room ticked, which has its own worktree (both together are refused).
- **The copy**: first start makes `~/.gonogo/worktrees/<name>` on a new branch `gonogo/<name>` from `HEAD` (uncommitted changes not included; never refreshed from `main`). The agent starts in the same subfolder its directory has in the repo. Later starts reuse it; a deleted folder is recreated on the old branch; an existing branch is used as is.
- **The agent may commit** (unlike Clean Room). Its role says: "Your files are a git worktree on the branch `gonogo/<name>`. Commit there; the Director merges the branch." You review and merge.
- Hangar and Recorder open the worktree.
- **Rename** is refused while the box is ticked; untick it in the same edit.
- **Edit**: on or off applies at the next start; off keeps worktree and branch.
- Stop, restart, Hold, Redline trip, crash: the worktree is untouched.
- **Remove**: a box, off by default, *Also delete its worktree and branch* runs `git worktree remove` and `git branch -d`, never `--force` or `-D`: git keeps a folder with unsaved changes and an unmerged branch. Ignored files (`.env`, `node_modules`, build output) are not counted as unsaved and are deleted. The console is removed either way; git's reason is in gonogo's log.
- **The panel** shows branch, path, unsaved changes, commits ahead, merged (`GET /api/agents/<name>/worktree`).

## Limits

- **Not a security boundary**: worktrees share `.git`, so a hook the agent plants in `.git/hooks` runs on your machine at your next git command. Clean Room is the boundary.
- Submodules and `git lfs` are not set up in a new worktree.
- Switching between Clean Room and a plain worktree: both use branch `gonogo/<name>` and git refuses one branch in two worktrees; remove the old worktree first.
- A boss's `hire_agent` can ask for it with `worktree: true` ([Relief](./relief.md)): the request shows a *Worktree* row, the folder must be in a git repository, and a Clean Room boss cannot ask for it.
