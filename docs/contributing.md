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
env HOME="$tmp" NPM_CONFIG_USERCONFIG="$tmp/npmrc" pnpm dlx "file:$(ls "$tmp"/*.tgz)" --port 0
```

## Releasing

The npm package is `@ulm0/gonogo` (the unscoped `gonogo` on npm is another project); the command it installs is `gonogo`. `.github/workflows/release.yml` publishes it, with provenance, and creates the GitHub Release with generated notes. It runs on a pushed `v*` tag, or by hand (Actions > Release > Run workflow) with the name of a tag that already exists. It checks out that tag, runs the checks above, and stops when the tag is not `v` plus the `version` of `package.json` or the package name is not `@ulm0/gonogo`. A version like `1.2.0-rc.1` goes to the npm dist-tag `next`. The same tag also makes `.github/workflows/image.yml` push the image.

To release: put the new `version` in `package.json` and an entry in `CHANGELOG.md`, merge to `main`, then tag that commit and push the tag (`git tag v<version> && git push origin v<version>`).

One-time setup, by the owner, before the first publish:

1. On npmjs.com, sign in as the account that owns the scope of `@ulm0/gonogo` and create a granular access token (Access Tokens > Generate New Token > Granular Access Token): read and write on packages, limited to the package `@ulm0/gonogo` once it exists (for the first publish, to its scope), with a short expiry.
2. Add it as the repository secret `NPM_TOKEN` (Settings > Secrets and variables > Actions).
3. Push the next tag, or run the workflow by hand for a tag that already exists. Not `v0.1.0`: that tag is on a commit whose `package.json` still says `gonogo`, so the run stops at the name check.

After the first publish, switch to npm trusted publishing (OIDC), so no token lives in the repository: on npmjs.com, the package's Settings > Trusted Publisher > GitHub Actions, with this repository and the workflow file `release.yml`. Then remove the `NODE_AUTH_TOKEN` line from the publish step, delete the `NPM_TOKEN` secret and revoke the token. The comment at the top of `release.yml` lists the same steps.

The tarball carries no lock file (pnpm reads none from a package): gonogo's own dependencies are pinned exactly in `package.json`, and theirs resolve at install time. The Docker image installs from `pnpm-lock.yaml` instead.
