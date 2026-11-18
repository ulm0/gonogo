# Security

<GatesMock class="doc-mock" />

## Network and tokens

- gonogo listens on `127.0.0.1` unless you pass `--host`. No TLS: to reach it from elsewhere, see [Reverse proxy](#reverse-proxy).
- Every `/api` call and the `/ws` WebSocket need the browser token. The built client files do not; they hold no state.
- A request whose `Host` is not a loopback name, the bind address or an `--allow-host` name gets 403, as does a browser request whose `Origin` is not its own `Host`. This blocks DNS rebinding and cross-site requests.
- Agents never see the browser token. Each agent start gets its own token in `GONOGO_TOKEN` (never on a command line), valid only for the hook and tool endpoints.
- Agents always call the server on `127.0.0.1`, whatever you bind. A Clean Room container uses `host.docker.internal` instead, accepted as `Host` for the hook and tool endpoints only (agent token still needed, `Origin` still refused); every other route answers 403 `forbidden host` for that name.

## Agents run as you

- An agent in `bypassPermissions` mode runs as your user: it can read the token files and everything else you can. Agent tokens stop mistakes and API misuse, not a hostile agent.
- Credentials in gonogo's environment (in the container: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) reach the agents (an API key as `GONOGO_API_KEY` in seed mode), so their shells can read them.
- **Secrets on disk are plain text** (mode 0600), readable by anyone who can read your home and by any `bypassPermissions` agent:
  - Uplink secrets and Slack/Linear signing secrets: `uplinks.json`.
  - Relay bot tokens: `relay.json`. Never logged or sent to the browser.
  - Docking secrets: `docking.json`.
  - Payload env and header values (tokens, API keys): `agents.json` and the agent's `mcp.json`; the page receives them so Edit can show them. To keep one out, write `${NAME}` and Claude Code expands it from the agent's environment (gonogo's minus the scrubbed variables; from Claude Code's docs, not tried).
- A payload server is code or a service you chose; its tools run with the agent's permission mode.

## Uplink

**`POST /uplink/<id>` takes no browser token.** It needs that uplink's secret (a body signature, or the secret as a bearer token). At most 256 KiB and 30 a minute per uplink. Unknown and disabled uplinks both answer 404. The Host check applies; a request with an `Origin` header is refused. An agent reads a delivery as a message from you.

## Relief

`hire_agent` makes a request, never a hire: the agent is hired only after your GO, a call that takes the browser token (an agent's token, the boss's too, gets 401). A request cannot hold `auto` or `bypassPermissions`, a custom command, a payload or a Clean Room of its own; 3 may wait, 5 in 10 minutes, each 30 minutes. **The role text it carries is what the new agent obeys, and a boss that read untrusted text may write something you would not**: read the block before GO. A Clean Room boss hires only Clean Room agents inside its own folder.

## Docking

**Dock only with people you trust: their agents can reach yours.**

- A docked station can message every agent of yours as `name@station`; your agent may act on it with the permissions you gave it. It can also create tasks assigned to your agents, and see your agents' names, roles and states. Agents are told to share only what a task needs; a prompt cannot enforce that.
- `/dock/*` takes no browser token: each call is signed with the dock's secret. A wrong signature, a timestamp more than 5 minutes off or a repeated nonce gets 401; at most 60 calls a minute per dock.
- gonogo encrypts nothing: use HTTPS or a private network, or messages and roster cross as plain text.
- A docking code works once, for 15 minutes. It holds an address your server posts to when you pair, so pair only with a code you got from the person. Undock at once if a station you do not know appears.

## Clean Room and Docker

- **A Docker socket mounted into gonogo's container is root on the host** (`compose.yaml` does this for Clean Room). Every agent in that container can use it; see [Clean Room in the container](../guide/docker.md#clean-room-in-the-container).
- **A Clean Room limits what an agent can reach, not what it can spend.** The container sees the worktree, the agent's own folder (settings, token, notes) and the network, not your home, other projects or `~/.claude`. It holds your Claude credential, and in `bypassPermissions` it uses the network freely. If you bind `--host 0.0.0.0` so containers can connect, anyone who reaches the port can try the browser and agent endpoints; the tokens are then the only gate. Not tested with real Docker.
- **Seed mode trusts the folders you hire agents into**, so a repository's own `.claude/settings.json` hooks and permission rules run with your credential before any model turn. Add only repositories you trust.
  - Trust covers subfolders that are not git repositories (per Claude Code's docs), so gonogo refuses to record trust for `/` and for any folder that is or holds your home, gonogo's home or Claude Code's configuration folder: `cannot record folder trust for <folder>: ...` (the boss too).
  - Entries stay after an agent is removed. They are the `hasTrustDialogAccepted` keys under `projects` in `<CLAUDE_CONFIG_DIR>/.claude.json` (`~/.claude.json` if unset, `/state/claude/.claude.json` in the image); delete one to revoke it.

## Dependencies

The Docker image installs from the repository's `pnpm-lock.yaml` (the tested versions and checksums). The npm tarball has no lock file: `pnpm dlx` and `pnpm add -g` get the exact versions `package.json` pins for gonogo's own dependencies and resolve theirs at install time.

## Reverse proxy

[Exposing gonogo safely](../https.md) has the full guide: Caddy, nginx, which paths may be public (`/uplink/*` and `/dock/*` only), the token, and Tailscale. In short: serve gonogo at the root of a name, start it with `--allow-host gonogo.example.com`, and for nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:7777;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

- Without `Host $http_host` nginx sends the upstream address and every request fails the `Origin` check. Caddy's `reverse_proxy 127.0.0.1:7777` needs nothing else.
- The long timeout is for agent stops (up to 8 seconds) and terminal sockets (open for hours).
- To take Uplink webhooks from the internet without exposing the page, use a separate name that forwards `/uplink/` only ([Uplink](../features/uplink.md)).
- Do not log the `Sec-WebSocket-Protocol` header: it carries the browser token.
