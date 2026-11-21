---
description: "Update gonogo from the page: how it knows a newer version is out, what an npm, pnpm or Docker install does, and how to undo an update."
---

# Update from the page, and the version in the top bar

<SelfUpdateMock class="doc-mock" />

Update gonogo from the page: the top bar shows the running version (links to the changelog) and an amber note when a newer one is out ([Rollout](rollout.md)). The terminal view (`gonogo tui`) has no header, so no version there.

## The notice, by install type

Rollout checks once a day (off with `GONOGO_UPDATE_CHECK=0` or `--no-update-check`). **CHECK NOW** (in the strip, and in FLIGHT RULES, VERSION CHECK) asks the registry right away, for a release that came out since: at most **once a minute** (inside it the answer is the cache and the seconds to wait), room main only (`POST /api/rollout/check`, a full key or a session; other rooms answer 409). Asking the page to update to a version **newer than the cache knows** (`POST /api/update {"version":"0.9.2"}` while the cache says 0.9.0) makes the same one ask first and then decides on what it found, instead of refusing at once; a version that is still not the newest one is the same 409 as before, and says so. The strip adapts to how gonogo was installed, told from where its file is:

| Install | How it is told | What the strip offers |
|---|---|---|
| Container image | `GONOGO_INSTALL=docker` (the image sets it), `/.dockerenv` or `/run/.containerenv` | **Update** recreates this container (socket mounted and moving tag, below); else `docker compose pull && docker compose up -d` in the `compose.yaml` folder, or **Update** through an update hook |
| Homebrew | file under `Cellar/gonogo/` | command only: `brew upgrade gonogo` (the button never runs brew) |
| npm global | file under `lib/node_modules/@ulm0/gonogo/` | **Update**: `npm install -g @ulm0/gonogo@x.y.z` |
| pnpm global | file under a `pnpm` folder, or unknown place | **Update**: `pnpm add -g @ulm0/gonogo@x.y.z` |
| `pnpm dlx` | file under `pnpm/dlx/` | command only |
| Git checkout | a `.git` next to the package | command only: `git pull && pnpm install && pnpm build` |

There is no rpm package. Files under `lib/node_modules` (rpm, deb) read as npm. Anything unplaceable is treated as pnpm global, and the note says to check the command first.

## Update

**Update to x.y.z** is the Director's go. Never pressed for you; with the check off nothing can start.

- The server runs only the one command above: no shell, small environment (`PATH`, `HOME`, `npm_config_*`, `PNPM_*`; no gonogo variable, no token), private folder `<home>/run` (mode 0700), 5 minutes at most.
- `x.y.z` must be the release the registry check found and the page sent; else 400 or 409.
- One update at a time. The page shows *Installing...*, then *Reloading* or *Installed*, the last 8 lines of installer output and the way back (`npm install -g @ulm0/gonogo@<the version that ran>`, then reload).
- After install with `--pty-host`: reloads at once like [live reload](live-reload.md); agents keep running. Without it: stops and tells you; a reload would stop the agents (Claude agents resume), so press Reload (Flight Rules).
- A failed install leaves the running version alone and shows the output. `EACCES` (global folder not writable): run the command yourself or change the npm prefix.

API: `POST /api/update` with `{ "version": "x.y.z" }` (the page's token). 202 with the state; 400 bad version; 409 not allowed, with the reason.

## In a container: Update recreates gonogo itself

Needs the Docker socket mounted (compose.yaml does, for the Clean Room) and a moving tag (`:latest`, `:0`, `:0.3`), and Docker 25 or newer (API 1.44; Pad Check says so on older). **The update runs the publisher's image code on this host with the Docker socket (root): the same trust as `docker compose pull`.** Guards: the version check and your click.

1. The click opens a confirmation: agents **working** and **idle** (all stop), and what **autostart** does after. Refused while a **T-minus poll or Static fire** is open.
2. The server pulls its own tag (from the container's `Config.Image`) and reads the label `org.opencontainers.image.version`. **If it is not exactly the clicked version, nothing changes** (registry may lag). A **pinned tag** (`:0.3.0`) or digest is refused: change the tag in compose.
3. A short-lived helper container (`gonogo self-update`, label `gonogo.helper`, removed when done; from the new image, for UNDO from the image running now) gets the socket and home folder. Through the Docker Engine API it copies the container from `inspect` (ports, binds, `init`, extra hosts, `group_add`, restart policy, networks, aliases, all labels) onto the new image as `<name>-next-<random>`, stops the old one (agents stop gracefully), renames it `<name>-prev-<random>`, starts the copy under the name and waits up to 3 minutes for Docker's **`healthy`**.
4. **Healthy**: old removed; `<home>/run/update.json` records result and previous image id. **Not healthy or not started**: copy removed, old renamed back and started, the page says why with the copy's last log lines. If that fails too, both stay as `-prev` and `-next` for you.
5. The page reconnects and shows *Updated 0.3.0 to 0.4.0* with **UNDO**: same helper on the **previous image** (kept on the host; `docker image prune -a` removes it and UNDO says so). One step back only; beyond, pin a tag.

| Item | Value |
|---|---|
| Health meaning | the image HEALTHCHECK (page at `127.0.0.1:7777/` answers 200). With another `--port` or `GONOGO_PORT` change the probe too ([Docker guide](../guide/docker.md)) or every update rolls back |
| Moving tag memory | the copy runs from the image id; the tag is kept in label `gonogo.self-update.ref` |
| Helper silent 5 minutes | the page says so; look at `docker ps -a`, `docker logs` of the `gonogo.helper` container; bring gonogo back with `docker compose up -d` |
| Cleanup | after a good update, stopped `<name>-prev-<6 hex>` / `<name>-next-<6 hex>` containers with the same compose project and service labels are removed |
| `gonogo doctor` / strip | "Docker self-update: ready / needs the Docker socket / pinned to 0.3.0" |
| API | `POST /api/update`, `POST /api/update/undo` |

**Several rooms.** One supervisor, one process per room: an update replaces all. **Only room `main` offers Update** (others say "update from the main room"). main asks the supervisor (`gonogo-ask busy`) whether any room has a T-minus poll or Static fire open; one open anywhere refuses and names it. The dialog's agent counts are main's; other rooms stop too, as for any restart. The health gate covers `main` only; other rooms that crash-loop show their error in the room list; UNDO is the way back. The container stops with SIGTERM to the supervisor, up to 60 s (`stop_grace_period`). With npm or pnpm, Update installs then asks the supervisor to reload (`SIGUSR2`; with `--pty-host` agents keep running), from main only.

**The new server follows the swap.** It reads `update.json` every 5 s (up to 15 minutes) until the helper finishes, so the strip shows *Updated* with UNDO, or the rollback, without a restart. The helper's label `gonogo.helper.target=<old container id>` keeps another gonogo's helper on the host from being taken for ours.

**A helper killed half way.** It writes `update.json` with state `started` before stopping anything. If killed, the next gonogo that finds `started` and no running helper (or one older than 15 minutes) marks it **interrupted**: the strip shows recovery text and lists the stopped `-prev-` containers (one may hold the only copy of the old version); **no UNDO is offered**. If it died while the old container was stopping or stopped, gonogo stays **down** until `docker compose up -d` (or `docker start` of the old container).

Limits:

- A compose file edited since the container was created is not re-read (only `docker compose up -d` does); the copy's `config-hash` label is old, so the next `docker compose up -d` recreates it once more, harmlessly.
- A private image needing a registry login needs `docker compose pull` on the host (the container has no credentials).
- A new image that passes healthcheck and breaks later is not caught: use UNDO.

**Without the socket**, or with a pinned tag, Update calls an update hook if set, else the strip shows the host commands.

| Variable | Meaning |
|---|---|
| `GONOGO_UPDATE_HOOK` | `http://` or `https://` URL that updates the container (e.g. Watchtower `/v1/update`; Watchtower has been archived and unmaintained since December 2025, so gonogo does not recommend it) |
| `GONOGO_UPDATE_HOOK_TOKEN` | optional; sent as `Authorization: Bearer <token>` |

One POST, no redirect followed, 15 s. The URL comes from the server environment, never a request.

### How gonogo finds its own container

The update needs this very container through the socket, and the hostname is only its id by default: a compose `hostname:` or a recreate makes it something else ("No such container: <hostname>" kept the Update key off on one install). A wrong container would be stopped by the update, so the rules are strict: (1) **its own files** first: the id in the bind sources of `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf` in `/proc/self/mountinfo` (`…/containers/<id>/`, Podman's `…/overlay-containers/<id>/`) and in `/proc/self/cgroup` (`docker/<id>`, `docker-<id>.scope`, `libpod-<id>.scope`, Kubernetes forms; a private cgroup namespace shows only `0::/`). **If the files name an id, only a container with exactly that id is this one**: two ids, or one this Docker does not know (the socket of another daemon), is a refusal, and nothing else is tried. (2) With the files silent, **the hostname, only as an id**: 12 to 64 hex characters that start the id of the container Docker finds; a name, or a hostname that was set, proves nothing. (3) Failing that, the one running container with this process's **MAC address and IP address and whose configured hostname is this hostname** (a MAC derives from an IP and collides between daemons, so it never counts alone). When no rule names exactly one container, it refuses, and **the Update strip, the AUTO-UPDATE block and Pad Check say why** (for example "this container could not be told from the others through the Docker socket: its own files (mountinfo, cgroup) name no container; the hostname … is not a container id; …"). On a host network (no address of its own) only the first two can work.

### Verifying the image (Docker)

The version label can be written by anyone who can push the tag, so it proves nothing. From 0.8.0 each image has a **build provenance attestation** (GitHub's `actions/attest-build-provenance`, on the digest of the manifest list the tags point at). Before it creates anything, the update (the click's and auto-update's) runs `gh attestation verify oci://ghcr.io/ulm0/gonogo@sha256:... --repo ulm0/gonogo --signer-workflow ulm0/gonogo/.github/workflows/image.yml` on the pulled digest, then builds the copy from that image's **id**.

| Result | Meaning | What happens |
|---|---|---|
| Verified | signed by this repository's image workflow for this release's tag (`--source-ref refs/tags/v<version>`) | update goes on |
| No attestation, none owed | image from before 0.8.0, or not `ghcr.io/ulm0/gonogo` (own build, mirror) | refused with reason; key **Update anyway (no attestation)**; Downlink notes it. Auto-update never takes it |
| Could not check | `gh` has no GitHub login (the common case in a container) | key **Update anyway (could not check)**. Auto-update never takes it |
| Failed | attestation does not verify, other signer or tag, GitHub unreachable, `gh` missing, or no attestation for a release from 0.8.0 on | refused, no override; Downlink says why; nothing changed |

`gh attestation verify` refuses to run without a GitHub login, even for a public repo ("To get started with GitHub CLI, please run: gh auth login"; `--bundle-from-oci` does not avoid it). Provide one:

- `gh auth login` once from a console of room main (gonogo looks in `<home>/gh`, else `~/.config/gh`), or
- `GH_TOKEN` in the container environment; a token with **no permissions** is enough.

**A `GH_TOKEN` or `GITHUB_TOKEN` in the container environment also reaches every agent not in a Clean Room.** Prefer the console login, or a fine-grained token with no permissions, never one with repository access.

Without a login every update is "no way to check": the click offers **Update anyway** and **auto-update never runs** (Flight Rules says why). `gh` runs with a small environment (its login, `PATH`, a proxy), no shell, a time limit, and needs `api.github.com` and the sigstore trust root. **UNDO is not verified** (the previous image already ran here). It proves the image came from that repository's workflow, not that the code is good, and cannot protect a compromised repository or account.

## Auto-update (Docker, off unless you turn it on)

<AutoUpdateMock class="doc-mock" />

**AUTO-UPDATE** in Flight Rules (room main, Docker with the socket and a moving tag) runs the Update above unattended, with the same pull, helper, health check, rollback and UNDO. Off until you turn it on in Flight Rules or set `GONOGO_AUTO_UPDATE=1` (the variable wins; `0` forces off). It runs only when all hold:

- **Next patch only.** Same major and minor, higher patch (0.6.1 takes 0.6.2). A new minor (0.7.0) never installs by itself while gonogo is 0.x; nor a major or pre-release. Those wait for your click.
- **A day old.** Rollout has seen the version for 24 hours (`latestSeenAt` beside `latest` in `rollout.json`).
- **Inside a window.** Default 02:00-05:00 in the container's time zone (set `TZ`); one to four windows `HH:MM-HH:MM`, an end before the start runs over midnight. `GONOGO_AUTO_UPDATE_WINDOW=01:00-02:00,13:00-14:00`.
- **Nothing in the way for 10 minutes running, in every room:** no agent working, starting, waiting for you or with mail queued; no T-minus poll or Static fire open. Any change restarts the 10 minutes. The Downlink gets an **UPDATE** note when they begin ("Auto-update to 0.6.2 starts at about 03:10 ..."), once per version; Flight Rules shows **SKIP THIS VERSION** while waiting. Skipping or switching off stops it.
- **Verified.** Unattested images are refused (no confirm exists).
- **Step-up.** Turning it on or changing its window asks your password again when you sign in with an account. Turning off and SKIP THIS VERSION never ask.
- **Once per version.** The attempt is recorded before it starts. A rolled-back, failed or interrupted version is never retried, and the switch turns itself **off** with the reason (turn it on again after reading it); a newer patch is taken as usual. If the start was refused (a poll opened in that second), it is not an attempt and retries at the next quiet moment.

Afterwards the Downlink says *updated 0.6.1 to 0.6.2* (agents start again per the startup setting; UNDO stays on the strip for a day) or *rolled back: the reason* with the version marked bad. Record: `<home>/autoupdate.json` (a damaged file means off).

**Turning it on lets the publisher's next patch run on this machine, with the Docker socket, without you reading it**; the day of cooling and the patch-only rule are the only checks. npm and pnpm installs have no auto-update.

## Not tried

Not tried: installing a real package from the registry (tests use a fake installer); **the Docker path against a real daemon, real pull and real healthy new image (tests use a fake Engine API; try it by hand in a throwaway compose project first)**; Watchtower; Windows; the strip in a browser (client logic tested, component only typechecked and built).
