/**
 * Flight Rules → System and update: RUNTIME SETTINGS (docs/runtime-settings-spec.md). The GONOGO_* values the Director can change here instead of in the compose
 * file, for this room or for all rooms. One line for each: the value, where it comes from (this room, all rooms, environment, built-in default) and when a change
 * applies. A write asks for the password again (the dialog of api.ts, as Room keys do); a refusal is said in the editor, in the words of the server.
 */
import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { ApiFailure } from './api.js';
import * as api from './api.js';
import type { RuntimeSettingRow, RuntimeSettingScope } from '../shared/protocol.js';
import { APPLIES_TEXT, canReset, layerValue, refusalText, SETTING_TEXT, SOURCE_TEXT, startScope, valueText } from './runtimeSettingsModel.js';

/** The editor of one setting: for this room or for all rooms, a field (or a choice), SET, RESET of the layer, CANCEL. */
function Editor({ row, onSaved, onClose }: { row: RuntimeSettingRow; onSaved(next: RuntimeSettingRow): void; onClose(): void }): ReactElement {
  const id = useId();
  const text = SETTING_TEXT[row.key];
  const [scope, setScope] = useState<RuntimeSettingScope>(startScope(row));
  const [value, setValue] = useState(layerValue(row, startScope(row)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = (next: RuntimeSettingScope): void => {
    setScope(next);
    setValue(layerValue(row, next));
    setError(null);
  };
  const send = (next: string | null): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .setRuntimeSetting(row.key, scope, next)
      .then(onSaved, (e: unknown) => setError(refusalText(e as ApiFailure, scope)))
      .finally(() => setBusy(false));
  };
  // an empty Max Q is a value (no limit, set on purpose); any other setting needs a word
  const ready = row.key === 'maxWorking' ? true : value.trim() !== '';
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (ready) send(value);
  };
  return (
    <form className="rt-editor" onSubmit={submit} aria-label={`Change ${text.label}`}>
      {row.scope === 'both' ? (
        <div className="rt-scope" role="group" aria-label={`${text.label}: change it for`}>
          {(['room', 'global'] as const).map((s) => (
            <button key={s} type="button" className="btn" data-kind={scope === s ? 'primary' : 'quiet'} aria-pressed={scope === s} onClick={() => choose(s)}>
              {s === 'room' ? 'This room' : 'All rooms'}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">All rooms: this is one setting for every room.</p>
      )}
      {text.input.kind === 'choice' ? (
        <select id={id} className="input" data-fit aria-label={`${text.label} value`} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose…</option>
          {text.input.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input id={id} className="input" type="text" autoComplete="off" spellCheck={false} aria-label={`${text.label} value`} placeholder={text.input.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
      )}
      {text.warning !== undefined && (
        <p className="flood rt-warning" data-tone="amber" role="note">
          {text.warning}
        </p>
      )}
      <div className="rules-keys">
        <button type="submit" className="btn" data-kind="primary" aria-disabled={busy || !ready || undefined}>
          Set
        </button>
        {canReset(row, scope) && (
          <button type="button" className="btn" aria-label={`Reset ${text.label}${row.scope === 'both' ? (scope === 'room' ? ' for this room' : ' for all rooms') : ''}`} aria-disabled={busy || undefined} onClick={() => send(null)}>
            Reset
          </button>
        )}
        <button type="button" className="btn" data-kind="quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The layers that hold a value, when there is more than one (so that a person can see what a Reset would bring back). */
function layers(row: RuntimeSettingRow): string | null {
  const held: string[] = [];
  if (row.scope === 'both' && row.room !== null) held.push(`this room: ${valueText({ key: row.key, value: row.room })}`);
  if (row.global !== null) held.push(`all rooms: ${valueText({ key: row.key, value: row.global })}`);
  if (row.envValue !== null) held.push(`environment: ${valueText({ key: row.key, value: row.envValue })}`);
  return held.length > 1 ? held.join(' · ') : null;
}

function Item({ row, editing, onEdit, onClose, onSaved }: { row: RuntimeSettingRow; editing: boolean; onEdit(): void; onClose(): void; onSaved(next: RuntimeSettingRow): void }): ReactElement {
  const text = SETTING_TEXT[row.key];
  const held = layers(row);
  return (
    <li className="rt-item">
      <div className="rt-top">
        <span className="rt-name">{text.label}</span>
        <code className="rt-env">{row.env}</code>
      </div>
      <p className="rt-now">
        <span className="rt-value">{valueText(row)}</span>
        <span className="chip" data-tone="quiet">
          {SOURCE_TEXT[row.source]}
        </span>
        <span className="hint">{APPLIES_TEXT[row.applies]}</span>
      </p>
      {held !== null && <p className="hint">{held}</p>}
      <p className="hint">{text.help}</p>
      {editing ? (
        <Editor row={row} onSaved={onSaved} onClose={onClose} />
      ) : (
        <button type="button" className="btn" data-kind="quiet" aria-label={`Change ${text.label}`} onClick={onEdit}>
          Change
        </button>
      )}
    </li>
  );
}

export function RuntimeSettingsBlock(): ReactElement {
  const id = useId();
  const [rows, setRows] = useState<RuntimeSettingRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.runtimeSettings().then(
      (found) => live && setRows(found),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        RUNTIME SETTINGS
      </h2>
      <p className="hint">Settings of gonogo that you can change here instead of in the compose file, for this room or for all rooms. This room&apos;s value wins, then the one for all rooms, then the environment, then the built-in default. Reset goes back to the next one.</p>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {rows !== null && (
        <ul className="rt-list">
          {rows.map((row) => (
            <Item
              key={row.key}
              row={row}
              editing={editing === row.key}
              onEdit={() => setEditing(row.key)}
              onClose={() => setEditing(null)}
              onSaved={(next) => {
                setRows((all) => (all === null ? all : all.map((r) => (r.key === next.key ? next : r))));
                setEditing(null);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
