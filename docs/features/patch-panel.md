# Patch Panel: the command bar

<PatchPanelMock class="doc-mock" />

One field that reaches every console, view and common action of the room from the keyboard. Design and limits: [`docs/shell-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/shell-spec.md).

- **Open**: Cmd+K or Ctrl+K, the nine-dot key in the top bar, or PATCH, last key of the phone bar. Ctrl+K inside a terminal stays in the terminal (kill-line); Cmd+K opens the panel there.
- **Holds**: each console (call sign or own name); each view (Room, Comms: inbox, Comms: traffic, Comms: threads, Launch Window, Flight Plan, Mission Log, Livery, Flight Rules); Docs (new tab), Staff a console, Brief FLIGHT, Start a T-minus poll (only when one can start and someone can answer), Mark the Downlink read (only when something is unread), Apply livery for each livery not in use. Nothing else.
- **Find**: type letters of a line in order (`fp` Flight Plan, `ml` Mission Log, `settings` Flight Rules); letters in a row or starting words rank first. Up/Down choose (wrap), Enter or click/tap runs, Esc or CLOSE shuts.
- **Running**: a view or console opens at once and the panel closes. An action that asks the server (poll, Downlink, livery) keeps the panel open until it answers, so errors show there.
- **Accessibility**: a modal dialog with a combobox; the keyboard stays inside; on close without running, focus returns.
- Nothing is stored or sent until a line runs.

## Brief FLIGHT anywhere

- **Open**: Cmd+B or Ctrl+B on any screen (the room, Comms, the Flight Plan, the Hangar, the hire form, a console on a phone with a keyboard), or the panel's Brief FLIGHT line (this is how a touch screen opens it; a console open on a phone has no PATCH key, so leave it first). Ctrl+B inside a terminal stays in the terminal; Cmd+B opens the dialog there.
- **Sends**: the same box as the room's: Enter sends to this room's FLIGHT, Shift+Enter is a new line, a long text goes as a file, Make this a mission closes the dialog and opens the draft. The page under it does not change.
- **After a send**: the dialog stays open and shows the sent note. Esc or CLOSE shuts it and the keyboard goes back to where it was. A text not sent is still there the next time it opens.
- **No FLIGHT, or FLIGHT stopped**: the box is off and says so, as in the room.
- One dialog at a time: Cmd/Ctrl+B or Cmd/Ctrl+K while any dialog is open (the panel, the brief, a password check, Select text) does nothing.
