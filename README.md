<p><img src="docs/brand/lockup.svg" alt="gonogo" width="280"></p>

# gonogo

Self-hosted mission control for coding agents, in a browser tab: each agent (Claude Code, Codex, Gemini CLI and more) runs as a real CLI in a terminal, you watch them all (phone included), and they message each other. One Node process; closing the tab stops nothing; one person per installation.

Documentation: <https://gonogo.ulm0.com/>

## Install

Needs Node 24+, macOS or Linux (glibc), and one agent CLI on your `PATH`, signed in (`claude` by default). The package is `@ulm0/gonogo` (the unscoped `gonogo` is another project). With pnpm, name the [release](https://github.com/ulm0/gonogo/releases) version and exempt gonogo: where `minimumReleaseAge` is set, a young release is refused and `@latest` picks an older one.

```
npm i -g @ulm0/gonogo@latest && gonogo     # or once, with pnpm: pnpm --config.minimum-release-age-exclude=@ulm0/gonogo dlx @ulm0/gonogo@<version>
brew install ulm0/tap/gonogo              # Homebrew (macOS, Linux)
pnpm install && pnpm build && pnpm start   # from a clone
docker build -t gonogo . && docker run -d --name gonogo --init -p 127.0.0.1:7777:7777 -e CLAUDE_CODE_OAUTH_TOKEN -v gonogo-state:/state -v gonogo-home:/home/node -v gonogo-projects:/projects gonogo
```

Open the printed `gonogo ready: http://127.0.0.1:7777/#token=...` (Docker: `docker logs gonogo`). The token is your password: the server runs shells as you. State is in `~/.gonogo` (`/state/gonogo` in Docker). Keep the port on `127.0.0.1`; for other devices or webhooks see [`docs/https.md`](docs/https.md).

[`compose.yaml`](compose.yaml) (Clean Room with gonogo in Docker) mounts the host's Docker socket, **which gives the container and every agent in it root over the host**. Read [Clean Room in the container](docs/guide/docker.md#clean-room-in-the-container) first.

## More

[Documentation](https://gonogo.ulm0.com/) (source in `docs/`), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/backlog.md`](docs/backlog.md), [`CHANGELOG.md`](CHANGELOG.md). License: MIT, see [`LICENSE`](LICENSE) and `dist/client/THIRD-PARTY-NOTICES.md`.
