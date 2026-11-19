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

- Cloudflare closes idle WebSockets after a time it does not state. gonogo pings every 20 seconds (checked in the code), which is shorter than any idle limit Cloudflare documents, but `expose check` cannot see an idle close (not verified).
- Not verified for Tunnel: how Host is mapped and WebSocket behaviour; `expose check` shows the Host gonogo sees.
- Do not use a **Quick Tunnel** (`trycloudflare.com`): it is for testing only, its name changes on every run, so `--allow-host`, the public URL and passkeys break.

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
