/** The room view: the status strip, then the consoles and the selected console's terminal; or, expanded, the terminal with a rail of names. */
import type { ReactElement } from 'react';
import { Commissioning } from './Rules.js';
import { TerminalBar } from './TerminalBar.js';
import { TerminalPane } from './TerminalPane.js';
import { openConsole, useStore } from './store.js';
import './layout.css';
import { Consoles, ConsoleRail, Needs, SelectedConsole, YourConsole } from './RoomView.js';
import { StatusStrip } from './StatusStrip.js';
import { useRoomPrefs } from './roomPrefs.js';

/** A phone's room: the selected console's terminal under the list (the first console when none is picked), with the same toolbar and Select. */
function PhoneTerminal(): ReactElement | null {
  const selected = useStore((s) => s.selected);
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const name = selected !== null && Object.hasOwn(agents, selected) ? selected : (order.find((n) => Object.hasOwn(agents, n)) ?? null);
  const full = useRoomPrefs((s) => s.expanded);
  if (name === null) return null;
  return (
    <section className="module lay-phone-term" aria-label={`Terminal of ${name}`} data-full={full || undefined}>
      <div className="lay-ops-head">
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

export function RoomScreen({ phone }: { phone: boolean }): ReactElement {
  const expanded = useRoomPrefs((s) => s.expanded);
  if (phone) {
    return (
      <main className="room room-phone lay-room" data-phone="true">
        <StatusStrip phone />
        <Needs phone />
        <Commissioning />
        <Consoles phone />
        <PhoneTerminal />
      </main>
    );
  }
  return (
    <>
      <StatusStrip phone={false} />
      <main className="room lay-room" data-expanded={expanded || undefined}>
        {expanded ? (
          <ConsoleRail />
        ) : (
          <div className="room-main">
            <Commissioning />
            <Consoles phone={false} />
            <YourConsole />
          </div>
        )}
        <SelectedConsole />
      </main>
    </>
  );
}
