# Relay: Slack, GitHub, Linear and Telegram

RELAY (a module under UPLINK in the Launch Window view) connects the four services. They come in through uplinks of their own
kinds, and what the agents write to you goes out to a Slack channel or a Telegram chat. Design and limits: [`docs/relay-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/relay-spec.md).
**Nothing of it was tried against a real Slack, GitHub, Linear or Telegram** (see [What was not verified](../reference/not-verified.md)).

- **In.** The page has a card for each service with its setup steps, the uplinks of its kind (address, last delivery) and MAKE
  UPLINK. The address of an uplink is `<your public name>/uplink/<id>`, so the services need to reach gonogo from the internet:
  put a reverse proxy with HTTPS in front (see [Reverse proxy](../reference/security.md#reverse-proxy) and [Uplink](./uplink.md)) and give gonogo its name with `--allow-host`. Each kind
  proves itself in the way of its service and turns what it gets into a message from you, `Uplink: <name>`:
  - **GitHub**: `X-Hub-Signature-256`. Secret: the one gonogo shows once when you make the uplink; paste it into the webhook.
    Content type `application/json`. Push, pull request, issue, issue comment and workflow run (when it completes) events are
    summarised (who, where, the title, the link, the start of the text); `ping` is answered, and the uplink lists it as
    `answered`. Other events are ignored. Every action of a chosen event is a message, so choose the events in GitHub.
  - **Linear**: `Linear-Signature`. Secret: Linear's own signing secret, pasted into the form (see the steps for the order).
    Issue and comment events are summarised; other types are ignored.
  - **Slack**: `X-Slack-Signature` with a timestamp that is at most 5 minutes old. Secret: the Signing Secret of your Slack
    app, pasted into the form. The check of the Request URL is answered. A mention of the bot and a direct message to it are
    messages to the uplink's recipient, with the Slack user id and the channel id; a reply in the thread of something gonogo
    posted goes to the agent that wrote it. What else is said in a channel, what a bot says and edits are ignored.
  - **Telegram**: `X-Telegram-Bot-Api-Secret-Token`. Secret: the one gonogo shows once; give it to `setWebhook` as
    `secret_token`. Only a text from the chat of the Telegram target is a message (to the uplink's recipient, or to the agent
    that wrote the message it replies to); every other chat is dropped, so that nobody who finds the bot reaches your agents.
    Save the Telegram target first.
  - Rotate secret is not there for Slack and Linear (the service made the secret): Edit changes it. Test sends a JSON sample
    to the recipient whatever the kind.
- **Out.** Slack and Telegram each have a target: a bot token and a place (a Slack channel id, a Telegram chat id), at most one
  of each. SAVE TARGET keeps it in `relay.json`; leaving the token empty when you edit the place keeps the saved one. TEST sends
  one message and shows how it went. REMOVE deletes the target and its token. The switches at the top choose what goes to the
  targets: messages to you, Redline trips, T-minus results and tasks blocked or in review. All four are on until you change
  them. A message looks like `Message from ana: <subject>` and the body, an event like `Redline: ana: loop: ...`; at most 3500
  characters. Each call has a 10 second timeout and is tried at most 3 times (again after 1 s and 2 s, or the `Retry-After` of the
  service, at most 10 s) when the network, a timeout, a `5xx` or a `429` fails it; a refusal (a wrong token, a channel the bot is
  not in) is not tried again, and the line under the target says what the service said. The token is never logged and the page
  never gets it back.
- **Replies.** gonogo remembers the last 500 messages it posted. A Slack reply in the thread of one of them, or a Telegram
  reply to one, reaches the agent that wrote it as a message from you, in reply to it; when that agent was removed or renamed
  since, the uplink's recipient gets it. A restart forgets the list.
- **Whatever is said, the agent reads.** Anybody who can write to the Slack bot or mention it in your workspace reaches the
  agent, and an issue title, a pull request body or a comment is a message as from you. Use a private workspace or channel and
  choose the recipient and its permission mode knowing that.
- **API** (browser token). `GET /api/relay` answers `{ "slack": { "to": "C0123456789", "last": { "at", "ok", "note" } }, "telegram": null,
  "forward": ["message", "redline", "tminus", "flight-plan"] }`, with no token. `PUT /api/relay/slack` and `PUT /api/relay/telegram`
  take `{"token": "...", "to": "..."}` (`token` may be left out to keep the saved one), `DELETE` on the same paths removes the
  target, `POST /api/relay/slack/test` and `POST /api/relay/telegram/test` send the test, and `PUT /api/relay/forward` takes
  `{"kinds": ["message", "redline"]}`. They all answer the view. There is no frame and no option for it.
