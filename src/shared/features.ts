/**
 * Feature toggles (docs/features-spec.md): one table of what the Director may switch off, read by the server (to enforce it) and by
 * the page (to show it), so the two cannot disagree. Pure data and pure functions: nothing here touches a file or the network.
 *
 * `requires` is hard: a feature cannot be on without it, so turning one off turns every feature that needs it off too (`forced`).
 * `enhances` is soft: the feature keeps working and loses something, said in `loses` (`degraded`). A row with `wired: false` is in the
 * table and the page but cannot be switched yet: the server refuses it, because a switch that hid a picture would be a lie.
 */

export const FEATURE_GROUPS = ['Room', 'Records', 'Spend', 'Work', 'Outside', 'Look'] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export interface Feature {
  id: string;
  label: string;
  group: FeatureGroup;
  /** One line of what it is, for the block. */
  about: string;
  /** Hard dependencies: the ids that must be on. */
  requires: readonly string[];
  /** Soft dependencies: the ids it is better with; `loses` says what it loses without them. */
  enhances: readonly string[];
  loses: string;
  /** Cannot be switched off, and why (one line). */
  core?: string;
  /** The server enforces the switch for this row. A row without it is listed and refused with "not switchable yet". */
  wired: boolean;
}

const f = (
  id: string,
  label: string,
  group: FeatureGroup,
  about: string,
  extra: { requires?: readonly string[]; enhances?: readonly string[]; loses?: string; wired?: boolean } = {},
): Feature => ({ id, label, group, about, requires: extra.requires ?? [], enhances: extra.enhances ?? [], loses: extra.loses ?? '', wired: extra.wired ?? true });
const core = (id: string, label: string, group: FeatureGroup, about: string, why: string): Feature => ({ id, label, group, about, requires: [], enhances: [], loses: '', core: why, wired: true });

export const FEATURES: readonly Feature[] = [
  core('roster', 'Roster and mail', 'Room', 'Hire, edit, start, stop and message agents.', 'nothing works without it'),
  core('downlink', 'Downlink', 'Room', 'The inbox where mail to you lands.', 'it is where mail to the Director goes'),
  core('redline', 'Redline and Hold', 'Room', 'The automatic brake, and the Hold key.', 'the only automatic brake; limits and Static fire ride on it'),
  core('controls', 'Flight Rules, Patch Panel, Clearance, Engine Bay', 'Room', 'The controls of everything else.', 'they are how you switch the rest'),
  f('director-turns', 'Director messages as user turns', 'Room', 'Your own words, from a signed-in browser or your private Telegram chat, are also typed into the agent as your turn.', { enhances: ['downlink'], loses: 'the agent gets only the pointer and reads your words as data, so a go of yours does not authorize anything in auto mode' }),
  f('maxq', 'Max Q', 'Room', 'At most N agents working at once.', { loses: 'there is no load limit and no mail waits for load' }),
  f('tminus', 'T-minus poll', 'Work', 'A go/no-go poll of the agents.', { loses: 'no poll and no go_nogo tool' }),
  f('static-fire', 'Static fire', 'Work', 'A T-minus poll with a subject, tried by SIMSUP and RETRO.', { requires: ['tminus'], loses: 'the ritual is gone, the poll remains' }),
  f('relief', 'Relief', 'Work', 'The boss asks for a hire and only your GO hires.', { loses: 'FLIGHT can only tell you to hire' }),
  f('flight-plan', 'Flight Plan', 'Work', 'The task board.', { loses: 'the task tools are gone' }),
  f('missions', 'Missions', 'Work', 'A named goal with its tasks.', { requires: ['flight-plan'], loses: 'the mission tools are gone' }),
  f('mission-log', 'Mission Log', 'Records', 'The shared memory of the room.', { loses: 'the log tools are gone' }),
  f('star-chart', 'Star Chart', 'Records', 'The log as a graph.', { requires: ['mission-log'], loses: 'the chart and links' }),
  f('plot-board', 'Plot Board', 'Records', 'The one current plan.', { loses: 'the board tools and view are gone' }),
  f('party-line', 'Party Line', 'Records', 'Messages grouped in threads.', { wired: false }),
  f('telemetry', 'Telemetry', 'Records', 'A timeline of an agent\'s tool calls.', { loses: 'the tool-call fold; nothing else reads it' }),
  core('black-box', 'Black Box', 'Records', 'The git-committed record of the room.', 'an audit trail that can be switched off, with its own switch, is not one'),
  f('propellant', 'Propellant', 'Spend', 'Token use and limits.', { wired: false }),
  f('cost', 'Cost', 'Spend', 'Dollars, prices and budgets.', { requires: ['propellant'], wired: false }),
  f('mass-budget', 'Mass Budget', 'Records', 'The size of an agent\'s notes.', { loses: 'the memory fold and REFLECT' }),
  f('hangar', 'Hangar', 'Work', 'The files of an agent\'s folder.', { loses: 'the file view' }),
  f('recorder', 'Recorder', 'Work', 'The git of an agent\'s folder.', { requires: ['hangar'], loses: 'the git view and commit' }),
  f('review', 'Post-Flight Review', 'Work', 'Notes and a verdict on an agent\'s diff.', { requires: ['recorder'], loses: 'the review tools and notes' }),
  f('launch-window', 'Launch Window', 'Outside', 'Schedules.', { loses: 'schedules stop, and a missed one does not catch up when it is turned on again' }),
  f('uplink', 'Uplink', 'Outside', 'Webhooks that start work.', { loses: 'webhooks answer 404' }),
  f('relay', 'Relay', 'Outside', 'Slack, Telegram, GitHub and Linear in and out.', { requires: ['uplink'], loses: 'nothing is forwarded to or taken from a chat' }),
  f('phone-approvals', 'Phone approvals', 'Outside', 'Answer a permission or a hire from your phone.', { enhances: ['relay'], loses: 'the Telegram buttons stop (the Claude app choice stays)', wired: false }),
  f('docking', 'Docking', 'Outside', 'A link to another station.', { loses: 'no link to another station' }),
  f('livery', 'Livery', 'Look', 'Themes.', { loses: 'the theme editor and livery_submit (the current theme stays)' }),
];

const BY_ID = new Map(FEATURES.map((feature) => [feature.id, feature]));
export const featureById = (id: string): Feature | undefined => BY_ID.get(id);
export const isFeatureId = (id: unknown): id is string => typeof id === 'string' && BY_ID.has(id);

/** What a change would do: nothing is changed by asking. */
export interface FeaturePlan {
  /** The features the Director asked to turn off and that are on now. */
  turnOff: string[];
  /** Also turned off, because they need one of the above. */
  forced: string[];
  /** Turned on, because something that is turned on needs them. */
  turnOn: string[];
  /** Still on, and losing something. */
  degraded: Array<{ id: string; lines: string[] }>;
  /** Why the change cannot be made: nothing is applied while there is one. */
  blocked: Array<{ id: string; why: string }>;
  /** The list of off ids after the change, in table order. */
  off: string[];
}

const inTableOrder = (ids: Iterable<string>): string[] => {
  const set = new Set(ids);
  return FEATURES.filter((feature) => set.has(feature.id)).map((feature) => feature.id);
};

/** Every feature that needs `id`, directly or through another. */
function dependents(ids: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const feature of FEATURES) {
      if (out.has(feature.id) || ids.has(feature.id)) continue;
      if (feature.requires.some((need) => ids.has(need) || out.has(need))) {
        out.add(feature.id);
        grew = true;
      }
    }
  }
  return out;
}

/** What the room is doing now, which the plan needs: it cannot orphan an open poll, and a feature that comes back needs a restart to reach a running agent. */
export interface PlanContext {
  /** A T-minus poll or a Static fire is open (still collecting votes). A finished one is cleared when T-minus goes off. */
  pollOpen?: boolean;
  /** The agents that are running (their tool list was fixed at their start). */
  running?: readonly string[];
}

/** The ids of an off list that can be off: it is closed over `requires` and loses the core and the not-switchable ones. */
export function cleanOff(ids: readonly string[]): string[] {
  const want = new Set(ids.filter((id) => {
    const feature = BY_ID.get(id);
    return feature !== undefined && feature.core === undefined && feature.wired;
  }));
  return inTableOrder([...want, ...dependents(want)]);
}

/** The plan to go from the off list `current` to the one the Director asked for (`asked`: the whole list of off ids). */
export function planFeatures(current: readonly string[], asked: readonly string[], context: PlanContext = {}): FeaturePlan {
  const blocked: FeaturePlan['blocked'] = [];
  const now = new Set(current.filter(isFeatureId));
  const want = new Set<string>();
  for (const id of asked) {
    const feature = BY_ID.get(id);
    if (feature === undefined) blocked.push({ id, why: 'there is no such feature' });
    else if (feature.core !== undefined) blocked.push({ id, why: `${feature.label} is core: ${feature.core}` });
    else if (!feature.wired && !now.has(id)) blocked.push({ id, why: `${feature.label} cannot be switched off yet` });
    else want.add(id);
  }
  // a feature that is turned on needs what it requires: those are turned on too
  const turnOn = new Set<string>();
  for (const feature of FEATURES) {
    if (!now.has(feature.id) || want.has(feature.id)) continue;
    for (let more = [...feature.requires]; more.length > 0; ) {
      const need = more.pop() as string;
      if (want.delete(need)) turnOn.add(need);
      more = more.concat(BY_ID.get(need)?.requires ?? []);
    }
  }
  const forced = dependents(want);
  const final = new Set([...want, ...forced]);
  const turnOff = inTableOrder([...want].filter((id) => !now.has(id)));
  const newlyOff = new Set([...final].filter((id) => !now.has(id)));
  if (context.pollOpen === true) {
    for (const id of ['tminus', 'static-fire']) if (newlyOff.has(id)) blocked.push({ id, why: `a poll is open: abort or clear it before turning off ${BY_ID.get(id)?.label ?? id}` });
  }
  const degraded: FeaturePlan['degraded'] = [];
  for (const feature of FEATURES) {
    if (final.has(feature.id) || feature.enhances.length === 0) continue;
    if (feature.enhances.some((id) => newlyOff.has(id))) degraded.push({ id: feature.id, lines: [feature.loses] });
  }
  // a feature that comes back reaches a running agent only at its next start (--allowedTools is fixed at the spawn)
  const running = context.running ?? [];
  for (const feature of FEATURES) {
    if (!now.has(feature.id) || final.has(feature.id) || (FEATURE_TOOLS[feature.id] ?? []).length === 0 || running.length === 0) continue;
    degraded.push({ id: feature.id, lines: [`restart ${running.join(', ')} to get ${(FEATURE_TOOLS[feature.id] ?? []).join(', ')} back`] });
  }
  return {
    turnOff,
    forced: inTableOrder([...forced].filter((id) => !now.has(id))),
    turnOn: inTableOrder(turnOn),
    degraded,
    blocked,
    off: inTableOrder(final),
  };
}

/** The server's route to the feature that owns it, or null (not a feature, or a core one). `segments` are the parts of the path after /api. */
export function featureOfRoute(segments: readonly string[]): string | null {
  const [first, second, third] = segments;
  switch (first) {
    case 'governor':
      return 'maxq';
    case 'poll':
      return 'tminus';
    case 'relief':
      return 'relief';
    case 'tasks':
      return 'flight-plan';
    case 'missions':
      return 'missions';
    case 'log':
      return second === 'chart' ? 'star-chart' : 'mission-log';
    case 'board':
      return 'plot-board';
    case 'schedules':
      return 'launch-window';
    case 'uplinks':
      return 'uplink';
    case 'relay':
      return second === 'phone' ? null : 'relay';
    case 'docking':
      return 'docking';
    case 'livery':
    case 'liveries':
      return 'livery';
    case 'agents':
      switch (third) {
        case 'telemetry':
          return 'telemetry';
        case 'memory':
        case 'reflect':
          return 'mass-budget';
        case 'files':
        case 'file':
          return 'hangar';
        case 'git':
          return 'recorder';
        case 'review':
          return 'review';
        default:
          return null;
      }
    default:
      return null;
  }
}

/** The MCP tools that belong to a feature: off, they are not listed and a call is refused. */
export const FEATURE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  tminus: ['go_nogo'],
  relief: ['hire_agent'],
  'flight-plan': ['task_list', 'task_create', 'task_update'],
  missions: ['mission_list', 'mission_create', 'mission_update'],
  'mission-log': ['log_write', 'log_search', 'log_read'],
  'plot-board': ['board_read', 'board_write'],
  livery: ['livery_submit'],
  review: ['review_read', 'review_note'],
};

/** The tool names that an off list takes away. */
export const toolsOff = (off: readonly string[]): string[] => off.flatMap((id) => FEATURE_TOOLS[id] ?? []);
