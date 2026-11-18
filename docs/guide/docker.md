# Running in Docker

The image is Debian bookworm (glibc), runs as the user `node` (uid 1000, because `bypassPermissions` refuses root), and holds git, tini, a pinned Claude Code (2.1.325; `--build-arg CLAUDE_CODE_VERSION=<x.y.z>` changes it) and gonogo from the same tarball `pnpm dlx` would use.

Build it from a clone of the repository (the `Dockerfile` is not in the package tarball), then run it:

```
docker build -t gonogo:0.1.0 .
docker run -d --name gonogo --init -p 127.0.0.1:7777:7777 -e CLAUDE_CODE_OAUTH_TOKEN \
  -v gonogo-state:/state -v gonogo-projects:/projects gonogo:0.1.0
docker logs gonogo
```

`docker logs` shows the `gonogo ready:` line with the URL, and **the URL holds the browser token**. Whoever can read the container log (a log shipper, a shared logging stack, a support bundle) can open the UI, hire agents in `bypassPermissions` and type into every terminal. The token never rotates: it stays valid until `/state/gonogo/token` is deleted. If the log is collected anywhere, build the URL from the volume instead of the log:

```
echo "http://127.0.0.1:7777/#token=$(docker exec gonogo cat /state/gonogo/token)"
```

and keep the log out of the collector (`docker run --log-driver none` keeps none, the error lines of the server included). To rotate the token, run `docker exec gonogo rm /state/gonogo/token` and then `docker restart gonogo`: the old URL stops working.

Set one credential, never both: `CLAUDE_CODE_OAUTH_TOKEN` (make one with `claude setup-token`) or `ANTHROPIC_API_KEY`. `-e NAME` without a value forwards the variable from your shell, so the secret is not typed into the command. If both are set the API key is used and gonogo logs a warning.

- The base image is `node:24-bookworm-slim`, a floating tag: a rebuild can bring a newer Node and a newer Debian. To pin it, build with `--build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<digest>` (`docker pull node:24-bookworm-slim` prints the digest). Claude Code is pinned by `CLAUDE_CODE_VERSION`, and gonogo's dependencies by the repository's `pnpm-lock.yaml`: the build installs the tarball's production dependencies from it (`--prod --frozen-lockfile`), so the image carries the tested versions and no devDependency.
- The image has a `HEALTHCHECK`: every 30 seconds it fetches `http://127.0.0.1:7777/` inside the container, a page that needs no token, and `docker ps` shows `healthy` once it answers 200. If you change the port with arguments after the image name, give `docker run` a matching `--health-cmd`.
- The server binds `0.0.0.0` inside the container and prints `127.0.0.1`. That is right when the host port is also 7777. With `-p 127.0.0.1:8080:7777` open the printed URL with `8080` in place of `7777`.
- `/state` holds gonogo's home and Claude Code's own configuration and sessions. `/projects` is the boss's working directory and where your projects go. Named volumes copy the image's ownership (uid 1000) on first use.
- To use a folder of the host for `/projects`, it must belong to uid 1000, or the boss and every agent cannot write there (the only symptom is Claude errors in a terminal). On Linux a missing folder is created by Docker as `root:root`, so:

  ```
  mkdir projects && sudo chown 1000:1000 projects
  docker run ... -v "$PWD/projects":/projects ...
  ```

  `--user $(id -u):$(id -g)` is not the fix: `/state` and `HOME=/home/node` would become unwritable. gonogo logs a warning at start when the home or the boss's directory is not writable. Git in the image refuses a repository owned by another uid (`dubious ownership`) except one mounted right at `/projects`: its `safe.directory` entries are `/projects` and `/projects/*`, but the git of Debian bookworm (2.39) does not read the second form, so `chown` what you mount.
- Seed mode is on in the image. In a fresh container Claude Code would stop at five dialogs (theme, login method, folder trust, bypass warning, API key), each defaulting to "No". Seed mode records folder trust for every folder an agent is hired into (not for `/`, for your home directory, or for a folder that holds either of them or the state; see [Security](../reference/security.md)), gives each `claude` `IS_DEMO=1`, and moves `ANTHROPIC_API_KEY` out of the agent's environment into an `apiKeyHelper`. The price: `IS_DEMO=1` hides your account name and organisation in Claude's header and in `/status`. The warning of the Security section applies in full: seed mode trusts every folder you hire an agent into, so add only repositories you trust.
- The image sets `HOME=/home/node`, `CLAUDE_CONFIG_DIR=/state/claude`, `GONOGO_HOME=/state/gonogo`, `GONOGO_SEED_CLAUDE=1`, `DISABLE_AUTOUPDATER=1` and `LANG=C.UTF-8`; its command is `gonogo --host 0.0.0.0 --port 7777`. Any option and variable of the [options table](../reference/configuration.md#options) works: `-e GONOGO_ALLOWED_HOSTS=gonogo.example.com`, or arguments after the image name (they replace the whole default command, so repeat `--host 0.0.0.0 --port 7777`).
- `docker stop` sends SIGTERM and gonogo stops its agents within 8 seconds and gives up on a stuck shutdown at 12, which is past Docker's default grace period of 10. Use `docker stop -t 15` or more.
- The image holds the docker CLI (only the client binary, copied from the pinned `docker:<version>-cli` image; `--build-arg DOCKER_CLI_IMAGE=...` changes it), for Clean Room below. It has no daemon.

## Clean Room in the container

`compose.yaml` at the root of the repository runs gonogo with the host's Docker socket mounted, so a Clean Room console starts its container on the host's Docker, next to gonogo's own (not Docker in Docker).

**Warning: the mounted socket gives the gonogo container root over the host.** Whoever can use the socket can start a container that mounts `/` of the host. That includes every agent in the gonogo container, also the ones that do not run in a Clean Room: an agent in `bypassPermissions` mode can do it without asking. Use this only on a machine where you would let those agents run as root.

```
sudo install -d -o 1000 -g 1000 gonogo-data gonogo-data/projects   # next to compose.yaml
export CLAUDE_CODE_OAUTH_TOKEN=...     # or ANTHROPIC_API_KEY, never both
export DOCKER_GID=$(stat -L -c %g /var/run/docker.sock)   # every compose command reads it
docker compose up -d                                       # pulls ghcr.io/ulm0/gonogo:latest
docker compose logs gonogo
```

`compose.yaml` runs the published image (amd64 and arm64) with `restart: always`. To update: `docker compose pull && docker compose up -d`. To run your own build instead, build it under the same name first: `docker build -t ghcr.io/ulm0/gonogo:latest .`.

A second instance on the same host: give it its own project name, port and data folder, for example `GONOGO_PORT=7778 GONOGO_DATA=$PWD/gonogo-data-2 docker compose -p gonogo-2 up -d` (make `gonogo-data-2` and its `projects/` as above). The compose file sets no `container_name`, and `GONOGO_CLEANROOM_NETWORK=container:self` finds each instance's own container.

- **Same paths.** The host's Docker reads the folders of `docker run -v` from its own file system, not from gonogo's container, so the worktree and the agent's folder (both under gonogo's home) must have the same path in the gonogo container as on the host. `compose.yaml` mounts one data folder at its own path (`GONOGO_DATA`, default `gonogo-data` next to `compose.yaml`, written as `${PWD}/gonogo-data` so the path is absolute and the same on both sides; run compose from that folder) and puts gonogo's home (`state/`), Claude Code's configuration (`claude/`) and the projects (`projects/`, the boss's first working directory) in it. The folder must belong to uid 1000 and its path must not contain a colon. Each Clean Room start runs `docker inspect` on gonogo's container and refuses with `gonogo's home ... is not mounted into the container ... from the same path of the host` when the home is not under such a mount (a named volume, another host path, none). "The host" is wherever the Docker daemon runs: in a Lima or Docker Desktop VM that is the VM, and a folder made in another shell of it may not be the one the daemon sees.
- **Network.** `GONOGO_CLEANROOM_NETWORK=container:self` starts each Clean Room with `--network container:<gonogo's container>`, found by its host name (Docker sets it to the short container id unless `hostname` is set, so the compose file needs no `container_name`; `container:<name>` names it explicitly): it shares gonogo's network and hosts file. `extra_hosts` in `compose.yaml` makes `host.docker.internal` name `127.0.0.1` there, so the Clean Room reaches gonogo on loopback (Claude Code blocks hooks to private addresses, not to loopback) and still by that name, which the server accepts for the hook and tool endpoints only; each start refuses when the name does not lead to `127.0.0.1` in gonogo's container. A Clean Room on this network can also connect to any port gonogo's container listens on, including a loopback-only server started by an agent outside a Clean Room. It stops working when the gonogo container is recreated (restart the console). Other networks are refused: on them gonogo would only be reachable at a private address.
- **The socket.** `group_add` gives the container user the group of the socket; `DOCKER_GID` is required, because that group id differs between hosts. Docker Desktop's socket may need another value or `0`; not tried.
- The image's `/state` and `/projects` volumes are not used with this file (Docker still makes two empty anonymous volumes for them; `docker compose down -v` removes them). The default Clean Room image `ghcr.io/ulm0/gonogo` is the one compose builds.
