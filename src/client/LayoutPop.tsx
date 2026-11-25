/** Layout: the popover that is the first thing Edit room offers (docs/ui-semantic.md, "Edit room"): three densities, Strip / Panel / Hidden for each panel, and the seats. The grid editor is one key in it. */
import type { ReactElement } from 'react';
import { EditRoomKey } from './EditRoomKey.js';
import { Pop } from './Pop.js';
import { DENSITIES, densityOf, PANELS, setRoomPrefs, useRoomPrefs } from './roomPrefs.js';
import type { Density, PanelMode } from './roomPrefs.js';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, Menu01Icon } from '@hugeicons/core-free-icons';

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

/** `icon`: a phone, where the key is a symbol (it keeps its name for a screen reader). */
export function LayoutPop({ icon = false }: { icon?: boolean }): ReactElement {
  const panels = useRoomPrefs((s) => s.panels);
  const seats = useRoomPrefs((s) => s.seats);
  const density = densityOf(panels);
  return (
    <Pop label={icon ? <HugeiconsIcon icon={Menu01Icon} className="size-4" aria-hidden="true" /> : <>Layout <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" aria-hidden="true" /></>} name="Layout of the room" align="end" className="lay-layout">
      {(close) => (
        <div className="lay-layout-pop">
          <div className="lay-pop-head">
            <b>Layout</b>
            <button type="button" className="btn" data-kind="quiet" onClick={close}>
              Close
            </button>
          </div>
          <p className="label">Density</p>
          <div className="lay-densities" role="group" aria-label="Density">
            {(Object.keys(DENSITIES) as Density[]).map((d) => (
              <button key={d} type="button" className="btn lay-density" aria-pressed={density === d} data-kind={density === d ? 'primary' : undefined} onClick={() => setRoomPrefs((s) => ({ ...s, panels: { ...DENSITIES[d] } }))}>
                <span>{DENSITY_TEXT[d].name}</span>
                <span className="hint">{DENSITY_TEXT[d].line}</span>
              </button>
            ))}
          </div>
          <p className="label">Each panel</p>
          <ul className="lay-panel-modes">
            {PANELS.map((p) => (
              <li key={p.id}>
                <span id={`lay-mode-${p.id}`}>{p.label}</span>
                <span className="lay-modes" role="group" aria-labelledby={`lay-mode-${p.id}`}>
                  {MODES.map((m) => (
                    <button key={m.mode} type="button" className="btn" aria-pressed={panels[p.id] === m.mode} data-kind={panels[p.id] === m.mode ? 'primary' : 'quiet'} onClick={() => setRoomPrefs((s) => ({ ...s, panels: { ...s.panels, [p.id]: m.mode } }))}>
                      {m.label}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="label">Open seats</p>
          <span className="lay-modes" role="group" aria-label="Open seats">
            <button type="button" className="btn" aria-pressed={seats === 'row'} data-kind={seats === 'row' ? 'primary' : 'quiet'} onClick={() => setRoomPrefs((s) => ({ ...s, seats: 'row' }))}>
              One row
            </button>
            <button type="button" className="btn" aria-pressed={seats === 'tiles'} data-kind={seats === 'tiles' ? 'primary' : 'quiet'} onClick={() => setRoomPrefs((s) => ({ ...s, seats: 'tiles' }))}>
              A tile each
            </button>
          </span>
          {!icon && <EditRoomKey />}
          <p className="hint">These choices are kept in this browser. Edit room arranges every block by hand and is saved for the room.</p>
        </div>
      )}
    </Pop>
  );
}
