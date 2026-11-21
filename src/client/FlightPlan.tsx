/**
 * Flight Plan: the task board. Five columns (stacked on a phone), a card for each task with the light and the call sign of
 * its assignee, keys that move it to another column, a select that gives it to an agent, and a form that makes one. No
 * drag and drop: every action is a key or a select that the keyboard and a screen reader reach.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { TASK_DETAIL_MAX_CHARS, TASK_TITLE_MAX_CHARS, TASKS_OPEN_MAX } from '../shared/protocol.js';
import type { Task, TaskStatus } from '../shared/protocol.js';
import * as api from './api.js';
import { HandOff } from './DockingPanel.js';
import { missionOptions, nameOf } from './missionsModel.js';
import { canHandOff } from './docking.js';
import { assigneeText, assignees, cardId, columnsOf, COLUMNS, emptyValues, FIELDS, labelOf, ledKindOf, requestOf, validate } from './plan.js';
import type { Field, Problems, Values } from './plan.js';
import { useAgentList } from './RoomView.js';
import { selectMission, showMissions, showRoom, useStore } from './store.js';
import { useRun } from './WallView.js';
import './loop.css';
import './plan.css';
import './docking.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isField = (name: unknown): name is Field => typeof name === 'string' && (FIELDS as readonly string[]).includes(name);

function TaskForm({ onDone }: { onDone(): void }): ReactElement {
  const id = useId();
  const list = useAgentList();
  const agents = useStore((s) => s.agents);
  const [values, setValues] = useState<Values>(emptyValues);
  const [problems, setProblems] = useState<Problems>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const options = useMemo(() => assignees(list, agents, null), [list, agents]);
  const missions = useStore((s) => s.missions);
  const missionChoices = useMemo(() => missionOptions(missions, null), [missions]);

  const change = (patch: Partial<Values>, field: Field): void => {
    setValues((v) => ({ ...v, ...patch }));
    setProblems((p) => ({ ...p, [field]: undefined }));
  };
  const describedBy = (field: Field): string | undefined => (problems[field] !== undefined ? `${id}-${field}-error` : undefined);
  const error = (field: Field): ReactElement | null => {
    const text = problems[field];
    return text === undefined ? null : (
      <p className="error" id={`${id}-${field}-error`}>
        {text}
      </p>
    );
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const found = validate(values);
    setProblems(found);
    setTopError(null);
    const bad = FIELDS.find((f) => found[f] !== undefined);
    if (bad !== undefined) {
      document.getElementById(`${id}-${bad}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.createTask(requestOf(values));
      onDone();
    } catch (e) {
      const field = (e as { field?: unknown }).field;
      if (isField(field)) {
        setProblems({ [field]: messageOf(e) });
        document.getElementById(`${id}-${field}`)?.focus();
      } else setTopError(messageOf(e));
      setBusy(false);
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) onDone();
  };

  return (
    <form className="plan-form module" aria-label="New task" noValidate onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown}>
      <h2 className="label">New task</h2>
      <fieldset className="plan-fields" disabled={busy}>
        <div className="field" data-invalid={problems.title !== undefined ? '' : undefined}>
          <label htmlFor={`${id}-title`}>Title</label>
          <input
            id={`${id}-title`}
            ref={first}
            className="input"
            value={values.title}
            maxLength={TASK_TITLE_MAX_CHARS}
            autoComplete="off"
            aria-invalid={problems.title !== undefined}
            aria-describedby={describedBy('title')}
            onChange={(e) => change({ title: e.target.value }, 'title')}
          />
          {error('title')}
        </div>
        <div className="field">
          <label htmlFor={`${id}-detail`}>Detail</label>
          <textarea
            id={`${id}-detail`}
            className="textarea plan-detail-input"
            rows={4}
            value={values.detail}
            maxLength={TASK_DETAIL_MAX_CHARS}
            aria-invalid={problems.detail !== undefined}
            aria-describedby={[`${id}-detail-hint`, describedBy('detail')].filter(Boolean).join(' ')}
            onChange={(e) => change({ detail: e.target.value }, 'detail')}
          />
          {error('detail')}
          <p className="hint" id={`${id}-detail-hint`}>
            What done means. The agent it is given to gets this text in a message.
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-assignee`}>Give it to</label>
          <select id={`${id}-assignee`} className="input" value={values.assignee} aria-describedby={describedBy('assignee')} onChange={(e) => change({ assignee: e.target.value }, 'assignee')}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {error('assignee')}
        </div>
        {missions.length > 0 && (
          <div className="field">
            <label htmlFor={`${id}-missionId`}>Mission</label>
            <select id={`${id}-missionId`} className="input" value={values.missionId} aria-describedby={describedBy('missionId')} onChange={(e) => change({ missionId: e.target.value }, 'missionId')}>
              {missionChoices.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {error('missionId')}
          </div>
        )}
      </fieldset>
      {topError !== null && (
        <p className="error" role="alert">
          {topError}
        </p>
      )}
      <div className="plan-actions">
        <button type="submit" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined}>
          {busy ? 'Adding…' : 'Add task'}
        </button>
        <button type="button" className="btn" data-size="big" data-kind="quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface CardProps {
  task: Task;
  /** The card is about to move to this column: the board puts the keyboard on it again once it is there. */
  willMove(move: { id: string; status: TaskStatus } | null): void;
  onNotice(text: string): void;
}

function Card({ task, willMove, onNotice }: CardProps): ReactElement {
  const id = useId();
  const list = useAgentList();
  const agents = useStore((s) => s.agents);
  const { busy, error, run } = useRun();
  const docks = useStore((s) => s.docking.docks);
  const [confirming, setConfirming] = useState(false);
  const [handing, setHanding] = useState(false);
  const keep = useRef<HTMLButtonElement | null>(null);
  const del = useRef<HTMLButtonElement | null>(null);
  const hand = useRef<HTMLButtonElement | null>(null);
  const asked = useRef(false);
  const handAsked = useRef(false);
  useEffect(() => {
    // focus moves to Keep when it asks, and back to Remove when Keep closes the question
    if (confirming) keep.current?.focus();
    else if (asked.current) del.current?.focus();
    asked.current = confirming;
  }, [confirming]);
  useEffect(() => {
    // focus goes back to Hand off when the form is cancelled
    if (!handing && handAsked.current) hand.current?.focus();
    handAsked.current = handing;
  }, [handing]);
  const options = useMemo(() => assignees(list, agents, task.assignee), [list, agents, task.assignee]);
  const missions = useStore((s) => s.missions);
  const missionChoices = useMemo(() => missionOptions(missions, task.missionId ?? null), [missions, task.missionId]);
  const led = ledKindOf(task, agents);
  const who = assigneeText(task, agents);

  const move = (status: TaskStatus): void =>
    run(async () => {
      willMove({ id: task.id, status });
      try {
        await api.updateTask(task.id, { status });
        onNotice(`${task.id} moved to ${labelOf(status)}`);
      } catch (e) {
        willMove(null);
        throw e;
      }
    });

  return (
    <li>
      <article className="plan-card" id={cardId(task.id)} tabIndex={-1} aria-labelledby={`${id}-title`}>
        <div className="plan-top">
          <span className="plan-id">{task.id}</span>
          <span className="plan-who">
            <span className="led" data-kind={led.kind} data-on={led.on} data-blink={led.blink} aria-hidden="true" />
            <span className="legend">{who}</span>
          </span>
        </div>
        <h3 className="plan-title" id={`${id}-title`}>
          {task.title}
        </h3>
        {task.missionId !== undefined && (
          <button type="button" className="chip plan-mission" data-tone="quiet" aria-label={`Mission ${nameOf(missions, task.missionId)}: open it`} onClick={() => { selectMission(task.missionId ?? null); showMissions(); }}>
            {nameOf(missions, task.missionId)}
          </button>
        )}
        {task.handedOff !== undefined && (
          <span className="chip dk-handed" data-tone="quiet">
            HANDED OFF · {task.handedOff}
          </span>
        )}
        <details className="plan-more">
          <summary>
            Detail and history <span className="plan-count">{task.notes.length}</span>
          </summary>
          {task.detail !== '' && <p className="plan-detail">{task.detail}</p>}
          <p className="hint">Made by {task.createdBy === 'user' ? 'the Director' : task.createdBy}.</p>
          <ol className="plan-notes">
            {task.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ol>
        </details>
        <div className="plan-moves" role="group" aria-label={`Move ${task.id}`}>
          {COLUMNS.filter((c) => c.status !== task.status).map((c) => (
            <button key={c.status} type="button" className="btn" aria-label={`Move ${task.id} to ${c.label.toLowerCase()}`} aria-disabled={busy || undefined} onClick={() => move(c.status)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="field plan-assign">
          <label htmlFor={`${id}-assign`}>Give it to</label>
          <select
            id={`${id}-assign`}
            className="input"
            aria-label={`Give it to (${task.id})`}
            value={task.assignee ?? ''}
            aria-disabled={busy || undefined}
            onChange={(e) => {
              const assignee = e.target.value === '' ? null : e.target.value;
              run(async () => {
                await api.updateTask(task.id, { assignee });
                onNotice(`${task.id} ${assignee === null ? 'is not given to anyone' : `given to ${assignee}`}`);
              });
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {(missions.length > 0 || task.missionId !== undefined) && (
          <div className="field plan-assign">
            <label htmlFor={`${id}-mission`}>Mission</label>
            <select
              id={`${id}-mission`}
              className="input"
              aria-label={`Mission (${task.id})`}
              value={task.missionId ?? ''}
              aria-disabled={busy || undefined}
              onChange={(e) => {
                const missionId = e.target.value === '' ? null : e.target.value;
                run(async () => {
                  await api.updateTask(task.id, { missionId });
                  onNotice(`${task.id} ${missionId === null ? 'is not in a mission' : `is in mission ${nameOf(missions, missionId)}`}`);
                });
              }}
            >
              {missionChoices.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {canHandOff(task, docks) &&
          (handing ? (
            <HandOff task={task} willMove={willMove} onNotice={onNotice} onClose={() => setHanding(false)} />
          ) : (
            <button type="button" ref={hand} className="btn" aria-label={`Hand off ${task.id} to another station`} aria-disabled={busy || undefined} onClick={() => setHanding(true)}>
              Hand off
            </button>
          ))}
        {confirming ? (
          <div className="plan-confirm flood" data-tone="nogo" role="group" aria-label={`Remove ${task.id}?`}>
            <p>
              <strong>Remove {task.id}?</strong> Its history goes with it.
            </p>
            <button type="button" className="btn" ref={keep} onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button
              type="button"
              className="btn"
              data-kind="primary"
              aria-disabled={busy || undefined}
              onClick={() => {
                setConfirming(false);
                run(() => api.deleteTask(task.id));
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <button type="button" ref={del} className="btn plan-remove" data-kind="danger" aria-label={`Remove ${task.id}`} aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </article>
    </li>
  );
}

/** The view of the top bar's FLIGHT PLAN key. */
export function FlightPlan(): ReactElement {
  const titleId = useId();
  const tasks = useStore((s) => s.tasks);
  const columns = useMemo(() => columnsOf(tasks), [tasks]);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement | null>(null);
  const expected = useRef<{ id: string; status: TaskStatus } | null>(null);
  // The page replaces the room: the keyboard starts at its title, not on a button that is gone.
  useEffect(() => heading.current?.focus(), []);
  // A card that moved is a new element in another column and the key that moved it is gone: the keyboard follows it.
  useEffect(() => {
    const move = expected.current;
    if (move === null || tasks.find((t) => t.id === move.id)?.status !== move.status) return;
    expected.current = null;
    document.getElementById(cardId(move.id))?.focus();
  });
  const full = tasks.filter((t) => t.status !== 'done').length >= TASKS_OPEN_MAX;
  const done = (): void => {
    setCreating(false);
    heading.current?.focus();
  };
  return (
    <section className="plan" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title plan-heading">
          FLIGHT PLAN
        </h1>
        <button type="button" className="btn" data-kind="primary" aria-disabled={full || undefined} onClick={() => !full && setCreating(true)}>
          New task
        </button>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      {full && <p className="hint">The board holds {TASKS_OPEN_MAX} open tasks. Finish or remove one to add another.</p>}
      {creating && <TaskForm onDone={done} />}
      {tasks.length === 0 && !creating && <p className="loop-empty">No tasks yet. Add one, give it to an agent, and the agent moves it along: todo, doing, review, done.</p>}
      <div className="plan-board">
        {COLUMNS.map(({ status, label }) => {
          const cards = columns[status];
          return (
            <section key={status} className="plan-col module" aria-labelledby={`${titleId}-${status}`}>
              <h2 className="label plan-col-head" id={`${titleId}-${status}`}>
                {label} <span className="plan-n">{cards.length}</span>
              </h2>
              {cards.length === 0 ? (
                <p className="hint plan-none">Nothing here.</p>
              ) : (
                <ul className="plan-cards">
                  {cards.map((t) => (
                    <Card
                      key={t.id}
                      task={t}
                      willMove={(move) => {
                        expected.current = move;
                      }}
                      onNotice={setNotice}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <p className="sr-only" role="status">
        {notice}
      </p>
    </section>
  );
}
