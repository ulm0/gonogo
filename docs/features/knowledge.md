# Knowledge: the claims the Director accepted

**Off until you turn it on** (Flight Rules -> FEATURES -> Knowledge anchors, the same switch as [Knowledge anchors](./knowledge-anchors.md)). Design: [`docs/knowledge-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/knowledge-spec.md) section 0b.

A **claim** is a sentence about a repository ("the limit is 5") with anchors that say where in the code it holds. gonogo keeps the claims you accepted for a repository, outside the repository, and agents can read them and propose more. Nothing is blocked by a claim, no model reads them, and nothing from a repository or from an agent goes into a prompt.

## Which repository

A repository is its identity, not its folder: `sha256(remote + root commit)`, shown as 16 characters. The remote is reduced to `host/path` (`git@github.com:o/r.git`, `https://x-access-token:...@github.com/o/r?x=y` and `ssh://host/o/r` are all `github.com/o/r`; the original text, with any token, is never stored, shown or logged). Two clones, a worktree and a Clean Room worktree of one history are one repository. A fork has another remote, so another id (you can alias it to the original). A shallow clone has no root commit yet: it is **provisional**, claims can be read and proposals and binding wait, until it is unshallowed (or you identify that remote by itself). A rewritten history or a moved remote shows "looks like `name`: MOVE claims here / KEEP SEPARATE", and nothing moves by itself.

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

## Export, import, aliases (command line)

`gonogo knowledge ...` runs on the machine gonogo runs on (in Docker: `docker exec <container> gonogo knowledge ...`), reads `GONOGO_KNOWLEDGE_DIR` or `<home>/knowledge` (`--home` for another), and works while gonogo is up (the same lock). **Nothing here has a route:** it cannot be done from the page or with an API key.

| Command | Does |
|---|---|
| `list` | the repositories, their claims, and the ones that look like another ("the same remote, another root commit") |
| `export [--repo <id or path>] [--out <file>] [--multivac]` | one JSON bundle of the accepted claims (and rituals): to stdout, or to a **new** file (0600; an existing file or a link is never written). No checkout path, binding or proposal is in it. `--multivac` adds, per repository, `multivac`: the claims as a multivac `invariants.md` (a `"literal"` leg becomes an escaped regex; a leg that would pass 200 characters is left out and named on stderr) |
| `import <file> [--apply] [--replace]` | a **dry run** that lists what it would add, skip and reject; `--apply` writes. A claim whose id is already there is skipped, or replaced with `--replace`. Imported claims have authority `imported` and `import: <file name>` as source |
| `alias <fork> <canonical>` | a fork reads and writes the knowledge of another repository (what the fork held stays where it is, unread) |
| `move <from> <to>` | after a rewritten root commit or a moved remote: the claims go to the new id (one rename) and the old id becomes an alias. Its checkouts come along **unbound** |
| `keep <a> <b>` | two repositories that look alike are kept apart |

**Limits and checks on import:** a bundle over **8 MiB** is refused before it is parsed, as is one with more than **50** repositories; per repository 256 KiB of claims, 200 claims and 500 anchors. A repository's id must be the hash of its remote and root commit (a bundle cannot put claims under another repository's id); a remote with a scheme, user, token or query is refused; every claim goes through the same parser as the store and a statement is cleaned as when you accept it. **Bindings are never imported:** the first checkout seen for the repository asks for one.

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

Claims are evaluated by the engine (one worker thread per run, at most 5 s, 64 MiB, two at once per room, at most one run per checkout every 30 s). A trial run of a proposal is for you only; a checkout that is not bound is not evaluated.
