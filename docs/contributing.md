<!--@include: ../CONTRIBUTING.md{1,3}-->

<ChecksMock class="doc-mock" />

<!--@include: ../CONTRIBUTING.md{4,}-->

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
env HOME="$tmp" NPM_CONFIG_USERCONFIG="$tmp/npmrc" pnpm dlx "file:$(ls "$tmp"/*.tgz)" --port 0
```

## Releasing

The npm package is `@ulm0/gonogo` (the unscoped `gonogo` on npm is another project); the command it installs is `gonogo`. `.github/workflows/release.yml` publishes it, with provenance, and creates the GitHub Release with generated notes. It runs on a pushed `v*` tag, or by hand (Actions > Release > Run workflow) with the name of a tag that already exists. It checks out that tag, runs the checks above, and stops when the tag is not `v` plus the `version` of `package.json` or the package name is not `@ulm0/gonogo`. A version like `1.2.0-rc.1` goes to the npm dist-tag `next`. The same tag also makes `.github/workflows/image.yml` push the image.

To release: put the new `version` in `package.json` and an entry in `CHANGELOG.md`, merge to `main`, then tag that commit and push the tag (`git tag v<version> && git push origin v<version>`).

Publishing uses npm trusted publishing (OIDC): on npmjs.com, `@ulm0/gonogo` > Settings > Trusted Publisher trusts this repository's workflow `release.yml`, so the publish job needs only `id-token: write` and no token lives in the repository. The first release, 0.1.1, went out with a short-lived granular token; it is no longer used. A tag whose `package.json` is not `@ulm0/gonogo` (such as `v0.1.0`) stops at the name check.

The tarball carries no lock file (pnpm reads none from a package): gonogo's own dependencies are pinned exactly in `package.json`, and theirs resolve at install time. The Docker image installs from `pnpm-lock.yaml` instead.
