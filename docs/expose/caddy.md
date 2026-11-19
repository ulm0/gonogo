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

**Tried:** not run against the real service. The commands follow the provider's documentation as read on 2026-11-18; `gonogo expose check` is the proof for your setup.
