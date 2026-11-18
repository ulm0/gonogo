# Spec: `gonogo tui` (draft)

Design by FIDO, 2026-11-18, task t33b. Status: draft, not built. Read from `web.ts`, `protocol.ts` (Part 3, frames) and the Downlink/Relief specs.

## Intent

Some people live in a terminal. `gonogo tui` is a second client of the **same running server**, usable at the same time as the web page:
the roster, a console, messages to and from the Director, the polls, Relief. It adds no server feature: if the server needs a route for it, that
is a gap in the API and is fixed there, for both clients.

## What the server already gives

- Browser token in `<home>/<BROWSER_TOKEN_FILE>` (0600). The TUI runs as the same user, so it reads the file; no URL to copy.
  Override: `--url`, `--token` (or `GONOGO_TOKEN`) for a server on another host.
- `GET /api/state` and the WebSocket `/ws` (`gonogo.v1` plus the token as second subprotocol): `snapshot`, then frames for agents,
  messages, Downlink, polls, Relief, Flight Plan. `attach`/`detach`/`input`/`resize` frames and binary output frames
  (`[kind, seq, bytes]`) for a console.
- REST for the actions: send a message (as the Director), `answer` a permission, `POST /api/relief/:id/go|no-go`, open/vote polls, Downlink read.
  Read and archived flags are on the server, so the web page and the TUI agree on what is unread.

## Options

1. **Plain ANSI, no new dependency (pick).** Alternate screen, raw mode, a pure `render(state, ui) -> string[]` function and a key table.
   Uses `ws` (already a dependency) and Node. The pty stream is already VT bytes, so an attached console **is** pass-through: output
   bytes go to stdout, stdin bytes become `input` frames. About 700 lines, almost all in the pure renderer, which is easy to test.
2. Ink (React for terminals) or blessed. Ink adds React-reconciler and yoga to a CLI that ships one small `node_modules`, and it fights with
   the pass-through of a raw console (it owns the screen). blessed is unmaintained. Rejected.

## Design

- **Command.** `gonogo tui [--url U] [--token T] [--home H]`. Needs a TTY (else exit 2 with a line). Node 24 only, no Windows.
- **Modules** (`src/tui/`): `client.ts` (WebSocket + REST, reconnect with the same backoff as the page, builds a state from the frames
  by reusing `src/client/store.ts` reducers if they are free of React; else a small copy), `render.ts` (pure), `keys.ts` (pure: key bytes
  to commands), `app.ts` (loop: raw mode, resize, redraw on state change, throttled to 20/s), `console.ts` (attach mode).
- **Screens** (first scope): **ROOM** (one line per agent: state glyph, name, position, `needs you` reason, held count; arrows move; Enter
  attaches; `n` writes a message to it; `h` hold, `r` resume), **INBOX** (Downlink: unread first; Enter reads; `r` replies as the Director
  by sending to the author; `a` archives), **NEEDS** (permission asks and Relief requests with `g`/`x` for GO/NO-GO; it is also the
  header strip of every screen, so an ask is never off screen), **POLL** (view, vote not needed: the Director calls it with `t`).
- **Console attach.** Takes the whole screen: snapshot from the server first, then raw pass-through. `Ctrl-]` is the escape (the key
  telnet uses; it is not used by Claude Code), then `q` detaches, `?` shows the keys. The pty has **one size**: the TUI sends `resize` when it
  attaches, and the web view of the same console follows (the existing `size` frame does that); the page and the TUI take turns. Said in the docs.
- **Layout.** Under 80 columns it shows one pane; at 100 or more, ROOM on the left, INBOX or NEEDS on the right. Colours: the 16 ANSI
  colours only, and `NO_COLOR` is honoured. Glyphs for state have a text twin (`working`, `idle`, `needs you`) so a screen reader or a log
  of the session still reads.
- **Same time as the web.** Both are ordinary WebSocket clients; the server treats them alike. An action in one shows in the other through the
  frames. The TUI stores nothing on disk.
- **Security.** The token is read, never printed, never put in argv for the local case (`--token` is documented as visible in `ps`; prefer the env).
  No agent token is involved. Same Origin rule: a non-browser client sends none, which the server already allows for the WebSocket.

## Minimal first scope (one PR)

ROOM, INBOX with reply, NEEDS (permission and Relief GO/NO-GO), console attach/detach, message to an agent, Hold/Resume, `?` help, reconnect.
**Left out:** Flight Plan, Missions, Mission Log, Recorder/Hangar (diffs and an editor in a terminal are a project of their own), settings,
hire form (use the page), polls beyond viewing, mouse, themes, Windows, remote hosts beyond `--url` (https needs nothing special: `ws`
supports `wss`).

## Order of changes

1. `render.ts`/`keys.ts` with tests (pure). 2. `client.ts` against a fake server, then the real one. 3. `app.ts` and the three screens.
4. `console.ts` pass-through. 5. `gonogo tui` in `cli.ts`, `docs/features/tui.md`, help text.

## Test plan

Renderer snapshots at 60, 80, 120 columns; key tables; a fake WebSocket server for frames, reconnect, backoff and the snapshot repaint;
the stand-in agent end to end through `node-pty` (attach, type, see output, detach, ensure the terminal is restored: raw mode off, alt
screen left, cursor visible, also on SIGINT and on a thrown error); `NO_COLOR`; narrow terminal. Not tested: terminal emulators other than
xterm-compatible ones; say so in the docs.

## As built (2026-11-18)

Built to the spec above. Where the build chose or differs:

- **Files.** `src/server/tui-*.ts`, flat in the server folder (`tui-state`, `tui-keys`, `tui-render`, `tui-client`, `tui-console`, `tui-app`, `tui-cli`), not a `src/tui/` folder: the package check lists `dist/server/*.js` module by module, so a new folder would have needed its own rule for no gain. `gonogo tui` is read in `main` before the server arguments and loads `tui-cli` only then.
- **State.** `src/client/store.ts` cannot be imported (it needs React), so `tui-state.ts` keeps the few facts the terminal shows: the roster, the Downlink, Relief and the poll. Every text of the server goes through `clean` (control, C1 and bidi characters become spaces) before it is drawn; a test feeds an escape sequence into every field.
- **GO and NO-GO only on the NEEDS screen.** The strip on every screen names the first request and says "(press 3)"; `g` and `x` act on the request under the cursor of NEEDS, so a key never answers something the Director has not seen in full. A permission answer carries the `needSeq` of the dialog it was shown, so a dialog that changed in the meantime is a 409 and not a wrong answer.
- **Keys.** ROOM: arrows or `j` `k`, Enter attach, `n` message, `h` hold, `r` resume. INBOX: Enter reads (and marks read), `r` replies to the author with the id of the message (`inReplyTo`), `a` archives. NEEDS: `g`, `x`. POLL: `t` calls a poll. `1`-`4` and Tab switch, `?` helps, `q` or Ctrl-C leaves. A message is one line (Enter sends; there is no bracketed paste, so a pasted line break sends early); Esc cancels, Ctrl-U clears.
- **Console.** Attach sends the size of this terminal (this client becomes the size owner), writes the snapshot, then passes bytes both ways; it attaches again after a reconnect. Ctrl-] then `q` leaves, `?` writes the keys on the last line (the console overwrites it when it next paints), Ctrl-] twice sends one Ctrl-], any other key after Ctrl-] is sent as it is.
- **Layout.** One pane under 100 columns, ROOM on the left and INBOX, NEEDS or POLL on the right from 100. The 16 ANSI colours; `NO_COLOR` set and not empty turns them off. A state is a glyph and a word (`* working`, `. idle`, `! needs you`, `- stopped`, `~ starting`, `on hold`).
- **Tests.** The pure parts (state, keys, render at 60 to 200 columns, the console escape, the command line); the client against a real `ws` server (subprotocol token, binary frames by attach seq, reconnect delays, a refused token, REST bodies); the loop with a fake terminal (restore on quit, Ctrl-C, SIGTERM, SIGHUP and a thrown error); and the real server with the stand-in agent, the terminal read back through an emulator (attach, type, resize, leave, hold, resume, quit). **Not tested:** a real tty and `node-pty` around `gonogo tui` itself (the streams are fakes), and terminals other than xterm-compatible ones. Nothing was run against a real `claude`.
- **Left out, as the spec says:** Flight Plan, Missions, Mission Log, Recorder and Hangar, settings, the hire form, polls beyond calling one, mouse, themes, Windows. `--url` takes an `https` address (the client uses `wss`); a self-signed certificate is not accepted.
