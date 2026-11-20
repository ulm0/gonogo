# Exposing gonogo: print the config, then check it

<ExposeMock provider="tailscale" class="doc-mock" />

`gonogo expose <provider> --public-url https://<name> [--write]` prints the commands and settings that publish the page; `--write` writes the config files (a Caddyfile, a cloudflared config) to `<home>/expose/<provider>/` with mode 0600. It **never runs a tunnel, installs anything or holds a provider's login**. `gonogo expose check` asks your public address, from this machine, whether it is as closed as it should be. Neither changes anything.

## Which provider

| Provider | Who can open it | What the provider sees | Page |
|---|---|---|---|
| **Tailscale Serve** | your tailnet only | does not decrypt | [Tailscale Serve](../expose/tailscale.md) |
| **Cloudflare named tunnel** | anyone with the address | ends the TLS: sees passwords, cookies, TOTP codes and every terminal byte | [Cloudflare](../expose/cloudflare.md) |
| **Caddy** on a server | anyone with the address | nothing: TLS ends on your machine | [Caddy](../expose/caddy.md) |
| **Tailscale Funnel** | anyone with the address | relay servers do not decrypt | [Funnel](../expose/funnel.md) |
| **ngrok** | anyone with the address | ends the TLS, as Cloudflare does | [ngrok](../expose/ngrok.md) |

Quick Tunnels (`trycloudflare.com`) are for testing only: the name changes every run, which breaks the allowed host, the public URL and passkeys. Cloudflare Access also ends the TLS at the provider.

## What gonogo requires before it answers on a name

| Flag / env | Meaning |
|---|---|
| `--allow-host gonogo.example.com` | a page host. Existing `GONOGO_ALLOWED_HOSTS` entries stay page hosts; a name in both lists is a page host. Must be a bare host name (`https://x`, `x/y` refused) |
| `--allow-host hooks.example.com:hooks` | a hooks host: serves only `/uplink/*` and `/dock/*`; 404 for the rest, no login page, page or socket. `GONOGO_HOOKS_ONLY=1` in the overlays |
| `--public-url https://gonogo.example.com` (or `GONOGO_PUBLIC_URL`) | the address other machines reach gonogo by (its webhooks for a `name:hooks`); taken on your word, not guessed from headers. Uplink and Relay webhook addresses use it |
| `--trusted-proxy 127.0.0.1` | the proxy whose forwarded address is believed. A tunnel makes every client look like 127.0.0.1; without it one shared bucket does the work |
| `--client-ip-header x-forwarded-for\|cf-connecting-ip` | header read **only from a trusted proxy** |

- **Host matching:** lower case, no port, no brackets, one trailing dot dropped, **exact** match. An unknown Host gets `403 forbidden host` everywhere (default deny). Hooks hosts check the parsed path: `/uplink/../api`, `//api`, `%2e%2e`, `/UPLINK` do not pass.
- **A public page host needs the login with its second factor, and an https public URL**; gonogo refuses to start otherwise, with one message saying what to do. Public or private comes from the flags and the shape of the name (RFC 1918, tailnet 100.64/10, `.local`, `.lan`, a name with no dot are private), never from where it resolves. A private name may stay plain http with the login (the page says it is not encrypted). A bind other machines can reach (outside a container) also needs the login.
- **`/hook` and `/mcp` are 404** on every Host the front port serves (agents use their room's loopback port). The Docker socket and `GONOGO_UPDATE_HOOK` are never reachable from the internet.
- Flight Rules -> LOGIN shows which names gonogo answers on and whether the login stands behind them.

## The client address header

The proxy must **overwrite** the header named by `--client-ip-header` with the address it saw (Caddy: `header_up X-Forwarded-For {remote_host}`, as the written Caddyfile does). A proxy that appends or forwards the client's header lets a stranger pick the address gonogo rate-limits and logs. `cf-connecting-ip` is right **only behind Cloudflare**; behind any other proxy use `x-forwarded-for`. Every config `expose` writes sets `X-Forwarded-For` and keeps the public `Host`.

## `gonogo expose check`

Run it on the machine after the provider's steps. It refuses while the login is not set up, then prints one line per request to your public address:

- **TLS:** https, and an answer.
- **Login:** `/api/auth/status` says an account exists and gonogo sees the request as **public** (a proxy rewriting the Host to 127.0.0.1 would make remote clients look local).
- **`/api/state` answers 401** with no credential.
- **A token is refused on TCP:** it sends a **made-up** 64-hex token (new each run, never yours) and requires 401.
- **`/hook` and `/mcp` are 404**; **a WebSocket upgrade with no credential is 401**; **the login page has its Content-Security-Policy**.

Exit 1 when a line fails. It cannot see an idle WebSocket close, a certificate about to expire, or what the provider logs.

## Docker Compose overlays

Next to `compose.yaml` each provider has a file: `compose.tailscale.yaml` (Serve or Funnel), `compose.cloudflared.yaml`, `compose.ngrok.yaml`, `compose.caddy.yaml`. Use `docker compose -f compose.yaml -f compose.<provider>.yaml up -d` (Docker Compose v2.23 or later). They add the sidecar and a private edge network, and set `GONOGO_ALLOWED_HOSTS` (`name:hooks` with `GONOGO_HOOKS_ONLY=1`), `GONOGO_PUBLIC_URL`, the trusted proxy (the sidecar's address on that network, not `127.0.0.1`) and the client address header, as `gonogo expose` prints them. Secrets and versions come from your `.env`. Each provider page has a **With Docker Compose** section.

## When gonogo refuses to start

Refused: a reachable bind outside Docker with no account; a public page name without an account, second factor and https `--public-url`; an `--allow-host` entry that is not a bare host name. Private names (`zimaos`, `nas.local`, `192.168.x.x`) in a container are never refused.

Fix: start gonogo **without** the named option and with `--host 127.0.0.1` (**in Docker never `--host 127.0.0.1`**: it cuts off the published port while the healthcheck still says healthy; keep the image's `0.0.0.0` and drop `GONOGO_ALLOWED_HOSTS` once). Open `http://127.0.0.1:<port>/` (in Docker the published port, on the host), make the account, turn on the second factor (Flight Rules, LOGIN), then add the option back.

A **Docker self-update from 0.4 with a public `GONOGO_ALLOWED_HOSTS` rolls back**: the new container refuses to start and never becomes healthy.

## Limits

- A tunnel hides nothing the login does not cover. Every client behind a tunnel has one address (the login's device buckets handle that).
- Not tried: no real tunnel, certificate or provider. Configs follow each provider's documentation as read on 2026-11-18; tests run `expose check` against a stand-in server.
- Not built: running a tunnel for you, certificates, DNS, IP allow-lists, mTLS.
