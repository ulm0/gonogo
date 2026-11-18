/**
 * Default models, in Flight Rules: one line for each engine that takes a model. A console with a model of its own keeps it; the
 * others use this one at their next start (hires, the 15 positions and Relief hires included, because they all start without one).
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { ModelDefaults } from '../shared/protocol.js';
import { POSITIONS } from '../shared/positions.js';
import { MODEL_PATTERN, providerInfo } from '../shared/protocol.js';
import * as api from './api.js';
import { MODEL_PROVIDERS, publishModelDefaults } from './models.js';
import { useRun } from './WallView.js';

const MODEL_RE = new RegExp(MODEL_PATTERN);

/** One line: a label, the model it holds and the call that changes it (an engine's line, or a position's). */
function Row({ label, names, saved, set, onSaved }: { label: string; names: readonly string[]; saved: string; set(model: string | null): Promise<ModelDefaults>; onSaved(next: ModelDefaults): void }): ReactElement {
  const id = useId();
  const [text, setText] = useState(saved);
  const { busy, error, run } = useRun();
  useEffect(() => setText(saved), [saved]);
  const value = text.trim();
  const bad = value !== '' && !MODEL_RE.test(value);
  const changed = value !== saved;
  const save = (next: string | null): void => run(async () => onSaved(await set(next)));
  return (
    <li className="rules-model">
      <label htmlFor={id} className="rules-call">
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="text"
        list={`${id}-names`}
        value={text}
        placeholder="its own default"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={bad}
        aria-describedby={bad ? `${id}-bad` : undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && changed && !bad && !busy) save(value === '' ? null : value);
        }}
      />
      <datalist id={`${id}-names`}>
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <button type="button" className="btn" aria-disabled={!changed || bad || busy || undefined} onClick={() => changed && !bad && !busy && save(value === '' ? null : value)}>
        {value === '' && saved !== '' ? 'Clear' : 'Set'}
      </button>
      {bad && (
        <p className="error" id={`${id}-bad`}>
          Use letters, digits and . _ : / @ + -, starting with a letter or digit.
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function ModelDefaultsBlock(): ReactElement {
  const titleId = useId();
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const saved = (next: ModelDefaults): void => {
    setDefaults(next);
    publishModelDefaults(next);
  };
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.modelDefaults().then(
      (found) => live && setDefaults(found),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="module rules-block rules-models" aria-labelledby={titleId}>
      <h2 className="label" id={titleId}>
        DEFAULT MODELS
      </h2>
      <p className="hint">
        The model a console starts with when it has none of its own: every hire, the positions and Relief hires. A console's own model (its Edit form) wins. It applies at each console's next start.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {defaults !== null && (
        <ul className="rules-model-list">
          {MODEL_PROVIDERS.map((provider) => (
            <Row key={provider} label={providerInfo(provider).label} names={providerInfo(provider).model ?? []} saved={defaults.models[provider] ?? ''} set={(model) => api.setModelDefault(provider, model)} onSaved={saved} />
          ))}
        </ul>
      )}
      {defaults !== null && (
        <>
          <h3 className="label">BY POSITION</h3>
          <p className="hint">
            A Claude Code console in a position starts with this model before the engine's line above. Its own model still wins. Other engines use their own line, because model names do not carry from one engine to another.
          </p>
          <ul className="rules-model-list">
            {POSITIONS.map((p) => (
              <Row key={p.id} label={p.callSign} names={providerInfo('claude').model ?? []} saved={defaults.positions?.[p.id] ?? ''} set={(model) => api.setPositionModel(p.id, model)} onSaved={saved} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
