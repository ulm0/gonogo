/** The Director asks a docked station's shared knowledge. The answer is data from another station: shown as plain text, with the line the server puts first, and never kept. */
import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { DockView } from '../shared/protocol.js';
import * as api from './api.js';
import { useRun } from './WallView.js';

export function KnowledgeAsk({ dock }: { dock: DockView }): ReactElement {
  const id = useId();
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<{ text: string; results: number } | null>(null);
  const { busy, error, run } = useRun();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const q = query.trim();
    if (q === '') return;
    run(async () => setAnswer(await api.askDockKnowledge(dock.id, q)));
  };
  return (
    <details className="dk-fold dk-ask">
      <summary>Ask {dock.name} what it knows</summary>
      <form className="dk-handoff" onSubmit={submit}>
        <div className="field">
          <label htmlFor={`${id}-q`}>Question</label>
          <input id={`${id}-q`} className="input" type="text" maxLength={300} value={query} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="submit" className="btn" data-kind="primary" aria-label={`Ask ${dock.name}`} aria-disabled={busy || query.trim() === '' || undefined}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
        <p className="hint dk-hint">{dock.name} answers only from the entries and claims its Director marked as shareable with this station, and only if it has the rule on. At most 20 questions an hour.</p>
      </form>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {answer !== null && (
        <p className="dk-ask-answer" role="status">
          {answer.text}
        </p>
      )}
    </details>
  );
}
