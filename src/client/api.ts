import { searchPath } from './log.js';
import { creationOptions, credentialJson, requestOptions } from './passkey.js';
import type { FeaturePlan } from '../shared/features.js';
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
  EngineModels,
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
  PushView,
  RelayService,
  RelayTargetRequest,
  RecorderCommit,
  RecorderCommitRequest,
  RecorderDiff,
  RecorderStatus,
  RelayView,
  TriggerEntry,
  ReliefRules,
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
  Effort,
  ModelDefaults,
  PermissionMode,
  CleanRoomFlavor,
  CleanRoomFlavors,
  Claim,
  KnowledgeRepo,
  KnowledgeView,
  PayloadDefaults,
  ProjectFolderCheck,
  ProjectFolderView,
  LinkView,
  DockRules,
  OutboundEntry,
  HandoffAsk,
  LinkPriority,
  LinkEventView,
  ExposureFindingView,
  RoomKeysView,
  RuntimeSettingKey,
  RuntimeSettingRow,
  RuntimeSettingScope,
  PermissionDefaults,
  PermissionRules,
  StartupSettings,
  AutoUpdateView,
  AutoUpdateWindow,
  SubagentSettings,
  CoauthorSettings,
  EgressSettings,
  GlobalMcpView,
  AutoReviewDraft,
  AutoReviewSettings,
  AutoReviewView,
  RulesView,
  HoldAllResult,
  ResumeAllResult,
  Provider,
  ReviewNote,
  ReviewNoteRequest,
  ReviewSent,
  ReviewStatus,
  ReviewVerdictKind,
  ReviewView,
  RoomView,
  TabNameView,
  UserMessageRequest,
  WorktreeStatus,
  CostReport,
  SemanticRequest,
  SemanticView,
} from '../shared/protocol.js';
import { withBase } from './base.js';
import { changesExposure, EXPOSURE_REFRESH } from './exposureModel.js';
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
export type ApiFailure = Error & { field?: string; status?: number; stepUp?: boolean; second?: boolean; passkey?: boolean; retryAfter?: number; code?: string; diagnostics?: Array<{ line: number; message: string }> };

const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

let token: string | null = null;
/** This tab started with a key (the address gonogo prints, or one kept from before): if the server then refuses it, that address was for the first setup. */
let openedWithKey = false;
export const hadSetupLink = (): boolean => openedWithKey;
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

async function callOnce(method: string, path: string, body?: unknown): Promise<unknown> {
  // with no token the login's session cookie is the credential (the browser sends it by itself)
  const headers: Record<string, string> = token === null ? {} : { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(withBase(API_PREFIX + path), {
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
    const diagnostics = Array.isArray(error?.diagnostics) ? error.diagnostics.filter((d): d is { line: number; message: string } => typeof asRecord(d)?.line === 'number' && typeof asRecord(d)?.message === 'string') : undefined;
    throw Object.assign(
      failure(message, response.status, typeof error?.field === 'string' ? error.field : undefined),
      error?.stepUp === true ? { stepUp: true, second: error.second === true, passkey: error.passkey === true } : {},
      typeof error?.retryAfter === 'number' ? { retryAfter: error.retryAfter } : {},
      typeof error?.code === 'string' ? { code: error.code } : {},
      diagnostics === undefined ? {} : { diagnostics },
    );
  }
  // a write may open or close something the banner of the insecure setup lists
  if (typeof window !== 'undefined' && changesExposure(method, path)) window.dispatchEvent(new Event(EXPOSURE_REFRESH));
  return parsed;
}

/* ---- step-up: a change that wants the password (and the code) again ---- */

export type StepUpAnswer = { password: string; code: string } | { passkey: unknown };
type StepUpHandler = (needsCode: boolean, message: string, passkey: boolean) => Promise<StepUpAnswer | null>;
let stepUpHandler: StepUpHandler | null = null;

/** The page registers the dialog that asks; the handler answers null when the person gives up. */
export function onStepUp(handler: StepUpHandler): () => void {
  stepUpHandler = handler;
  return () => {
    if (stepUpHandler === handler) stepUpHandler = null;
  };
}

/** Runs a call; when the server says the password is wanted again, asks, confirms (a new cookie is set) and runs it once more. */
async function viaStepUp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const first = e as ApiFailure;
    if (first.stepUp !== true || stepUpHandler === null) throw e;
    let message = first.message;
    for (;;) {
      const answer = await stepUpHandler(first.second === true, message, first.passkey === true);
      if (answer === null) throw e;
      try {
        await authCallOnce('POST', '/stepup', answer);
        return await run();
      } catch (again) {
        const f = again as ApiFailure;
        // a wrong password or code: ask again; anything else is the answer
        if (f.status !== 401 && f.status !== 429) throw again;
        message = f.message;
      }
    }
  }
}

const call = (method: string, path: string, body?: unknown): Promise<unknown> => viaStepUp(() => callOnce(method, path, body));

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

/** The room's default engine; null goes back to Claude Code. */
export async function setDefaultEngine(engine: Provider | null): Promise<ModelDefaults> {
  return toModelDefaults(await call('PUT', '/models/engine', { engine }));
}

/** Room keys: environment variables every agent of the room gets. The answers hold names, never a value. */
const toRoomKeys = (value: unknown): RoomKeysView => {
  const record = asRecord(value);
  if (record === null || !Array.isArray(record.keys)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as RoomKeysView;
};
export async function roomKeys(): Promise<RoomKeysView> {
  return toRoomKeys(await call('GET', '/room-keys'));
}
/** A new key needs a value; with none, `cleanRoom` alone changes a saved one. */
export async function setRoomKey(name: string, body: { value?: string; cleanRoom?: boolean }): Promise<RoomKeysView> {
  return toRoomKeys(await call('PUT', `/room-keys/${encodeURIComponent(name)}`, body));
}
export async function removeRoomKey(name: string): Promise<RoomKeysView> {
  return toRoomKeys(await call('DELETE', `/room-keys/${encodeURIComponent(name)}`));
}

/** The project folder of the room: where its agents work. A write is the owner's own login and asks for the password again; a refusal says why in words. */
const toProjectFolder = (value: unknown): ProjectFolderView => {
  const record = asRecord(value);
  if (record === null || typeof record.dir !== 'string' || (record.source !== 'set' && record.source !== 'default')) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as ProjectFolderView;
};
export async function projectFolder(): Promise<ProjectFolderView> {
  return toProjectFolder(await call('GET', '/project-folder'));
}
/** Whether a folder would be accepted, and its warning, before anything is saved; null when this server has no such check (the answer comes after the save then). */
export async function checkProjectFolder(dir: string): Promise<ProjectFolderCheck | null> {
  try {
    const record = asRecord(await call('GET', `/project-folder/check?dir=${encodeURIComponent(dir)}`));
    if (record === null || typeof record.ok !== 'boolean') return null;
    return record as unknown as ProjectFolderCheck;
  } catch (e) {
    if ((e as ApiFailure).status === 404) return null;
    throw e;
  }
}
/** Sets the folder; null goes back to the folder gonogo was started in. */
export async function setProjectFolder(dir: string | null): Promise<ProjectFolderView> {
  return toProjectFolder(await call('PUT', '/project-folder', { dir }));
}

/** Runtime settings: the GONOGO_* values the Director can change here. A write asks for the password again, as Room keys do. */
export async function runtimeSettings(): Promise<RuntimeSettingRow[]> {
  const record = asRecord(await call('GET', '/settings'));
  if (record === null || !Array.isArray(record.keys)) throw failure('The server sent an answer gonogo does not understand.');
  return record.keys as RuntimeSettingRow[];
}
/** Sets (or with null resets) the value of one layer of one setting; answers the new row. */
export async function setRuntimeSetting(key: RuntimeSettingKey, scope: RuntimeSettingScope, value: string | null): Promise<RuntimeSettingRow> {
  const record = asRecord(await call('PUT', `/settings/${encodeURIComponent(key)}`, { scope, value }));
  const row = record === null ? null : asRecord(record.row);
  if (row === null) throw failure('The server sent an answer gonogo does not understand.');
  return row as unknown as RuntimeSettingRow;
}

/** The template of the closing checklist a new mission copies (one line each; comments, headings and blank lines are dropped). Same shape and step-up as the rules. */
export async function ritualTemplate(): Promise<RulesView> {
  return rulesOf(await call('GET', '/ritual-template'));
}
export async function setRitualTemplate(text: string): Promise<RulesView> {
  return rulesOf(await call('PUT', '/ritual-template', { text }));
}

/**
 * Knowledge (docs/knowledge-spec.md section 0b): claims about a repository and what the last check found. Reads are for the Director's session; writes need a full key.
 * A write answers the repo it changed. Nothing here returns a trial result or a proposal to an agent: this is the Director's page.
 */
const toKnowledgeRepo = (value: unknown): KnowledgeRepo => {
  const record = asRecord(value);
  if (record === null || typeof record.repoId !== 'string' || !Array.isArray(record.claims) || !Array.isArray(record.roots)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as KnowledgeRepo;
};
const repoPath = (repoId: string): string => `/knowledge/${encodeURIComponent(repoId)}`;
export async function knowledge(): Promise<KnowledgeView> {
  let answer: unknown;
  try {
    answer = await call('GET', '/knowledge');
  } catch (e) {
    // the switch is off: the server answers the route itself with `feature_off` (404) before it reaches the view that says `enabled: false`; either way it is not a failure
    if ((e as ApiFailure).code === 'feature_off') return { enabled: false, repos: [], agents: {} };
    throw e;
  }
  const record = asRecord(answer);
  if (record === null || typeof record.enabled !== 'boolean' || !Array.isArray(record.repos)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as KnowledgeView;
}
export async function recheckRepo(repoId: string): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('POST', `${repoPath(repoId)}/recheck`, {}));
}
/** `anchors` is the legs as typed, one per line. A line the parser cannot read is a 400 with `diagnostics`. */
export async function addClaim(repoId: string, body: { statement: string; anchors: string }): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('POST', `${repoPath(repoId)}/claims`, body));
}
export async function updateClaim(repoId: string, id: string, body: { statement?: string; anchors?: string; state?: 'active' | 'retired' }): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('PUT', `${repoPath(repoId)}/claims/${encodeURIComponent(id)}`, body));
}
export async function deleteClaim(repoId: string, id: string): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('DELETE', `${repoPath(repoId)}/claims/${encodeURIComponent(id)}`));
}
/** The trial run of a proposal on its own checkout: the Director's, rate limited, never shown to the proposing agent. */
export async function trialProposal(repoId: string, id: string): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('POST', `${repoPath(repoId)}/proposals/${encodeURIComponent(id)}/trial`, {}));
}
export async function acceptProposal(repoId: string, id: string): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('POST', `${repoPath(repoId)}/proposals/${encodeURIComponent(id)}/accept`, {}));
}
export async function rejectProposal(repoId: string, id: string, reason?: string): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('POST', `${repoPath(repoId)}/proposals/${encodeURIComponent(id)}/reject`, reason === undefined || reason === '' ? {} : { reason }));
}
/** BIND a checkout to a repo id, IGNORE it, or UNBIND one that was bound (a forged checkout seen first must not own the id). */
export async function bindRoot(repoId: string, path: string, action: 'bind' | 'ignore' | 'unbind'): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('POST', '/knowledge/bind', { repoId, path, action }));
}
/** MOVE the claims of a candidate id here (one atomic rename, behind the password), or KEEP the two separate. */
export async function moveRepo(repoId: string, from: string, action: 'move' | 'keep'): Promise<KnowledgeRepo> {
  return toKnowledgeRepo(await call('POST', `${repoPath(repoId)}/move`, { from, action }));
}
/** PROMOTE: a store claim made from a Mission Log entry that carries anchors (the entry stays as it is). */
export async function promoteEntry(entryId: string): Promise<{ repoId: string; claim: Claim }> {
  const record = asRecord(await call('POST', `/log/${encodeURIComponent(entryId)}/promote`, {}));
  if (record === null || typeof record.repoId !== 'string' || asRecord(record.claim) === null) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as { repoId: string; claim: Claim };
}

/** Payload defaults: what the room gives every agent (docs/payload-spec.md). The answers say what each item is and never a value. */
const toPayloadDefaults = (value: unknown): PayloadDefaults => {
  const record = asRecord(value);
  if (record === null || !Array.isArray(record.mcpServers) || !Array.isArray(record.skills)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as PayloadDefaults;
};
export async function payloadDefaults(): Promise<PayloadDefaults> {
  return toPayloadDefaults(await call('GET', '/payload-defaults'));
}
/** Adds the server, or replaces the one of that name whole. */
export async function setDefaultServer(name: string, server: unknown): Promise<PayloadDefaults> {
  return toPayloadDefaults(await call('PUT', `/payload-defaults/servers/${encodeURIComponent(name)}`, server));
}
export async function removeDefaultServer(name: string): Promise<PayloadDefaults> {
  return toPayloadDefaults(await call('DELETE', `/payload-defaults/servers/${encodeURIComponent(name)}`));
}
export async function addDefaultSkill(path: string): Promise<PayloadDefaults> {
  return toPayloadDefaults(await call('POST', '/payload-defaults/skills', { path }));
}
export async function removeDefaultSkill(name: string): Promise<PayloadDefaults> {
  return toPayloadDefaults(await call('DELETE', `/payload-defaults/skills/${encodeURIComponent(name)}`));
}

/** The room's default effort for Claude Code consoles with none of their own; null clears it. */
export async function setDefaultEffort(effort: Effort | null): Promise<ModelDefaults> {
  return toModelDefaults(await call('PUT', '/models/effort', { effort }));
}

/** Which Clean Room sandbox flavors this Docker has a runtime for, and the room's default. */
export async function cleanRoomFlavors(): Promise<CleanRoomFlavors> {
  const value = asRecord(await call('GET', '/cleanroom/flavors'));
  const available = asRecord(value?.available);
  if (value === null || available === null) throw failure('The server sent an answer gonogo does not understand.');
  return value as unknown as CleanRoomFlavors;
}

/** The room's default Clean Room sandbox flavor; null goes back to docker. A flavor whose runtime Docker does not list is refused. */
export async function setDefaultSandbox(sandbox: CleanRoomFlavor | null): Promise<ModelDefaults> {
  return toModelDefaults(await call('PUT', '/models/sandbox', { sandbox }));
}

/** The room's default permission mode for hires that name none; null goes back to ask. bypassPermissions is refused without `confirmBypass`. */
export async function setDefaultMode(mode: PermissionMode | null, confirmBypass = false): Promise<ModelDefaults> {
  return toModelDefaults(await call('PUT', '/models/mode', { mode, ...(confirmBypass ? { confirmBypass: true } : {}) }));
}

/** The model of a position for one engine (Claude Code when none is named). */
export async function setPositionModel(position: string, model: string | null, provider: Provider = 'claude'): Promise<ModelDefaults> {
  return toModelDefaults(await call('PUT', `/models/positions/${encodeURIComponent(position)}`, { model, ...(provider === 'claude' ? {} : { provider }) }));
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

/** ALL STOP: holds every console that can be held; the answer names who was and was not. */
export async function holdAll(): Promise<HoldAllResult> {
  return (await call('POST', '/hold-all')) as HoldAllResult;
}

/** ALL RESUME: resumes every console that is on hold. */
export async function resumeAll(): Promise<ResumeAllResult> {
  return (await call('POST', '/resume-all')) as ResumeAllResult;
}

/**
 * Push to the installed app: the key to subscribe with and the devices (docs/features/mobile.md). The supervisor answers these, for every
 * room, at the root of the address (like the login), so they never carry a room's prefix; the login's session cookie is the credential.
 */
async function pushCall(method: string, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/push${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw failure('Could not reach the gonogo server.');
  }
  let parsed: unknown = null;
  try {
    const text = await response.text();
    if (text !== '') parsed = JSON.parse(text);
  } catch {
    // not JSON: the status says it
  }
  if (!response.ok) {
    const error = asRecord(parsed);
    throw failure(typeof error?.error === 'string' ? error.error : `The server answered ${response.status}.`, response.status, typeof error?.field === 'string' ? error.field : undefined);
  }
  return parsed;
}

export async function pushView(): Promise<PushView> {
  const record = asRecord(await pushCall('GET', ''));
  if (record === null || typeof record.publicKey !== 'string' || !Array.isArray(record.devices)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as PushView;
}

export async function pushSubscribe(body: { endpoint: string; keys: { p256dh: string; auth: string }; device: string; snippet: boolean }): Promise<PushView> {
  return (await pushCall('PUT', '/subscription', body)) as PushView;
}

export async function pushUnsubscribe(id: string): Promise<PushView> {
  return (await pushCall('DELETE', '/subscription', { id })) as PushView;
}

export async function pushTest(id: string): Promise<{ ok: boolean; note: string }> {
  return (await pushCall('POST', '/test', { id })) as { ok: boolean; note: string };
}

/** The newer version main's check saw, from the supervisor (a room other than main runs no check of its own); null when none, or when it cannot be asked. */
export async function roomsUpdate(): Promise<string | null> {
  try {
    const response = await fetch('/api/rooms', { headers: token === null ? {} : { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const latest = asRecord(asRecord(await response.json())?.update)?.latest;
    return response.ok && typeof latest === 'string' ? latest : null;
  } catch {
    return null;
  }
}

/** Global MCP servers: the user-scope servers of Claude Code and the room's two switches (docs/features/global-mcp.md). Turning one on asks for a step-up. */
const globalMcpOf = (value: unknown): GlobalMcpView => {
  const record = asRecord(value);
  if (record === null || typeof record.host !== 'boolean' || typeof record.cleanRoom !== 'boolean' || typeof record.source !== 'string' || !Array.isArray(record.servers)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as GlobalMcpView;
};
export async function globalMcp(): Promise<GlobalMcpView> {
  return globalMcpOf(await call('GET', '/global-mcp'));
}
export async function setGlobalMcp(patch: { host?: boolean; cleanRoom?: boolean }): Promise<GlobalMcpView> {
  return globalMcpOf(await call('PUT', '/global-mcp', patch));
}

/** Auto-review (docs/features/auto-review.md): the setting and the jobs, the draft of a job, its POST and its skip. Turning it on asks for a step-up. */
const autoReviewOf = (value: unknown): AutoReviewView => {
  const record = asRecord(value);
  if (record === null || asRecord(record.settings) === null || !Array.isArray(record.jobs)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as AutoReviewView;
};
export async function getAutoReview(): Promise<AutoReviewView> {
  return autoReviewOf(await call('GET', '/auto-review'));
}
export async function setAutoReview(patch: Partial<AutoReviewSettings>): Promise<AutoReviewView> {
  return autoReviewOf(await call('PUT', '/auto-review', patch));
}
export async function pollAutoReview(): Promise<AutoReviewView> {
  return autoReviewOf(await call('POST', '/auto-review/poll'));
}
export async function getReviewDraft(job: string): Promise<AutoReviewDraft | null> {
  const record = asRecord(await call('GET', `/auto-review/jobs/${encodeURIComponent(job)}`));
  return record === null || record.draft === null ? null : (record.draft as AutoReviewDraft);
}
export async function postReview(job: string): Promise<void> {
  await call('POST', `/auto-review/jobs/${encodeURIComponent(job)}/post`);
}
export async function skipReview(job: string): Promise<void> {
  await call('POST', `/auto-review/jobs/${encodeURIComponent(job)}/skip`);
}

/** Egress: whether a Clean Room agent holds the Anthropic API key (docs/features/egress.md). A change asks for a step-up. */
const egressOf = (value: unknown): EgressSettings => {
  const record = asRecord(value);
  if (record === null || typeof record.anthropic !== 'boolean') throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as EgressSettings;
};
export async function egressSettings(): Promise<EgressSettings> {
  return egressOf(await call('GET', '/egress'));
}
export async function setEgressSettings(patch: EgressSettings): Promise<EgressSettings> {
  return egressOf(await call('PUT', '/egress', patch));
}

/** Co-author line: the room's switch for the Co-Authored-By line an agent's commits carry. */
export async function coauthorSettings(): Promise<CoauthorSettings> {
  const record = asRecord(await call('GET', '/coauthor'));
  if (record === null || typeof record.enabled !== 'boolean' || typeof record.prFooter !== 'boolean') throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as CoauthorSettings;
}

export async function setCoauthorSettings(patch: Partial<CoauthorSettings>): Promise<CoauthorSettings> {
  const record = asRecord(await call('PUT', '/coauthor', patch));
  if (record === null || typeof record.enabled !== 'boolean' || typeof record.prFooter !== 'boolean') throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as CoauthorSettings;
}

/** Room rules: the text every agent of the room starts with (docs/features/door.md). A change asks for a step-up. */
const rulesOf = (value: unknown): RulesView => {
  const record = asRecord(value);
  if (record === null || typeof record.text !== 'string' || typeof record.bytes !== 'number' || typeof record.max !== 'number') throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as RulesView;
};
export async function rulesView(): Promise<RulesView> {
  return rulesOf(await call('GET', '/rules'));
}
export async function setRules(text: string): Promise<RulesView> {
  return rulesOf(await call('PUT', '/rules', { text }));
}

/** Subagents: what a Claude Code agent may do with its helpers (allow, limit, none). */
export async function subagentSettings(): Promise<SubagentSettings> {
  const record = asRecord(await call('GET', '/subagents'));
  if (record === null || typeof record.mode !== 'string' || typeof record.limit !== 'number') throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as SubagentSettings;
}

export async function setSubagentSettings(patch: Partial<SubagentSettings>): Promise<SubagentSettings> {
  const record = asRecord(await call('PUT', '/subagents', patch));
  if (record === null || typeof record.mode !== 'string') throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as SubagentSettings;
}

/** Start again after a restart: the room's policy (boss, running, off) and the carry-on message. */
export async function startupSettings(): Promise<StartupSettings> {
  return toStartupSettings(await call('GET', '/startup'));
}

export async function setStartupSettings(patch: Partial<StartupSettings>): Promise<StartupSettings> {
  return toStartupSettings(await call('PUT', '/startup', patch));
}

function toStartupSettings(value: unknown): StartupSettings {
  const record = asRecord(value);
  if (record === null || typeof record.policy !== 'string' || typeof record.carryOn !== 'boolean' || typeof record.bossMayStart !== 'boolean') throw failure('The server sent an answer gonogo does not understand.');
  return value as StartupSettings;
}

/** Feature toggles: the plan of a change (nothing changes), then the same change with `confirm`. `off` is the whole list of off ids. */
export async function planFeatures(off: string[]): Promise<FeaturePlan> {
  const answer = asRecord(await call('PUT', '/features', { off }));
  const plan = asRecord(answer?.plan);
  if (plan === null || !Array.isArray(plan.turnOff)) throw failure('The server sent an answer gonogo does not understand.');
  return plan as unknown as FeaturePlan;
}

/** `expect` is the `off` list of the plan that was shown: the server refuses (409) when the plan is not that any more. */
export async function applyFeatures(off: string[], expect: string[]): Promise<void> {
  await call('PUT', '/features', { off, expect, confirm: true });
}

export async function engines(): Promise<EngineCheck[]> {
  const list = await call('GET', '/engines');
  if (!Array.isArray(list) || !list.every((e) => typeof asRecord(e)?.provider === 'string')) throw failure('The server sent an answer gonogo does not understand.');
  return list as EngineCheck[];
}

/** Model lists: the models one engine offers; `refresh` makes the server ask the program again. */
export async function engineModels(provider: Provider, refresh = false): Promise<EngineModels> {
  const answer = asRecord(await call('GET', `/engines/${encodeURIComponent(provider)}/models${refresh ? '?refresh=1' : ''}`));
  if (answer === null || !Array.isArray(answer.models) || !answer.models.every((m) => typeof m === 'string') || typeof answer.source !== 'string') throw failure('The server sent an answer gonogo does not understand.');
  return answer as unknown as EngineModels;
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

/** Relief by rule (docs/hire-fire-spec.md): the requests with the rules and the names of the agents the boss hired. */
export async function reliefView(): Promise<ReliefView> {
  return toReliefView(await call('GET', '/relief'));
}
/** The rules that change, as the fields of ReliefRules; turning them up asks for the password again. */
export async function setReliefRules(patch: Partial<ReliefRules>): Promise<ReliefView> {
  return toReliefView(await call('PUT', '/relief/rules', patch));
}
/** STOP CREW: stops every agent the boss hired by rule and turns automatic approval off. No password. */
export async function stopCrew(): Promise<ReliefView> {
  return toReliefView(await call('POST', '/relief/stop-crew'));
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
/** The ledger priced for the last `days` days, by agent and by kind of token (an estimate). */
export async function getCost(days = 14): Promise<CostReport> {
  const record = asRecord(await call('GET', `/cost?days=${days}`));
  if (record === null || record.estimate !== true || asRecord(record.room) === null || !Array.isArray(record.days)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as CostReport;
}

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

/** Tab name: the name of this room in the title of the tab; null or empty goes back to the default. */
export async function setTabName(name: string | null): Promise<TabNameView> {
  const value = await call('PUT', '/tab-name', { name });
  if (asRecord(value) === null) throw failure('The server sent an answer gonogo does not understand.');
  return value as TabNameView;
}

/** Room editor: save the layout from the revision it was made from, or go back to today's page (all of it, or only the order of the desks). */
export async function saveRoom(request: { rev: number; blocks: Block[]; desks: DeskOrder }): Promise<RoomView> {
  return toRoomView(await call('PUT', '/room', request));
}

export async function resetRoom(part: 'all' | 'desks', rev: number): Promise<RoomView> {
  return toRoomView(await call('DELETE', `/room?rev=${rev}${part === 'desks' ? '&part=desks' : ''}`));
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

/** The closing checklist of a mission, edited by the Director's session only (an agent cannot): each answers the whole mission. */
export async function addRitualItem(id: string, text: string): Promise<Mission> {
  return toMission(await call('POST', `/missions/${encodeURIComponent(id)}/ritual`, { text }));
}
/** Ticks or unticks a line, or changes its words. */
export async function setRitualItem(id: string, index: number, patch: { done?: boolean; text?: string }): Promise<Mission> {
  return toMission(await call('PATCH', `/missions/${encodeURIComponent(id)}/ritual/${index}`, patch));
}
export async function removeRitualItem(id: string, index: number): Promise<Mission> {
  return toMission(await call('DELETE', `/missions/${encodeURIComponent(id)}/ritual/${index}`));
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

/** What the Address box may start with: this computer's network addresses (empty for anyone but a login session). */
export async function dockHints(): Promise<{ addresses: string[]; container: boolean }> {
  const hints = asRecord(await call('GET', '/docking/addresses'));
  return { addresses: Array.isArray(hints?.addresses) ? hints.addresses.filter((a): a is string => typeof a === 'string').slice(0, 4) : [], container: hints?.container === true };
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

/* ---- Docking 2: links (docs/docking-collab-spec.md) ---- */

/** Every link this station holds, with its trail. A server without Docking 2 has no route: then there are none. */
export async function links(): Promise<LinkView[]> {
  try {
    const list = asRecord(await call('GET', '/links'))?.links;
    return Array.isArray(list) ? (list as LinkView[]) : [];
  } catch (e) {
    if ((e as ApiFailure).status === 404) return [];
    throw e;
  }
}
const linkPath = (id: string, action: string): string => `/links/${encodeURIComponent(id)}/${action}`;
/** The sender takes a delivery: its task is done. */
export const acceptLink = (id: string): Promise<unknown> => call('POST', linkPath(id, 'accept'));
/** Gives a task back (the receiver) or sends a delivery back (the sender): the reason is up to 200 characters. */
export const returnLink = (id: string, reason: string): Promise<unknown> => call('POST', linkPath(id, 'return'), { reason });
/** The sender withdraws what is not done yet. */
export const recallLink = (id: string, reason = ''): Promise<unknown> => call('POST', linkPath(id, 'recall'), { reason });
export const dockRules = async (dock: string): Promise<DockRules> => (asRecord(await call('GET', `/docking/${encodeURIComponent(dock)}/rules`))?.rules ?? {}) as DockRules;
export const setDockRules = async (dock: string, patch: Partial<DockRules>): Promise<DockRules> => (asRecord(await call('PATCH', `/docking/${encodeURIComponent(dock)}/rules`, patch))?.rules ?? {}) as DockRules;
/** The events that left for a dock, in full (only the Director's session may read them). */
export async function outbound(dock: string): Promise<OutboundEntry[]> {
  const list = asRecord(await call('GET', `/docking/outbound?dock=${encodeURIComponent(dock)}`))?.entries;
  return Array.isArray(list) ? (list as OutboundEntry[]) : [];
}
/** The trail of one link, oldest first. */
export async function linkTrail(id: string): Promise<LinkEventView[]> {
  const list = asRecord(await call('GET', `/links/${encodeURIComponent(id)}`))?.trail;
  return Array.isArray(list) ? (list as LinkEventView[]) : [];
}
/** Handoffs FLIGHT asks to send while a dock's rule is ask: the whole text, for the Director's GO. */
export async function handoffAsks(): Promise<HandoffAsk[]> {
  try {
    const list = asRecord(await call('GET', '/handoff-requests'))?.requests;
    return Array.isArray(list) ? (list as HandoffAsk[]) : [];
  } catch (e) {
    if ((e as ApiFailure).status === 404) return [];
    throw e;
  }
}
/** GO or NO-GO on a handoff; `always` turns the dock's rule to Allow (the password is asked again). The answer says whether it was sent. */
export const answerHandoff = async (id: string, go: boolean, always = false): Promise<'sent' | 'refused'> => (asRecord(await call('POST', `/handoff-requests/${encodeURIComponent(id)}/answer`, { go, always }))?.state === 'sent' ? 'sent' : 'refused');

/** What the Director marked as shareable, and with which docks: Mission Log entries ('log', by id) and claims ('claim', by <repository id>/<claim id>). */
export interface DockShare {
  kind: 'log' | 'claim';
  key: string;
  docks: string[];
}
export async function dockShares(): Promise<DockShare[]> {
  const list = asRecord(await call('GET', '/dock-shares'))?.shares;
  return Array.isArray(list) ? (list as DockShare[]) : [];
}
/** Marks one entry or claim shareable for exactly these docks (none clears it). */
export const setDockShare = async (kind: DockShare['kind'], id: string, docks: string[]): Promise<DockShare> => (await call('PUT', '/dock-shares', { kind, id, docks })) as DockShare;
/** The Director asks a docked station's shared knowledge: the answer is data, with its first line fixed by the server, and is not stored. */
export async function askDockKnowledge(dock: string, query: string): Promise<{ text: string; results: number }> {
  return (await call('POST', '/docking/' + encodeURIComponent(dock) + '/knowledge', { query })) as { text: string; results: number };
}
/** Offers a mission to a station like a task: the other station makes its own mission and tells counts only. */
export async function handOffMission(dock: string, offer: { mission: string; due?: string; priority?: LinkPriority }): Promise<LinkView> {
  return asRecord(await call('POST', '/docking/' + encodeURIComponent(dock) + '/handoff', offer)) as unknown as LinkView;
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
export async function searchLog(query: string, meaning = true): Promise<LogSearch> {
  return toLogSearch(await call('GET', searchPath(query, meaning)));
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

/** Knowledge anchors: the counts for the tiles. An answer the page does not understand, or a refusal (the feature is off), leaves it as it was. */
export async function loadKnowledge(): Promise<void> {
  try {
    const body = asRecord(await call('GET', '/knowledge'));
    const agents = body === null ? null : asRecord(body.agents);
    if (agents === null) return;
    const counts: Record<string, number> = {};
    for (const [name, n] of Object.entries(agents)) if (typeof n === 'number' && n > 0) counts[name] = n;
    store.setState((s) => ({ ...s, knowledge: counts }));
  } catch {
    // off, or not reachable: the tiles show no count
  }
}

/** The Director's RECHECK of an entry's anchors: the entry with the new answer. A refusal ("again in 12 s") is the error. */
export async function recheckLogEntry(id: string): Promise<LogEntry> {
  return toLogEntry(await call('POST', `/log/${encodeURIComponent(id)}/recheck`));
}

/** Search by meaning: the status of the index and the endpoint (the route is there only while the feature is on). */
export async function getSemantic(): Promise<SemanticView> {
  return (await call('GET', '/semantic')) as SemanticView;
}

/** Saves the endpoint, the model and the host that may get the notes: behind a step-up. */
export async function putSemantic(request: SemanticRequest): Promise<SemanticView> {
  return (await call('PUT', '/semantic', request)) as SemanticView;
}

/** The managed Ollama: start or stop it (starting is behind a step-up). The answer is the status, which has the progress of the download and the pull. */
export async function semanticManaged(action: 'start' | 'stop'): Promise<SemanticView> {
  return (await call('POST', '/semantic/managed', { action })) as SemanticView;
}

/** The last lines the managed Ollama wrote. */
export async function semanticManagedLogs(): Promise<string[]> {
  return ((await call('GET', '/semantic/managed/logs')) as { lines: string[] }).lines;
}

/** One request to the endpoint: the size of the vectors it answers with. */
export async function testSemantic(): Promise<{ dimension: number }> {
  return (await call('POST', '/semantic/test')) as { dimension: number };
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
/** The history of triggers, newest first (docs/features/triggers.md). */
export async function getTriggers(query: string): Promise<TriggerEntry[]> {
  const answer = asRecord(await call('GET', `/triggers?${query}`));
  if (answer === null || !Array.isArray(answer.triggers)) throw failure('The server sent an answer gonogo does not understand.');
  return answer.triggers as TriggerEntry[];
}

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

/** Update from the page: installs `version` (the newer one the check found), then reloads. The progress comes in the rollout frames. */
export async function undoUpdate(): Promise<void> {
  await call('POST', '/update/undo');
}

/** CHECK NOW: the version check now (the rollout frame follows). `waitS` is there when it was asked a moment ago and the cache was answered. */
export async function checkUpdateNow(): Promise<{ waitS?: number }> {
  const answer = asRecord(await call('POST', '/rollout/check'));
  return typeof answer?.waitS === 'number' ? { waitS: answer.waitS } : {};
}

export async function startUpdate(version: string, unverified = false): Promise<void> {
  await call('POST', '/update', unverified ? { version, unverified: true } : { version });
}

/** Live reload: the server hands over to the installed gonogo (Flight Rules). Resolves with the note the server gives. */
export async function reloadServer(): Promise<string> {
  const answer = asRecord(await call('POST', '/reload'));
  return typeof answer?.note === 'string' ? answer.note : 'reloading';
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
  else if (frame.t === 'tabname') valid = typeof asRecord(frame.tabName) === 'object' && asRecord(frame.tabName) !== null;
  else if (frame.t === 'room') valid = typeof asRecord(frame.room)?.rev === 'number';
  else if (frame.t === 'livery') valid = asRecord(frame.livery) !== null && Array.isArray(asRecord(frame.livery)?.liveries) && typeof asRecord(frame.livery)?.current === 'string';
  else if (frame.t === 'relief') valid = isReliefView(frame.relief);
  else if (frame.t === 'docking') valid = typeof asRecord(frame.docking)?.station === 'string' && Array.isArray(asRecord(frame.docking)?.docks);
  else if (frame.t === 'rollout') valid = typeof asRecord(frame.rollout)?.current === 'string';
  else if (frame.t === 'knowledge') valid = asRecord(frame.counts) !== null;
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
  const ws = new WebSocket(`${scheme}//${location.host}${withBase(WS_PATH)}`, token === null ? [WS_SUBPROTOCOL] : [WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX + token]);
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
  if (attempting) return;
  attempting = true;
  clearTimeout(retryTimer);
  try {
    const response = await fetch(withBase(`${API_PREFIX}/state`), { headers: token === null ? {} : { Authorization: `Bearer ${token}` }, cache: 'no-store' });
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
  // no token: the page tries the session cookie of the login; a 401 then says "log in"
  token = findToken();
  openedWithKey = token !== null;
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

/* ---- the login (docs/login-spec.md): the account of the supervisor, never under a room's prefix ---- */

export interface AccountSession {
  id: string;
  created: number;
  last: number;
  address: string;
  agent: string;
  kind: 'public' | 'local';
  /** A cookie session, or a terminal (`tui`) a browser approved. */
  type: 'browser' | 'tui';
  label: string;
}
export interface AccountKey {
  id: string;
  name: string;
  scope: 'read' | 'act' | 'full';
  remote: boolean;
  created: number;
  expires: number;
  last: number | null;
  lastAddress: string | null;
}
export interface AccountView {
  user: string;
  state: string;
  locked: boolean;
  current: string | null;
  host: 'loopback' | 'private' | 'public';
  sessions: AccountSession[];
  keys: AccountKey[];
  mfa: { enabled: boolean; pending: boolean; recoveryLeft: number };
  passkeys: Array<{ id: string; name: string; rpId: string; created: number; last: number | null; backedUp: boolean }>;
  /** The rp id a passkey made here would have, or null where one cannot be made (not a public name). */
  passkeyHere: string | null;
  /** The names this gonogo answers on (docs/expose-spec.md): page hosts, hooks-only hosts and the public address. */
  exposure?: { pages: string[]; hooks: string[]; publicUrl: string | null };
}

/** One call to `/api/auth/...`: the supervisor's own route (a room has none), so the path is absolute and the session cookie is the credential. */
const authCall = (method: string, path: string, body?: unknown): Promise<unknown> => viaStepUp(() => authCallOnce(method, path, body));

async function authCallOnce(method: string, path: string, body?: unknown, base = '/api/auth'): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
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
    // not JSON: the status says it
  }
  if (!response.ok) {
    const error = asRecord(parsed);
    throw Object.assign(failure(typeof error?.error === 'string' ? error.error : `The server answered ${response.status}.`, response.status, typeof error?.field === 'string' ? error.field : undefined), error?.stepUp === true ? { stepUp: true, second: error.second === true, passkey: error.passkey === true } : {});
  }
  // the login and the keys are findings too (no second factor, an old key)
  if (typeof window !== 'undefined' && base === '/api/auth' && changesExposure(method, '/auth')) window.dispatchEvent(new Event(EXPOSURE_REFRESH));
  return parsed;
}

/** Whether an account exists (public, no login needed). */
export async function authStatus(): Promise<{ state: string; setup: boolean; locked: boolean }> {
  const record = asRecord(await authCall('GET', '/status'));
  if (record === null || typeof record.state !== 'string') throw failure('The server sent an answer gonogo does not understand.');
  return { state: record.state, setup: record.setup === true, locked: record.locked === true };
}

/** The account as the logged-in session sees it; a 401 means this page is not signed in with an account. */
export async function authAccount(): Promise<AccountView> {
  const record = asRecord(await authCall('GET', '/account'));
  if (record === null || typeof record.user !== 'string' || !Array.isArray(record.sessions) || !Array.isArray(record.keys)) throw failure('The server sent an answer gonogo does not understand.');
  return record as unknown as AccountView;
}

export const authLogout = (): Promise<unknown> => authCall('POST', '/logout', {});
export const authLogoutAll = (): Promise<unknown> => authCall('POST', '/logout-all', {});
export const authRevokeSession = (id: string): Promise<unknown> => authCall('DELETE', `/sessions/${encodeURIComponent(id)}`);
export const authChangePassword = (current: string, next: string): Promise<unknown> => authCall('POST', '/password', { current, next });
export const authRevokeKey = (id: string): Promise<unknown> => authCall('DELETE', `/keys/${encodeURIComponent(id)}`);
export const authConfirm = (password: string): Promise<unknown> => authCall('POST', '/confirm', { password });
export async function authMakeKey(input: { name: string; scope: string; days: number | null; remote: boolean }): Promise<{ key: string; id: string }> {
  const record = asRecord(await authCall('POST', '/keys', { name: input.name, scope: input.scope, remote: input.remote, ...(input.days === null ? {} : { days: input.days }) }));
  if (record === null || typeof record.key !== 'string' || typeof record.id !== 'string') throw failure('The server sent an answer gonogo does not understand.');
  return { key: record.key, id: record.id };
}

export async function authMfaBegin(): Promise<{ secret: string; uri: string }> {
  const record = asRecord(await authCall('POST', '/mfa/begin', {}));
  if (record === null || typeof record.secret !== 'string' || typeof record.uri !== 'string') throw failure('The server sent an answer gonogo does not understand.');
  return { secret: record.secret, uri: record.uri };
}
async function recoveryOf(call: Promise<unknown>): Promise<string[]> {
  const record = asRecord(await call);
  if (record === null || !Array.isArray(record.recovery) || !record.recovery.every((c) => typeof c === 'string')) throw failure('The server sent an answer gonogo does not understand.');
  return record.recovery as string[];
}
export const authMfaEnable = (code: string): Promise<string[]> => recoveryOf(authCall('POST', '/mfa/enable', { code }));
export const authMfaRecovery = (password: string, code: string): Promise<string[]> => recoveryOf(authCall('POST', '/mfa/recovery', { password, code }));
export const authMfaDisable = (password: string, code: string): Promise<unknown> => authCall('POST', '/mfa/disable', { password, code });

/** Makes a passkey on this device: the server's options, the browser's ceremony, the server's check. */
export async function authPasskeyAdd(name: string): Promise<void> {
  const options = asRecord(await authCall('POST', '/passkeys/begin', {}));
  if (options === null) throw failure('The server sent an answer gonogo does not understand.');
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
  } catch (e) {
    throw failure(e instanceof Error && e.name === 'NotAllowedError' ? 'The passkey was not made.' : e instanceof Error ? e.message : 'The passkey was not made.');
  }
  if (credential === null) throw failure('The passkey was not made.');
  await authCall('POST', '/passkeys/finish', { response: credentialJson(credential as PublicKeyCredential), name });
}
/** Taking one away asks the password and a code, as turning the second factor off does. */
export const authPasskeyRemove = (id: string, password: string, code: string): Promise<unknown> => authCall('DELETE', `/passkeys/${encodeURIComponent(id)}`, { password, code });

/** For a step-up: the browser signs the server's challenge; the answer is what POST /api/auth/stepup takes. */
export async function passkeyStepUpAnswer(): Promise<{ passkey: unknown }> {
  const options = asRecord(await authCallOnce('POST', '/stepup/options', {}));
  if (options === null) throw failure('The server sent an answer gonogo does not understand.');
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
  } catch {
    throw failure('The passkey was not given.');
  }
  if (credential === null) throw failure('The passkey was not given.');
  return { passkey: credentialJson(credential as PublicKeyCredential) };
}

/** Auto-update (docs/features/update.md): the switch, the windows, SKIP THIS VERSION. The route is room main's and a Docker install's: another room answers 404. */
export async function autoUpdate(): Promise<AutoUpdateView> {
  return toAutoUpdate(await call('GET', '/autoupdate'));
}

export async function setAutoUpdate(patch: { enabled?: boolean; windows?: AutoUpdateWindow[] }): Promise<AutoUpdateView> {
  return toAutoUpdate(await call('PUT', '/autoupdate', patch));
}

export async function skipAutoUpdate(version: string): Promise<AutoUpdateView> {
  return toAutoUpdate(await call('POST', '/autoupdate/skip', { version }));
}

function toAutoUpdate(value: unknown): AutoUpdateView {
  const record = asRecord(value);
  if (record === null || typeof record.enabled !== 'boolean' || !Array.isArray(record.windows) || !Array.isArray(record.skipped)) throw failure('The server sent an answer gonogo does not understand.');
  return value as AutoUpdateView;
}

/** The banner's list. null when this login may not read it (a key, a terminal login: 403) or it cannot be read: the banner then shows nothing. */
export async function exposureFindings(): Promise<ExposureFindingView[] | null> {
  try {
    const list = asRecord(await authCallOnce('GET', '/findings', undefined, '/api/exposure'))?.findings;
    return Array.isArray(list) ? (list as ExposureFindingView[]) : null;
  } catch {
    return null;
  }
}

/** Dismisses one finding for good. A 400 is not an error: it was not a current finding (it has gone), and the list is read again. */
export async function dismissExposure(id: string): Promise<void> {
  try {
    await authCallOnce('POST', '/dismiss', { id }, '/api/exposure');
  } catch (e) {
    if ((e as ApiFailure).status !== 400) throw e;
  }
}
