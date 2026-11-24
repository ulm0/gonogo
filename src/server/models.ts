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
import { CLEAN_ROOM_FLAVORS, EFFORTS, MODEL_PATTERN, modelFormProblem, PERMISSION_MODES, PROVIDERS, providerInfo } from '../shared/protocol.js';
import type { CleanRoomFlavor, Effort, Logger, ModelDefaults, PermissionMode, Provider } from '../shared/protocol.js';
import { FILE_MODE, MODELS_FILE, nullLogger } from './constants.js';
import { HubError } from './hub.js';

const MODEL_RE = new RegExp(MODEL_PATTERN);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ModelDefaultsStore {
  load(): Promise<void>;
  view(): ModelDefaults;
  /** The room's model for an engine, or undefined. */
  get(provider: Provider): string | undefined;
  /** The model of a position for an engine (Claude Code when none is named), or undefined. */
  getPosition(position: string, provider?: Provider): string | undefined;
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
  /** The room's default Clean Room sandbox flavor, or undefined (docker). */
  sandbox(): CleanRoomFlavor | undefined;
  /** Sets the default flavor, or clears it with null. A bad one throws a HubError (bad_request, field `sandbox`). Whether Docker has its runtime is the caller's check. */
  setSandbox(flavor: unknown): Promise<ModelDefaults>;
  /** Sets the default engine (any but `custom`), or clears it with null. A bad one throws a HubError (bad_request, field `engine`). */
  setEngine(engine: unknown): Promise<ModelDefaults>;
  /** Sets the default effort, or clears it with null. A bad level throws a HubError (bad_request, field `effort`). */
  setEffort(effort: unknown): Promise<ModelDefaults>;
  /** Sets the model of one position for one engine (Claude Code when none is named), or clears it with null (or empty text). A bad position, engine or name throws a HubError (bad_request, field `position`, `provider` or `model`). */
  setPosition(position: unknown, model: unknown, provider?: unknown): Promise<ModelDefaults>;
  /** Sets the model of one engine, or clears it with null (or empty text). A bad engine or name throws a HubError (bad_request, field `provider` or `model`). */
  set(provider: unknown, model: unknown): Promise<ModelDefaults>;
  close(): Promise<void>;
}

export function createModelDefaults(options: { dir: string; log?: Logger }): ModelDefaultsStore {
  const log = options.log ?? nullLogger;
  const path = join(options.dir, MODELS_FILE);
  let models: Partial<Record<Provider, string>> = {};
  let positions: Record<string, string> = {};
  /** The position models of every engine but Claude Code (whose are `positions`, as before). */
  let enginePositions: Partial<Record<Provider, Record<string, string>>> = {};
  let engine: Provider | undefined;
  let effort: Effort | undefined;
  let mode: PermissionMode | undefined;
  /** When bypassPermissions was confirmed as the room default; written with it, read back to accept it. */
  let bypassConfirmedAt: number | undefined;
  let sandbox: CleanRoomFlavor | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const view = (): ModelDefaults => ({ models: { ...models }, positions: { ...positions }, ...(Object.keys(enginePositions).length > 0 ? { enginePositions: Object.fromEntries(Object.entries(enginePositions).map(([p, map]) => [p, { ...map }])) } : {}), ...(engine ? { engine } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}), ...(sandbox ? { sandbox } : {}) });

  /** Writes what `change` returns, or nothing when it equals what is saved; a failed write leaves the old values. */
  const save = async (change: () => void): Promise<void> => {
    const before = JSON.stringify(view());
    const was = { models, positions, enginePositions, engine, effort, mode, bypassConfirmedAt, sandbox };
    change();
    if (JSON.stringify(view()) === before) return;
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, ...view(), ...(mode === 'bypassPermissions' && bypassConfirmedAt !== undefined ? { bypassConfirmedAt } : {}) }, null, 2), { flag: 'wx', mode: FILE_MODE });
      await rename(temp, path);
    } catch (error) {
      ({ models, positions, enginePositions, engine, effort, mode, bypassConfirmedAt, sandbox } = was);
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
        if (typeof saved.sandbox === 'string' && saved.sandbox !== 'docker' && (CLEAN_ROOM_FLAVORS as readonly string[]).includes(saved.sandbox)) sandbox = saved.sandbox as CleanRoomFlavor;
        if (isRecord(saved.positions)) positions = Object.fromEntries(Object.entries(saved.positions).filter(([id, model]) => POSITION_IDS.includes(id) && typeof model === 'string' && MODEL_RE.test(model))) as Record<string, string>;
        if (isRecord(saved.enginePositions)) {
          for (const [provider, map] of Object.entries(saved.enginePositions)) {
            if (provider === 'claude' || !isRecord(map) || !usable(provider, 'x')) continue;
            const kept = Object.fromEntries(Object.entries(map).filter(([id, model]) => POSITION_IDS.includes(id) && typeof model === 'string' && MODEL_RE.test(model))) as Record<string, string>;
            if (Object.keys(kept).length > 0) enginePositions[provider as Provider] = kept;
          }
        }
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
    sandbox: () => sandbox,
    async setSandbox(value) {
      if (value !== null && value !== undefined && (typeof value !== 'string' || !(CLEAN_ROOM_FLAVORS as readonly string[]).includes(value))) throw new HubError('bad_request', `sandbox must be one of: ${CLEAN_ROOM_FLAVORS.join(', ')}, or null`, 'sandbox');
      const run = chain.then(() => save(() => void (sandbox = value === null || value === undefined || value === 'docker' ? undefined : (value as CleanRoomFlavor))));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
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
    getPosition: (position, provider = 'claude') => (provider === 'claude' ? positions[position] : enginePositions[provider]?.[position]),
    resolve: (provider, position) => (position === undefined ? undefined : provider === 'claude' ? positions[position] : enginePositions[provider]?.[position]) ?? models[provider],
    async set(provider, model) {
      if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) throw new HubError('bad_request', 'unknown engine', 'provider');
      if (providerInfo(provider as Provider).model === null) throw new HubError('bad_request', `${providerInfo(provider as Provider).label} takes no model setting`, 'provider');
      const name = model === null || model === undefined ? '' : typeof model === 'string' ? model.trim() : null;
      if (name === null) throw new HubError('bad_request', 'model must be text or null', 'model');
      if (name !== '' && !MODEL_RE.test(name)) throw new HubError('bad_request', 'model must be 1 to 100 letters, digits or . _ : / @ + -, starting with a letter or digit', 'model');
      const problem = name === '' ? null : modelFormProblem(provider as Provider, name);
      if (problem !== null) throw new HubError('bad_request', problem, 'model');
      const run = chain.then(() => save(() => {
        const next = { ...models };
        if (name === '') delete next[provider as Provider];
        else next[provider as Provider] = name;
        models = next;
      }));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
    async setPosition(position, model, provider = 'claude') {
      if (typeof position !== 'string' || !POSITION_IDS.includes(position)) throw new HubError('bad_request', 'unknown position', 'position');
      if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) throw new HubError('bad_request', 'unknown engine', 'provider');
      if (providerInfo(provider as Provider).model === null) throw new HubError('bad_request', `${providerInfo(provider as Provider).label} takes no model setting`, 'provider');
      const name = model === null || model === undefined ? '' : typeof model === 'string' ? model.trim() : null;
      if (name === null) throw new HubError('bad_request', 'model must be text or null', 'model');
      if (name !== '' && !MODEL_RE.test(name)) throw new HubError('bad_request', 'model must be 1 to 100 letters, digits or . _ : / @ + -, starting with a letter or digit', 'model');
      const problem = name === '' ? null : modelFormProblem(provider as Provider, name);
      if (problem !== null) throw new HubError('bad_request', problem, 'model');
      const run = chain.then(() => save(() => {
        const next = { ...(provider === 'claude' ? positions : (enginePositions[provider as Provider] ?? {})) };
        if (name === '') delete next[position];
        else next[position] = name;
        if (provider === 'claude') positions = next;
        else {
          const all = { ...enginePositions };
          if (Object.keys(next).length === 0) delete all[provider as Provider];
          else all[provider as Provider] = next;
          enginePositions = all;
        }
      }));
      chain = run.catch(() => undefined);
      return run.then(view);
    },
    close: () => chain.then(() => undefined),
  };
}
