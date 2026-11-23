/** The terms of a task handoff, folded because most handoffs have none: a date, a priority, whether the other station may pass it on to a third, and the most it may spend. */
import type { ReactElement } from 'react';
import type { LinkPriority } from '../shared/protocol.js';
import type { OfferTerms } from './docking.js';

const PRIORITIES: ReadonlyArray<{ value: '' | LinkPriority; label: string }> = [
  { value: '', label: 'Normal' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
];

export function OfferTermsFields({ id, station, terms, problems, onChange }: { id: string; station: string; terms: OfferTerms; problems: { due?: string; budget?: string }; onChange(next: OfferTerms): void }): ReactElement {
  return (
    <details className="dk-fold dk-terms">
      <summary>Terms (optional)</summary>
      <div className="dk-handoff">
        <div className="field">
          <label htmlFor={`${id}-due`}>Due</label>
          <input id={`${id}-due`} className="input" type="text" placeholder="YYYY-MM-DD" value={terms.due} aria-invalid={problems.due !== undefined} aria-describedby={problems.due === undefined ? undefined : `${id}-due-e`} onChange={(e) => onChange({ ...terms, due: e.target.value })} />
          {problems.due !== undefined && (
            <p className="error" id={`${id}-due-e`}>
              {problems.due}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${id}-prio`}>Priority</label>
          <select id={`${id}-prio`} className="input" value={terms.priority} onChange={(e) => onChange({ ...terms, priority: e.target.value as OfferTerms['priority'] })}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-budget`}>Most it may spend (dollars)</label>
          <input id={`${id}-budget`} className="input" type="text" inputMode="decimal" value={terms.budget} aria-invalid={problems.budget !== undefined} aria-describedby={`${id}-budget-h`} onChange={(e) => onChange({ ...terms, budget: e.target.value })} />
          <p className={problems.budget === undefined ? 'hint' : 'error'} id={`${id}-budget-h`}>
            {problems.budget ?? `${station} enforces it with its own Propellant, and tells you the cost only if it has that rule on. An estimate, never a bill.`}
          </p>
        </div>
        <div className="staff-check">
          <input id={`${id}-onward`} type="checkbox" className="check" checked={terms.onward} onChange={(e) => onChange({ ...terms, onward: e.target.checked })} />
          <label htmlFor={`${id}-onward`}>{station} may pass it on to another station, with this text</label>
        </div>
      </div>
    </details>
  );
}
