# Caddy on a server with ports 80 and 443

<ExposeMock provider="caddy" class="doc-mock" />

**Who can open it:** anyone who has the address. **What Caddy sees:** it ends the TLS on your own machine: nobody else sees the traffic. Full control, and the right choice when you have a server with a public address.


Give gonogo the address, the name and the header the proxy sets, and start it (the login with its second factor must already be set up, or gonogo refuses to start on this name):

```
gonogo --allow-host gonogo.example.com --public-url https://gonogo.example.com --trusted-proxy 127.0.0.1 --client-ip-header x-forwarded-for
```

`gonogo expose caddy --public-url https://gonogo.example.com` prints exactly this and the steps below. It runs nothing and holds none of your provider logins.

`gonogo expose caddy --public-url https://gonogo.example.com --write` also writes `<home>/expose/caddy/Caddyfile` (mode 0600; an existing file is kept):

```
gonogo.example.com {
	reverse_proxy 127.0.0.1:7777 {
		# the client address, set here and not taken from the client; the Host stays the public one (Caddy passes it unchanged)
		header_up X-Forwarded-For {remote_host}
	}
}
```

Then, in order:

```
caddy run --config <home>/expose/caddy/Caddyfile
gonogo expose check
```

- The name must point at this machine in DNS and ports 80 and 443 must be open for Caddy to get its certificate.
- Not verified: WebSocket proxying details on the Caddy page read; `gonogo expose check` opens one.
- Webhooks only? Do not give the page a name at all: `--allow-host hooks.example.com:hooks` serves only `/uplink/*` and `/dock/*` there (see [Exposing gonogo safely](../https.md)).

- The proxy must **overwrite** `X-Forwarded-For` with the address it saw, never pass the client's own through; do not use `cf-connecting-ip` here (it is a header any client can write unless Cloudflare is in front).

- **In Docker with the tunnel or proxy on the host,** gonogo sees it at the Docker bridge gateway (for example `172.17.0.1`: `docker network inspect bridge`), so give `--trusted-proxy` that address, not `127.0.0.1`. With the tunnel in the same container or network namespace, `127.0.0.1` is right.

## With Docker Compose

`compose.caddy.yaml` next to `compose.yaml` adds the sidecar, a private `edge` network between it and gonogo, and the gonogo settings `gonogo expose caddy` prints. It is used on top of the base file:

```
docker compose -f compose.yaml -f compose.caddy.yaml up -d
```

- **Set the login up first** (open gonogo on this machine, make the account, turn on the second factor): gonogo refuses to start on a public name before. So start with `docker compose up -d` alone, do that, then add the overlay.
- **`.env`** (no secret is in the file; everything comes from here): `GONOGO_PUBLIC_NAME` (a domain that points at this machine); ports 80 and 443 must be open.
- **Sets for gonogo:** `GONOGO_ALLOWED_HOSTS` (the name; with `GONOGO_HOOKS_ONLY=1` it becomes `name:hooks` and serves only the webhooks), `GONOGO_PUBLIC_URL` (`https://` and the name), `GONOGO_TRUSTED_PROXY` (the sidecar's address on the edge network, `172.29.80.2` unless you set `GONOGO_EDGE_PROXY_IP` and `GONOGO_EDGE_SUBNET`: **not 127.0.0.1**, which is the container itself) and `GONOGO_CLIENT_IP_HEADER`.
- **The Caddyfile** is `packaging/overlays/Caddyfile` (mounted read-only; certificates are kept in the `caddy_data` volume). `caddy` is pinned in the file.
- **Not tried:** no real tunnel, certificate or provider was run, and `docker compose config` was not run on these files (no Compose where they were written); the text is checked by tests against `gonogo expose`. Run `gonogo expose check` once it is up.

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
