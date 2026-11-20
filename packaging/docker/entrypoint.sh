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
  [ -n "${GONOGO_HOME:-}" ] && fix "$(dirname "$GONOGO_HOME")"
  fix "${CLAUDE_CONFIG_DIR:-}"
  fix "$PWD"
  exec /usr/local/bin/gonogo-drop /usr/local/bin/gonogo-entrypoint "$@"
fi
# Past here this is uid 1000 (or the --user the container was started with).
# A new, empty home (a fresh folder or volume on /home/node) gets the skeleton: .bashrc, .profile. Never over a file.
cp -rn /etc/skel/. "$HOME"/ 2>/dev/null
# 0.5.x kept gh's login and git's global config in /state/config (XDG_CONFIG_HOME): carry them into the home, so a plain `docker run` on the
# same /state volume does not lose them when it has no home volume yet. Only while the target does not exist: a `gh auth logout` or a deleted ~/.gitconfig stays done.
if [ -d /state/config/gh ] && [ ! -e "$HOME/.config/gh" ] && mkdir -p "$HOME/.config" 2>/dev/null; then cp -rn /state/config/gh "$HOME/.config/" 2>/dev/null; fi
if [ -f /state/config/git/config ] && [ ! -e "$HOME/.gitconfig" ]; then cp /state/config/git/config "$HOME/.gitconfig" 2>/dev/null; fi
# A folder that is still not writable (the container was started with --user, or the bind is not one of the paths above): the copies above fail silently, so say it.
[ -w "$HOME" ] || echo "gonogo: $HOME is not writable by uid $(id -u); on the host: chown 1000:1000 <GONOGO_DATA>/home" >&2
exec gonogo "$@"
