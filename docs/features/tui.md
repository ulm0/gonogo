# gonogo tui: the room in a terminal

`gonogo tui` is a second client of the same running server, for the Director who lives in a terminal. It shows the roster, the Downlink with replies, the go and no-go questions, and lets you type into a console. It adds nothing to the server: it uses the same WebSocket and REST as the page, and both can be open at once; an action in one shows in the other. Design and limits: [`docs/tui-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/tui-spec.md).

```
gonogo tui [--url <address>] [--token <token>] [--home <dir>]
```

It finds the browser token in the file `token` of gonogo's home (`~/.gonogo`, `--home` or `GONOGO_HOME`), which the same user can read, and the server at `http://127.0.0.1:7777` (the port of `GONOGO_PORT`). For a server elsewhere give `--url` (http or https) and the token in `GONOGO_BROWSER_TOKEN` (`--token` also works, but it shows in `ps`). The token is never printed, and gonogo removes `GONOGO_BROWSER_TOKEN` from the environment of every agent it starts; still, set it only in the shell that runs `gonogo tui`. It needs a terminal on stdin and stdout, Node 24, xterm-compatible escapes, and at least 20 columns by 6 rows; Windows is not supported. `NO_COLOR` turns the colour off.

## Screens

The top line names them and the link (`connected`, `reconnecting…`, `token refused`); the second line is always the first thing that waits for you: `NEEDS 2: ana: permission request: Bash: git push (press 3)`. From 100 columns the room is on the left and the inbox, needs or poll on the right; below that one screen at a time. A state is a glyph and a word, so a log of the session still reads: `* working`, `. idle`, `! needs you`, `- stopped`, `on hold`.

| Key | ROOM (1) | INBOX (2) | NEEDS (3) | POLL (4) |
|---|---|---|---|---|
| up, down, `j`, `k` | move | move | move | |
| Enter | attach to the console | read the message | | |
| `n` | write to the agent | | | |
| `h`, `r` | hold, resume | | | |
| `r`, `a` | | reply, archive | | |
| `g`, `x` | | | GO, NO-GO | |
| `t` | | | | call a T-minus poll |

`1` to `4` and Tab switch screens, `?` lists the keys, `q` or Ctrl-C leaves.

- **INBOX** lists the [Downlink](./downlink.md), unread first. Enter shows the whole message and marks it read (the page agrees: read and archived are kept on the server). `r` writes a reply to the author, sent as you, with the message as `inReplyTo`.
- **NEEDS** lists the permission dialogs of the agents and the [Relief](./relief.md) hire requests. GO and NO-GO work only here, on the request under the cursor, so a key never answers something you have not read in full. A permission answer names the dialog it was shown: if the dialog changed meanwhile, the server refuses it and nothing is typed.
- **Messages** are one line: Enter sends, Esc cancels, Ctrl-U clears. A pasted line break sends early.

## A console

Enter on an agent takes the whole screen: its current screen first, then everything it prints, and everything you type goes to it unchanged. The one way out is **Ctrl-]**, then `q`; Ctrl-] then `?` writes the keys on the last line (the console paints over it later); Ctrl-] twice sends one Ctrl-] to the console; another key after Ctrl-] is sent as it is. A console has one size: attaching resizes it to this terminal, and the page's view of it follows; the page and the terminal take turns. After a reconnect the console is attached again.

## What it does not do

Flight Plan, Missions, the Mission Log, the Recorder and Hangar, settings, staffing a console (use the page), polls beyond calling one, a mouse, themes. The terminal client keeps nothing on disk. Texts an agent wrote (names, reasons, messages) are shown with control characters taken out, so an agent cannot draw on your terminal.
