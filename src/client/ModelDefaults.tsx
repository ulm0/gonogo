/**
 * Default models, in Flight Rules: one line for each engine that takes a model. A console with a model of its own keeps it; the
 * others use this one at their next start (hires, the 16 positions and Relief hires included, because they all start without one).
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { CleanRoomFlavor, CleanRoomFlavors, Effort, ModelDefaults, PermissionMode, Provider } from '../shared/protocol.js';
import { POSITIONS } from '../shared/positions.js';
import { CLEAN_ROOM_FLAVORS, EFFORTS, MODEL_PATTERN, PROVIDERS, providerInfo } from '../shared/protocol.js';
import * as api from './api.js';
import { FLAVOR_TEXT, MODEL_PROVIDERS, publishModelDefaults } from './models.js';
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
      <button type="button" className="btn" aria-label={`${value === '' && saved !== '' ? 'Clear' : 'Set'} the model of ${label}`} aria-disabled={!changed || bad || busy || undefined} onClick={() => changed && !bad && !busy && save(value === '' ? null : value)}>
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

/** One select of the DEFAULTS block: the saved value, '' for none, saved at once on a change. */
function Pick({ label, saved, options, empty, set, onSaved }: { label: string; saved: string; options: ReadonlyArray<{ value: string; text: string; disabled?: boolean }>; empty: string; set(value: string | null): Promise<ModelDefaults>; onSaved(next: ModelDefaults): void }): ReactElement {
  const id = useId();
  const { busy, error, run } = useRun();
  return (
    <li className="rules-model">
      <label htmlFor={id} className="rules-call">
        {label}
      </label>
      <select id={id} className="input" data-fit value={saved} disabled={busy} onChange={(event) => run(async () => onSaved(await set(event.target.value === '' ? null : event.target.value)))}>
        <option value="">{empty}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.text}
          </option>
        ))}
      </select>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** The room's default permission mode. Bypass is not saved by a click on the select: it asks for the same confirmation a hire does. */
function ModePick({ saved, onSaved }: { saved: PermissionMode | undefined; onSaved(next: ModelDefaults): void }): ReactElement {
  const id = useId();
  const { busy, error, run } = useRun();
  const [asking, setAsking] = useState(false);
  const [ok, setOk] = useState(false);
  return (
    <li className="rules-model">
      <label htmlFor={id} className="rules-call">
        Permission mode
      </label>
      <select
        id={id}
        className="input"
        data-fit
        value={asking ? 'bypassPermissions' : (saved ?? '')}
        disabled={busy}
        onChange={(event) => {
          const value = event.target.value;
          setOk(false);
          setAsking(value === 'bypassPermissions' && saved !== 'bypassPermissions');
          if (value !== 'bypassPermissions') run(async () => onSaved(await api.setDefaultMode(value === '' ? null : (value as PermissionMode))));
        }}
      >
        <option value="">Ask (default)</option>
        <option value="acceptEdits">Accept edits</option>
        <option value="auto">Auto</option>
        <option value="bypassPermissions">Bypass</option>
      </select>
      {asking && (
        <div className="staff-check" role="group" aria-label="Confirm bypass">
          <input id={`${id}-ok`} type="checkbox" className="check" checked={ok} onChange={(event) => setOk(event.target.checked)} />
          <label htmlFor={`${id}-ok`}>Hires from the form start in bypass: every tool runs without asking. Agents that hire (hire_agent, Relief) never get bypass from this.</label>
          <button type="button" className="btn" aria-disabled={!ok || busy || undefined} onClick={() => ok && !busy && run(async () => { onSaved(await api.setDefaultMode('bypassPermissions', true)); setAsking(false); })}>
            Set
          </button>
        </div>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** The room's default sandbox flavor of the Clean Room; one whose runtime Docker does not list shows as not installed and cannot be picked. */
function SandboxPick({ saved, flavors, onSaved }: { saved: ModelDefaults['sandbox']; flavors: CleanRoomFlavors | null; onSaved(next: ModelDefaults): void }): ReactElement {
  return (
    <Pick
      label="Clean Room sandbox (gVisor on gonogo's network: not verified; microVM: cannot start yet)"
      saved={saved ?? ''}
      empty={FLAVOR_TEXT.docker}
      options={CLEAN_ROOM_FLAVORS.filter((f) => f !== 'docker').map((f) => ({ value: f, text: `${FLAVOR_TEXT[f]}${flavors !== null && !flavors.available[f] ? ' (not installed)' : ''}`, disabled: flavors !== null && !flavors.available[f] && saved !== f }))}
      set={(flavor) => api.setDefaultSandbox(flavor as CleanRoomFlavor | null)}
      onSaved={onSaved}
    />
  );
}

/** Which engine's position models the list shows: every engine with a model setting. */
function PositionEngine({ value, onChange }: { value: Provider; onChange: (provider: Provider) => void }): ReactElement {
  const id = useId();
  return (
    <p className="rules-position-engine">
      <label className="label" htmlFor={id}>
        ENGINE
      </label>{' '}
      <select id={id} className="input" value={value} onChange={(event) => onChange(event.target.value as Provider)}>
        {MODEL_PROVIDERS.map((provider) => (
          <option key={provider} value={provider}>
            {providerInfo(provider).label}
          </option>
        ))}
      </select>
    </p>
  );
}

export function ModelDefaultsBlock(): ReactElement {
  const titleId = useId();
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const [positionEngine, setPositionEngine] = useState<Provider>('claude');
  const saved = (next: ModelDefaults): void => {
    setDefaults(next);
    publishModelDefaults(next);
  };
  const [flavors, setFlavors] = useState<CleanRoomFlavors | null>(null);
  useEffect(() => {
    let live = true;
    api.cleanRoomFlavors().then((found) => live && setFlavors(found), () => undefined);
    return () => {
      live = false;
    };
  }, []);
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
        DEFAULTS
      </h2>
      <p className="hint">
        What a console starts with when it has none of its own: the engine of a hire that names none (the hire form, Relief and hire_agent), the model of each engine and position, and the effort of the engines that take one (Claude Code, pi, opencode). A console's own setting (its Edit form) wins. A model or effort applies at each console's next start; the chips of each console say which level it comes from.
      </p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {defaults !== null && (
        <>
          <h3 className="label">ENGINE AND EFFORT</h3>
          <ul className="rules-model-list">
            <Pick label="Default engine" saved={defaults.engine ?? ''} empty="Claude Code" options={PROVIDERS.filter((p) => p !== 'custom' && p !== 'claude').map((p) => ({ value: p, text: providerInfo(p).label }))} set={(engine) => api.setDefaultEngine(engine as Provider | null)} onSaved={saved} />
            <ModePick saved={defaults.mode} onSaved={saved} />
            <SandboxPick saved={defaults.sandbox} flavors={flavors} onSaved={saved} />
            <Pick label="Effort" saved={defaults.effort ?? ''} empty="its own" options={EFFORTS.map((e) => ({ value: e, text: e }))} set={(effort) => api.setDefaultEffort(effort as Effort | null)} onSaved={saved} />
          </ul>
          {defaults.engine !== undefined && (!providerInfo(defaults.engine).hooks || !providerInfo(defaults.engine).mcp) && (
            <p className="hint">
              {providerInfo(defaults.engine).label}: {[providerInfo(defaults.engine).hooks ? null : 'no Redline or Hold', providerInfo(defaults.engine).mcp ? null : 'no gonogo tools'].filter((x) => x !== null).join(', ')}.
            </p>
          )}
          <h3 className="label">MODEL BY ENGINE</h3>
        </>
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
            A console in a position starts with its engine's model for that position before the engine's line above. Its own model still wins. Each engine has its own list, because model names do not carry from one engine to another.
          </p>
          <PositionEngine value={positionEngine} onChange={setPositionEngine} />
          <ul className="rules-model-list">
            {POSITIONS.map((p) => (
              <Row
                key={`${positionEngine}-${p.id}`}
                label={p.callSign}
                names={providerInfo(positionEngine).model ?? []}
                saved={(positionEngine === 'claude' ? defaults.positions?.[p.id] : defaults.enginePositions?.[positionEngine]?.[p.id]) ?? ''}
                set={(model) => api.setPositionModel(p.id, model, positionEngine)}
                onSaved={saved}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
