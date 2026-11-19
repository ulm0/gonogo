# History of triggers

<TriggersMock class="doc-mock" />

Everything that fires by itself or comes in from outside is written to one log per room, and the **HISTORY** tab of [Launch Window](./launch-window.md) shows it: a webhook delivery ([Uplink](./uplink.md), and the GitHub, Slack, Linear and Telegram uplinks of [Relay](./relay.md)), a Telegram message read by [long polling](./relay.md#telegram-needs-no-public-address), a Launch Window schedule's run, and a [Docking](./docking.md) hand-off or a call from a station. Before this, an uplink kept its last 20 deliveries and a schedule only its last run.

## What an entry says

| Field | |
|---|---|
| time, **kind** | `uplink` (webhook), `telegram` (a polled update), `schedule`, `docking` |
| **source**, name | the id of the uplink (`u1`), schedule (`s1`) or dock, and its name at that time; `telegram` for polling |
| **outcome** | the status of the message it made (`queued`, `held`, `delivered`, `read`, `undelivered`, `to_user`), or `answered` (a ping, a button press), `refused` or `failed` |
| what | the first 160 characters of the payload, **one line, secrets replaced** |
| message, agent | the id of the message it made and the agent it went to (the boss's name for "boss") |
| note | the reason, only for a refusal or a failure |

A bad signature is **not** an entry: anyone who guesses an uplink id could otherwise fill the log. The uplink counts them and tells the inbox once per window, as before. A Telegram message from a chat that is not yours is dropped before it is a trigger.

## The tab

**Triggers | History** at the top of Launch Window. History has three filters (kind, source, outcome), Clear filters and Refresh, and refreshes itself every 10 seconds while it is open and the browser tab is visible. Each uplink card, Relay uplink and schedule has a **History** link that opens the tab filtered to that one source. The page asks `GET /api/triggers?kind=&source=&outcome=&limit=` (the page's token, like every route): newest first, `limit` 1 to 500 (default 100), a bad value is 400 with its field.

## What is kept, and what is not

`<home>/triggers.jsonl` (mode 0600), one JSON line per entry, **append only**. It rotates to `triggers.1.jsonl` (the one before it is dropped) when it passes **1 MiB** or its first line is older than **90 days**; a read ignores lines older than 90 days. So the history is at most about 2 MiB and 90 days. The log lives in the room's home, which a Clean Room agent cannot read.

**Redaction:** an entry is cleaned where it is written, not where it comes from. The payload is cut to one line and these are replaced by `[redacted]`: `Bearer` values; the value after `token`, `secret`, `password`, `api_key`, `authorization`, `signature` and the like (as `key=value`, `key: value` or JSON); Slack (`xoxb-`), GitHub (`ghp_`, `github_pat_`), `sk-` and AWS (`AKIA`) keys; Telegram bot tokens; JWTs; gonogo API keys (`gnk_`); any run of 32 or more hex characters; and any unbroken run of 40 or more letters and digits. Control characters and bidirectional marks become spaces. **Never kept:** headers, signatures, uplink secrets, a whole body, the `Authorization` of a call. This is a pattern list, not a proof: a secret in an unusual shape and short enough to look like a word can stay in the first 160 characters, so do not send secrets in webhook bodies.

## Not built

A search over the whole text, export, a longer history, an entry for a refused signature, and a history for the Telegram messages that are not for an agent. The tab reads the files each time (two files, about 2 MiB at most): a room with a very busy webhook would want an index.
