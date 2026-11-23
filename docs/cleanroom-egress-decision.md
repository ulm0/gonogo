# Decision note: credential injection at egress for the Clean Room (draft)

By FIDO, 2026-11-23, for FLIGHT, the Director and RSO. Read-only research: **no code changed.** Read: `src/server/launcher.ts` (`:619`, `:718`, `:731`), `src/server/cleanroom.ts` (`buildDockerArgs`), `src/server/constants.ts:366` (`CLEAN_ROOM_CREDENTIALS`), `docs/cleanroom-microvm-decision.md` (my earlier note). **Vercel Sandbox's `networkPolicy` is described only from FLIGHT's message; I did not read its docs.** Nothing here was run; "not verified" marks what needs a real try.

## 1. Short answer

- **Yes, and it needs no MITM for the first targets.** Use a **reverse proxy** run by gonogo: the container is told a *base URL* that points at it, sends a *placeholder* token, and the proxy swaps in the real credential and forwards over https. This covers **Claude/Anthropic** (`ANTHROPIC_BASE_URL`) and **remote MCP servers** (gonogo writes the agent's `mcp.json`, so it can point each server at the proxy). A plain `HTTPS_PROXY` (CONNECT) cannot inject: the TLS is end to end, so the proxy only sees a host name and can **allow or deny, not add headers**. MITM (a gonogo CA trusted in the container) is the last resort, opt-in, later.
- **Enforcement is a separate problem from injection.** Today the Clean Room shares gonogo's network namespace, so a process in it can ignore the proxy and connect straight out. Injection still helps (nothing worth stealing is in the container), but **deny and allow-list policy can only be enforced once the Clean Room has its own network**: the same "bridge mode" the microVM note needs. One network change serves both.
- **Smallest first PR (S1, about 350 lines):** the per-agent reverse proxy for Anthropic only, the key kept out of the container's environment, no network change. It also answers the one question I cannot answer from here: whether Claude Code accepts a placeholder OAuth token with a custom base URL (section 3).

## 2. What reaches the container today

`launcher.ts:731` builds the list of variable **names** passed to `docker run` by name: `CLEAN_ROOM_ENV` (`GONOGO_TOKEN`, `TERM`...), `CLEAN_ROOM_CREDENTIALS` (`CLAUDE_CODE_OAUTH_TOKEN`, `GONOGO_API_KEY`) and every key of the agent's Clearance (`keysOf(agent)`), so a Clearance `GH_TOKEN` or `OPENAI_API_KEY` is in the container's environment. `GONOGO_TOKEN` is the agent's own token for gonogo's `/hook` and `/mcp`: a credential, but only for that agent's own tools, not an external secret. In seed mode `ANTHROPIC_API_KEY` is already moved into an `apiKeyHelper` (`launcher.ts:282`), a script Claude Code runs to get the key: **that is the natural place for a placeholder**.

## 3. How each target can work

| Target | No-MITM way | Notes |
|---|---|---|
| **Claude / Anthropic API** | `ANTHROPIC_BASE_URL=http://<proxy>/a/<agent token>/anthropic`; the `apiKeyHelper` (API-key mode) or `CLAUDE_CODE_OAUTH_TOKEN` (subscription mode) is a **placeholder**; the proxy replaces `x-api-key` or `Authorization: Bearer` and forwards to `https://api.anthropic.com` | `ANTHROPIC_BASE_URL` is a documented Claude Code setting (from general knowledge, not re-read). **Not verified:** whether the client accepts a placeholder OAuth token and still sends the headers a subscription token needs. API-key mode is the safe first try. |
| **Remote MCP servers** (`type: http`) | gonogo writes `mcp.json`; the URL becomes `http://<proxy>/a/<token>/mcp/<name>`; the proxy adds the headers from the server's rule | Clean: gonogo already owns that file. **stdio MCP servers run inside the container and need their secrets in the environment**; they stay as today (said plainly) until they can run on the host side. |
| **npm** | `npm_config_registry=http://<proxy>/a/<token>/npm/` can carry a private-registry token | Public registry needs no secret. Package metadata holds absolute `https://registry.npmjs.org/...` tarball URLs, so injection for a *private* registry needs URL rewriting in the proxy: **not phase 1**. |
| **gh / git** | no clean no-MITM way: `gh` talks to `https://api.github.com`; a custom host (`GH_HOST`) means GitHub Enterprise paths and, I believe, https; git cannot reach the repo from the container anyway (`CLEAN_ROOM_NOTE`: the Director commits from outside) | **Not targeted.** Either leave `GH_TOKEN` in the environment (honest) or deny it. `not verified`. |
| **Anything else over HTTPS** | `HTTPS_PROXY` with CONNECT: allow or deny by host only | no injection |

**MITM, if ever (phase 5, opt-in):** a CA per room, the key held only in gonogo's process memory or a 0600 file the container never sees; the container gets the certificate (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`); **name-constrained to the rule hosts** and short-lived leaf certificates. Costs: the proxy then sees every byte of every https call (code sent to the API included), certificate pinning breaks, and a CA trusted in the container is a standing risk. **I recommend not building it until a target needs it.**

## 3b. Identifying the agent, and where the proxy runs

The proxy lives **inside the room's gonogo process** (it already holds the keys in memory; the secret never crosses a process boundary). One listener per room on the address the Clean Room can reach. **Each agent start gets a fresh proxy token** (random, like the agent token), carried in the base-URL path (`/a/<token>/...`) or as the proxy password; it maps to that agent's rules and is **revoked when the agent stops**. The placeholder credential inside the container (`gnp_<random>`) is just a token the proxy recognizes and discards: useless outside.

## 4. Egress policy in the same rules

Rules per agent (resolved from the room default): `mode: open | proxy | list | deny`.
- `open` (today): nothing changes.
- `proxy`: injection and logging on, direct egress still possible where the network allows.
- `list`: only the hosts in the rules (injection hosts plus `allow` hosts) are reachable through the proxy; other CONNECTs are refused.
- `deny`: only gonogo's own `/hook` and `/mcp`.

**How it is enforced, per flavor** (this is the part that ties to the microVM note):

| Flavor | Enforcement |
|---|---|
| **Docker (runc), shared namespace (today)** | **Not enforceable**: the container shares gonogo's network namespace, so it can connect anywhere gonogo can. The mode is advisory; the UI must say "not enforced on this network". Injection still keeps secrets out. |
| **Docker or gVisor on its own network** | `docker network create --internal gonogo-cr-<room>` (no route out); the Clean Room joins it; **the only reachable address is gonogo's listener** on that network (the egress proxy plus a `/hook` and `/mcp`-only listener, the "bridge mode" of the microVM note). Everything else is unroutable, so a direct IP connection fails. |
| **Kata (microVM)** | the same internal network; the VM's interface lands on it. |
| **Host firewall rules** | not assumed: I do not know whether ZimaOS lets us add them (`docs/cleanroom-microvm-decision.md`, section 6). |

**A limit to state:** gonogo's own container attaches to that internal network, so the Clean Room can also reach **any other port gonogo's container listens on** (the supervisor's front port, which is `0.0.0.0` in Docker). It needs the login and is no worse than today's shared namespace, but it is a reason to bind the front port to specific addresses when the bridge mode lands. Proxy requests are accepted **only with a valid proxy token** and refused for any destination that resolves to a loopback, private, link-local or the gonogo container's own address, resolved once and the connection pinned to it (the lesson of the semantic-search review).

## 5. Config shape

- **Room default:** `<home>/egress.json` (0600, atomic, `version: 1`): `{ mode, hosts: [{ host, inject: [{ header, key }], allow? }] }`. `host` is an exact name (no wildcard in v1). `header` must be on a short allow-list (`authorization`, `x-api-key`, `private-token`, `x-*`-style names matching a pattern; **never `host`, `cookie`, `content-length` or hop-by-hop headers**). **`key` is the *name* of a Clearance key** (room or agent), never a value: values are looked up in memory at request time, so a changed key applies at once and **no secret is in the rules file, the API answer or the UI.**
- **Per agent:** `AgentRecord.egress?: 'inherit' | 'off' | { mode, hosts }` (like `cleanRoom`, `permissions`): the same shape, editable in the hire/edit form and in Flight Rules, `inherit` by default.
- **Presets** for the common cases (Anthropic API, a named MCP server) so the Director picks a name from a list and cannot mistype a host that then receives a credential.
- **API:** `GET/PUT /api/egress` and the per-agent field; **writes need step-up and scope `full`** (a rule decides where a secret is sent: it is an exfiltration control). **The UI shows host names, header names and key names, never values.**
- **What leaves the environment:** with a rule for a key, `launcher.ts:731` **drops that name from the list passed to the container** (and `CLAUDE_CODE_OAUTH_TOKEN` / `GONOGO_API_KEY` when the Anthropic rule is on) and passes the placeholder instead. A key with no rule keeps today's behavior and the UI marks it "in the container's environment".

## 6. Threats (RSO reads this)

| Id | Threat | Must hold |
|---|---|---|
| **G1** | The CA key is read by the sandbox (only if MITM is ever built). | The key never enters the container; the container gets the certificate only; name-constrained, short-lived leaf certs; same-user agents outside a Clean Room can read a 0600 file anyway (the known limit): keep the key in memory. No CA in phases 1 to 4. |
| **G2** | Header leakage to another domain. | Injection only when the **request's destination host equals the rule's host exactly**; the client's own `Authorization`/`x-api-key` are **removed** and replaced; **redirects are not followed by the proxy**: a `30x` goes back to the client, which can only re-request through the proxy (a different host then has no rule, so no header). Never add a header on a CONNECT. |
| **G3** | A rule sends a credential to an attacker host. | Rules are written only by the Director's session with step-up; presets; exact hosts; the Outbound-style log of rule changes; an agent has no route to the rules or to `keys.json` through the API. |
| **G4** | Proxy bypass by direct IP or by an unlisted port. | Enforced only on an internal network (section 4); **stated plainly as not enforced** on the shared namespace; the proxy refuses IP-literal destinations and any name resolving to a private, loopback, link-local or own address; resolve once, pin the connection (DNS rebinding). |
| **G5** | The placeholder or proxy token is stolen inside the container. | Per-agent, per-start, revoked at stop, accepted only from the internal network; worth nothing elsewhere. |
| **G6** | Header or request smuggling through key values or paths. | Header names allow-listed; **values from keys rejected if they contain CR, LF or NUL**; the path is normalized and the `/a/<token>/<service>/` prefix stripped exactly once; no `..`; hop-by-hop headers dropped. |
| **G7** | Logs leak. | Never log headers, bodies, or the placeholder; log host, method, status, bytes and the agent only (counts to the Black Box). |
| **G8** | The proxy as a relay or a DoS. | `list`/`deny` modes; per-agent caps on connections, request size, and time; the proxy talks to nobody but the rule hosts in `list`. |
| **G9** | The proxy sees all API traffic in plaintext (it terminates TLS to upstream). | Accepted: it is gonogo's own process on the same machine, as the key already is; said in the docs. A separate sidecar process would only move the same trust. |
| **G10** | Same-user agents outside a Clean Room read `keys.json` and the process environment. | Unchanged known limit: **the Clean Room is the boundary; this feature narrows what a Clean Room holds.** |
| **G11** | OAuth subscription token handling (terms, headers). | **Not verified**; API-key mode first. |

## 7. Phases

| PR | What | Size | Needs |
|---|---|---|---|
| **S1** | `src/server/egress.ts`: a per-room listener, the per-agent token, the Anthropic reverse proxy (`x-api-key` / `Bearer` swap, no redirects, IP/DNS checks), `ANTHROPIC_BASE_URL` and the placeholder helper in the Clean Room start, the key removed from the container's environment; no config yet (Anthropic only, on by a room switch, default off); tests with a fake upstream | S to M, ~350 | none; **answers the OAuth question** |
| **S2** | the rules model (`egress.json`, per-agent override), presets, the API with step-up, the Flight Rules block and the hire form field; remote MCP rewriting in `mcp.json` with header injection | M, ~450 | S1; RSO |
| **S3** | the internal network mode and the `/hook`+`/mcp` listener (shared with the microVM note), `list` and `deny` enforcement, the "not enforced" notice on the shared namespace | M, ~300 | the microVM bridge decision; RSO |
| **S4** | the request log in the UI (host, status, counts), the per-agent view, the gVisor and Kata checks | S to M, ~250 | S3 |
| **S5 (only if needed)** | MITM with a name-constrained CA | M to L | a target that needs it; its own security section |

**Tests (S1):** the proxy swaps the placeholder and never forwards the client's; a redirect is returned, not followed; a request for a host with no rule is refused; a destination resolving to `127.0.0.1`, `169.254.169.254` or gonogo's own address is refused; a key containing a newline is rejected; the container's environment has no real key and the placeholder is not accepted after the agent stops; logs hold no header; the container still starts with the switch off exactly as today.

## 8. Open questions for the Director

1. OK to start with **reverse proxy only (no MITM)**, accepting that gh/git and stdio MCP servers keep their secrets in the environment for now?
2. **Anthropic mode first:** API key, or subscription OAuth token? (OAuth with a placeholder is the unknown.)
3. Should `deny`/`list` wait for the internal-network mode (S3), or does the Director want the advisory modes sooner, clearly labelled "not enforced"?
