/** The room view of the prototype layout (docs/ui-semantic.md): the status strip, then the consoles and the selected console's terminal; or, expanded, the terminal with a rail of names. */
import type { ReactElement } from 'react';
import { Commissioning } from './Rules.js';
import { TerminalPane } from './TerminalPane.js';
import { TerminalBar } from './NextTerminal.js';
import { openConsole, useStore } from './store.js';
import { NextOperations, NextRail, Needs, SelectedConsole, YourConsole } from './RoomView.js';
import { StatusStrip } from './StatusStrip.js';
import { useNext } from './nextState.js';

/** A phone's room: the selected console's terminal under the list (the first console when none is picked), with the same toolbar and Select. */
function PhoneTerminal(): ReactElement | null {
  const selected = useStore((s) => s.selected);
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const name = selected !== null && Object.hasOwn(agents, selected) ? selected : (order.find((n) => Object.hasOwn(agents, n)) ?? null);
  if (name === null) return null;
  return (
    <section className="module next-phone-term" aria-label={`Terminal of ${name}`}>
      <div className="next-ops-head">
        <h2 className="label">{name.toUpperCase()}</h2>
        <span className="topbar-grow" />
        <button type="button" className="btn" data-kind="quiet" onClick={() => openConsole(name)}>
          Open console
        </button>
      </div>
      <TerminalBar phone />
      <TerminalPane agent={agents[name]} />
    </section>
  );
}

export function NextRoom({ phone }: { phone: boolean }): ReactElement {
  const expanded = useNext((s) => s.expanded);
  if (phone) {
    return (
      <main className="room room-phone next-room" data-phone="true">
        <StatusStrip phone />
        <Needs phone />
        <Commissioning />
        <NextOperations phone />
        <PhoneTerminal />
      </main>
    );
  }
  return (
    <>
      <StatusStrip phone={false} />
      <main className="room next-room" data-expanded={expanded || undefined}>
        {expanded ? (
          <NextRail />
        ) : (
          <div className="room-main">
            <Commissioning />
            <NextOperations phone={false} />
            <YourConsole />
          </div>
        )}
        <SelectedConsole />
      </main>
    </>
  );
}
