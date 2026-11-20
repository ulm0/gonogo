# Rollout: a newer gonogo

<RolloutMock class="doc-mock" />

gonogo tells you when a newer `@ulm0/gonogo` exists and the command to update your install. **It never updates itself without your click** ([Update from the page](update.md)). Design and limits: [`docs/rollout-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/rollout-spec.md).

## The check

- At most once a day, one GET of the `latest` version document of `@ulm0/gonogo` on `registry.npmjs.org` with an `Accept` header only: no version, id, cookie or machine data (the registry sees your address).
- 5 s at most, 256 KiB at most; the answer must hold a stable `x.y.z`, else ignored. Failure is silent.
- Asks at start, checks hourly, asks again after a day since the last try (a failed try counts). State in `rollout.json` in the home, so a restart does not re-ask within the day.
- **Off**: `GONOGO_UPDATE_CHECK=0` (or `off`, `false`, `no`) or `--no-update-check` (wins). Then nothing is asked or shown, not even a version the file holds.

## Where it shows

| Where | What |
|---|---|
| Page strip | under the top bar: `gonogo 0.2.0 is out (this is 0.1.1). To update, run: <command>`, with COPY and DISMISS (kept in this browser per version) |
| Top bar version | amber `0.2.0 out` beside the running version in every room (on a phone it replaces the version). In main the strip has Update; in another room it says to update from main with OPEN MAIN TO UPDATE (`/r/main/?update`), since Update stops main's agents. Dismissal is per version, shared by rooms. Only main checks; other rooms read main's `rollout.json` via `update` in `GET /api/rooms`; nothing shows when the check is off |
| `gonogo --version` | `gonogo 0.1.1`, plus `0.2.0 is out. To update, run: gonogo update` if the last check saw one. Reads the file, never the network; finds the home from `GONOGO_HOME` or the default |
| `gonogo update` | prints the state and command; runs and asks nothing |

## The command

| Installed as | Command |
|---|---|
| Docker image | `docker compose pull && docker compose up -d` in the `compose.yaml` folder |
| git checkout | `git pull && pnpm install && pnpm build` |
| `pnpm dlx` | `pnpm --config.minimum-release-age-exclude=@ulm0/gonogo dlx @ulm0/gonogo@<newest>` |
| Homebrew | `brew upgrade gonogo` |
| `npm install -g` | `npm install -g @ulm0/gonogo@latest` |
| `pnpm add -g`, or anything else | `pnpm --config.minimum-release-age-exclude=@ulm0/gonogo add -g @ulm0/gonogo@<newest>` |

For pnpm `<newest>` is the version the last check saw, never `@latest`; the flag exempts gonogo from `minimumReleaseAge` (otherwise a young release is refused and `@latest` picks an older one); dependencies keep the check. The install type is guessed from gonogo's own file path. If you started the image with `docker run`, pull and restart it yourself.
