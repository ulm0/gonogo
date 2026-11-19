/** The history of triggers (docs/features/triggers.md): the words and the small logic of the HISTORY tab, with no React. */
import { TRIGGER_KINDS } from '../shared/protocol.js';
import type { TriggerEntry, TriggerKind } from '../shared/protocol.js';

export interface HistoryFilter {
  /** '' is every kind. */
  kind: TriggerKind | '';
  /** '' is every source; else the id of an uplink, a schedule or a dock, or `telegram`. */
  source: string;
  /** '' is every outcome. */
  outcome: string;
}

export const NO_FILTER: HistoryFilter = { kind: '', source: '', outcome: '' };

export const KIND_LABEL: Readonly<Record<TriggerKind, string>> = { uplink: 'Webhook', telegram: 'Telegram (polling)', schedule: 'Schedule', docking: 'Docking' };

/** The outcomes that mean it did not work out; the others are the status of the message it made. */
export const BAD_OUTCOMES: readonly string[] = ['refused', 'failed', 'undelivered'];
export const OUTCOMES: readonly string[] = ['queued', 'held', 'delivered', 'read', 'to_user', 'answered', 'ignored', 'undelivered', 'refused', 'failed'];

export const toneOf = (outcome: string): 'nogo' | 'amber' | 'quiet' => (BAD_OUTCOMES.includes(outcome) ? 'nogo' : outcome === 'held' || outcome === 'queued' ? 'amber' : 'quiet');

/** The query of GET /api/triggers for a filter (empty parts left out). */
export function queryOf(filter: HistoryFilter, limit = 100): string {
  const q = new URLSearchParams();
  if (filter.kind !== '') q.set('kind', filter.kind);
  if (filter.source !== '') q.set('source', filter.source);
  if (filter.outcome !== '') q.set('outcome', filter.outcome);
  q.set('limit', String(limit));
  return q.toString();
}

/** A filter from what a card passes (a link to its own history): anything unknown is dropped. */
export function filterOf(patch: Partial<HistoryFilter>): HistoryFilter {
  return {
    kind: (TRIGGER_KINDS as readonly string[]).includes(patch.kind ?? '') ? (patch.kind as TriggerKind) : '',
    source: /^[A-Za-z0-9_.:@-]{1,40}$/.test(patch.source ?? '') ? (patch.source as string) : '',
    outcome: /^[A-Za-z0-9_]{1,20}$/.test(patch.outcome ?? '') ? (patch.outcome as string) : '',
  };
}

/** The sources to pick from: what is in the log, and every uplink and schedule there is (so one that has not fired yet can be asked about). */
export function sourcesOf(entries: readonly TriggerEntry[], known: ReadonlyArray<{ kind: TriggerKind; id: string; name: string }>): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const k of known) seen.set(k.id, `${k.name} (${KIND_LABEL[k.kind]})`);
  for (const e of entries) if (!seen.has(e.source)) seen.set(e.source, `${e.name} (${KIND_LABEL[e.kind]})`);
  return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** One line for a row: what it was, to whom, and the reason when it did not go. */
export function lineOf(e: TriggerEntry): string {
  const parts = [e.what === '' ? '(nothing kept)' : e.what];
  if (e.agent !== undefined) parts.push(`to ${e.agent}`);
  if (e.message !== undefined) parts.push(e.message);
  return parts.join(' · ');
}
