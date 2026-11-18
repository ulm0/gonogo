# Worktrees: a git worktree per agent

The `Own git worktree` box of the hire and edit form starts an agent in its own git worktree and branch of the
project, on your machine, so that two agents never edit the same checkout. It works for every engine. Design and limits:
[`docs/worktrees-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/worktrees-spec.md). It was tried with the
stand-in agent and real `git`, never with a real `claude` ([What was not verified](../reference/not-verified.md)).

- **Needs.** A working directory inside a git repository. The form and each start refuse with the reason when it is not.
  The box is hidden while Clean Room is ticked, which has a worktree of its own (the two together are refused).
- **The copy.** At the first start gonogo makes `~/.gonogo/worktrees/<name>` on a new branch `gonogo/<name>` from `HEAD`
  (uncommitted changes are not in it, and it is never refreshed from `main`). The agent starts in the same subfolder its
  directory has in the repository. Later starts find the worktree again; a folder that was deleted is made again on the old
  branch; a branch that exists is used as it is.
- **The agent may commit.** Unlike Clean Room, git works there. Its role says: "Your files are a git worktree on the branch
  `gonogo/<name>`. Commit there; the Director merges the branch." You review and merge the branch yourself.
- **Hangar and Recorder** open the worktree, not the main folder.
- **Rename** is refused while the box is ticked (the folder and branch carry the name); untick it in the same edit.
- **Edit.** Turning it on or off applies at the next start. Turning it off keeps the worktree and the branch.
- **Stop, restart, Hold, a Redline trip, a crash:** nothing happens to the worktree.
- **Remove.** The remove dialog has a box, off by default: *Also delete its worktree and branch*. With it gonogo runs
  `git worktree remove` and `git branch -d`, never `--force` or `-D`: git keeps a folder with unsaved changes and a branch
  that is not merged. Files that git ignores (`.env`, `node_modules`, build output) are not counted as unsaved: they are deleted with the worktree. The console is removed either way, and the reason git gave is in gonogo's log.
- **The panel** shows the branch, the path and what is in it: unsaved changes, commits ahead, merged
  (`GET /api/agents/<name>/worktree`).

## Limits

- **Not a security boundary.** Two worktrees of one repository share `.git`: a hook the agent plants in `.git/hooks` runs on
  your machine at your next git command. Clean Room is the boundary.
- Submodules and `git lfs` are not set up in a new worktree.
- Switching an agent between Clean Room and a plain worktree: both use the branch `gonogo/<name>`, and git refuses one
  branch in two worktrees, so remove the old worktree first.
- Not built yet: a boss's `hire_agent` request does not carry the setting (a hired agent has none).
