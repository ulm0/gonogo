# Clean Room: a sandbox per agent

The `Clean Room` box of the hire and edit form (Claude Code agents only) runs the agent in a Docker container that holds
a copy of the project and the agent's own files, and nothing else of your machine. Design and limits:
[`docs/clean-room-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/clean-room-spec.md). Read its known limits before you rely on it: it ran against real Docker only with gonogo itself in a
container and the stand-in agent, never with a real `claude` (see [What was not verified](../reference/not-verified.md)).

- **Needs.** Docker running (`docker version` must succeed), an image with Claude Code (`docker build -t ghcr.io/ulm0/gonogo .` from
  a clone makes the default one; `GONOGO_CLEANROOM_IMAGE` names another), and a working directory inside a git
  repository. The form refuses the box with the reason when one is missing, and a start checks again.
- **The copy.** At the first start gonogo makes a git worktree of the repository in `~/.gonogo/cleanroom/<name>` on a
  new branch `gonogo/<name>`, from the repository's `HEAD` (changes you have not committed are not in it). The agent
  starts in the same folder of the copy as its working directory has in the repository. The worktree and the branch stay
  until you remove them; gonogo never does.
- **The container.** `docker run --rm -i -t --init --name gonogo-<name>-<hash>` as your user, with only the worktree and
  the agent's folder under `~/.gonogo/agents/<name>/` mounted, at the same paths (the worktree's `.git` file read-only),
  and the container's own Claude home in
  `agents/<name>/cleanroom-home/` (your `~/.claude` is not shared). The agent's token and, when gonogo has them,
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (as `GONOGO_API_KEY`) are passed by name, never on the command line;
  nothing else of gonogo's environment is. With `-t` docker passes no signal on, so after the console's docker process
  ends (a stop, a crash) gonogo removes the container by name (`docker rm -f`), and again before every start, which also
  clears one left by a killed server.
- **The way back.** git does not work inside the container (the repository's `.git` is not mounted, so the agent cannot
  rewrite history or plant a hook). The agent edits the files; you commit in the worktree
  (`git -C ~/.gonogo/cleanroom/<name> add -A && git -C ~/.gonogo/cleanroom/<name> commit -m ...`) and merge `gonogo/<name>`
  yourself. Run git at the top of the worktree (as above) or from your repository, never from a subfolder of the worktree:
  the agent can write a `.git` folder there whose config makes git run a program on your machine. Read the diff before
  you merge. The console panel shows the branch and the worktree path under a `CLEAN ROOM` chip, and the tile carries the chip.
- **How it reaches gonogo.** The hook and tool URLs of a Clean Room agent use `host.docker.internal`, and the container is
  started with `--add-host host.docker.internal:host-gateway`. The server accepts that name as `Host` for the hook and
  tool endpoints only. The server must listen where the container can connect: on Docker Desktop the name leads to the
  host's loopback (Docker's documentation, not tried here); on Linux or in a VM start gonogo with `--host 0.0.0.0` (see [Security](../reference/security.md) first).
  With gonogo in a container and `GONOGO_CLEANROOM_NETWORK=container:<name>`, the container is started with `--network
  container:<name>` instead of `--add-host`: it shares gonogo's network and hosts file, where `host.docker.internal` names `127.0.0.1`, so the URLs and the Host rule stay as they are.
- **Edit.** The box applies at the next start. A Clean Room console cannot be renamed (its worktree and branch carry its
  name); untick the box in the same edit to rename it. Propellant does not count a Clean Room agent's tokens; MCP servers
  of a Payload run inside the container, and skill folders are not visible there.
- **Risk.** Claude Code 2.1.325 refuses HTTP hooks to private addresses, and the address `host.docker.internal` leads to
  usually is one. If that is so in your setup, the hooks of a Clean Room agent do not arrive and its console does not
  follow its work. See the spec; nothing here proves it either way. With gonogo in a container (`GONOGO_CLEANROOM_NETWORK`)
  the name leads to `127.0.0.1`, a loopback address, which Claude Code's rules allow (not tried with a real `claude`).
