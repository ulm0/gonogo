# Tailscale Funnel: the page on the public internet

<ExposeMock provider="funnel" class="doc-mock" />

**Who can open it:** anyone who has the address; your login and second factor are the only wall. **What Tailscale sees:** its relay servers do not decrypt the traffic; the TLS ends on this machine. Prefer [Serve](./tailscale.md) unless you need the open internet.


Give gonogo the address, the name and the header the proxy sets, and start it (the login with its second factor must already be set up, or gonogo refuses to start on this name):

```
gonogo --allow-host gonogo.tailnet-name.ts.net --public-url https://gonogo.tailnet-name.ts.net --trusted-proxy 127.0.0.1 --client-ip-header x-forwarded-for
```

`gonogo expose funnel --public-url https://gonogo.tailnet-name.ts.net` prints exactly this and the steps below. It runs nothing and holds none of your provider logins.

Then, in order:

```
tailscale funnel --bg http://127.0.0.1:7777
tailscale funnel status
gonogo expose check
```

- Needs a `funnel` node attribute for this machine and HTTPS certificates; only ports 443, 8443 and 10000; only `<machine>.<tailnet>.ts.net` names; the bandwidth limits are not configurable.

- The proxy must **overwrite** `X-Forwarded-For` with the address it saw, never pass the client's own through; do not use `cf-connecting-ip` here (it is a header any client can write unless Cloudflare is in front).

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
