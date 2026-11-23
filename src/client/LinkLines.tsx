/**
 * Docking 2 on a card: for each link of a task or a mission, one line of plain words (where it is, what it is doing, the last note), the due date and cost, the
 * deliverables, the trail, and the keys that exist for its state: Accept or Return a delivery, Give back, Withdraw. Nothing here edits the other station's task: the
 * keys send an event over the link, and the line changes when the other side answers.
 */
import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { DockView, LinkEventView, LinkView } from '../shared/protocol.js';
import * as api from './api.js';
import { attachmentHref, canRecall, canReturn, costLine, dueLine, KIND_WORDS, linkLine, needsReview, overCap, progressLine, trailLine, waitingLine } from './links.js';
import { refreshLinks } from './linksData.js';
import { useNow, useStore } from './store.js';
import { useRun } from './WallView.js';
import './docking.css';

const REASON_MAX = 200;

function Deliverables({ trail }: { trail: readonly LinkEventView[] }): ReactElement | null {
  const items = trail.flatMap((e) => e.attachments ?? []);
  if (items.length === 0) return null;
  return (
    <ul className="dk-deliver" aria-label="Deliverables">
      {items.map((a, i) => {
        const href = attachmentHref(a);
        return (
          <li key={i}>
            <span className="legend">{KIND_WORDS[a.kind]}</span>{' '}
            {href === null ? (
              <span>
                {a.label} <code>{a.ref}</code>
              </span>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {a.label}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Trail({ link }: { link: LinkView }): ReactElement {
  const now = useNow();
  return (
    <details className="dk-trail">
      <summary>
        Trail <span className="plan-count">{link.trail.length}</span>
      </summary>
      <ol>
        {link.trail.map((e) => (
          <li key={`${e.author}:${e.seq}`}>{trailLine(e, now)}</li>
        ))}
      </ol>
    </details>
  );
}

/** The reason box of a Return: one line of up to 200 characters, then the key. */
function Return({ link, label, onDone }: { link: LinkView; label: string; onDone(): void }): ReactElement {
  const id = useId();
  const [reason, setReason] = useState('');
  const { busy, error, run } = useRun();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    run(async () => {
      await api.returnLink(link.id, reason.trim());
      await refreshLinks();
      onDone();
    });
  };
  return (
    <form className="dk-return" onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-why`}>Reason</label>
        <input id={`${id}-why`} className="input" type="text" maxLength={REASON_MAX} value={reason} autoComplete="off" onChange={(e) => setReason(e.target.value)} />
      </div>
      <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || undefined}>
        {label}
      </button>
      <button type="button" className="btn" data-kind="quiet" onClick={onDone}>
        Cancel
      </button>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function LinkLine({ link, dock }: { link: LinkView; dock: DockView | undefined }): ReactElement {
  const { busy, error, run } = useRun();
  const [returning, setReturning] = useState(false);
  const waiting = waitingLine(link, dock);
  const due = dueLine(link);
  const progress = progressLine(link);
  const nominal = link.state === 'done' || link.state === 'recalled' || link.state === 'refused' || link.state === 'detached';
  return (
    <section className="dk-link" aria-label={`${link.kind === 'mission' ? 'Mission' : 'Task'} ${link.mine} with ${link.peerName}`} data-state={link.state}>
      <p className="dk-link-line">
        <span className="chip" data-tone={needsReview(link) ? 'amber' : nominal ? 'quiet' : 'go'}>
          {link.role === 'sender' ? 'OUT' : 'IN'}
        </span>{' '}
        <span>{linkLine(link)}</span>
        {link.stale && (
          <>
            {' '}
            <span className="chip" data-tone="amber">
              STALE
            </span>
          </>
        )}
      </p>
      {(due !== null || progress !== null) && <p className="hint">{[due, progress].filter((x) => x !== null).join(' · ')}</p>}
      {link.role === 'sender' && (
        <p className="hint" data-over={overCap(link) || undefined}>
          {costLine(link)}
          {overCap(link) && ' · past the cap: you can withdraw it'}
        </p>
      )}
      {waiting !== null && (
        <p className="hint" role="status">
          {waiting}
        </p>
      )}
      <Deliverables trail={link.trail} />
      <Trail link={link} />
      {!returning && (
        <div className="dk-link-keys">
          {needsReview(link) && (
            <>
              <button type="button" className="btn" data-kind="primary" aria-label={`Accept ${link.mine} from ${link.peerName}`} aria-disabled={busy || undefined} onClick={() => run(async () => { await api.acceptLink(link.id); await refreshLinks(); })}>
                Accept
              </button>
              <button type="button" className="btn" aria-label={`Send ${link.mine} back to ${link.peerName}`} onClick={() => setReturning(true)}>
                Send back
              </button>
            </>
          )}
          {canReturn(link) && (
            <button type="button" className="btn" aria-label={`Give ${link.mine} back to ${link.peerName}`} onClick={() => setReturning(true)}>
              Give back
            </button>
          )}
          {canRecall(link) && (
            <button type="button" className="btn" data-kind="quiet" aria-label={`Withdraw ${link.mine} from ${link.peerName}`} aria-disabled={busy || undefined} onClick={() => run(async () => { await api.recallLink(link.id); await refreshLinks(); })}>
              Withdraw
            </button>
          )}
        </div>
      )}
      {returning && <Return link={link} label={needsReview(link) ? 'Send it back' : 'Give it back'} onDone={() => setReturning(false)} />}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** The links of one task or mission, for its card. Nothing when it has none. */
export function LinkLines({ links }: { links: readonly LinkView[] }): ReactElement | null {
  const docks = useStore((s) => s.docking.docks);
  if (links.length === 0) return null;
  return (
    <div className="dk-links">
      {links.map((l) => (
        <LinkLine key={l.id} link={l} dock={docks.find((d) => d.id === l.peer)} />
      ))}
    </div>
  );
}
