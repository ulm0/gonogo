/**
 * Launch Window: the schedules that send a message by themselves on a cron rule. A list with the next fire of each, an
 * on switch, Run now, Edit and Delete, and a form whose rule field shows the next three fires as you type.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { BODY_MAX_CHARS, CRON_MAX_CHARS, SCHEDULE_NAME_MAX_CHARS, SCHEDULES_MAX } from '../shared/protocol.js';
import type { ScheduleView } from '../shared/protocol.js';
import * as api from './api.js';
import { emptyValues, FIELDS, lastText, nextText, previewOf, recipients, requestOf, toText, validate, valuesOf, zoneNote } from './launch.js';
import type { Field, Problems, Values } from './launch.js';
import { useAgentList } from './RoomView.js';
import { showRoom, useNow, useStore } from './store.js';
import { DockingPanel } from './DockingPanel.js';
import { RelayPanel } from './RelayPanel.js';
import { UplinkPanel } from './UplinkPanel.js';
import { useRun } from './WallView.js';
import './loop.css';
import './launch.css';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The zone of this browser; `fallback` when it cannot tell, which leaves no note. */
function browserZoneOf(fallback: string): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
}
const isField = (name: unknown): name is Field => typeof name === 'string' && (FIELDS as readonly string[]).includes(name);

function Editor({ schedule, onDone }: { schedule: ScheduleView | null; onDone(): void }): ReactElement {
  const id = useId();
  const list = useAgentList();
  const agents = useStore((s) => s.agents);
  const zone = useStore((s) => s.info?.timeZone ?? '');
  const now = useNow();
  const [values, setValues] = useState<Values>(() => (schedule === null ? emptyValues('boss') : valuesOf(schedule)));
  const [problems, setProblems] = useState<Problems>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => first.current?.focus(), []);

  const options = useMemo(() => recipients(list, agents, schedule?.to ?? null), [list, agents, schedule]);
  // The preview moves once a minute, not once a second.
  const minute = Math.floor(now / 60_000);
  const preview = useMemo(() => previewOf(values.rule, minute * 60_000), [values.rule, minute]);
  const note = zoneNote(zone, browserZoneOf(zone));

  const change = (patch: Partial<Values>, field?: Field): void => {
    setValues((v) => ({ ...v, ...patch }));
    if (field !== undefined) setProblems((p) => ({ ...p, [field]: undefined }));
  };
  const problemAt = (field: Field): string | undefined => problems[field];
  const describedBy = (field: Field, extra?: string): string | undefined => [extra, problemAt(field) !== undefined ? `${id}-${field}-error` : ''].filter(Boolean).join(' ') || undefined;

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
      if (schedule === null) await api.createSchedule(requestOf(values));
      else await api.updateSchedule(schedule.id, requestOf(values));
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

  const error = (field: Field): ReactElement | null => {
    const text = problemAt(field);
    return text === undefined ? null : (
      <p className="error" id={`${id}-${field}-error`}>
        {text}
      </p>
    );
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) onDone();
  };

  return (
    <form className="win-form module" aria-label={schedule === null ? 'New schedule' : `Edit ${schedule.name}`} noValidate onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown}>
      <h2 className="label">{schedule === null ? 'New schedule' : 'Edit schedule'}</h2>
      <fieldset className="win-fields" disabled={busy}>
        <div className="field" data-invalid={problemAt('name') !== undefined ? '' : undefined}>
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            ref={first}
            className="input"
            value={values.name}
            maxLength={SCHEDULE_NAME_MAX_CHARS}
            autoComplete="off"
            aria-invalid={problemAt('name') !== undefined}
            aria-describedby={describedBy('name')}
            onChange={(e) => change({ name: e.target.value }, 'name')}
          />
          {error('name')}
        </div>
        <div className="field">
          <label htmlFor={`${id}-to`}>Send to</label>
          <select id={`${id}-to`} className="input" value={values.to} aria-describedby={describedBy('to')} onChange={(e) => change({ to: e.target.value }, 'to')}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {error('to')}
        </div>
        <div className="field">
          <label htmlFor={`${id}-subject`}>Subject</label>
          <input
            id={`${id}-subject`}
            className="input"
            value={values.subject}
            autoComplete="off"
            aria-invalid={problemAt('subject') !== undefined}
            aria-describedby={describedBy('subject', `${id}-subject-hint`)}
            onChange={(e) => change({ subject: e.target.value }, 'subject')}
          />
          {error('subject')}
          <p className="hint" id={`${id}-subject-hint`}>
            The message arrives as “Launch Window: {values.name.trim() === '' ? 'name' : values.name.trim()}
            {values.subject.trim() === '' ? '' : `: ${values.subject.trim()}`}”.
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-body`}>Message</label>
          <textarea
            id={`${id}-body`}
            className="textarea win-body"
            rows={4}
            value={values.body}
            maxLength={BODY_MAX_CHARS}
            aria-invalid={problemAt('body') !== undefined}
            aria-describedby={describedBy('body')}
            onChange={(e) => change({ body: e.target.value }, 'body')}
          />
          {error('body')}
        </div>
        <div className="field">
          <label htmlFor={`${id}-rule`}>Rule</label>
          <input
            id={`${id}-rule`}
            className="input win-rule-input"
            value={values.rule}
            maxLength={CRON_MAX_CHARS}
            placeholder="0 9 * * mon-fri"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={problemAt('rule') !== undefined}
            aria-describedby={describedBy('rule', `${id}-rule-hint ${id}-rule-preview`)}
            onChange={(e) => change({ rule: e.target.value }, 'rule')}
          />
          {error('rule')}
          <p className="hint" id={`${id}-rule-hint`}>
            Five fields: minute, hour, day of month, month, day of week. Lists, ranges and steps work (*/15, 9-17, mon,wed); a day of week is 0 to 7 or a name. Both day fields set: either one fires.{' '}
            {note === null ? `Times are in the server’s time zone${zone === '' ? '' : ` (${zone})`}.` : `${note} A preview can be off by the difference.`}
          </p>
          <div id={`${id}-rule-preview`}>
            {preview.problem !== null && problemAt('rule') === undefined && <p className="hint win-problem">{preview.problem}</p>}
            {preview.times.length > 0 && (
              <>
                <p className="label">Next three</p>
                <ol className="win-times">
                  {preview.times.map((t) => (
                    <li key={t} className="lcd win-time">
                      {t}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </div>
        <div className="win-check">
          <input id={`${id}-enabled`} type="checkbox" checked={values.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
          <label htmlFor={`${id}-enabled`}>On: send it by itself</label>
        </div>
      </fieldset>
      {topError !== null && (
        <p className="error" role="alert">
          {topError}
        </p>
      )}
      <div className="win-actions">
        <button type="submit" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" data-size="big" data-kind="quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Row({ schedule, now, onEdit, onNotice }: { schedule: ScheduleView; now: number; onEdit(): void; onNotice(text: string): void }): ReactElement {
  const agents = useStore((s) => s.agents);
  const { busy, error, run } = useRun();
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement | null>(null);
  const del = useRef<HTMLButtonElement | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    // focus moves to Keep when it asks, and back to Delete when Keep closes the question
    if (confirming) keep.current?.focus();
    else if (asked.current) del.current?.focus();
    asked.current = confirming;
  }, [confirming]);
  const { name } = schedule;
  const off = !schedule.enabled;
  return (
    <li className="win-row" data-off={off ? '' : undefined}>
      <div className="win-main">
        <h3 className="win-name">{name}</h3>
        <p className="win-to">to {toText(schedule.to, agents)}</p>
        <p className="win-rule">{schedule.rule}</p>
      </div>
      <p className="lcd win-next" data-off={off ? '' : undefined}>
        <span className="sr-only">Next: </span>
        {nextText(schedule, now)}
      </p>
      <p className="win-last">{lastText(schedule)}</p>
      <div className="win-buttons">
        <label className="win-switch">
          <input
            type="checkbox"
            role="switch"
            checked={schedule.enabled}
            aria-label={`${name} enabled`}
            aria-disabled={busy || undefined}
            onChange={() => run(() => api.updateSchedule(schedule.id, { enabled: !schedule.enabled }))}
          />
          <span>Enabled</span>
        </label>
        <button
          type="button"
          className="btn"
          aria-label={`Run now: ${name}`}
          aria-disabled={busy || undefined}
          onClick={() => run(async () => onNotice(`${name}: ${(await api.runSchedule(schedule.id)).lastResult ?? 'sent'}`))}
        >
          Run now
        </button>
        <button type="button" className="btn" data-kind="quiet" aria-label={`Edit ${name}`} onClick={onEdit}>
          Edit
        </button>
        <button type="button" ref={del} className="btn" data-kind="danger" aria-label={`Delete ${name}`} aria-disabled={busy || undefined} onClick={() => setConfirming(true)}>
          Delete
        </button>
      </div>
      {confirming && (
        <div className="win-confirm flood" data-tone="nogo" role="group" aria-label={`Delete ${name}?`}>
          <p>
            <strong>Delete {name}?</strong> It will not send again.
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
              run(() => api.deleteSchedule(schedule.id));
            }}
          >
            Delete
          </button>
        </div>
      )}
      {error !== null && (
        <p className="error win-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** The view of the top bar's LAUNCH WINDOW key. */
export function LaunchWindow(): ReactElement {
  const titleId = useId();
  const schedules = useStore((s) => s.schedules);
  const zone = useStore((s) => s.info?.timeZone ?? '');
  const now = useNow();
  const note = zoneNote(zone, browserZoneOf(zone));
  /** 'new', the id of the schedule being edited, or nothing. */
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement | null>(null);
  // The page replaces the room: the keyboard starts at its title, not on a button that is gone.
  useEffect(() => heading.current?.focus(), []);
  const target = editing === null || editing === 'new' ? null : (schedules.find((s) => s.id === editing) ?? null);
  const open = editing === 'new' || target !== null;
  const done = (): void => {
    setEditing(null);
    heading.current?.focus();
  };
  return (
    <section className="win" aria-labelledby={titleId}>
      <header className="loop-head">
        <h1 id={titleId} ref={heading} tabIndex={-1} className="disp loop-title win-title">
          LAUNCH WINDOW
        </h1>
        <button type="button" className="btn" data-kind="primary" aria-disabled={schedules.length >= SCHEDULES_MAX || undefined} onClick={() => schedules.length < SCHEDULES_MAX && setEditing('new')}>
          New schedule
        </button>
        <button type="button" className="btn loop-room" data-kind="quiet" onClick={showRoom}>
          Room
        </button>
      </header>
      {zone !== '' && <p className="hint win-zone">{note ?? `Rules run in the server’s time zone: ${zone}.`}</p>}
      {open && <Editor key={editing} schedule={target} onDone={done} />}
      <div className="win-list module">
        {schedules.length === 0 ? (
          <p className="loop-empty">No schedules yet. A schedule sends a message by itself on a rule, for example every weekday at 09:00.</p>
        ) : (
          <ul className="win-rows">
            {schedules.map((s) => (
              <Row key={s.id} schedule={s} now={now} onEdit={() => setEditing(s.id)} onNotice={setNotice} />
            ))}
          </ul>
        )}
      </div>
      <UplinkPanel />
      <RelayPanel />
      <DockingPanel />
      <p className="sr-only" role="status">
        {notice}
      </p>
    </section>
  );
}
