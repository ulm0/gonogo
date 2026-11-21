#!/usr/bin/env bash
# The Docker self-update, end to end, on a Docker daemon that is the runner's own (a CI runner, or a docker-in-docker made for the occasion):
#   start gonogo from the image of FROM  ->  update it to TO through the real path (pull, attestation check, helper, health check)
#   ->  assert TO runs  ->  UNDO  ->  assert FROM runs again.
# Only the images ghcr.io/ulm0/gonogo:<FROM> and :latest (which must be TO) are pulled. The only credential is GH_TOKEN (the job's GITHUB_TOKEN), which
# `gh attestation verify` inside the container needs; it is passed by name, never printed.
#
# usage: GH_TOKEN=... scripts/update-e2e.sh <FROM> <TO>      (x.y.z both; FROM is 0.8.0 or later, the first release whose gonogo verifies)
# env:   E2E_PORT (default 17777), E2E_NAME (default gonogo-e2e), E2E_KEEP=1 leaves the container and the data after the run,
#        E2E_IMAGE=<repository> (default ghcr.io/ulm0/gonogo), E2E_UNVERIFIED=1 confirms an image that cannot be verified (for a daemon with no GitHub token, such as a local one; the workflow never sets it).
set -euo pipefail

FROM=${1:?usage: update-e2e.sh <FROM> <TO>}
TO=${2:?usage: update-e2e.sh <FROM> <TO>}
for v in "$FROM" "$TO"; do [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::$v is not x.y.z"; exit 2; }; done
[ "$FROM" != "$TO" ] || { echo "::error::FROM and TO are the same version"; exit 2; }
# E2E_IMAGE only for trying the script against a registry of your own (images that are not ghcr.io/ulm0/gonogo cannot be verified: also set E2E_UNVERIFIED=1)
IMAGE=${E2E_IMAGE:-ghcr.io/ulm0/gonogo}
NAME=${E2E_NAME:-gonogo-e2e}
PORT=${E2E_PORT:-17777}
RUN=$(date +%s)-$$
DATA=$(mktemp -d "${RUNNER_TEMP:-/tmp}/gonogo-e2e.XXXXXX")
SOCK=/var/run/docker.sock
# a runner has passwordless sudo; a daemon of our own (docker-in-docker, as root) has none and needs none
SUDO=sudo
[ "$(id -u)" = 0 ] && SUDO=''
step() { echo "::group::$*"; }
endstep() { echo "::endgroup::"; }
fail() { echo "::error::$*"; dump; exit 1; }

dump() {
  echo "::group::state at the failure"
  docker ps -a --filter "label=gonogo.e2e=$RUN" --format '{{.Names}} {{.Image}} {{.Status}}' || true
  # the server prints its Director token in the "gonogo ready:" line: never into a log that is public
  docker logs --tail 60 "$NAME" 2>&1 | mask || true
  [ -n "$(result_file)" ] && { echo "update.json:"; result_text | mask; } || true
  echo "::endgroup::"
}
cleanup() {
  if [ "${E2E_KEEP:-}" = 1 ]; then echo "kept: container $NAME, data $DATA"; return; fi
  # only what this run made: its containers carry the label gonogo.e2e=$RUN (the update's copies keep the labels of the container they replace),
  # and its helpers the label gonogo.helper.target=<the full id of one of them>; nothing else on the daemon is touched
  for id in $(docker ps -aq --no-trunc --filter "label=gonogo.e2e=$RUN"); do
    docker ps -aq --filter "label=gonogo.helper.target=$id" | xargs -r docker rm -f >/dev/null 2>&1 || true
  done
  docker ps -aq --filter "label=gonogo.e2e=$RUN" | xargs -r docker rm -f >/dev/null 2>&1 || true
  $SUDO rm -rf "$DATA" 2>/dev/null || rm -rf "$DATA" 2>/dev/null || true
}
trap cleanup EXIT

# where the helper writes its result: <home of room main>/run/update.json (under the supervisor's folder since rooms became the only mode)
# the folders are uid 1000's and private (0700): a runner user reads them with sudo
result_file() { $SUDO find "$DATA/state" -name update.json -path '*/run/*' 2>/dev/null | head -1; }
result_text() { local f; f=$(result_file); [ -n "$f" ] && $SUDO cat "$f"; }
mask() { sed -E 's/(#?token=)[0-9a-f]{16,}/\1***/g'; }
version_of() { docker exec "$NAME" node -p 'require("/opt/gonogo/package.json").version' 2>/dev/null; }
health_of() { docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo none; }
# requests to the room's own server with the Director token, from inside the container: `api_post METHOD PATH BODY` prints "<status> <body>"
api_post() { docker exec -e BODY="$3" -e TOKEN_FILE="$DATA/state/token" "$NAME" node -e '
    const [method, path] = process.argv.slice(1);
    const token = require("fs").readFileSync(process.env.TOKEN_FILE, "utf8").trim();
    fetch("http://127.0.0.1:7777" + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: process.env.BODY })
      .then(async (r) => console.log(r.status + " " + (await r.text())), (e) => { console.log("0 " + e.message); });
  ' "$1" "$2" 2>/dev/null || echo "0 exec failed"; }
api_get() { docker exec -e TOKEN_FILE="$DATA/state/token" "$NAME" node -e '
    const token = require("fs").readFileSync(process.env.TOKEN_FILE, "utf8").trim();
    fetch("http://127.0.0.1:7777" + process.argv[1], { headers: { authorization: "Bearer " + token } })
      .then(async (r) => console.log(await r.text()), (e) => { console.log("{}"); });
  ' "$1" 2>/dev/null || echo "{}"; }
update_state() { api_get /api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const u=JSON.parse(s).rollout?.update;console.log(u?JSON.stringify({state:u.state,version:u.version,undo:u.undo===true,verify:u.verify,note:String(u.note||"").slice(0,300)}):"none")}catch{console.log("none")}})'; }

# waits until the container of this name runs version $1 and is healthy
wait_running() {
  local want=$1 limit=${2:-240} i got
  for ((i = 0; i < limit; i += 3)); do
    got=$(version_of || true)
    if [ "$got" = "$want" ] && [ "$(health_of)" = healthy ]; then return 0; fi
    sleep 3
  done
  return 1
}
# waits for the update strip to leave "running" / "handed-off" (the helper is working), up to $1 seconds; prints the last state
wait_settled() {
  local limit=${1:-420} i s
  for ((i = 0; i < limit; i += 4)); do
    s=$(update_state)
    case "$s" in
      none) ;;
      *'"state":"running"'* | *'"state":"handed-off"'* | *'"state":"reloading"'*) ;;
      *) echo "$s"; return 0 ;;
    esac
    sleep 4
  done
  echo "$s"; return 1
}

step "Pull the two images ($IMAGE:$FROM, and :latest which must be $TO)"
docker pull -q "$IMAGE:$FROM" >/dev/null
# the update pulls the container's own MOVING tag: the container runs from :latest, which here is FROM until the pull replaces it
docker tag "$IMAGE:$FROM" "$IMAGE:latest"
# images through 0.11.0 say "v0.11.0" (the git tag), later ones the plain number
label=$(docker image inspect "$IMAGE:$FROM" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
label=${label#v}
[ "$label" = "$FROM" ] || fail "the image tagged $FROM says it is version '$label'"
docker pull -q "$IMAGE:latest" >/dev/null
latest_label=$(docker image inspect "$IMAGE:latest" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
latest_label=${latest_label#v}
[ "$latest_label" = "$TO" ] || fail ":latest of $IMAGE is version '$latest_label', not $TO (the update takes the moving tag; run this when TO is the latest release)"
# put FROM back under :latest for the start; the update pulls the registry's again
docker tag "$IMAGE:$FROM" "$IMAGE:latest"
endstep

step "Start gonogo $FROM"
$SUDO install -d -o 1000 -g 1000 "$DATA" "$DATA/state" "$DATA/projects" "$DATA/claude" "$DATA/home"
now=$(date +%s)000
# the update check is seeded (a check of the registry is a day away) so that $TO is "newer" at once
printf '{"version":1,"checkedAt":%s,"latest":"%s","latestSeenAt":%s}\n' "$now" "$TO" "$now" | $SUDO tee "$DATA/state/rollout.json" >/dev/null
$SUDO chown 1000:1000 "$DATA/state/rollout.json"
gid=$(stat -c %g "$SOCK" 2>/dev/null || stat -f %g "$SOCK")
docker run -d --name "$NAME" --label "gonogo.e2e=$RUN" --init --restart unless-stopped -p "127.0.0.1:$PORT:7777" \
  --group-add "$gid" -v "$SOCK:$SOCK" -v "$DATA:$DATA" -v "$DATA/home:/home/node" -w "$DATA/projects" \
  -e GONOGO_HOME="$DATA/state" -e CLAUDE_CONFIG_DIR="$DATA/claude" -e GH_TOKEN \
  "$IMAGE:latest" >/dev/null
wait_running "$FROM" 240 || fail "gonogo $FROM did not become healthy"
# the Director token of this throwaway instance: masked for the rest of the job, whatever prints it
token=$($SUDO cat "$DATA/state/token" 2>/dev/null || true)
[ -n "$token" ] && echo "::add-mask::$token"
echo "running $(version_of), health $(health_of)"
endstep

step "Update to $TO (the real path: pull, attestation check, helper, health gate)"
body="{\"version\":\"$TO\"}"
[ "${E2E_UNVERIFIED:-}" = 1 ] && body="{\"version\":\"$TO\",\"unverified\":true}"
started=$(api_post POST /api/update "$body")
echo "POST /api/update -> $started"
case "$started" in 202*) ;; *) fail "the update was not accepted: $started" ;; esac
# the old container goes away under the helper's hand; wait for the new one by name
sleep 6
for ((i = 0; i < 240; i += 3)); do
  [ "$(version_of || true)" = "$TO" ] && break
  s=$(update_state)
  case "$s" in *'"state":"failed"'*) fail "the update failed: $s" ;; esac
  sleep 3
done
wait_running "$TO" 240 || fail "gonogo $TO did not run healthy after the update"
echo "running $(version_of), health $(health_of)"
settled=$(wait_settled 240) || fail "the update strip did not settle: $settled"
echo "strip: $settled"
case "$settled" in *'"state":"done"'*'"undo":true'*) ;; *) fail "after the update the strip should say done with UNDO: $settled" ;; esac
[ "$(version_of)" = "$TO" ] || fail "version is not $TO"
# a variable, not a pipe: with pipefail, a grep -q that quits early would fail the pipe
grep -q '"state": *"ok"' <<<"$(result_text)" || fail "update.json does not say ok"
endstep

step "UNDO back to $FROM"
undone=$(api_post POST /api/update/undo '{}')
echo "POST /api/update/undo -> $undone"
case "$undone" in 202*) ;; *) fail "UNDO was not accepted: $undone" ;; esac
sleep 6
wait_running "$FROM" 300 || fail "gonogo $FROM did not run healthy after UNDO"
echo "running $(version_of), health $(health_of)"
settled=$(wait_settled 240) || fail "the strip did not settle after UNDO: $settled"
echo "strip: $settled"
grep -q "\"to\": *\"$FROM\"" <<<"$(result_text)" || fail "update.json does not record the UNDO"
endstep

echo "OK: $FROM -> $TO -> $FROM through the real path, each side healthy"
