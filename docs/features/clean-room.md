# Clean Room: a sandbox per agent

<CleanRoomMock class="doc-mock" />

The `Clean Room` box of the hire and edit form (Claude Code agents only) runs the agent in a Docker container that holds
a copy of the project and the agent's own files, nothing else of your machine. Design and limits:
[`docs/clean-room-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/clean-room-spec.md). It was tested against
real Docker with the stand-in agent, and since 0.2.0 by RSO and SIMSUP, real Claude Code consoles of the room that builds gonogo
([What was not verified](../reference/not-verified.md)).

- **Needs.** Docker running (`docker version` succeeds), an image with Claude Code (`docker build -t ghcr.io/ulm0/gonogo .`
  from a clone builds the default; `GONOGO_CLEANROOM_IMAGE` names another), and a working directory inside a git
  repository. The form and each start refuse with the reason when one is missing.
- **The copy.** At the first start gonogo makes a git worktree in `~/.gonogo/cleanroom/<name>` on a new branch
  `gonogo/<name>` from `HEAD` (uncommitted changes are not in it). The agent starts in the matching subfolder. gonogo
  never removes the worktree or the branch.
- **The container.** `docker run --rm -i -t --init --name gonogo-<name>-<hash>` as your user. Mounted at the same paths:
  only the worktree (its `.git` file read-only) and `~/.gonogo/agents/<name>/`. Claude's home is
  `agents/<name>/cleanroom-home/`; your `~/.claude` is not shared. Passed by name, never on the command line: the
  agent's token and, if set, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (as `GONOGO_API_KEY`); nothing else from
  gonogo's environment. gonogo runs `docker rm -f` on the container after it ends and before every start.
  It runs with `--cap-drop ALL --security-opt no-new-privileges`: no Linux capability, and a setuid program in the image gains none (inside gonogo's own container the Clean Room shares its network namespace, edge network included, so a capability such as `NET_RAW` or `NET_ADMIN` would reach it). `claude`, `git`, `gh` and `npm install` work as before: they need none as your user.
- **The way back.** git does not work inside the container. You commit in the worktree and merge `gonogo/<name>`
  yourself:
  `git -C ~/.gonogo/cleanroom/<name> add -A && git -C ~/.gonogo/cleanroom/<name> commit -m ...`.
  Run git at the worktree's top (as above) or from your repository, never from a subfolder of the worktree: the agent
  can plant a `.git` folder there that makes git run a program on your machine. Read the diff before you merge. The
  console panel shows the branch and worktree under a `CLEAN ROOM` chip.
- **Reaching gonogo.** Hook and tool URLs use `host.docker.internal`, with
  `--add-host host.docker.internal:host-gateway`; the server accepts that `Host` on those endpoints only. gonogo must
  listen where the container can connect: on Docker Desktop the name reaches the host's loopback (per Docker's docs,
  not tried); on Linux or in a VM start gonogo with `--host 0.0.0.0` (read [Security](../reference/security.md) first).
  With gonogo itself in a container, set `GONOGO_CLEANROOM_NETWORK=container:<name>`: the agent container gets
  `--network container:<name>` instead and shares gonogo's network, where `host.docker.internal` is `127.0.0.1`.
- **Edit.** The box applies at the next start. A Clean Room console cannot be renamed; untick the box in the same edit to
  rename it. Propellant does not count its tokens. Payload MCP servers run inside the container; skill folders are not
  visible there. The room's [Payload defaults](payload.md) never reach a Clean Room console: only what is in its own Payload.
- **Risk.** Claude Code 2.1.325 refuses HTTP hooks to private addresses, and `host.docker.internal` usually is one. If
  so, hooks do not arrive and the console does not follow the agent's work. Unproven either way; see the spec. With
  `GONOGO_CLEANROOM_NETWORK` the name is the loopback `127.0.0.1`, which Claude Code allows (not tried with a real
  `claude`).

## gonogo in a container (compose)

`compose.yaml` mounts the host's Docker socket, so Clean Room containers start on the host's Docker next to gonogo's (not Docker in Docker). **The socket is root on the host for every agent in the container**: see [Docker](../guide/docker.md#clean-room-in-the-container).

- `GONOGO_DATA` (absolute path, no path colon) and `DOCKER_GID` are required by every compose command; without a shell put both in the stack's environment. The data folder (`state/`, `claude/`, `projects/`, `home/`) belongs to uid 1000 and is mounted at its own path, because the host's Docker resolves `-v` paths on the host. Otherwise a start refuses with `gonogo's home ... is not mounted into the container ... from the same path of the host`. "The host" is where the daemon runs (a Lima or Docker Desktop VM counts).
- `GONOGO_CLEANROOM_NETWORK=container:self` (or `container:<name>`) starts each Clean Room in gonogo's network and hosts file; `extra_hosts` maps `host.docker.internal` to `127.0.0.1` (accepted for the hook and tool endpoints only). **A Clean Room there reaches any port the container listens on, including a loopback server another agent started.** Recreating gonogo's container breaks it: restart the console. Other networks are refused.
- `group_add` gives the user the socket's group; Docker Desktop may need another `DOCKER_GID` or `0` (not tried). The image's `/state` and `/projects` volumes are unused here (`docker compose down -v` removes the two empty ones). The default Clean Room image is `ghcr.io/ulm0/gonogo`.
