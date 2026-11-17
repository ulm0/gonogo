# Exposing gonogo safely

gonogo speaks plain HTTP and has no TLS of its own. Whoever holds the browser token can hire agents in `bypassPermissions` mode and type into every terminal, so the server runs shells as you for them. Read [Security](./reference/security.md) first. This page is about the one decision that matters: how do you reach it from another device.

**None of the recipes below was run against a real Caddy, nginx or Tailscale.** They follow the documentation of each tool and the routes of gonogo's code (see the end).

## Choose how to reach it

1. **Do not expose it.** Leave the bind address at `127.0.0.1` and use an SSH tunnel from the other machine: `ssh -L 7777:127.0.0.1:7777 you@host`, then open `http://127.0.0.1:7777/#token=...`. Nothing to configure.
2. **A private network (Tailscale).** The simplest way to use gonogo from a phone or a laptop. Only your devices can reach it.
3. **A public name behind a reverse proxy with HTTPS.** Needed only for what must be reached from the internet: webhooks (Uplink, Relay) and another station (Docking). Keep the page itself off the public name if you can.

Never run `--host 0.0.0.0` on a machine whose port can be reached from outside, with or without a proxy. In Docker the server binds `0.0.0.0` inside the container; publish it as `-p 127.0.0.1:7777:7777` so that only the host reaches it.

## What must be reachable from outside

| Path | Who calls it | Public? |
|---|---|---|
| `POST /uplink/<id>` | GitHub, Slack, Linear, Telegram, a monitor, your scripts (Uplink and the inbound side of Relay) | Only if you use them. Proves itself with the secret of that uplink. |
| `/dock/*` | Another gonogo you docked with (Docking) | Only if you dock, and only to that station. Proves itself with a signature. |
| `/`, `/assets/*`, `/api/*`, `/ws` | Your browser | **No.** Reach them over a private network. If you must, see "The page behind a proxy". |
| `/hook/*`, `/mcp` | Your agents | **Never.** Agents always call `127.0.0.1`; a Clean Room container calls `host.docker.internal`. No proxy is involved, so a proxy can answer 404 for both. |

A name for webhooks and docking alone is safer than one name for everything: the proxy forwards `/uplink/` and `/dock/` and answers 404 for the rest, so the page and the API are not even reachable there. gonogo limits an uplink to 30 deliveries a minute and a dock to 60 calls a minute, and a body to 256 KiB, whatever the proxy does.

## Allow the name

gonogo refuses a request whose `Host` is not a loopback name, the bind address or a name you allowed (`403 forbidden host`), and a browser request whose `Origin` is not its own `Host`. List every public name you serve:

```
gonogo --allow-host hooks.example.com --allow-host gonogo.example.com
# or: GONOGO_ALLOWED_HOSTS=hooks.example.com,gonogo.example.com
```

In Docker add `-e GONOGO_ALLOWED_HOSTS=hooks.example.com`. The proxy must pass the `Host` the client used. nginx rewrites it by default, so the examples set `Host $http_host`; Caddy keeps it.

## Webhooks and docking on a public name

Caddy gets its certificate by itself (the name must point at the machine, and ports 80 and 443 must be open):

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

nginx (certificate paths are an example; certbot writes such paths):

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

Then the address you give a sender is `https://hooks.example.com/uplink/<id>` (the Uplink row shows the origin of the page you opened, so replace it), and the address you give the other Director for Docking is `https://hooks.example.com`. Docking messages cross as plain text unless that address is `https`.

## The page behind a proxy

Serve gonogo at the root of a name, not under a path: the client calls `/api` and `/ws` by absolute path. The proxy must pass WebSocket upgrades and wait long: stopping an agent can take 8 seconds and terminal sockets stay open for hours.

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

The browser token is then the only gate on a name anyone on the internet can try, so guard the name too. Do not use the proxy's HTTP basic auth for it: the page sends its own `Authorization: Bearer` header on every `/api` call (this follows from `src/client/api.ts`; it was not tried), and the proxy would refuse those. Use a private network, a client certificate, or a proxy that signs you in with a cookie.

## The token in the URL

`gonogo ready: http://127.0.0.1:7777/#token=<64 hex>` puts the token after the `#`. A browser never sends that part to a server, so a proxy and its access log never see it. The page reads it once, keeps it in the local storage of that browser, and removes it from the address bar.

- Treat the whole URL like a password. A bookmark, a chat message or a screenshot that holds it opens your room.
- After that the token travels in the `Authorization` header of `/api` calls and in the `Sec-WebSocket-Protocol` header of `/ws`. Do not log either. nginx's default log format does neither; Caddy logs nothing unless you add a `log` directive, and if you do, drop request headers from it.
- The line is also in gonogo's own output, so it is in `docker logs`, in a systemd journal, in a log shipper. Rebuild the URL from the file instead of keeping that output: `echo "https://gonogo.example.com/#token=$(cat ~/.gonogo/token)"` (in Docker: `docker exec gonogo cat /state/gonogo/token`).
- The token never expires by itself. To change it, delete `~/.gonogo/token` and restart gonogo: the old URL stops working at once.

## Tailscale

[Tailscale](https://tailscale.com) joins your devices into a private network with encryption and a name for each machine. Install it on the machine that runs gonogo and on your phone or laptop, then on the gonogo machine:

```
tailscale serve --bg 7777
```

That gives `https://<machine>.<tailnet>.ts.net` with a certificate, reachable by your devices only, and forwards to `127.0.0.1:7777`. Start gonogo with that name allowed, open the address with `#token=...`, and it works on a phone. If the page answers `forbidden host`, the name in the address bar is not on the list: add it.

```
gonogo --allow-host <machine>.<tailnet>.ts.net
```

- Do not turn on Funnel for the page: it makes the whole name public.
- Two stations can dock over a tailnet: give each the other's `https://...ts.net` address (both devices must be able to reach each other, and each name must be allowed on its own station). No public name is needed.
- Binding to the Tailscale address (`--host 100.x.y.z`) also works and is encrypted by Tailscale, but the page then has an `http` address, which a browser treats as not secure. Prefer `tailscale serve`.

## Checklist

- The bind address is `127.0.0.1` (or the container's port is published on `127.0.0.1`).
- Every public name is in `--allow-host`, and TLS ends at the proxy.
- A public name forwards `/uplink/` and `/dock/` and nothing else, or the page is behind a private network.
- `/hook/` and `/mcp` are never forwarded.
- Neither the URL with the token nor the `Authorization` and `Sec-WebSocket-Protocol` headers are in a log you share.
- The secrets of Uplink, Relay and Docking are stored in plain text in the home directory (mode 0600), as [Security](./reference/security.md) says.

## Not verified

The Caddy and nginx files, `tailscale serve`, the allow-list with a real proxy name and docking over a tailnet were not run. What they rest on is read from the code: the route kinds and the Host and Origin checks in `src/server/web.ts`, the token handling in `src/client/api.ts`, and the limits in `src/server/constants.ts`.
