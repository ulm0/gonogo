---
description: "Run gonogo from the official Docker image: compose file, the data folder, running as user node, and how an update replaces the container."
---

# Running in Docker

The image runs gonogo as user `node` (uid 1000, so `bypassPermissions` works: it refuses root) on Debian bookworm, with git, tini, `gh`, the Docker CLI client with its buildx plugin (BuildKit), Claude Code 2.1.325, pi 1.6.0, opencode 2.4.1 (the package `@opencode/cli`) and gonogo. Build arguments `CLAUDE_CODE_VERSION`, `PI_VERSION` and `OPENCODE_VERSION` pick other releases.

<DockerRunMock class="doc-mock" />

Build from a clone (the `Dockerfile` is not in the npm package) and run:

```
docker build -t gonogo:0.1.0 .
docker run -d --name gonogo --init -p 127.0.0.1:7777:7777 -e CLAUDE_CODE_OAUTH_TOKEN \
  -v gonogo-state:/state -v gonogo-home:/home/node -v gonogo-projects:/projects gonogo:0.1.0
docker logs gonogo
```

`docker logs` shows the `gonogo ready:` URL and the setup token ([first run](./getting-started.md#first-run)). **Anyone who can read the log can set up or open gonogo and run agents as you**: if logs are collected, keep them out (`docker run --log-driver none` keeps none at all). On an install without an account the URL holds the browser token; it never rotates on its own. Read it from the volume, or rotate it (the old URL stops working):

```
echo "http://127.0.0.1:7777/#token=$(docker exec gonogo cat /state/gonogo/token)"
docker exec gonogo rm /state/gonogo/token && docker restart gonogo
```

Set one credential: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`; `-e NAME` forwards it from your shell. Both set: the API key wins, with a warning.

| Topic | What to know |
|---|---|
| Port | Binds `0.0.0.0` inside but prints `127.0.0.1:7777`; with `-p 127.0.0.1:8080:7777` open it with `8080` |
| Environment, command, health check, stopping, pinning the base image | [Configuration](../reference/configuration.md#in-the-docker-image) |
| Seed mode, who runs as whom, `docker exec` | [Security](../reference/security.md#the-docker-image). Use `docker exec -u node ...` for `gh auth login` |
| Update | With the socket mounted (compose does) and a moving tag, Update pulls and recreates the container with a health check, rollback and UNDO; otherwise the page shows `docker compose pull && docker compose up -d`, or calls `GONOGO_UPDATE_HOOK` ([Update](../features/update.md#in-a-container-update-recreates-gonogo-itself)) |
| Rooms | One front port, one process per room ([Rooms](../features/rooms.md)); `docker compose exec gonogo gonogo rooms add <id>`. `gonogo reload` is refused in Docker |
| Reaching it by a name | gonogo answers only `127.0.0.1` and `localhost` until you allow a name: **"forbidden host"** in the browser means that. With `compose.yaml`, put `GONOGO_ALLOWED_HOSTS=<name>[,<name>]` in the `.env` next to it and run `docker compose up -d` (it forwards that, `GONOGO_PUBLIC_URL`, `GONOGO_TRUSTED_PROXY`, `GONOGO_CLIENT_IP_HEADER`, `GONOGO_MAX_WORKING`, `GONOGO_LOG_LEVEL`, `GONOGO_STATION` and `GONOGO_UPDATE_CHECK` from your shell or `.env`; one you do not set stays unset). With `docker run`: `-e GONOGO_ALLOWED_HOSTS=<name>`. A page that is reachable beyond this machine wants the login account first ([Exposing it safely](../https.md)) |

## Volumes

- `/state`: gonogo's home and Claude Code's configuration and sessions.
- `/home/node`: HOME. gh login, `~/.gitconfig`, `~/.aws` and other dotfiles survive a new container only if this is a volume. To keep yours, copy `~/.config/gh`, `~/.aws`, `~/.gitconfig` into `gonogo-data/home` before the first `docker compose up`, owned by uid 1000 (compose from 0.5.x: `gonogo-data/config/gh` goes to `gonogo-data/home/.config/gh`, `config/gitconfig` to `home/.gitconfig`).
- `/projects`: the boss's directory and your projects. A host folder must belong to uid 1000 or agents cannot write there:

  ```
  mkdir projects && sudo chown 1000:1000 projects
  docker run ... -v "$PWD/projects":/projects ...
  ```

  Not `--user $(id -u):$(id -g)` (`/state` and HOME become unwritable). gonogo warns at start when the home or boss directory is not writable. Git refuses a repository owned by another uid (`dubious ownership`) except one mounted at `/projects` itself.

## Clean Room in the container

`compose.yaml` runs gonogo with the host's Docker socket mounted, so Clean Room consoles start on the host's Docker.

::: danger
**The mounted socket gives the gonogo container root over the host.** Any agent in it, Clean Room or not, can start a container that mounts the host's `/`, in `bypassPermissions` without asking. Use it only where you would let those agents run as root.
:::

```
export CLAUDE_CODE_OAUTH_TOKEN=...     # or ANTHROPIC_API_KEY, never both
docker compose up -d                   # pulls ghcr.io/ulm0/gonogo:latest (amd64, arm64), restart: always
docker compose logs gonogo
```

Update: `docker compose pull && docker compose up -d` (own build: tag it `ghcr.io/ulm0/gonogo:latest` first). The data folder is `./gonogo-data` next to `compose.yaml` unless `GONOGO_DATA` says another (an absolute path); compose run from a UI with no working directory stops and asks for it. The port is published on every interface (`GONOGO_HOST=127.0.0.1` in `.env` keeps it on this machine). Paths, network and socket details: [Clean Room](../features/clean-room.md#gonogo-in-a-container-compose).

## Reaching it from another device

Open `http://<the address of this computer>:7777` from any device on your network: the addresses of a home or office network (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`), link-local ones and the CGNAT ones that Tailscale gives need no configuration. A name (`gonogo.lan`, a name behind a proxy) and a public IP address must be listed in `GONOGO_ALLOWED_HOSTS`; without it the answer is a 403 that says so, so that `docker compose up -d` on a server never serves the page to the internet by its address. An address is safe to accept because a page of another site can only reach gonogo by a name (the DNS rebinding the Host check is for); the login and its rules by the kind of address still apply.

**On a LAN, set up the account first** (the page asks, on the first visit). For anything wider than your own network, use a name with https: plain http sends the password and the token in the clear, and the page says so on a private address.
