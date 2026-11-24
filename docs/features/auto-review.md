# Auto-review: a review of each pull request, by your agents

<AutoReviewMock class="doc-mock" />

An optional room setting that watches GitHub repos you link and makes **one review job per open pull request head**. The reviewers (RSO for security, RETRO for correctness by default) read the diff and write findings; **you click POST** (or turn on auto-post) and gonogo comments on the pull request under your own `gh` login, headed "Review by gonogo". It only comments: it never approves, requests changes, merges or sets a status. The full design and the threats are in [`docs/auto-review-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/auto-review-spec.md).

> **Built in slices.** This page describes what is in each slice that has landed. **Slice 1 (now): the setting, the poller, the gate and the job list.** The reviewer agents, the findings and the post (slice 2) and the page's draft view (slice 3) are not built yet: a queued job does nothing more than wait.

## The setting

Off by default. `GET` / `PUT /api/auto-review` (the page's block comes in slice 3). **Turning it on, auto-post, and changing the repos or authors ask for your password** (a step-up); turning it off does not. An **API key may only turn it off**.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | the poller runs |
| `autoPost` | `false` | post a finished review without your click (slice 2) |
| `repos` | `[]` | `owner/repo` of the repos to watch |
| `authors` | `[]` | GitHub logins whose pull requests are reviewed; empty means **only the room's own `gh` login** |
| `positions` | `rso`, `retro` | who reviews (slice 2) |
| `model` | none | the model of the reviewers (slice 2) |
| `maxUsdPerPr`, `maxUsdPerDay` | $2, $10 | spend caps (slice 2) |
| `maxLines`, `maxFiles` | 1500, 40 | a larger pull request is skipped |
| `focus`, `ignorePaths` | empty | extra instruction and paths left out of the diff (slice 2) |

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

## Not verified

See [not verified](../reference/not-verified.md): what a real `gh pr list` answers on your repos and what GitHub does with a comment are only checked on the one repo of the run recorded there.
