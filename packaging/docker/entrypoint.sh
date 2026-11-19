#!/bin/sh
# The container's first command (Dockerfile ENTRYPOINT, under tini): prepares HOME, then becomes gonogo. Never overwrites a file.
# A new, empty home (a fresh folder or volume on /home/node) gets the skeleton: .bashrc, .profile.
cp -rn /etc/skel/. "$HOME"/ 2>/dev/null
# 0.5.x kept gh's login and git's global config in /state/config (XDG_CONFIG_HOME): carry them into the home, so a plain `docker run` on the
# same /state volume does not lose them when it has no home volume yet. Only while the target does not exist: a `gh auth logout` or a deleted ~/.gitconfig stays done.
if [ -d /state/config/gh ] && [ ! -e "$HOME/.config/gh" ] && mkdir -p "$HOME/.config" 2>/dev/null; then cp -rn /state/config/gh "$HOME/.config/" 2>/dev/null; fi
if [ -f /state/config/git/config ] && [ ! -e "$HOME/.gitconfig" ]; then cp /state/config/git/config "$HOME/.gitconfig" 2>/dev/null; fi
# A bind of a folder that did not exist is made root:root by Docker (compose from a UI): the copies above fail silently, so say it.
[ -w "$HOME" ] || echo "gonogo: $HOME is not writable by uid $(id -u); on the host: chown 1000:1000 <GONOGO_DATA>/home" >&2
exec gonogo "$@"
