/** Flight Rules: what gonogo starts again after the server was stopped (docs/features/autostart.md). */
import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import { STARTUP_POLICIES, SUBAGENT_LIMIT_MAX, SUBAGENT_MODES } from '../shared/protocol.js';
import type { StartupPolicy, StartupSettings, SubagentMode, SubagentSettings } from '../shared/protocol.js';
import * as api from './api.js';

const TEXT: Record<StartupPolicy, string> = { boss: 'The boss only', running: 'Every console that was running', off: 'Nobody' };
const HINT: Record<StartupPolicy, string> = {
  boss: 'After a restart only the boss starts; you start the others (the default, as before).',
  running: 'After a restart the consoles that were running start again, the boss first and then three at a time. A console you stopped, held, or that tripped the Redline stays stopped. A console can opt out in its Edit form.',
  off: 'After a restart nothing starts, the boss included.',
};

/** ALL STOP and ALL RESUME: the Hold of every console at once. */
export function AllStopBlock(): ReactElement {
  const id = useId();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<string>): void => {
    if (busy) return;
    setBusy(true);
    work().then(setNote, (e: unknown) => setNote(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        ALL STOP
      </h2>
      <p className="hint">Holds every console that can be held: its turn is interrupted and its mail waits, as with the Hold key. A console at a dialog, without hooks or stopped is left as it is. ALL RESUME lets the held ones go on; a console that tripped the Redline is resumed by its own key.</p>
      <div className="rules-buttons">
        <button type="button" className="btn" data-kind="primary" aria-disabled={busy || undefined} onClick={() => run(async () => { const r = await api.holdAll(); return `${r.held.length} held${r.skipped.length > 0 ? `; left alone: ${r.skipped.join(', ')}` : ''}.`; })}>
          ALL STOP
        </button>
        <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => run(async () => `${(await api.resumeAll()).resumed.length} resumed.`)}>
          ALL RESUME
        </button>
      </div>
      {note !== null && <p className="hint" role="status">{note}</p>}
    </section>
  );
}

const SUB_TEXT: Record<SubagentMode, string> = { allow: 'Allowed', limit: 'At most N at once', none: 'None' };

/** Flight Rules: what a Claude Code console may do with its own helpers (docs/features/subagents.md). */
export function SubagentsBlock(): ReactElement {
  const id = useId();
  const [settings, setSettings] = useState<SubagentSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.subagentSettings().then((found) => live && setSettings(found), (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  const change = (patch: Partial<SubagentSettings>): void => {
    setProblem(null);
    api.setSubagentSettings(patch).then(setSettings, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        SUBAGENTS
      </h2>
      {settings !== null && (
        <>
          <select aria-label="Subagents" value={settings.mode} onChange={(event) => change({ mode: event.target.value as SubagentMode })}>
            {SUBAGENT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {SUB_TEXT[mode]}
              </option>
            ))}
          </select>
          {settings.mode === 'limit' && (
            <input aria-label="Most subagents at once" type="number" min={1} max={SUBAGENT_LIMIT_MAX} value={settings.limit} onChange={(event) => change({ limit: Number(event.target.value) })} />
          )}
          <p className="hint">
            What a Claude Code console may do with the helpers it starts. A limit is Claude Code's own, and it does not apply while a session runs ultracode. None denies the Agent tool. A helper still uses the console's gonogo tools, as the console. Applies at each console's next start.
          </p>
        </>
      )}
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

export function StartupBlock(): ReactElement {
  const id = useId();
  const [settings, setSettings] = useState<StartupSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.startupSettings().then(
      (found) => live && setSettings(found),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const change = (patch: Partial<StartupSettings>): void => {
    setProblem(null);
    api.setStartupSettings(patch).then(setSettings, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        START AGAIN AFTER A RESTART
      </h2>
      {settings !== null && (
        <>
          <select aria-label="Start again after a restart" value={settings.policy} onChange={(event) => change({ policy: event.target.value as StartupPolicy })}>
            {STARTUP_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {TEXT[policy]}
              </option>
            ))}
          </select>
          <p className="hint">{HINT[settings.policy]}</p>
          <label className="staff-check">
            <input type="checkbox" checked={settings.bossMayStart} onChange={(event) => change({ bossMayStart: event.target.checked })} />
            FLIGHT may start agents (the start_agent tool, for a console that is stopped; never one on hold)
          </label>
          <label className="staff-check">
            <input type="checkbox" checked={settings.carryOn} onChange={(event) => change({ carryOn: event.target.checked })} />
            Tell a console that was in the middle of a turn to carry on
          </label>
        </>
      )}
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
