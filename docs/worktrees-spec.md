# Spec: Worktrees for workers (draft)

Design by FIDO, 2026-11-18. Backlog section 4, "Workers in git worktrees" (*inferred*: the reference's behaviour was not
confirmed, this is built from the need). Status: draft, not built.

## Intent

Two workers that edit the same checkout step on each other: one stages half of the other's change, one runs the tests
against a file the other is mid-way through. Give each worker its own git worktree and branch of the room's repository, so
the work of each comes back as a branch the Director reviews and merges. **Clean Room already does this inside Docker**
(`docs/clean-room-spec.md`: `ensureWorktree`, `gonogo/<name>`); this feature is the same worktree without the container, and
with git working inside it.

## Design

- **The setting.** `AgentRecord.worktree?: {}` (absent is off; never stored as `undefined`; an object so a later field, such
  as a base branch, needs no migration). One reader, `parseWorktree`, in `src/server/worktree.ts`, used by hire, edit and
  `home.ts`, like `parseCleanRoom`. All providers, because a worktree is a folder: the agent's `cwd` changes and nothing
  else. A Clean Room agent has a worktree already; `worktree` and `cleanRoom` together are a 400 (field `worktree`), and
  the form hides the box when Clean Room is on.
- **One module.** Move `ensureWorktree`, the branch name and the "same sub-folder below the repository top" rule out of
  `cleanroom.ts` into `src/server/worktree.ts`; `cleanroom.ts` imports them. Behaviour of Clean Room does not change (its
  tests are the proof). The new module adds `removeWorktree` and `worktreeStatus`.
- **Place and branch.** `<home>/cleanroom/<name>` stays for Clean Room. Plain worktrees go to `<home>/worktrees/<name>`, on
  branch `gonogo/<name>`, from the repository's `HEAD`, once. The branch name is the same for both on purpose: an agent
  switched from one to the other can reuse the branch, but only after the old worktree is removed: git refuses a branch checked out in two worktrees, so the start fails with git's message until the Director removes the old one (found at review of W1). Later starts find the worktree again (`git worktree list --porcelain`); a
  deleted folder is pruned and made again on the old branch; an existing branch is used as it is; a foreign folder is an
  error and is left alone (all as `ensureWorktree` does today).
- **The agent starts in** the worktree, in the same sub-folder its `dir` has below the repository top. `dir` outside a git
  repository is a 400 at hire and edit (field `worktree`) and a rejected start, as for Clean Room. The transcript folder
  Claude Code uses follows the `cwd`, so Propellant keeps counting (`transcriptDirName(cwd)`).
- **Role note.** One sentence appended to the agent's role: "Your files are a git worktree on branch gonogo/<name>. Commit
  there; the Director merges the branch." Unlike Clean Room, git works in it, so the agent may commit (it must not push to
  `main`; that is the Director's rule, and `--no-verify`-style guards are not gonogo's job).
- **Rename.** Refused while `worktree` is on (409, field `name`), as for Clean Room, because the folder and the branch carry
  the name. Turning it off in the same edit allows it.
- **Edit.** Turning the setting on or off applies at the next start; the console is `dirty` until then. Turning it off
  keeps the worktree and branch (see cleanup).

## Cleanup, Hold and removal

| Event | What happens to the worktree and branch |
|---|---|
| Stop, restart, exit, crash | Nothing. The worktree is the agent's memory of its work. |
| Hold / Redline trip | Nothing. The process is held; its files stay. |
| Setting turned off | Nothing; the agent starts in `dir` again. The page says the old worktree is still there. |
| Remove the console | The remove dialog asks, default **keep**: KEEP WORKTREE or DELETE WORKTREE. Delete runs `git worktree remove <path>` **without `--force`** (git refuses when the folder has uncommitted changes) and then `git branch -d gonogo/<name>` (git refuses when the branch is not merged). A refusal is shown as the reason, the console is removed anyway and the leftover is listed in the view of the repository (below). |
| Name reused later | `ensureWorktree` meets the old branch and uses it as it is. Same as today. |

gonogo never uses `--force`, `-D` or `prune --expire`, so the only way to lose work is the Director typing it.
`GET /api/agents/<name>/worktree` returns `{ path, branch, dirty, ahead, merged }` (from `git status --porcelain`,
`git rev-list --count main..branch` and `git branch --merged`), shown on the console panel next to the Clean Room line.

## Interfaces

- `src/server/worktree.ts`: `parseWorktree(value)`, `worktreePath(home, name)`, `ensureWorktree(repo, path, branch, env)`
  (moved), `removeWorktree(repo, path, branch, env): Promise<{ removed: boolean; branchDeleted: boolean; reason?: string }>`,
  `worktreeStatus(path, env)`.
- `HubIo.checkWorktree(dir)`: one `git rev-parse --show-toplevel` (no Docker check).
- `AgentView.worktree: { path, branch } | null`; request field `worktree?: {}` on hire and edit; `DELETE
  /api/agents/<name>?worktree=delete` (default `keep`).
- Relief's `hire_agent` gets **no** field for it (the request stays small); a boss hire inherits `worktree` from the boss,
  as it inherits `cleanRoom`, and the `dir` rule of Clean Room (inside the boss's `dir`) applies.
- The form: a "Own git worktree" box; the tile chip `WORKTREE`, in the slot of the Clean Room chip.

## Options

1. **Per-agent setting (pick).** Same shape as Clean Room, so the form, the view and the tests have a pattern to follow, and
   FLIGHT can stay on the main checkout while workers branch off it.
2. A room-wide switch "every worker gets a worktree". Fewer clicks, but the boss and a read-only reviewer then get one too,
   and a room-wide switch hides a per-agent difference the Director wants to see. Rejected; a **room default for new hires**
   can come later as a field of the hire form, with no change to this design.

## Order of changes

1. Move the worktree code into `worktree.ts`; `cleanroom.ts` imports it; all Clean Room tests pass unchanged.
2. `parseWorktree`, the record field, `home.ts`, hire and edit checks, the launcher `cwd`; tests with real `git` in temp
   repositories.
3. Status route and the removal choice; the page (box, chip, panel line, remove dialog).
4. Page `docs/features/worktrees.md`, backlog tick, changelog.

## Test plan

- Unit: `parseWorktree`; branch and path from a name; a name with odd characters is already refused by the name rule.
- Real `git` in temp repositories (the pattern of `test/cleanroom.test.ts`): made once; found again; deleted folder made
  again; a branch that exists; `dir` in a sub-folder; `dir` outside a repository refused; two agents, two worktrees, no
  shared index; `removeWorktree` refuses a dirty folder and an unmerged branch and removes a clean merged one.
- Clean Room regression: its whole suite unchanged after step 1.
- Hub/e2e with the stand-in agent: the launched `cwd` is the worktree; Propellant reads its transcript; rename refused;
  `worktree` with `cleanRoom` refused.
- Client: box, chip, remove dialog (keep is the default); 390 px layout.

## Known limits (shortcuts to state in the final spec)

- The worktree starts from `HEAD`; uncommitted changes of the main checkout are not in it, and it is never refreshed from
  `main`.
- Two worktrees of one repository share `.git`: a hook the agent plants in `.git/hooks` runs on the host at the owner's next
  git command. Plain worktrees are **not** a security boundary; Clean Room is.
- Submodules and `git lfs` are not initialised in a new worktree.
