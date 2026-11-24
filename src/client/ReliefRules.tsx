/** Flight Rules: what the boss may hire without asking, STOP CREW, and which of its agents are protected (docs/hire-fire-spec.md, docs/features/relief.md). Raising a rule asks for the password again. */
import { useCallback, useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import { POSITION_IDS } from '../shared/positions.js';
import { PROVIDERS, RELIEF_MODES, RELIEF_RULES_DEFAULT } from '../shared/protocol.js';
import type { ReliefRules, ReliefView } from '../shared/protocol.js';
import * as api from './api.js';

const ENGINES = PROVIDERS.filter((p) => p !== 'custom');
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** `claude: opus, sonnet` per line, to and from the rule. */
const modelsText = (models: ReliefRules['models']): string => Object.entries(models).map(([engine, list]) => `${engine}: ${(list ?? []).join(', ')}`).join('\n');
const modelsOf = (value: string): ReliefRules['models'] => {
  const out: ReliefRules['models'] = {};
  for (const line of value.split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const names = line.slice(at + 1).split(',').map((n) => n.trim()).filter((n) => n !== '');
    if (names.length > 0) out[line.slice(0, at).trim() as keyof ReliefRules['models']] = names;
  }
  return out;
};
const toggle = <T,>(list: readonly T[], item: T, on: boolean): T[] => (on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item));

export function ReliefRulesBlock(): ReactElement {
  const id = useId();
  const [view, setView] = useState<ReliefView | null>(null);
  const [draft, setDraft] = useState<ReliefRules>(RELIEF_RULES_DEFAULT);
  const [modelsDraft, setModelsDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const take = useCallback((next: ReliefView): void => {
    setView(next);
    if (next.rules !== undefined) {
      setDraft(next.rules);
      setModelsDraft(modelsText(next.rules.models));
    }
  }, []);
  useEffect(() => {
    let live = true;
    api.reliefView().then((v) => live && take(v), (e: unknown) => live && setProblem(text(e)));
    return () => {
      live = false;
    };
  }, [take]);

  const run = (work: () => Promise<ReliefView>, done: string): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setNote(null);
    work().then((v) => {
      take(v);
      setNote(done);
    }, (e: unknown) => setProblem(text(e))).finally(() => setBusy(false));
  };
  const rules = view?.rules;
  if (view === null || rules === undefined) return <section className="module rules-block" aria-labelledby={`${id}-title`}><h2 className="label" id={`${id}-title`}>HIRE ON DEMAND</h2>{problem !== null ? <p className="error" role="alert">{problem}</p> : <p className="hint">Loading…</p>}</section>;
  const crew = view.crew ?? [];
  const set = (patch: Partial<ReliefRules>): void => setDraft({ ...draft, ...patch });
  const num = (value: string, fallback: number): number => (Number.isFinite(Number(value)) && value.trim() !== '' ? Number(value) : fallback);

  return (
    <section className="module rules-block" aria-labelledby={`${id}-title`}>
      <h2 className="label" id={`${id}-title`}>
        HIRE ON DEMAND
      </h2>
      <label className="staff-check">
        <input type="checkbox" className="switch" role="switch" checked={draft.autoApprove} onChange={(event) => set({ autoApprove: event.target.checked })} />
        FLIGHT may hire by rule, without asking you each time
      </label>
      <p className="hint">Off (the default): every hire waits for your GO. On: a request that fits every rule below is hired at once and its tile says "hired by flight"; any other becomes a request that names the rule. A role the boss writes itself, a custom command, keys, a payload, permissions and a folder outside its own always ask you.</p>
      <div className="rules-grid">
        <label>Crew at most <input type="number" className="input" min={1} max={24} value={draft.maxCrew} onChange={(event) => set({ maxCrew: num(event.target.value, draft.maxCrew) })} /></label>
        <label>Hires per hour <input type="number" className="input" min={1} max={60} value={draft.ratePerHour} onChange={(event) => set({ ratePerHour: num(event.target.value, draft.ratePerHour) })} /></label>
        <label>Crew budget, USD per day (optional) <input type="number" className="input" min={0.01} step={0.01} value={draft.crewBudgetUsd ?? ''} onChange={(event) => set({ crewBudgetUsd: event.target.value.trim() === '' ? null : num(event.target.value, draft.crewBudgetUsd ?? 1) })} /></label>
        <label>Highest mode <select className="input" value={draft.maxMode} onChange={(event) => set({ maxMode: event.target.value as ReliefRules['maxMode'] })}>{RELIEF_MODES.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
      </div>
      <p className="hint">Crew budget: empty = no daily ceiling; room budgets/Redline still apply.</p>
      <fieldset className="rules-set"><legend>Positions it may hire</legend>
        {POSITION_IDS.map((p) => <label key={p} className="staff-check"><input type="checkbox" className="check" checked={draft.positions.includes(p)} onChange={(event) => set({ positions: toggle(draft.positions, p, event.target.checked) })} />{p.toUpperCase()}</label>)}
      </fieldset>
      <fieldset className="rules-set"><legend>Engines (none checked: the room's default engine)</legend>
        {ENGINES.map((p) => <label key={p} className="staff-check"><input type="checkbox" className="check" checked={draft.engines.includes(p)} onChange={(event) => set({ engines: toggle(draft.engines, p, event.target.checked) })} />{p}</label>)}
      </fieldset>
      <fieldset className="rules-set"><legend>Autoscale (the crew follows the Flight Plan; needs automatic hires on)</legend>
        <label>Mode <select className="input" value={draft.autoscale} onChange={(event) => set({ autoscale: event.target.value as ReliefRules['autoscale'] })}><option value="off">off</option><option value="dry-run">dry run: only says what it would do</option><option value="on">on</option></select></label>
        <label>Hire when unassigned todo tasks for a position reach <input type="number" className="input" min={1} max={50} value={draft.scaleUpTodo} onChange={(event) => set({ scaleUpTodo: num(event.target.value, draft.scaleUpTodo) })} /></label>
        <label>Stop an agent idle with no task for (minutes, empty: never) <input type="number" className="input" min={5} max={1440} value={draft.idleStopMinutes ?? ''} onChange={(event) => set({ idleStopMinutes: event.target.value.trim() === '' ? null : num(event.target.value, draft.idleStopMinutes ?? 60) })} /></label>
        <label>Remove an agent stopped for (hours, empty: never) <input type="number" className="input" min={1} max={720} value={draft.removeStoppedHours ?? ''} onChange={(event) => set({ removeStoppedHours: event.target.value.trim() === '' ? null : num(event.target.value, draft.removeStoppedHours ?? 24) })} /></label>
      </fieldset>
      <label>Models it may name (one line per engine, for example <code>claude: opus, sonnet</code>; none listed: only the engine's default)
        <textarea className="textarea" rows={3} aria-label="Models a rule hire may name" value={modelsDraft} onChange={(event) => { setModelsDraft(event.target.value); set({ models: modelsOf(event.target.value) }); }} />
      </label>
      <label className="staff-check">
        <input type="checkbox" className="check" checked={draft.mayStop} onChange={(event) => set({ mayStop: event.target.checked })} />
        FLIGHT may stop agents with fire_agent (not itself, and not the ones you protect). Protect the consoles that gate your work, a reviewer for one, in their Edit form.
      </label>
      <label className="staff-check">
        <input type="checkbox" className="check" checked={draft.mayRemove} onChange={(event) => set({ mayRemove: event.target.checked })} />
        FLIGHT may also remove agents (their record goes; their folder is kept renamed, and an agent with keys of its own is never removed)
      </label>
      <label className="staff-check">
        <input type="checkbox" className="check" checked={draft.bypassInCleanRoom} onChange={(event) => set({ bypassInCleanRoom: event.target.checked })} />
        Allow bypassPermissions by rule in a Clean Room (egress on, no global MCP; the agent runs every tool without asking). In the Docker setup (GONOGO_CLEANROOM_NETWORK=container:*) a Clean Room shares gonogo's network and reaches every loopback service there, the managed Ollama among them.
      </label>
      <label className="staff-check">
        <input type="checkbox" className="check" checked={draft.autoOnHost} onChange={(event) => set({ autoOnHost: event.target.checked })} />
        Allow auto mode outside a Clean Room (agents the boss hires can then change anything your user can, without asking)
      </label>
      <div className="rules-buttons">
        <button type="button" className="btn" data-kind="primary" aria-disabled={busy || undefined} onClick={() => run(() => api.setReliefRules(draft), 'Saved.')}>
          SAVE RULES
        </button>
        <button type="button" className="btn" data-kind="danger" aria-disabled={busy || undefined} onClick={() => run(() => api.stopCrew(), 'Crew stopped, automatic hires are off.')}>
          STOP CREW
        </button>
      </div>
      <p className="hint">STOP CREW stops every agent the boss hired by rule and turns automatic hires off. It asks for no password.</p>
      {crew.length > 0 && (
        <div className="rules-crew">
          <h3 className="label">Boss-hired agents</h3>
          <ul>{crew.map((name) => <li key={name}>{name}</li>)}</ul>
          <p className="hint">Hired by FLIGHT by rule. Any agent but FLIGHT can be stopped by it unless you protect it in its Edit form.</p>
        </div>
      )}
      {note !== null && <p className="hint" role="status">{note}</p>}
      {problem !== null && <p className="error" role="alert">{problem}</p>}
    </section>
  );
}
