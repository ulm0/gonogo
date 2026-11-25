/** Offers a mission to a docked station (docs/docking-collab-spec.md, F): it makes its own mission, planned and led by its boss, and reports counts only. A date and a priority go with it. */
import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { LinkPriority, Mission } from '../shared/protocol.js';
import * as api from './api.js';
import { missionOffer, NO_TERMS, offerProblems } from './docking.js';
import type { OfferTerms } from './docking.js';
import { refreshLinks } from './linksData.js';
import { useStore } from './store.js';
import { useRun } from './WallView.js';
import { NativeSelect } from '@/ui/native-select.js';
import { Input } from '@/ui/input.js';

const PRIORITIES: ReadonlyArray<{ value: '' | LinkPriority; label: string }> = [
  { value: '', label: 'Normal' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
];

export function MissionHandOff({ mission }: { mission: Mission }): ReactElement | null {
  const id = useId();
  const docks = useStore((s) => s.docking.docks);
  const [open, setOpen] = useState(false);
  const [dockId, setDockId] = useState('');
  const [terms, setTerms] = useState<OfferTerms>(NO_TERMS);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useRun();
  if (docks.length === 0 || mission.status === 'done' || mission.status === 'aborted') return null;
  const dock = docks.find((d) => d.id === dockId) ?? docks[0];
  if (dock === undefined) return null;
  const problems = offerProblems(terms);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (problems.due !== undefined) return;
    run(async () => {
      await api.handOffMission(dock.id, missionOffer(mission.id, terms));
      await refreshLinks();
      setNotice(`${mission.name} offered to ${dock.name}. It makes its own mission; you see counts here, never its task titles.`);
      setOpen(false);
    });
  };
  if (!open) {
    return (
      <div className="dk-handoff">
        <button type="button" className="btn" data-kind="quiet" onClick={() => { setNotice(''); setOpen(true); }}>
          Hand off to a station
        </button>
        {notice !== '' && (
          <p className="hint dk-hint" role="status">
            {notice}
          </p>
        )}
      </div>
    );
  }
  return (
    <form className="dk-handoff" aria-label={`Hand off ${mission.name}`} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-s`}>Station</label>
        <NativeSelect id={`${id}-s`} value={dock.id} onChange={(e) => setDockId(e.target.value)}>
          {docks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="field">
        <label htmlFor={`${id}-d`}>Due (optional)</label>
        <Input id={`${id}-d`} type="text" placeholder="YYYY-MM-DD" value={terms.due} aria-invalid={problems.due !== undefined} onChange={(e) => setTerms({ ...terms, due: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-p`}>Priority</label>
        <NativeSelect id={`${id}-p`} value={terms.priority} onChange={(e) => setTerms({ ...terms, priority: e.target.value as OfferTerms['priority'] })}>
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || undefined}>
        {busy ? 'Handing off…' : 'Hand off'}
      </button>
      <button type="button" className="btn" data-kind="quiet" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {problems.due !== undefined && <p className="error dk-hint">{problems.due}</p>}
      {error !== null && (
        <p className="error dk-hint" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
