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
- Not verified: whether Serve puts the client address in X-Forwarded-For. If it does not, gonogo sees every client as 127.0.0.1 and one shared rate-limit bucket does the work.
- A `.ts.net` name is a public name by its shape, so gonogo asks for the login and its second factor and an https public URL, as for any public name.

- The proxy must **overwrite** `X-Forwarded-For` with the address it saw, never pass the client's own through; do not use `cf-connecting-ip` here (it is a header any client can write unless Cloudflare is in front).

- **In Docker with the tunnel or proxy on the host,** gonogo sees it at the Docker bridge gateway (for example `172.17.0.1`: `docker network inspect bridge`), so give `--trusted-proxy` that address, not `127.0.0.1`. With the tunnel in the same container or network namespace, `127.0.0.1` is right.

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
