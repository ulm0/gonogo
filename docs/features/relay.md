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
| Telegram | `X-Telegram-Bot-Api-Secret-Token` | shown once; pass to `setWebhook` as `secret_token` | text, photos and documents from the target's chat only; save the target first |

## Out

One target each for Slack and Telegram: bot token plus Slack channel id or Telegram chat id.

- SAVE TARGET stores in `relay.json` (empty token on edit keeps the saved one). TEST sends one message. REMOVE deletes target and token.
- Switches (all on): messages to you, Redline trips, T-minus results, tasks blocked or in review.
- Format: `Message from ana: <subject>` plus body; events like `Redline: ana: loop: ...`. At most 3500 characters.
- 10 s timeout; up to 3 tries (after 1 s and 2 s, or `Retry-After`, at most 10 s) on network error, timeout, `5xx`, `429`. Refusals (wrong token, bot not in channel) are not retried; the answer shows under the target.
- The token is never logged or returned to the page.

## Photos and documents from Telegram

A photo (its largest size) or a document that is a PNG, JPG, WebP, GIF or PDF, sent in the chat of the target, is downloaded into `agents/<name>/inbox-files/<message id>-<name>` (0600) in gonogo's home; the message to the agent goes at once with the caption (or "(no caption)") and "a file is on its way", so a restart in the middle of a download loses nothing; a second message, a reply to it, brings `Attached: <absolute path>` or why there is none. The type is checked by the mime type and by the first bytes of the file, the name is rebuilt from letters and digits, and at most 10 files are downloaded in a minute, and a file older than 30 days is removed when gonogo starts. Past the Bot API's 20 MB the agent is told the file was too big. Webhook and polling alike; the same gates as a text (a forwarded photo arrives without the Director's mark). A Clean Room agent sees it too (its own `agents/<name>/` is mounted at the same path).

## Telegram needs no public address

With a Telegram **target** saved, gonogo polls Telegram itself (`getUpdates` long polling), so a gonogo nothing can reach from outside still hears you and your button presses ([Phone approvals](./phone-approvals.md)). No uplink, webhook or public URL.

- On while the target is set and **no Telegram uplink exists** (an uplink uses webhook updates). One loop per gonogo, in room `main`.
- Same path as a webhook: only text, photos and documents from the target's chat reach an agent. A reply to a message gonogo posted goes to the agent that wrote it; other messages go to the boss, subject "Telegram". At most 30 a minute.
- First start reads nothing old: with no saved offset (or another bot's token) it takes the newest update id as start and hands on nothing earlier.
- **A webhook set on the bot** makes Telegram refuse `getUpdates` (409, "webhook is active"). The card says "A webhook is set for this bot; inbound uses it" and retries each minute. gonogo **never removes your webhook**: call `deleteWebhook` yourself to poll. A 409 about another `getUpdates` means **another program polls this bot** (second gonogo, overlapping reload, script): the card says so; back-off as below.
- The last update id is kept in `<home>/telegram-poll.json` (0600, with the secret signing approval buttons while there is no uplink), so a restart does not replay. A crash between hand-on and save can repeat one update.
- Errors back off 1 s, doubling, at most a minute (Telegram's own pause on 429; five minutes on a refused token). A changed token ends the request in flight.
- The card reads state when opened or changed; a target set a moment ago shows "starting" for up to two seconds.
- **Use a private chat with the bot.** In a group any member can press approval buttons.
- **Buttons sent while polling stop working if you then make a Telegram uplink** (the uplink's secret signs from then; send a new request). Polling then stops by itself.

## Replies

A Slack thread reply or Telegram reply to one of the last 500 posted messages (forgotten on restart) reaches the agent that wrote it, as a reply from you. If that agent was removed or renamed, the uplink's recipient gets it.

## Your words as a user turn

An agent reads mail with `read_messages`, and Claude Code's auto mode (its classifier) treats a tool result as **data, not as your words**: a "go" you wrote in the browser or on your phone did not authorize `gh pr merge --admin`, and the same words typed in the console did. So when gonogo has **checked that a message is yours**, it types your words into the agent's console as a user turn, after the pointer it already types, on one line:

```
gonogo: 1 new message from user. Call read_messages. [Director via Telegram] yes, merge it
```

- **Whose words.** Two places, and nothing else: the **BRIEF box and the message form of the page** when the request comes from a **signed-in browser session** (or the browser token of an install with no account yet), and a **Telegram message from your own private chat with the bot** (the chat of the Telegram target of Relay, with you as the sender; a group, a supergroup and a channel never count, and neither does a message that is forwarded, forwarded automatically from a channel or made by an inline bot: somebody else wrote it, and it arrives as a normal message). It is the supervisor, not the request, that says so: it adds the mark itself, drops any `x-gonogo-` header a sender wrote, and the room accepts it only on its local socket. **Never** typed as yours: a message from an agent or a docked station, an Uplink or a webhook of any kind (GitHub, Linear, Slack, a generic one), a schedule, a trigger, a task or a Relief message, an API key (it is a script, and a key can be made for a service), the local socket, the terminal client, Docking.
- **One clean line.** Escape sequences are removed whole (colours, titles, the end of a bracketed paste), control, invisible and direction characters (zero-width, the Arabic letter mark, the Mongolian vowel separator, interlinear annotation marks, bidi controls, tag characters) are removed, line breaks and tabs become a space, and what is left is cut at 1,000 characters (1,400 in all in one pointer; the full text is always in `read_messages`). Nothing in it can end the paste or press a key. The line must still begin with `gonogo: ` or the terminal refuses it.
- **Queued like the pointer.** A working agent is not typed into. When its turn ends it is **not** handed the pointer in the Stop block (that is hook output, not your turn): it goes idle and the console types the line then. If it cannot be typed, the next Stop hands over the pointer as before, so the message is never stuck. Your words are typed **once**: a pointer that has to be typed again is only the pointer. The message is marked read when the agent reads it, as ever.
- **Every engine** that gets the pointer gets the line (they all take it as typed input); only Claude Code has a classifier that cares. The role text tells the agent that the line is yours.
- **The switch**: FLIGHT RULES, FEATURES, *Director messages as user turns*, on by default, per room. Changing it asks for the password again when the last check is old, like every feature.
- **The risk, said plainly.** Whoever holds your **signed-in browser session** or your **Telegram chat** speaks with your authority to the agents, and an agent in auto mode will act on it. Protect both as you protect the account: a second factor, a short session on a shared computer, a private Telegram chat that nobody else can write in. A non-Clean-Room console runs as the same user as gonogo and can reach the room's local socket itself: the mark protects against the network and against other senders, not against a process on the machine that already has your files.

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
