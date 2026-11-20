/**
 * CHECK NOW (docs/features/update.md): asks the registry for the newest gonogo now, instead of at the next daily check. The server allows one ask a minute and
 * answers the seconds to wait inside that time. The answer reaches every page as the rollout frame; this only says when the last check was and how it went.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import * as api from './api.js';
import { useStore } from './store.js';

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function checkedAgo(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** Flight Rules: the block of room main's version check (any install, not only Docker); nothing in a room that runs no check. */
export function VersionCheckBlock(): ReactElement | null {
  const enabled = useStore((s) => s.rollout?.enabled === true);
  if (!enabled) return null;
  return (
    <section className="module rules-block" aria-labelledby="version-check-title">
      <h2 className="label" id="version-check-title">
        VERSION CHECK
      </h2>
      <p className="hint">gonogo asks the registry for the newest version once a day. If one came out since, ask now.</p>
      <CheckNow />
    </section>
  );
}

export function CheckNow(): ReactElement | null {
  const rollout = useStore((s) => s.rollout);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  if (rollout === null || !rollout.enabled) return null;
  const press = (): void => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    api.checkUpdateNow().then(
      (answer) => {
        setBusy(false);
        setSaid(answer.waitS === undefined ? null : `Asked a moment ago: try again in ${answer.waitS} s.`);
      },
      (e: unknown) => {
        setBusy(false);
        setSaid(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <span className="check-now">
      <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={press}>
        {busy ? 'CHECKING…' : 'CHECK NOW'}
      </button>
      <span className="hint" role="status">
        {said ?? (rollout.checkedAt === null ? 'Not checked yet.' : `Checked ${checkedAgo(rollout.checkedAt)}${rollout.latest === null ? '' : `: newest is ${rollout.latest}`}.`)}
      </span>
    </span>
  );
}
