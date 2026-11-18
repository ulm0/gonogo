/**
 * Propellant: token use per agent and for the room, read from Claude Code's own transcripts, kept in a ledger, checked
 * against the Director's limits over rolling windows (docs/redline-propellant-spec.md).
 *
 * A transcript is JSON lines; an assistant line carries `message.usage`, and one reply is written as several lines (one
 * per content block) that repeat the same `message.id` and the same usage, so only the first line of an id counts.
 * Tokens = input + cache creation + output. Cache reads are left out: in a long session they dwarf the rest and would
 * make every limit meaningless. The ledger also keeps the split per model (i, cw, o, cr) so the use can be priced when the view
 * is built (docs/cost-spec.md); an old line without a model counts for tokens and shows as unpriced.
 *
 * shortcut: subagent (Task tool) transcripts are other files and are not counted; read them too if that spend matters.
 * shortcut: the ledger and the limits are keyed by agent name, so a rename starts from zero; key by record id if renames get common.
 */
import { appendFile, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGENT_NAME_PATTERN, FUEL_WINDOWS } from '../shared/protocol.js';
import type {
  Budget,
  CostGauge,
  CostView,
  DayCost,
  DownlinkNotify,
  FuelGauge,
  FuelLimits,
  FuelWindow,
  Logger,
  PropellantRequest,
  PropellantView,
} from '../shared/protocol.js';
import { moneyText, costOf, mergePrices, priceFor } from '../shared/prices.js';
import type { ModelPrice, TokenSplit } from '../shared/prices.js';
import { tokenText } from '../shared/fuel.js';
import { BUDGET_MAX_USD, FILE_MODE, FUEL_KEEP_MS, FUEL_LIMIT_MAX, METER_READ_MAX_BYTES, PROPELLANT_FILE as LIMITS_FILE } from './constants.js';

const HOUR = 3_600_000;
export const WINDOW_MS: Record<FuelWindow, number> = { '5h': 5 * HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR };
const LEDGER_FILE = 'fuel.jsonl';
const NAME_RE = new RegExp(AGENT_NAME_PATTERN);

/** One ledger line: tokens (input + cache write + output) and, from the new shape on, the model and the split. */
export interface FuelEntry {
  at: number;
  agent: string;
  tokens: number;
  model?: string;
  i?: number;
  cw?: number;
  o?: number;
  cr?: number;
}

/** Dollar budgets per window, and the share of a budget at which Downlink is told. */
const WARN_AT = 0.8;
const DAYS_SHOWN = 14;
const WINDOW_LABEL: Record<FuelWindow, string> = { '5h': '5 h', day: '24 h', week: '7 d', month: '30 d' };
const WINDOW_NAME: Record<FuelWindow, string> = { '5h': '5-hour', day: 'day', week: 'week', month: 'month' };

interface Saved {
  room: FuelLimits;
  agents: Record<string, FuelLimits>;
  budget: { room: Budget; agents: Record<string, Budget> };
  /** Transcript path to the byte offset already counted, so a restart of gonogo does not count a turn twice. */
  cursors: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The tokens of one transcript line, its model and its split, and its message id, or null for a line without usage. */
export function lineUsage(line: string): { id: string; at: number | null; tokens: number; model: string | null; split: TokenSplit } | null {
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
  const split: TokenSplit = { i: n('input_tokens'), cw: n('cache_creation_input_tokens'), o: n('output_tokens'), cr: n('cache_read_input_tokens') };
  const model = typeof value.message.model === 'string' && value.message.model !== '' ? value.message.model.slice(0, 120) : null;
  return { id, at: Number.isFinite(at) ? at : null, tokens: split.i + split.cw + split.o, model, split };
}

/** Budgets from untrusted JSON: dollars in whole cents from 0.01 to BUDGET_MAX_USD per known window, or null; anything else is refused. */
export function parseBudget(value: unknown, what: string): Budget | string {
  if (!isRecord(value)) return `${what} must be an object of windows (${FUEL_WINDOWS.join(', ')})`;
  const budget: Budget = {};
  for (const [key, v] of Object.entries(value)) {
    if (!(FUEL_WINDOWS as readonly string[]).includes(key)) return `${what}: unknown window "${key}"`;
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.01 || v > BUDGET_MAX_USD || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) {
      return `${what}.${key} must be dollars in whole cents from 0.01 to ${BUDGET_MAX_USD}, or null`;
    }
    budget[key as FuelWindow] = Math.round(v * 100) / 100;
  }
  return budget;
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
    if (key !== 'room' && key !== 'agents' && key !== 'budget') return { ok: false, error: `unknown field "${key}"`, field: key };
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
  if (body.budget !== undefined) {
    if (!isRecord(body.budget)) return { ok: false, error: 'budget must be an object with room and agents', field: 'budget' };
    for (const key of Object.keys(body.budget)) {
      if (key !== 'room' && key !== 'agents') return { ok: false, error: `budget: unknown field "${key}"`, field: 'budget' };
    }
    const budget: NonNullable<PropellantRequest['budget']> = {};
    if (body.budget.room !== undefined) {
      const room = parseBudget(body.budget.room, 'budget.room');
      if (typeof room === 'string') return { ok: false, error: room, field: 'budget' };
      budget.room = room;
    }
    if (body.budget.agents !== undefined) {
      if (!isRecord(body.budget.agents)) return { ok: false, error: 'budget.agents must be an object of agent names', field: 'budget' };
      budget.agents = {};
      for (const [name, raw] of Object.entries(body.budget.agents)) {
        if (!NAME_RE.test(name)) return { ok: false, error: `budget.agents: invalid name "${name}"`, field: 'budget' };
        const b = parseBudget(raw, `budget.agents.${name}`);
        if (typeof b === 'string') return { ok: false, error: b, field: 'budget' };
        budget.agents[name] = b;
      }
    }
    value.budget = budget;
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
  /** The price table (defaults and the owner's rows). Without it the list prices are used. */
  prices?: () => Record<string, ModelPrice>;
  /** Downlink: a budget has reached 80 %. */
  notify?: DownlinkNotify;
}

export interface Propellant {
  load(): Promise<void>;
  /** Counts what the transcript gained since the last read. Resolves with the new tokens (0 when nothing or refused). */
  record(agent: string, transcriptPath: string): Promise<number>;
  view(): PropellantView;
  setLimits(request: PropellantRequest): Promise<PropellantView>;
  /** Replaces the dollar budget of each scope given ({} clears it); posts the 80 % warning when a new budget is already past it. */
  setBudget(budget: NonNullable<PropellantRequest['budget']>): Promise<PropellantView>;
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
  const saved: Saved = { room: {}, agents: {}, budget: { room: {}, agents: {} }, cursors: {} };
  const priceTable = options.prices ?? ((): Record<string, ModelPrice> => mergePrices());
  /** Scopes (agent or room, and window) that already told Downlink they are at 80 %; cleared when the window drops below it. */
  const warned = new Set<string>();
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
    const json = JSON.stringify({ version: 1, ...saved, budget: saved.budget }, null, 2);
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

  /** Dollars and unpriced tokens of one ledger line at the current prices. */
  const priced = (e: FuelEntry, table: Record<string, ModelPrice>): { usd: number; unpriced: number } => {
    const price = e.model === undefined ? null : priceFor(table, e.model);
    if (price === null) return { usd: 0, unpriced: e.tokens };
    return { usd: costOf({ i: e.i ?? 0, cw: e.cw ?? 0, o: e.o ?? 0, cr: e.cr ?? 0 }, price), unpriced: 0 };
  };

  const costGauge = (agent: string | null, budget: Budget, table: Record<string, ModelPrice>): CostGauge => {
    const t = now();
    const usd = { '5h': 0, day: 0, week: 0, month: 0 } as Record<FuelWindow, number>;
    const unpriced = { '5h': 0, day: 0, week: 0, month: 0 } as Record<FuelWindow, number>;
    for (const e of entries) {
      if (agent !== null && e.agent !== agent) continue;
      const p = priced(e, table);
      for (const w of FUEL_WINDOWS) {
        if (t - e.at >= WINDOW_MS[w]) continue;
        usd[w] += p.usd;
        unpriced[w] += p.unpriced;
      }
    }
    return { usd, unpriced, budget: { ...budget } };
  };

  const dayKey = (at: number): string => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /** The last DAYS_SHOWN local calendar days, oldest first, each with its dollars per agent. */
  const days = (table: Record<string, ModelPrice>): DayCost[] => {
    const out = new Map<string, DayCost>();
    const today = new Date(now());
    for (let k = DAYS_SHOWN - 1; k >= 0; k--) {
      const date = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - k, 12).getTime());
      out.set(date, { date, usd: 0, unpriced: 0, byAgent: {} });
    }
    for (const e of entries) {
      const day = out.get(dayKey(e.at));
      if (day === undefined) continue;
      const p = priced(e, table);
      day.usd += p.usd;
      day.unpriced += p.unpriced;
      if (p.usd > 0) day.byAgent[e.agent] = (day.byAgent[e.agent] ?? 0) + p.usd;
    }
    return [...out.values()];
  };

  const costView = (): CostView => {
    const table = priceTable();
    const agents: Record<string, CostGauge> = {};
    const names = new Set([...entries.map((e) => e.agent), ...Object.keys(saved.agents), ...Object.keys(saved.budget.agents)]);
    for (const name of [...names].sort()) agents[name] = costGauge(name, saved.budget.agents[name] ?? {}, table);
    const modelled = entries.filter((e) => e.model !== undefined).map((e) => e.at);
    return {
      room: costGauge(null, saved.budget.room, table),
      agents,
      days: days(table),
      pricedSince: modelled.length === 0 ? null : Math.min(...modelled),
    };
  };

  /** The first window whose spend has reached its budget, with the numbers for the reason text. */
  const budgetOver = (g: CostGauge): { window: FuelWindow; spent: number; limit: number } | null => {
    for (const w of FUEL_WINDOWS) {
      const limit = g.budget[w];
      if (limit !== undefined && g.usd[w] >= limit) return { window: w, spent: g.usd[w], limit };
    }
    return null;
  };

  /** Every scope with a budget and its share spent per window. */
  const shares = (): { key: string; who: string; window: FuelWindow; share: number }[] => {
    const table = priceTable();
    const out: { key: string; who: string; window: FuelWindow; share: number }[] = [];
    const scopes: [string, string, CostGauge][] = [['room', 'the room', costGauge(null, saved.budget.room, table)]];
    for (const name of Object.keys(saved.budget.agents)) scopes.push([`agent:${name}`, name, costGauge(name, saved.budget.agents[name] ?? {}, table)]);
    for (const [scope, who, g] of scopes) {
      for (const w of FUEL_WINDOWS) {
        const limit = g.budget[w];
        if (limit !== undefined) out.push({ key: `${scope}|${w}`, who, window: w, share: g.usd[w] / limit });
      }
    }
    return out;
  };

  /** Drops the warning of a scope that fell below 80 % so it can warn again. */
  const rearm = (): void => {
    if (warned.size === 0) return;
    const live = new Map(shares().map((x) => [x.key, x.share]));
    for (const key of [...warned]) if ((live.get(key) ?? 0) < WARN_AT) warned.delete(key);
  };

  /** One Downlink event per scope and window when a budget reaches 80 %, until it drops below again. quiet: remember only. */
  const warn = (quiet: boolean): void => {
    rearm();
    for (const x of shares()) {
      if (x.share < WARN_AT || warned.has(x.key)) continue;
      warned.add(x.key);
      if (!quiet) options.notify?.('redline', `${x.who} is at ${Math.floor(x.share * 100)} % of its ${WINDOW_NAME[x.window]} budget`);
    }
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
      const byKey = new Map<string, FuelEntry>();
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        const usage = lineUsage(line);
        if (usage === null || usage.id === lastId.get(path)) continue;
        lastId.set(path, usage.id);
        const { split } = usage;
        if (usage.tokens === 0 && split.cr === 0) continue;
        const at = usage.at ?? now();
        // one ledger line per minute, agent and model keeps the file small
        const key = `${Math.floor(at / 60_000)}|${usage.model ?? ''}`;
        const last = byKey.get(key);
        if (last) {
          last.tokens += usage.tokens;
          last.i = (last.i ?? 0) + split.i;
          last.cw = (last.cw ?? 0) + split.cw;
          last.o = (last.o ?? 0) + split.o;
          last.cr = (last.cr ?? 0) + split.cr;
        } else {
          const entry: FuelEntry = usage.model === null ? { at, agent, tokens: usage.tokens } : { at, agent, model: usage.model, i: split.i, cw: split.cw, o: split.o, cr: split.cr, tokens: usage.tokens };
          byKey.set(key, entry);
          fresh.push(entry);
        }
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
      warn(false);
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
    rearm();
    return { room: gauge(null, saved.room), agents, cost: costView() };
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
          if (isRecord(data.budget)) {
            const room = parseBudget(data.budget.room ?? {}, 'budget.room');
            if (typeof room !== 'string') saved.budget.room = room;
            if (isRecord(data.budget.agents)) {
              for (const [name, raw] of Object.entries(data.budget.agents)) {
                const b = parseBudget(raw, name);
                if (NAME_RE.test(name) && typeof b !== 'string') saved.budget.agents[name] = b;
              }
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
          if (!isRecord(e) || typeof e.at !== 'number' || typeof e.agent !== 'string' || typeof e.tokens !== 'number') continue;
          const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
          if (typeof e.model === 'string' && e.model !== '') {
            const entry: FuelEntry = { at: e.at, agent: e.agent, tokens: count(e.tokens), model: e.model, i: count(e.i), cw: count(e.cw), o: count(e.o), cr: count(e.cr) };
            if (entry.tokens > 0 || (entry.cr ?? 0) > 0) entries.push(entry);
          } else if (e.tokens > 0) {
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
      // what is already past 80 % at start was told before: remember it, do not tell again
      warn(true);
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

    async setBudget(budget) {
      if (budget.room !== undefined) saved.budget.room = { ...budget.room };
      for (const [name, b] of Object.entries(budget.agents ?? {})) {
        if (Object.keys(b).length === 0) delete saved.budget.agents[name];
        else saved.budget.agents[name] = { ...b };
      }
      await saveLimits();
      warn(false);
      return view();
    },

    over(agent) {
      const own = gauge(agent, saved.agents[agent] ?? {});
      const ownWindow = firstOver(own);
      if (ownWindow !== null) {
        const limit = own.limits[ownWindow] ?? 0;
        return { scope: 'agent', reason: `out of propellant: ${tokenText(own.used[ownWindow])} of ${tokenText(limit)} tokens in ${ownWindow}` };
      }
      const table = priceTable();
      const ownCost = budgetOver(costGauge(agent, saved.budget.agents[agent] ?? {}, table));
      if (ownCost !== null) {
        return { scope: 'agent', reason: `out of propellant: ${agent} spent ${moneyText(ownCost.spent)} of ${moneyText(ownCost.limit)} in ${WINDOW_LABEL[ownCost.window]}` };
      }
      const room = gauge(null, saved.room);
      const roomWindow = firstOver(room);
      if (roomWindow !== null) {
        const limit = room.limits[roomWindow] ?? 0;
        return { scope: 'room', reason: `room out of propellant: ${tokenText(room.used[roomWindow])} of ${tokenText(limit)} tokens in ${roomWindow}` };
      }
      const roomCost = budgetOver(costGauge(null, saved.budget.room, table));
      if (roomCost !== null) {
        return { scope: 'room', reason: `room out of propellant: the room spent ${moneyText(roomCost.spent)} of ${moneyText(roomCost.limit)} in ${WINDOW_LABEL[roomCost.window]}` };
      }
      return null;
    },

    close() {
      return chain.then(() => undefined);
    },
  };
}
