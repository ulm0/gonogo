---
description: "Run gonogo as a service on its own: a systemd user unit, a macOS LaunchAgent or an OpenRC init script, written by gonogo service install, started at login or boot and restarted when it exits."
---

# Run it as a service

`gonogo service install` makes gonogo start by itself, as you, and start again when it exits. It writes one file and prints what to run; it never runs `sudo`, never runs as root and never starts anything unless you say `--now`.

```
gonogo service install --pty-host --port 7777 --now
gonogo service status
gonogo service uninstall
```

| Machine | The file | What manages it |
|---|---|---|
| Linux with systemd | `~/.config/systemd/user/gonogo.service` | `systemctl --user` |
| macOS | `~/Library/LaunchAgents/com.ulm0.gonogo.plist` (log: `~/Library/Logs/gonogo.log`) | `launchctl` |
| Alpine and other OpenRC | `/etc/init.d/gonogo`, running as your user | `rc-service` |

Anything else gets "no service manager found": run gonogo yourself, for example in `tmux`. A container is its own service: use [Docker](./docker.md).

## What goes in the file

The flags you give to `service install`: `--home` (default `~/.gonogo`, written as an absolute path), `--host`, `--port`, `--pty-host`. Nothing else is pinned, and your shell's `GONOGO_*` variables are not read.

- **The program.** The absolute path of `node` and of the `gonogo` you ran, as it was installed (npm, Homebrew, a clone). A `pnpm dlx` run is refused (nothing is installed there). With pnpm's global install the unit uses `$PNPM_HOME/gonogo`, because pnpm's own folder carries the version and an update replaces it.
- **`PATH`.** The one of the shell that ran `service install`, with the folder of `node` first, so `claude`, `git` and `gh` are found when nothing logs in. Install again after you move them.
- **Restart.** `Restart=always` (systemd), `KeepAlive` (launchd), `supervise-daemon` (OpenRC). A reload and the Update key make gonogo exit on purpose and the manager starts the next one; gonogo does not start a second one itself when `GONOGO_SERVICE` is set, which the file does.
- **`--pty-host`.** Add it: the agents then live in a process of their own, and a reload or an Update keeps their turns running. systemd's `KillMode=process` and launchd's `AbandonProcessGroup` keep that process alive while gonogo restarts; stopping the service (`systemctl --user stop`, `gonogo service uninstall`) still stops gonogo, which stops the agents and the host.

## systemd

`install` writes the unit and prints `systemctl --user daemon-reload && systemctl --user enable --now gonogo.service`; `--now` runs that. A user unit stops when you log out unless you allow lingering. gonogo prints the command and does not run it, since it may ask for authorisation:

```
loginctl enable-linger $USER
```

`journalctl --user -u gonogo` is the log.

## macOS

`install` writes the plist; `--now` boots it into your login session (`launchctl bootstrap gui/<uid> <plist>`). It starts at every login.

## OpenRC

`/etc/init.d` needs root. As your user, `install` writes the script into `<home>/service/gonogo.initd` and prints the three `sudo` commands (`install`, `rc-update add`, `rc-service start`); `--now` is not applied. Already root (through `sudo`, or with `--user <name>`), it writes `/etc/init.d/gonogo` and `--now` adds and starts it. The script has `command_user` set to your user, never root, and logs to `/var/log/gonogo.log`. Paths without spaces or special characters only: OpenRC splits the arguments itself.

## status and uninstall

`status` prints the manager, the file, and whether it is active; its exit code is 0 (active), 3 (installed, not active), 4 (not installed). `uninstall` stops the service and removes the file (OpenRC without root prints the `sudo` commands). Your home folder is not touched.

## Update and reload under a service

The Update key (npm and pnpm installs) installs the new version and then reloads: gonogo hands the agents to the pty host and exits, and the manager starts the new gonogo at the same path. `gonogo reload` does the same from a terminal. Without `--pty-host` the agents stop and resume, as for any restart. The unit pins the path of the command, not a version, so an in-place update (npm, Homebrew) is picked up; if you move node (nvm, a Homebrew major), install again.

## Not verified

systemd was run on a GitHub runner, OpenRC in an Alpine container, launchd's file was only linted on macOS (a runner has no login session to load it into). Not run: a real boot, lingering, a reload with agents running under each manager, and a user whose home path has a space.
