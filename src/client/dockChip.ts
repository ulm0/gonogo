/** The "docked" chip of the status strip (the Director's glance at the stations this one is connected to), with no React. */
import type { DockView } from '../shared/protocol.js';

/** "DOCKED: lab, ops" ("DOCKED 2" on a phone); a station that does not answer turns it into "lab down" ("1 down" on a phone). Null with no dock. */
export function dockChipText(docks: readonly DockView[], phone: boolean): string | null {
  if (docks.length === 0) return null;
  const down = docks.filter((d) => d.status === 'down');
  if (down.length > 0) return phone ? `${down.length} down` : `${down.map((d) => d.name).join(', ')} down`;
  return phone ? `Docked ${docks.length}` : `Docked: ${docks.map((d) => d.name).join(', ')}`;
}

/** The word that says each station's state when colour is not seen: ok, down, new. */
export const dockStateWord = (dock: DockView): string => (dock.status === 'ok' ? 'answering' : dock.status === 'down' ? 'not answering' : 'waiting for the first answer');

/** What a screen reader hears: every station with its state, since the chip may be cut short. */
export const dockChipName = (docks: readonly DockView[]): string => `Docked with ${docks.map((d) => `${d.name}, ${dockStateWord(d)}`).join('; ')}. Open Docking in Flight Rules`;
