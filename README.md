<p><img src="docs/brand/lockup.svg" alt="gonogo" width="280"></p>

# gonogo

Self-hosted mission control for coding agents, in a browser tab: each agent (Claude Code, Codex, Gemini CLI and more) runs as a real CLI in a terminal, you watch them all (phone included), and they message each other. One Node process; closing the tab stops nothing; one person per installation.

Documentation: <https://gonogo.ulm0.com/>

## Install

Needs Node 24+, `git`, macOS or Linux (glibc), and one agent CLI on your `PATH`, **signed in: run `claude` once in a normal terminal and finish its sign-in first**. The package is `@ulm0/gonogo` (the unscoped `gonogo` is another project). With pnpm, name the [release](https://github.com/ulm0/gonogo/releases) version and exempt gonogo: where `minimumReleaseAge` is set, a young release is refused and `@latest` picks an older one.

```
npm i -g @ulm0/gonogo@latest && gonogo     # or once, with pnpm: pnpm --config.minimum-release-age-exclude=@ulm0/gonogo dlx @ulm0/gonogo@<version>
brew install ulm0/tap/gonogo              # Homebrew (macOS, Linux)
pnpm install && pnpm build && pnpm start   # from a clone
```

`EACCES` on `npm i -g`: use nvm or fnm, or `npm config set prefix ~/.npm-global` and `export PATH=~/.npm-global/bin:$PATH` (add it to `~/.bashrc` to keep it).

Docker, credential first (`claude setup-token` on a machine where `claude` is signed in; without it FLIGHT looks ready but is "Not logged in"). Set `VERSION` to the latest [release](https://github.com/ulm0/gonogo/releases) number; as root drop `sudo`; `claude setup-token` opens a browser on that machine and prints the token:

```
VERSION=0.14.0
export CLAUDE_CODE_OAUTH_TOKEN=PASTE_THE_TOKEN_HERE
curl -fsSLO https://raw.githubusercontent.com/ulm0/gonogo/v$VERSION/compose.yaml
docker compose up -d
sleep 5; docker compose logs gonogo
```

It prints a `gonogo ready:` address and a `gonogo setup:` line (Docker: the logs): open `/setup`, give the setup token, make your account. The token and the setup token are passwords: the server runs shells as you. State is in `~/.gonogo` (`/state/gonogo` in Docker). With Docker the port is published on every interface and the login (the setup token in the log) is what keeps others out; `GONOGO_HOST=127.0.0.1` in a `.env` keeps it on the machine. Otherwise it stays on `127.0.0.1`: from another machine use `ssh -L 7777:127.0.0.1:7777 you@host`. For webhooks see [`docs/https.md`](docs/https.md). New words: [Getting started](https://gonogo.ulm0.com/guide/glossary).

[`compose.yaml`](compose.yaml) mounts the host's Docker socket, **which gives the container and every agent in it root over the host** ([Clean Room in the container](docs/guide/docker.md#clean-room-in-the-container)); a plain `docker run` without it is in [Docker](docs/guide/docker.md).

## More

[Documentation](https://gonogo.ulm0.com/) (source in `docs/`), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/backlog.md`](docs/backlog.md), [`CHANGELOG.md`](CHANGELOG.md). License: MIT, see [`LICENSE`](LICENSE) and `dist/client/THIRD-PARTY-NOTICES.md`.
