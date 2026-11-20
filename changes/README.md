# Changes for the next release

One file per change, named after the branch with each `/` written as `-` (`eecom/auto-update` is `changes/eecom-auto-update.md`; a folder in `changes/` stops the release), holding the CHANGELOG bullet or bullets of that change:

```
- **A short bold name.** What changed for the person who uses gonogo, in one or two sentences.
```

Do not edit `CHANGELOG.md` in a pull request: every merged pull request would conflict with every other open one. The release pull request
runs `pnpm changelog:release <version> <date> "<intro>"`, which folds these files under a new heading and deletes them.
