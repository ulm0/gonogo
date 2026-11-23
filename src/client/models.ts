/**
 * Default models (docs/engine-bay-spec.md): what the page knows about the room's model per engine. No React here but the hook.
 * A console's own model wins; the room's applies when it has none, at the next start.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CleanRoomFlavor, ModelDefaults, Provider } from '../shared/protocol.js';
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
