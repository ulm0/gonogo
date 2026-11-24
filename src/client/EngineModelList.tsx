/**
 * Model lists (docs/engine-bay-spec.md): the line under a model field that says where its names come from (the engine's own list, its
 * suggested names, not installed, an error), and the REFRESH key that asks the program again. The field itself stays free text.
 */
import type { ReactElement } from 'react';
import type { Provider } from '../shared/protocol.js';
import { providerInfo } from '../shared/protocol.js';
import type { EngineModelsState } from './models.js';
import { loadEngineModels, modelListText } from './models.js';

export function ModelListStatus({ provider, state }: { provider: Provider; state: EngineModelsState }): ReactElement {
  const loading = state.state === 'loading';
  return (
    <span className="model-list-status" data-state={state.state === 'ready' ? state.list.source : state.state}>
      <span aria-live="polite">{modelListText(provider, state)}</span>{' '}
      <button type="button" className="btn" aria-label={`Refresh the models of ${providerInfo(provider).label}`} aria-disabled={loading || undefined} onClick={() => !loading && void loadEngineModels(provider, true)}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </span>
  );
}
