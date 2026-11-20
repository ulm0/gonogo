# Security

<GatesMock class="doc-mock" />

## Network and tokens

- gonogo listens on `127.0.0.1` unless you pass `--host`. No TLS: to reach it from elsewhere, see [Reverse proxy](#reverse-proxy).
- Every `/api` call and the `/ws` WebSocket need a login: a session cookie, an API key, or the local unix socket (`<home>/run/api.sock`). Until an account exists, the old browser token does it; **once one has been made the token is deleted and never comes back** ([Login](../features/login.md)). The built client files need nothing; they hold no state. **A signed-in session can run anything on this machine.**
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
- Room keys (`room-keys.json`, 0600, plain text) are environment variables for every agent of the room: values are never sent to the page or logged, a change is step-up and audited by name, and a Clean Room agent gets only the keys marked for it, by name on the `docker run` line. A console outside a Clean Room runs as the same OS user as gonogo and can read the file, as it can read `keys.json`.
- A payload server is code or a service you chose; its tools run with the agent's permission mode.
  - The room's Payload defaults (`payload-defaults.json`, 0600, plain text) are servers started by every agent outside a Clean Room, so changing them asks for the password again and the Black Box notes the name. The page is never sent a value, an argument or a url's query, only names and counts. **A Clean Room agent gets none of them** (their env and headers hold keys), so a default cannot widen what a Clean Room agent runs or can read. An agent outside a Clean Room can read the file.
  - A console that is not in a Clean Room runs as the same OS user as gonogo, so it can edit `<home>/payload-defaults.json` directly, and the next start of every agent then runs the servers listed there. The same holds for `permissions.json` and the other room files. Clean Room is the boundary: a Clean Room agent gets none of the room's defaults.

## Mass Budget

REFLECT only reads and copies one agent's `memory.md` and never writes it. The agent name must match the name pattern and be an agent, so no path comes from the request. The file is opened without following a link and without waiting on a pipe, must be a regular file, and is read up to 1 MiB; `memory.md.bak` goes through a temporary file and a rename, so a link in its place is replaced, never written through. The route needs the browser token; the notes are never logged. An agent that runs as you can still put anything in its own folder.

## Uplink

**`POST /uplink/<id>` takes no browser token.** It needs that uplink's secret (a body signature, or the secret as a bearer token). At most 256 KiB and 30 a minute per uplink. Unknown and disabled uplinks both answer 404. The Host check applies; a request with an `Origin` header is refused. An agent reads a delivery as a message from you.

## Relief

`hire_agent` makes a request, never a hire: the agent is hired only after your GO, a call that takes the browser token (an agent's token, the boss's too, gets 401). A request cannot hold `auto` or `bypassPermissions`, a custom command, a payload or a Clean Room of its own; 3 may wait, 5 in 10 minutes, each 30 minutes. **The role text it carries is what the new agent obeys, and a boss that read untrusted text may write something you would not**: read the block before GO. A role with a character you could not see (zero width, a direction override, the Unicode tag block, a control code) is refused. A Clean Room boss hires only Clean Room agents inside its own folder.

## Party Line

No route or setting of its own: it groups messages the hub holds; an answer is `POST /api/messages` with the browser token, and the Director cannot write to a `name@station`. An agent picks the `in_reply_to` of its messages, so the page follows it only when the sender is one of the two ends of the message named (or the Director): an agent cannot write itself into others' conversations.

## Plot Board and Black Box

- **Plot Board:** `PUT /api/board` takes the browser token; `board_write` takes the boss's agent token and the server asks the hub who the boss is at each call, so any other agent is refused. Every agent reads the plan like mail, and `board.md` is plain text (mode 0600): keep secrets out.
- **Black Box:** records names, ids and counts, never a body, title or secret. git runs without a shell, 10 s limit, no `GIT_*` variables or git config of yours, hooks, signing and fsmonitor off; a link in place of the folder or a day file is refused. It shows an edit, it cannot prevent one: an agent in `bypassPermissions` runs as you and can change the files or history.

## Docking

**Dock only with people you trust: their agents can reach yours.**

- A docked station can message every agent of yours as `name@station`; your agent may act on it with the permissions you gave it. It can also create tasks assigned to your agents, and see your agents' names, roles and states. Agents are told to share only what a task needs; a prompt cannot enforce that.
- `/dock/*` takes no browser token: each call is signed with the dock's secret. A wrong signature, a timestamp more than 5 minutes off or a repeated nonce gets 401; at most 60 calls a minute per dock.
- gonogo encrypts nothing: use HTTPS or a private network, or messages and roster cross as plain text.
- A docking code works once, for 15 minutes. It holds an address your server posts to when you pair, so pair only with a code you got from the person. Undock at once if a station you do not know appears.

## Hangar and Recorder

- Only the browser token opens them. Hangar resolves paths with `realpath` and refuses `..`, absolute paths, links that leave, `.git` and gonogo's folder; it writes only a text file you saved (1 MiB, refused if it changed on disk) or a new one, and never deletes. An agent outside a Clean Room runs as you and can write these files itself: the checks guard the browser's requests, not the agent.
- Recorder runs git with an argument list, no prompt, hooks off, a time limit and an output cap, and commits as your own git author. The agent can write the repository's `.git/config`: hooks, fsmonitor, external diff and text conversion are off, but a `filter` driver and the `gpg.program` of a signing repository are not. Read the status before you commit.

## Clean Room and Docker

- **A Docker socket mounted into gonogo's container is root on the host** (`compose.yaml` does this for Clean Room). Every agent in that container can use it; see [Clean Room in the container](../guide/docker.md#clean-room-in-the-container).
- **A Clean Room limits what an agent can reach, not what it can spend.** The container sees the worktree, the agent's own folder (settings, token, notes) and the network, not your home, other projects or `~/.claude`. It holds your Claude credential, and in `bypassPermissions` it uses the network freely. If you bind `--host 0.0.0.0` so containers can connect, anyone who reaches the port can try the browser and agent endpoints; the tokens are then the only gate. Not tested with real Docker.
- **Seed mode trusts the folders you hire agents into**, so a repository's own `.claude/settings.json` hooks and permission rules run with your credential before any model turn. Add only repositories you trust.
  - Trust covers subfolders that are not git repositories (per Claude Code's docs), so gonogo refuses to record trust for `/` and for any folder that is or holds your home, gonogo's home or Claude Code's configuration folder: `cannot record folder trust for <folder>: ...` (the boss too).
  - Entries stay after an agent is removed. They are the `hasTrustDialogAccepted` keys under `projects` in `<CLAUDE_CONFIG_DIR>/.claude.json` (`~/.claude.json` if unset, `/state/claude/.claude.json` in the image); delete one to revoke it.

## Engine checks and the update check

- **Live reload** (`--pty-host`) puts the terminals in a separate process behind a unix socket in `<home>/run` (0700; socket and key 0600). **Any agent outside a Clean Room can read the key and connect, and type into other agents**: keep it off unless you need it. A hold or trip is saved in `run/hub-state.json`; a reload is refused when it cannot be saved ([Live reload](../features/live-reload.md)).
- **Rooms** (`gonogo` supervisor, one process per room): the write routes `/api/rooms` take the Director token only, a body of at most 4 KB and an own-address Origin. Rooms share no memory, tokens or tools, but run as one OS user, so **an agent outside a Clean Room can read the files of every room**. The proxy at `/r/<id>/` asks the login who is calling, reaches the room over its unix socket, drops cookies and `X-Forwarded-*`, and refuses `/hook/` and `/mcp` ([Rooms](../features/rooms.md)). On a fresh install the Director token is `<home>/token` in main's home: an agent of main outside a Clean Room can read it and open every room; with an account it can still write `auth.json`, which the tamper alarm only makes loud ([Login](../features/login.md)).
- **Push to the installed app** ([phone app](../features/mobile.md)): the server posts to an address a login supplies, checked when stored and at every send: `https`, standard port, no credentials, a host on the browser vendors' list (`PUSH_HOSTS`, `src/server/push.ts`); no redirect, the answer is not shown, so a session cannot make gonogo post to `127.0.0.1` or the LAN. A device goes when its session ends. The supervisor keeps the VAPID key and devices in `push.json` (0600) next to `auth.json`, so **an agent outside a Clean Room can read the private key and send a push of any text to your phones** (a fake "an agent needs you"); it cannot read what gonogo sends (encrypted). The default payload is generic; sender and first words are each device's opt-in.
- **Pad Check** (`gonogo doctor`, `GET /api/engines`, the hire form) runs `<program> --version` for each engine found: no shell, 5 s, an environment of `PATH`, `HOME`, `LANG`, `NO_COLOR`. It never runs an installer; the install commands are text from each vendor's page.
- **Update from the page** (`POST /api/update`) is the one place gonogo runs an installer: `npm install -g @ulm0/gonogo@x.y.z` or `pnpm add -g ...`, only for the version the registry check found, after your click, no shell, small environment ([Update](../features/update.md)). In a container with the Docker socket, Update starts a helper that recreates gonogo from the new image, whose code then runs with the socket (root on the host): **trusting an update is trusting the image's publisher**. The pull is refused unless the image's version label is the version you clicked; the helper touches only its own container. `GONOGO_UPDATE_HOOK` and `GONOGO_UPDATE_HOOK_TOKEN` are removed from agents' environments, but an agent outside a Clean Room in `bypassPermissions` can still read them from `/proc/<pid>/environ`: set the hook only if you accept that.
- **Rollout** makes one GET a day to `registry.npmjs.org` for the `latest` version: no data about you, at most 256 KiB read, only a stable `x.y.z`, installs nothing. Off with `GONOGO_UPDATE_CHECK=0` or `--no-update-check` ([Rollout](../features/rollout.md)).

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
