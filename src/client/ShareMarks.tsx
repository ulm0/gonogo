/**
 * Share marks (docs/docking-collab-spec.md, I): the Director chooses which docked stations may ask for one Mission Log entry or one claim. Nothing is shared by default; an agent cannot
 * set this. Only a short snippet of what is marked ever leaves, and only for a station whose "answer knowledge questions" rule is on.
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import * as api from './api.js';
import type { DockShare } from './api.js';
import { useStore } from './store.js';
import { useRun } from './WallView.js';
import { Checkbox } from '@/ui/checkbox.js';

/** One copy of the marks for every row of the page, read when a row opens and after each change. */
let marks: DockShare[] | null = null;
const watchers = new Set<() => void>();
export async function refreshShares(): Promise<void> {
  try {
    marks = await api.dockShares();
  } catch {
    marks = marks ?? [];
  }
  for (const w of watchers) w();
}

/** The docks that may ask for this key of this kind. */
export const docksOf = (list: readonly DockShare[], kind: DockShare['kind'], key: string): string[] => list.find((m) => m.kind === kind && m.key === key)?.docks ?? [];

/** The new list of docks when one box is ticked or cleared: kept in the order of the docks of the page. */
export const toggled = (current: readonly string[], dock: string, on: boolean, order: readonly string[]): string[] => order.filter((d) => (d === dock ? on : current.includes(d)));

export function ShareMarks({ kind, id, label }: { kind: DockShare['kind']; id: string; label: string }): ReactElement | null {
  const key = useId();
  const docks = useStore((s) => s.docking.docks);
  const [, render] = useState(0);
  const { busy, error, run } = useRun();
  useEffect(() => {
    const w = (): void => render((n) => n + 1);
    watchers.add(w);
    if (marks === null) void refreshShares();
    return () => void watchers.delete(w);
  }, []);
  if (docks.length === 0) return null;
  const current = docksOf(marks ?? [], kind, id);
  const order = docks.map((d) => d.id);
  return (
    <fieldset className="dk-share" disabled={busy}>
      <legend className="legend">{label}</legend>
      {docks.map((d) => (
        <div className="staff-check" key={d.id}>
          <Checkbox
            id={`${key}-${d.id}`}
            checked={current.includes(d.id)}
            onChange={(e) => run(async () => { await api.setDockShare(kind, id, toggled(current, d.id, e.target.checked, order)); await refreshShares(); })}
          />
          <label htmlFor={`${key}-${d.id}`}>{d.name}</label>
        </div>
      ))}
      <p className="hint">{current.length === 0 ? 'Not shared with any station.' : 'A station that has the rule on can ask for this one, and gets a short snippet, never the whole text.'}</p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
