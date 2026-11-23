import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactElement, RefObject } from 'react';
import type { AgentView, ReliefRequest, WorktreeStatus } from '../shared/protocol.js';
import { MAX_AGENTS } from '../shared/protocol.js';
import type { Position } from '../shared/positions.js';
import { ConsoleTraffic } from './Activity.js';
import { AgentFuel } from './Propellant.js';
import { Brief } from './Brief.js';
import { MassBudget } from './MassBudget.js';
import * as api from './api.js';
import {
  askDetail,
  askTitle,
  asksForGo,
  cellNumber,
  chipText,
  chipTone,
  cleanRoomPlace,
  subagentChip,
  subagentTypes,
  worktreePlace,
  consoleMode,
  consoleSubtitle,
  holdable,
  ledOf,
  legendsOf,
  needingYou,
  onHold,
  panelDetails,
  reasonText,
  seat,
  splitReason,
  staffedText,
  stateText,
  tileKind,
  tileLabel,
  tileLines,
  tripped,
  voteOf,
} from './room.js';
import type { Cell, TileKind } from './room.js';
import { HandoffNeed } from './HandoffAsks.js';
import { useHandoffAsks } from './linksData.js';
import { reliefFailure, reliefRows, reliefTitle, roleLabel } from './relief.js';
import { closeConsole, openConsole, openEdit, openHangar, openHire, openRecorder, showTraffic, useFeature, useNow, useStore } from './store.js';
import { TerminalPane } from './TerminalPane.js';
import { useRun } from './WallView.js';
import { DetailChips } from './DetailChips.js';
import { EditRoomKey } from './EditRoomKey.js';
import { LayoutPop } from './LayoutPop.js';
import { useRoomPrefs } from './roomPrefs.js';
import { TerminalBar } from './TerminalBar.js';
import { legendOf, sinceText } from './wall.js';
import { stoppedCardDetail } from './wording.js';
import { AgentTelemetry } from './TelemetryPanel.js';

/* ---- helpers ---- */

const PHONE_QUERY = '(max-width: 699px)';

function subscribePhone(onChange: () => void): () => void {
  const query = typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null;
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

/** A viewport under 700 px gets the phone layout: one column, a bottom bar, a console that opens full screen. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

/** The agents in room order. A stable array while neither the order nor the agents change. */
export function useAgentList(): AgentView[] {
  const order = useStore((s) => s.order);
  const agents = useStore((s) => s.agents);
  return useMemo(() => order.flatMap((name) => (Object.hasOwn(agents, name) ? [agents[name]] : [])), [order, agents]);
}

/** The seats of the room and the names they give. */
export function useSeats(): { cells: Cell[]; legends: ReturnType<typeof legendsOf> } {
  const list = useAgentList();
  const desks = useStore((s) => s.room.layout?.desks);
  const cells = useMemo(() => seat(list, desks), [list, desks]);
  return { cells, legends: useMemo(() => legendsOf(cells), [cells]) };
}

/** Picking a console is usually the first step of typing to it: on a wide page the terminal gets the keyboard. */
function pick(name: string, phone: boolean): void {
  openConsole(name);
  if (!phone) document.querySelector<HTMLElement>('.term-host textarea')?.focus();
}

/* ---- the matrix ---- */

/** The status light of a console: it takes its colour from the kind (or the tile it sits in). */
function Led({ kind }: { kind: TileKind }): ReactElement {
  const { on, blink } = ledOf(kind);
  return <span className="led" data-kind={kind} data-on={on} data-blink={blink} aria-hidden="true" />;
}

function Tile({ cell, selected, phone }: { cell: Cell; selected: boolean; phone: boolean }): ReactElement {
  const now = useNow();
  const poll = useStore((s) => s.poll);
  if (cell.type !== 'agent') {
    const open = cell.type === 'open';
    return (
      <button
        type="button"
        className="tile room-tile"
        data-kind="open"
        aria-label={tileLabel(cell, null)}
        onClick={() => openHire(open ? cell.position.id : null)}
      >
        <span className="tile-head">
          <Led kind="open" />
          <span className="tile-legend">{open ? cell.position.callSign : 'SPARE'}</span>
          <span className="tile-num" aria-hidden="true">
            {cellNumber(cell.n)}
          </span>
        </span>
        <span className="tile-lcd">
          <span className="tile-sub">{open ? cell.position.summary : 'Any agent or command'}</span>
        </span>
        <span className="tile-foot">
          <span className="tile-state">OPEN</span>
        </span>
      </button>
    );
  }
  const { agent, position } = cell;
  const vote = voteOf(poll, agent.name);
  const [first, second] = tileLines(agent, position);
  const right = vote ?? (agent.provider === 'custom' ? 'CUSTOM' : agent.held !== null ? `${agent.queued} HELD` : onHold(agent) ? 'ON HOLD' : '');
  return (
    <button
      type="button"
      className="tile room-tile"
      data-kind={tileKind(agent)}
      data-selected={selected || undefined}
      aria-current={selected ? 'true' : undefined}
      aria-label={tileLabel(cell, vote)}
      onClick={() => pick(agent.name, phone)}
    >
      <span className="tile-head">
        <Led kind={tileKind(agent)} />
        <span className="tile-legend">{cell.seated && position !== null ? position.callSign : agent.name.toUpperCase()}</span>
        <span className="tile-num" aria-hidden="true">
          {cellNumber(cell.n)}
        </span>
      </span>
      <span className="tile-lcd" aria-hidden="true">
        <span className="tile-sub">{first}</span>
        <span className="tile-sub">{second}</span>
      </span>
      <span className="tile-foot" aria-hidden="true">
        <span className="tile-state">{stateText(agent, now, !(phone && vote !== null))}</span>
        {vote !== null && <span className="tile-state tile-state-vote">· {vote}</span>}
        <StaleMark name={agent.name} />
        {right === '' && subagentChip(agent) !== '' ? (
          <span className="chip tile-right tile-chip" data-tone="amber">
            {subagentChip(agent)}
          </span>
        ) : right === '' && (agent.cleanRoom || agent.worktree) ? (
          <span className="chip tile-right tile-chip" data-tone="quiet">
            {agent.cleanRoom ? 'CLEAN ROOM' : 'WORKTREE'}
          </span>
        ) : (
          <span className="tile-state tile-right">{right}</span>
        )}
      </span>
    </button>
  );
}

/** Knowledge anchors: how many Mission Log entries anchored to this agent's repository were last found not confirmed. A count; nothing of the entries. */
function StaleMark({ name }: { name: string }): ReactElement | null {
  const stale = useStore((s) => s.knowledge[name] ?? 0);
  return stale > 0 ? <span className="tile-state tile-state-vote">· {stale} STALE</span> : null;
}

export function Operations({ phone }: { phone: boolean }): ReactElement {
  const { cells } = useSeats();
  const selected = useStore((s) => s.selected);
  const staffed = cells.filter((c) => c.type === 'agent').length;
  return (
    <section className="operations module" aria-label="Operations">
      <div className="operations-head">
        <h2 className="label">
          <span className="label-letter" aria-hidden="true">
            E ·{' '}
          </span>
          OPERATIONS
        </h2>
        <span className="hint">{staffedText(staffed)}</span>
        {!phone && <EditRoomKey />}
      </div>
      <div className="matrix">
        {cells.map((cell) => (
          <Tile
            key={cell.type === 'agent' ? `a:${cell.agent.name}` : cell.type === 'open' ? `p:${cell.position.id}` : 'spare'}
            cell={cell}
            selected={cell.type === 'agent' && cell.agent.name === selected}
            phone={phone}
          />
        ))}
      </div>
    </section>
  );
}

/* ---- your console: what needs the Director ---- */

function GoButtons({ agent, size }: { agent: AgentView; size: 'row' | 'phone' }): ReactElement {
  const { busy, error, run } = useRun();
  return (
    <>
      {error !== null && (
        <p className="error need-error" role="alert">
          {error}
        </p>
      )}
      <div className="go-buttons" data-size={size}>
        <button type="button" className="btn" data-kind="danger" data-size="big" aria-disabled={busy || undefined} onClick={() => run(() => api.answer(agent.name, false))}>
          NO-GO
        </button>
        <button type="button" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined} onClick={() => run(() => api.answer(agent.name, true))}>
          GO
        </button>
      </div>
    </>
  );
}

/** Redline: resume gives the agent its mail back, stop ends it. */
function RedlineButtons({ agent, size }: { agent: AgentView; size: 'row' | 'phone' }): ReactElement {
  const { busy, error, run } = useRun();
  return (
    <>
      {error !== null && (
        <p className="error need-error" role="alert">
          {error}
        </p>
      )}
      <div className="go-buttons" data-size={size}>
        <button type="button" className="btn" data-kind="danger" data-size={size === 'row' ? 'big' : undefined} aria-disabled={busy || undefined} onClick={() => run(() => api.stopAgent(agent.name))}>
          STOP
        </button>
        <button type="button" className="btn" data-kind="primary" data-size={size === 'row' ? 'big' : undefined} aria-disabled={busy || undefined} onClick={() => run(() => api.resume(agent.name))}>
          RESUME
        </button>
      </div>
    </>
  );
}

function Need({ agent, legend, phone }: { agent: AgentView; legend: string; phone: boolean }): ReactElement {
  const now = useNow();
  const ask = asksForGo(agent);
  return (
    <section className="flood need" data-tone="amber" aria-label={askTitle(agent, legend)}>
      <span className="led need-led" data-on="true" data-blink="true" aria-hidden="true" />
      <div className="need-text">
        <h3 className="disp need-title">{askTitle(agent, legend)}</h3>
        <p className="need-detail">{askDetail(agent, now)}</p>
      </div>
      {tripped(agent) ? (
        <RedlineButtons agent={agent} size={phone ? 'phone' : 'row'} />
      ) : ask && !phone ? (
        <GoButtons agent={agent} size="row" />
      ) : (
        <button type="button" className="btn" data-kind="primary" data-size={phone ? undefined : 'big'} onClick={() => pick(agent.name, phone)}>
          {phone ? (ask ? 'Answer' : 'Open') : 'Open the terminal'}
        </button>
      )}
    </section>
  );
}

/** Relief: the boss asks to hire. Every parameter is here, and GO is the only way the agent is hired. */
export function ReliefNeed({ request, legend, onFail }: { request: ReliefRequest; legend: string; onFail(text: string): void }): ReactElement {
  const now = useNow();
  const { busy, run } = useRun();
  const title = reliefTitle(request, legend);
  // the request leaves the list before the hire runs, so this block is gone when a GO fails: the failure is told by `Needs`, which stays
  const answer = (go: boolean): void => run(() => api.answerRelief(request.id, go).catch((e: unknown) => onFail(reliefFailure(request.name, go, e))));
  return (
    <section className="flood need relief-need" data-tone="amber" aria-label={title}>
      <span className="led need-led" data-on="true" data-blink="true" aria-hidden="true" />
      <div className="need-text">
        <h3 className="disp need-title">{title}</h3>
        <dl className="relief-rows">
          {reliefRows(request, now).map((row) => (
            <div key={row.label} className="relief-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="relief-role-label" id={`relief-role-${request.id}`}>
          {roleLabel(request)}
        </p>
        {/* the whole text, in a box that scrolls: the Director decides on what he can read */}
        <p className="relief-role" role="group" tabIndex={0} aria-labelledby={`relief-role-${request.id}`}>
          {request.role}
        </p>
      </div>
      <div className="go-buttons">
        <button type="button" className="btn" data-kind="danger" data-size="big" aria-disabled={busy || undefined} aria-label={`NO-GO: do not hire ${request.name}`} onClick={() => answer(false)}>
          NO-GO
        </button>
        <button type="button" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined} aria-label={`GO: hire ${request.name}`} onClick={() => answer(true)}>
          GO
        </button>
      </div>
    </section>
  );
}

/** One amber flood per console that needs the Director, then one per hire request that waits. Nothing is drawn when none does. */
export function Needs({ phone }: { phone: boolean }): ReactElement | null {
  const list = useAgentList();
  const { legends } = useSeats();
  const relief = useStore((s) => s.relief);
  const asks = useHandoffAsks();
  const [failed, setFailed] = useState<string | null>(null);
  const needing = needingYou(list);
  if (needing.length === 0 && relief.length === 0 && asks.length === 0 && failed === null) return null;
  return (
    // On a wide page the floods dock at the foot of the viewport while the matrix is on screen: the wall is tall and the floods sit below the matrix.
    <div className={phone ? 'needs' : 'needs needs-dock'}>
      {failed !== null && (
        <section className="flood need" data-tone="nogo" role="alert">
          <p className="need-text relief-failed">{failed}</p>
          <button type="button" className="btn" data-size="big" onClick={() => setFailed(null)}>
            DISMISS
          </button>
        </section>
      )}
      {needing.map((agent) => (
        <Need key={agent.name} agent={agent} legend={legendOf(legends, agent.name)} phone={phone} />
      ))}
      {relief.map((request) => (
        <ReliefNeed key={request.id} request={request} legend={legendOf(legends, request.by)} onFail={setFailed} />
      ))}
      {asks.map((ask) => (
        <HandoffNeed key={ask.id} ask={ask} legend="FLIGHT" />
      ))}
    </div>
  );
}

export function YourConsole(): ReactElement {
  const list = useAgentList();
  const boss = list.find((a) => a.boss) ?? null;
  return (
    <>
      <Needs phone={false} />
      <section className="your-console" aria-label="Your console">
        <Brief boss={boss} />
      </section>
    </>
  );
}

/* ---- the selected console ---- */

/** The row of actions of a console. START is a button of the foot of a stopped console, not of this row. */
function Actions({ agent, onRemove, removeRef, locked, run }: { agent: AgentView; onRemove(): void; removeRef: RefObject<HTMLButtonElement | null>; locked: boolean; run(action: () => Promise<unknown>): void }): ReactElement {
  const mode = consoleMode(agent);
  const hangarOn = useFeature('hangar');
  const recorderOn = useFeature('recorder');
  return (
    <div className="panel-actions">
      {holdable(agent) && (
        <button type="button" className="btn" data-kind="quiet" aria-disabled={locked || undefined} onClick={() => !locked && run(() => api.hold(agent.name))}>
          Hold
        </button>
      )}
      {mode !== 'stopped' && (
        <button type="button" className="btn" data-kind="quiet" aria-disabled={locked || undefined} onClick={() => !locked && run(() => api.restart(agent.name))}>
          Restart
        </button>
      )}
      {mode !== 'stopped' && mode !== 'starting' && (
        <button type="button" className="btn" data-kind="quiet" aria-disabled={locked || undefined} onClick={() => !locked && run(() => api.stopAgent(agent.name))}>
          Stop
        </button>
      )}
      <button type="button" className="btn" data-kind="quiet" aria-disabled={locked || undefined} onClick={() => !locked && openEdit(agent.name)}>
        Edit
      </button>
      {hangarOn && (
        <button type="button" className="btn" data-kind="quiet" onClick={() => openHangar(agent.name)}>
          Open files
        </button>
      )}
      {recorderOn && (
        <button type="button" className="btn" data-kind="quiet" onClick={() => openRecorder(agent.name)}>
          Open git
        </button>
      )}
      {!agent.boss && (
        <button type="button" className="btn" data-kind="danger" ref={removeRef} aria-disabled={locked || undefined} onClick={() => !locked && onRemove()}>
          Remove
        </button>
      )}
    </div>
  );
}

/** The foot under the terminal: what this state of the console asks of the Director. */
function Foot({ agent, run, locked }: { agent: AgentView; run(action: () => Promise<unknown>): void; locked: boolean }): ReactElement | null {
  const now = useNow();
  const mode = consoleMode(agent);
  if (mode === 'ask') {
    const { tool, detail } = splitReason(reasonText(agent));
    return (
      <div className="flood foot-ask" data-tone="amber">
        <h3 className="disp">
          <span className="led" data-on="true" data-blink="true" aria-hidden="true" />
          ASKS FOR A GO
        </h3>
        <p className="need-detail">{tool === null ? detail : `${tool} · ${detail}`}</p>
        <GoButtons agent={agent} size="row" />
      </div>
    );
  }
  if (mode === 'needs') {
    return (
      <div className="flood foot-ask" data-tone="amber">
        <h3 className="disp">
          <span className="led" data-on="true" data-blink="true" aria-hidden="true" />
          {onHold(agent) ? 'ON HOLD' : tripped(agent) ? 'HIT THE REDLINE' : 'NEEDS YOU'}
        </h3>
        <p className="need-detail">{askDetail(agent, now)}</p>
        {tripped(agent) ? <RedlineButtons agent={agent} size="row" /> : <p className="need-detail">Answer it in the terminal above.</p>}
      </div>
    );
  }
  if (mode === 'stopped') {
    const detail = stoppedCardDetail(agent.exit);
    return (
      <div className="foot">
        {detail !== null && <p className="foot-exit">{detail}</p>}
        <p className="hint">
          {agent.provider === 'custom'
            ? 'Start runs the command again.'
            : `Mail to a stopped console comes back to you undelivered. Start ${agent.provider === 'claude' ? 'picks up its last session' : 'opens a new session'}.`}
        </p>
        <button type="button" className="btn" data-kind="primary" data-size="big" aria-disabled={locked || undefined} onClick={() => !locked && run(() => api.restart(agent.name))}>
          Start
        </button>
      </div>
    );
  }
  if (mode === 'starting') {
    return (
      <div className="foot">
        <p className="hint">Mail waits until {agent.name} is idle. If Claude Code asks to trust the folder, it shows here as a go or no-go.</p>
        <button type="button" className="btn" data-kind="quiet" aria-disabled={locked || undefined} onClick={() => !locked && run(() => api.stopAgent(agent.name))}>
          Stop
        </button>
      </div>
    );
  }
  if (mode === 'custom') {
    return (
      <div className="foot">
        <code className="foot-command">{agent.command ?? ''}</code>
        <p className="hint">No hooks and no mail. Lit means it is printing. It takes no Max Q slot and is never polled.</p>
      </div>
    );
  }
  return null;
}

function Remove({ agent, legend, onKeep, onRemove, busy }: { agent: AgentView; legend: string; onKeep(): void; onRemove(deleteWorktree: boolean): void; busy: boolean }): ReactElement {
  const [deleteTree, setDeleteTree] = useState(false);
  return (
    <section className="flood remove" data-tone="nogo" role="alertdialog" aria-label={`Remove ${legend}`} aria-describedby={`remove-${agent.name}`}>
      <h3 className="disp">REMOVE {legend}?</h3>
      <p id={`remove-${agent.name}`}>The console and its session go. Its notes stay on disk until you delete them.</p>
      {agent.worktree && (
        <div className="staff-check">
          <input id={`remove-tree-${agent.name}`} type="checkbox" className="check" checked={deleteTree} onChange={(event) => setDeleteTree(event.target.checked)} />
          <label htmlFor={`remove-tree-${agent.name}`}>Also delete its worktree and branch (git keeps them when they hold unsaved or unmerged work)</label>
          {deleteTree && <p className="hint">Files that git ignores (.env, node_modules, build output) are deleted with the worktree.</p>}
        </div>
      )}
      <div className="remove-buttons">
        {/* autoFocus: the safe answer has the keyboard. */}
        <button type="button" className="btn" data-size="big" autoFocus onClick={onKeep}>
          KEEP {legend}
        </button>
        <button type="button" className="btn" data-kind="primary" data-size="big" aria-disabled={busy || undefined} onClick={() => onRemove(deleteTree)}>
          REMOVE
        </button>
      </div>
    </section>
  );
}

/** Clean Room: where the console works (its branch and its worktree) and how the work comes back. Nothing for a console on the host. */
function CleanRoomLine({ agent }: { agent: AgentView }): ReactElement | null {
  const home = useStore((s) => s.info?.home ?? '');
  const place = cleanRoomPlace(agent, home);
  if (place === null) return null;
  return (
    <p className="panel-clean">
      <span className="chip" data-tone="quiet">
        CLEAN ROOM
      </span>{' '}
      Branch <code>{place.branch}</code>, worktree <code>{place.worktree}</code>. Commit in the worktree, then merge the branch.
    </p>
  );
}

/** Subagents: the helpers this console has running now, by kind (docs/features/subagents.md). Nothing when there are none. */
function SubagentsLine({ agent }: { agent: AgentView }): ReactElement | null {
  if (subagentChip(agent) === '') return null;
  return (
    <p className="panel-clean">
      <span className="chip" data-tone="amber">
        {subagentChip(agent)}
      </span>{' '}
      {subagentTypes(agent)}. {agent.subagents?.started ?? 0} started since it began.
    </p>
  );
}

/** Worktree: where the console works, and what is in it (uncommitted changes, commits not merged). Nothing for a console without one. */
function WorktreeLine({ agent }: { agent: AgentView }): ReactElement | null {
  const home = useStore((s) => s.info?.home ?? '');
  const place = worktreePlace(agent, home);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  useEffect(() => {
    if (place === null) return;
    let live = true;
    api.worktreeStatus(agent.name).then((found) => live && setStatus(found), () => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [agent.name, place === null, agent.stateSince]);
  if (place === null) return null;
  const facts = status === null || !status.exists ? 'Not made yet: it is made when the console starts.' : `${status.dirty ? 'Unsaved changes' : 'Clean'}, ${status.ahead} ${status.ahead === 1 ? 'commit' : 'commits'} ahead${status.merged ? ', merged' : ''}.`;
  return (
    <p className="panel-clean">
      <span className="chip" data-tone="quiet">
        WORKTREE
      </span>{' '}
      Branch <code>{place.branch}</code>, worktree <code>{place.worktree}</code>. {facts}
    </p>
  );
}

function ConsolePanel({ agent, legend, position }: { agent: AgentView; legend: string; position: Position | null }): ReactElement {
  const massOn = useFeature('mass-budget');
  const telemetryOn = useFeature('telemetry');
  const now = useNow();
  const activity = useStore((s) => s.activity);
  const { busy, error, run } = useRun();
  const [confirming, setConfirming] = useState(false);
  const removeRef = useRef<HTMLButtonElement | null>(null);
  const mode = consoleMode(agent);
  const flooded = mode === 'ask' || mode === 'needs';
  const locked = busy || agent.transition !== null;
  const details = panelDetails(agent);
  const keep = (): void => {
    setConfirming(false);
    removeRef.current?.focus();
  };
  return (
    <aside className="panel module" aria-label="Selected console" data-mode={mode}>
      <header className="panel-head">
        <div className="panel-id">
          <div className="panel-title">
            <Led kind={tileKind(agent)} />
            <h2 className="panel-legend">{legend}</h2>
            <span className="chip" data-tone={chipTone(agent.state, flooded)}>
              {chipText(agent, now)}
            </span>
          </div>
          <span className="panel-sub">{consoleSubtitle(agent, position)}</span>
          <DetailChips agent={agent} />
        </div>
        <Actions agent={agent} onRemove={() => setConfirming(true)} removeRef={removeRef} locked={locked} run={run} />
      </header>
      {error !== null && (
        <p className="error panel-error" role="alert">
          {error}
        </p>
      )}
      {details.length > 0 && <p className="panel-details">{details.join(' · ')}</p>}
      <CleanRoomLine agent={agent} />
      <WorktreeLine agent={agent} />
      <SubagentsLine agent={agent} />
      {massOn && <MassBudget agent={agent} />}
      {confirming && (
        <Remove
          agent={agent}
          legend={legend}
          busy={busy}
          onKeep={keep}
          onRemove={(deleteWorktree) => {
            run(() => api.remove(agent.name, deleteWorktree));
            setConfirming(false);
          }}
        />
      )}
      <TerminalBar />
      <TerminalPane agent={agent} />
      <Foot agent={agent} run={run} locked={locked} />
      {agent.provider === 'claude' && (
        <details className="panel-fuel">
          <summary className="label">PROPELLANT</summary>
          <AgentFuel name={agent.name} />
        </details>
      )}
      {telemetryOn && <AgentTelemetry name={agent.name} />}
      <ConsoleTraffic items={activity} name={agent.name} onOpenLoop={() => showTraffic(agent.name)} />
    </aside>
  );
}

/** The right column of a wide page: the console that is selected. */
export function SelectedConsole(): ReactElement {
  const selected = useStore((s) => s.selected);
  const { cells, legends } = useSeats();
  const cell = cells.find((c) => c.type === 'agent' && c.agent.name === selected);
  if (cell === undefined || cell.type !== 'agent') {
    return (
      <aside className="panel module panel-empty" aria-label="Selected console">
        <TerminalPane agent={null} />
        <p className="hint">Pick a console in the room{cells.length - 1 < MAX_AGENTS ? ' or staff a new one' : ''}.</p>
      </aside>
    );
  }
  return <ConsolePanel key={cell.agent.name} agent={cell.agent} legend={legendOf(legends, cell.agent.name)} position={cell.position} />;
}

/* ---- phone: one console, full screen ---- */

const KEYS: ReadonlyArray<{ label: string; name: string | null; data: string; look?: 'danger' | 'primary' }> = [
  { label: 'esc', name: null, data: '\x1b' },
  { label: 'tab', name: null, data: '\t' },
  { label: '↑', name: 'Up', data: '\x1b[A' },
  { label: '↓', name: 'Down', data: '\x1b[B' },
  { label: '^C', name: 'Control C', data: '\x03', look: 'danger' },
  { label: '⏎', name: 'Enter', data: '\r', look: 'primary' },
];

function PhoneGo({ agent, legend, n, onTerminal }: { agent: AgentView; legend: string; n: number; onTerminal(): void }): ReactElement {
  const now = useNow();
  const { tool, detail } = splitReason(reasonText(agent));
  const { busy, error, run } = useRun();
  return (
    <div className="phone-go">
      <header className="phone-go-head">
        <button type="button" className="btn phone-back" data-kind="quiet" onClick={closeConsole}>
          ‹ Room
        </button>
        <span className="label">{`WAITING ${sinceText(now - agent.stateSince)}`}</span>
      </header>
      <section className="phone-go-card module" aria-label={`${legend} asks for a go`}>
        <p className="phone-go-call">
          <span className="led" data-on="true" data-blink="true" aria-hidden="true" />
          <span className="legend">{`${cellNumber(n)} · ${legend}`}</span>
        </p>
        <h1 className="disp phone-go-title">Asks for a go</h1>
        <div className="phone-go-what lcd">
          {tool !== null && <span className="phone-go-tool">{tool}</span>}
          <span className="phone-go-detail">{detail}</span>
          <span className="phone-go-dir">in {agent.dir}</span>
        </div>
        {agent.queued > 0 && (
          <p className="phone-go-held">
            {agent.queued} {agent.queued === 1 ? 'message' : 'messages'} for {legend} {agent.queued === 1 ? 'is' : 'are'} held until you answer.
          </p>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
      <div className="phone-go-buttons">
        <button type="button" className="btn phone-go-no" data-kind="danger" data-size="big" aria-disabled={busy || undefined} onClick={() => run(() => api.answer(agent.name, false))}>
          <span className="led" aria-hidden="true" />
          NO-GO
        </button>
        <button type="button" className="btn phone-go-yes" data-kind="primary" data-size="big" aria-disabled={busy || undefined} onClick={() => run(() => api.answer(agent.name, true))}>
          <span className="led" aria-hidden="true" />
          GO
        </button>
      </div>
      <button type="button" className="link phone-go-link" onClick={onTerminal}>
        Open the terminal
      </button>
    </div>
  );
}

function PhoneConsole({ agent, legend, position, n }: { agent: AgentView; legend: string; position: Position | null; n: number }): ReactElement {
  const massOn = useFeature('mass-budget');
  const telemetryOn = useFeature('telemetry');
  const now = useNow();
  const activity = useStore((s) => s.activity);
  const { busy, error, run } = useRun();
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState('');
  const removeRef = useRef<HTMLButtonElement | null>(null);
  const promptKey = `${agent.name}:${agent.stateSince}`;
  const live = agent.state !== 'stopped';
  const locked = busy || agent.transition !== null;

  if (asksForGo(agent) && terminalFor !== promptKey) return <PhoneGo agent={agent} legend={legend} n={n} onTerminal={() => setTerminalFor(promptKey)} />;

  const type = (event: FormEvent): void => {
    event.preventDefault();
    if (text === '' || !live) return;
    api.input(agent.name, text);
    setText('');
  };
  return (
    <div className="phone-console" data-mode={consoleMode(agent)}>
      <header className="phone-head">
        <button type="button" className="btn phone-back" data-kind="quiet" onClick={closeConsole}>
          ‹ Room
        </button>
        <Led kind={tileKind(agent)} />
        <h1 className="phone-legend">{legend}</h1>
        <span className="chip" data-tone={chipTone(agent.state, false)}>
          {chipText(agent, now)}
        </span>
      </header>
      <CleanRoomLine agent={agent} />
      <WorktreeLine agent={agent} />
      <SubagentsLine agent={agent} />
      <DetailChips agent={agent} />
      <div className="phone-sub">
        <span className="panel-sub">{consoleSubtitle(agent, position)}</span>
        <button type="button" className="btn" data-kind="quiet" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? 'Less' : 'More'}
        </button>
      </div>
      {more && <Actions agent={agent} onRemove={() => setConfirming(true)} removeRef={removeRef} locked={locked} run={run} />}
      {more && massOn && <MassBudget agent={agent} />}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirming && (
        <Remove
          agent={agent}
          legend={legend}
          busy={busy}
          onKeep={() => {
            setConfirming(false);
            removeRef.current?.focus();
          }}
          onRemove={(deleteWorktree) => {
            run(() => api.remove(agent.name, deleteWorktree).then(closeConsole));
            setConfirming(false);
          }}
        />
      )}
      <TerminalPane agent={agent} />
      <Foot agent={agent} run={run} locked={locked} />
      <div className="phone-traffic">
        {telemetryOn && <AgentTelemetry name={agent.name} />}
        <ConsoleTraffic items={activity} name={agent.name} onOpenLoop={() => showTraffic(agent.name)} />
      </div>
      <div className="phone-keys" role="group" aria-label="Terminal keys">
        {KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="btn phone-key"
            data-kind={key.look}
            aria-label={key.name ?? undefined}
            disabled={!live}
            onClick={() => api.input(agent.name, key.data)}
          >
            {key.label}
          </button>
        ))}
      </div>
      <form className="phone-type" onSubmit={type}>
        <label className="sr-only" htmlFor="phone-type">
          Type into the terminal of {legend}
        </label>
        <input id="phone-type" className="input" type="text" value={text} placeholder={`Type into ${legend}'s terminal`} disabled={!live} autoComplete="off" autoCapitalize="off" onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn" data-kind="quiet" disabled={!live}>
          Type
        </button>
      </form>
    </div>
  );
}

/** The phone's open console, full screen; null when none is open (or the one that was open is gone). */
export function PhoneConsoleScreen(): ReactElement | null {
  const selected = useStore((s) => s.selected);
  const { cells, legends } = useSeats();
  const cell = cells.find((c) => c.type === 'agent' && c.agent.name === selected);
  useEffect(() => {
    if (cell === undefined) closeConsole();
  }, [cell]);
  if (cell === undefined || cell.type !== 'agent') return null;
  return <PhoneConsole key={cell.agent.name} agent={cell.agent} legend={legendOf(legends, cell.agent.name)} position={cell.position} n={cell.n} />;
}

/* ---- the consoles, staffed first (the room view of docs/ui-semantic.md) ---- */

/** The seats nobody holds: one row of names (and a way to staff one), or on a phone one key. */
function OpenSeats({ cells, phone }: { cells: Cell[]; phone: boolean }): ReactElement {
  const shown = phone ? [] : cells.slice(0, 6);
  return (
    <div className="lay-open-seats" role="group" aria-label="Open seats">
      <span className="hint">{cells.length} open {cells.length === 1 ? 'seat' : 'seats'}</span>
      {shown.map((cell) => (cell.type === 'open' ? (
        <button key={cell.position.id} type="button" className="btn lay-seat" data-kind="quiet" aria-label={`Staff a console: ${cell.position.callSign}, ${cell.position.title}`} onClick={() => openHire(cell.position.id)}>
          {cell.position.callSign}
        </button>
      ) : null))}
      {!phone && cells.length > shown.length && <span className="hint">+{cells.length - shown.length} more</span>}
      <button type="button" className="btn" data-kind="quiet" onClick={() => openHire()}>
        Staff…
      </button>
    </div>
  );
}

/** CONSOLES: the agents that are staffed come first and big; an open seat is a name in a row, unless Layout asks for a tile each. */
export function Consoles({ phone }: { phone: boolean }): ReactElement {
  const { cells } = useSeats();
  const selected = useStore((s) => s.selected);
  const seats = useRoomPrefs((s) => s.seats);
  const staffed = cells.filter((c) => c.type === 'agent');
  const open = cells.filter((c) => c.type !== 'agent');
  const tiles = seats === 'tiles' ? cells : staffed;
  return (
    <section className="operations module lay-ops" aria-label="Consoles">
      <div className="lay-ops-head">
        <h2 className="label">CONSOLES</h2>
        <span className="hint">{phone ? `${staffed.length} staffed` : `${staffed.length} staffed · ${open.length} open ${open.length === 1 ? 'seat' : 'seats'}`}</span>
        <span className="topbar-grow" />
        <button type="button" className="btn" data-kind="primary" aria-label="Staff a console" onClick={() => openHire()}>
          {phone ? '+' : '+ Staff a console'}
        </button>
        <LayoutPop icon={phone} />
      </div>
      <div className="matrix lay-matrix">
        {tiles.map((cell) => (
          <Tile key={cell.type === 'agent' ? `a:${cell.agent.name}` : cell.type === 'open' ? `p:${cell.position.id}` : 'spare'} cell={cell} selected={cell.type === 'agent' && cell.agent.name === selected} phone={phone} />
        ))}
      </div>
      {seats === 'row' && open.length > 0 && <OpenSeats cells={open} phone={phone} />}
    </section>
  );
}

/** The consoles as a narrow column of names, while one console has the room. */
export function ConsoleRail(): ReactElement {
  const { cells, legends } = useSeats();
  const selected = useStore((s) => s.selected);
  return (
    <nav className="lay-rail module" aria-label="Consoles">
      <span className="label">CONSOLES</span>
      {cells.map((cell) =>
        cell.type === 'agent' ? (
          <button key={cell.agent.name} type="button" className="btn lay-rail-key" data-kind={cell.agent.name === selected ? 'primary' : 'quiet'} aria-current={cell.agent.name === selected ? 'true' : undefined} onClick={() => openConsole(cell.agent.name)}>
            <Led kind={tileKind(cell.agent)} />
            {legendOf(legends, cell.agent.name)}
          </button>
        ) : null,
      )}
    </nav>
  );
}
