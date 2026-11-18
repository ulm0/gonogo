/** Plan quota (docs/quota-spec.md): the words of the PLAN block, with no React. */
import type { PlanQuota } from '../shared/protocol.js';

export const PLAN_LABEL = "from Claude Code: your plan's own number";
export const NO_PLAN_TEXT =
  "No plan quota reported. A subscriber's Claude Code agent reports it after its first reply; an API-key or Bedrock room has none (see COST). The meters below are gonogo's own ledger: an estimate, not your plan's number.";

export interface PlanRow {
  key: 'fiveHour' | 'sevenDay';
  label: string;
  pct: number;
  /** "41 %, resets in 2 h 10 min" */
  text: string;
  /** over 80 or 95 percent, for the colour */
  level: 'ok' | 'low' | 'over';
}

export function durationText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

/** The windows still open, with the reset as a time from `now`. */
export function planRows(plan: PlanQuota, now: number): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const [key, label] of [['fiveHour', '5-HOUR'], ['sevenDay', 'WEEK']] as const) {
    const w = plan[key];
    if (w === undefined || w.resetsAt <= now) continue;
    rows.push({ key, label, pct: w.pct, text: `${Math.floor(w.pct)} %, resets in ${durationText(w.resetsAt - now)}`, level: w.pct >= 95 ? 'over' : w.pct >= 80 ? 'low' : 'ok' });
  }
  return rows;
}

/** "last seen 7 min ago" for a stale report, else "". */
export const ageText = (plan: PlanQuota, now: number): string => (plan.stale ? `last seen ${durationText(now - plan.at)} ago (${plan.source})` : '');
