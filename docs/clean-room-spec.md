# Spec: Clean Room

Written and built 2026-11-17. Feature of the self-hosted roadmap (`docs/backlog.md` section 11): an optional sandbox per
agent, the equivalent of Munder Difflin's Sandbox Office. A Clean Room console runs in a Docker container that holds a
copy of the project and the console's own files, and nothing else of your machine.

## Intent

An agent in `bypassPermissions` mode runs as you and can read and change everything you can. The owner wants to let one
agent loose on a project without that: its own copy of the code, a container around it, and the work coming back as a
git branch that the owner merges when it is good.

## Design

- **The setting.** `AgentRecord.cleanRoom?: { image?: string }`. `{}` is on with the default image; absent is off (the
  key is never stored as `undefined`). The view carries `cleanRoom: CleanRoom | null`. Claude Code agents only: the
  image of the project has Claude Code and no other CLI. The one reader is `parseCleanRoom` in `src/server/cleanroom.ts`;
  the hub uses it for hire and edit, `home.ts` for `agents.json` (a bad record makes the file unusable, like the others).
  An image is a Docker image name or id (`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$`), so docker can never read it as an
  option.
- **The checks at hire and edit.** `HubIo.checkCleanRoom(dir)` runs `docker version` (it exits 0 only when the daemon
  answers) and `git rev-parse --show-toplevel` in the folder. A failure is a 400 with the field `cleanRoom` and the
  reason in one line (`Clean Room needs Docker, and "docker version" failed: Cannot connect to the Docker daemon ...`,
  `Clean Room needs the directory to be inside a git repository: fatal: not a git repository ...`). Both programs are
  run without a shell. The same two checks run again at every start; a failure rejects the start with the same text.
  Editing only `dir` of a console that is already a Clean Room is not checked until its next start.
- **The worktree.** At a start `ensureWorktree` makes `<home>/cleanroom/<name>` with `git worktree add -b gonogo/<name>`
  from the repository's `HEAD`, once. Later starts find it again (`git worktree list --porcelain` must name it). A
  worktree whose folder was deleted is pruned and made again on its old branch; a branch that exists is used as it is. A
  folder in that place that git does not know, or one that belongs to another repository, is an error and is left alone.
  The agent starts in the same folder below the repository's top as its `dir` has (`repo/sub` starts in `worktree/sub`);
  if that folder is not committed, the start says so. gonogo never deletes a worktree or a branch.
- **The container.** The launcher starts `docker run --rm -i -t --init --name <container> --user <uid>:<gid> --add-host
  host.docker.internal:host-gateway -e HOME=<h> -e CLAUDE_CONFIG_DIR=<h> -e <NAME> ... -v <worktree>:<worktree> -v
  <worktree>/.git:<worktree>/.git:ro -v <agent folder>:<agent folder> -w <cwd> --entrypoint <program> <image>
  <arguments>` in the pty, with the argument list that a Claude Code start has. Only the worktree and `agents/<name>/`
  are mounted, at the paths they have on the host,
  so every path in `settings.json`, `mcp.json` and the arguments is true on both sides. `<h>` is
  `agents/<name>/cleanroom-home/`: the container's own Claude config, folder trust and sessions, so nothing of
  `~/.claude` is shared and a restart resumes the session.
- **Variables.** They are named, never given a value, so docker reads them from its own environment and no secret is on a
  command line: `GONOGO_TOKEN`, `TERM`, `COLORTERM`, `IS_DEMO`, and, when gonogo has them, `CLAUDE_CODE_OAUTH_TOKEN` and
  `GONOGO_API_KEY` (how seed mode carries `ANTHROPIC_API_KEY`). Nothing else of gonogo's environment goes in.
- **The server's name.** The hook and MCP URLs written for a Clean Room agent use `host.docker.internal` where the others
  use `127.0.0.1`. The web server accepts that name as `Host` for the hook and MCP endpoints only; any other route (the
  API, the page, the WebSocket) answers 403 `forbidden host` for it, as for any unknown name. The agent token is still
  needed, and an `Origin` header is still refused there.
- **gonogo in a container** (`compose.yaml`; added 2026-11-17). The image holds the docker CLI and the compose file mounts
  the host's Docker socket, so a Clean Room container runs on the host's Docker next to gonogo's (not Docker in Docker).
  `GONOGO_CLEANROOM_NETWORK=container:<gonogo's container>` (`cleanRoomNetwork`, the only accepted form) makes the start
  use `--network container:<name>` in place of `--add-host`. The Clean Room then shares gonogo's network and hosts file,
  where `host.docker.internal` must name `127.0.0.1` (`compose.yaml`: `extra_hosts`; each start checks it with a lookup in
  gonogo and refuses otherwise), so the URLs and the Host rule above stay as they are and the hooks go to loopback, which
  Claude Code's block on private addresses allows. The shared network also lets a Clean Room connect to any port of
  gonogo's container, loopback-only servers of agents outside a Clean Room included. Another network is refused at
  hire and at start: gonogo would be reachable there only at a private address, and the Host rule names only
  `host.docker.internal`. The host's daemon resolves `-v` sources on its own file system, so gonogo's home must be a bind
  mount from the same host path; each start with the variable runs `docker inspect` on that container and refuses with
  `gonogo's home <home> is not mounted into the container <name> from the same path of the host ...` when the closest
  mount over the home is not a `bind` whose source equals its destination (`sameMountError`). **The socket is root on the
  host** for gonogo's container and every agent in it, Clean Room or not; the docs say so where the file is described.
- **Image.** The agent's own `cleanRoom.image`, else `GONOGO_CLEANROOM_IMAGE`, else `ghcr.io/ulm0/gonogo`. The project's `Dockerfile`
  builds that image (`docker build -t ghcr.io/ulm0/gonogo .`); it is not published there yet.
- **The UI.** A `Clean Room` box in the staffing form (hire and edit, Claude Code only) with a hint that says what it
  does and what it needs. A `CLEAN ROOM` chip on the tile (in the slot of the vote, the held count and CUSTOM, so it shows
  when none of those does; on the phone the tile is too small, so only its accessible name says `clean room`), and a line
  under the header of the console panel (and under the header of the phone console) with a chip, the branch and the
  worktree path, and how the work comes back: commit in the worktree, then merge the branch. The branch and the path
  follow from the name (`gonogo/<name>`, `<home>/cleanroom/<name>`), so the view carries only the setting.
- **Edit and rename.** The setting applies at the next start; the console is `dirty` until then. A Clean Room console
  cannot be renamed (409, field `name`), because its worktree and branch carry its name; turning Clean Room off in the
  same edit allows it.

## Decisions the first request left open

- **Only Claude Code.** The other engines are not in the image, and the custom command is not ours to wrap. The hub
  answers 400 for them, and the form does not show the box.
- **git does not work inside the container, on purpose.** A worktree's `.git` is a file that points into the repository's
  own `.git`, which is not mounted. Mounting it would let the agent change every branch, rewrite history and plant a hook
  that runs on the host the next time you use git, which ends the sandbox. So the agent edits files and the owner commits
  from outside (`git -C <worktree> add -A && git -C <worktree> commit`) and merges `gonogo/<name>`. The agent's role text
  gets one sentence that says so (`CLEAN_ROOM_NOTE`), so it does not spend turns on git errors.
- **Seed behaviour is always on for a Clean Room.** A fresh container home has no folder trust, no login and no first-run
  answers, so the launcher records the trust of the worktree folder in the container's own `.claude.json`, gives `claude`
  `IS_DEMO=1` and moves `ANTHROPIC_API_KEY` into the `apiKeyHelper`, the same as seed mode does, whatever `--seed-claude`
  says. It writes only into the container's home, never into `~/.claude.json`.
- **`--entrypoint`.** The `Dockerfile` ends in `ENTRYPOINT ["tini", "-s", "--", "gonogo"]`: without `--entrypoint`,
  `docker run gonogo claude ...` would start a second gonogo with `claude` as its argument. The program goes in
  `--entrypoint`, the rest after the image name.
- **`CLAUDE_CONFIG_DIR` and `HOME`.** The image sets `CLAUDE_CONFIG_DIR=/state/claude`, a folder of its own user (uid
  1000), which `--user` makes unwritable. Both variables point at the container home under the agent's folder.
- **The container's name and its removal.** With `-t` the docker CLI passes no signal on to the container, so the SIGTERM
  of a stop would end the docker process and leave `claude` running in the container, on the same worktree as the next
  start. The container is named `gonogo-<name>-<12 hex of sha256 of the worktree path>` (two gonogo homes on one Docker
  never share a name), and the launcher runs `docker rm -f <container>` when that start's token is revoked (every exit)
  and before every start (a container left by a killed server). The next start of the agent waits for a removal still
  running, so it never removes its own new container.
- **The worktree's `.git` file is read-only** (a second bind mount with `:ro`). Rewritten, it could point the owner's next
  git command in the worktree at a config whose `core.fsmonitor` runs a program on the host. A `.git` folder planted in a
  subfolder can still do that to a git command run from that subfolder, so the docs say to run git at the worktree's top.
- **No symbolic link in the container home.** The container can write `agents/<name>/`, and trust seeding follows a
  symlinked `.claude.json` on purpose (for the owner's own file). A start refuses when `cleanroom-home` or its
  `.claude.json` is a symbolic link, so gonogo never writes into a file outside the agent's folder for the container.
- **`--init`.** Added to the flags the request named, so that signals reach `claude` and children are reaped; the
  entrypoint is no longer `tini`.
- **Credentials.** Only the three names above, by name. `ANTHROPIC_API_KEY` reaches the container as `GONOGO_API_KEY`
  because the settings file tells Claude Code to read the key from it (`apiKeyHelper`).
- **A path with a colon** (the home, the worktree) cannot be mounted with `-v`; the start says so.
- **Propellant does not count a Clean Room agent.** The meter reads only transcripts under Claude's own projects folder;
  the container's transcripts are under its own home. A room limit still trips a Clean Room agent, but its own tokens are
  not counted.
- **Payload.** MCP servers run inside the container (the image must hold their program); skill folders are not mounted,
  so the skills of a Clean Room agent are not found.

## Checked how

| What | How | Result |
|---|---|---|
| The setting reader, the image rules, the argument list, the URL rewrite | `test/cleanroom.test.ts` | pass |
| `docker version` ok, daemon down, docker missing; the repository check | a fake `docker` (`test/fake-docker.mjs`) and real `git` in a temp folder | pass |
| The worktree: made once, found again, deleted and made again, a foreign folder, a branch checked out elsewhere, a subfolder, an uncommitted folder | real `git` 2.56 in temp repositories | pass |
| The launcher's files and argument list, no secret on the command line, trust in the container home, resume | `test/cleanroom.test.ts` against the real launcher | pass |
| The container's name, `docker rm -f` before a start and after an exit (the next start waits for it), a symlinked container home refused | `test/cleanroom.test.ts`, and the stop in `test/e2e.test.ts`, with the fake `docker` | pass |
| The Host rule: hook and MCP yes, everything else no, with token, with Origin | `test/edge.test.ts` against the real web server | pass |
| Hire, edit, rollback, rename | `test/hub.test.ts`, `test/edge.test.ts`, `test/client-forms.test.ts`, `test/client-room.test.ts` | pass |
| `GONOGO_CLEANROOM_NETWORK`: the accepted form, the argument list with `--network`, the mount rule, a failed `docker inspect` before the worktree, a bad value at hire | `test/cleanroom.test.ts` | pass |
| gonogo in a container (`compose.yaml`) on real Docker 29.9.1 in a Lima VM with the stand-in agent: the sandbox started through the socket with `--network container:`, mounts at the same paths, hooks and MCP on loopback (`idle`, `working`, `idle`; a message read), stop removes it, restart makes a new one; a gonogo without the same-path mount refused with the mount text. Rerun at review with `host.docker.internal` from the shared hosts file: hooks and MCP worked, `/api/state` and `/` answered 403 `forbidden host` from inside the Clean Room, and a gonogo without `extra_hosts` refused the start with the `names nothing ... not 127.0.0.1` text | by hand, 2026-11-17 (`docs/reference/not-verified.md`) | pass |
| A hire through the real server: worktree and branch made, `docker run` called with the arguments above, the stand-in agent reaches the hub by `host.docker.internal` (hooks answered 200, mail read through the MCP route) | `test/e2e.test.ts` with the fake docker, which runs the stand-in on the host and maps the name to `127.0.0.1` | pass |

Not checked with gonogo on the host, because real Docker only runs inside a Lima VM here and the host's `docker` CLI fails
on a keychain error: everything Docker does on that path (with gonogo in a container, the run above covers the mounts,
the user, `--entrypoint`, the stop by name and the read-only `.git` mount). That is: that the arguments are accepted, that the mounts, the user and `--entrypoint` give a
container in which `claude` starts, that the `gonogo` image works for an arbitrary uid (a user with no passwd entry), that
`host.docker.internal` resolves and the server is reachable at it, that `-t` really passes no signal on and that
`docker rm -f` by name stops the container, that a read-only file mount over `.git` inside the worktree mount works, and a real `claude`
in a container with a real credential. The box and the chip were not opened in a browser (logic tested; the page was
type-checked and built), so the 390 px layout, the 44 px target of the box and its screen reader name are by construction.

## Known limits

- **Hooks may be blocked, and this is the biggest open risk.** Claude Code 2.1.325 refuses HTTP hooks to addresses that
  are not public or loopback: its bundle holds the message `HTTP hook blocked: ... an address that HTTP hooks may not
  reach` and a list of private ranges (strings of the binary, not run; `docs/facts/claude-code-hooks-mcp.md` 5.4). The
  address `host.docker.internal` resolves to with `host-gateway` is the bridge address of Docker or the host address of a
  VM, which is normally a private one. If so, no hook of a Clean Room agent reaches gonogo: its console would not follow
  its work (no working, needs you or GO and NO-GO from the hooks), a pointer to it could be held (`no hook has reached
  gonogo from <name>`), and Redline would see nothing, while the MCP tools, which are not hooks, would work. The way out is command hooks instead of HTTP hooks (a small Node forwarder inside the agent's folder,
  like Gemini's `HOOK_SHIM`, since the image has Node). It was not built because it cannot be tried here. With gonogo in a
  container and `GONOGO_CLEANROOM_NETWORK`, the name leads to `127.0.0.1`, so this limit should not apply (not tried with a real `claude`).
- **The server must be reachable at the host's address.** With the default `--host 127.0.0.1` the server is not reachable
  from a container on a Linux bridge; Docker Desktop and some VMs forward the name to the host's loopback. Start gonogo
  with `--host 0.0.0.0` where it is not (the browser token and the Host check still guard the browser routes; the agent
  routes need an agent token), and not with `--host ::1`.
- shortcut: the worktree starts from the repository's `HEAD`, so uncommitted changes in your checkout are not in the copy;
  upgrade when the owner asks for them (a stash or a diff applied at creation).
- shortcut: the worktree is made once and never refreshed from the main branch; update it yourself (`git -C <worktree>
  merge main`). Upgrade with a button when it hurts.
- shortcut: gonogo never removes a worktree, a branch or the container home when a console is removed or the setting is
  turned off; `git worktree remove` and `git branch -d` do. Upgrade with a clean-up on remove.
- shortcut: the removal after an exit is not awaited, so a server that exits right after its agents may leave a container
  until that agent's next start removes it; upgrade by awaiting the removals at shutdown.
- Git is not usable inside the container (see above), and Propellant does not count a Clean Room agent.
- Per-agent image has no field in the form; set `cleanRoom.image` through the API or `agents.json` (the form keeps it).
