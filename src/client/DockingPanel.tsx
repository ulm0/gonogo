/**
 * Docking: stations that are connected to this one. A section of the Launch Window view, under RELAY, because it too is a way
 * for work to arrive that the Director did not type. It shows this station's name, one row for each docked station (the state
 * of its last answer, its agents, Undock) and the two keys that make a connection: Make a code (here) and Pair (with a code
 * from the other station). The code holds a one-time token and is on screen once, in the state of this component.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { DOCKS_MAX } from '../shared/protocol.js';
import type { DockCode, DockView, Task, TaskStatus } from '../shared/protocol.js';
import * as api from './api.js';
import { addressProblem, codeProblem, expiresText, handoffChoices, handoffRequest, localNote, statusText, toneOf, undockedText, wordOf } from './docking.js';
import { useNow, useStore } from './store.js';
import { copyText } from './uplink.js';
import { useRun } from './WallView.js';
import './loop.css';
import './launch.css';
import './uplink.css';
import './docking.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const selectAll = (event: { currentTarget: HTMLInputElement }): void => event.currentTarget.select();
type Mode = 'code' | 'pair';
interface Problems {
  address?: string;
  code?: string;
}

/** The address of this station, and for Pair the code. Make a code answers with the code, Pair with a new row. */
function Form({ mode, onDone, onMade, onNotice }: { mode: Mode; onDone(): void; onMade(made: DockCode): void; onNotice(text: string): void }): ReactElement {
  const id = useId();
  const [address, setAddress] = useState(location.origin);
  const [code, setCode] = useState('');
  const [problems, setProblems] = useState<Problems>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const note = localNote(address.trim());

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const found: Problems = { address: addressProblem(address), ...(mode === 'pair' ? { code: codeProblem(code) } : {}) };
    setProblems(found);
    setTopError(null);
    const bad = mode === 'pair' && found.code !== undefined ? 'code' : found.address !== undefined ? 'address' : null;
    if (bad !== null) {
      document.getElementById(`${id}-${bad}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      if (mode === 'code') onMade(await api.createDockCode(address.trim()));
      else onNotice(`Docked with ${(await api.pairDock(code.trim(), address.trim())).name}.`);
      onDone();
    } catch (e) {
      const field = (e as { field?: unknown }).field;
      if (field === 'url' || field === 'code') {
        const key = field === 'url' ? 'address' : 'code';
        setProblems({ [key]: messageOf(e) });
        document.getElementById(`${id}-${key}`)?.focus();
      } else setTopError(messageOf(e));
      setBusy(false);
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) onDone();
  };
  const addressField = (
    <div className="field" data-invalid={problems.address !== undefined ? '' : undefined}>
      <label htmlFor={`${id}-address`}>Address of this station</label>
      <input
        id={`${id}-address`}
        ref={mode === 'code' ? first : undefined}
        className="input"
        value={address}
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problems.address !== undefined}
        aria-describedby={[`${id}-address-hint`, problems.address !== undefined ? `${id}-address-error` : ''].filter(Boolean).join(' ')}
        onChange={(e) => {
          setAddress(e.target.value);
          setProblems((p) => ({ ...p, address: undefined }));
        }}
      />
      {problems.address !== undefined && (
        <p className="error" id={`${id}-address-error`}>
          {problems.address}
        </p>
      )}
      <p className="hint" id={`${id}-address-hint`}>
        How the other station reaches this one. Its name has to be allowed here (--allow-host).{note === null ? '' : ` ${note}`}
      </p>
    </div>
  );
  return (
    <form className="win-form module" aria-label={mode === 'code' ? 'Make a docking code' : 'Pair with a docking code'} noValidate onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown}>
      <h3 className="label">{mode === 'code' ? 'Make a code' : 'Pair'}</h3>
      <fieldset className="win-fields" disabled={busy}>
        {mode === 'pair' && (
          <div className="field" data-invalid={problems.code !== undefined ? '' : undefined}>
            <label htmlFor={`${id}-code`}>Code from the other station</label>
            <input
              id={`${id}-code`}
              ref={first}
              className="input"
              value={code}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problems.code !== undefined}
              aria-describedby={problems.code !== undefined ? `${id}-code-error` : undefined}
              onChange={(e) => {
                setCode(e.target.value);
                setProblems((p) => ({ ...p, code: undefined }));
              }}
            />
            {problems.code !== undefined && (
              <p className="error" id={`${id}-code-error`}>
                {problems.code}
              </p>
            )}
          </div>
        )}
        {addressField}
      </fieldset>
      {topError !== null && (
        <p className="error" role="alert">
          {topError}
        </p>
      )}
      <div className="win-actions">
        <button type="submit" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined}>
          {busy ? 'Working…' : mode === 'code' ? 'Make code' : 'Pair'}
        </button>
        <button type="button" className="btn" data-size="big" data-kind="quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The one time a code is on screen. The field is selected, so that copying is one keystroke where the clipboard key is refused. */
function CodePanel({ made, now, onDone, onNotice }: { made: DockCode; now: number; onDone(): void; onNotice(text: string): void }): ReactElement {
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div className="dk-code flood" data-tone="amber" role="group" aria-label="Docking code">
      <p>
        <strong>Docking code.</strong> {expiresText(made.expiresAt, now)} Give it to the Director of the other station: they paste it under Pair, with the address of their own station. gonogo will not show it again.
      </p>
      <input ref={field} readOnly className="input up-value" aria-label="Docking code" value={made.code} spellCheck={false} onFocus={selectAll} />
      <div className="up-keys">
        <button type="button" className="btn" onClick={() => void copyText(made.code).then((ok) => onNotice(ok ? 'Code copied.' : 'Could not copy. Select the code and copy it.'))}>
          Copy code
        </button>
        <button type="button" className="btn" data-kind="primary" onClick={onDone}>
          I have it
        </button>
      </div>
    </div>
  );
}

function Row({ dock, now, onNotice }: { dock: DockView; now: number; onNotice(text: string): void }): ReactElement {
  const { busy, error, run } = useRun();
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement | null>(null);
  const key = useRef<HTMLButtonElement | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    // focus moves to Keep when the question opens, and back to Undock when Keep closes it
    if (confirming) keep.current?.focus();
    else if (asked.current) key.current?.focus();
    asked.current = confirming;
  }, [confirming]);
  return (
    <li className="up-row" data-off={dock.status === 'down' ? '' : undefined}>
      <div className="win-main">
        <h3 className="win-name">
          {dock.name}{' '}
          <span className="chip" data-tone={toneOf(dock)}>
            {wordOf(dock)}
          </span>
        </h3>
        <p className="win-to">{dock.url}</p>
      </div>
      <p className="win-last">{statusText(dock, now)}</p>
      <details className="up-log">
        <summary>Agents ({dock.agents.length})</summary>
        {dock.agents.length === 0 ? (
          <p className="hint">None yet. Agents write to them as name@{dock.name}.</p>
        ) : (
          <ul className="dk-agents">
            {dock.agents.map((agent) => (
              <li key={agent.name}>
                <span className="dk-name">
                  {agent.name}@{dock.name}
                </span>
                <span className="chip" data-tone={agent.state === 'working' ? 'go' : agent.state === 'needs_you' ? 'amber' : 'quiet'}>
                  {agent.state.replace('_', ' ')}
                </span>
                {agent.boss && <span className="chip" data-tone="quiet">boss</span>}
                <span className="dk-role">{agent.role}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
      <div className="win-buttons">
        <button type="button" ref={key} className="btn" data-kind="danger" aria-label={`Undock ${dock.name}`} aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
          Undock
        </button>
      </div>
      {confirming && (
        <div className="win-confirm flood" data-tone="nogo" role="group" aria-label={`Undock ${dock.name}?`}>
          <p>
            <strong>Undock {dock.name}?</strong> Its agents can no longer write to yours and yours cannot write to theirs. Dock again with a new code.
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
              run(async () => onNotice(undockedText(dock.name, await api.undock(dock.id))));
            }}
          >
            Undock
          </button>
        </div>
      )}
      {error !== null && (
        <p className="error win-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** The DOCKING module of the Launch Window view. */
export function DockingPanel(): ReactElement {
  const titleId = useId();
  const docking = useStore((s) => s.docking);
  const now = useNow();
  const [mode, setMode] = useState<Mode | null>(null);
  const [made, setMade] = useState<DockCode | null>(null);
  const [notice, setNotice] = useState('');
  const add = useRef<HTMLButtonElement | null>(null);
  const full = docking.docks.length >= DOCKS_MAX;
  /** Closes the form or the code panel and leaves the keyboard on the key that opens a form. */
  const closeTo = (clear: () => void): void => {
    clear();
    add.current?.focus();
  };
  return (
    <section className="dk" aria-labelledby={titleId}>
      <header className="loop-head">
        <h2 id={titleId} className="disp loop-title up-title">
          DOCKING
        </h2>
        <button type="button" ref={add} className="btn" data-kind="primary" aria-disabled={full || undefined} onClick={() => !full && setMode('code')}>
          Make a code
        </button>
        <button type="button" className="btn" aria-disabled={full || undefined} onClick={() => !full && setMode('pair')}>
          Pair
        </button>
      </header>
      {docking.station !== '' && (
        <p className="dk-station">
          This station is <strong>{docking.station}</strong>. Its agents are written to as name@{docking.station}. Dock only with people you trust: their agents can reach yours.
        </p>
      )}
      {mode !== null && <Form key={mode} mode={mode} onDone={() => closeTo(() => setMode(null))} onMade={setMade} onNotice={setNotice} />}
      {made !== null && <CodePanel made={made} now={now} onDone={() => closeTo(() => setMade(null))} onNotice={setNotice} />}
      <div className="win-list module">
        {docking.docks.length === 0 ? (
          <p className="loop-empty">No station is docked. Docking connects this station to another gonogo so that their agents can message each other and hand off tasks. One side makes a code and the other pairs with it.</p>
        ) : (
          <ul className="win-rows">
            {docking.docks.map((d) => (
              <Row key={d.id} dock={d} now={now} onNotice={setNotice} />
            ))}
          </ul>
        )}
      </div>
      <p className="hint up-notice" role="status">
        {notice}
      </p>
    </section>
  );
}

/**
 * The form of a card of the Flight Plan that hands its task to a docked station: which station (when there are several) and
 * which of its agents. The task is copied to that board and is done here, so the board puts the keyboard on the card again
 * once it has moved (`willMove`).
 */
export function HandOff({ task, willMove, onNotice, onClose }: { task: Task; willMove(move: { id: string; status: TaskStatus } | null): void; onNotice(text: string): void; onClose(): void }): ReactElement {
  const id = useId();
  const docks = useStore((s) => s.docking.docks);
  const [dockId, setDockId] = useState(docks[0]?.id ?? '');
  const [assignee, setAssignee] = useState('');
  const { busy, error, run } = useRun();
  const first = useRef<HTMLSelectElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const dock = docks.find((d) => d.id === dockId) ?? docks[0];
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) onClose();
  };
  if (dock === undefined) {
    return (
      <p className="hint" role="status">
        No station is docked any more.{' '}
        <button type="button" className="btn" data-kind="quiet" onClick={onClose}>
          Close
        </button>
      </p>
    );
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    run(async () => {
      willMove({ id: task.id, status: 'done' });
      try {
        await api.handOffTask(dock.id, handoffRequest(task, assignee));
        onNotice(`${task.id} handed off to ${assignee === '' ? '' : `${assignee}@`}${dock.name}`);
      } catch (e) {
        willMove(null);
        throw e;
      }
    });
  };
  return (
    <form className="dk-handoff" aria-label={`Hand off ${task.id}`} onSubmit={submit} onKeyDown={onKeyDown}>
      {docks.length > 1 && (
        <div className="field">
          <label htmlFor={`${id}-station`}>Station</label>
          <select
            id={`${id}-station`}
            ref={first}
            className="input"
            value={dock.id}
            onChange={(e) => {
              setDockId(e.target.value);
              setAssignee('');
            }}
          >
            {docks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor={`${id}-agent`}>{`Hand off to ${dock.name}`}</label>
        <select id={`${id}-agent`} ref={docks.length > 1 ? undefined : first} className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          {handoffChoices(dock).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || undefined}>
        {busy ? 'Handing off…' : 'Hand off'}
      </button>
      <button type="button" className="btn" data-kind="quiet" onClick={onClose}>
        Cancel
      </button>
      <p className="hint dk-hint">Copies the task to that station&rsquo;s board and marks it done here.</p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
