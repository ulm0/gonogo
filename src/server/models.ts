/**
 * Default models (docs/engine-bay-spec.md): the room's model for each engine that takes one, used at an agent's start when the agent
 * has no `model` of its own. models.json holds `{ version: 1, models: { claude: 'sonnet' } }`; names only, no secret. A model of the
 * agent always wins, and a change applies at the next start of each agent (the launcher asks at every start).
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODEL_PATTERN, PROVIDERS, providerInfo } from '../shared/protocol.js';
import type { Logger, ModelDefaults, Provider } from '../shared/protocol.js';
import { FILE_MODE, MODELS_FILE, nullLogger } from './constants.js';
import { HubError } from './hub.js';

const MODEL_RE = new RegExp(MODEL_PATTERN);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ModelDefaultsStore {
  load(): Promise<void>;
  view(): ModelDefaults;
  /** The room's model for an engine, or undefined. */
  get(provider: Provider): string | undefined;
  /** Sets the model of one engine, or clears it with null (or empty text). A bad engine or name throws a HubError (bad_request, field `provider` or `model`). */
  set(provider: unknown, model: unknown): Promise<ModelDefaults>;
  close(): Promise<void>;
}

export function createModelDefaults(options: { dir: string; log?: Logger }): ModelDefaultsStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, MODELS_FILE);
  let models: Partial<Record<Provider, string>> = {};
  let chain: Promise<unknown> = Promise.resolve();

  const usable = (provider: unknown, model: unknown): boolean =>
    typeof provider === 'string' && (PROVIDERS as readonly string[]).includes(provider) && providerInfo(provider as Provider).model !== null && typeof model === 'string' && MODEL_RE.test(model);

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.models)) throw new Error('not a version 1 models file');
        models = Object.fromEntries(Object.entries(saved.models).filter(([provider, model]) => usable(provider, model))) as Partial<Record<Provider, string>>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        log.error(`${MODELS_FILE} could not be read; the room has no default models and the file is kept as ${MODELS_FILE}.bad`, error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view: () => ({ models: { ...models } }),
    get: (provider) => models[provider],
    async set(provider, model) {
      if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) throw new HubError('bad_request', 'unknown engine', 'provider');
      if (providerInfo(provider as Provider).model === null) throw new HubError('bad_request', `${providerInfo(provider as Provider).label} takes no model setting`, 'provider');
      const name = model === null || model === undefined ? '' : typeof model === 'string' ? model.trim() : null;
      if (name === null) throw new HubError('bad_request', 'model must be text or null', 'model');
      if (name !== '' && !MODEL_RE.test(name)) throw new HubError('bad_request', 'model must be 1 to 100 letters, digits or . _ : / @ + -, starting with a letter or digit', 'model');
      const run = chain.then(async () => {
        const before = models;
        const next = { ...models };
        if (name === '') delete next[provider as Provider];
        else next[provider as Provider] = name;
        if (JSON.stringify(next) === JSON.stringify(before)) return;
        models = next;
        const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ version: 1, models }, null, 2), { flag: 'wx', mode: FILE_MODE });
          await rename(temp, path);
        } catch (error) {
          models = before;
          await rm(temp, { force: true }).catch(() => undefined);
          throw new Error(`could not save the default models: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      chain = run.catch(() => undefined);
      return run.then(() => ({ models: { ...models } }));
    },
    close: () => chain.then(() => undefined),
  };
}
