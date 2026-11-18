# Patch Panel: the command bar

<PatchPanelMock class="doc-mock" />

The PATCH PANEL is one field that reaches every console, view and common action of the room from the keyboard. Design and limits:
[`docs/shell-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/shell-spec.md).

- **Open it** with Cmd+K or Ctrl+K anywhere on the page, with the round key of nine dots in the top bar (named Patch Panel for a
  screen reader), or with PATCH, the last key of the phone bar. Ctrl+K typed inside a terminal stays in the terminal (it is the
  shell's kill-line); Cmd+K opens the panel there too.
- **What it holds.** Open each console (by its call sign, or its own name), each view (Room, Comms: inbox, Comms: traffic, Comms: threads, Launch Window, Flight
  Plan, Mission Log, Livery, Flight Rules), and the actions the page already has: Docs (the online documentation, in a new tab), Staff a console, Brief FLIGHT, Start a T-minus
  poll (only when a poll can start and somebody can answer it), Mark the Downlink read (only when something is unread) and Apply
  livery for each livery that is not in use. Nothing else: it adds no action of its own.
- **Find.** Type any letters of a line in order: `fp` finds Flight Plan, `ml` Mission Log, `settings` Flight Rules. A line whose
  letters follow each other or start words comes first. Up and Down choose (they wrap), Enter runs, a click or a tap runs, Esc or
  CLOSE shuts it.
- **Running.** A view or a console opens at once and the panel closes. An action that asks the server (a poll, the Downlink, a
  livery) keeps the panel open until it answers, so an error shows in the panel.
- **Accessibility.** A modal dialog: the keyboard stays inside it and the page behind is out of reach while it is open. The field is
  a combobox with a list of options; the chosen one is read as you move. When it closes without running anything, the keyboard goes
  back to where it was.
- Nothing is stored and nothing is sent to the server until a line runs.
