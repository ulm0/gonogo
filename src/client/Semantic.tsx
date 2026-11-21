/**
 * Flight Rules: SEARCH BY MEANING (docs/features/semantic-search.md). Shown when the feature is on. The Director names the Ollama endpoint, the model and,
 * for a host that is not this machine, confirms that his notes may be sent there. The endpoint is saved behind the password again (api.ts turns the server's
 * step-up answer into the dialog). The page shows counts and fixed words from the server, never what the endpoint said.
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { SemanticView } from '../shared/protocol.js';
import * as api from './api.js';
import { semanticStatusText } from './semanticview.js';
import { useFeature, useStore } from './store.js';
import { useRun } from './WallView.js';

export function SemanticBlock(): ReactElement | null {
  const on = useFeature('semantic-search');
  const known = useStore((s) => s.info !== null);
  const id = useId();
  const [view, setView] = useState<SemanticView | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tested, setTested] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  // the page asks only when the feature is on: the route of a feature that is off answers 404
  const logRev = useStore((s) => s.log.rev);
  useEffect(() => {
    if (!on || !known) return;
    let live = true;
    api.getSemantic().then(
      (found) => {
        if (!live) return;
        setView(found);
        setEndpoint((was) => (was === '' ? found.endpoint : was));
        setModel((was) => (was === '' ? found.model : was));
        setConfirm((was) => (was === '' ? (found.confirmed ?? '') : was));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [on, known, logRev]);
  if (!on) return null;
  const changed = view !== null && (endpoint !== view.endpoint || model !== view.model || confirm !== (view.confirmed ?? ''));
  const save = (): void =>
    run(async () => {
      const saved = await api.putSemantic({ endpoint, model, ...(confirm.trim() === '' ? {} : { confirm: confirm.trim() }) });
      setView(saved);
      setTested(null);
    });
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        Search by meaning
      </h2>
      <p className="hint">
        The Mission Log is also searched by what an entry means. The text of every entry is sent to the embedding endpoint below (an Ollama server, <code>/api/embed</code>), which should be this machine. Search never waits for it:
        without an answer it is a word search. The index is kept in this room, and the endpoint is changed behind your password.
      </p>
      {view !== null && (
        <>
          <label htmlFor={`${id}-endpoint`}>Endpoint</label>
          <input id={`${id}-endpoint`} className="input" value={endpoint} autoComplete="off" spellCheck={false} onChange={(e) => setEndpoint(e.target.value)} />
          <label htmlFor={`${id}-model`}>Model</label>
          <input id={`${id}-model`} className="input" value={model} autoComplete="off" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
          <label htmlFor={`${id}-confirm`}>Send my notes to this host (only when it is not this machine)</label>
          <input id={`${id}-confirm`} className="input" value={confirm} autoComplete="off" spellCheck={false} placeholder="the host name, as in the endpoint" onChange={(e) => setConfirm(e.target.value)} />
          <p className="hint" role="status">
            {semanticStatusText(view)}
            {tested !== null ? ` ${tested}` : ''}
          </p>
          <div className="rules-keys">
            <button type="button" className="btn" data-kind="primary" aria-disabled={!changed || busy || undefined} onClick={() => changed && !busy && save()}>
              Save
            </button>
            <button
              type="button"
              className="btn"
              aria-disabled={busy || changed || undefined}
              onClick={() => !busy && !changed && run(async () => setTested(`Test: the endpoint answers with vectors of ${(await api.testSemantic()).dimension} numbers.`))}
            >
              Test
            </button>
          </div>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
