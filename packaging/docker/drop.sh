#!/bin/sh
# usage: drop.sh <program> [args...]. Runs the program as uid/gid 1000 (the image's `node`), from root, and does nothing else.
# The supplementary groups are the ones the container was given, plus the group of the Docker socket when it is mounted (found here, so no DOCKER_GID and no `group_add`),
# WITHOUT root's gid 0: the socket stays reachable and the root group does not come along (a socket owned by gid 0 stays out of reach, as before). No capability survives a change of uid from 0, and the inheritable and bounding sets are emptied
# too (not no-new-privs: that would follow into every agent and break what they legitimately run).
# Used by the entrypoint and by the `gonogo` command, because `docker exec` now starts as root too.
groups=$(id -G | tr ' ' '\n' | grep -vx 0 | paste -sd, -)
sock=$(stat -c %g /var/run/docker.sock 2>/dev/null)
case "$sock" in
  '' | *[!0-9]* | 0) ;;
  *) case ",$groups," in *,"$sock",*) ;; *) groups="${groups:+$groups,}$sock" ;; esac ;;
esac
if [ -n "$groups" ]; then
  exec setpriv --reuid=1000 --regid=1000 "--groups=$groups" --inh-caps=-all --bounding-set=-all "$@"
fi
exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --bounding-set=-all "$@"
