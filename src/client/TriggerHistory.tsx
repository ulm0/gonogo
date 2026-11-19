/**
 * The HISTORY tab of Launch Window (docs/features/triggers.md): everything that fired by itself or came in from outside, newest first: a webhook
 * delivery, a polled Telegram update, a schedule's run, a Docking call. Filters by kind, source and outcome; a card's own link opens it filtered.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { TRIGGER_KINDS } from '../shared/protocol.js';
import type { TriggerEntry, TriggerKind } from '../shared/protocol.js';
import * as api from './api.js';
import { setHistoryFilter, useNow, useStore } from './store.js';
import { KIND_LABEL, lineOf, NO_FILTER, OUTCOMES, queryOf, sourcesOf, toneOf } from './triggers.js';
import { atText } from './uplink.js';

const REFRESH_MS = 10_000;

export function TriggerHistory(): ReactElement {
  const id = useId();
  const filter = useStore((s) => s.historyFilter);
  const uplinks = useStore((s) => s.uplinks);
  const schedules = useStore((s) => s.schedules);
  const now = useNow();
  const [entries, setEntries] = useState<TriggerEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback((): void => {
    api.getTriggers(queryOf(filter)).then(
      (found) => {
        setEntries(found);
        setProblem(null);
      },
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    );
  }, [filter]);
  useEffect(() => {
    load();
    // only while the tab is on screen: a hidden browser tab does not ask every 10 s
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    const shown = (): void => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [load]);

  const sources = useMemo(
    () => sourcesOf(entries ?? [], [...uplinks.map((u) => ({ kind: 'uplink' as const, id: u.id, name: u.name })), ...schedules.map((s) => ({ kind: 'schedule' as const, id: s.id, name: s.name }))]),
    [entries, uplinks, schedules],
  );
  const filtered = filter.kind !== '' || filter.source !== '' || filter.outcome !== '';

  return (
    <section className="module trg" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        HISTORY
      </h2>
      <p className="hint">Everything that fired by itself or came in from outside: webhooks, Telegram messages read by polling, schedule runs and Docking calls. Newest first. The payload is kept as one cut line with secrets replaced; the whole body is not.</p>
      <div className="trg-filters" role="group" aria-label="Filter the history">
        <label htmlFor={`${id}-kind`}>Kind</label>
        <select id={`${id}-kind`} className="input" data-fit="" value={filter.kind} onChange={(e) => setHistoryFilter({ kind: e.target.value as TriggerKind | '' })}>
          <option value="">All kinds</option>
          {TRIGGER_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-source`}>Source</label>
        <select id={`${id}-source`} className="input" data-fit="" value={filter.source} onChange={(e) => setHistoryFilter({ source: e.target.value })}>
          <option value="">All sources</option>
          {filter.source !== '' && !sources.some((s) => s.id === filter.source) && <option value={filter.source}>{filter.source}</option>}
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-outcome`}>Outcome</label>
        <select id={`${id}-outcome`} className="input" data-fit="" value={filter.outcome} onChange={(e) => setHistoryFilter({ outcome: e.target.value })}>
          <option value="">Any outcome</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <button type="button" className="btn" data-kind="quiet" aria-disabled={!filtered || undefined} onClick={() => filtered && setHistoryFilter(NO_FILTER)}>
          Clear filters
        </button>
        <button type="button" className="btn" onClick={load}>
          Refresh
        </button>
      </div>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {entries !== null && entries.length === 0 && <p className="loop-empty">{filtered ? 'Nothing matches these filters.' : 'Nothing has fired yet. A webhook delivery, a schedule run or a Docking call will show here.'}</p>}
      {entries !== null && entries.length > 0 && (
        <ol className="trg-list" aria-label="Triggers, newest first">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="trg-row" data-outcome={e.outcome}>
              <span className="lcd-num trg-at">{atText(e.at, now)}</span>
              <span className="chip" data-tone="quiet">
                {KIND_LABEL[e.kind]}
              </span>
              <span className="trg-name">{e.name}</span>
              <span className="chip" data-tone={toneOf(e.outcome)}>
                {e.outcome}
              </span>
              <span className="trg-what">{lineOf(e)}</span>
              {e.note !== undefined && <span className="hint trg-note">{e.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
