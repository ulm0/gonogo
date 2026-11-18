import type {
  AgentView,
  AnswerRequest,
  AuditView,
  BoardView,
  ClientFrame,
  DockCode,
  DockHandoffRequest,
  DockingView,
  DockView,
  DownlinkView,
  EditRequest,
  EngineCheck,
  ErrorFrame,
  GovernorRequest,
  GovernorView,
  HangarCreateRequest,
  HangarFile,
  HangarListing,
  HangarSaved,
  HangarSaveRequest,
  HireRequest,
  MemoryView,
  LiveryDesignRequest,
  LiveryView,
  LogChart,
  LogEntry,
  LogRequest,
  LogSearch,
  PollRequest,
  PollView,
  PropellantRequest,
  PropellantView,
  ReflectResult,
  RelayForwardRequest,
  PhoneMode,
  RelayService,
  RelayTargetRequest,
  RecorderCommit,
  RecorderCommitRequest,
  RecorderDiff,
  RecorderStatus,
  RelayView,
  ReliefView,
  ScheduleRequest,
  ScheduleView,
  SendResult,
  ServerFrame,
  SizeFrame,
  SnapshotFrame,
  StateSnapshot,
  Task,
  TaskPatch,
  ToolCall,
  TaskRequest,
  UplinkCreated,
  UplinkPatch,
  UplinkRequest,
  UplinkView,
  Block,
  DeskOrder,
  Mission,
  MissionPatch,
  MissionRequest,
  ModelDefaults,
  PermissionDefaults,
  PermissionRules,
  Provider,
  ReviewNote,
  ReviewNoteRequest,
  ReviewSent,
  ReviewStatus,
  ReviewVerdictKind,
  ReviewView,
  RoomView,
  UserMessageRequest,
  WorktreeStatus,
} from '../shared/protocol.js';
import {
  API_PREFIX,
  RECONNECT_DELAYS_MS,
  TOKEN_FRAGMENT_KEY,
  TOKEN_STORAGE_KEY,
  WS_BINARY_OUTPUT,
  WS_INPUT_CHUNK_CHARS,
  WS_PATH,
  WS_SUBPROTOCOL,
  WS_TOKEN_PROTOCOL_PREFIX,
} from '../shared/protocol.js';
import type { ModelPrice, PricesView } from '../shared/prices.js';
import { applyServerFrame, pruneEnvelopes, readStored, store, writeStored } from './store.js';

/** What the terminal pane receives. api.ts drops snapshots and output of an attach that is no longer the current one. */
export interface TerminalListener {
  snapshot(frame: SnapshotFrame): void;
  output(bytes: Uint8Array): void;
  size(frame: SizeFrame): void;
  error(frame: ErrorFrame): void;
}

/** An Error from a REST call: the server's message, plus the field it names and the HTTP status. */
export type ApiFailure = Error & { field?: string; status?: number };

const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

let token: string | null = null;
let socket: WebSocket | null = null;
let started = false;
let attempting = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let attachCounter = 0;
let currentSeq = 0;
let terminal: TerminalListener | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isStateSnapshot(value: unknown): value is StateSnapshot {
  const record = asRecord(value);
  return (
    record !== null &&
    Array.isArray(record.agents) &&
    Array.isArray(record.activity) &&
    asRecord(record.info) !== null &&
    asRecord(record.governor) !== null &&
    (record.poll === null || asRecord(record.poll) !== null)
  );
}

/** The token comes from the #token=... fragment (once), else from storage; the fragment is removed from the address bar either way. */
function findToken(): string | null {
  const fragment = location.hash.startsWith('#') ? new URLSearchParams(location.hash.slice(1)) : null;
  if (fragment?.has(TOKEN_FRAGMENT_KEY)) {
    const given = fragment.get(TOKEN_FRAGMENT_KEY) ?? '';
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      // A sandboxed frame may forbid it; the token then stays in the address bar, which only the owner sees.
    }
    if (TOKEN_PATTERN.test(given)) {
      writeStored(TOKEN_STORAGE_KEY, given);
      return given;
    }
  }
  const stored = readStored(TOKEN_STORAGE_KEY);
  return stored !== null && TOKEN_PATTERN.test(stored) ? stored : null;
}

/* ---- REST ---- */

function failure(message: string, status?: number, field?: string): ApiFailure {
  return Object.assign(new Error(message), { status, field });
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token ?? ''}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(API_PREFIX + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw failure('Could not reach the gonogo server.');
  }
  let parsed: unknown = null;
  try {
    const text = await response.text();
    if (text !== '') parsed = JSON.parse(text);
  } catch {
    // A body that is not JSON (a proxy's error page) is told apart by the status below.
  }
  if (!response.ok) {
    const error = asRecord(parsed);
    const message = typeof error?.error === 'string' ? error.error : `The server answered ${response.status}.`;
    throw failure(message, response.status, typeof error?.field === 'string' ? error.field : undefined);
  }
  return parsed;
}

function toAgentView(value: unknown): AgentView {
  const record = asRecord(value);
  if (record === null || typeof record.name !== 'string' || typeof record.state !== 'string') {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as AgentView;
}

function toPollView(value: unknown): PollView {
  const record = asRecord(value);
  if (record === null || typeof record.status !== 'string' || !Array.isArray(record.entries)) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as PollView;
}

function toGovernorView(value: unknown): GovernorView {
  const record = asRecord(value);
  if (record === null || typeof record.working !== 'number' || typeof record.holding !== 'number') {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as GovernorView;
}

function toPropellantView(value: unknown): PropellantView {
  const record = asRecord(value);
  if (record === null || asRecord(record.room) === null || asRecord(record.agents) === null) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as PropellantView;
}

function toPricesView(value: unknown): PricesView {
  const record = asRecord(value);
  if (record === null || asRecord(record.rows) === null) throw failure('The server sent an answer gonogo does not understand.');
  return value as PricesView;
}

function toScheduleView(value: unknown): ScheduleView {
  const record = asRecord(value);
  if (record === null || typeof record.id !== 'string' || typeof record.rule !== 'string') {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as ScheduleView;
}

function toDownlinkView(value: unknown): DownlinkView {
  const record = asRecord(value);
  if (record === null || typeof record.unread !== 'number' || !Array.isArray(record.items)) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as DownlinkView;
}

/** A hire request as the page draws it: every field the block shows must be there. */
function isReliefRequest(value: unknown): boolean {
  const r = asRecord(value);
  return (
    r !== null &&
    ['id', 'by', 'name', 'role', 'dir', 'provider', 'mode'].every((key) => typeof r[key] === 'string') &&
    typeof r.at === 'number' &&
    typeof r.expiresAt === 'number' &&
    (r.position === null || typeof r.position === 'string') &&
    (r.cleanRoom === null || asRecord(r.cleanRoom) !== null)
  );
}

const isReliefView = (value: unknown): value is ReliefView => {
  const requests = asRecord(value)?.requests;
  return Array.isArray(requests) && requests.every(isReliefRequest);
};

function toReliefView(value: unknown): ReliefView {
  if (!isReliefView(value)) throw failure('The server sent an answer gonogo does not understand.');
  return value;
}

function toLiveryView(value: unknown): LiveryView {
  const record = asRecord(value);
  if (record === null || typeof record.current !== 'string' || !Array.isArray(record.liveries) || !record.liveries.every((e) => typeof asRecord(e)?.slug === 'string' && asRecord(asRecord(e)?.tokens) !== null)) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as LiveryView;
}

function toLogSearch(value: unknown): LogSearch {
  const record = asRecord(value);
  if (record === null || typeof record.total !== 'number' || !Array.isArray(record.hits)) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as LogSearch;
}

function toLogEntry(value: unknown): LogEntry {
  const record = asRecord(value);
  if (record === null || typeof record.id !== 'string' || typeof record.body !== 'string' || !Array.isArray(record.tags)) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as LogEntry;
}

function toBoardView(value: unknown): BoardView {
  const record = asRecord(value);
  if (record === null || typeof record.text !== 'string' || typeof record.revision !== 'number') throw failure('The server sent an answer gonogo does not understand.');
  return value as BoardView;
}

function toAuditView(value: unknown): AuditView {
  const record = asRecord(value);
  if (record === null || typeof record.git !== 'string' || typeof record.command !== 'string' || !Array.isArray(record.events)) throw failure('The server sent an answer gonogo does not understand.');
  return value as AuditView;
}

function toLogChart(value: unknown): LogChart {
  const record = asRecord(value);
  if (record === null || typeof record.total !== 'number' || !Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as LogChart;
}

function toMemoryView(value: unknown): MemoryView {
  const record = asRecord(value);
  if (record === null || typeof record.bytes !== 'number' || typeof record.over !== 'boolean') throw failure('The server sent an answer gonogo does not understand.');
  return value as MemoryView;
}

function toReflectResult(value: unknown): ReflectResult {
  const record = asRecord(value);
  if (record === null || asRecord(record.send) === null) throw failure('The server sent an answer gonogo does not understand.');
  toMemoryView(record.memory);
  return value as ReflectResult;
}

function toTask(value: unknown): Task {
  const record = asRecord(value);
  if (record === null || typeof record.id !== 'string' || typeof record.status !== 'string' || !Array.isArray(record.notes)) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as Task;
}

function toRelayView(value: unknown): RelayView {
  const record = asRecord(value);
  if (record === null || !Array.isArray(record.forward) || !('slack' in record) || !('telegram' in record)) throw failure('The server sent an answer gonogo does not understand.');
  return value as RelayView;
}

function toUplinkView(value: unknown): UplinkView {
  const record = asRecord(value);
  if (record === null || typeof record.id !== 'string' || !Array.isArray(record.deliveries)) {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as UplinkView;
}

function toUplinkCreated(value: unknown): UplinkCreated {
  const view = toUplinkView(value);
  if (typeof (view as Partial<UplinkCreated>).secret !== 'string') throw failure('The server sent an answer gonogo does not understand.');
  return view as UplinkCreated;
}

function toSendResult(value: unknown): SendResult {
  const record = asRecord(value);
  if (record === null || typeof record.ok !== 'boolean' || typeof record.status !== 'string') {
    throw failure('The server sent an answer gonogo does not understand.');
  }
  return value as SendResult;
}

const agentPath = (name: string): string => `/agents/${encodeURIComponent(name)}`;

export async function hire(request: HireRequest): Promise<AgentView> {
  return toAgentView(await call('POST', '/agents', request));
}

export async function edit(name: string, request: EditRequest): Promise<AgentView> {
  return toAgentView(await call('PATCH', agentPath(name), request));
}

/** Pad Check: where each engine is on the server's PATH and what its `--version` says. */
/** Default models: the room's model for each engine, used when a console has none of its own. */
export async function modelDefaults(): Promise<ModelDefaults> {
  return toModelDefaults(await call('GET', '/models'));
}

/** Sets the room's model for one engine; null or empty clears it. */
export async function setModelDefault(provider: Provider, model: string | null): Promise<ModelDefaults> {
  return toModelDefaults(await call('PUT', `/models/${encodeURIComponent(provider)}`, { model }));
}

export async function setPositionModel(position: string, model: string | null): Promise<ModelDefaults> {
  return toModelDefaults(await call('PUT', `/models/positions/${encodeURIComponent(position)}`, { model }));
}

function toModelDefaults(value: unknown): ModelDefaults {
  const models = asRecord(asRecord(value)?.models);
  if (models === null) throw failure('The server sent an answer gonogo does not understand.');
  return value as ModelDefaults;
}

/** Tool permissions: the room's rules for the Claude Code consoles that have none of their own. */
export async function permissionDefaults(): Promise<PermissionDefaults> {
  return toPermissionDefaults(await call('GET', '/permissions'));
}

/** Replaces the room's rules; `{}` clears them. */
export async function setPermissionDefaults(permissions: PermissionRules): Promise<PermissionDefaults> {
  return toPermissionDefaults(await call('PUT', '/permissions', permissions));
}

function toPermissionDefaults(value: unknown): PermissionDefaults {
  if (asRecord(asRecord(value)?.permissions) === null) throw failure('The server sent an answer gonogo does not understand.');
  return value as PermissionDefaults;
}

export async function engines(): Promise<EngineCheck[]> {
  const list = await call('GET', '/engines');
  if (!Array.isArray(list) || !list.every((e) => typeof asRecord(e)?.provider === 'string')) throw failure('The server sent an answer gonogo does not understand.');
  return list as EngineCheck[];
}

/** Also starts a stopped agent. */
export async function restart(name: string): Promise<AgentView> {
  return toAgentView(await call('POST', `${agentPath(name)}/restart`));
}

export async function stopAgent(name: string): Promise<AgentView> {
  return toAgentView(await call('POST', `${agentPath(name)}/stop`));
}

/** Removes the console; `deleteWorktree` also asks git to delete its worktree and branch (git refuses unsaved or unmerged work, and the console is gone anyway). */
export async function remove(name: string, deleteWorktree = false): Promise<void> {
  await call('DELETE', `${agentPath(name)}${deleteWorktree ? '?worktree=delete' : ''}`);
}

export async function worktreeStatus(name: string): Promise<WorktreeStatus> {
  const record = asRecord(await call('GET', `${agentPath(name)}/worktree`));
  if (record === null || typeof record.branch !== 'string' || typeof record.dirty !== 'boolean') throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as WorktreeStatus;
}

export async function sendMessage(request: UserMessageRequest): Promise<SendResult> {
  return toSendResult(await call('POST', '/messages', request));
}

/** Starts a T-minus poll; without `agents` the server polls every running claude agent except the boss. */
export async function startPoll(request: PollRequest = {}): Promise<PollView> {
  return toPollView(await call('POST', '/poll', request));
}

export async function holdPoll(): Promise<PollView> {
  return toPollView(await call('POST', '/poll/hold'));
}

export async function abortPoll(): Promise<PollView> {
  return toPollView(await call('POST', '/poll/abort'));
}

export async function clearPoll(): Promise<void> {
  await call('DELETE', '/poll');
}

/** The Director's go or no-go on a permission prompt, as if Enter or Escape was typed in the terminal. */
export async function answer(name: string, go: boolean): Promise<AgentView> {
  const request: AnswerRequest = { go };
  return toAgentView(await call('POST', `${agentPath(name)}/answer`, request));
}

/** Relief: the Director's GO or NO-GO on a hire request of the boss. The answer is the list as it is now. */
export async function answerRelief(id: string, go: boolean): Promise<ReliefView> {
  return toReliefView(await call('POST', `/relief/${encodeURIComponent(id)}/${go ? 'go' : 'no-go'}`));
}

/** Max Q: a limit of 1 to MAX_AGENTS, or null to switch it off. */
export async function setGovernor(request: GovernorRequest): Promise<GovernorView> {
  return toGovernorView(await call('PUT', '/governor', request));
}

/** Propellant: token limits for the room and per agent; {} clears a scope. */
export async function setPropellant(request: PropellantRequest): Promise<PropellantView> {
  return toPropellantView(await call('PUT', '/propellant', request));
}

/** Cost: the model prices, the defaults with your own rows over them. */
export async function getPrices(): Promise<PricesView> {
  return toPricesView(await call('GET', '/prices'));
}

/** Replaces your own rows (the defaults stay behind them). */
export async function setPrices(models: Record<string, ModelPrice>): Promise<PricesView> {
  return toPricesView(await call('PUT', '/prices', { models }));
}

/** Drops one of your rows: the default comes back. */
export async function removePrice(prefix: string): Promise<PricesView> {
  return toPricesView(await call('DELETE', `/prices/${encodeURIComponent(prefix)}`));
}

/** Clears a Redline trip: the agent gets its mail again. */
export async function resume(name: string): Promise<AgentView> {
  return toAgentView(await call('POST', `${agentPath(name)}/resume`));
}

/** Hold: the Director stops the agent's turn and its mail until RESUME. */
export async function hold(name: string): Promise<AgentView> {
  return toAgentView(await call('POST', `${agentPath(name)}/hold`));
}

/** Telemetry: the agent's tool calls, newest first. */
export async function telemetry(name: string): Promise<ToolCall[]> {
  const record = asRecord(await call('GET', `${agentPath(name)}/telemetry`));
  if (record === null || !Array.isArray(record.calls)) throw failure('The server sent an answer gonogo does not understand.');
  return record.calls as ToolCall[];
}

/** Launch Window: a schedule that sends a message by itself on a cron rule. The list comes in the state and in `schedules` frames. */
export async function createSchedule(request: ScheduleRequest): Promise<ScheduleView> {
  return toScheduleView(await call('POST', '/schedules', request));
}

export async function updateSchedule(id: string, patch: Partial<ScheduleRequest>): Promise<ScheduleView> {
  return toScheduleView(await call('PATCH', `/schedules/${encodeURIComponent(id)}`, patch));
}

export async function deleteSchedule(id: string): Promise<void> {
  await call('DELETE', `/schedules/${encodeURIComponent(id)}`);
}

/** Sends the message now, whether the schedule is on or off; `lastResult` says what the hub answered. */
export async function runSchedule(id: string): Promise<ScheduleView> {
  return toScheduleView(await call('POST', `/schedules/${encodeURIComponent(id)}/run`));
}

/** Room editor: save the layout from the revision it was made from, or go back to today's page (all of it, or only the order of the desks). */
export async function saveRoom(request: { rev: number; blocks: Block[]; desks: DeskOrder }): Promise<RoomView> {
  return toRoomView(await call('PUT', '/room', request));
}

export async function resetRoom(part: 'all' | 'desks'): Promise<RoomView> {
  return toRoomView(await call('DELETE', `/room${part === 'desks' ? '?part=desks' : ''}`));
}

function toRoomView(value: unknown): RoomView {
  if (typeof asRecord(value)?.rev !== 'number') throw failure('The server sent an answer gonogo does not understand.');
  return value as RoomView;
}

/** Missions: named goals that tasks serve. The list comes in the state and in `missions` frames. */
export async function createMission(request: MissionRequest): Promise<Mission> {
  return toMission(await call('POST', '/missions', request));
}

export async function updateMission(id: string, patch: MissionPatch): Promise<Mission> {
  return toMission(await call('PATCH', `/missions/${encodeURIComponent(id)}`, patch));
}

/** A mission with tasks needs `unlink`: its tasks then stay on the board without it. */
export async function deleteMission(id: string, unlink = false): Promise<void> {
  await call('DELETE', `/missions/${encodeURIComponent(id)}${unlink ? '?unlink=1' : ''}`);
}

function toMission(value: unknown): Mission {
  const record = asRecord(value);
  if (record === null || typeof record.id !== 'string' || typeof record.status !== 'string' || !Array.isArray(record.history)) throw failure('The server sent an answer gonogo does not understand.');
  return value as Mission;
}

/** Flight Plan: the task board. The list comes in the state and in `tasks` frames. */
export async function createTask(request: TaskRequest): Promise<Task> {
  return toTask(await call('POST', '/tasks', request));
}

export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  return toTask(await call('PATCH', `/tasks/${encodeURIComponent(id)}`, patch));
}

export async function deleteTask(id: string): Promise<void> {
  await call('DELETE', `/tasks/${encodeURIComponent(id)}`);
}

/** Docking: the stations docked with this one. They come in the state and in `docking` frames. */
export async function createDockCode(url: string): Promise<DockCode> {
  const code = asRecord(await call('POST', '/docking/code', { url }));
  if (typeof code?.code !== 'string' || typeof code.expiresAt !== 'number') throw failure('The server sent an answer gonogo does not understand.');
  return code as unknown as DockCode;
}

/** `code` is what the other station's Director made; `url` is the address of this station as that one will reach it. */
export async function pairDock(code: string, url: string): Promise<DockView> {
  const dock = asRecord(await call('POST', '/docking/pair', { code, url }));
  if (typeof dock?.id !== 'string' || typeof dock.name !== 'string') throw failure('The server sent an answer gonogo does not understand.');
  return dock as unknown as DockView;
}

/** `told` is false when the other station could not be reached: it keeps the dock until it is undocked there too. */
export async function undock(id: string): Promise<boolean> {
  return asRecord(await call('DELETE', `/docking/${encodeURIComponent(id)}`))?.told === true;
}

/** Copies a task of this board to the board of a docked station; the answer is the task as it is here now. */
export async function handOffTask(dockId: string, request: DockHandoffRequest): Promise<Task> {
  return toTask(await call('POST', `/docking/${encodeURIComponent(dockId)}/handoff`, request));
}

/** Livery: choose, delete, ask an agent for a new one. The list comes in the state and in `livery` frames; each call answers with it as it is now. */
export async function selectLivery(slug: string): Promise<LiveryView> {
  return shownLivery(toLiveryView(await call('PUT', '/livery', { slug })));
}

export async function deleteLivery(slug: string): Promise<LiveryView> {
  return shownLivery(toLiveryView(await call('DELETE', `/liveries/${encodeURIComponent(slug)}`)));
}

/** The answer is the truth now: the page shows it without waiting for the frame (which brings the same view). */
function shownLivery(livery: LiveryView): LiveryView {
  store.setState((s) => ({ ...s, livery }));
  return livery;
}

export async function designLivery(request: LiveryDesignRequest): Promise<SendResult> {
  return toSendResult(await call('POST', '/liveries/design', request));
}

/** Mission Log: the shared memory. A `log` frame says that something changed; the entries are asked for. An empty query lists the newest. */
export async function searchLog(query: string): Promise<LogSearch> {
  return toLogSearch(await call('GET', `/log?q=${encodeURIComponent(query)}`));
}

export async function readLogEntry(id: string): Promise<LogEntry> {
  return toLogEntry(await call('GET', `/log/${encodeURIComponent(id)}`));
}

export async function createLogEntry(request: LogRequest): Promise<LogEntry> {
  return toLogEntry(await call('POST', '/log', request));
}

export async function updateLogEntry(id: string, request: LogRequest): Promise<LogEntry> {
  return toLogEntry(await call('PUT', `/log/${encodeURIComponent(id)}`, request));
}

export async function deleteLogEntry(id: string): Promise<void> {
  await call('DELETE', `/log/${encodeURIComponent(id)}`);
}

/** Hangar and Recorder: the files and the git of one agent's folder. Nothing here comes in a frame: the page asks again. */
const understood = (ok: boolean, value: unknown): unknown => {
  if (!ok) throw failure('The server sent an answer gonogo does not understand.');
  return value;
};

export async function listFiles(agent: string, path: string): Promise<HangarListing> {
  const value = await call('GET', `${agentPath(agent)}/files?path=${encodeURIComponent(path)}`);
  return understood(Array.isArray(asRecord(value)?.entries), value) as HangarListing;
}

export async function readFile(agent: string, path: string): Promise<HangarFile> {
  const value = await call('GET', `${agentPath(agent)}/file?path=${encodeURIComponent(path)}`);
  return understood(typeof asRecord(value)?.text === 'string' && typeof asRecord(value)?.etag === 'string', value) as HangarFile;
}

export async function saveFile(agent: string, request: HangarSaveRequest): Promise<HangarSaved> {
  const value = await call('PUT', `${agentPath(agent)}/file`, request);
  return understood(typeof asRecord(value)?.etag === 'string', value) as HangarSaved;
}

export async function createFile(agent: string, request: HangarCreateRequest): Promise<HangarSaved> {
  const value = await call('POST', `${agentPath(agent)}/file`, request);
  return understood(typeof asRecord(value)?.etag === 'string', value) as HangarSaved;
}

export async function gitStatus(agent: string): Promise<RecorderStatus> {
  const value = await call('GET', `${agentPath(agent)}/git`);
  return understood(typeof asRecord(value)?.repo === 'boolean', value) as RecorderStatus;
}

export async function gitDiff(agent: string, path: string, staged: boolean): Promise<RecorderDiff> {
  const value = await call('GET', `${agentPath(agent)}/git/diff?path=${encodeURIComponent(path)}&staged=${staged ? 1 : 0}`);
  return understood(typeof asRecord(value)?.diff === 'string', value) as RecorderDiff;
}

export async function gitLog(agent: string): Promise<RecorderCommit[]> {
  const value = await call('GET', `${agentPath(agent)}/git/log`);
  return understood(Array.isArray(value), value) as RecorderCommit[];
}

export async function gitCommit(agent: string, request: RecorderCommitRequest): Promise<RecorderCommit> {
  const value = asRecord(await call('POST', `${agentPath(agent)}/git/commit`, request));
  return understood(asRecord(value?.commit) !== null, value?.commit) as RecorderCommit;
}

/** Post-Flight Review: the diff of a console's folder against its last commit, and the notes on it. */
export async function reviewView(agent: string): Promise<ReviewView> {
  const value = await call('GET', `${agentPath(agent)}/review`);
  return understood(typeof asRecord(value)?.repo === 'boolean' && Array.isArray(asRecord(value)?.files) && Array.isArray(asRecord(value)?.notes), value) as ReviewView;
}

export async function reviewAddNote(agent: string, request: ReviewNoteRequest): Promise<ReviewNote> {
  const value = await call('POST', `${agentPath(agent)}/review/notes`, request);
  return understood(typeof asRecord(value)?.id === 'string', value) as ReviewNote;
}

export async function reviewSetStatus(agent: string, id: string, status: ReviewStatus): Promise<ReviewNote> {
  const value = await call('PATCH', `${agentPath(agent)}/review/notes/${encodeURIComponent(id)}`, { status });
  return understood(typeof asRecord(value)?.id === 'string', value) as ReviewNote;
}

export async function reviewRemoveNote(agent: string, id: string): Promise<void> {
  await call('DELETE', `${agentPath(agent)}/review/notes/${encodeURIComponent(id)}`);
}

/** APPROVE, or REQUEST CHANGES: the open notes go to the agent as one message. */
export async function reviewVerdict(agent: string, verdict: ReviewVerdictKind): Promise<ReviewSent> {
  const value = await call('POST', `${agentPath(agent)}/review/verdict`, { verdict });
  return understood(typeof asRecord(value)?.message === 'string', value) as ReviewSent;
}

/** ASK WALKTHROUGH (the author explains its diff) or PEER REVIEW (`reviewer` is asked to review it). */
export async function reviewAsk(agent: string, request: { kind: 'walkthrough' } | { kind: 'peer'; reviewer: string }): Promise<ReviewSent> {
  const value = await call('POST', `${agentPath(agent)}/review/ask`, request);
  return understood(typeof asRecord(value)?.message === 'string', value) as ReviewSent;
}

/** Plot Board: the plan. The page asks again every few seconds; a write names the revision it was made from. */
export async function readBoard(): Promise<BoardView> {
  return toBoardView(await call('GET', '/board'));
}

export async function writeBoard(text: string, revision: number): Promise<BoardView> {
  return toBoardView(await call('PUT', '/board', { text, revision }));
}

/** Black Box: the newest events and the command that reads the repository. */
export async function readBlackBox(): Promise<AuditView> {
  return toAuditView(await call('GET', '/black-box'));
}

/** Star Chart: the newest entries with their tags, authors and mentions. Asked again when a `log` frame says something changed. */
export async function logChart(): Promise<LogChart> {
  return toLogChart(await call('GET', '/log/chart'));
}

/** Mass Budget: the size of an agent's memory.md, and the request to condense it. No frame: the page asks. */
export async function agentMemory(name: string): Promise<MemoryView> {
  return toMemoryView(await call('GET', `${agentPath(name)}/memory`));
}

export async function reflect(name: string): Promise<ReflectResult> {
  return toReflectResult(await call('POST', `${agentPath(name)}/reflect`));
}

/** Downlink: the inbox. It comes in the state and in `downlink` frames; each call answers with it as it is now. */
export async function markRead(ids: string[]): Promise<DownlinkView> {
  return toDownlinkView(await call('POST', '/downlink/read', { ids }));
}

export async function archiveItems(ids: string[]): Promise<DownlinkView> {
  return toDownlinkView(await call('POST', '/downlink/archive', { ids }));
}

export async function markAllRead(): Promise<DownlinkView> {
  return toDownlinkView(await call('POST', '/downlink/read-all'));
}

/** Uplink: a webhook that starts work. The list comes in the state and in `uplinks` frames; only create and rotate answer with the secret. */
export async function createUplink(request: UplinkRequest): Promise<UplinkCreated> {
  return toUplinkCreated(await call('POST', '/uplinks', request));
}

export async function updateUplink(id: string, patch: UplinkPatch): Promise<UplinkView> {
  return toUplinkView(await call('PATCH', `/uplinks/${encodeURIComponent(id)}`, patch));
}

export async function deleteUplink(id: string): Promise<void> {
  await call('DELETE', `/uplinks/${encodeURIComponent(id)}`);
}

/** A new secret; the old one stops working at once. */
export async function rotateUplink(id: string): Promise<UplinkCreated> {
  return toUplinkCreated(await call('POST', `/uplinks/${encodeURIComponent(id)}/rotate`));
}

/** Fires a sample delivery now, whether the uplink is on or off; the answer holds it as the newest delivery. */
export async function testUplink(id: string): Promise<UplinkView> {
  return toUplinkView(await call('POST', `/uplinks/${encodeURIComponent(id)}/test`));
}

/** Relay: the targets and what is forwarded. No frame: the page asks again after each change. The token is never in an answer. */
export async function getRelay(): Promise<RelayView> {
  return toRelayView(await call('GET', '/relay'));
}

/** Without `token` the saved one stays. */
export async function setRelayTarget(service: RelayService, request: RelayTargetRequest): Promise<RelayView> {
  return toRelayView(await call('PUT', `/relay/${service}`, request));
}

/** Phone approvals: where permissions and hire requests are sent (Flight Rules). */
export async function setPhoneMode(mode: PhoneMode): Promise<RelayView> {
  return toRelayView(await call('PUT', '/relay/phone', { mode }));
}

export async function removeRelayTarget(service: RelayService): Promise<RelayView> {
  return toRelayView(await call('DELETE', `/relay/${service}`));
}

/** Sends one message to the target now; the answer holds how it went in `last`. */
export async function testRelayTarget(service: RelayService): Promise<RelayView> {
  return toRelayView(await call('POST', `/relay/${service}/test`));
}

export async function setRelayForward(request: RelayForwardRequest): Promise<RelayView> {
  return toRelayView(await call('PUT', '/relay/forward', request));
}

/* ---- WebSocket ---- */

type FieldType = 'string' | 'number' | 'boolean';

/** What the client needs of a frame before it acts on it. State, agent and activity frames are checked in parseFrame. */
const FRAME_FIELDS = new Map<string, ReadonlyArray<readonly [string, FieldType]>>([
  ['agent-removed', [['name', 'string']]],
  [
    'snapshot',
    [
      ['seq', 'number'],
      ['agent', 'string'],
      ['generation', 'number'],
      ['cols', 'number'],
      ['rows', 'number'],
      ['running', 'boolean'],
      ['data', 'string'],
    ],
  ],
  [
    'size',
    [
      ['agent', 'string'],
      ['cols', 'number'],
      ['rows', 'number'],
    ],
  ],
  ['error', [['message', 'string']]],
]);

/** A frame that does not parse, or lacks what its type needs, is dropped: the server only sends what protocol.ts says. */
function parseFrame(text: string): ServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const frame = asRecord(value);
  if (frame === null || typeof frame.t !== 'string') return null;
  let valid = false;
  if (frame.t === 'state') valid = isStateSnapshot(frame.state);
  else if (frame.t === 'agent') valid = typeof asRecord(frame.agent)?.name === 'string';
  else if (frame.t === 'poll') valid = frame.poll === null || asRecord(frame.poll) !== null;
  else if (frame.t === 'governor') valid = asRecord(frame.governor) !== null;
  else if (frame.t === 'propellant') valid = asRecord(asRecord(frame.propellant)?.room) !== null;
  else if (frame.t === 'schedules') valid = Array.isArray(frame.schedules);
  else if (frame.t === 'uplinks') valid = Array.isArray(frame.uplinks);
  else if (frame.t === 'tasks') valid = Array.isArray(frame.tasks);
  else if (frame.t === 'missions') valid = Array.isArray(frame.missions);
  else if (frame.t === 'room') valid = typeof asRecord(frame.room)?.rev === 'number';
  else if (frame.t === 'livery') valid = asRecord(frame.livery) !== null && Array.isArray(asRecord(frame.livery)?.liveries) && typeof asRecord(frame.livery)?.current === 'string';
  else if (frame.t === 'relief') valid = isReliefView(frame.relief);
  else if (frame.t === 'docking') valid = typeof asRecord(frame.docking)?.station === 'string' && Array.isArray(asRecord(frame.docking)?.docks);
  else if (frame.t === 'rollout') valid = typeof asRecord(frame.rollout)?.current === 'string';
  else if (frame.t === 'log') valid = Array.isArray(frame.changed) && Array.isArray(frame.removed);
  else if (frame.t === 'downlink') valid = Array.isArray(asRecord(frame.downlink)?.items) && typeof asRecord(frame.downlink)?.unread === 'number';
  else if (frame.t === 'activity') {
    const item = asRecord(frame.item);
    valid = typeof item?.id === 'string' && typeof item.at === 'number';
  } else valid = FRAME_FIELDS.get(frame.t)?.every(([key, type]) => typeof frame[key] === type) ?? false;
  return valid ? (value as ServerFrame) : null;
}

function dispatch(frame: ServerFrame): void {
  store.setState((s) => applyServerFrame(s, frame, Date.now()));
  if (frame.t === 'snapshot') {
    if (frame.seq === currentSeq) terminal?.snapshot(frame);
  } else if (frame.t === 'size') terminal?.size(frame);
  else if (frame.t === 'error') terminal?.error(frame);
}

/** byte 0 = WS_BINARY_OUTPUT, bytes 1 to 4 = the attach seq (uint32, big endian), then the pty bytes. */
function dispatchOutput(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 5) return;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== WS_BINARY_OUTPUT || view.getUint32(1) !== currentSeq) return;
  terminal?.output(new Uint8Array(buffer, 5));
}

function send(frame: ClientFrame): boolean {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function scheduleRetry(): void {
  clearTimeout(retryTimer);
  const delay = RECONNECT_DELAYS_MS[Math.min(store.getState().failedAttempts, RECONNECT_DELAYS_MS.length - 1)];
  retryTimer = setTimeout(() => void connect(), delay);
}

/** The attempt is over without an open socket. `wasOpen` is true when the socket had been open (the count then starts again). */
function lost(wasOpen: boolean): void {
  attempting = false;
  store.setState((s) => ({ ...s, connection: 'reconnecting', failedAttempts: wasOpen ? 0 : s.failedAttempts + 1 }));
  scheduleRetry();
}

function openSocket(): void {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${location.host}${WS_PATH}`, [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + (token ?? '')]);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    if (socket !== ws) return;
    opened = true;
    attempting = false;
    store.setState((s) => ({ ...s, connection: 'open', failedAttempts: 0 }));
  };
  ws.onmessage = (event: MessageEvent) => {
    if (socket !== ws) return;
    const data: unknown = event.data;
    if (typeof data === 'string') {
      const frame = parseFrame(data);
      if (frame !== null) dispatch(frame);
    } else if (data instanceof ArrayBuffer) dispatchOutput(data);
  };
  // `error` is always followed by `close`, which is where the reconnect starts.
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    currentSeq = 0;
    lost(opened);
  };
}

/** One attempt: the state over REST first (it tells 401 and "starting" apart), then the socket. */
async function connect(): Promise<void> {
  if (attempting || token === null) return;
  attempting = true;
  clearTimeout(retryTimer);
  try {
    const response = await fetch(`${API_PREFIX}/state`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (response.status === 401) {
      attempting = false;
      token = null;
      writeStored(TOKEN_STORAGE_KEY, null);
      store.setState((s) => ({ ...s, connection: 'unauthorized' }));
      return;
    }
    const body: unknown = response.ok ? await response.json() : null;
    if (!isStateSnapshot(body)) {
      lost(false);
      return;
    }
    store.setState((s) => applyServerFrame(s, { t: 'state', state: body }, Date.now()));
    openSocket();
  } catch {
    lost(false);
  }
}

/** Reads the token, loads the state, opens the socket and keeps it open. Called once, by main.tsx. */
export function start(): void {
  if (started) return;
  started = true;
  // Pasting the printed URL into a tab that already shows this page changes only the fragment: the page does not reload, so the token would never be read.
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(location.hash.slice(1)).has(TOKEN_FRAGMENT_KEY)) location.reload();
  });
  token = findToken();
  if (token === null) {
    store.setState((s) => ({ ...s, connection: 'unauthorized' }));
    return;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.getState().connection === 'reconnecting') void connect();
  });
  setInterval(() => store.setState((s) => pruneEnvelopes(s, Date.now())), 1000);
  void connect();
}

/** The RETRY NOW button of the server-gone screen: connect() clears the wait timer itself and ignores a call while an attempt runs. */
export function retryNow(): void {
  void connect();
}

/* ---- terminal ---- */

export function onTerminal(listener: TerminalListener): () => void {
  terminal = listener;
  return () => {
    if (terminal === listener) terminal = null;
  };
}

const validSize = (size: { cols: number; rows: number }): boolean =>
  Number.isInteger(size.cols) && Number.isInteger(size.rows) && size.cols > 0 && size.rows > 0;

/** Asks for the screen of `agent`; false when the socket is not open. The answer comes back to the TerminalListener. */
export function attach(agent: string, size?: { cols: number; rows: number }): boolean {
  const seq = attachCounter + 1;
  const frame: ClientFrame =
    size !== undefined && validSize(size)
      ? { t: 'attach', seq, agent, cols: size.cols, rows: size.rows }
      : { t: 'attach', seq, agent };
  if (!send(frame)) return false;
  attachCounter = seq;
  currentSeq = seq;
  return true;
}

export function detach(): void {
  currentSeq = 0;
  send({ t: 'detach' });
}

/** Pieces of at most `max` UTF-16 code units, never cutting between the two halves of a surrogate pair. */
export function splitInput(data: string, max: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + max, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(data.slice(start, end));
    start = end;
  }
  return pieces;
}

/** A paste of 300 KB would be one frame over the server's limit, so it goes out as ten. */
export function input(agent: string, data: string, binary = false): void {
  for (const piece of splitInput(data, WS_INPUT_CHUNK_CHARS)) {
    send(binary ? { t: 'input', agent, data: piece, binary: true } : { t: 'input', agent, data: piece });
  }
}

export function resize(agent: string, cols: number, rows: number): void {
  send({ t: 'resize', agent, cols, rows });
}
