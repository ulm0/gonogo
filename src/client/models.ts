/**
 * Default models (docs/engine-bay-spec.md): what the page knows about the room's model per engine. No React here but the hook.
 * A console's own model wins; the room's applies when it has none, at the next start.
 */
import { useEffect, useState } from 'react';
import type { ModelDefaults, Provider } from '../shared/protocol.js';
import { PROVIDERS, providerInfo } from '../shared/protocol.js';
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
export function modelNote(own: string | null | undefined, defaults: ModelDefaults | null, provider: Provider, label: string): string {
  const eff = effectiveModel(own, defaults, provider);
  const where = eff === null ? `Empty: ${label} uses its own default.` : eff.from === 'console' ? `This console runs ${eff.model}.` : `Empty: the room's default ${eff.model} applies.`;
  return `${where} A /model typed inside the console only changes that session: set it here to keep it.`;
}

/** The room's defaults, asked once when the component mounts; null until they come (or if the server cannot say). */
export function useModelDefaults(): ModelDefaults | null {
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  useEffect(() => {
    let live = true;
    api.modelDefaults().then(
      (found) => live && setDefaults(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return defaults;
}
