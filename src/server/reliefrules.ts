/**
 * The rules of the room for the boss's hires (docs/hire-fire-spec.md): `relief.json` in the room's home, 0600, `version: 1`.
 * Written only through PUT /api/relief/rules (a step-up, scope `full`) and the STOP CREW key; no tool of an agent reads or writes it.
 * A missing or bad file reads as the defaults (autoApprove off). The server keeps in MEMORY the record written by the last API change and compares the file
 * with it on every read and on a timer: a hand edit (an agent that can write the file) turns autoApprove off, renames the file `.bad` and raises the alarm.
 * Never compared with a hash kept beside the file (whoever can rewrite the file could rewrite that too).
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { POSITION_IDS } from '../shared/positions.js';
import { MAX_AGENTS, MODEL_PATTERN, PROVIDERS, RELIEF_MODES, RELIEF_RULES_DEFAULT } from '../shared/protocol.js';
import type { Logger, Provider, ReliefRules } from '../shared/protocol.js';
import { FILE_MODE, nullLogger, RELIEF_FILE } from './constants.js';
import { HubError } from './hub.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (message: string, field: string): HubError => new HubError('bad_request', message, field);
const FIELDS = Object.keys(RELIEF_RULES_DEFAULT);
const MODE_RANK: readonly string[] = RELIEF_MODES;
/** The ranks of the modes a rule can grant: default < acceptEdits < auto. */
export const modeRank = (mode: string): number => MODE_RANK.indexOf(mode);

/** The rules from untrusted JSON, every field checked: only the known fields, each of its own kind. `base` is what an absent field keeps. A bad one throws a bad_request (field `rules.<name>`). */
export function readRules(raw: unknown, base: ReliefRules = RELIEF_RULES_DEFAULT, budgetEnforced = false): ReliefRules {
  if (!isRecord(raw)) throw bad('the rules are an object', 'rules');
  for (const key of Object.keys(raw)) if (!FIELDS.includes(key)) throw bad(`unknown rule "${key}"`, `rules.${key}`);
  const out: ReliefRules = { ...base, positions: [...base.positions], engines: [...base.engines], models: { ...base.models } };
  const whole = (value: unknown, name: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(`${name} is a whole number from ${min} to ${max}`, `rules.${name}`);
    return value;
  };
  const flag = (value: unknown, name: string): boolean => {
    if (typeof value !== 'boolean') throw bad(`${name} is true or false`, `rules.${name}`);
    return value;
  };
  if (raw.autoApprove !== undefined) out.autoApprove = flag(raw.autoApprove, 'autoApprove');
  if (raw.autoOnHost !== undefined) out.autoOnHost = flag(raw.autoOnHost, 'autoOnHost');
  if (raw.mayStop !== undefined) out.mayStop = flag(raw.mayStop, 'mayStop');
  if (raw.maxCrew !== undefined) out.maxCrew = whole(raw.maxCrew, 'maxCrew', 1, MAX_AGENTS);
  if (raw.ratePerHour !== undefined) out.ratePerHour = whole(raw.ratePerHour, 'ratePerHour', 1, 60);
  if (raw.crewBudgetUsd !== undefined) {
    const usd = raw.crewBudgetUsd;
    if (usd === null) out.crewBudgetUsd = null;
    else if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0.01 || usd > 100_000 || Math.abs(usd * 100 - Math.round(usd * 100)) > 1e-6) throw bad('crewBudgetUsd is dollars in whole cents from 0.01 to 100000', 'rules.crewBudgetUsd');
    else out.crewBudgetUsd = Math.round(usd * 100) / 100;
  }
  if (raw.positions !== undefined) {
    const list = raw.positions;
    if (!Array.isArray(list) || list.length > POSITION_IDS.length || !list.every((p) => typeof p === 'string' && POSITION_IDS.includes(p))) throw bad(`positions is a list of positions (${POSITION_IDS.join(', ')})`, 'rules.positions');
    out.positions = [...new Set(list as string[])];
  }
  if (raw.engines !== undefined) {
    const list = raw.engines;
    if (!Array.isArray(list) || !list.every((p) => typeof p === 'string' && (PROVIDERS as readonly string[]).includes(p) && p !== 'custom')) throw bad(`engines is a list of ${PROVIDERS.filter((p) => p !== 'custom').join(', ')} (never a custom command)`, 'rules.engines');
    out.engines = [...new Set(list as Provider[])];
  }
  if (raw.models !== undefined) {
    const given = raw.models;
    if (!isRecord(given)) throw bad('models is an object: an engine and the list of model names it may use', 'rules.models');
    const models: Partial<Record<Provider, string[]>> = {};
    for (const [engine, list] of Object.entries(given)) {
      if (!(PROVIDERS as readonly string[]).includes(engine) || engine === 'custom') throw bad(`models names the engine "${engine}", which is not one a rule can hire`, 'rules.models');
      if (!Array.isArray(list) || list.length > 20 || !list.every((m) => typeof m === 'string' && new RegExp(MODEL_PATTERN).test(m))) throw bad(`the models of ${engine} are a list of at most 20 model names`, 'rules.models');
      if (list.length > 0) models[engine as Provider] = [...new Set(list as string[])];
    }
    out.models = models;
  }
  if (raw.maxMode !== undefined) {
    if (typeof raw.maxMode !== 'string' || !MODE_RANK.includes(raw.maxMode)) throw bad(`maxMode is one of ${RELIEF_MODES.join(', ')} (bypassPermissions is not a choice)`, 'rules.maxMode');
    out.maxMode = raw.maxMode as ReliefRules['maxMode'];
  }
  // shortcut: the crew budget is stored but not enforced until the hold of PR3; automatic approval without a ceiling on spend is refused until then (PR3 passes budgetEnforced)
  if (out.autoApprove && !budgetEnforced) throw bad('automatic approval is not available yet: the crew budget is not enforced yet', 'rules.autoApprove');
  if (out.autoApprove && out.crewBudgetUsd === null) throw bad('crewBudgetUsd is needed when autoApprove is on: the dollars per day the boss-hired crew may spend', 'rules.crewBudgetUsd');
  return out;
}

/** Does `next` give the boss more than `now` does? Only that needs the Director's step-up (lowering a rule never does). */
export function raisesPower(now: ReliefRules, next: ReliefRules): boolean {
  const more = (a: readonly unknown[], b: readonly unknown[]): boolean => b.some((x) => !a.includes(x));
  return (
    (!now.autoApprove && next.autoApprove) ||
    (!now.autoOnHost && next.autoOnHost) ||
    (!now.mayStop && next.mayStop) ||
    next.maxCrew > now.maxCrew ||
    next.ratePerHour > now.ratePerHour ||
    (next.crewBudgetUsd !== null && (now.crewBudgetUsd === null || next.crewBudgetUsd > now.crewBudgetUsd)) ||
    modeRank(next.maxMode) > modeRank(now.maxMode) ||
    more(now.positions, next.positions) ||
    more(now.engines, next.engines) ||
    Object.entries(next.models).some(([engine, list]) => more(now.models[engine as Provider] ?? [], list))
  );
}

export interface ReliefRulesStore {
  load(): Promise<void>;
  /** The rules in force. Compares the file with the last record this process wrote first (see the header): a mismatch is a tamper. */
  view(): ReliefRules;
  /** The Director's change: `body` holds the fields that change, the others stay. Returns whether it raised the boss's power (the caller asked for a step-up before). */
  set(body: unknown): Promise<ReliefRules>;
  /** STOP CREW's half: autoApprove off, nothing else changes. */
  off(): Promise<ReliefRules>;
  /** The timer's check of the file against the record (also done by view()). */
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createReliefRules(options: { dir: string; log?: Logger; alarm?: (text: string) => void; /** True once the crew budget is enforced (docs/hire-fire-spec.md, PR3): until then autoApprove cannot be turned on. */ budgetEnforced?: boolean }): ReliefRulesStore {
  const enforced = options.budgetEnforced === true;
  const log = options.log ?? nullLogger;
  const path = join(options.dir, RELIEF_FILE);
  let current: ReliefRules = { ...RELIEF_RULES_DEFAULT };
  /** What this process wrote last, as text: the file must say the same. */
  let record: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const text = (rules: ReliefRules): string => JSON.stringify({ version: 1, ...rules }, null, 2);

  const write = async (next: ReliefRules): Promise<void> => {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, text(next), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new Error(`could not save the Relief rules: ${error instanceof Error ? error.message : String(error)}`);
    }
    current = next;
    record = text(next);
  };

  /** Reads the file. A file nobody of ours wrote (none yet, or a hand edit) is a tamper only when this process wrote one before. */
  const compare = async (): Promise<void> => {
    let file: string | null = null;
    try {
      file = await readFile(path, 'utf8');
    } catch {
      file = null;
    }
    if (record === null || file === record) return;
    // the file is not what the last change wrote: autoApprove off, the file kept aside, the Director told
    log.warn('relief.json was changed outside gonogo: autoApprove is off');
    current = { ...current, autoApprove: false };
    if (file !== null) await rename(path, `${path}.bad`).catch(() => undefined);
    await write(current).catch((error: unknown) => log.error('could not restore relief.json', error));
    options.alarm?.('relief.json was changed outside gonogo: automatic hires are off. Look at relief.json.bad, then set the rules again.');
  };
  const queue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  };

  const copy = (): ReliefRules => ({ ...current, positions: [...current.positions], engines: [...current.engines], models: Object.fromEntries(Object.entries(current.models).map(([k, v]) => [k, [...(v ?? [])]])) });

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1) throw new Error('not a version 1 relief file');
        const { version: _version, ...rest } = saved;
        current = readRules(rest, RELIEF_RULES_DEFAULT, enforced);
        record = text(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('relief.json is unreadable: the defaults apply (every hire waits for a GO)', error);
        current = { ...RELIEF_RULES_DEFAULT };
        record = null;
      }
    },
    // the file is read by the timer and before each decision (check); view() is the cheap copy
    view: copy,
    check: () => queue(compare),
    set: (body) =>
      queue(async () => {
        await compare();
        const next = readRules(body, current, enforced);
        await write(next);
        return copy();
      }),
    off: () =>
      queue(async () => {
        await compare();
        await write({ ...current, autoApprove: false });
        return copy();
      }),
    async close() {
      await chain.catch(() => undefined);
    },
  };
}
