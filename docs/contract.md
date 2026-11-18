# gonogo: build contract

Date: 2026-11-16. Status: for builders A to H. Written by the lead architect from the design
(`docs/superpowers/specs/2026-11-16-gonogo-design.md`) and the fact files (`docs/facts/`).

This document, `src/shared/protocol.ts` and `src/server/constants.ts` are one contract. The two source files are
compiled and are the exact definitions of every type, interface, constant and limit. This document says what the
members mean, who calls them, and what the code must do. If this text and the two source files disagree, the source
files win and the disagreement is a bug to report. **Builders do not edit the two source files.** Section 15 lists the
revisions the contract editor made to all three files after the first review.

Precedence, as the owner set it: where the facts and the design disagree about a Claude Code behaviour, the facts
win; where they disagree about what gonogo should do, the design wins. Where this contract makes a call that
differs from the design or the facts, section 12 lists it with the reason. Section 13 lists what nobody could settle
without a real `claude`.

Exact strings in this document (pointer text, reasons, notes, JSON bodies) are part of the contract: tests and the
stand-in agent compare against them.

## 0. Read this first

### 0.1 What to read, per builder

| Builder | Files | Read |
|---|---|---|
| A hub | `hub.ts`, `test/hub.test.ts` | 0, 1, 2.1, 4, 5, 10.1, 11, protocol.ts (all of Part 3), constants.ts |
| B launcher | `launcher.ts`, `test/launcher.test.ts` | 0, 1, 2.2, 7, 10.2, 11, facts `claude-code-hooks-mcp.md` section 0 (cheat sheet) and 1, 6, 7, 9; `toolchain-docker.md` 4.2 |
| C terminal | `terminal.ts`, `test/terminal.test.ts`, `test/fixtures/` | 0, 1, 2.3, 6, 10.3, 11, facts `claude-code-terminal.md` 2 to 7 and Corrections |
| D stand-in and e2e | `test/fake-claude.mjs`, `test/e2e.test.ts` | 0, 1, 3, 4, 5, 6.3 to 6.5 (the fake's screen must satisfy `analyzeScreen` and the ready rule), 7.2 to 7.4 (the flags and files it parses), 9, 10.5, all of 2.8 |
| E server edge | `bin/gonogo.js`, `home.ts`, `hooks.ts`, `mcp.ts`, `web.ts`, `cli.ts`, `test/edge.test.ts` | 0, 1, 2.4 to 2.8, 3, 10.4, 11, facts `hooks-mcp.md` 4, 5, 6 |
| F client core | `main.tsx App.tsx api.ts store.ts TerminalPane.tsx HireForm.tsx Activity.tsx Brief.tsx styles.css` | 0, 1, 3 (wire only), 8, 10.6, 11 |
| G floor | `Floor.tsx`, `art.ts` | 0, 1, 8.1, 8.3, 8.8, 10.6, 11 |
| H packaging | `Dockerfile`, `.dockerignore`, `README.md`, `scripts/smoke-real.mjs`, `scripts/check-pack.mjs` | 0, 1, 2.8, 2.9, 3.1 to 3.4, 5.8, 7.7, 10.8, 13, 14, protocol.ts Part 2; facts `toolchain-docker.md` 2, 3 to 5 and `Dockerfile.probe` |

Everyone reads sections 0 and 1. Nobody waits for another builder: every cross-module call is typed in
`protocol.ts` (the option types of the factories included), so code written against it fits. Build your module against fakes of the interfaces you consume.
What `protocol.ts` cannot check is the import of a factory itself (`createHub` from `./hub.js` while that file is still a stub): builder E owns that check when the files are merged.

### 0.2 Words

- **agent**: one `claude` process in a pty plus its roster record. Identified by its **name** everywhere.
- **boss**: the agent with `boss: true`. The recipient alias `boss` resolves to it.
- **generation**: integer, counts spawns of one agent in this server run (1, 2, 3, ...). The hub assigns it before it
  calls `io.spawn`. Every event from the terminal host and every hook carries it, so late events of an older
  process are recognised and dropped.
- **token (agent token)**: 64 hex characters, new for every start (agent, generation). Environment variable
  `GONOGO_TOKEN` of that claude process only. It authenticates hook posts and MCP calls and nothing else, and
  identifies (agent, generation). The **browser token** is a different secret (section 3.2).
- **pointer**: the only text gonogo ever types into a terminal or hands to a Stop hook (section 5.1).
- **trigger**: the messages returned by an agent's last non-empty `read_messages`; drives hop counting (5.7).
- **draft latch**: "the user has typed text into this agent's input and it is still there": ended by Enter, Ctrl-C, the screen showing an empty box for a second, or 30 minutes (4.6).
- **mirror**: the server-side headless xterm of one agent (section 6).
- **the three signals** that decide state: hooks (fast, can be missing), the window-title glyph (OSC 0), and the
  mirror screen (dialogs, prompt box). Sections 4 and 6.

### 0.3 Global decisions (every builder relies on these)

1. **Names.** Agent names match `AGENT_NAME_PATTERN` (`^[a-z0-9][a-z0-9-]{0,31}$`), are unique, and are not in
   `RESERVED_NAMES` (`user`, `boss`). The boss's default name is `flight` (design says "Flight"; conflict 1).
   Names appear in file paths, URLs, the typed pointer and tokens' routes, so they are validated at every entry
   (hub on hire/edit, hooks and MCP on the request path).
2. **Time** is milliseconds since the epoch (`number`) everywhere, taken from `io.now()` inside the hub and
   `Date.now()` elsewhere. **JSON** only; UTF-8; no BOM.
3. **Only the server writes state.** The browser changes things only through the REST routes. Agents change things
   only through the three MCP tools and hook replies.
4. **A message body never goes through a terminal.** Only the pointer does (5.1). Nothing else is ever typed by
   the server except the pointer. A blind CR is never sent.
5. **The server never types into anything but an idle, ready agent** that shows a prompt box and no dialog, has no
   draft, and whose title glyph is not "working" (5.3).
6. **Queues and pending state live in memory only.** `messages.jsonl` is a log, not a queue. After a server
   restart every agent is `stopped` and every message that was not yet read is shown as `undelivered`.
7. **No retries without new information.** A pointer that was not confirmed within `PROMPT_SUBMIT_CONFIRM_MS` is not
   typed again until the user pressed Enter or Ctrl-C in that terminal, a UserPromptSubmit arrived, or the agent read its mail (5.4).
8. **Defensive edges.** Everything that comes from outside (HTTP bodies, hook payloads, MCP arguments, WebSocket
   frames, `agents.json`, `.claude.json`) is parsed defensively: wrong type or missing field means a 400 (or
   ignore, for hooks), never a crash. An uncaught error ends every agent, so the hostile-input rules of 3.2 and the
   WebSocket rules of 3.4 apply to every byte that arrives on the port.
9. **Secrets.** Never log a token, an API key, a message body or a hook payload. Log event names, agent names,
   ids and counts. Token files are mode 0600 inside directories of mode 0700.
10. **Platform.** macOS and Linux (glibc). Node 24 or newer. No Windows.
11. **Imports** (no cycles): `hub.ts` imports only `protocol.ts`, `constants.ts` and Node built-ins. `launcher.ts`,
    `terminal.ts` and `home.ts` import the same plus their own libraries. `hooks.ts`, `mcp.ts`, `web.ts` import
    `protocol.ts`, `constants.ts`, their libraries and each other as the edge builder likes. Only `cli.ts` imports
    hub, launcher, terminal, home, web. Client files import only `../shared/protocol.js` and their libraries (never
    `src/server/*`).
12. **Plain closures.** `createHub`, `createLauncher`, `createTerminalHost`, `openHome` and `createWebServer` return objects whose methods are closures and never use `this` (no classes with methods), so a method may be passed on detached. `cli.ts` still wires them with arrow functions (2.8 step 4).
13. **Agents reach the server on loopback only.** Every URL written into a settings or MCP file has the host `127.0.0.1` (or `[::1]` when the server is bound to `::1`), whatever address the server is bound to: claude blocks http hooks to private addresses (2.8 step 8).

### 0.4 Who calls whom

```
browser ──REST/WS──► web.ts ──► hub (lifecycle, send, onUserInput)      terminals (attach, resize, write)
claude  ──hook────► hooks.ts ─► hub.onHook          (token → launcher.resolveToken)
claude  ──MCP─────► mcp.ts ───► hub.sendFromAgent / readMessages / rosterFor
hub ──HubIo──► spawn: launcher.prepareStart → terminals.spawn      stop/typePointer/screen/title: terminals
terminals ──onEvent──► (cli wiring) launcher.revoke on exit, hub.onTerminalEvent
hub ──HubIo.emit──► web.broadcast ──► browsers
hub ──HubIo.saveRoster / logMessage / loadRoster / loadHistory──► home
```

### 0.5 Lead rulings (these win over anything else in this document)

The first builder-readiness check asked 19 questions. The lead (the person running the build) answered them as below; where a section above says something else, this list is right. Each ruling names the builders it touches.

1. **Scaffold requests (all).** Section 14 is applied (2026-11-16): `vitest.config.ts` (30 s timeouts, forks), `tsconfig.test.json`, `typecheck` covers `test/`, `noEmitOnError`, the two metas, the dev proxy, `.gitignore`, `prepack` and `check:pack`. Nobody edits those files.
2. **One shared working tree (all builders).** Every builder writes only the files it owns (section 1) into the same tree, at the same time, and every other file is still a stub until the merge. So: (a) check your own files only: run `pnpm exec tsc -p tsconfig.server.json --noEmit` (or the client/test config) and read only the lines that start with your own paths, or use a private tsconfig in your scratch folder that lists only your files plus `src/shared/protocol.ts` and `src/server/constants.ts`; (b) run only your own test files (`pnpm exec vitest run test/<yours>.test.ts`); (c) **never run `pnpm build`, `vite build` or `pnpm pack`** (they empty and rewrite `dist` for everyone); F and G may check that the client bundles with `pnpm exec vite build --outDir <scratch>/client-out --emptyOutDir`; (d) D writes the e2e test and E writes `cli.ts` against the typed interfaces without being able to run them until A, B, C and G have landed: the integrator pass runs build, typecheck, the whole suite and `check:pack` after the merge and fixes the seams. Write your module so that it can be merged without a change.
3. **Behaviour that differs from the design (A, D, E).** Section 12 stands: Escape alone does not release the draft latch (23), static files need no browser token (10), one bounded second pointer (16), the session-flag flip needs the flag's own message in the exit tail (28), the boss is `flight` (1), the browser token travels in `Sec-WebSocket-Protocol` (25). The final report to the owner lists them.
4. **Browser test of the built client (nobody in A to H).** The integrator runs it after the merge with the Chrome tools against a server started with the stand-in agent, and fixes what it finds. Builders F and G leave a visible, accessible UI and do not run a browser.
5. **Permission summary (A).** `cut to PERMISSION_SUMMARY_CHARS` means: the first `PERMISSION_SUMMARY_CHARS` characters of the whitespace-collapsed text, plus `…` only when something was cut (so at most 101 characters). Pin it in `hub.test.ts`.
6. **Restart gap (A).** While `transition === 'restarting'` the exit handler records `exit` and sets the internal state to `stopped` but **emits no frame**; the restart operation's `spawn` then emits the one `starting` frame, with `transition` already cleared (4.9). Routing (5.2 step 6) tests `transition === 'restarting'` **before** it tests `state === 'stopped'`: such a recipient is treated like a running agent (message `queued`, note `waiting: <name> is restarting`, 5.8). The unit test asserts exactly this, including that no `stopped` frame was emitted.
7. **Claude config directory (B).** In seed mode `prepareStart` creates `<CLAUDE_CONFIG_DIR>` with `mkdir -p` (mode 0700) before the temp file of 7.6; a failure rejects with the same `cannot record folder trust in <path>: <reason>` text. Launcher test with a missing config directory.
8. **Agent token check (B, E).** `resolveToken` is the plain `Map` lookup of 7.9 (256-bit random key, loopback only, Origin refused). `timingSafeEqual` on SHA-256 digests stays for the **browser** token in `web.ts` (3.2). Section 11's "tokens checked per request" means the browser token.
9. **Finding spawn-helper (C).** `createRequire(import.meta.url).resolve('<package>/package.json')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@lydell/node-pty-<platform>-<arch>` (its `exports` is `./lib/index.js` only). Resolve the package's **main entry** instead (`require.resolve('@lydell/node-pty-<platform>-<arch>')` gives `<pkg>/lib/index.js`, so the package directory is two levels up) and look in `prebuilds/<platform>-<arch>/spawn-helper`; keep the `<package>/package.json` form for the official `node-pty`. Add a test that calls `ensureSpawnHelperExecutable()` with no `roots` on the real install: it finds the helper, changes nothing and does not throw.
10. **Replay test seam (C).** `TerminalHost` gets no test-only export by default: replay the recorded stream through the real `spawn()` with a tiny child (`process.execPath`, `-e`, a script that writes the recorded bytes to stdout), so the pty, the mirror and the mode fix-ups are all under test. If that proves unstable, C may export **one** extra function used only by `test/terminal.test.ts` and must say so in the report.
11. **Fixtures hold private strings (C).** The two recorded streams in the facts job's scratch folder (`real-fs.stream.jsonl`, `real-classic.stream.jsonl`) also contain the owner's `login@hostname` (from a status line), the home directory path and a scratch path. Copy them now, then replace every such string with **same-length** filler inside the decoded `d` records (so cell positions do not move) and re-encode; blank `start.args` and `start.cwd`; the replay test must stay green. Before finishing, grep the decoded fixtures for the owner's login name, the machine's hostname, `/Users/`, `/Volumes/` and any e-mail address: none may remain. Do not write the owner's names into any file you create, the report excepted (and there say only that none remain).
12. **Stand-in's empty box (D).** The fake draws the `Try "fake placeholder"` hint only until the first keystroke or the first submitted prompt of that process; an emptied box is `❯` followed by U+00A0 and nothing else (add this sentence to 9.3 in your own notes; the contract text is not edited by builders).
13. **FAKE_CLAUDE_IGNORE_POINTER (D).** The switch also covers Stop-block reasons: while it is set, any text that matches the pointer pattern is treated as an ordinary instruction, whether it was typed or arrived as a Stop block's reason.
14. **URL printed for an IPv6 bind (E).** `Running.url` and the `gonogo ready:` line bracket an IPv6 bind host: `http://[::1]:<port>/#token=...`. `0.0.0.0`, `::`, `127.0.0.1` and `localhost` print `127.0.0.1`.
15. **`--allow-host` (E).** Repeatable flag; when any `--allow-host` is given the `GONOGO_ALLOWED_HOSTS` list is ignored (flags replace env, like every other option).
16. **Static files and proxies (E, F, H).** The contract wins over `docs/scaffold-notes.md` on both points it left open: static files are served with no token (Host check only); the client keeps absolute `/api` and `/ws` URLs; the README documents proxying **at the root of a host** only (no path prefix). The lead trimmed those two sentences from `docs/scaffold-notes.md`.
17. **Floor styling (F, G).** G styles everything it renders (`ul.agent-list`, the state dots, the canvas container) with inline style objects or one `<style>` element inside `Floor.tsx`, using the CSS custom properties of 8.1, and sets the container's height from the scaled stage height. F's `styles.css` supplies only the tokens, `.sr-only` and the focus ring, and does not style `.agent-list`. The five dot shapes of the accessible list: `starting` ring, `idle` filled circle, `working` half circle, `needs_you` triangle, `stopped` square. F builds the props of `FloorProps` (8.3) structurally; the type lives in G's file.
18. **H's reading list and scripts (H).** H also reads 3.3, 3.4, 5.8 and protocol.ts Part 2 (the smoke script hires over REST, briefs the boss, reads activity items and types into the terminal socket), and owns `scripts/check-pack.mjs`. **`check-pack.mjs` and the README's install commands run pnpm with `NPM_CONFIG_USERCONFIG` pointing at an empty temp file and `HOME` at a temp directory**, so the owner's `~/.npmrc` (it holds a registry token) is never read or sent.
19. **Docker is not built here (H).** The Docker daemon is down in this session and the lead never starts it. H writes the Dockerfile and states in the README's "what was not run" part that it was not built; the Docker checks of 10.8 run later when the daemon is up.
20. **Open items stay open (H, lead).** O3 to O6, O9 to O12, O15 to O17 and O21 to O25 are answered by H's smoke run and the Docker checks, not by the builders. A builder must not guess the answer into code that cannot be undone: use the fallback column of section 13 where it says so.

## 1. Layout and ownership

One owner per file. Files not listed here do not exist. Builders may add test fixtures under their own
`test/fixtures/<their-name>/`. F and G may each add one pure-logic test file (`test/client-store.test.ts`,
`test/client-floor.test.ts`, no DOM, no Pixi value imports).

| File | Owner | What it is |
|---|---|---|
| `package.json tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts index.html .gitignore` | scaffold | exists; section 14 lists the changes this contract needs |
| `src/shared/protocol.ts` | contract author | wire and module types, const arrays (written) |
| `src/server/constants.ts` | contract author | every timing constant, limit, fixed string, logger (written) |
| `src/server/hub.ts` | A | `createHub(io, options): Hub`. Pure logic, no I/O except through `HubIo` |
| `src/server/launcher.ts` | B | `createLauncher(options): Launcher` |
| `src/server/terminal.ts` | C | `createTerminalHost(options): TerminalHost` and pure helpers |
| `src/server/home.ts` | E | `openHome(dir, log): Home` |
| `src/server/hooks.ts` | E | `/hook/<agent>/<event>` endpoint |
| `src/server/mcp.ts` | E | `/mcp` endpoint |
| `src/server/web.ts` | E | HTTP server, static client, REST, WebSocket, auth, Host/Origin checks |
| `src/server/cli.ts` | E | `main`, `startGonogo`, wiring, boss creation, URL printing |
| `bin/gonogo.js` | E | shebang, Node version check, `import('../dist/server/cli.js')`, calls `main` |
| `src/client/main.tsx App.tsx api.ts store.ts TerminalPane.tsx HireForm.tsx Activity.tsx Brief.tsx styles.css` | F | client core |
| `src/client/Floor.tsx art.ts` | G | Pixi floor, procedural drawing, accessible agent list |
| `test/hub.test.ts` | A | |
| `test/launcher.test.ts` | B | |
| `test/terminal.test.ts`, `test/fixtures/` | C | includes the recorded stream fixture |
| `test/edge.test.ts` | E | hooks, mcp, web, auth, home, cli |
| `test/fake-claude.mjs`, `test/e2e.test.ts` | D | stand-in agent and end-to-end test |
| `Dockerfile .dockerignore README.md scripts/smoke-real.mjs scripts/check-pack.mjs` | H | packaging, the manual smoke script, and the check of the packed package (10.8) |

Output layout after `pnpm build`: `dist/server/*.js`, `dist/shared/protocol.js` (server build, rootDir `src`),
`dist/client/` (vite). The package ships `bin` and `dist`.

## 2. Server modules: exported API, callers, rules

Every interface named here is defined in `src/shared/protocol.ts` (Part 3). "Exports" lists what other files and
tests may import. Anything not listed is private. Functions marked *pure* touch no I/O and are what the unit
tests call.

### 2.1 `hub.ts` (builder A)

```ts
export function createHub(io: HubIo, options: HubOptions): Hub;
export class HubError extends Error {            // name === 'HubError'
  constructor(code: ApiErrorCode, message: string, field?: string);
  readonly code: ApiErrorCode; readonly field?: string;
}
export type { InputEffect } from '../shared/protocol.js';                         // 'set' | 'clear' | 'none'
export function classifyInput(data: string): InputEffect;                         // pure, 4.6
export function pointerText(messages: ReadonlyArray<{ from: string }>): string;   // pure, 5.1
export function describePermission(toolName: unknown, toolInput: unknown): string; // pure, 4.4
```

- **Called by**: `cli.ts` (creates it, wires `onTerminalEvent`, calls `start`/`shutdown`); `web.ts` (REST: `views`,
  `activity`, `hire`, `edit`, `restart`, `stop`, `remove`, `sendFromUser`; WebSocket input: `onUserInput`, whose return value tells web.ts a keystroke from focus and mouse reports, 3.4);
  `hooks.ts` (`onHook`); `mcp.ts` (`sendFromAgent`, `readMessages`, `rosterFor`, each with the generation of the caller's token, 4.10 rule 7).
- **Calls**: only `HubIo`. No `fs`, no `net`, no `setTimeout`, no `Date.now()`, no `Math.random`, no
  `crypto`: use `io.now`, `io.setTimer`, `io.newMessageId`, `io.newSessionId`. This is what makes the unit tests
  deterministic (fake clock, fake timers, scripted `screen`/`title`).
- **Rules**: all behaviour is in sections 4 (states, races, latches, reconciliation, lifecycle) and 5 (messages,
  delivery, hops, outcomes, exact activity text). Module-level rules:
  1. Every method that changes an `AgentView` or an `ActivityItem` calls `io.emit` with the whole new object,
     exactly once per change, after the in-memory state is consistent. (One deliberate delay: the `starting` frame of a spawn waits for `io.spawn` to resolve, 4.9. A rename emits `agent-removed` for the old name, then the new agent's frame.)
  2. Lifecycle methods (`hire`, `edit`, `restart`, `stop`, `remove`) for one agent run one at a time, in call order
     (a promise chain per agent). `onHook`, `sendFrom*`, `readMessages`, `onUserInput`, `onTerminalEvent` are
     synchronous and never wait for a lifecycle method.
  3. Persist with `io.saveRoster` after every change of a roster record (hire, edit, remove, session id change,
     desk) and `io.logMessage` after every creation or status change of a message. Persistence failures are
     logged, and for lifecycle methods surface as `HubError('internal', ...)`; message routing never fails because
     the log failed.
  4. Timers are per agent and carry the generation they were set for; a callback whose generation is no longer the
     agent's current one does nothing.
  5. `HubError.code` maps to HTTP status in `web.ts` (section 3.3). Messages are one plain sentence for humans.
  6. `views()` returns agents sorted by `desk` ascending (the boss, desk 0, first); `activity()` is newest first and holds at most `ACTIVITY_HUB_MAX` items (older ones stay in the log only).
  7. Once `shutdown()` has begun the hub is `closing`: `hire`, `edit`, `restart`, `stop` and `remove` reject with `HubError('conflict', 'the server is shutting down')`, so nothing starts a process that the shutdown would not stop. Messages, hooks and reads keep working.
  8. Everything an agent's rt owns (record, state, queue, timers, the lifecycle promise chain) hangs on one `rt` object, keyed by name in a map; a rename (4.9) moves that object to the new key.

### 2.2 `launcher.ts` (builder B)

```ts
// LauncherOptions is defined in protocol.ts (Part 3) so that cli.ts is written against one definition:
//   { homeDir (absolute), hubUrl: () => string (loopback only, "http://127.0.0.1:7777" or "http://[::1]:7777", no trailing slash, read at every prepareStart),
//     seed (7.6), env? (default process.env), agentCmd? (7.7), claudeBin? (default CLAUDE_BIN), log? }
export function createLauncher(options: LauncherOptions): Launcher;
export function parseAgentCmd(value: string | undefined): string[] | null;  // 7.7
// pure builders, exported so the tests can compare them with the exact JSON of section 7:
export function buildSettings(input: {...}): Record<string, unknown>;
export function buildMcpConfig(hubUrl: string): Record<string, unknown>;
export function buildArgv(input: {...}): string[];
export function buildChildEnv(input: {...}): Record<string, string>;
export function buildRoleText(name: string, role: string, memoryPath: string): string;
export function transcriptDirName(cwd: string): string;
```

- **Called by**: `cli.ts` (`createLauncher`, `parseAgentCmd`; passes `prepareStart` into `HubIo.spawn`;
  `revoke` on every exit event; `renameAgentFiles` into `HubIo.renameAgentFiles`; `resolveToken` into `web.ts`).
- **Calls**: `node:fs/promises`, `node:crypto`, `node:os`, `node:path`. Never the hub, never the terminal host.
- **Rules**: section 7. The parameter objects of the `build*` helpers are yours to shape; their output is not.

### 2.3 `terminal.ts` (builder C)

```ts
// TerminalHostOptions is defined in protocol.ts (Part 3): { log?, now? (default Date.now), killAfterMs? (default STOP_KILL_AFTER_MS; tests pass small values), giveUpAfterKillMs? (default STOP_GIVEUP_AFTER_KILL_MS) }
export function createTerminalHost(options?: TerminalHostOptions): TerminalHost;
export function analyzeScreen(rows: readonly string[], cols: number): ScreenProbe;   // pure, 6.4
export function classifyTitle(title: string): TitleGlyph;                            // pure, 6.5
export function sanitizeForPaste(text: string): string;                              // pure, 6.7
export function buildSubmit(text: string): string;        // ESC[200~ + sanitize + ESC[201~ + CR, pure
export class ModeTracker { feed(chunk: Uint8Array | string): void; fixup(): string; } // 6.6
export function ensureSpawnHelperExecutable(log?: Logger, roots?: readonly string[]): string[];   // 6.10, returns fixed paths; `roots` (package directories to scan instead of the require.resolve results) is for tests, spawn() never passes it
```

- **Called by**: `cli.ts` (creates it; wires events and `HubIo`, `rename` included); `web.ts` (`attach`, `resize`, `write`, `info`).
- **Calls**: `@lydell/node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `node:fs`, `node:module`. Never the
  hub or the launcher: it only receives a `SpawnSpec`.
- **Rules**: section 6.

### 2.4 `home.ts` (builder E)

```ts
export function openHome(dir: string, log?: Logger): Home;
```

1. Synchronously creates `<dir>` and `<dir>/agents` (mode 0700, recursive) and **always** `chmodSync` both to 0700: a home created earlier with a looser umask, restored from a backup or copied with rsync may be 0755, and 0.3 item 9
   promises 0700. A `chmod` that fails (a root-owned bind mount) is logged as a warning and does not stop the start.
2. **Lock.** Creates `<dir>/server.lock` (`LOCK_FILE`) with `open(path, 'wx')` and writes `<pid>\n` into it. Two servers on one home would resume the boss's session twice (two claude processes on one transcript) and overwrite each other's `agents.json`; without
   the lock only the default port protects, and `--port 7778` passes. On `EEXIST` read the pid: the lock is **stale** (replace it) when the content is not a positive integer, or `process.kill(pid, 0)` throws `ESRCH`, or the pid equals
   `process.pid` while this process holds no lock of its own on that directory (inside containers pids repeat, so the lock of the previous run can name this very process). Otherwise throw
   `Error('another gonogo is using <dir> (pid <N>). Stop it, or delete <dir>/server.lock if none is running.')`. A module-level set of the directories this process holds makes a second `openHome` of the same directory in one process fail the same way.
3. `<dir>/token` (64 hex chars from 32 random bytes, mode 0600) is created when it does not exist. An existing token file is read and trimmed and **`chmodSync(path, 0o600)`**; if it is not 64 hex chars it is replaced (and a warning logged).
4. `loadRoster()`: file missing -> `{ version: 1, agents: [] }`. Invalid JSON or wrong shape -> throw an `Error`
   whose message names the path and says "fix or delete this file" (cli prints it and exits 1). Never auto-reset:
   the roster holds the session ids.
   Each record is validated field by field (names by the pattern, `mode` in `PERMISSION_MODES`, `sessionId` a
   UUID, `desk` a non-negative integer); an invalid record is a load error, not a silent drop.
5. `saveRoster()`: `JSON.stringify(file, null, 2)` to a temp file in the same directory (`.agents.json.<pid>.<rand>.tmp`,
   mode 0600), then `rename`. Calls are serialised (a promise chain) so the last call wins.
6. `appendMessage(record)`: one JSON line per call through a promise chain of `fs.appendFile(messagesPath, line, { mode: 0o600 })`; errors are logged. **The first line this process writes for an id is the whole record; every later change of that id
   appends only `{"id":"m12","status":"read","note":null,"updatedAt":1700000000000}`.** (The hub logs every creation and every status change; writing the whole record, body included, each time stored every message three or four times.)
7. `loadRecentMessages(limit)`: reads at most the last `MESSAGES_TAIL_BYTES` of `messages.jsonl` (a first line that starts before that window is dropped without a warning), ignores lines that do not parse (log a warning with the count), folds by `id`
   (a whole record opens an entry; a partial line sets `status`, `note` and `updatedAt` of the entry with that id, and is dropped when the window holds no whole record of that id), orders by `at` ascending, returns the last `limit`. `lastMessageSeq()` scans the same
   tail, whole and partial lines, for ids matching `^m(\d+)$`, and the tail of `messages.jsonl.1` when the first has none (ids never restart after a rotation). Neither reads the whole file, so start-up stays fast whatever the file size.
8. **Rotation, at open only**: when `messages.jsonl` is larger than `MESSAGES_ROTATE_BYTES` it is renamed to `messages.jsonl.1` (`MESSAGES_ROTATED_FILE`, replacing an older one) and a new file starts. A run that adds tens of megabytes before its next start is not expected; reads stay bounded either way.
9. `agentDir(name)` returns `join(dir, AGENTS_DIR, name)` and throws if `name` does not match the name pattern.
10. `close()`: waits for the roster and message chains, then removes `server.lock` (only when it still holds this process's pid). Idempotent. `stop()` (2.8) calls it last, so appends and saves issued during shutdown reach the disk before `process.exit`; a failed start calls it too.

### 2.5 `hooks.ts` (builder E)

```ts
export interface HookDeps {
  hub: Pick<Hub, 'onHook'>;
  resolveToken(token: string): AgentIdentity | null;
  log: Logger;
}
export function createHookHandler(deps: HookDeps):
  (req: IncomingMessage, res: ServerResponse, agentName: string, event: string) => Promise<void>;
```

`web.ts` routes `POST /hook/<agent>/<event>` here after the Host and Origin checks. Behaviour: section 3.5.
The signature is internal to builder E (`web.ts` and `hooks.ts` change together); the behaviour is the contract.

### 2.6 `mcp.ts` (builder E)

```ts
export interface McpDeps {
  hub: Pick<Hub, 'sendFromAgent' | 'readMessages' | 'rosterFor'>;   // each called with identity.generation (3.6, 4.10 rule 7)
  resolveToken(token: string): AgentIdentity | null;
  log: Logger;
}
export function createMcpHandler(deps: McpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
```

`web.ts` routes `/mcp` here. Behaviour: section 3.6.

### 2.7 `web.ts` (builder E)

```ts
export interface WebOptions {
  host: string;                       // bind address
  port: number;                       // 0 = any free port
  browserToken: string;
  allowedHosts: string[];             // extra Host header names (section 3.2); loopback names are always allowed
  staticDir: string | null;           // built client; null = serve no static files
  hub: Hub;
  terminals: TerminalHost;
  resolveToken(token: string): AgentIdentity | null;
  info: () => ServerInfo;
  isReady: () => boolean;             // false until hub.start() has resolved (2.8 step 9): /api and /ws answer 503 meanwhile (3.3)
  log: Logger;
}
export interface WebServer {
  listen(): Promise<{ host: string; port: number }>;   // rejects on EADDRINUSE etc.; resolves with the first bind
  close(): Promise<void>;                              // closes sockets (WS code 1001) and the server(s); idempotent
  broadcast(event: HubEvent): void;                    // to every authenticated WebSocket
}
export function createWebServer(options: WebOptions): WebServer;
```

Behaviour: section 3. Default `staticDir` is computed by `cli.ts`: `new URL('../client/', import.meta.url)` from
`dist/server/cli.js`, i.e. `dist/client`, used only when it contains `index.html`.

**`listen()` and the agents' loopback.** It binds `host:port`. When `host` is a specific address that is neither a wildcard (`0.0.0.0`, `::`) nor a loopback address (`127.0.0.1`, `::1`) (a LAN address, a Tailscale `100.x`), it **also** binds `127.0.0.1` on the same port with the same
request and upgrade handlers (a second `http.Server`, one shared `WebSocketServer`; with `port: 0` the second bind reuses the port the first got): the agents are always handed a loopback URL (2.8 step 8) and claude would block a private one. It rejects when either bind fails, closing the one that succeeded; `close()` closes both.
A bind host of `localhost` never reaches this module (cli maps it to `127.0.0.1`).

### 2.8 `cli.ts` and `bin/gonogo.js` (builder E)

```ts
export interface StartOptions {
  host?: string;                       // default env GONOGO_HOST or DEFAULT_HOST; "localhost" and "" mean 127.0.0.1
  port?: number;                       // default env GONOGO_PORT or DEFAULT_PORT; 0 = any
  home?: string;                       // default env GONOGO_HOME or ~/.gonogo
  seed?: boolean;                      // default env GONOGO_SEED_CLAUDE is "1" or "true"
  agentCmd?: string[] | null;          // default parseAgentCmd(env.GONOGO_AGENT_CMD)
  cwd?: string;                        // default process.cwd(): the boss's directory
  maxHops?: number;                    // default env GONOGO_MAX_HOPS, else DEFAULT_MAX_HOPS (1..MAX_HOPS_LIMIT, else warn and default)
  allowedHosts?: string[];             // default split of env GONOGO_ALLOWED_HOSTS on ","
  staticDir?: string | null;           // default: dist/client when it has index.html, else null
  env?: Record<string, string | undefined>;   // default process.env; the base of the claude children's environment too
  log?: Logger;                        // default nullLogger
  checkClaude?: boolean;               // default true; ignored (no check) when agentCmd is set
}
export interface Running {
  url: string;                         // the printed URL, with the #token fragment
  host: string; port: number;          // actual bound address
  browserToken: string;
  home: string;
  stop(): Promise<void>;               // idempotent graceful shutdown
}
export function startGonogo(options?: StartOptions): Promise<Running>;
export function main(argv: string[], env?: Record<string, string | undefined>): Promise<void>;  // the CLI
```

**`startGonogo` wiring, in this order (this is the glue of the whole system):**

1. Resolve options. A bind host of `localhost` or an empty one becomes `127.0.0.1` before anything else (`listen(port, 'localhost')` binds whichever address `localhost` resolves to first, often `::1` only, and every `127.0.0.1` URL below would be refused).
   When `agentCmd` is not set and `checkClaude !== false`, look for an executable named `claude` on `env.PATH`; missing: throw `Error('the claude CLI was not found on PATH. Install Claude Code and sign in, or set GONOGO_AGENT_CMD.')`.
2. `home = openHome(resolve(home), log)` (takes the lock, 2.4). **Everything after this call, up to step 10, runs in a `try`; its `catch` runs `await web?.close()`, `await terminals?.stopAll()` and `await home.close()` (which releases the lock) and rethrows**, so a failed start leaves no listening port, no process and no lock.
   Then `home.loadRoster()` at once, discarding the result: a corrupt `agents.json` stops the start here, before anything listens. `terminals = createTerminalHost({ log: log.child('terminal') })`.
   For `home.dir` and the boss's directory `cwd`, `fs.accessSync(dir, W_OK)`; on failure log one `warn`: `<dir> is not writable by uid <n>; chown it to that uid` (a Docker bind mount keeps the host's ownership and the image runs as uid 1000, 2.9).
3. `let baseUrl = ''; let ready = false`. `launcher = createLauncher({ homeDir: home.dir, hubUrl: () => baseUrl, seed, env, agentCmd, log: log.child('launcher') })`.
4. `let seq = home.lastMessageSeq()`. Build `io: HubIo` **with arrow functions, never with methods taken off their objects** (`import { randomUUID } from 'node:crypto'`: the global `crypto.randomUUID` detached from `crypto` throws `ERR_INVALID_THIS`):
   `now = () => Date.now()`; `setTimer = (fn, ms) => setTimeout(fn, ms).unref()` and `clearTimer = (h) => clearTimeout(h as NodeJS.Timeout)`;
   `newMessageId = () => 'm' + ++seq`; `newSessionId = () => randomUUID()`;
   `checkDirectory(p)`: not absolute -> `{ ok: false, error: 'directory must be an absolute path' }`; `stat` fails ->
   `{ ok: false, error: 'directory does not exist: <p>' }`; not a directory -> `{ ok: false, error: 'not a directory: <p>' }`;
   else `{ ok: true, path: resolve(p) }`;
   `loadRoster = async () => home.loadRoster()`; `saveRoster = (r) => home.saveRoster(r)`; `loadHistory = async (n) => home.loadRecentMessages(n)`;
   `logMessage = (r) => home.appendMessage(r)`;
   `renameAgentFiles = async (o, n) => { await launcher.renameAgentFiles(o, n); terminals.rename(o, n); }`;
   `spawn = async (req) => { const p = await launcher.prepareStart(req.agent, { generation: req.generation, flag: req.flag }); try { const { pid } = terminals.spawn(req.agent.name, req.generation, p.spec); return { generation: req.generation, flag: p.flag, pid }; } catch (e) { launcher.revoke(req.agent.name, req.generation); throw e; } }`;
   `stop = (name, g) => terminals.stop(name, g)`; `typePointer = (name, g, text) => terminals.submit(name, g, text)`;
   `screen = (n) => terminals.screen(n)`, `title = (n) => terminals.title(n)`, `outputBytes = (n) => terminals.outputBytes(n)`; `emit = (e) => web?.broadcast(e)` (late bound); `log = log.child('hub')`.
   (0.3 item 12 also makes every factory return closures, so a detached method would work too; the arrows are the rule anyway.)
5. `hub = createHub(io, { maxHops, bossDir: cwd })`.
6. `terminals.onEvent((e) => { if (e.kind === 'exit') launcher.revoke(e.name, e.generation); hub.onTerminalEvent(e); })`.
   Subscribe before the first spawn. The revoke comes first so a hook in flight after the exit is refused with 401.
7. `web = createWebServer({ host, port, browserToken: home.browserToken, allowedHosts, staticDir, hub, terminals, resolveToken: (t) => launcher.resolveToken(t), info, isReady: () => ready, log: log.child('web') })`
   where `info()` builds `ServerInfo` (`version` from `package.json` read with `new URL('../../package.json', import.meta.url)`,
   which resolves from both `src/server` and `dist/server`).
8. `const addr = await web.listen()`; then set `baseUrl = 'http://' + agentHost + ':' + addr.port` where **`agentHost` is `127.0.0.1`, or `[::1]` when the bind host is `::1`: whatever the bind host is.** Agents never receive the bind host: claude's http hooks accept
   loopback and public addresses only and answer `HTTP hook blocked` for a private one (a LAN address, a Tailscale `100.x`; facts `claude-code-hooks-mcp.md` 5.4), which would silence every hook of every agent. For a specific non-loopback bind host `web.listen()` also listens on
   `127.0.0.1` with the same handlers (2.7), so the loopback URL always connects. Tests: no URL in the generated `settings.json` or `mcp.json` has a host other than `127.0.0.1` or `[::1]` (10.2); `--host 192.168.x.x`-style binds answer on loopback too (10.4).
9. `await hub.start()` (this starts the boss; the hook and MCP endpoints are already listening), then `ready = true`. Until then every `/api` route and `/ws` answer `503 {"error":"starting","code":"unavailable"}` (3.3): a browser tab that was reconnecting during a
   restart (8.4 retries forever) must not open its WebSocket onto an empty roster and miss the stopped agents, which never emit a frame of their own.
10. Return `Running`. `url = 'http://' + displayHost + ':' + addr.port + '/#token=' + home.browserToken` with
    `displayHost` = `127.0.0.1` for a wildcard or loopback bind host, else the bind host.
11. `stop()`: idempotent, safe from signal handlers. `await hub.shutdown()` comes first and sets the hub's `closing` flag synchronously: from that moment `hire`, `edit`, `restart`, `stop` and `remove` are rejected (REST answers `409 the server is shutting down`, 2.1 rule 7), so
    nothing can start a claude that the steps below would not stop; `/hook`, `/mcp` and the open WebSockets keep working so the agents can finish. Then `await terminals.stopAll()`, `await web.close()`, `await home.close()`, within `SHUTDOWN_MAX_MS`.
    The mechanism that leaves nothing running is 6.8 (SIGTERM, SIGKILL after 5 s, give up after 3 s more: 8 s in all, inside `SHUTDOWN_MAX_MS`); there is no other sweep.

**`main(argv, env)`** parses arguments, calls `startGonogo` with `log = createLogger({ level: env.GONOGO_LOG_LEVEL ?? 'info' })`
installs the signal handlers, and prints exactly one line to **stdout** after the server listens:

```
gonogo ready: http://127.0.0.1:7777/#token=<64 hex>
```

(the smoke script and the README parse it with `/^gonogo ready: (\S+)$/m`), and everything else to stderr through
the logger. Flags (flag beats env beats default; `--` options may be written `--port=7777` or `--port 7777`):

| Flag | Env | Meaning |
|---|---|---|
| `--port <n>` | `GONOGO_PORT` | listen port, default 7777 |
| `--host <addr>` | `GONOGO_HOST` | bind address, default 127.0.0.1. A specific non-loopback address also listens on 127.0.0.1 for the agents (2.7); `localhost` means 127.0.0.1 |
| `--home <dir>` | `GONOGO_HOME` | state directory, default `~/.gonogo` |
| `--seed-claude` | `GONOGO_SEED_CLAUDE=1` | seed mode (7.6) |
| `--allow-host <name>` (repeatable) | `GONOGO_ALLOWED_HOSTS` (comma list) | extra accepted `Host` names (3.2) |
| `--help`, `-h` | | usage, exit 0 |
| `--version`, `-v` | | `gonogo <version>`, exit 0 |
| | `GONOGO_MAX_HOPS` | hop cap, default 8 |
| | `GONOGO_AGENT_CMD` | replaces `claude` (7.7) |
| | `GONOGO_LOG_LEVEL` | `debug` `info` `warn` `error`, default info |

Unknown flag: print usage to stderr, exit 2. Startup failure (port in use, another gonogo on the home, corrupt `agents.json`, claude missing): one line `gonogo: <message>` on stderr, exit 1, no stack trace unless `GONOGO_LOG_LEVEL=debug`.

**Signals and errors.** `SIGINT`, `SIGTERM`, `SIGHUP` call `running.stop()` then `process.exit(0)`; a second signal exits at once with 130. Any error before `startGonogo` resolves exits 1 as above. **After start, `uncaughtException` and
`unhandledRejection` are the last resort, not the policy**: an error whose `code` is in `TRANSIENT_ERROR_CODES` or starts with an entry of `TRANSIENT_ERROR_PREFIXES` (a reset socket, a destroyed stream, headers already sent, an oversized WebSocket frame: anything a client or a vanished terminal
can cause) is logged at `warn` with its stack and the process keeps running; any other error logs its stack, runs `running.stop()` and exits 1. Every agent dies with the server, so the handlers themselves must be rare. To keep that true: `main()` installs
`process.stdout.on('error', () => {})` and `process.stderr.on('error', () => {})` (a closed terminal or pipe must not end the agents; the logger and the fatal handler write to the same streams); the web layer follows the hostile-input rules of 3.2 and the WebSocket rules of 3.4; every
promise that is not awaited ends in `.catch(...)` that logs (11).

**`bin/gonogo.js`**: `#!/usr/bin/env node`; if `Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR (24)` print
`gonogo needs Node 24 or newer (this is <version>).` to stderr and exit 1 **before any import**; then
`try { const { main } = await import('../dist/server/cli.js'); await main(process.argv.slice(2)); } catch (e) { process.stderr.write('gonogo: ' + e.message + '\n'); if (process.env.GONOGO_LOG_LEVEL === 'debug') process.stderr.write(String(e.stack) + '\n'); process.exit(1); }`.
The catch exists because `terminal.ts` loads the pty library at import time, and its loader throws a long, helpful message (platform package missing: `--omit=optional`, Alpine/musl, armv7, a `node_modules` copied between systems) that must reach the user as one line, not as a stack with `[cause]`. No other code.

### 2.9 Packaging (builder H): `Dockerfile`, `.dockerignore`, `README.md`, `scripts/smoke-real.mjs`

H writes no TypeScript. Start from `docs/facts/Dockerfile.probe` (never built: the Docker daemon was down) and keep its structure.

**Dockerfile** (multi-stage, `ARG NODE_IMAGE=node:24-bookworm-slim`):
1. Stage `build`: `WORKDIR /src`, `corepack enable pnpm` (it runs the pnpm that `packageManager` pins), copy `package.json pnpm-lock.yaml`, `pnpm install --frozen-lockfile`, copy the rest, `pnpm pack --pack-destination /out` (the `prepack` script builds client and server, so a packaging error fails the image build); then unpack the tarball into `/app`, copy `pnpm-lock.yaml` there and run `pnpm --dir /app install --prod --frozen-lockfile` (the tarball has no lock: this gives the image the tested versions and no devDependency).
2. Stage `runtime`: Debian slim, never Alpine (the pty binaries need glibc). `apt-get install -y --no-install-recommends ca-certificates git tini` (+ cleanup; `tini` reaps the orphans that agents' tools leave behind, 3.5 of `toolchain-docker.md`, and forwards signals even when the user forgets `--init`); `git config --system --add safe.directory '*'`;
   `corepack pnpm@${PNPM_VERSION} add --global --config.global-dir=/usr/local/share/pnpm --config.global-bin-dir=/usr/local/bin --config.enable-global-virtual-store=false --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}` (default `2.1.325`, as an `ARG`; `PNPM_VERSION` is an `ARG` equal to the `packageManager` release) **followed by `claude --version`** in the same `RUN` (pnpm skips the postinstall without `--allow-build`, and the check then fails the build), then remove pnpm's store and corepack's cache; this layer comes before the gonogo layer.
   `COPY --from=build /app /opt/gonogo`, `ln -s /opt/gonogo/bin/gonogo.js /usr/local/bin/gonogo`. `mkdir -p /state /projects && chown node:node /state /projects`.
3. `ENV HOME=/home/node CLAUDE_CONFIG_DIR=/state/claude GONOGO_HOME=/state/gonogo GONOGO_SEED_CLAUDE=1 DISABLE_AUTOUPDATER=1 LANG=C.UTF-8`. `IS_DEMO` is **not** set (the server gives it to each claude child in seed mode).
4. `USER node` (uid 1000; `bypassPermissions` refuses root), `WORKDIR /projects` (the boss starts there), a build-time `RUN` as `node` proving that `claude --version` runs and that the pty library loads and spawns `/bin/sh -c 'echo pty-ok'` (as in the probe file),
   `VOLUME ["/state", "/projects"]`, `EXPOSE 7777`, `ENTRYPOINT ["tini", "-s", "--", "gonogo"]` (`-s` makes `tini` a subreaper, so reaping also works when Docker's own `--init` is present and `tini` is not PID 1), `CMD ["--host", "0.0.0.0", "--port", "7777"]` (home comes from `GONOGO_HOME`).
5. The header comment holds the documented run command: `docker run -d --name gonogo --init -p 127.0.0.1:7777:7777 -e CLAUDE_CODE_OAUTH_TOKEN -v gonogo-state:/state -v gonogo-projects:/projects gonogo:<tag>`, then `docker logs gonogo` for the line `gonogo ready: http://127.0.0.1:7777/#token=...`.
   (inside the container the server binds `0.0.0.0` and prints `127.0.0.1`: correct when the host port is also 7777; the README says what to do otherwise). One credential only: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`, never both.
   **`/projects` is a named volume in the documented command** (a named volume copies the image's ownership, uid 1000, on first use). The variant that bind-mounts a host folder (`-v "$PWD/projects":/projects`) keeps the host's ownership: on Linux a missing folder is created by the daemon as `root:root` and an existing one usually belongs to a user that is not uid 1000, and then the boss and every
   agent working there cannot write (the only symptom would be claude errors inside a terminal). The header comment and the README give it with `mkdir projects && sudo chown 1000:1000 projects`; `--user $(id -u):$(id -g)` is **not** the fix (`/state` and `HOME=/home/node` would become unwritable). `cli.ts` also warns at start when the home or the boss directory is not writable (2.8 step 2).
   Seed mode trusts every folder an agent is hired into (7.6): the README says so next to the run command.
   Nothing is pushed anywhere; nothing is published.

**`.dockerignore`**: `node_modules`, `dist`, `.git`, `*.tgz`, `.env`, `.env.*`, `.gonogo`, `docs`, `test`, `scratch`, `.DS_Store` (the build stage rebuilds `dist` through `prepack`; tests are not needed in the image).

**README.md** (plain, short, honest): what it is (one paragraph); **requirements** (Node 24 or newer; `claude` on the PATH and signed in; macOS, or Linux with glibc 2.28 or newer: **no Alpine**, and do not install with `--no-optional` (npm's `--omit=optional`), because the pty library ships its binary as an optional platform package; an unsupported platform makes `gonogo` print the loader's one-line message and exit 1); `pnpm dlx gonogo` and its options (the table of 2.8); the URL line and where the token lives (`~/.gonogo/token`);
the screen (floor, tabs, terminal, brief the boss, activity); agents and messages in five lines (pointer, `read_messages`, states, hold rules); the boss and its working directory (**started from the home directory, Claude Code asks the trust question on every start**; the README says so);
state on disk (`agents.json`, `messages.jsonl` and its rotated `messages.jsonl.1`, `server.lock`, `agents/<name>/`); security (loopback by default, browser token, Host/Origin checks, no TLS: put a reverse proxy or a private network in front and pass `--allow-host`, agents in `bypassPermissions` run as your user and can read the token files, credentials in the container environment are readable by the agents' shells;
agents always talk to the server on 127.0.0.1, even when you bind another address; **a working proxy recipe** (below); **seed mode trusts the folders you hire agents into, so repository hooks and settings run with your credential: add only repositories you trust**);
**reverse proxy recipe**: for nginx `proxy_pass http://127.0.0.1:7777; proxy_http_version 1.1; proxy_set_header Host $http_host; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 3600s;` plus `--allow-host gonogo.example.com` on gonogo (nginx rewrites `Host` to the upstream address by default, which makes every request fail the Origin check 3.2 rule 2; stop and restart requests take up to 8 s and sockets live for hours, hence the long timeout; Caddy's `reverse_proxy` keeps the Host and needs no extra line);
the browser token travels in the `Sec-WebSocket-Protocol` header of `/ws`, so the proxy **must not log that header** (it is not in the URL, so default access logs do not hold it);
Docker (the run command with the two named volumes; the bind-mount variant and its `chown 1000:1000`; seed mode, what `IS_DEMO=1` costs: the account name is hidden in Claude's header, and the trust sentence above), environment variables (the table of 2.8), troubleshooting (agent stuck in "needs you"; trust dialog; `held: text in <name>'s input` means the input box still holds text: submit it, or clear it with Ctrl-C (or Esc twice) in that terminal and gonogo notices within about two seconds; `held: no hook has reached gonogo from <name>; is its folder trusted?` means hooks are silent: an untrusted folder, or a blocked URL; `held: pointer not confirmed within 2 s`),
development (`pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm check:pack`, `pnpm smoke:real`; to try the tarball by hand `pnpm pack` then `pnpm dlx file:/abs/path/gonogo-<version>.tgz`), and **what was not verified** (Linux, the container's real sign-in, a real `claude` inside the image: sections 13 and 10.8 of the contract) — written as facts, no marketing.

**scripts/smoke-real.mjs** and **scripts/check-pack.mjs**: section 10.8.

## 3. HTTP and WebSocket surface

Owner: builder E (server), consumed by F (client), D (e2e test) and H (smoke script). One Node `http` server, no
framework. Types of every body are in `protocol.ts` (Part 2).

### 3.1 Routes

| Route | Method | Auth | What |
|---|---|---|---|
| `/`, `/assets/*`, `/index.html`, other static paths | GET, HEAD | none | the built client (3.7) |
| `/api/state` | GET | browser token | `StateSnapshot` |
| `/api/agents` | POST | browser token | hire |
| `/api/agents/:name` | PATCH, DELETE | browser token | edit, remove |
| `/api/agents/:name/stop` | POST | browser token | stop |
| `/api/agents/:name/restart` | POST | browser token | restart (also starts a stopped agent) |
| `/api/messages` | POST | browser token | message from the user |
| `/ws` | GET (Upgrade) | browser token in the `Sec-WebSocket-Protocol` header (3.2) | terminals and events |
| `/hook/:agent/:event` | POST | agent token | Claude Code hooks |
| `/mcp` | POST (GET, DELETE answer 405) | agent token | MCP tools |

Any other path under `/api`, `/hook`, `/mcp`, `/ws` is 404 (JSON error body). Any other method on a known route is 405
with an `Allow` header. `OPTIONS` is always 405 and no CORS header is ever sent.

### 3.2 Who may talk to the port

Checks run in this order for every request and upgrade; the first failure answers and stops.

1. **Host header.** Required. Take the host part (strip the port; `[::1]:7777` gives `::1`), lower-case it. It must be
   one of: `127.0.0.1`, `localhost`, `::1`; every entry of `allowedHosts` (lower-cased, port stripped); the bind
   host when it is a specific address (not `0.0.0.0` or `::`). Otherwise `403`, `text/plain`, body `forbidden host`.
   This stops DNS-rebinding: a page on `evil.example` that resolves to 127.0.0.1 sends `Host: evil.example:7777`.
2. **Origin header** (not applied to GET/HEAD of static files).
   - `/api/*` and `/ws`: if an `Origin` header is present, it is parsed inside a `try`; `new URL(origin).host` must equal the request's `Host`
     header (case-insensitive) and its hostname must pass rule 1; else `403`, `text/plain`, `forbidden origin`. **An `Origin` that does not parse (`null`, which browsers send from a sandboxed iframe, empty, garbage) is the same `403`.**
     No `Origin` (curl, the e2e test, server-side clients) is allowed: the token still applies.
   - `/hook/*` and `/mcp`: any `Origin` header at all is refused with `403 forbidden origin`. claude never sends one; a web page would.
   Behind a reverse proxy that rewrites `Host` to the upstream address (nginx does by default) the browser's `Origin` no longer equals `Host` and every request fails here: the README gives the proxy lines that keep it (`proxy_set_header Host $http_host`) and the `--allow-host` to pass (2.9).
3. **Token.**
   - Browser routes and `/ws`: the browser token (`home.browserToken`). REST: `Authorization: Bearer <token>`. **WebSocket: the `Sec-WebSocket-Protocol` request header**, which a browser can set through the second argument of `new WebSocket(url, protocols)`:
     `new WebSocket(url, [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + token])` offers `gonogo.v1, token.<64 hex>`. The server takes the offered entry that starts with `token.` and compares the rest; `handleProtocols` selects `WS_SUBPROTOCOL` only, so the secret is never echoed.
     **The token is never in a URL**: the printed URL has it in the fragment, which no server sees, and reverse proxies, load balancers and access logs record request lines, query string included, on every connect and every reconnect (the client reconnects every 0.5 to 10 s while the server is down); a token in `?token=` is not accepted.
     The README tells proxy operators not to log `Sec-WebSocket-Protocol`.
     **Comparison**: hash both sides with SHA-256 and `crypto.timingSafeEqual` the two 32-byte digests. Never `timingSafeEqual` two strings after comparing their JS lengths: 64 non-ASCII characters have the length of a token and a different byte length, and `timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`.
     Failure: `401`, JSON `{"error":"unauthorized","code":"unauthorized"}`, header `WWW-Authenticate: Bearer`. On an upgrade the server writes the `HTTP/1.1 401 Unauthorized` response line and destroys the socket (with the socket error listener of 3.4 still attached).
   - `/hook/*` and `/mcp`: `Authorization: Bearer <agent token>`; `resolveToken(token)` gives `{agent, generation}` or null (401).
     A token is valid for these two routes only. The browser token is never accepted there and an agent token is never accepted on `/api` or `/ws`
     (they are different random values, and each route only asks its own authority).
   - Static files need no token (a browser cannot attach a header to a navigation or a module script; the files hold no state).
4. **Ready, route, method, body.** While `isReady()` is false every `/api` route and `/ws` answer `503 {"error":"starting","code":"unavailable"}` (after the token check, so a stranger learns nothing). 404 / 405 / 415 / 413 / 400 as in 3.3.

Always sent: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. On API, hook and MCP
responses also `Cache-Control: no-store`. No cookies, no sessions, no CORS headers.

**Hostile input (builder E follows these and tests each).** Any web page can make a browser send `GET http://127.0.0.1:7777//`, an `Origin: null` preflight or a WebSocket handshake before any token is checked, and an uncaught exception ends every agent (2.8). So:

1. The `request` and `upgrade` handlers are wrapped in `try/catch` (and every async handler's promise is caught): an exception is logged with its stack and answered `500` (an upgrade: the socket is destroyed). Nothing is rethrown.
2. **`req.url` is never passed to `new URL`** (`new URL('//', base)` and `new URL('//[', base)` throw `ERR_INVALID_URL`). Split at the first `?`; the path must start with exactly one `/` (a path that starts with `//` is `404`); decode with `decodeURIComponent` inside a `try` (a `URIError` is `404`); a NUL byte anywhere is `404`. The query string is not used by any route.
3. `Origin` is parsed inside a `try` (rule 2 above).
4. **Static files** (3.7): `stat` first and serve only `isFile()` (a directory such as `/assets` is `404`; piping a stream opened on a directory emits `EISDIR` on the stream and killed a test server); send with `stream.pipeline(createReadStream(path), res, callback)` whose callback destroys `res` on error.
5. Token comparison: SHA-256 digests, as above.
6. `:name` in `/api/agents/:name` is validated with `AGENT_NAME_PATTERN` after decoding; a miss is `404 unknown agent`.

Tests (10.4): `GET //`, `GET //[`, `GET /%E0%A4%A`, `GET /assets` (a directory in `dist/client`), `Origin: null` on `/api`, `/ws`, `/hook`, `/mcp`, a 64-character non-ASCII bearer token and the same in the WebSocket subprotocol: each answers a 4xx and **the server still answers a normal request afterwards**.

**How the browser token travels.** The server prints `http://127.0.0.1:7777/#token=<64 hex>`. The fragment is never sent to
a server and never logged. `main.tsx` reads `location.hash` (key `TOKEN_FRAGMENT_KEY`), stores the token in
`localStorage[TOKEN_STORAGE_KEY]` (inside try/catch; keep it in memory if storage throws), and removes the fragment with
`history.replaceState`. From then on: REST sends the header, the WebSocket the subprotocol pair. Without a token in the URL
the client uses the stored one. A 401 from `GET /api/state` clears the stored token and shows the page "Open the URL that
`gonogo` printed (it ends in `#token=...`)".

### 3.3 REST

All bodies are JSON (`Content-Type: application/json`, UTF-8). Request bodies larger than `MAX_REST_BODY_BYTES`: 413
(`code: too_large`). A POST/PATCH with a body but another content type: 415 (`code: unsupported`). Invalid JSON, or JSON that is
not an object: 400. Unknown fields are ignored. Errors always have the shape `ApiError`. `HubError.code` maps to status:
`bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `too_large` 413, `unsupported` 415,
`internal` 500, `unavailable` 503 (answered by the web layer only, while the hub has not started, 3.2 rule 4). A thrown non-HubError is logged with its stack and answered `500 {"error":"internal error","code":"internal"}`.
`:name` that does not match the name pattern is 404 `unknown agent`.

| Request | Success | Errors |
|---|---|---|
| `GET /api/state` | `200 StateSnapshot` (`agents` sorted by `desk`, `activity` newest first) | |
| `POST /api/agents` `HireRequest` | `201 AgentView` (state `starting`) | 400 bad name / reserved / role empty or too long / dir not absolute, missing or not a directory (`field` says which) / mode / `confirmBypass` missing for bypassPermissions; 409 name taken, office full (`MAX_AGENTS`) |
| `PATCH /api/agents/:name` `EditRequest` | `200 AgentView` (changes apply at the next start; `dirty` is true while running; **a rename emits `agent-removed` for the old name and then the frame of the new one**, 4.9) | 400 as above or empty body; 404; 409 rename while not stopped, new name taken, `agents/<new>` exists |
| `POST /api/agents/:name/restart` | `200 AgentView` once the new process exists in the terminal host (state `starting`; a spawn that fails answers the view in state `stopped` with `exit.text`) | 404 |
| `POST /api/agents/:name/stop` | `200 AgentView` after the process exited (up to 8 s); idempotent on a stopped agent | 404 |
| `DELETE /api/agents/:name` | `204` after the process exited and the record was removed | 404; 409 `the boss cannot be removed` |
| `POST /api/messages` `UserMessageRequest` | `201 SendResult` (the message is from `user`, hops 0) | 400 empty/too long body, subject too long, `to` is `user`; 404 unknown recipient (`field: "to"`) |

Hire is create + save + start. A hire that cannot spawn (pty failure) still returns `201` with the agent in state `stopped` and
`exit.text` explaining; the roster keeps it. Once the server is shutting down (`stop()`, 2.8 step 11) `POST /api/agents`, `PATCH`, `DELETE` and the stop and restart routes answer `409` `the server is shutting down`; `GET /api/state` and `POST /api/messages` keep working.

### 3.4 WebSocket `/ws`

One socket per browser tab. JSON text frames carry control and events; **binary frames carry terminal bytes** (server to client only). Created with `ws` (`noServer`, `perMessageDeflate: false`, `maxPayload: WS_MAX_FRAME_BYTES`,
`handleProtocols` selecting `WS_SUBPROTOCOL` only); the upgrade handler runs checks 1 to 4 of 3.2 before it accepts. A frame that is too big closes the socket with 1009.

**Error listeners (a missing one is an uncaught exception that ends every agent; both crashes were reproduced with the `ws` library).**
- After Node emits `upgrade` the raw socket has **no** `error` listener. The first line of the upgrade handler is `socket.on('error', noop)`; it is removed just before `wss.handleUpgrade(...)` (the `ws` README pattern) and stays attached on the 401 and 503 paths, which write the response line and `socket.destroy()`:
  a client that resets the connection meanwhile would otherwise throw `ECONNRESET` out of the process.
- `ws` emits `error` (`WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`) on a socket that receives a frame over `maxPayload` and then closes it with 1009. Every accepted socket gets `ws.on('error', log)` at once; `wss.on('error', log)` and, after `listen`, `server.on('error', log)` too. None of them rethrows.
- The client never gets near the limit: it splits one input into pieces of at most `WS_INPUT_CHUNK_CHARS` (8.4), so pasting a 300 KB log into a terminal arrives as ten frames.

**On open** the server sends `{"t":"state","state":StateSnapshot}`. Afterwards it pushes `agent`, `agent-removed` and `activity`
frames for every change (the same objects the hub emits). The client keeps no polling.

**Terminal attachment.** A socket is attached to at most one agent at a time.

1. Client: `{"t":"attach","seq":7,"agent":"ana","cols":100,"rows":30}` (`cols`/`rows` optional, the client's fitted size).
2. Server: unknown agent -> `{"t":"error","message":"unknown agent","ref":"attach"}`. Otherwise it detaches the previous
   attachment, applies the size (rule below) when the agent runs, then `await terminals.attach(agent, listener)`. If the socket
   closed or a newer `attach` arrived meanwhile it calls `detach()` and sends nothing. Else it sends
   `{"t":"snapshot","seq":7,"agent":"ana","generation":3,"cols":100,"rows":30,"running":true,"data":"<serialize() + fix-ups>"}`
   and **then** calls `attachment.start()`; from then on every chunk is sent as a binary frame:
   byte 0 = `WS_BINARY_OUTPUT` (1), bytes 1 to 4 = seq (uint32 big endian), then the raw bytes.
3. The client builds (or resets) an xterm of the snapshot's `cols` x `rows`, writes `data`, then writes binary payloads whose
   seq equals its current seq, and ignores others. After that it may `fit()`; a changed size is sent as a `resize` frame (when it is the size owner, below).
4. **Re-attach.** The client remembers the `generation` and `running` of the last snapshot it applied. On every `AgentFrame` of the attached agent it sends a new `attach` when `agent.generation !== snapshot.generation`, or when `snapshot.running === false` while `agent.state !== 'stopped'`
   (a stopped agent that was attached and then started; a restart; the flip retry). At most one attach is in flight per (agent, generation). The hub emits the `starting` frame only after the new process exists in the terminal host (4.9), so that attach already finds the new record; a snapshot taken
   before it (a tab that connected inside the spawn window) is healed by the rule on the next frame. Without this a pane that attached to the old, finished record would never see the new process (the terminal host tells the sockets of a replaced record nothing). 8.4 repeats the rule for the pane.
5. `{"t":"detach"}` detaches. Closing the socket detaches.

**Input and size.** `{"t":"input","agent":"ana","data":"..."}` (and `"binary":true` when `data` is the byte string from xterm's
`onBinary`; the server writes `Buffer.from(data, 'latin1')`). `agent` must be the attached agent, else an `error` frame with
`ref: "input"` and the input is dropped. The server calls `terminals.write(agent, data)`; only when it returns true, it calls
`effect = hub.onUserInput(agent, data)`. `{"t":"resize","agent":"ana","cols":100,"rows":30}`: **`agent` must be the attached agent too** (else an `error` frame with `ref: "resize"`: a debounced resize of the pane that was just left must not take the size of an agent this tab no longer shows);
integers, clamped to `MIN_COLS..MAX_COLS` x `MIN_ROWS..MAX_ROWS`; anything else is an `error` frame (`ref: "resize"`).

**The pty has one size, owned per agent in `web.ts` by the last socket that did one of three things: sent a valid `resize`; attached with a size; or sent an `input` whose `effect` is `set` or `clear`** (printable text, Enter, Ctrl-C: a keystroke that
a person made). An `input` chunk whose effect is `none` never takes the size: that is every focus report (`ESC[I`/`ESC[O`; claude enables `?1004h`), mouse report (`?1003h` any-motion tracking sends one per pixel of movement), device-attribute or colour reply that a tab's xterm
sends **on its own** (all arrive as `onData`), and 4.6 lists them as input that does nothing. Without this, hovering the second tab of one agent took the size and repainted the first, and two windows fought over the pty on every mouse move.
When a socket takes ownership with a size that differs from the pty's, `terminals.resize` is called (after the write when the trigger was an input; the size is the one that socket last sent or attached with, and an input from a socket that never sent a size takes nothing). **Whenever the pty size changed** (compare `terminals.info(agent)` before and after), every socket attached to that agent
receives `{"t":"size","agent":"ana","cols":140,"rows":45}` (the socket that caused it included; a client ignores a size equal to its own). Without it a window that is not the owner keeps an xterm of its old size while claude repaints for the new one, and shows garbage until it attaches again.
Closing the owning socket clears ownership (the pty keeps its size; the other windows are already at that size and keep following size frames until one of them takes over, 8.4).

**Liveness and limits.** The server pings every `WS_PING_INTERVAL_MS`; a socket that did not answer the previous ping is
terminated. When `bufferedAmount` exceeds `WS_MAX_BUFFERED_BYTES` the server closes it with 1013 (the client reconnects and gets a
fresh snapshot, nothing is lost). On `close()` of the server every socket gets 1001. Malformed JSON, a non-object, or an unknown `t`:
`{"t":"error","message":"bad frame","ref":"frame"}`, the socket stays open.

### 3.5 Hook endpoint `POST /hook/<agent>/<event>`

Called by claude (native `http` hooks, `axios` user agent). Checks 1 to 3 of 3.2 (Origin must be absent), then:

1. `<agent>` must match the name pattern and `<event>` must be in `HOOK_EVENTS`, else `404`.
2. The token must resolve; `identity.agent` must equal `<agent>`, else `403 {"error":"token does not belong to this agent","code":"forbidden"}`.
3. Body: up to `MAX_HOOK_BODY_BYTES` (else `413`, remaining bytes drained); must parse as a JSON object (else `400`). `Content-Type` is not checked.
4. `reply = hub.onHook({ agent, generation: identity.generation, event, payload })`. Respond `200`, `Content-Type: application/json`,
   body `JSON.stringify(reply)`. Only `Stop` may carry `decision`/`reason`; for every other event the body is `{}` whatever the hub returned.
   The handler must answer without waiting for any I/O (the hook timeout is 10 s; the typical answer takes 1 ms).
5. **Stop reply bodies**: `{}` lets the agent go idle. `{"decision":"block","reason":"gonogo: 1 new message from ana. Call read_messages."}`
   makes it carry on with that text as feedback (claude shows it to the model as `Stop hook feedback:\n<reason>`).
6. Errors thrown by the hub: log the stack, answer `500` (claude treats it as a non-blocking error).

A failing hook never stops claude, so a lost or refused hook only leaves the state stale; the title glyph and screen
reconciliation (4.7) cover it.

### 3.6 MCP endpoint `POST /mcp`

Streamable HTTP, **stateless** (what `docs/facts/claude-code-hooks-mcp.md` section 6 verified against claude 2.1.325):

1. Checks 1 to 3 of 3.2. `GET /mcp` and `DELETE /mcp` (after auth) answer `405` with body
   `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}`; claude opens a GET once and carries on.
2. Read the body (up to `MAX_MCP_BODY_BYTES`), parse JSON (400 on failure).
3. Per request: `const server = new McpServer({ name: 'gonogo', version })`, three tools registered, `const transport = new
   StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` (exactly this option object; do not set `enableJsonResponse`),
   `res.on('close', () => { transport.close().catch(logDebug); server.close().catch(logDebug); })` (both return promises: an unhandled rejection there is a floating promise, 11), `await server.connect(transport)`,
   `await transport.handleRequest(req, res, parsedBody)`. A handler that throws answers `500` and the server keeps serving (tested).
4. The caller's identity is `identity.agent` and `identity.generation` from the token, captured in the closure that builds the server. **`from` is always
   stamped from it**; no tool argument can name a sender. Every hub call passes the generation: `hub.sendFromAgent(identity.agent, identity.generation, req)`, `hub.readMessages(identity.agent, identity.generation)`, `hub.rosterFor(identity.agent, identity.generation)`.
   A `tools/call` that the edge authenticated just before the process exited can reach the hub after the restart created a new generation (the token is checked once per request, the tool callback runs later); the hub refuses it with `HubError('conflict', 'this session has ended')`
   instead of letting a dying process consume the queue that the restart keeps (4.10 rule 7). Like every `HubError` it becomes a tool error below.
5. Tools (`registerTool(name, { description, inputSchema }, handler)`, descriptions from `MCP_DESCRIPTIONS`). A tool result is
   `{ content: [{ type: 'text', text: JSON.stringify(object) }] }` and `isError: true` when the object has `"ok": false`.
   **Argument mapping** (the tool's arguments are snake_case, the hub's are not): `in_reply_to` becomes `AgentSendRequest.inReplyTo`; a missing `subject` becomes `''` (`AgentSendRequest.subject` is a required string).

| Tool | Input (zod) | Result object |
|---|---|---|
| `send_message` | `to: string (1..64)`, `subject: string (0..200), optional`, `body: string (1..20000)`, `in_reply_to: string (max 40), optional` | `{"ok":true,"id":"m12","to":"ben","status":"queued","note":"waiting: ben is working"}`; undelivered (stopped recipient, hop cap): `isError`, `{"ok":false,"id":"m14","to":"ben","status":"undelivered","note":"ben is stopped; the message went to the user"}`; rejected by the hub (unknown recipient, to self, empty body, stale session): `isError`, `{"ok":false,"error":"<HubError message>"}` |
| `list_roster` | none | `RosterResult` (a `HubError` becomes `isError`, `{"ok":false,"error":"..."}`) |
| `read_messages` | none | `ReadMessagesResult` (same for a `HubError`) |

   For a user recipient the success object is `{"ok":true,"id":"m13","to":"user","status":"to_user","note":null}`.
6. The tool list has exactly these three tools (claude calls them `mcp__gonogo__send_message` and so on).

### 3.7 Static client

`GET`/`HEAD` for any path that is not `/api`, `/hook`, `/mcp`, `/ws`: resolve under `staticDir` (reject any path whose
resolved location is outside it, and any path with a NUL byte: 404; follow the hostile-input rules of 3.2: `stat` first and serve **only regular files**, a directory is 404, send with `stream.pipeline`). A path with no file extension that does not exist serves
`index.html` (client routes). Missing file with an extension: 404 `text/plain`. `Content-Type` from a small table (html, js,
mjs, css, json, svg, png, jpg, ico, woff2, map, txt; default `application/octet-stream`). `index.html`: `Cache-Control: no-cache`;
files under `assets/`: `public, max-age=31536000, immutable`. When `staticDir` is null every static request is 404.

## 4. The state machine (builder A, `hub.ts`)

### 4.1 What the hub keeps per agent (runtime record `rt`, memory only)

`record` (`AgentRecord`, mirrored in `agents.json`), `state`, `stateSince`, `needsKind`, `needsReason`, `generation`
(0 until first spawn; only grows), `ready` (bool, per generation), `transition` (`null | 'stopping' | 'restarting' | 'removing'`),
`startedAt`, `lastBlockAt` (when a Stop block was last answered), `running` = `{ role, dir, mode }` copied from the record at spawn (for `dirty`), `flag` (flag used by the last start),
`flipAvailable` (bool: the one-time session flag flip, 4.9), `draft` (`null | { lastKeyAt }`), `unconfirmed`
(`null | { text, ids, since }`), `pendingConfirm` (`null | { text, ids, at }` plus its timer), `stopBlocks` (int),
`trigger` (`null | { ids, maxHops }`), `screenClearSince` (`null | ms`), `hooksSeen` (bool: false at spawn, true as soon as any hook of this generation reaches the hub), `lastInputAt` (ms of the browser's last input of any kind),
`pointed` (map message id -> how many times it became `delivered`, 5.5), `exit` (`ExitSummary | null`), timers
(startup, confirm, delivery), the lifecycle promise chain (it hangs on `rt`, so a rename only moves `rt` to the new key), and the **queue**: the message ids addressed to this agent whose status is `queued` or
`held`, oldest first. The message store (id to `MessageRecord`) is shared; `delivered` messages stay in it until read
or undelivered.

`AgentView` is derived: `draft` = latch active; `queued` = queue length; `held` = `{ kind: 'draft', text: "held: text in <name>'s input" }`
when the latch is active and the queue is not empty, else `{ kind: 'unconfirmed', text }` when that latch is set and the queue is not empty (`text` is the note the latch put on its items, 5.4: `held: pointer not confirmed within 2 s`, or the no-hook text), else null (an unconfirmed latch whose queue is empty cannot exist: 5.4, 5.6); `dirty` = state is not `stopped` and `record.role/dir/mode` differ from `rt.running`.

### 4.2 States

| State | Meaning | Delivery |
|---|---|---|
| `starting` | spawned, not ready (no prompt box yet) | waits |
| `idle` | ready, no turn running, prompt box expected | types a pointer (5.3) |
| `working` | a turn, a tool or a shell command is running | waits for the Stop hook (5.5) |
| `needs_you` | a dialog or permission prompt needs the user (`needsKind`, `needsReason`) | waits |
| `stopped` | no process | undelivered (5.2) |

`needs_you` reasons (exact text): `STARTUP_DIALOG_REASON` (kind `startup_dialog`); `permission request: <tool>[: <summary>]` (kind `permission`,
from `describePermission`: tool name, then the first present of `command`, `file_path`, `path`, `url` from `tool_input`, whitespace collapsed
to single spaces, cut to `PERMISSION_SUMMARY_CHARS` with a trailing `…`); `SCREEN_DIALOG_REASON` (kind `dialog`); `input requested: <message>` (kind `input`, message cut to 100).

### 4.3 Sources of change

1. **Lifecycle calls** (hire, edit, restart, stop, remove, start, shutdown): 4.9.
2. **Terminal events** (`onTerminalEvent`): `ready`, `title`, `exit`. A `title` event carries nothing the hub does not also get from `io.title(name)`; the hub may run the reconciliation rules at once or leave them to the sweep.
3. **Hooks** (`onHook`): 4.4.
4. **Sweep** (every `RECONCILE_TICK_MS`, one timer for the whole hub) and per-agent timers: reconciliation 4.7, startup 4.8, confirm 5.4, delivery 5.3.
5. **User input** (`onUserInput`): draft latch 4.6.

Every handler first drops the event when the agent is unknown or the event's `generation` is not `rt.generation`. A hook that passes this check sets `rt.hooksSeen = true`, even when a rule below then ignores it.

### 4.4 Hooks

`onHook` is synchronous and never throws (catch everything, log, return `{}`).

**Preamble, for every hook of the current generation:**

- P1. `rt.transition !== null`: return `{}`, change nothing (the process is going away; its late signals mean nothing).
- P2. `state === 'stopped'`: return `{}`.
- P3. `state === 'starting'`, or `needs_you` with kind `startup_dialog`: a hook proves the REPL is up (hooks are held back by claude until
  the folder is trusted and the dialogs are answered). Set `ready = true`, cancel the startup timer, state `idle` (clear needs fields), then
  apply the event rule below. A later `ready` terminal event is a no-op.

**Event rules** (after the preamble):

| Event | Rule |
|---|---|
| `UserPromptSubmit` | Delivery bookkeeping first (5.4: confirm, late confirm, or "a prompt that is not our pointer"). Then state `working`, `stopBlocks = 0`. If the prompt is not our pointer: clear the trigger and the unconfirmed latch (a person submitted; its held items are released, 5.4). **The draft latch is not touched here**: Enter and Ctrl-C clear it themselves (4.6), and claude queues a prompt typed while it works and submits it later, possibly after the user started a new draft. If `payload.session_id` is a UUID different from `record.sessionId`: set it and save the roster (claude started a new session after `/clear`). |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `stopBlocks = 0`. From `idle` or `working`: state `working`. From `needs_you`: if `io.screen(name)` is null or `dialog` is null, state `working`; if a dialog is still on screen stay `needs_you` (a sibling tool of the same batch finished; the dialog is still open). A tool the user allowed shows no hook until it ends (PostToolUse, or PostToolUseFailure when it errors); the way out of `needs_you` meanwhile is R4 (4.7). |
| `PermissionRequest` | state `needs_you`, kind `permission`, reason from `describePermission(tool_name, tool_input)`. Reply `{}`: the user decides. |
| `Notification` | by `payload.notification_type`: `permission_prompt`: only while the state is not `needs_you` **and `io.screen(name)?.dialog` is non-null**: the Notification comes about 6 s after the dialog, so one that arrives after the user answered it (or while the screen is unparsed) must not bring `needs_you` back; R1 covers a PermissionRequest that never came. When it applies: same as `PermissionRequest` with reason `permission request: waiting for approval`. `elicitation_dialog`, `agent_needs_input`: state `needs_you`, kind `input`, reason `input requested: <message>` (no screen check: an elicitation form is not in `DIALOG_PATTERNS`). Everything else, including `idle_prompt`: ignore. |
| `Stop` | 5.5 (clears the trigger, gives unread messages their second pointer, state `idle` or, when it answers a block, `working`). |
| `StopFailure` | Clear the trigger, `stopBlocks = 0`, state `idle`, reply `{}`; give unread `delivered` messages their second pointer (5.5, `redeliver`); then schedule a delivery check (`DELIVERY_SETTLE_MS`). |

State changes emit an `AgentFrame`. `stateSince` changes only when the state value changes (a `working` -> `working` write changes nothing and emits nothing). Unknown events and fields are ignored.

### 4.5 Transition table (state changes only)

| From | Trigger | To | Notes |
|---|---|---|---|
| (none) / `stopped` | spawn requested (hire, restart, boot, flip retry) | `starting` | generation + 1, latches and trigger cleared, startup timer armed; the frame waits for `io.spawn` (4.9) |
| `starting` | terminal `ready` event, or first hook (P3) | `idle` | |
| `starting` | startup timer, not ready, `io.outputBytes > 0` | `needs_you` (`startup_dialog`) | 4.8 |
| `needs_you` (`startup_dialog`) | terminal `ready` event, or first hook | `idle` | the user answered the dialog |
| `idle`, `needs_you` | `UserPromptSubmit`; `PreToolUse`/`PostToolUse`/`PostToolUseFailure` (needs_you only with no dialog on screen) | `working` | |
| `idle` | title glyph `working` for `TITLE_WORKING_CONFIRM_MS` since the state became idle (R3) | `working` | shell command, slash command, lost hook |
| `needs_you` (`permission`, `dialog`) | no dialog on screen and the title glyph `working` for `TITLE_WORKING_CONFIRM_MS` (R4) | `working` | the user **allowed** the tool: no hook fires until it ends |
| `working`, `idle` | `PermissionRequest`; `Notification` per 4.4 | `needs_you` | |
| `working` | `Stop` | `idle`, or `working` again (no frame) when a Stop block was answered | 5.5 |
| `working`, `needs_you` | `StopFailure` | `idle` | |
| `working` | title glyph `idle` for `TITLE_IDLE_RECONCILE_MS` (R1; probe known) | `idle`, or `needs_you` (`dialog`) when a dialog is on screen | |
| `needs_you` (`permission`, `dialog`, `input`) | prompt box visible, no dialog, idle glyph for `NEEDS_YOU_CLEAR_MS` (R2) | `idle` | denied or Esc: no hook fires |
| any except `stopped` | terminal `exit` event | `stopped` (or `starting` again on the flag flip, or on restart) | 4.9 |

There is no other way to a state. In particular `Notification: idle_prompt` and `SessionEnd` never change it.

### 4.6 The draft latch

`onUserInput(name, data)` stamps `rt.lastInputAt = now` (any input, whatever its effect), runs `classifyInput(data)`, applies the effect and **returns it** (web.ts uses it to tell a keystroke from focus and mouse reports, 3.4).

`classifyInput`: tokenise `data` from the left.

- `ESC [ 200 ~ ... ESC [ 201 ~` (or to the end of the chunk) is one bracketed paste: effect `set` when its content has at least one character that is not whitespace. Any other `ESC [ ... <final byte 0x40-0x7E>` (arrows, SGR mouse
  `ESC[<0;41;13M`, focus `ESC[I`/`ESC[O`, device attribute replies `ESC[?1;2c`, cursor position replies `ESC[12;40R`) is skipped; the
  exact sequence `ESC [ M` is followed by 3 raw bytes, skip those too (X10 mouse from `onBinary`). `ESC O x` is skipped (3 chars). `ESC ] ... (BEL | ESC \)`
  and `ESC P|_|^|X ... ESC \` are skipped to their terminator or the end. `ESC` followed by any other character is skipped as a pair (Alt-key,
  `ESC CR` newline): no effect. **A lone `ESC` at the very end of the chunk (the Escape key) has no effect** (see the note below).
- `\r` (Enter) and `\x03` (Ctrl-C): `clear`. A printable character (code point >= 0x20, not 0x7f, not in 0x80-0x9f): `set`.
  Everything else (other C0 controls, Tab, Backspace, `\n`, Ctrl-U): no effect.
- The chunk's effect is that of the last token that had one (`set` after `clear` in one chunk gives `set`).

Applying the effect:

- `set`: ignored while `io.screen(name)?.dialog` is non-null **or the state is `needs_you`** (keystrokes that answer a dialog or a permission prompt are not a draft). Else `rt.draft = { lastKeyAt: now }`; emit the view when the latch turned on; the queued items become `held` (note `held: text in <name>'s input`).
- `clear` (Enter, Ctrl-C): `rt.draft = null`, `rt.unconfirmed = null`; **release** the held items (below); emit when either was set; then schedule a delivery check (`DELIVERY_SETTLE_MS`). Clearing never types anything.
- **Screen proof** (the sweep, 4.7): the draft latch is active, `probe` is non-null with `probe.promptBox` and `probe.promptText === ''`, and `now - max(rt.draft.lastKeyAt, rt.lastInputAt) >= DRAFT_SCREEN_CLEAR_MS` -> clear the draft latch and release. The text is gone (Backspace to the start, Ctrl-U, Esc Esc: the key pair that clears claude's box).
  The screen may only **clear** a latch, never set one (prior-art lesson 27: a key that a menu swallowed would otherwise leave a phantom draft and "messages never arrive"); any text, a grey placeholder included, counts as text, so a phantom behind the startup placeholder ends with Enter, Ctrl-C or the 30 minutes. The 1 s is the echo grace: the box does not show a key the instant it was sent.
- **Expiry**: the sweep clears a latch whose `lastKeyAt` is `DRAFT_EXPIRY_MS` old and releases (design: after 30 minutes the mail goes in, typed after whatever the box still holds).
- **Release** (however a latch ends): its `held` items go back to `queued` with the wait note of 5.8 for the recipient's state, one frame each, **at once** (not only when the next delivery check manages to type: that check stops quietly while the screen is unparsed and the items would keep a stale `held:` note), then a delivery check is scheduled.
- Effects of the latch: no typed pointer (5.3 step 2) and no Stop block (5.5 step 4) while it is set; queued messages are `held` with the note `held: text in <name>'s input`.
- The hub types nothing into the draft and never deletes the user's text.

**Why Escape alone is not a release.** The design lists Enter, Escape and Ctrl-C. A single Esc leaves the text in claude's box (Esc Esc clears it; docs, prior-art 2.5), so releasing on it let the pointer be pasted after the user's words and submitted as one prompt: the design's own anti-goal. Esc Esc empties the box and the screen proof ends the latch about
`DRAFT_SCREEN_CLEAR_MS` later (plus one sweep tick). Section 12, conflict 23; open item O23.

### 4.7 Reconciliation (the sweep, per agent with a live generation)

The hooks can be missing (Stop does not fire after Esc, a denied permission or an interrupt; `!` and slash commands fire no
UserPromptSubmit; a hook POST can fail; no hook fires between the user allowing a tool and the tool ending). The window title and the screen are the second and third source. `info = io.title(name)`;
`probe = io.screen(name)`; `now = io.now()`. A null `info` or `probe` means "unknown": **no rule that reads it fires** (R1 included).
The clock of a rule that reads the glyph is `since = max(info.since, rt.stateSince)`: how long the glyph has disagreed with the state, not how long the glyph class has existed (a Stop sets `idle` at once while the title is still the working glyph for 10 to 30 ms, and the glyph's age is the whole turn).

- **R1** state `working`, `probe` non-null, `info.glyph === 'idle'` and `now - since >= TITLE_IDLE_RECONCILE_MS` (the design's "more than 2 seconds"):
  if `probe.dialog` -> state `needs_you` (`dialog`, `SCREEN_DIALOG_REASON`); else state `idle`. Also clear the trigger and `stopBlocks`, and give unread `delivered` messages their second pointer (5.5, `redeliver`).
  Never apply R1 while a Stop block was answered less than `TITLE_IDLE_RECONCILE_MS` ago (the title is still catching up).
- **R2** state `needs_you` (kinds `permission`, `dialog`, `input`) and `probe.promptBox && probe.dialog === null && info.glyph === 'idle'`:
  remember `screenClearSince` (first time seen), and when `now - screenClearSince >= NEEDS_YOU_CLEAR_MS` -> state `idle`, **clear the trigger and `stopBlocks` (the turn ended without a Stop, as in R1) and run `redeliver`**. Reset `screenClearSince` to null
  whenever the condition is false. (The title is `✳` while a permission dialog is open, so the glyph alone proves nothing; the screen says the dialog is gone.)
- **R3** state `idle`, `info.glyph === 'working'` and `now - since >= TITLE_WORKING_CONFIRM_MS` -> state `working` (a shell command or a turn
  without a hook). The delivery check (5.3 step 6) also refuses to type while the glyph says working.
- **R4** state `needs_you` with kind `permission` or `dialog`, `probe` non-null with `probe.dialog === null`, `info.glyph === 'working'` and `now - since >= TITLE_WORKING_CONFIRM_MS` -> state `working` (clear `needsKind`, `needsReason`, `screenClearSince`).
  **This is the way out when the user ALLOWS a tool.** The dialog closes and the turn resumes (title `◐` again), but the next hook is PostToolUse (PostToolUseFailure when it errors) when the tool ends, which for a build or a test run is minutes: PermissionRequest came before the decision and nothing announces it. Without R4 every
  agent in `default` mode that runs Bash stayed red on the floor, pinned in the strip and deaf to mail ("waiting: <name> needs you") for the whole runtime of each approved tool. Kind `input` is not covered: an elicitation form is not recognised on screen, so its end is PostToolUse of the MCP tool (or R2).
- Then: expire the draft latch and apply the screen proof (4.6), then run the delivery check (5.3) when the queue is not empty.

### 4.8 Startup

On spawn the hub arms one timer per generation for `STARTUP_READY_TIMEOUT_MS`. When it fires and `rt.ready` is still false and the state is
`starting`: if `io.outputBytes(name) > 0` -> `needs_you` (`startup_dialog`, reason `STARTUP_DIALOG_REASON`); else arm it again for `STARTUP_RECHECK_MS`.
The `ready` terminal event (6.3) sets `ready = true` and moves `starting` or `needs_you (startup_dialog)` to `idle`.
Nothing is delivered to a `starting` agent (it is not ready). A hook that arrives first counts as ready (P3).

### 4.9 Lifecycle operations (serialised per agent)

Operations of one agent run strictly one after the other. A request identical in kind to one already queued or running for that agent (a double-clicked Restart or Stop) does not run twice: it resolves with the result of the pending one. Once `shutdown()` has begun every one of them rejects (2.1 rule 7).

**start()**: `io.loadRoster()`; build one runtime per record (state `stopped`, generation 0). If there is no boss, create one:
`{ name: 'flight' (or the first free of flight-2, flight-3, ...), role: BOSS_ROLE, dir: options.bossDir, mode: 'default', sessionId: io.newSessionId(), desk: 0, boss: true }`,
save the roster. `io.loadHistory(ACTIVITY_BACKLOG)` fills the activity list; every item whose status is `queued`, `held` or `delivered` becomes
`undelivered` with the matching note of 5.8 (logged with `io.logMessage`). Arm the sweep. Start the boss (as a restart).

**spawn(rt, flag)** (internal): `generation += 1`; state `starting` (`stateSince = now`); clear the draft and unconfirmed latches, trigger, `stopBlocks`, `pendingConfirm`, `exit`, `hooksSeen`, the `pointed` counters; `rt.running = { role, dir, mode }`;
arm the startup timer; **do not emit yet**; `await io.spawn({ agent: record, generation, flag })`.
- **Success**: remember `flag` and `pid`, then emit the `starting` AgentFrame. The routing state (generation, state `starting`) was consistent from the first line, only the frame waits, and `views()` already shows it. **Why the frame waits:** a browser reacts to a new `generation` by attaching, and `io.spawn` is the launcher's
  file work plus the terminal host's spawn; a frame sent before it resolved made the browser attach to the previous, finished record (or to none), and the terminal host tells the sockets of a replaced record nothing, so the pane stayed dead until the user switched agent (3.4 rule 4 heals the remaining orderings).
- **Rejection**: state `stopped`, `exit = { code: null, signal: null, at, requested: false, text: 'could not start: <message>' }`,
  the messages in the queue become undelivered (note of 5.8, "could not start"), emit the `stopped` frame.
A user-initiated start (hire, restart, boot) sets `flipAvailable = true`; the flip retry itself does not.

**hire(req)**: validate in this order, each failure a `HubError` (field in brackets): name pattern (`name`, bad_request) and not reserved (`name`, bad_request);
unique (`name`, conflict); `MAX_AGENTS` not reached (conflict); role trimmed, 1..`ROLE_MAX_CHARS` (`role`); `mode` in `PERMISSION_MODES` (`mode`);
`dir` string up to `DIR_MAX_CHARS`, `io.checkDirectory` ok (`dir`, message from the check); `mode === 'bypassPermissions'` needs `confirmBypass === true` (`confirmBypass`).
Create the record (`sessionId = io.newSessionId()`, desk = lowest unused integer >= 1, `boss: false`, `dir` = the checked path), save the roster, then spawn(flag null) (which emits the first frame of the agent).
Resolve with the view (state `starting`, or `stopped` with `exit.text` when the spawn failed).

**edit(name, req)**: at least one known field, else bad_request. Validate fields like hire (name rules only when it changes). `mode: 'bypassPermissions'` needs `confirmBypass: true` unless the mode is unchanged. A rename requires `state === 'stopped'` and no transition
(conflict otherwise), then `await io.renameAgentFiles(old, new)` (a rejection becomes conflict with its message; the glue also moves the terminal host's record, 2.8 step 4), then **re-key**: the `rt` object (queue, timers, operation chain, everything of 4.1) moves from the old key
of the hub's map to the new one, and the record's `name` changes. (Hooks and tokens are not affected: a rename needs a stopped agent, and the next start issues a token for the new name.) Update the record, save the roster, and emit: **for a rename `{ t: 'agent-removed', name: <old> }` first and then the new agent's `AgentFrame`**
(a client that only handled `agent` added the new name and kept a ghost tab and desk under the old one until the next full state); otherwise the changed view (the `dirty` flag now shows). Changes to role, dir and mode apply at the next start.

**restart(name)**: if a process runs: `transition = 'restarting'`, emit, `await io.stop(name, generation)`, then spawn(flag null); `transition` is cleared in the same step that emits the spawn's frame, so one frame shows both (the exit handler leaves the queue intact, 4.10 rule 4).
A stopped agent is simply spawned. **stop(name)**: a stopped agent returns its view; else `transition = 'stopping'`, emit, `await io.stop`, `transition = null`, return the view (state `stopped`).
**remove(name)**: the boss is refused (conflict `the boss cannot be removed`). If running: `transition = 'removing'`, `await io.stop`. Then delete the runtime, save the roster, emit
`agent-removed`. Files under `agents/<name>` stay on disk.

**exit event** (`onTerminalEvent` kind `exit`, generation current): cancel the agent's timers, clear `pendingConfirm`, `ready = false`, clear the draft and unconfirmed latches, the trigger and `stopBlocks`.
Then, in this order:

1. **Flag flip**: when `transition === null`, `info.requested === false`, `info.code === 1`, `info.durationMs < SESSION_FLIP_WINDOW_MS`, `flipAvailable`, **and `info.tail` contains claude's own message for the flag that was used**
   (`SESSION_IN_USE_TEXT` after `session-id`, `SESSION_MISSING_TEXT` after `resume`): set `flipAvailable = false`, keep state `starting`,
   and queue a spawn with the opposite of the flag used (`'session-id'` <-> `'resume'`) on the agent's operation chain. Nothing else changes (no `stopped` flash, the queue stays).
   Any other exit with code 1 within 3 s (a flag claude refused, `bypassPermissions` as root, a working directory that cannot be entered, an authentication failure) is not a session mismatch: it goes to step 2 with its own tail, so the user reads the real cause and no second process is wasted on it.
2. Otherwise state `stopped`, `exit = { code, signal, at, requested, text }` where `text` is `stopped` when requested, else `killed by signal <n>` or `exited with code <c>`,
   followed by `: <last non-empty line of info.tail>` when not requested and the tail has one. (After a flip whose retry also fails, the text comes from the retry's tail.)
3. Messages: **while the hub is `closing` nothing is converted here** (see `shutdown()`). `transition === 'restarting'`: `delivered`-but-unread messages go back to `queued` (note `restarted before it was read`, their `pointed` counters dropped) and everything stays queued for the new process.
   Any other exit: every unread message (queued, held, delivered) becomes `undelivered` with the "stopped before reading it" note of 5.8 ("was removed before reading it" when `transition === 'removing'`).
4. `transition === 'stopping'` -> null (the stop op resolves), `'removing'` -> the remove op continues, `'restarting'` -> the restart op continues.

**shutdown()**: set `closing`; stop the sweep timer; mark every running agent `transition = 'stopping'`; `await Promise.all(io.stop(...))`; clear every timer. **Messages are not converted**: the exit handler skips step 3 while `closing` (the process is going away; the log writes would race `process.exit`, and
`start()` converts whatever the log still shows as `queued`, `held` or `delivered` to `undelivered` with the "server restarted before it was read" note, so nothing is lost). `Home.close()` (2.4) flushes the writes that did happen.

### 4.10 Races, each with its rule

1. **A hook before readiness.** P3: the hook is evidence of readiness. The later `ready` event changes nothing. A hook for a generation older than the current is dropped (also at the edge: its token is revoked on exit).
2. **A Stop while a pointer is being typed** (`pendingConfirm` set). The Stop sets `idle` as usual but its block logic ignores ids that are in `pendingConfirm` (they are in flight). The confirm timer keeps running. If the typed pointer gets submitted after the turn ended, UserPromptSubmit confirms it (its prompt ends with the pointer text); if the 2 s run out first the messages are `held` and a late UserPromptSubmit with the pointer text still confirms them (5.4).
3. **Two messages at once.** The first message schedules a delivery check `DELIVERY_COALESCE_MS` later; everything queued by then goes into one pointer. While a pointer is in flight (`pendingConfirm`) no second pointer is typed. A `read_messages` call returns all unread messages whether or not their pointer went out, and removes them from the queue.
4. **A restart during delivery.** `restart` sets `transition = 'restarting'`: routing queues new messages (the new process will get them), the in-flight confirm and delivery timers are cancelled by the exit handler, `delivered`-unread messages return to `queued`.
5. **A draft latch while a Stop is being answered.** If the latch is set when the Stop hook arrives: reply `{}`, messages `held`. If the user starts typing after the reply was computed, the block still lands (accepted). The latch clearing (Enter, Ctrl-C, or the screen showing an empty box, 4.6) releases the held items and triggers a delivery check; the user's Enter submits a prompt, which makes the agent `working`, and the held messages then wait for the next Stop.
6. **Title-glyph reconciliation.** 4.7. The clock is the later of the glyph's `since` (set by the terminal host when the class changed, so a flapping glyph restarts it) and the state's `stateSince`. A Stop block answered (state forced to `working`) suppresses R1 for `TITLE_IDLE_RECONCILE_MS`.
7. **Hooks and MCP calls of a previous process generation.** The launcher revokes a start's token when its process exits (cli wiring, 2.8 step 6), so the edge answers 401 and the hub never sees them. Belt and braces: `onHook` compares `generation`; `sendFromAgent`, `readMessages` and `rosterFor` take the generation of the token the edge resolved and refuse the call with
   `HubError('conflict', 'this session has ended')` when it is not the agent's current one or `transition` is not null. (The token is checked when the request starts; the tool callback runs after an `await`. A call that was authenticated just before the exit and runs after the restart created the new generation would otherwise consume the queue that the restart keeps,
   and a dying process could mark mail read during `stopping` or `restarting`.) A hook that was already read by the edge when the exit was processed is dropped by the generation or `transition` check.
8. **Stop requested while a spawn is running.** Lifecycle operations are serialised per agent, so the stop waits for `io.spawn` to resolve, then stops the new process.
9. **Exit while a pointer is in flight.** The exit handler clears `pendingConfirm`; its ids are still `queued` and are handled by exit rule 3.
10. **A delayed `ready` event or title event of an older generation** is dropped by the generation check.
11. **Double Stop, double PermissionRequest, repeated `ready`** are idempotent: same state, no extra emit.
12. **The user's Enter or Ctrl-C while a pointer is unconfirmed.** It clears the draft and unconfirmed latches (4.6) and releases the held items; the delivery check may then type a fresh pointer. A pointer that sat typed in the box and was submitted by that Enter reaches the agent as an ordinary prompt (the latch is gone, so it is not "confirmed"): the agent reads the mail and
    `read_messages` ends the bookkeeping (5.6). Escape is not a release (4.6).
13. **`read_messages` before the confirmation.** The hook is lost (an untrusted folder, a failed POST), or the agent read the mail on its own. `read_messages` returns every unread message, so it ends the confirmation: timer cancelled, `pendingConfirm` and `unconfirmed` cleared (5.6). Without this an agent that did read its mail stayed deaf (every later message `held`) until the user pressed a key in its terminal.
14. **A turn that ends without `read_messages`.** The model call failed (StopFailure), the user interrupted (R1/R2), claude ignored a Stop block, or the model simply did not call the tool. `redeliver` (5.5) gives each such `delivered` message one more pointer and then says so in the strip; conflict 16.

## 5. Messages and delivery (builder A, `hub.ts`; edge parts by E; tools used by D)

### 5.1 The pointer

The only text the server ever types into a terminal, and the only text it ever hands to a Stop hook. `pointerText(messages)`:

```
gonogo: <n> new message<s> from <names>. Call read_messages.
```

`n` = number of messages, `<s>` = `s` unless n is 1, `<names>` = the distinct `from` values in order of first appearance, joined with `, `, at most
`POINTER_MAX_SENDERS` (3) of them, followed by ` and others` when there are more. Examples:
`gonogo: 1 new message from ana. Call read_messages.`, `gonogo: 3 new messages from ana, user. Call read_messages.`,
`gonogo: 7 new messages from a, b, c and others. Call read_messages.`. One line, ASCII, starts with `gonogo:`. At most about 170 characters (162 with a three-digit count and three 32-character names), always under the 500 that `submit` enforces (6.7) and the 800 at which the TUI collapses a paste into `[Pasted text]`.
Sender names are validated names or `user`.

### 5.2 Sending a message (`sendFromUser`, `sendFromAgent`)

1. **Validate** (throw `HubError`, `field` in brackets): `to` is a non-empty string of at most 64 characters (`to`); `subject` is a string of at most
   `SUBJECT_MAX_CHARS` (agents may omit it: `''`) (`subject`); `body` is a string whose trim is non-empty and at most `BODY_MAX_CHARS` (`body`);
   `inReplyTo` that does not match `^m\d+$` is dropped (null). The stored body is the text as given (not trimmed).
2. **Resolve `to`**: `boss` -> the boss's name (no boss: bad_request); `user` -> `user` (refused for `sendFromUser`, field `to`); an agent name -> itself;
   anything else -> `HubError('not_found', 'unknown recipient "<to>". Known: <names>, boss, user', 'to')`.
3. An agent sender must exist (else bad_request `unknown sender`), its `generation` must be the current one and `transition` null (else conflict `this session has ended`, 4.10 rule 7), and it must not equal the recipient (bad_request `you cannot send a message to yourself`).
4. **Hops**: sender `user` -> 0. Agent sender with a trigger (5.7) -> `trigger.maxHops + 1`; without -> 1.
5. **Record**: `id = io.newMessageId()`, `from`, `to` (resolved), `subject`, `body`, `inReplyTo`, `hops`, `at = io.now()`, `updatedAt = at`.
6. **Route** (first match wins):
   - recipient is `user`: status `to_user`, note null. Done.
   - recipient is an agent and `hops > options.maxHops`: status `undelivered`, note `hop limit <N> reached; the message went to the user`. Done.
   - recipient `state === 'stopped'` or `transition` is `stopping` or `removing`: status `undelivered`, note `<name> is stopped; the message went to the user`
     (`<name> is being removed; ...` for removing). Done.
   - else: append the id to the recipient's queue; status `held` when the draft or unconfirmed latch is set (whatever the recipient's state: 5.3 step 2), else `queued`; the note is the first applicable row of 5.8 (an idle recipient: `waiting: about to type the pointer`); schedule a delivery check in `DELIVERY_COALESCE_MS`.
7. `io.logMessage(record)`, emit an `ActivityFrame` (body cut to `ACTIVITY_WIRE_BODY_CHARS`, `truncated` set).
8. Return `SendResult { ok: status !== 'undelivered', id, to, status, note }`. This is what the MCP tool reports to the sender at once.

An undelivered message is **not** queued anywhere and never reaches the agent later; it is visible to the user in the strip.

### 5.3 The delivery check (typing a pointer into an idle agent)

Run: `DELIVERY_COALESCE_MS` after a message was queued; `DELIVERY_SETTLE_MS` after a Stop/StopFailure/R1/R2 that left messages queued, after a latch cleared, after a `ready` event; and by the sweep for every agent whose queue is not empty. It does at most one thing: type one
pointer for the whole queue.

1. Continue only when the agent exists, `transition === null`, the state is not `stopped` and the queue is not empty.
2. **Latches first, whatever the state** (so a working recipient with a draft shows `held`, not `waiting: ... is working` that flips back to `held` at its Stop): expire the draft latch (4.6). Draft latch active: items -> `held`, note `held: text in <name>'s input`; stop. Unconfirmed latch set: items -> `held`, note per 5.4; stop.
3. `starting`, `needs_you`, `working`: set the wait note (5.8) on the queued items and stop. (A `working` agent gets its pointer through its Stop hook, 5.5.)
   Only `idle` continues.
4. `pendingConfirm` set: stop (a pointer is already in flight).
5. `probe = io.screen(name)`. `null`: stop (retry at the next sweep). `!probe.promptBox` or `probe.dialog !== null`: wait note `waiting: <name> is not ready for input`; stop.
6. `info = io.title(name)`. `info?.glyph === 'working'`: same wait note; stop.
7. `text = pointerText(queue messages)`. `io.typePointer(name, generation, text)`; `false`: log, stop (retry at the next sweep).
8. `pendingConfirm = { text, ids: [queue ids], at: now }`; arm the confirm timer for `PROMPT_SUBMIT_CONFIRM_MS` (with the generation); items status `queued`,
   note `waiting: confirming the pointer`. The ids stay in the queue until confirmed or read.

The server types the pointer as `ESC[200~ + text + ESC[201~ + CR` in one write (6.7). It never types anything else and never sends a CR on its own.

### 5.4 Confirmation: the 2 second rule

- **Confirmed.** A `UserPromptSubmit` hook whose `prompt`, with `\r\n` and `\r` turned into `\n` and trimmed, **ends with** `pendingConfirm.text`: cancel the timer, every id of
  `pendingConfirm` that is still queued becomes `delivered` (note `pointer typed`, removed from the queue, `pointed[id] += 1`), `pendingConfirm = null`, `unconfirmed = null`. (`ends with`, not `equals`: when the pointer is pasted after text that was still in the box, claude submits both as one prompt and the pointer was delivered all the same.)
- **Not confirmed.** The timer fires with `pendingConfirm` still set. `ids` = the ids of `pendingConfirm` that are **still queued** (a message already read is no longer waiting). None: `pendingConfirm = null`, nothing else (no latch: it would be invisible and deaf). Otherwise `unconfirmed = { text, ids, since }`, `pendingConfirm = null`,
  the ids -> `held`. **Note** (also the text of `AgentView.held`): `held: pointer not confirmed within 2 s`; but when `rt.hooksSeen` is false **and** the title glyph is `working` with `info.since >= pendingConfirm.at` (a turn started after the pointer was typed and no hook of this process has ever arrived),
  the note is `held: no hook has reached gonogo from <name>; is its folder trusted?`, and one `warn` is logged (hooks are held back in an untrusted folder, or the hook URL is blocked, facts `toolchain-docker.md` 4.2). **No retry is made.** The pointer may sit unsent in the input box.
- **Late confirm.** While `unconfirmed` is set, a `UserPromptSubmit` whose prompt ends with `unconfirmed.text` marks its still-queued ids `delivered` (note `pointer typed`, `pointed[id] += 1`) and clears the latch.
- **Release.** `unconfirmed` is also cleared by any other `UserPromptSubmit`, by the user's **Enter or Ctrl-C** in that terminal (4.6; Escape does not: with a pointer sitting in the box a single Esc leaves it there), by `read_messages` (5.6), and by the process exiting. Its held items are released (4.6) and the delivery check may type a fresh pointer.
  A Stop hook does not release it (the pointer text could still sit in the input box).
- A `UserPromptSubmit` with some other prompt while `pendingConfirm` is set is not a confirmation: the timer keeps running and ends as "not confirmed".

### 5.5 The Stop hook: handing the pointer to a working agent

On `Stop` (after the preamble, 4.4):

1. Clear the trigger. **The state is set once, at the end** (`working` when a block is answered, else `idle`; clear needs fields): no intermediate `idle` frame, and `stateSince` does not move when a block leaves the state `working`.
2. `redeliver` (below): unread `delivered` messages of this agent get their second pointer (they go to the front of the queue).
3. `candidates` = queued ids that are not in `pendingConfirm.ids`. None: state `idle`, reply `{}` and stop.
4. Draft latch active (after the expiry check): candidates -> `held` (note `held: text in <name>'s input`), state `idle`, reply `{}`, schedule a delivery check, stop.
5. `unconfirmed` set: state `idle`, reply `{}`, stop.
6. `stopBlocks >= MAX_STOP_BLOCKS` (8): state `idle`, reply `{}`, schedule a delivery check in `DELIVERY_SETTLE_MS` (the agent really goes idle and the typed path delivers). Claude Code ignores the 9th consecutive
   block and ends the turn; the counter resets on every `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `UserPromptSubmit` (a tool call between blocks), so the cap only bites an agent that keeps stopping without reading.
7. Otherwise: `text = pointerText(candidates)`; candidates become `delivered` (note `handed over when its turn ended`, removed from the queue, `pointed[id] += 1`); `stopBlocks += 1`; `lastBlockAt = now`;
   state `working` (claude continues and fires no UserPromptSubmit); reply `{ "decision": "block", "reason": text }`.

Claude shows the reason to the model as a user message `Stop hook feedback:\n<text>`. **Verified in `claude -p` only**; whether the interactive TUI continues the turn and how it draws the block (docs say a `block` can show as a hook error) is open item O21, with two fallbacks: hand over nothing at Stop (typed path only), or reply with the
`additionalContext` form (`{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"<pointer>"}}`, which continued the turn in `-p`, shows as hook feedback and counts against the same cap, facts `claude-code-hooks-mcp.md` 4.3). Never block with anything but a pointer.

**`redeliver` (delivered but not read).** A message is `delivered` when its pointer was typed and confirmed, or handed over at a Stop. The agent may still not call `read_messages`: the model call failed (StopFailure), the user interrupted (R1, R2), another Stop hook of the owner's plugins had used up claude's cap of 8 so claude ignored our block while the hub
set `working`, or the model just did not call the tool. The sender (the boss, say) then waits for ever on a chip that says `delivered`. So at every turn end the hub learns about (`Stop`, `StopFailure`, R1 and R2 to idle) every message addressed to the agent that is still `delivered` is looked at:
`pointed[id] < POINTER_MAX_ATTEMPTS` (2): it goes back to the front of the queue (status `queued`, note `waiting: <name> has not read it yet`) and the usual paths point at it again (the Stop block above, or the delivery check); otherwise its note becomes `not read: <name> did not read it after two pointers` once
(status stays `delivered`, `activity` frame, the strip shows it in warning colour, 8.5) and nothing more is typed: **a loop is impossible, which is what conflict 16 protects.** `pointed[id]` is dropped when the message is read or undelivered.

### 5.6 Reading messages (`readMessages(agent, generation)`)

0. **Guards.** Unknown agent: `{ count: 0, messages: [] }`. `generation` is not the agent's current one, or `transition` is not null: `HubError('conflict', 'this session has ended')` (4.10 rule 7).
1. Collect every message addressed to `agent` with status `queued`, `held` or `delivered`, oldest first.
2. Each becomes `read` (note null, `updatedAt = now`, logged and emitted) and leaves the queue; its `pointed` entry is dropped.
3. **It ends the confirmation.** Every unread message of the agent was just returned, so a pointer in flight (`pendingConfirm`) and an unconfirmed latch have nothing left to wait for: cancel the confirm timer, `pendingConfirm = null`, `unconfirmed = null` (log `pointer confirmed by read_messages` at debug).
   The hook that should have confirmed it may never come (silent hooks, a lost POST); without this the timer then set an invisible latch (no queued ids, so no `held` in the view) that made every later message wait until the user pressed a key in that terminal.
4. If at least one message was returned: `trigger = { ids, maxHops: max(hops of the returned messages) }` (replacing the previous trigger). A read that returns nothing leaves the trigger as it is.
5. Return `{ count, messages: [{ id, from, subject, body, inReplyTo, at }] }`; the body is complete (not truncated). Each message is returned exactly once.

`rosterFor(agent, generation)`: unknown agent: `HubError('not_found', 'unknown agent')`; the generation guard of step 0. Else `{ you: agent, boss: <boss name or null>, agents: [{ name, role: first ROSTER_ROLE_CHARS chars, state, boss }] sorted by desk, specialRecipients: ['boss', 'user'] }`.

### 5.7 Hops and the trigger (the loop guard, server side)

The server stamps hops; the agent cannot. `trigger` is set by a non-empty `read_messages`, and cleared by `Stop`, `StopFailure`, a `UserPromptSubmit` that is not our pointer, R1 and R2 reconciliation to idle,
exit and restart. A message an agent sends while its trigger is set has `hops = trigger.maxHops + 1`; with no trigger `1`; a message typed by the user `0`. A message to an agent with
`hops > maxHops` (default 8) is undelivered and shown to the user (5.2 step 6). A message to `user` is never blocked.

### 5.8 What the activity strip records, exactly

`status` and `note` of an `ActivityItem` (`note` is shown next to the status chip; the strip row also shows time, `from -> to`, subject and the start of the body).
`<name>` is the recipient. Reasons for undelivered always end with `; the message went to the user`.

| Situation | `status` | `note` |
|---|---|---|
| Message to `user` | `to_user` | null |
| Queued, recipient `starting` | `queued` | `waiting: <name> is starting` |
| Queued, recipient `working` | `queued` | `waiting: <name> is working` |
| Queued, recipient `needs_you` | `queued` | `waiting: <name> needs you` |
| Queued, recipient `idle` (the delivery check runs `DELIVERY_COALESCE_MS` later) | `queued` | `waiting: about to type the pointer` |
| Queued, recipient `idle` but not typeable now (no box, dialog, glyph working) | `queued` | `waiting: <name> is not ready for input` |
| Queued, recipient restarting | `queued` | `waiting: <name> is restarting` |
| Pointer typed, waiting for UserPromptSubmit | `queued` | `waiting: confirming the pointer` |
| Delivered, then its turn ended without `read_messages` (first time: pointed at once more) | `queued` | `waiting: <name> has not read it yet` |
| Draft latch (any recipient state, 5.3 step 2) | `held` | `held: text in <name>'s input` |
| Pointer not confirmed in 2 s | `held` | `held: pointer not confirmed within 2 s` |
| Pointer not confirmed in 2 s, a turn started, and no hook has ever reached the hub from this process | `held` | `held: no hook has reached gonogo from <name>; is its folder trusted?` |
| Pointer confirmed (typed path) | `delivered` | `pointer typed` |
| Handed over by the Stop hook | `delivered` | `handed over when its turn ended` |
| Still not read after the second pointer | `delivered` | `not read: <name> did not read it after two pointers` |
| Returned by `read_messages` | `read` | null |
| Recipient stopped or stopping at send time | `undelivered` | `<name> is stopped; the message went to the user` |
| Recipient being removed at send time | `undelivered` | `<name> is being removed; the message went to the user` |
| Hop cap | `undelivered` | `hop limit <N> reached; the message went to the user` |
| Recipient exited before reading | `undelivered` | `<name> stopped before reading it; the message went to the user` (`was removed before reading it` when removing) |
| Recipient could not start | `undelivered` | `<name> could not start; the message went to the user` |
| Found queued or delivered in the log at server start | `undelivered` | `server restarted before it was read; the message went to the user` |

The note a send returns (`SendResult.note`, the MCP result) is the first applicable row: an item queued to an idle recipient says `waiting: about to type the pointer`, not null. When a latch ends its `held` items leave `held` at once for the wait row of the recipient's state (4.6).
Every status or note change is logged (`io.logMessage`) and emitted (`ActivityFrame`, same `id`). A `queued` item whose wait reason changes gets a new note and a new frame; do not emit when the text is unchanged.
The strip also shows, above the messages, one pinned line per agent in `needs_you`: `<name> needs you: <needsReason>` (client-derived from `AgentView`, 8.5).

### 5.9 Summary of when each recipient state delivers

| Recipient | Message is |
|---|---|
| `starting` | queued; typed (5.3) after it becomes `idle` |
| `idle`, ready, box visible, no dialog, no draft, glyph not working | pointer typed within `DELIVERY_COALESCE_MS` |
| `working` | queued (`held` while the user has a draft, 5.3 step 2); handed over at the next `Stop` (5.5), or typed after it if the cap is reached |
| `needs_you` | queued; waits for the user; never typed into |
| `stopped`, stopping, removing | undelivered, to the user |

## 6. The terminal host (builder C, `terminal.ts`)

One `TerminalHost` serves all agents, keyed by name. Per agent it owns a pty and a **mirror**: a headless xterm that receives every output byte and every
resize. Facts: `docs/facts/claude-code-terminal.md` sections 2 to 7, plus its "Corrections (skeptic)". Everything that depends on how claude draws
its screen lives here and in the launcher (design: risks).

### 6.1 Imports and library traps

```ts
import { spawn as ptySpawn } from '@lydell/node-pty';          // ESM named import works; types: IPty
import xtermHeadless from '@xterm/headless';                   // DEFAULT import, then destructure (the named import fails in plain Node ESM)
import { SerializeAddon } from '@xterm/addon-serialize';       // named import works
const { Terminal } = xtermHeadless;
import type { Terminal as HeadlessTerminal } from '@xterm/headless';   // for annotations only
```

`new Terminal({ cols, rows, scrollback: MIRROR_SCROLLBACK_LINES, allowProposedApi: true })`, `mirror.loadAddon(new SerializeAddon())`. `pty.spawn(..., { name: TERM_VALUE, cols, rows, cwd, env, encoding: null })`
(`encoding: null` gives `Buffer` chunks). **Do not forward `mirror.onData`** (the replies the headless xterm generates to terminal queries) to the pty: the browser's xterm answers, and claude does not wait for answers.
The `test/terminal.test.ts` suite must import the module the way plain Node does (a test that spawns `node dist/...` or imports through `vite-node` is not enough); at minimum assert the default-import form compiles and runs under vitest, and note the plain-Node check in the report.

### 6.2 Spawn

`spawn(name, generation, spec)`:

1. Once per process, call `ensureSpawnHelperExecutable()` (6.10).
2. A live process for `name` is an error (`agent <name> is already running`). A finished record of the same name is replaced (its attachments are told nothing; they simply stop receiving: that is why the hub emits the `starting` frame only after this call returned, so a browser attaches again and finds the new record, 4.9 and 3.4 rule 4).
3. Size: `spec.cols/rows`, else the last size this name had, else `DEFAULT_COLS` x `DEFAULT_ROWS`; clamp to `MIN_COLS..MAX_COLS`, `MIN_ROWS..MAX_ROWS`.
4. `ptySpawn(spec.file, spec.args, { ..., env: spec.env, cwd: spec.cwd })`. On a thrown error: `throw new Error('could not start <file>: <message>')`; when the message contains `posix_spawnp failed` append
   ` (command not found, or the pty helper is not executable)`.
5. Create the mirror and the mode tracker (6.6), subscribe `pty.onData`, `pty.onExit`, `mirror.onTitleChange`. Record `generation`, `pid`, `spawnedAt = now()`.
6. Return `{ pid }`.

### 6.3 Output path and readiness

What claude 2.1.325 writes at startup (fullscreen renderer, measured after spawn): about 210 ms `ESC[?25h`; about 307 ms `ESC[?2004h ESC[?2031h ESC[?1004h` (raw mode is on) and `ESC]0;✳ Claude Code BEL` (title); about 323 ms `ESC[?1049h ESC[?1000h ESC[?1002h ESC[?1003h ESC[?1006h`
(alternate screen, mouse); about 423 ms the queries `ESC]11;?BEL`, `ESC[c`, `ESC[>0q`, `ESC[?u`, `ESC]7501;?BEL` (unanswered, harmless). `ESC[?2004h` came 0.17 to 0.64 s after spawn (median 0.29 s) and the boxed prompt row a median of 13 ms later (479 ms once, with an MCP server starting).

For every pty chunk, in this order, synchronously: `bytes += length`; `modeTracker.feed(chunk)`; `pending += 1; mirror.write(chunk, afterParse)`; hand the chunk to every attachment (6.6).
`afterParse`: `pending -= 1`, bump the screen version, and if the agent is not yet ready: **ready = `mirror.modes.bracketedPasteMode === true` (claude wrote `ESC[?2004h`, so raw mode is on) AND `analyzeScreen(...).promptBox` AND `dialog === null`.**
On the first true: emit `{ kind: 'ready', name, generation, at }` exactly once per generation. Do not wait for the pty to go quiet (the status line and spinner keep it busy), do not use SessionStart, do not look at placeholder text.
No settle delay: a paste plus CR sent 1 ms after the box appeared was submitted in the experiments.

### 6.4 Screen analysis (`analyzeScreen(rows, cols)`, pure)

`rows` are the visible rows of the active buffer (`buffer.active.getLine(viewportY + y).translateToString(true)`, right-trimmed), `cols` the mirror width.
Constants come from `constants.ts`.

- `isRule(row)`: the row contains a run of at least `RULE_MIN_RUN` (20) consecutive `RULE_CHAR` (`─`).
- **Prompt box** (`promptBox`): a row `y` whose text starts with `PROMPT_GLYPH + NBSP` (`❯` then U+00A0, **not** a normal space), with `isRule(rows[y-1])`, and some `k` in `1..BOX_MAX_ROWS` with
  `isRule(rows[y+k])`. `promptText` = the row's text after those two characters, trimmed (it may be a grey placeholder or prompt suggestion: it is information, not a verdict). No box: `promptBox: false`, `promptText: null`.
  The permission dialog draws `❯ 1. Yes` but its rules are dashed (`╌`) and it replaces the box, so it is not a box.
- **Dialog** (`dialog`): test the right-trimmed rows, skipping the prompt-box row, against `DIALOG_PATTERNS` in order (`new RegExp(source)`); the first kind that holds wins. `permission` holds only when a row matches its pattern
  (`^\s*Do you want to `) **and** some row matches the `menu` pattern; a `Do you want to` row without a numbered menu is ordinary assistant text. `menu` alone is reported as `menu`. No match: `null`.
  Kinds: `theme`, `login`, `trust`, `bypass`, `api_key`, `resume`, `permission`, `menu`. Never match the bare word "permission" or the footer text `bypass permissions on`.
- Result `{ cols, rows: rows.length, promptBox, dialog, promptText }`.

`host.screen(name)` returns `null` when the name has no mirror **or while any written chunk is still unparsed (`pending > 0`)**; otherwise the analysis of the current viewport (cache it per screen version).
The hub treats null as "try again at the next sweep".

### 6.5 Window title

`mirror.onTitleChange(title)` (OSC 0 and OSC 2; claude sends `ESC ] 0 ; <title> BEL`). `classifyTitle(title)`: first character of `title.trimStart()`: `TITLE_IDLE_GLYPH` (`✳`) -> `idle`; one of `TITLE_WORKING_GLYPHS` (`◐`, `◑`) -> `working`;
anything else, including an empty title (claude sets an empty title on exit) -> `unknown`. Keep `title`, `glyph` and `since` (the time the glyph **class** last changed, from `now()`); `host.title(name)` returns them, or null before the first title.
Emit `{ kind: 'title', ... }` only when the class changes. Remember: the title shows `✳` while a permission dialog waits, so `idle` means "not running a turn", not "ready for input".

### 6.6 Snapshot, attachments and the mode fix-ups

The reconnect design (facts, skeptic correction 1): a joining browser gets `serialize()` of the mirror **plus the modes `serialize()` does not carry**, then live bytes.

- **ModeTracker** (`feed(chunk)`, `fixup()`): scan the raw output for `ESC [ ? <params> h|l` where `<params>` is digits separated by `;` (claude may combine them). Remember the last value of modes `1006` (SGR mouse
  encoding), `25` (cursor visibility) and `2031` (colour-scheme reports); a sequence that sets several modes updates each of them. Sequences may be split across chunks: keep the unfinished tail (at most 32 bytes starting at the last ESC)
  and prepend it to the next chunk. `fixup()` returns, for each mode seen at least once and in this order `1006`, `2031`, `25`, the string `ESC[?<n>h` or `ESC[?<n>l`; `''` when none was seen. A new spawn starts a new tracker.
- **`attach(name, listener)`**, exactly this order, with no `await` before step 2:
  1. Create the attachment `att = { listener, started: false, buffer: [] }` and add it to the record's set: from now on every chunk is appended to `att.buffer`.
  2. In the same synchronous block: `modesAtMark = tracker.fixup()` and enqueue the marker `mirror.write('', onMark)`.
  3. `await` the marker. In `onMark` (all output received before step 2 has been parsed, nothing later has): `data = serialize.serialize({ scrollback: SNAPSHOT_SCROLLBACK_LINES }) + modesAtMark`.
  4. Resolve `{ snapshot: { cols: mirror.cols, rows: mirror.rows, data, generation, running }, start, detach }`.
  `start()` passes the buffered chunks to the listener in order, then switches to direct delivery (each new chunk goes straight to the listener, synchronously, in order). `detach()` removes the attachment and drops its buffer.
  Result: no byte missing, none twice. A name with no record resolves a snapshot with `data: ''`, `generation: 0`, `running: false` at the last or default size, and no-op `start`/`detach`. After the process exited the mirror and
  its last screen stay readable until the next spawn of that name.
- **Resize**: `resize(name, cols, rows)` clamps; false when the process has exited (6.9); when it equals the current size it returns true and does nothing (every resize makes claude repaint). Otherwise `pty.resize(cols, rows)` **first, in a `try`** (it throws `ioctl(2) failed, EBADF` once the child has exited, and a throw
  out of a WebSocket handler would end the server: log at debug, return false and leave the mirror alone, so mirror and pty never disagree), then `mirror.resize(cols, rows)`, in the same tick (the repaint arrives in a later tick, in a mirror that already has the new size). Remember the size per name. Who may resize is decided by the web layer (3.4), which
  also tells the other attached windows (`SizeFrame`).
- **Rename**: `rename(oldName, newName)` moves the finished record (mirror, last screen, size, title) from one key to the other, replacing a finished record that `newName` may still hold, and returns true; false when either name has a live process or `oldName` has no record. Without it a renamed stopped agent attached to an empty snapshot,
  the old name's mirror leaked, and a later hire of the old name inherited its stale mirror and size.

### 6.7 Typing

- `write(name, data)`: `pty.write(data)` (string or bytes) **in a `try`** (a throw means false), false when no live process or the process has exited (6.9). Browser keystrokes; nothing is filtered.
- `submit(name, generation, text)` returns false and writes nothing unless: the record is live, `generation` matches, `mirror.modes.bracketedPasteMode` is true, `clean = sanitizeForPaste(text)` is non-empty,
  at most 500 characters, and **starts with `POINTER_PREFIX` ("gonogo: ")**. Then exactly one `pty.write(PASTE_START + clean + PASTE_END + ENTER)` (one string, one call, in the same `try`). The prefix rule makes it impossible for the server to type anything but a pointer. **`submit` sanitises and writes; it does not refuse text that contained an ESC**: for `gonogo: a<ESC>[201~b` it writes `gonogo: a[201~b` (the hub only ever passes `pointerText`, which is ASCII, so this is defence in depth).
- `sanitizeForPaste(text)`: `\r\n` and `\r` become `\n`; remove every C0 control except `\n` and `\t` (this removes ESC, so a message cannot end the paste with `ESC[201~` and type keys), DEL and C1 controls (U+0080 to U+009F);
  remove zero-width, bidi and tag characters (U+200B to U+200F, U+202A to U+202E, U+2060 to U+2064, U+2066 to U+2069, U+FEFF, U+E0000 to U+E007F); trim. (Claude Code strips some of these itself and turns tabs into 4 spaces.)

### 6.8 Stopping

`stop(name, generation?)`: resolve at once when there is no live process, or `generation` is given and is not the live one. Otherwise (a second call returns the same promise):

1. `stopRequested = true`. Send `SIGTERM` to the **process group**: `process.kill(-pid, 'SIGTERM')` (the pty child is a session leader, so its group id is its pid); if that throws `ESRCH`, try `process.kill(pid, 'SIGTERM')`; other errors are logged.
2. After `killAfterMs` (default `STOP_KILL_AFTER_MS` = 5000) with no exit: `process.kill(-pid, 'SIGKILL')` (fall back to `pid`).
3. After a further `giveUpAfterKillMs` (3000) with still no exit event: treat the process as gone (run the exit handling with `code: null, signal: 9`, call `pty.destroy()` in a try/catch).
4. The promise resolves after the exit event handlers have run. Claude handles SIGTERM itself (runs its SessionEnd hooks, ends its children, exits in about 2.4 s with code 143); SIGKILL first would orphan its MCP servers and tool processes,
   and a SIGKILL leaves no `SessionEnd`. After a natural exit nothing sweeps the group (a dev server the agent started on purpose may keep running).
`stopAll()`: `stop` for every live record, in parallel.

### 6.9 Exit

`pty.onExit({ exitCode, signal })` runs once (also when synthesised by step 3 above). **Its first line sets `exited = true` on the record**: from then on `write`, `resize` and `submit` return false without touching the pty (the record stays `running` for `stop()` bookkeeping until the mirror has finished parsing, and a resize or attach with a size that lands in that window used to throw out of the WebSocket handler).
`code = signal > 0 ? null : exitCode`, `signal = signal > 0 ? signal : null` (node-pty reports exit code 0 with a signal for a crash). `durationMs = now() - spawnedAt`.
Wait for the mirror to finish parsing (`mirror.write('', cb)`), then `tail` = the last `EXIT_TAIL_LINES` non-empty rows of the viewport, joined with `\n`, at most `EXIT_TAIL_CHARS`. Clear the kill timers, mark the record not running, then emit
`{ kind: 'exit', name, generation, info: { code, signal, durationMs, requested: stopRequested, tail }, at }`, then resolve the stop promises. Exit code 1 within 3 s of a start is the signal of a wrong session flag; deciding on it is the hub's job (4.9).
When the **server** dies the kernel closes the pty masters and claude gets SIGHUP (exit 129, about 2.2 s); that is why shutdown calls `stopAll()` first.

### 6.10 Spawn-helper guard

`ensureSpawnHelperExecutable(log?, roots?)` returns the list of paths it changed. `roots` (package directories to scan instead of the `require.resolve` results) exists so that the test can run it on a temp tree with a 0644 helper; `spawn()` never passes it. For each package in `@lydell/node-pty-<platform>-<arch>` and `node-pty` (the official one, in case someone swaps the library): try
`createRequire(import.meta.url).resolve('<package>/package.json')`; in that directory look for files named `spawn-helper` under `prebuilds/*/` and `build/Release/` (depth at most 2). If a file exists and `(mode & 0o111) === 0`,
`chmodSync(path, mode | 0o755)` and report it. Errors (not the owner, read-only file system) are logged as a warning with the path and do not throw: the spawn then fails with `posix_spawnp failed`, which 6.2 explains.
Linux packages have no helper: the function finds nothing and returns `[]`.

### 6.11 Events and errors

`onEvent(handler)` returns an unsubscribe function; handlers run synchronously in subscription order; an exception in a handler is caught and logged (never breaks the host). Per agent: `title` events may arrive **before** `ready` (the first title, `✳ Claude Code`, is written in the same chunk as `ESC[?2004h`, before the prompt box, and the title callback runs while that chunk is parsed), any number of them after it, and `exit` is always last.
`spawn` throws `Error` with a user-facing message; **every other method returns a value and never throws** (for a missing agent, after the process exited, or when the pty rejects the call). `info(name)` returns `{ running, generation, pid, cols, rows }` (null for a name never spawned). `outputBytes(name)` is 0 when there is no record.

## 7. The launcher (builder B, `launcher.ts`)

Everything that depends on Claude Code's flags, settings keys and first-run behaviour is here. Facts: `docs/facts/claude-code-hooks-mcp.md` section 0 (cheat sheet), 1, 6, 7, 9, and
`docs/facts/toolchain-docker.md` section 4.2. `<home>` = `LauncherOptions.homeDir`, `<name>` = the agent name, `<dir>` = the agent's working directory.

### 7.1 `prepareStart(agent, { generation, flag })`, in this order

1. `stat(agent.dir)`: not a directory -> reject `Error('working directory does not exist: <dir>')`.
2. `mkdir -p <home>/agents/<name>` (mode `DIR_MODE` 0700; `chmod` when it exists with another mode).
3. `memory.md`: when missing, create it (mode 0600) with `# Memory of <name>\n\nNotes that survive restarts. Keep it short.\n`. Never overwrite.
4. **Token**: `token = randomBytes(TOKEN_BYTES).toString('hex')`. Registry: `byToken: Map<token, {agent, generation}>` and `byAgent: Map<name, {token, generation}>`. Issuing revokes any older token of the same agent (one live token per agent).
   Write `<home>/agents/<name>/token` (the token and `\n`, mode 0600, atomic).
5. Write `settings.json` (7.3) and `mcp.json` (7.4), mode 0600, atomic (temp file in the same directory, then `rename`). Both are regenerated on every start, so an edited role, mode or a new port always applies.
6. Seed mode: 7.6 (trust is written **and verified** here, before step 8 builds the environment; a failure rejects).
7. Session flag: `flag ?? ((await transcriptExists(...)) ? 'resume' : 'session-id')` (7.5).
8. argv (7.2), environment (7.8), `file`/`args` (7.7). Return `{ spec: { file, args, env, cwd: agent.dir }, flag, token }`.

Any failure rejects with an `Error` whose message a user can read; nothing is half-registered (a token issued in step 4 is revoked on failure).

### 7.2 The command line

Elements of the argv array (no shell, no quoting; every line below is one element or one flag with its value elements). First start (`flag === 'session-id'`):

```
--session-id <agent.sessionId>
--permission-mode <default | acceptEdits | auto | bypassPermissions>
--settings <home>/agents/<name>/settings.json
--strict-mcp-config
--mcp-config <home>/agents/<name>/mcp.json
--append-system-prompt <role text, one element>
--system-prompt-snapshot off
--allowedTools mcp__gonogo__send_message mcp__gonogo__list_roster mcp__gonogo__read_messages
```

Every later start (`flag === 'resume'`): the same list with `--resume <agent.sessionId>` in place of `--session-id <agent.sessionId>`. Why every flag every time: `--resume` restores history and model, not
`--settings`, `--mcp-config`, `--allowedTools`, `--permission-mode` or the role text. `--permission-mode` is always passed (without it a new interactive session may start in `auto`); `default` is accepted by claude 2.1.325.
`--strict-mcp-config` is mandatory (without it 600 tools from the owner's other MCP servers load). `--system-prompt-snapshot off` makes an edited role apply at the next start. `--allowedTools` is last because it takes several values.
No `--model` (the user's default applies; the smoke script sets `ANTHROPIC_MODEL=haiku` in the environment instead). The role text is `buildRoleText(name, agent.role, memoryPath)`: `ROLE_PREAMBLE` with `{name}`, `{memory}` (absolute path of `memory.md`) and `{role}` (the role, trimmed) replaced **in one pass with a function replacer**:
`ROLE_PREAMBLE.replace(/\{(name|memory|role)\}/g, (_, k) => values[k])`. Never `template.replace('{role}', role)`: a string replacement interprets `$&`, `$'`, `` $` `` and `$$` in the replacement, so a role such as `Budget is $$5 and cost $& more` would be silently altered (checked), and replacing the three placeholders one after the other
can expand a `{memory}` that the owner wrote inside the role. The role text is free text up to 4000 characters; prices, regexes and shell snippets contain `$`.
It contains no date, no roster and nothing else that changes between starts (the prompt cache stays warm).

### 7.3 `settings.json` (written with `JSON.stringify(obj, null, 2)`; key order as shown)

```json
{
  "hooks": {
    "UserPromptSubmit": [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:7777/hook/<name>/UserPromptSubmit", "timeout": 10, "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] } ] } ],
    "PreToolUse": [ ... same shape, url .../hook/<name>/PreToolUse ... ],
    "PostToolUse": [ ... ], "PostToolUseFailure": [ ... ], "PermissionRequest": [ ... ], "Notification": [ ... ], "Stop": [ ... ], "StopFailure": [ ... ]
  },
  "tui": "fullscreen",
  "promptSuggestionEnabled": false,
  "crossSessionInbound": "refuse",
  "permissions": {
    "deny": ["SendMessage", "ListAgents"],
    "allow": ["Read(//<memory path without its leading slash>)", "Edit(//<memory path without its leading slash>)"]
  }
}
```

- `hooks`: one entry per name in `HOOK_EVENTS`, in that order, each `[ { hooks: [ handler ] } ]` with no `matcher`; `handler` is exactly `{ "type": "http", "url": "<hubUrl>/hook/<name>/<Event>", "timeout": HOOK_TIMEOUT_S, "headers": { "Authorization": "Bearer $GONOGO_TOKEN" }, "allowedEnvVars": ["GONOGO_TOKEN"] }`.
  `allowedEnvVars` is mandatory: without it claude sends `Bearer ` with an empty token. The host in `url` is literal and **always loopback**: what `hubUrl()` returns, which is `http://127.0.0.1:<port>` (or `http://[::1]:<port>` for a server bound to `::1`) whatever address the server is bound to (2.8 step 8); never `localhost`, never a LAN address (claude answers `HTTP hook blocked` and every hook of the agent is silent). No `SessionStart` entry (http hooks cannot use it). `PostToolUseFailure` is a working heartbeat (4.4): a tool the user allowed may fail, and then it fires instead of PostToolUse.
- `tui: "fullscreen"` pins the alternate-screen renderer so the byte stream has one format. `promptSuggestionEnabled: false` removes the grey suggestion that reads like typed text and saves a background request.
- `crossSessionInbound: "refuse"` and `permissions.deny` turn off Claude Code's own `SendMessage` and `ListAgents` so agents use gonogo's tools.
- `permissions.allow` lets the agent read and edit its own memory file without a prompt (path rule form `//absolute/path`: see open item O4).
- Only when `agent.mode === 'bypassPermissions'`: add `"skipDangerousModePermissionPrompt": true` (removes the one-time warning dialog; the user ticked the box in the hire form).
- Only when seed mode is on and the server environment has a non-empty `ANTHROPIC_API_KEY`: add `"apiKeyHelper": "printenv GONOGO_API_KEY"` (`API_KEY_HELPER_COMMAND`).
- Nothing else. No `env` block, no `model`, no `statusLine`, no `sandbox`.

### 7.4 `mcp.json`

```json
{ "mcpServers": { "gonogo": { "type": "http", "url": "<hubUrl>/mcp", "headers": { "Authorization": "Bearer ${GONOGO_TOKEN}" } } } }
```

`type` must be present. The key `gonogo` makes the tool names `mcp__gonogo__*`. `${GONOGO_TOKEN}` is expanded from the claude process environment; the token is never written into this file.

### 7.5 Session flag

Rule from the design: `--session-id` while no transcript file exists for the id, `--resume` once one does. Claude stores transcripts at `<configDir>/projects/<projectDir>/<id>.jsonl`, with `configDir` = `env.CLAUDE_CONFIG_DIR` or `~/.claude`
and `projectDir = cwd.replace(/[^A-Za-z0-9]/g, '-')` (`transcriptDirName`). The transcript stays in the **original** project directory when a later start uses another working directory, so the check is: exists in `projectDir` of
`agent.dir` or of its `realpath`; otherwise exists in **any** `<configDir>/projects/*/<id>.jsonl`. Read errors count as "does not exist". The hub corrects a wrong guess once: exit code 1 within 3 s **whose tail holds the message of the flag that was used** flips the flag (4.9; any other early exit 1 is a different problem and is reported as it is). Claude's own messages for the two wrong cases:
`Error: Session ID <uuid> is already in use.` (session-id on an existing id) and `No conversation found with session ID: <uuid>` (resume on a missing one); both exit with code 1 at once.

### 7.6 Seed mode

On when `options.seed` (Docker image default through `GONOGO_SEED_CLAUDE=1`, or `--seed-claude`). Off, the launcher never reads or writes any Claude file of the user and never answers a startup dialog. On, for every start, **in this order** (the order is the point: `IS_DEMO=1` hides the trust dialog **without** trusting the folder, so
hooks stay silent in an untrusted folder and nothing on screen says so: facts `toolchain-docker.md` 4.2, runs 16 and h1; step 1 must therefore be proven before step 2 is allowed):

1. **Trust**: set `projects["<dir>"].hasTrustDialogAccepted = true` in `claudeJson` = `<CLAUDE_CONFIG_DIR>/.claude.json` when `env.CLAUDE_CONFIG_DIR` is set, else `<os.homedir()>/.claude.json`, for `realpath(agent.dir)` and for `path.resolve(agent.dir)` (both when they differ).
   Merge, never replace: read the file (missing = `{}`); change only those keys; if nothing changes, do not write at all; otherwise write a temp file in the same directory
   (mode of the existing file, else 0600) and `rename`. Serialise these writes with a promise chain (several agents start together). Claude rewrites this file itself on every start; a lost update is possible and is open item O11.
   **The result is verified**: after the rename (or when nothing needed writing) read the file back and check that both keys are `true`; on a miss retry up to `TRUST_VERIFY_ATTEMPTS` (3) times, `TRUST_VERIFY_DELAY_MS` (200) apart, rewriting each time.
   **When the file is not valid JSON or not an object, or cannot be written (EACCES, ENOSPC, EROFS), or the keys are still not there after the last attempt, `prepareStart` rejects with `Error('cannot record folder trust in <path>: <reason>')`** (the hub shows it as `could not start: cannot record folder trust in ...`; it never starts a claude whose hooks would be silent).
   Never overwrite an invalid file: the user fixes or deletes it.
2. **`IS_DEMO=1`** goes into the child environment now, and only now (skips theme, login, trust, bypass-warning and API-key-approval dialogs; hides the account name in the header).
3. **API key**: when `env.ANTHROPIC_API_KEY` is a non-empty string, remove it from the child environment, pass it as `GONOGO_API_KEY`, and add `apiKeyHelper` to `settings.json` (7.3). A plain `ANTHROPIC_API_KEY` would trigger a dialog whose default is "No" (or `Not logged in` under `IS_DEMO`).
   `CLAUDE_CODE_OAUTH_TOKEN` is left in the environment. If both are set, log one warning (`both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; the API key is used`). The user sets one credential.
4. `skipDangerousModePermissionPrompt` is written per 7.3 for bypass agents (also outside seed mode).

What is left if claude's own rewrite of `.claude.json` still drops the key (O11) is caught at run time, not at start: the hub notices that no hook has ever arrived from a process whose title shows a turn, and says so on the held item (`held: no hook has reached gonogo from <name>; is its folder trusted?`, 5.4).

**What seed mode trusts.** It records trust for every folder an agent is hired into and for the boss's directory, while the child environment holds `CLAUDE_CODE_OAUTH_TOKEN` or `GONOGO_API_KEY`. Claude's trust dialog is what stops a cloned repository's `.claude/settings.json` from running its hooks and from adding permission rules or an `apiKeyHelper`: here a repository dropped under `/projects`
can run its own hook commands with the credential before any model turn. The hire form (8.6) and the README say so in one sentence; the mitigation `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is open item O22 (not adopted until it is run in the unprivileged container).

### 7.7 `GONOGO_AGENT_CMD` (tests, and users who want another command)

`parseAgentCmd(value)`: `undefined`, empty or blank -> `null`. A trimmed value starting with `[` must be a JSON array of one or more strings (else `Error('GONOGO_AGENT_CMD: ...')`); otherwise split on runs of whitespace (no quoting; paths with spaces need the JSON form).
`cli.ts` calls it and passes the result as `agentCmd`. With `agentCmd = [a, b, ...]`: `spec.file = a`, `spec.args = [b, ..., ...claudeArgs]` where `claudeArgs` is the argv of 7.2 unchanged. So `GONOGO_AGENT_CMD="node test/fake-claude.mjs"` runs
`node test/fake-claude.mjs --session-id ... --allowedTools ...`. Everything else is as for claude: files, token, environment, trust seeding when `seed`. The check for `claude` on PATH is skipped (2.8).

### 7.8 The child environment (`buildChildEnv`)

The complete environment of the claude process (the terminal host passes it as is):

1. Copy `options.env` (default `process.env`), drop undefined values.
2. Remove every name in `SCRUB_ENV_EXACT` and every name starting with an entry of `SCRUB_ENV_PREFIXES`: the session identity of any Claude Code that started gonogo (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_CODE_CHILD_SESSION`, ...). `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
   and the other operator settings stay. (A leaked `CLAUDE_CODE_CHILD_SESSION` makes claude skip saving transcripts, which breaks `--resume`.)
3. Seed mode: 7.6 (`IS_DEMO`, API key move).
4. Set `TERM=xterm-256color`, `COLORTERM=truecolor`, `GONOGO_TOKEN=<token>`.
5. `NO_PROXY` and `no_proxy`: append `127.0.0.1,localhost` to an existing value (comma-separated, no duplicates) or set it. Claude sends http hooks through `HTTPS_PROXY`/`HTTP_PROXY` unless the host is listed. That claude honours it for http hooks and for the MCP server is read from the docs and from binary strings only (facts `claude-code-hooks-mcp.md` 5.4, UNVERIFIED):
   the smoke script has a step for it (10.8), open item O24. A server bound to `::1` hands out `[::1]` URLs, which `NO_PROXY` does not list; that combination with a corporate proxy is not covered.
6. The token goes only in the environment, never on the command line (argv is visible to every local process through `ps`). The role text is on the command line (it is not secret).

### 7.9 Token registry and files

- `resolveToken(token)`: `byToken.get(token) ?? null`.
- `revoke(name, generation)`: when `byAgent.get(name)` has that generation, delete both map entries and unlink `<home>/agents/<name>/token` (ignore ENOENT); otherwise do nothing.
- `agents/<name>/token` exists so a person can run `GONOGO_TOKEN=$(cat <home>/agents/<name>/token) claude ...` against the generated files while debugging; the server never reads it back.
  Limit (design): an agent in `bypassPermissions` mode runs as the same OS user and can read these files; the tokens stop mistakes and API misuse, not a hostile agent.
- `renameAgentFiles(oldName, newName)`: `<home>/agents/<new>` exists -> reject `Error('agents/<new> already exists')`; `<old>` missing -> resolve; else `fs.rename`.
- `memoryPath(name)` = `<home>/agents/<name>/memory.md`.

## 8. The client (builders F and G)

React 19 + Vite + TypeScript, Pixi.js 8 for the floor, xterm.js 6 (+ `@xterm/addon-fit`) for the terminal. No UI framework, no state library, no CSS framework. Client files import only
`../shared/protocol.js` (types and const values), `react`, `react-dom`, `pixi.js`, `@xterm/*`, and each other. Import specifiers end in `.js` (they resolve to `.ts`/`.tsx` under Vite, vitest and `moduleResolution: bundler`; checked on Vite 8.3.8, vitest 5.1.0 and tsc 7.0.2, so `docs/scaffold-notes.md` was corrected to say the same).
Dark theme only (`color-scheme: dark`); themes are a non-goal.

### 8.1 Page layout (`App.tsx`, `styles.css`; builder F)

```
┌ top bar: "gonogo", connection badge ───────────────────────────────────────────────┐
├ floor pane ───────────────────────────┬ right pane ──────────────────────────────────┤
│ <Floor/> canvas + agent list          │ tabs: [flight] [ana] [ben]            [+ Hire] │
│                                       │ agent bar: name, state chip, reason/held,     │
│                                       │            Start|Restart  Stop  Edit  Remove  │
│                                       │ <TerminalPane/>                               │
│                                       │ <Brief/>                                      │
├ activity strip (<Activity/>, 176 px) ─┴───────────────────────────────────────────────┤
└──────────────────────────────────────────────────────────────────────────────────────┘
```

CSS grid: columns `minmax(360px, 1fr) minmax(420px, 1.4fr)`, rows `1fr 176px`; the strip spans both columns. Below 900 px width everything stacks (floor, right pane at least 60 vh, strip) and nothing scrolls
horizontally. The page is `100dvh`; panes scroll inside themselves. Initial selection: the boss. The selected name is remembered in `localStorage['gonogo.selected']` (inside try/catch; the page works without it).

CSS tokens (`:root`), used everywhere, contrast measured against the pane backgrounds:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#14161c` | page |
| `--panel` | `#1c1f27` | panes, dialogs |
| `--panel-2` | `#252a35` | inputs, chips, floor surround |
| `--border` | `#333a49` | |
| `--text` | `#e6e8ee` | text (14:1 on `--bg`) |
| `--muted` | `#a4acbd` | secondary text (7.2:1 on `--panel`) |
| `--accent` | `#8da2ff` | focus ring, selection, primary buttons (text on it: `--bg`) |
| `--ok`, `--warn`, `--danger` | `#6fd49a`, `#ffc857`, `#ff6b6b` | status (all >= 4.5:1 on `--panel`) |
| `--terminal-bg` | `#0f1115` | xterm background |
| `--floor-bg`, `--floor-line` | `#232733`, `#2b3040` | floor |

State colours are `STATE_COLORS` from `protocol.ts` (CSS reads them from a `style` attribute set in code, not from a second copy of the hex values).
Font: `ui-sans-serif, system-ui, sans-serif` for UI, `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` 13 px for the terminal.

### 8.2 The store (`store.ts`, builder F)

A hand-written store (no dependency). One module-level instance, subscribed to with `useSyncExternalStore`.

```ts
export interface ClientState {
  connection: 'connecting' | 'open' | 'reconnecting' | 'unauthorized';
  failedAttempts: number;                   // consecutive failed reconnects; >= RECONNECT_SERVER_GONE_AFTER means "server gone"
  info: ServerInfo | null;
  agents: Record<string, AgentView>;        // by name
  order: string[];                          // names sorted by desk ascending (stable reference unless it changes)
  activity: ActivityItem[];                 // newest first, unique ids, at most ACTIVITY_CLIENT_MAX
  selected: string | null;
  form: null | { mode: 'hire' } | { mode: 'edit'; name: string };
  envelopes: Envelope[];                    // transient animations (Envelope is defined in protocol.ts, so that store.ts needs no .tsx file)
  userMailSeenAt: number;                   // SERVER time (an `at` of an ActivityItem), persisted in localStorage['gonogo.mailSeenAt'] (try/catch); never Date.now(): the browser and server clocks differ for a remote user
}
export function createStore(initial: ClientState): { getState(): ClientState; setState(next: ClientState | ((s: ClientState) => ClientState)): void; subscribe(l: () => void): () => void };
export const store: ReturnType<typeof createStore>;
export function useStore<T>(selector: (s: ClientState) => T): T;     // re-renders only when the selected value changes (Object.is)
// pure and exported for test/client-store.test.ts:
export function applyServerFrame(s: ClientState, frame: ServerFrame, now: number): ClientState;
export function sortOrder(agents: Record<string, AgentView>): string[];
export function userMailCount(s: ClientState): number;               // activity items with to === 'user' and at > userMailSeenAt
// "mark mail seen" (mailbox click, a row expanded) sets userMailSeenAt to the largest `at` among the user-addressed items it marks, never to Date.now()
```

`applyServerFrame` (frames `state`, `agent`, `agent-removed`, `activity`; the others are ignored here):
- `state`: replace `info`, `agents`, `order`, `activity` wholesale; keep `selected` if that agent still exists, else the boss, else the first. No envelopes.
- `agent`: replace that entry (new object), recompute `order` when the name is new or its `desk` changed (else keep the same array); if nothing is selected, select the boss.
- `agent-removed`: delete; if it was selected, select the boss. (A rename arrives as `agent-removed` for the old name and then `agent` for the new one, 4.9; after the REST reply `HireForm` selects the new name.)
- `activity`: replace the item with the same `id`, or insert; keep newest first by `at`; cap at `ACTIVITY_CLIENT_MAX`. **A new id** (never seen) whose status is not `undelivered`, with `from !== to`, and both `from` and `to` an
  existing agent name or `user`, appends `{ id, from, to, startedAt: now }` to `envelopes`. Envelopes older than `ENVELOPE_KEEP_MS` are dropped on every frame and by a 1 s timer.
- `size` and the other frames: ignored here (`TerminalPane` handles `snapshot` and `size` through `api.ts`).
Components subscribe with narrow selectors (`useStore(s => s.agents[name])`, `useStore(s => s.order)`); they never read the whole state. `api.ts` is the only writer of `connection`, `failedAttempts`, `info`; `App.tsx`, `HireForm.tsx` and the others call
`store.setState` only for `selected`, `form`, `userMailSeenAt`.

### 8.3 The office floor (`Floor.tsx`, `art.ts`; builder G)

```ts
// Envelope { id, from, to, startedAt } (names or 'user'; startedAt = Date.now()) is defined in protocol.ts; Floor.tsx and store.ts both import it from there
export interface FloorProps {
  agents: readonly AgentView[];       // sorted by desk
  selected: string | null;
  envelopes: readonly Envelope[];
  userMail: number;                   // unseen messages addressed to the user
  reducedMotion: boolean;             // from prefers-reduced-motion
  onSelect(name: string): void;
  onEmptyDesk(): void;                // click on an empty desk: F opens the hire form
  onMailbox(): void;                  // click on the mailbox: F marks mail seen
}
export default function Floor(props: FloorProps): ReactElement;   // ReactElement from "react" (React 19 has no global JSX)
```
`App.tsx` passes the props; `Floor` does not import the store. `art.ts` imports only **types** from `pixi.js` (so `test/client-floor.test.ts` can import its pure helpers in Node): `fnv1a(name): number`, `deskCell(index): {x,y}`,
`deskCount(maxDesk): number`, `avatarParts(seed): Rect[]`, `hslToHex(h,s,l): number`, `bezierPoint(...)`, plus drawing functions that take a `Graphics` argument: `drawDesk`, `drawAvatar`, `drawStateBadge`, `drawEnvelope`, `drawMailbox`.

**Layout** (logical pixels; the stage is scaled to the container width, scale at most 1.25):

- `FLOOR_COLUMNS` (4) columns. Cell 168 x 150. Margin 24. Header strip 40 high (title "OFFICE", mailbox at the right). Desk `i` sits in column `i % 4`, row `floor(i / 4)`; cell origin
  `x = 24 + col * 168`, `y = 40 + 24 + row * 150`. Logical width 720; height `40 + 48 + rows * 150`.
- Desks drawn: `max(FLOOR_MIN_DESKS (8), ceil((maxDesk + 2) / 4) * 4)` where `maxDesk` is the highest `desk` of any agent, so there is always at least one empty desk and whole rows.
- **The boss** has desk 0 (top left, the first cell): a corner office: a wider desk (120 x 60 instead of 96 x 54, top colour `#6b5230`), a brass nameplate (a 40 x 10 rectangle `#b08d3c`) and a plant (three overlapping green circles) in the cell's corner. Other agents' desks: top `#5b4a3a`, edge `#4a3b2e`.
- **Empty desk**: dashed outline (4 px dash) of the desk rectangle in `--floor-line` lightened to `#3a4054`, a "+" drawn with two 2 px lines, label `empty desk` in `#8b93a7`. The whole cell is clickable (`onEmptyDesk`) unless the office is full (`MAX_AGENTS`).
- Floor surface `#232733` with 1 px grid lines `#2b3040` every 24 px.

**Per desk, back to front:** floor cell; chair (circle 22 px, `#2f3547`) behind the avatar; **avatar**; desk top (covers the avatar below the chest) with a monitor (rect 30 x 20 body `#0f1115`, 26 x 16 screen) and a keyboard (rect 24 x 6 `#3a4054`);
state badge above the avatar's head; queue and held badges at the desk's top right; name label (13 px, bold, `#e6e8ee`) below the desk, with a drawn star in front of the boss's name; state label (12 px, `STATE_COLORS[state]`, text `STATE_LABELS[state]`) below the name;
selection outline.

**State visuals** (colour comes from `STATE_COLORS`; the shape and the text label also say the state, so colour is never the only cue):

| State | Screen | Badge above the head | Avatar |
|---|---|---|---|
| `starting` | `#1b2036`, three dots pulsing in turn | three small dots | normal |
| `idle` | `#1b2a22` (dim green), static lines | check mark in a circle | normal |
| `working` | `#2a3a66`, lines scrolling 1 px per frame at 30 fps (static when `reducedMotion`) | rotating arc | normal |
| `needs_you` | `#3a1b1b`, red "!" | red circle with "!", scaling 1.0 to 1.15 at 1 Hz (static when `reducedMotion`) | normal |
| `stopped` | `#0a0b0e` (off) | power symbol (circle with a gap and a line) | alpha 0.45 and tinted `0x8b93a7` |

- **Queue badge**: when `queued > 0`, an envelope icon (14 x 10) with the count (`9+` above 9) in `--warn` at the desk's top right. **Held badge**: when `held` is set, two 3 x 8 bars (pause) in `--warn` next to it.
- **Selected**: 2 px rounded outline `#8da2ff` around the desk and labels, 4 px outside.
- **Mailbox** (header, top right): a mailbox shape 28 x 20 and the label `you`; when `userMail > 0` a red circle `#ff6b6b` with the count (`9+`) on its corner. Click: `onMailbox`.
- **Avatar** (`drawAvatar`): a 12 x 14 pixel grid drawn with `Graphics.rect` at scale 3 (36 x 42 px), from `seed = fnv1a(name)`: skin from 6 tones (`#f1c7a5 #e0a97c #c68642 #8d5524 #f6d5b8 #a8703f`) by `seed % 6`; hair colour from 6
  (`#2b2118 #5a3a22 #c9a227 #b5442c #6b6b6b #1d1d1d`) by `(seed >> 4) % 6`; hair style `(seed >> 8) % 3` (0 short: rows 0 to 1; 1 long: rows 0 to 1 plus side pixels at columns 2 and 9 down to row 6; 2 bun: rows 0 to 1 plus a 2 x 2 bun at columns 5 to 6 above row 0);
  head rows 2 to 6, columns 3 to 8; eyes at (4,4) and (7,4) `#1b1e27`; mouth (5,6) to (6,6) in a darker skin; torso rows 7 to 13, columns 2 to 9 in `hsl((seed >> 12) % 360, 55%, 50%)`; arms at columns 1 and 10, rows 8 to 12, 15 % darker; hands skin at rows 12 to 13.
  Only rows 0 to 9 show above the desk. No sprite sheets, no images, no fonts other than the system font for the labels.
- **Envelope animation**: for each entry in `envelopes` whose age is below `ENVELOPE_MS` (1400 ms): an envelope (18 x 12, `#f4efe3`, a V flap line `#b9b2a0`, 1 px outline `#7d7766`) travels from the sender's desk centre (or the mailbox when `from` is `user`) to the recipient's desk centre (or the mailbox) along a quadratic
  Bezier whose control point is the midpoint raised by 40 px, ease-in-out cubic, tilted by the tangent (at most 12 degrees), fading out over the last 150 ms, drawn above all desks. A name that has no desk (agent gone) skips the animation.
  With `reducedMotion` there is no travel: the recipient's cell gets a `--warn` outline for 700 ms.
- **Rendering**: one `Application` created in an effect with `await app.init({ resizeTo: container, backgroundAlpha: 0, antialias: true, resolution: devicePixelRatio })` guarded by a `cancelled` flag (React StrictMode mounts twice) and destroyed on cleanup
  (`app.destroy(true, { children: true })`). The ticker runs at most 30 fps and only while something animates (a working, starting or needs-you agent, or an envelope); otherwise stop the ticker and call `app.render()` after each prop change.
- **Hit testing**: each cell container has `eventMode = 'static'`, `cursor = 'pointer'`, `pointertap` calling `onSelect(name)` or `onEmptyDesk()`.

**Accessible list** (rendered by `Floor.tsx` next to the canvas, visible, compact):

```html
<section aria-label="Office floor">
  <canvas aria-hidden="true"></canvas>
  <ul aria-label="Agents" class="agent-list">
    <li><button type="button" aria-pressed="true|false" data-state="working">...</button></li>
    ...
    <li><button type="button">Hire a new agent</button></li>      <!-- only while fewer than MAX_AGENTS -->
  </ul>
  <div class="sr-only" role="status" aria-live="polite">...</div>
</section>
```

Button content: a state dot (shape differs per state: filled circle, ring, half circle, triangle, square) in the state colour, the name, the state label, `needsReason` when set, `n waiting` when `queued > 0`, and the held text.
The accessible name is `<name>[ (boss)], <state label>[: <needsReason>][, <n> message(s) waiting][, <held.text>]`. The live region announces changes after the first render: `<name> is now <state label>` and, for `needs_you`, `<name> needs you: <reason>`;
announcements are queued and joined so at most one is written per 500 ms. The canvas is decorative (`aria-hidden`): everything it shows is in the list.

### 8.4 The terminal pane (`TerminalPane.tsx`, `api.ts`; builder F)

`TerminalPane({ agent }: { agent: AgentView | null })`. One xterm `Terminal` instance for the whole page (created once in an effect, disposed on unmount, StrictMode-safe), with `FitAddon`;
options `{ cursorBlink: true, fontFamily: <mono stack>, fontSize: 13, scrollback: 2000, macOptionIsMeta: true, theme: { background: '#0f1115', foreground: '#e6e8ee', cursor: '#8da2ff' } }`. Default DOM renderer (no WebGL addon: there is one instance).
**`TerminalPane.tsx` imports `'@xterm/xterm/css/xterm.css'`** (Vite bundles it into the one CSS asset): xterm needs it for its layers, the hidden helper textarea, the viewport scroll and the selection, and every planned test passes without it while the pane renders wrongly.

**Attach.** The pane sends `api.attach(name, { cols, rows } from fit.proposeDimensions())` (an `AttachFrame` with a new `seq`, a counter in `api.ts`) when `agent.name` changes, when the connection becomes `open` again after a reconnect, and **on every `AgentFrame` of the attached agent whose `generation` differs from the `generation` of the last snapshot it applied,
or whose `state` is not `stopped` while that snapshot had `running: false`** (3.4 rule 4: a restart, the start of a stopped agent, the flip retry; at most one attach in flight per (name, generation)), always only when the container has a non-zero size and the page is visible. The pane remembers `generation` and `running` of every snapshot it applies. The hub emits an agent's `starting` frame after its process exists (4.9), so this attach finds the new terminal.
A `SnapshotFrame` whose `seq` is the current one: `term.reset(); term.resize(cols, rows); term.write(data)`,
remember `seq`. Binary frames (byte 0 = 1): read the uint32 at bytes 1 to 4, ignore when it is not the current `seq`, else `term.write(new Uint8Array(buffer, 5))`. `ws.binaryType = 'arraybuffer'`. Frames arriving for an old `seq` are dropped.
Agent not selected or none: `api.detach()`.

**Input.** `term.onData(d => api.input(name, d))`, `term.onBinary(d => api.input(name, d, true))`, only while attached to a running agent; otherwise dropped. **`api.input` splits `d` into pieces of at most `WS_INPUT_CHUNK_CHARS` UTF-16 code units** (never between the two halves of a surrogate pair) and sends one `input` frame per piece, in order: one frame per `onData` string made a 300 KB paste exceed `WS_MAX_FRAME_BYTES` and
the unguarded server died of the oversized frame; now such a paste arrives as ten frames. A custom key handler turns Shift+Enter into the bytes `ESC CR` (`'\x1b\r'`)
instead of the bare CR xterm.js would send (a bare CR submits the prompt; `ESC CR` inserts a newline, the sequence claude's own terminal setup uses), and Alt+Shift+T moves focus to the selected tab (xterm otherwise swallows Tab; this is the keyboard way out).
Paste uses xterm's default (it wraps in `ESC[200~ ... ESC[201~` when the TUI enabled bracketed paste, which the snapshot and the live bytes keep correct).

**Resize.** A `ResizeObserver` on the container, debounced `RESIZE_DEBOUNCE_MS`, calls `fit.fit()`; `term.onResize` sends `api.resize(name, cols, rows)` only when the size differs from the last one sent for this attach, the container is not zero-sized and
`document.visibilityState === 'visible'` (never fit or send for a hidden or unsized host: it proposes a tiny grid and every resize repaints claude). On `visibilitychange` to visible: fit again and send if changed. The pty has one size; the last browser to resize, attach with a size or type a real keystroke owns it (3.4).
**`SizeFrame`** for the attached agent: `term.resize(cols, rows)` when it differs from the xterm's size (the pty is the truth, and this window renders at that size so that claude's repaint is not drawn into a grid of another size); the pane first records that size as "the last one sent", so that `term.onResize` does not send it back and make this window the owner by accident. When `fit.proposeDimensions()` then differs from it, a one-line hint sits above the terminal:
`Size set by another window. Click to use this window's size.` The click does `fit.fit()` and `api.resize` (this window becomes the owner). **No window resizes itself back on its own in answer to a `SizeFrame`** (two windows would fight over the pty for ever).

**What it shows.**

| Condition | Pane |
|---|---|
| no agent selected | text "Select an agent or hire one" |
| `state === 'stopped'` | the last screen (dimmed to 55 %), and a card: `<name> is stopped`, `exit.text` when set, a **Start** button (`api.restart`) |
| `state === 'starting'` | terminal live, small chip "starting" |
| `state === 'needs_you'` | terminal live, a banner above it: `<name> needs you: <needsReason>` (`role="status"`) |
| connection `reconnecting` | terminal frozen and dimmed, input off, banner `Reconnecting...`; when `failedAttempts >= RECONNECT_SERVER_GONE_AFTER`: `The gonogo server is not reachable. Is it still running? Retrying every 10 s.` |
| connection `unauthorized` | the whole page shows `Open the URL that gonogo printed (it ends in #token=...).` |

The container has `role="region"` and `aria-label="Terminal of <name>"`. After a snapshot the terminal takes focus when nothing else (a dialog, an input) has it.

**`api.ts`** (the only module that talks to the server; builder F's shape, behaviour fixed here): `start()` reads the token (fragment, then storage; 3.2), `GET /api/state` with the header (401 -> `unauthorized`), applies it as a `state` frame, opens
`new WebSocket('ws(s)://<location.host>/ws', [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + token])` (the token is in the `Sec-WebSocket-Protocol` header, never in the URL: 3.2). Functions: `hire`, `edit`, `restart`, `stopAgent`, `remove`, `sendMessage` (the REST routes of 3.3, JSON, errors thrown as `Error(apiError.error)` with a `field` property), `attach`, `detach`, `input`, `resize`.
Server frames go through `applyServerFrame`. **Reconnect**: on WebSocket close or error set `connection = 'reconnecting'`; attempt `n` waits `RECONNECT_DELAYS_MS[min(n, last)]`, first does `GET /api/state` (401: `unauthorized`, stop; a network error or any other status, `503 starting` included: `failedAttempts += 1`, wait again;
200: open the WebSocket); on open `failedAttempts = 0`, `connection = 'open'`, and the pane attaches again. Retrying continues forever at the last delay. A `visibilitychange` to visible while not open retries at once.

### 8.5 The activity strip (`Activity.tsx`, builder F)

`Activity({ items, agents, onSelect })` with `items: ActivityItem[]` (newest first) and `agents: Record<string, AgentView>`. A `<section aria-label="Activity">` with a scrolling `<ol>`:

1. **Pinned lines first**: for every agent in `needs_you` with a `needsReason`: `<name> needs you: <needsReason>` with a red left border and the `!` icon (`role="status"`). Clicking selects that agent.
2. **Message rows** (at most 100 rendered): `HH:MM` (local 24 h), `from -> to` (an arrow character is fine here), then `"subject: preview"` (subject omitted when empty; preview = body with whitespace collapsed, at most 120 characters plus `…`), then a chip:

| `status` | Chip text | Style |
|---|---|---|
| `queued` | the `note` | muted |
| `held` | `held` then the `note` (already starts with `held:`; show it once) | `--warn` |
| `delivered` | `delivered` (+ note in a `title`); **when the note starts with `not read:` the chip shows the note** (the agent ignored two pointers, 5.5) | muted green; `--warn` with the warning icon for `not read:` |
| `read` | `read` | `--ok` |
| `undelivered` | `undelivered: <note>` with a warning icon | `--danger`, left border |
| `to_user` | `to you` with an envelope icon | `--warn`, left border |

   Each row is a `<button aria-expanded>`: clicking expands the full `body` (the item's `body`, up to 2000 characters; add `…(cut)` when `truncated`) and marks that item seen when it is addressed to the user. Rows addressed to `user` or undelivered also carry the colour/icon so colour is not the only cue.

### 8.6 The hire form (`HireForm.tsx`, builder F)

A native `<dialog>` opened with `showModal()` (focus trap and Escape for free), used for hire and edit (`store.form`). Fields and rules (the same limits as the server, from `protocol.ts`):

| Field | Control | Rule |
|---|---|---|
| Name | text, lower-case hint | matches `AGENT_NAME_PATTERN`, not `user` or `boss`, not in use (own name allowed in edit). In edit mode it is disabled with the hint "Stop the agent to rename it" unless the agent is stopped |
| Role | textarea | trimmed, 1 to `ROLE_MAX_CHARS` characters, counter shown |
| Working directory | text | trimmed, not empty, at most `DIR_MAX_CHARS`, starts with `/` ("a path on the machine where gonogo runs"); hire pre-fills `info.cwd`; the server checks that it exists |
| Permission mode | radio group | `default` (asks before risky actions), `acceptEdits` (edits files without asking), `auto` (Claude decides which tool calls are safe to run without asking and asks about the rest), `bypassPermissions` (runs every tool without asking) |

Choosing `bypassPermissions` shows a warning (`role="alert"`): "This agent will run every tool without asking: shell commands, file changes, network access. Use it only in a directory you can afford to lose." and a required checkbox "I understand".
**When `info.seed` is true** the form also shows one line under the working directory: "Folders added here are trusted automatically: repository hooks and settings run with your credential. Add only repositories you trust." (seed mode records Claude's folder trust for them, 7.6).
The submit button (Hire / Save) stays disabled until every rule holds. On submit the fields are disabled and `api.hire(...)` or `api.edit(name, ...)` is called (with `confirmBypass: true` when the box is ticked and the mode is bypass).
A server error is shown at the top of the form (`role="alert"`) and, when it names a `field`, on that field (`aria-invalid`, `aria-describedby`). Success closes the dialog and selects the agent (after a rename the new name: the `agent-removed` frame of the old one has already selected the boss, 8.2). Edit mode says "Changes apply at the next restart." Cancel and Escape close it without a request.
Every control has a visible `<label>`. Focus goes to the Name field (hire) or the first editable field (edit) on open and returns to the opener on close.

### 8.7 Tabs, agent bar, Brief box (`App.tsx`, `Brief.tsx`, builder F)

- **Tabs**: `role="tablist"`, one `role="tab"` per agent in `order` (the boss first), `aria-selected`, roving tabindex with Left/Right/Home/End, a state dot in the state colour; then a `+ Hire` button (`store.form = { mode: 'hire' }`). `onSelect` from the floor and the strip use the same `store.selected`.
- **Agent bar** (for the selected agent): name, state chip (colour and label), `needsReason` when set, `held.text` when set, `queued` count, "restart to apply changes" when `dirty`, and the buttons **Start** (stopped) or **Restart**, **Stop** (not stopped), **Edit**, **Remove** (never for the boss; asks `window.confirm("Remove <name>? Its terminal stops. Its memory file stays on disk.")`).
  Buttons are disabled while `transition` is not null and while their request is running.
- **Brief** (`Brief({ boss }: { boss: AgentView | null })`): a form with the label "Brief the boss (<boss name>)", a textarea (2 rows; Enter sends, Shift+Enter makes a newline) and a Send button; it calls `api.sendMessage({ to: 'boss', subject: 'Brief', body })`, then shows the result under the box
  (`queued`: "Sent. <note>"; `undelivered`: the note in `--danger`) and clears the text on success. Disabled with the hint "<boss name> is stopped. Start it to brief." when the boss is `stopped`, and when the text is empty.

**Components and props (summary).**

| Component (file) | Props | Reads from the store | Writes |
|---|---|---|---|
| `App` (`App.tsx`) | none | `connection`, `failedAttempts`, `order`, `agents`, `selected`, `activity`, `envelopes`, `userMailSeenAt`, `info` | `selected`, `userMailSeenAt` |
| `TerminalPane` | `{ agent: AgentView \| null }` | `connection`, `failedAttempts` | none (talks to `api`) |
| `HireForm` | none | `form`, `agents`, `info` | `form`, `selected` |
| `Activity` | `{ items: ActivityItem[]; agents: Record<string, AgentView>; onSelect(name: string): void }` | none | none |
| `Brief` | `{ boss: AgentView \| null }` | none | none (talks to `api`) |
| `Floor` (G) | `FloorProps` (8.3) | none | none |
| `main.tsx` | none | | reads the token (3.2), calls `api.start()`, renders `<App/>` in `StrictMode` |

### 8.8 Accessibility and contrast baseline (all client files)

- `<html lang="en">`; one `<h1>` ("gonogo") in the top bar; landmarks `header`, `main`, `section` with `aria-label`s; no positive `tabindex`.
- Every interactive element is a real `<button>`, `<a>`, `<input>`, `<textarea>` or `<dialog>`; hit areas at least 32 x 32 CSS px; visible focus ring: `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible`.
- Text contrast at least 4.5:1 against its background (the token table in 8.1 and `STATE_COLORS` were chosen for this: 4.8:1 to 9.7:1 on `#232733`); large shapes at least 3:1. Status is never colour only: every state has a text label and a distinct shape.
- `prefers-reduced-motion: reduce`: no envelope travel, no pulse, no scrolling lines, no spinner (CSS animations off and `FloorProps.reducedMotion = true`).
- Dialog errors use `role="alert"`; the activity and needs-you banners use `role="status"`; the live region of 8.3 announces state changes.
- Keyboard: the whole UI is reachable with Tab; tabs use arrow keys; Alt+Shift+T leaves the terminal; Escape closes the dialog. The terminal receives all other keys, including Tab and Escape, because claude uses them.
- `sr-only` utility class (visually hidden, still read).

## 9. The stand-in agent `test/fake-claude.mjs` (builder D)

A plain ESM file for Node 24, no dependency except `@modelcontextprotocol/sdk` (its client; resolved from the project's `node_modules`). It runs inside a pty exactly where claude would, started by
`GONOGO_AGENT_CMD="node test/fake-claude.mjs"` (or the JSON form with an absolute path), and receives the argv of 7.2. It makes no network call except to the gonogo server and needs no credential.
The e2e test exercises the **real** server paths through it: launcher files, token, hook transport, MCP, pointer typing, the terminal host and the hub. It must pass `node --check`.

### 9.1 Arguments

Parses exactly the flags of 7.2: `--session-id <uuid>` | `--resume <uuid>` (exactly one), `--permission-mode <default|acceptEdits|auto|bypassPermissions>`, `--settings <file>`, `--strict-mcp-config`, `--mcp-config <file>`,
`--append-system-prompt <text>`, `--system-prompt-snapshot <value>`, `--allowedTools <a> <b> ...` (values until the next argument starting with `--`). It checks that the settings and MCP files exist and parse, that `--strict-mcp-config` is present, that `--allowedTools` lists
the three `mcp__gonogo__*` names, and that `--system-prompt-snapshot off` is present. Any deviation (unknown flag, missing flag): print `fake-claude: <what>` to stderr and **exit 2**, so a launcher bug fails the test loudly.

### 9.2 Session emulation (what claude does with the id)

Transcript path `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd with every non-alphanumeric replaced by "-">/<id>.jsonl`. At start: `--session-id X` while any `projects/*/X.jsonl` exists -> print `Error: Session ID X is already in use.` and exit 1;
`--resume X` while none exists -> print `No conversation found with session ID: X` and exit 1 (both before drawing anything). The file is created (content `{}\n`) when the first prompt is submitted (not at start), like the real thing.
**`FAKE_CLAUDE_SESSION_DIR`**: when set, the fake looks for `<id>.jsonl` **only** in that directory (instead of `projects/*`) and creates its transcript there. The launcher keeps looking under `<CLAUDE_CONFIG_DIR>/projects`, so the two disagree about whether the session exists: that is how the test reaches the flag flip (a launcher and a fake that share one predicate never disagree, and exit code 1 is unreachable).

### 9.3 Startup and screen

1. At once: write `ESC[?25h`.
2. After `FAKE_CLAUDE_READY_MS` (default 150) write in one chunk: `ESC[?2004h ESC[?2031h ESC[?1004h`, `ESC]0;✳ Claude Code BEL`, `ESC[?1049h ESC[?1000h ESC[?1002h ESC[?1003h ESC[?1006h`, then draw the screen.
   (With `FAKE_CLAUDE_DIALOG=trust`: draw the trust dialog instead and wait, 9.8.)
3. Screen (R = terminal rows, W = columns, from `process.stdout`; draw with absolute positioning `ESC[<row>;1H`, `ESC[K`; first `ESC[2J`): rows 1 to 3 a header (` ▐▛███▛█   Claude Code v0.0.0-fake`, `▝▜██████▀  Fake model`, ` ▝▝   ▝▝   <cwd>`);
   row R-3 a rule of `─` repeated W times; row R-2 the prompt row `❯` + U+00A0 + the input text (or the placeholder `Try "fake placeholder"` when empty); row R-1 the rule; row R: `  ? for shortcuts`. Cursor after the typed text.
   Redraw everything on `SIGWINCH` / `process.stdout 'resize'` (claude repaints on resize).
4. Output uses `\r\n` where it needs line ends. It never prints anything on its own between turns.

### 9.4 Input

`process.stdin.setRawMode(true)`; read UTF-8. A tiny parser: `ESC[200~ ... ESC[201~` appends its content to the input (a CR inside becomes `\n`); a CR outside a paste submits (the whole input, with trailing whitespace trimmed); printable characters append; `\x7f` deletes one;
`\x03`: clears a non-empty input, else prints `Press Ctrl-C again to exit` and exits 0 on a second press within 1 s; a lone `ESC` clears the input (during a turn it interrupts: title back to `✳`, **no Stop hook**, like claude); other CSI/SS3/OSC sequences are ignored.
An input line starting with `!` is shell mode: no hook at all, title `◐` for `FAKE_CLAUDE_SHELL_MS` (default 1500; the e2e test sets 3000 or more, so that the 1 s of R3 and a 500 ms sweep tick cannot miss the window), then back to `✳`, no Stop. Echo the input on the prompt row as it is typed.
Every bracketed paste is logged as `{"e":"paste","text":...}` (the e2e test counts typed pointers with it). **`FAKE_CLAUDE_IGNORE_CR=1`**: a CR outside a paste does nothing (the text stays in the box, no turn, no hook), which is a pointer whose Enter was lost.

### 9.5 A turn

On submit with text `P`:
1. `UserPromptSubmit` hook with `prompt: P` (9.6). Create the transcript file if missing. Title `◐ Fake`, toggling `◐`/`◑` every 400 ms while the turn lasts.
2. If `P` matches `^gonogo: (\d+) new messages? from (.+)\. Call read_messages\.$` **and `FAKE_CLAUDE_IGNORE_POINTER` is not set**: call tool `read_messages` (9.7), then run the directives of every returned message body (below). Otherwise run the directives found in `P` itself, if any; with none, "think" for `FAKE_CLAUDE_TURN_MS` (default 200).
3. Every tool call is wrapped in `PreToolUse` and `PostToolUse` hooks (`tool_name: "mcp__gonogo__<tool>"`, `mcp_server: { name: "gonogo", source: "dynamic" }`, `tool_input`, `tool_use_id`, and for Post `tool_response`).
4. **Stop**: POST `Stop` (`stop_hook_active: false`, `last_assistant_message: "ok"`). While the reply is `{"decision":"block","reason":R}`: count blocks; treat `R` as a new instruction (a pointer: call `read_messages` again, with its Pre/PostToolUse hooks, which resets the block counter like claude);
   post `Stop` again with `stop_hook_active: true`. **Emulate claude's cap**: if the 9th consecutive block comes (no tool call since the 8th), ignore it and end the turn. Then title `✳ Fake`, redraw the box.
5. Log each step to the file of 9.9.

**Directives** (one per line, in a message body or a typed prompt): `@fake send <to> | <subject> | <body>` (tool `send_message`, result logged; the line is split on ` | ` into at most three parts, the third is the whole rest of the line, so a body may itself be a directive and chains nest: `@fake send ben | chain | @fake send ana | back | ok`); `@fake list` (tool `list_roster`); `@fake sleep <ms>`; `@fake tool <name>` (Pre/PostToolUse hooks for a built-in tool, no MCP call);
`@fake permission <tool> [<ms>]`: post `PermissionRequest`, replace the box by a permission dialog (rows `Do you want to run <tool>?`, `❯ 1. Yes`, `  2. No`, `Esc to cancel`; the title stays `✳`), wait for the answer: `1` or CR -> remove the dialog, set the title to `◐`, **run the tool for `<ms>` ms (default 0) with no hook**, then post `PostToolUse` and go on (a tool that runs after an allowed prompt: R4 must leave `needs_you` before that hook);
`2` or ESC -> remove the dialog and end the turn **without any hook** (what a denial does);
`@fake apierror` (post `StopFailure` instead of `Stop`); `@fake exit <code>`; `@fake crash` (`SIGKILL` itself); `@fake say <text>` (print a line in the transcript area);
`@fake notify <type> <message>` (post a `Notification` hook with `notification_type` `<type>` and `message` `<message>`; no screen change: the late `permission_prompt` Notification and the elicitation types of 4.4);
`@fake dialog` (draw a permission-like dialog on screen, `Do you want to proceed?` with a numbered menu, **post no hook**; the title stays `✳`; answered like `@fake permission`: R1 must find it, `needs_you` with `SCREEN_DIALOG_REASON`);
`@fake newsession` (every later hook of this process carries a fresh random `session_id`, as after `/clear`).

### 9.6 Hooks

For event `E` take `settings.hooks[E][0].hooks[0]` = `{ url, timeout, headers, allowedEnvVars }`. Build the header value by replacing `$NAME` with `process.env[NAME]` **only for names listed in `allowedEnvVars`** (otherwise with an empty string: claude does this, and the server then answers 401, which the e2e test catches).
`POST` with `Content-Type: application/json`, body `{ session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name: E, ...fields }` (fields as in `docs/facts/claude-code-hooks-mcp.md` section 2), `fetch` with an abort after `timeout` seconds. Any failure (network, non-2xx) is a non-blocking error: log it, continue.
Only the reply to `Stop` is interpreted (`decision: "block"` with `reason`). `FAKE_CLAUDE_NO_HOOKS=1` posts nothing (emulates claude before the trust dialog is answered).

### 9.7 MCP

Read `mcpServers.gonogo` from the MCP file; expand `${GONOGO_TOKEN}` from the environment in the header; connect with the SDK's `Client` and `StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })` at ready time (log failure; retry at the first call).
Call tools by name with their arguments (`send_message` takes `to`, `subject`, `body`, `in_reply_to`); parse the text of the first content item as JSON; log it.

### 9.8 Dialog, exit and the other switches

- `FAKE_CLAUDE_DIALOG=trust`: instead of the box draw `Quick safety check: Is this a project you created or one you trust?`, `❯ No, exit`, `  Yes, I trust this folder`; no `?2004h` yet, no hooks. Input `1`, `y` or CR on the second row accepts: continue with the normal startup (hooks work from now on). `FAKE_CLAUDE_DIALOG=bypass` does the same with `WARNING: Claude Code running in Bypass Permissions mode`.
- `SIGTERM`: after `FAKE_CLAUDE_EXIT_DELAY_MS` (default 100) set the title to empty, print `Resume this session with:` and `claude --resume <id>`, `process.exit(143)`. With `FAKE_CLAUDE_STUBBORN=1` ignore SIGTERM (exercises the SIGKILL path). `SIGHUP`: exit 129.
- Other env switches: `FAKE_CLAUDE_READY_MS`, `FAKE_CLAUDE_TURN_MS`, `FAKE_CLAUDE_SHELL_MS`, `FAKE_CLAUDE_EXIT_DELAY_MS`, `FAKE_CLAUDE_IGNORE_CR` (9.4), `FAKE_CLAUDE_SESSION_DIR` (9.2), `FAKE_CLAUDE_IGNORE_POINTER` (9.5: a pointer prompt is treated like any other prompt, so the agent never calls `read_messages` for it).
- **Every switch is read from the fake's process environment, which the server derives from the `env` that was passed to `startGonogo`: a switch is global to that server and so to every agent it runs.** A scenario that needs one starts its own fresh server and uses the boss (which always exists) as its subject.

### 9.9 Log for assertions

When `FAKE_CLAUDE_LOG_DIR` is set, append JSON lines to `<dir>/<agent name>.jsonl` (the name is taken from `/hook/<name>/` in the hook URLs): `{ "e": "start", "argv": [...], "tokenLength": 64, "cwd": ..., "pid": process.pid }` (never the token: the test reads it from `<home>/agents/<name>/token` while the agent runs, mode 0600, 7.9, and **before** a stop, which unlinks it), `{ "e": "resize", "cols": C, "rows": R }` (at start and at every redraw after a size change), `{ "e": "paste", "text": ... }`, `{ "e": "prompt", "text": ... }`,
`{ "e": "hook", "event": ..., "status": 200, "reply": ... }`, `{ "e": "tool", "name": ..., "result": ... }`, `{ "e": "dialog", ... }`, `{ "e": "exit", "code": ... }`. The `start` event is written right after the arguments were parsed and **before** the session check of 9.2, so a start that exits 1 is visible too (the flip test counts them). The e2e test reads these to assert what the agent saw (which prompts were typed, which block replies came).

## 10. Test plan

Rules for all tests: vitest (`pnpm test` runs everything under `test/`); nothing printed (use `nullLogger` or a collecting sink; `console.*` is banned in `src/`); no network except `127.0.0.1`; no real `claude`; no file outside a per-test temp directory
(`fs.mkdtemp(join(os.tmpdir(), 'gonogo-'))`, removed in `afterEach`) and the project; each test file independent; ports are always 0. Every behaviour rule that a section above states with "must", "never" or an exact string needs at least one test.

### 10.1 `test/hub.test.ts` (A)

A fake `HubIo` (fake clock, timers stored and fired by the test, scripted `screen()`/`title()`/`outputBytes()`, recorded `typePointer`/`spawn`/`stop`/`emit`/`logMessage`/`saveRoster` calls, in-memory roster, a `spawn` the test can hold open). Cases:
state table 4.5 for every hook (`PostToolUseFailure` included), implicit readiness (P3), PermissionRequest and the needs_you heartbeat rule with and without a dialog on screen, Notification types (**`permission_prompt` ignored when no dialog is on screen or the screen is unparsed, applied with one; elicitation types without a screen check**), StopFailure;
reconciliation R1 (to idle, to needs_you with a dialog, suppressed after a block, **skipped with a null probe, clock from `max(info.since, stateSince)` so that a sweep tick 20 ms after a Stop does not flip `idle` back to `working`**), R2 (**also clears trigger and `stopBlocks`**), R3 with the fake clock, **R4: `needs_you` (`permission`) -> `working` once the dialog is gone and the glyph has been `working` for `TITLE_WORKING_CONFIRM_MS`; not while a dialog is on screen; not while the glyph is `idle`; not for kind `input`**;
startup timer (5 s with output -> needs_you with the exact reason; without output -> recheck; ready later -> idle); delivery to each recipient state (5.9 table) including coalescing of two messages into one pointer and `pointerText` exact strings (singular, plural, several senders, "and others"; **the longest pointer is 164 characters**);
the typed write is exactly one `typePointer` call; **the notes of a send (an idle recipient: `waiting: about to type the pointer`); a working recipient with a draft is `held` from the first frame and stays `held` through the delivery check (no flip to `waiting: ... is working` and back)**;
the 2 s confirmation (confirm, **confirm with a prompt that only ends with the pointer**, timeout -> held + exact note, **the no-hook note when `hooksSeen` is false and the glyph is `working`**, no retry, late confirm, release by Enter, release by Ctrl-C, **no release by Escape**, release by another UserPromptSubmit, Stop does not release;
**`read_messages` before the hook: `pendingConfirm` and `unconfirmed` cleared, timer cancelled, no invisible latch (a later message is typed, not held); the timer finds no queued ids and sets nothing**);
Stop hook: block reply exact JSON, delivered note, never block with a draft, never block ids in flight, **one state write per Stop (a block leaves `working` with no frame and no `stateSince` change; no transient `idle`)**, cap: 8 blocks then `{}` and a typed pointer, counter reset by PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit;
**`redeliver`: a `delivered` message whose turn ended unread (Stop, StopFailure, R1, R2) goes back to the queue once with `waiting: <name> has not read it yet` and is pointed at again; the second time its note becomes `not read: ...` and nothing more is typed; `read_messages` drops the counter**;
draft latch: `classifyInput` table (printable, Enter, **Escape alone: no effect**, `ESC[A`, SGR mouse, X10 mouse, focus, DA reply, bracketed paste, paste then Enter, Ctrl-C, Backspace, Tab, mixed chunks) and its return value from `onUserInput`, dialog guard, **`set` ignored while `needs_you`, a foreign UserPromptSubmit leaves the draft latch alone, screen proof (empty box for 1 s after the last input clears it; a placeholder or text does not; a null probe does not), held items released at once with the wait note**,
30-minute expiry, effect on view (`draft`, `held` texts); hops: user 0, agent 1, trigger +1, cap (hops 9 refused at maxHops 8), `to user` never blocked, trigger cleared by Stop/StopFailure/foreign UserPromptSubmit/R1/R2/exit, an empty read keeps it;
stopped, stopping and removing recipients (undelivered, exact notes, `SendResult.ok false`), stop/exit converting unread messages, restart keeping the queue and returning delivered-unread to queued, server start converting old queued items;
`read_messages` exactly-once, order, trigger, statuses emitted; `sendFromAgent` validation errors (unknown recipient lists names **and is `not_found` with field `to`**, self, empty body, too long) as `HubError` with `code` and `field`; `boss` alias; **a stale generation or a running transition refused with `conflict` by `sendFromAgent`, `readMessages` and `rosterFor`; an unknown agent: empty read, `not_found` roster**;
lifecycle: hire validation (every rule of 4.9 with its field), desk assignment, boss creation (`flight`, desk 0, `BOSS_ROLE`, dir from options), edit (rename only stopped, `dirty`, bypass confirm, **rename: `agent-removed` for the old name and then the agent frame of the new one, `rt`, queue and operation chain re-keyed, `renameAgentFiles` called, an operation queued under the new name runs after the rename**), remove (boss refused), restart sequence (stop then spawn, transition flags, **one frame**), per-agent serialisation,
**spawn: no AgentFrame with the new generation before `io.spawn` resolves (a held `spawn`), the `starting` frame after it, the `stopped` frame with `could not start` on rejection**,
flag flip (exit code 1 within 3 s once, opposite flag, not twice, not when requested, not after 3 s, **only when the tail holds the message of the flag used; exit code 1 with an unrelated tail goes to `stopped` with its own text**), spawn rejection -> stopped with `could not start`, `/clear` session id follow, stale-generation events ignored (hooks, ready, title, exit), **`shutdown`: lifecycle calls rejected with `conflict` afterwards, no message converted by the exits, `start()` later converts them**; persistence calls (`saveRoster`, `logMessage`) and emitted frames for each change.

### 10.2 `test/launcher.test.ts` (B)

Against a temp home, no claude. Exact `deepStrictEqual` of: argv for first start and later start (every element, the role text element contains the preamble and the role and the memory path; **a role containing `$&`, `$$`, `$'` and the literal text `{memory}` appears verbatim in the argv element**); `settings.json` for `default`, `acceptEdits`, `auto`, `bypassPermissions` (skip key), and seed mode with an API key (apiKeyHelper) and without;
`mcp.json`; the child env (scrub exact names and prefixes, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR` kept, `TERM`, `COLORTERM`, `GONOGO_TOKEN`, `NO_PROXY` merged without duplicates, no `ANTHROPIC_API_KEY` in seed mode and `GONOGO_API_KEY` set, `IS_DEMO` only in seed mode **and only after the trust was verified**).
Session flag: no transcript -> `session-id`; transcript in the agent's project dir -> `resume`; transcript in another project dir -> `resume`; a forced flag wins. Seed trust: creates the file, merges without losing keys, writes both `realpath` and `resolve` paths, skips the write when already true,
**an invalid JSON file or an unwritable directory rejects `prepareStart` with `cannot record folder trust in <path>: ...` and leaves the file untouched (no `IS_DEMO` child is ever started without trust)**, a write that is lost (the file is rewritten without the key between write and read-back) is retried up to `TRUST_VERIFY_ATTEMPTS`, atomic (no temp file left), mode 0600. Token files: mode 0600 in a 0700 directory, one live token per agent, `resolveToken`, `revoke` deletes the file and forgets the token, revoke of an older generation does nothing.
`parseAgentCmd` (undefined, blank, whitespace form, JSON form, bad JSON), `agentCmd` replacing `file` and prepending args. `renameAgentFiles`, memory file created once and never overwritten, missing working directory rejects.
A test that runs `JSON.parse` on the generated settings and checks that every hook URL matches `/hook/<name>/<Event>` for the eight `HOOK_EVENTS` and that no secret value appears anywhere in the two files. **A test that `hubUrl` values `http://127.0.0.1:7777` and `http://[::1]:7777` appear unchanged and that no URL in the two files has another host.**

### 10.3 `test/terminal.test.ts` and `test/fixtures/` (C)

Pure: `analyzeScreen` on recorded screens (idle box, box with typed text, wrapped multi-row draft, permission dialog, trust dialog, bypass warning, API key dialog, numbered menu, an assistant line `Do you want to ...` without a menu, the footer `bypass permissions on`, a dashed rule that is not a box);
`classifyTitle` (`✳ Claude Code`, `◐ x`, `◑ x`, empty, other); `ModeTracker` (split across chunks at every byte, combined `?1000;1006h`, last wins, nothing seen -> `''`); `sanitizeForPaste` (ESC, `ESC[201~`, C1, zero-width, tab, CRLF, trim); `buildSubmit`; `ensureSpawnHelperExecutable(log, [dir])` on a temp tree with a 0644 helper (fixed to executable, reported) and with nothing (returns `[]`).
**Reconnect fix-ups on a recorded stream** (the design's required test): replay `test/fixtures/claude-fullscreen.stream.jsonl` (format: one JSON object per line, `{"k":"d","b":"<base64 output>"}`, `{"k":"rs","cols":C,"rows":R}`, ignore other kinds) into a `createTerminalHost` mirror through a test seam
(a `feed(name, bytes)` and `resize` entry on an internal factory exported for tests, or a fake pty injected through an option); at every quiet checkpoint compare a fresh headless terminal fed `snapshot.data` with the live mirror: viewport text, per-cell attributes, cursor, active buffer type, `modes` (bracketed paste, mouse tracking, focus, wraparound), **and the SGR mouse encoding** (a click at column 40, row 12 reports `ESC[<0;41;13M` in both).
Fixture source: copy `real-fs.stream.jsonl` (52 KB, a real fullscreen run with a permission dialog and 5 resizes) and `real-classic.stream.jsonl` from `<scratch>/facts-tui-pty/captures/` (the folder named in `claude-code-terminal.md` Appendix B) into `test/fixtures/`; they hold argv paths and screen text only. If they are gone, generate a synthetic stream with
`test/fixtures/make-stream.mjs` from the startup bytes of terminal facts 3.2, looped thinking frames, two resizes and `?1006`/`?25` toggles, and say so in the report.
Pty (real, with `/bin/sh` and `node -e` children, no claude): spawn echoes output and `onEvent` order (**a `title` may precede `ready`; `exit` is last**); `ready` fires for a child that prints `ESC[?2004h` and then a box (`❯`+NBSP between two rules) and not for one that prints only the dialog; `title` events; `submit` writes one chunk `ESC[200~ text ESC[201~ CR` (observe with a child that logs raw stdin as hex), **refuses** text without the `gonogo: ` prefix and when the mode is off, and **for text holding an ESC writes the sanitised text (no ESC except the two paste markers and the CR)**;
resize applies to mirror and pty (child prints `stty size`); **a child that exits, then `resize`, `write` and `submit` called in the same tick and from inside an exit listener: all return false and none throws**; exit codes (0, 1, signal) and the `tail`; `stop` with a well-behaved child (SIGTERM) and with a stubborn one and `killAfterMs: 200` (SIGKILL), process group kill (child spawns a grandchild that dies too), `stop` resolves after the exit event handlers; `attach` under heavy output (a child printing numbered lines) delivers snapshot + listener bytes with none missing and none duplicated;
**`rename` moves a finished record (the renamed name attaches to the last screen, the old name has none; false for a live process)**; spawn of a missing command throws a readable error; a second spawn of a live name throws; `screen()` is null while writes are pending.

### 10.4 `test/edge.test.ts` (E)

Real `http` server on port 0 with fake `Hub`/`TerminalHost` objects. Hooks: 401 (no header, wrong token, token of another agent -> 403), unknown event 404, bad JSON 400, Origin present 403, oversize 413, reply bodies (`{}`; a Stop block passes through; a non-Stop `decision` is stripped), the hub's `generation` argument comes from the token, `PostToolUseFailure` accepted.
MCP (through the SDK's own client against the server): tool list is exactly three, `send_message` stamps `from` from the token whatever the arguments say, **passes `identity.generation` to the hub, maps `in_reply_to` to `inReplyTo` and a missing `subject` to `''`**, result JSON shapes of 3.6 (queued, undelivered with `isError`, HubError with `isError`), `read_messages`, `list_roster`, 405 on GET/DELETE, 401, Origin refused, **a hub that throws answers 500 and the next request still works**.
Web: every REST route with its status codes and `ApiError` bodies, 415, 413, 400, 405 with `Allow`, `OPTIONS` 405, **503 `starting` on `/api` and `/ws` while `isReady()` is false (after the token check), 409 `shutting down` from the hub's rejection**; auth matrix (no token, wrong token, agent token on `/api`, browser token on `/hook`); Host matrix (`evil.example` 403, `127.0.0.1`, `localhost`, `[::1]`, an `allowedHosts` entry); Origin matrix (same-origin ok, other origin 403, absent ok, **`Host: gonogo.example.com` with `Origin: https://gonogo.example.com` and an `allowedHosts` entry ok (the reverse-proxy case)**);
**hostile input (3.2): `GET //`, `GET //[`, `GET /%E0%A4%A`, `GET /assets` (a directory), `Origin: null` on `/api`, `/ws`, `/hook`, `/mcp`, a 64-character non-ASCII bearer token and WebSocket token: each a 4xx, and the server answers a normal request afterwards**; a bind host that is a specific non-loopback address (use a second loopback alias or the machine's own address when available, else a fake) also answers on `127.0.0.1`;
WebSocket: handshake auth **through the subprotocol (`gonogo.v1` selected and the token never echoed; `?token=` refused)**, `state` first frame, `agent`/`activity` pushes through `broadcast`, `attach` -> snapshot then `start()` then binary frames with the right 5-byte header, a stale-seq attach, **size ownership: attach with size, resize, an input chunk whose effect is `set`/`clear` takes the size, focus (`ESC[I`), SGR mouse and device replies do not; a `size` frame goes to every socket attached to that agent after a change and not when nothing changed; `resize` for an agent the socket is not attached to is an `error` frame (`ref: resize`)**, `input` only for the attached agent and only calling `onUserInput` when `write` returned true, malformed frames keep the socket open,
**a 300 KiB frame closes the socket with 1009 and the server survives; a client that resets the connection during the 401 does not crash the server; a client that splits a 300 KB paste into `WS_INPUT_CHUNK_CHARS` pieces gets all of it written**, close clears ownership, backpressure close 1013 (fake slow socket), `close()` sends 1001.
Static: index, an asset with its cache header, SPA fallback, traversal attempts (`/../`, `%2e%2e`, NUL) 404, `staticDir: null` 404. Home: first-run token (64 hex, mode 0600), reopen reads the same token, **a pre-existing 0755 home and 0644 token are tightened to 0700 and 0600**, roster round trip and atomicity (no temp file left), corrupt roster throws with the path, invalid record rejected, messages fold (last line per id), **the second append of an id is a partial line, a partial line whose whole record is outside the window is dropped, the tail window and rotation (`messages.jsonl.1`), `lastMessageSeq` across a rotation**, `agentDir` rejects bad names, **the lock: a second `openHome` on the same directory fails with `another gonogo is using`, a stale pid or this process's own pid in an old file is replaced, `close()` removes it and flushes the chains (every test closes the home it opened: the set of held directories is per process)**.
CLI: argument parsing (flags, `=` form, env fallbacks, precedence, bad port, unknown flag exit 2), `parseAgentCmd` use, `claude` not on PATH message, the single `gonogo ready: <url>` line (capture stdout), URL host for wildcard binds, **a bind host of `localhost` binds `127.0.0.1`**, `startGonogo` + `stop()` leaves no listening socket, **a corrupt `agents.json` makes `startGonogo` reject and leaves the port free and no lock; a failure after `listen` closes the server; `POST /api/agents` during `stop()` answers 409 and leaves no process; a transient error (`ECONNRESET`) reaching the process-level handler is logged and the server keeps serving**;
`bin/gonogo.js` prints one `gonogo: <message>` line and exits 1 when the import throws (a fake `dist`), and the Node-version line before any import.

### 10.5 `test/e2e.test.ts` (D)

Starts `startGonogo({ port: 0, home: tmp, cwd: tmp, agentCmd: ['node', <abs path of test/fake-claude.mjs>], staticDir: null, env: { ...process.env, CLAUDE_CONFIG_DIR: tmp/claude, FAKE_CLAUDE_LOG_DIR: tmp/log }, log: nullLogger })` and talks to it with `fetch` and the `ws` package, like the browser would (the token in the `Authorization` header for REST and in the subprotocol pair `['gonogo.v1', 'token.<token>']` for the WebSocket).
A small helper `waitFor(predicate, timeoutMs)` polls `GET /api/state`; per-test timeout 30 s; real timers. **The fake's switches (9.8) are environment variables of the whole server: a scenario that needs one starts its own fresh server with it and uses the boss as its subject.** Scenarios (each starts from a fresh server unless stated):

1. **Boot and auth**: boss `flight` goes `starting` -> `idle`; `/api/state` 401 without the token, 403 for a foreign `Host`/`Origin`, 200 with the token; **the agent token (read from `<home>/agents/flight/token` while the boss runs; the fake's log holds only its length) is refused on `/api`**.
2. **Terminal**: WebSocket attach to the boss -> snapshot contains a row starting with `❯` + NBSP and `running: true`; binary frames follow; `input` frames typing `hello` then `\r` produce a `prompt` line in the fake's log, state `working` then `idle`; `resize` changes the fake's size (the fake logs `{"e":"resize","cols":C,"rows":R}`, 9.9) and a second attach gets the new size in the snapshot;
   **a second socket attached to the boss with another size and a `set` keystroke takes the size; the first socket receives a `size` frame; focus and mouse input from the first socket (`ESC[I`, `ESC[<35;10;5M`) does not take it back**.
3. **Hire**: `POST /api/agents` for `ana` (acceptEdits); validation errors (bad name, relative dir, missing dir, bypass without confirm, duplicate); the fake's logged argv equals the first-start argv built from 7.2 (**with the `sessionId` in `<home>/agents.json` and the exported `buildRoleText(name, role, memoryPath)`**: B's `build*` parameter objects are private, so D recomputes the expected argv from the section), `--session-id`, `--permission-mode acceptEdits`.
4. **Pointer delivery**: `POST /api/messages` to `ana`: the fake logs exactly one prompt equal to `gonogo: 1 new message from user. Call read_messages.`, the hub state goes `working`, the activity item goes `queued` -> `delivered` (note `pointer typed`) -> `read`; the message body is returned by the fake's `read_messages` call (check its log); `idle` again.
5. **Agent to agent and hops**: ana's message body contains `@fake send ben | hi | @fake send ana | back | x` style chains; `ben` receives it with hops 1; a ping-pong chain stops at the cap (start the server with `maxHops: 3`): the item beyond the cap is `undelivered` with the exact note and the sender's tool result is `ok:false`; a message to `user` becomes `to_user`.
6. **Working recipient and Stop block**: ben runs `@fake sleep 1500`; a message to ben meanwhile is `queued` (`waiting: ben is working`), then `delivered` with note `handed over when its turn ended`; the fake logged a Stop block reply and **one** extra turn, no second typed prompt.
7. **Draft latch**: `input` frames `abc` (no Enter) to ana: view `draft: true`, a message to ana becomes `held` with `held: text in ana's input`; `input` `\x03` (Ctrl-C) clears it and the message is delivered. **Second run: `abc`, then `\x1b` (the fake clears its box on ESC, standing for Esc Esc): the latch stays up for about 1 s and then the screen proof ends it (within 4 s) and the message is delivered; `abc` then `\x7f\x7f\x7f` (Backspace) ends it the same way.**
8. **Unconfirmed pointer** (fresh server with `FAKE_CLAUDE_IGNORE_CR=1`, subject the boss): the pointer is typed (one `paste` line in the fake's log), no turn, after 2 s the item is `held` (`held: pointer not confirmed within 2 s`) and the view has `held.kind === 'unconfirmed'`; no second pointer is typed within another 3 s (still one `paste`); the user's Enter in that terminal releases it and a fresh pointer is typed (two `paste` lines).
   **Lost hooks** (fresh server with `FAKE_CLAUDE_NO_HOOKS=1`, subject the boss): the pointer is typed, the turn runs without a single hook, `read_messages` returns the message within about a second: the item is `read` (never `held`) and **a second message to the boss is typed and read too** (no deaf latch).
9. **Stopped recipient**: `POST .../stop` on ben; a message to ben is `undelivered` with the exact note; `POST .../restart` brings ben back (`--resume`, because the fake wrote the transcript), generation increases, the old token (**read from `<home>/agents/ben/token` before the stop, which unlinks it**) is refused with 401 on `/hook`.
   **Attach race: attach over the WebSocket to ben while he is stopped (snapshot `running: false`), `POST .../restart`, wait for the `agent` frame with the new generation and state `starting`, then a fresh `attach` returns `running: true` with the new generation and binary frames follow** (a pane that attached to the finished record before the spawn used to stay dead).
10. **Startup dialog** (fresh server, `FAKE_CLAUDE_DIALOG=trust`, subject the boss): after 5 s `needs_you` with `startup dialog: answer it in the terminal`; `input` `1` -> `idle`. **Permission** (default server): `@fake permission Bash 4000` -> `needs_you` with `permission request: Bash`; **allowing it with `1` -> `working` within about 3 s through R4 (the fake runs the tool for 4 s and posts no hook meanwhile): assert `working`, not `idle` and not `needs_you`, while the fake's log shows no `PostToolUse` yet; then `idle` after the turn.**
    **Denial**: answering `2` (no hook follows) -> `idle` through screen reconciliation within `NEEDS_YOU_CLEAR_MS` + a sweep. **A late `Notification` (`@fake notify permission_prompt x` after the dialog was answered) does not bring `needs_you` back. `@fake notify elicitation_dialog hello` -> `needs_you` with `input requested: hello`. `@fake dialog` (no hook) -> `needs_you` with `a dialog is waiting in the terminal: answer it there` through R1 after about 2 s.**
11. **Shell mode** (`FAKE_CLAUDE_SHELL_MS=3000` in this server's env): `input` `!sleep\r` -> state `working` through the title glyph alone (no hook), then `idle` through the glyph (R1).
12. **Session flag flip** (fresh server with `FAKE_CLAUDE_SESSION_DIR=<tmp>/sessions`): hire `ana`, stop her, create `<tmp>/sessions/<ana's sessionId from agents.json>.jsonl`, restart: the launcher passes `--session-id` (it looks in `<CLAUDE_CONFIG_DIR>/projects` and finds nothing), the fake prints `Error: Session ID <id> is already in use.` and exits 1 within 3 s, the hub retries once with `--resume`, `ana` reaches `idle`;
    assert that after the restart the fake's log holds exactly two `start` events, with `--session-id` and then `--resume`, and no third. **A process that exits 1 within 3 s for another reason is not retried: hire `zed` and type `@fake exit 1` and Enter into him at once; he goes `stopped` with `exit.text` starting `exited with code 1` and the fake's log holds exactly one `start` event.**
13. **Stop paths**: SIGTERM stop (exit 143, `exit.text` `stopped`); `FAKE_CLAUDE_STUBBORN=1` agent is killed after about 5 s; `stop()` of the server leaves no fake process (`process.kill(pid, 0)` throws, **the pid from the fake's `start` event**) and no listening port.
14. **Static**: when `dist/client/index.html` exists (it does after `pnpm build`), a second server with `staticDir` serves it at `/` with the security headers; skipped otherwise.
15. **Edit, rename, remove**: `PATCH` ben's role -> `dirty: true`; restart -> the fake's logged `--append-system-prompt` holds the new role; stop ben, `PATCH` his name to `bob`: the WebSocket delivers `agent-removed` (`ben`) and then `agent` (`bob`), `GET /api/state` lists only `bob`, and a restart of `bob` starts with `--resume` and the same session id; `DELETE /api/agents/bob` -> 204 after the process is gone, `agent-removed` frame, the boss answers 409.
16. **Detach and session follow**: `detach` then no more binary frames and `input` is an `error` frame (`ref: input`); `@fake newsession` then another prompt -> `agents.json` holds the new session id.
17. **Unread pointer** (fresh server with `FAKE_CLAUDE_IGNORE_POINTER=1`, subject the boss): a message to the boss is typed (one `paste` line) and confirmed (`delivered`, `pointer typed`); the turn ends without `read_messages`; at that Stop the item goes back to the queue (`waiting: flight has not read it yet`) and is handed over at once by the Stop block (the fake logs one block reply and one extra turn; still one `paste` line);
    the extra turn ends unread too: the note becomes `not read: flight did not read it after two pointers`, the status stays `delivered`, and within 3 s no further block and no second `paste` come (no loop).
18. **StopFailure and roster**: `@fake apierror` -> the hub goes `idle` through StopFailure (no Stop), and a message queued meanwhile is then typed and read; `@fake list` -> the fake's logged `list_roster` result is a `RosterResult` with every agent, its state and the boss flag.

### 10.6 Client tests (optional, F and G)

`test/client-store.test.ts` (F): `applyServerFrame` for every frame (`size` ignored; a rename as `agent-removed` then `agent`), selection fallback, envelope creation rules (new id only, not for `undelivered`, unknown names skipped), ordering, cap, `userMailCount` (**`userMailSeenAt` is a server time: marking items seen sets it to the largest `at`**). `test/client-floor.test.ts` (G): `fnv1a`, `deskCell`, `deskCount` (boss at 0, at least one empty desk, whole rows), `avatarParts` determinism and bounds (12 x 14), `bezierPoint` endpoints, `hslToHex`. Node environment, no DOM, no Pixi value imports.
**A client test file may import only client modules that contain no import of a `.tsx` file** (`tsconfig.test.json` has no `jsx` setting: a test that reaches `Floor.tsx` through `store.ts` fails `tsc` with `TS6142`, verified). That is why `Envelope` lives in `protocol.ts` and `store.ts` and `art.ts` import no component.

### 10.7 What is not tested here

A browser test of the built client (design, Testing) has no file or owner in the fixed layout; it is open item O14. Linux, a real claude and the Docker image are checked by `scripts/smoke-real.mjs` and the Docker build (10.8). The packed package in plain Node is checked by `pnpm check:pack` (10.8).

### 10.8 `scripts/smoke-real.mjs`, `scripts/check-pack.mjs` and the Docker checks (H)

**`scripts/check-pack.mjs`** (`pnpm check:pack`; not part of `pnpm test`; the integrator runs it after `pnpm build` and before declaring the build done). Nothing else runs the compiled package in plain Node: `pnpm test` runs from `src` through vitest, the e2e test passes `staticDir` explicitly, and the failures that only a built run shows
(a CommonJS named import of `@xterm/headless`, a missing `.js` suffix, a wrong `dist` layout, the `../../package.json` read, the default `dist/client` path, the bin and its shebang, the engines guard) would reach the first user. Steps, each printing `ok <step>` or exiting 1 with the reason:
1. `pnpm pack --pack-destination <tmp>` (the `prepack` script cleans and rebuilds `dist`); the tarball's file list is exactly `package/bin/gonogo.js`, `package/dist/client/**`, `package/dist/server/*.js`, `package/dist/shared/protocol.js`, `package/package.json`, `package/README.md` (and a licence file when there is one): no `src`, `test`, `docs`, `.env*`, `*.tgz`, no lock file, no stale module.
2. In an empty directory with an empty `HOME`, pnpm store and cache and `env -i PATH=<dir of node>:/bin`, plus links to `sed`, `dirname` and `uname` (pnpm's bin shims call them; no compiler): `pnpm dlx file:<abs tgz> --version` prints `gonogo <version>`. pnpm is the one that runs the script (`npm_execpath`), so run it as `pnpm check:pack`.
3. Install the tarball into an empty project with `pnpm add file:<abs tgz>` (pnpm 10 runs no dependency build script unless allowed); start `node_modules/.bin/gonogo --port 0 --home <tmp>` with `GONOGO_AGENT_CMD` set to the JSON form of `["node", "<abs project>/test/fake-claude.mjs"]`; parse the `gonogo ready: ...` line.
4. `GET /` is `200 text/html` with the three security headers; `GET /api/state` without the token is 401; a raw `GET //` is 404 **and the server answers again afterwards**; the boss reaches `idle`.
5. SIGTERM: the process exits 0 within 15 s, the port is free, no fake process is left.

**`scripts/smoke-real.mjs`**: not part of `pnpm test`. `node scripts/smoke-real.mjs --spend` (refuses to run without `--spend`: it uses subscription tokens). Needs `pnpm build` first and a signed-in `claude`. Steps, each printing `ok <step>` or exiting 1 with the reason:
0. `claude doctor` on the generated files: start the server (`startGonogo` from `dist/server/cli.js`, temp home, port 0, `env.ANTHROPIC_MODEL = 'haiku'`), wait for the boss's `settings.json`, copy it to `<tmp probe>/.claude/settings.json`, run `claude doctor` there (no model call) and fail on any `Invalid`/`ignored` line mentioning hooks, permissions or `crossSessionInbound`;
1. the boss reaches `idle` within 30 s (if it is `needs_you` with the startup reason, print the dialog and tell the user to answer it in the terminal once, then retry);
2. hire `ana` in a temp git-free directory with `default` mode; 3. brief the boss: `POST /api/messages` to `boss`, body `Reply to the user with send_message: "ready". Nothing else.`; expect an item `to_user` from `flight` within 90 s; 4. message `ana` the same way; expect `to_user` from `ana` (this also answers O15 and O21: the model acted on the Stop feedback or on the typed pointer);
5. stop both and check the processes are gone; **6. proxy check: a second server with `env.HTTP_PROXY = env.HTTPS_PROXY = 'http://127.0.0.1:9'` (nothing listens there), hire an agent, type a short prompt through the terminal WebSocket: the agent must go `working` and then `idle` (the API call fails, StopFailure fires) while the hub sees the hooks, which shows that `NO_PROXY` keeps the loopback hook traffic off the proxy (O24; the MCP connection is not observed).**
It prints the activity strip at the end and the claude version. Docker (when a daemon is up): `docker build`, `docker run --rm --entrypoint claude <image> --version`, `docker run --rm --entrypoint id <image>` (uid 1000), `docker run --rm --entrypoint tini <image> --version`, run the image with no credential and check `gonogo ready:` appears and the boss reaches a state (no crash), as far as credentials allow;
the open items O16, O21, O22 and O25 are answered by these runs.

## 11. Conventions

- **Language**: TypeScript 7 (`strict`), ESM only (`"type": "module"`). Relative imports end in `.js` (`import { x } from './hub.js'`) in server, client and tests. Use `import type` for type-only imports. No `any` (use `unknown` and narrow), no `@ts-ignore`, no non-null `!` unless a comment says why it holds. Named exports everywhere; the only default export is `Floor` in `Floor.tsx`.
  The shared file is compiled without Node types: never import Node modules or use `Buffer`/`NodeJS.*` in `src/shared` or `src/client`.
- **Server compile**: `pnpm build:server` (`tsc -p tsconfig.server.json`, NodeNext, output `dist/server`, `dist/shared`). `@xterm/headless` is imported as default + destructured (6.1).
- **Style**: 2 spaces, single quotes, semicolons, trailing commas, `const` first. Comments say why, never what. No dead code, no TODO without an owner and an open item number.
- **Errors**: throw `Error` with a message a user can read (it may reach the UI). The hub throws `HubError` (`name`, `code`, `field`). Never swallow an error silently: log it with the logger or handle it. No floating promises: `void p.catch((e) => log.error(...))` (that includes `transport.close()` and `server.close()` in 3.6: an unhandled rejection that reaches the process-level handler is a last resort, 2.8, not a policy).
  Event and timer callbacks catch their own exceptions (an exception in a callback must not take the server down). `process.exit` only in `bin/gonogo.js` and `main` in `cli.ts`.
- **Logging**: every module takes a `Logger` (default `nullLogger`) and calls `log.child('<module>')` once. `console.*` is not used in `src/`. Only `main()` builds the stderr logger (`createLogger`). Levels: `error` something failed that a person should know; `warn` degraded but working; `info` lifecycle (start, stop, listening);
  `debug` everything else. Never log tokens, API keys, message bodies or hook payloads (9 of 0.3). Nothing is printed during tests: tests that exercise `main` capture stdout/stderr.
- **Clock and timers**: the hub uses only `io.now`/`io.setTimer`. Elsewhere `Date.now()` and `setTimeout`. Timers that must not keep the process alive are `unref()`ed.
- **Files**: write generated files atomically (temp file in the same directory, `rename`), with the modes of 0.3 item 9. Each of `home.ts` and `launcher.ts` has its own private helper (do not share one).
- **Security reflexes**: validate every name with `AGENT_NAME_PATTERN` before it touches a path or a URL; compare tokens in constant time where they are checked per request (`timingSafeEqual`); never put a token on a command line; never build a shell command string.
- **Dependencies**: exactly the ones in `package.json`; nobody adds one. Runtime: `@lydell/node-pty`, `@modelcontextprotocol/sdk`, `@xterm/addon-serialize`, `@xterm/headless`, `ws`, `zod`. A builder who needs another says so under "Requests to the scaffold" in the report.
- **package scripts you can rely on** (all exist; run them from the project root):

| Script | Does |
|---|---|
| `pnpm build` | `build:client` then `build:server` |
| `pnpm build:client` | `vite build` -> `dist/client` |
| `pnpm build:server` | `tsc -p tsconfig.server.json` -> `dist/server`, `dist/shared` |
| `pnpm typecheck` | `tsc` for the client config and the server config, `--noEmit` |
| `pnpm test` | `vitest run` (everything in `test/**/*.test.ts`) |
| `pnpm smoke:real` | `node scripts/smoke-real.mjs` (spends tokens; not part of `pnpm test`) |
| `pnpm check:pack` | `node scripts/check-pack.mjs`: packs, installs and starts the built package in plain Node (10.8; not part of `pnpm test`) |
| `pnpm prepack` | removes `dist`, then `pnpm run build` (runs on `pnpm pack`/`publish`; the Docker build uses `pnpm pack`). `tsc` never deletes stale files and `files` ships all of `dist`, so a module that was renamed or deleted during the build would otherwise stay in the tarball, the image and `pnpm dlx` |

- **Do not**: run `git init/commit/push`, `pnpm publish`, `docker push`; touch `~/.claude`, `~/.claude-work`, `~/.claude.json`; read credential files; start real `claude` sessions (except H's smoke script, run by a person with `--spend`). Scratch files go to the scratchpad of your job, never `/tmp`.

## 12. Conflicts found, and how each is resolved

1. **Boss name.** The design's mock and text say the boss is "Flight"; the hire rule says names are lower-case letters, digits and hyphens. Resolved: the default boss name is `flight` (`BOSS_DEFAULT_NAME`). It is renameable like any agent.
2. **Name pattern.** The design's rule is silent about a leading hyphen. Resolved: `^[a-z0-9][a-z0-9-]{0,31}$` (must start with a letter or digit), plus the reserved names `user` and `boss` (recipient aliases).
3. **Hook events.** The design's state table lists UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure and PermissionRequest; the cheat sheet's settings omit StopFailure and the facts add Notification as a backup. Resolved: **eight** events (`HOOK_EVENTS`): the six, Notification, and `PostToolUseFailure`
   (a working heartbeat: a tool the user allowed may fail, and then it fires instead of PostToolUse; 4.4). `PostToolBatch` and `MessageDisplay`
   (suggested as heartbeats) are not registered: PreToolUse and PostToolUse already cover "working"; fewer hooks, less noise. `SessionStart` cannot be an http hook and is not needed (readiness comes from the terminal).
4. **Three tools.** The cheat sheet's `--allowedTools` has two names; the design has three tools. Resolved: all three (`ALLOWED_TOOLS`).
5. **The ninth Stop block.** The design says Claude Code ignores the ninth consecutive block and the idle rule then delivers. The facts add that the count resets on every tool call. Resolved: the server never sends the ninth (`MAX_STOP_BLOCKS = 8`); at the cap it answers `{}` and the typed path delivers (5.5). The design's hop cap (also 8) is a different counter.
6. **Pointer wording.** The design writes `<n> new message(s) from <name>`. Resolved: proper plural (`1 new message`, `3 new messages`) and, for several senders, a comma list of at most three names then ` and others` (5.1). Tests and the stand-in match `^gonogo: (\d+) new messages? from (.+)\. Call read_messages\.$`.
7. **One write.** The reference app types the paste and sends CR 140 ms later; the design and the verified facts (6 of 6 in steady state) use one write. Resolved: one write (`ESC[200~ text ESC[201~ CR`).
8. **Readiness test.** The design says "seen `ESC[?2004h` and the boxed prompt row". Resolved: the mirror's `modes.bracketedPasteMode` stands for "seen and still on" (it also handles combined parameter lists); the box test is the one of 6.4.
9. **Query replies.** `toolchain-docker.md` 1.6 says the headless terminal's replies to queries "need" forwarding; `claude-code-terminal.md` 3.2 verified claude does not wait for them, and the design says not to forward. Resolved: not forwarded.
10. **Token on every request.** The design says every HTTP request and WebSocket from the browser must carry the token. A navigation or a module script cannot carry a header. Resolved: static files are served without it (they hold no state, and Host/Origin checks apply); every `/api` call and the WebSocket need it;
    the URL carries it once in the fragment (3.2).
11. **Session flag.** The design: transcript check plus one flip on exit code 1 within 3 s. The terminal facts' skeptic suggests recording "first prompt delivered" instead. Resolved: the design. The check also searches every project directory, because `--resume` from another working directory keeps the transcript in the original one.
12. **Role edits.** The design says edits apply at the next restart; the facts show that is false for the role text unless `--system-prompt-snapshot off` is passed. Resolved: passed on every start, the first included (its effect on a first start is open item O17).
13. **Per-agent token file.** The design's disk layout lists `agents/<name>/memory.md, settings.json, mcp.json` and the browser `token`; its security paragraph speaks of "the token files on disk". Resolved: `agents/<name>/token` (0600) is written at each start for debugging; the server never reads it.
14. **Browser test.** The design's Testing section asks for a browser test of the built client; the fixed layout has no file or owner for it. Resolved: not built; open item O14. `test/e2e.test.ts` scenario 14 checks that the built files are served.
15. **Memory file prompts.** The role text tells the agent to read and edit a file outside its working directory, which prompts in `default` mode. Resolved: `permissions.allow` entries for exactly that file (rule syntax is open item O4; if wrong the cost is an extra prompt, not a safety problem).
16. **Redelivery.** A message handed over by pointer but never read (the agent ignored it, the model call failed, the user interrupted, claude ignored our Stop block) used to stay `delivered` for ever, and a boss waited on it indefinitely. The design says no blind retry and no loops. Resolved: **one** more pointer, and only when a turn
    ended without `read_messages` (Stop, StopFailure, R1, R2; `redeliver`, 5.5); after the second pointer the item stays `delivered` with the note `not read: <name> did not read it after two pointers`, shown in warning colour, and nothing more is typed. Bounded (`POINTER_MAX_ATTEMPTS`), so it cannot loop, and visible.
17. **Asynchronous delivery by hook.** The facts suggest an async-rewake Stop hook that would let claude wake itself without typing. Not adopted: it is unverified in the interactive TUI and the design chose typing plus the Stop block. `--setting-sources project,local` (clean agent without the owner's hooks) is not offered either.
18. **Seed mode default.** The design says seed mode is on by default in the Docker image and with `--seed-claude` elsewhere. Resolved: the flag and `GONOGO_SEED_CLAUDE=1`; the Dockerfile sets that variable.
19. **Role of `Notification`.** The design's table has no Notification row. Resolved: only `permission_prompt` (backup for PermissionRequest, 6 s late) and input-request types change state; `idle_prompt` never does (it is the normal idle state arriving 60 s after Stop).
20. **Resize ownership.** "The browser that most recently resized or typed wins" is implemented in `web.ts` (3.4); an `attach` that carries a size counts as a resize. **"Typed" means a keystroke** (an input chunk whose effect is `set` or `clear`): focus reports, mouse reports and device replies that a tab's xterm sends on its own never take the size, and the other windows are told every size change with a `size` frame.
21. **Script name.** The scaffold named the smoke script `smoke:real`; earlier drafts said `smoke`. Resolved: `npm run smoke:real`.
22. **React 19 types.** `JSX.Element` is no longer a global type; components return `ReactElement` (import it from `react`).
23. **Draft latch release by Escape.** The design: held "until the user presses Enter, Escape or Ctrl-C there, or 30 minutes pass". Its anti-goal: never type into a prompt the user has half typed. A single Esc leaves the text in claude's box (Esc Esc clears it), so releasing on Escape made the pointer land after the user's words and be submitted as one prompt.
    Resolved: Enter and Ctrl-C release at once; Escape alone does nothing; the screen ends the latch when the box has been empty for `DRAFT_SCREEN_CLEAR_MS` after the last input (Esc Esc, Backspace, Ctrl-U), which also ends phantom drafts (4.6). The 30-minute expiry stays as the design has it.
24. **Stop block in the interactive TUI.** Earlier drafts called Stop-hook delivery "verified". Every run behind it was `claude -p`; prior art says an interactive `block` may draw as a hook error. Resolved: the rule stays (the design chose it), the claim is narrowed, and O21 asks for the interactive check with two fallbacks (5.5).
25. **Browser token on the WebSocket.** The design: every WebSocket from the browser must carry the token. A query-string token lands in the access logs of the reverse proxy the README recommends, on every connect and reconnect, and the token never rotates. Resolved: it is carried, in the `Sec-WebSocket-Protocol` header (3.2); a `?token=` is refused.
26. **Agents reach the server on loopback.** The design's hook URL is `http://127.0.0.1:<port>/hook/...`; an earlier draft of 2.8 handed agents a specific bind address instead, which claude blocks for private ranges. Resolved: always loopback; a specific non-loopback bind host also listens on `127.0.0.1` (2.7, 2.8 step 8).
27. **Seed mode that cannot record trust fails the start.** The design: the server records trust before every start. An earlier draft logged a warning and carried on with `IS_DEMO=1`, which hides the trust dialog without trusting the folder (silent hooks, no dialog, no reason on screen). Resolved: reject with `cannot record folder trust in <path>: <reason>` (7.6).
28. **When the session flag flips.** The design: exit code 1 within 3 s of a start flips the flag once and retries. Many other things exit 1 that fast (a refused flag, `bypassPermissions` as root, an unreadable working directory, an authentication failure), and the retry then showed claude's session message instead of the real cause. Resolved: the flip also needs the message of the flag that was used
    in the exit tail (`SESSION_IN_USE_TEXT` after `--session-id`, `SESSION_MISSING_TEXT` after `--resume`); any other early exit 1 is reported with its own tail (4.9).

## 13. Open items (settle against real behaviour during the build)

Each has an owner who writes the answer in their report and fixes their code. Five were settled while this contract was written (probes in the lead architect's scratch folder; no real claude was started). "Real claude" means someone runs it with the user's permission (builders do not start real sessions; H's smoke script and the integrator do).

| # | Question | Owner | Fallback if the answer is bad |
|---|---|---|---|
| O1 | Does `@xterm/headless` 6.0.0 fire `onTitleChange` for OSC 0 in plain Node? | C | **SETTLED here** (macOS, Node 24): yes, with the whole title string (`✳ Claude Code`, `◐ Fake`). Keep a test. |
| O2 | Is `mirror.modes.bracketedPasteMode` readable right after the write callback in headless 6.0.0? | C | **SETTLED here**: yes (`true` after `ESC[?2004h`; `buffer.active.type` is `alternate` after `ESC[?1049h`). Keep a test. |
| O3 | Does claude run `apiKeyHelper` with the child's environment (so `printenv GONOGO_API_KEY` works)? | B, verified by H's smoke | write the key to `agents/<name>/apikey` (0600) and use `cat <path>` as the helper |
| O4 | Is `Read(//abs/path)` / `Edit(//abs/path)` the right rule syntax for one absolute file in `permissions.allow` of a `--settings` file? | B, verified by H | add the agent directory with `--add-dir`, or accept prompts |
| O5 | Does a `--settings` file honour `permissions.deny` for `SendMessage`/`ListAgents` and `crossSessionInbound: "refuse"`? | B, verified by H (does `claude doctor` flag them?) | pass them in a second inline `--settings` JSON string, or accept native messaging next to gonogo's |
| O6 | Does `claude doctor` accept the generated `settings.json` unchanged? | H (smoke step 0), fix by B | follow doctor's message |
| O7 | Where is `spawn-helper` inside `@lydell/node-pty-darwin-*`, and does the guard find it? | C | **SETTLED here**: `node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper` (mode 755 in this install). Linux packages have no helper. Keep the test on a 0644 copy. |
| O8 | Does `process.kill(-pid, sig)` reach the pty child's group? | C | **SETTLED on macOS**: the child's pgid equals its pid, a grandchild shares it, `kill(-pid, 'SIGTERM')` ended both, and node-pty reported `{"exitCode":0,"signal":15}` (hence `code = null` when `signal > 0`). Linux is not verified: keep the grandchild test. |
| O9 | Does claude draw title glyphs other than `◐ ◑ ✳` (for example `◓ ◒`)? | C, H | add them to `TITLE_WORKING_GLYPHS` |
| O10 | Exact wording and keys of the trust dialog, bypass warning, API-key dialog and "Resume this conversation?" | C (patterns are from verified screens; trust and resume wording is only partly verified) | extend `DIALOG_PATTERNS`; the generic `menu` pattern already catches numbered or Yes/No rows |
| O11 | Can claude's own rewrite of `.claude.json` drop a trust key written by `seedTrust` when several agents start together? | B | the write is verified on disk before `IS_DEMO` is set (7.6) and a run-time note says when no hook arrives (5.4); also re-check once after 2 s and record the finding |
| O12 | After the user **allows** a permission prompt, does PostToolUse (or PostToolUseFailure) follow when the tool ends, and what does the title do meanwhile (`◐` is assumed)? The classic renderer's dialog text? | A, H | none needed for the state: R4 (4.7) leaves `needs_you` from the screen and the title alone; R2 covers denied/Esc. If the title stays `✳` after an allow, R4 never fires: then use `PostToolUse` only and say so |
| O13 | One `McpServer` + transport per request under concurrent calls | E | serialise the three handlers with a mutex |
| O14 | Browser test of the built client (no owner in the fixed layout) | integrator | manual check with the Chrome tools |
| O15 | Does the model act on `Stop hook feedback:\n<pointer>` every time (verified only for simple instructions, in `-p`)? | H (smoke step 4) | none needed; a miss shows as `delivered` and is pointed at once more (5.5), then marked `not read:` |
| O16 | Linux: `@lydell/node-pty` loads in `node:24-bookworm-slim`, claude 2.1.325 runs as `node`, bind-mount permissions (documented with a named volume and a `chown 1000:1000` variant), `--init` | H (Docker build) | README says what was not run |
| O17 | Does `--system-prompt-snapshot off` work on a **first** start (verified only on a resume)? | B, verified by H | pass it only on `--resume` starts |
| O18 | Does the prompt box still match when claude's status line or plugins add rows (user settings)? | C | relax: allow a rule row up to 3 rows above |
| O19 | Does vite resolve `./Floor.js` to `Floor.tsx` and `./api.js` to `api.ts` with the scaffold's config? | F, G (first `npm run build`) | **SETTLED here** (a probe copy of the scaffold configs): `vite build` (Vite 8.3.8), vitest 5.1.0 and `tsc` 7.0.2 with `moduleResolution: bundler` resolve `./App.js` to `App.tsx`, `./Floor.js` to `Floor.tsx` and `./api.js` to `api.ts`. The `.js` rule of 11 stands; `docs/scaffold-notes.md` was corrected to say so. |
| O20 | xterm.js `onBinary` mouse reports (X10) after a snapshot: does restoring `?1006h` always avoid them? | F | none; they are ignored by claude as noise |
| O21 | Does the interactive TUI continue the turn after a Stop `{"decision":"block"}` reply, and how does it draw it (docs: a `block` can show as a hook error)? Everything verified about Stop blocks ran in `claude -p`. | H (smoke step 4) | reply with `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"<pointer>"}}` (continued the turn in `-p`, shown as hook feedback, same cap; facts hooks-mcp 4.3), or hand over nothing at Stop and let the typed path deliver after the turn |
| O22 | Does `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` in the child environment keep Bash, `apiKeyHelper` and the hooks working in the unprivileged container (Linux also isolates Bash in a PID namespace, which an unprivileged container may refuse)? Seed mode trusts every hired folder while the child holds the credential (7.6). | H (Docker smoke) | if it works, make it the seed-mode default; else keep the README sentence about trusted folders |
| O23 | Esc in claude's box: does a single Esc leave typed text and does Esc Esc clear it (docs say so; not observed)? 4.6 relies on it. | C, H | none needed: the screen proof of 4.6 handles either answer; only the latency of ending a latch changes |
| O24 | Does claude honour `NO_PROXY=127.0.0.1,localhost` for http hooks and for the MCP server when `HTTP_PROXY`/`HTTPS_PROXY` are set (docs and binary strings only)? | H (smoke step 6) | document that agents behind a proxy need `NO_PROXY` set by the operator, or give up proxies in the agents' environment |
| O25 | The image's `tini` (Debian package `tini` in bookworm) with `-s` as the entrypoint next to Docker's own `--init`: reaping works, signals reach gonogo, `docker stop` ends the agents within the grace period | H (Docker build) | fall back to `ENTRYPOINT ["gonogo"]` and tell the README reader to use `--init` |

## 14. Requests to the scaffold

**Applied by the lead on 2026-11-16 (items 1 to 7; item 8 is a rule).** The scaffold files exist; this contract needed these changes (nobody else edits them):

1. `vitest.config.ts`: `test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000, pool: 'forks' }` (the e2e and pty tests spawn processes; forks isolate them).
2. Type-check the tests: add `tsconfig.test.json` (`extends ./tsconfig.server.json`, `compilerOptions: { "noEmit": true, "rootDir": ".", "allowJs": true, "checkJs": false, "types": ["node"] }`, `include: ["test", "src/server", "src/shared"]`) and extend the `typecheck` script with `&& tsc -p tsconfig.test.json --noEmit`.
   This config has **no `jsx`**, so a client test file may import only client modules that import no `.tsx` file (10.6; `TS6142` otherwise).
   `tsconfig.json` (client) keeps `src/client` and `src/shared` only; `src/shared/protocol.ts` already compiles under it (no Node types).
3. `tsconfig.server.json`: add `"noEmitOnError": true`. Keep `include` as is.
4. `index.html`: add `<meta name="color-scheme" content="dark" />` and `<meta name="theme-color" content="#14161c" />`.
5. `vite.config.ts`: add a dev proxy so the client can run against a real server during development: `server: { proxy: { '/api': 'http://127.0.0.1:7777', '/ws': { target: 'ws://127.0.0.1:7777', ws: true } } }`. Optional, harmless.
6. `.gitignore`: also `*.log` and `test/fixtures/tmp`. `.dockerignore` is H's.
7. `package.json`: the `prepack` script becomes `node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})" && npm run build` (`tsc` never deletes stale files, `files` ships all of `dist`: checked on Node 24, `require` works in `node -e` of a `"type": "module"` package), and a new script `"check:pack": "node scripts/check-pack.mjs"` (10.8). Nothing else. The `files` list (`bin`, `dist`) is right; npm always packs `README.md` and `package.json`.
8. If `npm run build` fails because `src/shared/protocol.ts` or `src/server/constants.ts` does not compile in a config, report it to the contract author; do not edit those two files.

## 15. Revision log

Review round 1: three critics (server logic, interfaces, security and packaging) sent 57 issues. The editor checked each against this contract, the design and the fact files, reproduced the Node, `ws`, node-pty and TypeScript claims in a scratch folder (`new URL('//', base)` throws, `timingSafeEqual` throws on equal-length non-ASCII strings, the global `crypto.randomUUID` throws when detached,
`pty.resize()` throws `EBADF` after the child exited, an oversized `ws` frame without an `error` listener ends the process, `TS6142` without `jsx`, `./X.js` resolves to `X.tsx` in Vite, vitest and tsc, the worst pointer is 164 characters), and changed `docs/contract.md`, `src/shared/protocol.ts`, `src/server/constants.ts` and `docs/scaffold-notes.md`.
Both source files typecheck after the changes. Where two issues conflicted the editor chose by the design and the facts: that choice is named in the line. **Applied** means the text or the source changed; **modified** means the fix differs from the critic's proposal and the line says how; **not adopted** names a part that was left out and why.

Changes to the two source files: `protocol.ts` (eight `HOOK_EVENTS`, `unavailable` error code, `InputEffect`, `WS_SUBPROTOCOL` and `WS_TOKEN_PROTOCOL_PREFIX` instead of `WS_TOKEN_PARAM`, `WS_INPUT_CHUNK_CHARS`, `Envelope`, `SizeFrame`, `LauncherOptions`, `TerminalHostOptions`, `TerminalHost.rename`, `Home.close`, the `Hub` signatures with generation, `onUserInput` returning the effect, comments);
`constants.ts` (`SESSION_IN_USE_TEXT`, `SESSION_MISSING_TEXT`, `DRAFT_SCREEN_CLEAR_MS`, `POINTER_MAX_ATTEMPTS`, `TRANSIENT_ERROR_CODES`, `TRANSIENT_ERROR_PREFIXES`, `MESSAGES_ROTATED_FILE`, `MESSAGES_ROTATE_BYTES`, `MESSAGES_TAIL_BYTES`, `LOCK_FILE`, `TRUST_VERIFY_ATTEMPTS`, `TRUST_VERIFY_DELAY_MS`, comments). New open items: O21 to O25; O12, O15, O16 and O19 changed.

**Server logic**

- R1 (major) applied: needs_you had no way out after an allowed tool. R4 added (4.7, 4.5), `PostToolUseFailure` registered as a working heartbeat (eight events: protocol.ts, 4.4, 7.3, conflict 3), a late `permission_prompt` Notification needs a dialog on screen (4.4), O12 rewritten, e2e 10 asserts `working` while the fake's approved tool runs (9.5 `@fake permission <tool> [<ms>]`).
- R2 (major) applied: agents are only ever given loopback URLs; a specific non-loopback bind host also listens on 127.0.0.1 (2.7, 2.8 steps 1 and 8, 0.3 item 13, 7.3); tests 10.2 and 10.4. Chosen over refusing to start: the private-network setup stays usable.
- R3 (major) applied, modified: trust is written and verified on disk before `IS_DEMO=1` is set, and a start that cannot record it is rejected (7.6, 7.1, conflict 27); silent hooks in the residual O11 case are shown as `held: no hook has reached gonogo from <name>; is its folder trusted?` (5.4, 5.8) instead of a `needs_you` of kind `dialog` (R2 would clear that state again one second later, and a first `!ls` would raise it falsely).
- R4 (major) applied: `read_messages` ends the confirmation, the 2 s timer sets the latch only for ids still queued (5.4, 5.6, 4.10 rule 13, 4.1); e2e 8 rewritten (`FAKE_CLAUDE_IGNORE_CR` for the unconfirmed case, `FAKE_CLAUDE_NO_HOOKS` for the lost-hooks case). No latch expiry was added: the hold is visible while it exists and ends by Enter, Ctrl-C, another prompt, a read or an exit.
- R5 (major) applied: `SizeFrame` to every attached socket, ownership only by `resize`, an attach with a size, or a keystroke (`onUserInput` now returns the effect), `resize` needs the attached agent (3.4, 8.4, 6.6, protocol.ts, conflict 20).
- R6 (major) applied, modified: `redeliver` (5.5): one more pointer when a turn ends without `read_messages` (Stop, StopFailure, R1, R2), then `not read:` note and chip (5.8, 8.5, conflict 16). Not adopted: a pinned strip line `<name> has N unread messages` (it would need a new `AgentView` field; the item chip says it where the message is).
- R7 (minor) applied, modified: confirmation uses `endsWith` (5.4); the unconfirmed latch ends by Enter or Ctrl-C only; a lone Escape no longer releases the draft latch, the screen does when the box is empty for a second (4.6, conflict 23, O23): this resolves the design's own contradiction between its Escape release and its anti-goal. The 30-minute expiry still types after whatever the box holds, as the design says.
- R8 (minor) applied: rename emits `agent-removed` (old) then the new frame, `rt` and its chain move to the new key, `TerminalHost.rename` runs through the `renameAgentFiles` glue (4.9, 2.1 rule 8, 6.6, 2.8 step 4, protocol.ts).
- R9 (minor) applied: R1 and R3 count from `max(info.since, stateSince)`, R1 does nothing with a null probe, R2 clears the trigger and `stopBlocks`, 5.7 lists R2 (4.7, 5.7).
- R10 (minor) applied: shutdown converts nothing (the exit handler skips rule 3 while `closing`) and `start()` converts; `Home.close()` flushes the chains before exit (4.9, 2.4 item 10, 2.8 step 11).
- R11 (minor) applied in part: screen proof clears phantom drafts, `set` is ignored in `needs_you`, a foreign UserPromptSubmit leaves the draft latch alone (4.4, 4.6). Not adopted: ignoring `set` while the probe is null (the screen proof ends such a phantom within about two seconds, while ignoring would let a half-typed prompt be overwritten).
- R12 (minor) applied: note `waiting: about to type the pointer` for an idle recipient, latches before state wait notes (5.3 step 2), Stop sets the state once (5.5 step 1), held items go back to `queued` at once when a latch ends (4.6), 5.8.
- R13 (minor) applied: `sendFromAgent(from, generation, req)`, `readMessages(agent, generation)`, `rosterFor(agent, generation)` refuse a stale generation or a running transition (protocol.ts, 3.6, 4.10 rule 7, 5.2 step 3, 5.6).
- R14 (minor) applied: `WebOptions.isReady`; `/api` and `/ws` answer 503 `starting` until `hub.start()` resolved; error code `unavailable` (2.7, 2.8 step 9, 3.2 rule 4, 3.3, 8.4). Chosen over splitting `hub.start()`: the hook and MCP endpoints must already listen when the boss starts.
- R15 (minor) applied: `<home>/server.lock` taken by `openHome`, stale detection by pid, released by `Home.close()` (2.4 item 2).
- R16 (major) applied: e2e 8 and 12 rewritten with `FAKE_CLAUDE_IGNORE_CR` and `FAKE_CLAUDE_SESSION_DIR` (9.2, 9.4, 9.8, 10.5). The `FAKE_CLAUDE_FAIL_FIRST_START` variant was not adopted: R23's session-directory variant keeps the launcher/fake disagreement realistic and makes the tail check of R46 reachable.
- R17 (minor) applied: tokens from `<home>/agents/<name>/token`, `pid`, `resize` and `paste` events in 9.9, scenario 11 with `FAKE_CLAUDE_SHELL_MS=3000` (10.5, 9.4, 9.9).
- R18 (minor) applied: "verified" narrowed to `claude -p`; open item O21 with both fallbacks (5.5, conflict 24, 13).

**Interfaces**

- R19 (blocker) applied: the `starting` frame is emitted after `io.spawn` resolves; the client re-attaches on a generation or `running` mismatch (4.9, 3.4 rule 4, 8.4, 6.2, `HubIo.spawn` comment); e2e 9 has the attach race.
- R20 (major) applied: same fix as R8, with the client rule in 8.2 and e2e 15.
- R21 (major) applied: `Envelope` moved into protocol.ts; client test files may not reach a `.tsx` file (8.2, 8.3, 10.6, 14.2).
- R22 (major) applied: same fixes as R4 and R16 (scenario 8 rewritten; switches are global to a server, so such scenarios start their own server and use the boss).
- R23 (major) applied: scenario 12 uses `FAKE_CLAUDE_SESSION_DIR` so the launcher passes `--session-id` while the fake refuses it (9.2, 10.5).
- R24 (minor) applied: token from the file, `pid` in the `start` event, expected argv recomputed from 7.2 with `buildRoleText` (10.5 scenarios 1, 3, 9, 13; 9.9).
- R25 (minor) applied: protocol.ts comments of `sendFromUser` and `sendFromAgent` say `not_found` (field `to`) for an unknown recipient.
- R26 (minor) applied: `randomUUID` imported from `node:crypto`, the io wiring uses arrows, factories return plain closures (2.8 step 4, 0.3 item 12).
- R27 (minor) applied: a bind host of `localhost` is bound as `127.0.0.1`; agents get loopback URLs only (2.8 steps 1 and 8, 2.7).
- R28 (minor) applied: the roster is validated before anything listens and steps 3 to 10 run in a `try` that closes the server, stops the terminals and releases the lock (2.8 step 2); edge test.
- R29 (minor) applied: `submit` sanitises and writes (6.7 kept); test 10.3 changed to match.
- R30 (minor) applied: `ensureSpawnHelperExecutable(log?, roots?)`, section reference 6.10 (2.3, 6.10).
- R31 (minor) applied: a `title` event may precede `ready` (6.11); the pointer is "at most about 170 characters" (5.1).
- R32 (minor) applied: `resize` for an unattached agent is an error (3.4); `userMailSeenAt` is server time (8.2); unknown agent results (5.6, protocol.ts); the MCP argument mapping (3.6).
- R33 (minor) applied: scenarios 15 to 18 (edit, rename, remove, detach, session follow, unread pointer, StopFailure, roster) and the directives `@fake notify`, `@fake dialog`, `@fake newsession` and the switch `FAKE_CLAUDE_IGNORE_POINTER` (9.5, 9.8, 10.5).
- R34 (minor) applied: builder D reads 6.3 to 6.5 and 7.2 to 7.4; builder H reads 3.2 and has `check-pack.mjs` (0.1, 1).
- R35 (minor) applied: `LauncherOptions` and `TerminalHostOptions` live in protocol.ts; the sentence about "every cross-module call" says what protocol.ts cannot check (0.1, 2.2, 2.3).
- R36 (minor) applied: `TerminalPane.tsx` imports `@xterm/xterm/css/xterm.css` (8.4).
- R37 (minor) applied: O19 closed (works); the `.js` rule stays; `docs/scaffold-notes.md` edited.

**Security and packaging**

- R38 (blocker) applied: the hostile-input rules (3.2): no `new URL(req.url)`, `Origin: null` is 403, `decodeURIComponent` in a `try`, static files by `stat` and `pipeline`, digest comparison; tests listed in 10.4.
- R39 (major) applied: upgrade socket `error` listener, `ws.on('error')`, `wss` and `server` error handlers, input split into `WS_INPUT_CHUNK_CHARS` pieces (3.4, 8.4, protocol.ts, 10.4).
- R40 (major) applied: `exited` flag as the first line of `onExit`, `pty.write` and `pty.resize` in `try`, `pty.resize` before `mirror.resize`, no method throws after spawn (6.6, 6.7, 6.9, 6.11, protocol.ts, 10.3).
- R41 (major) applied: after start, transient error codes are logged and ignored, other errors shut down; `stdout` and `stderr` error handlers; `.catch` on the two floating promises of 3.6 (2.8, 3.6, 11, constants.ts).
- R42 (major) applied: same fix as R3 (trust verified before `IS_DEMO`, reject on failure). Not adopted: the "no hook within 10 s after ready" diagnostic, which would flag every idle agent that nobody has prompted yet.
- R43 (major) applied: the browser token travels in `Sec-WebSocket-Protocol`; `?token=` is refused (3.2, 3.4, 8.4, protocol.ts, 10.4, 10.5, conflict 25). Not adopted: the one-time ticket route (more state and one more request per reconnect for no gain over a header).
- R44 (major) applied: `scripts/check-pack.mjs` and `npm run check:pack` (10.8, 1, 2.9, 11, 14.7), with the `npx --yes file:<abs tgz>` form in the README outline.
- R45 (minor) applied in part: once `shutdown()` began the hub rejects lifecycle calls with 409 (2.1 rule 7, 2.8 step 11, 3.3). Not adopted: a final SIGKILL sweep after `SHUTDOWN_MAX_MS`: 6.8 already kills at 5 s and gives up at 8 s, and nothing can start a process after the hub refused it.
- R46 (minor) applied: the flag flip needs the flag's own message in the exit tail (4.9, 7.5, `SESSION_IN_USE_TEXT`, `SESSION_MISSING_TEXT`).
- R47 (minor) applied: `/projects` is a named volume in the documented command, the bind-mount variant needs `chown 1000:1000`, and start warns when the home or the boss directory is not writable (2.9, 2.8 step 2).
- R48 (minor) applied: `tini` in the image, `ENTRYPOINT ["tini", "-s", "--", "gonogo"]`, open item O25 (2.9).
- R49 (minor) applied: same fix as R15.
- R50 (minor) applied in part: status changes append a four-field line, history and the id counter read the last 1 MiB, rotation at open (2.4 items 6 to 8, constants.ts). Not adopted: a per-sender message rate cap (the hop cap already bounds agent loops; a rate limit is a new feature).
- R51 (minor) applied: one-pass function replacer in `buildRoleText` and a test with `$&`, `$$`, `$'` and `{memory}` (7.2, 10.2).
- R52 (minor) applied: one sentence in the hire form and the README about trusted folders in seed mode; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is open item O22, not adopted before it is run (7.6, 8.6, 2.9).
- R53 (minor) applied: README proxy recipe with `Host $http_host`, upgrade headers, a long timeout and `--allow-host`, and an edge test (2.9, 3.2 rule 2, 10.4).
- R54 (minor) applied: `prepack` removes `dist` first; `check:pack` asserts the file list (11, 14.7, 10.8).
- R55 (minor) applied: `bin/gonogo.js` prints one `gonogo: <message>` line when the import fails; the README names glibc 2.28, no Alpine and no `--omit=optional` (2.8, 2.9).
- R56 (minor) applied: `openHome` always sets 0700 on the home and 0600 on the token (2.4 items 1 and 3, 10.4).
- R57 (minor) applied in part: the bind-host half is R2; `NO_PROXY` is marked unverified, with smoke step 6 and open item O24 (7.8, 10.8, 13). Not adopted: refusing a private bind host (R2's second listener keeps it usable).

**Integration pass (2026-11-16, after builders A to H)**

The integrator ran `rm -rf dist; npm run build; npm run typecheck; npm test; npm run check:pack` (all green), started the built server by hand with the stand-in, and drove the built client in Chrome 157 against it (open item O14: hire form, typing into a terminal, briefing the boss, stop, a click on an empty desk, an 800 px window, signing in with the printed URL). What changed:

- `protocol.ts`: the comment of `AgentView.draft` now says what 4.6 and conflict 23 say (Enter and Ctrl-C end the latch, a lone Escape does not, the screen does when the box has been empty for a second). Comment only.
- Client: `api.ts` reloads the page when the fragment changes to one that holds `#token=...` (pasting the printed URL into a tab that already shows "Not signed in" is a same-document navigation, so the token was never read); `index.html` declares an empty icon (the browser's `/favicon.ico` request was a 404 in the console).
- Where the shipped code differs from the text above, the code is right and these are corrections of the text: 3.6 item 3 and 10.4 (an exception inside a tool callback becomes an `isError` result `{"ok":false,"error":"internal error"}` with HTTP 200, because the SDK has sent the stream headers by then; 500 is for a failure before the transport answers); 3.5 (the agent token is checked before the 404 for an unknown event, the order of 3.2); 6.2 step 4 and 10.3 (node-pty does not throw for a missing command on macOS, so `spawn()` pre-checks it and throws `could not start <file>: command not found or not executable`); 10.3 (the fixtures are `real-fs.stream.jsonl` and `real-classic.stream.jsonl`); 4.9 and 2.1 (a restart clears `transition` when its spawn starts, the one frame still goes out after `io.spawn` resolves; shutdown queues the stop on each agent's own lifecycle chain; "identical in kind" compares with the last queued or running operation only); 2.2 (`revoke` uses `unlinkSync`); 8.3 (the avatar shifts are unsigned `>>>`, the bun sits inside the 12 x 14 grid, the chair radius is 22, `app.init` also sets `autoDensity`, `autoStart: false`, `accessibilityOptions` and `eventFeatures`); 9.3, 9.5 and 9.8 (the stand-in follows lead rulings 12 and 13 of 0.5); 10.8 (`smoke-real.mjs` prints PASS or FAIL lines and its proxy check uses a recording proxy).

### Verification round (lead, 2026-11-16)

Four verifiers (network edge, processes/files/packaging, product against design, browser UX) reviewed the merged tree and the lead ran the real-claude smoke (`npm run smoke:real -- --spend`, claude 2.1.325, model haiku). 29 findings: 1 critical, 2 medium, 17 low, 9 info.

- **EDGE-1 (critical, reproduced)**: an unauthenticated client that aborts a static request leaked one file descriptor; enough of them ended the process with `EMFILE`, which killed every agent. Fixed in `web.ts` (the server now owns the descriptor); regression test in `test/edge.test.ts`; the lead re-measured with `fdcheck` (3000 aborted requests per mode: leak 0, server alive).
- **Medium**: SECPROC-1 (unbounded mail from one agent token: mailbox caps, per-sender rate limit, run-time log rotation) and PROD-1 (no LICENSE, no third-party notices): both fixed.
- **Low and info**: fixed except SECPROC-4 (the browser token in the container log: documented in the README, behaviour unchanged), SECPROC-11 (a process that ignores SIGTERM can outlive Stop: accepted), UX-5 (no scroll hint on a long tab strip) and the "avatars are small" opinion. SECPROC-6 ships `npm-shrinkwrap.json` but does not pin the Docker base image by digest (no daemon here to resolve one); SECPROC-8 refuses broad folders in seed mode but does not remove trust entries when an agent is removed; PROD-2 lacks repository, homepage, bugs and author (the owner's URL is needed).

Lead changes to scaffolding after the smoke: `scripts/smoke-real.mjs` ignores the doctor line "workspace has not been trusted" (the probe folder is untrusted by construction) and has a new step 4c (a permission prompt raises `needs_you`, Enter allows it once, the turn finishes); `--help` lists `GONOGO_SCRUB_ENV`.

**Open items settled by the real-claude smoke (claude 2.1.325, macOS arm64, host mode, seed mode off):** O6 yes (`claude doctor` accepts the generated settings.json); O15 and O21 yes (a message sent while the agent was working was handed over by the Stop block, the interactive TUI continued the turn and the model read its mail); O12 yes (a Bash permission prompt raised `needs_you` of kind `permission`, allowing it with Enter left `needs_you` and the turn finished); O24 yes (with `HTTP_PROXY` set, 0 requests for gonogo's port reached the proxy while 28 others did, so claude honours the proxy for its own traffic and `NO_PROXY` keeps gonogo off it); O17 partly (the first-start argv with `--system-prompt-snapshot off` was accepted; whether the role text applied was not checked). **Still open:** O3 (apiKeyHelper environment, seed mode only), O4 (no prompt about the memory file appeared, but the model may not have read it), O5 (doctor does not flag `permissions.deny` or `crossSessionInbound`; that does not prove they take effect), O9, O10, O11, O16, O22, O23, O25 (Docker, Linux, other dialogs).

**Fix round, Edge (web.ts, home.ts, bin shim) (contract notes of the fixer):**

- 3.2 hostile-input rule 4 and 3.7: static files are no longer sent with `stream.pipeline(createReadStream(path), res, callback)`. sendFile (async, awaited by serveStatic) opens a FileHandle (`fs/promises.open`), pipes `handle.createReadStream()` into `res` with `stream/promises.pipeline`, destroys `res` on error (debug log 'static file stream failed', as before) and closes the handle in `finally`. HEAD never opens the file; a destroyed `res` is not opened; an `open` failure after a successful stat (file gone) is a 500 through the request catch. An aborted request no longer logs an error-level 'request failed'.
- 2.4 item 1: a chmod that fails is no longer only a warning. openHome throws a one-line error (before the lock) when the home or agents/ is not a directory, is not owned by process.getuid(), or still has group/other bits after chmod 0700 (failure or silent no-op, e.g. exFAT volumes, some bind mounts). The home is checked before anything is created inside it. The warning 'could not set mode 0700' is gone.
- 2.4 item 3: an existing token file gets the same check (regular file, owned by the current uid, no group/other bits after chmod 0600) before it is read; on failure openHome throws and releases the lock.
- 2.4 item 8: rotation is no longer 'at open only': the same check (size > MESSAGES_ROTATE_BYTES, rename to messages.jsonl.1 replacing an older one) also runs before every append, inside the message write chain; a failed rename warns and the append goes on.
- 2.8 / bin shim (contract line 430 and README.md:14): the shim collapses every whitespace run of the printed message to one space, so the 'one line' promise holds for the pty loader's multi-paragraph message.

**Fix round, Hub, terminal host, MCP, shared types (contract notes of the fixer):**

- 5.2 step 6 and 5.8: two new undelivered rows. 'mailbox full: <name> has too many unread messages' (recipient already holds MAILBOX_MAX_MESSAGES=100 unread messages or MAILBOX_MAX_BODY_CHARS=256 KiB of unread bodies; queued, held and delivered count; checked after the stopped/removing rows, before queueing; applies to every sender including the owner) and 'rate limit: <sender> sent too many messages this minute' (agent senders only, SEND_RATE_MAX=120 per rolling SEND_RATE_WINDOW_MS=60 s, checked before the recipient is looked at so it also covers to:user and stopped recipients; a refused message does not use a slot; the owner is never limited). Both notes follow the strings in the task and do NOT end with '; the message went to the user', which 5.8 says every undelivered reason does: decide whether to append it.
- 5.2 / 5.8: a rate-limit refusal is stored, logged, emitted and shown in the strip once per flood (the first one); later refusals of that sender are answered ok:false with the same note and a fresh id but are not recorded, until the sender gets a slot again. Without this the refusals were the flood (60 MB of log for 3,000 requests).
- 5.6 steps 1, 2, 3, 4, 5 and 4.10 rule 3 ('read_messages returns all unread messages'): one result holds at most READ_MAX_MESSAGES=20 messages or READ_MAX_CHARS=40,000 characters of their JSON, whichever comes first; the first message always goes. Only the returned ones become read. The others stay unread: delivered ones go back to queued (note = wait note of the recipient's state), queue is rebuilt from them, a draft latch re-holds them, their pointed counters are kept, so the Stop hook and the delivery check point at them again. The pointer in flight and the unconfirmed latch are still ended by any non-failing read. The trigger (5.7) covers only the returned messages. The result object gets `remaining` and `note` only when messages are left; an empty or complete read keeps the exact old shape. 3.6 table row for read_messages and ReadMessagesResult in protocol.ts say so.
- 3.6: the read_messages result may carry `remaining` (number) and `note` ('More messages are waiting: call read_messages again to read them.'). The tool description in MCP_DESCRIPTIONS and the role preamble were left unchanged.
- 2.1 / 4.9 remove, 2.3 / 6.6, 2.8 step 4: HubIo.forget?(name) and TerminalHost.forget?(name) (optional). remove() calls io.forget after the process has stopped and agent-removed was emitted; the host drops the finished record (mirror disposed, attachments cut loose), no-op while a process runs or for an unknown name; the cli.ts glue is one line.
- 6.1: the mirror is created with logLevel: 'off' (xterm no longer prints parser errors to stderr).
- 4.1: the hub keeps two more per-agent fields, sentAt (at most 120 timestamps) and limitNoted; unread message ids stay in the hub's activity order list until they are terminal (hub memory rule next to 2.1 rule 6; activity() output is unchanged).
- 15 R50 says a per-sender message rate cap was 'not adopted'; it is adopted now. constants.ts gained MAILBOX_MAX_MESSAGES, MAILBOX_MAX_BODY_CHARS, SEND_RATE_MAX, SEND_RATE_WINDOW_MS, READ_MAX_MESSAGES, READ_MAX_CHARS and lost WS_CLOSE_TOO_BIG and BRACKETED_PASTE_ENABLE; protocol.ts lost McpToolName and SPECIAL_RECIPIENTS (PROD-8).

**Fix round, Launcher, packaging, docs, fixtures (contract notes of the fixer):**

- 7 buildChildEnv (contract 7.x step 2, scrub lists): the child environment also loses the names and prefixes in GONOGO_SCRUB_ENV (comma separated; entry ending in _ = prefix, else exact), read from the launcher's own env before gonogo sets TERM, COLORTERM, GONOGO_TOKEN, NO_PROXY, IS_DEMO. The list in constants.ts is unchanged.
- 7.6 prepareStart in seed mode (contract lines 111, 1240, 1789): before any write it also rejects with Error('cannot record folder trust for <dir>: it is|holds <the root of the file system | your home directory | gonogo's home directory | Claude Code's configuration folder> ... use a project folder instead'). Covers '/', the OS home, and any folder that is or holds the OS home, the gonogo home, or CLAUDE_CONFIG_DIR (default ~/.claude); realpaths checked too. A boss whose directory is the home directory never starts in seed mode.
- 7.x renameAgentFiles (contract line 1277): the rejection text changed from Error('agents/<new> already exists') to 'the name "<new>" is taken by a notes folder left over from a removed agent; choose another name, or delete that folder from the agents folder of the gonogo home' (the hub passes it to the UI as conflict on field name).
- Packaging (contract 10.8 step 1 and the Docker build stage, line 437): package-lock.json is replaced by npm-shrinkwrap.json (made by npm shrinkwrap); package.json `files` now lists it because npm does not pack it automatically when `files` is set; the Dockerfile build stage copies `package.json npm-shrinkwrap.json`. package.json gained keywords and os [darwin, linux].
- 10.8 check-pack file list: package/LICENSE, package/npm-shrinkwrap.json and package/dist/client/THIRD-PARTY-NOTICES.md are now required (the last one comes from vite build.license.fileName in vite.config.ts, no script); package/npm-shrinkwrap.json is accepted.
- Docker (contract line 438): `git config --system --add safe.directory '*'` replaced by entries '/projects' and '/projects/*' ('/projects/*' needs a newer git than bookworm's 2.39; documented). HEALTHCHECK added: node fetch of http://127.0.0.1:7777/, healthy on 200. Dockerfile header and README now say the ready line in docker logs holds the browser token and give the docker exec way to read/rotate it; README and Dockerfile say the node base image is a floating tag and how to pin it.
- 0.5 item 11 (fixtures): done. Besides the owner strings, the plan name, the plugin-sync UUID fragments AND the two session ids of the 'Resume this session' lines are now x filler in test/fixtures/*.jsonl (same length); docs/facts use <home>, <volume>, <scratch>, <plan>, <uuid>. The 'weak' strings ~/.claude-work and the home-relative project path <project> were left.
- README.md: npx gonogo is stated as not valid until a deliberate publish; limits (24 agents, role 4000, body 20000, absolute path), 'not read:' status, boss directory, leftover agents/<name>/ and persistent seed-mode trust entries are documented; docs/scaffold-notes.md was brought up to date; new test file test/repo-files.test.ts (30 tests) guards licence, lock, pack list, Dockerfile lines and the privacy classes.

**Fix round, Browser client (contract notes of the fixer):**

- 8.7 Brief: the confirmation is no longer 'Sent. <note>' with the raw server note; it is 'Sent. <plain sentence>' (map of the 5.8 wait/held notes in src/client/wording.ts, generic sentence for an unknown note, plain 'Sent.' for a null note). Undelivered still shows the note in --danger.
- 8.4 What it shows, stopped row: the card shows exit.text only when it says more than 'stopped' (a stop the owner asked for gives 'stopped'), so '<name> is stopped' is not followed by a second 'stopped'.
- 8.4/8.8 keyboard way out: the 'Alt+Shift+T returns to the tabs' hint is visible whenever an agent is selected (also needs_you, starting, size hint, connecting/reconnecting), after the path or after a notice; below 480 px it is hidden while a notice is shown.
- 8.1/8.2 page: until the first state frame has arrived (info === null) the page shows only the top bar and 'Loading the office...' (or the server-gone text after RECONNECT_SERVER_GONE_AFTER failed attempts): no floor, tabs, Hire control or form. From the first state on everything stays live whatever the connection state, reconnecting included. New selector isLoading in store.ts.
- 8.3 Floor / 8.1 narrow layout: below 480 px viewport width the canvas is not drawn and no Pixi app runs; the agent list stays and the mailbox is a plain 'Mailbox' button (same .dh-failed styles as the WebGL-failed case). The picture returns when the window is 480 px or wider.
- 8.8 focus: the focus frame around a focused terminal is the accent at 60 % (still 2 px, about 3.5:1 on the terminal background, full accent where color-mix is missing) instead of full-strength accent.
- 8.3 accessible list / 8.7 agent bar: the name in the list and in the bar carries a title (tooltip) with the full name, since both cut long names with an ellipsis.

### Mission-control round (lead, 2026-11-16)

Theme, roster, T-minus, Max Q, custom provider and an SVG floor. The spec is `docs/next-spec.md`. Where the text above says otherwise, this list wins. Names in the sections above that still say office, desk, mailbox or boss describe the same things under the old words (operations room, console, Gallery, FLIGHT).

**Shared types** (`protocol.ts`, `constants.ts`, new `positions.ts`)

- `src/shared/positions.ts` holds the 15 control-room positions (id, call sign, title, one-line summary, accent colour, default role text). The boss is the position `flight`, default name `flight`.
- `AgentView` and the `list_roster` entries carry `position`; `AgentView` also carries `provider` (`claude` or `custom`) and `command` (custom only). `dirty` also compares `command` (4.4, 4.9).
- The roster file (`agents.json`) keeps `position`, `provider` (only `custom` is stored) and `command`; `home.ts` validates them strictly on load, like the other fields: an unknown position, a provider other than `claude` or `custom`, a command on a claude record, a custom record without a command or with one that `readCustomCommand` (`src/server/command.ts`) cannot read, a custom boss and a reserved name (`user`, `boss`) all make the file unusable (one line, the file is never touched).
- `StateSnapshot` carries `poll` (null or a poll view) and `governor` (`{ limit, working, holding }`). Frames `poll` and `governor` are sent once per change. The client refuses a snapshot without `governor`.

**Hub** (2.1, 4, 5)

- Hire and edit take `position`, `provider` and `command`. Provider and command are kept only for custom agents; a custom agent ignores `mode` and `confirmBypass`. An edit rolls back name, role, dir, mode, position and command field by field.
- Custom agent (4): no hooks, no draft latch, no startup dialog, no reconcile by title or screen. State comes from output bytes: `starting` until the first output or `CUSTOM_START_MS` after spawn, then `idle`; `working` while output arrived within the last `CUSTOM_ACTIVE_MS`. A message to a custom agent is undelivered at once (before the hop and stopped checks, 5.2) with a note that it cannot read mail.
- T-minus: `startPoll`, `holdPoll`, `abortPoll`, `clearPoll`, `vote`. `startPoll` takes an optional `agents` list; the default is every running Claude agent except the boss, and a custom agent is refused (400, field `agents`). Each polled agent gets the Director's message `T-minus: go/no-go poll` (never held by Max Q) and answers with `go_nogo`. Votes are accepted while the poll is `open` or on `hold`. The first no-go moves an open poll to `hold`; when every entry voted go the status is `go` and the boss gets `T-minus: all go`. While the hold came from a no-go vote, every vote re-evaluates it: a standing no-go keeps `hold`, no no-go left and all voted go gives `go` (the boss is told once), no no-go left but a vote missing gives `open`. A hold the Director called never changes by votes: the Director clears or aborts it. A vote shares the per-agent send window of `send_message` (`too many requests: wait a moment`) and its reason is one clean line (control and bidi characters removed). A removed agent's entry is deleted (a poll with no entry left is cleared); a rename renames the entry. Abort sends `T-minus: aborted` to every entry that did not vote no-go. An entry whose process ends counts as no-go with the reason `stopped`. Only one poll exists at a time (`conflict`, `clear the poll first`); it is not saved and shutdown clears it. Notes: `waiting for <names>`, `no-go: <names>`, `held by the Director`, `all go`, `aborted by the Director`. Errors: hold without an open poll is `conflict` (`no poll is open`), abort without a poll is `conflict` (`there is no poll`), a second abort is a no-op, an empty target list is `bad_request` (`nobody to poll`, no field).
- Max Q: `setGovernor({ limit })` with `null` or a whole number from 1 to 24 (start value `HubOptions.maxWorking`, from `GONOGO_MAX_WORKING`). The view is `{ limit, working, holding }`: `working` counts claude agents in state `working` (the boss too) and claude agents whose pointer is typed and not yet confirmed; custom agents take no slot, `holding` counts messages that wait only for the limit. While `working` is at or above `limit`, an idle recipient gets no pointer; the message stays `queued` with the note `waiting: load limit (<working> of <limit> agents working)`. A recipient with a queued message from the Director is never held, so polls and the Director's briefs always pass. A working recipient is not gated: its mail still goes by the Stop hook. Held messages go at the next sweep (500 ms) after a working agent finishes, and at once when the limit changes (5.3). `AgentView.held` is not set by Max Q; it stays the draft and unconfirmed-pointer hold.

**Edge and launcher** (2.6, 2.7, 2.8, 3, 7, 9)

- 3.3 REST: `POST /api/poll` (201; an empty body is allowed), `POST /api/poll/hold` and `/abort` (200), `DELETE /api/poll` (204), `PUT /api/governor` (200). `PUT` is covered by the 415 content-type rule. Unknown body fields are ignored, as on the other routes. `HubError.field` is passed through to the 400/409 body.
- 3.6 MCP: four tools. `go_nogo` takes `{ vote: "go" | "no-go", reason? }` (at most `POLL_REASON_MAX_CHARS`) and returns `{ ok, note }`; it is an error result when `ok` is false. `--allowedTools` gains `mcp__gonogo__go_nogo`.
- 7 launcher: a custom agent gets no `settings.json`, `mcp.json`, token or `memory.md`. The command is read by `src/server/command.ts` with the same rules as `GONOGO_AGENT_CMD` (whitespace split, or a JSON array of strings; a NUL character is refused, also as a JSON escape) and run in the agent folder with the scrubbed environment and no `GONOGO_TOKEN`. `web.ts` refuses a command that cannot be read at hire and edit (400, field `command`), so nothing is hired or saved for it. At start a bad command is rejected with a one-line reason. `buildChildEnv(token)` takes `string | null`.
- 2.8 cli: `GONOGO_MAX_WORKING` (1 to 24, otherwise ignored with a warning) and `StartOptions.maxWorking`; `--help` lists it. The state folder default is `~/.gonogo`.
- 9 stand-in: accepts the four tool names and the directive `@fake vote go|no-go [reason]`.

**Client** (8)

- 8.3 the floor is one inline SVG (no pixi.js, no canvas): 2 to 4 console columns by pane width (`columnsFor`: floor((width - 48) / 168), clamped), viewBox 384 to 720 units wide, scaled by CSS only. Each console has an operator, a desk with lit panel and two screens (three and gold trim for FLIGHT), and a name plate. States differ by shape and colour. An open console is a dashed ghost desk with a plus and the label `open console`. The Gallery (the Director's booth) is a real button `Gallery: N new messages for the Director`; the live region says `N new message(s) in the Gallery`; the accessible agent name includes the position title. Below 480 px viewport width the picture is not drawn and the list stays.
- 8.1 / 8.5 wording: `Loading the operations room...`, `The operations room is full (N consoles).`, `No console selected.`, the chip `to Director`, the wire name `user` shown as Director, the Max Q note shown as `waiting for Max Q: N of M agents working`.
- 8.1 wall display (`WallDisplay.tsx`, `wall.ts`) above the floor: the T-MINUS poll row (start, hold, abort, clear), counters per state and the MAX Q stepper. Pure logic is in `wall.ts` and `form.ts` so tests can import it.
- 8.6 hire form: Provider (Claude or Custom), Position (fills name and role, both editable; it also sets the console's accent colour), and for custom a Command field (at most `COMMAND_MAX_CHARS` = 1000; the client repeats the number in `form.ts`). Custom hides position and permission mode; the provider cannot be changed in edit.
- Palette tokens `--room-*` in `styles.css`; the shell tokens alias them.

### Annunciator redesign (lead, 2026-11-17)

The client was rebuilt in a new look (mockups: `docs/design/*.dc.html`; build brief: `docs/redesign-spec.md`). Where section 8 or the round above says otherwise, this list wins.

- Shared types: `AgentView.history` (state changes of the last `HISTORY_WINDOW_MS`, plus the one before, at most `HISTORY_MAX`; memory only), `AgentView.doing` (the tool call of the latest `PreToolUse` hook, one line, at most `DOING_MAX_CHARS`; null for a custom agent and before the first call; kept until the next spawn), `AnswerRequest`, `Hub.answer`, `HubIo.press`.
- 3.3 REST: `POST /api/agents/:name/answer` with `{ "go": boolean }` answers 200 with the view (still `needs_you`; the hooks move the state). The hub presses Enter for go and Escape for no-go, only when the agent is in `needs_you` with kind `permission` and no transition runs; otherwise 409 (`<name> is not asking for a go`, or `could not reach the terminal of <name>`). 400 with field `go` for a body without a boolean.
- 8 client: `App.tsx` shows one of: not signed in, loading, server gone, the staffing page (`store.form`), the comm loop (`store.view === 'loop'`), or the room. Files: `WallView.tsx` + `wall.ts` (mission, clock, sequence chart, poll word and flood, Max Q), `RoomView.tsx` + `room.ts` (the fixed matrix of 15 position cells plus spare cells, the needs-you floods with GO and NO-GO, the selected console panel, the phone views), `HireForm.tsx` + `form.ts` (staff, edit, custom command, the bypass confirmation, room full), `Activity.tsx` + `loop.ts` (comm loop and per-console traffic), `Brief.tsx`. Styles: `base.css` (tokens and primitives), `shell.css`, `forms.css`, `loop.css`. Fonts are bundled from `@fontsource` packages; the page loads nothing from another host. The floor picture, the tab bar, the activity strip, the Gallery button and `STATE_COLORS` on the floor are gone.
- Phone layout under 700 px viewport width. Not built from the mockups: `always allow in this folder`, the first-run `BRIEF FLIGHT` block, a server-time offset for the mission clock.

### Redline and Propellant (lead, 2026-11-17)

The first two features of the self-hosted roadmap (`docs/backlog.md` section 11; spec `docs/redline-propellant-spec.md`). Protocol: `NEEDS_KINDS` and `HELD_KINDS` gain `redline`; `FUEL_WINDOWS`, `FuelLimits`, `FuelGauge`, `PropellantView`, `PropellantRequest`, the `propellant` frame and `StateSnapshot.propellant`; `Hub.trip`, `Hub.resume`, `HubIo.meter`, `HubOptions.redline`. Routes: `POST /api/agents/:name/resume`, `PUT /api/propellant`. Files: `fuel.jsonl`, `propellant.json`. Env: `GONOGO_REDLINE`. The MCP server that gives agents their tools is named `gonogo` from this round on (tools `mcp__gonogo__*`); settings and `mcp.json` are written again at every start, so existing agents pick it up at their next start. Verified with a real `claude` (haiku, `scripts/smoke-real.mjs` step 4e): 28 103 tokens were counted from the transcript, a 1-token limit tripped the agent at the end of its turn, and resume cleared it. The loop, error-storm and ping-pong detectors and the Escape of a working agent were tested with the stand-in agent only.

### Instrument restyle (lead, 2026-11-17)

The owner found the Annunciator look too high in contrast and chose Instrument instead (mockups `docs/design/instrument/`, brief `docs/instrument-spec.md`; the Annunciator mockups moved to `docs/design/annunciator/`). Only the look changed: `base.css` has new tokens (warm grey body, modules, keys with a bottom edge, LEDs, dark olive LCD screens; indigo working, saffron needs you, sage go, raspberry no-go) and the fonts are Geist, Geist Mono and Doto, bundled from `@fontsource`. `shell.css`, `forms.css` and `loop.css` were rewritten on it; markup gained LED spans, module letters, cell numbers and the Max Q knob. Behaviour, routes and tests are unchanged.


### Engine Bay (lead, 2026-11-17)

Other agent CLIs next to Claude Code (`docs/backlog.md` section 11; spec `docs/engine-bay-spec.md`). Protocol: `PROVIDERS` gains `gemini`, `codex`, `opencode`, `qwen`, `grok`, `kimi`, `crush`, `pi`, `copilot` and `cursor`; new `ProviderCheck`, `ProviderInfo`, `PROVIDER_INFO`, `providerInfo()` and `ServerInfo.installed` (providers whose program is on the server's `PATH`). New file `src/server/providers.ts` (the adapters, the Gemini hook shim, `onPath`, moved from `cli.ts`, and `installedProviders`); `launcher.ts` starts every provider but `claude` and `custom` through it. The hub decides by `PROVIDER_INFO`: hooks drive the state, a Max Q slot and the Redline detectors only where `hooks` is true (claude, gemini); mail, polls and the draft latch only where `mcp` is true; the screen, title, Propellant meter and session id rules stay Claude's. A pointer typed into a provider without hooks is delivered at once. A Gemini `Notification` with `notification_type: 'ToolPermission'` sets `needs_you` (kind `permission`); `Hub.answer` with `go: false` on a Gemini agent sets `idle`, because that Escape ends its turn without a hook. A provider without permission modes stores `default`. The roster accepts every provider. A room Propellant limit trips Claude agents only. Files under `agents/<name>/`: `gemini-settings.json`, `opencode.json`, `kimi-mcp.json`, `copilot-mcp.json`. Client: an Engine select in the hire form (installed first), engine labels on the console chip and tile names, polls from the wall ask agents with the tools, the PROPELLANT fold only on Claude consoles. Claude Code's argv, settings and behaviour are unchanged; one existing test fixture that used `gemini` as an unknown provider now uses `eliza`. Not run against a model: Gemini CLI 0.59.0 (not signed in) was checked by its help and bundled source, pi 1.5.2 by its help (`docs/facts/gemini.md`, `docs/facts/pi.md`), the rest are from their docs.

### Payload (lead, 2026-11-17)

MCP servers and skills chosen per agent (`docs/backlog.md` section 11; spec `docs/payload-spec.md`). Protocol: `McpServer`, `Payload`, `AgentRecord.payload`, `AgentView.payload` (null when none), `HireRequest.payload`, `EditRequest.payload` (null removes it), `ProviderInfo.payload` (`all`, `servers` or null: Claude Code, Gemini CLI and Kimi CLI take servers, only Claude Code skills). New file `src/server/payload.ts` (`parsePayload`, `payloadRefusal`); limits and the plugin names in `constants.ts`. `web.ts` passes `payload` through when it is an object; the hub validates it and answers 400 with the field `payload`, `payload.mcpServers` or `payload.skills`; each skill folder is checked with `HubIo.checkDirectory`. `home.ts` validates the payload of every roster record on load with the same reader (a bad one makes the file unusable). An edit that changes the payload makes the agent `dirty`. The launcher writes the servers into `mcp.json` before `gonogo`'s own entry, and for skills rebuilds `agents/<name>/payload-plugin/` (manifest and one symlink per skill folder) and passes `--plugin-dir` before `--append-system-prompt`; `--allowedTools` is unchanged. Gemini's settings file and Kimi's `kimi-mcp.json` carry the servers too. Client: the PAYLOAD fold of the hire and edit form (`form.ts` `payloadOf`). Stand-in `test/fake-claude.mjs` accepts `--plugin-dir` and extra servers in `mcp.json`. Checked with the installed `claude` 2.1.325 and no model: `--help`, `claude plugin validate`, `claude mcp list` against a local server. Not run: a model using a payload tool or skill, a remote server, `--mcp-config` with a payload entry, Gemini and Kimi.

### Clean Room (lead, 2026-11-17)

An optional sandbox per agent (`docs/backlog.md` section 11; spec `docs/clean-room-spec.md`). Protocol: `CleanRoom`, `AgentRecord.cleanRoom`, `AgentView.cleanRoom` (null when off), `HireRequest.cleanRoom`, `EditRequest.cleanRoom` (null turns it off), `HubIo.checkCleanRoom` (optional for fakes), `CLEAN_ROOM_DIR` and `cleanRoomBranch` (the worktree is `<home>/cleanroom/<name>` on the branch `gonogo/<name>`). New file `src/server/cleanroom.ts` (`parseCleanRoom`, the Docker and repository checks, `ensureWorktree`, `prepareCleanRoom`, `containerUrl`, `buildDockerArgs`); limits, the image name rules and the credential names are in `constants.ts`. `web.ts` passes `cleanRoom` through when it is an object (or `null` on edit); the hub validates it (Claude Code only, a good image, `docker version` and a git repository) and answers 400 with the field `cleanRoom`; an edit that changes it makes the agent `dirty`, and a Clean Room agent cannot be renamed (409, field `name`) unless the same edit turns it off. `home.ts` validates the field of every roster record with the same reader. The launcher, for a record with `cleanRoom`: checks Docker again, makes the worktree once, writes the hook and MCP URLs with `host.docker.internal` in place of `127.0.0.1`, records the folder trust in the container's own `.claude.json` (seed behaviour is always on for it), and starts `docker run --rm -i -t --init --user <uid>:<gid> --add-host host.docker.internal:host-gateway` with `HOME` and `CLAUDE_CONFIG_DIR` set to `agents/<name>/cleanroom-home`, variables named without values (`GONOGO_TOKEN`, `TERM`, `COLORTERM`, `IS_DEMO`, `CLAUDE_CODE_OAUTH_TOKEN`, `GONOGO_API_KEY`), only the worktree and `agents/<name>/` mounted at their own paths, and the program as `--entrypoint` (the project's image has `gonogo` as its entrypoint). This changes 0.3 item 13: a Clean Room agent is given `host.docker.internal`, and `web.ts` accepts that name as `Host` for the hook and MCP endpoints only (any other route answers 403 `forbidden host`; the WebSocket upgrade is unchanged). Env: `GONOGO_CLEANROOM_IMAGE` (default `gonogo`). Client: a `Clean Room` box in the staffing form (`form.ts` `cleanRoomOf`), a `CLEAN ROOM` chip on the tile and a line with the branch and the worktree under the console header (`room.ts` `cleanRoomPlace`). Stand-ins: `test/fake-docker.mjs` (a `docker` that runs the stand-in agent on the host) and `FAKE_CLAUDE_BEHIND_DOCKER` in `test/fake-claude.mjs`. Never run against real Docker or a real `claude` in a container; Claude Code 2.1.325 blocks HTTP hooks to private addresses (strings of its binary), which `host.docker.internal` probably resolves to, so the hooks of a Clean Room agent may not arrive (spec, known limits).

### Auto permission mode (2026-11-17)

`PERMISSION_MODES` is now `default`, `acceptEdits`, `auto`, `bypassPermissions` (`claude --help` of 2.1.325 lists `auto` among its `--permission-mode` choices). Where 3.3, 7.2, 7.3 or 8 list the modes, read `auto` as the third. `auto` is passed to claude only as `--permission-mode auto`: `settings.json` is the same as for `default` and `acceptEdits` (no `permissions.defaultMode`, no allow-list change, no skip key, which stays for `bypassPermissions`). It needs no `confirmBypass` and no confirmation box, on hire or on edit. The hire form shows a tile AUTO between ACCEPT EDITS and BYPASS with the hint "Claude decides which tool calls are safe to run without asking and asks about the rest". The REST, `home.ts` and `agents.json` checks all use `PERMISSION_MODES`, so a roster written with `auto` loads. A real `claude` 2.1.325 was started in `auto` on the owner's account without a prompt: it showed `auto mode on` and no extra dialog. Not verified: a turn in `auto` through gonogo, and what claude does on an account or model that cannot use it. The stand-in agent accepts `auto`.

### Clean Room review fixes (2026-11-17)

Three changes to the Clean Room start (spec `docs/clean-room-spec.md`). The container is named `gonogo-<name>-<12 hex of sha256 of the worktree path>` (`containerName`, `CleanRoomPlace.container`), and the launcher runs `docker rm -f` on it before every start and when that start's token is revoked (every exit), because with `-t` the docker CLI passes no signal on and a stop would leave `claude` running in the container; the next start of the agent waits for a removal still running. The worktree's `.git` file is mounted read-only over the worktree mount, so the agent cannot point the owner's next git command in the worktree at a config that runs a program on the host. A start refuses when `agents/<name>/cleanroom-home` or its `.claude.json` is a symbolic link, because trust seeding follows a symlinked `.claude.json` and the container can write that folder. `test/fake-docker.mjs` now takes `--name`, `:ro` mounts of files and `docker rm`. Still never run against real Docker.

### Launch Window (lead, 2026-11-17)

Schedules that send a message by themselves on a cron rule (`docs/backlog.md` section 11; spec `docs/launch-window-spec.md`). Protocol: `Schedule`, `ScheduleView` (adds `nextAt`), `ScheduleRequest`, `SchedulePatch`, the `schedules` frame (`SchedulesFrame`, also in `HubEvent`), `StateSnapshot.schedules`, `ServerInfo.timeZone`, `SCHEDULE_NAME_MAX_CHARS`, `SCHEDULES_MAX`, `CRON_MAX_CHARS` and `scheduleSubject`. New files: `src/shared/cron.ts` (`parseCron`, `nextFire`, `nextFires`; no imports, compiled by the client and the server, so it is in the package allow-list of `scripts/check-pack.mjs` and `test/repo-files.test.ts`) and `src/server/schedules.ts` (`createSchedules`: the file, the validation, the minute timer on an injected clock, the fire through `Hub.sendFromUser`). `web.ts` takes `WebOptions.schedules` and serves `GET` and `POST /api/schedules`, `PATCH` and `DELETE /api/schedules/:id` and `POST /api/schedules/:id/run`; `cli.ts` creates it after the hub and loads it after `hub.start()`, and closes it first at shutdown. File: `schedules.json` (`{ version: 1, schedules }`, mode 0600). A fire is a message from `user` with the subject `Launch Window: <name>: <subject>`; a fire more than 60 s late and the fires missed while the server was down are logged, not replayed. Client: `LaunchWindow.tsx` with `launch.ts` and `launch.css`, `store.view` gains `window`, a LAUNCH WINDOW key in the top bar and a LAUNCH key in the phone bar. Tested with a fake clock, a fake store behind the routes and the stand-in agent in a real server; never across a real minute boundary, never with a real `claude`.

### Launch Window review fixes (2026-11-17)

Four small changes (spec `docs/launch-window-spec.md`). At start, a fire in the last 60 s before the start is logged as missed too (it was neither sent nor logged); the grace of 60 s is for a running timer only. A second record with an id already loaded from `schedules.json` is skipped with a warning. In the form, a recipient that is in the room but has no gonogo tools reads `(cannot read mail)`, not `(not in the room)`. Keep in the inline delete question gives the focus back to Delete. The spec and the reference say that a schedule does not follow a renamed console (a `shortcut:` in `schedules.ts`).

### Uplink (lead, 2026-11-17)

Incoming webhooks that start work (`docs/backlog.md` section 11; spec `docs/uplink-spec.md`). Protocol: `Uplink`, `UplinkView` (no secret), `UplinkCreated` (adds `secret`), `UplinkDelivery`, `UplinkRequest`, `UplinkPatch`, `UplinkKind` and `UPLINK_KINDS` (`generic`), the `uplinks` frame (`UplinksFrame`, also in `HubEvent`), `StateSnapshot.uplinks`, `UPLINK_NAME_MAX_CHARS`, `UPLINKS_MAX`, `UPLINK_DELIVERIES_MAX` and `uplinkSubject`; the error code `rate_limited` (429) is new in `API_ERROR_CODES`. New file `src/server/uplinks.ts` (`createUplinks`: the file, the validation, the secrets, the rate limit on an injected clock, the delivery through `Hub.sendFromUser`; `KINDS` maps a kind to its `authentic` and `read` functions, the extension point for Relay). `schedules.ts` exports `UNSAFE_IN_NAME`. `constants.ts`: `UPLINKS_FILE`, `UPLINK_BODY_MAX_BYTES` (256 KiB), `UPLINK_RATE_MAX` (30) and `UPLINK_RATE_WINDOW_MS`, `UPLINK_NOTE_MAX_CHARS`. File: `uplinks.json` (`{ version: 1, uplinks }`, mode 0600, the secret in plain text).

- 3.2 `web.ts` has a new route kind `uplink` for `/uplink/*`, outside `/api` and the browser token. The Host check is unchanged and runs first (an allow-listed name passes; `host.docker.internal` still reaches only hooks and tools and gets 403 here); an `Origin` header is refused with 403 as for hooks and tools.
- 3.3 `POST /uplink/:id` answers 202 `{ ok, id, status }`, 404 `not found` for an unknown, malformed or disabled id (one body), 401, 429 with `Retry-After: 60`, 400 (a body that is not JSON), 409 with the hub's reason, 413 past 256 KiB, 405 with `Allow: POST`, 503 before ready. The proof is `X-Gonogo-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret text>` or `Authorization: Bearer <secret>`, compared in constant time. Only a request that proved itself counts against the rate limit (30 a minute per uplink, sliding window in memory) and is recorded. The message is from `user`, subject `Uplink: <name>`, body the JSON pretty-printed and cut to `BODY_MAX_CHARS` with a line that says so.
- 3.3 REST (browser token): `GET` and `POST /api/uplinks` (201, the answer carries the secret), `PATCH` (`name`, `to`, `enabled`) and `DELETE /api/uplinks/:id`, `POST /api/uplinks/:id/rotate` (200, the new secret) and `POST /api/uplinks/:id/test` (200 with the view; a refusal is in the delivery). A bad field is 400 with its name, an unknown id 404, the 21st uplink 409. Unknown fields are refused.
- 8 client: the UPLINK module is a section of the Launch Window view, under the schedules (`UplinkPanel.tsx`, `uplink.ts`, `uplink.css`; `api.ts` `createUplink`, `updateUplink`, `deleteUplink`, `rotateUplink`, `testUplink`; `store.uplinks`). The secret lives only in the state of one component. No new top-bar or phone-bar key. `launch.ts` exports `MONTHS` and `pad`.
- Tests: `test/uplinks.test.ts` (the store on a fake clock), `test/client-uplink.test.ts`, a `describe('uplink')` in `test/edge.test.ts` (routes, Host, Origin, 413) and scenario 24 of `test/e2e.test.ts` (a real server with the stand-in agent). `StateSnapshot.uplinks` was added to the two snapshot expectations of `edge.test.ts` and the fixture of `client-store.test.ts`; `STATUS_OF_CODE` gained `rate_limited`. Not run: a real reverse proxy, a real sender, a real `claude` reading a delivery.
- Review: a broken `uplinks.json` is logged without the parse error's text (V8 quotes the text around the fault, which can be part of a secret; a test covers it). The deliveries fold hides Safari's own marker. A `shortcut:` comment in `uplinks.ts` records that an uplink does not follow a renamed console. The reference's `curl` and `openssl` example was run against the built server: signed and bearer 202, a wrong signature 401, an unknown id 404, another Host 403, the file 0600, the secret in no log line.

### Flight Plan (lead, 2026-11-17)

A task board shared by the Director and the agents (`docs/backlog.md` section 11; spec `docs/flight-plan-spec.md`). Protocol: `Task`, `TaskStatus` and `TASK_STATUSES` (`todo`, `doing`, `review`, `done`, `blocked`), `TaskRequest`, `TaskPatch`, the `tasks` frame (`TasksFrame`, also in `HubEvent`), `StateSnapshot.tasks`, `TASK_TITLE_MAX_CHARS` (200), `TASK_DETAIL_MAX_CHARS` (4000), `TASK_NOTE_MAX_CHARS` (200), `TASKS_OPEN_MAX` (500) and `taskSubject`; `MCP_TOOL_NAMES` gains `task_list`, `task_create` and `task_update`. New file `src/server/tasks.ts` (`createTasks`: the file, the validation, the history lines, the assignment message through an injected `send(actor, request)`; an `Actor` is the Director or an agent with its token's generation). `constants.ts`: `TASKS_FILE`, `TASK_NOTES_MAX` (20 history lines kept), `TASKS_DONE_KEEP` (100 done tasks kept), the three tools in `ALLOWED_TOOLS`, `MCP_DESCRIPTIONS` and one line in `ROLE_PREAMBLE` (which now says "these tools" where it said "three tools"). File: `tasks.json` (`{ version: 1, seq, tasks }`, mode 0600; `seq` is the number of the last id given, so no id comes back after a restart).

- 3.3 REST (browser token): `GET` and `POST /api/tasks` (201), `PATCH /api/tasks/:id` (`status`, `assignee`, `note`; 200) and `DELETE /api/tasks/:id` (204). The browser is the Director. A bad field is 400 with its name (any other field too), an unknown id 404, the 501st open task 409 (also moving a `done` task back to a full board). Without a `tasks` option the routes are 404.
- 3.6 MCP: seven tools. `task_list { mine?, status? }` answers `{ count, tasks, remaining?, note? }`, most recently changed first, cut at `READ_MAX_CHARS` like `read_messages`. `task_create { title, detail?, assignee? }` and `task_update { id, status?, assignee?, note? }` answer `{ ok: true, task }`; a refusal is an error result `{ ok: false, error }`. The agent is the one of the token; no argument names one. `--allowedTools` gains the three names. `createMcpHandler` takes an optional `tasks`; without it the three tools answer that the Flight Plan is not available.
- 5 messages: a task given to an agent, at create or when the assignee changes (not to the agent that does it itself), sends the subject `Flight Plan: <id> assigned to you: <title>` (cut to 200 characters) and a body of the detail and who gave it. From the Director it is `Hub.sendFromUser`; from an agent it is `Hub.sendFromAgent` as that agent, so the send window, Redline's ping-pong detector and the hop limit apply. The message goes before the change is stored, so a refusal leaves the board as it was; a message made but not delivered is a note on the task.
- 8 client: the FLIGHT PLAN view (`FlightPlan.tsx`, `plan.ts`, `plan.css`; `api.ts` `createTask`, `updateTask`, `deleteTask`; `store.tasks`, `store.view` gains `plan`, `showPlan`), a FLIGHT PLAN key in the top bar and a PLAN key in the phone bar, each with a small count of the tasks that are doing or blocked. The phone-bar keys lost 10 px of side padding so that five fit at 390 px, and the working directory in the top bar is cut at 24 characters (it was 40) so that the top bar stays on one line at 1280 px.
- Tests: `test/tasks.test.ts` (the store), `test/client-plan.test.ts`, a `describe('flight plan')` in `test/edge.test.ts` (routes and tools) and scenario 25 of `test/e2e.test.ts`. The stand-in agent has the directive `@fake task <tool> <json>` and the three tools in its allowed list; `launcher.test.ts` expects them in the argv. `StateSnapshot.tasks` was added to the two snapshot expectations of `edge.test.ts` and the fixture of `client-store.test.ts`. Not run: a real `claude` using the tools.
- Review: `tasks.json` keeps `seq`, so an id that was removed or dropped is not given again after a restart (the spec listed that as a shortcut). `cli.ts` loads the board before `hub.start()`: the MCP route is not behind the ready gate, and a `task_create` from an agent that started before the load would have taken an id of the file and lost the saved task with it.

### Downlink (lead, 2026-11-17)

The Director's inbox, kept by the server (`docs/backlog.md` section 11; spec `docs/downlink-spec.md`). Protocol: `DownlinkMessage`, `DownlinkEvent`, `DownlinkItem` (a union on `type`: `message` or `event`), `DownlinkView` (`{ unread, items }`, newest first), `DownlinkRequest` (`{ ids }`), `DOWNLINK_EVENT_KINDS` (`redline`, `tminus`, `launch-window`, `uplink`, `flight-plan`), `DownlinkEventKind`, `DownlinkNotify`, the `downlink` frame (`DownlinkFrame`, also in `HubEvent`), `StateSnapshot.downlink` and `HubIo.notify?` (optional, so the fakes do not change; `Hub` does not change). New file `src/server/downlink.ts` (`createDownlink`: the copy of the newest messages to the Director, the events, the flags, the file; the clock and the log of messages are injected). `constants.ts`: `DOWNLINK_FILE`, `DOWNLINK_EVENTS_MAX` (1000), `DOWNLINK_MAIL_MAX` (200), `DOWNLINK_TEXT_MAX_CHARS` (300), `DOWNLINK_IDS_MAX` (200), `DOWNLINK_HISTORY` (1000 records of the log read at start), `UPLINK_BAD_MAX` (3) and `UPLINK_BAD_WINDOW_MS` (10 minutes). `hub.ts` exports `cutText`. File: `downlink.json` (`{ version: 1, seq, events: [{ id, at, kind, text }], flags: { "<item id>": "read" | "archived" } }`, mode 0600; a message is only a flag, its text is in `messages.jsonl`).

- 3.3 REST (browser token): `GET /api/downlink` (the view), `POST /api/downlink/read` and `/archive` with `{ ids }` (1 to 200 ids, `m<n>` or `e<n>`; any other field or a bad id is 400 with its name; an id the inbox does not hold is skipped), `POST /api/downlink/read-all`. All answer 200 with the view. Without a `downlink` option the routes are 404 and the snapshot has an empty inbox.
- 3.4 the `downlink` frame carries the whole view and goes out at every change: a message to `user` that joined (from the `activity` frames, in `cli.ts`'s `emit`), an event, a flag. A call that changes nothing writes nothing and sends nothing.
- 5 messages: a message to `user` is an inbox item; the reply to it is a message from the Director to its sender with `inReplyTo` (`POST /api/messages`, unchanged). Items are not in the hub: `hub.activity()` is unchanged and still lists the newest 200 messages of all kinds.
- Events: `Downlink.post(kind, text)` is called through `HubIo.notify` by `tripRt` (a Redline trip, whoever caused it) and `publishPoll` (a T-minus result: once for each `poll id:status` that is `go`, `hold` or `aborted`), and through a `notify` option by `schedules.ts` (`fire`, when the hub refused the message or threw), `uplinks.ts` (more than `UPLINK_BAD_MAX` requests that did not prove themselves in `UPLINK_BAD_WINDOW_MS`, at most one event for each uplink in each window) and `tasks.ts` (`update`, an agent that moved a task to `blocked` or `review`). The text is one line, never a secret.
- 8 client: the DOWNLINK view (`Downlink.tsx`, `inbox.ts`, `downlink.css`; `api.ts` `markRead`, `archiveItems`, `markAllRead`; `store.downlink`, `store.view` gains `downlink`, `showDownlink`), a DOWNLINK key in the top bar and a DOWN key in the phone bar with the unread count in their accessible name. Removed: `ClientState.userMailSeenAt`, `MAIL_SEEN_STORAGE_KEY` (`gonogo.mailSeenAt`), `userMailCount`, `markMailSeen` and the badge of the LOOP key (where section 8 of this file and `docs/redesign-spec.md` still speak of them, read the inbox instead); the loop still lists every message. `Facts.mail` of the live region is `Facts.unread` and says `N unread in the Downlink`. `Reply` of `Activity.tsx` is exported and takes any item with an id, a sender and a subject, and an `onSent`. The top bar's gap went from 18 to 14 px and the working directory in it starts at 6 characters and grows to 24, so that six keys stay on one line at 1280 px. The phone bar has six keys; they fit at 390 px.
- Tests: `test/downlink.test.ts` (the store), `test/client-inbox.test.ts`, a `describe('downlink')` in `test/edge.test.ts` (routes), the hooks in `test/hub.test.ts`, `schedules.test.ts`, `uplinks.test.ts` and `tasks.test.ts` (a fake `notify`) and scenario 26 of `test/e2e.test.ts`. `StateSnapshot.downlink` was added to the two snapshot expectations of `edge.test.ts` and the fixture of `client-store.test.ts`; the mail tests of `client-store.test.ts` and the announcer tests of `client-room.test.ts` follow the new count. The page was opened in Chrome at 1280 px and in the 390 px emulation against a real server with the stand-in agent; the keys were pressed by script. Not run: a real `claude`, Firefox, Safari, a screen reader.
- Review: a row read while the DOWNLINK page is up keeps its place among the unread until the page is left (`filterItems` takes the ids read on this visit), so opening a message no longer moves it down under the other unread ones; MARK READ puts the keyboard on its row before the key goes away; `uplinks.ts` forgets the bad-signature times of an uplink that is removed.

### Mission Log (lead, 2026-11-17)

One memory shared by every agent, with search (`docs/backlog.md` section 11; spec `docs/mission-log-spec.md`). Protocol: `LogEntry` (`id`, `title`, `body`, `tags`, `author`, `createdAt`, `updatedAt`), `LogHead` (`id`, `title`), `LogHit` (an entry without its body, with a `snippet`), `LogSearch` (`{ total, hits }`), `LogRequest`, the `log` frame (`LogFrame`, `{ changed: LogHead[], removed: string[] }`, also in `HubEvent`; not in `StateSnapshot`), `LOG_TITLE_MAX_CHARS` (200), `LOG_BODY_MAX_CHARS` (20000), `LOG_ENTRIES_MAX` (2000), `LOG_TAGS_MAX` (8), `LOG_TAG_PATTERN`, `LOG_QUERY_MAX_CHARS` (200) and `LOG_SEARCH_MAX` (20); `MCP_TOOL_NAMES` gains `log_write`, `log_search` and `log_read`. New files `src/server/logsearch.ts` (`createIndex`: BM25 in memory, `tokenize`, `snippet`) and `src/server/missionlog.ts` (`createMissionLog`: the files, the validation, the limits, who may change what). `constants.ts`: `LOG_DIR` (`mission-log`), `LOG_SNIPPET_CHARS` (200), `LOG_SNIPPET_LEAD_CHARS` (40), the three tools in `ALLOWED_TOOLS`, `MCP_DESCRIPTIONS` and one line in `ROLE_PREAMBLE`. Files: `<home>/mission-log/<id>.md` (a front matter of `id`, `title`, `tags`, `author`, `createdAt` and `updatedAt`, each value JSON on one line and the times ISO, then the body; folder 0700, files 0600, written through a temporary file and a rename) and `mission-log/.seq` (the highest id given, written when an entry is removed).

- 3.3 REST (browser token): `GET /api/log?q=` (`{ total, hits }`: the ranked results, or the newest 20 for an empty or missing `q`), `POST /api/log` (201; `title` and `body` required, `tags`), `GET /api/log/:id`, `PUT /api/log/:id` (200; the fields it carries change, at least one) and `DELETE /api/log/:id` (204). The browser is the Director and its change keeps the author. A bad field is 400 with its name (any other field too, `author` and `id` among them), an unknown or malformed id 404, the 2001st entry 409 (field `log`). Without a `missionLog` option the routes are 404.
- 3.4 the `log` frame goes out after every write that changed something (a new entry, a change, a removal), with ids and titles and never a body. A change that changes nothing writes nothing and sends nothing.
- 3.6 MCP: ten tools. `log_write { id?, title?, body?, tags? }` makes an entry (title and body required) or, with `id`, changes the fields given of an entry the caller wrote, and answers `{ ok: true, id, title, tags }`; `log_search { query, limit? }` (query 1 to 200 characters, limit 1 to 20, 20 when absent) answers `{ count, results }`; `log_read { id }` answers `{ ok: true, entry }`. A refusal is an error result `{ ok: false, error }`, `forbidden` with the author's name for an entry another agent wrote. The author is the agent of the token; no argument can name one. Without a `missionLog` dependency the three tools say the Mission Log is not available.
- Search: BM25 (k1 1.2, b 0.75, idf `ln(1 + (N - n + 0.5) / (n + 0.5))`) over the title and the tags (counted three times) and the body, words of two or more Unicode letters or digits, lowercased, no stemming; a tie goes to the newer entry. Index built at start, kept at every write. The snippet is about 200 characters around the place where the most different words of the query are close, on one line, with `…` where it was cut.
- 8 client: the MISSION LOG view (`MissionLog.tsx`, `log.ts`, `log.css`; `api.ts` `searchLog`, `readLogEntry`, `createLogEntry`, `updateLogEntry`, `deleteLogEntry`; `store.log` (`{ rev, changed, removed }`: the last frame, `rev` also counts a `state`), `store.view` gains `log`, `showLog`), a MISSION LOG key in the top bar and a LOG key in the phone bar. The page keeps no entries in the store: it asks again when `rev` changes. The text of an entry is a `<pre>`, never HTML or markdown. The top bar's gap is 10 px (it was 14) so that seven keys and the staffing key stay on one line at 1280 px; the phone bar has seven keys.
- Tests: `test/logsearch.test.ts` (the index and the snippets), `test/missionlog.test.ts` (the store), `test/client-log.test.ts`, a `describe('mission log')` in `test/edge.test.ts` (routes and tools) and scenario 27 of `test/e2e.test.ts`. The stand-in agent has the directive `@fake log <tool> <json>` (the same code as `@fake task`) and the three tools in its allowed list; `launcher.test.ts` expects them in the argv. `client-store.test.ts` has the frame and the view. `StateSnapshot` did not change.

### Relay (lead, 2026-11-17)

Slack, GitHub, Linear and Telegram, built on Uplink (in) and Downlink (out) (`docs/backlog.md` section 11; spec `docs/relay-spec.md`). Protocol: `UPLINK_KINDS` is now `generic`, `github`, `linear`, `slack`, `telegram`; `UPLINK_GIVEN_SECRET_KINDS` (`linear`, `slack`); `UplinkRequest.secret`; `UplinkDelivery.status` gains `answered`; `RELAY_SERVICES`, `RelayService`, `RELAY_FORWARD_KINDS` (`message`, `redline`, `tminus`, `flight-plan`), `RelayForwardKind`, `RelayLast`, `RelayTargetView`, `RelayView`, `RelayTargetRequest` and `RelayForwardRequest`. No frame and no `StateSnapshot` field. New files `src/server/relaykinds.ts` (`RELAY_KINDS`: the `authentic` and `read` of the four kinds, pure) and `src/server/relay.ts` (`createRelay`: `relay.json`, the targets, the forwarding with its queue and retries, the map of forwarded messages, the handled keys). `uplinks.ts` exports `Inbound`, `Thread`, `Made` and `KindDef`; `KindDef.authentic` takes the clock and `read` the headers and an `Inbound`; `createUplinks` takes `inbound`. `constants.ts`: `RELAY_FILE`, `RELAY_TIMEOUT_MS` (10 s), `RELAY_TRIES` (3), `RELAY_BACKOFF_MS` (1 s, doubling), `RELAY_RETRY_AFTER_MAX_MS` (10 s), `RELAY_QUEUE_MAX` (50), `RELAY_TEXT_MAX_CHARS` (3500), `RELAY_THREADS_MAX` (500), `RELAY_SEEN_MAX` (500), `RELAY_NOTE_MAX_CHARS` and `SLACK_SIGNATURE_MAX_AGE_MS` (5 min). File: `relay.json` (`{ version: 1, slack?: { token, to }, telegram?: { token, to }, forward }`, mode 0600, the tokens in plain text). `StartOptions.fetch` (test seam; the default is the global `fetch`).

- 3.2 / 3.3 `POST /uplink/:id` is as before for a message (`202`). The kinds prove themselves their own way: `github` `X-Hub-Signature-256`, `linear` `Linear-Signature`, `slack` `X-Slack-Signature` over `v0:<X-Slack-Request-Timestamp>:<body>` with a timestamp at most 5 minutes from now, `telegram` `X-Telegram-Bot-Api-Secret-Token`; none of them takes the generic header or a bearer token, and the generic kind takes none of theirs. A body the kind answers itself (a GitHub `ping`, a Slack `url_verification`) is `200` with the answer and is recorded as `answered`; an event that is not for the agents is `200 {"ok": true, "ignored": true}`, not recorded and not counted against the rate limit. The body is read before the rate limit. A reply (a Slack thread reply or a Telegram reply to a forwarded message) is sent to the agent that wrote the original, with `inReplyTo` and the subject `Re: <subject>`. `Uplinks.deliver` may return `{ ok: true, answer }`. Test sends the generic sample whatever the kind.
- 3.3 REST (browser token): `POST /api/uplinks` takes `secret` for `slack` and `linear` (required, 16 to 256 printable characters; any other kind refuses it with 400 and the field) and `PATCH` may change it for those two; `POST /api/uplinks/:id/rotate` is `409` for them. New routes: `GET /api/relay` (`{ slack, telegram, forward }`, a target is `{ to, last }`, never a token), `PUT /api/relay/slack` and `/telegram` (`{ token?, to }`; no `token` keeps the saved one; the shape of both is checked and the error never repeats the token), `DELETE` on both, `POST /api/relay/slack/test` and `/telegram/test` (one message, one try; the answer has `last`) and `PUT /api/relay/forward` (`{ kinds }`). All answer the view; a bad field is 400 with its name, an unknown service or a target that is not there 404. Without a `relay` option the routes are 404.
- Out: `Relay.observe` is called by the `emit` of the hub's `HubIo` for every frame (a message to `user` is forwarded) and `Relay.event` by the one `notify` function that `cli.ts` hands to the hub, Launch Window, Uplink and Flight Plan, after `Downlink.post` (`redline`, `tminus` and `flight-plan` are forwarded, `launch-window` and `uplink` are not). Each call is one `fetch` with a 10 s timeout and `redirect: 'error'`, tried again (at most 3 tries, 1 s then 2 s, or the `Retry-After` of a `429`, at most 10 s) after a network error, a timeout, a `5xx` or a `429`; a refusal is not tried again. Messages go out one after the other; past 50 waiting the oldest is dropped. A Slack text is escaped (`&`, `<`, `>`). A token is not logged and not in a note.
- 8 client: the RELAY module (`RelayPanel.tsx`, `relay.ts`, `relay.css`; `api.ts` `getRelay`, `setRelayTarget`, `removeRelayTarget`, `testRelayTarget`, `setRelayForward`) is a section of the Launch Window view under UPLINK. `UplinkPanel.tsx` exports `Editor` (which takes `kind`, `name` and `hint` and shows a Signing secret field for the kinds that take one) and `SecretPanel`; its Row has no Rotate key for those kinds. `uplink.ts` gains `needsSecret` and `secretProblem`, and `Field` gains `secret`. No new top-bar or phone-bar key.
- Tests: `test/relaykinds.test.ts` (the proofs with the vectors of the documentation of GitHub and Slack and of RFC 4231, the summaries), `test/relay.test.ts` (the store, the calls with a fake `fetch`, retries, the queue, the token, the map of replies), `test/client-relay.test.ts`, the kinds in `test/uplinks.test.ts`, a `describe('relay')` and a 200 answer in `test/edge.test.ts`, and scenario 28 of `test/e2e.test.ts` (a real server with the stand-in agent and a fake `fetch`). Scenario 24 and two tests of `uplinks.test.ts` that used `slack` as a kind that does not exist now use `sms`. Not run: a real Slack, GitHub, Linear or Telegram, a real reverse proxy, a real `claude` reading a delivery. A running server was posted to with `curl` and `openssl` signatures, and the page was opened in Chrome at 1280 px and in the 390 px emulation (no overflow, keys of at least 44 px).
- Review fixes: a reply whose agent was removed or renamed since goes to the uplink's recipient instead of answering the service 409 (Telegram sends a refused update again and again); a queued forward reads its target when it goes, so a target removed meanwhile gets nothing; after `close` nothing more is queued. Tests in `test/uplinks.test.ts` and `test/relay.test.ts`.

### Livery (lead, 2026-11-17)

Visual themes, and an agent that designs one (`docs/backlog.md` section 11; spec `docs/livery-spec.md`). Protocol: `LiveryEntry` (`slug`, `name`, `description`, `builtin`, `author`, `tokens`), `LiveryView` (`{ current, liveries }`), `LiverySelectRequest`, `LiveryDesignRequest` (`{ to?, brief }`), the `livery` frame (`LiveryFrame`, the whole view; also in `HubEvent`) and `StateSnapshot.livery?` (absent from an older server: the page shows Instrument); `MCP_TOOL_NAMES` gains `livery_submit` and `DOWNLINK_EVENT_KINDS` gains `livery` (the chip `LIVERY` in `inbox.ts`; Relay does not forward it). New files `src/shared/livery.ts` (the 28 tokens with their roles, the colour reader for `#rgb`, `#rrggbb`, `rgb()`, `hsl()` and `oklch()`, `contrast`, `CONTRAST_PAIRS`, `checkLivery`, `liveryProperties`, `slugOf`, `BUILTIN_LIVERIES`, `builtinEntries`, `defaultView`; it has no import except types, and it ships in the package, so `scripts/check-pack.mjs` and `test/repo-files.test.ts` list `dist/shared/livery.js`) and `src/server/livery.ts` (`createLiveries`: the files, the checks, the limit, `designBody`). `constants.ts`: `LIVERY_DIR` (`liveries`), `LIVERY_FILE` (`livery.json`), `livery_submit` in `ALLOWED_TOOLS` and `MCP_DESCRIPTIONS`; no line in `ROLE_PREAMBLE` (the design message names the tool). Files: `<home>/liveries/<slug>.json` (`{ version: 1, name, description, author, tokens }`; folder 0700, files 0600, written through a temporary file and a rename) and `<home>/livery.json` (`{ version: 1, current }`, 0600).

- 3.3 REST (browser token): `GET /api/liveries` (the view), `PUT /api/livery` (`{ slug }`; 404 with the field `slug` for an unknown one), `DELETE /api/liveries/:slug` (200 with the view; 403 for a livery that ships, 404 for an unknown one; the chosen one falls back to `instrument`) and `POST /api/liveries/design` (201 with the `SendResult` of the message; `to` is an agent name or `boss`, `brief` 1 to 500 characters; a bad field is 400 with its name). Without a `liveries` option the routes are 404.
- 3.4 the `livery` frame goes out after every change of the list or the choice, never after a change that changes nothing.
- 3.6 MCP: eleven tools. `livery_submit { name, description?, tokens }` (name 1 to 40 characters, description at most 200, `tokens` an object of text values) answers `{ ok: true, slug, note }` or an error result `{ ok: false, error }` whose text lists what to fix (a missing or unknown token, a value that is not a colour, `--muted on --body is 3.30:1, it needs 4.5:1`; at most 12 lines and "and N more"). The author is the agent of the token. A livery under the slug of one that ships is refused (400, field `name`), and under the slug of the one in use too (409, field `name`: a replace would change the look without the Director); the 13th custom one is 409. The Director gets a `livery` event in the Downlink and nothing is applied. Without a `liveries` dependency the tool says Livery is not available.
- 8 client: the LIVERY view (`Livery.tsx`, `look.ts`, `livery.css`; `api.ts` `selectLivery`, `deleteLivery`, `designLivery`; `store.livery`, `store.view` gains `livery`, `showLivery`), reached by a round half-filled key (named Livery) in the top bar, on a phone too; the phone bar did not change. `look.ts` puts the tokens on `:root` as properties with `style.setProperty` (none for the default) with `data-livery` and `data-scheme` attributes and sets `theme-color` and `color-scheme`; `startLivery()` runs in `main.tsx` before the first render and keeps a copy of the livery in `localStorage` (`gonogo.livery`, checked as a submit is). `TerminalPane.tsx` builds the xterm theme from `--lcd` and `--lcd-text` (`xtermTheme`) and sets it again when `store.livery` changes. The page helpers are in `look.ts` and not `livery.ts` because `Livery.tsx` and `livery.ts` differ only in case. `shell.css`: the logo is turned on a dark livery, the long name of the unit gives way between 700 and 1399 px so that seven keys and the staffing key stay on one line at 1280 px, the round keys of the top bar do not shrink, and the keys of the phone bar have 4 px of padding (with the unread count of DOWN they were 14 px too wide at 390 px).
- Tests: `test/livery.test.ts` (the colours, the contrast with known values, every livery that ships and that Instrument equals the CSS, the check, the properties, the store on a temporary folder), `test/client-look.test.ts`, a `describe('livery')` in `test/edge.test.ts` (routes and tool) and one in `client-store.test.ts`, and scenario 29 of `test/e2e.test.ts`. The stand-in agent has `@fake livery livery_submit <json>` (the same code as `@fake task`) and the tool in its allowed list; `launcher.test.ts` expects it in the argv. Not run: a real `claude` designing a livery, Firefox, Safari, a screen reader, a phone's own browser bar. The page was opened in Chrome at 1280 px and in the 390 px emulation against a real server with the stand-in agent (no overflow, keys of at least 44 px); the keys were pressed by script.
- Review fixes: `livery_submit` no longer replaces the livery in use (it changed the look on every device, which only the Director may do); after a DELETE in the LIVERY view the keyboard goes back to the title instead of the body of the page. Test in `test/livery.test.ts`.

### Docking (lead, 2026-11-17)

Two installations connect so that their agents can message each other and hand off tasks (`docs/backlog.md` section 11; spec `docs/docking-spec.md`). Protocol: `STATION_NAME_PATTERN`, `DOCKS_MAX`, `DockedAgent`, `DockView`, `DockingView`, `DockCodeRequest`, `DockCode`, `DockPairRequest`, `DockHandoffRequest`, `StationMessage`, `DockingFrame` (the `docking` frame, also in `HubEvent`) and `StateSnapshot.docking?` (absent from an older server and from one without Docking: the page shows no docks); `Task.handedOff?` (the station a task was handed to); `RosterResult.docked?`; `HubIo.dock?` and `DockLink` (`stations`, `rosters`, `send`); `Hub.sendFromStation`. A recipient of `send_message` may be `name@station` (`name` an agent name or `boss`, `station` a docked one; 64 characters at most, which is why a station name has 31). `MCP_TOOL_NAMES` did not change. New file `src/server/docking.ts` (`createDocking`, `stationName`, `signCall`, `DOCK_ROUTES`). `constants.ts`: `DOCKING_FILE`, `STATION_FILE`, `STATION_ENV` (`GONOGO_STATION`), `DOCK_CODE_TTL_MS` (15 min), `DOCK_CODES_MAX` (5), `DOCK_SKEW_MS` (5 min), `DOCK_BODY_MAX_BYTES` (256 KiB), `DOCK_RATE_MAX` (60) and `DOCK_RATE_WINDOW_MS`, `DOCK_TIMEOUT_MS` (10 s), `DOCK_UNDOCK_TIMEOUT_MS` (3 s), `DOCK_PULL_MS` (30 s); `ROLE_PREAMBLE` and the descriptions of `send_message` and `list_roster` say how to address a docked agent. Files: `station.json` (`{ version: 1, id }`) and `docking.json` (`{ version: 1, docks: [{ id, name, url, secret, since }] }`), both mode 0600, the secret in plain text. `Actor` of Flight Plan gains `{ kind: 'dock', station }`; `Tasks.handOff`. `StartOptions.fetch` (the Relay test seam) is also what Docking calls with.

- 3.2 `/dock/<route>` is a route kind beside `uplink`: outside `/api` and the browser token, the Host check of every route, any `Origin` is 403, only for the hub's own names (not `host.docker.internal`). `POST /dock/pair` (unsigned: a proof of holding the docking code's token), `GET /dock/roster`, `POST /dock/message`, `POST /dock/task` and `POST /dock/undock` (signed); another method is 405 with `Allow`, another path 404, a body over 256 KiB 413, and 503 until the server is ready. A signed call has `X-Gonogo-Station`, `X-Gonogo-Timestamp`, `X-Gonogo-Nonce` and `X-Gonogo-Signature`, the HMAC-SHA256 hex of `STATION\nMETHOD\nPATH\nTIMESTAMP\nNONCE\n` (STATION the sender's id, so a call cannot be reflected to its maker) and the body keyed with the 32 secret bytes. Refused with 401: a malformed header, a station that is not docked, a wrong signature, a timestamp more than 5 minutes from the clock (either way), a nonce seen before; 429 with `Retry-After: 60` past 60 calls a minute from one dock (only calls that passed the signature count). `/dock/pair` takes 60 calls a minute in all.
- 3.3 REST (browser token): `GET /api/docking` (the view), `POST /api/docking/code { url }` (201 `{ code, expiresAt }`), `POST /api/docking/pair { code, url }` (201 with the dock), `DELETE /api/docking/:id` (200 `{ told }`) and `POST /api/docking/:id/handoff { task, assignee? }` (200 with the task). A bad field is 400 with its name (`url`, `code`, `task`, `assignee`), an unknown dock 404, a refusal by the other station is its own code with its own text (its 401, 403 and 404 are 409 here), a station that cannot be reached 503. Without a `docking` option the routes and `/dock` are 404.
- 3.4 the `docking` frame goes out after every change a browser shows (a dock made or removed, a pull that changed the status, the time of the answer or the agents), never after one that changes nothing.
- 5.2 / 5.8 a message to `name@station` is checked by the hub (a docked station, a name that can be an agent; the Director may not send one), counts against the sender's send limit, the hop limit and Redline's ping-pong, and is a record `from: <agent>, to: name@station` that is `queued` ("sending to lab") and then `delivered` ("accepted by lab: <status>[, <note>]") or `undelivered` (the reason). A record to a station that is `delivered` is finished: the restart sweep and the trim of the hub's memory leave it. `Hub.sendFromStation` makes the record `from: <name>@<station>` at the other end with the hops it came with, routed as any message; `to` may not be `user` or have an `@`, `from` has to be an agent name, `inReplyTo` does not cross. `list_roster` has `docked` for the stations that answered their last pull.
- Flight Plan: `Tasks.handOff` marks a task `done` with `handedOff` and a history line; a task made by a station is made by `Tasks.create` with the actor `dock` (history `Director of lab: ...`, `createdBy: user`, the assignment message from `director@lab`).
- 8 client: the DOCKING module (`DockingPanel.tsx`, `docking.ts`, `docking.css`; `api.ts` `createDockCode`, `pairDock`, `undock`, `handOffTask`; `store.docking`) is a section of the Launch Window view under RELAY, and `HandOff` (in `DockingPanel.tsx`) is a form of a card of the Flight Plan, which also shows the chip `HANDED OFF · station`. No new top-bar or phone-bar key.
- Tests: `test/docking.test.ts` (two copies of the module wired through a fake fetch), a `describe('docking')` in `test/hub.test.ts` and in `test/edge.test.ts` (routes, Host, Origin, methods, 413), `test/tasks.test.ts`, `test/client-docking.test.ts`, `client-store.test.ts`, and scenario 30 of `test/e2e.test.ts` (two real servers with the stand-in agent). The stand-in agent did not change. Not run: two machines, a real reverse proxy or HTTPS, a real `claude` reading a message from another station, Firefox, Safari, a screen reader. The page was opened in Chrome (a 500 px window) against two real servers with the stand-in agent.
- Review fixes: `signCall` takes the sender's station id and signs it (a call of A's sent back to A with B's id in the header was accepted: both hold one secret). B tells A to undock when B refuses a pairing that A accepted (B still listed A, or a name clash), so A keeps no orphan dock. A no longer pulls B the moment it accepts a pairing (that pull could reach B before B saved the dock, and showed NO ANSWER for 30 s); a dock that is not `ok` is pulled when it calls in, which B does right after it saves. Two hand-offs of one task at once copy it once. `sendFromStation` passes only `to`, `subject` and `body` (an `inReplyTo` from the wire no longer lands in a record). Text another station sends back is cut to 300 characters in a note or an error.

### Release readiness (lead, 2026-11-17)

What an open-source, self-hosted release needs, with no control-room name (`docs/backlog.md` section 11, last paragraph; spec `docs/release-readiness-spec.md`). No protocol change and no new route, option or environment variable.

- 2 saved state: `src/server/migrate.ts` has `FORMATS` (`agents.json`, `schedules.json`, `uplinks.json`, `tasks.json`, `downlink.json`, `relay.json`, `docking.json`, `station.json`, `livery.json`, `propellant.json`, `liveries/*.json`) and `migrateHome(home, log, formats?)`. `openHome` calls it after the lock and the token and before any store reads a file (`home.ts`). A file whose `version` is a whole number below `steps.length + 1` is copied to `<file>.bak-v<old>` (mode 0600, an existing copy is kept), upgraded by its steps in order (`version` set by the runner) and written through a temporary file and a rename, with one `info` line; a step, copy or write that fails stops the start with a message that names the file and the copy; a file above `steps.length + 1` stops the start with `<path> was saved by a newer gonogo (format version N; this one reads up to M). ...` and the lock is released. A missing file, text that is not JSON and a file without a usable version are left to the store, except for a format marked `unversionedIs1` (only `propellant.json`, written without a version before), which counts as version 1. Every `steps` is `[]` today: all formats are at version 1.
- 2 saved state: `propellant.json` is written with `version: 1` (`PROPELLANT_FILE` in `constants.ts`; the loader still reads a file without one), and the front matter of a Mission Log entry has `version: 1` as its first line (`missionlog.ts`; an entry without one reads as 1, one with another version is skipped with a warning and kept). `messages.jsonl`, `fuel.jsonl`, `mission-log/.seq` and the files the launcher writes again at every start have no version.
- Documents: `docs/https.md` (new), `README.md` (26 lines: what it is, the feature names, install, links), `CONTRIBUTING.md` (new), `docs/reference.md` (State on disk rows, "Versions of the saved state", Troubleshooting, Development, What was not verified), `package.json` (`description`, `keywords`; no `repository`, `author`, `homepage` or `bugs` exist and none was added). `scripts/check-pack.mjs` and `test/repo-files.test.ts` did not change: `migrate.ts` is a `src/server` module, which the pack check lists by itself.
- Tests: `test/migrate.test.ts` with `test/fixtures/migrate/` (a made-up three-version format; each real file refused at version 2; `openHome` refusing, releasing the lock and opening again), `test/propellant.test.ts` and `test/missionlog.test.ts` (the version, an entry without one, an entry of version 2), and the existing Mission Log file text test now has `version: 1`. Not run: an upgrade of a real file (none exists yet), two gonogos on one home, Caddy, nginx and Tailscale as in `docs/https.md`, `npm run smoke:real`.
- Review fixes: the runner read a `propellant.json` from before it had a version as no version and left it alone, so the first Propellant step would have skipped every older file; `unversionedIs1` makes it version 1 (test in `test/migrate.test.ts`). The docs say that a `.bak-v<n>` copy of `uplinks.json`, `relay.json` or `docking.json` keeps the secrets of that day after a rotation, that Mission Log entries are not under the runner (a `shortcut:` in the spec), and where the token file is in Docker.

### Final check of the roadmap round (2026-11-17)

`npm run typecheck`, `npx vitest run` (2211 tests), `npm run build` and `npm run check:pack` passed. A server with the stand-in agent was walked in Chrome at 1440 x 900 and in the 390 x 844 phone emulation: a hire with a payload, a schedule run now, an uplink posted to with a signed `curl` (202) and a wrong signature (401), tasks made and moved by the Director and by an agent over MCP, Downlink read and archive, a Mission Log entry written and searched, the four liveries applied to every view, Relay's setup steps and Docking's code and Pair form. `scripts/smoke-real.mjs --spend` passed every step against claude 2.1.326 (haiku).

- Fix: with a count on both Down and Plan, the seven keys of the phone bar no longer fit in 390 px (the page scrolled sideways by 16 px, and the other keys shrank to 39 px). The counts now sit on the key's corner (`.phone-bar .chip` is absolutely placed, the keys have 2 px padding and no letter spacing), so each key is 47 px wide whatever the count (`shell.css`).
- Fix: the labels of the checkboxes in `.win-check` (Launch Window, Uplink, Relay) and `.staff-check` (Clean Room) were 15 to 18 px tall, so on a phone only the 22 px box was a target. A label now fills its 44 px row (`launch.css`, `forms.css`).
- Docs: `docs/reference.md` "What was not verified" now lists every open item the builders and reviewers of the round reported, plus Release and Tests bullets.

### Clean Room with gonogo in a container (2026-11-17)

The owner chose to mount the host's Docker socket (not Docker in Docker). The image copies the docker CLI binary from `ARG DOCKER_CLI_IMAGE=docker:29.9.1-cli` (no daemon, no plugins; Renovate reads the ARG like `NODE_IMAGE`). New env `GONOGO_CLEANROOM_NETWORK` (`CLEAN_ROOM_NETWORK_ENV`, `CLEAN_ROOM_NETWORK_PATTERN` in `constants.ts`): only `container:<name>`. `cleanroom.ts`: `cleanRoomNetwork` (also run by `checkCleanRoom`, so a bad value is a 400 at hire), `sameMountError`, `CleanRoomPlace.network`; with the variable, `prepareCleanRoom` runs `docker inspect` on that container and refuses unless gonogo's home is a bind mount from the same host path, `buildDockerArgs` puts `--network <value>` in place of `--add-host`, and `containerUrl(hubUrl, network)` keeps `127.0.0.1`. New `compose.yaml` (socket, one same-path data folder, `group_add` with `DOCKER_GID`, the network variable). `.dockerignore` lets `docs/brand` in again: the client imports its logo from there and the image build failed without it. Run once on real Docker in the Lima VM with the stand-in agent (`docs/reference.md`, What was not verified).

Review fix (2026-11-17): with `containerUrl(hubUrl, network)` keeping `127.0.0.1`, a Clean Room on gonogo's network used a loopback `Host` and so reached every route, not only hook and MCP. Now the URLs keep `host.docker.internal` in both modes (`containerUrl(hubUrl)` as before); `compose.yaml` gives gonogo's container `extra_hosts: host.docker.internal:127.0.0.1`, which the Clean Room shares through `--network container:`, and `prepareCleanRoom` refuses a start when that name does not resolve to `127.x` in gonogo. The compose and reference instructions `export DOCKER_GID`, because every compose command interpolates it. Rerun in the Lima VM with the stand-in agent.

### pnpm everywhere (2026-11-17)

The owner uses pnpm and wants no npm in the project's own tooling. `package.json` pins `packageManager: pnpm@10.34.9+sha512...` (the newest 10.x); `pnpm-lock.yaml` was made by `pnpm import` from `npm-shrinkwrap.json`, so every version stayed the same, and the shrinkwrap is gone (`files` no longer lists it, `.gitignore` no longer hides the pnpm lock). pnpm 10 runs no dependency build script: none is allowed, because `@lydell/node-pty` loads its prebuilt platform package under pnpm's layout too (checked on macOS arm64 and in the image), and the one script pnpm reports (esbuild 0.21, through VitePress) is not needed for `docs:build`, so `pnpm.ignoredBuiltDependencies` names it and the install does not warn. The scripts, CI (`pnpm/action-setup`, `cache: pnpm`, `pnpm install --frozen-lockfile`), Renovate (one `pnpm` group for `packageManager` and the Dockerfile's `PNPM_VERSION`) and the user docs say pnpm. 10.8 changes: `check-pack.mjs` runs the pnpm that runs it (`npm_execpath`), steps 2 and 3 are `pnpm dlx file:<tgz>` and `pnpm add file:<tgz>`, and its clean PATH links `sed`, `dirname` and `uname` because pnpm's bin shims call them. The tarball no longer holds a lock file (pnpm neither packs nor reads one in a package), so the file list does not require one: `pnpm dlx` and `pnpm add -g` get the exact versions of the direct dependencies and resolve the rest at install time, and the Docker build installs the tarball's dependencies with `--prod --frozen-lockfile` from the repository's lock (2.9, Dockerfile step 1). The image installs Claude Code with `corepack pnpm@${PNPM_VERSION} add --global --allow-build=@anthropic-ai/claude-code` and keeps no pnpm; gonogo lives in `/opt/gonogo`. Built in the Lima VM (linux/arm64): `claude --version`, `docker --version`, `gonogo --version` and the pty check pass, 1.13 GB.

### Dependency advisories (2026-11-17)

`pnpm audit` found 10 advisories, all in devDependencies: VitePress 1.6.4 pulled vite 5.4.21 (dev server path traversal and `server.fs` bypasses, launch-editor issues, cross-origin script execution) and esbuild 0.21.5. VitePress is now `2.0.0-alpha.21` (the `next` tag), which uses the project's vite 8.3.8, so vite 5 and esbuild left the lock and `pnpm.ignoredBuiltDependencies` is gone. `pnpm docs:build` passes with the dead-link check on; the built site was compared with the 1.6.4 build in Chrome (home, Clean Room page, local search, dark mode, 390 px): same pages, same theme, no console error, no sideways scroll at 390 px; the one visible change is a slightly larger hero logo on the home page. Left: picomatch 4.0.7 under vite (ReDoS, GHSA-fc5q-39xc-vjpf) has no patched release, so no override can fix it; it is a build-time dependency. `pnpm audit --prod` finds nothing, and the image holds production dependencies only.

Renovate (same day): security updates are on (`vulnerabilityAlerts` with the label `security`, any time of day, and `osvVulnerabilityAlerts` for advisories from OSV); a package rule on `isVulnerabilityAlert` gives them `prPriority` 10, because Renovate's validator accepts `prPriority` only in `packageRules`. The GitHub Actions stay one group. `renovate-config-validator` (Renovate 44.247.1, through `pnpm dlx`) passes.

Image workflow (same day): `.github/workflows/image.yml` builds linux/amd64 on `ubuntu-24.04` and linux/arm64 on `ubuntu-24.04-arm`, natively (QEMU is gone), on every pull request and push to main, without a push. On a `v*` tag each platform is pushed to `ghcr.io/<repository>` by digest only (`push-by-digest=true,name-canonical=true`) and uploads its digest as an artifact; a `merge` job joins them with `docker buildx imagetools create` under the metadata-action tags (`<version>`, `<major>.<minor>`, and `latest` for a tag without a pre-release suffix). The manifest list carries metadata-action's OCI annotations (source, description, licence, version; `DOCKER_METADATA_ANNOTATIONS_LEVELS: index`); each platform image keeps the labels. Only `publish` and `merge` hold `packages: write`. Checked with actionlint 1.7.12; no tag was pushed, so the publish path has not run.

Old name, last traces (same day): `docs/facts/prior-art-notes.md` names the reference product's state hook and nudge files by placeholders (`renderer/hooks/<state hook>.ts`, `shared/<nudge>.ts`, like `main/<core>.ts`), with every line number kept; `docs/themes.md` says "a bee colony". The guard in `test/repo-files.test.ts` now fails on the old name anywhere, inside a word too, unless "arc" comes before it.

### Static fire and second positions (2026-11-18)

Max Q reading (b), the stress ritual, as Static fire (spec `docs/static-fire-spec.md`). Protocol: `PollRequest.subject`, `PollView.subject` (absent on a T-minus poll), `STATIC_FIRE_POSITIONS` (`simsup`, `retro`). Hub: `startPoll` with a subject briefs every running agent with the gonogo tools in those positions (`Static fire: <subject>`, one body for SIMSUP, one for RETRO), refuses `agents` with it (400, field `agents`), a subject that is empty or longer than `SUBJECT_MAX_CHARS - 13` (400, field `subject`) and an empty crew (`no SIMSUP or RETRO is running`). `settlePoll` keeps a static fire `open` until every entry voted, then go or hold as T-minus; the boss is not told. Abort says `Static fire: aborted`. `publishPoll` posts `Static fire on <subject>: <STATUS>: <note> · <agent>: <reason> ...` as a `tminus` Downlink event. `web.ts` passes `subject` (text, else 400 field `subject`). Client: `wall.ts` `fireTargets` and `pollHeading`; `noteLine` starts with the subject; the T-MINUS block has a subject field and a STATIC FIRE key while no poll is on the wall (disabled, with a line saying why, when no SIMSUP or RETRO runs); the announcer names a static fire. `go_nogo`'s description names Static fire.

Second agent in a position: decided as the hire form already does it. Positions are presets, not seats; picking a taken position fills the name with the first free `<id>-2`, `<id>-3`, ... (`suggestName`, `form.ts`), and the hub stays the judge of unique names (409 `an agent named "<name>" already exists`).

### Hold and Telemetry (2026-11-18)

Two backlog items (`docs/backlog.md` sections 4 and 7; spec `docs/telemetry-spec.md`). Protocol: `HOLD_REASON` (`on hold`), `ToolCall`, `TELEMETRY_PER_AGENT` (200), `Hub.hold`, `HubIo.toolHook?` (optional, so the fakes do not change). Hold reuses Redline: `tripRt` takes a by-hand flag that stores `HOLD_REASON` as the reason instead of `redline: ...`, writes the held note `held: <name> is on hold` and posts no Downlink event; `Hub.hold` is a `conflict` unless the agent has hooks and is `idle` or `working` with no transition, and `Hub.resume` ends it as any trip. The hub hands every `PreToolUse`, `PostToolUse` and `PostToolUseFailure` of the current process to `HubIo.toolHook` (a throw there is logged and ignored). New file `src/server/telemetry.ts` (`createTelemetry`: pairs by `tool_use_id`, else the oldest open call of the tool; `TELEMETRY_FILE_SLACK` 2000). Routes: `POST /api/agents/:name/hold`, `GET /api/agents/:name/telemetry` (`{ calls }`, newest first). File: `telemetry.jsonl`, a log with no version. Client: a Hold key in the console's actions, ON HOLD on the tile, chip, flood and foot (with STOP and RESUME in the foot of any tripped console), and a TELEMETRY fold under the terminal. Tested with the stand-in agent only.

### Patch Panel, Flight Rules and Commissioning (2026-11-18)

Section 9 of the backlog: the command bar and the onboarding with a settings screen (spec `docs/shell-spec.md`). Client only: no route, frame, protocol type or state file changed.

- 8 client: `store.view` gains `rules` and `showRules`. `shell.ts` (pure): `commands`, `fuzzyCost`, `matchCommands`, `isPanelKey`, `stepIndex`, and Commissioning's `readMarks`, `showCommissioning`, `commissioningSteps`. `PatchPanel.tsx` (`patch.css`): a modal `<dialog>` with a combobox over a listbox, opened by Cmd/Ctrl+K, a round key in the top bar and PATCH in the phone bar; it runs only actions the page already had (`openConsole`, the views, `openHire`, the brief box, `api.startPoll`, `api.markAllRead`, `api.selectLivery`). `Rules.tsx` (`rules.css`): the FLIGHT RULES view (the wall's `MaxQ` and `Propellant`, now exported from `WallView.tsx`, and keys to Livery, Launch Window and each console's Edit) and the COMMISSIONING module above the room while FLIGHT is the only console.
- Commissioning is remembered per browser (`localStorage` `gonogo.commissioning`, a JSON array of `away`, `note`, `livery`), not on the server: a convenience, no state file or migration.
- Shell: the top bar's gap is 8 px (was 10) so that nine keys stay on one line at 1280 px; the phone bar has eight keys (gap 3 px, side padding 6 px, each 45 px wide at 390 px). On a phone the Flight Rules view shows the Propellant module the phone's wall hides.
- Tests: `test/client-shell.test.ts`. Checked in Chrome with the stand-in agent at 1280 px and 390 px (Instrument and Night Shift): Cmd+K, filter, Enter, Esc, focus return, Put away. Not run: Firefox, Safari, a screen reader, a real phone.

### Relief (2026-11-18)

A boss that hires agents by itself, only with the Director's GO (`docs/backlog.md` section 4; spec `docs/relief-spec.md`). Protocol: `RELIEF_MODES` (`default`, `acceptEdits`), `ReliefRequest` (`id`, `by`, `at`, `expiresAt`, `name`, `position`, `role`, `dir`, `provider`, `mode`, `cleanRoom`), `ReliefView` (`{ requests }`), the `relief` frame (`ReliefFrame`, the whole view; also in `HubEvent` and `ServerFrame`) and `StateSnapshot.relief?` (absent from an older server and from one without Relief: the page shows none); `MCP_TOOL_NAMES` gains `hire_agent` and `DOWNLINK_EVENT_KINDS` gains `relief` (the chip `RELIEF` in `inbox.ts`; Relay does not forward it). New file `src/server/relief.ts` (`createRelief`, `insideRealpath`); no change in `hub.ts`: the requests are kept outside it and the hub is used through `views`, `hire` and `sendFromUser`. `constants.ts`: `RELIEF_PENDING_MAX` 3, `RELIEF_RATE_MAX` 5, `RELIEF_RATE_WINDOW_MS` 10 minutes, `RELIEF_TTL_MS` 30 minutes, `hire_agent` in `ALLOWED_TOOLS` and `MCP_DESCRIPTIONS`. Nothing is saved: no file, no version, no migration.

- 3.3 REST (browser token): `GET /api/relief` (the view), `POST /api/relief/:id/go` and `POST /api/relief/:id/no-go` (no body; 200 with the view). A gone or malformed id is 404, a hire that fails at the GO is the error of `POST /api/agents` (400, 409, ...), and any other path or verb is 404 or 405. An agent token is 401 on all three, like on every `/api` route. Without a `relief` option the routes are 404.
- 3.4 the `relief` frame goes out after every change of the list (a request made, answered or expired).
- 3.6 MCP: twelve tools, `hire_agent { name, position?, role?, dir?, engine?, mode? }` for the boss only (a strict schema: any other field is refused before the handler; `name` 1 to 32, `position` and `engine` and `mode` at most 32, `role` at most `ROLE_MAX_CHARS`, `dir` at most `DIR_MAX_CHARS`). It answers `{ ok: true, id, status: "pending", note }` or an error result `{ ok: false, error }`: not the boss `forbidden`, a stale session `conflict`, `mode` above acceptEdits, `custom` as engine, a bad or taken name (an agent or a waiting request), a position or role missing, a `role` with a control code, a format character (zero width, direction override, Unicode tags) or another character a person cannot see, a folder the form's check refuses, a Clean Room boss outside its folder (`forbidden`), the room full or 3 waiting (`conflict`), a 6th request in 10 minutes (`rate_limited`). Without a `relief` dependency the tool says Relief is not available.
- 4 / 5: after the Director's answer FLIGHT gets a message from `user` with the subject `Relief: <name> is staffed`, `Relief: request for <name> refused`, `... expired` or `Relief: <name> could not be hired`; the wall's MISSION ignores a subject that starts with `Relief:`, as it ignores `T-minus:`. The GO calls `Hub.hire` with `name`, `role`, `dir`, `mode`, `provider`, `position?` and `cleanRoom?` (the boss's own setting), never `confirmBypass`, `command` or `payload`.
- 8 client: a hire request is a flood in `Needs` (`RoomView.tsx` `ReliefNeed`; `relief.ts`; `api.ts` `answerRelief`; `store.relief`), with NO-GO and GO, the rows and the whole role text in a scrolling group (11 em) whose label gives its length; a GO or NO-GO that fails is a red `role="alert"` notice with DISMISS, kept by `Needs` (the block is gone by then); `room.ts` `Facts.relief` makes the live region say `N hire requests wait for your go` when the count grows; `.needs-dock` scrolls past 55vh. No new top-bar or phone-bar key. `positions.ts`: the FLIGHT role text names `hire_agent`.
- Tests: `test/relief.test.ts` (40 tests: every limit and abuse case, on a fake hub and a fake clock with real folders and links), a `describe('relief')` in `test/edge.test.ts` (routes, token rule, tool schema), `test/client-relief.test.ts`, scenario 31 of `test/e2e.test.ts`. The stand-in agent has `@fake relief hire_agent <json>` (the code of `@fake task`) and the tool in its allowed list; `launcher.test.ts` expects it in the argv. Not run: a real `claude` asking for a hire, a Clean Room GO on real Docker, Firefox, Safari, a screen reader. The block was opened in Chrome (a tab of its own) at 1440 px and at 390 px, Instrument and Night Shift, against a real server with the stand-in agent: three requests at once, GO and NO-GO pressed, no horizontal overflow, keys 48 px high, the agent hired and the Downlink lines there; the keys were pressed by script.
- Waking idle workers that hold unread mail (the second item of backlog section 4): checked and already covered, no code. See 5.3 (the delivery check runs again at every sweep for an idle agent whose queue is not empty), 5.5 (`redeliver`: a message delivered and not read gets one more pointer at every turn end, `Stop`, `StopFailure`, R1 and R2, then a visible `not read` note) and `test/hub.test.ts` ("redeliver"), scenario 17 of `test/e2e.test.ts`. What is not retried is a pointer that was typed and not confirmed within 2 s: that is held on purpose (5.4), because a second paste could put two pointers in one box.

### Mass Budget and Star Chart (backlog section 3, 2026-11-18)

Two features on the memory of the room; specs `docs/mass-budget-spec.md` and `docs/star-chart-spec.md`. Semantic search, the third item, is not built (no model ships; `docs/mission-log-spec.md`, Rejected). No saved state changes: no file gets a new field, `memory.md.bak` has no version, so `migrate.ts` is untouched.

- Protocol (`src/shared/protocol.ts`, additive): `ChartNode`, `ChartEdge`, `LogChart`, `MemoryView`, `ReflectResult`. No frame, no `StateSnapshot` field.
- Mass Budget (`src/server/massbudget.ts`, wired in `cli.ts`, `WebOptions.massBudget`): `GET /api/agents/:name/memory` and `POST /api/agents/:name/reflect` (201). gonogo never writes `memory.md`. It reads it with `O_NOFOLLOW | O_NONBLOCK` (a link or a non-regular file is a 409, at most 1 MiB), sends one `Hub.sendFromUser` message `Mass Budget: condense your memory file`, and puts the bytes it read in `memory.md.bak` (temporary file, then rename) only when the hub took the message. Soft limit 200 lines or 16 KiB, target 100 lines, constants in `massbudget.ts`. The panel is `MassBudget.tsx` (`mass.ts`, `mass.css`) in `ConsolePanel`, and under MORE in `PhoneConsole`.
- Star Chart (`src/server/logchart.ts`, `MissionLog.chart()`, `GET /api/log/chart`, `Pick<MissionLog, ... 'chart' ...>` in `WebOptions`): the newest 150 entries, their 40 most used tags and their authors; edges for tags, authors, mentions of an id (`l12`) and tags that meet in two entries. The layout is `src/client/chart.ts` (deterministic), the drawing and the lists `StarChart.tsx`, `chart.css`; the Mission Log page got a switch ENTRIES, CHART, LINKS.
- Tests: `test/massbudget.test.ts`, `test/logchart.test.ts`, `test/client-mass.test.ts`, `test/client-chart.test.ts`, the chart route in the `mission log` block of `test/edge.test.ts` (its fake gained `chart`), and scenario 31 of `test/e2e.test.ts`.
