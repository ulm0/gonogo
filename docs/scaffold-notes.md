# Scaffold notes

How the project is built and how its files import each other. The root files (`package.json`, `pnpm-lock.yaml`, the `tsconfig*.json` files, `vite.config.ts`, `vitest.config.ts`, `index.html`, `.gitignore`) serve every source file, so change them deliberately. Dependency versions are pinned exactly, with no `^`.

## Where compiled files land

`pnpm build` runs `vite build` and then `tsc -p tsconfig.server.json`. `tsconfig.server.json` has `rootDir: "src"` and `outDir: "dist"`, so the folder name under `src` is kept:

| Source | Built file |
|---|---|
| `src/server/<name>.ts` | `dist/server/<name>.js` |
| `src/shared/<name>.ts` | `dist/shared/<name>.js` |
| `index.html` and `src/client/**` | `dist/client/index.html` and `dist/client/assets/*` (Vite) |
| `bin/gonogo.js` | not built, shipped as it is; it does `await import('../dist/server/cli.js')` |

The brief said `outDir dist/server`. With `rootDir src` that would put the server at `dist/server/server/cli.js`, so `outDir` is `dist` instead. The files that matter are `dist/server/cli.js` and `dist/client/index.html`. `tsc` never deletes stale files, so remove `dist` by hand after renaming or deleting a source file. `pnpm pack` ships `bin` and `dist`, and always `package.json`, the README and the `LICENSE`.

## How the built server finds the client and package.json

Every file in `dist/server` has `dist/client` as its sibling folder, and the package root two levels up:

```ts
const clientDir = fileURLToPath(new URL('../client/', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
```

Under vitest the same expression in `src/server/web.ts` points at `src/client/`, which is source, not a build. So `web.ts` should take the directory as an option and use the expression above only as the default. Tests pass a temporary folder with an `index.html`. A test must never depend on `dist` having been built first.

Vite uses `base: './'`, so the built `index.html` asks for `./assets/...`. The server serves static files without the browser token (contract 3.2 and 3.7), and the client calls `/api` and `/ws` by absolute path, so the app is proxied at the root of a host, not under a path prefix.

## Import rules

- `src/server` and `src/shared`: relative imports end in `.js` (`import { x } from '../shared/protocol.js'`). NodeNext requires it. Vitest and the client bundler resolve `.js` to the `.ts` file, so shared code can be imported from all three places.
- `src/client`: relative imports end in `.js` like everywhere else (`import { App } from './App.js'`). They resolve to `.ts`/`.tsx` under Vite 8.3.8 (`vite build`), vitest 5.1.0 and `tsc` 7.0.2 with `moduleResolution: bundler` (checked on a copy of these configs; contract 11 and open item O19). `docs/contract.md` is the authority.
- `isolatedModules` is on in both configs, so re-export a type with `export type { X } from './y'`. `import { X }` of a type is fine.
- `@xterm/headless` is a CommonJS package: use `import headless from '@xterm/headless'; const { Terminal } = headless;`. The named import passes under vitest and `tsc` and then fails in plain Node, so only a run of the built server catches it.
- The server config has no DOM types and the client config has no Node types. `src/shared` is compiled by both, so it can use neither.

## Commands

- `pnpm build`: client, then server.
- `pnpm typecheck`: the three tsconfigs with `--noEmit`: `tsconfig.json` (client and shared), `tsconfig.server.json` (server and shared) and `tsconfig.test.json` (`test/` with the server code, without `jsx`: a client test may import only client modules that import no `.tsx` file, contract 10.6). The config files at the root are not type-checked.
- `pnpm test`: `vitest run`, files matching `test/**/*.test.ts`, Node environment. Files such as `test/fake-claude.mjs` and `test/fixtures/` are never collected.
- `pnpm smoke:real` runs `scripts/smoke-real.mjs` against a real `claude`. It is not part of `pnpm test`.
- `pnpm-lock.yaml` is the lock: it is part of the project and it is not ignored. It was made by `pnpm import` from the npm lock the tests had run on (2026-11-17), so the versions did not change. It lists the Linux x64 and arm64 builds of the platform packages (pty, TypeScript, rolldown, lightningcss), so `pnpm install --frozen-lockfile` in the Docker build works from a lock made on a Mac. pnpm does not ship a lock in a package: the Docker build installs the tarball's dependencies from this one. `packageManager` in `package.json` pins pnpm (release and checksum); corepack and CI run that release.
