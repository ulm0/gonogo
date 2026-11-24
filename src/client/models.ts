/**
 * Default models (docs/engine-bay-spec.md): what the page knows about the room's model per engine. No React here but the hook.
 * A console's own model wins; the room's applies when it has none, at the next start.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CleanRoomFlavor, EngineModels, ModelDefaults, Provider } from '../shared/protocol.js';
import { PROVIDERS, providerInfo } from '../shared/protocol.js';
import { effectiveModel as startModel } from '../shared/details.js';
import * as api from './api.js';

/** The engines with a model field, in the order the page lists them. */
export const MODEL_PROVIDERS: readonly Provider[] = PROVIDERS.filter((p) => providerInfo(p).model !== null);

/** The model a console runs with: its own, else the room's, else null (the CLI's own default). */
export function effectiveModel(own: string | null | undefined, defaults: ModelDefaults | null, provider: Provider): { model: string; from: 'console' | 'room' } | null {
  const mine = own?.trim();
  if (mine) return { model: mine, from: 'console' };
  const room = defaults?.models[provider];
  return room ? { model: room, from: 'room' } : null;
}

/** What the model field says under it: where the value comes from, and that a `/model` typed in the console is not kept. */
export function modelNote(own: string | null | undefined, defaults: ModelDefaults | null, provider: Provider, label: string, position: string | null = null): string {
  // the position's default (Claude Code) comes before the room's, as at the start (shared/details.ts)
  const eff = startModel({ model: own?.trim() || null, provider, position }, defaults);
  const where = eff === null ? `Empty: ${label} uses its own default.` : eff.from === 'console' ? `This console runs ${eff.name}.` : `Empty: the ${eff.from === 'position' ? "position's" : "room's"} default ${eff.name} applies.`;
  return `${where} A /model typed inside the console only changes that session: set it here to keep it.`;
}

/* The room's defaults are asked once for the whole page and shared: the hire form and every chip on the page read the same copy, and the
   settings block publishes a change so that they follow it. They are not in a frame, so another browser's change shows at the next load. */
let shared: ModelDefaults | null = null;
let asked = false;
const listeners = new Set<() => void>();

/** The settings block saved a change: every reader gets it. */
export function publishModelDefaults(next: ModelDefaults): void {
  shared = next;
  listeners.forEach((l) => l());
}

/** Forgets the copy (a test, or a new connection to another server). */
export function resetModelDefaults(): void {
  shared = null;
  asked = false;
  listeners.forEach((l) => l());
}

/** The room's defaults; null until they come (or if the server cannot say). */
export function useModelDefaults(): ModelDefaults | null {
  useEffect(() => {
    if (asked) return;
    asked = true;
    api.modelDefaults().then(publishModelDefaults, () => {
      asked = false;
    });
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shared,
    () => shared,
  );
}

/** The Clean Room flavors as a person reads them, with the runtime each needs. */
export const FLAVOR_TEXT: Readonly<Record<CleanRoomFlavor, string>> = { docker: 'Docker (runc)', gvisor: 'gVisor (runsc)', microvm: 'microVM (Kata)' };

/* Model lists (docs/engine-bay-spec.md): what each engine offers, asked of the server once per engine for the whole page and shared,
   like the defaults above. The hire form, the Edit form and the DEFAULTS block read the same copy; REFRESH asks the program again. */
export type EngineModelsState = { state: 'loading' } | { state: 'ready'; list: EngineModels } | { state: 'failed'; error: string };
const modelLists = new Map<Provider, EngineModelsState>();
const modelListeners = new Set<() => void>();
const LOADING: EngineModelsState = { state: 'loading' };

/** Asks the server for one engine's models (again with `refresh`); every reader follows. */
export function loadEngineModels(provider: Provider, refresh = false): Promise<void> {
  const before = modelLists.get(provider);
  if (!refresh && before !== undefined) return Promise.resolve();
  modelLists.set(provider, LOADING);
  modelListeners.forEach((l) => l());
  return api.engineModels(provider, refresh).then(
    (list) => {
      modelLists.set(provider, { state: 'ready', list });
      modelListeners.forEach((l) => l());
    },
    (e: unknown) => {
      modelLists.set(provider, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
      modelListeners.forEach((l) => l());
    },
  );
}

/** Forgets every list (a test, or a new connection to another server). */
export function resetEngineModels(): void {
  modelLists.clear();
  modelListeners.forEach((l) => l());
}

/** The names a model field offers: the engine's real list when it came, else the names PROVIDER_INFO suggests. */
export function modelNames(provider: Provider, state: EngineModelsState): readonly string[] {
  return state.state === 'ready' ? state.list.models : (providerInfo(provider).model ?? []);
}

/** One engine's models; asks for them the first time any reader wants them. null provider: none asked. */
export function useEngineModels(provider: Provider | null): EngineModelsState {
  useEffect(() => {
    if (provider !== null && providerInfo(provider).model !== null) void loadEngineModels(provider);
  }, [provider]);
  return useSyncExternalStore(
    (l) => {
      modelListeners.add(l);
      return () => modelListeners.delete(l);
    },
    () => (provider === null ? LOADING : (modelLists.get(provider) ?? LOADING)),
    () => (provider === null ? LOADING : (modelLists.get(provider) ?? LOADING)),
  );
}

/** What the line under a model field says about the list: where the names come from, or why there are none. */
export function modelListText(provider: Provider, state: EngineModelsState): string {
  const label = providerInfo(provider).label;
  if (state.state === 'loading') return `Loading the models of ${label}…`;
  if (state.state === 'failed') return `Could not ask the server for the models of ${label}: ${state.error}. Type a name.`;
  const list = state.list;
  const n = list.models.length;
  const count = `${n} ${n === 1 ? 'model' : 'models'}`;
  switch (list.source) {
    case 'cli':
      return n === 0 ? `${list.command ?? label} listed no models: is a provider signed in? Type a name.` : `${count} from ${list.command ?? label}${list.version ? ` (${list.version})` : ''}. Pick one or type any name it accepts.`;
    case 'static':
      return n === 0 ? `${label} has no command that lists its models: type a name.` : `${label} has no command that lists its models; names it knows: ${list.models.join(', ')}. Any name it accepts works.`;
    case 'missing':
      return `${label} is not installed here (${providerInfo(provider).bin} is not on the PATH): type a name.`;
    case 'error':
      return `Could not read the list (${list.command ?? label}: ${list.error ?? 'no answer'}). Type a name.`;
  }
}

/** Puts a list in the page's copy as if the server had sent it (a test, or a page that already has one). */
export function publishEngineModels(provider: Provider, list: EngineModels): void {
  modelLists.set(provider, { state: 'ready', list });
  modelListeners.forEach((l) => l());
}
