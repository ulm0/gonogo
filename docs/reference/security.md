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
  - Per-agent keys (Clearance, for example `OPENAI_API_KEY`): `keys.json`. Write-only in the page, which gets the names and the time they were set. Never logged, never in a message, Downlink item, Relay post, answer or error, and never in `agents.json`. Each agent's process gets only its own keys; in a Clean Room they pass by name (`docker run -e NAME`), never on a command line. The agent itself can read its keys (`env`).
  - Payload env and header values (tokens, API keys): `agents.json` and the agent's `mcp.json`; the page receives them so Edit can show them. To keep one out, write `${NAME}` and Claude Code expands it from the agent's environment (gonogo's minus the scrubbed variables; from Claude Code's docs, not tried).
- A payload server is code or a service you chose; its tools run with the agent's permission mode.

## Mass Budget

REFLECT reads and copies one agent's `memory.md`; gonogo never writes that file. The agent name must match the name pattern and be an agent, so no path comes from the request. The file is opened without following a symbolic link and without waiting on a pipe, must be a regular file, and is read up to 1 MiB; `memory.md.bak` is written through a temporary file and a rename, so a link standing in its place is replaced, never written through. The routes need the browser token like every `/api` route. The text of the notes is never logged. An agent that runs as you can still put anything in its own folder.

## Uplink

**`POST /uplink/<id>` takes no browser token.** It needs that uplink's secret (a body signature, or the secret as a bearer token). At most 256 KiB and 30 a minute per uplink. Unknown and disabled uplinks both answer 404. The Host check applies; a request with an `Origin` header is refused. An agent reads a delivery as a message from you.

## Relief

`hire_agent` makes a request, never a hire: the agent is hired only after your GO, a call that takes the browser token (an agent's token, the boss's too, gets 401). A request cannot hold `auto` or `bypassPermissions`, a custom command, a payload or a Clean Room of its own; 3 may wait, 5 in 10 minutes, each 30 minutes. **The role text it carries is what the new agent obeys, and a boss that read untrusted text may write something you would not**: read the block before GO. A role with a character you could not see (zero width, a direction override, the Unicode tag block, a control code) is refused. A Clean Room boss hires only Clean Room agents inside its own folder.

## Party Line

No route, file or setting of its own: the page groups the messages it already holds, and an answer is the comm loop's `POST /api/messages` with the browser token. The page offers no box to a `name@station`, which the hub refuses from the Director. An agent chooses the `in_reply_to` of its messages and the hub checks only its shape, so the page follows it only when the sender is one of the two ends of the message it names (or the Director): an agent cannot write itself into a conversation of others and take the default place of the answer.

## Plot Board and Black Box

- **Plot Board:** `PUT /api/board` takes the browser token; `board_write` takes the boss's agent token and the server asks the hub who the boss is at each call, so any other agent is refused. Every agent reads the plan like mail, and `board.md` is plain text (mode 0600): keep secrets out.
- **Black Box:** records names, ids and counts, never a message body, a title or a secret. git runs without a shell, with a 10 second limit, an environment of the server's `PATH` and a few `GIT_*` settings of its own (none of the process's `GIT_*` variables, none of your git config) and hooks, signing and fsmonitor off even when the repository's config asks for them. A `black-box` folder that is a link is refused, and so is a link where a day's file goes. The record shows an edit, it cannot prevent one: an agent in `bypassPermissions` runs as you and can change the files or the history.

## Docking

**Dock only with people you trust: their agents can reach yours.**

- A docked station can message every agent of yours as `name@station`; your agent may act on it with the permissions you gave it. It can also create tasks assigned to your agents, and see your agents' names, roles and states. Agents are told to share only what a task needs; a prompt cannot enforce that.
- `/dock/*` takes no browser token: each call is signed with the dock's secret. A wrong signature, a timestamp more than 5 minutes off or a repeated nonce gets 401; at most 60 calls a minute per dock.
- gonogo encrypts nothing: use HTTPS or a private network, or messages and roster cross as plain text.
- A docking code works once, for 15 minutes. It holds an address your server posts to when you pair, so pair only with a code you got from the person. Undock at once if a station you do not know appears.

## Hangar and Recorder

- Only the browser token opens them. Hangar resolves every path with `realpath` and refuses `..`, an absolute path, a link that leads out, `.git` and gonogo's own folder; it writes only a text file you saved (1 MiB, refused if the file changed on disk) or a new one, and never deletes. An agent outside a Clean Room runs as you and can write these files itself: the checks guard the browser's requests, not the agent.
- Recorder runs git with an argument list, no prompt, hooks off, a time limit and an output cap, and commits only with the author of your own git config. The agent can write the repository's `.git/config`, which git reads: hooks, the file system monitor, the external diff and text conversion are off, a `filter` driver is not, nor the `gpg.program` of a repository that signs its commits. Read the status before you commit.

## Clean Room and Docker

- **A Docker socket mounted into gonogo's container is root on the host** (`compose.yaml` does this for Clean Room). Every agent in that container can use it; see [Clean Room in the container](../guide/docker.md#clean-room-in-the-container).
- **A Clean Room limits what an agent can reach, not what it can spend.** The container sees the worktree, the agent's own folder (settings, token, notes) and the network, not your home, other projects or `~/.claude`. It holds your Claude credential, and in `bypassPermissions` it uses the network freely. If you bind `--host 0.0.0.0` so containers can connect, anyone who reaches the port can try the browser and agent endpoints; the tokens are then the only gate. Not tested with real Docker.
- **Seed mode trusts the folders you hire agents into**, so a repository's own `.claude/settings.json` hooks and permission rules run with your credential before any model turn. Add only repositories you trust.
  - Trust covers subfolders that are not git repositories (per Claude Code's docs), so gonogo refuses to record trust for `/` and for any folder that is or holds your home, gonogo's home or Claude Code's configuration folder: `cannot record folder trust for <folder>: ...` (the boss too).
  - Entries stay after an agent is removed. They are the `hasTrustDialogAccepted` keys under `projects` in `<CLAUDE_CONFIG_DIR>/.claude.json` (`~/.claude.json` if unset, `/state/claude/.claude.json` in the image); delete one to revoke it.

## Engine checks and the update check

- **Live reload** (`--pty-host`) puts the agents' terminals in a separate process reached over a unix socket in `<home>/run` (folder 0700, socket and key 0600, key checked in constant time). The socket and the key belong to your user, so **any agent that does not run in a Clean Room can read the key and connect**: it could type into other agents. That fits "agents run as you", but it is a reason to keep the option off when you do not need it. A hold or trip is saved in `run/hub-state.json` and a reload is refused when it cannot be saved ([Live reload](../features/live-reload.md)).
- **Rooms** (`gonogo` is the supervisor, one process per room) run one gonogo per room behind one port. The supervisor's own write routes (`POST`, `PATCH`, `DELETE` on `/api/rooms`) take the Director token only, a JSON body of at most 4 KB and an Origin of its own address. The processes do not share memory, tokens or tools, but they run as one OS user, so **an agent outside a Clean Room can read the files of every room**. The proxy at `/r/<id>/` swaps the Director token for the room's own, drops cookies and `X-Forwarded-*`, and refuses `/hook/` and `/mcp` ([Rooms](../features/rooms.md)). The Director token is `<home>/token` (0600; a room never reads it and has its own, `run/room-token`, new at every start), in main's home, so an agent of room main outside a Clean Room can read it, and with it open every room.
- **Pad Check** (`gonogo doctor`, `GET /api/engines`, the hire form) runs `<program> --version` for each engine found on the `PATH`: no shell, 5 seconds, an environment of `PATH`, `HOME`, `LANG` and `NO_COLOR` only. It is the same program gonogo would start for an agent. It never runs an installer; the install commands are text from each vendor's page.
- **Update from the page** (`POST /api/update`) is the one place gonogo runs an installer: `npm install -g @ulm0/gonogo@x.y.z` or `pnpm add -g ...`, only for the version the registry check found and the page repeated, only after the Director's click, with no shell and a small environment ([Update from the page](../features/update.md)). In a container with the Docker socket, Update starts a helper container that recreates gonogo from the new image: the new image's code runs with the socket (root on the host) at once, so **trusting an update is trusting the image's publisher**, as with `docker compose pull`; the pull is refused unless the image's version label is the version you clicked, and the helper touches only the one container it was started for. The update hook (`GONOGO_UPDATE_HOOK`, `GONOGO_UPDATE_HOOK_TOKEN`) is removed from every agent's environment, but an agent that runs without a Clean Room and with `bypassPermissions` can still read the server's environment from `/proc/<pid>/environ`, as it can read any file of your user: set the hook only when you accept that.
- **Rollout** makes one GET a day to `registry.npmjs.org` for the `latest` version of `@ulm0/gonogo`. It sends an `Accept` header and nothing about you or the machine, reads at most 256 KiB, accepts only a stable `x.y.z`, and installs nothing. Off with `GONOGO_UPDATE_CHECK=0` or `--no-update-check` ([Rollout](../features/rollout.md)).

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
