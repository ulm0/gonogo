# gonogo tui: the room in a terminal

<TuiMock class="doc-mock" />

`gonogo tui` is a second client of the running server for a Director who lives in a terminal: roster, Downlink with replies, go and no-go questions, and typing into a console. It uses the page's WebSocket and REST; both can be open at once. Design and limits: [`docs/tui-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/tui-spec.md).

```
gonogo tui [--url <address>] [--token <token>] [--home <dir>] [--room <id>]
gonogo tui --logout --url <address>
```

| Setting | Meaning |
|---|---|
| default (same machine) | local socket `<home>/run/api.sock`, no token ([Login](./login.md)) |
| otherwise / `--url` / `--token` | token from file `token` in the home (`~/.gonogo`, `--home` or `GONOGO_HOME`; fresh installs only, an account deletes it), server `http://127.0.0.1:7777` (`GONOGO_PORT`) |
| `--url` | other server, http or https |
| `GONOGO_BROWSER_TOKEN` | token for a remote server (an API key); `--token` also works but shows in `ps`. Set it only in the shell that runs the tui; gonogo removes it from agents' environments |
| `NO_COLOR` | colour off |

Needs a terminal on stdin and stdout, Node 24, xterm-compatible escapes, at least 20 columns by 6 rows. Windows is not supported. The token is never printed. Token order: `--token`, the environment, the stored session, the device login (terminal only).

## Signing in from another machine

`gonogo tui --url https://gonogo.example.com` with no key uses the session stored at `~/.config/gonogo/tui.json` (directory 0700, file 0600; a file others can read is refused). With none, it prints an address and a code:

```
To sign in this terminal, open  https://gonogo.example.com/login/device  in a browser where you are signed in to gonogo,
and type this code (it is not in the address):

    ABCD-2345
```

In the browser, type the code, check the terminal's address, name and program, confirm your password if more than 5 minutes passed, then approve or deny. The terminal gets its own session: a week unused, 30 days in all, shown in Flight Rules → LOGIN as TERMINAL with REVOKE. It can do what a browser session can **except** what step-up and account settings guard ("do this in the browser"). `--logout` ends and forgets it.

**Approve only if you started it, on your own terminal, just now.** Whoever talks you into entering their code gets a terminal as strong as your browser session. A request you did not start shows as a notice on your open pages.

- Not offered before an account exists, nor on a public name whose account has no second factor or passkey.
- At most two terminals wait per address, five in all; one not approvable at once is told to use a key: `gonogo auth key add <name> --scope full --remote`, then `--token`.
- `http://` to a public name is refused; to a private name it warns it is unencrypted. No flag skips the certificate check.
- Redirects are never followed; the session goes only to its exact address. First use from another network than the approval's is a notice.
- Scripts have no flow: pass a key.

## Screens

Top line: room name (as the browser tab says it; `gonogo`, the station, or the [tab name](./flight-rules.md)), screens, link (`connected`, `reconnecting...`, `token refused`). Second line: what waits for you, e.g. `NEEDS 2: ana: permission request: Bash: git push (press 3)`. From 100 columns the room is left and inbox/needs/poll right; below that one screen at a time. States read as glyph and word: `* working`, `. idle`, `! needs you`, `- stopped`, `on hold`.

| Key | ROOM (1) | INBOX (2) | NEEDS (3) | POLL (4) |
|---|---|---|---|---|
| up, down, `j`, `k` | move | move | move | |
| Enter | attach console | read message | | |
| `n` | write to agent | | | |
| `h`, `r` | hold, resume | | | |
| `r`, `a` | | reply, archive | | |
| `g`, `x` | | | GO, NO-GO | |
| `t` | | | | call T-minus poll |

`1` to `4` and Tab switch screens, `?` lists keys, `q` or Ctrl-C leaves.

- **INBOX**: the [Downlink](./downlink.md), unread first. Enter shows the message and marks it read (kept on the server). `r` replies to the author as you, with `inReplyTo`.
- **NEEDS**: permission dialogs and [Relief](./relief.md) hire requests. GO and NO-GO work only here, on the request under the cursor. A permission answer names its dialog; if it changed, the server refuses and nothing is typed.
- Messages are one line: Enter sends, Esc cancels, Ctrl-U clears. A pasted line break sends early.

## A console

Enter on an agent takes the screen; what you type goes to it unchanged. Leave with **Ctrl-]** then `q`. Ctrl-] then `?` writes the keys on the last line; Ctrl-] twice sends one Ctrl-]; another key is sent as is. Attaching resizes the console to this terminal (the page's view follows; they take turns). A reconnect re-attaches.

Cut before your terminal: clipboard writes (OSC 52) and window/tab title sequences (OSC 0, 1, 2), across output pieces. Colours, cursor, alternate screen and hyperlinks pass. 8-bit forms are not handled (a UTF-8 terminal ignores them).

## Not in the tui

Flight Plan, Missions, Mission Log, Recorder, Hangar, settings, staffing a console, polls beyond calling one, mouse, themes. Nothing is kept on disk by the client. Agent-written texts are shown with control characters removed.
