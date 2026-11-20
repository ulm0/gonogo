# Running in Docker

The image runs gonogo as user `node` (uid 1000) on Debian bookworm with git, tini, `gh`, the Docker CLI client, Claude Code 2.1.325 (`--build-arg CLAUDE_CODE_VERSION=<x.y.z>`) and gonogo.

<DockerRunMock class="doc-mock" />

Build from a clone (the `Dockerfile` is not in the npm package) and run:

```
docker build -t gonogo:0.1.0 .
docker run -d --name gonogo --init -p 127.0.0.1:7777:7777 -e CLAUDE_CODE_OAUTH_TOKEN \
  -v gonogo-state:/state -v gonogo-home:/home/node -v gonogo-projects:/projects gonogo:0.1.0
docker logs gonogo
```

`docker logs` shows the `gonogo ready:` URL. **The URL holds the browser token: anyone who can read the log can run agents as you.** If the log is collected anywhere, build the URL from the volume (`docker run --log-driver none` keeps no log at all):

```
echo "http://127.0.0.1:7777/#token=$(docker exec gonogo cat /state/gonogo/token)"
```

Rotate the token: `docker exec gonogo rm /state/gonogo/token`, then `docker restart gonogo`.

Set one credential: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`. `-e NAME` without a value forwards it from your shell. Both set: the API key wins, with a warning.

## Image details

| Topic | What to know |
|---|---|
| Base | `node:24-bookworm-slim` floats; pin with `--build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<digest>`. Dependencies come from `pnpm-lock.yaml` |
| Health check | Every 30 s, `GET /rooms/health` inside the container (503 until room main was ready once, then 200 while gonogo runs). Fixed to port 7777: with another `--port`, give a matching `--health-cmd` (compose `healthcheck:`) or it is always `unhealthy` and **every self-update rolls back** |
| Port | Binds `0.0.0.0` inside but prints `127.0.0.1:7777`; with `-p 127.0.0.1:8080:7777` open it with `8080` |
| Environment | `GONOGO_INSTALL=docker`, `HOME=/home/node`, `CLAUDE_CONFIG_DIR=/state/claude`, `GONOGO_HOME=/state/gonogo`, `GONOGO_SEED_CLAUDE=1`, `DISABLE_AUTOUPDATER=1`, `LANG=C.UTF-8` |
| Command | `gonogo --host 0.0.0.0 --port 7777`. Every [option](../reference/configuration.md#options) works as `-e GONOGO_ALLOWED_HOSTS=...` or as arguments after the image name (they replace the whole command: repeat `--host 0.0.0.0 --port 7777`) |
| Stopping | Agents stop within 8 s, gonogo gives up at 12 (Docker's default is 10): `docker stop -t 15` or more; compose `stop_grace_period: 60s` |
| Docker CLI | Client only (`--build-arg DOCKER_CLI_IMAGE=...`), for Clean Room. No daemon |
| Update | With the socket mounted (compose does) and a moving tag, the Update button pulls and recreates the container with a health check, rollback and UNDO. With a pinned tag or no socket the page shows `docker compose pull && docker compose up -d`, or calls `GONOGO_UPDATE_HOOK` ([Update](../features/update.md#in-a-container-update-recreates-gonogo-itself)) |

### Volumes

- `/state`: gonogo's home and Claude Code's configuration and sessions.
- `/home/node`: HOME (gh login, `~/.gitconfig`, `~/.aws`, every dotfile survive a new container only if this is a volume). On a new, empty home the container copies `/etc/skel`, never over an existing file. To keep what you have, copy `~/.config/gh`, `~/.aws`, `~/.gitconfig` into `gonogo-data/home` before the first `docker compose up`, owned by uid 1000 (from compose 0.5.x: `gonogo-data/config/gh` goes to `gonogo-data/home/.config/gh`, `gonogo-data/config/gitconfig` to `gonogo-data/home/.gitconfig`).
- `/projects`: the boss's directory and your projects. A host folder must belong to uid 1000 or agents cannot write there:

  ```
  mkdir projects && sudo chown 1000:1000 projects
  docker run ... -v "$PWD/projects":/projects ...
  ```

  Not `--user $(id -u):$(id -g)` (`/state` and HOME become unwritable). gonogo warns at start when the home or boss directory is not writable. Git refuses a repository owned by another uid (`dubious ownership`) except one mounted at `/projects` itself, so `chown` what you mount.

### Seed mode (on)

Without it a fresh container stops at five Claude Code dialogs (theme, login method, folder trust, bypass warning, API key). Seed mode:

- records folder trust for every folder an agent is hired into, except `/`, your home directory and folders holding either or the state ([Security](../reference/security.md)). **Add only repositories you trust.**
- sets `IS_DEMO=1` for each `claude` (hides account name and organisation in its header and `/status`);
- moves `ANTHROPIC_API_KEY` out of the agent's environment into an `apiKeyHelper`.

## Rooms in the container

`gonogo` is the supervisor: one front port (7777), one process per room ([Rooms](../features/rooms.md)). Add rooms at `/rooms` or with `docker compose exec gonogo gonogo rooms add <id>`. Every room stops its agents within 12 s, in parallel; the supervisor waits 17 before it kills one. Clean Room, Update and the health check work; `gonogo reload` is refused in Docker.

## Who runs as whom

The container starts as root; the server and agents run as uid 1000. At start the entrypoint gives uid 1000 the top (never recursively, never through a symlink) of `$HOME`, the folder above `$GONOGO_HOME`, `$CLAUDE_CONFIG_DIR` and the working directory, but only those that are root-owned mount points (a folder Docker created as `root:root`, as ZimaOS or Portainer do), and logs it. Root-owned regular files and folders in `/home/node` go to uid 1000 too.

- `--user 1000:1000` (or compose `user:`) skips this: nothing is chowned; an unwritable home gets a warning with the `chown`.
- **`docker exec` starts as root.** `gonogo` drops to uid 1000 itself; for `gh auth login` or anything writing in the home use `docker exec -u node ...`, or the files are root's.

## Clean Room in the container

`compose.yaml` mounts the host's Docker socket, so a Clean Room console starts its container on the host's Docker (not Docker in Docker).

::: danger
**The mounted socket gives the gonogo container root over the host.** Any agent in it, Clean Room or not, can start a container that mounts the host's `/`, in `bypassPermissions` without asking. Use it only where you would let those agents run as root.
:::

```
sudo install -d -o 1000 -g 1000 gonogo-data gonogo-data/projects gonogo-data/home   # next to compose.yaml
printf 'GONOGO_DATA=%s\nDOCKER_GID=%s\n' "$PWD/gonogo-data" "$(stat -L -c %g /var/run/docker.sock)" > .env
export CLAUDE_CODE_OAUTH_TOKEN=...     # or ANTHROPIC_API_KEY, never both
docker compose up -d                   # pulls ghcr.io/ulm0/gonogo:latest (amd64, arm64), restart: always
docker compose logs gonogo
```

- `GONOGO_DATA` (absolute path, no default) is required: **every** compose command stops with "set GONOGO_DATA to the absolute path of the data folder" without it. Without a shell (ZimaOS, Portainer, Dockge) put the two lines in the stack's environment, with a host path that exists.
- Update: `docker compose pull && docker compose up -d` (own build: tag it `ghcr.io/ulm0/gonogo:latest` first). Second instance: `GONOGO_PORT=7778 GONOGO_DATA=$PWD/gonogo-data-2 docker compose -p gonogo-2 up -d`.
- **Same paths.** The host's Docker resolves `-v` paths on the host, so the data folder (`state/`, `claude/`, `projects/`) is mounted at its own path. It must belong to uid 1000 and its path must not contain a colon, or each Clean Room start refuses with `gonogo's home ... is not mounted into the container ... from the same path of the host`. "The host" is where the daemon runs (a Lima or Docker Desktop VM counts).
- **Network.** `GONOGO_CLEANROOM_NETWORK=container:self` starts each Clean Room with `--network container:<gonogo's container>` (`container:<name>` names it), sharing its network and hosts file. `extra_hosts` maps `host.docker.internal` to `127.0.0.1` (accepted for the hook and tool endpoints only; a start refuses if it does not resolve so). **A Clean Room on this network reaches any port the container listens on, including a loopback server another agent started.** Recreating the gonogo container breaks it: restart the console. Other networks are refused.
- **The socket.** `group_add` gives the user the socket's group; `DOCKER_GID` is required (differs by host). Docker Desktop may need another value or `0` (not tried).
- The image's `/state` and `/projects` volumes are unused here (`docker compose down -v` removes the two empty ones Docker makes). The default Clean Room image is `ghcr.io/ulm0/gonogo`.
