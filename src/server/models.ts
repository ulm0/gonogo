/**
 * Default models (docs/engine-bay-spec.md): the room's model for each engine that takes one, used at an agent's start when the agent
 * has no `model` of its own. models.json holds `{ version: 1, models: { claude: 'sonnet' }, positions: { reviewer: 'opus' } }`; names only,
 * no secret. A position's model is for a Claude Code agent in that position and wins over the engine's. The agent's own model always
 * wins, and a change applies at the next start of each agent (the launcher asks at every start).
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { POSITION_IDS } from '../shared/positions.js';
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
  /** The model of a position (for Claude Code), or undefined. */
  getPosition(position: string): string | undefined;
  /** What an agent without a model of its own starts with: its position's model (Claude Code only: model names do not carry from one engine to another), else its engine's. */
  resolve(provider: Provider, position?: string): string | undefined;
  /** Sets the model of one position, or clears it with null (or empty text). A bad position or name throws a HubError (bad_request, field `position` or `model`). */
  setPosition(position: unknown, model: unknown): Promise<ModelDefaults>;
  /** Sets the model of one engine, or clears it with null (or empty text). A bad engine or name throws a HubError (bad_request, field `provider` or `model`). */
  set(provider: unknown, model: unknown): Promise<ModelDefaults>;
  close(): Promise<void>;
}

export function createModelDefaults(options: { dir: string; log?: Logger }): ModelDefaultsStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, MODELS_FILE);
  let models: Partial<Record<Provider, string>> = {};
  let positions: Record<string, string> = {};
  let chain: Promise<unknown> = Promise.resolve();

  const view = (): ModelDefaults => ({ models: { ...models }, positions: { ...positions } });

  /** Writes what `change` returns, or nothing when it equals what is saved; a failed write leaves the old values. */
  const save = async (change: () => { models: Partial<Record<Provider, string>>; positions: Record<string, string> }): Promise<void> => {
    const before = { models, positions };
    const next = change();
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    ({ models, positions } = next);
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, models, positions }, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      ({ models, positions } = before);
      await rm(temp, { force: true }).catch(() => undefined);
      throw new Error(`could not save the default models: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const usable = (provider: unknown, model: unknown): boolean =>
    typeof provider === 'string' && (PROVIDERS as readonly string[]).includes(provider) && providerInfo(provider as Provider).model !== null && typeof model === 'string' && MODEL_RE.test(model);

  return {
    async load() {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.models)) throw new Error('not a version 1 models file');
        models = Object.fromEntries(Object.entries(saved.models).filter(([provider, model]) => usable(provider, model))) as Partial<Record<Provider, string>>;
        if (isRecord(saved.positions)) positions = Object.fromEntries(Object.entries(saved.positions).filter(([id, model]) => POSITION_IDS.includes(id) && typeof model === 'string' && MODEL_RE.test(model))) as Record<string, string>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        log.error(`${MODELS_FILE} could not be read; the room has no default models and the file is kept as ${MODELS_FILE}.bad`, error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view,
    get: (provider) => models[provider],
    getPosition: (position) => positions[position],
    resolve: (provider, position) => (provider === 'claude' && position !== undefined ? positions[position] : undefined) ?? models[provider],
    async set(provider, model) {
      if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) throw new HubError('bad_request', 'unknown engine', 'provider');
      if (providerInfo(provider as Provider).model === null) throw new HubError('bad_request', `${providerInfo(provider as Provider).label} takes no model setting`, 'provider');
      const name = model === null || model === undefined ? '' : typeof model === 'string' ? model.trim() : null;
      if (name === null) throw new HubError('bad_request', 'model must be text or null', 'model');
      if (name !== '' && !MODEL_RE.test(name)) throw new HubError('bad_request', 'model must be 1 to 100 letters, digits or . _ : / @ + -, starting with a letter or digit', 'model');
      const run = chain.then(() => save(() => {
        const next = { ...models };
        if (name === '') delete next[provider as Provider];
        else next[provider as Provider] = name;
        return { models: next, positions };
      }));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
    async setPosition(position, model) {
      if (typeof position !== 'string' || !POSITION_IDS.includes(position)) throw new HubError('bad_request', 'unknown position', 'position');
      const name = model === null || model === undefined ? '' : typeof model === 'string' ? model.trim() : null;
      if (name === null) throw new HubError('bad_request', 'model must be text or null', 'model');
      if (name !== '' && !MODEL_RE.test(name)) throw new HubError('bad_request', 'model must be 1 to 100 letters, digits or . _ : / @ + -, starting with a letter or digit', 'model');
      const run = chain.then(() => save(() => {
        const next = { ...positions };
        if (name === '') delete next[position];
        else next[position] = name;
        return { models, positions: next };
      }));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
    close: () => chain.then(() => undefined),
  };
}
