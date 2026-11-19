# Rollout: a newer gonogo

<RolloutMock class="doc-mock" />

gonogo tells you when a newer `@ulm0/gonogo` exists and says which command updates the way you installed it. **It never updates itself without your click** (Update, on the page, for an npm or pnpm install or a container with an update hook: [Update from the page](update.md)). Design and limits: [`docs/rollout-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/rollout-spec.md).

## The check

- Once a day at most, gonogo does one GET of the `latest` version document of `@ulm0/gonogo` on `registry.npmjs.org`, with an `Accept` header and nothing else of its own: no version, no id, no cookie, nothing about you or the machine. The registry sees the address the request comes from, like any request.
- 5 seconds at most; at most 256 KiB read; the answer must hold a stable `x.y.z`, else it is ignored. A failure is silent.
- It asks at start, then looks every hour and asks again once a day has passed since the last try (a failed try counts). The last try and the version it saw are in `rollout.json` in the home, so a restart does not ask again within the day.

## Off

`GONOGO_UPDATE_CHECK=0` (or `off`, `false`, `no`), or `--no-update-check` (the flag wins). Then nothing is asked and nothing is shown, not even a version the file holds.

## Where it shows

| Where | What |
|---|---|
| The page | A strip under the top bar while a newer version is out: `gonogo 0.2.0 is out (this is 0.1.1). To update, run: <command>`, with COPY and DISMISS. Dismiss is kept in this browser for that version; a newer one shows again. |
| The version in the top bar | In every room, an amber `0.2.0 out` next to the running version while a newer one is out. The strip shows under the bar in every room. In main it has the Update key, and the amber version shows it again (also one dismissed for that version). In another room it says to update from main and has OPEN MAIN TO UPDATE (`/r/main/?update`): the Update key asks before it stops main's agents, so nothing is updated from another room's page. Dismissal is per version and shared by the rooms (one browser origin). Only main runs the check, so another room's page asks the supervisor what main saw (`update` in `GET /api/rooms`, read from main's `rollout.json`); nothing shows when the check is off. A phone shows the amber note in place of the running version. |
| `gonogo --version` | `gonogo 0.1.1`, and a second line `0.2.0 is out. To update, run: gonogo update` when the last check saw a newer one. It reads the file, never the network, and finds the home from `GONOGO_HOME` or the default. |
| `gonogo update` | The state and the command below. It runs nothing and asks nothing. |

## The command

| gonogo was installed as | Command |
|---|---|
| The Docker image | `docker compose pull && docker compose up -d`, in the folder of your `compose.yaml` |
| A git checkout | `git pull && pnpm install && pnpm build` |
| `pnpm dlx` | `pnpm --config.minimum-release-age-exclude=@ulm0/gonogo dlx @ulm0/gonogo@<newest>` |
| Homebrew | `brew upgrade gonogo` |
| `npm install -g` | `npm install -g @ulm0/gonogo@latest` |
| `pnpm add -g`, or anything else | `pnpm --config.minimum-release-age-exclude=@ulm0/gonogo add -g @ulm0/gonogo@<newest>` |

For pnpm, `<newest>` is the version the last check saw, written out, never `@latest`, and the flag exempts gonogo from pnpm's `minimumReleaseAge` (where it is set, a young release is refused and `@latest` picks an older one). Dependencies keep the check.

The way gonogo was installed is guessed from where its own file is. If you started the image with `docker run` instead of compose, pull the image and start it again yourself.
