/**
 * gonogo tui (docs/tui-spec.md): what the terminal client knows of the room, built from the frames of the WebSocket. Pure: no
 * socket, no screen. The page keeps the same facts in src/client/store.ts, which cannot be imported here (it needs React); this
 * keeps only what the terminal shows: the roster, the Downlink, the Relief requests and the poll.
 *
 * Every text that came from the server is untrusted: an agent wrote it. `clean` takes out what a terminal would act on (escape
 * sequences, control and bidi characters) before it is drawn.
 */
import { isHoldReason } from '../shared/protocol.js';
import type { AgentView, DownlinkItem, DownlinkView, ModelDefaults, PollView, ReliefRequest, ServerFrame, ServerInfo, TabNameView } from '../shared/protocol.js';

export type Link = 'connecting' | 'open' | 'reconnecting' | 'unauthorized';

export interface TuiState {
  link: Link;
  /** The first state frame has come: before it the room is unknown, not empty. */
  loaded: boolean;
  /** By desk, then name. */
  agents: AgentView[];
  downlink: DownlinkView;
  relief: ReliefRequest[];
  poll: PollView | null;
  info: ServerInfo | null;
  /** The name of this room in the title of the browser tab: the header shows it too. */
  tabName: TabNameView;
  /** The room's default models, for the model each console starts with: null until the server answered. */
  models: ModelDefaults | null;
}

export const initialState = (): TuiState => ({ link: 'connecting', loaded: false, agents: [], downlink: { unread: 0, items: [] }, relief: [], poll: null, info: null, tabName: { name: null, fallback: null }, models: null });

const byDesk = (a: AgentView, b: AgentView): number => a.desk - b.desk || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Text of the server made safe for a terminal: C0, DEL, C1 and bidi controls become spaces, a run of spaces is one, and it is cut to `max`. */
export function clean(text: string, max = 200): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/ {2,}/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The state after one frame. Frames the terminal does not show (terminal bytes, size, propellant, tasks) leave it as it is. */
export function applyFrame(s: TuiState, frame: ServerFrame): TuiState {
  switch (frame.t) {
    case 'state':
      return {
        ...s,
        loaded: true,
        info: frame.state.info,
        agents: [...frame.state.agents].sort(byDesk),
        downlink: frame.state.downlink ?? s.downlink,
        relief: frame.state.relief?.requests ?? [],
        poll: frame.state.poll,
        tabName: frame.state.tabName ?? s.tabName,
      };
    case 'agent':
      return { ...s, agents: [...s.agents.filter((a) => a.name !== frame.agent.name), frame.agent].sort(byDesk) };
    case 'agent-removed':
      return { ...s, agents: s.agents.filter((a) => a.name !== frame.name) };
    case 'downlink':
      return { ...s, downlink: frame.downlink };
    case 'relief':
      return { ...s, relief: frame.relief.requests };
    case 'models':
      return { ...s, models: frame.models };
    case 'poll':
      return { ...s, poll: frame.poll };
    case 'tabname':
      return { ...s, tabName: frame.tabName };
    default:
      return s;
  }
}

/** The Director's own hold: a Redline trip with the reason of a hold. */
export const isOnHold = (a: AgentView): boolean => a.state === 'needs_you' && a.needsKind === 'redline' && a.transition === null && isHoldReason(a.needsReason);

/** What waits for a go or a no-go: a permission dialog of an agent, or a Relief request. */
export type Need =
  | { kind: 'permission'; agent: string; reason: string; needSeq: number | null }
  | { kind: 'relief'; id: string; by: string; name: string; reason: string };

export function needsOf(s: TuiState): Need[] {
  const out: Need[] = [];
  for (const a of s.agents) {
    if (a.state === 'needs_you' && a.needsKind === 'permission' && a.transition === null) out.push({ kind: 'permission', agent: a.name, reason: clean(a.needsReason ?? 'permission request'), needSeq: a.needSeq });
  }
  for (const r of s.relief) out.push({ kind: 'relief', id: r.id, by: clean(r.by, 40), name: clean(r.name, 40), reason: `hire ${clean(r.name, 40)} (${r.position === null ? 'own role' : clean(r.position, 40)}) in ${clean(r.dir, 80)}` });
  return out;
}

export const isUnread = (i: DownlinkItem): boolean => !i.read && !i.archived;

/** The Downlink the terminal lists: archived items out, unread first, each group newest first (the server sends newest first). */
export function inboxOf(s: TuiState): DownlinkItem[] {
  const live = s.downlink.items.filter((i) => !i.archived);
  return [...live.filter(isUnread), ...live.filter((i) => !isUnread(i))];
}

/** One line for an item of the inbox: who and what, never more than `max` characters. */
export function itemLine(i: DownlinkItem, max = 120): string {
  return i.type === 'message' ? clean(`${i.from}: ${i.subject === '' ? i.body : i.subject}`, max) : clean(`${i.kind}: ${i.text}`, max);
}
