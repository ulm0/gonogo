# Relay: Slack, GitHub, Linear and Telegram

<RelayMock class="doc-mock" />

RELAY (under UPLINK in Launch Window) takes Slack, GitHub, Linear and Telegram in through uplinks, and forwards what agents send you to Slack or Telegram. Design and limits: [`docs/relay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/relay-spec.md).
**Not tried against a real Slack, GitHub, Linear or Telegram** (see [What was not verified](../reference/not-verified.md)).

## In

Each service card has setup steps, its uplinks (address, last delivery) and MAKE UPLINK. Address: `<your public name>/uplink/<id>`, so gonogo must be reachable from the internet over HTTPS ([Reverse proxy](../reference/security.md#reverse-proxy), [Uplink](./uplink.md)), with the name allowed by `--allow-host`. Each delivery becomes a message from you, `Uplink: <name>`.

| Service | Signature | Secret | Becomes a message |
| --- | --- | --- | --- |
| GitHub | `X-Hub-Signature-256` | Shown once by gonogo; paste into the webhook. Content type `application/json`. | Push, pull request, issue, issue comment, completed workflow run (summarised). `ping` is listed as `answered`. Others ignored. Every action of a chosen event is a message: pick events in GitHub. |
| Linear | `Linear-Signature` | Linear's signing secret, pasted into the form (follow the steps' order). | Issue and comment events. |
| Slack | `X-Slack-Signature`, timestamp at most 5 minutes old | Your Slack app's Signing Secret, pasted into the form. | Bot mentions and DMs (with user and channel id). Other channel talk, bot messages and edits ignored. Request URL check answered. |
| Telegram | `X-Telegram-Bot-Api-Secret-Token` | Shown once by gonogo; pass to `setWebhook` as `secret_token`. | Only text from the Telegram target's chat; other chats dropped. Save the target first. |

Messages go to the uplink's recipient, except [replies](#replies). Slack and Linear have no Rotate secret: use Edit. Test sends a JSON sample to the recipient.

## Out

One target each for Slack and Telegram: a bot token and a Slack channel id or Telegram chat id.

- SAVE TARGET stores it in `relay.json`; an empty token on edit keeps the saved one. TEST sends one message. REMOVE deletes target and token.
- Switches (all on by default): messages to you, Redline trips, T-minus results, tasks blocked or in review.
- Format: `Message from ana: <subject>` plus body; events like `Redline: ana: loop: ...`. At most 3500 characters.
- 10 second timeout; up to 3 tries (after 1 s and 2 s, or `Retry-After`, at most 10 s) on network error, timeout, `5xx` or `429`. Refusals (wrong token, bot not in channel) are not retried; the service's answer shows under the target.
- The token is never logged or returned to the page.

## Telegram needs no public address

With a Telegram **target** saved (the bot token and the chat id) gonogo asks Telegram for new messages itself, by `getUpdates` long polling, so a gonogo on a home or office network that nothing can reach from outside still hears you, and your button presses (phone approvals) arrive too. No uplink, no webhook and no public URL are needed.

- **On by itself** while the Telegram target is set and **no Telegram uplink exists** (an uplink gets its updates by webhook, and polling stays off). One loop per gonogo, in room `main`.
- **The same path as a webhook:** only text from the target's chat reaches an agent (other chats are dropped), a reply to a message gonogo posted goes to the agent that wrote it, and a message that is not a reply goes to the boss with the subject "Telegram". At most 30 a minute, like an uplink.
- **A webhook that is set on the bot** makes Telegram refuse `getUpdates` (409). The RELAY card then says "A webhook is set for this bot; inbound uses it", and gonogo looks again once a minute. It **never removes your webhook**: do that yourself (`deleteWebhook`) if you want polling instead.
- **A restart does not replay:** the last update id is kept in `<home>/telegram-poll.json` (mode 0600, with the secret that signs the phone-approval buttons while there is no uplink). A crash between handing an update on and saving its id can repeat one update.
- **Errors back off** (1 s, doubling, at most a minute; Telegram's own pause on 429; five minutes on a refused token) with no busy loop. A changed token ends the request in flight. The token is never in a log line, an error or the card.
- The card reads this state when it is opened or changed; it is not pushed.

## Replies

A Slack thread reply or Telegram reply to one of the last 500 posted messages (forgotten on restart) reaches the agent that wrote it, as a reply from you. If that agent was removed or renamed, the uplink's recipient gets it.

## Whatever is said, the agent reads

Anyone who can message or mention the bot reaches the agent, and issue titles, pull request bodies and comments arrive as messages from you. Use a private workspace or channel; choose the recipient and its permission mode accordingly.

## API

Browser token required. No frame, no option.

- `GET /api/relay` answers `{ "slack": { "to": "C0123456789", "last": { "at", "ok", "note" } }, "telegram": null, "forward": ["message", "redline", "tminus", "flight-plan"], "phone": "off" }`, without the token.
- `PUT /api/relay/slack`, `PUT /api/relay/telegram` take `{"token": "...", "to": "..."}` (omit `token` to keep the saved one). `DELETE` on the same paths removes the target.
- `POST /api/relay/slack/test`, `POST /api/relay/telegram/test` send the test.
- `PUT /api/relay/forward` takes `{"kinds": ["message", "redline"]}`.

All answer the view.
