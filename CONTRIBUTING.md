# Contributing

gonogo is a personal tool that anyone can host. Fixes and small features are welcome; open an issue first for anything large.

## Run the checks

Node 24 or newer and pnpm, the release that `packageManager` in `package.json` pins (`corepack enable pnpm` installs it). From a clone:

```
pnpm install
pnpm typecheck       # server, client and tests
pnpm exec vitest run # the whole suite, about 2 minutes
pnpm build           # client (vite) and server (tsc) into dist/
```

All three must pass. `pnpm check:pack` packs the project and runs the package in plain Node; it needs the npm registry and rebuilds `dist`, so do not run it while something uses `dist`.

The documentation site is VitePress, built from `docs/` (`.vitepress/config.mts` lists the pages and leaves the design notes out): `pnpm docs:dev` serves it with live reload, `pnpm docs:build` checks it (a dead link fails the build).

## Where things are

`src/shared/protocol.ts` has every shared type. `src/server/` is the hub (`hub.ts`, pure logic behind an interface, tested with a fake clock), the web server (`web.ts`), the launcher and the MCP server. `src/client/` is React 19 and Vite; logic that tests need lives in plain `.ts` files because the test config has no JSX. `docs/contract.md` is the design and its revision log; `docs/backlog.md` is what is planned; each feature has a short `docs/<name>-spec.md`.

A new feature has tests (unit and routes), a spec, a page in `docs/features/` (and its line in the sidebar of `.vitepress/config.mts`) and a line in the revision log of `docs/contract.md`. Keep English plain and short. A known limit gets a comment `shortcut: <the limit>, <when to upgrade>`. Add no dependency without a reason; `pnpm-lock.yaml` pins what the tests ran on. pnpm runs no dependency build script unless `pnpm.onlyBuiltDependencies` in `package.json` names the package.

## The stand-in agent

`test/fake-claude.mjs` stands in for `claude`: it parses the arguments the launcher builds, checks the generated `settings.json` and `mcp.json`, draws a screen the terminal code accepts, posts the same hooks and calls the same MCP tools. `test/e2e.test.ts` starts the real server with it (`GONOGO_AGENT_CMD`), so the launcher, hooks, MCP, terminal host and hub run end to end without a model, an account or a token. When you add or rename a tool or change what `mcp.json` holds, update its `ALLOWED_TOOLS` and its checks.

A stand-in proves gonogo's side only. Anything that changes how a real CLI starts, reports its state or receives mail needs a run of that CLI before it is trusted.

## The real smoke

```
pnpm build
pnpm smoke:real --spend
```

It starts the built server with the real `claude` on the haiku model, hires an agent, passes a few messages and a go/no-go poll, and stops everything. **It spends subscription tokens**: two agents and a handful of short turns. Nobody measured the amount, so it is small but not free. It refuses to run without `--spend`, is not part of `pnpm test`, and a person runs it, not CI. It needs a signed-in `claude` and a folder Claude Code already trusts (`--dir`). Run it before a release and after a change to the launcher, the hooks, the terminal rules or message delivery.

## Saved state

Every JSON file under the home holds a `version`. To change one, add a step to its entry in `src/server/migrate.ts` and change the store to match; at start the runner upgrades older files after a `<file>.bak-v<old>` copy and refuses newer ones. Add a fixture and a test in `test/migrate.test.ts`.

## Secrets

Never put a token, a webhook secret or a credential in a test, a fixture, a log line or a document. Tests never call an outside service: mock `fetch` or start a local server.
