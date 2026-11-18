import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, RefObject } from 'react';
import { MAX_AGENTS, SUBJECT_MAX_CHARS } from '../shared/protocol.js';
import * as api from './api.js';
import { legendsOf, seat } from './room.js';
import { useNow, useStore } from './store.js';
import {
  briefedText,
  clockText,
  fireTargets,
  gaugeSegments,
  legendOf,
  missionOf,
  noteLine,
  pollButtons,
  pollHeading,
  pollTargets,
  pollWord,
  sequenceLabel,
  sequenceSpans,
  stepLimit,
  voteChips,
} from './wall.js';
import { RoomFuel } from './Propellant.js';
import type { PollButton } from './wall.js';

const BUTTON_LABELS: Record<PollButton, string> = { poll: 'Poll the room', hold: 'Hold', abort: 'Abort', clear: 'Clear' };
const BUTTON_TITLES: Record<PollButton, string> = {
  poll: 'Ask every running Claude agent except FLIGHT for go or no-go',
  hold: 'Hold the poll',
  abort: 'Abort the poll and tell the agents to stand by',
  clear: 'Remove the poll from the wall',
};

/**
 * A disabled or removed button drops keyboard focus to <body>. If focus was inside the group and is lost on a render, put it
 * on the first enabled button of the group. Returns the props that track whether focus is in the group.
 */
function useKeepFocus(group: RefObject<HTMLElement | null>): { onFocus(): void; onBlur(e: { target: EventTarget }): void } {
  const inside = useRef(false);
  useLayoutEffect(() => {
    if (!inside.current || (document.activeElement !== document.body && document.activeElement !== null)) return;
    group.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  });
  return {
    onFocus: () => {
      inside.current = true;
    },
    // A button that is removed or disabled while focused may blur too; only a blur from a live, enabled button is the Director leaving.
    onBlur: (e) => {
      const t = e.target as HTMLButtonElement;
      if (t.isConnected && !t.disabled) inside.current = false;
    },
  };
}

/** Runs one request at a time and keeps its error for the block that started it. */
export function useRun(): { busy: boolean; error: string | null; run(action: () => Promise<unknown>): void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void action()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { busy, error, run };
}

/** The name of a module as printed on the panel: a letter, then the name. The letter is print, not a word. */
function Heading({ letter, children }: { letter: string; children: string }): ReactElement {
  return (
    <h2 className="label">
      <span className="label-letter" aria-hidden="true">
        {letter} ·{' '}
      </span>
      {children}
    </h2>
  );
}

function Mission(): ReactElement {
  const activity = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const now = useNow();
  const bossName = order.find((name) => Object.hasOwn(agents, name) && agents[name].boss) ?? null;
  const mission = useMemo(() => missionOf(activity, bossName), [activity, bossName]);
  return (
    <div className="wall-block wall-mission module">
      <Heading letter="A">MISSION</Heading>
      <div className="wall-lcd lcd">
        <p className="wall-mission-text">{mission === null ? 'Brief FLIGHT to start the clock.' : mission.text}</p>
        <span className="lcd-num wall-clock" data-ghost={mission === null} role="timer" aria-label="Mission elapsed">
          {clockText(mission === null ? 0 : now - mission.at)}
        </span>
      </div>
      <span className="label wall-clock-label">{mission === null ? 'NO MISSION YET' : `ELAPSED SINCE THE BRIEF · ${briefedText(mission.at)}`}</span>
    </div>
  );
}

function Sequence(): ReactElement {
  const order = useStore((s) => s.order);
  const agents = useStore((s) => s.agents);
  const now = useNow();
  const cells = useMemo(() => seat(order.flatMap((name) => (Object.hasOwn(agents, name) ? [agents[name]] : []))), [order, agents]);
  const legends = useMemo(() => legendsOf(cells), [cells]);
  const tracks = cells.flatMap((cell) => (cell.type === 'agent' ? [cell.agent] : []));
  return (
    <div className="wall-block wall-sequence module">
      <div className="wall-head">
        <Heading letter="B">SEQUENCE</Heading>
        <span className="seq-key">
          <span className="seq-swatch" data-kind="work" aria-hidden="true" />
          working
        </span>
        <span className="seq-key">
          <span className="seq-swatch" data-kind="needs" aria-hidden="true" />
          needs you
        </span>
      </div>
      <div className="seq-tracks" role="img" aria-label={sequenceLabel(tracks, legends, now)} data-dense={tracks.length > 10}>
        {tracks.map((agent) => (
          <div className="seq-row" key={agent.name}>
            <span className="seq-call">{legends[agent.name]}</span>
            <span className="seq-track">
              {sequenceSpans(agent, now).map((span, i) => (
                <span key={i} className="seq-span" data-kind={span.kind} style={{ left: `${span.from}%`, width: `${span.to - span.from}%` }} />
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="seq-axis" aria-hidden="true">
        <span>−10 m</span>
        <span>−5 m</span>
        <span>now</span>
      </div>
    </div>
  );
}

function TMinus(): ReactElement {
  const poll = useStore((s) => s.poll);
  const order = useStore((s) => s.order);
  const agents = useStore((s) => s.agents);
  const list = useMemo(() => order.flatMap((name) => (Object.hasOwn(agents, name) ? [agents[name]] : [])), [order, agents]);
  const legends = useMemo(() => legendsOf(seat(list)), [list]);
  const targets = useMemo(() => pollTargets(list), [list]);
  const crew = useMemo(() => fireTargets(list), [list]);
  const [subject, setSubject] = useState('');
  const { busy, error, run } = useRun();
  const actions = useRef<HTMLDivElement>(null);
  const keep = useKeepFocus(actions);
  const word = pollWord(poll);
  const legend = (agent: string): string => legendOf(legends, agent);
  const chips = voteChips(poll, targets, legends);
  const note = noteLine(poll, targets, legends);
  const nobody = poll === null && targets.length === 0;
  const act: Record<PollButton, () => void> = {
    poll: () => run(() => api.startPoll({})),
    hold: () => run(() => api.holdPoll()),
    abort: () => run(() => api.abortPoll()),
    clear: () => run(() => api.clearPoll()),
  };
  return (
    // A finished poll tints this module, not the whole wall.
    <div className={word.tone === 'none' ? 'wall-block wall-tminus module' : 'wall-block wall-tminus module flood'} data-tone={word.tone === 'none' ? undefined : word.tone}>
      <Heading letter="C">{pollHeading(poll)}</Heading>
      <p className="wall-word">
        <span className="disp" data-ghost={word.ghost}>
          {word.word}
        </span>
        {word.count !== null && <span className="lcd-num wall-count">{word.count}</span>}
      </p>
      <p className="wall-note" title={note}>
        {note}
      </p>
      {chips.length > 0 && (
        // Before a poll the READY keys would only repeat the room: they stay for the screen reader.
        <ul className={poll === null ? 'vote-chips sr-only' : 'vote-chips'} aria-label="Votes">
          {chips.map((chip) => (
            <li key={chip.agent} className="vote-chip" data-verdict={chip.verdict}>
              <span className="led" data-on={chip.verdict === 'GO' || chip.verdict === 'NO-GO'} data-blink={chip.verdict === 'WAIT'} aria-hidden="true" />
              <span className="vote-call">{legend(chip.agent)}</span> <span className="vote-verdict">{chip.verdict}</span>
            </li>
          ))}
        </ul>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="wall-actions" ref={actions} {...keep}>
        {pollButtons(poll).map((button) => (
          <button
            key={button}
            type="button"
            className="btn"
            data-kind={button === 'poll' || button === 'clear' ? 'primary' : button === 'abort' ? 'danger' : undefined}
            disabled={button === 'poll' && nobody}
            aria-disabled={busy || undefined}
            title={button === 'poll' && nobody ? 'There is nobody to poll: no running Claude agent besides FLIGHT' : BUTTON_TITLES[button]}
            onClick={act[button]}
          >
            {BUTTON_LABELS[button]}
          </button>
        ))}
      </div>
      {poll === null && (
        // Static fire: the same poll, asking SIMSUP to break the subject and RETRO to write its rollback.
        <form
          className="wall-fire"
          onSubmit={(event) => {
            event.preventDefault();
            if (crew.length > 0 && subject.trim() !== '') run(() => api.startPoll({ subject }).then(() => setSubject('')));
          }}
        >
          <input
            className="input"
            type="text"
            value={subject}
            maxLength={SUBJECT_MAX_CHARS - 'Static fire: '.length}
            autoComplete="off"
            aria-label="What to static fire"
            aria-describedby={crew.length === 0 ? 'wall-fire-why' : undefined}
            placeholder="What to test"
            onChange={(event) => setSubject(event.target.value)}
          />
          <button
            type="submit"
            className="btn"
            disabled={crew.length === 0}
            aria-disabled={busy || subject.trim() === '' || undefined}
            title={crew.length === 0 ? undefined : `Ask ${crew.map((a) => legend(a.name)).join(' and ')} to break it and plan the rollback`}
          >
            Static fire
          </button>
          {crew.length === 0 && (
            <p id="wall-fire-why" className="hint">
              Static fire needs a running SIMSUP or RETRO.
            </p>
          )}
        </form>
      )}
    </div>
  );
}

function MaxQ(): ReactElement {
  const governor = useStore((s) => s.governor);
  const { busy, error, run } = useRun();
  const gauge = gaugeSegments(governor);
  const minus = stepLimit(governor, 'minus');
  const plus = stepLimit(governor, 'plus');
  const stepper = useRef<HTMLDivElement>(null);
  const keep = useKeepFocus(stepper);
  const set = (limit: number | null): void => run(() => api.setGovernor({ limit }));
  return (
    <div className="wall-block wall-maxq module">
      <Heading letter="D">MAX Q</Heading>
      {/* The knob: a ring of work colour over the track, as far round as the agents working are of the limit (270 degrees is all of them). */}
      <div
        className="knob"
        role={gauge.total > 0 ? 'img' : undefined}
        aria-label={gauge.total > 0 ? `${governor.working} of ${governor.limit} Claude agents working${gauge.over ? ', over the limit' : ''}` : undefined}
        data-full={gauge.full}
        style={{ '--fill': `${gauge.total > 0 ? (gauge.filled / gauge.total) * 270 : 0}deg` } as CSSProperties}
      >
        <p className="lcd-num wall-limit">{governor.limit === null ? 'OFF' : <>{governor.working}<span>/{governor.limit}</span></>}</p>
      </div>
      <p className="wall-note wall-maxq-note">
        {governor.limit === null ? `No limit. ${governor.working} working.` : 'Claude agents working'}
        {governor.holding > 0 && ` · holding ${governor.holding}`}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="stepper" role="group" aria-label="Working limit" ref={stepper} {...keep}>
        <button type="button" className="btn" data-shape="round" disabled={minus === null} aria-disabled={busy || undefined} aria-label="Lower the limit" onClick={() => minus !== null && set(minus)}>
          −
        </button>
        <button
          type="button"
          className="btn"
          data-shape="round"
          disabled={plus === null}
          aria-disabled={busy || undefined}
          aria-label={governor.limit === null ? 'Set a limit' : 'Raise the limit'}
          title={plus === null ? `At most ${MAX_AGENTS}` : undefined}
          onClick={() => plus !== null && set(plus)}
        >
          +
        </button>
        <button type="button" className="btn stepper-off" data-kind="quiet" disabled={governor.limit === null} aria-disabled={busy || undefined} onClick={() => set(null)}>
          Off
        </button>
      </div>
    </div>
  );
}

function Propellant(): ReactElement {
  return (
    <div className="wall-block wall-fuel module">
      <Heading letter="F">PROPELLANT</Heading>
      <RoomFuel />
    </div>
  );
}

/** The wall: five modules, mission clock, sequence, T-minus, Max Q and Propellant. */
export function Wall(): ReactElement {
  return (
    <section className="wall" aria-label="The wall">
      <Mission />
      <Sequence />
      <TMinus />
      <MaxQ />
      <Propellant />
    </section>
  );
}
