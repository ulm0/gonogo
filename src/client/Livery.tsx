/**
 * Livery: the look of gonogo, chosen once for every device. A list of the liveries with a swatch each, apply and (for a custom one)
 * delete, and a box that asks an agent to design a new one. The list is in the page state (the server tells every browser); an
 * agent's livery shows here when it submits it, and the Director's inbox says so.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { LIVERY_BRIEF_MAX_CHARS } from '../shared/livery.js';
import type { LiveryEntry } from '../shared/protocol.js';
import * as api from './api.js';
import { recipients } from './launch.js';
import { askedText, briefProblem, SWATCH_TOKENS, sourceText } from './look.js';
import { legendOf } from './loop.js';
import { useAgentList } from './RoomView.js';
import { showRoom, useStore } from './store.js';
import { useRun } from './WallView.js';
import './loop.css';
import './livery.css';
import { Textarea } from '@/ui/textarea.js';
import { NativeSelect } from '@/ui/native-select.js';

function Row({ entry, current, onNotice, onGone }: { entry: LiveryEntry; current: boolean; onNotice(text: string): void; onGone(): void }): ReactElement {
  const agents = useStore((s) => s.agents);
  const { busy, error, run } = useRun();
  const [confirming, setConfirming] = useState(false);
  const del = useRef<HTMLButtonElement | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    // focus moves to Keep when it asks, and back to Delete when Keep closes the question
    if (confirming) keep.current?.focus();
    else if (asked.current) del.current?.focus();
    asked.current = confirming;
  }, [confirming]);
  return (
    <li className="liv-row module" data-current={current ? 'true' : undefined}>
      <span className="liv-swatch" aria-hidden="true">
        {SWATCH_TOKENS.map((token) => (
          <span key={token} style={{ background: entry.tokens[token] }} />
        ))}
      </span>
      <div className="liv-text">
        <h3 className="liv-name">
          {entry.name}
          {current && (
            <>
              {' '}
              <span className="chip" data-tone="go">
                In use
              </span>
            </>
          )}
        </h3>
        {entry.description !== '' && <p className="liv-desc">{entry.description}</p>}
        <p className="hint">{sourceText(entry, (name) => legendOf(name, agents))}</p>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="liv-actions">
        <button
          type="button"
          className="btn"
          data-kind={current ? undefined : 'primary'}
          aria-label={`Apply ${entry.name}`}
          aria-disabled={busy || current || undefined}
          onClick={() => {
            if (current) return;
            run(async () => {
              await api.selectLivery(entry.slug);
              onNotice(`${entry.name} applied.`);
            });
          }}
        >
          Apply
        </button>
        {!entry.builtin &&
          (confirming ? (
            <div className="liv-confirm flood" data-tone="nogo" role="group" aria-label={`Delete ${entry.name}?`}>
              <p>
                <strong>Delete {entry.name}?</strong> The file goes with it.
              </p>
              <button type="button" className="btn" ref={keep} onClick={() => setConfirming(false)}>
                Keep
              </button>
              <button
                type="button"
                className="btn"
                data-kind="primary"
                aria-disabled={busy || undefined}
                onClick={() => {
                  setConfirming(false);
                  run(async () => {
                    await api.deleteLivery(entry.slug);
                    onNotice(`${entry.name} deleted.`);
                    // the row and its keys are gone: the keyboard goes back to the title instead of the body of the page
                    onGone();
                  });
                }}
              >
                Delete
              </button>
            </div>
          ) : (
            <button type="button" ref={del} className="btn" data-kind="danger" aria-label={`Delete ${entry.name}`} aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
              Delete
            </button>
          ))}
      </div>
    </li>
  );
}

/** The box that asks an agent for a livery: a line of text, who, and a key. */
function Design({ onNotice }: { onNotice(text: string): void }): ReactElement {
  const id = useId();
  const list = useAgentList();
  const agents = useStore((s) => s.agents);
  const options = useMemo(() => recipients(list, agents, null), [list, agents]);
  const [brief, setBrief] = useState('');
  const [to, setTo] = useState('boss');
  const [problem, setProblem] = useState('');
  const { busy, error, run } = useRun();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const submit = (event: { preventDefault(): void }): void => {
    event.preventDefault();
    if (busy) return;
    const found = briefProblem(brief);
    setProblem(found);
    if (found !== '') {
      field.current?.focus();
      return;
    }
    run(async () => {
      const sent = await api.designLivery({ to, brief: brief.trim() });
      onNotice(askedText(legendOf(sent.to, agents), sent.ok, sent.note));
      if (sent.ok) setBrief('');
    });
  };
  return (
    <form className="liv-design module" aria-labelledby={`${id}-title`} noValidate onSubmit={submit}>
      <h2 id={`${id}-title`} className="label">
        Design one
      </h2>
      <div className="field">
        <label htmlFor={`${id}-brief`}>What should it look like?</label>
        <Textarea variant="field"
          id={`${id}-brief`}
          ref={field}
          rows={3}
          value={brief}
          maxLength={LIVERY_BRIEF_MAX_CHARS}
          aria-invalid={problem !== ''}
          aria-describedby={`${id}-hint${problem !== '' ? ` ${id}-problem` : ''}`}
          onChange={(e) => {
            setBrief(e.target.value);
            setProblem('');
          }}
        />
        {problem !== '' && (
          <p className="error" id={`${id}-problem`}>
            {problem}
          </p>
        )}
        <p className="hint" id={`${id}-hint`}>
          For example: a dark blue look for night, with amber signals. The agent gets your line, the list of tokens and the contrast rule, and its livery is checked before it is saved.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${id}-to`}>Ask</label>
        <NativeSelect id={`${id}-to`} value={to} onChange={(e) => setTo(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="liv-actions">
        <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || undefined}>
          Ask for a livery
        </button>
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The view of the top bar's LIVERY key. */
export function Livery(): ReactElement {
  const titleId = useId();
  const livery = useStore((s) => s.livery);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement | null>(null);
  // The page replaces the room: the keyboard starts at its title, not on a button that is gone.
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="liv" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title liv-title">
          LIVERY
        </h1>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      <p className="hint">The look of gonogo. It is kept on the server, so every device that opens this room shows the one you apply.</p>
      <ul className="liv-list" aria-label="Liveries">
        {livery.liveries.map((entry) => (
          <Row key={entry.slug} entry={entry} current={entry.slug === livery.current} onNotice={setNotice} onGone={() => heading.current?.focus()} />
        ))}
      </ul>
      <Design onNotice={setNotice} />
      <p className="hint liv-notice" role="status">
        {notice}
      </p>
    </section>
  );
}
