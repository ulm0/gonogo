/** Outbound: the last events that left for a dock, with the exact text and when the other station acknowledged it. Only the Director's own login can read it; the Black Box keeps kinds and counts only. */
import { useState } from 'react';
import type { ReactElement } from 'react';
import type { DockView, OutboundEntry } from '../shared/protocol.js';
import * as api from './api.js';
import { atText } from './uplink.js';
import { useNow } from './store.js';

export function OutboundBlock({ dock }: { dock: DockView }): ReactElement {
  const now = useNow();
  const [events, setEvents] = useState<OutboundEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (open: boolean): void => {
    if (!open) return;
    setError(null);
    api.outbound(dock.id).then(setEvents, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <details className="dk-fold dk-outbound" onToggle={(e) => load(e.currentTarget.open)}>
      <summary>What left for {dock.name}</summary>
      <p className="hint">The last 50 events sent to {dock.name}, as they left, and whether it answered.</p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {events !== null && events.length === 0 && <p className="hint">Nothing has been sent yet.</p>}
      {events !== null && events.length > 0 && (
        <ol className="dk-outbound-list">
          {events.map((e, i) => (
            <li key={`${e.link}:${e.seq}:${i}`}>
              <p className="dk-outbound-head">
                <span className="legend">{atText(e.at, now)}</span> <span className="chip" data-tone="quiet">{e.kind}</span>{' '}<span className="hint">{e.by}</span>{' '}
                <span className="hint">{e.ackedAt === null ? 'not acknowledged yet' : `acknowledged ${atText(e.ackedAt, now)}`}</span>
              </p>
              <p className="dk-outbound-text">{e.text}</p>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
