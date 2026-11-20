# Homebrew tap

`gonogo.rb` is the formula; the tap is the GitHub repository `ulm0/homebrew-tap` with it at `Formula/gonogo.rb`. Users run
`brew install ulm0/tap/gonogo`.

- **Source.** The tarball of the version (`pnpm pack`, `ulm0-gonogo-<v>.tgz`) that the release workflow attaches to the GitHub Release (`github.com/ulm0/gonogo/releases/download/v<v>/…`), with its sha256, installed by
  `std_npm_args` into `libexec`, with a `bin` link. `depends_on "node"` (Homebrew's `node` is 24 or newer; pin `node@24` if a later
  major breaks gonogo).
- **node-pty.** The native part is `@lydell/node-pty`, which ships prebuilt binaries as optional per-platform packages
  (darwin and linux, x64 and arm64), so the install compiles nothing and needs no Xcode Command Line Tools or Python for it.
  `std_npm_args` ignores lifecycle scripts, which this relies on: there is none to run. Linux needs glibc (Linuxbrew's is fine).
- **Updates.** The `homebrew` job of `.github/workflows/release.yml` opens a pull request on the tap after each stable release, once the
  tarball is attached to the GitHub Release. It does not wait for npm: the sha256 is computed from the file the workflow uploaded, and the
  job only checks that the release serves that same file. (It used to read the npm registry's copy and failed on 0.7.0 and 0.8.1, when npm
  still answered 404 after ten minutes.) The tarball is made by `pnpm pack` from the checked tag; npm gets its own pack from `pnpm publish`,
  so the two files can differ in bytes but not in content. Off until the variable `HOMEBREW_TAP` is `true`.

## The Director creates

1. The repository `ulm0/homebrew-tap` (public), with `Formula/gonogo.rb` copied from here.
2. A fine-grained personal access token limited to that repository, with Contents and Pull requests write, as the secret
   `HOMEBREW_TAP_TOKEN` of `ulm0/gonogo`. Then the repository variable `HOMEBREW_TAP` = `true`.

Not run with a real `brew` yet: `brew install --build-from-source`, `brew test gonogo` and `brew audit --strict --new` are the
checks to run on the first copy.
