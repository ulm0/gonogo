# Spec: the app shell (Patch Panel, Flight Rules, Commissioning)

Written and built 2026-11-18. Two items of `docs/backlog.md` section 9: the command bar (here the Patch Panel) and the onboarding
wizard with a settings screen (here Commissioning and Flight Rules). Client only: no route, no frame, no state file and no protocol
type changed.

## Names

A patch panel connects any line to any other: the command bar. Flight rules are what the room runs by: its settings.
Commissioning is bringing a new station into service: the first-run checklist. None clashes with a position, a wall module or a
feature.

## Patch Panel

- `src/client/shell.ts` (pure, tested): `commands()` builds the lines from the room (consoles in room order by call sign, the eight
  views, then the actions); `fuzzyCost()` and `matchCommands()` filter and rank; `isPanelKey()` and `stepIndex()` are the keys.
- Only actions that exist: `openConsole`, the `show*` views, `openHire`, the brief box (the same focus trick as the phone bar's
  BRIEF), `api.startPoll`, `api.markAllRead`, `api.selectLivery`. A poll is listed only when `pollButtons` offers POLL and
  `pollTargets` is not empty; Mark read only with unread items; Apply livery only for liveries not in use.
- Match: the letters of the query, spaces ignored, in order, any case. A letter right after the last costs 0, one at the start of a
  word 1, any other the letters skipped plus 2. A match in the hidden words (an agent's own name, `settings`, `hire`, `theme`)
  costs 3 more than the same in the label. Ties keep the panel's order.
- `src/client/PatchPanel.tsx`: a `<dialog>` opened with `showModal()` (the browser traps focus and makes the page inert), the
  field a `combobox` with `aria-activedescendant` over a `listbox` of `option`s, so the keyboard never leaves the field. Esc and
  CLOSE close it; a click on the backdrop too. A line that changes the page closes the panel first and gives the keyboard back to
  the opener, then the view takes it to its title. A request keeps the panel open until it answers and shows its error.
- Open: Cmd+K or Ctrl+K on `window` (bubble phase: xterm takes Ctrl+K inside a terminal first), the round key in the top bar,
  PATCH in the phone bar (eight keys of 45 px at 390 px: the bar's gap went from 6 to 3 px and its side padding from 12 to 6).

## Brief dialog (2026-11-25)

- `isBriefKey()` in `shell.ts`: B with Cmd or Ctrl, no Alt or Shift. The `keydown` listener in `Office` (`App.tsx`, on `window`, bubble phase) handles both keys and keeps one state, `'panel' | 'brief' | null`: a key opens its dialog only when none is open, so a press while one is open does nothing. A key with `isComposing` (an input method) is ignored. `preventDefault` keeps the browser's own Ctrl+B (Firefox's bookmarks).
- `src/client/BriefDialog.tsx`: the house `Dialog` holding `Brief` unchanged, so long text, `enterSends` and Make this a mission are the same code as the room's box. The field takes the focus (Close does when the field is off); Esc and CLOSE shut it and give the keyboard back to the opener. `Office` renders it on every screen, the phone console included.
- After a send it stays open with the sent note: the Director sees it went, and Esc is one key. Make this a mission closes it first (`Brief`'s `onLeave`) and gives the keyboard back, then opens the draft.
- `Brief` now says `This room has no FLIGHT to brief.` when there is no boss (it was a silent disabled box).
- The panel's Brief FLIGHT line opens the dialog (`onBrief`) instead of going to the room and focusing `.brief-input`; the panel no longer takes `phone`. The phone bar's BRIEF and Flight Rules' brief step still go to the box in the page.
- shortcut: Ctrl+B typed in a terminal stays there (xterm takes it first, as with Ctrl+K); Cmd+B, or the panel, works there. Upgrade if people ask for it inside a console.

## Flight Rules

- `store.view` gains `rules`, `showRules`. `src/client/Rules.tsx` renders the wall's `MaxQ` and `Propellant` (exported from
  `WallView.tsx`, unchanged) and keys to the views where the other settings live: Livery, Launch Window (schedules, Uplink, Relay,
  Docking), each console's Edit form. It adds no setting.
- On a phone the wall hides Propellant and flattens its modules; `rules.css` shows them whole on this screen.
- Top bar: two round keys (Patch Panel, Flight Rules) before Livery. To keep the bar on one line at 1280 px its gap is 8 px
  (was 10).

## Commissioning

- Shown above the room while every agent is a boss (FLIGHT is created at the first start, so that is an empty room) and it was not
  put away. Steps: FLIGHT idle or working; a room Propellant limit in any window; a livery other than Instrument, or the Livery view
  opened from the checklist; the security note opened.
- Remembered per browser: `localStorage` `gonogo.commissioning`, a JSON array of `away`, `note`, `livery` (unknown values and bad
  JSON read as none). Why not the server: it is a convenience like the selected console, a server-side flag would need a state
  file, a route and a migration, and the cost of a second device showing it once is one press. Flight Rules can reset it.
- shortcut: the security note is a two-paragraph summary in the page, not the docs page (the app asks no other host); if the
  note grows, link the docs site.

## Not done

- No new settings, no per-user settings, no shortcut editor, no recent or pinned lines in the panel.
- Not verified: Firefox and Safari (`<dialog>` focus return differs), a real screen reader, a phone's software keyboard over the panel.

## Moved from the user page

- Commissioning marks (put away, note read, livery opened) live in one `localStorage` key, `gonogo.commissioning`: a convenience like the selected console, with no server state and no migration. A private window or blocked site data shows the checklist on every visit; nothing else breaks.
