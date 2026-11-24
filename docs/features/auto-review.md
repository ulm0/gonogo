# Auto-review: a review of each pull request, by your agents

<AutoReviewMock class="doc-mock" />

An optional room setting that watches GitHub repos you link and makes **one review job per open pull request head**. The reviewers (RSO for security, RETRO for correctness by default) read the diff and write findings; **you click POST** (or turn on auto-post) and gonogo comments on the pull request under your own `gh` login, headed "Review by gonogo". It only comments: it never approves, requests changes, merges or sets a status. The full design and the threats are in [`docs/auto-review-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/auto-review-spec.md).

> **Built in slices.** **Slice 1: the setting, the poller, the gate and the job list. Slice 2 (this page): the reviewers, the findings, the cleaning and the post, through the API.** The Flight Rules block and the draft view of the page (slice 3) are not built yet: until then the setting, the draft and the POST are used with the API.

## The setting

Off by default. `GET` / `PUT /api/auto-review` (the page's block comes in slice 3). **Turning it on, auto-post, and changing the repos or authors ask for your password** (a step-up); turning it off does not. An **API key may only turn it off**.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | the poller runs |
| `autoPost` | `false` | post a finished review without your click. **A restart turns it off again** (the Downlink says so): turn it on in the browser to confirm |
| `repos` | `[]` | `owner/repo` of the repos to watch |
| `authors` | `[]` | GitHub logins whose pull requests are reviewed; empty means **only the room's own `gh` login** |
| `positions` | `rso`, `retro` | who reviews |
| `model` | none | the model of the reviewers |
| `maxUsdPerPr`, `maxUsdPerDay` | $2, $10 | spend caps |
| `maxLines`, `maxFiles` | 1500, 40 | a larger pull request is skipped |
| `focus`, `ignorePaths` | empty | extra instruction and paths left out of the diff |

## What the poller does

Every 3 minutes (no webhook in v1), for each linked repo, it runs `gh pr list` with the room's own `gh` login (the `gh` folder of the room's home, or your `GH_CONFIG_DIR`). That is the **only** gh call in this slice, with a fixed argument list: the repo name must match `owner/repo`, the author a GitHub login or `@me`, and nothing else from a request reaches gh.

A pull request becomes a **job** only when all of this holds, and otherwise it is listed as **skipped** with the reason (once per head commit):

- a **branch of the same repo**: never a fork (`isCrossRepository` false and the head owner equal to the repo's owner);
- **not a draft**;
- by an **author on the list** (or by you, when the list is empty);
- not larger than `maxFiles` files or `maxLines` changed lines;
- the head commit is a full SHA.

**One job per head commit**: the same head is never made twice, even after a restart (a head that the gate only skipped, say a draft, is judged again at the next poll, once it passes it becomes a job; one you or a failure skipped is not revived). **Look now** (and `POST /api/auto-review/poll`) is limited to one every 30 seconds. A new push **supersedes** the older job of that pull request that has not finished. At most **4 jobs per repo per hour**: more wait for the next poll. A repo that cannot be listed shows the error in the last poll and the others are still read.

Files: `auto-review.json` (the setting, 0600) and `auto-review-jobs.json` (the last 200 jobs: repo, number, head, a title cleaned of control characters, status). **No diff, comment or finding is stored.** The Black Box says that it was switched, with a count of repos, never a pull request.

## A job: the reviewers

A queued job (the day's cap permitting) is run like this:

1. gonogo writes the pull request's diff (`gh pr diff`, minus your `ignorePaths`) to `review/<job>/diff.patch` in the room's home (0600). A diff over 600 KB is skipped as too large to read. **The diff is never put in a prompt or a message**: a reviewer reads the file.
2. It makes a **mission** with the per-PR cap (`maxUsdPerPr`) and **hires one reviewer agent per position** (RSO and RETRO by default), named `<job>-<position>`, with a task each in the Flight Plan (`review of repo#N @ sha (rso)`), so [Propellant](propellant.md) counts their spend on the mission and the cap holds them. The model is the setting's `model`.
3. Each reviewer is **read-only**: Claude Code's deny rules forbid Bash, Edit, Write, MultiEdit, NotebookEdit, WebFetch, WebSearch, Task and Agent (a deny wins in every mode), its MCP config holds **only gonogo's server** (no global servers, no room Payload defaults, no skills), it gets **no keys**, and it is told the diff is untrusted data. It reads with Read, Grep and Glob in its job folder and answers once with **`pr_review_submit`** (a summary, at most 20 findings: file, line, severity `info`, `low`, `medium` or `high`, text). Only a reviewer of a running job has that tool. **Reviewers always run on Claude Code, whatever the room's default engine** (the read-only rules are written by that launcher only; hiring a review-only agent on another engine is refused). Of gonogo's own tools a reviewer is allowed two, `pr_review_submit` and `read_messages`: the server leaves every other one out of its tool list for as long as it exists, and `--allowedTools` approves only those two, so a diff that tells it to message FLIGHT, vote, write the Mission Log or change the Flight Plan has no tool to do it with.
4. What comes back is **cleaned** before it is kept: secrets redacted; control and bidi characters removed; `@mentions` and `#123` / `owner/repo#123` references broken so they do not ping or link; any line starting with `/` quoted (no slash-command bot); images and HTML removed; links shown as text. A finding must name a **file and a line that are in the diff** (the new side), or it is dropped and listed as dropped. The draft is kept in `review/<job>/draft.json` (0600).
5. When every reviewer has submitted, the job is **done** and the reviewers are removed (after they finish their turn, so their spend is counted). A new push that supersedes the job, or **skip**, removes them at once.

**The post.** `POST /api/auto-review/jobs/<job>/post` (the Director's session only: an API key, even a full one, is refused, as is reading the draft with `GET /api/auto-review/jobs/<job>`), or `autoPost`. It runs **one** write: `gh api -X POST repos/<owner>/<repo>/pulls/<n>/reviews --input <file>`, with the body in a 0600 temporary file (never on the command line), `event` fixed to `COMMENT`, `commit_id` the reviewed head, headed "Review by gonogo (RSO, RETRO)" with one comment per finding. It is refused when the pull request has a new head since (read with `gh pr view <n> --json headRefOid`, whoever wrote it). It **never** approves, requests changes, merges, resolves a thread or sets a status. The comment appears under your own GitHub login. `POST /api/auto-review/jobs/<job>/skip` ends a job without a post.

**Caps.** `maxUsdPerPr` is a [mission budget](cost.md), so Redline stops that job's reviewers when it is reached (the job then waits for you to skip it); `maxUsdPerDay` stops new jobs from starting when the review missions of the last 24 hours have spent that much (a job that is still running counts at its per-PR cap at least, so several started in one poll cannot overrun it). These are estimates at list prices.

**What this does not do (read it).** The reviewers cannot run or write, but a Claude Code agent can still **read any file your user can**: the deny list names the usual secret places (`~/.ssh`, `~/.aws`, `~/.config/gh`, `.env`, keys), it is a list and not a wall. A prompt-injected reviewer could put what it read into a finding; the cleaning redacts token-shaped text and a finding is cut to 2,000 characters and must sit on a line of the diff, which makes that hard but not impossible. A Clean Room would close it and is not required here. `gh` is called as the room's own `gh` login (set `GONOGO_GH_BIN` to name another binary).

## Not verified

See [not verified](../reference/not-verified.md): what a real `gh pr list` answers on your repos and what GitHub does with a comment are only checked on the one repo of the run recorded there.
