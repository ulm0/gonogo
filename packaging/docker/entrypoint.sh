#!/bin/sh
# The container's first command (Dockerfile ENTRYPOINT, under tini). It starts as root, for one reason: a folder bound into the container that did not exist
# on the host is made root:root by Docker (compose from ZimaOS or Portainer, no `install -d`), and the user the server runs as (uid 1000) could not write in it.
# As root it gives uid 1000 the TOP of gonogo's own bind targets that are root's, and nothing else; then it drops to uid 1000 and runs this script again, which
# prepares HOME and becomes gonogo. A container started with `--user 1000` never is root here: it skips all of this and only warns.
#
# What it will chown, and what never:
#  - only $HOME, the folder above $GONOGO_HOME (the data folder), $CLAUDE_CONFIG_DIR and the working directory;
#  - only a real directory (not a symlink), owned by uid 0, that is a mount point or sits directly in one (Docker made it);
#  - never recursively (a root-owned folder with files of someone else keeps them as they are), never `/` or a system folder, never anything else.
if [ "$(id -u)" = 0 ]; then
  fix() {
    p=$1
    # only a path that is already its own canonical spelling: `/etc/`, `/usr/./lib`, `/proc/self/root/etc` and a path through a symlinked parent are refused
    [ -n "$p" ] && r=$(realpath -e "$p" 2>/dev/null) && [ "$r" = "$p" ] || return 0
    case "$p" in
      '' | / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /media | /mnt | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var) return 0 ;;
      /*) ;;
      *) return 0 ;;
    esac
    [ -d "$p" ] && [ ! -L "$p" ] && [ "$(stat -c %u "$p")" = 0 ] || return 0
    # a mount point, or directly in one that is not `/` (a working directory Docker made inside the data folder)
    mountpoint -q "$p" || { d=$(dirname "$p"); [ "$d" != / ] && mountpoint -q "$d"; } || return 0
    chown -h 1000:1000 "$p" && echo "gonogo: $p was owned by root (Docker made it): now owned by uid 1000" >&2
  }
  fix "$HOME"
  # `docker exec -it gonogo gh auth login` runs as root and leaves root-owned files inside the home, which uid 1000 could not read: give the ENTRIES of the home
  # that are root's to uid 1000. Only regular files with ONE link and directories (a symlink an agent planted is no `-type f` or `-type d` and is never followed; a hardlink planted to a root file has a second link and is never chowned, whatever fs.protected_hardlinks says), never across a mount
  # (-xdev for another device, and every mount point is pruned: a bind of the same filesystem has the same device, so -xdev alone does not see it), and `-execdir` so chown runs inside each directory on `./name` and `-h` leaves a symlink alone: nothing outside the home can be reached.
  # At this point nothing else of this container runs, so nobody can swap a path under it.
  case "$HOME" in
    '' | / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /media | /mnt | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var) ;;
    /*) if [ "$(realpath -e "$HOME" 2>/dev/null)" = "$HOME" ] && [ -d "$HOME" ] && [ ! -L "$HOME" ]; then find "$HOME" -xdev -mindepth 1 \( -type d -exec mountpoint -q {} \; -prune \) -o -user 0 \( -type f -links 1 -o -type d \) -execdir chown -h 1000:1000 {} + 2>/dev/null; fi ;;
  esac
  [ -n "${GONOGO_HOME:-}" ] && fix "$(dirname "$GONOGO_HOME")"
  fix "${CLAUDE_CONFIG_DIR:-}"
  fix "$PWD"
  exec /usr/local/bin/gonogo-drop /usr/local/bin/gonogo-entrypoint "$@"
fi
# Past here this is uid 1000 (or the --user the container was started with).
# A new, empty home (a fresh folder or volume on /home/node) gets the skeleton: .bashrc, .profile. Never over a file.
cp -rn /etc/skel/. "$HOME"/ 2>/dev/null
# Which data folder this is, once, in the log. A default folder (compose's ./gonogo-data, GONOGO_DATA not given) that is new and empty is the usual way to lose sight of
# earlier data: an old install whose .env went missing, or compose run from another folder, starts empty without a word. Say so, with the way back.
if [ -n "${GONOGO_HOME:-}" ]; then
  data=$(dirname "$GONOGO_HOME")
  if [ -z "${GONOGO_DATA_GIVEN:-}" ] && [ -z "$(ls -A "$GONOGO_HOME" 2>/dev/null)" ]; then
    echo "gonogo: data folder $data is new and empty (the default, GONOGO_DATA is not set). If you had gonogo before, your data is elsewhere: stop this and set GONOGO_DATA=<its absolute path> in the .env next to compose.yaml." >&2
  else
    echo "gonogo: data folder $data" >&2
  fi
fi
# 0.5.x kept gh's login and git's global config in /state/config (XDG_CONFIG_HOME): carry them into the home, so a plain `docker run` on the
# same /state volume does not lose them when it has no home volume yet. Only while the target does not exist: a `gh auth logout` or a deleted ~/.gitconfig stays done.
if [ -d /state/config/gh ] && [ ! -e "$HOME/.config/gh" ] && mkdir -p "$HOME/.config" 2>/dev/null; then cp -rn /state/config/gh "$HOME/.config/" 2>/dev/null; fi
if [ -f /state/config/git/config ] && [ ! -e "$HOME/.gitconfig" ]; then cp /state/config/git/config "$HOME/.gitconfig" 2>/dev/null; fi
# A folder that is still not writable (the container was started with --user, or the bind is not one of the paths above): the copies above fail silently, so say it.
[ -w "$HOME" ] || echo "gonogo: $HOME is not writable by uid $(id -u); on the host: chown 1000:1000 <GONOGO_DATA>/home" >&2
exec gonogo "$@"
