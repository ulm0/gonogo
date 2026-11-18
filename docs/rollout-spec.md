# Spec: Rollout

Written and built 2026-11-18. Backlog section 9, "Auto-update", without the auto: gonogo tells the Director when a newer
`@ulm0/gonogo` exists and says which command updates it. It never updates itself.

## Intent

A self-hosted tool that nobody reminds drifts. Rollout asks once a day whether the package has a newer release, shows a quiet
note, and prints the exact command for the way gonogo was installed. Running that command is the Director's act.

## Design

- **The check** (`src/server/rollout.ts`). One `fetch` of the registry's `latest` version document for `@ulm0/gonogo`
  (`registry.npmjs.org`, address in `ROLLOUT_URL`): a GET with an `Accept` header and nothing of ours, so no version, no id, no
  cookie, nothing about the user or the machine; the registry sees the address the request comes from, as for any request. 5
  seconds at most; at most 256 KiB of the answer is read; the `version` in it must be a stable `x.y.z`, else the answer is
  ignored. A failure (no network, a timeout, a refusal, a long or odd answer) is silent: `latest` stays what it was.
- **How often.** At start, and then every hour the server looks, it asks when more than a day has passed since the last
  *try* (a failed try counts, so a registry that is down is not asked every hour). The time and `latest` are cached in
  `<home>/rollout.json` (`{ "version": 1, "checkedAt": ms, "latest": "x.y.z" }`, mode 0600, one of the versioned formats), so a
  restart does not ask again within the day. A `checkedAt` in the future (a clock set back) counts as due.
- **Off.** `GONOGO_UPDATE_CHECK=0` (also `off`, `false`, `no`) or `--no-update-check`; the flag wins. Off means no request, no
  frame, no note, not even for a version the file holds, and `gonogo --version` says nothing more. `startGonogo` is off unless
  its caller asks (`updateCheck: true`), so no test and no other caller reaches the registry by accident; `main` asks unless
  it was turned off.
- **Where it shows.**
  - The page: a quiet strip under the top bar while `RolloutView.newer` (`rollout` in the state and in `rollout` frames):
    `gonogo 0.2.0 is out (this is 0.1.1). To update, run: <command>` with COPY and DISMISS. Dismiss is remembered in this
    browser for that version only (`localStorage`, `gonogo.rollout.dismissed`); a newer version shows again.
  - `gonogo --version`: the first line is as before (`gonogo 0.1.1`); a second line says `0.2.0 is out. To update, run:
    gonogo update` when the cached `latest` is newer. It reads the file, never the network, and finds the home from
    `GONOGO_HOME` or the default (not from `--home`: the flag is not read when `--version` is asked).
  - `gonogo update`: prints the state and the command, and exits 0. It does not ask the network either (the cache says what the
    last check saw) and runs nothing.
- **Which command** (`updateCommand`, from the path of `dist/server/cli.js`, `/.dockerenv` or `/run/.containerenv`, and a
  `.git` folder above `dist`):

| Installed as | Command |
|---|---|
| a container (the image, `compose.yaml`) | `docker compose pull && docker compose up -d`, in the folder of the compose file |
| a git checkout | `git pull && pnpm install && pnpm build` |
| `pnpm dlx` | `pnpm dlx @ulm0/gonogo@latest` |
| `npm install -g` (`lib/node_modules/@ulm0/gonogo`) | `npm install -g @ulm0/gonogo@latest` |
| `pnpm add -g`, and anything not recognised | `pnpm add -g @ulm0/gonogo@latest` |

## Known limits

- The way gonogo was installed is guessed from its path (shortcut: pnpm's `global` and `dlx` folders, npm's
  `lib/node_modules`); a layout it does not know gets the pnpm command, which may be wrong for that install.
- `latest` is the registry's `latest` dist-tag. A release that exists but is not tagged `latest` is not seen, and a
  deprecated one is not told apart.
- The page learns of a release only when the server's own check finds it (at most a day after publish, more if the server was off).
- A container shows the command for the compose file; a container started with `docker run` needs `docker pull` and a new
  `docker run`, which the note does not say.
- Not run against the real registry in a test (tests use a fake `fetch`); checked once by hand that the address answers with
  the `latest` version document.
