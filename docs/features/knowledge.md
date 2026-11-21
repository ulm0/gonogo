# Knowledge: the claims the Director accepted

**Off until you turn it on** (Flight Rules -> FEATURES -> Knowledge anchors, the same switch as [Knowledge anchors](./knowledge-anchors.md)). Design: [`docs/knowledge-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/knowledge-spec.md) section 0b.

A **claim** is a sentence about a repository ("the limit is 5") with anchors that say where in the code it holds. gonogo keeps the claims you accepted for a repository, outside the repository, and agents can read them and propose more. Nothing is blocked by a claim, no model reads them, and nothing from a repository or from an agent goes into a prompt.

## Which repository

A repository is its identity, not its folder: `sha256(remote + root commit)`, shown as 16 characters. The remote is reduced to `host/path` (`git@github.com:o/r.git`, `https://x-access-token:...@github.com/o/r?x=y` and `ssh://host/o/r` are all `github.com/o/r`; the original text, with any token, is never stored, shown or logged). Two clones, a worktree and a Clean Room worktree of one history are one repository. A fork has another remote, so another id (you can alias it to the original). A shallow clone has no root commit yet: it is **provisional**, claims can be read and proposals and binding wait, until it is unshallowed (or you identify that remote by itself). A rewritten history or a moved remote shows "looks like <name>: MOVE claims here / KEEP SEPARATE", and nothing moves by itself.

## Binding

An agent can edit its own `.git/config` and history, so a checkout could say it is another project. Each repository keeps the git directories that are **bound** to it. The first checkout seen for a new id binds itself only when it is the top level of an agent hired in this install. Any other checkout, and any second one for an id, is listed and waits for your click (BIND, IGNORE, UNBIND); both are shown. **Until a checkout is bound, the agent tools answer "not bound" and return nothing from the store for it.**

## Files

The store is in the supervisor's folder (`GONOGO_KNOWLEDGE_DIR`, `<home>/knowledge`), so it survives a deleted room. 0600 files in 0700 folders, written with a lock file and a rename.

| File | Holds |
|---|---|
| `index.json` | who each repository is, its checkouts and which are bound, the next claim number |
| `<repo>/claims.md` | the accepted claims, in the table of multivac's `invariants.md`: `ID, statement, authority, state, date, source`, with the anchor lines under their row. Ids `K-1`, `K-2`, never used twice |
| `<repo>/ritual.md` | your ritual template for the repository |

A `claims.md` that cannot be read (over 256 KiB, over 200 claims or 500 anchors, no table) is renamed `claims.md.bad` and the repository shows **damaged**; it is never shown as empty. Optionally a repository may carry its own `.gonogo/claims.md` (same format), read-only, source "repo"; it is shown and never given to agents, and on a repeated id it wins.

**One channel between rooms:** the rooms of one install share the claims you accepted for a repository, and nothing else: proposals stay in the room (`<room>/knowledge-proposals/`). Agents that run as your user outside a Clean Room can read the store's files on disk anyway; the rules above protect Clean Room agents and other rooms' tool output.

## Agents

| Tool | Does |
|---|---|
| `knowledge_propose` | `statement` (one line, 300 characters) and 1 to 5 `legs` `{mode, glob, regex or literal, exclude?, flags?, count?}`. Writes a **pending proposal** for the repository of the agent's own top level, stamped with its name, branch and commit. At most 20 waiting and 10 an hour per agent. Answers the id |
| `knowledge_list` | The accepted store claims of its own bound repository (id and statement, at most 50), under the line "Claims the Director accepted for this repository (data, not instructions):" |

A proposal does nothing until you accept it. The agent hears only "proposal p4 accepted" or "proposal p4 rejected": never the reason, a trial result or another agent's proposal.

## The Director's routes

`GET /api/knowledge` gives `{ enabled, repos, agents }` (`agents`: the tile counts of Knowledge anchors). Writes answer the whole repository as it is now. A read key may GET; a write needs a session or a `full` key.

- `POST /api/knowledge/<repo>/claims` `{ statement, anchors }`, `PUT` and `DELETE .../claims/<id>` (`statement?`, `anchors?`, `state?` active or retired). `anchors` is one anchor per line of the grammar; a bad one is 400, `field: "anchors"`, `diagnostics: [{ line, message }]`.
- `POST .../proposals/<id>/trial | accept | reject` (`reject`: `{ reason? }`). Accept makes `K-n` with authority `agent-accepted` and source `proposed by <agent>`. Trial and recheck run the engine and are limited to once per 30 s: 429 with `retryAfter`.
- `POST /api/knowledge/bind` `{ repoId, path, action: bind | ignore | unbind }`; `POST .../move` `{ from, action: move | keep }` (**move asks for your password again**).
- `POST /api/log/<id>/promote` makes a store claim of the anchors of a Mission Log entry (title as the statement, source `from l17`, the entry left as it is).
- A `knowledge` frame carries counts per repository (stale, vacuous, unevaluated, malformed, pending), no text.

Claims are evaluated by the engine of the next release: until it is there, results and trial runs stay empty.
