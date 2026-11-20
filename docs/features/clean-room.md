# Clean Room: a sandbox per agent

<CleanRoomMock class="doc-mock" />

The `Clean Room` box of the hire and edit form (Claude Code agents only) runs the agent in a Docker container holding a copy of the project and the agent's own files, nothing else of your machine. Design: [`docs/clean-room-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/clean-room-spec.md). Tested against real Docker with the stand-in agent, and by RSO and SIMSUP, real Claude Code consoles of the room that builds gonogo ([What was not verified](../reference/not-verified.md)).

## Needs

- Docker running (`docker version` succeeds).
- An image with Claude Code: `docker build -t ghcr.io/ulm0/gonogo .` from a clone builds the default; `GONOGO_CLEANROOM_IMAGE` names another.
- A working directory inside a git repository.

The form and each start refuse with the reason when one is missing.

## What it does

- **The copy:** at first start gonogo makes a git worktree `~/.gonogo/cleanroom/<name>` on a new branch `gonogo/<name>` from `HEAD` (uncommitted changes are not in it). The agent starts in the matching subfolder. gonogo never removes the worktree or branch.
- **The container:** `docker run --rm -i -t --init --name gonogo-<name>-<hash>` as your user, with `--cap-drop ALL --security-opt no-new-privileges` (no capability; setuid gains none; inside gonogo's own container it shares the network namespace, so `NET_RAW` or `NET_ADMIN` would reach it). `claude`, `git`, `gh`, `npm install` work as before. gonogo runs `docker rm -f` after it ends and before every start.
- **Mounted at the same paths:** only the worktree (its `.git` file read-only) and `~/.gonogo/agents/<name>/`. Claude's home is `agents/<name>/cleanroom-home/`; your `~/.claude` is not shared.
- **Passed by name** (never on the command line): the agent's token and, if set, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (as `GONOGO_API_KEY`); nothing else from gonogo's environment.
- The console panel shows the branch and worktree under a `CLEAN ROOM` chip.

## The way back

git does not work inside the container. Commit and merge `gonogo/<name>` yourself:

`git -C ~/.gonogo/cleanroom/<name> add -A && git -C ~/.gonogo/cleanroom/<name> commit -m ...`

Run git at the worktree's top (as above) or from your repository, **never from a subfolder of the worktree**: the agent can plant a `.git` folder there that makes git run a program on your machine. Read the diff before you merge.

## Reaching gonogo

- Hook and tool URLs use `host.docker.internal` (`--add-host host.docker.internal:host-gateway`); the server accepts that `Host` on those endpoints only.
- gonogo must listen where the container can connect. Docker Desktop: the name reaches the host's loopback (per Docker's docs, not tried). Linux or VM: start with `--host 0.0.0.0` (read [Security](../reference/security.md) first).
- With gonogo itself in a container, set `GONOGO_CLEANROOM_NETWORK=container:<name>`: the agent gets `--network container:<name>` and shares gonogo's network, where `host.docker.internal` is `127.0.0.1`.

## Limits

- The box applies at the next start. A Clean Room console cannot be renamed (untick the box in the same edit to rename).
- Propellant does not count its tokens. Payload MCP servers run inside the container; skill folders are not visible there. The room's [Payload defaults](payload.md) never reach it; only its own Payload does.
- **Risk:** Claude Code 2.1.325 refuses HTTP hooks to private addresses, and `host.docker.internal` usually is one; hooks then do not arrive and the console does not follow the agent's work. Unproven either way (see the spec). With `GONOGO_CLEANROOM_NETWORK` the name is `127.0.0.1`, which Claude Code allows (not tried with a real `claude`).
