/** LAYOUT: the popover that replaces the grid editor as the first thing a person meets (docs/ui-semantic.md, "Edit room"): three densities, Strip / Panel / Hidden for each panel, and the seats. */
import type { ReactElement } from 'react';
import { NextPop } from './NextPop.js';
import { DENSITIES, densityOf, PANELS, setNext, useNext } from './nextState.js';
import type { Density, PanelMode } from './nextState.js';

const DENSITY_TEXT: Readonly<Record<Density, { name: string; line: string }>> = {
  focus: { name: 'Focus', line: 'Consoles and the terminal; the clock is the only chip.' },
  standard: { name: 'Standard', line: 'A status strip, the consoles and the terminal.' },
  full: { name: 'Full wall', line: 'Every panel as a box, as before.' },
};
const MODES: ReadonlyArray<{ mode: PanelMode; label: string }> = [
  { mode: 'strip', label: 'Strip' },
  { mode: 'panel', label: 'Panel' },
  { mode: 'hidden', label: 'Hidden' },
];

export function LayoutPop(): ReactElement {
  const panels = useNext((s) => s.panels);
  const seats = useNext((s) => s.seats);
  const density = densityOf(panels);
  return (
    <NextPop label="Layout ▾" name="Layout of the room" align="end" className="next-layout">
      {(close) => (
        <div className="next-layout-pop">
          <div className="next-pop-head">
            <b>Layout</b>
            <button type="button" className="btn" data-kind="quiet" onClick={close}>
              Close
            </button>
          </div>
          <p className="label">Density</p>
          <div className="next-densities" role="group" aria-label="Density">
            {(Object.keys(DENSITIES) as Density[]).map((d) => (
              <button key={d} type="button" className="btn next-density" aria-pressed={density === d} data-kind={density === d ? 'primary' : undefined} onClick={() => setNext((s) => ({ ...s, panels: { ...DENSITIES[d] } }))}>
                <span>{DENSITY_TEXT[d].name}</span>
                <span className="hint">{DENSITY_TEXT[d].line}</span>
              </button>
            ))}
          </div>
          <p className="label">Each panel</p>
          <ul className="next-panel-modes">
            {PANELS.map((p) => (
              <li key={p.id}>
                <span id={`next-mode-${p.id}`}>{p.label}</span>
                <span className="next-modes" role="group" aria-labelledby={`next-mode-${p.id}`}>
                  {MODES.map((m) => (
                    <button key={m.mode} type="button" className="btn" aria-pressed={panels[p.id] === m.mode} data-kind={panels[p.id] === m.mode ? 'primary' : 'quiet'} onClick={() => setNext((s) => ({ ...s, panels: { ...s.panels, [p.id]: m.mode } }))}>
                      {m.label}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="label">Open seats</p>
          <span className="next-modes" role="group" aria-label="Open seats">
            <button type="button" className="btn" aria-pressed={seats === 'row'} data-kind={seats === 'row' ? 'primary' : 'quiet'} onClick={() => setNext((s) => ({ ...s, seats: 'row' }))}>
              One row
            </button>
            <button type="button" className="btn" aria-pressed={seats === 'tiles'} data-kind={seats === 'tiles' ? 'primary' : 'quiet'} onClick={() => setNext((s) => ({ ...s, seats: 'tiles' }))}>
              A tile each
            </button>
          </span>
          <p className="hint">Kept in this browser. The saved room layout, which the grid editor writes, is not touched.</p>
        </div>
      )}
    </NextPop>
  );
}
