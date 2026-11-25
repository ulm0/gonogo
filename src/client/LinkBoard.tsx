/** The cross-station board: everything that crosses a dock, derived from the links. OUT is what this station sent, IN what it holds from others, with a filter by station and by state; the keys are the ones the cards have. */
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { LinkLine } from './LinkLines.js';
import { boardRows, reviewCount, STATE_FILTERS } from './links.js';
import { useLinks } from './linksData.js';
import { useStore } from './store.js';
import { NativeSelect } from '@/ui/native-select.js';

export function LinkBoard(): ReactElement | null {
  const id = useId();
  const links = useLinks();
  const docks = useStore((s) => s.docking.docks);
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [station, setStation] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'review' | 'closed'>('open');
  if (links.length === 0) return null;
  const rows = boardRows(links, direction, station, filter);
  const review = reviewCount(links);
  const count = (d: 'out' | 'in'): number => links.filter((l) => (d === 'out' ? l.role === 'sender' : l.role === 'receiver')).length;
  return (
    <section className="dk-board module" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="label">
        ACROSS STATIONS{review > 0 ? ` · ${review} to review` : ''}
      </h3>
      <div className="dk-board-bar">
        <div role="group" aria-label="Direction" className="dk-board-dir">
          {(['out', 'in'] as const).map((d) => (
            <button key={d} type="button" className="btn" data-kind={direction === d ? 'primary' : 'quiet'} aria-pressed={direction === d} onClick={() => setDirection(d)}>
              {d === 'out' ? 'Sent' : 'Held'} {count(d)}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor={`${id}-s`}>Station</label>
          <NativeSelect id={`${id}-s`} value={station} onChange={(e) => setStation(e.target.value)}>
            <option value="">All stations</option>
            {docks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="field">
          <label htmlFor={`${id}-f`}>Show</label>
          <NativeSelect id={`${id}-f`} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            {STATE_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="loop-empty">Nothing here with these filters.</p>
      ) : (
        <ul className="dk-board-rows">
          {rows.map((l) => (
            <li key={l.id}>
              <p className="dk-board-title">
                <strong>{l.title}</strong> <span className="hint">{l.kind === 'mission' ? `mission ${l.mine}` : l.mine}</span>
              </p>
              <LinkLine link={l} dock={docks.find((d) => d.id === l.peer)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
