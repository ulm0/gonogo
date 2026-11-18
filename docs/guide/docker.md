# Running in Docker

The image is Debian bookworm, runs as user `node` (uid 1000; `bypassPermissions` refuses root), and holds git, tini, Claude Code 2.1.325 (`--build-arg CLAUDE_CODE_VERSION=<x.y.z>` changes it) and gonogo.

<DockerRunMock class="doc-mock" />

Build from a clone (the `Dockerfile` is not in the npm package), then run:

```
docker build -t gonogo:0.1.0 .
docker run -d --name gonogo --init -p 127.0.0.1:7777:7777 -e CLAUDE_CODE_OAUTH_TOKEN \
  -v gonogo-state:/state -v gonogo-projects:/projects gonogo:0.1.0
docker logs gonogo
```

`docker logs` shows the `gonogo ready:` line with the URL. **The URL holds the browser token**: anyone who can read the container log can open the UI and run agents as you. The token never rotates on its own. If the log is collected anywhere, build the URL from the volume instead and keep the log out of the collector (`docker run --log-driver none` keeps no log at all, server errors included):

```
echo "http://127.0.0.1:7777/#token=$(docker exec gonogo cat /state/gonogo/token)"
```

To rotate the token: `docker exec gonogo rm /state/gonogo/token`, then `docker restart gonogo`. The old URL stops working.

Set one credential, not both: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`. `-e NAME` without a value forwards it from your shell. If both are set, the API key wins and gonogo logs a warning.

## Image details

- **Base image** `node:24-bookworm-slim` is a floating tag. Pin it with `--build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<digest>` (`docker pull node:24-bookworm-slim` prints the digest). gonogo's dependencies come from the repository's `pnpm-lock.yaml` (`--prod --frozen-lockfile`).
- **Health check**: every 30 s it fetches `http://127.0.0.1:7777/` inside the container; `docker ps` shows `healthy` on a 200. The probe is fixed to port 7777: if you run with another `--port` or `GONOGO_PORT`, give the container a matching `--health-cmd` (compose: `healthcheck:`), or it is always `unhealthy` and **every Docker self-update rolls back** (the update waits for `healthy`).
- **Port**: the server binds `0.0.0.0` inside the container but prints `127.0.0.1:7777`. With `-p 127.0.0.1:8080:7777`, open the printed URL with `8080`.
- **Volumes**: `/state` holds gonogo's home and Claude Code's configuration and sessions. `/projects` is the boss's working directory and where your projects go. Named volumes take the image's ownership (uid 1000).
- **Host folder for `/projects`**: it must belong to uid 1000, or agents cannot write there (you only see Claude errors in a terminal). On Linux Docker creates a missing folder as `root:root`, so:

  ```
  mkdir projects && sudo chown 1000:1000 projects
  docker run ... -v "$PWD/projects":/projects ...
  ```

  Do not use `--user $(id -u):$(id -g)`: `/state` and `HOME=/home/node` become unwritable. gonogo warns at start when the home or the boss's directory is not writable. Git refuses a repository owned by another uid (`dubious ownership`) except one mounted at `/projects` itself (Debian's git 2.39 ignores the `/projects/*` entry), so `chown` what you mount.
- **Seed mode** is on. Without it a fresh container stops at five Claude Code dialogs (theme, login method, folder trust, bypass warning, API key). Seed mode:
  - records folder trust for every folder an agent is hired into, except `/`, your home directory and folders that hold either or the state ([Security](../reference/security.md)). **Add only repositories you trust.**
  - sets `IS_DEMO=1` for each `claude`, which hides your account name and organisation in Claude's header and `/status`;
  - moves `ANTHROPIC_API_KEY` out of the agent's environment into an `apiKeyHelper`.
- **gh and git**: the image has the `gh` CLI (pinned, checked against the release checksum). `gh auth login` inside the container keeps its login in `/state/config/gh`, and `git config --global` writes `/state/config/git/config`, so both survive a restart or a new container on the same `/state`. The home folder `/home/node` is not on a volume. The container creates `/state/config/git` at start, so a `/state` volume made by an older image needs nothing.
- **Update**: with the Docker socket mounted (the compose file does) and a moving tag, the Update button pulls the image and recreates the container itself, with a health check and a rollback, and UNDO puts the old image back. With a pinned tag or no socket the page shows `docker compose pull && docker compose up -d`, or calls `GONOGO_UPDATE_HOOK` ([Update from the page](../features/update.md#in-a-container-update-recreates-gonogo-itself)).
- **Environment**: `GONOGO_INSTALL=docker`, `HOME=/home/node`, `CLAUDE_CONFIG_DIR=/state/claude`, `XDG_CONFIG_HOME=/state/config`, `GIT_CONFIG_GLOBAL=/state/config/git/config`, `GONOGO_HOME=/state/gonogo`, `GONOGO_SEED_CLAUDE=1`, `DISABLE_AUTOUPDATER=1`, `LANG=C.UTF-8`. Command: `gonogo --host 0.0.0.0 --port 7777`. Every [option](../reference/configuration.md#options) works, as `-e GONOGO_ALLOWED_HOSTS=gonogo.example.com` or as arguments after the image name (these replace the whole command, so repeat `--host 0.0.0.0 --port 7777`).
- **Stopping**: gonogo stops its agents within 8 s and gives up at 12, past Docker's default 10. Use `docker stop -t 15` or more.
- **Docker CLI**: the client binary only (from `docker:<version>-cli`; `--build-arg DOCKER_CLI_IMAGE=...` changes it), for Clean Room. No daemon.

## Several rooms in the container

The image runs plain `gonogo`, which is **one room**: it never reads `rooms.json`, so `docker compose exec gonogo gonogo rooms add team` saves the room but nothing starts it (the command says so, and the server logs a line at start when the file lists rooms). To run rooms, give the service the rooms command in `compose.yaml`:

```yaml
services:
  gonogo:
    command: ["rooms", "--host", "0.0.0.0", "--port", "7777"]
    stop_grace_period: 60s   # each room stops its agents within 12 s; the supervisor waits 17
```

then add rooms from the list page at `/`, or with `docker compose exec gonogo gonogo rooms add <id>`. The container's healthcheck, the update button and the Clean Room all work on the container, not per room: the update dialog is not offered under rooms (see [Rooms](../features/rooms.md)).

## Clean Room in the container

`compose.yaml` at the repository root runs gonogo with the host's Docker socket mounted, so a Clean Room console starts its container on the host's Docker, next to gonogo's (not Docker in Docker).

::: danger
**The mounted socket gives the gonogo container root over the host.** Any agent in it, Clean Room or not, can start a container that mounts the host's `/`; in `bypassPermissions` mode without asking. Use this only where you would let those agents run as root.
:::

```
sudo install -d -o 1000 -g 1000 gonogo-data gonogo-data/projects   # next to compose.yaml
export CLAUDE_CODE_OAUTH_TOKEN=...     # or ANTHROPIC_API_KEY, never both
export DOCKER_GID=$(stat -L -c %g /var/run/docker.sock)   # every compose command reads it
docker compose up -d                                       # pulls ghcr.io/ulm0/gonogo:latest
docker compose logs gonogo
```

It runs the published image (amd64, arm64) with `restart: always`. Update: `docker compose pull && docker compose up -d`. To use your own build, tag it first: `docker build -t ghcr.io/ulm0/gonogo:latest .`.

Second instance on the same host: own project name, port and data folder, e.g. `GONOGO_PORT=7778 GONOGO_DATA=$PWD/gonogo-data-2 docker compose -p gonogo-2 up -d` (create `gonogo-data-2` and its `projects/` as above).

- **Same paths.** The host's Docker resolves `-v` paths on the host, so gonogo's home must have the same path inside gonogo's container as on the host. `compose.yaml` mounts one data folder at its own path (`GONOGO_DATA`, default `${PWD}/gonogo-data`; run compose from that folder) holding `state/`, `claude/` and `projects/`. It must belong to uid 1000 and its path must not contain a colon. Otherwise each Clean Room start refuses with `gonogo's home ... is not mounted into the container ... from the same path of the host`. "The host" is where the daemon runs: in a Lima or Docker Desktop VM, that is the VM.
- **Network.** `GONOGO_CLEANROOM_NETWORK=container:self` starts each Clean Room with `--network container:<gonogo's container>` (found by host name; `container:<name>` names it explicitly), sharing gonogo's network and hosts file. `extra_hosts` maps `host.docker.internal` to `127.0.0.1` there; the server accepts that name for the hook and tool endpoints only, and each start refuses if it does not resolve to `127.0.0.1`. A Clean Room on this network can reach any port gonogo's container listens on, including a loopback server started by another agent. Recreating the gonogo container breaks it (restart the console). Other networks are refused.
- **The socket.** `group_add` gives the container user the socket's group; `DOCKER_GID` is required because it differs between hosts. Docker Desktop may need another value or `0` (not tried).
- The image's `/state` and `/projects` volumes are unused here (Docker still makes two empty anonymous volumes; `docker compose down -v` removes them). The default Clean Room image is `ghcr.io/ulm0/gonogo`.
