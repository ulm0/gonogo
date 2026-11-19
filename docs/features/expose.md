# Exposing gonogo: print the config, then check it

<ExposeMock provider="tailscale" class="doc-mock" />

`gonogo expose <provider> --public-url https://<name> [--write]` prints the commands and gonogo settings that publish the page, and with `--write` writes the config files (a Caddyfile, a cloudflared config) into `<home>/expose/<provider>/` with mode 0600. It **never runs a tunnel, never installs anything and never holds a provider's login**: the same rule as `gonogo update`. `gonogo expose check` then asks your public address, from this machine, whether it is as closed as it should be. Neither changes anything.

## Which provider

In this order (what each provider can see comes first, because it differs):

| Provider | Who can open it | What the provider sees | Page |
|---|---|---|---|
| **Tailscale Serve** | your tailnet only | does not decrypt | [Tailscale Serve](../expose/tailscale.md) |
| **Cloudflare named tunnel** | anyone with the address | ends the TLS: sees passwords, cookies, TOTP codes and every terminal byte | [Cloudflare](../expose/cloudflare.md) |
| **Caddy** on a server | anyone with the address | nothing: the TLS ends on your machine | [Caddy](../expose/caddy.md) |
| **Tailscale Funnel** | anyone with the address | relay servers do not decrypt | [Funnel](../expose/funnel.md) |
| **ngrok** | anyone with the address | ends the TLS, as Cloudflare does | [ngrok](../expose/ngrok.md) |

Quick Tunnels (`trycloudflare.com`) are for testing only: the name changes on every run, so the allowed host, the public URL and the login's passkeys break.

## What gonogo requires before it answers on a name

- **A page host** is `--allow-host gonogo.example.com`. A **hooks host** is `--allow-host hooks.example.com:hooks`: it serves only `/uplink/*` and `/dock/*`, 404 for everything else, no login page, no page, no socket. Existing `GONOGO_ALLOWED_HOSTS` entries stay page hosts. A name in both lists is a page host.
- **One reading of a Host.** Every check (the allow-lists, the proxy, the login's class) reads the Host through one function: lower case, no port, no brackets, one trailing dot dropped, then an **exact** match; an unknown Host gets `403 forbidden host` everywhere (default deny). The hooks-host check is on the parsed path: `/uplink/../api`, `//api`, `%2e%2e` and `/UPLINK` do not pass.
- **A public page host needs the login with its second factor, and an https public URL.** gonogo refuses to start on one otherwise, with one message that says what to do. A name is public or private from the flags and the shape of the name (RFC 1918, tailnet 100.64/10, `.local`, `.lan`, a name with no dot are private), never from where it resolves. A private name may stay plain http, with the login, and the page says it is not encrypted. A bind other machines can reach (outside a container, where the wildcard bind is normal) also needs the login.
- **`--public-url https://gonogo.example.com`** (or `GONOGO_PUBLIC_URL`) is the address other machines reach this gonogo by: its page, or, for a name given as `name:hooks`, its webhooks; gonogo takes your word and does not guess from forwarded headers whether TLS happened. The webhook addresses the page shows for Uplink and Relay use it.
- **`--trusted-proxy 127.0.0.1` and `--client-ip-header x-forwarded-for|cf-connecting-ip`**: the address is read from that header **only when the peer is a trusted proxy**, so a stranger cannot choose the rate-limit bucket. A tunnel makes every client look like 127.0.0.1; without this setting one shared bucket does the work.
- **`/hook` and `/mcp` are 404** on every Host the front port serves: agents use their room's own loopback port. The Docker socket and `GONOGO_UPDATE_HOOK` are never reachable from the internet.

The Flight Rules LOGIN block says which names gonogo answers on and whether the login stands behind them.

## The client address header

The proxy must **overwrite** the header named by `--client-ip-header`, not pass through what the client sent: `x-forwarded-for` is set to the address the proxy saw (Caddy: `header_up X-Forwarded-For {remote_host}`, as the written Caddyfile does). A proxy that appends to, or forwards, the client's own header lets a stranger pick the address gonogo rate-limits and logs. `cf-connecting-ip` is right **only behind Cloudflare** (Cloudflare sets it and replaces a client's value); behind any other proxy it is a header any client can write, so use `x-forwarded-for` there. gonogo reads the header only from a peer listed in `--trusted-proxy`.

## `gonogo expose check`

Run it on the machine after you did the provider's steps. It refuses while the login is not set up, then makes one set of requests to your public address and prints one line each:

- **TLS:** https, and an answer.
- **the login:** `/api/auth/status` says an account exists, and that gonogo sees this request as **public** (the proxy kept the public Host; a proxy that rewrites it to 127.0.0.1 would make a remote client look local).
- **`/api/state` answers 401** with no credential.
- **A token is refused on TCP:** it sends a **made-up** 64-hex token (new every run, never one of yours: a typo in the address or a hop without TLS must not leak a credential) and requires 401. A tunnel can make remote traffic look local; once an account exists no token works on TCP, whoever holds it.
- **`/hook` and `/mcp` are 404**; **a WebSocket upgrade with no credential is 401** (so the path and the upgrade pass the proxy); **the login page has its Content-Security-Policy**.

It exits 1 when a line fails. It cannot see an idle WebSocket close, a certificate that is about to expire or what the provider logs.

## When gonogo refuses to start

One message that says what to do: start gonogo **without** the option it names (and with `--host 127.0.0.1`; in Docker drop `GONOGO_ALLOWED_HOSTS` and `GONOGO_HOST` once), open `http://127.0.0.1:<your port>/`, make the account, turn on the second factor (Flight Rules, LOGIN), then add the option back. The refusals: a bind other machines can reach, outside Docker, with no account; a public page name without an account, the second factor and an https `--public-url`; an `--allow-host` entry that is not a bare host name (`https://x` or `x/y`). Private names (`zimaos`, `nas.local`, `192.168.x.x`) in a container are never refused. A **Docker self-update from 0.4 with a public `GONOGO_ALLOWED_HOSTS` rolls back**: the new container refuses to start, so it never becomes healthy.

## What a tunnel does and does not hide

A tunnel hides nothing the login does not cover. Cloudflare Tunnel, Cloudflare Access and ngrok **end the TLS at the provider**: it can see passwords, cookies, TOTP codes and every terminal byte. Tailscale Serve and Funnel do not decrypt. Every client behind a tunnel has one address (the device buckets of the login handle that), and a tunnel can make remote traffic look local, which is why `expose check` sends a made-up token through the public address and requires 401. Every proxy config `expose` writes sets `X-Forwarded-For` and keeps the public `Host`.

## Not tried

No real tunnel, certificate or provider was used: the configs follow each provider's documentation as read on 2026-11-18, and the tests run `expose check` against a stand-in server. Not built: running a tunnel for you, certificates, DNS, IP allow-lists, mTLS.
