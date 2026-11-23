/** A handoff FLIGHT asks to send while the dock's rule is Ask: the Director reads the whole text that would leave and answers GO or NO-GO, once, like a hire request. */
import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { HandoffAsk } from '../shared/protocol.js';
import * as api from './api.js';
import { alwaysText, askRows, askText, askTitle } from './dockRules.js';
import { refreshAsks } from './linksData.js';
import { useRun } from './WallView.js';

export function HandoffNeed({ ask, legend }: { ask: HandoffAsk; legend: string }): ReactElement {
  const id = useId();
  const { busy, error, run } = useRun();
  const [always, setAlways] = useState(false);
  const title = askTitle(ask, legend);
  const answer = (go: boolean): void =>
    run(async () => {
      await api.answerHandoff(ask.id, go, go && always);
      await refreshAsks();
    });
  return (
    <section className="flood need relief-need" data-tone="amber" aria-label={title}>
      <span className="led need-led" data-on="true" data-blink="true" aria-hidden="true" />
      <div className="need-text">
        <h3 className="disp need-title">{title}</h3>
        <dl className="relief-rows">
          {askRows(ask).map((row) => (
            <div key={row.label} className="relief-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="relief-role-label" id={`${id}-text`}>
          What would leave, in full:
        </p>
        <p className="relief-role dk-ask-text" role="group" tabIndex={0} aria-labelledby={`${id}-text`}>
          {askText(ask)}
        </p>
        <div className="staff-check dk-always">
          <input id={`${id}-always`} type="checkbox" className="check" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          <label htmlFor={`${id}-always`}>{alwaysText(ask.dockName)}</label>
        </div>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="go-buttons">
        <button type="button" className="btn" data-kind="danger" data-size="big" aria-disabled={busy || undefined} aria-label={`NO-GO: do not send this task to ${ask.dockName}`} onClick={() => answer(false)}>
          NO-GO
        </button>
        <button type="button" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined} aria-label={`GO: send this task to ${ask.dockName}`} onClick={() => answer(true)}>
          GO
        </button>
      </div>
    </section>
  );
}
