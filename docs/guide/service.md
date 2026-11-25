---
description: "Run gonogo as a service on its own: a systemd user unit, a macOS LaunchAgent or an OpenRC init script, written and started by gonogo service install, started at login or boot and restarted when it exits."
---

# Run it as a service

`gonogo service install` makes gonogo start by itself, as you, and start again when it exits. It writes one file, **starts the service right away** (no reboot, no second command) and tells you what it did.

```
gonogo service install --pty-host --port 7777
gonogo service status
gonogo service restart
gonogo service uninstall
```

`install --no-start` only writes the file. `start`, `stop` and `restart` are thin wrappers over the manager. A second `install` is safe: it rewrites the file and restarts the service.

| Machine | The file | What manages it |
|---|---|---|
| Linux with systemd | `~/.config/systemd/user/gonogo.service` | `systemctl --user` |
| macOS | `~/Library/LaunchAgents/com.ulm0.gonogo.plist` (log: `~/Library/Logs/gonogo.log`) | `launchctl` |
| OpenRC (Gentoo, Artix, Devuan) | `/etc/init.d/gonogo`, running as your user | `rc-service` |

gonogo itself needs glibc, so OpenRC on Alpine (musl) starts the server but cannot run agents. Anything else gets "no service manager found": run gonogo yourself, for example in `tmux`. A container is its own service: use [Docker](./docker.md).

## When it needs root

systemd and launchd need none. A step that does (OpenRC's `/etc/init.d`, `rc-update` and `rc-service`; `loginctl enable-linger` where polkit refuses) stops with one line:

```
This needs root: run `sudo gonogo service install --port 7777 --pty-host`
```

with the flags you gave. Run it. Under `sudo` the service still runs as **you** (`SUDO_USER`, with your home and your `PATH`), never as root; as root with no one behind `sudo`, say who with `--user <name>`. gonogo never runs `sudo` itself.

## What goes in the file

The flags you give to `service install`: `--home` (default `~/.gonogo`, written as an absolute path), `--host`, `--port`, `--pty-host`. Nothing else is pinned, and your shell's `GONOGO_*` variables are not read.

- **The program.** The absolute path of `node` and of the `gonogo` you ran, as it was installed (npm, Homebrew, a clone). A `pnpm dlx` run is refused (nothing is installed there). With pnpm's global install the unit uses `$PNPM_HOME/gonogo`, because pnpm's own folder carries the version and an update replaces it.
- **The folder it runs in** is your home directory.
- **`PATH`.** The one of the shell that ran `service install`, with the folder of `node` first, so `claude`, `git` and `gh` are found when nothing logs in. Install again after you move them.
- **Restart.** `Restart=always` (systemd), `KeepAlive` (launchd), `supervise-daemon` (OpenRC). A reload and the Update key make gonogo exit on purpose and the manager starts the next one; gonogo does not start a second one itself when `GONOGO_SERVICE` is set, which the file does.
- **`--pty-host`.** Add it: the agents then live in a process of their own, and a reload or an Update keeps their turns running. systemd's `KillMode=process` and launchd's `AbandonProcessGroup` keep that process alive while gonogo restarts; stopping the service (`gonogo service stop`, `uninstall`) still stops gonogo, which stops the agents and the host. The trade-off: with `KillMode=process`, a stop that hangs past `TimeoutStopSec` (90 s) kills only gonogo and leaves the pty host and the agents running, orphaned; the next start adopts them or refuses to start over them, and `ps` shows what is left.

## A gonogo already running

If a gonogo you started in a terminal holds the port, `install` writes the file and does not start a second one:

```
not started: a gonogo (or something else) is already listening on port 7777.
stop the running gonogo first (Ctrl+C), then run gonogo service start
```

## systemd

`install` runs `systemctl --user daemon-reload`, `enable` and `restart`, then turns on **lingering** (`loginctl enable-linger`) so the unit runs when you are logged out and starts at boot. If polkit refuses, you get the sudo line above; the service is already running until you log out. `journalctl --user -u gonogo` is the log.

## macOS

`install` writes the plist, boots it into your login session (`launchctl bootstrap gui/<uid> <plist>`) and kickstarts it. It starts again at every login. `install`, `start` and `restart` first boot the old job out and **wait until launchd has finished unloading it** (up to ten seconds; `bootout` returns before the job is gone, and loading a job that is still loaded fails with "Bootstrap failed: 5: Input/output error"). `start` of a job that is already running says "already running" and loads nothing (loading it again is the same exit 5). A job that is still loaded after that is restarted in place with `launchctl kickstart -k`. If the label was disabled (`launchctl disable`), gonogo enables it again once. Any other exit 5 prints what to check:

Before it loads anything, `install`, `start` and `restart` look at the lock of the home (`<home>/run/supervisor.lock`): if a gonogo you started in a terminal holds it, nothing is loaded and the output names its pid, because the service would only exit at once. If that happens while the service is already installed (a terminal gonogo took the lock while it was stopped), launchd's `KeepAlive` starts it again every five seconds; each try prints "another gonogo supervisor is using ..." in `~/Library/Logs/gonogo.log` and exits, and `gonogo service status` says that a gonogo outside launchd holds the lock. Stop that one and the next try takes over; nothing else breaks, and the plist is never removed by a failed load.

Under Homebrew the file names the **stable** `node` and `gonogo` (`/opt/homebrew/bin/node`, or `/opt/homebrew/opt/node@22/bin/node` for a versioned formula), never the versioned `Cellar/node/<version>` folder that `brew upgrade` removes. A service installed before this has the versioned path in its file: run `gonogo service install` again.

```
plutil -lint ~/Library/LaunchAgents/com.ulm0.gonogo.plist
launchctl print-disabled gui/$(id -u)        # if com.ulm0.gonogo is disabled: launchctl enable gui/$(id -u)/com.ulm0.gonogo
lsof -iTCP:7777 -sTCP:LISTEN                 # something else holding the port
tail ~/Library/Logs/gonogo.log
```

## OpenRC

`/etc/init.d` needs root, so as your user the first line is the sudo line; the script is also staged in `<home>/service/gonogo.initd` with the three commands to do it by hand. Under `sudo` it writes `/etc/init.d/gonogo`, runs `rc-update add gonogo default` and `rc-service gonogo restart`. The script has `command_user` set to your user, never root, and logs to `/var/log/gonogo.log`.

## status and uninstall

`status` prints the manager, the file, and whether it is active; its exit code is 0 (active), 3 (installed, not active), 4 (not installed). `uninstall` stops the service and removes the file (OpenRC without root: the sudo line). Your home folder is not touched.

## Update and reload under a service

The Update key (npm and pnpm installs) installs the new version and then reloads: gonogo hands the agents to the pty host and exits, and the manager starts the new gonogo at the same path. `gonogo reload` does the same from a terminal. Without `--pty-host` the agents stop and resume, as for any restart. The unit pins the path of the command, not a version, so an in-place update (npm, Homebrew) is picked up; if you move node (nvm, a Homebrew major), install again.

## Not verified

systemd was run on a GitHub runner and OpenRC in a Debian container (install, an agent surviving a reload, restart, stop, uninstall); launchd's file was only linted on macOS (a runner has no login session to load it into), and the wait for the unload and the exit 5 hints are tested with a fake `launchctl` only. Not run: a real boot, the polkit refusal of lingering and the `sudo` path on systemd, and a user whose home path has a space (a space in `--home` was run on systemd and OpenRC).
