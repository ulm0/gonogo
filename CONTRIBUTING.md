# Contributing

Fixes and small features are welcome; open an issue first for anything large.

## Run the checks

Node 24 or newer and the pnpm release pinned by `packageManager` in `package.json` (`corepack enable pnpm` installs it). From a clone:

```
pnpm install
pnpm typecheck       # server, client and tests
pnpm exec vitest run # the whole suite, about 2 minutes
pnpm build           # client (vite) and server (tsc) into dist/
```

All three must pass. `pnpm check:pack` packs the project and runs it in plain Node; it needs the npm registry and rebuilds `dist`, so do not run it while something uses `dist`.

Docs are VitePress, from `docs/` (pages listed in `.vitepress/config.mts`): `pnpm docs:dev` serves them with live reload, `pnpm docs:build` checks them (a dead link fails the build). CI runs it on every pull request. The site (gonogo.ulm0.com) is published **with a release**, from the `v*` tag, not on every merge: a merged docs change shows up with the next release. To publish a docs-only fix sooner, run the **Release** workflow by hand (Actions, Run workflow, on main) with `docs_only` checked and a tag or branch as the tag: only the docs are built and deployed.

## Where things are

- `src/shared/protocol.ts`: every shared type.
- `src/server/`: the hub (`hub.ts`, pure logic, tested with a fake clock), the web server (`web.ts`), the launcher and the MCP server.
- `src/client/`: React 19 and Vite. Logic that tests need lives in plain `.ts` files (the test config has no JSX).
- `docs/contract.md`: the design and its revision log. `docs/backlog.md`: what is planned. `docs/<name>-spec.md`: one per feature.

A new feature needs tests (unit and routes), a spec, a page in `docs/features/` with its sidebar line in `.vitepress/config.mts`, and a line in the revision log of `docs/contract.md`. Keep English plain and short. Mark a known limit with `shortcut: <the limit>, <when to upgrade>`. Add no dependency without a reason. pnpm runs no dependency build script unless `pnpm.onlyBuiltDependencies` in `package.json` names the package.

## Dependency updates

Renovate opens an update only once the release is a day old (`minimumReleaseAge`), and `internalChecksFilter: strict` hides a branch whose release is still too young, so no pull request exists to merge early. A security fix does not wait. pnpm can hold the same line on install: if it refuses a version that is younger than its `minimumReleaseAge`, name the package in `minimumReleaseAgeExclude` in a `pnpm-workspace.yaml` at the root, for example `minimumReleaseAgeExclude: ["vitest@5.1.1"]`, and remove the line once the release is old enough. Pin an exact version there, never a whole package.

## The stand-in agent

`test/fake-claude.mjs` stands in for `claude`: it checks the arguments and the generated `settings.json` and `mcp.json`, draws a screen, posts the same hooks and calls the same MCP tools. `test/e2e.test.ts` runs the real server with it (`GONOGO_AGENT_CMD`) end to end, without a model or account. When you add or rename a tool or change `mcp.json`, update its `ALLOWED_TOOLS` and checks.

It proves gonogo's side only. A change to how a real CLI starts, reports state or receives mail needs a run of that CLI.

## The browser smoke

`browser/smoke.spec.ts` drives Chromium (Playwright) through the built server with the stand-in agent: setup and login with a second factor (real form posts, so the browser sends its own `Origin`), no console or CSP errors, the cookie flags and Content-Security-Policy headers the browser got, styles and fonts applied, a room whose link lamp comes up and whose console draws text, the service worker, the Flight Rules blocks (Knowledge with its switch on, room rules, the closing checklist template, skills) and a mission with its closing checklist. It exists because a browser found bugs that Node clients and jsdom cannot. It spends nothing. It checks a few exact design values (the link lamp's 10.5px font, the logo's 26px height) as a canary for a broken style sheet: change them in the spec together with the design.

```
pnpm build
pnpm exec playwright install --with-deps chromium   # once, about 150 MB
pnpm exec playwright test
```

CI runs it (the `smoke` job of `.github/workflows/ci.yml`) on pull requests that touch `src/client`, the auth and web server files, any `.css`, `public/` or the Vite config, and before a release publishes (`release.yml` calls it on the tag). A failure uploads a screenshot and a trace as an artifact. Firefox and WebKit are not run in CI; locally `PW_BROWSERS=firefox,webkit pnpm exec playwright test browser/smoke.spec.ts`. WebKit runs with service workers blocked: Playwright's WebKit hangs the page once one is installed.

## The real smoke

```
pnpm build
pnpm smoke:real --spend
```

It runs the built server with the real `claude` (haiku): hires an agent, passes a few messages and a go/no-go poll, stops everything. **It spends subscription tokens** (two agents, a few short turns; not measured). It refuses to run without `--spend`, is not part of `pnpm test`, and is run by a person, not CI. It needs a signed-in `claude` and a folder Claude Code already trusts (`--dir`). Run it before a release and after changing the launcher, hooks, terminal rules or message delivery.

## Saved state

Every JSON file under the home holds a `version`. To change a format, add a step to its entry in `src/server/migrate.ts`, update the store, and add a fixture and test in `test/migrate.test.ts`.

## Secrets

Never put a token, webhook secret or credential in a test, fixture, log line or document. Tests never call an outside service: mock `fetch` or start a local server.
