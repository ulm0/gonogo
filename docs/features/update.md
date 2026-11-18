# Update from the page, and the version in the corner

The running version is shown small in the bottom corner of every page (above the phone bar on a phone) and links to the
changelog. The terminal view (`gonogo tui`) is not built yet, so it has no header to put it in.

## The notice, by install type

Rollout (once a day, off with `GONOGO_UPDATE_CHECK=0` or `--no-update-check`) already says when a newer `@ulm0/gonogo` exists.
It now also tells **how this gonogo was installed**, from where its own file is, and the strip says the right thing for it:

| Install | How it is told | What the strip offers |
|---|---|---|
| Container image | `GONOGO_INSTALL=docker` (the image sets it), `/.dockerenv` or `/run/.containerenv` | the commands `docker compose pull && docker compose up -d` (run in the folder of your `compose.yaml`); an **Update** button only when an update hook is set (below) |
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

## In a container

A container cannot replace its own image. Without a hook, the strip shows the commands to run on the host. With one, **Update** calls it:

- `GONOGO_UPDATE_HOOK`: an `http://` or `https://` URL, for example Watchtower's `http://watchtower:8080/v1/update`;
- `GONOGO_UPDATE_HOOK_TOKEN` (optional): sent as `Authorization: Bearer <token>`.

One POST, no redirect followed, 15 s. The hook decides what to pull and when to restart; gonogo only says "now". If it updates this
container, the page reconnects when the new one is up. The URL comes from the environment of the server, never from a request.
The Dockerfile sets `GONOGO_INSTALL=docker`.

## Not tried

The install of a real package from the registry (the tests use a fake installer), a Watchtower, Windows, and the strip in a browser
(there was no browser here; the client logic is tested, the component was only typechecked and built).
