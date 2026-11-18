# Update from the page, and the version in the corner

<SelfUpdateMock class="doc-mock" />

The running version is shown small in the bottom corner of every page (above the phone bar on a phone) and links to the
changelog. The terminal view (`gonogo tui`) is not built yet, so it has no header to put it in.

## The notice, by install type

Rollout (once a day, off with `GONOGO_UPDATE_CHECK=0` or `--no-update-check`) already says when a newer `@ulm0/gonogo` exists.
It now also tells **how this gonogo was installed**, from where its own file is, and the strip says the right thing for it:

| Install | How it is told | What the strip offers |
|---|---|---|
| Container image | `GONOGO_INSTALL=docker` (the image sets it), `/.dockerenv` or `/run/.containerenv` | **Update** recreates this container when the Docker socket is mounted and the tag is a moving one (below); else the commands `docker compose pull && docker compose up -d` (run in the folder of your `compose.yaml`), or **Update** through an update hook |
| Homebrew | file under `Cellar/gonogo/` | the command only: `brew upgrade gonogo`. The **Update** button never runs brew |
| npm global | file under `lib/node_modules/@ulm0/gonogo/` | **Update**: `npm install -g @ulm0/gonogo@<version>` |
| pnpm global | file under a `pnpm` folder, or an unknown place | **Update**: `pnpm add -g @ulm0/gonogo@<version>` |
| `pnpm dlx` | file under `pnpm/dlx/` | the command only (nothing is installed to replace) |
| Git checkout | a `.git` next to the package | the command only (`git pull && pnpm install && pnpm build`) |

There is **no rpm package** of gonogo. An install from anything that puts the files under `lib/node_modules` (an rpm, a deb of
Node packages) reads as npm, and the strip says so. Anything gonogo cannot place is treated as a pnpm global install, and the note
says to check the command before you run it.

## Update

The **Update to x.y.z** button is the Director's go. It is never pressed for you: there is no timer, and with the check off nothing
is asked and nothing can be started. The server runs exactly one command and nothing else:

- npm: `npm install -g @ulm0/gonogo@x.y.z`; pnpm: `pnpm add -g @ulm0/gonogo@x.y.z`, without a shell, with a small environment (`PATH`,
  `HOME`, `npm_config_*`, `PNPM_*`; none of gonogo's variables, no token), in a private folder (`<home>/run`, mode 0700: a planted `.npmrc` in `/tmp` is never read), for at most 5 minutes.
- `x.y.z` must be a release number, the one the registry check found, and the same one the page sent: anything else is refused (400 or 409).
- One update at a time. The page follows it through the rollout frames: *Installing…*, then *Reloading* or *Installed*, with the last 8
  lines of the installer's output and the **way back** (`npm install -g @ulm0/gonogo@<the version that ran>`, then reload).
- When it installed, and gonogo runs with `--pty-host`, it reloads at once, as [live reload](live-reload.md) does: the agents keep
  running and the page reconnects. Without `--pty-host` it stops after the install and tells you: a reload would stop the agents
  (Claude agents resume), so you press Reload (Flight Rules) when you are ready.
- A failed install leaves the running version alone and shows the output. `EACCES` (the global folder is not writable by gonogo's
  user) says so: run the command yourself, or change the npm prefix.

The API is `POST /api/update` with `{ "version": "x.y.z" }` (the page's token, like every route): 202 with the state, 400 for a bad
version, 409 for everything that is not allowed, with the reason.

## In a container: Update recreates gonogo itself

With the Docker socket mounted (compose.yaml does, for the Clean Room) and a **moving tag** (`:latest`, `:0`, `:0.3`), **Update to x.y.z** replaces this container with the newer image. Trust, in one sentence: **the update runs the code of the image's publisher on this host, with the Docker socket (root), the same trust as `docker compose pull`**, and the only guards are the version check and your click.

1. The click opens a confirmation: how many agents are **working** and how many are **idle** (they all stop), and what **autostart** will do after (all that were running start again in waves; only the boss; or they stay stopped). It is refused while a **T-minus poll or Static fire** is open.
2. The server pulls **its own tag** (the one in its container's `Config.Image`) and reads the image's `org.opencontainers.image.version` label. **If it is not exactly the version you clicked, nothing is changed** (the registry may lag; try later). A **pinned tag** (`:0.3.0`) or a digest is refused: change the tag in your compose file.
3. It starts a short-lived **helper container** (from the new image; for UNDO from the image that runs now, because the old one may be too old to have `self-update`) (`gonogo self-update`, label `gonogo.helper`, removed when done) with the socket and the home folder mounted. The helper uses the Docker Engine API on the one container it was started for: it creates a copy of it on the new image from `inspect` (ports, binds, `init`, extra hosts, `group_add`, restart policy, networks and aliases, every label including compose's), stops the old one (gonogo stops its agents gracefully), renames it `<name>-prev-<random>` (the copy is made as `<name>-next-<random>`, so a leftover of an earlier try never blocks this one), starts the copy under the name, and waits up to 3 minutes for Docker's **`healthy`** (the image's healthcheck).
4. **Healthy**: the old container is removed and `<home>/run/update.json` records the result and the previous image id. **Not healthy, or it did not start**: the copy is removed, the old one is renamed back and started again, and the page says why, with the last lines of the copy's log. If even that fails, the page says so and both containers are left under `-prev` and `-next` names for you.
5. The page reconnects to the new container and shows *Updated 0.3.0 to 0.4.0* with **UNDO**: it runs the same helper on the **previous image** (kept on the host: `docker image prune -a` removes it, and UNDO then says so). One step back only; beyond that, pin a tag in compose.

The copy runs from the image **id**, so the moving tag it came from is kept in the label `gonogo.self-update.ref` and the next update and UNDO read it there. If the helper does not answer within **5 minutes** (it died half way), the page says so and what to look at (`docker ps -a`, `docker logs` of the `gonogo.helper` container) and how to bring gonogo back (`docker compose up -d`). It needs **Docker 25 or newer** (API 1.44); Pad Check says so on an older daemon. The image's own HEALTHCHECK (the page at `127.0.0.1:7777/` answers 200) is what "healthy" means: with another `--port` or `GONOGO_PORT` the probe must be changed too (see the Docker guide), or every update rolls back. After a good update the helper also removes **stopped** containers named `<name>-prev-<6 hex>` or `<name>-next-<6 hex>` that carry the same compose project and service labels (a stopped one with `restart: always` could otherwise come back after a daemon restart on the same `/state`, two writers).

**Several rooms.** gonogo is one supervisor and one process per room, so an update replaces all of them: the container, or the install and a reload. **Only room `main` offers Update** (its home is the root, where `update.json` is read after the swap); the other rooms say "update from the main room". Before it starts, main asks the supervisor whether another room has a **T-minus poll or Static fire open**, over the pipe the two share (one question, `gonogo-ask busy`; the answer is one line with two fields, whether it is busy and which room); an open one in any room refuses the click and names it. The dialog's counts of working and idle agents are main's own: the other rooms stop too, as they do for any restart. The swap itself is the same as for one room: the container stops (SIGTERM to the supervisor, which stops every room, up to 60 s: `stop_grace_period`) and the new image starts. With an npm or pnpm install, Update installs the version and then asks the supervisor to reload (`SIGUSR2`; with `--pty-host` the agents keep running), from main only.

**The new server follows the swap.** The server that boots in the middle of an update looks at `update.json` every 5 s (for at most 15 minutes) until the helper writes its end, so the strip changes to *Updated* with UNDO, or to the rollback, without a restart. The helper carries the label `gonogo.helper.target=<the old container id>`, so another gonogo's helper on the same host is never taken for ours.

**A helper killed half way.** The helper writes `update.json` with state `started` (from, to, the previous image, the names it is using) **before it stops anything**, and replaces it with the result. If it is killed, the next gonogo that finds `started` and no helper container running (or one older than 15 minutes) marks it **interrupted**: the strip shows the recovery text and lists the stopped `-prev-` containers it left (one may hold the only copy of the old version), and **no UNDO is offered** (UNDO points at an older image then, which would be a wrong action). If the helper is killed while the old container is stopping or stopped, gonogo stays **down** until you run `docker compose up -d` (or `docker start` of the old container): there is nothing running to show it.

Limits, stated plainly: a compose file edited since the container was created is **not** re-read (only `docker compose up -d` does that), and the copy's `config-hash` label is the old one, so the next `docker compose up -d` recreates it once more, harmlessly, to the same image. A private image that needs a registry login needs `docker compose pull` on the host (the container has no credentials). A new image that starts, passes its healthcheck and is broken afterwards is not caught: use UNDO. `gonogo doctor` and the strip say "Docker self-update: ready / needs the Docker socket / pinned to 0.3.0". The API is `POST /api/update` as for npm, and `POST /api/update/undo`.

**Without the socket**, or with a pinned tag, Update calls an update hook if you set one, else the strip shows the commands to run on the host:

- `GONOGO_UPDATE_HOOK`: an `http://` or `https://` URL that updates the container (for example a **Watchtower** `/v1/update`; Watchtower is **archived and unmaintained** since December 2025, so gonogo does not recommend it);
- `GONOGO_UPDATE_HOOK_TOKEN` (optional): sent as `Authorization: Bearer <token>`.

One POST, no redirect followed, 15 s. The URL comes from the environment of the server, never from a request. The Dockerfile sets `GONOGO_INSTALL=docker`.

## Not tried

The install of a real package from the registry (the tests use a fake installer), **the Docker path against a real daemon, a real pull and a real healthy new image (the tests use a fake Engine API; try it by hand in a throwaway compose project before you rely on it)**, a Watchtower, Windows, and the strip in a browser
(there was no browser here; the client logic is tested, the component was only typechecked and built).
