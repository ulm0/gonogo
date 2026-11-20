# History of triggers

<TriggersMock class="doc-mock" />

See everything that fired by itself or came in from outside: the **HISTORY** tab of [Launch Window](./launch-window.md), one log per room. It covers webhook deliveries ([Uplink](./uplink.md), and the GitHub, Slack, Linear, Telegram uplinks of [Relay](./relay.md)), Telegram messages read by [long polling](./relay.md#telegram-needs-no-public-address), Launch Window schedule runs, and [Docking](./docking.md) hand-offs or station calls.

## An entry

| Field | Meaning |
|---|---|
| time, **kind** | `uplink`, `telegram` (polled update), `schedule`, `docking` |
| **source**, name | id of the uplink (`u1`), schedule (`s1`) or dock and its name then; `telegram` for polling |
| **outcome** | status of the message made (`queued`, `held`, `delivered`, `read`, `undelivered`, `to_user`), or `answered` (ping, button press), `refused`, `failed` |
| what | first 160 characters of the payload, **one line, secrets replaced** |
| message, agent | id of the message and the agent it went to (the boss's name for "boss") |
| note | reason, only for a refusal or failure |

A bad signature is **not** an entry (guessing an uplink id could fill the log); the uplink counts them and tells the inbox once per window. A Telegram message from a chat that is not yours is dropped before it is a trigger.

## The tab

**Triggers | History** at the top of Launch Window. Filters: kind, source, outcome; Clear filters; Refresh. It refreshes every 10 s while open and visible. Each uplink card, Relay uplink and schedule has a **History** link filtered to it. Route: `GET /api/triggers?kind=&source=&outcome=&limit=` (page token): newest first, `limit` 1 to 500 (default 100), bad value 400 with its field.

## Kept

`<home>/triggers.jsonl` (0600), append only, one JSON line per entry. It rotates to `triggers.1.jsonl` (the older one dropped) past **1 MiB** or when its first line is over **90 days**; reads ignore lines over 90 days: at most about 2 MiB and 90 days. It lives in the room's home, unreadable to a Clean Room agent.

**Redaction** is applied where an entry is written. The payload is cut to one line and replaced by `[redacted]`: `Bearer` values; values after `token`, `secret`, `password`, `api_key`, `authorization`, `signature` and the like (`key=value`, `key: value`, JSON); the `user:password@` of a URL; Slack (`xoxb-`, `xapp-`), GitHub (`ghp_`, `github_pat_`), GitLab (`glpat-`), `sk-`, Stripe (`sk_live_`, `rk_live_`), AWS (`AKIA`) keys; Telegram bot tokens; JWTs; gonogo API keys (`gnk_`); runs of 32 or more hex characters; unbroken runs of 40 or more letters and digits. Control and bidirectional characters become spaces. **Never kept**: headers, signatures, uplink secrets, a whole body, `Authorization`. This is a pattern list, not proof: a short secret of unusual shape can stay in the first 160 characters, so do not send secrets in webhook bodies.

## Not built

Full-text search, export, longer history, entries for refused signatures, history for Telegram messages not for an agent. The tab reads both files each time; a very busy webhook would want an index.
