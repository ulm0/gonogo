# Update from the page, and the version in the top bar

<SelfUpdateMock class="doc-mock" />

The running version is shown small in the top bar of every room, next to the logo, and links to the changelog; when a newer one is out it adds an amber note ([Rollout](rollout.md)). It used to sit in the bottom corner. The terminal view (`gonogo tui`) is not built yet, so it has no header to put it in.

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

**Several rooms.** gonogo is one supervisor and one process per room, so an update replaces all of them: the container, or the install and a reload. **Only room `main` offers Update** (its home is the root, where `update.json` is read after the swap); the other rooms say "update from the main room". Before it starts, main asks the supervisor whether another room has a **T-minus poll or Static fire open**, over the pipe the two share (one question, `gonogo-ask busy`; the answer is one line with two fields, whether it is busy and which room); an open one in any room refuses the click and names it. The dialog's counts of working and idle agents are main's own: the other rooms stop too, as they do for any restart. The health gate covers room `main` only: other rooms that crash-loop in a new image show their error in the room list, and UNDO is the way back. The swap itself is the same as for one room: the container stops (SIGTERM to the supervisor, which stops every room, up to 60 s: `stop_grace_period`) and the new image starts. With an npm or pnpm install, Update installs the version and then asks the supervisor to reload (`SIGUSR2`; with `--pty-host` the agents keep running), from main only.

**The new server follows the swap.** The server that boots in the middle of an update looks at `update.json` every 5 s (for at most 15 minutes) until the helper writes its end, so the strip changes to *Updated* with UNDO, or to the rollback, without a restart. The helper carries the label `gonogo.helper.target=<the old container id>`, so another gonogo's helper on the same host is never taken for ours.

**A helper killed half way.** The helper writes `update.json` with state `started` (from, to, the previous image, the names it is using) **before it stops anything**, and replaces it with the result. If it is killed, the next gonogo that finds `started` and no helper container running (or one older than 15 minutes) marks it **interrupted**: the strip shows the recovery text and lists the stopped `-prev-` containers it left (one may hold the only copy of the old version), and **no UNDO is offered** (UNDO points at an older image then, which would be a wrong action). If the helper is killed while the old container is stopping or stopped, gonogo stays **down** until you run `docker compose up -d` (or `docker start` of the old container): there is nothing running to show it.

Limits, stated plainly: a compose file edited since the container was created is **not** re-read (only `docker compose up -d` does that), and the copy's `config-hash` label is the old one, so the next `docker compose up -d` recreates it once more, harmlessly, to the same image. A private image that needs a registry login needs `docker compose pull` on the host (the container has no credentials). A new image that starts, passes its healthcheck and is broken afterwards is not caught: use UNDO. `gonogo doctor` and the strip say "Docker self-update: ready / needs the Docker socket / pinned to 0.3.0". The API is `POST /api/update` as for npm, and `POST /api/update/undo`.

**Without the socket**, or with a pinned tag, Update calls an update hook if you set one, else the strip shows the commands to run on the host:

- `GONOGO_UPDATE_HOOK`: an `http://` or `https://` URL that updates the container (for example a **Watchtower** `/v1/update`; Watchtower is **archived and unmaintained** since December 2025, so gonogo does not recommend it);
- `GONOGO_UPDATE_HOOK_TOKEN` (optional): sent as `Authorization: Bearer <token>`.

One POST, no redirect followed, 15 s. The URL comes from the environment of the server, never from a request. The Dockerfile sets `GONOGO_INSTALL=docker`.

### Verifying the image (Docker)

The version label of an image is a line anyone who can push the tag can write, so it proves nothing about who built it. Since 0.8.0 (the first release whose image is attested) the release workflow signs a **build provenance attestation** for each image (GitHub's `actions/attest-build-provenance`, on the digest of the manifest list the tags point at), and the update, **the click's and auto-update's alike**, runs `gh attestation verify oci://ghcr.io/ulm0/gonogo@sha256:… --repo ulm0/gonogo --signer-workflow ulm0/gonogo/.github/workflows/image.yml` on the digest it pulled before it creates anything. It then makes the copy from the **id of that very image** (the tag may move again; the id cannot). Three answers:

- **Verified**: the attestation is there, signed by this repository's image workflow, **for the tag of this very release** (`--source-ref refs/tags/v<version>`, so an image built by a run of the workflow from a branch does not verify). The update goes on.
- **No attestation, and none was owed** (an image from before 0.8.0, or one that is not `ghcr.io/ulm0/gonogo`, such as your own build or a mirror): the click is refused with the reason and a key **Update anyway (no attestation)** that you press by hand; the Downlink says it was run without one. **Auto-update never takes such an image.**
- **Could not check** (`gh` has no GitHub login in the container, see below). **Still confirmable by hand after 0.8.0, and it is the common case**: a container with no login is not told anything about the image. A `gh` login or a `GH_TOKEN` with no permissions closes it, so the check can say verified or failed. It is the same offer as the line above, kept visibly apart: the message says gonogo could not look, not that the image has no attestation, and the key says **Update anyway (could not check)**. Auto-update never takes it either.
- **Failed** (an attestation that does not verify, another signer or tag, GitHub not reachable, `gh` missing, **or no attestation for a release from 0.8.0 on**, since every one of those has one): refused, with no key to override it, and the Downlink says why. Nothing was changed.

**`gh attestation verify` refuses to run without a GitHub login**, even for a public repository (found by running it in a container: "To get started with GitHub CLI, please run: gh auth login"). So the container needs one: `gh auth login` once from a console of room main (gonogo looks for the login in the room's own folder, `<home>/gh`, and else in `~/.config/gh`), or `GH_TOKEN` in the container's environment; a token with **no permissions** is enough, since the repository is public. **A `GH_TOKEN` or `GITHUB_TOKEN` set in the container's environment also reaches every agent that does not run in a Clean Room** (they inherit the environment): prefer the login from a console of room main, or a fine-grained token with no permissions at all, never one with repository access. `gh attestation verify --bundle-from-oci` does not avoid the login (tried: it stops with the same message); only a bundle file given with `--bundle` does, and gonogo would have to fetch and parse that itself. Without a login every update is "no way to check": the click offers **Update anyway**, and **auto-update never runs** (it says why in Flight Rules). `gh` runs with a small environment (its login, `PATH`, a proxy; no other secret of gonogo's), no shell and a time limit, and needs to reach `api.github.com` and the sigstore trust root. **UNDO is not verified**: the previous image already ran here. What this does not do: it proves the image came out of that workflow of that repository, not that its code is good, and it cannot protect a repository whose workflow or account is itself compromised.

## Auto-update (Docker, off unless you turn it on)

<AutoUpdateMock class="doc-mock" />

**AUTO-UPDATE** in Flight Rules (room main, a Docker install with the socket and a moving tag; nowhere else) lets gonogo run the Update above **by itself, unattended**. It is **off** until you turn it on in Flight Rules or set `GONOGO_AUTO_UPDATE=1` in the container's environment (the variable wins and the page then shows the switch as set by it; `0` forces it off). It applies the same pull, helper, health check, rollback and UNDO as the click, and only when all of this holds:

- **The next patch only.** The version must have the same major and minor as the one that runs and a higher patch (0.6.1 takes 0.6.2). **A new minor (0.7.0) never installs by itself while gonogo is 0.x**, since a 0.x minor may break; a major or a pre-release never does either. Those wait for your click.
- **A day old.** Rollout must have seen that version for at least 24 hours (`latestSeenAt` beside `latest` in `rollout.json`); a version it has just learned of starts its day then.
- **Inside a window.** By default 02:00 to 05:00 in the container's time zone (set `TZ`); one to four windows, `HH:MM-HH:MM`, an end before the start runs over midnight. `GONOGO_AUTO_UPDATE_WINDOW=01:00-02:00,13:00-14:00` sets them from the environment.
- **Nothing in the way, for 10 minutes running, in every room:** no agent working, starting, waiting for you or with mail queued, and no T-minus poll or Static fire open. Any change starts the 10 minutes again. The Downlink gets an **UPDATE** note when the 10 minutes begin ("Auto-update to 0.6.2 starts at about 03:10 …"), once per version, and Flight Rules shows **SKIP THIS VERSION** while it waits; skipping, or turning the switch off, stops it.
- **Verified.** The image must verify as above; an unattested one is refused (no confirm exists for auto-update).
- **Turning it on asks for your password again** when you sign in with an account (step-up): turning it on or changing its window is the one change here that lets code run unattended; turning it off and SKIP THIS VERSION never ask.
- **Once per version.** The attempt is recorded before it starts. A version that was rolled back, failed or was interrupted is **never tried again**, and the switch turns itself **off** with the reason (turn it on again after you have read it); a newer patch is then taken as usual. (If the update refused to start at all, because a poll opened in the last second, nothing was touched: it is not an attempt and it tries again at the next quiet moment.)

After the restart the new gonogo says in the Downlink what happened: *updated 0.6.1 to 0.6.2* (the agents start again by themselves per the startup setting; UNDO stays on the strip for a day), or *rolled back: the reason* with the version marked bad. The record is `<home>/autoupdate.json` (a damaged file means off).

Trust, in one sentence, which the page repeats: **turning it on lets the publisher's next patch run on this machine, with the Docker socket, without you reading it**; the day of cooling and the patch-only rule are the only checks. The npm and pnpm installs have no auto-update.

## Not tried

The install of a real package from the registry (the tests use a fake installer), **the Docker path against a real daemon, a real pull and a real healthy new image (the tests use a fake Engine API; try it by hand in a throwaway compose project before you rely on it)**, a Watchtower, Windows, and the strip in a browser
(there was no browser here; the client logic is tested, the component was only typechecked and built).
