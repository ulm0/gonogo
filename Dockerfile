# gonogo container image.
#
# Status: built and run on 2026-11-17 with Docker 29.9 in a Lima VM (linux/arm64): the image is about 1.06 GB. The
# `RUN` checks near the end prove at every build what plain Node cannot: `claude --version`, `gonogo --version`
# (which loads the whole compiled server, the pty library included) and a pty that spawns a shell, all as the
# non-root user. linux/amd64 and a real Claude credential inside the container were not tried. With the docker CLI
# (`docker --version` is checked at build too) it is about 1.13 GB; Clean Room through compose.yaml ran the same day.
# Rebuilt with pnpm the same day: all checks pass, still about 1.13 GB.
#
# Build, from the repository root:
#   docker build -t gonogo:<tag> .
#   (optional) --build-arg CLAUDE_CODE_VERSION=<x.y.z>   the Claude Code release baked into the image, default below
#   (optional) --build-arg PI_VERSION=<x.y.z> --build-arg OPENCODE_VERSION=<x.y.z>   the pi and opencode releases (Engine Bay)
#
# Run. One credential only: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY, never both.
# `-e NAME` without a value forwards the variable from your shell, so the secret is not typed into the command line.
# Three named volumes (/home/node keeps gh's login, ~/.gitconfig and the other dotfiles): a named volume copies the image's ownership (uid 1000) on first use.
#   docker run -d --name gonogo --init -p 127.0.0.1:7777:7777 -e CLAUDE_CODE_OAUTH_TOKEN \
#     -v gonogo-state:/state -v gonogo-home:/home/node -v gonogo-projects:/projects gonogo:<tag>
#   docker logs gonogo     # the line `gonogo ready: http://127.0.0.1:7777/#token=...` is the URL to open
# That line holds the browser token, so whoever can read the container log can open the UI. If the log is collected
# anywhere, read the token from the volume instead: docker exec gonogo cat /state/gonogo/token
#
# /projects as a folder of the host instead of a named volume. A bind mount keeps the host's ownership, and the image
# runs as uid 1000, so the folder must belong to that uid or the boss and every agent cannot write there:
#   mkdir projects && sudo chown 1000:1000 projects
#   docker run ... -v "$PWD/projects":/projects ...
# `--user $(id -u):$(id -g)` is not the fix: /state and HOME=/home/node would become unwritable.
#
# Clean Room inside this container: compose.yaml at the repository root mounts the host's Docker socket, so the docker
# CLI in this image starts each Clean Room container on the host's Docker. WARNING: the socket gives this container
# root over the host, and so does every agent in it, including the ones that do not run in a Clean Room. The host's
# Docker mounts a Clean Room's folders by their host paths, so gonogo's home must be mounted at the same path on both
# sides (compose.yaml does that); docs/guide/docker.md, Clean Room in the container, has the details.
#
# Seed mode is on in this image (GONOGO_SEED_CLAUDE=1). It records Claude's folder trust for every folder an agent
# is hired into, so a repository dropped under /projects can run its own Claude hooks with your credential.
#
# Nothing here pushes an image or publishes a package.

# A floating tag: a rebuild can pick up a newer Node and a newer Debian. To pin the base image, build with
#   --build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<digest>     (`docker pull node:24-bookworm-slim` prints the digest)
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
# Only the docker CLI binary of this image is copied (no daemon, no compose or buildx plugin), for Clean Room.
ARG DOCKER_CLI_IMAGE=docker:29.10.0-cli
# The pnpm that installs Claude Code in the runtime stage: the same release as package.json `packageManager`.
ARG PNPM_VERSION=12.21.0
# The gh CLI (binary only), pinned; the sha256 of each archive is from gh_<version>_checksums.txt of the release.
ARG GH_VERSION=2.103.3
ARG GH_SHA256_AMD64=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG GH_SHA256_ARM64=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

# Stage: the gh binary, for the architecture of the build. Node fetches the archive (the base image has no curl or CA
# bundle tool, but node carries its own CAs) and sha256sum checks it against the pin above, so a changed archive fails
# the build. Works with the classic builder as well as BuildKit.
FROM ${NODE_IMAGE} AS gh
ARG GH_VERSION
ARG GH_SHA256_AMD64
ARG GH_SHA256_ARM64
RUN set -eu; \
    case "$(uname -m)" in x86_64) arch=amd64; sum="$GH_SHA256_AMD64" ;; aarch64) arch=arm64; sum="$GH_SHA256_ARM64" ;; *) echo "no gh for $(uname -m)" >&2; exit 1 ;; esac; \
    f=gh_${GH_VERSION}_linux_${arch}.tar.gz; \
    node -e 'fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require("fs").writeFileSync(process.argv[2],Buffer.from(b)))' "https://github.com/cli/cli/releases/download/v${GH_VERSION}/$f" "/tmp/$f"; \
    echo "$sum  /tmp/$f" | sha256sum -c -; \
    mkdir /out; tar -xzf "/tmp/$f" -C /out --strip-components=2 "gh_${GH_VERSION}_linux_${arch}/bin/gh"

# ---------------------------------------------------------------------------
# Stage 1: build the package tarball exactly as `pnpm publish` would ship it. The runtime stage runs that tarball,
# so the container runs the same artifact as `pnpm dlx @ulm0/gonogo`, and a packaging mistake (a file missing from "files",
# a missing shebang) fails the image build. `prepack` in package.json builds the client (vite) and the server (tsc).
# corepack runs the pnpm that package.json `packageManager` pins, release and checksum.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN mkdir -p /out && pnpm pack --pack-destination /out
# The tarball carries no lock file, so its dependencies are installed here from pnpm-lock.yaml: the image gets the
# versions and checksums the tests ran on, and --prod leaves every devDependency out. No dependency build script runs
# (pnpm 10 skips them): the pty library loads its prebuilt binary.
RUN mkdir /app \
 && tar -xzf /out/*.tgz -C /app --strip-components=1 \
 && cp pnpm-lock.yaml /app/ \
 && pnpm --dir /app install --prod --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: runtime. Debian slim (glibc), never Alpine: the pty library ships glibc-only binaries.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG CLAUDE_CODE_VERSION=2.1.325
ARG PI_VERSION=1.6.0
ARG OPENCODE_VERSION=1.19.6
ARG PNPM_VERSION

# The base image has neither git nor a CA bundle. tini reaps the orphans that agents' tools leave behind and forwards
# signals, also when the user forgot `--init`. git refuses repositories owned by another uid, and a bind-mounted
# /projects usually is, hence safe.directory, for /projects only. `/projects/*` is the form for the repositories below
# it, but an older git (bookworm has 2.39) compares it as plain text and matches nothing, so `/projects` stands for a
# repository mounted right there; anything else keeps git's ownership check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory /projects \
 && git config --system --add safe.directory '/projects/*'

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# gh, binary only.
COPY --from=gh /out/gh /usr/local/bin/gh

# Claude Code, pinned, from the npm registry (the package its docs give for containers), installed by the pinned pnpm
# through corepack. --allow-build: the postinstall step links the native binary into place, and pnpm skips it
# otherwise, so `claude --version` right after fails the build in that case. This layer stays before the gonogo layer,
# so a gonogo rebuild does not redo the 350 MiB one. pnpm's store and corepack's cache are removed in the same layer,
# or they would add about as much again to the image; the image keeps no pnpm. No global virtual store: pnpm 12 would
# otherwise leave Claude Code in that store under /root, which the node user cannot reach and the rm removes.
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@${PNPM_VERSION} add --global \
      --config.global-dir=/usr/local/share/pnpm --config.global-bin-dir=/usr/local/bin --config.enable-global-virtual-store=false \
      --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && claude --version \
 && rm -rf /root/.cache /root/.local/share/pnpm

# Two more engines (Engine Bay), so an agent can move off Claude Code when its quota runs out: pi and opencode, pinned, the same way and in
# a layer of their own after Claude Code's. pi is plain JavaScript (no build step). opencode-ai's postinstall links the binary of its
# platform package (opencode-linux-x64 or -arm64, an optional dependency pnpm picks for the build's architecture), hence --allow-build.
# Each brings its own login: an API key set as a Clearance key of the agent, or a login stored under HOME (the /home/node volume).
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@${PNPM_VERSION} add --global \
      --config.global-dir=/usr/local/share/pnpm --config.global-bin-dir=/usr/local/bin --config.enable-global-virtual-store=false \
      --allow-build=opencode-ai @earendil-works/pi-coding-agent@${PI_VERSION} opencode-ai@${OPENCODE_VERSION} \
 && pi --version \
 && opencode --version \
 && rm -rf /root/.cache /root/.local/share/pnpm

COPY --from=build /app /opt/gonogo
# The scripts of packaging/docker are not in the npm tarball (/app), so they come from the build stage's source. `gonogo` is a small script that
# drops from root to uid 1000 (docker exec starts as root, see below); gonogo-drop does the dropping (setpriv, from util-linux).
COPY --from=build --chmod=0755 /src/packaging/docker/gonogo.sh /usr/local/bin/gonogo
COPY --from=build --chmod=0755 /src/packaging/docker/drop.sh /usr/local/bin/gonogo-drop
COPY --from=build --chmod=0755 /src/packaging/docker/entrypoint.sh /usr/local/bin/gonogo-entrypoint

RUN mkdir -p /state /projects \
 && chown -R node:node /state /projects

# HOME=/home/node holds only dotfiles (claude, gh and node are in /usr/local): mount a volume or a host folder there and gh's login
# (~/.config/gh), ~/.gitconfig, ~/.aws and the rest survive a new container, with no XDG or GIT_CONFIG detour.
# CLAUDE_CONFIG_DIR keeps Claude's .claude.json (onboarding, folder trust), settings and sessions in the volume.
# IS_DEMO is not set here: the server gives it to each claude child in seed mode, and an image-wide value would
# hide the account in every claude started in the container.
ENV HOME=/home/node \
    GONOGO_INSTALL=docker \
    CLAUDE_CONFIG_DIR=/state/claude \
    GONOGO_HOME=/state/gonogo \
    GONOGO_SEED_CLAUDE=1 \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    LANG=C.UTF-8

# uid 1000: Claude Code refuses bypassPermissions as root. The boss starts in /projects. The build-time proof below runs as node;
# the container itself starts as root (USER root again after it) so that the entrypoint can give uid 1000 a bind folder Docker made root's,
# and then drops to uid 1000 before anything of gonogo's runs.
USER node
WORKDIR /projects

# Build-time proof as the non-root user. `gonogo --version` imports the whole compiled server, so a missing
# platform package of the pty library, a CommonJS import that only fails in plain Node or a bad bin fails here.
RUN claude --version \
 && pi --version \
 && opencode --version \
 && docker --version \
 && gh --version \
 && gonogo --version \
 && cd /opt/gonogo \
 && node -e 'const pty=require("@lydell/node-pty");const p=pty.spawn("/bin/sh",["-c","echo pty-ok"],{});let o="";p.onData(d=>{o+=d});p.onExit(()=>{console.log(JSON.stringify(o.trim()));process.exit(/pty-ok/.test(o)?0:1)})'

VOLUME ["/state", "/projects"]
EXPOSE 7777

USER root

# /rooms/health is the supervisor's own path (no token, never proxied): 503 until room main has been ready once, then 200 for as
# long as the supervisor runs, also while main restarts, so a crash loop of main does not flap the container and a main that never
# starts keeps it unhealthy (the self-update swap then rolls back). It probes the port of CMD below: with another --port, give
# `docker run` a matching --health-cmd.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7777/rooms/health').then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"]

# -s: tini acts as a subreaper, so reaping also works under Docker's own --init, where tini is not PID 1.
# gonogo-entrypoint (packaging/docker/entrypoint.sh): as root, chowns the top of gonogo's own root-owned bind targets to uid 1000 and drops to it; then fills a new, empty home from /etc/skel, carries over gh's login and git's config from a 0.5.x /state/config, warns when the home is not writable, and execs gonogo with the CMD.
ENTRYPOINT ["tini", "-s", "--", "gonogo-entrypoint"]
# Inside the container the server must listen on all interfaces; the home comes from GONOGO_HOME.
CMD ["--host", "0.0.0.0", "--port", "7777"]
