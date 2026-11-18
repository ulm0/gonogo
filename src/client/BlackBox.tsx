/**
 * Black Box: the record of the room, as the server keeps it in a git repository. The page lists the newest events (asked for
 * every few seconds; there is no frame) and shows the command that reads the whole record with git. It writes nothing:
 * the server is the only committer.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { AuditView } from '../shared/protocol.js';
import * as api from './api.js';
import { copyText, countText, gitText, KIND_CHIPS, stampText } from './audit.js';
import { useRefresh } from './refresh.js';
import { showRoom } from './store.js';
import './loop.css';
import './records.css';

export function BlackBox(): ReactElement {
  const titleId = useId();
  const [view, setView] = useState<AuditView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => heading.current?.focus(), []);

  useRefresh(() => {
    api.readBlackBox().then(
      (found) => {
        setView(found);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  });

  const copy = async (): Promise<void> => {
    if (view === null) return;
    setNotice((await copyText(view.command)) ? 'Copied.' : 'The browser would not copy it: select the command and copy it by hand.');
  };

  return (
    <section className="rec" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title rec-heading">
          BLACK BOX
        </h1>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      <p className="rec-lead">What happened in the room: hires, stops, polls, Redline trips, plan changes, uplink deliveries and configuration changes. Names and ids only, never a message or a secret. Only the server writes it.</p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view !== null && (
        <>
          <p className="flood rec-git" data-tone={view.git === 'ok' ? 'lit' : 'amber'}>
            {gitText(view)}
          </p>
          <div className="module rec-form">
            <div className="field">
              <label htmlFor={`${titleId}-cmd`}>Read it with git</label>
              <input id={`${titleId}-cmd`} className="lcd rec-command" readOnly value={view.command} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
            </div>
            <div className="rec-actions">
              <button type="button" className="btn" onClick={() => void copy()}>
                Copy
              </button>
            </div>
            {/* the live region below tells a screen reader; this line is for everybody else, and the only word a page without a clipboard gives */}
            {notice !== '' && (
              <p className="hint" aria-hidden="true">
                {notice}
              </p>
            )}
          </div>
          <p className="hint">{countText(view.events.length)}</p>
          {view.events.length > 0 && (
            <ol className="rec-events module">
              {view.events.map((event, i) => (
                <li key={`${event.at}-${i}`} className="rec-event">
                  <time className="rec-when" dateTime={new Date(event.at).toISOString()}>
                    {stampText(event.at)}
                  </time>
                  <span className="chip rec-kind" data-tone={KIND_CHIPS[event.kind].tone}>
                    {KIND_CHIPS[event.kind].text}
                  </span>
                  <span className="rec-text-line">{event.text}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <p className="sr-only" role="status">
        {notice}
      </p>
    </section>
  );
}
