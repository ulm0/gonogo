# Spec: Uplink

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): incoming webhooks that
start work, the equivalent of Munder Difflin's 24x7 webhooks.

## Intent

A service or a script posts JSON to an address of gonogo, and an agent gets it as a message from the Director: a GitHub
issue opened, a monitor that fired, a deploy that finished, a cron job on another machine. Nothing else is new: the agent
that gets the message works as it always does, and Max Q, Redline and held mail apply as to any message of the Director.

## Design

- **An uplink** is `{ id, name, kind, to, secret, enabled, createdAt, deliveries }` (`Uplink` in `src/shared/protocol.ts`).
  `id` is `u1`, `u2`, ... and is not used twice in one run of the server. `to` is an agent name or `boss` (which follows
  whoever is the boss), as for a schedule. `deliveries` are the last 20, newest first: `{ at, status, note }`. Browsers
  get `UplinkView`, the same without `secret`.
- **The file** is `~/.gonogo/uplinks.json`, `{ "version": 1, "uplinks": [...] }`, mode 0600, written whole through a
  temporary file and a rename after every change and every delivery (`src/server/uplinks.ts`, the same writer as
  `schedules.ts`). The secret is in it as text: a signature cannot be checked against a hash. A file that cannot be read
  is renamed `uplinks.json.bad` and the server starts with none, so the next save cannot overwrite the secrets that were
  handed out. One bad record is skipped with a warning and the rest load.
- **The secret** is 32 random bytes in hex (64 characters). It is in the answer to create and to rotate and nowhere else:
  not in the list, not in the state, not in a frame. The page keeps it in the state of one component, so leaving the view
  loses it. Rotate makes a new one and the old one stops at once; the deliveries stay.
- **The endpoint** is `POST /uplink/:id`, outside `/api` and outside the browser token (`handleUplink` in `web.ts`; the
  route kind `uplink`). The sender proves itself in one of two ways, and either one is enough:
  `X-Gonogo-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body keyed with the secret text (the 64 characters, not
  the bytes they spell), or `Authorization: Bearer <secret>`. Both are compared in constant time. The signature is over
  the bytes as they arrived, before anything is parsed. The bearer form is there for senders that cannot sign; it sends
  the secret itself, so it wants HTTPS.
- **The answers.** 202 `{ ok, id, status }` when a message was made (`status` is the hub's: `queued`, `held` or
  `undelivered`; an undelivered message exists and went to the Director's loop). 404 `not found` for an id that is
  unknown, not of the form `u<n>` or disabled: the same body, so nothing says which. 401 for a request that does not prove
  itself. 429 with `Retry-After: 60` past the rate limit. 400 for a body that is not JSON. 409 with the hub's reason when
  the hub refused the message (the recipient is gone, there is no boss). 413 past 256 KiB. 405 with `Allow: POST` for
  another method, whatever the id. 503 until the server is ready. The new error code is `rate_limited` (429).
- **The limits.** A body of at most 256 KiB (`UPLINK_BODY_MAX_BYTES`, checked on the declared length and while reading).
  30 deliveries a minute per uplink, in a sliding window kept in memory (`UPLINK_RATE_MAX`). Only a request that proved
  itself counts and is recorded: ids are `u1`, `u2`, so a stranger could otherwise use up the limit of the real sender or
  fill the list of deliveries with noise. The first refusal of a flood is recorded, the rest are not (as the hub does for
  an agent's send limit). At most 20 uplinks and a name of 60 characters on one line.
- **The message.** From `user` to the target, subject `Uplink: <name>`, body the JSON pretty-printed with two spaces. JSON
  that is not an object is still JSON (`"text"`, `42`, `[1]`). A body longer than 20000 characters (the hub's limit) is
  cut and ends with `[cut: the delivery has N characters, the first M are shown]`; the delivery's note says `(cut)`. The
  body is read as JSON whatever its `Content-Type`, because senders differ.
- **A delivery record** is `queued`, `held` or `undelivered` (the hub's status, with its note after the message id) or
  `refused` (a body that was not JSON, a hub that refused, the first refusal of a flood). `Test` writes the same with
  `test: ` in front.
- **The kind is an extension point.** `UPLINK_KINDS` was `['generic']` when this was written, and `KINDS` in `uplinks.ts` maps a kind
  to two functions: `authentic(raw, headers, secret)` and `read(raw)` (the message text of a body, or a `bad_request`). Relay
  (`docs/relay-spec.md`) added `github`, `linear`, `slack` and `telegram` by adding entries; the functions now also get the clock
  and the headers, and `read` may answer the sender or ignore the body instead of making a message. The file, the routes and the
  rate limit are as described here. The kind is chosen at create and cannot be edited.
- **Routes** (`web.ts`, browser token only): `GET /api/uplinks`, `POST /api/uplinks` (201 with the secret),
  `PATCH /api/uplinks/:id` (200; `name`, `to` and `enabled`; any other field is a 400 with its name),
  `DELETE /api/uplinks/:id` (204), `POST /api/uplinks/:id/rotate` (200 with the new secret) and
  `POST /api/uplinks/:id/test` (200 with the view; it sends `{ "test": true, "uplink": <name>, "at": <ISO time> }` through
  the same path, on or off, without the rate limit, and a refusal is in the delivery, not in the status). A bad field is
  400 with its name, an unknown id 404, the 21st uplink 409. `to` is checked for its shape, not for existing: the hub says
  at the delivery if the agent is gone.
- **Frames.** `uplinks` carries the whole list and is sent at every change and every delivery; `StateSnapshot.uplinks` has
  it at connect. No secret is in either.
- **Host and Origin.** The path is reached through a reverse proxy, so the Host check is the one every route has: the name
  has to be loopback, the bind address or on the allow-list (`--allow-host`, `GONOGO_ALLOWED_HOSTS`). No other route got
  looser, and the Clean Room name `host.docker.internal` still reaches only hooks and tools. An `Origin` header is refused
  with 403, as for hooks: a webhook sender is a server, and a web page has no reason to post here.
- **The screen** is a module in the Launch Window view, under the schedules (`UplinkPanel.tsx`, `uplink.ts`,
  `uplink.css`). Each row has the name, the recipient, the address in a field with Copy, the last delivery, a Deliveries
  fold (time, status chip, note), an Enabled switch, Test, Rotate secret, Edit and Delete. Rotate and Delete ask inline
  first, with focus on Keep. Create and Rotate open a saffron panel that shows the secret once, selected, with Copy
  secret and a key that closes it. The address is `<origin of the page>/uplink/<id>`.

## Decisions

- **A section of Launch Window, not a view of its own.** Both start work by themselves, the phone bar has four keys of 87 px
  at 390 px and a fifth would be 70 px, the top bar is full, and a view for a list that is empty most of the time is a click
  more than it is worth. The module has its own name (UPLINK) and its own files, so it can be lifted into a view later
  without touching the rest.
- **The Host check stays as it is.** "Let the path through for the allowed hosts" is what it already does: the public name of
  the proxy goes on the allow-list. Letting `/uplink/` skip the check for any name would save one flag and lose nothing the
  secret does not cover, but the brief was to keep the rest as strict as today, and one rule is easier to explain.
- **404 before 401.** An unknown or disabled id is 404, an enabled id with a wrong proof is 401. That tells a stranger that an
  id exists, but ids are `u1`, `u2` and guessable anyway. What it does not tell is whether the id is off.
- **The signature is over the text of the secret.** `openssl dgst -sha256 -hmac "$SECRET"` and every HMAC library take the
  key as given, and that is the 64 characters. A scheme that decoded the hex first would break the one-line recipe.
- **The body is JSON or nothing.** Form posts, XML and plain text are a 400, not a message with a guess. A kind of Relay can
  read what it needs.
- **Prompt injection is not solved here.** The text of a delivery (an issue title, a log line) becomes a message the agent
  treats as from the Director. No preface says "this came from outside", because it would make agents that were set up to
  act on a delivery hesitate. Choose the recipient and its permission mode knowing that anyone who can make the sender
  say something can say it to the agent.
- **A failed proof is not recorded and not logged above debug.** It would give anyone who guesses an id a way to push the
  real deliveries out of the list of 20. A sender that does not get through sees its 401 in its own log.

## Rejected

- A signature header per service (`X-Hub-Signature-256`, Slack, Stripe) in the generic kind: that is Relay's job, as kinds.
- A secret stored as a hash: the HMAC needs the secret itself.
- Replay protection (a timestamp in the signature, a nonce): a replayed delivery is another message of the same words. Add
  a timestamp header to the generic kind if a sender needs it.
- Queueing a delivery for an agent that is down: the hub already says `undelivered` and the message is in the loop.
- A configurable rate limit or body limit per uplink.

## Known limits

- shortcut: the secret is stored in plain text in a 0600 file, see `uplinks.ts`. Encrypt it if the home folder is ever
  shared.
- shortcut: a request that does not prove itself costs the server a hash of up to 256 KiB and is not rate limited. Put a rate
  limit on the reverse proxy; add one for failures here if the endpoint is ever exposed without one.
- The bearer form sends the secret in the clear to whatever is on the path. Use HTTPS, which the proxy recipe gives.
- The wall's MISSION shows the subject of the latest message to FLIGHT, so a delivery to the boss becomes the mission and
  restarts its clock (the same as a scheduled message).
- shortcut: `to` is a name, so an uplink does not follow a renamed console; its deliveries end `refused` (409 to the
  sender) until it is edited. Key by record id if renames get common.
- The address on the page is the origin the page was opened on. Behind a proxy that is usually the right name; if the
  sender must use another, replace the origin by hand.
- The rate limit is in memory: a restart gives every uplink its 30 back.
- Ids are not used twice in one run, but after a restart the highest one removed before it can come back.
- Tested with a fake store behind the routes, a real server with the stand-in agent (a signed post, a bearer post, a bad
  body, another Host and an Origin, test, rotate, off, a missing recipient and delete) and `curl` against a running server.
  Never run behind a real reverse proxy, never from a real GitHub or other sender, never with a real `claude` reading a
  delivery. The page was opened in Chrome: the form, the secret panel and a list with deliveries at 1280 px, and the list with
  its deliveries open in Chrome's 390 px phone emulation (no horizontal overflow, keys of at least 44 px, the switch's
  label is the 44 px target). Not opened in a browser: the Rotate and Delete questions, the form at 390 px, Edit and Test.
  Not tried: Firefox, Safari, a screen reader, and the Copy keys (the field is selected so that copying by hand works
  where the clipboard is refused).
