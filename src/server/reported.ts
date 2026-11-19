/**
 * The cost an engine reports itself (docs/features/cost.md): Claude Code's status line carries `cost.total_cost_usd`, the dollars of the
 * session so far. The per-agent status-line shim posts that number, the session id and the time it was posted (and still nothing else but
 * `rate_limits`); it is kept next to the ledger, never mixed into it: the estimate (tokens times price) is the one basis the headline, the
 * budgets and Redline use.
 *
 * `reported.jsonl` holds a first line `{created}` and then `{at, agent, session, total, base?}`, one line each time a SESSION's total changed.
 * Dollars are worked out on read, per session: a total lower than the one before, **posted later**, is a reset (the new total is the delta, never
 * negative), and a report posted earlier than the last kept for the session is dropped (two shims can deliver out of order). A session is one key
 * whatever the agent is called, so a rename does not count its total again; each delta is credited to the agent the line names. The first line of
 * a session that arrives within ten minutes of the file being made is a `base`: it counts 0, because that session was already running when this
 * began and its total is not today's spend. A restart of gonogo cannot count anything twice. The last seconds before a session ends can be lost:
 * the figure is "at least". The file is pruned as it grows, and the number of sessions kept is capped.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../shared/protocol.js';
import { FILE_MODE, FUEL_KEEP_MS } from './constants.js';

export const REPORTED_FILE = 'reported.jsonl';
const TOTAL_MAX = 1_000_000;
const SESSION_RE = /^[\w.:-]{1,80}$/;
/** A session that is first seen this soon after the file was made was already running: it counts 0 on that first line. */
const BASE_MS = 10 * 60 * 1000;
/** The shim's own time may be this far ahead of ours (clock skew) and this far behind (a post that waited). */
const AHEAD_MS = 60 * 1000;
const BEHIND_MS = 6 * 3_600_000;
/** Sessions kept in all and per agent; a new one beyond that is not recorded (an agent posting endless fresh ids cannot grow memory or disk). */
export const MAX_SESSIONS = 2000;
export const MAX_SESSIONS_PER_AGENT = 500;
/** The file and the memory are pruned every this many lines recorded. */
const PRUNE_EVERY = 200;

interface Line {
  at: number;
  agent: string;
  session: string;
  total: number;
  base?: true;
}

export interface ReportedAgent {
  /** Dollars the engine reported in the window: at least this much (the last seconds of a session can be lost). */
  usd: number;
  sessions: number;
}

export interface Reported {
  load(): Promise<void>;
  /** A status-line body of an agent: records its `session` and `total` when the total changed and the report is not older than the last one. */
  record(agent: string, body: unknown): void;
  /** Per agent, the reported dollars of the local days from `startMs` on, and the day of each arrival (for the per-day table). */
  window(startMs: number, dayOf: (at: number) => string): { agents: Record<string, ReportedAgent>; byDay: Record<string, Record<string, number>> };
  /** How many sessions are kept (the caps are tested with it). */
  size(): number;
  close(): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The session, the total and the shim's own time of a status-line body, or null: strict, anything else in it is ignored. */
export function parseReport(body: unknown): { session: string; total: number; at?: number } | null {
  if (!isRecord(body) || typeof body.session !== 'string' || !SESSION_RE.test(body.session)) return null;
  const total = body.total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0 || total > TOTAL_MAX) return null;
  const at = typeof body.at === 'number' && Number.isFinite(body.at) && body.at > 0 ? Math.round(body.at) : undefined;
  return { session: body.session, total: Math.round(total * 1e6) / 1e6, ...(at === undefined ? {} : { at }) };
}

export function createReported(options: { dir: string; now: () => number; log: Logger }): Reported {
  const { now, log } = options;
  const path = join(options.dir, REPORTED_FILE);
  let lines: Line[] = [];
  /** The newest report kept for each session. */
  const lastBy = new Map<string, { at: number; total: number; agent: string }>();
  let createdAt: number | null = null;
  let headerWritten = false;
  let recorded = 0;
  let chain: Promise<unknown> = Promise.resolve();

  /** Lines older than the window are dropped, except the newest of each session before it (the baseline the next delta needs); a session whose newest line is older than the window goes whole. */
  const prune = (): boolean => {
    const cut = now() - FUEL_KEEP_MS;
    const newest = new Map<string, number>();
    for (const l of lines) newest.set(l.session, Math.max(newest.get(l.session) ?? 0, l.at));
    const baseline = new Map<string, Line>();
    for (const l of lines) if (l.at < cut) baseline.set(l.session, l);
    const kept = lines.filter((l) => (newest.get(l.session) ?? 0) >= cut && (l.at >= cut || baseline.get(l.session) === l));
    const changed = kept.length !== lines.length;
    lines = kept;
    if (changed) {
      lastBy.clear();
      for (const l of [...lines].sort((a, b) => a.at - b.at)) lastBy.set(l.session, { at: l.at, total: l.total, agent: l.agent });
    }
    return changed;
  };

  const rewrite = async (): Promise<void> => {
    const json = [JSON.stringify({ created: createdAt ?? now() }), ...lines.map((l) => JSON.stringify(l))].join('\n') + '\n';
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, json, { mode: FILE_MODE, flag: 'wx' }).then(() => rename(temp, path)).catch((error: unknown) => log.warn('reported cost could not be pruned', error));
    headerWritten = true;
  };

  return {
    size: () => lastBy.size,

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
          if (isRecord(l) && typeof l.created === 'number' && Number.isFinite(l.created)) {
            createdAt = createdAt === null ? l.created : Math.min(createdAt, l.created);
            headerWritten = true;
          } else if (isRecord(l) && typeof l.at === 'number' && typeof l.agent === 'string' && typeof l.session === 'string' && typeof l.total === 'number' && Number.isFinite(l.total) && l.total >= 0) {
            lines.push({ at: l.at, agent: l.agent, session: l.session, total: l.total, ...(l.base === true ? { base: true as const } : {}) });
          }
        } catch {
          // a torn line is not a line
        }
      }
      lines.sort((a, b) => a.at - b.at);
      for (const l of lines) lastBy.set(l.session, { at: l.at, total: l.total, agent: l.agent });
      // a file with no first line is older than this feature of the file: no session of it is "already running"; a new file is made now
      if (text === '' && createdAt === null) createdAt = now();
      if (prune()) await rewrite();
    },

    record(agent, body) {
      const r = parseReport(body);
      if (r === null) return;
      const t = now();
      // the shim's own time orders the reports; one that is missing, from the future or far too old is taken as arriving now
      const at = r.at !== undefined && r.at <= t + AHEAD_MS && r.at >= t - BEHIND_MS ? r.at : t;
      const prev = lastBy.get(r.session);
      if (prev !== undefined) {
        // older than the last kept for this session: it was overtaken on the way (two shims), and a lower total in it is no reset
        if (at < prev.at) return;
        if (r.total === prev.total) {
          prev.at = at;
          return;
        }
      } else {
        if (lastBy.size >= MAX_SESSIONS) return;
        let mine = 0;
        for (const v of lastBy.values()) if (v.agent === agent) mine += 1;
        if (mine >= MAX_SESSIONS_PER_AGENT) return;
      }
      const base = prev === undefined && createdAt !== null && at - createdAt < BASE_MS;
      const line: Line = { at, agent, session: r.session, total: r.total, ...(base ? { base: true as const } : {}) };
      lines.push(line);
      lastBy.set(r.session, { at, total: r.total, agent });
      recorded += 1;
      if (recorded % PRUNE_EVERY === 0 && prune()) {
        chain = chain.then(rewrite);
        return;
      }
      const first = !headerWritten;
      headerWritten = true;
      const text = (first ? `${JSON.stringify({ created: createdAt ?? t })}\n` : '') + JSON.stringify(line) + '\n';
      chain = chain.then(() => appendFile(path, text, { mode: FILE_MODE })).catch((error: unknown) => log.warn('reported cost could not be saved', error));
    },

    window(startMs, dayOf) {
      const agents: Record<string, ReportedAgent> = {};
      const byDay: Record<string, Record<string, number>> = {};
      const before = new Map<string, number>();
      const seen = new Map<string, Set<string>>();
      for (const l of [...lines].sort((a, b) => a.at - b.at)) {
        const was = before.get(l.session);
        // the first line of a session is its own total (0 when it was already running at the start); a lower total, later, is a reset: the new total is the delta
        const delta = was === undefined ? (l.base === true ? 0 : l.total) : l.total >= was ? l.total - was : l.total;
        before.set(l.session, l.total);
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
