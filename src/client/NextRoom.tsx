/** The room view of the prototype layout (docs/ui-semantic.md): the status strip, then the consoles and the selected console's terminal; or, expanded, the terminal with a rail of names. */
import type { ReactElement } from 'react';
import { Commissioning } from './Rules.js';
import { NextOperations, NextRail, Needs, SelectedConsole, YourConsole } from './RoomView.js';
import { StatusStrip } from './StatusStrip.js';
import { useNext } from './nextState.js';

export function NextRoom({ phone }: { phone: boolean }): ReactElement {
  const expanded = useNext((s) => s.expanded);
  if (phone) {
    return (
      <main className="room room-phone next-room" data-phone="true">
        <StatusStrip phone />
        <Needs phone />
        <Commissioning />
        <NextOperations phone />
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
