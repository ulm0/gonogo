/**
 * Flight Rules: the name of this room in the title of the browser tab, so that several gonogo sessions can be told apart. Kept on the
 * server, so every browser shows it. Empty goes back to the default (the station name when GONOGO_STATION is set, else `gonogo`).
 */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import { TAB_NAME_MAX_CHARS } from '../shared/protocol.js';
import * as api from './api.js';
import { tabTitle } from './notify.js';
import { useStore } from './store.js';
import { useRun } from './WallView.js';

export function TabNameBlock(): ReactElement {
  const id = useId();
  const view = useStore((s) => s.tabName);
  const [text, setText] = useState(view.name ?? '');
  const { busy, error, run } = useRun();
  // another browser changed it: this field follows
  useEffect(() => setText(view.name ?? ''), [view.name]);
  const changed = text.trim() !== (view.name ?? '');
  const save = (): void => {
    if (changed && !busy) run(() => api.setTabName(text.trim() === '' ? null : text));
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        TAB NAME
      </h2>
      <p className="hint">Tells this room from another in the tab bar. Every browser shows it.</p>
      <div className="rules-tabname">
        <label htmlFor={`${id}-name`} className="sr-only">
          Tab name
        </label>
        <input
          id={`${id}-name`}
          className="input"
          value={text}
          maxLength={TAB_NAME_MAX_CHARS}
          placeholder={view.fallback ?? 'gonogo'}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button type="button" className="btn" aria-disabled={!changed || busy || undefined} onClick={save}>
          {text.trim() === '' && view.name !== null ? 'Clear' : 'Set'}
        </button>
      </div>
      <p className="hint">{`The tab says: ${tabTitle({ name: text.trim() === '' ? null : text.trim(), fallback: view.fallback })}`}</p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
