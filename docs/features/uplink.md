# Uplink: webhooks

UPLINK (a module under the schedules in the Launch Window view) lists webhooks: an address that a service or a script posts
JSON to. Each post reaches an agent as a message from the Director, through the same path as the Brief box: Max Q, Redline
and held mail apply to it. Design and limits: [`docs/uplink-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/uplink-spec.md).

- **An uplink** has a name (at most 60 characters), a recipient (FLIGHT, which follows whoever is the boss, or one of the
  consoles that can read mail) and a secret that gonogo makes (32 random bytes, 64 hex characters). The message has the
  subject `Uplink: <name>` and the JSON of the post pretty-printed; one longer than 20000 characters is cut and ends with a
  line that says so. At most 20 uplinks. The kind is `generic` (any sender that signs its JSON, as below), or `github`, `linear`,
  `slack` or `telegram`, which Relay adds (see [Relay](./relay.md)). The kind is chosen when the uplink is made and cannot be changed.
- **The secret is shown once**, when you make the uplink and when you rotate it, in a saffron panel. gonogo keeps it in
  `uplinks.json` (a signature cannot be checked against a hash), but no answer, list or frame shows it again. If it is lost,
  Rotate makes a new one and the old one stops working at once.
- **Each row** shows the address (`<the origin of the page>/uplink/<id>`) with Copy, the last delivery, a Deliveries fold
  with the last 20 (time, `queued`, `held`, `undelivered`, `refused` or `answered`, and the message id with the hub's note, or why
  it was refused or answered), an Enabled switch, **TEST** (sends a sample, `{"test": true, ...}`, also when it is off), **ROTATE SECRET**
  and **DELETE** (both ask first) and **EDIT** (name, recipient, switch).
- **The endpoint** is `POST /uplink/<id>`. It is outside `/api` and does not take the browser token: the sender proves itself
  with the secret, in one of two ways. `X-Gonogo-Signature: sha256=<hex>` is the HMAC-SHA256 of the raw body, keyed with the
  secret as text (the 64 characters). `Authorization: Bearer <secret>` is for senders that cannot sign; it sends the secret
  itself, so use it over HTTPS only. Answers: `202` with `{"ok": true, "id": "m12", "status": "queued"}`; `404` for an
  unknown or a disabled uplink (the same answer); `401` for a request that does not prove itself; `429` with `Retry-After`
  past 30 deliveries a minute per uplink; `400` for a body that is not JSON; `409` with the reason when the recipient is gone;
  `413` past 256 KiB. A request that does not prove itself is not recorded and does not count against the limit. The kinds
  of Relay prove themselves in the way of their service and may answer `200` instead (a ping, a challenge, an event that is
  not for the agents); see [Relay](./relay.md).
- **A curl example.** With the address and the secret from the page:

  ```
  URL=https://hooks.example.com/uplink/u1
  SECRET=<the secret from the page>
  BODY='{"event":"deploy","service":"web","ok":false}'
  SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
  curl -i -X POST "$URL" -H "X-Gonogo-Signature: sha256=$SIG" -d "$BODY"
  # or, without signing: curl -i -X POST "$URL" -H "Authorization: Bearer $SECRET" -d "$BODY"
  ```

  The signature is over the bytes that are sent, so sign exactly what goes on the wire. With `-d` curl sends the text as it
  is. In Node: `createHmac('sha256', secret).update(rawBody).digest('hex')`.
- **Reaching it from outside.** gonogo listens on `127.0.0.1`, and the senders (GitHub, a monitor) are on the internet, so
  put a reverse proxy with HTTPS in front and forward only `/uplink/`. Start gonogo with the public name of the proxy,
  `--allow-host hooks.example.com` (or `GONOGO_ALLOWED_HOSTS=hooks.example.com`): the Host check is the same for this path as
  for every other, and a name that is not on the list gets `403 forbidden host`. The proxy must pass the body unchanged
  and keep the `Host`. If gonogo is already served on a name (the recipe under [Reverse proxy](../reference/security.md#reverse-proxy)), `/uplink/` works on it with
  no change. A name for webhooks alone is safer, because the proxy can forward `/uplink/` and nothing else. For nginx:

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

  Because that name is on the allow-list, a request for `/api` or `/` with it would reach gonogo too, which is why the
  `location /` above answers 404 itself and the browser token stays the only way into `/api`. Caddy:
  `reverse_proxy /uplink/* 127.0.0.1:7777` inside a site block for the name. Then the address to give the sender is
  `https://hooks.example.com/uplink/u1`; the page shows the origin you opened it on, so replace it when the two differ.
- **Whatever the sender writes, the agent reads.** The text of a delivery (an issue title, a log line) is a message as from
  you. Pick the recipient and its permission mode knowing that anyone who can make the sender say something can say it to
  that agent.
- **API.** `GET /api/uplinks`, `POST /api/uplinks` with `{"name": "GitHub", "to": "boss"}` (`enabled` defaults to true; the
  answer has the secret), `PATCH /api/uplinks/:id` with `name`, `to` or `enabled`, `DELETE /api/uplinks/:id`,
  `POST /api/uplinks/:id/rotate` (the answer has the new secret) and `POST /api/uplinks/:id/test`. The list is also in the
  state and in an `uplinks` frame on the WebSocket, never with a secret. `kind` (and, for `slack` and `linear`, `secret`) goes in
  the body of the `POST`; `secret` also goes in a `PATCH` of those two kinds.
