/**
 * The cost an engine reports itself (docs/features/cost.md): Claude Code's status line carries `cost.total_cost_usd`, the dollars of the
 * session so far. The per-agent status-line shim posts that number and the session id (and still nothing else but `rate_limits`);
 * it is kept next to the ledger, never mixed into it: the estimate (tokens times price) is the one basis the headline, the budgets and Redline use.
 *
 * `reported.jsonl` holds `{at, agent, session, total}`, one line each time a session's total CHANGED. Dollars are worked out on read, per
 * (agent, session): a total lower than the one before is a reset (the new total is the delta, never negative), the first line of a key counts
 * as its own total, and a day is the local day the line arrived on. So a restart of gonogo cannot count anything twice. The last seconds
 * before a session ends can be lost: the figure is "at least" what was spent.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { FILE_MODE, FUEL_KEEP_MS } from './constants.js';

export const REPORTED_FILE = 'reported.jsonl';
const TOTAL_MAX = 1_000_000;
const SESSION_RE = /^[\w.:-]{1,80}$/;

interface Line {
  at: number;
  agent: string;
  session: string;
  total: number;
}

export interface ReportedAgent {
  /** Dollars the engine reported in the window: at least this much (the last seconds of a session can be lost). */
  usd: number;
  sessions: number;
}

export interface Reported {
  load(): Promise<void>;
  /** A status-line body of an agent: records its `session` and `total` when the total changed. */
  record(agent: string, body: unknown): void;
  /** Per agent, the reported dollars of the local days from `startMs` on, and the day of each arrival (for the per-day table). */
  window(startMs: number, dayOf: (at: number) => string): { agents: Record<string, ReportedAgent>; byDay: Record<string, Record<string, number>> };
  close(): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The session and the total of a status-line body, or null: strict, anything else in it is ignored. */
export function parseReport(body: unknown): { session: string; total: number } | null {
  if (!isRecord(body) || typeof body.session !== 'string' || !SESSION_RE.test(body.session)) return null;
  const total = body.total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0 || total > TOTAL_MAX) return null;
  return { session: body.session, total: Math.round(total * 1e6) / 1e6 };
}

export function createReported(options: { dir: string; now: () => number; log: Logger }): Reported {
  const { now, log } = options;
  const path = join(options.dir, REPORTED_FILE);
  let lines: Line[] = [];
  const last = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();
  const key = (agent: string, session: string): string => `${agent}\u0000${session}`;

  /** Lines older than the window are dropped, except the newest of each key before it: the baseline the next delta needs. */
  const prune = (): boolean => {
    const cut = now() - FUEL_KEEP_MS;
    const baseline = new Map<string, Line>();
    for (const l of lines) if (l.at < cut) baseline.set(key(l.agent, l.session), l);
    const kept = lines.filter((l) => l.at >= cut || baseline.get(key(l.agent, l.session)) === l);
    const changed = kept.length !== lines.length;
    lines = kept;
    return changed;
  };

  return {
    async load() {
      let text = '';
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${REPORTED_FILE} could not be read; reported cost starts at 0`, error);
      }
      for (const raw of text.split('\n')) {
        if (raw === '') continue;
        try {
          const l = JSON.parse(raw) as unknown;
          if (isRecord(l) && typeof l.at === 'number' && typeof l.agent === 'string' && typeof l.session === 'string' && typeof l.total === 'number' && Number.isFinite(l.total) && l.total >= 0) lines.push({ at: l.at, agent: l.agent, session: l.session, total: l.total });
        } catch {
          // a torn line is not a line
        }
      }
      lines.sort((a, b) => a.at - b.at);
      for (const l of lines) last.set(key(l.agent, l.session), l.total);
      if (prune()) {
        const json = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length === 0 ? '' : '\n');
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        await writeFile(temp, json, { mode: FILE_MODE, flag: 'wx' }).then(() => rename(temp, path)).catch((error: unknown) => log.warn('reported cost could not be pruned', error));
      }
    },

    record(agent, body) {
      const r = parseReport(body);
      if (r === null) return;
      const k = key(agent, r.session);
      if (last.get(k) === r.total) return;
      last.set(k, r.total);
      const line: Line = { at: now(), agent, session: r.session, total: r.total };
      lines.push(line);
      chain = chain.then(() => appendFile(path, JSON.stringify(line) + '\n', { mode: FILE_MODE })).catch((error: unknown) => log.warn('reported cost could not be saved', error));
    },

    window(startMs, dayOf) {
      const agents: Record<string, ReportedAgent> = {};
      const byDay: Record<string, Record<string, number>> = {};
      const before = new Map<string, number>();
      const seen = new Map<string, Set<string>>();
      for (const l of [...lines].sort((a, b) => a.at - b.at)) {
        const k = key(l.agent, l.session);
        const was = before.get(k);
        // the first line of a key is its own total; a total below the last is a reset, so the new total is the delta; never negative
        const delta = was === undefined ? l.total : l.total >= was ? l.total - was : l.total;
        before.set(k, l.total);
        if (l.at < startMs) continue;
        const a = (agents[l.agent] ??= { usd: 0, sessions: 0 });
        a.usd += delta;
        const sessions = seen.get(l.agent) ?? new Set<string>();
        if (!sessions.has(l.session)) a.sessions += 1;
        sessions.add(l.session);
        seen.set(l.agent, sessions);
        const day = dayOf(l.at);
        const perDay = (byDay[day] ??= {});
        perDay[l.agent] = (perDay[l.agent] ?? 0) + delta;
      }
      return { agents, byDay };
    },

    async close() {
      await chain;
    },
  };
}
