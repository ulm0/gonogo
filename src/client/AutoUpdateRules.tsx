/** Flight Rules: AUTO-UPDATE (docs/features/update.md): the Docker self-update that runs by itself, off unless the Director turns it on. */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { AutoUpdateView, AutoUpdateWindow } from '../shared/protocol.js';
import * as api from './api.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The windows as the text box shows them: `02:00-05:00, 13:00-14:00`. */
export const windowsText = (windows: readonly AutoUpdateWindow[]): string => windows.map((w) => `${w.from}-${w.to}`).join(', ');

/** The text box back to windows, or null when a part is not HH:MM-HH:MM (24 hours) or from equals to. */
export function parseWindows(text: string): AutoUpdateWindow[] | null {
  const parts = text.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0 || parts.length > 4) return null;
  const out: AutoUpdateWindow[] = [];
  for (const part of parts) {
    const m = /^(\d\d:\d\d)\s*-\s*(\d\d:\d\d)$/.exec(part);
    if (m === null || !TIME.test(m[1] as string) || !TIME.test(m[2] as string) || m[1] === m[2]) return null;
    out.push({ from: m[1] as string, to: m[2] as string });
  }
  return out;
}

const hour = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function AutoUpdateBlock(): ReactElement | null {
  const id = useId();
  const [view, setView] = useState<AutoUpdateView | null>(null);
  const [windows, setWindows] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // another room answers 404: the block is room main's, so it simply is not there
    api.autoUpdate().then(
      (found) => {
        if (!live) return;
        setView(found);
        setWindows(windowsText(found.windows));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  if (view === null || (!view.available && view.unavailable === 'auto-update is for the Docker install')) return null;
  const apply = (work: Promise<AutoUpdateView>): void => {
    setProblem(null);
    work.then(
      (found) => {
        setView(found);
        setWindows(windowsText(found.windows));
      },
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    );
  };
  const parsed = parseWindows(windows);
  const newest = view.latest;
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        AUTO-UPDATE
      </h2>
      <label className="staff-check">
        <input type="checkbox" className="check" checked={view.enabled} disabled={view.source === 'env' || !view.available} onChange={(event) => apply(api.setAutoUpdate({ enabled: event.target.checked }))} />
        Update gonogo by itself, in the window below
      </label>
      {view.source === 'env' && <p className="hint">GONOGO_AUTO_UPDATE sets this switch: change the environment of the container.</p>}
      {!view.available && <p className="hint">Not available here: {view.unavailable}.</p>}
      <label className="field">
        <span className="label">WINDOWS (24 HOURS, LOCAL TIME)</span>
        <input className="input" aria-label="Auto-update windows" value={windows} onChange={(event) => setWindows(event.target.value)} onBlur={() => parsed !== null && windowsText(view.windows) !== windowsText(parsed) && apply(api.setAutoUpdate({ windows: parsed }))} />
      </label>
      {parsed === null && <p className="error">Windows look like 02:00-05:00, with commas between up to four; an end before the start runs over midnight.</p>}
      <p className="hint">
        It takes only the next patch of the version that runs (a new minor, such as 0.7.0, never installs by itself while gonogo is 0.x), one that has been out for a day, inside a window, once per version, and only after nothing has been working, waiting for you or open as a poll for 10 minutes, in every room. It tells the Downlink before and after, and uses the Update key&apos;s health check, rollback and UNDO. A version it rolled back is never tried again and it turns itself off. <strong>Turning it on lets the publisher&apos;s next patch run on this machine, with the Docker socket, without you reading it.</strong>
      </p>
      {view.enabled && view.plan !== null && (
        <p className="hint" role="status">
          Updates to {view.plan.version} at about {hour(view.plan.startsAt)} if nothing changes.{' '}
          <button type="button" className="btn" onClick={() => apply(api.skipAutoUpdate(view.plan?.version ?? ''))}>
            SKIP THIS VERSION
          </button>
        </p>
      )}
      {view.enabled && view.plan === null && view.waiting !== null && newest !== null && <p className="hint">Next: {newest} waits ({view.waiting}).</p>}
      {view.skipped.length > 0 && <p className="hint">Skipped: {view.skipped.join(', ')}.</p>}
      {view.note !== null && (
        <p className="error" role="alert">
          {view.note}
        </p>
      )}
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
