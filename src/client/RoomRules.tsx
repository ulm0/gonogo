import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { RulesView } from '../shared/protocol.js';
import * as api from './api.js';

/** Flight Rules: the rules every agent of the room starts with (docs/features/door.md). Saving asks for the password again. */
export function RoomRulesBlock(): ReactElement {
  const id = useId();
  const [saved, setSaved] = useState<RulesView | null>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.rulesView().then(
      (found) => {
        if (!live) return;
        setSaved(found);
        setText(found.text);
      },
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const bytes = new TextEncoder().encode(text.trim()).length;
  const max = saved?.max ?? 8192;
  const changed = saved !== null && text.trim() !== saved.text;
  const save = (): void => {
    setBusy(true);
    setProblem(null);
    api.setRules(text).then(
      (found) => {
        setSaved(found);
        setText(found.text);
        setBusy(false);
      },
      (e: unknown) => {
        setProblem(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        RULES
      </h2>
      <p className="hint">How we work here, for every agent of this room: branches, reports, what never to touch. Added to the role text of each agent when it starts, on every engine that takes one.</p>
      {saved !== null && (
        <>
          <label htmlFor={`${id}-text`} className="rules-call">
            Room rules
          </label>
          <textarea id={`${id}-text`} className="textarea" rows={8} value={text} autoComplete="off" spellCheck={false} aria-describedby={`${id}-count`} onChange={(event) => setText(event.target.value)} />
          <p className="hint" id={`${id}-count`} data-tone={bytes > max ? 'bad' : undefined}>
            {bytes} of {max} bytes
          </p>
          <button type="button" className="btn" data-kind="primary" aria-disabled={busy || !changed || bytes > max || undefined} onClick={() => !busy && changed && bytes <= max && save()}>
            SAVE
          </button>
        </>
      )}
      <p className="hint">
        These words reach every agent of the room at the start of its next session, in its role text (the system prompt on Claude Code and pi, the first prompt on the other engines), so saving asks for your password. The project&apos;s own AGENTS.md is only pointed to, never copied: gonogo tells an engine that does not load it itself where it is, and reads nothing of it.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
