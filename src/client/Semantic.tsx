/**
 * Flight Rules: SEARCH BY MEANING (docs/features/semantic-search.md). Shown when the feature is on. Two modes: MANAGED (gonogo runs its own Ollama on this machine:
 * it downloads the pinned release once, starts it when an entry has to be indexed, stops it when it is idle; the block shows what it is doing, the model, the keep-alive,
 * the idle time, the CPU threads, a memory limit and its log) and REMOTE (an Ollama server you run: the endpoint, the host you confirm when it is not this machine, and an
 * API key for one behind a proxy). Everything is saved behind the password again (api.ts turns the server's step-up answer into the dialog). The page shows counts and fixed
 * words from the server, never what a server said.
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { SemanticRequest, SemanticView } from '../shared/protocol.js';
import * as api from './api.js';
import { EMBEDDING_MODELS, managedStatusText, semanticStatusText } from './semanticview.js';
import { useFeature, useStore } from './store.js';
import { useRun } from './WallView.js';

type Mode = 'managed' | 'remote';

export function SemanticBlock(): ReactElement | null {
  const on = useFeature('semantic-search');
  const known = useStore((s) => s.info !== null);
  const id = useId();
  const [view, setView] = useState<SemanticView | null>(null);
  const [mode, setMode] = useState<Mode>('managed');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [confirm, setConfirm] = useState('');
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [ack, setAck] = useState(false);
  const [keepAlive, setKeepAlive] = useState('');
  const [idle, setIdle] = useState('');
  const [threads, setThreads] = useState('');
  const [memory, setMemory] = useState('');
  const [tested, setTested] = useState<string | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
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
        // the first setup starts on the managed mode; a saved one shows what it is
        // where the Clean Rooms share gonogo's network (the Docker default) the first setup starts on Remote: managed there needs him to say he understands
        setMode((was) => (view === null ? (found.configured ? found.mode : found.managed?.shared === true ? 'remote' : 'managed') : was));
        if (view === null) setAck(found.acknowledged);
        setEndpoint((was) => (was === '' ? found.endpoint : was));
        setModel((was) => (was === '' ? found.model : was));
        setConfirm((was) => (was === '' ? (found.confirmed ?? '') : was));
        if (found.managed !== null) {
          const s = found.managed.settings;
          setKeepAlive((was) => (was === '' ? s.keepAlive : was));
          setIdle((was) => (was === '' ? String(s.idleMinutes) : was));
          setThreads((was) => (was === '' ? String(s.threads) : was));
          setMemory((was) => (was === '' ? String(s.memoryMb) : was));
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // `view` is only read to tell the first answer from the next ones
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, known, logRev]);
  if (!on) return null;
  const managed = view?.managed ?? null;
  // the managed server has no login, and the Clean Rooms of this gonogo reach 127.0.0.1: saving managed needs his word
  const needsAck = mode === 'managed' && managed?.shared === true && !(view?.acknowledged ?? false);
  const num = (text: string): number => (/^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);
  const request = (): SemanticRequest => {
    if (mode === 'managed') return { mode, model, keepAlive: keepAlive.trim(), idleMinutes: num(idle), threads: num(threads), memoryMb: num(memory), ...(ack ? { acknowledge: true } : {}) };
    return { mode, endpoint, model, ...(confirm.trim() === '' ? {} : { confirm: confirm.trim() }), ...(removeKey ? { apiKey: null } : key === '' ? {} : { apiKey: key }) };
  };
  const changed =
    view !== null &&
    (!view.configured ||
      mode !== view.mode ||
      (mode === 'managed' && needsAck && ack) ||
      model !== view.model ||
      (mode === 'remote' && (endpoint !== view.endpoint || confirm !== (view.confirmed ?? '') || key !== '' || removeKey)) ||
      (mode === 'managed' &&
        managed !== null &&
        (keepAlive !== managed.settings.keepAlive || idle !== String(managed.settings.idleMinutes) || threads !== String(managed.settings.threads) || memory !== String(managed.settings.memoryMb))));
  const save = (): void =>
    run(async () => {
      const saved = await api.putSemantic(request());
      setView(saved);
      setKey('');
      setRemoveKey(false);
      setTested(null);
    });
  const action = (what: 'start' | 'stop'): void => run(async () => setView(await api.semanticManaged(what)));
  const showLog = (): void => run(async () => setLines(await api.semanticManagedLogs()));
  const percent = managed?.progress != null && managed.progress.total > 0 ? Math.min(100, Math.floor((managed.progress.done / managed.progress.total) * 100)) : null;
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        Search by meaning
      </h2>
      <p className="hint">
        The Mission Log is also searched by what an entry means. The text of every entry is sent to an Ollama server to be turned into vectors, either one that gonogo runs on this machine (managed) or
        one you run (remote). Search without an answer is a word search. The index is kept in this room, and everything here is changed behind your password.
      </p>
      {view !== null && (
        <>
          <fieldset className="rules-keys" aria-label="Mode">
            <label>
              <input type="radio" className="radio" name={`${id}-mode`} checked={mode === 'managed'} disabled={managed === null || managed.state === 'unsupported'} onChange={() => setMode('managed')} /> Managed: gonogo runs Ollama
            </label>
            <label>
              <input type="radio" className="radio" name={`${id}-mode`} checked={mode === 'remote'} onChange={() => setMode('remote')} /> Remote: an Ollama you run
            </label>
          </fieldset>
          {mode === 'managed' && managed !== null && (
            <>
              <p className="hint">
                gonogo downloads Ollama {managed.version} once (the file is 1.6 GB, of which about 80 MB are kept), checks its checksum before it opens it, and runs it only on 127.0.0.1 with a port of its own.
                It starts when an entry has to be indexed and stops after the idle time. Indexing on a CPU is slow: about half a second a piece of an entry, so a large log takes a while (the progress is below, and search by words works meanwhile).
              </p>
              {managed.shared && (
                <div className="hint" role="note">
                  <p>
                    <strong>Clean Rooms can reach this Ollama.</strong> The Clean Rooms of this gonogo share its network, so an agent in one can reach the Ollama that gonogo runs on 127.0.0.1. Ollama has no login: such an agent could
                    pull or delete models, chat with it, and fill the disk, and a flaw in Ollama would be a way out of the Clean Room. Remote (an Ollama outside this container) does not have this problem.
                  </p>
                  <label>
                    <input type="checkbox" className="check" checked={ack || view.acknowledged} disabled={view.acknowledged} onChange={(e) => setAck(e.target.checked)} /> I understand, and I want the managed Ollama anyway
                  </label>
                </div>
              )}
              <p className="hint" role="status">
                {managedStatusText(managed)}
              </p>
              {percent !== null && <progress aria-label="Progress" max={100} value={percent} />}
              <label htmlFor={`${id}-keep`}>Keep the model in memory for</label>
              <input id={`${id}-keep`} className="input" value={keepAlive} autoComplete="off" spellCheck={false} placeholder="5m" onChange={(e) => setKeepAlive(e.target.value)} />
              <label htmlFor={`${id}-idle`}>Stop Ollama after this many minutes without a request (0: never)</label>
              <input id={`${id}-idle`} className="input" inputMode="numeric" value={idle} autoComplete="off" onChange={(e) => setIdle(e.target.value)} />
              <label htmlFor={`${id}-threads`}>CPU threads for an embedding (0: Ollama chooses)</label>
              <input id={`${id}-threads`} className="input" inputMode="numeric" value={threads} autoComplete="off" onChange={(e) => setThreads(e.target.value)} />
              <label htmlFor={`${id}-mem`}>Memory limit in MB (0: none; over it Ollama is stopped)</label>
              <input id={`${id}-mem`} className="input" inputMode="numeric" value={memory} autoComplete="off" onChange={(e) => setMemory(e.target.value)} />
            </>
          )}
          {mode === 'remote' && (
            <>
              <label htmlFor={`${id}-endpoint`}>Endpoint</label>
              <input id={`${id}-endpoint`} className="input" value={endpoint} autoComplete="off" spellCheck={false} onChange={(e) => setEndpoint(e.target.value)} />
              <label htmlFor={`${id}-confirm`}>Send my notes to this host (only when it is not this machine)</label>
              <input id={`${id}-confirm`} className="input" value={confirm} autoComplete="off" spellCheck={false} placeholder="the host name, as in the endpoint" onChange={(e) => setConfirm(e.target.value)} />
              <label htmlFor={`${id}-key`}>API key (for an Ollama behind a proxy; sent as Authorization: Bearer, over https or to this machine only)</label>
              <input
                id={`${id}-key`}
                className="input"
                type="password"
                value={key}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={view.apiKeySet ? 'a key is saved: type another to replace it' : 'none'}
                onChange={(e) => {
                  setKey(e.target.value);
                  setRemoveKey(false);
                }}
              />
              {view.apiKeySet && (
                <label>
                  <input type="checkbox" className="check" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} /> Remove the saved key
                </label>
              )}
            </>
          )}
          <label htmlFor={`${id}-model`}>Model</label>
          <input id={`${id}-model`} className="input" list={`${id}-models`} value={model} autoComplete="off" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
          <datalist id={`${id}-models`}>
            {EMBEDDING_MODELS.map((m) => (
              <option key={m.name} value={m.name}>
                {m.note}
              </option>
            ))}
          </datalist>
          <p className="hint" role="status">
            {semanticStatusText(view)}
            {tested !== null ? ` ${tested}` : ''}
          </p>
          <div className="rules-keys">
            <button type="button" className="btn" data-kind="primary" aria-disabled={!changed || busy || (needsAck && !ack) || undefined} onClick={() => changed && !busy && !(needsAck && !ack) && save()}>
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
            {mode === 'managed' && managed !== null && view.mode === 'managed' && (
              <>
                <button type="button" className="btn" aria-disabled={busy || changed || managed.state === 'ready' || undefined} onClick={() => !busy && !changed && managed.state !== 'ready' && action('start')}>
                  Start Ollama
                </button>
                <button type="button" className="btn" aria-disabled={busy || managed.state === 'off' || undefined} onClick={() => !busy && managed.state !== 'off' && action('stop')}>
                  Stop Ollama
                </button>
                <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => !busy && showLog()}>
                  Show its log
                </button>
              </>
            )}
          </div>
          {/* what the server wrote is shown as plain text, never as markdown or HTML: a request path in it can be an agent's */}
          {lines !== null && mode === 'managed' && (
            <pre className="hint" aria-label="What Ollama wrote last" tabIndex={0}>
              {lines.length === 0 ? 'Nothing yet.' : lines.join('\n')}
            </pre>
          )}
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
