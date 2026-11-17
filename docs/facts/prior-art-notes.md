# Prior art: what Munder Difflin teaches gonogo

Date: 2026-11-16. Job: prior-art. Read-only research; no model runs.

This file records how an existing MIT-licensed desktop app ("Munder Difflin", package version 0.4.6) runs real
`claude` CLI agents in pseudo-terminals, receives their hook events and delivers messages between them, and what
that means for the hard parts of gonogo. It describes behaviour in my own words. No code is copied; only short
strings (flag names, event names, setting keys) are quoted.

## Summary (the ten things a builder most needs)

1. The reference removed the Stop-hook "keep going" path that gonogo's delivery rule relies on. Its comment: it bypassed
   typing and permission safety and could spend credits while a user was answering a question. Today its Stop handler
   returns an empty reply (5.1). Official docs add an 8-consecutive-continuation cap (5.4).
2. Mail never travels through the terminal in the reference. It lands in a file; only a one-line nudge is typed (2.3).
3. Typing recipe that worked for them: bracketed paste only for multi-line text, a 140 ms pause, then `\r` as a separate
   write, all serialised per terminal, with a 4.5 s per-agent cooldown (2.1, 2.2). Unproven on Claude Code 2.1.325.
4. Their "user is typing" gate is a keystroke-tracked draft latch that clears on Enter/Esc/Ctrl-C and expires after
   30 minutes, plus a picker latch for bare slash commands. They tried 60 s and dropped it. Gonogo's 15 s is weaker (2.5, C6).
5. Idle/working comes from hooks, backed by a 12 s PTY-silence rule because turn-end signals get lost (3.1, 3.2). Docs
   confirm Esc during a turn fires no `Stop` and an API error fires `StopFailure` (3.5, C2).
6. They pre-accept the bypass warning and folder trust by editing the user's own `~/.claude/settings.json` and `~/.claude.json`
   (4.1). Docs confirm both keys; docs also show more blocking dialogs the reference never handled (4.2, C5).
7. They strip every `CLAUDECODE`/`CLAUDE_*` variable from the agent environment except four operator settings, because a leaked
   `CLAUDE_CODE_CHILD_SESSION` breaks `--resume`. Docs confirm; this machine's session carries 13 such variables (1.4, C14).
8. They never pass `--session-id`; they learn the id from hooks and `--resume` it, which failed whenever hooks did not land (1.3).
9. Not from the reference but found while checking it against the docs: on Claude Code 2.1.283+ the built-in permission mode is
   `auto`, not Manual (C4); resumed sessions reuse the old system prompt (C7); and Claude Code ships native `SendMessage`/`ListAgents`
   tools that agents may use instead of gonogo's, with approval dialogs that typed text could answer (C3).
10. The reference defaults every agent to `bypassPermissions`, so its permission-prompt handling is lightly tested (0.3, C16).

## 0. How to read this file

### 0.1 Labels

Every fact carries a label that says how it was established.

- VERIFIED (source file:lines) means I read it in the reference's source. Paths are relative to the extracted tree
  (`md-tar` inside this session's scratchpad directory; untrusted downloaded data, read but never executed).
  `main/` is `src/main/`, `shared/` is `src/shared/`, `renderer/` is `src/renderer/src/`.
- VERIFIED (docs: page) means I read it on the official Claude Code documentation on 2026-11-16, at
  `https://code.claude.com/docs/en/<page>`. The fetch tool answers through a small summarising model, so for the
  facts that matter most I re-read the raw page text it saved (hooks Stop section, CLI flag table, sessions page,
  workspace trust section, interactive-mode queue section, cross-session messaging, channels). Where a fact comes
  only from the tool's quoted summary I say so.
- VERIFIED (ran: command) means I ran a command.
- UNVERIFIED means it is a claim made in the reference's comments or blog, or my inference. Each is marked.

### 0.2 What I read

Required: `main/pty.ts`, `main/hooks.ts`, `main/workerWake.ts`, `main/workerLaunch.ts`, `main/ptyEnv.ts`,
`shared/claudeCommands.ts`, `shared/agentProvider.ts` (Claude parts), `shared/hookEvents.ts`, its nudge file (written here as `shared/<nudge>.ts`),
the router, Stop handling, spawn injection and settings generation inside their core main-process file, written here as `main/<core>.ts` (3669 lines, searched and
read in the relevant ranges), and `main/hiddenClaude.ts`.

Not on the list but necessary, because the typing and state logic is not in the files above: the reference keeps it
in its browser-like renderer. I read the product's state hook file (written here as `renderer/hooks/<state hook>.ts`), `renderer/hooks/queueDelivery.ts`,
`renderer/hooks/usePtyParser.ts`, `renderer/components/terminalPool.ts`, `terminalAutomation.ts`, `terminalKeys.ts`,
`terminalRecovery.ts`, `renderer/store/store.ts` (the queue rules), `shared/providerAutomation.ts`, plus from `main/`:
`index.ts` (spawn core, worker wake beat, sleep/wake, teardown, exit handler), `config.ts` (trust and model tiers),
`control.ts`, `transcript.ts`, `procKill.ts`, `shellEnv.ts`, `breaker.ts` (header only).

Message-queue documents found in the tree: the blog posts `file-based-coordination-vs-message-queues.md` and
`atomic-file-mailboxes-for-agents.md`, the generated protocol text inside `main/<core>.ts` (lines 2955-3100), and the
queue rules in `renderer/store/store.ts`. Also read: `the-hook-shim-pattern.md`, `claude-code-hooks-explained.md`,
`why-does-claude-code-keep-asking-for-permission.md`, `the-newline-that-silenced-windows-agents.md`.

Not in the extracted tree: a `LICENSE` file (only `LICENSE-ASSETS`, which says MIT covers the source code), a protocol markdown file named after their product,
`TELEMETRY.md`, `test/*.test.cjs`, `tools/*.cjs`. So the reference's tests could not be read.

### 0.3 Caveats about the reference

- The blog posts are marketing and are stale against the code in places (5.1 and 5.3 give examples). When blog
  and code disagree, I trust the code.
- The reference was written against older Claude Code builds. Its comments cite one live check on "claude 2.1.239".
  The Claude Code on this machine is 2.1.325 (VERIFIED ran: `command claude --version`, output below). Any text it
  matches on screen ("esc to interrupt", approval menu wording) is UNVERIFIED for 2.1.325.
- The reference's default is to start every agent in `bypassPermissions` (VERIFIED `main/config.ts:427`, global
  "auto mode" defaults to true; `renderer/store/config.ts:408-435` adds the flag). Its permission-prompt handling
  therefore saw much less real use than gonogo's will, because gonogo's boss defaults to `default` mode.

### 0.4 The one machine fact recorded

Exact command (the environment variables inherited from this Claude Code session were removed first, as the ground rules
require; `unset_args` collects a `-u NAME` pair for `CLAUDECODE` and every `CLAUDE_CODE_*` variable):

```
unset_args=(); for v in $(env | cut -d= -f1 | grep -E '^(CLAUDECODE|CLAUDE_CODE_.*)$'); do unset_args+=(-u "$v"); done; env "${unset_args[@]}" TERM=xterm-256color zsh -c 'command claude --version' 2>&1 | head -3
```

Output:

```
2.1.325 (Claude Code)
```

This is a local version query. It makes no API call and spends nothing.

## 1. The claude command line and environment

### 1.1 Command line the reference builds

Order of assembly (VERIFIED `renderer/store/config.ts:408-435`, `main/index.ts:2780-2887`, `main/<core>.ts:977-1006`):

1. The renderer builds the base: the executable (`claude`), then `--model <id>` when a model was chosen, then
   `--permission-mode bypassPermissions` when the global auto mode is on.
2. Main appends the protocol injection: `--append-system-prompt <protocol text>` and `--settings <agentDir>/settings.json`.
3. Main then adds, only for Claude: the auto-mode flag again if missing (idempotent, matched as whole tokens),
   `--model <role default>` if no model is present, `--remote-control-session-name-prefix <agent name slug>`,
   `--max-turns N` only when configured, and `--resume <session id>` only when restoring.

Resulting shape:

`claude --model <id> --permission-mode bypassPermissions --append-system-prompt <text> --settings <file> --remote-control-session-name-prefix <slug> [--max-turns N] [--resume <sid>]`

Details:

- Model. Explicit per-agent model wins, then the user's default model, then a role tier: Opus for the orchestrator,
  Sonnet for workers, Haiku for narrow helpers whose role matches words like triage, verify, lint, summarise
  (VERIFIED `main/config.ts:743-776`). Their catalog uses ids such as `claude-sonnet-4-6` and a `[1m]` suffix for the
  1M window (`shared/claudeCommands.ts:59`). UNVERIFIED that the suffix still means that. The docs say `--model`
  takes an alias (`sonnet`, `opus`, `haiku`) or a full name (VERIFIED docs: cli-reference).
- Permission modes. The reference has no per-agent mode. There is one global toggle: bypass for every agent, or no
  flag at all for "ask first". No use of `acceptEdits`, `plan`, or an explicit `default`. See 1.7: omitting the flag
  no longer means "ask first".
- System prompt. `--append-system-prompt` carries a multi-line protocol text of about 6.1 thousand characters
  (identity, inbox and outbox rules, guardrails) (VERIFIED `main/pty.ts:132-134,184-186`, `main/<core>.ts:1530-1613`). Its
  text is kept free of anything that changes per spawn (dates, counters, roster) so the prompt cache stays warm
  (VERIFIED `main/<core>.ts:1508-1529`). Changing facts travel by other channels (1.5).
- Not used by the reference for Claude agents: `--session-id`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`,
  `--setting-sources`, `--continue`, `--fork-session`, `--dangerously-skip-permissions` (that spelling appears only as another
  CLI's flag). `--add-dir` appears only in the hidden helper (and in the Codex spawn). (VERIFIED by grep over `main/`,
  `shared/` and `renderer/`.)
- The hidden helper (`main/hiddenClaude.ts:115-120`) runs `--model <m> --permission-mode bypassPermissions
  --disallowedTools Edit Write NotebookEdit [--add-dir <d>]` in an interactive PTY (not `-p`), then reads the answer
  from the session transcript file instead of the screen (`hiddenClaude.ts:61-97`). Its comment says the PTY route
  is chosen so usage draws from the interactive plan quota rather than a separate pool for the Agent SDK. UNVERIFIED.

### 1.2 The per-agent settings file

Written fresh at every spawn into the agent's own folder and passed with `--settings`, so the user's `~/.claude` is
never edited for this (VERIFIED `main/<core>.ts:1245-1308`). Its content, in words:

- `theme` set to `auto` (a pinned theme ignored later theme changes; `auto` listens to the terminal's theme
  reports).
- `mcpServers` for a default bundle of read-only servers, with every id prefixed so they cannot clobber the user's
  own. UNVERIFIED that Claude Code reads `mcpServers` from a `--settings` file: the docs I fetched show
  `--mcp-config` as the flag for MCP servers and the settings reference did not list `mcpServers` in the part I read.
  Use `--mcp-config` (VERIFIED docs: cli-reference).
- `statusLine` set to a command. Claude pipes session status JSON to it after each response; the reference uses it to
  read exact context-window usage (`context_window.total_input_tokens`, `context_window_size`).
- A `sandbox` block (`enabled`, `filesystem.allowWrite`) plus `permissions.additionalDirectories`, both listing the
  agent folder and shared root. Their comment: "Verified live (claude 2.1.239)" that with bypass mode the sandbox still
  blocks writes outside the listed folders, and that both layers are needed, because with only one the agent deadlocks
  on its own inbox. Bypass mode only silences prompts; it does not sandbox. UNVERIFIED on 2.1.325. The docs list `sandbox`
  (with `sandbox.enabled`) and `permissions.additionalDirectories` as settings valid in any settings file (VERIFIED docs:
  settings-reference, fetch tool's summary). Gonogo's design does not use a sandbox; this is only a pointer.
- `hooks`: nine events, each with one `command` handler running the shim: `Stop`, `SubagentStop`, `PreToolUse` and
  `PostToolUse` (matcher `*`), `UserPromptSubmit`, `Notification`, `SessionStart`, `PreCompact`, `PostCompact`.
  Not registered: `StopFailure`, `SessionEnd`, `PermissionRequest`, `PostToolUseFailure`.

Docs facts that bear on this file (VERIFIED docs: cli-reference, sessions): `--settings` accepts a path or inline JSON,
the file must be a regular file of at most 2 MiB, keys you omit keep their file-based values, and `--settings`,
`--mcp-config`, `--add-dir` are not restored on resume, so they must be passed again on every start.

### 1.3 Session id handling

- The reference never chooses a session id. It reads `session_id` out of any hook payload and stores it in its
  registry (VERIFIED `main/hooks.ts:429-431`, `main/<core>.ts:1208-1221`). Restart builds `--resume <that id>`.
- It attaches `--resume` only if the transcript file exists. If a transcript lives under a different working
  directory's project folder, it copies the file across first (`main/transcript.ts:58-94`, `main/index.ts:2864-2885`).
  Otherwise it starts a fresh session and warns.
- Respawn must keep the previously recorded id: ensureAgent spreads the prior registry entry first, because losing it
  meant `--resume` was never attached and every restart began a new thread (`main/<core>.ts:772-781`).
- Second source for the id: the telemetry sample, because hooks sometimes did not land and "Restart & Continue" then
  refused (`main/index.ts:1224-1239`, `main/index.ts:3196-3215`).
- Where Claude stores the file: `~/.claude/projects/<cwd with every non-alphanumeric turned into a dash>/<id>.jsonl`
  (VERIFIED `main/transcript.ts:6-56`, confirmed by docs: sessions, "Where transcripts are stored", which adds a
  200-character truncation plus hash).

Docs cross-check (VERIFIED docs: cli-reference, sessions):
- `--session-id <uuid>` exists ("must be a valid UUID"). The reference does not use it, so it has no evidence on how
  `--session-id` then `--resume` behave for the same id. UNVERIFIED; needs a runner test.
- Since v2.1.223, `--resume <id>` searches the current project, its worktrees, then every other project on the
  machine, and resolves only when exactly one other project holds the transcript. A hand-copied duplicate makes it
  report "No conversation found with session ID: ..." rather than pick one. So the reference's copy-across trick was needed
  on older builds, is unnecessary on new ones, and the stale copy it leaves behind can make a later resume from a third
  folder report not-found (my reading of the two docs sentences; UNVERIFIED by a run).
- Resuming the same session in two processes writes both into one transcript and loses messages.

### 1.4 Environment

PTY environment, bottom to top (VERIFIED `main/ptyEnv.ts` whole file, `main/pty.ts:664-673`):

1. The inherited environment minus every variable whose name starts with `CLAUDECODE` or `CLAUDE_`, except a keep list:
   `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`. Stripped by
   prefix because a fixed list was already seven names short of a live session's dump.
2. Defaults: `PATH` set to the user's login-shell PATH, `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_COLOR=1`,
   and on non-Windows `LANG` (default `en_US.UTF-8`) and `LC_CTYPE` set to UTF-8 unless the user exported one.
3. Per-agent values win over everything, including the strip: `AGENT_ID`, `AGENT_NAME`, a root variable, `AGENT_DIR`,
   a node variable, `COLORFGBG` (theme hint), a hook socket variable (its path), and, when their telemetry collector is up,
   `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus `OTEL_*` exporter settings (their main-process launcher, lines 803-828 and 977-1006).

PTY: node-pty, name `xterm-256color`, default 100 columns by 30 rows, re-spawned at the terminal's real grid after a
restart "so the TUI's absolute cursor moves land in the right cells" (`main/pty.ts:664-668`,
`renderer/hooks/<state hook>.ts:1210`). Command resolution: plain names only, through an interactive login shell with the
output fenced between markers, cached after the first hit, falling back to common install folders
(`main/pty.ts:411-493`, `main/shellEnv.ts`).

Evidence from this machine (VERIFIED ran: `env | grep -i '^[^=]*claude[^=]*=' | cut -d= -f1 | sort`, names only; values
withheld because some are tokens). This session's environment carries 13 variables of that family:
`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`,
`CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_SESSION_ATTENDED`,
`CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_ENABLE_AUTO_MODE`, `CLAUDE_CODE_TMPDIR`, `CLAUDE_EFFORT`, `CLAUDE_PID`.
That matches the reference's list of what leaks when the app is launched from inside a Claude session.
The docs confirm the effect for the key one (VERIFIED docs: env-vars): `CLAUDE_CODE_CHILD_SESSION` is set in
subprocesses Claude spawns (Bash tool, hooks, status line) and "a nested interactive `claude` TUI started this way is
automatically excluded from `--resume`, `--continue`, up-arrow history, and the `claude agents` list";
`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` overrides that. Which of the other 12 are identity and which are operator
configuration is not documented in what I read, so the reference's keep list is probably not complete.

### 1.5 How the reference sends changing information to a running agent

Instead of the system prompt, it uses the hook reply (VERIFIED `main/hooks.ts:521-580`, `main/control.ts`):
the hook server answers `SessionStart`, `UserPromptSubmit` and `PostToolUse` with `hookSpecificOutput.additionalContext`
carrying (a) the live roster for the orchestrator, (b) the agent's standing goal, delivered once at session start and
then only when it changes, and (c) queued "steer" notes from the operator, delivered once each, oldest dropped past 20
notes, each capped at 10 000 characters. Only one `additionalContext` can be returned per hook, so the three are merged
into one string. Docs confirm these events accept `additionalContext` and that on `UserPromptSubmit` it is "added to
Claude's context alongside the submitted prompt" (VERIFIED docs: hooks).

### 1.6 Hook transport

Not HTTP hooks. Each hook is a `command` handler that runs a tiny script reading the payload on stdin, adding the
agent id from the environment, sending one line of JSON to a Unix socket, and relaying the reply; every failure path
exits 0 so the shim cannot crash a turn (VERIFIED `main/<core>.ts:3107-3158`). The server side caps a frame at 256 KiB,
answers an ownership ping so it can tell its own socket from another instance's, and a 15-second health beat re-binds
if the socket file is lost (`main/hooks.ts:24-25,155-337`, `main/index.ts:5287-5291`).

### 1.7 Docs cross-check of the flags and defaults (this matters for gonogo)

All VERIFIED docs, `cli-reference` and `permission-modes`, read 2026-11-16:

- `--permission-mode` accepts `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, or `manual` as an
  alias for `default` (alias needs v2.1.200+).
- The built-in starting mode in a terminal is `auto` with Claude Code v2.1.283 or later (earlier: `auto` only on some
  plans). `claude -p` starts in `default`. If auto is unavailable (model, settings, server-side) the session starts in
  Manual. Quoted by the fetch tool from the "which mode a session starts in" section; the raw text was not saved.
  So omitting the flag no longer gives "ask first"; `--permission-mode default` (or `manual`) must be explicit.
- Resume restores the saved permission mode in a terminal, except a session that ended in `bypassPermissions`
  resumes in "the permission mode a new session would start in". Pass `--permission-mode` on every start and restart.
- First use of bypass mode shows a warning dialog; accepting sets `skipDangerousModePermissionPrompt` in
  `~/.claude/settings.json`; declining exits. It refuses to start as root or under sudo on Linux and macOS.
- `--max-turns` is "print mode only" (so the reference's use of it on interactive sessions is probably a no-op).
- `--append-system-prompt-file` exists. The system prompt is built once on the conversation's first request, recorded,
  and reused after `--resume` until the conversation is compacted; changed flag text on a later launch takes effect only
  after compaction or in a new conversation, unless `--system-prompt-snapshot off` (v2.1.257+).
- `--remote-control-session-name-prefix`, `--setting-sources`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`,
  `--disallowedTools`, `--add-dir` all exist.

## 2. How the reference types into a claude terminal

### 2.1 The submit sequence (VERIFIED `renderer/hooks/<state hook>.ts:111-157`)

1. Wait until the PTY is "ready" (2.4).
2. Build the payload. If the text contains a newline, wrap it in bracketed-paste markers (ESC `[200~` ... ESC `[201~`).
   Single-line text is sent raw.
3. Write the payload.
4. Wait 140 ms.
5. Write a lone carriage return (`\r`) as a separate write.
6. Wait a settle time, 250 ms by default, 1500 ms after the boot-time `/remote-control` command.

Why, in their words: writing text and Enter in one chunk makes the TUI treat the whole thing as a paste, so the Enter
lands as a newline inside the input box and never submits. Without bracketed paste, every newline in a multi-line
message acted as Enter and submitted line fragments (their issue #24). The main-process wake nudge uses the same
shape without markers because the nudge is one line: write text, 140 ms timer, write `\r` (`main/index.ts:5177-5193`).
The hidden helper wraps its prompt in bracketed paste always, then `\r` after 140 ms (`main/hiddenClaude.ts:185-192`).

The raw `\r` is the only submit they use. They do not send `\n` for submit.

### 2.2 Serialisation, acknowledgement, retries

- Every write to one PTY is chained on a per-PTY promise so two callers can never interleave text and Enter. Their
  incident: "Unknown command: /remote-control<next prompt>" (`<state hook>.ts:84-88`).
- A write to a dead PTY resolves with a failure result instead of rejecting. An unchecked await made failed deliveries
  look successful and the queue destroyed messages it had already popped (#36). Now a failure rejects, the message stays
  in the queue, retries are spaced by the per-agent flush cooldown, and after 3 failed attempts the message is dropped
  with a console warning (`<state hook>.ts:143-149,784-888`). A queue item is acknowledged only after both writes succeed.
- A per-agent flush cooldown of 4500 ms keeps one delivery from landing on the next, because right after typing the
  agent still reads idle until the `UserPromptSubmit` hook flips it (`<state hook>.ts:305-309,784,826`).
- The queue flush runs on every store change (200 ms debounce) plus a 3-second backstop interval (`<state hook>.ts:944-954`).

### 2.3 What gets typed: a pointer, not the body (VERIFIED)

For Claude agents the reference never types a message body into the terminal. Mail goes into the agent's inbox
folder as a file; the only thing typed is a one-line nudge beginning `You have new <product> inbox message(s)` that names
the message ids as diagnostics and tells the agent to read its inbox folder, act, and move handled files to a done
folder (`shared/<nudge>.ts`). Multi-line typing is used only for human-composed queue messages, the orchestrator's boot
prompt, Slack-origin work for the orchestrator, and "WORK ORDER" text for non-Claude CLIs.

Queue rules (`renderer/store/store.ts:892-933`, `renderer/hooks/queueDelivery.ts:66-92`): one pending nudge and one
pending compaction per agent; each queued message can carry a delivery-time precondition (inbox still non-empty), and a
stale one is dropped rather than deferred, because a deferred stale item would block everything behind it. The check
fails open: if the inbox cannot be read, send, because a spurious nudge costs one turn while a swallowed one leaves mail
unread.

### 2.4 Readiness and when they refuse to type

Readiness (`shared/providerAutomation.ts:228-257`, `<state hook>.ts:91-109`): the PTY must have emitted at least one output
frame (`hasOutput`, `main/pty.ts:75-78`) and a settle time must have passed (400 ms for Claude), counted from when the
wait began. They deliberately do not wait for output to go quiet, because some TUIs repaint a status line forever and
blocked queued messages until readiness timed out. Timeout 30 s.

The gates before an automatic delivery is typed (VERIFIED `<state hook>.ts:793-888`, `queueDelivery.ts:16-56`):

1. Target must have a live PTY.
2. Status must be idle. Working, thinking, compacting, waiting and blocked all refuse. A breaker-pinned "looping"
   agent is deliverable only if its PTY has been silent 12 s. Unknown silence fails closed.
3. Operator "auto delivery paused" refuses, except for a message the user explicitly released.
4. Boot grace: 35 s after spawn. In the renderer it is applied to the orchestrator and to seeded workers; the
   main-process watchdog applies it to every worker (`<state hook>.ts:454,750,820`, `main/workerWake.ts:42`).
5. The user owns the prompt: a draft or an open picker refuses (2.5).
6. Per-agent flush cooldown 4.5 s.
7. Delivery-time precondition (drop if stale).
8. For the one-time protocol seed typed into TUIs that reject it as an argument: refuse if the agent shows `waiting` or
   `blocked`, "because the seed's trailing Enter would confirm" a permission prompt (`<state hook>.ts:753-765`).
9. The main-process wake watchdog adds: no output for 12 s, not within 5 minutes of a permission-type Notification,
   at least 60 s since the last nudge to that worker, and edge-triggered on message ids not announced before
   (`main/workerWake.ts:36-69,249-296`).

### 2.5 Draft and picker detection (the closest thing to gonogo's "user activity gate")

All VERIFIED, `renderer/components/terminalPool.ts:345-556`, `terminalAutomation.ts`.

- The browser terminal watches the user's keystrokes and keeps its own model of the prompt line: printable characters
  append, backspace deletes, Enter/Esc/Ctrl-C clear, Ctrl-U clears, escape sequences are skipped. "Draft present" is the
  line being non-empty, stamped with the time of the last keystroke.
- A paste is never counted as a submit (xterm rewrites pasted newlines to carriage returns).
- The model drifts when a TUI swallows keys for its own menu, leaving a phantom draft ("messages never arrive"). So they
  also read the rendered prompt line from the xterm buffer, strip box-drawing characters and prompt markers, and if
  it is empty after a 1 s echo grace they treat the draft as gone. The screen may only clear a draft, never invent one:
  a wrong "empty" fuses automation text onto the user's, while a wrong "has text" only parks a message.
- Expiry: a draft untouched for 30 minutes stops blocking (`STALE_INPUT_MS` = 1 800 000). The first version used 60 s
  and "fired while the user had merely paused to think"; they judged treating a real draft as abandoned the expensive
  mistake. After expiry, text is typed after whatever is there; automation never deletes the user's text.
- Pickers: submitting a bare `/model`, `/reasoning`, `/permissions`, `/permission`, `/provider`, `/settings`, `/config`,
  `/experimental`, `/experiments`, `/hooks`, `/mcp`, `/apps`, `/plugins`, `/resume` or `/sessions` latches a picker block
  until Enter, Esc or Ctrl-C is typed, or 30 minutes pass. With an argument (`/model sonnet`) nothing latches; latching
  there wedged delivery for the whole session. A 500 ms settle follows release.
- They never send Escape on their own to close a menu: "rude and unverifiable". The user's "clear draft" button sends
  Ctrl-U and hands the discarded text back, because it is not undoable.
- Browser-terminal key fix: xterm.js encodes Shift+Enter as a bare CR, which submits. They intercept it and send ESC CR
  (the sequence Claude's `/terminal-setup` installs for iTerm2 and VS Code) (`renderer/components/terminalKeys.ts`).

Docs cross-check (VERIFIED docs: interactive-mode): Ctrl+U deletes from the cursor to line start and "repeat to clear
across lines in multiline input"; Ctrl+C clears the input if nothing is running and a second press exits Claude Code;
Esc+Esc clears the draft; multiline entry is `\` then Enter in every terminal, Ctrl+J "in any terminal without
configuration", Shift+Enter natively only in iTerm2, WezTerm, Ghostty, Kitty, Warp, Windows Terminal.

### 2.6 Native queueing, which the reference does not use

Claude Code queues messages typed while it is working: "Type a message and press Enter while Claude is working. Claude
Code queues the message instead of interrupting the turn." A queued message is passed to Claude as soon as the running
tool calls finish within the same turn, and leftovers go out after the turn ends in order. `/model`, `/effort`, `/fast`
run immediately instead of queueing. (VERIFIED docs: interactive-mode, raw text.) The reference holds everything until
idle anyway. Whether that was caution or history is UNVERIFIED. For gonogo this changes the "if it is working, the
message waits" rule, but not the permission-prompt hazard (typing while a permission dialog is up answers the dialog).

### 2.7 Where the typing code lives

In the reference most of this is in the renderer (React effects on timers), with a small copy in the main process.
They added the main-process copy because Chromium throttles timers in a hidden window and a worker "sits on an undrained
inbox forever" (`main/workerWake.ts:1-31`). For gonogo all of it belongs on the server; the browser tab is only a view.
The draft model also needs the user's keystrokes, which in gonogo reach the server over the WebSocket anyway. The
screen-reading half needs a terminal emulator on the server (UNVERIFIED how heavy that is).

## 3. Working, idle or waiting for the user

### 3.1 Primary signal: hooks (VERIFIED `renderer/hooks/<state hook>.ts:477-549`, `main/hooks.ts`)

- `PreToolUse` sets working (and picks an avatar station from the tool name). `PostToolUse` and `UserPromptSubmit` keep
  it working so it does not flicker between tool calls. `PreCompact` sets compacting, `PostCompact` working.
- `Stop` and `SubagentStop` set idle. A "blocked Stop" branch exists from the old drain design but is dead, because the
  hook server never marks an event blocked (5.1).
- `Notification` is classified by message text: contains "permission", "approve", "confirm" or "needs your" and is not an
  idle-style message means needs the user; "waiting for your input", "is idle", "waiting for input" or empty means idle.
  A needs-user Notification maps to `blocked` for the orchestrator and `waiting` for every other agent (because in their
  model only the orchestrator talks to the human). The status code uses message text only. The one place that checks the
  type, the desktop-toast code in `main/hooks.ts:586-592`, compares it with `idle`, while the docs list the value as
  `idle_prompt` (VERIFIED docs: hooks), so only its text fallback could ever match. Do not copy that.
- New agents are created with status idle at spawn (`renderer/hooks/<state hook>.ts:430,1042`, `main/<core>.ts:787`).

### 3.2 Backstop: PTY silence (VERIFIED `<state hook>.ts:637-676`)

Every 4 s the renderer reads each PTY's last-output time. An agent that is "working" and whose PTY has been silent for
more than 12 s is flipped to idle (skipped during boot grace and for breaker-pinned agents). Reason: a turn-end signal
that does not fire leaves an agent working forever, and both delivery paths are idle-gated, so mail stops draining.
A genuinely working agent keeps emitting bytes, including a long tool; a false idle self-corrects on the next hook.

### 3.3 Older screen heuristics (VERIFIED `renderer/hooks/usePtyParser.ts`)

A stream parser, called a stopgap before hooks, looks for the footer "esc to interrupt" (turn in progress), tool lines
beginning with a bullet and a tool name, a 4 s idle drift, and approval-prompt text (`Do you want to proceed`, a
numbered "1. Yes" menu line, `Yes, and don't ask again`, `(y/n)`). Gotcha recorded in the file: do not match the bare
word "permission", because the footer always shows "bypass permissions on (shift+tab to cycle)" and the agent would
flip between working and blocked on every repaint. It only runs for the terminal that is mounted. Approve and Deny
buttons send `y` + Enter and `n` + Enter, which looks stale against a numbered menu. UNVERIFIED on 2.1.325.

### 3.4 Failure cases the comments mention

- A bridge's turn-end signal never fires: agent pinned working (3.2).
- A worker whose first nudge was lost while the TUI was still drawing sat 17 minutes with 0 tokens and no transcript
  until a human typed "read your inbox" (seen 2026-09-06). PTY output cannot prove a turn: a TUI redraws its chrome
  without working. A session-start usage sample with zero tokens is not evidence of work either (seen 2026-09-07).
  Their stall rule: mail older than 90 s with no hook-proven turn since it landed (`main/workerWake.ts:47-66,173-186`).
- Hook events not arriving at all: if nothing is listening, the shims exit 0 with empty output, which the CLI reads as
  "allow", and status, the breaker and cost silently go dark (`main/hooks.ts:55-60`). On first run, services were not
  started until the next launch, so no hook ever arrived (`main/index.ts:3196-3215`).
- The idle Notification mistaken for "needs you": the avatar walked to the door with a red mark right after finishing
  (`<state hook>.ts:522-547`).
- A mid-turn "looping" pin that stranded mail forever because only idle was deliverable (`queueDelivery.ts:16-47`).
- After laptop sleep, timers froze and PTYs wedged while node-pty still held the fd (`main/index.ts:5294-5373`).

### 3.5 Docs cross-check (VERIFIED docs: hooks unless noted)

- `Stop` "runs when the main Claude Code agent has finished responding. Does not run if the stoppage occurred due to a
  user interrupt. API errors fire StopFailure instead." So a user Esc leaves "working" with no Stop. The reference's
  Claude settings do not register `StopFailure`.
- `SubagentStop` is a separate event for subagents. The reference maps it to idle, which flips the parent to idle while
  its own turn continues. Derived from the docs' event definitions plus the code reading.
- Notification input has `message`, optional `title`, and `notification_type` (`permission_prompt`, `idle_prompt`,
  `auth_success`, `elicitation_dialog` and others). Sample: message "Claude needs your permission", title "Permission
  needed". Timing: `idle_prompt` fires when Claude "finished responding about 60 seconds ago and you haven't typed
  since"; `permission_prompt` fires once "the prompt has waited about six seconds" (fetch tool's quoted summary).
- A `PermissionRequest` hook "runs when Claude Code is about to ask you for permission to use a tool" and fires only when
  a prompt is about to appear. The reference does not use it. UNVERIFIED in practice; a possible immediate "needs you"
  signal instead of the 6 s Notification.
- Hook handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. An `http` hook sends the JSON input as a POST body
  with `Content-Type: application/json`; headers can use env vars listed in `allowedEnvVars`; non-2xx or a connection
  failure is a non-blocking error; default timeout 600 s (30 s on `UserPromptSubmit`).
- Hooks inherit the parent environment, apart from `OTEL_*` variables.

## 4. Trust dialogs, onboarding dialogs and permission prompts

### 4.1 What the reference does

- It avoids the first-run dialogs by writing to the user's own config before every Claude spawn
  (VERIFIED `main/index.ts:2950-2956`, `main/config.ts:798-880`): in `~/.claude/settings.json` it sets
  `skipDangerousModePermissionPrompt` and `skipAutoPermissionPrompt` to true, and in `~/.claude.json` it sets
  `projects["<cwd>"].hasTrustDialogAccepted` to true. Each is done only if not already satisfied "so we rarely touch
  files a running `claude` also writes", and each file is its own best-effort boundary. The stated reason: on a fresh
  install the bypass warning ("1. No, exit / 2. Yes, I accept") cannot be answered in time and the agent exits with code
  1, and the folder-trust dialog ("Accessing workspace / Quick safety check") does the same ("god exits 1 and every
  message to it sits at waiting").
- Because default posture is bypass, tool permission prompts are rare in the reference. When one does appear, it is
  handled by status: a needs-user Notification makes the agent `waiting` or `blocked`, which closes the delivery gate;
  the main watchdog also stays off the worker for 5 minutes after such a Notification (`main/workerWake.ts:46,267-269`).
- Slow human approval is deliberately left to Claude's own prompt. The only hook-level control is an immediate
  `PreToolUse` deny for a paused or gated agent, which has no round trip and so cannot hit a hook timeout
  (`main/hooks.ts:502-519`).
- It does not handle any other startup dialog (login, theme, API key approval, resume warning). Its status at spawn is
  idle, protected only by the boot grace and the readiness wait.

### 4.2 Docs cross-check (VERIFIED docs: permissions, permission-modes, authentication, sessions)

- Workspace trust: the dialog is shown in interactive terminal sessions, not `-p`. It is keyed on the git repository
  root (or on the start folder outside a repo, covering subfolders). "When you start in your home directory, Claude Code
  holds the trust for the current session only and doesn't write it to disk." To trust by hand, set
  `projects["<path>"].hasTrustDialogAccepted` to true in `~/.claude.json`; the docs name that key.
- Bypass warning: first use shows a dialog; accepting writes `skipDangerousModePermissionPrompt` to
  `~/.claude/settings.json` (scope "User, local, or managed"; the settings-reference index row reads "Skip the confirmation
  dialog before bypassPermissions mode"). Whether a `--settings` file can carry it is not clear from what I read.
  UNVERIFIED. `skipAutoPermissionPrompt` is also documented there ("Skip the one-time notice Claude Code shows when you first
  enter auto mode yourself rather than through the built-in default", scope user or managed), but the permission-modes page
  names no setting that suppresses the notice shown when the built-in default starts a session in auto mode (once, at the
  top of the session). Both quoted from the fetch tool's summary of settings-reference.
- `ANTHROPIC_API_KEY` in the environment: "In interactive mode, you are prompted once to approve or decline the key, and
  your choice is remembered." Relevant to the Docker route. `CLAUDE_CODE_OAUTH_TOKEN` ranks below it, has no such
  prompt in the text I read, and cannot establish Remote Control sessions.
- Resume: "the 'Resume this conversation?' dialog" can appear when resuming a long conversation after a long break or on
  a different model, on Pro, Max and Ultra. That is another blocking dialog on restart.
- Cross-session messages from another session can open an approval dialog in the receiving terminal; see 7, C3.

## 5. The Stop hook, inbox draining and loop prevention

### 5.1 What the Stop hook does in the reference today (VERIFIED `main/hooks.ts:490-500`)

Nothing that continues the agent. For `Stop` and `SubagentStop` it returns an empty object, so the agent stops. If
`stop_hook_active` is set it returns immediately. Otherwise it only raises a desktop notification ("finished - idle")
and forwards the event. The comment, in my paraphrase: the old path that turned unread mail into a forced continuation at
Stop is gone because it bypassed draft and human-in-the-loop safety and could spend credits while a user was answering a
question; mail stays durable in files and the renderer wakes the agent later through the guarded idle-only path.

The old path still exists as dead code: a drain function (`main/<core>.ts:1462-1490`) that compared the inbox against a
per-agent cursor file, advanced the cursor to the newest id so each message surfaced exactly once, and returned a block
decision whose reason listed each message and told the agent to move handled files to a done folder. Nothing calls it
(VERIFIED by grep for `drainForStop`: definition at `<core>.ts:1467`, mentions only in comments at 2180 and 2225).
Comments in `shared/agentProvider.ts` and the blog post `the-hook-shim-pattern.md` (2026-06-04) still describe the old
behaviour ("Stop->drain works natively"), so they are stale. The same hook server serves every provider, so those
comments are stale for Codex, Antigravity and Grok too.

### 5.2 How the agent is kept draining instead

1. Mail arrives as a file in the agent's inbox folder (written atomically by the router).
2. A renderer poll every 4 s lists each agent's inbox; for ids not yet announced it queues one nudge with the
   "inbox still non-empty" precondition (`<state hook>.ts:678-730`).
3. The queue types the nudge only when every gate in 2.4 passes. The main-process watchdog does the same on a 15 s beat
   for workers, as a fallback for a throttled renderer (`main/index.ts:5169-5286`).
4. The agent reads the folder, acts, moves files to the done folder. The folder, not the nudge, is the authority.
5. Exactly-once is by the done folder (old design: by a cursor file).

### 5.3 Loop prevention in the reference

- A pending-nudge limit of one per agent, an edge trigger on announced ids, a 60 s watchdog cooldown and a 4.5 s flush
  cooldown (2.4, 2.3).
- Message acts: only `request`, `query` and `propose` expect a reply; `inform` and `done` are terminal and the protocol
  text forbids replying to them (`main/<core>.ts:2989-2992`).
- Hop count: capped at 12 (`main/<core>.ts:205`). The count is carried by the message the agent writes and clamped to
  0..12; only a harness bounce (undeliverable, archived-recipient notice) adds one (`<core>.ts:1619-1668,1730`). So an agent
  that writes hops of 0 every time defeats it. The blog's claim that "every reply increments a hop count" does not match
  the code. Gonogo's server-stamped design is stronger.
- A circuit breaker, outside gonogo's scope: eight identical consecutive tool calls, five error events, and an output
  token velocity trip a steer, constrain, stop ladder; hard stop is off by default (`main/breaker.ts`).
- Never deliver a message to its own sender (`<core>.ts:1693`).
- The `stop_hook_active` guard (still present).

### 5.4 Docs cross-check (VERIFIED docs: hooks, raw text)

- `stop_hook_active` "is true when Claude Code is already continuing as a result of a stop hook".
- Claude Code caps this: "after stop hooks have continued the turn eight times in a row, Claude Code overrides the next
  block and ends the turn. The count ... resets each time Claude calls a tool." Adjustable with
  `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
- The blocking reply is `decision: "block"` with a required `reason`. A second form, `hookSpecificOutput.additionalContext`
  on `Stop`, continues the conversation but "is shown in the transcript as hook feedback rather than a hook error".
- `Stop` does not run on a user interrupt; `StopFailure` replaces it on an API error.

## 6. Lessons recorded in comments

Format: file and lines, then the lesson in one or two sentences. Every item is VERIFIED (source: the file and lines given) as
a statement of what the reference's comment says. Whether the underlying claim about Claude Code is true is a separate matter,
and I mark UNVERIFIED where I could not check it.

Coverage. I grepped each required file, and the renderer, store and main files above, for TRADEOFF, trade-off, gotcha, race,
racy, BUG, NOTE, HACK, WORKAROUND and "do not" (case variants). The literal tags are rare. Hits in the required files:
`main/pty.ts:114` (DO NOT, a Windows cmd.exe path, lesson 65), `main/pty.ts:449` (NOTE, Windows), `main/hooks.ts:503` ("Race-free",
lesson 51), `shared/agentProvider.ts:20,85,213,375,440,483,545` (NOTE and "do not" about other CLIs, flag stacking and trust flags,
lessons 5 and 50), `shared/providerAutomation.ts:58,241` (NOTE and "Do not" on another CLI's command table and on readiness, lesson 40).
Elsewhere: `renderer/hooks/<state hook>.ts:318,331` ("racy", "race", lesson 66), `renderer/components/terminalPool.ts:162,451` (NOTE: open xterm
only once its host is in the document, lesson 62; "do not cost the same", lesson 27), `renderer/hooks/usePtyParser.ts:25` (Do NOT match "permission", lesson 46), `renderer/store/store.ts:772`
("a race he usually lost", lesson 67), `main/<core>.ts:1513` (Do NOT add volatile text, lesson 7), `main/control.ts:9` (race-free,
lesson 51). Most lessons are carried by long incident-style comments instead ("observed live", "seen live", "bit us", "silently"),
so I collected those too. The hits about Codex, Antigravity, Grok, Pi, OpenCode and Crush I did not summarise, because gonogo
is Claude-only.

### Environment and spawn

1. `main/ptyEnv.ts:12-29`. Launching the app from inside a Claude session leaks that session's identity variables into every agent;
   `CLAUDE_CODE_CHILD_SESSION` silently turned transcript saving off, so `--resume` found nothing (hit live 2026-08-16/17). Strip by
   prefix, not by a fixed list. (Docs now confirm the exclusion from resume.)
2. `main/ptyEnv.ts:32-44`. The prefix also holds operator configuration (config dir, OAuth token, Bedrock/Vertex switches) that must
   survive the strip, and per-agent values set on purpose must win over the strip.
3. `main/ptyEnv.ts:69-86`. With no locale a child runs in the C locale and macOS decodes UTF-8 output as MacRoman ("—" becomes
   mojibake); set `LANG` and `LC_CTYPE` to UTF-8 unless the user exported them. Matters for the Docker image.
4. `main/workerLaunch.ts:1-8,60-69`. A whole command line passed as one executable name made node-pty try to run a binary named like
   the line; workers died within about a second while their request was archived as done, "for days". Split into executable plus argv.
5. `main/workerLaunch.ts:46-58`, `shared/agentProvider.ts:694-703`. Add a permission flag only if the command has none, matching
   whole tokens, not substrings.
6. `main/index.ts:2826-2837`. The permission posture must be applied on every spawn path; a worker that missed it deadlocked on a
   cross-session message "held for the recipient user's approval" with nobody able to grant it.
7. `main/<core>.ts:1508-1529`. Keep `--append-system-prompt` text free of dates, counters and roster state so the prompt cache stays warm;
   put changing facts in hook context or files. `main/hooks.ts:545-553`: deliver the standing goal once at session start and then
   only when it changes, or an unchanged briefing bloats the transcript.
8. `main/<core>.ts:772-781`. A respawn must carry the previously recorded session id forward, or `--resume` is never attached.
9. `main/index.ts:2864-2885`, `main/transcript.ts:58-94`. Attach `--resume` only when the transcript exists; otherwise start fresh and
   tell the user, not a silently broken resume.
10. `main/transcript.ts:6-56`. Claude changed its project-folder naming (every non-alphanumeric becomes a dash); the old resolver read
    an absent folder, which every caller treated as "no transcripts yet", and the miss cost months of dead features.
11. `main/index.ts:1224-1239,3196-3215`. The resume key arrived only through hooks; any window where hooks did not land (services not
    started after first-run onboarding) left "Restart & Continue" with nothing. Start the hook receiver before the first spawn and
    keep a second source for the id.
12. `main/hooks.ts:55-60,258-273`. When nothing accepts on the hook endpoint the shims exit 0 and the CLI reads that as allow, so
    the control plane can be dead for a whole session with nothing logged; they added bind retries with back-off, a health beat and
    a one-time notice.
13. `main/<core>.ts:483-502`. UNVERIFIED claim: hooks run through `/bin/sh -c` with a bare `PATH`, so a hook written as `node <file>`
    exited 127 for nvm users and every payload was silently lost; they route hooks through an absolute-path launcher. The docs I read
    say hooks inherit the parent environment, so check before copying; HTTP hooks avoid the question.
14. `main/pty.ts:37-40,68-74,715-720`, `main/<core>.ts:2679-2747`. Keep a bounded tail (8 KiB) of each PTY's output; a provider that
    crashes at startup prints its reason and vanishes (a `claude` panic 923 ms in left no trace, 2026-08-24). node-pty reports exit
    code 0 with a non-zero signal for a crash, so test the signal separately. Write that tail with mode 0600 and keep it out of git.
15. `main/pty.ts:675-710`. On restart under the same id, the old process's late data and exit events arrive after the replacement
    is registered and would scribble into the new TUI or delete the new session; guard with a session-identity check.
16. `main/index.ts:425-443`. An explicit kill removes the session at once so the exit callback is swallowed; every kill path must run
    its own teardown.
17. `main/procKill.ts:1-30,60-90`. SIGHUP to the direct child leaks its children (MCP servers, helpers); after a grace of 4 s sweep the
    process group, but only if the group still holds a process from a snapshot taken before (same pid and start time), because the pgid
    can be recycled by an unrelated group (killed a bystander, 2026-08-30). Never sweep after a natural exit: a dev server the agent
    started on purpose must survive.
18. `main/pty.ts:411-418`, `main/shellEnv.ts:17-47`. Finding `claude` through an interactive login shell costs about a second (nvm, asdf);
    cache hits, never misses, and fence the output between markers because rc files print noise ("Restored session: ...").
19. `main/index.ts:5294-5373`. After laptop sleep, timers freeze and PTYs can wedge while node-pty keeps the fd; re-arm timers, drain
    the message backlog and probe each pid with signal 0 after a short grace.

### Typing

20. `renderer/hooks/<state hook>.ts:111-128`. Text and Enter in one write make the Enter part of a paste; send Enter as a separate write after
    a short delay, and wrap in bracketed paste only multi-line text.
21. `renderer/hooks/<state hook>.ts:138-142`. Single-line text goes without paste markers because one non-Claude TUI (agy) treats the markers
    as literal text and never submits.
22. `renderer/hooks/<state hook>.ts:84-88`. Serialise all writes per PTY; interleaved callers produced "Unknown command:
    /remote-control<next prompt>".
23. `renderer/hooks/<state hook>.ts:143-149`. A write to a dead PTY resolves with ok false instead of throwing; an unchecked await made failed
    deliveries look sent and the queue destroyed popped messages (#36). Check the result, keep the message, bound retries.
24. `renderer/hooks/<state hook>.ts:305-309,784,826`. Right after typing, the agent still reads idle until `UserPromptSubmit` arrives; a per-agent
    cooldown stops a second message landing on top.
25. `renderer/hooks/<state hook>.ts:678-689`. The wake loop once typed straight into the terminal and fused its text onto the user's half-written
    line, submitting a garbled prompt; every automatic writer now goes through the one gated queue.
26. `renderer/components/terminalAutomation.ts:30-39`. A 60 s draft expiry fired while the user was thinking; the cheap mistake is a
    parked message and the expensive one is treating a real draft as abandoned, so expiry became 30 minutes.
27. `renderer/components/terminalPool.ts:427-468`. The keystroke-count draft model drifts (a menu swallows keys, count stays above zero,
    "messages never arrive"); read the rendered prompt line, but only to clear a phantom, after a 1 s echo grace.
28. `renderer/components/terminalAutomation.ts:11-27`. Only a bare picker command latches the picker block; latching on the argument
    form wedged the queue for the rest of the session, and the block clears only on Enter, Esc or Ctrl-C or after 30 minutes.
29. `renderer/components/terminalPool.ts:532-569`. Ctrl-U kills the line but does not close a picker; clearing the draft used to tell
    automation the prompt was free while a picker was open, so the queued message went into the picker and was acknowledged as
    delivered. Never send Escape for the user.
30. `renderer/components/terminalPool.ts:350-369`. A paste is not a submit; xterm turns pasted newlines into carriage returns.
31. `renderer/components/terminalKeys.ts:1-30`. xterm.js sends Shift+Enter as a bare CR, so Shift+Enter submitted (#481); send ESC CR.
32. `shared/providerAutomation.ts:33-50`. A wrong slash command typed into a live terminal is worse than none; per-provider command
    tables are total, and `null` means "could not establish a command we trust".
33. `renderer/hooks/<state hook>.ts:1117-1134`. `/compact` on an agent with nothing new is refused locally ("Not enough messages to compact"),
    makes no API call, and so the token count stays identical and a pressure gate fires again on the same number; they sent it hourly for
    15 hours. Latch at delivery, not at enqueue. (That Claude refuses locally is the comment's claim; UNVERIFIED.)
34. `renderer/hooks/<state hook>.ts:753-765`. Refuse the one-time seed when the agent shows waiting or blocked; its trailing Enter would
    confirm a permission prompt.
35. `renderer/hooks/queueDelivery.ts:16-56`. Waiting and blocked hold the prompt because every delivery ends with Enter, which would answer
    it; unmeasurable silence fails closed. A breaker pin once made the one message meant to unwedge an agent undeliverable.
36. `renderer/hooks/queueDelivery.ts:66-92`. Queued items are decided at enqueue and delivered later; drop stale ones instead of deferring,
    and fail open when the check cannot run.
37. `renderer/store/store.ts:892-922`. Enforce "one pending nudge/compaction per agent" inside the enqueue function so no call site can route
    around it; the first nudge makes the agent drain everything, so later copies cost a full turn each for nothing.
38. `shared/<nudge>.ts:1-28`. The nudge lands after the agent has often already drained the mail; name ids as diagnostics only and say the
    folder is authoritative, or the agent burns a turn guessing.
39. `renderer/hooks/<state hook>.ts:280-299`. Track announced ids as a set, not a "newest id": an agent-chosen id that sorted high froze the
    high-water mark and the agent got one nudge per app launch.
40. `shared/providerAutomation.ts:239-257`. Ready means first output frame plus a short settle, not quiet output.
41. `main/pty.ts:60-67`. Do not type before the child has produced a frame, so startup prompts cannot outrun the TUI's subscription.

### Working, idle, waiting

42. `renderer/hooks/<state hook>.ts:637-676`. A lost turn-end signal pins an agent at working and starves both delivery paths; a 12 s PTY-silence
    backstop flips it to idle.
43. `main/workerWake.ts:47-66`. PTY output cannot vouch that a turn is running; a TUI redraws its chrome without working (17 minutes stalled).
44. `main/workerWake.ts:173-186`. A zero-token usage sample stamped at session start is not evidence of work.
45. `renderer/hooks/<state hook>.ts:522-547`. Notification means two things (needs you; merely idle); treating idle as blocked flagged agents
    right after they finished.
46. `renderer/hooks/usePtyParser.ts:24-39`. Never match the bare word "permission" on screen; the footer always says "bypass permissions on".
47. `main/workerWake.ts:1-31`. Delivery logic on a renderer timer stops when the window is throttled or hidden.

### Trust and permission prompts

48. `main/config.ts:861-877`. A fresh install shows a bypass warning that a PTY cannot answer in time; the agent exits 1 on its own
    ("reported by multiple users"). Pre-accepting means editing two of the user's files, and only when not already satisfied.
49. `main/config.ts:834-852`. UNVERIFIED for current builds: Claude looks the trust key up under a forward-slash path and walks parents;
    on Windows both spellings are written.
50. `shared/agentProvider.ts:545-548`. For another CLI they pass a flag to skip workspace trust "so unattended Mac Mini spawns do not stall".
51. `main/hooks.ts:502-519`. A tool deny returned from `PreToolUse` is race-free because it needs no round trip; slow human approval is
    left to Claude's own prompt.

### Stop hook, messages and loops

52. `main/hooks.ts:494-499`. Do not turn unread mail into a forced continuation at Stop; it bypassed draft and approval safety and could
    spend credits while a user was answering a question.
53. `main/<core>.ts:1630-1637,1654-1668`. Agent-authored hop counts are only carried and clamped; the harness counts only its own bounces.
54. `main/<core>.ts:1707-1739`. Mail to a recipient with no terminal still got filed and the sender learned nothing; the orchestrator mailed
    dead agents for hours (2026-08-16). Now a request to an archived agent is filed and its sender is told at once.
55. `main/<core>.ts:1699-1706`. Mail to a send-only agent sat unread for hours (task brief plus a reprimand about the unread inbox); bounce it.
56. `main/<core>.ts:1831`. A polling router is cheaper and sturdier than file watching on macOS; the poll timer froze during sleep and was the
    one timer never re-armed (`main/index.ts:5349-5363`).
57. `main/<core>.ts:1856-1887`. Agents write malformed JSON by hand (literal newlines inside strings), so they repair that case and quarantine
    the rest; the sender is the owning folder, not a field the agent writes.
58. `main/control.ts:1-14,68-75`. Steering through hook `additionalContext` avoids typing into the TUI at all; notes are delivered once,
    capped at 20, 10 000 characters each, oldest dropped.
59. `main/hooks.ts:572-579`. Only one `additionalContext` can come back per hook; merge sources into one.

### Terminal view

60. `renderer/components/terminalPool.ts:571-670`. Browsers allow about 16 live WebGL contexts and silently drop the oldest; addon-webgl's
    dispose does not release the context. A terminal held its context while hidden and went black with a healthy PTY. Lease the context on
    show, lose it on hide, keep a DOM-renderer fallback.
61. `renderer/components/terminalRecovery.ts:30-50`, `main/pty.ts:760-772`. Startup output can predate the browser's subscription, so ask the
    PTY for one redraw (they resize to the same size) after subscribing, and latch "done" only after the request succeeded; a failed
    one left a blank pane over a healthy process. Whether a same-size resize makes `claude` repaint is UNVERIFIED.
62. `renderer/components/terminalPool.ts:162-164,836-858`. Resize the PTY only when the grid actually changed; every resize repaints the TUI
    into scrollback. Never fit a hidden or unsized host (it proposes a tiny grid), and call xterm's `open()` only once its host element is in
    the document, because it measures the character cell on open.
63. `renderer/components/terminalPool.ts:720-727,861-885`. A terminal's scrollback exists only in the xterm instance and the PTY will not
    resend it, so keep the instance alive for the whole session and reset it in place on restart; disposing it left a dead pane that
    swallowed every keystroke.
64. `main/hiddenClaude.ts:9-24,26-27,122-124`. For one-shot answers: spawn an interactive PTY, wait for 1.5 s of silence (cap 7 s), paste,
    Enter after 140 ms, wait for 3.5 s of silence, then read the last assistant text from the transcript file, not the screen; kill the
    process group after.

### Spawn races, restarts and roster freshness (second pass)

65. `main/pty.ts:114-152,644-662`. Never put a prompt-carrying spawn through cmd.exe: it cuts an argument at its first newline, has no
    backslash escape and caps near 8191 characters, so Windows agents started healthy and never received their protocol. The deeper
    lesson, from the same incident: truncation passes every health check, so make any fallback that can lose data log loudly. Gonogo
    targets macOS and Linux, where argv arrays carry newlines intact.
66. `renderer/hooks/<state hook>.ts:317-319,328-332,1177-1190`. Guard spawns with a flag claimed synchronously before any await, because the window
    between "is it already running" and "spawn it" is racy (a re-render or double mount could otherwise spawn the boss twice). Debounce
    respawns (8 s) so a power resume and a screen unlock arriving back to back cannot respawn the same terminal twice. Relevant to a
    double-clicked Restart.
67. `renderer/store/store.ts:772-784`. The boss card's position was decided by a race between the boss bootstrap and the restore of other
    agents; fix such orderings at insertion, not by sorting on every render.
68. `main/<core>.ts:2564-2662`, `main/hooks.ts:529-543`. After a restart the orchestrator resumes a transcript that still describes the old floor
    and "will happily message agents that no longer exist", and telling it to read a file is not the same as it always knowing; so the
    live roster (one line, capped at 24 agents) is pushed into its context at session start and on every prompt, worded to supersede any
    earlier roster, and agents the user is working with directly are flagged "ON HOLD" so it does not dispatch to them. Directly relevant
    to gonogo's boss, which is restarted and resumed on every server start.

## 7. What contradicts or complicates the gonogo design

Stated plainly. Each item says what the design says, what I found, and where it comes from. "Reference" means the
prior-art source; "docs" means official documentation read on 2026-11-16.

### Breaks the design as written

C1. Stop-hook continuation. The design says a message to a working agent is "handed over when the agent's stop hook
fires, which makes the agent carry on with it". The reference built exactly that and then removed it, because it
bypassed the typing and permission guards and could spend credits while a user was answering a question (5.1). Docs add
limits: at most eight consecutive Stop continuations without a tool call, and `decision: "block"` shows as a hook error
unless you use the `additionalContext` form (5.4). The design's 15 s user-activity gate exists to stop typed text merging
with a half-typed prompt; a Stop continuation types nothing, so as written it would not be applied, yet the harm the
reference cites (the turn carrying on while the user is mid-answer) is of the same kind. At minimum the same gates should
apply, and note there is no signal that separates "the agent finished" from "the agent asked the user a question and is
waiting for the answer".

C2. "Stop means idle" is not complete. Stop does not fire when the user interrupts with Esc, and an API error fires
`StopFailure` instead (3.5). With the design's table the agent then stays "working", its queue never drains (delivery is
tied to Stop), and the loop-guard trigger "cleared when its stop hook fires" stays set, so a later unrelated message gets
hop plus one. The reference needed a 12 s PTY-silence backstop for this and never registered `StopFailure`. Register
`StopFailure`, clear the trigger on a user-typed `UserPromptSubmit`, and keep a silence fallback.

C3. Native cross-session tools will compete with gonogo's tools. Claude Code 2.1.224 and later ships `SendMessage` and
`ListAgents` in every session and delivers over a per-session Unix socket (docs: cross-session-messaging; this
environment already exports `CLAUDE_CODE_MESSAGING_SOCKET`). Two agents on the same machine are reachable by default.
Consequences for gonogo: an agent can message another without touching gonogo's server (no activity strip, no hop
count, no stopped-recipient rule); and when the two sessions are in different permission classes (one bypassing prompts,
one not), the receiver "holds" the message and an approval dialog opens in its terminal (default dialog expiry 5 minutes;
rules in docs: cross-session-messaging, "Control inbound messages"). A message typed by gonogo while that dialog is
open would answer it. The reference ran into the held-message deadlock ("held for the recipient user's approval", lesson 6).
Docs give the switches: `permissions.deny` entries `SendMessage` and `ListAgents` stop sending and listing (denying
`SendMessage` also removes messaging to subagents and agent-team teammates, since one tool serves both), and
`crossSessionInbound: "refuse"` drops inbound; the docs say a `--settings` value can set `crossSessionInbound`. Put both
in each agent's generated settings, or adopt native messaging on purpose. Whether `--settings` honours the deny rules
and the key is UNVERIFIED in practice. Native delivery also queues at most 50 messages and throttles loops per sender
(docs), which is worth knowing if gonogo ever chooses to use it.

C4. `default` is not "omit the flag". On 2.1.283 and later a terminal session with no flag starts in `auto`
(classifier-based), not Manual (1.7). The hire form's `default` must pass `--permission-mode default` (or `manual`), and
every restart must pass the mode again because resume restores the saved mode and never restores bypass. The reference's
"ask first" (omit the flag) would not be ask-first today. UNVERIFIED by a run; the fetch tool quoted the table.

C5. Startup dialogs and the initial state. Several dialogs can be on screen before any hook fires: workspace trust (the
boss's folder is "the directory gonogo was started from", and when that is the home directory Claude never saves the
trust, so the boss would ask on every server start), the bypass warning for `bypassPermissions`, the API key approval when
`ANTHROPIC_API_KEY` is set (the Docker route), and the "Resume this conversation?" dialog (4.2). The reference avoided
the first two by editing the user's own config files and has no handling for the others; it also starts agents as idle.
Whether any hook fires during these dialogs is UNVERIFIED (assume not). Gonogo should start every agent in a "starting"
state that refuses delivery until `SessionStart` arrives, and surface "no `SessionStart` after N seconds" as needs-you.
Whether to pre-accept by editing `~/.claude.json` is an owner decision (the docs document the key), and in Docker it can be
baked into the image.

C6. User activity gate. The design holds delivery for 15 s after the user's last keystroke and notes the shortcut. The
reference tried 60 s, abandoned it for a draft latch that clears on Enter, Esc or Ctrl-C and expires after 30 minutes, plus
a picker latch for bare slash commands that open menus, plus a rendered-line read to clear phantom drafts (2.5). With 15 s,
a paused draft is merged, and a menu opened by `/model`, `/config`, `/mcp`, `/resume` and similar is typed into after 15 s
of silence; the reference saw the text lost and the picker "got garbage" (lesson 29), and the trailing Enter can select an item.
The keystroke model needs only the WebSocket input the server already sees. The rendered-line read needs a terminal emulator on
the server.

C7. "Changes apply at the next restart" is weaker than it sounds. A resumed session reuses the system prompt recorded on
its first request until compaction (1.7), so an edited role in `--append-system-prompt` will not apply to a resumed agent.
Use `--system-prompt-snapshot off` (v2.1.257+) or, as the reference does for its standing goal, send the role text through
hook `additionalContext` at `SessionStart`/`UserPromptSubmit` and re-read it each time. The same applies to the boss's
roster: do not bake it into the system prompt (the reference pushes the live roster by hook for exactly this reason,
lesson 68). An edited working directory is less of a problem than the reference found: `--resume` finds a session in another
project since v2.1.223, so copying the transcript is no longer needed, and copies leave duplicates (1.3).

C8. Notification is not a single "needs you". The design maps "notification (permission or input wanted)" to needs-you.
`idle_prompt` is the normal idle state arriving about 60 s after a turn ends and is not a request for the user; `permission_prompt`
arrives only after the prompt has waited about 6 s (3.5). Use `notification_type`, and consider `PermissionRequest` for an
immediate signal. In the reference the one type check compares with the wrong value (3.1), and its state logic uses message
text only.

### Changes a design choice

C9. Typing the message body. The reference never types a message body into a Claude terminal; it types a one-line
pointer and the body stays in a file the agent reads. The design types the whole message, possibly multi-line, which the
reference only does for human-composed text (including Slack-origin work for its orchestrator). Its answer to "how a
multi-line message is typed reliably" is bracketed paste, a 140 ms pause, then a separate carriage return; that is UNVERIFIED
on 2.1.325 and needs a runner test, including a long text (a "Pasted text" placeholder may appear; UNVERIFIED) and a
contradiction to settle: the docs say Ctrl+J (a line feed) inserts a newline "in any terminal", while the reference saw bare
newlines submit fragments. A one-line pointer plus a tool call that returns the body would avoid the whole question.

C10. Idle is not the only safe state. Claude Code queues messages typed mid-turn (2.6). For a bypass-mode agent this allows
immediate delivery. For any other mode a permission dialog may be up while the state reads "working", so the design's
"never type into a terminal that is not idle" remains the safe rule. Keep it, but know the alternative exists.

C11. Message to a stopped or removed recipient. The design sends it to the user. The reference learned that the sender must
also be told at once (mail to a dead agent was filed and the sender waited for hours). With tool-based sending the send tool's
result can carry the failure reason synchronously; say so in the design.

C12. Session ids. The design assigns a fixed id at first start; the reference learns it from hooks, which failed whenever hooks
did not land. The fixed id is an improvement, but `--session-id` followed by `--resume` for the same id has no evidence in the
reference and none in docs beyond the flag's existence. Also: never run two processes on one session, so a restart must wait for
the old process group to be gone (1.3, lesson 17).

C13. Hook transport. The reference uses command hooks and a socket, fail-open by design. Gonogo plans HTTP hooks (valid per
docs), which fail open too: if the server is not reachable the hook is a non-blocking error and state silently goes stale.
Add a visible health signal (for example "agent running but no hook event since start"). The reference's earlier outage came
from starting agents before the hook receiver was up (lesson 11).

C14. Environment when gonogo is started from a Claude session. Agents inherit `CLAUDE_CODE_CHILD_SESSION` and 12 siblings
(1.4). Docs: such a child TUI is excluded from `--resume`. Strip by prefix and keep operator settings, or set
`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`. The set of operator-config variables is wider than the reference's keep list.

C15. Docker. Locale must be UTF-8 in the image (lesson 3). First-run dialogs (C5) apply to a fresh container. The state volume
must also hold `~/.claude.json`, where trust lives (VERIFIED docs: permissions); where key approvals live and whether the file
moves under `CLAUDE_CONFIG_DIR` is UNVERIFIED. The reference's pseudo-terminal library is node-pty `^1.0.0` (VERIFIED
`package.json`); its post-install step rebuilds native modules for Electron and runs two helper scripts, `tools/ensure-pty-perms.cjs`
and `tools/patch-node-pty-conpty.cjs`, which are not in the tree, so what they fix is inferred from their names (UNVERIFIED). The
reference is therefore no evidence that a compiler-free install exists; the builder must test a clean container and a clean macOS
account.

### Worth knowing

C16. The reference's default is bypass for every agent, so its handling of permission prompts is lightly tested (0.3). Gonogo's
boss runs in `default`, where prompts are routine; expect the "needs you" path to be exercised constantly.

C17. Replay for reconnecting browsers. The reference keeps each xterm instance alive in the renderer because scrollback exists
nowhere else. Gonogo's server buffer replays raw bytes into a new xterm, which could start mid-escape-sequence or lose screen
state (my inference; UNVERIFIED); the reference's remedy is a redraw request after attach. Whether a same-size resize makes `claude` repaint is UNVERIFIED (its `redraw` is
a same-size resize); test a resize to a different size and back. Also use ESC CR for Shift+Enter and lease the WebGL context.

C18. Process hygiene on stop, restart and remove: sweep the process group after a grace period with the pid-reuse guard (lesson 17);
not after a natural exit.

C19. Laptop sleep (lesson 19) applies to `npx gonogo` on a laptop; the design does not mention it.

C20. The reference persists mail and queued nudges across restarts; gonogo deliberately does not, so an old instruction never fires
days later. The reference's blog states the trade-off plainly (durable and inspectable, versus pull latency and hand-built
semantics). No contradiction; just note that its stale-item protection was a delivery-time precondition.

## 8. Open questions for a runner (real claude, within budget)

1. Does bracketed paste (ESC `[200~` ... ESC `[201~`), 140 ms, then `\r` submit one multi-line prompt on 2.1.325? What about a 10 KB text, and a bare `\n` or Ctrl+J instead of paste?
2. Does typing a message while Claude is working queue it natively, and when does `UserPromptSubmit` fire for it: at typing or at delivery?
3. Which hooks, if any, fire while the trust dialog, the bypass warning, the API key approval and "Resume this conversation?" are shown? When does `SessionStart` fire relative to them?
4. After Esc during a turn: no `Stop`; does anything else fire? Does `idle_prompt` follow after 60 s?
5. `--session-id <uuid>` on first start, then `--resume <uuid>` after exit: works? What happens with `--session-id` for an existing id?
6. Does a `--settings` file honour `crossSessionInbound`, `permissions.deny`, `skipDangerousModePermissionPrompt`, and `mcpServers`?
7. What does a session with no `--permission-mode` show in its status bar on 2.1.325 (confirms `auto` as the built-in default)?
8. Does a same-size PTY resize repaint? Does resizing to another size and back?
9. Does Shift+Enter sent as ESC CR insert a newline from xterm.js?
10. Do HTTP hooks with `allowedEnvVars` headers work, and what happens on connection refusal?
11. Does `CLAUDE_CODE_CHILD_SESSION=1` in the child's environment exclude it from `--resume`, and does `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` restore it?
12. Does 2.1.325 draw on the main screen or the alternate screen by default (the interactive-mode page mentions a fullscreen rendering
    mode)? This decides how safe it is to replay a truncated output buffer into a fresh xterm.

## 9. Not worth copying (for scale)

Electron IPC; the git-committed shared folder; OpenTelemetry collector and cost ledger; the circuit breaker; MemPalace and knowledge
graph; Slack and webhooks; kanban; voice; Windows shim decoding; the twelve other CLI providers and their bridges; auto-install of
missing CLIs; worktree isolation. All are in the design's non-goals or out of scope.

## 10. Run log

No model runs. One local command that does not call the API: `command claude --version`.

Commands run on the extracted tree (read-only; nothing executed from it, no interpreter started inside it; I used `cd` only to run
`ls`, `grep`, `sed`, `cat`, `wc`, `find` there):

- `ls -la`, `find . -maxdepth 3 -not -path '*/node_modules/*' -type d | head -80`, `ls -la src/main`, `ls -la src/shared`,
  `find . -type f | wc -l` (2067 files), `wc -l` on the key files.
- `grep -rn "submitToPty" src --include='*.ts' --include='*.tsx'`
- `grep -rn "drainForStop\|HOP_CAP\|stop_hook_active\|decision: *'block'\|\"decision\"" main shared renderer ...`
- `grep -rn "hops" main shared renderer ...`
- `grep -rn "permission_prompt\|idle_prompt\|notification_type\|elicitation" src ...`
- `grep -rn -i "hasCompletedOnboarding\|...\|skipDangerous\|skipAutoPermission\|hasTrustDialogAccepted..." main shared renderer ...`
- `grep -n "recordSession" main/*.ts`, `grep -n "ensureClaudePermissionsAccepted" main/*.ts`
- `grep -rn -- "--settings\|--append-system-prompt\|--session-id\|--resume\|--permission-mode\|--mcp-config\|--allowedTools ..." main shared`
- `grep -n -E "TRADEOFF|[Tt]rade-?off|[Gg]otcha|\b[Rr]ace\b|...|[Dd]o not|DO NOT" <each key file>` for item 6.
- `env | grep -i '^[^=]*claude[^=]*=' | cut -d= -f1 | sort` (names only).
- The `claude --version` command, exactly as in 0.4 (it prints `2.1.325 (Claude Code)`).

Official pages fetched on 2026-11-16 (all under `https://code.claude.com/docs/en/`): `hooks` (293 488 characters, read in three
slices), `cli-reference`, `permission-modes`, `permissions`, `sessions`, `settings-reference` (first 100 000 of 457 636 characters),
`env-vars` (first 100 000 of 192 529), `interactive-mode`, `authentication`, `cross-session-messaging`, `channels`, and `llms.txt` (index).
Channels (an MCP server pushing events into a session with `--channels`) is a research preview that requires claude.ai or Console API
key authentication and does not work with third-party providers; I did not evaluate it further.

No JSON was executed by me, and none of the reference's settings are reproduced verbatim.
