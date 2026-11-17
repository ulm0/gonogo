# Toolchain, npm packaging, Docker and sign-in: facts

Date of every run and every download: 2026-11-16. Job: toolchain-docker. Contract: `docs/superpowers/specs/2026-11-16-gonogo-design.md`.

Every statement is tagged. **VERIFIED** says how (a command I ran, or an official page I fetched). **UNVERIFIED** means I could not run it, with the best documented or derived answer. A statement with neither tag is a description of something I did or read, in the same section.

The most important result first: **the Docker daemon was not running, so no image was built or run.** Everything about building, running, sizing or testing a container is UNVERIFIED. What I could check without a daemon (registry API over HTTPS, package contents, ELF parsing, simulated platform selection) is tagged VERIFIED and says so.

## 0. Environment

- Host: macOS on arm64 (Darwin 27.0.0). Default toolchain Node v24.18.0 with npm 11.16.0 (nvm).
- Other toolchains used, all by absolute path, nothing installed globally:
  - Node v22.21.1 with npm 10.9.4 (nvm).
  - Node v20.20.2, fetched into scratch with `npm install node@20`, driven by npm 11.16.0's CLI.
  - npm 12.2.2, fetched into scratch with `npm install npm@12.2.2`, driven by Node v24.18.0.
- `command claude --version` printed `2.1.325 (Claude Code)`.
- `docker info` (run at the start and again at the end) printed the client section (Docker Engine - Community 29.9.3, context `limakit`) and then:
  `Cannot connect to the Docker daemon at unix:///Volumes/<volume>/lima/default/sock/docker.sock. Is the docker daemon running?`
  I did not start it. I never ran any other `docker` command.
- Scratch directory (all probe projects, logs, downloads): `<scratch>/facts-toolchain-docker`. The volume is APFS without `noexec`.
- Every npm command used `npm_config_cache` inside scratch and an empty user config (`~/.npmrc` holds only a registry auth token), so nothing wrote to `~/.npm` and no user setting leaked into a result. Audit and fund were off.

## 1. A dependency block that installs cleanly today

### 1.1 The block

Exact versions, resolved by a fresh `npm install` on 2026-11-16 (npm `latest` tags). Runtime dependencies are what `npx gonogo` and the image must install. The client libraries are bundled by Vite, so they belong in `devDependencies`; that keeps the published package's install small.

```json
{
  "dependencies": {
    "@lydell/node-pty": "1.2.0-beta.18",
    "@modelcontextprotocol/sdk": "1.32.2",
    "@xterm/addon-serialize": "0.14.0",
    "@xterm/headless": "6.0.0",
    "ws": "8.23.0",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@types/ws": "8.18.2",
    "@vitejs/plugin-react": "6.3.0",
    "@xterm/addon-fit": "0.11.0",
    "@xterm/xterm": "6.0.0",
    "pixi.js": "8.23.0",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "typescript": "7.0.2",
    "vite": "8.3.8",
    "vitest": "5.1.0"
  }
}
```

Notes on the block:

- The pty line is one of four choices; see 1.4. `node-pty` 1.2.0-beta.18 can replace the `@lydell/node-pty` line. Do not use `node-pty` 1.1.0 (its `latest` tag).
- `zod` is not in your list but is required: `@modelcontextprotocol/sdk` declares `zod` (`^3.25 || ^4.0`) as a non-optional peer, and the server imports `zod` for tool schemas. npm installs it automatically as a peer; declare it so it is yours.
- `@types/react` and `@types/react-dom` are required for TSX with React 19 (React ships no types; without them `tsc` fails with TS7016 and TS7026). Also not in your list.
- `@types/node` is pinned to the 22 line on purpose. The npm `latest` is 26.6.6. See 1.3.
- Lockfile facts: 219 packages in the first (latest-everything) lockfile, 163 to 164 installed per platform. The macOS-generated lockfile carries the Linux x64 and arm64 glibc variants of every platform-specific package with `resolved` and `integrity`: `@rolldown/binding-linux-{arm64,x64}-gnu` 1.2.19, `@typescript/typescript-linux-{arm64,x64}` 7.0.2, `lightningcss-linux-{arm64,x64}-gnu` 1.33.0, `@lydell/node-pty-linux-{arm64,x64}` 1.2.0-beta.18. VERIFIED: `jq` over `package-lock.json`, and `npm ci --os=linux --cpu=arm64 --libc=glibc --ignore-scripts` then `--cpu=x64` in a scratch copy installed the Linux variant of each (nothing was executed on Linux).

### 1.2 What was run (all VERIFIED unless marked)

Project: scratch `probe` (first, latest-everything) and `probe-final` (the block above). `"type": "module"`.

1. `npm install react react-dom vite @vitejs/plugin-react typescript vitest pixi.js @xterm/xterm @xterm/addon-fit ws @types/ws @modelcontextprotocol/sdk node-pty @lydell/node-pty @xterm/headless @xterm/addon-serialize @types/node` on Node 24.18.0 / npm 11.16.0: `added 160 packages in 25s`, exit 0, no `ERESOLVE`, `npm ls --depth=0` exit 0. Versions that came out: `node-pty` 1.1.0, `@lydell/node-pty` 1.2.0-beta.18, `@types/node` 26.6.6, the rest as in the block.
2. Smoke test on `probe-final`, on Node 24.18.0 with a fresh `npm install`, then on Node 22.21.1 with `npm ci` from that lockfile. All five steps passed on both:
   - `npx tsc -p tsconfig.json` (client, test files, vite and vitest configs; `jsx: react-jsx`, `moduleResolution: bundler`, `strict`).
   - `npx tsc -p tsconfig.server.json` (`module` and `moduleResolution` both `NodeNext`, `strict`, emits to `dist-server`).
   - `npx vite build` (React page that creates a Pixi `Application` and an xterm `Terminal` with `FitAddon`; `root: 'client'`, `outDir: '../dist/client'`). Output: 10 files, 1,084 KB; main chunk 809.76 kB, 226.87 kB gzip. Vite 8 prints a chunk-size warning (it now uses rolldown; its option is `build.rolldownOptions.output.codeSplitting`).
   - `npx vitest run` (one trivial test plus one that drives `@xterm/headless` and the serialize addon): 2 passed.
   - A real run of the compiled server: it spawns a pty, serves HTTP and a `ws` WebSocket, and hosts an MCP tool over streamable HTTP. A script then used the SDK's own client to list the tool and call it, and a `ws` client got its echo back. Output was `tools: [ 'send_message' ]`, `call : [{"type":"text","text":"queued for ben: hi"}]`, `ws echo: ping`.
3. Browser proof of the built page: served `dist/client` with `vite preview`, loaded it with `Google Chrome --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader --virtual-time-budget=8000 --dump-dom` (separate `--user-data-dir` in scratch). The page set `data-probe="pixi-and-xterm-ok"` after `await app.init()` resolved; the DOM held a 200x100 `<canvas>` and `.terminal.xterm` markup. This was the first `probe` build (same client code and same client library versions as `probe-final`; only `@types/node` differed).
4. Node 20.20.2 (reusing the installed tree): the server run, the headless xterm check, `tsc`, `vite build` and, to my surprise, `vitest run` all worked, although vitest 5.1.0 declares `engines.node` as `^22.12.0 || ^24.0.0 || >=26.0.0`. Supported or not, the trivial test passed.
5. UNVERIFIED: none of this ran on Linux.

### 1.3 Peer dependency and engine findings

At today's `latest` tags there is **no conflict**. The one real conflict you will hit is a plausible choice:

- `@types/node@^20` (natural if the floor is Node 20) fails a fresh resolve:
  `npm error code ERESOLVE ... Could not resolve dependency: peerOptional @types/node@"^22.0.0 || >=24.0.0" from vitest@5.1.0`. VERIFIED (`npm install --package-lock-only` with `"@types/node": "^20.19.0"`).
  Fix: `@types/node@^22.12.0` (resolves to 22.20.5). It satisfies vitest (`^22.0.0 || >=24.0.0`), vite (`^20.19.0 || >=22.12.0`) and `@types/ws` (`*`). VERIFIED: resolve exit 0, whole suite passed.
- `vite@7` with `@vitejs/plugin-react@6`: ERESOLVE (`peer vite@"^8.0.0" from @vitejs/plugin-react@6.3.0`). VERIFIED. Keep vite 8.
- `react-dom@19.3.1` peers `react@^19.3.1`: keep the two equal. (Read from `npm view`; I did not run a failing resolve for it.)
- Peer ranges read with `npm view <pkg> peerDependencies engines`: vitest `vite ^6.4.0 || ^7.0.0 || ^8.0.0`; vite and vitest list `@types/node` as optional; `ws` lists `bufferutil` and `utf-8-validate` as optional (not installed, `ws` works without them); the MCP SDK lists `zod` required and `@cfworker/json-schema` optional.
- Engines (`npm view`): vite 8.3.8 `^20.19.0 || >=22.12.0`; `@vitejs/plugin-react` 6.3.0 the same; vitest 5.1.0 `^22.12.0 || ^24.0.0 || >=26.0.0`; typescript 7.0.2 `>=16.20.0`; `ws` `>=10`; MCP SDK `>=18`; the `@anthropic-ai/claude-code` wrapper `>=22.0.0`; npm 12.2.2 `^22.22.2 || ^24.15.0 || >=26.0.0`.
- Node 20 reached end of life on 2026-04-30 (nodejs/Release `schedule.json`, fetched). Node 22 ends 2027-04-30, Node 24 2028-04-30, Node 26 became LTS 2026-10-28. The design's "Node 20 or newer" names an end-of-life version as its floor. The server stack does run on 20.20.2 (item 4), but the dev toolchain and the Claude npm wrapper both declare 22.
- Bundled npm per Node line (nodejs.org `index.json`): Node 22.23.5 ships npm 10.9.9, Node 24.22.3 ships npm 11.19.1, Node 26.13.1 ships npm 11.20.0. npm `latest` is 12.2.2 (`npm view npm dist-tags`).

TypeScript 7.0.2 is the native compiler: `tsc` comes from per-platform optional packages `@typescript/typescript-<os>-<cpu>`. It handled both tsconfigs above without changes. It keeps a `#!/usr/bin/env node` first line when compiling a `.ts` entry file (VERIFIED, emitted file mode is 644, which does not matter, see 2.1). Leaving out `"types": ["node"]` also compiled.

### 1.4 The four pty candidates

All four install, and all four were run with a real pty on macOS arm64. The stated differences are what the other researcher needs. Sources: `npm view`, `npm pack` of each tarball, `tar tvzf`, `strings`/ELF parsing of the Linux binaries, clean-room runs (section 2).

| | `node-pty` 1.1.0 (`latest`) | `node-pty` 1.2.0-beta.18 (`beta`) | `@lydell/node-pty` 1.1.0 (stable) | `@lydell/node-pty` 1.2.0-beta.18 (`latest`) |
|---|---|---|---|---|
| Installs (macOS arm64, npm 10.9.4, 11.16.0) | yes | yes | yes | yes |
| `pty.spawn` works after install on macOS | **no**: `Error: posix_spawnp failed.` | yes | yes | yes |
| Cause | `prebuilds/darwin-*/spawn-helper` is mode 644 in the tarball and stays 644 after install (same on npm 10 and 11). `chmod +x` fixes it (VERIFIED) | spawn-helper is 755 | platform package ships spawn-helper 755 | 755 |
| Linux prebuilt binaries | **none** (only darwin-arm64, darwin-x64, win32-arm64, win32-x64) | `prebuilds/linux-x64/pty.node`, `prebuilds/linux-arm64/pty.node` | `@lydell/node-pty-linux-x64`, `@lydell/node-pty-linux-arm64` (optionalDependencies) | same package names |
| Needs a compiler on Linux | **yes**: `scripts.install` is `node scripts/prebuild.js \|\| node-gyp rebuild`; `prebuild.js` exits 1 when `prebuilds/linux-<arch>` is missing, so `node-gyp rebuild` runs (python3, make, g++). VERIFIED by running `prebuild.js` with `process.platform`/`process.arch` overridden: exit 1 for linux-x64 and linux-arm64 | no: same script exits 0 for linux-x64 and linux-arm64 (same simulation) | no, no install scripts at all | no, no install scripts at all |
| Highest glibc symbol needed (Linux) | n/a | x64 GLIBC_2.28, arm64 GLIBC_2.28; libstdc++ GLIBCXX_3.4.22 | x64 GLIBC_2.28; **arm64 GLIBC_2.34** and GLIBCXX_3.4.21 | x64 and arm64 GLIBC_2.28 (byte-identical build IDs to the official beta.18) |
| Linked libraries (ELF NEEDED, parsed) | n/a | libutil.so.1, libstdc++.so.6, libgcc_s.so.1, libpthread.so.0, libc.so.6 (arm64 adds ld-linux-aarch64.so.1) | same family | same |
| musl (Alpine) | would compile from source | binary is glibc-only, but `process.platform` is `linux` so `prebuild.js` skips the build and the load would fail; `npm_config_build_from_source=true` forces a build | glibc-only, no `libc` field on the platform package, so npm installs it on musl too (VERIFIED with `--libc=musl`) | same |
| Install script behaviour on npm 12 | scripts skipped by default (see 1.5), which on Linux means no build at all | skipped; still works because the loader falls back to `prebuilds/<platform>-<arch>` | n/a | n/a |
| Package size (tarball / installed in the runtime toy) | 15.5 MB tarball | 7.2 MB tarball; runtime toy `node_modules` 56 MB | 14.5 KB main + about 20 to 36 KB per platform | runtime toy `node_modules` 29.6 MB |
| ESM named import in plain Node | yes (`spawn`, `fork`, `open`, `createTerminal`, `native`, `default`) | yes | yes | yes |
| TypeScript types | `typings/node-pty.d.ts`; `import * as pty from 'node-pty'` compiles under NodeNext | same | `node-pty.d.ts`; same import form compiles | same |
| Upstream | microsoft/node-pty | microsoft/node-pty (prerelease) | community fork `lydell/node-pty`, one npm maintainer, MIT | same |

Other facts:

- The loader (`lib/utils.js`) tries `build/Release`, `build/Debug`, then `prebuilds/<platform>-<arch>`. So with `--ignore-scripts` the official 1.2.0-beta.18 still loads its prebuild. VERIFIED: clean-room `npx` run with `npm_config_ignore_scripts=true` started and spawned for both beta.18 packages.
- Linux binaries were never executed. UNVERIFIED: that `pty.node` loads on Debian bookworm. Static support: every library it needs (`libstdc++.so.6`, `libgcc_s.so.1`, `libutil.so.1`, libc) exists in the `node:22-bookworm-slim` arm64 layers, and bookworm has glibc 2.36 (VERIFIED from the layers, section 3).

### 1.5 npm's install-script policy (affects every candidate and the Docker build)

VERIFIED from the docs bundled with each npm and by running them:

- npm 10.9.4 and 11.16.0 run dependency install scripts. npm 11.16.0 prints `npm warn allow-scripts N packages have install scripts not yet covered by allowScripts` after a project install. Its docs call this advisory: "A future release will block unreviewed install scripts." With `--strict-allow-scripts` (or `npm_config_strict_allow_scripts=true`) a project install of `node-pty` fails with `ESTRICTALLOWSCRIPTS`; `@lydell/node-pty` installs fine because it has no scripts. In `npx` runs on 11.16.0 the strict flag did not block anything (`npm exec --strict-allow-scripts` ran the tool).
- **npm 12.2.2 (the current `latest`) blocks dependency install scripts by default.** Its docs: "Dependency install scripts are blocked by default. Install commands silently skip lifecycle scripts for any dependency that does not have a matching entry in `allowScripts`." A project install prints `npm warn install-scripts 1 package had install scripts blocked ... node-pty@1.2.0-beta.18`, and `npx` skips them silently. Both beta.18 pty packages still started and spawned under npm 12.2.2 (clean-room `npx`), because they load prebuilt binaries at runtime. The review commands moved to `npm install-scripts ls` and `npm install-scripts approve <pkg>`.
- Consequence for the official `node-pty` 1.1.0: on Linux the compile lives in the install script. Under npm 12 it would be skipped and the module would not load. (Derived from the loader code and the policy; not run on Linux.)
- Claude Code's own npm package has a `postinstall` that links the native binary. Under npm 12 it is skipped and `claude` prints `Error: claude native binary not installed.` (documented in the troubleshooting page, section 3.3).

### 1.6 Import-form traps that tests do not catch

- **`import { Terminal } from '@xterm/headless'` fails in plain Node ESM**: `SyntaxError: Named export 'Terminal' not found. The requested module '@xterm/headless' is a CommonJS module`. It passes under vitest and under `tsc`, so unit tests will not show it. Working form (compiled by `tsc` with NodeNext and run on Node 20.20.2, 22 and 24): `import headless from '@xterm/headless'; const { Terminal } = headless;` plus `import type { Terminal as HeadlessTerminal } from '@xterm/headless'` for types. `import { SerializeAddon } from '@xterm/addon-serialize'` works as a named import. VERIFIED.
- Headless usage: `new Terminal({ cols, rows, allowProposedApi: true })`, `loadAddon(new SerializeAddon())`, `write(data, callback)`, `serialize()` returned `"hello\r\nworld"`. VERIFIED.
- A headless terminal answers terminal queries (cursor position, device attributes) through `term.onData`. A real Claude Code TUI needs those replies written back to the pty. My probe harness forwarded them (`term.onData(d => pty.write(d))`) and the TUI rendered normally. Browser xterm.js does the same when its `onData` is forwarded over the WebSocket.
- MCP SDK paths that compiled under NodeNext and ran: `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer`, `registerTool(name, { description, inputSchema: { to: z.string(), ... } }, handler)`), `.../server/streamableHttp.js` (`new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`, then `await mcp.connect(transport)` and `transport.handleRequest(req, res, parsedBody)`), client side `.../client/index.js` and `.../client/streamableHttp.js`. I tested sequential requests only, with one `McpServer` reconnected per request. Concurrent requests and one server instance per request were not tested.
- The MCP SDK brings 17 direct dependencies (`express`, `hono`, `@hono/node-server`, `jose`, `ajv`, `cors`, `zod-to-json-schema`, and others). Runtime footprint measured in a clean-room `npx` of a toy with ws, the SDK, zod, both xterm packages and a pty: about 113 package directories, `node_modules` 29.6 MB with `@lydell/node-pty` and 56.2 MB with `node-pty` 1.2.0-beta.18, installed in 4 to 6 seconds.

## 2. npm package mechanics

Toy package, built from a template in scratch (never published, name `gonogo-toy`). Exact `package.json`:

```json
{
  "name": "gonogo-toy",
  "version": "0.0.1",
  "description": "toy package to test npm mechanics",
  "type": "module",
  "bin": { "gonogo-toy": "bin/cli.js" },
  "files": ["bin", "client"],
  "engines": { "node": ">=20" },
  "scripts": { "prepack": "node scripts/build-client.mjs" },
  "dependencies": { "ws": "^8.23.0" }
}
```

Plus a `.gitignore` containing `client/`, a `scripts/build-client.mjs` that writes `client/index.html`, and `bin/cli.js` (ESM, top-level await): it loads a pty library, spawns `/bin/sh -c 'echo pty-ok'`, then serves `client/index.html` and a `ws` server on `--port` (0 = any) and prints `gonogo-toy listening on http://127.0.0.1:<port>`.

### 2.1 Findings (VERIFIED, npm 11.16.0 on Node 24.18.0 unless stated)

- `bin`: an object mapping the command name to the file. `npx` infers the command when there is a single bin.
- `files`: an allowlist that wins over `.gitignore`. `client/` is gitignored and absent from the source tree, yet `npm pack` shipped it. `npm pack` output: `bin/cli.js`, `client/index.html`, plus `package.json` (3 files).
- `prepack`: ran on `npm pack` (`> gonogo-toy-sb644@0.0.1 prepack`, then `prepack: built client/index.html`) before the tarball was assembled. `npm pack --pack-destination <dir>` keeps tarballs out of the source tree.
- `type: "module"`: `bin/cli.js` with `import` and top-level await ran on Node 20.20.2, 22.21.1 and 24.18.0.
- **Shebang: required. Executable bit: not required.** Four variants packed and run through `npx file:<tgz>`:

  | variant | mode in tarball | mode after install | result |
  |---|---|---|---|
  | shebang, source 644 | 644 | 755 | started |
  | shebang, source 755 | 755 | 755 | started |
  | no shebang, source 755 | 755 | 755 | failed: the bin is run by `sh`, `.../.bin/gonogo-toy-nosb755: line 1: import: command not found` |
  | no shebang, source 644 | 644 | 755 | same failure |

  `npm pack` keeps source file modes in the tarball; npm sets 755 on bin targets at install.
- `engines`: a mismatch only warns. Toy with `"node": ">=22.12.0"` under Node 20.20.2 printed `npm warn EBADENGINE Unsupported engine { package: 'gonogo-toy-eng22@0.0.1', required: { node: '>=22.12.0' }, current: { node: 'v20.20.2', npm: '11.16.0' } }` and still started. With `engine-strict=true` the install fails with `npm error code EBADENGINE`. To refuse old Node with a readable message the bin must check `process.versions.node` itself before any static import that needs a newer Node.
- How to run a tarball through npx. Working: `npx --yes file:/abs/path/pkg.tgz [args]` and `npx --yes --package=/abs/path/pkg.tgz <bin-name> [args]`. **Not working**: `npx /abs/path/pkg.tgz` treats the path as a command (`sh: ...tgz: Permission denied`). Packages land in `<cache>/_npx/<hash>/node_modules/`.
- Global install from a tarball (the step the Dockerfile uses): `npm install -g --prefix <dir> a.tgz b.tgz` on Node 22.21.1 / npm 10.9.4 with no compiler on PATH installed both (`added 202 packages in 3s`), created `bin/<name> -> ../lib/node_modules/<pkg>/bin/cli.js`, and the command ran.

### 2.2 Clean-room test

Method (script `cleanroom.sh` in scratch): fresh empty working directory, fresh `HOME`, fresh empty npm cache, `env -i` with **`PATH` holding only a symlink to `node` plus `/bin`**, so `cc`, `make` and `python3` were not reachable and a `node-gyp rebuild` would have failed. Command shape:

```
env -i HOME=<fresh> PATH=<dir with only node>:/bin npm_config_cache=<fresh> \
  node <npm>/bin/npx-cli.js --yes --foreground-scripts --loglevel=info file:<abs tgz> --port 0
```

Then wait for the `listening on` line, `curl` the URL, kill the process group, and read the log. `--foreground-scripts --loglevel=info` shows every lifecycle script (`npm info run node-pty@... install ...`) and any `gyp info` line.

Results (macOS arm64; "started" means the server printed its URL, curl returned the page built by `prepack`, and the pty line `pty via <package>: "pty-ok"` appeared):

| pty dependency of the toy | Node 24.18.0 / npm 11.16.0 | Node 22.21.1 / npm 10.9.4 | Node 20.20.2 / npm 11.16.0 | Node 24.18.0 / npm 12.2.2 |
|---|---|---|---|---|
| `node-pty` 1.1.0 | not started: `Error: posix_spawnp failed.` | same | same | not run |
| `node-pty` 1.2.0-beta.18 | started | started | started | started (install scripts skipped) |
| `@lydell/node-pty` 1.1.0 | started | started | started | not run |
| `@lydell/node-pty` 1.2.0-beta.18 | started | started | started | started |

- **No compiler was needed on macOS.** In every log there were 0 `gyp info` and 0 `gyp ERR` lines. For `node-pty` the log shows `npm info run node-pty@1.2.0-beta.18 install node_modules/node-pty node scripts/prebuild.js || node-gyp rebuild`, then `> Checking prebuilds...`, then `{ code: 0, signal: null }`: the prebuild check passed and the `node-gyp rebuild` branch never ran. (A naive `grep -i 'node-gyp rebuild'` counts 1 hit; that is the script text, not a build.)
- UNVERIFIED on Linux. Derived: official 1.1.0 needs python3, make and g++ there; 1.2.0-beta.18 and `@lydell` do not.
- Other settings tried on the same toys (npm 11.16.0, Node 24): `npm_config_ignore_scripts=true` started both beta.18 packages with 0 scripts run; `--allow-scripts=node-pty` with strict mode started; plain strict mode started under `npx` (not enforced there, see 1.5).

## 3. Docker image

### 3.1 What could and could not be checked

UNVERIFIED (no daemon): `docker build`, `docker run`, `claude --version` inside the image as the non-root user, node-pty loading inside the image, the built image size, bind-mount permissions on the owner's Lima-backed Docker.

VERIFIED without the daemon: Docker Hub registry API calls over HTTPS with `curl` (token, manifests, config blobs, the five layer blobs of `node:22-bookworm-slim` for arm64, then `tar tzf` and selective extraction), Anthropic's apt repository metadata and the arm64 and amd64 `.deb` files, the npm packages, ELF parsing, and a syntax lint of the Dockerfile with `dockerfile-utils` (it flags `RUNN`, a bad `COPY` and a bad `EXPOSE` on a deliberately broken file, and reports nothing on `Dockerfile.probe`; syntax only).

### 3.2 Base image: Debian slim, not Alpine

Registry facts (VERIFIED, `https://registry-1.docker.io/v2/library/node/manifests/...` with an anonymous pull token):

- `node:22-bookworm-slim` and `node:22-slim` resolve to the same digests today. Both `linux/amd64` and `linux/arm64/v8` exist. Also present: `node:24-bookworm-slim`, `node:22-trixie-slim`, `node:20-bookworm-slim`, `node:22-alpine`.
- `node:22-bookworm-slim` arm64: 5 layers, 76 MiB compressed, 252,147,712 bytes (240 MiB) unpacked as tar. `NODE_VERSION=22.23.5`, `YARN_VERSION=1.22.22`, npm 10.9.9, glibc `GNU C Library (Debian GLIBC 2.36-9+deb12u14)`. amd64 compressed total is also 76 MiB. For comparison: `node:22-alpine` arm64 58 MiB compressed, `node:24-bookworm-slim` arm64 77 MiB, `node:22-trixie-slim` arm64 78 MiB.
- Default user is root (no `USER`). A `node` user exists: `node:x:1000:1000::/home/node:/bin/bash`, group `node:x:1000`.
- Present in the layers: `bash`, `libstdc++.so.6`, `libgcc_s.so.1`, `libutil.so.1`, `/usr/local/bin/node`, npm, yarn, `docker-entrypoint.sh`. **Absent: `git`, `curl`, `/etc/ssl/certs/ca-certificates.crt`, `openssl`, `ps`, `rg`, `python3`, `make`.**
- Debian package versions (sources.debian.org API): bookworm git 2.39.5, glibc 2.36-9+deb12u14; trixie git 2.47.3, glibc 2.41.

Why not Alpine, from verified facts: the Claude binary has musl builds (so Claude itself would run on Alpine 3.19+, docs), but the node-pty prebuilds and every `@lydell/node-pty-linux-*` package link against glibc (`libc.so.6`, `libstdc++.so.6`, `libgcc_s.so.1`, `libutil.so.1`) and neither package marks itself glibc-only, so npm installs them on musl and they fail to load; official 1.2.0-beta.18 would need `npm_config_build_from_source=true` plus a toolchain. Alpine's saving is about 18 MiB compressed against a roughly 350 MiB Claude binary. The musl behaviour itself is UNVERIFIED (derived).

Node line: Node 22 is in maintenance until 2027-04-30; `node:24-bookworm-slim` exists for both architectures if the owner prefers a longer horizon. The Dockerfile takes the image as `ARG NODE_IMAGE`.

### 3.3 Installing the `claude` CLI

Official page `https://code.claude.com/docs/en/setup.md` (fetched 2026-11-16). Supported methods: native installer, Homebrew cask, WinGet, Linux package managers (apt, dnf, apk), npm. The binary is named `claude` in every method. System requirements: Ubuntu 20.04+, Debian 10+, Alpine 3.19+, 4 GB RAM or more, x64 or ARM64. For musl, `bash` and `curl` are needed.

| Method | Exact command or package | Facts |
|---|---|---|
| npm | `npm install -g @anthropic-ai/claude-code@2.1.325` | Wrapper package (7 files, 208 KB), `bin: { "claude": "bin/claude.exe" }`, `engines.node >=22.0.0`, `postinstall: node install.cjs`. The binary comes from a per-platform optional dependency (`@anthropic-ai/claude-code-linux-x64`, `-linux-arm64`, `-linux-x64-musl`, `-linux-arm64-musl`, ...) that carries `os`, `cpu` and `libc` fields, so npm picks glibc or musl itself. Platform packages are 365,843,546 bytes unpacked (x64) and 364,701,706 (arm64). `install.cjs` **hard-links** the binary onto `bin/claude.exe` (copy only on `EXDEV` or `EPERM`), so there is one copy on disk when both paths sit on the same layer; do not `COPY` the installed directory between stages. The docs recommend exactly this method for pinned dev containers ("install it from your Dockerfile with `npm install -g @anthropic-ai/claude-code@X.Y.Z`" and set `DISABLE_AUTOUPDATER` to `1`). Do not use `--ignore-scripts`; npm 12 skips the postinstall by default (docs, "Fix an npm 12 install"). Verified at 2.1.325 from `npm view` and the tarball contents. |
| native installer | `curl -fsSL https://claude.ai/install.sh \| bash -s 2.1.325` (also `stable`, `latest`) | Script read, not executed. Downloads `https://downloads.claude.ai/claude-code-releases/<version>/<platform>/claude.zst` when `zstd` exists, otherwise `.../claude`, checks the SHA256 from `manifest.json`, then runs `claude install`, which sets up `~/.local/bin/claude` (symlink into `~/.local/share/claude/versions/`). Needs `curl` or `wget`, `bash`, writes `~/.claude/downloads` during install, and about 512 MB of free memory (its OOM message). Auto-updates by default. In a container, with a state volume under the home, it fights the volume. |
| apt | repository `https://downloads.claude.ai/claude-code/apt/stable` (or `/latest`), signing key `https://downloads.claude.ai/keys/claude-code.asc` (fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`), `apt install claude-code` | Package `claude-code`, `Depends: libc6 (>= 2.17)` and nothing else. The `latest` channel newest is `2.1.325-1`, arm64 `.deb` 171,658,004 bytes (SHA256 `ef91299d...c68c` matches the index), Installed-Size 356,153 KB. The `stable` channel newest is 2.1.311-1 (134 MB). VERIFIED by downloading both `.deb` files: the package holds exactly `/usr/bin/claude` (364,701,112 bytes arm64, 365,842,960 amd64) and a copyright file, no maintainer scripts. Needs `curl`, `gnupg`, `ca-certificates` at build time. |

ELF facts for the 2.1.325 binary (parsed with a 40-line Python ELF reader over the `.deb` contents, VERIFIED): `ELF 64-bit ... dynamically linked`, interpreter `/lib/ld-linux-aarch64.so.1` (arm64) or `/lib64/ld-linux-x86-64.so.2` (x64), NEEDED `librt, libc, ld-linux, libpthread, libdl, libm` only, **highest glibc symbol version 2.17** on both. No libstdc++. The binary is about 348 MiB, so any image carries that.

Recommendation, from these facts: npm global install with a pinned version in the runtime stage (no extra packages, same method the docs name for containers), followed immediately by `claude --version` so a skipped postinstall fails the build. Fall back to apt if a future npm default breaks the npm route. `DISABLE_AUTOUPDATER=1` in the image environment (documented: "Set to 1 to disable automatic background updates. Manual `claude update` still works"; `DISABLE_UPDATES=1` blocks both). With a root-owned npm global directory and a non-root runtime user, auto-update could not write anyway; the docs say Claude shows a one-time notice in that case.

`claude --version` inside the container as the non-root user: **UNVERIFIED**. The Dockerfile runs it twice (as root right after install, as `node` before `VOLUME`).

### 3.4 Packages the image needs

- Needed: `git` (agents work in repositories; absent from the base) and `ca-certificates` (HTTPS for git and npm; absent from the base; apt installs it only as a recommend, so ask for it explicitly with `--no-install-recommends`). VERIFIED absent from the layers; Debian bookworm git is 2.39.5.
- Not needed by Claude itself: the binary needs only libc6 (>= 2.17) and `bash` (present). It bundles `ripgrep` (docs: "ripgrep: usually included with Claude Code").
- Not needed for hooks: Claude Code has a native HTTP hook type (`"type": "http"`, hooks reference), so the image needs no `curl` for gonogo's hook posts. The design says "hooks (HTTP POST)", which this supports directly.
- Optional extras, only if you want agents to have them: `curl`, `openssh-client` (git over SSH), `ripgrep` is already inside Claude, `procps`, `jq`, `python3`, `build-essential`.
- `git config --system --add safe.directory '*'` is in the Dockerfile because a bind-mounted `/projects` is usually owned by a different uid, and git refuses such repositories otherwise. It is git's `safe.directory` ownership check; I did not reproduce the refusal here. UNVERIFIED.

### 3.5 Non-root user, home, volumes

- Claude Code refuses `bypassPermissions` as root: `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons` (permission-modes doc, "skipped automatically inside a recognized sandbox"). Docs-only; I could not run as root on this host. The image uses the existing `node` user (uid and gid 1000, home `/home/node`).
- Claude state: the dev container doc says `~/.claude` holds the token, user settings and session history and a **separate file `~/.claude.json`** holds account details, personal MCP servers and per-project trust; to keep both, set `CLAUDE_CONFIG_DIR` to the volume path, which makes Claude write `.claude.json` inside it ("If Claude Code repeats first-launch setup after each rebuild... check that `containerEnv`... sets `CLAUDE_CONFIG_DIR`"). VERIFIED by experiment too (section 4.2, run 13): with `CLAUDE_CONFIG_DIR=<dir>` and an empty `HOME`, Claude read `<dir>/.claude.json` and `<dir>/settings.json`, and created `backups`, `cache`, `plugins`, `sessions` inside `<dir>`. It still wrote `~/.local/state/gh/device-id` under `HOME`; harmless.
- Volumes the design asked for: one state volume mounted at `/state` (holding `claude/` as `CLAUDE_CONFIG_DIR` and `gonogo/` as the gonogo home) and one projects volume at `/projects` (the working directory, so the boss starts there). A named volume copies the image's ownership on first use, so the image does `mkdir -p /state /projects && chown node:node ...`. For a bind mount the host's ownership applies; on the owner's macOS Docker that may need `--user`. UNVERIFIED.
- `docker run --init` is recommended: commands that Claude's tools leave behind are re-parented to PID 1, and Node as PID 1 does not reap such orphans, so zombies pile up without an init. Standard Linux behaviour, not tested here. UNVERIFIED.
- The URL with the access token is printed by the server; inside a container the server listens on `0.0.0.0`, so it must print a host-visible URL rather than the bind address. A builder item, nothing to verify.
- Credentials in the container environment are readable by every agent shell. Claude Code documents `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` to strip credentials from Bash, hook and stdio-MCP subprocess environments; on Linux it also puts Bash subprocesses in an isolated PID namespace, which may not be permitted inside an unprivileged container. UNVERIFIED either way.

### 3.6 Prebuilt node-pty binaries for Linux

See the table in 1.4. In short, for **linux-x64 and linux-arm64**: `node-pty` 1.1.0 has none; `node-pty` 1.2.0-beta.18 has `prebuilds/linux-x64/pty.node` (71,784 bytes) and `prebuilds/linux-arm64/pty.node` (69,096 bytes), both `ELF 64-bit LSB shared object` for the right CPU, max GLIBC 2.28; `@lydell/node-pty` has `@lydell/node-pty-linux-x64` and `@lydell/node-pty-linux-arm64` at 1.1.0 (arm64 needs GLIBC 2.34) and at 1.2.0-beta.18 (GLIBC 2.28). The owner's Docker is arm64: `node:22-bookworm-slim` arm64 has glibc 2.36, enough for all of them. Ubuntu 20.04 (glibc 2.31) would not run `@lydell/node-pty` 1.1.0 on arm64. Loading inside a container: UNVERIFIED.

### 3.7 Image size

UNVERIFIED (not built). Components, each VERIFIED: base 76 MiB compressed or 240 MiB unpacked; Claude binary 364.7 MB (348 MiB) unpacked, `.deb` 171.7 MB compressed. Git, CA bundle and their libraries are an estimate of 40 to 50 MiB, and gonogo with production dependencies is an estimate of 30 to 60 MiB (see the runtime footprints in 1.6). So roughly 650 to 700 MiB unpacked and roughly 280 to 300 MiB compressed. Treat these as estimates until `docker image ls` runs.

## 4. Signing in inside a container

### 4.1 What the docs say (official, fetched 2026-11-16)

`https://code.claude.com/docs/en/authentication.md`:

- Precedence when several credentials exist: cloud provider variables, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then Anthropic profiles, then subscription OAuth from `/login`. So with both set, the API key wins. Set one.
- `CLAUDE_CODE_OAUTH_TOKEN`: "A long-lived OAuth token generated by `claude setup-token`. Use this for CI pipelines and scripts where browser login isn't available." `claude setup-token` makes a one-year token, prints it, saves nothing; it needs a Pro, Max, Ultra, Team or Enterprise plan; it can only make model requests (no Remote Control, no claude.ai connectors; locally configured MCP servers still work). Bare mode does not read it. env-vars page: "Takes precedence over keychain-stored credentials", and `/login` while it is set switches the session.
- `ANTHROPIC_API_KEY`: "In interactive mode, you are prompted once to approve or decline the key, and your choice is remembered... In non-interactive mode (`-p`), the key is always used when present."
- Login prompt skip: the page lists two cases where first launch skips the login prompt, an approved `ANTHROPIC_API_KEY` and an earlier sign-in (including a dev container whose credentials live in a volume). It does not list `CLAUDE_CODE_OAUTH_TOKEN` among them. "Older version: before v2.1.290, the prompt appeared during setup whether or not you were signed in."
- `/logout` "resets your first-launch setup state". The dev container page says `~/.claude.json` holds "its record that you completed setup". No settings key for "skip first-launch setup" is documented, and the key names `hasCompletedOnboarding` and `customApiKeyResponses` appear nowhere in the 19 documentation pages I fetched (checked with `grep -l` over all of them).
- **Documented ways to skip dialogs:**
  - `IS_DEMO` (env-vars page): "Set to any non-empty value, such as `1`, to enable demo mode: hides your email and organization name from the header and `/status` output, and skips onboarding. Setting it to `0` or `false` still enables demo mode; unset the variable to turn it off."
  - `projects["<path>"].hasTrustDialogAccepted = true` in `~/.claude.json` for the workspace trust dialog (permissions page, "trust it by hand").
  - `skipDangerousModePermissionPrompt: true` for the bypass warning, scope "User, local, or managed, and files passed with `--settings`".
  - `apiKeyHelper` (settings reference): "Run your own command to produce the credential Claude Code sends with model requests", any settings file, sent as `X-Api-Key` and `Authorization: Bearer`. A configured helper is not an environment key, so no approval prompt (see 4.2, runs k1 and k2).
  - The `theme` setting (any settings file, default `dark`) exists but does not skip the picker (run 14).
- Trust matters for hooks: hooks page, "Workspace trust": in an interactive session Claude Code "holds back hooks from every settings file, including your own `~/.claude/settings.json`, until you accept the workspace trust dialog for the folder, or for a parent directory whose trust extends to it". Trust keys on the git repository root, or on the starting directory outside a repository, and covers subdirectories except nested repositories. Starting in the home directory never persists trust.

### 4.2 What the TUI actually did (VERIFIED by experiment, host only)

Method: Claude Code 2.1.325, macOS arm64, run in a pty from Node (`@lydell/node-pty`) with the screen text read from an `@xterm/headless` buffer. Each run used a **fresh scratch `HOME`**, `TERM=xterm-256color`, a whitelisted environment (no inherited `CLAUDE_CODE_*`, no `CLAUDECODE`), `DISABLE_AUTOUPDATER=1`, a scratch `TMPDIR`, and **fake credentials** (`CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKE...`, `ANTHROPIC_API_KEY=sk-ant-api03-FAKE...`, or an `apiKeyHelper` that prints a fake key). No prompt was ever submitted, so no model request was made. The server rejected the fake token with 401 (the REPL showed `Remote managed settings failed to load (authentication rejected (401))`), which is an artefact of the fake token.

First-run dialogs, by what was set up:

| Run | Setup | What appeared |
|---|---|---|
| 1 | empty `HOME`, fake OAuth token | `Welcome to Claude Code v2.1.325 ... Choose the text style that looks best with your terminal` (theme picker, default `Dark mode`). **A token does not skip it.** |
| 2 | Enter on the theme | `Select login method: 1. Claude account with subscription 2. Anthropic Console account 3. 3rd-party platform`. **With a fake token the login screen still appears.** |
| 14 | `~/.claude/settings.json` = `{"theme":"dark","skipDangerousModePermissionPrompt":true}` | Theme picker still appears. The `theme` setting does not skip it. |
| 16 | **`IS_DEMO=1`**, empty `HOME`, fake OAuth token, nothing seeded | REPL directly: no theme picker, no login screen, **no trust dialog**, footer `manual mode on`. `.claude.json` recorded `hasTrustDialogAccepted: false` for the cwd, so the folder is still untrusted. |
| 17 | `IS_DEMO=1`, empty `HOME`, fake `ANTHROPIC_API_KEY`, nothing seeded | REPL directly, no key-approval dialog, but the footer says `Not logged in · Run /login`: **the dialog is skipped and the key is not approved, so it is not used.** |
| 18 | `IS_DEMO=1`, trust seeded, `--permission-mode bypassPermissions`, no skip key | REPL, footer `bypass permissions on`: **`IS_DEMO=1` also skips the bypass warning.** |
| 3 | `.claude.json` = `{"hasCompletedOnboarding": true}`, fake token | Theme and login both skipped; straight to `Accessing workspace: <cwd> / Quick safety check: Is this a project you created or one you trust? / ❯ No, exit / Yes, I trust this folder`. **Default is "No, exit".** |
| 4 | plus `projects["<cwd>"].hasTrustDialogAccepted: true` | The REPL: banner, `❯` prompt, footer `manual mode on`. `.claude.json` kept both seeded keys. |
| 5 | as 4, `--permission-mode bypassPermissions`, no skip key | `WARNING: Claude Code running in Bypass Permissions mode ... ❯ No, exit / Yes, I accept` |
| 6 | as 5 plus `{"skipDangerousModePermissionPrompt": true}` in `~/.claude/settings.json` | REPL, footer `bypass permissions on`. |
| 15 | as 5, key only in a file passed as `--settings <file>`, no user settings file | REPL, footer `bypass permissions on`; no `settings.json` was written to `HOME`. A per-agent generated settings file can carry it with no global side effect. |
| 7 | `ANTHROPIC_API_KEY` (fake), onboarding and trust seeded | `Detected a custom API key in your environment / ANTHROPIC_API_KEY: sk-ant-...AKEFAKEFAKE-FAKEAAAA / Do you want to use this API key? / Yes / ❯ No (recommended)`. **Default is "No".** |
| 8 | answered Yes (Up, Enter) | `.claude.json` gained `"customApiKeyResponses":{"approved":["<last 20 characters of the key>"],"rejected":[]}`. REPL header `Opus 5.5 · API Usage Billing`, a one-time banner `Auto mode is now Claude Code's default permission mode`, footer `auto mode on`. |
| 9 | seed `customApiKeyResponses.approved` by hand with `--permission-mode default`, then `acceptEdits` | No dialog. Footers `manual mode on` and `accept edits on`. |
| k1, k2 | no API key in the environment; `apiKeyHelper` (a script that touches a marker and prints a fake key) in a `--settings` file; k1 with `hasCompletedOnboarding` seeded, k2 with `IS_DEMO=1`; trust seeded in both | No dialog, header `Opus 5.5 · API Usage Billing`, no `Not logged in`, and the helper ran at startup (marker file created). A documented, dialog-free API-key route. |
| 10, 11, 12 | trust key: git repo root with cwd `repo/sub`; the cwd `repo/sub` itself; a plain parent with cwd `parent/child` | No trust dialog in any of the three. So a key for the exact cwd works, and a key for an ancestor works. |
| 13 | `CLAUDE_CONFIG_DIR=<dir>` holding `.claude.json` and `settings.json`, empty `HOME`, bypass mode | REPL with bypass on; the dialogs honoured the files in `<dir>`. |

Hooks are gated by trust (a SessionStart hook in a `--settings` file that touches a marker; fake token; HOME fresh each time):

| Run | `.claude.json` seed | `IS_DEMO` | Screen | Hook ran |
|---|---|---|---|---|
| h1 | none | 1 | REPL, no dialog | **no** |
| h2 | onboarding and trust | unset | REPL | yes |
| h3 | onboarding only | unset | trust dialog waiting | no |
| h4 | trust only | 1 | REPL, no dialog | yes |

This matches the hooks page ("holds back hooks from every settings file ... until you accept the workspace trust dialog") and extends it: the rule also holds for a file passed with `--settings`, and `IS_DEMO=1` hides the trust dialog without trusting the folder, so a folder reached that way has **silent hooks**. (My first round of h-runs used an unquoted marker path containing a space and proved nothing; the table is from the corrected re-runs.)

Answers to the questions asked:

- **Does the TUI show first-run dialogs even when a token is present?** Yes. With a fake token and a fresh config: the theme picker, then the login-method screen (runs 1, 2); once onboarding is marked complete, the workspace trust dialog (run 3); with `ANTHROPIC_API_KEY` also the key-approval dialog (run 7); with bypass mode also the bypass warning (run 5). UNVERIFIED: whether a *valid* `CLAUDE_CODE_OAUTH_TOKEN` skips the login-method screen. The docs do not promise it, and I cannot test with a real token without spending the subscription. Both `IS_DEMO=1` and the seeded `hasCompletedOnboarding` make the question moot.
- **Is there a documented way to skip them?** Yes: `IS_DEMO=1` skips the theme picker, the login screen, the trust dialog, the bypass warning and the key-approval dialog (runs 16, 17, 18). It is documented as "skips onboarding", and it has costs: it hides the account email and organization in the header and `/status`, it does not record trust (hooks stay silent, h1), and it does not approve an environment API key (run 17). Other documented pieces: `projects["<path>"].hasTrustDialogAccepted`, `skipDangerousModePermissionPrompt` (also via `--settings`), `apiKeyHelper` (also via `--settings`), `CLAUDE_CONFIG_DIR` plus a state volume. **Undocumented but verified on 2.1.325**: `hasCompletedOnboarding: true` (skips theme and login, leaves the trust dialog) and `customApiKeyResponses.approved: ["<last 20 characters of the API key>"]` (skips the key-approval dialog). Treat those two as internal and keep them in one place (the design already says affected code is kept in one place).
- Every dialog defaults to the safe option (`No, exit` or `No (recommended)`). Pressing Enter blindly exits Claude or rejects the key. A server that detects a dialog should answer it deliberately or, better, arrange for none to appear. Detection is possible from the screen text (the headless terminal's lines matched strings like `Choose the text style`, `Select login method`, `Quick safety check`, `Bypass Permissions mode`, `Detected a custom API key`).
- **Permission mode must be passed explicitly.** Without a flag the TUI started in `manual` with the fake OAuth token (run 4) but in `auto` with an API key (runs 8, k1; the docs say the built-in default for interactive sessions is `auto` from v2.1.283 when auto mode is available). `--permission-mode default|acceptEdits|bypassPermissions` produced `manual mode on`, `accept edits on`, `bypass permissions on` (runs 5, 6, 9). The design's three modes map directly onto these flags.
- A real Linux container run of any of this is UNVERIFIED. The seeds are plain files and the flags are the same binary, so I expect the same behaviour, but Linux was not run.

Recipe that uses only documented mechanisms (every piece VERIFIED above, with fake credentials, on the host):

1. For a subscription token: spawn `claude` with `CLAUDE_CODE_OAUTH_TOKEN` in its environment, `IS_DEMO=1`, `--permission-mode <mode>`, and `--settings <per-agent file>`; before spawning, make sure `projects["<cwd>"].hasTrustDialogAccepted` is `true` in `$CLAUDE_CONFIG_DIR/.claude.json` (merge, do not overwrite). Hooks in the per-agent file then run (h4).
2. For an API key: do not put it in the child's environment as `ANTHROPIC_API_KEY` (that triggers the approval dialog, or `Not logged in` under `IS_DEMO=1`). Pass it through `apiKeyHelper` in the per-agent settings file (k1, k2); the helper can read it from a variable with another name or from a file in the state volume. If `ANTHROPIC_API_KEY` must be used as is, seed `customApiKeyResponses.approved` (undocumented, run 9).
3. Without `IS_DEMO=1` (for example in `npx` mode, where the user already completed onboarding): the trust dialog, and for bypass mode the warning, will appear in the terminal for the user to answer; `--settings` with `{"skipDangerousModePermissionPrompt": true}` removes only the second one without touching the user's own files (run 15).

Undocumented fallback seed, if `IS_DEMO=1` is not acceptable (it hides account info and affects every Claude child):

```json
{
  "hasCompletedOnboarding": true,
  "customApiKeyResponses": { "approved": ["<last 20 characters of ANTHROPIC_API_KEY>"], "rejected": [] },
  "projects": { "/abs/working/dir": { "hasTrustDialogAccepted": true } }
}
```

Caveats: Claude rewrites `.claude.json` on every start (adding `userID`, `machineID`, `numStartups`, `projects.*`, backups under `backups/`), so a seeding step must merge and write atomically, and several running agents share the file. Whether concurrent writers can lose each other's keys was not tested. In `npx` mode `~/.claude.json` is the owner's real file; writing trust keys there is a global side effect, so the design's current plan (the user answers the trust dialog in the terminal) is the conservative route for that mode.

## 5. Recommended Dockerfile and run command

File: `docs/facts/Dockerfile.probe` (multi-stage). Syntax-linted only; never built. Summary of the choices, each tied to a fact above:

- Stage `build`: `npm ci`, then `npm pack --pack-destination /out`. The runtime stage installs that tarball, so the container runs the same artifact as `npx gonogo` and a packaging error fails the build.
- Stage `runtime`: `ARG NODE_IMAGE=node:22-bookworm-slim`; `apt-get install --no-install-recommends ca-certificates git`; `npm install -g @anthropic-ai/claude-code@2.1.325 && claude --version`; `npm install -g /tmp/*.tgz`; `mkdir -p /state /projects && chown node:node`; `ENV HOME=/home/node CLAUDE_CONFIG_DIR=/state/claude GONOGO_HOME=/state/gonogo DISABLE_AUTOUPDATER=1`; `USER node`; a build-time `RUN` that runs `claude --version` and spawns a shell through whichever pty package is installed, as `node`; `VOLUME ["/state", "/projects"]`; `EXPOSE 7777`; `ENTRYPOINT ["gonogo"]` with `--host 0.0.0.0 --port 7777 --home /state/gonogo`. `GONOGO_HOME` and the CLI flags are placeholders.
- Layer order puts the 350 MiB Claude layer before the gonogo layer so a code change does not rebuild or re-push it.
- `IS_DEMO=1` is deliberately not in the image `ENV`. It belongs to the environment the gonogo server gives each `claude` child (section 4.2, recipe), together with the trust seeding and the per-agent `--settings` file. Setting it image-wide would hide the account in every `claude` started inside the container and would make a plain `-e ANTHROPIC_API_KEY` end in `Not logged in`.

Run command (UNVERIFIED because never run; it is also in the Dockerfile header):

```
docker run -d --name gonogo --init \
  -p 127.0.0.1:7777:7777 \
  -e CLAUDE_CODE_OAUTH_TOKEN \
  -v gonogo-state:/state \
  -v "$PWD/projects":/projects \
  gonogo:probe
docker logs gonogo
```

`-e NAME` with no value forwards the host's variable, so the token is not typed into the command line or shell history (it is still visible in `docker inspect`). For an API key the plain `-e ANTHROPIC_API_KEY` is **not enough** by itself: Claude would show the approval dialog (default "No") or, under `IS_DEMO=1`, run as `Not logged in`. The server has to route the key through `apiKeyHelper` or seed the approval (4.2, recipe step 2). Set one credential, never both (the API key wins by the documented precedence).

The first thing to run once the daemon is up:

```
docker build -t gonogo:probe .
docker run --rm --entrypoint claude gonogo:probe --version
docker run --rm --entrypoint id gonogo:probe
docker image ls gonogo:probe
```

## 6. What this changes in the design

- The pty library is not a free choice among equals: `node-pty` 1.1.0 (the `latest` tag) breaks both promises in the design, "installs without a compiler" on Linux and a working spawn on macOS. Candidates that pass are `@lydell/node-pty` (1.1.0 or 1.2.0-beta.18) and `node-pty` 1.2.0-beta.18; the third-party fork and the prerelease are the trade-offs. Versions differ in the glibc floor (1.2.0-beta.18: 2.28; `@lydell/node-pty` 1.1.0 on arm64: 2.34).
- Node 20 as the floor is end of life, and the dev tools and Claude's npm wrapper declare Node 22. The runtime stack does run on 20.20.2.
- The design's note that the first run "shows Claude Code's trust question" understates it. In a fresh home Claude Code blocks on up to five dialogs that default to "No": theme, login method, workspace trust, bypass-permissions warning and API-key approval. The documented switch `IS_DEMO=1` skips all of them, but then **hooks stay silent** until `projects["<cwd>"].hasTrustDialogAccepted` is `true` (documented key). So the server needs a seeding step before every agent start (trust for the working directory), must pass `--permission-mode` explicitly (the built-in default is `auto` in some setups), and should pass credentials as in 4.2.
- A server that cannot prevent a dialog can still detect it: the screen text is readable from a headless terminal, and every dialog has distinctive text. Never answer by blind Enter.
- Cross-reference: `docs/facts/claude-code-hooks-mcp.md` lists as UNVERIFIED "the workspace-trust gate on hooks", "the bypassPermissions warning dialog" and "`skipDangerousModePermissionPrompt` from `--settings`" because its runs were all `-p`. This file verifies them in the interactive TUI on 2.1.325: hooks from a `--settings` file are held back until trust is recorded (h1 to h4), the bypass warning appears and defaults to "No, exit" (run 5), and the key suppresses it from a `--settings` file (run 15). It also agrees that `--permission-mode` must always be passed.
- `CLAUDE_CONFIG_DIR` inside the state volume is the documented way to persist all Claude state, including `.claude.json`. Verified: with it set, Claude reads `settings.json` and `.claude.json` from that directory and keeps its `backups`, `cache`, `plugins` and `sessions` there.
- npm 12 blocks install scripts by default. The beta.18 pty packages and `@lydell` survive because they load prebuilds; Claude's own npm postinstall does not, so the image must run `claude --version` at build time (it does) or install Claude another way (apt has no install scripts).
- The image will be about 650 to 700 MiB because of the 348 MiB Claude binary. Nothing in gonogo can shrink that.
- `@xterm/headless` cannot be imported by name from compiled ESM (1.6); tests under vitest will not notice.
- `zod`, `@types/react` and `@types/react-dom` must be added to the dependency list given in the task.

## 7. UNVERIFIED, collected

1. Everything that needs the Docker daemon: build, run, `claude --version` as the non-root user, node-pty loading in the image, image size, bind-mount permissions on the owner's Docker, the `safe.directory` and `--init` behaviour.
2. Any execution on Linux: `pty.node` loading, TypeScript 7 and rolldown native binaries in the build stage, Alpine behaviour.
3. Whether a valid (non-fake) `CLAUDE_CODE_OAUTH_TOKEN` changes which first-run screens appear, and what a valid key does under `apiKeyHelper` (all runs used fake credentials).
4. Concurrency of several Claude processes and a seeding step writing the same `.claude.json`.
5. Whether `bypassPermissions` refuses root in a container (docs only), and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` inside an unprivileged container.
6. The stability of `hasCompletedOnboarding` and `customApiKeyResponses` (undocumented keys) and of `IS_DEMO`'s exact skip list across Claude Code versions; all checked on 2.1.325 only.
7. MCP SDK concurrency (one server instance per request) and Windows.

## 8. Real `claude` runs

- `command claude --version`, once, on the host: `2.1.325 (Claude Code)`.
- Thirty-one launches of the interactive TUI (`/opt/homebrew/bin/claude`, the same binary as `command claude`), all with fake credentials in scratch homes, none inside a container (Docker was down), none with a prompt submitted. Count: runs 1 to 8 (8), run 9 for two modes in two passes (4), runs 10 to 12 (3), runs 13 to 15 (3), runs 16 to 18 (3), hook gating runs h1 to h4 plus a re-run of h2 and a second re-run of h1, h3, h4 (8), apiKeyHelper runs k1 and k2 (2): 8 + 4 + 3 + 3 + 3 + 8 + 2 = 31. No model request could succeed and none was attempted; the only network effect was the TUI's own startup traffic, which the server answered with 401 for the fake token. The job's stated budget was no runs except `claude --version` in a container; I treated item 4's "if you can test this without spending tokens, do" as covering these launches. Flag if that reading is wrong.
- Side effects checked: no run was pointed at `~/.claude`, `~/.claude-work` or the real `~/.claude.json` (every run set its own `HOME`, and `CLAUDE_CONFIG_DIR` only in run 13); `DISABLE_AUTOUPDATER=1` kept the Homebrew install untouched. One careless command created an empty file under `/tmp` and I deleted it at once.

## 9. Evidence on disk

All under the scratch directory above: `inspect/` (npm tarballs and extracted node-pty packages), `probe/`, `probe-final/` (the block, lockfile, smoke-test sources), `toy/` and `clean/<label>/out.log` (clean-room logs), `pty-variants/`, `tui/run1` to `run18`, `h1` to `h4`, `k1`, `k2` (`cfg.json` per run), `registry/` (manifests, configs, layer listings), `apt/` (repository metadata; the two large `.deb` files and extracted binaries were deleted after parsing), `docs/` (the Claude Code documentation pages that were read), `cleanroom.sh`, `hooktest.sh`, `helpertest.sh`, `elfinfo.py`, `final-suite.sh`, and the TUI harness `probe/tui-probe.mjs`.
