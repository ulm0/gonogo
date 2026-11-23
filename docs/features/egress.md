# Clean Room API key: kept out of the container

<EgressMock class="doc-mock" />

A Clean Room agent runs in a container, and by default the container holds the Anthropic API key in its environment: whatever runs in there can read it. With this switch on, the container holds **a placeholder** and a web address of gonogo's, and **gonogo adds the real key** to the agent's requests to `api.anthropic.com`. The key never enters the container, its environment, its command line or the `docker` process. Design and threats: [`docs/cleanroom-egress-decision.md`](https://github.com/ulm0/gonogo/blob/main/docs/cleanroom-egress-decision.md). It is the first step of that note (a reverse proxy, no certificate in the container).

- **Where:** Flight Rules, CLEAN ROOM API KEY (the room's setting, **off** by default), and in an agent's form, under its Clean Room box: *Follow the room's setting*, *Keep it out of the container*, or *Leave it in the container*. The agent's own choice wins. It applies at the agent's **next start**.
- **Who can change it:** only you, in the page, with a fresh password check (step-up). An API key may **turn it on, but never off or back to the room's setting**, at the room or for an agent (a hire with `cleanRoom.egress: false`, or an edit of a Clean Room that does not say `egress: true`, is refused with "do it in the browser"). Hiring a Clean Room agent that holds its own key against the room's setting asks too. The page shows the setting, never a key. The Black Box records "Director set Clean Room egress for the Anthropic key on/off".
- **What the container gets:** `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>/egress/<token>/anthropic` and `GONOGO_API_KEY=gnp_…` (a random placeholder that Claude Code sends as its key and that the proxy throws away). Nothing else changes. With the switch off the start is exactly what it was.

## What the proxy does

- **One upstream:** `api.anthropic.com`, and only `/v1/` with GET, HEAD, POST and DELETE. Any other path (a `..`, an encoded slash or dot, a backslash), method or service is refused.
- **The token** is made at each agent start, is 32 random bytes, kept only as a hash, and **revoked when the agent stops** (and replaced at a restart). A wrong, old or revoked token is `403`, one that is not even shaped like one is `404`. It is the whole credential: no other header of the request is believed.
- **The key** is looked up at **every request** (the agent's Clearance first, else gonogo's own environment), so changing it applies at once; no copy is kept. The client's own `x-api-key`, `Authorization` and `Cookie` are removed and the real key is set as `x-api-key`. A key with a space, a line break or a control character is refused (`503`) and nothing is sent.
- **No redirect is followed:** a `30x` goes back to the client; a `Location` to the same host is turned into the proxy's own path, any other is dropped.
- **Where it connects:** the name is resolved once, **every address must be public** (not loopback, private, link-local such as the cloud metadata address, carrier-grade NAT, multicast, one of this machine's own, nor an address that wraps another one: NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, the IPv4-compatible `::/96`, or an IPv4-mapped one that holds a private address), and the connection is made to that answer (no second lookup to rebind).
- **Limits:** 16 requests at once per agent, 64 MiB of request body, 10 minutes idle.
- **Logs:** a line with the agent, the method, the status and the byte count at debug level. Never a header, a body, a path, the key, the token or the placeholder.

## Limits, said plainly

- **API-key mode only.** A subscription login (`CLAUDE_CODE_OAUTH_TOKEN`) is **not** covered: with the switch on and only a login, the agent starts as before and the log says so. A probe with Claude Code 2.1.325 and a placeholder login shows it does work mechanically (it sends `POST /v1/messages?beta=true` with `Authorization: Bearer <placeholder>` and the `oauth-2025-04-20` beta header, and accepts the base URL), but whether Anthropic accepts a subscription token through a proxy, and how a refreshed token would be kept, is **not known**, so it is not built.
- **Not enforced.** A Clean Room shares gonogo's network, so a process in it can still connect to the internet directly. The switch only makes sure **there is no key there to steal**. Other keys (GitHub, other Clearance keys, a stdio MCP server's secrets) are still in the environment.
- **The proxy sees the API traffic in plain text** (it ends the container's http and starts the https to Anthropic), as gonogo's own process already holds the key.
- **A live reload** of gonogo (a new server taking over running agents) keeps their proxy tokens: the hashes and the agent names, never a token or a key, are saved in `run/egress-tokens.json` (0600), and the new server finds the key again by the agent's name. A token whose agent is no longer live is dropped at the start, and one that is no longer valid answers `403` with "restart the agent to get a new one".
- **The base URL can be read by anyone who can run `docker inspect`** on a Clean Room container. That is not an escalation: such a process runs as the user who owns the key already, and the token stops working when the agent stops.
- **Same-user agents outside a Clean Room** can read `keys.json` and gonogo's environment: the Clean Room remains the boundary, and this narrows what it holds.
