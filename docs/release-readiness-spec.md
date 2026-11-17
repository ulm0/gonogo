# Spec: Release readiness

Written and built 2026-11-17. Not a feature of the room and it has no control-room name: it is what an open-source, self-hosted
release needs (the last paragraph of `docs/backlog.md` section 11). Nothing is published by it: no npm package, no image.

## Intent

Someone who installs gonogo keeps files under `~/.gonogo` for months. A newer gonogo must be able to change the shape of one of
them without losing what is in it, and an older gonogo must not read or overwrite a file it does not understand. A stranger who
finds the repository must be able to tell what it is, install it, expose it without a mistake, and run its tests.

## Versions and migrations of the saved state

- **Every JSON file with a format carries `"version": <n>`.** All of them were already at 1 except `propellant.json`, which now
  writes `version: 1` at its next save, and the Mission Log entries, whose front matter now has `version: 1` as its first line.
  A file from before that has no version and reads as 1; nothing rewrites it at start.
- **One runner, `migrateHome` in `src/server/migrate.ts`.** `FORMATS` lists each file (a name, or `<folder>/*.json`) with its
  `steps`; step `i` turns version `i + 1` into `i + 2`, so the version this gonogo writes is `steps.length + 1`. Today every list is
  empty. To change a format, add one step and change the store.
- **When it runs:** `openHome` calls it after the lock and the token and before any store reads a file. Under the lock, so
  two gonogos cannot upgrade the same file; before the stores, so they only ever see the current shape.
- **Older file:** copy to `<file>.bak-v<old>` first (mode 0600, never replaced if it exists), run the steps in order on the parsed
  JSON, set `version` after each, write through a temporary file and a rename, log one line. A step that throws, or a copy or write
  that fails, stops the start with a message that names the file, says it was not changed and names the copy.
- **Newer file:** the start stops with `<path> was saved by a newer gonogo (format version N; this one reads up to M). Start the
  gonogo that saved it, or move the file away to start without it.` and the lock is released.
- **Anything else** (a missing file, text that is not JSON, no version, a version that is not a whole number from 1) is skipped and
  left to the store that owns the file.

Decisions the request left open:

1. The runner lives in `openHome`, not in `cli.ts`: every caller that opens a home, tests included, gets the lock, the check and
   the release of the lock on a refusal, and `cli.ts` needs no new line.
2. A newer file is refused by the runner and not left to the stores. Each store renames a file it does not understand to `<file>.bad`
   and starts empty, which for a newer file would hide it, and the next save would write a new, empty file next to it.
3. A file with no version is left alone. The stores already refuse it (a damaged `agents.json` stops the start, the others are
   renamed `.bad`), and guessing a version for a file gonogo did not write is worse than reporting it. The exception is
   `propellant.json` (`unversionedIs1` in `FORMATS`): gonogo wrote it without a version before, so the runner reads such a file as
   version 1 and upgrades it like any other once a step exists.
4. `propellant.json` and the Mission Log entries are versioned by writing `version: 1` from now on. A Mission Log entry of a newer
   version is skipped with a warning and kept, one file at a time (the same rule as a file that is not an entry), instead of
   stopping the start: one entry from a newer gonogo should not lock out the other files.
5. The logs `messages.jsonl` and `fuel.jsonl` have no version. Each line is its own record, a line that cannot be read is skipped, and
   a header line would break the tail reader and the rotation. If a log ever needs another shape, the new shape gets a new file name.
   `mission-log/.seq`, `token`, `server.lock` and the files under `agents/<name>/` that the launcher writes again at every start
   have nothing to migrate.
6. Steps are pure functions of the parsed file. A step cannot do I/O, so a failure cannot leave a half-migrated home, and the
   copy is the whole undo.

## Documents and the package

- **`docs/https.md`:** the three ways to reach gonogo (an SSH tunnel, Tailscale, a public name behind a proxy), a table of which
  paths may be public (`/uplink/*` and `/dock/*` only; `/hook/*` and `/mcp` never), Caddy and nginx files for a name that carries
  only webhooks and docking and for the page, `GONOGO_ALLOWED_HOSTS`, what the token in the URL means, and a checklist.
- **`README.md`:** what it is, the thirteen feature names in five lines, how to install (npm and Docker, from a clone, and
  honest that nothing is published), links to `docs/reference.md` and `docs/https.md`. 26 lines.
- **`package.json`:** a new `description` and keywords (`ai-agents`, `mission-control`, `self-hosted`, `webhooks` added). It has no
  `repository`, `author`, `homepage` or `bugs` field, and none was invented: the owner adds them with the first publish.
- **`CONTRIBUTING.md`:** the three checks, where things are, the stand-in agent, the real smoke and what it costs (not measured),
  saved-state migrations and secrets in tests.

## Known limits

- shortcut: no format has moved past version 1, so the runner has only run against fixtures; the first real step is its first real use.
- shortcut: a home with one file too new and another that needs an upgrade can upgrade the second before it refuses the first. The
  copy makes that harmless; a check pass over all files first would remove it.
- A `.bak-v<n>` file stays until a person deletes it. gonogo never reads or removes it. A copy of `uplinks.json`, `relay.json` or
  `docking.json` holds the secrets of that day in plain text (mode 0600), even after they are rotated.
- shortcut: a Mission Log entry has a version but the runner does not read Markdown, so the first change to the entry format needs its
  upgrade in `missionlog.ts`; move the entries under the runner when that happens.
- Going back to an older gonogo is by hand: put the `.bak-v<n>` copy back, losing what changed since the upgrade.
- The Caddy and nginx files, `tailscale serve` and docking over a tailnet in `docs/https.md` were not run. The smoke cost in
  `CONTRIBUTING.md` was not measured.
- Not done on purpose: publishing the npm package or the image (only when the owner says so).

## Tests

`test/migrate.test.ts` with fixtures in `test/fixtures/migrate/`: a three-version made-up format (every step in order, a file
that starts at version 2, a second run that changes nothing, a copy with the original bytes and mode 0600, a refused newer file
that stays as it was, files left to their store, a failing step, an existing copy kept, a home that cannot be written, a folder of
files), each real file of `FORMATS` refused at version 2, and `openHome` stopping with that message and opening again once the
file is gone. `test/propellant.test.ts` and `test/missionlog.test.ts` cover the two files that gained a version.
