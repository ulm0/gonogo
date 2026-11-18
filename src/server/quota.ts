/**
 * Plan quota (docs/quota-spec.md): the 5-hour and weekly use of the Claude plan, as Claude Code's own status line reports it.
 * A per-agent status-line shim posts only `rate_limits` to /hook/<agent>/StatusLine; the report with the newest time wins (the
 * plan is one pool for every agent). Kept in memory and in quota.json (mode 0600), so a restart shows the last value as stale.
 * Alerts: one Downlink `redline` event per window and threshold (80 and 95 %), armed again only when a window's resets_at moves forward by more than a minute.
 * No automatic trip. gonogo never asks Anthropic for this number.
 *
 * shortcut: the thresholds are fixed at 80 and 95 %, and `rate_limits.spend_limit` (gateway rooms) is not read; add both when a room needs them.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownlinkNotify, Logger, PlanQuota, PlanWindow } from '../shared/protocol.js';
import { FILE_MODE, QUOTA_FILE } from './constants.js';
import { isRecord } from './hooks.js';

/** A report older than this is shown as "last seen N min ago". */
export const QUOTA_STALE_MS = 15 * 60_000;
const THRESHOLDS = [80, 95] as const;
const WINDOWS = ['fiveHour', 'sevenDay'] as const;
type WindowKey = (typeof WINDOWS)[number];
const WIRE: Record<WindowKey, string> = { fiveHour: 'five_hour', sevenDay: 'seven_day' };
const NAME: Record<WindowKey, string> = { fiveHour: 'Plan 5-hour window', sevenDay: 'Plan week' };

/** One window from untrusted JSON: a percentage from 0 to 1000 and a reset in epoch seconds; anything else is no window. */
function windowOf(value: unknown): PlanWindow | null {
  if (!isRecord(value)) return null;
  const pct = value.used_percentage;
  const resets = value.resets_at;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 1000) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0 || resets > 1e11) return null;
  return { pct: Math.round(pct * 10) / 10, resetsAt: Math.round(resets) * 1000 };
}

/** The windows of a status-line body (`{ rate_limits: { five_hour, seven_day } }`); everything else in it is ignored. */
export function parseRateLimits(body: unknown): Partial<Record<WindowKey, PlanWindow>> {
  const limits = isRecord(body) ? body.rate_limits : undefined;
  const out: Partial<Record<WindowKey, PlanWindow>> = {};
  if (!isRecord(limits)) return out;
  for (const key of WINDOWS) {
    const w = windowOf(limits[WIRE[key]]);
    if (w !== null) out[key] = w;
  }
  return out;
}

export interface Quota {
  load(): Promise<void>;
  /** A status-line body of an agent. True when it changed what is shown. */
  report(agent: string, body: unknown): boolean;
  /** The windows still open, or null when none was ever reported. */
  view(): PlanQuota | null;
  close(): Promise<void>;
}

export function createQuota(options: { dir: string; now: () => number; notify?: DownlinkNotify; log: Logger }): Quota {
  const { now, log } = options;
  const path = join(options.dir, QUOTA_FILE);
  let state: { windows: Partial<Record<WindowKey, PlanWindow>>; at: number; source: string } | null = null;
  /** `window|threshold` to the `resetsAt` of the window it was told for: told again only when a window with a later reset reaches it. */
  const told = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();

  const open = (): Partial<Record<WindowKey, PlanWindow>> => {
    const out: Partial<Record<WindowKey, PlanWindow>> = {};
    for (const key of WINDOWS) {
      const w = state?.windows[key];
      if (w !== undefined && w.resetsAt > now()) out[key] = w;
    }
    return out;
  };

  const save = (): void => {
    const json = JSON.stringify({ version: 1, ...state }, null, 2);
    chain = chain
      .then(async () => {
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, json, { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      })
      .catch((error: unknown) => log.warn('quota could not be saved', error));
  };

  const hoursText = (ms: number): string => {
    const m = Math.max(1, Math.round(ms / 60_000));
    if (m < 60) return `${m} min`;
    if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
    return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  };

  /** The tell for each window and threshold crossed, once; a threshold is told again only for a window whose reset moved forward, so a percentage that dips and rises is one alert. quiet: remember only. */
  const alert = (quiet: boolean): void => {
    const current = open();
    for (const key of WINDOWS) {
      const w = current[key];
      if (w === undefined) continue;
      // one event per crossing: when 95 % arrives at once, it is told once, not as 80 and 95
      let fresh = false;
      for (const threshold of THRESHOLDS) {
        const id = `${key}|${threshold}`;
        const was = told.get(id);
        if (w.pct < threshold || (was !== undefined && w.resetsAt <= was + 60_000)) continue;
        told.set(id, w.resetsAt);
        fresh = true;
      }
      if (fresh && !quiet) options.notify?.('redline', `${NAME[key]} is at ${Math.floor(w.pct)} %, resets in ${hoursText(w.resetsAt - now())}`);
    }
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (isRecord(saved) && saved.version === 1 && isRecord(saved.windows) && typeof saved.at === 'number' && typeof saved.source === 'string') {
          const windows: Partial<Record<WindowKey, PlanWindow>> = {};
          for (const key of WINDOWS) {
            const w = windowOf({ used_percentage: isRecord(saved.windows[key]) ? saved.windows[key].pct : null, resets_at: isRecord(saved.windows[key]) ? Number(saved.windows[key].resetsAt) / 1000 : null });
            if (w !== null) windows[key] = w;
          }
          state = { windows, at: saved.at, source: saved.source.slice(0, 64) };
          alert(true);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${QUOTA_FILE} could not be read; the plan quota starts empty`, error);
      }
    },

    report(agent, body) {
      const fresh = parseRateLimits(body);
      if (Object.keys(fresh).length === 0) return false;
      // a window the report lacks stays while it is open: Claude Code sends each window only when it has one
      const windows = { ...open(), ...fresh };
      if (state !== null && JSON.stringify(windows) === JSON.stringify(state.windows)) {
        state = { ...state, at: now(), source: agent };
        return false;
      }
      state = { windows, at: now(), source: agent };
      save();
      alert(false);
      return true;
    },

    view() {
      if (state === null) return null;
      const windows = open();
      if (Object.keys(windows).length === 0) return null;
      return { ...windows, at: state.at, source: state.source, stale: now() - state.at > QUOTA_STALE_MS };
    },

    close: () => chain.then(() => undefined),
  };
}
