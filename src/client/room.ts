import type { AgentState, AgentView, PollView } from '../shared/protocol.js';
import { CLEAN_ROOM_DIR, cleanRoomBranch, HOLD_REASON, MAX_AGENTS, providerInfo, STATE_LABELS } from '../shared/protocol.js';
import { POSITIONS, positionById } from '../shared/positions.js';
import type { Position } from '../shared/positions.js';
import { sinceText } from './wall.js';
import type { Legends } from './wall.js';

// Pure logic of the room (the matrix of consoles, the console panel, the needs-you floods and the live region), kept out of Room.tsx so that it can be tested without a DOM.

/* ---- seating ---- */

export type Cell =
  | { type: 'agent'; n: number; agent: AgentView; position: Position | null; /** in the cell of its own position */ seated: boolean }
  | { type: 'open'; n: number; position: Position }
  | { type: 'spare'; n: number };

/**
 * The fixed matrix. Cells 1 to 15 are the positions in their order; an agent with a position sits there, the oldest desk
 * when several share one. Everyone else (no position, a duplicate, a custom command) follows in desk order, then one SPARE
 * open cell while the room has room.
 */
export function seat(agents: readonly AgentView[]): Cell[] {
  const sorted = [...agents].sort((a, b) => a.desk - b.desk || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const taken = new Map<string, AgentView>();
  for (const agent of sorted) {
    if (agent.position !== null && positionById(agent.position) !== null && !taken.has(agent.position)) taken.set(agent.position, agent);
  }
  const cells: Cell[] = POSITIONS.map((position, i) => {
    const agent = taken.get(position.id);
    return agent === undefined ? { type: 'open', n: i + 1, position } : { type: 'agent', n: i + 1, agent, position, seated: true };
  });
  const seated = new Set(taken.values());
  for (const agent of sorted) {
    if (!seated.has(agent)) cells.push({ type: 'agent', n: cells.length + 1, agent, position: positionById(agent.position), seated: false });
  }
  if (agents.length < MAX_AGENTS) cells.push({ type: 'spare', n: cells.length + 1 });
  return cells;
}

/** Names to what the room calls them: the call sign for a seated agent, else the name in capitals. */
export function legendsOf(cells: readonly Cell[]): Legends {
  const legends: Record<string, string> = Object.create(null);
  for (const cell of cells) if (cell.type === 'agent') legends[cell.agent.name] = cell.seated && cell.position !== null ? cell.position.callSign : cell.agent.name.toUpperCase();
  return legends;
}

/* ---- a tile ---- */

/** The look of a tile: the `data-kind` of primitives.css, plus `idle` (the unlit default). */
export type TileKind = 'working' | 'needs' | 'idle' | 'starting' | 'stopped' | 'open';

export function tileKind(agent: AgentView): TileKind {
  switch (agent.state) {
    case 'working':
      return 'working';
    case 'needs_you':
      return 'needs';
    case 'starting':
      return 'starting';
    case 'stopped':
      return 'stopped';
    default:
      return 'idle';
  }
}

/** The LED of a console: it glows and breathes while it works or needs the Director, and only breathes while it starts. */
export function ledOf(kind: TileKind): { on: boolean; blink: boolean } {
  const lit = kind === 'working' || kind === 'needs';
  return { on: lit, blink: lit || kind === 'starting' };
}

/** The cell number as printed on the panel: `01` to `24`. */
export const cellNumber = (n: number): string => String(n).padStart(2, '0');

const TRANSITION_WORDS ={ stopping: 'STOPPING', restarting: 'RESTARTING', removing: 'REMOVING' } as const;

/** `WORKING 38 S`, `NEEDS YOU 3 M`, `PRINTING` for a custom command that prints, `STOPPING` while a transition runs. */
export function stateText(agent: AgentView, now: number, timed = true): string {
  if (agent.transition !== null) return TRANSITION_WORDS[agent.transition];
  if (agent.provider === 'custom' && agent.state === 'working') return 'PRINTING';
  const label = STATE_LABELS[agent.state].toUpperCase();
  // A phone tile with a vote has no room for the time.
  return timed ? `${label} ${sinceText(now - agent.stateSince).toUpperCase()}` : label;
}

const PERMISSION_PREFIX = 'permission request: ';

/** What the agent needs, without the hub's `permission request: ` prefix. */
export function reasonText(agent: AgentView): string | null {
  const reason = agent.needsReason;
  if (reason === null) return null;
  return reason.startsWith(PERMISSION_PREFIX) ? reason.slice(PERMISSION_PREFIX.length) : reason;
}

const waitingText = (n: number): string => `${n} waiting`;

/** The first of: what it needs, what holds its mail, how it ended, how many messages wait, what its position does. */
export function secondLine(agent: AgentView, position: Position | null): string {
  if (agent.state === 'needs_you' && reasonText(agent) !== null) return reasonText(agent) ?? '';
  if (agent.held !== null) return agent.held.text;
  if (agent.exit !== null && agent.exit.text !== '') return agent.exit.text;
  if (agent.queued > 0) return waitingText(agent.queued);
  if (agent.provider === 'custom') return agent.command ?? '';
  return position?.summary ?? agent.role.split('\n')[0] ?? '';
}

/** `mcp__gonogo__read_messages` reads as `read_messages`, another server's tool as `server: tool`; the rest is unchanged. */
export function toolText(doing: string): string {
  return doing.replace(/^mcp__gonogo__/, '').replace(/^mcp__([^_:\s]+(?:_[^_:\s]+)*)__/, '$1: ');
}

/** Two lines of a tile: what it does, then why it matters. An agent that has not used a tool yet puts the second line first, so the tile has no hole. */
export function tileLines(agent: AgentView, position: Position | null): [string, string] {
  const second = secondLine(agent, position);
  // The server keeps `doing` until the next spawn; on a stopped console it is stale.
  const doing = agent.provider === 'custom' || agent.state === 'stopped' ? null : agent.doing;
  if (doing === null || doing === '') return [second, ''];
  const shown = toolText(doing);
  // A permission prompt names the same tool call as `doing`: say it once.
  return shown === second || doing === second ? [shown, ''] : [shown, second];
}

export type Vote = 'GO' | 'NO-GO' | 'WAIT';

/** The vote chip of an agent while a poll runs (not after it is aborted). */
export function voteOf(poll: PollView | null, name: string): Vote | null {
  if (poll === null || poll.status === 'aborted') return null;
  const entry = poll.entries.find((e) => e.agent === name);
  if (entry === undefined) return null;
  return entry.vote === 'go' ? 'GO' : entry.vote === 'no-go' ? 'NO-GO' : 'WAIT';
}

/** The accessible name of a tile: who, which position, what state, what it needs. The time in state is left out: a screen reader would not hear it tick. */
export function tileLabel(cell: Cell, vote: Vote | null): string {
  if (cell.type === 'open') return `Staff a console: ${cell.position.callSign}, ${cell.position.title}`;
  if (cell.type === 'spare') return 'Staff a console with no position';
  const { agent, position } = cell;
  const state = agent.transition ?? (agent.provider === 'custom' && agent.state === 'working' ? 'printing' : STATE_LABELS[agent.state]);
  const engine = agent.provider === 'claude' ? '' : `, ${providerInfo(agent.provider).label.toLowerCase()}`;
  let label = `${agent.name}${agent.boss ? ' (boss)' : ''}${position === null ? '' : `, ${position.title}`}${engine}, ${state}`;
  const reason = reasonText(agent);
  if (reason !== null) label += `: ${reason}`;
  if (agent.cleanRoom) label += ', clean room';
  if (agent.queued > 0) label += `, ${agent.queued} ${agent.queued === 1 ? 'message' : 'messages'} waiting`;
  if (agent.held !== null) label += `, ${agent.held.text}`;
  if (vote !== null) label += `, vote ${vote.toLowerCase()}`;
  return label;
}

/* ---- the Director's console ---- */

/** Consoles that need the Director, in room order. */
export const needingYou = (agents: readonly AgentView[]): AgentView[] => agents.filter((a) => a.state === 'needs_you');

export const asksForGo = (agent: AgentView): boolean => agent.state === 'needs_you' && agent.needsKind === 'permission' && agent.transition === null;

/** Redline stopped this agent: the Director resumes it or stops it. */
export const tripped = (agent: AgentView): boolean => agent.state === 'needs_you' && agent.needsKind === 'redline' && agent.transition === null;

/** Hold: the Director put this agent on hold (a Redline trip by hand); RESUME ends it. */
export const onHold = (agent: AgentView): boolean => tripped(agent) && agent.needsReason === HOLD_REASON;

/** Hold is offered while an agent with hooks runs and is not already held or tripped. */
export const holdable = (agent: AgentView): boolean =>
  providerInfo(agent.provider).hooks && agent.transition === null && (agent.state === 'idle' || agent.state === 'working');

/** `SURGEON ASKS FOR A GO`, `SURGEON IS ON HOLD`, `SURGEON HIT THE REDLINE`, or `SURGEON NEEDS YOU` for anything else. */
export const askTitle = (agent: AgentView, legend: string): string =>
  asksForGo(agent) ? `${legend} ASKS FOR A GO` : onHold(agent) ? `${legend} IS ON HOLD` : tripped(agent) ? `${legend} HIT THE REDLINE` : `${legend} NEEDS YOU`;

/** The line under the title: the reason, how long it waits, how many messages wait for the answer. */
export function askDetail(agent: AgentView, now: number): string {
  const parts = [reasonText(agent) ?? 'Answer it in the terminal', `waiting ${sinceText(now - agent.stateSince)}`];
  if (agent.queued > 0) parts.push(`${agent.queued} ${agent.queued === 1 ? 'message' : 'messages'} waiting`);
  return parts.join(' · ');
}

/** `Bash: npm test` to the tool and what it runs; a reason without a tool has none. */
export function splitReason(reason: string | null): { tool: string | null; detail: string } {
  if (reason === null) return { tool: null, detail: '' };
  const at = reason.indexOf(': ');
  return at > 0 && at <= 24 ? { tool: reason.slice(0, at), detail: reason.slice(at + 2) } : { tool: null, detail: reason };
}

/* ---- the console panel ---- */

export type ConsoleMode = 'ask' | 'needs' | 'stopped' | 'starting' | 'custom' | 'running';

/** Which of the states of Console.dc.html the selected console is in. A custom command that is stopped is stopped. */
export function consoleMode(agent: AgentView): ConsoleMode {
  if (agent.state === 'stopped') return 'stopped';
  if (agent.provider === 'custom') return 'custom';
  if (asksForGo(agent)) return 'ask';
  if (agent.state === 'needs_you') return 'needs';
  if (agent.state === 'starting') return 'starting';
  return 'running';
}

/** The tone of the state chip in the panel header; `ink` on a flooded header. */
export function chipTone(state: AgentState, flooded: boolean): 'lit' | 'amber' | 'quiet' | 'ink' {
  if (flooded) return 'ink';
  return state === 'working' ? 'lit' : state === 'needs_you' ? 'amber' : 'quiet';
}

const NEEDS_WORDS = { startup_dialog: 'STARTUP DIALOG', permission: 'PERMISSION', dialog: 'DIALOG', input: 'INPUT', redline: 'REDLINE' } as const;

/** The state chip of the panel: `NEEDS YOU 3 M · PERMISSION`, `PRINTING · CUSTOM COMMAND`. */
export function chipText(agent: AgentView, now: number): string {
  const base = stateText(agent, now);
  if (agent.state === 'needs_you' && agent.needsKind !== null) return `${base} · ${onHold(agent) ? 'HOLD' : NEEDS_WORDS[agent.needsKind]}`;
  return agent.provider === 'claude' ? base : `${base} · ${providerInfo(agent.provider).label.toUpperCase()}`;
}

/** What else the Director should know about a console, under its header: mail that waits, edits that need a restart. */
export function panelDetails(agent: AgentView): string[] {
  const details: string[] = [];
  if (agent.held !== null) details.push(agent.held.text);
  else if (agent.queued > 0) details.push(`${agent.queued} ${agent.queued === 1 ? 'message' : 'messages'} waiting`);
  if (agent.dirty) details.push('Restart to apply the changes you saved.');
  return details;
}

/** Where a Clean Room console works: its branch and its worktree (the server's home holds the worktrees), or null when it runs on the host. */
export function cleanRoomPlace(agent: Pick<AgentView, 'name' | 'cleanRoom'>, home: string): { branch: string; worktree: string } | null {
  return !agent.cleanRoom ? null : { branch: cleanRoomBranch(agent.name), worktree: `${home.replace(/\/+$/, '')}/${CLEAN_ROOM_DIR}/${agent.name}` };
}

/** `guido · Guidance officer · /projects/app`; a custom command has no position title. */
export function consoleSubtitle(agent: AgentView, position: Position | null): string {
  return [agent.name, position?.title ?? null, agent.dir].filter((part) => part !== null && part !== '').join(' · ');
}

/** The count line above the matrix. */
export const staffedText = (n: number): string => `${n} staffed · ${Math.max(0, MAX_AGENTS - n)} open`;

/* ---- the live region ---- */

export interface Facts {
  agents: readonly AgentView[];
  /** Items in the Downlink that the Director has not read (the server counts them). */
  unread: number;
  poll: PollView | null;
  limit: number | null;
}

/** At most one live-region write per this long. */
export const ANNOUNCE_GAP_MS = 500;

export interface Announcer {
  update(facts: Facts, legends: Legends): void;
  /** Cancel the pending write (the component unmounts). */
  stop(): void;
  /** Schedule what is still queued (the component mounted again after `stop`). */
  resume(): void;
}

const pollKey = (poll: PollView | null): string => (poll === null ? 'none' : `${poll.id}:${poll.status}`);

function pollAnnouncement(poll: PollView | null): string | null {
  if (poll === null) return null;
  const what = poll.subject === undefined ? 'T-minus' : 'Static fire';
  switch (poll.status) {
    case 'open':
      return poll.subject === undefined ? 'T-minus: poll started' : `Static fire started: ${poll.subject}`;
    case 'go':
      return `${what}: GO`;
    case 'hold':
      return poll.entries.some((e) => e.vote === 'no-go') ? `${what}: NO-GO. ${poll.note}` : `${what}: HOLD`;
    case 'aborted':
      return poll.subject === undefined ? 'T-minus: poll aborted' : 'Static fire: aborted';
  }
}

/**
 * The text for the live region: a console that starts needing the Director, a console that stops, a Downlink that holds
 * more unread items than before, the result of a poll, a new Max Q limit. The first non-empty list of agents is the page loading, not news, so
 * it only sets the baseline. Lines wait for the 500 ms gap since the last write and go out joined: a burst reads as one.
 */
export function createAnnouncer(write: (text: string) => void, gapMs = ANNOUNCE_GAP_MS): Announcer {
  let memory: { states: Map<string, AgentState>; unread: number; poll: string; limit: number | null } | null = null;
  const pending: string[] = [];
  let lastWrite = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(): void {
    if (timer !== undefined || pending.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      const text = pending.splice(0).join('. ');
      if (text === '') return;
      lastWrite = Date.now();
      write(text);
    }, Math.max(0, lastWrite + gapMs - Date.now()));
  }

  return {
    update(facts, legends) {
      const states = new Map<string, AgentState>();
      for (const a of facts.agents) states.set(a.name, a.state);
      const next = { states, unread: facts.unread, poll: pollKey(facts.poll), limit: facts.limit };
      if (memory === null) {
        if (facts.agents.length > 0) memory = next;
        return;
      }
      for (const a of facts.agents) {
        const before = memory.states.get(a.name);
        if (before === a.state) continue;
        const who = legends[a.name] ?? a.name.toUpperCase();
        if (a.state === 'needs_you') pending.push(`${who} ${asksForGo(a) ? 'asks for a go' : 'needs you'}${reasonText(a) === null ? '' : `: ${reasonText(a)}`}`);
        else if (a.state === 'stopped' && before !== undefined) pending.push(`${who} stopped`);
      }
      if (facts.unread > memory.unread) pending.push(`${facts.unread} unread in the Downlink`);
      if (next.poll !== memory.poll) {
        const text = pollAnnouncement(facts.poll);
        if (text !== null) pending.push(text);
      }
      if (next.limit !== memory.limit) pending.push(next.limit === null ? 'Max Q off' : `Max Q limit ${next.limit}`);
      memory = next;
      schedule();
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
    resume: schedule,
  };
}
