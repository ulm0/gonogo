/**
 * The room's Relief setting (docs/relief-spec.md, "Auto"): `relief.json` in the room's home. `manual` (the default, and what every unreadable file reads as) leaves
 * every hire to the Director's GO. `auto` lets a boss's request staff an agent without the wait, inside limits that are all optional and unset by default.
 * Written only through PUT /api/relief/settings (a step-up, scope `full`); no tool of an agent reads or writes it.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { POSITION_IDS } from '../shared/positions.js';
import { MAX_AGENTS, RELIEF_AUTO_MODES } from '../shared/protocol.js';
import type { Logger, ReliefLimits, ReliefSettings } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, RELIEF_FILE } from './constants.js';
import { HubError } from './hub.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (message: string, field: string): HubError => new HubError('bad_request', message, field);

/** Limits from untrusted JSON: only the five known ones; null or absent means unset; anything else is a bad_request (field `limits.<name>`). */
export function readLimits(raw: unknown): ReliefLimits {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw bad('limits is an object', 'limits');
  const out: ReliefLimits = {};
  for (const key of Object.keys(raw)) if (!['maxCrew', 'ratePerHour', 'dailyCrewBudget', 'allowedPositions', 'maxMode'].includes(key)) throw bad(`unknown limit "${key}"`, `limits.${key}`);
  const whole = (value: unknown, name: string, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw bad(`${name} is a whole number from 1 to ${max}, or null for no limit`, `limits.${name}`);
    return value;
  };
  if (raw.maxCrew !== undefined && raw.maxCrew !== null) out.maxCrew = whole(raw.maxCrew, 'maxCrew', MAX_AGENTS);
  if (raw.ratePerHour !== undefined && raw.ratePerHour !== null) out.ratePerHour = whole(raw.ratePerHour, 'ratePerHour', 60);
  if (raw.dailyCrewBudget !== undefined && raw.dailyCrewBudget !== null) {
    const usd = raw.dailyCrewBudget;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0.01 || usd > 100_000 || Math.abs(usd * 100 - Math.round(usd * 100)) > 1e-6) throw bad('dailyCrewBudget is dollars in whole cents from 0.01 to 100000, or null for no limit', 'limits.dailyCrewBudget');
    out.dailyCrewBudget = Math.round(usd * 100) / 100;
  }
  if (raw.allowedPositions !== undefined && raw.allowedPositions !== null) {
    const list = raw.allowedPositions;
    if (!Array.isArray(list) || list.length === 0 || list.length > POSITION_IDS.length || !list.every((p) => typeof p === 'string' && POSITION_IDS.includes(p))) throw bad(`allowedPositions is a list of positions (${POSITION_IDS.join(', ')}), or null for any`, 'limits.allowedPositions');
    out.allowedPositions = [...new Set(list as string[])];
  }
  if (raw.maxMode !== undefined && raw.maxMode !== null) {
    if (typeof raw.maxMode !== 'string' || !(RELIEF_AUTO_MODES as readonly string[]).includes(raw.maxMode)) throw bad(`maxMode is one of ${RELIEF_AUTO_MODES.join(', ')} (never bypassPermissions), or null for the room's default mode`, 'limits.maxMode');
    out.maxMode = raw.maxMode as (typeof RELIEF_AUTO_MODES)[number];
  }
  return out;
}

export interface ReliefSettingsStore {
  load(): Promise<void>;
  view(): ReliefSettings;
  /** `{ mode, limits }`, the whole setting. A bad one throws a HubError (bad_request, with the field). */
  set(input: unknown): Promise<ReliefSettings>;
  /** The reduce-only switch: back to manual, limits kept. */
  manual(): Promise<ReliefSettings>;
  close(): Promise<void>;
}

export function createReliefSettings(options: { dir: string; log?: Logger }): ReliefSettingsStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, RELIEF_FILE);
  let current: ReliefSettings = { mode: 'manual', limits: {} };
  let chain: Promise<unknown> = Promise.resolve();

  const write = async (next: ReliefSettings): Promise<void> => {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, ...next }, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new Error(`could not save the Relief setting: ${error instanceof Error ? error.message : String(error)}`);
    }
    current = next;
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || (saved.mode !== 'manual' && saved.mode !== 'auto')) throw new Error('not a version 1 relief file');
        current = { mode: saved.mode, limits: readLimits(saved.limits) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        // a bad file is manual: no hire without the Director's GO because a file could not be read
        current = { mode: 'manual', limits: {} };
        log.error(`${RELIEF_FILE} could not be read; Relief is manual and the file is kept as ${RELIEF_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view: () => ({ mode: current.mode, limits: { ...current.limits, ...(current.limits.allowedPositions === undefined ? {} : { allowedPositions: [...current.limits.allowedPositions] }) } }),
    async set(input) {
      if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
      for (const key of Object.keys(input)) if (key !== 'mode' && key !== 'limits') throw bad(`unknown field "${key}"`, key);
      if (input.mode !== 'manual' && input.mode !== 'auto') throw bad('mode is manual or auto', 'mode');
      const next: ReliefSettings = { mode: input.mode, limits: readLimits(input.limits) };
      const run = chain.then(() => write(next));
      chain = run.catch(() => undefined);
      await run;
      return this.view();
    },
    async manual() {
      const run = chain.then(() => (current.mode === 'manual' ? undefined : write({ mode: 'manual', limits: current.limits })));
      chain = run.catch(() => undefined);
      await run;
      return this.view();
    },
    close: () => chain.then(() => undefined),
  };
}
