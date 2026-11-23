/** The rules of one dock (docs/docking-collab-spec.md): who may send what, what happens on arrival and on delivery, what is told back. Each change is saved at once and asks for the password again like the other settings. */
import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { DockRules, DockView } from '../shared/protocol.js';
import * as api from './api.js';
import { RULE_FIELDS, STALE_HELP, staleProblem } from './dockRules.js';
import { useRun } from './WallView.js';

export function DockRulesBlock({ dock }: { dock: DockView }): ReactElement {
  const id = useId();
  const [rules, setRules] = useState<DockRules | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stale, setStale] = useState('');
  const [staleError, setStaleError] = useState<string | undefined>();
  const { busy, error, run } = useRun();
  useEffect(() => {
    let live = true;
    api.dockRules(dock.id).then(
      (found) => {
        if (!live) return;
        setRules(found);
        setStale(String(found.staleHours));
      },
      (e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [dock.id]);
  const save = (patch: Partial<DockRules>): void =>
    run(async () => {
      const next = await api.setDockRules(dock.id, patch);
      setRules(next);
      setStale(String(next.staleHours));
    });
  const submitStale = (event: FormEvent): void => {
    event.preventDefault();
    const problem = staleProblem(stale);
    setStaleError(problem);
    if (problem === undefined) save({ staleHours: Number(stale) });
  };
  return (
    <details className="dk-fold dk-rules">
      <summary>Rules for {dock.name}</summary>
      {loadError !== null && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {rules === null && loadError === null && <p className="hint">Reading the rules…</p>}
      {rules !== null && (
        <div className="dk-rules-body">
          {RULE_FIELDS.map((f) => (
            <div className="field" key={f.key}>
              <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
              <select id={`${id}-${f.key}`} className="input" value={rules[f.key]} aria-disabled={busy || undefined} aria-describedby={`${id}-${f.key}-h`} onChange={(e) => save({ [f.key]: e.target.value } as Partial<DockRules>)}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="hint" id={`${id}-${f.key}-h`}>
                {f.help(dock.name)}
              </p>
            </div>
          ))}
          <form className="field dk-stale" onSubmit={submitStale} noValidate>
            <label htmlFor={`${id}-stale`}>Tell my boss when a task is quiet for (hours)</label>
            <div className="dk-handoff">
              <input id={`${id}-stale`} className="input" type="text" inputMode="numeric" value={stale} aria-invalid={staleError !== undefined} aria-describedby={`${id}-stale-h`} onChange={(e) => setStale(e.target.value)} />
              <button type="submit" className="btn" aria-label={`Set the quiet time for ${dock.name}`} aria-disabled={busy || undefined}>
                Set
              </button>
            </div>
            <p className={staleError === undefined ? 'hint' : 'error'} id={`${id}-stale-h`}>
              {staleError ?? STALE_HELP(dock.name)}
            </p>
          </form>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </details>
  );
}
