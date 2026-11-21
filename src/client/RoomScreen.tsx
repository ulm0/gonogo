/** The room view: the status strip, then the consoles and the selected console's terminal; or, expanded, the terminal with a rail of names. */
import type { ReactElement } from 'react';
import { Commissioning } from './Rules.js';
import './layout.css';
import { Consoles, ConsoleRail, Needs, SelectedConsole, YourConsole } from './RoomView.js';
import { StatusStrip } from './StatusStrip.js';
import { useRoomPrefs } from './roomPrefs.js';

export function RoomScreen({ phone }: { phone: boolean }): ReactElement {
  const expanded = useRoomPrefs((s) => s.expanded);
  if (phone) {
    return (
      <main className="room room-phone lay-room" data-phone="true">
        <StatusStrip phone />
        <Needs phone />
        <Commissioning />
        <Consoles phone />
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
