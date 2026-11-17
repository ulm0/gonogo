# Claude Code in a pseudo-terminal: facts for gonogo

Job: tui-pty. Date of the experiments: 2026-11-16. Written for the people who build gonogo. Every statement is tagged
**VERIFIED** (with the command or document that proves it) or **UNVERIFIED** (with the reason). Sample sizes are small and are
given where it matters. Nothing here was copied from the reference app.

## 0. Environment and method

| Item | Value |
|---|---|
| `command claude --version` | `2.1.325 (Claude Code)` |
| claude binary | `/opt/homebrew/bin/claude` -> `/opt/homebrew/Caskroom/claude-code@latest/2.1.325/claude` (Mach-O arm64) |
| Machine | macOS 27.0.1 (Darwin 27.0.0), arm64 |
| Node / npm | v24.18.0 / 11.16.0 (also run on Node v22.21.1 and v24.14.0) |
| Model for every real run | `--model haiku` (resolved by claude to `claude-haiku-5-5`, shown as "Haiku 5.5") |
| Pty library used by the harness | `@lydell/node-pty@1.2.0-beta.18` |
| Emulator used for screen reading | `@xterm/headless@6.0.0` with `@xterm/addon-serialize@0.14.0` |
| Docker | not available (the Lima daemon was not running and was not started). Nothing in this file was run on Linux. |

Method. A small Node harness (scratch folder, not part of the project) starts claude in a pty, records every output byte with a
millisecond timestamp, feeds the bytes into a headless xterm to read the screen, and reads a hook log written by a command hook.
62 claude sessions were started. Only 10 messages were ever submitted to a session (section 1), so the run budget was respected.

Inherited variables removed before every launch (listed with `env | grep -i claude`): `CLAUDECODE`, all eleven `CLAUDE_CODE_*`
variables of this session (ENTRYPOINT, ENABLE_AUTO_MODE, TMPDIR, MESSAGING_SOCKET, MESSAGING_TOKEN, BRIDGE_SESSION_ID, EXECPATH,
SESSION_ID, CHILD_SESSION, SESSION_ATTENDED), and also `AI_AGENT`, `CLAUDE_PID`, `CLAUDE_EFFORT` (they matched the grep and could
change behaviour). `TERM=xterm-256color` and `COLORTERM=truecolor` were set.

Exact launch used by every session unless a section says otherwise:

```
file : /opt/homebrew/bin/claude
argv : --model haiku --settings <scratch>/settings/probe-hooks.json --permission-mode default --session-id <fresh uuid>
pty  : { name: 'xterm-256color', cols: 120, rows: 40, cwd: '<project>', encoding: null }
env  : this process env minus the variables above, plus TERM, COLORTERM, and four DH_* variables read by my hook script
```

The settings file (hooks only; the command is a Node script that writes the stdin it receives to a log with a timestamp):

```json
{
  "hooks": {
    "SessionStart":        [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" SessionStart" }] }],
    "UserPromptSubmit":    [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" UserPromptSubmit" }] }],
    "UserPromptExpansion": [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" UserPromptExpansion" }] }],
    "PreToolUse":          [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" PreToolUse" }] }],
    "PermissionRequest":   [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" PermissionRequest" }] }],
    "PermissionDenied":    [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" PermissionDenied" }] }],
    "PostToolUse":         [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" PostToolUse" }] }],
    "PostToolUseFailure":  [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" PostToolUseFailure" }] }],
    "Notification":        [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" Notification" }] }],
    "Stop":                [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" Stop" }] }],
    "StopFailure":         [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" StopFailure" }] }],
    "SessionEnd":          [{ "hooks": [{ "type": "command", "command": "\"$DH_NODE\" \"$DH_HOOK\" SessionEnd" }] }]
  }
}
```

For tests that must not reach the model, the hook script answered `UserPromptSubmit` with
`{"decision":"block","reason":"probe-block"}` (documented: https://code.claude.com/docs/en/hooks, UserPromptSubmit). Blocked
prompts never reach the model. Variants of the file added `"respondToBashCommands": false`, `"promptSuggestionEnabled": false`
or `"tui": "default" | "fullscreen"` where stated.

Two settings of this machine shape everything below and must be kept in mind: the user's `~/.claude/settings.json` has
`"tui": "fullscreen"` (alternate-screen renderer) and `"permissions": {"defaultMode": "auto"}`, `remoteControlAtStartup: true`, a
custom `statusLine`, and plugin hooks. Both renderers were therefore tested (fullscreen = this machine's default, classic = forced).

## 1. Run ledger (every real or submitted message)

Budget: at most 10 short prompts, all with `--model haiku`. Result: **10 messages submitted, 3 of them real model calls.**
One further attempt never reached claude because my script had already exited it, and is not counted. The row numbers below are
the ones used as "ledger #N" in the rest of this file (the scratch ledger file has one more row because of that attempt).

| # | Session label | What was submitted | Model call? |
|---|---|---|---|
| 1 | s1-early-fs | `EARLY-MSG alpha é 日本` written 2 ms after spawn, then a late CR (hook-blocked) | no |
| 2 | tf-fs | raw `SW1 same write text` + CR in one write (hook-blocked) | no |
| 3 | inv-fs | bracketed paste `inv<U+200B>isible zero-width`, CR after 150 ms (hook-blocked) | no |
| 4 | s2-paste10k-fs | 10,240-byte bracketed paste + CR in the same write (hook-blocked) | no |
| 5 | s3-raw10k-fs | the same 10,240 bytes typed raw + CR in the same write (hook-blocked) | no |
| 6 | s4-slash-fs | pasted `/probe-unknown arg1\nsecond line of the message` + CR (consumed by the TUI as a command) | no |
| 7 | real-fs (R1) | `Create a file named probe-perm-delete-me.txt in the current directory containing the word hi. Do nothing else.` then denied with Esc | **yes** |
| 8 | real-fs (R2) | `reply with the single word ok` | **yes** |
| 9 | bang-heavy-fs | pasted shell-mode command `!for i in $(seq 1 500); do echo "probe line $i of 500 ..."; sleep 0.05; done; sleep 7771` (no model call because `respondToBashCommands:false`) | no |
| 10 | real-classic | `reply with the single word ok` in the classic renderer, with `promptSuggestionEnabled:false` | **yes** |

The file `probe-perm-delete-me.txt` was never created (checked after R1 with `ls`; the project folder holds only `docs/`).
No stray claude, MCP or sleep process was left running (checked with `ps`).

---

## 2. node-pty on this machine (question 1)

### 2.1 `npm install node-pty` (latest) loads without compiling, but cannot spawn on macOS

- **VERIFIED** (`npm view node-pty dist-tags --json`): `latest` is `1.1.0`; `beta` is `1.2.0-beta.18`.
- **VERIFIED** (`npm install node-pty --foreground-scripts --loglevel=verbose` in a fresh folder): the install script
  `node scripts/prebuild.js || node-gyp rebuild` printed `> Checking prebuilds...` and exited 0, so `node-gyp` never ran; the
  `postinstall` script printed `SKIPPED (not Windows)`. Install time 0.5 s. `prebuilds/darwin-arm64/pty.node` is the file loaded.
- **VERIFIED**: the helper `prebuilds/darwin-arm64/spawn-helper` (and `darwin-x64`) has mode `-rw-r--r--` after install, and
  `pty.spawn('/bin/echo', ['hello-from-pty'])` throws `posix_spawnp failed.`.
- **VERIFIED** (`tar -tvzf node-pty-1.1.0.tgz`, the file downloaded with `npm pack node-pty@1.1.0`): the published tarball itself
  stores both `spawn-helper` files as `-rw-r--r--`. The bit is lost at publish time, not by npm, so no install path can keep it.
- **VERIFIED**: the helper mode stays `644` when node-pty 1.1.0 is installed (a) with `npm install` in a project, (b) with
  `npx --package ./probe-np-latest-1.0.0.tgz probe-np-latest` where the probe package depends on `node-pty@1.1.0` (helper at
  `<npm cache>/_npx/<hash>/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`, mode 644, output
  `{"ok":false,"error":"posix_spawnp failed."}`), (c) with `npm install -g --prefix <scratch> <probe tarball>`, (d) with
  `npm install ./node-pty-1.1.0.tgz`, (e) with `npm install --ignore-scripts`. The spawn itself was run and failed in (a), (b)
  and (e); in (c) and (d) only the mode was read (644). The package has no script that fixes the mode.
- **VERIFIED**: workaround that works: `chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`; afterwards the spawn
  returns `hello-from-pty`, exit code 0, in about 220 ms. In an app this means a guard such as
  `fs.chmodSync(<helper path>, 0o755)` before the first spawn. It only works if the process owns the file; a root-installed global
  package run by a normal user cannot chmod it. A `postinstall` of gonogo would have to do it, and npm 11.16 already prints
  `npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts` for node-pty, which suggests
  install scripts may stop running by default in a later npm. (The warning is VERIFIED; the "later npm" reading is UNVERIFIED.)

### 2.2 node-pty 1.1.0 has no Linux prebuilds

- **VERIFIED** (`tar -tzf node-pty-1.1.0.tgz | grep -i linux` prints nothing; listing of `prebuilds/`): the tarball ships
  `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64` only.
- **VERIFIED** (I ran the package's real `scripts/prebuild.js` with `process.platform`/`process.arch` overridden): on `linux-x64` and
  `linux-arm64` it prints `Rebuilding because directory .../prebuilds/linux-x64 does not exist` and exits 1, so the install script
  falls through to `node-gyp rebuild`, which needs python3, make and a C++ compiler. On `darwin-*` it exits 0.
- **UNVERIFIED**: an actual `npm install node-pty` on a compiler-less Linux machine (no Docker daemon). The failure is inferred
  from the shipped script above.

### 2.3 node-pty `1.2.0-beta.18` (the `beta` tag) fixes both problems but is a beta

- **VERIFIED** (`tar -tvzf node-pty-1.2.0-beta.18.tgz`): `spawn-helper` is `-rwxr-xr-x` for darwin-arm64 and darwin-x64, and the
  tarball contains `prebuilds/linux-arm64/pty.node` (69,096 bytes) and `prebuilds/linux-x64/pty.node` (71,784 bytes). The
  tarball is 7.15 MB; installed it is 26 MB (1.1.0: 15.5 MB tarball, 62 MB installed).
- **VERIFIED**: installs with mode 755 and spawns correctly via `npm install node-pty@beta`, via `npx --package <probe tarball>`,
  and with `--ignore-scripts`.
- It still carries the same `install`/`postinstall` scripts, and it is a prerelease, so a caret range such as `^1.1.0` would not
  select it; it must be pinned exactly.

### 2.4 `@lydell/node-pty` (prebuilt-binary fork)

- **VERIFIED** (`npm view @lydell/node-pty`): `latest` and `beta` are both `1.2.0-beta.18`; `optionalDependencies` lists
  `@lydell/node-pty-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-arm64,win32-x64}` at the same version.
- **VERIFIED** (`tar -xzOf lydell-node-pty-1.2.0-beta.18.tgz package/package.json`): the main package has **no `scripts` field at
  all** (nothing to compile, nothing for npm's script gating to block). Its tarball is 5,563 bytes (`index.js`, `package.json`,
  `README.md`, `node-pty.d.ts`). `index.js` requires `@lydell/node-pty-${process.platform}-${process.arch}` and, if it is missing,
  throws an error that names `--omit=optional` and "node_modules copied between operating systems (Docker, WSL)" as causes.
- **VERIFIED** (tarball listings): each platform package is 31-36 KB. The darwin ones contain `spawn-helper` as `-rwxr-xr-x` and
  `pty.node`; the linux ones contain only `prebuilds/linux-x64/pty.node` or `prebuilds/linux-arm64/pty.node`. Their `package.json`
  has `os` and `cpu` fields and **no `libc` field**.
- **VERIFIED** (`npm install @lydell/node-pty`): installs only `@lydell/node-pty` and `@lydell/node-pty-darwin-arm64` (224 KB in
  total), no scripts, helper mode 755, spawn works. Also works with `--ignore-scripts` and through
  `npx --package <probe tarball>` (spawn run), and the helper is mode 755 in an `npm install -g --prefix` install (spawn not run
  there). With `--omit=optional` it fails at `require` with the explicit
  message above. `npm install --os=linux --cpu=x64` selects `@lydell/node-pty-linux-x64`, `--cpu=arm64` selects
  `@lydell/node-pty-linux-arm64`, `--os=darwin --cpu=x64` selects `@lydell/node-pty-darwin-x64`.
- **VERIFIED** (`file` and `strings` on the extracted ELF files, not executed): the Linux binaries of the fork and of node-pty
  `1.2.0-beta.18` are the same builds (identical BuildID: x64 `c51ec0f7b71029035c7c949b77c1b04f040cbaba`, arm64
  `64113da75cd63610301d4f7591f2000577e86085`). They are dynamically linked against `libc.so.6`, `libpthread.so.0`, `libutil.so.1`,
  `libstdc++.so.6`, `libgcc_s.so.1`, and use glibc symbol versions up to `GLIBC_2.28`. They therefore need glibc 2.28 or newer
  (Debian 10+, Ubuntu 18.10+, RHEL 8+) and will not load on Alpine (musl). Because the platform packages have no `libc` field, npm
  will still install them on Alpine and the failure appears at load time.
- **VERIFIED**: Node v22.21.1, v24.14.0 and v24.18.0 on macOS arm64 run the fork and node-pty beta (smoke test). Node 20 is not
  installed here: **UNVERIFIED** (the addons are N-API, so it is expected to work).
- The fork's API matched what the harness needed: `spawn`, `onData`, `onExit`, `write`, `resize`, `kill`, `destroy`,
  and the `encoding: null` option (Buffers) all worked.

### 2.5 Answer: which dependency is safer

`@lydell/node-pty` pinned to the exact version `1.2.0-beta.18`. Reasons that were verified: correct executable bit on macOS in
every install path, Linux x64 and arm64 binaries present, no install scripts, only the matching platform's ~35 KB package is
downloaded. Costs: it is a prerelease of a single-maintainer fork (pin exactly; `npm i @lydell/node-pty` does pick it because
its `latest` tag points to it), glibc-only on Linux, and `--omit=optional` breaks it. `node-pty@latest` (1.1.0) is not usable:
no Linux prebuilds and a non-executable helper on macOS. `node-pty@1.2.0-beta.18` is an acceptable second choice (same binaries)
but is larger, still has install scripts and still needs the chmod guard as a belt-and-braces measure.

---

## 3. Starting claude in a pty (question 2)

### 3.1 Argv and environment

- **VERIFIED**: the launch in section 0 starts claude interactively. `--permission-mode default` is accepted although `--help`
  lists `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`; the hook payloads report `"permission_mode":"default"` and
  the footer shows `⏸ manual mode on`. (`--permission-mode manual` was not run: **UNVERIFIED**.) Pass the mode explicitly: this
  machine's settings say `defaultMode: auto`, and without the flag the session would not be in manual mode.
- **VERIFIED**: these variants all started claude normally, drew the same screen and fired SessionStart at 0.40-0.42 s:
  no `LANG`/`LC_*` at all; `LC_ALL=C`; `TERM=xterm` without `COLORTERM`; and a minimal environment of only `HOME`, `PATH`,
  `TERM`, `USER`. The box-drawing characters and the prompt glyph are still emitted as UTF-8 in the C locale. (Shell-mode commands
  with a minimal environment were not run: **UNVERIFIED**.)
- **VERIFIED**: size is taken from the pty (`cols`, `rows` at spawn). `pty.resize()` makes claude repaint completely within about
  100-200 ms (section 6).
- **VERIFIED**: the first ~0.3 s after spawn the tty is in cooked mode (`stty -a` in a node-pty child: `icanon echo icrnl imaxbel`).
  Claude switches it to raw mode itself.

### 3.2 What claude writes at startup (fullscreen run, times after spawn)

```
+210 ms  (first bytes: ESC[?25h)
+307 ms  ESC[?2004h  ESC[?2031h  ESC[?1004h        bracketed paste, colour-scheme reports, focus events: raw mode is on
+307 ms  ESC]0;✳ Claude Code BEL                    window title, idle glyph
+323 ms  ESC[?1049h ESC[?1000h ESC[?1002h ESC[?1003h ESC[?1006h     (fullscreen only) alternate screen + mouse reporting
+423 ms  ESC]11;?BEL  ESC[c  ESC[>0q  ESC[?u  ESC]7501;?BEL  ESC[c    queries: background colour, DA1 (twice), XTVERSION, kitty keyboard, OSC 7501
```

- **VERIFIED** (stream captures of fullscreen and classic sessions, including `real-fs` and `real-classic`): this order was seen in
  every session I inspected; in the classic renderer the `?1049h` and mouse lines are absent. The terminal title is set with OSC 0 and
  BEL; on exit claude sets an empty title.
- **VERIFIED** (obs1-default vs obs3-fs-respond): claude does not wait for answers to those queries. With no answers, and with the
  headless emulator answering DA1 (`ESC[?1;2c`, the only query xterm.js headless 6.0.0 answered), startup took the same time and
  the reply text did not appear in the input box.
- **VERIFIED** (58 sessions whose startup was captured): `ESC[?2004h` came 0.17-0.64 s (median 0.29 s) after spawn. The first
  output chunk containing the prompt glyph came a median of 13 ms later (range -2 to +27 ms in 57 of 58 sessions; one session that
  also started an MCP server took 479 ms).

### 3.3 Startup screens

- **VERIFIED**: in every run the screen goes straight to the main UI: a 3-line header (`▐▛███▛█   Claude Code v2.1.325`,
  `Haiku 5.5 · Claude <plan>`, `<project> · /rc`), then banners (section 8), then the input box and a footer.
- **VERIFIED** (read-only look at `~/.claude.json`): no trust dialog appeared because the parent `<home>/Documents/Projects/personal`
  has `hasTrustDialogAccepted: true` and gonogo's own entry is `false`. Docs say trust of a parent covers subfolders that are
  not nested git repositories (https://code.claude.com/docs/en/permissions, "Project allow rules and workspace trust").
  **The trust dialog itself was never seen, so its wording and keys are UNVERIFIED.**
- **VERIFIED** (https://code.claude.com/docs/en/hooks, "Workspace trust"): in an interactive session claude holds back hooks from
  every settings file until the trust dialog is accepted. So on a first run in an untrusted folder gonogo will get no hooks at all.
- **VERIFIED** (`--permission-mode bypassPermissions --setting-sources project,local`, observed and then exited with Ctrl+C twice,
  nothing accepted): a blocking warning dialog appears at startup:
  `WARNING: Claude Code running in Bypass Permissions mode ... ❯ No, exit / Yes, I accept / Enter to confirm · Esc to cancel`.
  In that run the SessionStart hook did **not** fire (only SessionEnd did, at exit). On this machine the user setting
  `skipDangerousModePermissionPrompt: true` (read from `~/.claude/settings.json`) normally hides it; whether the same key works when it
  comes from a per-agent `--settings` file, and whether answering the dialog once makes claude remember it, are **UNVERIFIED** (I did
  not answer it). Note that the dialog also uses the `❯` glyph for its selected row.
- **VERIFIED** (obs-nosrc-user): with `--setting-sources project,local` (user settings skipped) the same folder gives a clean
  startup with no banners and no status line, in the classic renderer, with the footer `⏸ manual mode on · ? for shortcuts · ← 5 agents`.

### 3.4 How to detect "claude is ready for input"

- **VERIFIED** (58 sessions): the sequence "output contains `ESC[?2004h`" followed within about 30 ms (once 479 ms) by "a screen row
  that starts with `❯` + U+00A0 (a no-break space, not a normal space; checked with code points) sitting between two horizontal
  rules of at least 20 `─`" happened every time, 0.2-0.7 s after spawn. Read the screen with a headless emulator; do not match the
  placeholder text (it is random: `Try "fix typecheck errors"`, `Try "how do I log an error?"`, ...).
- **VERIFIED**: the `❯` glyph alone is not enough: the bypass-permissions dialog, the permission dialog (`❯ 1. Yes`) and the trust
  dialog (per docs) also draw `❯` on a selected row. Require the two rules around a single-line box and the absence of dialog text.
- **VERIFIED**: after readiness the stream is almost silent: 76 bytes in 59 s of idle in the fullscreen run, apart from short
  repaint bursts of about 1-2.6 KB on resize and a statusline refresh. "Wait until the pty is quiet" is therefore unreliable only
  while the status line or a spinner is updating, and is not needed at all if the two signals above are used.

### 3.5 Does SessionStart fire before the input box is usable? Does the gap matter?

- **VERIFIED** (hook log vs stream, 57 sessions with both): the SessionStart hook script starts **after** raw mode in 55 of 57
  sessions: median +114 ms (min -32 ms in the very first cold launch and -17 ms in one other, max +421 ms) relative to
  `ESC[?2004h`; relative to the first prompt frame it is a median +101 ms (range -59 to +196 ms, earlier than the frame in 3 of 57).
  The ordering is therefore not guaranteed; do not use SessionStart as the readiness signal.
- Docs (https://code.claude.com/docs/en/hooks, SessionStart): "SessionStart hooks run in the background. You can type right away
  ... Claude's first response still waits for the hooks to finish". **VERIFIED as documentation only**; the delay of the first
  response was not measured.
- **VERIFIED** (exp-earlykeys, 2 runs): printable keys written every 20 ms from +2 ms after spawn, including about 10 sent before
  raw mode, all reached the input box (69 of 69 and 74 of 74). The kernel buffers them.
- **VERIFIED** (S1, ledger #1): the message `EARLY-MSG alpha é 日本` followed by CR in **one write 2 ms after spawn**: the text arrived
  intact in the box (multi-byte characters included) but the CR did **not** submit, and no UserPromptSubmit fired in 6 s. A CR sent
  later, separately, submitted it and the hook payload was byte-equal to the text.
- **VERIFIED** (non-submitting probe: write `x\` + CR; if the Enter key is processed the backslash becomes a newline and the box
  shows `["❯ x",""]`, if the CR is lost it shows `["❯ x\\"]`): fullscreen, raw mode at +291..+331 ms: lost at +2 ms and +100 ms,
  processed at +200, 280, 320, 360, 450, 700, 1500 ms. Classic, raw mode at +246..+395 ms: lost at +2, +150, +230 ms, processed at
  +260, 300, 450, 1500 ms. One run per point.
- Conclusion: an Enter written before the tty is in raw mode can be lost; text is not. The gap between SessionStart and
  readiness does not matter if delivery waits for the two readiness signals above (the SessionStart hook was later than raw mode in
  55 of 57 runs, and in the other two it was only 17-32 ms earlier; the Enter probes processed a CR written even 100 ms before raw mode
  in the fullscreen run, but **the exact outcome for those two runs is UNVERIFIED**, since a CR there would have cost another
  submitted prompt).

---

## 4. Typing a message in (question 3)

All "paste" below means: `ESC[200~` + text + `ESC[201~` written to the pty (bracketed paste). `\r` means the single byte 0x0D.
Compared against the `prompt` field of the UserPromptSubmit hook payload, which is JSON with the keys
`session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name, prompt`.

### 4.1 Results

| Test | Result |
|---|---|
| (a) Raw text then CR, small: `SW1 same write text\r` in one write, claude idle, ledger #2 | Submitted; hook fired; prompt **byte-equal** (19 bytes). **VERIFIED** (1 sample). |
| (a) Raw text then CR, large: 10,240 bytes, 131 lines, one write + CR, ledger #5 | Submitted (hook after 119 ms) but only **2,196 bytes arrived**: the prompt held two collapsed pastes of 1,034 bytes (12 lines, the start of the text) and 1,025 bytes (19 lines, starting and ending mid-line) and the last ~20 bytes; about 80 % of the text was lost. The input box showed `[Pasted text #1 +11 lines][Pasted text #2 +18 lines]zzzzzzzz`. **VERIFIED** (1 sample). Raw typing of large text is not safe. |
| (b) Bracketed paste, 10,240 bytes, CR in the **same write** (delay 0), ledger #4 | Submitted (hook after 72 ms). After removing the wrapper described below the text is **byte-equal except that each of the 5 tab characters became 4 spaces** (inner 10,255 bytes vs 10,240; `expected.replace(/\t/g,'    ') === received`). Unicode (accents, CJK, Greek, Korean, emoji with ZWJ, combining accent, NBSP), backticks, `$(...)`, `${HOME}`, backslashes, blank lines, leading and trailing spaces, a 400-character line and lines starting with `/` or `!` after the first line all survived. **VERIFIED** (1 sample of 10 KB). |
| (b) Bracketed paste, CR after 150 ms, small text, ledger #3 | Submitted; text equal apart from the invisible character removed (below). **VERIFIED** (1 sample). |
| (b) Bracketed paste + CR in one write, all submissions | The CR was accepted as Enter in 6 of 6 steady-state cases (10 KB, slash command, R1, R2, shell command, classic R2); the slash and shell cases were then handled as commands, see 4.3. |

Minimum delay between the end of the paste and the CR: **0 ms worked** (CR in the same write as `ESC[201~`), in 6 of 6 steady-state
submissions; 150 ms worked in 1 of 1. I found no delay at which it failed in steady state, so I cannot give a positive lower bound.
The only failures were the early ones in section 3.5 and raw large text. Keeping a short gap (30-50 ms) is harmless but its
benefit is **UNVERIFIED**. Hook latency after the CR: 60-120 ms in all runs.

### 4.2 What the TUI does to pasted text

- **VERIFIED** (https://code.claude.com/docs/en/terminal-config "Paste large content", and observed): more than three lines or more
  than 800 characters collapse into a placeholder such as `[Pasted text #1 +130 lines]`; three lines stay visible
  (`paste3` probe: box `["❯ line1","  line2","  line3"]`); four lines (`a CRLF b CR c LF d`) became `[Pasted text #1 +3 lines]` and
  none of the CR, CRLF or LF inside the paste submitted anything (CR inside a bracketed paste is a line break).
- **VERIFIED** (ledger #4 payload): when a collapsed paste is submitted, the hook `prompt` is the text wrapped as
  `\n\n<pasted_content id="efd3">\n` + text + `\n</pasted_content id="efd3">\n` (58 bytes of wrapper, random 4-hex id). The wrapper
  also appeared in the blocked-prompt echo on screen. Docs: Claude is told pasted content "can contain instructions you didn't
  write" and to follow it only where the typed message asks (https://code.claude.com/docs/en/terminal-config, "How Claude treats
  pasted text"; not applied in sessions that do not fetch feature flags). A small single-line paste arrives as plain text with no
  wrapper (ledger #3). A small multi-line paste (up to 3 lines and 800 characters) was not submitted: **UNVERIFIED** whether it is
  wrapped.
- **VERIFIED** (free probes): pastes of 50 KB (512 lines), 200 KB (2,048 lines) and 800 KB (8,192 lines) each showed
  `[Pasted text #N +511 | +2047 | +8191 lines]` after 30, 103 and 139 ms, exactly the number of lines sent. Byte-exactness beyond
  10 KB was not checked (that would need a submission).
- **VERIFIED**: a trailing newline inside a paste is kept as an extra empty line in the input (`["❯ line with trailing newline",""]`).
  What the submitted prompt holds was not checked: **UNVERIFIED**. Trim it.
- **VERIFIED** (ledger #3): the invisible character U+200B inside pasted text was removed before the hook saw it (payload 20 bytes,
  sent 23 bytes) and the screen showed `Removed 1 invisible character from your prompt`; the message was sent in that run.
  Docs (https://code.claude.com/docs/en/interactive-mode, "Invisible characters in prompts") say claude removes tag characters,
  bidi controls and zero-width spaces on Enter, and sometimes puts the cleaned prompt back for review instead of sending
  (`Removed N invisible characters · review and press Enter to send`). That second variant was **not observed**.

### 4.3 Dangers found

- **VERIFIED** (free probe): **text containing the end marker `ESC[201~` escapes the paste.** Input
  `ESC[200~ PRE ESC[201~ ^C POST ESC[201~` left the box as `["❯ POST"]`: the embedded marker ended the paste, the Ctrl+C then acted
  as a key and cleared `PRE`, and `POST` was typed as keystrokes. Any ESC (0x1b) inside a delivered message lets its author send
  keystrokes (Enter, Esc, digits for a permission prompt). Strip ESC and other C0 controls other than `\n` and `\t`.
- **VERIFIED** (S4, ledger #6): a pasted message **starting with `/`** is executed as a command. `/probe-unknown arg1\nsecond line`
  produced `Unknown command: /probe-unknown`, `Args from unknown skill: arg1 / second line of the message`; **no UserPromptSubmit
  fired and nothing reached the model**, the message is simply lost. (Docs: the hook fires for real skills and commands,
  https://code.claude.com/docs/en/hooks.)
- **VERIFIED**: a pasted message **starting with `!`** switches the prompt to shell mode and, on Enter, **runs it as a shell
  command with no permission prompt**. Probe: paste of `!echo probe-bang-ok` without Enter shows `! echo probe-bang-ok` with the
  footer `! for shell mode`; ledger #9 pasted a `!for ...` command with CR, it ran in a `zsh -c` child, no UserPromptSubmit fired, no
  Stop fired, and the title glyph alternated `◐`/`◑` while it ran. Docs: "Pasting text that starts with `!` into an empty prompt enters
  shell mode automatically" (https://code.claude.com/docs/en/interactive-mode, "Shell mode with `!` prefix"). By default claude then
  also answers the command output with a model call (docs); my run disabled that with `respondToBashCommands:false`.
- **VERIFIED**: in raw typing a bare LF (0x0A) inserts a newline (like Ctrl+J), a CR on an empty prompt does nothing, one Ctrl+C
  clears the input and shows `Press Ctrl-C again to exit` for about 0.9 s (a second Ctrl+C inside that window exits claude).
- **VERIFIED** (S1 and probes): an Enter written before the tty reached raw mode is lost (section 3.5).
- **VERIFIED** (R2 screen, fullscreen run with default settings): after a completed turn the box showed `❯ create the file`, a
  grey **prompt suggestion** that looks like typed text in a plain-text read of the screen. Docs: Tab or Right arrow places it, then
  Enter submits it, typing dismisses it; each suggestion costs a background model request
  (https://code.claude.com/docs/en/interactive-mode, "Prompt suggestions"). Whether a bare Enter on an untouched suggestion submits
  it was not tested: **UNVERIFIED**, so never send a blind CR to an input that might hold only a suggestion.
- **VERIFIED**: `"promptSuggestionEnabled": false` in the `--settings` file removed the suggestion (classic run, ledger #10: the
  box stayed `["❯ "]` 1.5 s and 6.5 s after Stop). One run with the setting off and one with it on; the fullscreen run used the
  user default (on).

### 4.4 Recommended recipe (all parts verified above unless marked)

1. Wait for readiness (section 3.4).
2. Sanitize the text: remove ESC and other C0 controls except `\n` and `\t`; turn `\r\n` and `\r` into `\n`; remove zero-width,
   bidi and tag characters; trim leading and trailing whitespace and blank lines; expect tabs to become 4 spaces.
3. Begin every message with a fixed header line (for example `[gonogo] message from ana, id 7:`) so that the first character
   is never `/`, `!`, `?`, `@` or another special trigger.
4. Write `ESC[200~` + text + `ESC[201~` + `\r` as one write (or the CR 30-50 ms later), never raw text beyond one short line.
5. Expect `UserPromptSubmit` within 0.5 s (observed 60-120 ms). If it does not arrive within about 2 s, treat the message as not
   delivered and look at the screen before doing anything else (slash and `!` paths fire no hook by design).

---

## 5. Working, idle and permission prompts (question 4)

Fullscreen run `real-fs`, hooks logged, one session, times in seconds after spawn. Default permission mode (`permission_mode:"default"`).

```
1.95  CR written (R1)                      2.01  UserPromptSubmit
1.98  title  ◐ Claude Code                 2.94  title  ◑ Claude Code   3.13  title  ◑ Probe-perm-delete-me.txt file creation
3.42  PreToolUse (Write)                   3.44  permission dialog is on screen    3.46  PermissionRequest hook
3.43  title  ✳ Probe-perm-delete-me.txt file creation        (✳ again although claude is waiting for the user)
9.49  Notification  {"message":"Claude needs your permission","notification_type":"permission_prompt"}   = 6.0 s after the dialog
9.6   Esc written                          9.69  dialog gone, prompt idle, title ◑ then ✳ within 20 ms     (no Stop, no PostToolUse, no PermissionDenied)
12.69 CR written (R2)                      12.76 UserPromptSubmit     12.78 title ◑
13.68 title ◐                              13.71 Stop  {"stop_hook_active":false,"last_assistant_message":"ok",...}   13.73 title ✳
73.78 Notification  {"message":"Claude is waiting for your input","notification_type":"idle_prompt"}    = 60.1 s after Stop
```

- **VERIFIED**: a permission prompt is announced by the `PermissionRequest` hook 20-40 ms after the dialog is drawn
  (payload: `tool_name`, `tool_input`, `permission_suggestions`, `permission_mode`, `effort`, `prompt_id`), and by the `Notification`
  hook only **6.0 s** later (docs: "has waited about six seconds", https://code.claude.com/docs/en/hooks, Notification).
- **VERIFIED**: the Notification payload **does** distinguish the two kinds: `notification_type` is `permission_prompt`
  (`message` "Claude needs your permission") for the dialog and `idle_prompt` (`message` "Claude is waiting for your input") for
  "idle for a while". `idle_prompt` arrived 60.1 s after Stop (docs: finished responding about 60 seconds ago and no typing since).
  Neither payload has a `title` field in this version. Docs list more types (`auth_success`, `elicitation_dialog`,
  `agent_needs_input`, ...), none observed.
- **VERIFIED**: **a Stop hook does not fire when the user interrupts or denies**: after Esc on the dialog the turn ended
  (`⎿ User rejected write to probe-perm-delete-me.txt`, `✻ Sautéed for 1s · done 1:55 PM`) and in the following 3 s and the
  rest of the session no Stop, PostToolUse, PostToolUseFailure or PermissionDenied event came. Docs agree: "Stop ... Does not run if
  the stoppage occurred due to a user interrupt" (https://code.claude.com/docs/en/hooks). With only the hooks of the design, an
  agent whose permission prompt is denied or interrupted would stay "needs you" until the next prompt.
- **VERIFIED**: the window title is a state signal in the pty stream: `OSC 0` with BEL, `✳ <title>` when claude is not running a
  turn (idle, **and** while waiting at a permission dialog), `◐`/`◑` alternating about once a second while it is working
  (a model turn **or** a shell-mode command). The title text is `Claude Code` until the first prompt, then a short summary made by
  the model (`Probe-perm-delete-me.txt file creation`, `Single word reply`). The glyph flips within 30 ms of the CR and back to
  `✳` within 10-30 ms of Stop. After the deny the glyph went `◑` then `✳` within 20 ms, so the title catches the transitions that
  hooks miss. The first title of a session is `✳ Claude Code`.
- **VERIFIED** (screens): while working the transcript shows a spinner line whose glyph rotates `✳ ✶ ✻ ✽` with a random verb and an
  ellipsis (`✳ Concocting…`, `✽ Whatchamacalliting…`, `✶ Sketching…`), plus, around the Stop hook, `✻ Sketching… (running Stop hook · 0s)`.
  Finished turns end with a line `✻ Worked for 1s · done 1:55 PM` (or a verb such as `Sautéed`, `Cogitated`). A shell command shows its
  last lines, `+126 lines (8s)` and `(ctrl+b to run in background)`. The permission dialog (fullscreen) reads:

  ```
   Create file
   probe-perm-delete-me.txt
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
     1 hi
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   Do you want to create probe-perm-delete-me.txt?
   ❯ 1. Yes
     2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)
     3. No
   Esc to cancel · Tab to amend
  ```

  While the dialog is up the normal input box is not drawn (the two-rule single-line box is gone), so readiness detection correctly
  says "not ready". The classic renderer's dialog was not captured (the classic run was an `ok` prompt).
- **VERIFIED**: stream volume. Fullscreen, thinking phase: 1,360 bytes in 1.4 s (about 970 B/s). Fullscreen shell command with
  one new line every ~0.1 s: 6,445 bytes in 11.5 s. Idle: about 1 B/s, plus a 1-2.6 KB repaint burst per resize. Whole `real-fs`
  session (85 s, 5 resizes): 27,230 bytes; `real-classic` (15 s, 3 resizes): 18,184 bytes.
- **VERIFIED**: UserPromptSubmit does not fire for shell-mode `!` commands (ledger #9) nor for unknown slash commands (ledger #6),
  so a busy agent running a `!` command shows no hook activity, only the `◐`/`◑` title and the running-command screen.
- **VERIFIED** (hook payload keys by event; `scratchpad_dir` and `transcript_path` are present on all):
  SessionStart `source` (`startup`, or `resume` after `--resume`) and `model` (`claude-haiku-5-5`); UserPromptSubmit `prompt`,
  `prompt_id`, `permission_mode`; PreToolUse `tool_name`, `tool_input`, `tool_use_id`, `effort`; PermissionRequest as above;
  Stop `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`; SessionEnd `reason`
  (`prompt_input_exit` for Ctrl+C/Ctrl+D, `other` for signals and master close).
- **UNVERIFIED**: the state after the user **allows** a prompt (expected PostToolUse then Stop), the classic permission dialog, a long
  turn's `(esc to interrupt)` text (turns lasted about 1 s), what a bracketed paste does to a dialog (the design forbids sending one).
- **UNVERIFIED**: OSC 7501. Claude sends the query `ESC]7501;?BEL` at startup; docs say terminals that implement the "OSC 7501
  Program Status Protocol" get working/waiting/done status and then claude leaves the glyph out of the title
  (https://code.claude.com/docs/en/terminal-config, "See session status in your terminal"). I did not answer the query; the reply
  format is unknown to me.

---

## 6. Reconnecting a browser (question 5)

Method. Streams captured from real claude runs (every byte plus resize events, timestamped) were replayed offline. "Live" = a
headless terminal fed everything from the start, i.e. what a browser that never disconnected shows. At every quiet point (no output
for 400 ms; 17 points in the fullscreen run, 8 in the classic run) a "late joiner" was built two ways and compared with "live" on:
viewport text, per-cell character/colour/attributes, cursor position, normal-vs-alternate buffer, and terminal modes
(bracketed paste, mouse, focus, application cursor, wraparound).

- (a) fresh terminal at the current size, fed only the last N bytes of raw output (N = 8, 16, 32, 64 KB, and all);
- (b) fresh terminal at the current size, fed `SerializeAddon.serialize()` of a server-side headless terminal that had received all
  output and every resize (`serialize()` default, `{scrollback:1000}`, `{scrollback:0}`).

| Stream | Bytes | Checkpoints | (a) 8 KB | (a) 16 KB | (a) 32 KB | (a) 64 KB | (a) all | (b) serialize |
|---|---|---|---|---|---|---|---|---|
| `real-fs`: fullscreen, real haiku run, permission dialog, 5 resizes | 27,230 | 17 | 3 of 17 exact | 9 of 17 | 17 of 17 | 17 of 17 | 17 of 17 | **17 of 17** |
| `real-classic`: classic renderer, real haiku run, 3 resizes | 18,184 | 8 | 2 of 8 | 6 of 8 | 8 of 8 | 8 of 8 | 8 of 8 | **8 of 8** |
| `sim-long-fs`: **SIMULATED**, real fullscreen stream whose real thinking-phase frames (1,360 bytes) were looped 60 times | 107,470 | 17 | 2 of 17 | 2 of 17 | 2 of 17 | **2 of 17** | 17 of 17 | **17 of 17** |

**VERIFIED** (`exp-reconnect.js` over the three captures). Details:

- Approach (b) reproduced the live screen **exactly** (text, attributes, cursor, buffer type, modes) at every checkpoint, including
  right after the resizes (120x40 -> 100x30 -> 120x40 and 100x30 -> 80x24 -> 140x45), in both renderers. The serialized string was
  1.8-2.8 KB for a fullscreen screen and 1.9-2.6 KB for the classic one (scrollback included in both); 98 bytes after claude exited. With
  `{scrollback:0}` the classic buffer lost scrollback rows after the resizes (19-22 rows), which is expected. At three
  post-resize checkpoints the re-serialized string differed from the live one although every viewport cell compared equal.
- Approach (a) fails as soon as the stream is longer than the window, and the failure is not only a missing screen. In the
  simulated long stream the 64 KB tail started in the middle of an escape sequence (row 0 contained the stray text `;3H`), the header
  rows were blank (they had been drawn once, more than 64 KB earlier, and fullscreen claude only sends changed cells), 8 rows and
  478 cells differed, the cursor was wrong, the fresh terminal was in the normal buffer instead of the alternate one, and **the
  modes were missing: no bracketed paste, no mouse reporting**. Without bracketed paste mode a browser paste of several lines would
  type each line followed by Enter. After a resize the tail contains a full repaint, so the text was right, but the modes, buffer
  type and cursor were still wrong.
- How soon a 64 KB tail wraps: about 70 s of continuous thinking at the measured 970 B/s, or minutes of an agent that is
  working part of the time. The real runs here were shorter than 64 KB, which is why (a) with 32/64 KB looks fine on them; the
  8 KB and 16 KB columns and the simulation show what happens once the stream is longer than the window. The simulation row is
  synthetic by construction (it loops real frames) and only demonstrates the mechanism.
- Resize case: claude repaints the whole screen after a `pty.resize()` (SIGWINCH); the headless terminal must be resized with the
  pty (`term.resize(cols, rows)`) before the repaint bytes are written. Done that way, (b) was exact after every resize. The addon's
  documentation recommends writing the serialized data into a terminal of the original size and resizing afterwards; creating the
  late joiner at the current size worked in all 25 checkpoints of the two real runs (and in the 17 of the simulation).
- Only one pty size exists. Several browsers with different window sizes cannot all be exact; the design has to say whose size wins
  (not tested).

**Answer: use (b).** Keep one `@xterm/headless` + serialize addon per agent, write every output chunk and every resize into it,
and send `serialize()` (with a scrollback cap in the classic renderer) to a joining browser, then live bytes. A raw 64 KB tail
(a) loses terminal modes and, once the stream passes the window, parts of the screen.

Free extras: `ESC[?1049h` (fullscreen) and `ESC[?2004h` are written once at startup and only re-sent in part later (after a
resize claude re-sends the four mouse modes; after a dialog it re-sent `?2004h`). A server that wants the modes without an
emulator would have to track them itself.

---

## 7. Stopping (question 6)

Setup: idle claude, started with `--mcp-config '<json>' --strict-mcp-config` whose one stdio server is a small Node program that
logs signals and **ignores SIGINT, SIGTERM, SIGHUP and stdin EOF** ("stubborn"), so any death of that child is claude's doing:

```
{"mcpServers":{"probe":{"type":"stdio","command":"<node>","args":["fake-mcp.js","<log>","stubborn"]}}}
```

| Stop action | Time to process gone | onExit | SessionEnd hook | Stubborn child |
|---|---|---|---|---|
| Ctrl+C, Ctrl+C (0.4 s apart) | 2.53 s from the first key | code 0 | `prompt_input_exit` | got SIGINT then SIGTERM about 100 ms apart, then gone (SIGKILL) |
| Ctrl+D, Ctrl+D (0.4 s apart) | 2.64 s | code 0 | `prompt_input_exit` | same |
| `kill -TERM` (node-pty `kill('SIGTERM')`) | 2.41 s | **code 143** | `other` | same |
| `kill -HUP` (node-pty default `kill()`) | 2.09 s | **code 129** | `other` | same |
| `kill -INT` | 2.00 s | code 0 | `other` | same |
| master fd closed (`_socket.destroy()`, kernel hangup) | 2.24 s | **code 129** | `other` | same |
| `pty.destroy()` | 2.25 s | code 129 | `other` | same |
| `kill -KILL` | 25 ms | signal 9 | **none** | **survived** (orphaned; got stdin EOF at +6 ms and a kernel SIGHUP at +106 ms, both ignored by my probe) |

- **VERIFIED** for every row above (`exp-stop.js`, one run each; liveness checked with `kill(pid, 0)` at +0.2, +1 and +3 s).
- **VERIFIED**: claude handles SIGTERM, SIGHUP and SIGINT itself: it runs the SessionEnd hooks, terminates its children (SIGINT, then
  SIGTERM, then SIGKILL for those that ignore them) and exits, in about 2 s. With `--setting-sources project,local` (no user hooks)
  the exit after the second Ctrl+C took about 1.0 s, so the 2 s is mostly user plugin hooks and cleanup.
- **VERIFIED**: the children claude starts are killed on every graceful path: the MCP server, and in ledger #9 (SIGTERM during a
  shell-mode command) the `zsh -c` shell (its own session and process group), its `sleep` child, and a `caffeinate -i -t 300`
  process that claude itself starts, all gone within 200 ms of claude's exit. A long `sleep 7771` as the final command was not
  reached (my loop condition matched the command line of the `zsh -c` wrapper too early), so a bare long-running shell child was not
  separately observed: **UNVERIFIED**, but the shell wrapper and its running child were both killed.
- **VERIFIED**: when the **server** dies and the kernel closes the pty master, claude gets SIGHUP and exits with code 129 after about 2.2 s,
  killing its children; agents therefore end with the server, as the design expects. After SIGKILL nothing is cleaned up and a child that
  ignores SIGHUP and EOF survives.
- **VERIFIED**: on exit claude prints `Resume this session with:` and `claude --resume <session id>` to the normal screen.
- **UNVERIFIED**: `/exit` (it would have cost a submitted prompt; Ctrl+C twice and Ctrl+D twice both gave code 0), SIGTERM while a
  model turn is running, SIGTERM during a permission dialog.
- Docs: Ctrl+D needs a second press within 800 ms; Ctrl+C interrupts a running turn, otherwise the first press clears the input and
  the second exits (https://code.claude.com/docs/en/interactive-mode).

---

## 8. This machine's user hooks and banners (question 7)

What is on screen at startup, in every run with the user's settings (`captures/obs1-default.screens.txt`):

1. `⎿ SessionStart:startup hook error` / `⎿ Failed with non-blocking status code: cat: <home>/.claude/plugins/synced/<uuid>/.../scripts/sta…`
   - a failing `SessionStart` command hook (`cat ${CLAUDE_PLUGIN_ROOT}/scripts/startup-context.txt`) from a plugin synced into
   `~/.claude/plugins/synced/` that points at a missing file. In the first capture it was drawn 0.14 s **after** the first prompt frame
   (0.668 s vs 0.805 s), and it shifts the layout. It contains the word "error". It wraps differently at each window width (it was 3
   lines at 100 columns).
2. A plugin status line above the input box, `● ultra  $0.00  0s    Review  Audit  Board  Details [-]`, whose cost and time update, and the user's own
   `statusLine` command (`user@host \<project> (<kube context>) Haiku 5.5 · medium…`) below it. Both change during a session, so the
   screen is never completely static.
3. `· /rc connecting…` in the header (setting `remoteControlAtStartup: true`), which turns into `· /rc` about 1.2 s later, and `← 5 agents` in the footer.
4. The input placeholder is random per launch (`Try "fix lint errors"`, `Try "how does <filepath> work?"`).
5. After a finished turn the input shows a grey suggestion (`❯ create the file`) unless `promptSuggestionEnabled` is false.

Hooks that are in the settings but **print nothing visible** in the TUI: `herdr-agent-state.sh session` (exits at once unless `HERDR_ENV=1`)
and the other plugins' SessionStart hooks (for example superpowers' `run-hook.cmd session-start`), which add context for the model only; the
first model response waits for them, per the docs. **VERIFIED** by reading `~/.claude/settings.json` and the plugin `hooks.json` files
(read-only) and by the screens above. I did not read every plugin's hook output, so a plugin that only prints in some situations is possible.

What would confuse readiness detection:

- Matching on `error`, on a quiet pty, on the placeholder text, or on `❯` alone. The hook-error lines arrive after the prompt, and the status lines
  keep the pty from being quiet.
- Relying on SessionStart: in these hook-heavy sessions it arrived a median 101 ms after the first prompt frame (range 75-196 ms), but 30-59 ms
  **before** it in 3 of 57 sessions (the first cold launch included).
- The renderer: `tui: fullscreen` puts everything on the alternate screen with mouse reporting; with the user's settings skipped the same
  command started in the classic renderer.
- `permissions.defaultMode: auto` would change the mode and the footer unless `--permission-mode` is passed (it is, above).

How to remove all of it: **VERIFIED** `--setting-sources project,local` gives a clean startup (no banners, no status lines, no `/rc`, footer with
`? for shortcuts`), with the side effect that the user's own hooks, permission rules, plugins and `tui` setting are not used.
**UNVERIFIED**: whether it also skips user-level MCP servers (the test used `--strict-mcp-config` separately).

---

## 9. Other findings that affect the design

### 9.1 Renderer and per-agent settings can be pinned

- **VERIFIED** (one startup each): `CLAUDE_CODE_NO_FLICKER=0` -> classic (normal buffer) even though the user's `tui` is `fullscreen`;
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` -> classic; `CLAUDE_CODE_NO_FLICKER=1` -> alternate screen even with user settings skipped (where the
  default here was classic); `--settings` file with `"tui":"default"` -> classic, with `"tui":"fullscreen"` -> alternate screen, both overriding the
  user setting. Docs: https://code.claude.com/docs/en/fullscreen ("Fullscreen by default": without a setting the renderer depends on the account and
  install date, so different users get different renderers).
- Fullscreen: alternate screen, `?1000/1002/1003/1006` mouse reporting, input fixed at the bottom, only changed cells are sent.
  Classic: normal buffer, history in the terminal's scrollback, no mouse reporting.

### 9.2 Session ids

- **VERIFIED**: `--resume <id>` restores the conversation (screen shows the earlier turns, SessionStart `source:"resume"`).
- **VERIFIED**: `--session-id <id>` for an id that already has a conversation exits at once with code 1 and the message
  `Error: Session ID <uuid> is already in use.`
- **VERIFIED**: `--resume <id>` for an id that never received a prompt (no transcript file yet) or never existed exits at once with code 1 and
  `No conversation found with session ID: <id>`. So "fixed id at first start, resume on restart" fails for an agent that was started but never
  briefed (the boss on a fresh install, for example). Use `--session-id` while no transcript exists and `--resume` once it does.

### 9.3 Other

- **VERIFIED**: the prompt line is `❯` + U+00A0 (no-break space), and the raw stream uses `\r\r\n` line ends.
- **VERIFIED**: claude had started a `caffeinate -i -t 300` child while a shell command was running (seen in the process tree of ledger #9)
  and it was gone after claude's exit.
- **VERIFIED**: hook processes are children of the claude pid (`ppid` in my hook log equals the pty child pid).
- **UNVERIFIED**: Linux behaviour of the claude binary in the Docker image; anything on Windows.

---

## 10. How each answer changes the design document

Document: `docs/superpowers/specs/2026-11-16-gonogo-design.md`. Quoted headings are the design's own.

1. **Distribution > npm** ("The pseudo-terminal library must install without a compiler on macOS and Linux"). Decide now:
   `@lydell/node-pty` pinned at `1.2.0-beta.18`. Not `node-pty@latest` (no Linux prebuilds, non-executable `spawn-helper` on macOS in every install path,
   `posix_spawnp failed`). Add a start-up guard that `chmod`s the helper if it is not executable, regardless of library. Linux support is glibc >= 2.28 only.
2. **Distribution > Docker**: base the image on Debian/Ubuntu, not Alpine (the Linux pty binaries need glibc). `LANG` unset and a minimal environment
   were fine for claude. A session started in `bypassPermissions` shows a blocking warning dialog (SessionStart does not fire while it is up) unless the
   user-level `skipDangerousModePermissionPrompt` setting hides it; handle it (answer it, or detect it with the no-SessionStart timeout of item 5), and
   test whether the key works from the per-agent settings file (not verified).
3. **How it works > Terminals** ("keeps a bounded buffer of recent output. A browser that connects gets the buffer first"). Replace the raw buffer by a
   per-agent headless emulator (`@xterm/headless` + `@xterm/addon-serialize`) fed with every byte and every resize; a joining browser gets `serialize()`
   then live bytes. A 64 KB raw tail loses modes (bracketed paste, mouse, alternate screen) and parts of the screen. Also: pin the renderer through the
   per-agent settings file (`"tui"`) or `CLAUDE_CODE_NO_FLICKER` so the stream format is known; write one pty size (state which browser wins);
   do not forward the server-side emulator's query replies (the browser answers DA1 itself, and claude does not wait for replies anyway).
4. **How it works > Terminals** ("fixed session id at first start and is resumed with it on restart"). Use `--session-id <uuid>` only while no transcript
   exists and `--resume <uuid>` afterwards; `--resume` on a never-briefed agent and `--session-id` on an existing one both exit with code 1.
5. **How it works > Agent state** (the hook table). Add a starting/ready step: ready = `ESC[?2004h` seen + the boxed `❯` prompt row; SessionStart is not a
   readiness signal. Use `PermissionRequest` for "needs you" (20-40 ms), keep `Notification` only as a slow backup (`permission_prompt` +6 s,
   `idle_prompt` +60 s, told apart by `notification_type`; `idle_prompt` is not "needs you"). **A Stop hook does not fire after Esc, a denial or an interrupt**,
   and `!` commands and slash commands fire no UserPromptSubmit: add the OSC 0 title glyph (`◐`/`◑` working, `✳` idle or waiting) as a second source so the
   agent does not stay "working" or "needs you" forever, and so a busy shell command is not mistaken for idle. If no SessionStart arrives within about 5 s
   of spawn while the pty is producing output, show "needs you" (a startup dialog such as the trust dialog, whose hooks are held back, or the bypass warning).
   Use the pty exit event for "stopped"; SessionEnd does not fire on SIGKILL.
6. **How it works > Messages > Delivery rule** and **Risks > Typing into the terminal**. The risk is answered: bracketed paste works (6 of 6 in steady state).
   State the recipe of section 4.4. Add: sanitize ESC and C0 controls (a pasted `ESC[201~` ends the paste and the rest is typed as keys), prefix every
   message so it cannot start with `/` or `!` (a leading `!` runs a shell command with no permission prompt; a leading `/` is swallowed as a command),
   expect tabs to become 4 spaces, expect collapsed pastes (more than 3 lines or 800 characters) to reach the agent wrapped in `<pasted_content id="...">`
   and be treated as pasted, possibly untrusted, content (decide whether to keep short messages under that limit or to lead with a typed sentence).
   Never raw-type more than one short line. Verify with UserPromptSubmit within about 2 s and do not retry with a blind CR.
7. **Anti-goals > typing into a permission prompt**: gate on `PermissionRequest` (immediate), not on `Notification` (6 s late), and on the dialog being
   absent from the screen; the `❯` glyph also marks dialog rows.
8. **Messages > User activity gate**: unchanged, but also hold delivery while the title glyph says working.
9. **Per-agent settings file** ("The server writes a per-agent settings file"): add `"promptSuggestionEnabled": false` (verified to remove the grey
   suggestion; that it also saves the background request is from the docs), `"tui"` if pinning the renderer there, and (to be tested) the
   `skipDangerousModePermissionPrompt` key for `bypassPermissions` agents. Pass `--permission-mode` explicitly. Consider `--setting-sources project,local` to avoid the user's banners, status lines,
   `remoteControlAtStartup` and hook noise (cost: the user's own hooks and rules are not applied).
10. **Stopping** (not written in the design): to stop an agent send SIGTERM (exit code 143, about 2.4 s), then SIGKILL after about 5 s; Ctrl+C twice or
    Ctrl+D twice also exit with code 0. Claude terminates its children itself on every path except SIGKILL, so SIGKILL first would orphan MCP servers and tool processes.
    When the server exits, closing the pty masters makes the agents exit (code 129, about 2.2 s).
11. **Risks > "First run in a new directory shows Claude Code's trust question"**: hooks do not run until it is answered, so the floor cannot rely on hooks to
    flag it; use the no-SessionStart timeout in item 5. The dialog's own text was not seen.

## 11. Unverified, in one list

- The trust dialog (appearance, keys, text) and hook behaviour during it.
- Installing node-pty or `@lydell/node-pty` on real Linux x64/arm64, Alpine, Node 20, and with pnpm, yarn or bun.
- Delivery of a short multi-line paste (up to 3 lines) and of a message with a trailing newline; wrapper behaviour for pastes mixed with typed text; how the model treats `<pasted_content>`.
- Byte-exactness of pastes above 10 KB (line counts were checked up to 8,192 lines only).
- A bare Enter on an untouched prompt suggestion; the "review and press Enter" variant of invisible-character removal.
- The exact moment between spawn and raw mode when Enter starts working (probe results are one run per point).
- Stop and SessionEnd behaviour for `/exit`, for SIGTERM during a running turn or a dialog, and for a long-running shell-mode child at the moment of SIGTERM.
- Hooks after the user allows a permission prompt; the classic renderer's permission dialog; OSC 7501 reply format; Windows; the Docker image's claude binary.
- Whether `--setting-sources project,local` also drops user-level MCP servers.

## Appendix A: exact commands run

`S` is the scratch folder named at the end of this file. npm always ran with `--cache "$S/npm-cache"`, so nothing was written under `~/.npm`.
`CLEAN` stands for `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_ENABLE_AUTO_MODE -u CLAUDE_CODE_TMPDIR -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u AI_AGENT -u CLAUDE_PID -u CLAUDE_EFFORT`.

```
CLEAN command claude --version                                   -> 2.1.325 (Claude Code)
CLEAN TERM=xterm-256color command claude --help                  (flag list: --settings, --setting-sources, --permission-mode, --session-id, --resume, --mcp-config, --strict-mcp-config)

# question 1
npm view node-pty version dist-tags time.modified --json
npm view @lydell/node-pty version dist-tags optionalDependencies engines --json
npm install node-pty --foreground-scripts --loglevel=verbose                # in a fresh folder; also: node-pty@beta, @lydell/node-pty, --ignore-scripts, --omit=optional
npm pack node-pty@1.1.0 node-pty@1.2.0-beta.18 @lydell/node-pty@1.2.0-beta.18 @lydell/node-pty-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}@1.2.0-beta.18
tar -tvzf <tarball>            tar -xzOf <tarball> package/package.json
node pty-smoke.js <package dir>                                    # spawns /bin/echo in a pty, prints JSON
chmod +x <package dir>/prebuilds/darwin-arm64/spawn-helper
npx --yes --package "$S/tarballs/probe-np-latest-1.0.0.tgz" probe-np-latest      # also probe-np-beta, probe-lydell (PROBE_MOD set to the library name)
npm install -g --prefix <scratch> <probe tarball>           npm install ./node-pty-1.1.0.tgz
npm install @lydell/node-pty@1.2.0-beta.18 --os=linux --cpu=arm64 --ignore-scripts      # also x64 and darwin x64
node fake-platform-prebuild.js linux x64 <node-pty>/scripts/prebuild.js        # runs the package's own prebuild.js with a faked platform
file <pty.node>        strings -a <pty.node> | grep -oE 'GLIBC_[0-9.]+'          # extracted ELF files, never executed

# questions 2 to 7 (all through the harness, cwd of claude = the gonogo folder)
node exp-observe.js '{"label":"obs1-default","durationMs":14000,"exitKeys":["\u0003","\u0003"]}'
node exp-observe.js '{"label":"obs2-classic","durationMs":9000,"env":{"CLAUDE_CODE_NO_FLICKER":"0"},"exitKeys":["\u0004","\u0004"]}'
node exp-earlykeys.js '{"label":"early-fs","durationMs":1600,"intervalMs":20}'
node exp-s1-early.js '{"label":"s1-early-fs","atMs":2}'
node exp-early-bs.js '{"label":"ebs-fs-200","atMs":200}'               # non-submitting Enter probe, repeated for the times listed in 3.5
node exp-typing-free.js '{"label":"tf-fs"}'   node exp-typing-free2.js '{"label":"tf3-fs"}'      # non-submitting paste probes
node exp-submit.js '{"label":"s2-paste10k-fs","mode":"paste","text":"10k","delays":[0,1,10,25,50,100,200,400]}'
node exp-submit.js '{"label":"s3-raw10k-fs","mode":"raw","text":"10k","tag":"R","delays":[0,10,50,100,250,500,1000]}'
node exp-submit.js '{"label":"s4-slash-fs","mode":"paste","text":"/probe-unknown arg1\nsecond line of the message","delays":[0],"block":false}'
node exp-real.js '{"label":"real-fs","steps":["r1","r2"],"idleWaitMs":75000}'
node exp-real.js '{"label":"real-classic","env":{"CLAUDE_CODE_NO_FLICKER":"0"},"settings":"probe-hooks-nosuggest.json","steps":["r2"]}'
node exp-bang-heavy.js '{"label":"bang-heavy-fs"}'
node exp-stop.js '{"label":"stop-SIGTERM","how":"SIGTERM"}'              # also ctrlc2, ctrld2, SIGHUP, SIGINT, SIGKILL, master-close, pty-destroy
node exp-reconnect.js "$S/captures/real-fs.stream.jsonl" 400            # also real-classic and sim-long-fs
node make-sim-long.js "$S/captures/real-fs.stream.jsonl" "$S/captures/sim-long-fs.stream.jsonl" 60
node exp-argv.js '{"label":"argv-resume","args":["--model","haiku","--settings","$HOOKS","--permission-mode","default","--resume","<id>"],"env":{"CLAUDE_CODE_NO_FLICKER":"0"}}'
```

## Appendix B: where the evidence is

Scratch folder (may be cleaned): `<scratch>/facts-tui-pty/`
- `scripts/` harness and experiments (`lib/harness.js`, `exp-submit.js`, `exp-real.js`, `exp-stop.js`, `exp-reconnect.js`, ...);
- `captures/*.stream.jsonl` raw output bytes (base64) with timestamps and resize events, `captures/*.snaps.txt` and `*.screens.txt` screen dumps;
- `logs/*.hooks.jsonl` and `logs/payloads/` every hook payload exactly as received, `logs/prompt-ledger.jsonl` the submitted-message ledger;
- `tarballs/` the npm tarballs inspected, `installs/` the probe installs.

---

## Corrections (skeptic)

Written by an independent re-check (job "recheck-tui-pty", 2026-11-16). `command claude --version` printed `2.1.325 (Claude Code)`, the same
build as above; macOS arm64, Node v24.18.0. Everything above this line is unchanged. I read this file and the design, picked the six VERIFIED claims
whose failure would break the build (install behaviour, how text is submitted, hook payload fields, the permission-prompt/Stop behaviour, the
reconnect approach, the session-id flags), and re-ran each with my own harness (`@lydell/node-pty@1.2.0-beta.18`, `@xterm/headless@6.0.0`,
`@xterm/addon-serialize@0.14.0`; scratch folder `<scratch>/recheck-tui-pty/`).
The researcher's scratch files were not used. Result: five of the six claims hold as written. One is wrong in a way that matters and is corrected below.

Run ledger of the re-check (four claude sessions, all `--model haiku`, cwd = the gonogo folder, `TERM=xterm-256color`, inherited `CLAUDECODE`, `CLAUDE_CODE_*`, `AI_AGENT`, `CLAUDE_PID`, `CLAUDE_EFFORT` removed;
the binary was started directly as `/opt/homebrew/bin/claude`, which is what `command claude` resolves to):

| # | argv after `--model haiku --settings <hooks> --permission-mode default` | What happened | Model calls |
|---|---|---|---|
| 1 | `--session-id 8af79d8a-2b57-4176-8c3f-421a40299302` | six pasted prompts, all blocked by my UserPromptSubmit hook (the last two by accident, see the second note below), 4 resizes, exit by Ctrl+C twice | 0 |
| 2 | `--session-id eb9ff3ca-26bc-494a-ad20-0a541ee3e864` | `reply with the single word ok`; a Write request denied with Esc; one `/probe-unknown` paste; exit by Ctrl+C twice | 2 |
| 3 | `--session-id eb9ff3ca-26bc-494a-ad20-0a541ee3e864` (same id again) | exited at once, code 1 | 0 |
| 4 | `--resume 8af79d8a-2b57-4176-8c3f-421a40299302` | resumed, exit by Ctrl+C twice | 0 |

Free commands that start no session: `--version`, `--help`, and `--permission-mode <default|manual|bogus> --help`. `probe-perm-delete-me.txt` was not created
(checked with `ls` of the project folder after each run).

### Correction 1. `serialize()` does not restore every terminal mode (section 6 "Answer: use (b)", section 10 item 3)

Wrong as written: "Approach (b) reproduced the live screen exactly (text, attributes, cursor, buffer type, modes)", and the recipe "a joining browser gets
`serialize()` then live bytes" as a complete reconnect.

Correct fact (VERIFIED: two real fullscreen captures from runs 1 and 2, replayed offline with `node replay.js <capture> 400`; 27 quiet checkpoints in
total, 51,690 bytes with 4 resizes and 19,323 bytes with 2 resizes):

- What the researcher found holds. A fresh terminal at the current size fed `serialize()` equals the live one at 27 of 27 checkpoints, including right
  after resizes, for every cell (character, colours, attributes), the cursor position, the active buffer (alternate or normal), the normal-buffer
  text and the public `terminal.modes` object (bracketed paste, mouse tracking mode, focus reporting, application cursor, wraparound).
- What it does not carry. In the fullscreen renderer claude switches on `?1000 ?1002 ?1003 ?1004 ?1006 ?1049 ?2004 ?2031`. `serialize()` output re-asserts only
  `?1049h`, `?2004h`, `?1004h` and `?1003h`. Missing: **`?1006h` (SGR mouse encoding)**, `?2031h` (colour-scheme reports) and, in 0.14.0, the cursor visibility
  (`?25l` while a permission dialog is up: it differed at 1 of 27 checkpoints). The SGR encoding differed at all 23 alternate-screen checkpoints.
- On the wire (VERIFIED, `mouse-wire.js`, a click at column 40, row 12): the live terminal, with `?1006h`, reports `ESC[<0;41;13M`. A late joiner built from
  `serialize()` has tracking mode "any" but the default encoding and reports the same click as `ESC[M` plus three raw bytes (`1b 5b 4d 20 49 2d`), and
  xterm.js delivers that through `onBinary`, not `onData`. This is not the format claude asked for.
- Claude re-sends the mouse modes after resizes and after some prompt redraws: 9 times in the 51 KB capture (at 0.3 s, 10.9 s, 16.9 s, 17.8 s, 26.8 s, 88.2 s,
  89.1 s, 98.1 s and at exit). The wrong encoding therefore lasts until the next such event; the longest gap in that capture was 61 s (26.8 s to 88.2 s), and an
  idle agent can be silent much longer.
- Fix for the builders: the server must remember the last `CSI ? 1006 h|l` it saw in the pty output (also `?25` and, if wanted, `?2031`) and write the matching
  `\x1b[?1006h` (and `\x1b[?25l`) into the joining terminal after the `serialize()` string. The same holds for `@xterm/addon-serialize@0.15.0-beta.332` with
  `@xterm/headless@6.1.0-beta.336` (VERIFIED: it adds `?25l`, still no `?1006h`).
- UNVERIFIED: how claude reacts to an X10 mouse report (no run left to send one). Treat it as garbage input until shown otherwise.
- The researcher's raw-tail result (a) is reproduced: exact checkpoints for the last 2 KB / 4 KB / 8 KB / 16 KB / 32 KB / 64 KB / all bytes were 0 / 1 / 2 / 5 / 10 /
  18 / 18 of 18 (51,690-byte capture) and 0 / 0 / 2 / 6 / 9 / 9 / 9 of 9 (19,323-byte capture). A tail fails as soon as the stream is longer than the tail
  (in the 8 KB example the buffer type, the modes and 6 rows differed).

### Not corrections: facts that this file marks UNVERIFIED or does not say, found while re-checking

- VERIFIED (run 1): a bracketed paste of exactly three lines (with a tab in line 2) reached the hook as plain text, the tab as four spaces, **no** `<pasted_content>`
  wrapper. A six-line paste arrived wrapped exactly as section 4.2 says: `\n\n<pasted_content id="1366">\n` + text + `\n</pasted_content id="1366">\n`
  (58 bytes of wrapper). This settles the "UNVERIFIED whether it is wrapped" remark for up to three lines (the input box was not empty at that point).
- VERIFIED (run 1): after a UserPromptSubmit hook blocks a prompt, the blocked text comes back into the input box. The next prompt's hook payload began with
  the previous prompt's text, so every later prompt carried the marker and was blocked too. Tests that use the block reply need one blocked prompt per session.
  How to clear the box in a live session was not tried.
- VERIFIED (run 4): `--resume <id>` of a session whose only prompts were blocked by a hook works (`SessionStart` `source:"resume"`, the screen shows the block
  notices, exit 0 after two Ctrl+C). Its transcript file existed (25 lines: attachments, `system:informational` block notices, no `user` or `assistant` line). The
  case "never received a prompt, `--resume` exits with `No conversation found`" in section 9.2 was **not** re-run (no run left): UNVERIFIED by me. Docs say:
  "If no stored session matches the ID, Claude Code reports `No conversation found with session ID: <session-id>`" (https://code.claude.com/docs/en/sessions,
  "Resume by session ID or name"). In gonogo, record in its own state that the first prompt was delivered instead of testing for the file.
- VERIFIED (`command claude --permission-mode default --help` exits 0 and prints the help; the same with `manual` exits 0; `--permission-mode bogus --help` exits 1 with
  `error: option '--permission-mode <mode>' argument 'bogus' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.`):
  the parser accepts `default` although `--help` does not list it. Docs: "`manual` as an alias for `default` ... both values work" (https://code.claude.com/docs/en/cli-reference).
- VERIFIED (runs 1 and 2): the first prompt can go out the moment the boxed prompt row is on screen. The paste + CR (one write) was sent 1 ms after the box was
  detected and 22-24 ms after `ESC[?2004h`, before the SessionStart hook ran (451 ms and 535 ms after spawn), and was submitted both times (hook 271 ms and 294 ms
  after the write). So SessionStart is confirmed again as a poor readiness signal.
- Not re-checked at all: section 7 (stop signals and exit codes), the bypass-permissions warning dialog, shell mode with `!`, `--setting-sources`, the classic renderer,
  Docker and Linux behaviour, and the one-write-versus-delayed-CR timing sweeps. The numbers in those sections stand or fall with the researcher's own runs.

### Appendix C (skeptic): exact commands

`S` is the skeptic's scratch folder named above. `clean-env.sh` unsets `CLAUDECODE AI_AGENT CLAUDE_PID CLAUDE_EFFORT` and every `CLAUDE_CODE_*`, then exports `TERM=xterm-256color COLORTERM=truecolor`.
Every npm call used `--cache "$S/npm-cache"`.

```
( source "$S/clean-env.sh"; command claude --version )                      -> 2.1.325 (Claude Code)
( source "$S/clean-env.sh"; command claude --help )                         -> --permission-mode choices: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan
( source "$S/clean-env.sh"; command claude --permission-mode default --help )   exit 0
( source "$S/clean-env.sh"; command claude --permission-mode manual --help )    exit 0
( source "$S/clean-env.sh"; command claude --permission-mode bogus --help )     exit 1, error text quoted above

npm view node-pty dist-tags --json                  -> latest 1.1.0, beta 1.2.0-beta.18
npm view @lydell/node-pty dist-tags version --json  -> latest and beta 1.2.0-beta.18
npm pack node-pty@1.1.0 node-pty@1.2.0-beta.18 @lydell/node-pty@1.2.0-beta.18 @lydell/node-pty-linux-x64@1.2.0-beta.18 @lydell/node-pty-linux-arm64@1.2.0-beta.18
tar -tvzf <tarball> | grep -E 'spawn-helper|prebuilds/[^/]+/pty.node'    (1.1.0: spawn-helper -rw-r--r--, no linux entry; beta.18: -rwxr-xr-x, linux-x64 71,784 B, linux-arm64 69,096 B)
npm install node-pty --foreground-scripts           (fresh folder)  then  node pty-smoke.js <folder> node-pty         -> {"ok":false,"error":"posix_spawnp failed."}
chmod +x <folder>/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper ; same smoke test                         -> {"ok":true,"out":"hello-from-pty",...}
npm install @lydell/node-pty                        (fresh folder)  then  node pty-smoke.js <folder> @lydell/node-pty  -> {"ok":true,"out":"hello-from-pty","exit":{"exitCode":0,"signal":0}}
npm install @lydell/node-pty --omit=optional        (fresh folder)  smoke test -> error text naming "--omit=optional"
tar -xzOf lydell-node-pty-linux-x64-1.2.0-beta.18.tgz package/prebuilds/linux-x64/pty.node | strings -a | grep -oE 'GLIBC_[0-9.]+' | sort -uV   -> highest GLIBC_2.28 (arm64: GLIBC_2.28)

( source "$S/clean-env.sh"; LABEL=run1 S="$S" node "$S/harness/run1.js" )
( source "$S/clean-env.sh"; LABEL=run2 S="$S" node "$S/harness/run2.js" )
( source "$S/clean-env.sh"; LABEL=run3-sessionid-reuse EXTRA='["--session-id","eb9ff3ca-26bc-494a-ad20-0a541ee3e864"]' S="$S" node "$S/harness/launch.js" )
( source "$S/clean-env.sh"; LABEL=run4-resume-never-briefed EXTRA='["--resume","8af79d8a-2b57-4176-8c3f-421a40299302"]' S="$S" node "$S/harness/launch.js" )
node "$S/harness/replay.js" "$S/captures/run1.events.jsonl" 400      node "$S/harness/replay.js" "$S/captures/run2.events.jsonl" 400
node "$S/harness/mouse-wire.js"
```

Launch used by runs 1 and 2: `/opt/homebrew/bin/claude --model haiku --settings $S/settings/hooks.json --permission-mode default --session-id <fresh uuid>`, pty 120x40,
`encoding: null`, cwd the gonogo folder, environment as above plus `DH_NODE`, `DH_HOOK`, `DH_LOG`. `hooks.json` has command hooks for SessionStart, UserPromptSubmit,
UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, Notification, Stop, StopFailure and SessionEnd, and
`"promptSuggestionEnabled": false`. The hook script appends its stdin JSON with a timestamp to `DH_LOG` and answers a UserPromptSubmit whose prompt contains
`BLOCKME` with `{"decision":"block","reason":"probe-block"}`. Every message was written as `ESC[200~` + text + `ESC[201~` + `\r` in one `write`.
