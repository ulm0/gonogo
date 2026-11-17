# Spec: Relay

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): Slack, GitHub, Linear and
Telegram, the equivalent of Munder Difflin's integrations. It is built on Uplink (what comes in) and Downlink (what goes out).

## Intent

The agents work while the Director is away from the browser. Relay lets the services he already uses talk to them and lets
them talk back: a GitHub push, a Linear issue or a Slack or Telegram message becomes a message to an agent; what an agent
writes to the Director, a Redline trip, a T-minus result and a task that is blocked are posted to a Slack channel or a
Telegram chat, and a reply there goes back to the agent that wrote. Nothing else is new: the agent that gets a message works
as it always does, and Max Q, Redline and held mail apply to it as to any message of the Director.

## Design

### In: four uplink kinds

`UPLINK_KINDS` is `generic`, `github`, `linear`, `slack`, `telegram`. A kind is two functions (`KINDS` of `uplinks.ts`, the
entries are in `relaykinds.ts`): `authentic(raw, headers, secret, now)` and `read(raw, headers, inbound)`. The file, the routes
and the rate limit of Uplink are as they were; the endpoint is the same `POST /uplink/<id>`.

| Kind | Proof | What it makes |
|---|---|---|
| `github` | `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the raw body keyed with the secret | `X-GitHub-Event` `push`, `pull_request`, `issues`, `issue_comment` and `workflow_run` (only `completed`) become one text each: who, where, the title, the link and the first 1000 characters of the body (a push lists 5 commits). `ping` is answered `200`. Any other event is ignored. |
| `linear` | `Linear-Signature: <hex>`, HMAC-SHA256 of the raw body | `Issue` (key, title, state, assignee, priority, what changed on an update, link, the first 1000 characters of the description) and `Comment` events. Any other type is ignored. |
| `slack` | `X-Slack-Signature: v0=<hex>`, HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>`; the timestamp must be within 5 minutes of now | `url_verification` is answered with `{"challenge": ...}`. An `app_mention` and a direct message become `Slack mention from <user id> in <channel id>:` and the text. A thread reply to a message that gonogo posted becomes a reply (below). Everything else is ignored: bots (what gonogo posts comes back as an event), messages with a subtype, and what is said in a channel. |
| `telegram` | `X-Telegram-Bot-Api-Secret-Token` equal to the secret | A `message` with text from the chat of the Telegram target becomes `Telegram message from <name> @<user> in chat <id>:` and the text. A message from any other chat, an edit, a channel post or a message with no text is ignored. |

- **Answers.** A message that was made is `202` as before. A ping and a challenge are `200` with their answer, and are recorded
  as a delivery with the status `answered`. An event that is not for the agents is `200 {"ok": true, "ignored": true}`; it is not
  recorded and does not use the rate limit, so that chatter in a Slack channel cannot use up the 30 a minute or fill the list of
  20 deliveries. The body is read before the rate limit for that reason (a body that is not JSON is still recorded as refused).
- **The secret.** GitHub and Telegram take the secret that gonogo makes (64 hex characters, shown once). Slack and Linear make
  the signing secret themselves, so the form for those two has a Signing secret field and the uplink keeps the one it is given
  (`secret` in the request, required at create, 16 to 256 printable characters; Edit can change it). Rotate is refused (409) for
  them, and the page does not show the key. Any other kind refuses a `secret` (400).
- **Test** sends the same JSON sample whatever the kind: it proves the way to the agent, not a service's signature.
- **Each message** has the subject `Uplink: <name>` and is from `user` to the uplink's recipient, except a reply.

### Out: relay.json

`~/.gonogo/relay.json` (mode 0600, written whole through a temporary file and a rename):
`{ "version": 1, "slack": { "token", "to" }, "telegram": { "token", "to" }, "forward": [...] }`. `to` is the Slack channel id or
the Telegram chat id. A target has a bot token and a place, and there is at most one of each service. `forward` is the kinds
sent to every target: `message` (a message to the Director), `redline`, `tminus` and `flight-plan` (a task an agent moved to
blocked or review). The default is all four. The Director chooses with four switches.

- **Where it comes from.** `Relay.observe` sees every frame of the hub (a message to `user`) and `Relay.event` is called with
  every `DownlinkNotify` (the same function that feeds the inbox), so the inbox and Relay see the same things. `launch-window`
  and `uplink` events are not forwardable.
- **The text.** `Message from ana: <subject>`, a blank line and the body; or `Redline: <text>`, `T-minus: <text>`,
  `Flight Plan: <text>`. At most 3500 characters, cut with `…`. Plain text: Slack's `&`, `<` and `>` are escaped, so that an agent
  cannot write `<!channel>`.
- **The call.** One `fetch` to `https://slack.com/api/chat.postMessage` (a bearer token, `{channel, text}`) or
  `https://api.telegram.org/bot<token>/sendMessage` (`{chat_id, text}`), with a 10 s timeout and `redirect: 'error'`. A timeout,
  a network error, a `5xx` and a `429` are tried again, at most 3 tries, after 1 s and then 2 s, or after the `Retry-After` of a
  `429` (at most 10 s). Any other refusal (a wrong token, a channel that is not there; Slack says it with `200` and
  `ok: false`) is not tried again. Messages go out one after the other so that they keep their order; past 50 waiting the oldest is
  dropped and a warning is logged. A message that waits reads its target when its turn comes: a target removed meanwhile gets
  nothing.
- **The token** is never logged, never in a note (the notes are cleaned of it), and never sent to a browser. Its shape is checked
  when the target is saved (`xoxb-...`, `<digits>:<chars>`), so that a signing secret pasted by mistake is caught, and the
  error does not repeat what was typed.
- **How it went.** `last` of each target (time, ok, one line) is in memory and in the view. Test sends one message, one try.

### Replies

A message that was forwarded is remembered by the id the service gave it (`slack:<channel>:<ts>`, `telegram:<chat>:<message id>`)
with the id of the message, the agent that wrote it and its subject. The map holds the newest 500. A Slack message in the thread
of one of those, or a Telegram reply to one, becomes a message from `user` to that agent, `inReplyTo` the original and the
subject `Re: <subject>`, with the text as the body, whatever agent the uplink is set to. If that agent was removed or renamed
since, the uplink's recipient gets it. A reply to something that is not in the map is a message to the uplink's recipient (a Telegram message, a Slack direct message) or is ignored (a Slack channel). A Slack
event that was handled (the same `channel:ts`) is ignored the second time: Slack tries again and sends a mention in a thread as a
message too. The last 500 handled keys are kept.

### Routes and screen

`GET /api/relay` answers `{ slack, telegram, forward }`; a target is `{ to, last }`, never the token. `PUT /api/relay/slack` and
`/telegram` take `{ token?, to }` (no `token` keeps the saved one), `DELETE` removes a target, `POST /api/relay/<service>/test`
sends the test, and `PUT /api/relay/forward` takes `{ kinds }`. All answer the view. A bad field is 400 with its name, an unknown
service or a target that is not there 404. Browser token only. There is no frame and no snapshot field: the page asks again
after each change.

RELAY is a module of the Launch Window view, under UPLINK (`RelayPanel.tsx`, `relay.ts`, `relay.css`). At the top the four
switches. Then a card for each of GitHub, Linear, Slack and Telegram: Slack and Telegram have the target form (bot token,
channel or chat id, SAVE TARGET, TEST, REMOVE and how the last send went), every card has the setup steps in a fold, the uplinks
of its kind with their addresses and last deliveries, and MAKE UPLINK, which opens the form of Uplink for that kind. The steps are
in `relay.ts`.

## Decisions

- **A module of Launch Window, not a view.** The same reasons as Uplink: both are work that starts by itself, and the phone bar
  has no room for another key.
- **Relay hooks the places that feed the inbox, not the inbox.** Reading the `downlink` frame would need a copy of what was seen
  before to find what is new. The hub's `emit` and the one `notify` function are the two places, and they already exist.
- **`flight-plan` is "blocked or review".** The inbox event covers both, they both need the Director, and telling them apart would
  mean reading the text. The switch says "Tasks blocked or in review".
- **One list of kinds for all targets.** The brief says the Director picks what is forwarded; a switch for each target is
  twice the screen for no case anybody asked for.
- **Linear takes its own signing secret.** The Linear page makes the secret after the URL is given, and gonogo's address needs
  the id of the uplink, which needs the secret: so the steps say to make the webhook with a placeholder URL, copy the secret,
  make the uplink and then put the address in the webhook. Using the API to make the webhook with gonogo's secret would avoid
  that; it was not done because the field was not checked.
- **Telegram talks to one chat.** Anybody on Telegram can find a bot and write to it, and a webhook secret says only that the
  update comes from Telegram. A message from a chat that is not the target's is dropped. Slack has no such rule: its app is in
  your workspace, and whoever can write to the bot or mention it there reaches the agent (see the limits).
- **The target has to exist before the Telegram uplink works.** Its chat id is how the uplink knows who the Director is.
- **Ignored events are not recorded.** See Answers above. A ping is, so that the Director sees that GitHub reached gonogo.
- **A Slack signing secret and a Linear one are kept as text**, like the others: a signature cannot be checked against a hash.
- **`StartOptions.fetch`** is a seam for tests (like `agentCmd`): the end-to-end scenario hands in a fake so that nothing
  leaves the machine. It is not an option of the command line.
- **No new dependency.** Node's `fetch`, `AbortSignal` and `crypto`.

## Rejected

- Slack's Socket Mode, Telegram's `getUpdates` and a GitHub App: each needs a long connection, a loop or a private key, and the
  uplink already is the way in.
- Slack slash commands and buttons, Telegram commands, a Linear or GitHub reply (a comment from gonogo): the brief is messages
  in and messages out.
- Several targets of one service, or a different set of kinds for each.
- Names for Slack users and channels (`users.info` needs another scope and a call for each message).
- Filtering GitHub actions (`labeled`, `synchronize`): GitHub only filters by event, so every action of a chosen event is one
  message. Choose the events in GitHub, and the rate limit of Uplink protects the agent.
- Replay protection for GitHub, Linear and Telegram (their signatures have no time; Slack's has, and is checked).

## Known limits

- shortcut: the targets' tokens and the signing secrets are stored as text in 0600 files, see `relay.ts` and `uplinks.ts`.
  Encrypt them if the home folder is ever shared.
- shortcut: the map of forwarded messages and the handled keys are in memory and gone at a restart. A reply to an older message
  is a message to the uplink's recipient (Telegram, a Slack direct message) or is dropped (a Slack channel). Persist them if
  restarts get common.
- shortcut: the send queue and `last` are in memory. A restart drops what was waiting, and a message that was forwarded while the
  network was down for more than three tries is lost (the note says so, and a warning is logged).
- shortcut: a Slack event is marked handled when it is sent, also when the hub then refuses it (the uplink's recipient is gone),
  so Slack's retry of it is ignored. The delivery says it was refused; send the message again from Slack. A reply whose agent
  was removed or renamed since goes to the uplink's recipient instead, so that the service is not answered 409 (Telegram would
  send the same update again and again).
- shortcut: a Slack user and channel are ids, not names.
- A body over 256 KiB is a 413: a GitHub push with a very large payload is not delivered. Uplink's limit applies.
- Anybody who can write to the Slack bot or mention it in your workspace reaches the agent, and what a GitHub issue, a Linear
  comment or a pull request says is a message as from you. The agents are told nothing about where it came from. Use a private
  workspace or channel, and choose the recipient and its permission mode knowing this.
- Slack: a message with a file or an edit has a subtype and is ignored; a mention in a channel and the thread reply that follows
  need the bot to be in the channel.
- Telegram: `setWebhook` and `getUpdates` exclude each other. Telegram only calls HTTPS on the ports 443, 80, 88 and 8443.
- Slack marks the Request URL Verified only if gonogo answers in 3 seconds. The answer waits for nothing, so it should; this was
  not tried with Slack.
- Nothing was tried against a real service. The signatures are checked against the vectors the documentation of GitHub and Slack
  give and RFC 4231 (the HMAC), and against `openssl` and `curl` on a running server. The shapes of the payloads (GitHub's
  `push`, `pull_request`, `issues`, `issue_comment` and `workflow_run`, Linear's `Issue` and `Comment`, Slack's events, Telegram's
  `message`), the replies of `chat.postMessage` and `sendMessage`, and the wording of the setup steps (the menus of Slack, Linear,
  GitHub and Telegram) are from their documentation as remembered when this was written; no real delivery, bot, app or webhook
  was made. The outbound calls were tested with a fake `fetch` only. The page was opened in Chrome at 1280 px and in Chrome's
  390 px phone emulation (no overflow, keys of at least 44 px; the forms, the errors and an uplink made for GitHub and Slack);
  the keys were pressed by script, and Test was not pressed against a saved target, because it would call the real service. Not
  tried: Firefox, Safari, a screen reader, a real reverse proxy and a real `claude` reading a delivery.
