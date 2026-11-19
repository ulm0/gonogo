/**
 * Uplink: webhooks that start work. A section of the Launch Window view, because both are work that starts by itself. A
 * list with the address of each, an on switch, Test, Rotate secret, Edit and Delete, the recent deliveries, and a form.
 * The secret is shown once, in a panel that only holds it in this component's state: leaving the page loses it.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { roomOrigin } from './base.js';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { UPLINK_NAME_MAX_CHARS, UPLINKS_MAX, uplinkSubject } from '../shared/protocol.js';
import type { UplinkKind, UplinkView } from '../shared/protocol.js';
import * as api from './api.js';
import { recipients, toText } from './launch.js';
import { useAgentList } from './RoomView.js';
import { useNow, useStore, showHistory } from './store.js';
import { atText, copyText, emptyValues, endpointOf, FIELDS, lastText, needsSecret, requestOf, secretProblem, toneOf, validate, valuesOf } from './uplink.js';
import type { Field, Problems, Values } from './uplink.js';
import { useRun } from './WallView.js';
import './loop.css';
import './launch.css';
import './uplink.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isField = (name: unknown): name is Field => typeof name === 'string' && (FIELDS as readonly string[]).includes(name);
const selectAll = (event: { currentTarget: HTMLInputElement }): void => event.currentTarget.select();

/** What the panel shows once: the secret that create or rotate just answered with. */
export interface Shown {
  name: string;
  secret: string;
}

/** The form of an uplink. `kind` is the kind of a new one (an uplink that is edited has its own); Relay makes the ones of its services with it. */
export function Editor({
  uplink,
  kind = 'generic',
  name = '',
  hint,
  onDone,
  onSecret,
}: {
  uplink: UplinkView | null;
  kind?: UplinkKind;
  /** The name a new uplink starts with. */
  name?: string;
  /** Where the signing secret comes from, for the kinds that take one. */
  hint?: string;
  onDone(): void;
  onSecret(shown: Shown): void;
}): ReactElement {
  const id = useId();
  const own = uplink?.kind ?? kind;
  const [secret, setSecret] = useState('');
  const list = useAgentList();
  const agents = useStore((s) => s.agents);
  const [values, setValues] = useState<Values>(() => (uplink === null ? { ...emptyValues('boss'), name } : valuesOf(uplink)));
  const [problems, setProblems] = useState<Problems>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => first.current?.focus(), []);

  const options = useMemo(() => recipients(list, agents, uplink?.to ?? null), [list, agents, uplink]);
  const change = (patch: Partial<Values>, field?: Field): void => {
    setValues((v) => ({ ...v, ...patch }));
    if (field !== undefined) setProblems((p) => ({ ...p, [field]: undefined }));
  };
  const describedBy = (field: Field, extra?: string): string | undefined => [extra, problems[field] !== undefined ? `${id}-${field}-error` : ''].filter(Boolean).join(' ') || undefined;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const found = validate(values);
    const wrong = needsSecret(own) ? secretProblem(secret.trim(), uplink !== null) : undefined;
    if (wrong !== undefined) found.secret = wrong;
    setProblems(found);
    setTopError(null);
    const bad = FIELDS.find((f) => found[f] !== undefined);
    if (bad !== undefined) {
      document.getElementById(`${id}-${bad}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      if (uplink === null) {
        const made = await api.createUplink({ ...requestOf(values), kind: own, ...(needsSecret(own) ? { secret: secret.trim() } : {}) });
        // a secret the Director pasted is not news to him: only one that gonogo made is shown
        if (!needsSecret(own)) onSecret({ name: made.name, secret: made.secret });
      } else await api.updateUplink(uplink.id, { name: values.name.trim(), to: values.to, enabled: values.enabled, ...(secret.trim() === '' ? {} : { secret: secret.trim() }) });
      onDone();
    } catch (e) {
      const field = (e as { field?: unknown }).field;
      if (isField(field)) {
        setProblems({ [field]: messageOf(e) });
        document.getElementById(`${id}-${field}`)?.focus();
      } else setTopError(messageOf(e));
      setBusy(false);
    }
  }

  const error = (field: Field): ReactElement | null => {
    const text = problems[field];
    return text === undefined ? null : (
      <p className="error" id={`${id}-${field}-error`}>
        {text}
      </p>
    );
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) onDone();
  };

  return (
    <form className="win-form module" aria-label={uplink === null ? `New ${own} uplink` : `Edit ${uplink.name}`} noValidate onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown}>
      <h3 className="label">{uplink === null ? (own === 'generic' ? 'New uplink' : `New ${own} uplink`) : 'Edit uplink'}</h3>
      <fieldset className="win-fields" disabled={busy}>
        <div className="field" data-invalid={problems.name !== undefined ? '' : undefined}>
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            ref={first}
            className="input"
            value={values.name}
            maxLength={UPLINK_NAME_MAX_CHARS}
            autoComplete="off"
            aria-invalid={problems.name !== undefined}
            aria-describedby={describedBy('name', `${id}-name-hint`)}
            onChange={(e) => change({ name: e.target.value }, 'name')}
          />
          {error('name')}
          <p className="hint" id={`${id}-name-hint`}>
            Every delivery arrives as “{uplinkSubject(values.name.trim() === '' ? 'name' : values.name.trim())}”.
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-to`}>Send to</label>
          <select id={`${id}-to`} className="input" value={values.to} aria-describedby={describedBy('to')} onChange={(e) => change({ to: e.target.value }, 'to')}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {error('to')}
        </div>
        {needsSecret(own) && (
          <div className="field" data-invalid={problems.secret !== undefined ? '' : undefined}>
            <label htmlFor={`${id}-secret`}>Signing secret</label>
            <input
              id={`${id}-secret`}
              type="password"
              className="input"
              value={secret}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problems.secret !== undefined}
              aria-describedby={describedBy('secret', `${id}-secret-hint`)}
              onChange={(e) => {
                setSecret(e.target.value);
                setProblems((p) => ({ ...p, secret: undefined }));
              }}
            />
            {error('secret')}
            <p className="hint" id={`${id}-secret-hint`}>
              {uplink !== null ? 'Leave it empty to keep the saved secret. ' : ''}
              {hint ?? 'The secret of the service: gonogo checks every delivery against it.'}
            </p>
          </div>
        )}
        <div className="win-check">
          <input id={`${id}-enabled`} type="checkbox" className="check" checked={values.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
          <label htmlFor={`${id}-enabled`}>On: take deliveries</label>
        </div>
      </fieldset>
      {topError !== null && (
        <p className="error" role="alert">
          {topError}
        </p>
      )}
      <div className="win-actions">
        <button type="submit" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" data-size="big" data-kind="quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The one time a secret is on screen. The field is selected, so that copying is one keystroke where the clipboard key is refused. */
export function SecretPanel({ shown, onDone, onNotice }: { shown: Shown; onDone(): void; onNotice(text: string): void }): ReactElement {
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div className="up-secret flood" data-tone="amber" role="group" aria-label={`Secret of ${shown.name}`}>
      <p>
        <strong>Secret of {shown.name}.</strong> It is shown once and gonogo will not show it again. Copy it into the sender now; if it is lost, rotate it.
      </p>
      <input ref={field} readOnly className="input up-value" aria-label={`Secret of ${shown.name}`} value={shown.secret} spellCheck={false} onFocus={selectAll} />
      <div className="up-keys">
        <button type="button" className="btn" onClick={() => void copyText(shown.secret).then((ok) => onNotice(ok ? 'Secret copied.' : 'Could not copy. Select the secret and copy it.'))}>
          Copy secret
        </button>
        <button type="button" className="btn" data-kind="primary" onClick={onDone}>
          I have it
        </button>
      </div>
    </div>
  );
}

function Row({ uplink, now, onEdit, onNotice, onSecret }: { uplink: UplinkView; now: number; onEdit(): void; onNotice(text: string): void; onSecret(shown: Shown): void }): ReactElement {
  const agents = useStore((s) => s.agents);
  const { busy, error, run } = useRun();
  const [confirming, setConfirming] = useState<'rotate' | 'delete' | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const rotateKey = useRef<HTMLButtonElement | null>(null);
  const deleteKey = useRef<HTMLButtonElement | null>(null);
  const asked = useRef<'rotate' | 'delete' | null>(null);
  useEffect(() => {
    // focus moves to Keep when a question opens, and back to the key that asked when Keep closes it
    if (confirming !== null) {
      asked.current = confirming;
      keep.current?.focus();
    } else if (asked.current !== null) {
      (asked.current === 'rotate' ? rotateKey : deleteKey).current?.focus();
      asked.current = null;
    }
  }, [confirming]);
  const { name } = uplink;
  const off = !uplink.enabled;
  const url = endpointOf(roomOrigin(), uplink.id);
  return (
    <li className="up-row" data-off={off ? '' : undefined}>
      <div className="win-main">
        <h3 className="win-name">{name}</h3>
        <p className="win-to">to {toText(uplink.to, agents)}</p>
        <p className="win-to">{uplink.kind}</p>
      </div>
      <div className="up-url">
        <input readOnly className="input up-value" aria-label={`Address of ${name}`} value={url} spellCheck={false} onFocus={selectAll} />
        <button type="button" className="btn" aria-label={`Copy address of ${name}`} onClick={() => void copyText(url).then((ok) => onNotice(ok ? `Address of ${name} copied.` : 'Could not copy. Select the address and copy it.'))}>
          Copy
        </button>
      </div>
      <p className="win-last">
        {lastText(uplink, now)}{' '}
        <button type="button" className="btn" data-kind="quiet" aria-label={`History of ${name}`} onClick={() => showHistory({ source: uplink.id })}>
          History
        </button>
      </p>
      {uplink.deliveries.length > 0 && (
        <details className="up-log">
          <summary>Deliveries ({uplink.deliveries.length})</summary>
          <ul className="up-deliveries">
            {uplink.deliveries.map((d, i) => (
              <li key={`${d.at}-${i}`}>
                <span className="up-at">{atText(d.at, now)}</span>
                <span className="chip" data-tone={toneOf(d.status)}>
                  {d.status}
                </span>
                <span className="up-note">{d.note}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="win-buttons">
        <label className="win-switch">
          <input
            type="checkbox" className="switch"
            role="switch"
            checked={uplink.enabled}
            aria-label={`${name} enabled`}
            aria-disabled={busy || undefined}
            onChange={() => run(() => api.updateUplink(uplink.id, { enabled: !uplink.enabled }))}
          />
          <span>Enabled</span>
        </label>
        <button
          type="button"
          className="btn"
          aria-label={`Test: ${name}`}
          aria-disabled={busy || undefined}
          onClick={() => run(async () => onNotice(`${name}: ${(await api.testUplink(uplink.id)).deliveries[0]?.note ?? 'sent'}`))}
        >
          Test
        </button>
        {!needsSecret(uplink.kind) && (
          <button type="button" ref={rotateKey} className="btn" aria-label={`Rotate secret: ${name}`} aria-disabled={busy || undefined} onClick={() => setConfirming('rotate')}>
            Rotate secret
          </button>
        )}
        <button type="button" className="btn" data-kind="quiet" aria-label={`Edit ${name}`} onClick={onEdit}>
          Edit
        </button>
        <button type="button" ref={deleteKey} className="btn" data-kind="danger" aria-label={`Delete ${name}`} aria-disabled={busy || undefined} onClick={() => setConfirming('delete')}>
          Delete
        </button>
      </div>
      {confirming !== null && (
        <div className="win-confirm flood" data-tone="nogo" role="group" aria-label={confirming === 'rotate' ? `Rotate the secret of ${name}?` : `Delete ${name}?`}>
          <p>
            {confirming === 'rotate' ? (
              <>
                <strong>Rotate the secret of {name}?</strong> The old secret stops working now. You get the new one once.
              </>
            ) : (
              <>
                <strong>Delete {name}?</strong> Its address stops answering and its secret is gone.
              </>
            )}
          </p>
          <button type="button" className="btn" ref={keep} onClick={() => setConfirming(null)}>
            Keep
          </button>
          <button
            type="button"
            className="btn"
            data-kind="primary"
            aria-disabled={busy || undefined}
            onClick={() => {
              const what = confirming;
              setConfirming(null);
              if (what === 'rotate') run(async () => onSecret({ name, secret: (await api.rotateUplink(uplink.id)).secret }));
              else run(() => api.deleteUplink(uplink.id));
            }}
          >
            {confirming === 'rotate' ? 'Rotate' : 'Delete'}
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

/** The UPLINK module of the Launch Window view. */
export function UplinkPanel(): ReactElement {
  const titleId = useId();
  const uplinks = useStore((s) => s.uplinks);
  const now = useNow();
  /** 'new', the id of the uplink being edited, or nothing. */
  const [editing, setEditing] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [notice, setNotice] = useState('');
  const add = useRef<HTMLButtonElement | null>(null);
  const target = editing === null || editing === 'new' ? null : (uplinks.find((u) => u.id === editing) ?? null);
  const open = editing === 'new' || target !== null;
  /** Closes the form or the secret panel and leaves the keyboard on the key that opens a form. */
  const closeTo = (clear: (none: null) => void): void => {
    clear(null);
    add.current?.focus();
  };
  return (
    <section className="up" aria-labelledby={titleId}>
      <header className="loop-head">
        <h2 id={titleId} className="disp loop-title up-title">
          UPLINK
        </h2>
        <button type="button" ref={add} className="btn" data-kind="primary" aria-disabled={uplinks.length >= UPLINKS_MAX || undefined} onClick={() => uplinks.length < UPLINKS_MAX && setEditing('new')}>
          New uplink
        </button>
      </header>
      {open && <Editor key={editing} uplink={target} onDone={() => closeTo(setEditing)} onSecret={setShown} />}
      {shown !== null && <SecretPanel shown={shown} onDone={() => closeTo(setShown)} onNotice={setNotice} />}
      <div className="win-list module">
        {uplinks.length === 0 ? (
          <p className="loop-empty">No uplinks yet. An uplink is an address that a service or a script posts JSON to; each post reaches an agent as a message.</p>
        ) : (
          <ul className="win-rows">
            {uplinks.map((u) => (
              <Row key={u.id} uplink={u} now={now} onEdit={() => setEditing(u.id)} onNotice={setNotice} onSecret={setShown} />
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
