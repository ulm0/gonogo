#!/bin/sh
# The `gonogo` command of the image. `docker exec gonogo gonogo ...` starts as root now (the entrypoint needs root for a moment), and a gonogo that ran as root
# would write rooms.json, the token and the rest as root: from root it becomes `node` first.
if [ "$(id -u)" = 0 ]; then
  exec /usr/local/bin/gonogo-drop /opt/gonogo/bin/gonogo.js "$@"
fi
exec /opt/gonogo/bin/gonogo.js "$@"
