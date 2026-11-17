<!--@include: ../CONTRIBUTING.md-->

## Development

The commands and files below belong to the source repository: `scripts/`, `docs/`, `test/`, `CONTRIBUTING.md` and the `Dockerfile` are not part of the package tarball. `CONTRIBUTING.md` says how to run the checks, what the stand-in agent is and what the real smoke costs.

```
pnpm build          # client (vite) and server (tsc) into dist/
pnpm test           # vitest: unit tests, and an end-to-end test with a stand-in agent
pnpm typecheck
pnpm check:pack     # packs the project and runs the packed package in plain Node
pnpm smoke:real --spend   # real claude on haiku; spends subscription tokens
```

`check:pack` runs `pnpm pack` (whose `prepack` rebuilds `dist`), so do not run it while something uses `dist`. `smoke:real` needs `pnpm build` first, a signed-in `claude`, and a folder Claude Code already trusts (this project by default, or `--dir <folder>`).

To try the tarball by hand, run pnpm with an empty user config and a temporary `HOME`, so your own `~/.npmrc` (pnpm reads it too, and it may hold a registry token) is never read or sent. Run the tarball with `pnpm dlx file:<absolute path>`. The tarball carries no lock file: its own dependencies are pinned exactly in `package.json`, theirs resolve at install time.

```
tmp=$(mktemp -d) && : > "$tmp/npmrc"
env HOME="$tmp" NPM_CONFIG_USERCONFIG="$tmp/npmrc" pnpm pack --pack-destination "$tmp"
env HOME="$tmp" NPM_CONFIG_USERCONFIG="$tmp/npmrc" pnpm dlx "file:$tmp/gonogo-0.1.0.tgz" --port 0
```
