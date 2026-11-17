# pi facts (checked 2026-11-17)

Verdict: usable as a screen-only engine. 0 model prompts ran; whether it is signed in was not checked.

## Commands run
- `which -a pi` -> a shell alias that sets an AWS profile, then `/opt/homebrew/bin/pi`. gonogo starts the binary by
  name from its own `PATH`, so the alias (and its profile) does not apply to agents.
- `pi --version` -> `1.5.2`.
- `pi --help` and `pi mcp --help`.

## What the help says
- `pi [options] [messages...]`: interactive by default, a positional message is the first prompt.
- `--append-system-prompt <text>` adds to the system prompt (repeatable). gonogo passes the role there.
- `--session-id <id>` uses or creates a session of the current directory; `--continue` and `--resume` exist too.
- MCP: `pi mcp add|remove|list|login|logout` edits `~/.pi/agent/mcp.json` or the project's `.pi/mcp.json`. There is no
  flag or environment variable for a per-session MCP file, and gonogo writes neither file. So pi gets no gonogo tools,
  no mail and no votes. `--no-mcp` exists.
- `--tui-mode fullscreen` is the default.
- Hooks: none in the help; extensions (`-e <path>`) could add some. Not used, so its state comes from output activity.

## Not verified
Its screen in gonogo's terminal, bracketed paste, sign-in, and whether the appended role is applied.
