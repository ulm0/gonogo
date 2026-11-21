/**
 * Feature toggles (docs/features-spec.md): which features the Director switched off. `<home>/features.json` `{ version: 1, off: [...] }`
 * (0600, written whole through a temporary file and a rename) holds the off ids and `on`, the ids of the off-by-default features the Director switched on, so a feature added later is on after an upgrade (unless it is off by default)
 * and an id this build does not know is dropped. A file that cannot be read is kept as `.bad` and everything is on.
 *
 * `isOn` is what every gate asks (routes, MCP tools, the hub's and the background work's switches); `plan` and `apply` are the two
 * halves of PUT /api/features: nothing changes until the same plan is asked again with `confirm`.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanOff, DEFAULT_OFF, FEATURES, planFeatures } from '../shared/features.js';
import type { FeaturePlan, PlanContext } from '../shared/features.js';
import type { FeaturesView, Logger } from '../shared/protocol.js';
import { FEATURES_FILE, FILE_MODE, nullLogger } from './constants.js';
import { HubError } from './hub.js';

export interface FeatureStore {
  load(): Promise<void>;
  view(): FeaturesView;
  /** Is it on? An id this build does not know is on. */
  isOn(id: string): boolean;
  /** The label of a feature, for "<label> is off". */
  label(id: string): string;
  /** The plan for `{ off }`, changing nothing. A bad body throws a HubError (bad_request). */
  plan(input: unknown): FeaturePlan;
  /**
   * Applies the plan of `input` (worked out again now) and tells the browsers. `input.expect` is the `off` list of the plan the
   * Director read: when the plan is not that any more (something changed, a poll opened) nothing is applied and it is a conflict.
   */
  apply(input: unknown): Promise<{ plan: FeaturePlan; view: FeaturesView }>;
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function createFeatureStore(options: { dir: string; emit?(view: FeaturesView): void; context?(): PlanContext; changed?(): void; log?: Logger }): FeatureStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, FEATURES_FILE);
  // a feature that is off until switched on is off before the file says anything
  let off = new Set<string>(cleanOff(DEFAULT_OFF));
  let chain: Promise<unknown> = Promise.resolve();
  const view = (): FeaturesView => ({ off: FEATURES.filter((feature) => off.has(feature.id)).map((feature) => feature.id) });

  const asked = (input: unknown): string[] => {
    if (!isRecord(input)) throw new HubError('bad_request', 'request body must be a JSON object');
    for (const key of Object.keys(input)) if (key !== 'off' && key !== 'confirm' && key !== 'expect') throw new HubError('bad_request', `unknown field "${key}"`, key);
    if (!Array.isArray(input.off) || !input.off.every((id) => typeof id === 'string')) throw new HubError('bad_request', 'off must be a list of feature ids', 'off');
    return input.off as string[];
  };

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.off)) throw new Error('not a version 1 features file');
        // closed over `requires`, without the core and the not-switchable ids: a hand-edited file cannot make an inconsistent room
        const ids = (list: unknown): string[] => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []);
        const on = new Set(ids(saved.on));
        off = new Set(cleanOff([...ids(saved.off), ...DEFAULT_OFF.filter((id) => !on.has(id))]));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        // moved aside only when its content is wrong; a file that cannot be read (EACCES, EISDIR) stays where it is
        if (code !== undefined) {
          log.error(`${FEATURES_FILE} could not be read; every feature is on`, error);
          return;
        }
        log.error(`${FEATURES_FILE} could not be read; every feature is on and the file is kept as ${FEATURES_FILE}.bad`, error instanceof SyntaxError ? 'not valid JSON' : error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view,
    isOn: (id) => !off.has(id),
    label: (id) => FEATURES.find((feature) => feature.id === id)?.label ?? id,
    plan: (input) => planFeatures([...off], asked(input), options.context?.()),
    async apply(input) {
      const plan = planFeatures([...off], asked(input), options.context?.());
      const expect = (input as Record<string, unknown>).expect;
      if (!Array.isArray(expect) || !expect.every((id) => typeof id === 'string')) throw new HubError('bad_request', 'expect must be the off list of the plan you read', 'expect');
      if (plan.blocked.length === 0 && [...expect].sort().join() !== [...plan.off].sort().join()) throw new HubError('conflict', 'the plan changed since you read it: read it again', 'expect');
      if (plan.blocked.length > 0) throw new HubError('conflict', plan.blocked.map((b) => b.why).join('; '), 'off');
      const run = chain.then(async () => {
        const before = off;
        const next = new Set(plan.off);
        if ([...next].sort().join() === [...before].sort().join()) return;
        off = next;
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ version: 1, off: view().off, on: DEFAULT_OFF.filter((id) => !off.has(id)) }, null, 2), { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          off = before;
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`could not save the features: ${error instanceof Error ? error.message : String(error)}`);
        }
        options.emit?.(view());
        options.changed?.();
      });
      chain = run.catch(() => undefined);
      await run;
      return { plan, view: view() };
    },
    close: () => chain.then(() => undefined),
  };
}
