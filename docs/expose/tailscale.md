# Tailscale Serve: the page for your tailnet

<ExposeMock provider="tailscale" class="doc-mock" />

**Who can open it:** only devices on your tailnet. **What Tailscale sees:** it does not decrypt the traffic; the TLS ends on this machine. This is the first choice: nothing is public, the phone joins the tailnet, https is automatic.


Give gonogo the address, the name and the header the proxy sets, and start it (the login with its second factor must already be set up, or gonogo refuses to start on this name):

```
gonogo --allow-host gonogo.tailnet-name.ts.net --public-url https://gonogo.tailnet-name.ts.net --trusted-proxy 127.0.0.1 --client-ip-header x-forwarded-for
```

`gonogo expose tailscale --public-url https://gonogo.tailnet-name.ts.net` prints exactly this and the steps below. It runs nothing and holds none of your provider logins.

Then, in order:

```
tailscale serve --bg http://127.0.0.1:7777
tailscale serve status    # the https name it prints is your public URL
gonogo expose check
```

- Needs MagicDNS and HTTPS certificates switched on for the tailnet (Tailscale admin console).
- Not verified: whether Serve (and Funnel) put the client address in X-Forwarded-For. If it does not, gonogo sees every client as 127.0.0.1 and one shared rate-limit bucket does the work.
- A `.ts.net` name is a public name by its shape, so gonogo asks for the login and its second factor and an https public URL, as for any public name.

- The proxy must **overwrite** `X-Forwarded-For` with the address it saw, never pass the client's own through; do not use `cf-connecting-ip` here (it is a header any client can write unless Cloudflare is in front).

- **In Docker with the tunnel or proxy on the host,** gonogo sees it at the Docker bridge gateway (for example `172.17.0.1`: `docker network inspect bridge`), so give `--trusted-proxy` that address, not `127.0.0.1`. With the tunnel in the same container or network namespace, `127.0.0.1` is right.

## With Docker Compose

`compose.tailscale.yaml` next to `compose.yaml` adds the sidecar, a private `edge` network between it and gonogo, and the gonogo settings `gonogo expose tailscale` prints. It is used on top of the base file (it needs **Docker Compose v2.23 or later**: the proxy's config is inline in the file, so only `compose.yaml` and this file are needed):

```
docker compose -f compose.yaml -f compose.tailscale.yaml up -d
```

- **Set the login up first** (open gonogo on this machine, make the account, turn on the second factor): gonogo refuses to start on a public name before. So start with `docker compose up -d` alone, do that, then add the overlay.
- **`.env`** (no secret is in the file; everything comes from here): `TS_AUTHKEY` (an auth key from the Tailscale admin console), optional `TAILSCALE_VERSION` (another tag of `tailscale/tailscale`; the file pins `v1.104.4`), `GONOGO_PUBLIC_NAME` (`<machine>.<tailnet>.ts.net`), optional `TS_HOSTNAME` and `TAILSCALE_FUNNEL=true` (Funnel, the public internet; the default is Serve).
- **Your own LAN names:** `GONOGO_LAN_HOSTS=zimaos,192.168.1.5` (comma separated) is added to `GONOGO_ALLOWED_HOSTS`, so the names you open gonogo by on your own network keep working.
- **Docker says "Pool overlaps with other one on this address space":** another network already uses `172.29.80.0/24`; set `GONOGO_EDGE_SUBNET` (for example `172.29.81.0/24`) and `GONOGO_EDGE_PROXY_IP` (an address in it) in `.env`.
- **Sets for gonogo:** `GONOGO_ALLOWED_HOSTS` (the name; with `GONOGO_HOOKS_ONLY=1` it becomes `name:hooks` and serves only the webhooks), `GONOGO_PUBLIC_URL` (`https://` and the name), `GONOGO_TRUSTED_PROXY` (the sidecar's address on the edge network, `172.29.80.2` unless you set `GONOGO_EDGE_PROXY_IP` and `GONOGO_EDGE_SUBNET`: **not 127.0.0.1**, which is the container itself) and `GONOGO_CLIENT_IP_HEADER`.
- **The client address (not verified):** if Serve or Funnel do not set `X-Forwarded-For`, every client reaches gonogo as the sidecar, `172.29.80.2`: one shared rate-limit bucket and no "different network" warning at login. Check the client address LOGIN shows on a real run.
- **Serve or Funnel:** `TAILSCALE_FUNNEL=true` adds `AllowFunnel` to the serve config, which is inline in the file (`configs` with `content`). The sidecar runs in user-space networking: no `NET_ADMIN`, no `/dev/net/tun`.
- **Not tried:** no real tunnel, certificate or provider was run, and `docker compose config` was not run on these files (no Compose where they were written); the text is checked by tests against `gonogo expose`. Run `gonogo expose check` once it is up.

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
