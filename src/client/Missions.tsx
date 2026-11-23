/**
 * Missions: the named goals of the room. A list (status, name, lead, `3 / 7`), a detail with the goal, the keys that change its
 * status, the tasks that serve it (each opens its card in the Flight Plan) and its history, and a form that makes or edits one.
 * Every action is a key the keyboard reaches. The view opens from the Patch Panel, the wall's mission strip and the brief box.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { MISSION_GOAL_MAX_CHARS, MISSION_NAME_MAX_CHARS, RITUAL_ITEM_MAX_CHARS, RITUAL_ITEMS_MAX } from '../shared/protocol.js';
import type { Mission, RitualItem } from '../shared/protocol.js';
import * as api from './api.js';
import { parseMoney } from '../shared/fuel.js';
import { moneyText } from '../shared/prices.js';
import { actionsOf, budgetShare, emptyMissionValues, progressOf, ritualProgress, ritualTextProblem, sourceText, spendText, sortMissions, STATUS_LABELS, STATUS_TONES, tasksOf, tickedText, validateMission } from './missionsModel.js';
import type { MissionValues } from './missionsModel.js';
import { LinkLines } from './LinkLines.js';
import { incoming, outgoing } from './links.js';
import { useLinks } from './linksData.js';
import { cardId, labelOf } from './plan.js';
import { useAgentList } from './RoomView.js';
import { selectMission, showPlan, showRoom, useStore } from './store.js';
import { useRun } from './WallView.js';
import './loop.css';
import './missions.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function Status({ mission }: { mission: Mission }): ReactElement {
  return (
    <span className="chip" data-tone={STATUS_TONES[mission.status]}>
      {STATUS_LABELS[mission.status]}
    </span>
  );
}

/**
 * The closing checklist: what the Director wants checked before the mission is called done. The Director ticks, adds, rewords and removes lines here (the server
 * refuses an agent), a line an agent set says which agent set it (it is plain text, never a link or an instruction, and never passes for the Director's), and
 * it is never a gate: DONE works with items open, and the Downlink says which were left.
 */
function RitualLine({ mission, item, index, count }: { mission: Mission; item: RitualItem; index: number; count: number }): ReactElement {
  const { busy, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const id = useId();
  const problem = ritualTextProblem(text, count, false);
  const source = sourceText(item);
  if (editing) {
    return (
      <li>
        <label htmlFor={id} className="sr-only">
          Words of closing item {index + 1}
        </label>
        <input id={id} className="input" value={text} maxLength={RITUAL_ITEM_MAX_CHARS + 20} autoComplete="off" aria-invalid={problem !== null || undefined} onChange={(e) => setText(e.target.value)} />
        <button
          type="button"
          className="btn"
          data-kind="primary"
          aria-disabled={problem !== null || busy || undefined}
          onClick={() =>
            problem === null &&
            !busy &&
            run(async () => {
              await api.setRitualItem(mission.id, index, { text: text.trim() });
              setEditing(false);
            })
          }
        >
          Save
        </button>
        <button
          type="button"
          className="btn"
          data-kind="quiet"
          onClick={() => {
            setText(item.text);
            setEditing(false);
          }}
        >
          Cancel
        </button>
        {problem !== null && <span className="error">{problem}</span>}
        {error !== null && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </li>
    );
  }
  return (
    <li>
      <label>
        <input type="checkbox" className="check" checked={item.done} disabled={busy} onChange={(event) => run(() => api.setRitualItem(mission.id, index, { done: event.target.checked }))} />
        <span className="mis-ritual-text">{item.text}</span>
      </label>
      {source !== '' && (
        <span className="chip" data-tone={item.from === 'agent' || item.from === 'repo' ? 'amber' : 'quiet'}>
          {source}
        </span>
      )}
      {item.done && <span className="hint">{tickedText(item)}</span>}
      <button type="button" className="btn" data-kind="quiet" aria-label={`Edit closing item ${index + 1}: ${item.text}`} aria-disabled={busy || undefined} onClick={() => setEditing(true)}>
        Edit
      </button>
      <button type="button" className="btn" data-kind="quiet" aria-label={`Remove closing item ${index + 1}: ${item.text}`} aria-disabled={busy || undefined} onClick={() => !busy && run(() => api.removeRitualItem(mission.id, index))}>
        Remove
      </button>
      {error !== null && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

function Ritual({ mission }: { mission: Mission }): ReactElement {
  const id = useId();
  const { busy, error, run } = useRun();
  const [text, setText] = useState('');
  const items = mission.ritual ?? [];
  const progress = ritualProgress(mission);
  const problem = text === '' ? null : ritualTextProblem(text, items.length, true);
  const add = (event: FormEvent): void => {
    event.preventDefault();
    if (ritualTextProblem(text, items.length, true) !== null || busy) return;
    run(async () => {
      await api.addRitualItem(mission.id, text.trim());
      setText('');
    });
  };
  return (
    <section className="mis-ritual" aria-label={`Closing checklist of ${mission.name}`}>
      <h3 className="label">CLOSING CHECKLIST</h3>
      {items.length === 0 ? (
        <p className="hint">Nothing to check before this mission is called done. Add a line, or set a template in Flight Rules for every new mission.</p>
      ) : (
        <p className="hint" role="status">
          {progress.text}
          {progress.left > 0 && mission.status !== 'done' ? ' You can close the mission with items open: the Downlink will list them.' : ''}
        </p>
      )}
      <ul className="mis-ritual-list">
        {items.map((item, index) => (
          <RitualLine key={`${index}:${item.text}`} mission={mission} item={item} index={index} count={items.length} />
        ))}
      </ul>
      {items.length < RITUAL_ITEMS_MAX && (
        <form className="mis-budget" onSubmit={add} noValidate>
          <label htmlFor={id}>New closing item</label>
          <input id={id} className="input" value={text} autoComplete="off" placeholder="Tests pass on main" aria-invalid={problem !== null || undefined} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn" aria-disabled={text.trim() === '' || problem !== null || busy || undefined}>
            Add
          </button>
        </form>
      )}
      {(mission.ritualOmitted ?? 0) > 0 && (
        <p className="hint">{`${mission.ritualOmitted} more ${mission.ritualOmitted === 1 ? 'line' : 'lines'} of the template ${mission.ritualOmitted === 1 ? 'was' : 'were'} left out: a mission holds at most ${RITUAL_ITEMS_MAX}.`}</p>
      )}
      {problem !== null && <p className="error">{problem}</p>}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** What the mission has cost, and its budget: Redline warns at 80 % and stops the agents working on it at 100 %. */
function MissionCost({ mission }: { mission: Mission }): ReactElement {
  const id = useId();
  const spend = useStore((s) => s.propellant.cost.missions?.[mission.id]);
  const { busy, error, run } = useRun();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const share = budgetShare(spend);
  const save = (usd: number | null): void => run(async () => {
    await api.setPropellant({ budget: { missions: { [mission.id]: usd } } });
    setText('');
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const usd = parseMoney(text);
    setInvalid(usd === null);
    if (usd !== null) save(usd);
  };
  return (
    <section className="mis-cost" aria-label={`Cost of ${mission.name}`}>
      <h3 className="label">COST</h3>
      <p className="mis-spend" data-level={share === null ? undefined : share >= 1 ? 'over' : share >= 0.8 ? 'low' : undefined}>
        {spendText(spend) || 'Nothing spent yet. Replies are counted to the mission while an agent has one of its tasks on doing.'}
      </p>
      <form className="mis-budget" onSubmit={submit} noValidate>
        <label htmlFor={id}>Budget in dollars</label>
        <input id={id} className="input" value={text} inputMode="decimal" autoComplete="off" placeholder={spend?.budget === undefined ? 'no budget' : moneyText(spend.budget)} aria-invalid={invalid} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn" aria-disabled={busy || undefined}>
          Set
        </button>
        {spend?.budget !== undefined && (
          <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => save(null)}>
            Clear
          </button>
        )}
      </form>
      {invalid && <p className="error">Dollars from 0.01 to 1,000,000, for example 25 or $12.50.</p>}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** The form that makes a mission, or edits the name, goal and lead of one. */
function MissionForm({ original, draft, onDone }: { original: Mission | null; draft: { name: string; goal: string } | null; onDone(saved: Mission | null): void }): ReactElement {
  const id = useId();
  const list = useAgentList();
  const agents = useStore((s) => s.agents);
  const [values, setValues] = useState<MissionValues>(() => (original === null ? emptyMissionValues(draft) : { name: original.name, goal: original.goal, lead: original.lead ?? '' }));
  const [problems, setProblems] = useState<Partial<Record<'name' | 'goal' | 'lead', string>>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const leads = list.filter((a) => a.provider === 'claude' || a.boss);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const found = validateMission(values, MISSION_NAME_MAX_CHARS, MISSION_GOAL_MAX_CHARS);
    setProblems(found);
    setTopError(null);
    if (found.name !== undefined) return void document.getElementById(`${id}-name`)?.focus();
    if (found.goal !== undefined) return void document.getElementById(`${id}-goal`)?.focus();
    setBusy(true);
    try {
      const saved =
        original === null
          ? await api.createMission({ name: values.name.trim(), goal: values.goal.trim(), ...(values.lead === '' ? {} : { lead: values.lead }) })
          : await api.updateMission(original.id, { name: values.name.trim(), goal: values.goal.trim(), lead: values.lead === '' ? null : values.lead });
      onDone(saved);
    } catch (e) {
      const field = (e as { field?: unknown }).field;
      if (field === 'name' || field === 'goal' || field === 'lead') {
        setProblems({ [field]: messageOf(e) });
        document.getElementById(`${id}-${field}`)?.focus();
      } else setTopError(messageOf(e));
      setBusy(false);
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) onDone(null);
  };
  return (
    <form className="mis-form module" aria-label={original === null ? 'New mission' : 'Edit mission'} noValidate onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown}>
      <h2 className="label">{original === null ? 'New mission' : `Edit ${original.id}`}</h2>
      <fieldset className="mis-fields" disabled={busy}>
        <div className="field" data-invalid={problems.name !== undefined ? '' : undefined}>
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            ref={first}
            className="input"
            value={values.name}
            maxLength={MISSION_NAME_MAX_CHARS}
            autoComplete="off"
            aria-invalid={problems.name !== undefined}
            aria-describedby={problems.name !== undefined ? `${id}-name-error` : undefined}
            onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          />
          {problems.name !== undefined && (
            <p className="error" id={`${id}-name-error`}>
              {problems.name}
            </p>
          )}
        </div>
        <div className="field" data-invalid={problems.goal !== undefined ? '' : undefined}>
          <label htmlFor={`${id}-goal`}>Goal</label>
          <textarea
            id={`${id}-goal`}
            className="textarea mis-goal-input"
            rows={4}
            value={values.goal}
            maxLength={MISSION_GOAL_MAX_CHARS}
            aria-invalid={problems.goal !== undefined}
            aria-describedby={`${id}-goal-hint${problems.goal !== undefined ? ` ${id}-goal-error` : ''}`}
            onChange={(e) => setValues((v) => ({ ...v, goal: e.target.value }))}
          />
          {problems.goal !== undefined && (
            <p className="error" id={`${id}-goal-error`}>
              {problems.goal}
            </p>
          )}
          <p className="hint" id={`${id}-goal-hint`}>
            What done means. FLIGHT gets this text when the mission starts.
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-lead`}>Lead</label>
          <select id={`${id}-lead`} className="input" value={values.lead} onChange={(e) => setValues((v) => ({ ...v, lead: e.target.value }))}>
            <option value="">{original === null ? 'FLIGHT, the boss' : 'Nobody'}</option>
            {leads.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
            {values.lead !== '' && !leads.some((a) => a.name === values.lead) && <option value={values.lead}>{`${values.lead} (${Object.hasOwn(agents, values.lead) ? 'cannot read mail' : 'not in the room'})`}</option>}
          </select>
        </div>
      </fieldset>
      {topError !== null && (
        <p className="error" role="alert">
          {topError}
        </p>
      )}
      <div className="mis-actions">
        <button type="submit" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined}>
          {busy ? 'Saving…' : original === null ? 'Make mission' : 'Save'}
        </button>
        <button type="button" className="btn" data-size="big" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Detail({ mission }: { mission: Mission }): ReactElement {
  const tasks = useStore((s) => s.tasks);
  const { busy, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement | null>(null);
  const taskSpend = useStore((s) => s.propellant.cost.tasks) ?? {};
  const linked = tasksOf(tasks, mission.id);
  const allLinks = useLinks();
  const incomingMission = incoming(allLinks, 'mission', mission.id);
  const missionLinks = [...outgoing(allLinks, 'mission', mission.id), ...(incomingMission === undefined ? [] : [incomingMission])];
  const progress = progressOf(tasks, mission.id);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  if (editing) return <MissionForm original={mission} draft={null} onDone={() => setEditing(false)} />;
  const open = (taskId: string): void => {
    showPlan();
    requestAnimationFrame(() => document.getElementById(cardId(taskId))?.focus());
  };
  return (
    <article className="mis-detail module" aria-label={`Mission ${mission.name}`}>
      <div className="mis-top">
        <span className="mis-id">{mission.id}</span>
        <Status mission={mission} />
        <span className="mis-progress" aria-label={`Tasks done: ${progress.text}`}>
          {progress.text}
        </span>
      </div>
      <h2 className="mis-name">{mission.name}</h2>
      <p className="hint">
        Lead {mission.lead ?? 'nobody'} · made by {mission.createdBy === 'user' ? 'the Director' : mission.createdBy}
      </p>
      <p className="mis-goal">{mission.goal === '' ? 'No goal written.' : mission.goal}</p>
      <LinkLines links={missionLinks} />
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="mis-keys" role="group" aria-label={`Change ${mission.name}`}>
        {actionsOf(mission.status).map((a) => (
          <button key={a.to} type="button" className="btn" data-kind={a.to === 'active' ? 'primary' : undefined} aria-disabled={busy || undefined} onClick={() => run(() => api.updateMission(mission.id, { status: a.to }))}>
            {a.label}
          </button>
        ))}
        <button type="button" className="btn" data-kind="quiet" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="btn" data-kind="quiet" aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
          Remove
        </button>
      </div>
      {confirming && (
        <section className="flood remove" data-tone="nogo" role="alertdialog" aria-label={`Remove ${mission.name}`}>
          <h3 className="disp">REMOVE {mission.name}?</h3>
          <p>{linked.length === 0 ? 'The mission goes. Nothing is linked to it.' : `The mission goes. Its ${linked.length} ${linked.length === 1 ? 'task stays' : 'tasks stay'} on the Flight Plan, no longer linked.`}</p>
          <div className="remove-buttons">
            <button type="button" ref={keep} className="btn" data-size="big" autoFocus onClick={() => setConfirming(false)}>
              KEEP IT
            </button>
            <button
              type="button"
              className="btn"
              data-kind="primary"
              data-size="big"
              aria-disabled={busy || undefined}
              onClick={() =>
                run(async () => {
                  await api.deleteMission(mission.id, linked.length > 0);
                  selectMission(null);
                })
              }
            >
              REMOVE
            </button>
          </div>
        </section>
      )}
      <Ritual mission={mission} />
      <MissionCost mission={mission} />
      <h3 className="label">TASKS</h3>
      {linked.length === 0 ? (
        <p className="hint">No task serves this mission yet. Link one from its card in the Flight Plan, or give a task this mission when you make it.</p>
      ) : (
        <ul className="mis-tasks">
          {linked.map((t) => (
            <li key={t.id}>
              <button type="button" className="btn mis-task" data-kind="quiet" aria-label={`Open ${t.id} in the Flight Plan: ${t.title}`} onClick={() => open(t.id)}>
                <span className="plan-id">{t.id}</span> <span className="chip" data-tone={t.status === 'done' ? 'quiet' : 'amber'}>{labelOf(t.status)}</span> {t.title}
                {spendText(taskSpend[t.id]) !== '' && <span className="hint"> · {spendText(taskSpend[t.id])}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <details className="plan-more">
        <summary>
          History <span className="plan-count">{mission.history.length}</span>
        </summary>
        <ol className="plan-notes">
          {mission.history.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      </details>
    </article>
  );
}

/** The view of the Patch Panel's Missions line. */
export function Missions(): ReactElement {
  const titleId = useId();
  const missions = useStore((s) => s.missions);
  const tasks = useStore((s) => s.tasks);
  const missionSpend = useStore((s) => s.propellant.cost.missions) ?? {};
  const selected = useStore((s) => s.selectedMission);
  const draft = useStore((s) => s.missionDraft);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const [creating, setCreating] = useState(draft !== null);
  const sorted = useMemo(() => sortMissions(missions), [missions]);
  // The page replaces the room: the keyboard starts at its title.
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (draft !== null) setCreating(true);
  }, [draft]);
  const current = selected === null ? null : (missions.find((m) => m.id === selected) ?? null);
  const done = (saved: Mission | null): void => {
    setCreating(false);
    if (saved !== null) selectMission(saved.id);
    else selectMission(selected);
    heading.current?.focus();
  };
  return (
    <section className="mis" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title mis-heading">
          MISSIONS
        </h1>
        <button type="button" className="btn" data-kind="primary" onClick={() => setCreating(true)}>
          New mission
        </button>
        {current !== null && (
          <button type="button" className="btn" data-kind="quiet" onClick={() => selectMission(null)}>
            All missions
          </button>
        )}
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      {creating && <MissionForm original={null} draft={draft} onDone={done} />}
      {current !== null && !creating && <Detail key={current.id} mission={current} />}
      {selected !== null && current === null && !creating && <p className="loop-empty">That mission is gone.</p>}
      {current === null && !creating && (
        <>
          {sorted.length === 0 ? (
            <p className="loop-empty">No missions yet. A mission names a goal, collects the tasks that serve it and keeps its own history. Make one, or ask FLIGHT to.</p>
          ) : (
            <ul className="mis-list">
              {sorted.map((m) => (
                <li key={m.id}>
                  <button type="button" className="mis-row module" aria-label={`${m.name}, ${STATUS_LABELS[m.status].toLowerCase()}, tasks ${progressOf(tasks, m.id).text}`} onClick={() => selectMission(m.id)}>
                    <Status mission={m} />
                    <span className="mis-row-name">{m.name}</span>
                    <span className="hint mis-row-lead">{m.lead ?? 'no lead'}</span>
                    <span className="mis-progress">{progressOf(tasks, m.id).text}</span>
                    {spendText(missionSpend[m.id]) !== '' && <span className="hint mis-row-cost">{spendText(missionSpend[m.id])}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
