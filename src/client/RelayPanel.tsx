/**
 * Relay: Slack, GitHub, Linear and Telegram. A section of the Launch Window view, under UPLINK, because it makes uplinks and
 * posts what the Director would otherwise have to come and see. The top says which kinds of item are forwarded; each service has
 * a card with its target (Slack and Telegram: a token and a place, Test and Remove), its setup steps, the uplinks of its kind
 * with their addresses and a key that makes one. The token is typed here once and never comes back: the page asks the server for
 * the view again after each change (no frame), and the view has no token.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { roomOrigin } from './base.js';
import type { FormEvent, ReactElement } from 'react';
import { RELAY_FORWARD_KINDS } from '../shared/protocol.js';
import type { RelayService, RelayTargetView, RelayView } from '../shared/protocol.js';
import * as api from './api.js';
import { FORWARD_LABELS, lastText, parts, SERVICES, TARGET_FIELDS, targetProblems, toggled } from './relay.js';
import type { ServiceInfo, TargetProblems } from './relay.js';
import { useNow, useStore, showHistory } from './store.js';
import { copyText, endpointOf, lastText as deliveryText } from './uplink.js';
import { Editor, SecretPanel } from './UplinkPanel.js';
import type { Shown } from './UplinkPanel.js';
import { useRun } from './WallView.js';
import './loop.css';
import './launch.css';
import './uplink.css';
import './relay.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const selectAll = (event: { currentTarget: HTMLInputElement }): void => event.currentTarget.select();

interface Shared {
  view: RelayView | null;
  setView(view: RelayView): void;
  now: number;
  onNotice(text: string): void;
}
type Acts = Omit<Shared, 'view'>;

function Forward({ view, setView, onNotice }: Shared): ReactElement {
  const id = useId();
  const { busy, error, run } = useRun();
  return (
    <fieldset className="rl-forward module" disabled={view === null}>
      <legend className="label">Forwarded to the targets</legend>
      {RELAY_FORWARD_KINDS.map((kind) => (
        <div className="win-check" key={kind}>
          <input
            id={`${id}-${kind}`}
            type="checkbox" className="check"
            checked={view?.forward.includes(kind) ?? false}
            aria-disabled={busy || undefined}
            onChange={(e) => {
              const on = e.target.checked;
              if (view !== null) {
                run(async () => {
                  setView(await api.setRelayForward({ kinds: toggled(view.forward, kind, on) }));
                  onNotice(`${FORWARD_LABELS[kind]}: ${on ? 'forwarded' : 'not forwarded'}.`);
                });
              }
            }}
          />
          <label htmlFor={`${id}-${kind}`}>{FORWARD_LABELS[kind]}</label>
        </div>
      ))}
      <p className="hint">A kind that is ticked goes to every target that is saved below, as soon as it happens.</p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** The place gonogo posts to: a bot token and a channel or chat. The saved token is never shown; an empty field keeps it. */
function Target({ service, label, saved, setView, now, onNotice }: Acts & { service: RelayService; label: string; saved: RelayTargetView | null }): ReactElement {
  const id = useId();
  const [token, setToken] = useState('');
  const [to, setTo] = useState(saved?.to ?? '');
  const [problems, setProblems] = useState<TargetProblems>({});
  const [busy, setBusy] = useState(false);
  const { busy: acting, error, run } = useRun();
  const place = TARGET_FIELDS[service];
  useEffect(() => setTo(saved?.to ?? ''), [saved?.to]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const found = targetProblems({ token, to }, saved !== null);
    setProblems(found);
    const bad = found.token !== undefined ? 'token' : found.to !== undefined ? 'to' : null;
    if (bad !== null) {
      document.getElementById(`${id}-${bad}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      setView(await api.setRelayTarget(service, token.trim() === '' ? { to: to.trim() } : { token: token.trim(), to: to.trim() }));
      setToken('');
      onNotice(`${label} target saved.`);
    } catch (e) {
      const field = (e as { field?: unknown }).field;
      if (field === 'token' || field === 'to') {
        setProblems({ [field]: messageOf(e) });
        document.getElementById(`${id}-${field}`)?.focus();
      } else setProblems({ to: messageOf(e) });
    }
    setBusy(false);
  }
  const fieldError = (field: keyof TargetProblems): ReactElement | null =>
    problems[field] === undefined ? null : (
      <p className="error" id={`${id}-${field}-error`}>
        {problems[field]}
      </p>
    );
  const last = saved?.last ?? null;

  return (
    <form className="rl-target" aria-label={`${label} target`} noValidate onSubmit={(e) => void submit(e)}>
      <div className="field" data-invalid={problems.token !== undefined ? '' : undefined}>
        <label htmlFor={`${id}-token`}>Bot token</label>
        <input
          id={`${id}-token`}
          type="password"
          className="input"
          value={token}
          placeholder={saved === null ? '' : 'Saved. Leave empty to keep it.'}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problems.token !== undefined}
          aria-describedby={problems.token !== undefined ? `${id}-token-error` : undefined}
          onChange={(e) => {
            setToken(e.target.value);
            setProblems((p) => ({ ...p, token: undefined }));
          }}
        />
        {fieldError('token')}
      </div>
      <div className="field" data-invalid={problems.to !== undefined ? '' : undefined}>
        <label htmlFor={`${id}-to`}>{place.to}</label>
        <input
          id={`${id}-to`}
          className="input"
          value={to}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problems.to !== undefined}
          aria-describedby={[`${id}-to-hint`, problems.to !== undefined ? `${id}-to-error` : ''].filter(Boolean).join(' ')}
          onChange={(e) => {
            setTo(e.target.value);
            setProblems((p) => ({ ...p, to: undefined }));
          }}
        />
        {fieldError('to')}
        <p className="hint" id={`${id}-to-hint`}>
          {place.hint}
        </p>
      </div>
      <div className="rl-keys">
        <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || undefined}>
          {busy ? 'Saving…' : 'Save target'}
        </button>
        <button
          type="button"
          className="btn"
          aria-label={`Test the ${label} target`}
          aria-disabled={saved === null || acting || undefined}
          onClick={() =>
            saved !== null &&
            run(async () => {
              const next = await api.testRelayTarget(service);
              setView(next);
              onNotice(`${label}: ${next[service]?.last?.note ?? 'sent'}`);
            })
          }
        >
          Test
        </button>
        {saved !== null && (
          <button
            type="button"
            className="btn"
            data-kind="danger"
            aria-label={`Remove the ${label} target`}
            aria-disabled={acting || undefined}
            onClick={() =>
              run(async () => {
                setView(await api.removeRelayTarget(service));
                setToken('');
                onNotice(`${label} target removed.`);
              })
            }
          >
            Remove
          </button>
        )}
      </div>
      <p className="win-last">
        {saved === null ? 'No target yet: nothing is sent to ' + label + '.' : lastText(last, now)}
        {last !== null && (
          <>
            {' '}
            <span className="chip" data-tone={last.ok ? 'go' : 'nogo'}>
              {last.ok ? 'sent' : 'failed'}
            </span>
          </>
        )}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Card({ info, ...shared }: Shared & { info: ServiceInfo }): ReactElement {
  const id = useId();
  const uplinks = useStore((s) => s.uplinks).filter((u) => u.kind === info.kind);
  const [making, setMaking] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const add = useRef<HTMLButtonElement | null>(null);
  const { onNotice, now } = shared;
  const closeTo = (clear: () => void): void => {
    clear();
    add.current?.focus();
  };
  return (
    <article className="rl-card module" aria-labelledby={id}>
      <h3 id={id} className="label">
        {info.label}
      </h3>
      {info.target !== null && <Target {...shared} service={info.target} label={info.label} saved={shared.view?.[info.target] ?? null} />}
      {info.target === 'telegram' && shared.view?.telegram != null && shared.view.telegramInbound !== undefined && (
        <p className={shared.view.telegramInbound.mode === 'error' ? 'error' : 'hint'} data-inbound={shared.view.telegramInbound.mode}>
          {shared.view.telegramInbound.note}
        </p>
      )}
      <details className="up-log rl-steps">
        <summary>Setup steps</summary>
        <ol>
          {info.steps.map((step) => (
            <li key={step}>{parts(step).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : p.text))}</li>
          ))}
        </ol>
      </details>
      {uplinks.length > 0 && (
        <ul className="rl-uplinks" aria-label={`${info.label} uplinks`}>
          {uplinks.map((u) => {
            const url = endpointOf(roomOrigin(), u.id);
            return (
              <li key={u.id}>
                <h4 className="win-name">{u.name}</h4>
                <div className="up-url">
                  <input readOnly className="input up-value" aria-label={`Address of ${u.name}`} value={url} spellCheck={false} onFocus={selectAll} />
                  <button type="button" className="btn" aria-label={`Copy address of ${u.name}`} onClick={() => void copyText(url).then((ok) => onNotice(ok ? `Address of ${u.name} copied.` : 'Could not copy. Select the address and copy it.'))}>
                    Copy
                  </button>
                </div>
                <p className="win-last">
                  {deliveryText(u, now)}{' '}
                  <button type="button" className="btn" data-kind="quiet" aria-label={`History of ${u.name}`} onClick={() => showHistory({ source: u.id })}>
                    History
                  </button>
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {making && (
        <Editor
          uplink={null}
          kind={info.kind}
          name={info.label}
          hint={info.kind === 'slack' ? 'Slack, Basic Information, App Credentials, Signing Secret.' : info.kind === 'linear' ? 'The Signing secret that Linear shows for the webhook.' : undefined}
          onDone={() => closeTo(() => setMaking(false))}
          onSecret={setShown}
        />
      )}
      {shown !== null && <SecretPanel shown={shown} onDone={() => closeTo(() => setShown(null))} onNotice={onNotice} />}
      <button type="button" ref={add} className="btn rl-make" aria-label={`Make a ${info.label} uplink`} onClick={() => setMaking(true)}>
        Make uplink
      </button>
    </article>
  );
}

/** The RELAY module of the Launch Window view. */
export function RelayPanel(): ReactElement {
  const titleId = useId();
  const now = useNow();
  const [view, setView] = useState<RelayView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    api.getRelay().then(
      (v) => alive && setView(v),
      (e: unknown) => alive && setProblem(messageOf(e)),
    );
    return () => {
      alive = false;
    };
  }, []);
  const shared: Shared = { view, setView, now, onNotice: setNotice };
  return (
    <section className="rl" aria-labelledby={titleId}>
      <header className="loop-head">
        <h2 id={titleId} className="disp loop-title up-title">
          RELAY
        </h2>
      </header>
      <p className="hint">
        Slack, GitHub, Linear and Telegram. They reach gonogo from the internet, so the address of an uplink needs a public HTTPS name that is on the allow-list; see Reverse proxy in the reference.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <Forward {...shared} />
      <div className="rl-cards">
        {SERVICES.map((info) => (
          <Card key={info.kind} info={info} {...shared} />
        ))}
      </div>
      <p className="hint up-notice" role="status">
        {notice}
      </p>
    </section>
  );
}
