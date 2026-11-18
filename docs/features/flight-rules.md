# Flight Rules: settings and Commissioning

<FlightRulesMock class="doc-mock" />

FLIGHT RULES (the round key of three sliders in the top bar, or Flight Rules in the [Patch Panel](./patch-panel.md)) gathers the
settings you can change in the room on one screen. COMMISSIONING is the checklist of an empty room. Design and limits:
[`docs/shell-spec.md`](https://github.com/ulm0/gonogo/blob/main/docs/shell-spec.md).

## Flight Rules

- **MAX Q** and **PROPELLANT** for the room: the wall's own modules, so a limit set here is the one on the wall (see the
  [load governor](../guide/the-room.md#positions-t-minus-max-q-and-custom-agents) and [Propellant](./propellant.md)). On a phone
  the wall shows no Propellant module: this screen is where a phone sets it.
- **DEFAULT MODELS**: the model each engine starts with when a console has none of its own (see [Engine Bay](./engine-bay.md#model)).
- **LIVERY**: the name of the one in use and a key to the [Livery](./livery.md) view.
- **LAUNCH WINDOW**: a key to the view that holds schedules, [Uplink](./uplink.md), [Relay](./relay.md) and
  [Docking](./docking.md).
- **CONSOLES**: every console with its EDIT key (directory, role, engine, permission mode, payload). A console's own Propellant
  limit stays in its panel.
- **THIS BROWSER**: the [notifications](./notifications.md) switch, and SHOW COMMISSIONING AGAIN.

It adds no setting: each one is the same call as in its own place, kept on the server, so every device shows the same.

## Commissioning

A module above the room while FLIGHT is the only console (FLIGHT is made at the first start, so that is an empty room). Four
steps, each with a light and a key:

1. **Staff FLIGHT**: ticked when FLIGHT is idle or working, that is up and past its startup questions. OPEN FLIGHT opens its
   terminal.
2. **Set a Propellant limit**: ticked when the room has a limit in any window. FLIGHT RULES opens the screen above.
3. **Pick a livery**: ticked when the livery in use is not Instrument, or once you opened the Livery view from this key (keeping
   Instrument is a choice too).
4. **Read the security note**: SHOW THE NOTE opens two short paragraphs (the token is a password, the server runs shells as you,
   an agent in `bypassPermissions` mode runs as your user, dock only with people you trust) and ticks the step. The whole story is
   [Security](../reference/security.md).

PUT AWAY hides it. It also goes as soon as a second console is staffed.

**Where it is remembered: this browser.** The marks (put away, note read, livery opened) are one `localStorage` key,
`gonogo.commissioning`. It is a convenience like the selected console: no state file on the server, no migration, and a second
device that shows the checklist once more costs one press of PUT AWAY. A private window or blocked site data shows it on every
visit; nothing else breaks.
