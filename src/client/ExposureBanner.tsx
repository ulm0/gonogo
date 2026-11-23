/** The insecure-setup banner under the top bar: what is open in this install, how to close it, and a Dismiss for each (for good: the server remembers). Nothing when there is nothing to say. */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { ExposureFindingView } from '../shared/protocol.js';
import * as api from './api.js';
import { BANNER_ROWS, bannerFindings, bannerTitle, bannerTone, EXPOSURE_REFRESH, SEVERITY_WORDS } from './exposureModel.js';

function Row({ finding, busy, onDismiss }: { finding: ExposureFindingView; busy: boolean; onDismiss: () => void }): ReactElement {
  return (
    <li className="exposure-row">
      <span className="chip" data-tone={finding.severity === 'high' ? 'nogo' : 'amber'}>
        {SEVERITY_WORDS[finding.severity]}
      </span>
      <div className="exposure-text">
        <p>{finding.text}</p>
        <p className="hint">{finding.fix}</p>
      </div>
      <button type="button" className="btn" data-kind="quiet" aria-label={`Dismiss: ${finding.text}`} aria-disabled={busy || undefined} onClick={onDismiss}>
        Dismiss
      </button>
    </li>
  );
}

export function ExposureBanner(): ReactElement | null {
  const [list, setList] = useState<ExposureFindingView[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback((): void => {
    void api.exposureFindings().then((found) => setList(found === null ? [] : bannerFindings(found)));
  }, []);
  useEffect(() => {
    load();
    // a change in Flight Rules (any write of this page) or coming back to the tab can change what is open
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = (): void => {
      clearTimeout(timer);
      timer = setTimeout(load, 800);
    };
    window.addEventListener(EXPOSURE_REFRESH, soon);
    window.addEventListener('focus', soon);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(EXPOSURE_REFRESH, soon);
      window.removeEventListener('focus', soon);
    };
  }, [load]);
  const dismiss = async (ids: string[]): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      for (const id of ids) await api.dismissExposure(id);
    } catch {
      // the list is read again below: what is still open stays shown
    } finally {
      setBusy(false);
      load();
    }
  };
  if (list.length === 0) return null;
  const first = list.slice(0, BANNER_ROWS);
  const rest = list.slice(BANNER_ROWS);
  return (
    <aside className="exposure-banner flood" data-tone={bannerTone(list)} aria-label="Insecure setup">
      <div className="exposure-head">
        <strong>{bannerTitle(list.length)}</strong>
        {list.length > 1 && (
          <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => void dismiss(list.map((f) => f.id))}>
            Dismiss all
          </button>
        )}
      </div>
      <ul className="exposure-list">
        {first.map((f) => (
          <Row key={f.id} finding={f} busy={busy} onDismiss={() => void dismiss([f.id])} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="exposure-more">
          <summary className="btn" data-kind="quiet">
            {rest.length} more
          </summary>
          <ul className="exposure-list">
            {rest.map((f) => (
              <Row key={f.id} finding={f} busy={busy} onDismiss={() => void dismiss([f.id])} />
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}
