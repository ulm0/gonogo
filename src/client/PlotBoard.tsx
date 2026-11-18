/**
 * Plot Board: the one current plan of the room. The text is plain: it is shown in a box as it was typed, never as HTML or
 * markdown. The Director edits it here; the boss writes it with board_write; every agent reads it. The page asks the server
 * every few seconds (there is no frame): a box nobody typed in follows the server, a box with typing in it stays as it is and
 * says when the board moved on, and a save names the revision it started from, so it cannot replace text the Director did not see.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { BOARD_MAX_CHARS } from '../shared/protocol.js';
import type { BoardView } from '../shared/protocol.js';
import * as api from './api.js';
import { boardMode, conflictText, countText, tidy, writtenText } from './board.js';
import { useRefresh } from './refresh.js';
import { showRoom, useStore } from './store.js';
import './loop.css';
import './records.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The view of the top bar's PLOT BOARD key. */
export function PlotBoard(): ReactElement {
  const titleId = useId();
  const agents = useStore((s) => s.agents);
  const [server, setServer] = useState<BoardView | null>(null);
  const [text, setText] = useState('');
  /** The revision the text in the box was started from. */
  const [base, setBase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  // what the box holds now, and what it held when it was last the server's text: a box that still holds it has not been typed in
  const typed = useRef('');
  const synced = useRef<string | null>(null);
  useEffect(() => heading.current?.focus(), []);

  const adopt = (view: BoardView): void => {
    setServer(view);
    setText(view.text);
    setBase(view.revision);
    typed.current = view.text;
    synced.current = view.text;
  };

  useRefresh(() => {
    api.readBoard().then(
      (view) => {
        setServer(view);
        setError(null);
        // a box nobody typed in follows the board; one with typing in it keeps it
        if (synced.current === null || typed.current === synced.current) adopt(view);
      },
      (e: unknown) => setError(messageOf(e)),
    );
  });

  const mode = server === null ? 'clean' : boardMode(tidy(text), base, server);
  const save = async (): Promise<void> => {
    if (busy || server === null || mode !== 'edited') return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.writeBoard(text, base);
      adopt(saved);
      setNotice('Saved.');
    } catch (e) {
      if ((e as { status?: unknown }).status === 409) {
        // the board moved on: show what is there now, and keep the typing
        const latest = await api.readBoard().catch(() => null);
        if (latest !== null) setServer(latest);
        setError(latest === null ? messageOf(e) : conflictText(latest, agents));
      } else setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rec" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title rec-heading">
          PLOT BOARD
        </h1>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      <p className="rec-lead">The one current plan of the room. Every agent can read it; only FLIGHT, the boss, and you can write it. It is not the Flight Plan (tasks) or the Mission Log (what agents learned).</p>
      <form
        className="module rec-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="field">
          <label htmlFor={`${titleId}-text`}>Plan</label>
          <textarea
            id={`${titleId}-text`}
            className="textarea rec-text"
            rows={18}
            value={text}
            maxLength={BOARD_MAX_CHARS}
            spellCheck={false}
            aria-describedby={`${titleId}-meta`}
            disabled={server === null}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
              typed.current = e.target.value;
              setText(e.target.value);
              setNotice('');
            }}
          />
        </div>
        <p className="hint" id={`${titleId}-meta`}>
          {server === null ? 'Loading…' : `${writtenText(server, agents, Date.now())} ${countText(text)}.`}
        </p>
        {mode === 'stale' && server !== null && (
          <p className="flood rec-stale" data-tone="amber" role="status">
            {conflictText(server, agents)}
          </p>
        )}
        {error !== null && mode !== 'stale' && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="rec-actions">
          <button type="submit" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || mode !== 'edited' || undefined}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn"
            data-size="big"
            data-kind="quiet"
            aria-disabled={server === null || mode === 'clean' || undefined}
            onClick={() => {
              if (server === null || mode === 'clean') return;
              adopt(server);
              setError(null);
              setNotice(mode === 'stale' ? 'Loaded the latest.' : 'Typing discarded.');
            }}
          >
            {mode === 'stale' ? 'Load the latest' : 'Discard typing'}
          </button>
        </div>
      </form>
      <p className="sr-only" role="status">
        {notice}
      </p>
    </section>
  );
}
