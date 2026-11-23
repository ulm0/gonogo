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
import { EFFORTS, MODEL_PATTERN, PERMISSION_MODES, PROVIDERS, providerInfo } from '../shared/protocol.js';
import type { Effort, Logger, ModelDefaults, PermissionMode, Provider } from '../shared/protocol.js';
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
  /** The room's default engine: Claude Code until one is set. */
  engine(): Provider;
  /** The room's default effort for Claude Code, or undefined. */
  effort(): Effort | undefined;
  /** The room's default permission mode, or undefined (default). */
  mode(): PermissionMode | undefined;
  /** Sets the default mode, or clears it with null. A bad mode throws a HubError (bad_request, field `mode`); bypassPermissions needs `confirmBypass: true` (bad_request, field `confirmBypass`). */
  setMode(mode: unknown, confirmBypass?: unknown): Promise<ModelDefaults>;
  /** Sets the default engine (any but `custom`), or clears it with null. A bad one throws a HubError (bad_request, field `engine`). */
  setEngine(engine: unknown): Promise<ModelDefaults>;
  /** Sets the default effort, or clears it with null. A bad level throws a HubError (bad_request, field `effort`). */
  setEffort(effort: unknown): Promise<ModelDefaults>;
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
  let engine: Provider | undefined;
  let effort: Effort | undefined;
  let mode: PermissionMode | undefined;
  /** When bypassPermissions was confirmed as the room default; written with it, read back to accept it. */
  let bypassConfirmedAt: number | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const view = (): ModelDefaults => ({ models: { ...models }, positions: { ...positions }, ...(engine ? { engine } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}) });

  /** Writes what `change` returns, or nothing when it equals what is saved; a failed write leaves the old values. */
  const save = async (change: () => void): Promise<void> => {
    const before = JSON.stringify(view());
    const was = { models, positions, engine, effort, mode, bypassConfirmedAt };
    change();
    if (JSON.stringify(view()) === before) return;
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, ...view(), ...(mode === 'bypassPermissions' && bypassConfirmedAt !== undefined ? { bypassConfirmedAt } : {}) }, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      ({ models, positions, engine, effort, mode, bypassConfirmedAt } = was);
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
        if (typeof saved.engine === 'string' && (PROVIDERS as readonly string[]).includes(saved.engine) && saved.engine !== 'custom') engine = saved.engine as Provider;
        if (typeof saved.effort === 'string' && (EFFORTS as readonly string[]).includes(saved.effort)) effort = saved.effort as Effort;
        // bypassPermissions is read back only with the stamp that setMode writes when a person confirmed it: a planted file must not preselect it
        if (typeof saved.mode === 'string' && saved.mode !== 'default' && (PERMISSION_MODES as readonly string[]).includes(saved.mode) && (saved.mode !== 'bypassPermissions' || typeof saved.bypassConfirmedAt === 'number')) mode = saved.mode as PermissionMode;
        if (mode === 'bypassPermissions') bypassConfirmedAt = saved.bypassConfirmedAt as number;
        if (isRecord(saved.positions)) positions = Object.fromEntries(Object.entries(saved.positions).filter(([id, model]) => POSITION_IDS.includes(id) && typeof model === 'string' && MODEL_RE.test(model))) as Record<string, string>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        log.error(`${MODELS_FILE} could not be read; the room has no default models and the file is kept as ${MODELS_FILE}.bad`, error);
        await rename(path, `${path}.bad`).catch(() => undefined);
      }
    },
    view,
    engine: () => engine ?? 'claude',
    effort: () => effort,
    mode: () => mode,
    async setMode(value, confirmBypass) {
      if (value !== null && value !== undefined && (typeof value !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(value))) throw new HubError('bad_request', `mode must be one of: ${PERMISSION_MODES.join(', ')}, or null`, 'mode');
      if (value === 'bypassPermissions' && confirmBypass !== true) throw new HubError('bad_request', 'bypassPermissions needs confirmBypass: true', 'confirmBypass');
      const run = chain.then(() => save(() => {
        mode = value === null || value === undefined || value === 'default' ? undefined : (value as PermissionMode);
        bypassConfirmedAt = mode === 'bypassPermissions' ? Date.now() : undefined;
      }));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
    async setEngine(value) {
      if (value !== null && value !== undefined && (typeof value !== 'string' || !(PROVIDERS as readonly string[]).includes(value) || value === 'custom')) throw new HubError('bad_request', 'engine must be an engine of the hire form other than a custom command, or null', 'engine');
      const run = chain.then(() => save(() => void (engine = value === null || value === undefined || value === 'claude' ? undefined : (value as Provider))));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
    async setEffort(value) {
      if (value !== null && value !== undefined && (typeof value !== 'string' || !(EFFORTS as readonly string[]).includes(value))) throw new HubError('bad_request', `effort must be one of: ${EFFORTS.join(', ')}, or null`, 'effort');
      const run = chain.then(() => save(() => void (effort = (value ?? undefined) as Effort | undefined)));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
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
        models = next;
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
        positions = next;
      }));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
    close: () => chain.then(() => undefined),
  };
}
