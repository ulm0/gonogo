# Uplink: webhooks

<UplinkMock class="doc-mock" />

UPLINK (under the schedules in Launch Window) lists webhooks: addresses a service or script posts JSON to; each post reaches an agent as a message from the Director (Max Q, Redline and held mail apply). Design and limits: [`docs/uplink-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/uplink-spec.md).

- **An uplink**: name (at most 60 characters), recipient (FLIGHT, following the current boss, or a console that can read mail), and a secret gonogo makes (64 hex characters). Message subject `Uplink: <name>`, body the JSON pretty-printed, cut at 20000 characters with a note. At most 20 uplinks. Kind, fixed at creation: `generic` or `github`, `linear`, `slack`, `telegram` ([Relay](./relay.md)).
- **The secret is shown once**, at creation and rotation (stored in `uplinks.json`). Lost: ROTATE SECRET; the old one stops at once.
- **Each row**: address `<origin of the page>/uplink/<id>` with Copy, last delivery, a Deliveries fold with the last 20 (`queued`, `held`, `undelivered`, `refused`, `answered`, with message id or reason), Enabled switch, **TEST** (sends `{"test": true, ...}`, even when off), **ROTATE SECRET**, **DELETE**, **EDIT** (name, recipient, switch).

## The endpoint

`POST /uplink/<id>`, outside `/api`, no browser token. The sender proves itself with:

- `X-Gonogo-Signature: sha256=<hex>`: HMAC-SHA256 of the raw body keyed with the 64-character secret as text; or
- `Authorization: Bearer <secret>` for senders that cannot sign. It sends the secret itself: HTTPS only.

| Status | When |
|---|---|
| `202` | `{"ok": true, "id": "m12", "status": "queued"}` |
| `404` | unknown or disabled uplink |
| `401` | no valid proof (not recorded, not rate-counted) |
| `429` | over 30 deliveries a minute per uplink, with `Retry-After` |
| `400` | body is not JSON |
| `409` | recipient is gone, with the reason |
| `413` | body over 256 KiB |

Relay kinds authenticate as their service does and may answer `200` (ping, challenge, event not for agents); see [Relay](./relay.md).

```
URL=https://hooks.example.com/uplink/u1
SECRET=<the secret from the page>
BODY='{"event":"deploy","service":"web","ok":false}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -i -X POST "$URL" -H "X-Gonogo-Signature: sha256=$SIG" -d "$BODY"
# or, unsigned: curl -i -X POST "$URL" -H "Authorization: Bearer $SECRET" -d "$BODY"
```

Sign exactly the bytes sent. Node: `createHmac('sha256', secret).update(rawBody).digest('hex')`.

## Reaching it from outside

gonogo listens on `127.0.0.1`. Put an HTTPS reverse proxy in front that forwards only `/uplink/`, passes the body unchanged and keeps `Host`. Start gonogo with `--allow-host hooks.example.com` (or `GONOGO_ALLOWED_HOSTS=hooks.example.com`); other names get `403 forbidden host`. A name already serving gonogo ([Reverse proxy](../reference/security.md#reverse-proxy)) works unchanged, but a separate name forwarding only `/uplink/` is safer. nginx:

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

Keep the `location /` 404: the name is allow-listed, so without it `/api` and `/` reach gonogo. Caddy: `reverse_proxy /uplink/* 127.0.0.1:7777` in the name's site block. The page shows the origin you opened it on: replace it for the sender if it differs.

**The agent reads whatever the sender writes** (an issue title, a log line) as a message from you. Choose recipient and permission mode knowing anyone who can make the sender speak can speak to that agent.

## API

| Route | Does |
|---|---|
| `GET /api/uplinks` | list (also in state and the `uplinks` WebSocket frame; never with a secret) |
| `POST /api/uplinks` | `{"name": "GitHub", "to": "boss"}`, `enabled` default true; answer has the secret. `kind` (and for `slack`, `linear` the `secret`) goes here |
| `PATCH /api/uplinks/:id` | `name`, `to`, `enabled` (and `secret` for `slack`, `linear`) |
| `DELETE /api/uplinks/:id` | delete |
| `POST /api/uplinks/:id/rotate` | answer has the new secret |
| `POST /api/uplinks/:id/test` | test |
