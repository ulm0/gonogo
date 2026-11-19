# gonogo tui: the room in a terminal

<TuiMock class="doc-mock" />

`gonogo tui` is a second client of the same running server, for the Director who lives in a terminal. It shows the roster, the Downlink with replies, the go and no-go questions, and lets you type into a console. It adds nothing to the server: it uses the same WebSocket and REST as the page, and both can be open at once; an action in one shows in the other. Design and limits: [`docs/tui-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/tui-spec.md).

```
gonogo tui [--url <address>] [--token <token>] [--home <dir>]
```

On the machine gonogo runs on it uses the **local socket** `<home>/run/api.sock` when it is there: no token, the file's permissions are the credential ([Login](./login.md)). Otherwise, or with `--url` or `--token`, it finds the browser token in the file `token` of gonogo's home (a fresh install only: an account deletes it; a remote TUI uses an API key as `--token`) (`~/.gonogo`, `--home` or `GONOGO_HOME`), which the same user can read, and the server at `http://127.0.0.1:7777` (the port of `GONOGO_PORT`). For a server elsewhere give `--url` (http or https) and the token in `GONOGO_BROWSER_TOKEN` (`--token` also works, but it shows in `ps`). The token is never printed, and gonogo removes `GONOGO_BROWSER_TOKEN` from the environment of every agent it starts; still, set it only in the shell that runs `gonogo tui`. It needs a terminal on stdin and stdout, Node 24, xterm-compatible escapes, and at least 20 columns by 6 rows; Windows is not supported. `NO_COLOR` turns the colour off.

## Signing in from another machine

`gonogo tui --url https://gonogo.example.com` with no key: the terminal looks for the session it stored for that server (`~/.config/gonogo/tui.json`, directory 0700 and file 0600, a file others can read is refused), and with none it **asks to be signed in**. It prints an address and a code (never in the address):

```
To sign in this terminal, open  https://gonogo.example.com/login/device  in a browser where you are signed in to gonogo,
and type this code (it is not in the address):

    ABCD-2345
```

In the browser you **type the code**, see the terminal's address, its name and its program, confirm your password again if it has been more than five minutes, and approve or deny. The terminal then has a session of its own: it lasts a week without use and 30 days in all, shows in Flight Rules → LOGIN as TERMINAL with REVOKE, and can do what a browser session can **except** what the step-up guards and the account (those say "do this in the browser"). `gonogo tui --logout --url <address>` ends it and forgets it.

**Approve only if you started it, on your own terminal, just now.** Somebody who talks you into entering their code gets a terminal as strong as your browser session. A request you did not start shows as a notice on your open pages before anyone asks you for anything.

- Not offered before an account exists, nor on a public name whose account has no second factor or passkey. At most two terminals wait per address and five in all; one that cannot be approved at once is told to use a key (`gonogo auth key add <name> --scope full --remote`, then `--token`).
- `http://` to a public name is refused; to a private name the terminal warns that it is not encrypted. There is no flag to skip the certificate check.
- A redirect is never followed, and the session is sent to the exact address it was made for. The first use from another network than the one it was approved from is a notice.
- From a script there is no flow: give a key with `--token` or `GONOGO_BROWSER_TOKEN`. Order: `--token`, the environment, the stored session, the device login (terminal only).

## Screens

The top line starts with the name of the room as the browser tab says it (`gonogo`, or the station, or the [tab name](./flight-rules.md)), then names the screens and the link (`connected`, `reconnecting…`, `token refused`); the second line is always the first thing that waits for you: `NEEDS 2: ana: permission request: Bash: git push (press 3)`. From 100 columns the room is on the left and the inbox, needs or poll on the right; below that one screen at a time. A state is a glyph and a word, so a log of the session still reads: `* working`, `. idle`, `! needs you`, `- stopped`, `on hold`.

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

The agent's output decides what a console prints, so two kinds of sequence are cut before they reach your terminal: the ones that write the clipboard (OSC 52) and the ones that set the title of the window or the tab (OSC 0, 1, 2). Colours, the cursor, the alternate screen and hyperlinks pass. The filter works across the pieces the output arrives in. The 8-bit forms of these sequences are not handled; a UTF-8 terminal does not read them.

## What it does not do

Flight Plan, Missions, the Mission Log, the Recorder and Hangar, settings, staffing a console (use the page), polls beyond calling one, a mouse, themes. The terminal client keeps nothing on disk. Texts an agent wrote (names, reasons, messages) are shown with control characters taken out, so an agent cannot draw on your terminal.
