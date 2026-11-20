# Cloudflare named tunnel: public, outbound-only

<ExposeMock provider="cloudflare" class="doc-mock" />

**Who can open it:** anyone who has the address (put Cloudflare Access in front as a second layer; gonogo still logs in). **What Cloudflare sees:** it ends the TLS, so it can see every password, cookie, TOTP code and terminal byte that passes. Use [Tailscale Serve](./tailscale.md) if that is not acceptable. No port is opened: `cloudflared` only makes outbound connections.


Give gonogo the address, the name and the header the proxy sets, and start it (the login with its second factor must already be set up, or gonogo refuses to start on this name):

```
gonogo --allow-host gonogo.example.com --public-url https://gonogo.example.com --trusted-proxy 127.0.0.1 --client-ip-header cf-connecting-ip
```

`gonogo expose cloudflare --public-url https://gonogo.example.com` prints exactly this and the steps below. It runs nothing and holds none of your provider logins.

`gonogo expose cloudflare --public-url https://gonogo.example.com --write` also writes this file to `<home>/expose/cloudflare/config.yml` (mode 0600; an existing file is kept):

```yaml
# gonogo expose cloudflare: edit the two paths, then run it with the command printed by `gonogo expose cloudflare`.
tunnel: gonogo
credentials-file: /home/YOU/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: gonogo.example.com
    service: http://127.0.0.1:7777
    originRequest:
      httpHostHeader: gonogo.example.com   # keep the public Host: gonogo's Host check and the login's class use it
  - service: http_status:404
```

Then, in order:

```
cloudflared tunnel login
cloudflared tunnel create gonogo
cloudflared tunnel route dns gonogo gonogo.example.com
cloudflared tunnel --config <home>/expose/cloudflare/config.yml run gonogo
gonogo expose check
```

- `--client-ip-header cf-connecting-ip` is right **only behind Cloudflare**, which sets it and replaces a client's value; with any other proxy use `x-forwarded-for`.
- Cloudflare closes idle WebSockets after a time it does not state. gonogo pings every 20 seconds (checked in the code), which is shorter than any idle limit Cloudflare documents, but `expose check` cannot see an idle close (not verified).
- Not verified for Tunnel: how Host is mapped and WebSocket behaviour; `expose check` shows the Host gonogo sees.
- Do not use a **Quick Tunnel** (`trycloudflare.com`): it is for testing only, its name changes on every run, so `--allow-host`, the public URL and passkeys break.

- **In Docker with the tunnel or proxy on the host,** gonogo sees it at the Docker bridge gateway (for example `172.17.0.1`: `docker network inspect bridge`), so give `--trusted-proxy` that address, not `127.0.0.1`. With the tunnel in the same container or network namespace, `127.0.0.1` is right.

## With Docker Compose

`compose.cloudflared.yaml` next to `compose.yaml` adds the sidecar, a private `edge` network between it and gonogo, and the gonogo settings `gonogo expose cloudflare` prints. It is used on top of the base file (it needs **Docker Compose v2.23 or later**: the proxy's config is inline in the file, so only `compose.yaml` and this file are needed):

```
docker compose -f compose.yaml -f compose.cloudflared.yaml up -d
```

- **Set the login up first** (open gonogo on this machine, make the account, turn on the second factor): gonogo refuses to start on a public name before. So start with `docker compose up -d` alone, do that, then add the overlay.
- **`.env`** (no secret is in the file; everything comes from here): `TUNNEL_TOKEN` (the token of a remotely managed tunnel), `GONOGO_PUBLIC_NAME`.
- **Your own LAN names:** `GONOGO_LAN_HOSTS=zimaos,192.168.1.5` (comma separated) is added to `GONOGO_ALLOWED_HOSTS`, so the names you open gonogo by on your own network keep working.
- **Docker says "Pool overlaps with other one on this address space":** another network already uses `172.29.80.0/24`; set `GONOGO_EDGE_SUBNET` (for example `172.29.81.0/24`) and `GONOGO_EDGE_PROXY_IP` (an address in it) in `.env`.
- **Sets for gonogo:** `GONOGO_ALLOWED_HOSTS` (the name; with `GONOGO_HOOKS_ONLY=1` it becomes `name:hooks` and serves only the webhooks), `GONOGO_PUBLIC_URL` (`https://` and the name), `GONOGO_TRUSTED_PROXY` (the sidecar's address on the edge network, `172.29.80.2` unless you set `GONOGO_EDGE_PROXY_IP` and `GONOGO_EDGE_SUBNET`: **not 127.0.0.1**, which is the container itself) and `GONOGO_CLIENT_IP_HEADER`.
- **In the Cloudflare dashboard** (the token mode keeps the ingress there): the tunnel's Public Hostname is your name, service `HTTP` `gonogo:7777`, and under Additional application settings, HTTP Settings, set the **HTTP Host Header** to the same name: gonogo checks the Host. `cloudflare/cloudflared` is pinned in the file.
- `GONOGO_CLIENT_IP_HEADER` is `cf-connecting-ip` here, right only behind Cloudflare.
- **Not tried:** no real tunnel, certificate or provider was run, and `docker compose config` was not run on these files (no Compose where they were written); the text is checked by tests against `gonogo expose`. Run `gonogo expose check` once it is up.

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
