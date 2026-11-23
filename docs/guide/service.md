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
| Alpine and other OpenRC | `/etc/init.d/gonogo`, running as your user | `rc-service` |

Anything else gets "no service manager found": run gonogo yourself, for example in `tmux`. A container is its own service: use [Docker](./docker.md).

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
- **`--pty-host`.** Add it: the agents then live in a process of their own, and a reload or an Update keeps their turns running. systemd's `KillMode=process` and launchd's `AbandonProcessGroup` keep that process alive while gonogo restarts; stopping the service (`gonogo service stop`, `uninstall`) still stops gonogo, which stops the agents and the host.

## A gonogo already running

If a gonogo you started in a terminal holds the port, `install` writes the file and does not start a second one:

```
not started: a gonogo (or something else) is already listening on port 7777.
stop the running gonogo first (Ctrl+C), then run gonogo service start
```

## systemd

`install` runs `systemctl --user daemon-reload`, `enable` and `restart`, then turns on **lingering** (`loginctl enable-linger`) so the unit runs when you are logged out and starts at boot. If polkit refuses, you get the sudo line above; the service is already running until you log out. `journalctl --user -u gonogo` is the log.

## macOS

`install` writes the plist, boots it into your login session (`launchctl bootstrap gui/<uid> <plist>`) and kickstarts it. It starts again at every login.

## OpenRC

`/etc/init.d` needs root, so as your user the first line is the sudo line; the script is also staged in `<home>/service/gonogo.initd` with the three commands to do it by hand. Under `sudo` it writes `/etc/init.d/gonogo`, runs `rc-update add gonogo default` and `rc-service gonogo restart`. The script has `command_user` set to your user, never root, and logs to `/var/log/gonogo.log`. Paths without spaces or special characters only: OpenRC splits the arguments itself.

## status and uninstall

`status` prints the manager, the file, and whether it is active; its exit code is 0 (active), 3 (installed, not active), 4 (not installed). `uninstall` stops the service and removes the file (OpenRC without root: the sudo line). Your home folder is not touched.

## Update and reload under a service

The Update key (npm and pnpm installs) installs the new version and then reloads: gonogo hands the agents to the pty host and exits, and the manager starts the new gonogo at the same path. `gonogo reload` does the same from a terminal. Without `--pty-host` the agents stop and resume, as for any restart. The unit pins the path of the command, not a version, so an in-place update (npm, Homebrew) is picked up; if you move node (nvm, a Homebrew major), install again.

## Not verified

systemd was run on a GitHub runner and OpenRC in an Alpine container (install, an agent surviving a reload, restart, stop, uninstall); launchd's file was only linted on macOS (a runner has no login session to load it into). Not run: a real boot, the polkit refusal of lingering and the `sudo` path on systemd, and a user whose home path has a space.
