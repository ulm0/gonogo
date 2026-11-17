/**
 * Propellant: token use per agent and for the room, read from Claude Code's own transcripts, kept in a ledger, checked
 * against the Director's limits over rolling windows (docs/redline-propellant-spec.md).
 *
 * A transcript is JSON lines; an assistant line carries `message.usage`, and one reply is written as several lines (one
 * per content block) that repeat the same `message.id` and the same usage, so only the first line of an id counts.
 * Tokens = input + cache creation + output. Cache reads are left out: in a long session they dwarf the rest and would
 * make every limit meaningless.
 *
 * shortcut: subagent (Task tool) transcripts are other files and are not counted; read them too if that spend matters.
 * shortcut: the ledger and the limits are keyed by agent name, so a rename starts from zero; key by record id if renames get common.
 */
import { appendFile, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGENT_NAME_PATTERN, FUEL_WINDOWS } from '../shared/protocol.js';
import type { FuelGauge, FuelLimits, FuelWindow, Logger, PropellantRequest, PropellantView } from '../shared/protocol.js';
import { tokenText } from '../shared/fuel.js';
import { FILE_MODE, FUEL_KEEP_MS, FUEL_LIMIT_MAX, METER_READ_MAX_BYTES, PROPELLANT_FILE as LIMITS_FILE } from './constants.js';

const HOUR = 3_600_000;
export const WINDOW_MS: Record<FuelWindow, number> = { '5h': 5 * HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR };
const LEDGER_FILE = 'fuel.jsonl';
const NAME_RE = new RegExp(AGENT_NAME_PATTERN);

export interface FuelEntry {
  at: number;
  agent: string;
  tokens: number;
}

interface Saved {
  room: FuelLimits;
  agents: Record<string, FuelLimits>;
  /** Transcript path to the byte offset already counted, so a restart of gonogo does not count a turn twice. */
  cursors: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The tokens of one transcript line and its message id, or null for a line without usage. */
export function lineUsage(line: string): { id: string; at: number | null; tokens: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.message.usage)) return null;
  const usage = value.message.usage;
  const id = typeof value.message.id === 'string' ? value.message.id : typeof value.requestId === 'string' ? value.requestId : '';
  if (id === '') return null;
  const n = (key: string): number => {
    const v = usage[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const at = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
  return { id, at: Number.isFinite(at) ? at : null, tokens: n('input_tokens') + n('cache_creation_input_tokens') + n('output_tokens') };
}

/** Limits from untrusted JSON: whole numbers from 1 to FUEL_LIMIT_MAX per known window; anything else is refused. */
export function parseLimits(value: unknown, what: string): FuelLimits | string {
  if (!isRecord(value)) return `${what} must be an object of windows (${FUEL_WINDOWS.join(', ')})`;
  const limits: FuelLimits = {};
  for (const [key, v] of Object.entries(value)) {
    if (!(FUEL_WINDOWS as readonly string[]).includes(key)) return `${what}: unknown window "${key}"`;
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > FUEL_LIMIT_MAX) {
      return `${what}.${key} must be a whole number of tokens from 1 to ${FUEL_LIMIT_MAX}, or null`;
    }
    limits[key as FuelWindow] = v;
  }
  return limits;
}

export function parsePropellantRequest(body: Record<string, unknown>): { ok: true; value: PropellantRequest } | { ok: false; error: string; field: string } {
  const value: PropellantRequest = {};
  for (const key of Object.keys(body)) {
    if (key !== 'room' && key !== 'agents') return { ok: false, error: `unknown field "${key}"`, field: key };
  }
  if (body.room !== undefined) {
    const room = parseLimits(body.room, 'room');
    if (typeof room === 'string') return { ok: false, error: room, field: 'room' };
    value.room = room;
  }
  if (body.agents !== undefined) {
    if (!isRecord(body.agents)) return { ok: false, error: 'agents must be an object of agent names', field: 'agents' };
    value.agents = {};
    for (const [name, raw] of Object.entries(body.agents)) {
      if (!NAME_RE.test(name)) return { ok: false, error: `agents: invalid name "${name}"`, field: 'agents' };
      const limits = parseLimits(raw, `agents.${name}`);
      if (typeof limits === 'string') return { ok: false, error: limits, field: 'agents' };
      value.agents[name] = limits;
    }
  }
  return { ok: true, value };
}

export interface PropellantOptions {
  /** gonogo's home: fuel.jsonl and propellant.json live here. */
  dir: string;
  /** Claude Code's projects folder: only transcripts below it are read. */
  projectsRoot: string;
  now: () => number;
  log: Logger;
}

export interface Propellant {
  load(): Promise<void>;
  /** Counts what the transcript gained since the last read. Resolves with the new tokens (0 when nothing or refused). */
  record(agent: string, transcriptPath: string): Promise<number>;
  view(): PropellantView;
  setLimits(request: PropellantRequest): Promise<PropellantView>;
  /** Why this agent must stop, or null: its own limit first, then the room's. */
  over(agent: string): { scope: 'agent' | 'room'; reason: string } | null;
  close(): Promise<void>;
}

export { tokenText };

export function createPropellant(options: PropellantOptions): Propellant {
  const { dir, now, log } = options;
  const ledgerPath = join(dir, LEDGER_FILE);
  const limitsPath = join(dir, LIMITS_FILE);
  let entries: FuelEntry[] = [];
  let saved: Saved = { room: {}, agents: {}, cursors: {} };
  /** The last message id counted per transcript: the repeated lines of one reply follow each other. */
  const lastId = new Map<string, string>();
  /** One read per transcript at a time, and the ledger and limits file written in order. */
  const reading = new Map<string, Promise<number>>();
  let chain: Promise<unknown> = Promise.resolve();
  let projectsReal: string | null = null;

  const later = (fn: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => log.error('propellant could not write', error));
    return run.then(() => undefined);
  };

  const saveLimits = (): Promise<void> => {
    // a file from before it had a version has none and reads as version 1 (src/server/migrate.ts)
    const json = JSON.stringify({ version: 1, ...saved }, null, 2);
    return later(async () => {
      const tmp = join(dir, `.${LIMITS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: FILE_MODE, flag: 'wx' });
      await rename(tmp, limitsPath);
    });
  };

  const prune = (): boolean => {
    const cut = now() - FUEL_KEEP_MS;
    const before = entries.length;
    entries = entries.filter((e) => e.at >= cut);
    return entries.length !== before;
  };

  const gauge = (agent: string | null, limits: FuelLimits): FuelGauge => {
    const t = now();
    const used = { '5h': 0, day: 0, week: 0, month: 0 } as Record<FuelWindow, number>;
    for (const e of entries) {
      if (agent !== null && e.agent !== agent) continue;
      for (const w of FUEL_WINDOWS) if (t - e.at < WINDOW_MS[w]) used[w] += e.tokens;
    }
    return { used, limits: { ...limits } };
  };

  const firstOver = (g: FuelGauge): FuelWindow | null => {
    for (const w of FUEL_WINDOWS) {
      const limit = g.limits[w];
      if (limit !== undefined && g.used[w] >= limit) return w;
    }
    return null;
  };

  const inside = async (path: string): Promise<string | null> => {
    projectsReal ??= await realpath(options.projectsRoot).catch(() => null);
    if (projectsReal === null || !path.endsWith('.jsonl')) return null;
    const real = await realpath(path).catch(() => null);
    return real !== null && real.startsWith(projectsReal + sep) ? real : null;
  };

  const readNew = async (agent: string, transcriptPath: string): Promise<number> => {
    const path = await inside(transcriptPath);
    if (path === null) {
      log.debug(`propellant ignored a transcript outside ${options.projectsRoot}`);
      return 0;
    }
    const handle = await open(path, 'r');
    let tokens = 0;
    try {
      const size = (await handle.stat()).size;
      let offset = saved.cursors[path] ?? 0;
      if (offset > size) offset = 0; // the file was replaced: count it again from the start
      const length = Math.min(size - offset, METER_READ_MAX_BYTES);
      if (length <= 0) return 0;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (end < 0) return 0; // no complete line yet
      const fresh: FuelEntry[] = [];
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        const usage = lineUsage(line);
        if (usage === null || usage.id === lastId.get(path)) continue;
        lastId.set(path, usage.id);
        if (usage.tokens === 0) continue;
        const at = usage.at ?? now();
        // one ledger line per minute and agent keeps the file small
        const last = fresh[fresh.length - 1];
        if (last && Math.floor(last.at / 60_000) === Math.floor(at / 60_000)) last.tokens += usage.tokens;
        else fresh.push({ at, agent, tokens: usage.tokens });
        tokens += usage.tokens;
      }
      saved.cursors[path] = offset + end + 1;
      const cut = now() - FUEL_KEEP_MS;
      const kept = fresh.filter((e) => e.at >= cut);
      entries.push(...kept);
      if (kept.length > 0) {
        const text = kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await later(() => appendFile(ledgerPath, text, { mode: FILE_MODE }));
      }
      await saveLimits();
    } finally {
      await handle.close();
    }
    return tokens;
  };

  const view = (): PropellantView => {
    prune();
    const agents: Record<string, FuelGauge> = {};
    const names = new Set([...entries.map((e) => e.agent), ...Object.keys(saved.agents)]);
    for (const name of [...names].sort()) agents[name] = gauge(name, saved.agents[name] ?? {});
    return { room: gauge(null, saved.room), agents };
  };

  return {
    async load() {
      try {
        const data: unknown = JSON.parse(await readFile(limitsPath, 'utf8'));
        if (isRecord(data)) {
          const room = parseLimits(data.room ?? {}, 'room');
          if (typeof room !== 'string') saved.room = room;
          if (isRecord(data.agents)) {
            for (const [name, raw] of Object.entries(data.agents)) {
              const limits = parseLimits(raw, name);
              if (NAME_RE.test(name) && typeof limits !== 'string') saved.agents[name] = limits;
            }
          }
          if (isRecord(data.cursors)) {
            for (const [path, n] of Object.entries(data.cursors)) {
              if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) saved.cursors[path] = n;
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${LIMITS_FILE} could not be read; limits start empty`, error);
      }
      let text = '';
      try {
        text = await readFile(ledgerPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`${LEDGER_FILE} could not be read; token use starts at 0`, error);
      }
      for (const line of text.split('\n')) {
        if (line === '') continue;
        try {
          const e: unknown = JSON.parse(line);
          if (isRecord(e) && typeof e.at === 'number' && typeof e.agent === 'string' && typeof e.tokens === 'number' && e.tokens > 0) {
            entries.push({ at: e.at, agent: e.agent, tokens: e.tokens });
          }
        } catch {
          // a torn last line after a crash: skipped
        }
      }
      if (prune()) {
        const kept = entries.map((e) => JSON.stringify(e)).join('\n');
        await later(() => writeFile(ledgerPath, kept === '' ? '' : kept + '\n', { mode: FILE_MODE }));
      }
    },

    record(agent, transcriptPath) {
      const previous = reading.get(transcriptPath) ?? Promise.resolve(0);
      const run = previous
        .catch(() => 0)
        .then(() => readNew(agent, transcriptPath))
        .catch((error: unknown) => {
          log.warn(`propellant could not read the transcript of ${agent}`, error);
          return 0;
        });
      reading.set(transcriptPath, run);
      void run.then(() => {
        if (reading.get(transcriptPath) === run) reading.delete(transcriptPath);
      });
      return run;
    },

    view,

    async setLimits(request) {
      if (request.room !== undefined) saved.room = { ...request.room };
      for (const [name, limits] of Object.entries(request.agents ?? {})) {
        if (Object.keys(limits).length === 0) delete saved.agents[name];
        else saved.agents[name] = { ...limits };
      }
      await saveLimits();
      return view();
    },

    over(agent) {
      const own = gauge(agent, saved.agents[agent] ?? {});
      const ownWindow = firstOver(own);
      if (ownWindow !== null) {
        const limit = own.limits[ownWindow] ?? 0;
        return { scope: 'agent', reason: `out of propellant: ${tokenText(own.used[ownWindow])} of ${tokenText(limit)} tokens in ${ownWindow}` };
      }
      const room = gauge(null, saved.room);
      const roomWindow = firstOver(room);
      if (roomWindow !== null) {
        const limit = room.limits[roomWindow] ?? 0;
        return { scope: 'room', reason: `room out of propellant: ${tokenText(room.used[roomWindow])} of ${tokenText(limit)} tokens in ${roomWindow}` };
      }
      return null;
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
