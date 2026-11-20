# Relay: Slack, GitHub, Linear and Telegram

<RelayMock class="doc-mock" />

RELAY (under UPLINK in Launch Window) takes Slack, GitHub, Linear and Telegram in through uplinks and forwards what agents send you to Slack or Telegram. Design and limits: [`docs/relay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/relay-spec.md).
**Not tried against a real Slack, GitHub, Linear or Telegram** ([What was not verified](../reference/not-verified.md)).

## In

Each service card has setup steps, its uplinks (address, last delivery) and MAKE UPLINK. Address: `<your public name>/uplink/<id>`: gonogo must be reachable over HTTPS ([Reverse proxy](../reference/security.md#reverse-proxy), [Uplink](./uplink.md)), the name allowed by `--allow-host`. Each delivery is a message from you, `Uplink: <name>`, to the uplink's recipient (replies excepted, below). Slack and Linear have no Rotate secret: use Edit. Test sends a JSON sample.

| Service | Signature | Secret | Becomes a message |
| --- | --- | --- | --- |
| GitHub | `X-Hub-Signature-256` | shown once; paste into the webhook; content type `application/json` | push, pull request, issue, issue comment, completed workflow run (summarised). `ping` is listed `answered`. Every action of a chosen event is a message: pick events in GitHub |
| Linear | `Linear-Signature` | Linear's signing secret, pasted into the form | issue and comment events |
| Slack | `X-Slack-Signature`, timestamp at most 5 minutes old | your app's Signing Secret, pasted into the form | bot mentions and DMs (with user and channel id); other talk, bot messages, edits ignored; request URL check answered |
| Telegram | `X-Telegram-Bot-Api-Secret-Token` | shown once; pass to `setWebhook` as `secret_token` | text from the target's chat only; save the target first |

## Out

One target each for Slack and Telegram: bot token plus Slack channel id or Telegram chat id.

- SAVE TARGET stores in `relay.json` (empty token on edit keeps the saved one). TEST sends one message. REMOVE deletes target and token.
- Switches (all on): messages to you, Redline trips, T-minus results, tasks blocked or in review.
- Format: `Message from ana: <subject>` plus body; events like `Redline: ana: loop: ...`. At most 3500 characters.
- 10 s timeout; up to 3 tries (after 1 s and 2 s, or `Retry-After`, at most 10 s) on network error, timeout, `5xx`, `429`. Refusals (wrong token, bot not in channel) are not retried; the answer shows under the target.
- The token is never logged or returned to the page.

## Telegram needs no public address

With a Telegram **target** saved, gonogo polls Telegram itself (`getUpdates` long polling), so a gonogo nothing can reach from outside still hears you and your button presses ([Phone approvals](./phone-approvals.md)). No uplink, webhook or public URL.

- On while the target is set and **no Telegram uplink exists** (an uplink uses webhook updates). One loop per gonogo, in room `main`.
- Same path as a webhook: only text from the target's chat reaches an agent. A reply to a message gonogo posted goes to the agent that wrote it; other messages go to the boss, subject "Telegram". At most 30 a minute.
- First start reads nothing old: with no saved offset (or another bot's token) it takes the newest update id as start and hands on nothing earlier.
- **A webhook set on the bot** makes Telegram refuse `getUpdates` (409, "webhook is active"). The card says "A webhook is set for this bot; inbound uses it" and retries each minute. gonogo **never removes your webhook**: call `deleteWebhook` yourself to poll. A 409 about another `getUpdates` means **another program polls this bot** (second gonogo, overlapping reload, script): the card says so; back-off as below.
- The last update id is kept in `<home>/telegram-poll.json` (0600, with the secret signing approval buttons while there is no uplink), so a restart does not replay. A crash between hand-on and save can repeat one update.
- Errors back off 1 s, doubling, at most a minute (Telegram's own pause on 429; five minutes on a refused token). A changed token ends the request in flight.
- The card reads state when opened or changed; a target set a moment ago shows "starting" for up to two seconds.
- **Use a private chat with the bot.** In a group any member can press approval buttons.
- **Buttons sent while polling stop working if you then make a Telegram uplink** (the uplink's secret signs from then; send a new request). Polling then stops by itself.

## Replies

A Slack thread reply or Telegram reply to one of the last 500 posted messages (forgotten on restart) reaches the agent that wrote it, as a reply from you. If that agent was removed or renamed, the uplink's recipient gets it.

## The agent reads whatever is said

Anyone who can message or mention the bot reaches the agent; issue titles, pull request bodies and comments arrive as messages from you. Use a private workspace or channel; choose recipient and permission mode accordingly.

## API

Browser token required.

| Route | Does |
|---|---|
| `GET /api/relay` | `{ "slack": { "to": "C0123456789", "last": { "at", "ok", "note" } }, "telegram": null, "forward": ["message", "redline", "tminus", "flight-plan"], "phone": "off" }`, without the token |
| `PUT /api/relay/slack`, `PUT /api/relay/telegram` | `{"token": "...", "to": "..."}` (omit `token` to keep the saved one); `DELETE` removes the target |
| `POST /api/relay/slack/test`, `POST /api/relay/telegram/test` | send the test |
| `PUT /api/relay/forward` | `{"kinds": ["message", "redline"]}` |

All answer the view.
