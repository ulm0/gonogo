# Exposing gonogo safely

gonogo speaks plain HTTP, no TLS. The browser token lets its holder run agents in `bypassPermissions` mode and type into every terminal, so read [Security](./reference/security.md) first.

<ProxyPathsMock class="doc-mock" />

**None of these recipes was run against a real Caddy, nginx or Tailscale.** They follow each tool's documentation and gonogo's routes.

## Choose how to reach it

1. **Do not expose it.** Keep the bind address `127.0.0.1` and tunnel: `ssh -L 7777:127.0.0.1:7777 you@host`, then open `http://127.0.0.1:7777/#token=...`.
2. **A private network ([Tailscale](#tailscale)).** Simplest for a phone or laptop; only your devices reach it.
3. **A public name behind an HTTPS reverse proxy.** Only for what the internet must reach: webhooks (Uplink, Relay) and another station (Docking). Keep the page off the public name if you can.

Never run `--host 0.0.0.0` on a machine whose port is reachable from outside. In Docker, publish as `-p 127.0.0.1:7777:7777`.

## What must be reachable from outside

| Path | Who calls it | Public? |
|---|---|---|
| `POST /uplink/<id>` | GitHub, Slack, Linear, Telegram, monitors, scripts (Uplink, inbound Relay) | Only if you use them. Proved by that uplink's secret. |
| `/dock/*` | A docked gonogo (Docking) | Only if you dock. Proved by a signature. |
| `/`, `/assets/*`, `/api/*`, `/ws` | Your browser | **No.** Use a private network, or see [The page behind a proxy](#the-page-behind-a-proxy). |
| `/hook/*`, `/mcp` | Your agents | **Never.** Agents call `127.0.0.1` (a Clean Room calls `host.docker.internal`); a proxy can answer 404. |

Prefer a name for webhooks and docking alone: the proxy forwards `/uplink/` and `/dock/` and answers 404 for the rest. Whatever the proxy does, gonogo limits an uplink to 30 deliveries a minute, a dock to 60 calls a minute, and a body to 256 KiB.

## Allow the name

gonogo refuses a request whose `Host` is not a loopback name, the bind address or an allowed name (`403 forbidden host`), and a browser request whose `Origin` is not its own `Host`. List every public name:

```
gonogo --allow-host hooks.example.com --allow-host gonogo.example.com
# or: GONOGO_ALLOWED_HOSTS=hooks.example.com,gonogo.example.com
```

In Docker: `-e GONOGO_ALLOWED_HOSTS=hooks.example.com`. The proxy must pass the client's `Host`: Caddy does; nginx needs `Host $http_host`.

## Webhooks and docking on a public name

Caddy gets its certificate itself (the name must point at the machine; ports 80 and 443 open):

```
hooks.example.com {
    @public path /uplink/* /dock/*
    handle @public {
        reverse_proxy 127.0.0.1:7777
    }
    handle {
        respond 404
    }
}
```

nginx (certificate paths as certbot writes them):

```nginx
server {
    listen 443 ssl;
    server_name hooks.example.com;
    ssl_certificate     /etc/letsencrypt/live/hooks.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hooks.example.com/privkey.pem;

    location ~ ^/(uplink|dock)/ {
        client_max_body_size 256k;
        proxy_pass http://127.0.0.1:7777;
        proxy_set_header Host $http_host;
    }
    location / { return 404; }
}
```

Give senders `https://hooks.example.com/uplink/<id>` (the Uplink row shows the origin you opened the page on; replace it). Give the other Director `https://hooks.example.com` for Docking. Docking traffic is plain text unless that address is `https`.

## The page behind a proxy

Serve gonogo at the root of a name, not under a path (the client calls `/api` and `/ws` by absolute path). The proxy must pass WebSocket upgrades and allow long reads: stopping an agent can take 8 seconds and terminal sockets stay open for hours.

```
gonogo.example.com {
    @agents path /hook/* /mcp /mcp/*
    respond @agents 404
    reverse_proxy 127.0.0.1:7777
}
```

```nginx
server {
    listen 443 ssl;
    server_name gonogo.example.com;
    ssl_certificate     /etc/letsencrypt/live/gonogo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gonogo.example.com/privkey.pem;

    location ~ ^/(hook|mcp)(/|$) { return 404; }
    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

The browser token is then the only gate on a public name, so guard the name too: a private network, a client certificate, or a proxy that signs you in with a cookie. Not HTTP basic auth: the page sends its own `Authorization: Bearer` header on every `/api` call, so the proxy would refuse them (read from the code, not tried).

## The token in the URL

`gonogo ready: http://127.0.0.1:7777/#token=<64 hex>` puts the token after the `#`, which browsers never send to a server. The page stores it in that browser's local storage and removes it from the address bar.

- Treat the whole URL as a password (bookmarks, chat, screenshots).
- Afterwards the token travels in the `Authorization` header of `/api` calls and the `Sec-WebSocket-Protocol` header of `/ws`. Do not log either. nginx's default log format logs neither; Caddy logs nothing unless you add `log`, and then drop request headers.
- The line is also in gonogo's output (`docker logs`, the systemd journal, log shippers). Rebuild the URL from the file instead: `echo "https://gonogo.example.com/#token=$(cat ~/.gonogo/token)"` (Docker: `docker exec gonogo cat /state/gonogo/token`).
- The token never expires. To change it, delete `~/.gonogo/token` and restart gonogo; the old URL stops working.

## Tailscale

Install [Tailscale](https://tailscale.com) on the gonogo machine and your devices, then on the gonogo machine:

```
tailscale serve --bg 7777
```

This serves `https://<machine>.<tailnet>.ts.net` with a certificate, to your devices only, forwarding to `127.0.0.1:7777`. Allow the name and open it with `#token=...`. A `forbidden host` answer means the name is not allowed yet.

```
gonogo --allow-host <machine>.<tailnet>.ts.net
```

- Do not turn on Funnel for the page: it makes the name public.
- Two stations can dock over a tailnet with each other's `https://...ts.net` address (each must reach the other and allow its own name). No public name needed.
- `--host 100.x.y.z` also works, but the page is then `http`, which browsers treat as not secure. Prefer `tailscale serve`.

## Checklist

- Bind address `127.0.0.1` (or the container port published on `127.0.0.1`).
- Every public name in `--allow-host`; TLS ends at the proxy.
- A public name forwards only `/uplink/` and `/dock/`, or the page is on a private network.
- `/hook/` and `/mcp` never forwarded.
- No shared log holds the token URL or the `Authorization` and `Sec-WebSocket-Protocol` headers.
- Uplink, Relay and Docking secrets are plain text in the home directory (mode 0600), see [Security](./reference/security.md).
