# Uplink: webhooks

<UplinkMock class="doc-mock" />

UPLINK (under the schedules in the Launch Window view) lists webhooks: addresses a service or script posts JSON to. Each
post reaches an agent as a message from the Director; Max Q, Redline and held mail apply. Design and limits:
[`docs/uplink-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/uplink-spec.md).

- **An uplink** has a name (at most 60 characters), a recipient (FLIGHT, which follows the current boss, or a console that
  can read mail) and a secret gonogo makes (32 random bytes, 64 hex characters). The message has the subject
  `Uplink: <name>` and the posted JSON pretty-printed, cut at 20000 characters with a note. At most 20 uplinks. The kind,
  fixed at creation, is `generic` (any sender that signs as below) or `github`, `linear`, `slack` or `telegram`
  ([Relay](./relay.md)).
- **The secret is shown once**, at creation and at rotation. It is stored in `uplinks.json` but never shown again. If it
  is lost, Rotate makes a new one; the old one stops at once.
- **Each row** shows the address (`<the origin of the page>/uplink/<id>`) with Copy, the last delivery, a Deliveries fold
  with the last 20 (`queued`, `held`, `undelivered`, `refused` or `answered`, with message id or reason), an Enabled
  switch, **TEST** (sends `{"test": true, ...}`, even when off), **ROTATE SECRET**, **DELETE** and **EDIT** (name,
  recipient, switch).
- **The endpoint** is `POST /uplink/<id>`, outside `/api`, without the browser token. The sender proves itself with:
  - `X-Gonogo-Signature: sha256=<hex>`: HMAC-SHA256 of the raw body, keyed with the 64-character secret as text; or
  - `Authorization: Bearer <secret>`, for senders that cannot sign. It sends the secret itself: HTTPS only.

  | Status | When |
  |---|---|
  | `202` | `{"ok": true, "id": "m12", "status": "queued"}` |
  | `404` | unknown or disabled uplink |
  | `401` | no valid proof (not recorded, not rate-counted) |
  | `429` | over 30 deliveries a minute per uplink, with `Retry-After` |
  | `400` | body is not JSON |
  | `409` | recipient is gone, with the reason |
  | `413` | body over 256 KiB |

  Relay kinds authenticate the way their service does and may answer `200` (a ping, a challenge, an event not for the
  agents); see [Relay](./relay.md).
- **A curl example.** With the address and secret from the page:

  ```
  URL=https://hooks.example.com/uplink/u1
  SECRET=<the secret from the page>
  BODY='{"event":"deploy","service":"web","ok":false}'
  SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
  curl -i -X POST "$URL" -H "X-Gonogo-Signature: sha256=$SIG" -d "$BODY"
  # or, without signing: curl -i -X POST "$URL" -H "Authorization: Bearer $SECRET" -d "$BODY"
  ```

  Sign exactly the bytes sent. In Node: `createHmac('sha256', secret).update(rawBody).digest('hex')`.
- **Reaching it from outside.** gonogo listens on `127.0.0.1`. Put an HTTPS reverse proxy in front that forwards only
  `/uplink/`, passes the body unchanged and keeps the `Host`. Start gonogo with `--allow-host hooks.example.com` (or
  `GONOGO_ALLOWED_HOSTS=hooks.example.com`); other names get `403 forbidden host`. If gonogo is already served on a name
  ([Reverse proxy](../reference/security.md#reverse-proxy)), `/uplink/` works there unchanged, but a separate name that
  forwards only `/uplink/` is safer. nginx:

  ```nginx
  server {
      server_name hooks.example.com;
      # TLS lines here
      location /uplink/ {
          limit_req zone=uplink burst=10 nodelay;   # limit_req_zone $binary_remote_addr zone=uplink:1m rate=10r/s; in http {}
          client_max_body_size 256k;
          proxy_pass http://127.0.0.1:7777;
          proxy_set_header Host $http_host;
      }
      location / { return 404; }
  }
  ```

  The `location /` 404 matters: the name is on the allow-list, so without it `/api` and `/` would reach gonogo too.
  Caddy: `reverse_proxy /uplink/* 127.0.0.1:7777` in a site block for the name. Give the sender
  `https://hooks.example.com/uplink/u1`; the page shows the origin you opened it on, so replace it if they differ.
- **Whatever the sender writes, the agent reads** as a message from you (an issue title, a log line). Choose the recipient
  and its permission mode knowing that anyone who can make the sender say something can say it to that agent.
- **API.** `GET /api/uplinks`, `POST /api/uplinks` with `{"name": "GitHub", "to": "boss"}` (`enabled` defaults to true; the
  answer has the secret), `PATCH /api/uplinks/:id` with `name`, `to` or `enabled`, `DELETE /api/uplinks/:id`,
  `POST /api/uplinks/:id/rotate` (answer has the new secret) and `POST /api/uplinks/:id/test`. The list is also in the
  state and in an `uplinks` frame on the WebSocket, never with a secret. `kind` (and, for `slack` and `linear`, `secret`)
  goes in the `POST` body; `secret` also goes in a `PATCH` of those two kinds.
