import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import * as api from './api.js';
import { Switch } from '@/ui/checkbox.js';

/** Flight Rules: whether a Clean Room agent holds the Anthropic API key (docs/features/egress.md). Saving asks for the password again. */
export function EgressBlock(): ReactElement {
  const id = useId();
  const [on, setOn] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.egressSettings().then((found) => live && setOn(found.anthropic), (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        CLEAN ROOM API KEY
      </h2>
      {on !== null && (
        <label className="staff-check">
          <Switch
 role="switch"
            checked={on}
            onChange={(event) => {
              setProblem(null);
              api.setEgressSettings({ anthropic: event.target.checked }).then((saved) => setOn(saved.anthropic), (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
            }}
          />
          Keep the Anthropic API key out of Clean Room containers
        </label>
      )}
      <p className="hint">
        On: a Clean Room agent gets a placeholder and a web address of this gonogo, and gonogo adds the real key to its requests to api.anthropic.com, so the key is not in the container. Off (the default): the key is in the container&apos;s environment, as before. It applies at the
        next start of each Clean Room agent, and one agent can follow or override it in its own form. It covers an API key; a subscription login (CLAUDE_CODE_OAUTH_TOKEN) is not covered yet. Changing it asks for your password. Nothing on this page shows a key.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
