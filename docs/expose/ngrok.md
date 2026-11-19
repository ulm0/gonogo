# ngrok: public, the last choice

<ExposeMock provider="ngrok" class="doc-mock" />

**Who can open it:** anyone who has the address. **What ngrok sees:** it ends the TLS, so it can see every password, cookie, TOTP code and terminal byte that passes. Use it only when nothing above is possible.


Give gonogo the address, the name and the header the proxy sets, and start it (the login with its second factor must already be set up, or gonogo refuses to start on this name):

```
gonogo --allow-host gonogo.example.ngrok.app --public-url https://gonogo.example.ngrok.app --trusted-proxy 127.0.0.1 --client-ip-header x-forwarded-for
```

`gonogo expose ngrok --public-url https://gonogo.example.ngrok.app` prints exactly this and the steps below. It runs nothing and holds none of your provider logins.

Then, in order:

```
ngrok http --url=gonogo.example.ngrok.app http://127.0.0.1:7777
ngrok http --domain=gonogo.example.ngrok.app http://127.0.0.1:7777    # the same for an ngrok agent before 3.16, which has --domain
gonogo expose check
```

- Check `ngrok http --help` for your version: the flag for a fixed name has changed over time.
- Free-plan features, WebSocket support and any interstitial page were not read: `gonogo expose check` is the proof.

- The proxy must **overwrite** `X-Forwarded-For` with the address it saw, never pass the client's own through; do not use `cf-connecting-ip` here (it is a header any client can write unless Cloudflare is in front).

- **In Docker with the tunnel or proxy on the host,** gonogo sees it at the Docker bridge gateway (for example `172.17.0.1`: `docker network inspect bridge`), so give `--trusted-proxy` that address, not `127.0.0.1`. With the tunnel in the same container or network namespace, `127.0.0.1` is right.

## With Docker Compose

`compose.ngrok.yaml` next to `compose.yaml` adds the sidecar, a private `edge` network between it and gonogo, and the gonogo settings `gonogo expose ngrok` prints. It is used on top of the base file:

```
docker compose -f compose.yaml -f compose.ngrok.yaml up -d
```

- **Set the login up first** (open gonogo on this machine, make the account, turn on the second factor): gonogo refuses to start on a public name before. So start with `docker compose up -d` alone, do that, then add the overlay.
- **`.env`** (no secret is in the file; everything comes from here): `NGROK_AUTHTOKEN`, `NGROK_VERSION` (a tag of `ngrok/ngrok`: pick one on Docker Hub; there is no default on purpose), `GONOGO_PUBLIC_NAME` (your fixed ngrok domain).
- **Sets for gonogo:** `GONOGO_ALLOWED_HOSTS` (the name; with `GONOGO_HOOKS_ONLY=1` it becomes `name:hooks` and serves only the webhooks), `GONOGO_PUBLIC_URL` (`https://` and the name), `GONOGO_TRUSTED_PROXY` (the sidecar's address on the edge network, `172.29.80.2` unless you set `GONOGO_EDGE_PROXY_IP` and `GONOGO_EDGE_SUBNET`: **not 127.0.0.1**, which is the container itself) and `GONOGO_CLIENT_IP_HEADER`.
- The command is `http --url=<name> gonogo:7777` (`--url` is ngrok 3.16 and later; an older agent has `--domain`: edit the file).
- **Not tried:** no real tunnel, certificate or provider was run, and `docker compose config` was not run on these files (no Compose where they were written); the text is checked by tests against `gonogo expose`. Run `gonogo expose check` once it is up.

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
