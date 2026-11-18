/**
 * The engine, the model and the effort of a console as chips (docs/features/engine-bay.md). The model is the one the console will start
 * with, and says where it comes from when the console did not choose it; with none set there is no model chip (the CLI's own default
 * is not known here, and a guess is not shown). The effort is the stored one, never read from the running console.
 */
import type { ReactElement } from 'react';
import { detailsOf, modelText } from '../shared/details.js';
import type { AgentView } from '../shared/protocol.js';
import { useModelDefaults } from './models.js';
import './details.css';

export function DetailChips({ agent }: { agent: Pick<AgentView, 'model' | 'provider' | 'position' | 'effort'> }): ReactElement {
  const d = detailsOf(agent, useModelDefaults());
  return (
    <span className="detail-chips" role="group" aria-label="Engine, model and effort">
      <span className="chip" data-tone="quiet" data-detail="engine">
        {d.engine}
      </span>
      {d.model !== null && (
        <span className="chip" data-tone="quiet" data-detail="model" title={d.model.from === 'console' ? 'The model of this console' : d.model.from === 'position' ? "The default model of this console's position" : "The room's default model for this engine"}>
          {modelText(d.model)}
        </span>
      )}
      {d.effort !== null && (
        <span className="chip" data-tone="quiet" data-detail="effort">
          {`effort ${d.effort}`}
        </span>
      )}
    </span>
  );
}
